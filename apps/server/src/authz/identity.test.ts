/**
 * **M4 B1** — Clerk identity seam, demo gating and the production startup guard
 * (`docs/CONTRACTS.md` §18; `docs/DECISIONS.md` D-082).
 *
 * Layer: **Node only**, no network. Clerk is represented by an injected fake verifier
 * (`session-verifier.ts`), because a real Clerk session is B2's proof. The Express app, the
 * identity resolver, the `app_user` mapping and the real SQLite files all run unchanged, so
 * a defect in the production wiring is still visible here.
 *
 * Covered:
 *
 * - `AUTH_MODE=clerk`: no/invalid session → `401 session_required`; verified session →
 *   request succeeds **as the mapped internal user**, not as the Clerk `sub`;
 * - `AUTH_MODE=demo`: the pre-B1 session flow is unchanged;
 * - `NODE_ENV=production`: `POST /api/session/bootstrap` is absent (404), and the real
 *   entrypoint exits non-zero before listening;
 * - the schema has no login-session table — only `document*` and `app_user`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createAuthz } from './authz.js';
import { isAppUserStore } from './app-user.js';
import { AUTHZ_DATABASE_FILE_NAME, openMembershipStore } from './membership-store.js';
import { createFakeSessionVerifier, type VerifiedIdentity } from './session-verifier.js';
import {
  bootstrap,
  getWithSession,
  setCookies,
  startHarness,
  type Harness,
} from './test-support.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { openDocumentStore } from '../persistence/open-store.js';
import { loadSqliteModule } from '../persistence/sqlite-runtime.js';
import { findStartupRefusal } from '../startup.js';

/* ---------------------------------------------------------------- *
 * The fake Clerk identity source — no network, no @clerk dependency
 * ---------------------------------------------------------------- */

const ADA_IDENTITY: VerifiedIdentity = {
  clerkUserId: 'user_clerk_ada',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
};
const GRACE_IDENTITY: VerifiedIdentity = {
  clerkUserId: 'user_clerk_grace',
  email: 'grace@example.com',
  displayName: 'Grace Hopper',
};
const ADA_COOKIE = 'clerk_session=verified-ada';
const GRACE_COOKIE = 'clerk_session=verified-grace';

const verifier = createFakeSessionVerifier(({ cookie }) => {
  if (cookie === ADA_COOKIE) return ADA_IDENTITY;
  if (cookie === GRACE_COOKIE) return GRACE_IDENTITY;
  return null;
});

/** The internal id the server mapped an authenticated cookie to. */
async function internalIdFor(harness: Harness, cookie: string): Promise<string> {
  const response = await harness.request('/api/session', { headers: { cookie } });
  assert.equal(response.status, 200, 'the fake verifier accepted the session');
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(typeof body['userId'], 'string');
  return body['userId'] as string;
}

/** Add one membership row for a mapped internal user (the test owns this fixture). */
async function seedMembership(
  dataPath: string,
  userId: string,
  documentId: string,
  role: 'owner' | 'editor' | 'commenter' | 'viewer',
): Promise<void> {
  const memberships = await openMembershipStore(dataPath);
  try {
    memberships.seed([{ documentId, userId, role }]);
  } finally {
    memberships.close();
  }
}

async function tempDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

/* ---------------------------------------------------------------- *
 * AUTH_MODE=clerk over real HTTP
 * ---------------------------------------------------------------- */

describe('AUTH_MODE=clerk — verified identity maps to an internal user', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness({
      authMode: 'clerk',
      nodeEnv: 'test',
      verifier,
      aiProvider: null,
    });
  });

  after(async () => {
    await harness.close();
  });

  it('answers 401 session_required for every protected path without a verified session', async () => {
    const cases = [
      { path: '/api/session', cookie: null },
      { path: '/api/session', cookie: 'clerk_session=forged' },
      { path: '/api/documents', cookie: null },
      { path: '/api/documents/demo-document', cookie: 'clerk_session=forged' },
    ] as const;

    for (const testCase of cases) {
      const response = await harness.request(testCase.path, {
        headers: testCase.cookie === null ? {} : { cookie: testCase.cookie },
      });
      assert.equal(response.status, 401, `${testCase.path} ${testCase.cookie ?? 'no cookie'}`);
      assert.deepEqual(await response.json(), { error: 'session_required' });
    }
  });

  it('clears the stale demo cookie on DELETE even when the Clerk session is already gone', async () => {
    // The client calls this right after `signOut()` (A2's B2 wiring). Requiring a verified
    // session here would answer 401 and leave the demo cookie behind forever. Clearing the
    // caller's own cookie is not a privileged operation (§18.2: Clerk owns the session).
    for (const cookie of [null, 'clerk_session=forged', ADA_COOKIE]) {
      const response = await harness.request('/api/session', {
        method: 'DELETE',
        headers: cookie === null ? {} : { cookie },
      });
      assert.equal(response.status, 204, `DELETE with ${cookie ?? 'no cookie'}`);
      const setCookie = response.headers.get('set-cookie') ?? '';
      assert.match(
        setCookie,
        /insighthub_session=;/,
        'the demo cookie must be cleared regardless of Clerk authentication',
      );
    }
  });

  it('returns the internal id, not the Clerk sub, and no locally invented expiry', async () => {
    const response = await harness.request('/api/session', { headers: { cookie: ADA_COOKIE } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), ['displayName', 'userId']);
    assert.equal(body['displayName'], 'Ada Lovelace');
    assert.equal(typeof body['userId'], 'string');
    assert.notEqual(
      body['userId'],
      ADA_IDENTITY.clerkUserId,
      'the Clerk sub must not leak as userId',
    );
    assert.equal(body['expiresAt'], undefined, 'Clerk owns the session lifetime (§18.2)');

    // Idempotent mapping over HTTP: the same verified sub resolves to the same internal id.
    const again = await harness.request('/api/session', { headers: { cookie: ADA_COOKIE } });
    assert.deepEqual(await again.json(), body);
  });

  it('authorizes the document with the mapped internal user id', async () => {
    const adaId = await internalIdFor(harness, ADA_COOKIE);
    await seedMembership(harness.dataPath, adaId, 'demo-document', 'owner');

    // The membership row is keyed by the internal id. If authorization still spoke for the
    // Clerk sub, this request would be a 404.
    const document = await harness.request('/api/documents/demo-document', {
      headers: { cookie: ADA_COOKIE },
    });
    assert.equal(document.status, 200);
    assert.equal(((await document.json()) as Record<string, unknown>)['id'], 'demo-document');

    const list = await harness.request('/api/documents', { headers: { cookie: ADA_COOKIE } });
    assert.equal(list.status, 200);
    const listed = (await list.json()) as { documents: Array<{ id: string }> };
    assert.deepEqual(
      listed.documents.map((entry) => entry.id),
      ['demo-document'],
    );

    // A different verified Clerk user is a different internal user with no membership, so the
    // non-disclosure answer applies — the mapping is not "everyone is one user".
    const other = await harness.request('/api/documents/demo-document', {
      headers: { cookie: GRACE_COOKIE },
    });
    assert.equal(other.status, 404);
    assert.deepEqual(await other.json(), { error: 'not_found' });
  });

  it('fails closed when the verifier itself throws', async () => {
    const failing = await startHarness({
      authMode: 'clerk',
      nodeEnv: 'test',
      aiProvider: null,
      verifier: createFakeSessionVerifier(() => {
        throw new Error('clerk backend unavailable');
      }),
    });

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const response = await failing.request('/api/session', {
        headers: { cookie: ADA_COOKIE },
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'session_required' });
    } finally {
      console.warn = originalWarn;
      await failing.close();
    }
  });

  it('does not mount demo bootstrap in clerk mode', async () => {
    const response = await harness.request('/api/session/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoUserId: 'demo-ada' }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(setCookies(response).length, 0);
  });

  it('lets a verified identity reach the AI route (guard runs before body parsing)', async () => {
    const response = await harness.request('/api/ai/suggest', {
      method: 'POST',
      headers: { cookie: ADA_COOKIE, 'content-type': 'application/json' },
      body: '{ not json',
    });
    // The malformed body proves the 401 guard passed; the parse failure is the route's own 400.
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  });
});

/* ---------------------------------------------------------------- *
 * AUTH_MODE=demo regression
 * ---------------------------------------------------------------- */

describe('AUTH_MODE=demo — the pre-B1 session flow is unchanged', () => {
  let harness: Harness;

  before(async () => {
    harness = await startHarness({ nodeEnv: 'development', aiProvider: null });
  });

  after(async () => {
    await harness.close();
  });

  it('still bootstraps, reads the same session body and lists the demo documents', async () => {
    const session = await bootstrap(harness, 'demo-ada');
    assert.equal(session.userId, 'demo-ada');

    const current = await getWithSession(harness, '/api/session', session.cookie);
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), {
      userId: 'demo-ada',
      displayName: 'Ada Lovelace',
      expiresAt: session.expiresAt,
    });

    const documents = await getWithSession(harness, '/api/documents', session.cookie);
    assert.equal(documents.status, 200);
    const listed = (await documents.json()) as { documents: Array<{ id: string }> };
    assert.deepEqual(
      listed.documents.map((entry) => entry.id),
      ['demo-document', 'demo-private-notes', 'demo-team-notes'],
    );

    const document = await getWithSession(harness, '/api/documents/demo-document', session.cookie);
    assert.equal(document.status, 200);
  });

  it('keeps the §17.4 unauthenticated body for demo callers', async () => {
    for (const path of ['/api/session', '/api/documents', '/api/documents/demo-document']) {
      const response = await harness.request(path);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { error: 'unauthenticated' }, path);
    }
  });
});

/* ---------------------------------------------------------------- *
 * Production demo gate
 * ---------------------------------------------------------------- */

describe('NODE_ENV=production — demo bootstrap is absent', () => {
  it('answers 404 not_found for the bootstrap path, including a malformed body', async () => {
    const harness = await startHarness({ nodeEnv: 'production', aiProvider: null });
    try {
      const response = await harness.request('/api/session/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ demoUserId: 'demo-ada' }),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'not_found' });
      assert.equal(setCookies(response).length, 0, 'a refusal must not issue a cookie');

      // The route is not mounted, so the route-scoped body parser never runs either.
      const malformed = await harness.request('/api/session/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      });
      assert.equal(malformed.status, 404);
      assert.deepEqual(await malformed.json(), { error: 'not_found' });

      // The rest of the app still answers; only the demo fixture is gone.
      assert.equal((await harness.request('/health')).status, 200);
      const session = await harness.request('/api/session');
      assert.equal(session.status, 401);
      assert.deepEqual(await session.json(), { error: 'unauthenticated' });
    } finally {
      await harness.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * Startup guard (the rule index.ts enforces)
 * ---------------------------------------------------------------- */

function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    corsOrigin: 'http://localhost:5173',
    wsPath: '/ws',
    ...overrides,
  };
}

/**
 * A production configuration that satisfies every M4 B3 rule, so a test can vary exactly one
 * field. `dataPath` is only inspected textually (`isAbsolute`), never opened.
 */
function productionConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return baseConfig({
    nodeEnv: 'production',
    corsOrigin: 'https://app.insighthub.example',
    dataPath: join(tmpdir(), 'insighthub-production-data'),
    ...overrides,
  });
}

describe('startup guard', () => {
  it('reads AUTH_MODE from config, defaulting to demo', () => {
    assert.equal(loadConfig({}).authMode, 'demo');
    assert.equal(loadConfig({ AUTH_MODE: 'clerk' }).authMode, 'clerk');
    // Unknown values are B3's fail-fast decision; B1 resolves them to the safe development
    // default, and production refuses that combination below.
    assert.equal(loadConfig({ AUTH_MODE: 'unexpected' }).authMode, 'demo');
    assert.equal(loadConfig({ NODE_ENV: 'production' }).nodeEnv, 'production');
  });

  it('refuses NODE_ENV=production with AUTH_MODE=demo', () => {
    const refusal = findStartupRefusal(baseConfig({ nodeEnv: 'production', authMode: 'demo' }), {});
    assert.equal(refusal?.code, 'DEMO_AUTH_IN_PRODUCTION');
  });

  it('allows demo outside production', () => {
    assert.equal(
      findStartupRefusal(baseConfig({ nodeEnv: 'development', authMode: 'demo' }), {}),
      null,
    );
    assert.equal(findStartupRefusal(baseConfig({ authMode: 'demo' }), {}), null);
  });

  it('refuses clerk mode without CLERK_SECRET_KEY, and accepts a configured secret', () => {
    const clerk = productionConfig({ authMode: 'clerk' });

    // B1's transitional `CLERK_VERIFIER_NOT_WIRED` guard is gone (B2 wires the verifier); the
    // remaining rule is the configuration the verifier needs. B3 named the refusal after the
    // missing setting. An empty value counts as missing.
    assert.equal(findStartupRefusal(clerk, {})?.code, 'CLERK_SECRET_KEY_MISSING');
    assert.equal(
      findStartupRefusal(clerk, { CLERK_SECRET_KEY: '   ' })?.code,
      'CLERK_SECRET_KEY_MISSING',
    );

    // A fake (well-shaped) secret is enough for the startup rule: the real Clerk call is not
    // made at startup, and this suite must never contact Clerk. The rest of this config is a
    // complete production configuration, so no later B3 rule fires.
    assert.equal(findStartupRefusal(clerk, { CLERK_SECRET_KEY: 'sk_test_not_a_real_key' }), null);
  });

  it('makes the real entrypoint exit non-zero before listening', () => {
    const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        AUTH_MODE: 'demo',
        PORT: '0',
        INSIGHTHUB_DATA_PATH: join(tmpdir(), `insighthub-guard-${process.pid}`),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /refusing to start: DEMO_AUTH_IN_PRODUCTION/);
    assert.doesNotMatch(result.stdout, /http\s+ready/, 'the server must not have listened');
  });

  it('makes the real entrypoint refuse clerk mode without a secret, before listening', () => {
    const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      AUTH_MODE: 'clerk',
      PORT: '0',
      INSIGHTHUB_DATA_PATH: join(tmpdir(), `insighthub-clerk-guard-${process.pid}`),
    };
    // The parent process may legitimately have a Clerk key configured; this test is about its
    // absence, so it is removed explicitly rather than assumed unset.
    delete env['CLERK_SECRET_KEY'];

    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /refusing to start: CLERK_SECRET_KEY_MISSING/);
    assert.doesNotMatch(result.stdout, /http\s+ready/, 'the server must not have listened');
  });

  it('starts clerk mode with a configured secret, and never prints the value', async () => {
    const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
    const dataPath = await mkdtemp(join(tmpdir(), 'insighthub-clerk-start-'));
    const secret = 'sk_test_not_a_real_key';
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUTH_MODE: 'clerk',
        CLERK_SECRET_KEY: secret,
        // No publishable key: the process must still start (B3 owns making it required). The
        // startup warning is expected and no request is made, so Clerk is never contacted.
        CLERK_PUBLISHABLE_KEY: '',
        VITE_CLERK_PUBLISHABLE_KEY: '',
        PORT: '0',
        INSIGHTHUB_DATA_PATH: dataPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      const deadline = Date.now() + 30_000;
      // M4 B9: startup logs are JSON lines; wait for the structured listener event.
      while (!/"event":"server\.listening"/.test(stdout)) {
        if (child.exitCode !== null) {
          assert.fail(`the clerk server exited early (${child.exitCode})\n${stdout}\n${stderr}`);
        }
        if (Date.now() > deadline) {
          assert.fail(`the clerk server never listened\n${stdout}\n${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // The verifier was constructed and wired: startup reports the mode, not a refusal.
      assert.match(stdout, /"event":"server\.auth_ready"[^\n]*"authMode":"clerk"/);
      assert.doesNotMatch(stderr, /CLERK_SECRET_KEY_MISSING/);
      // The secret is never logged, in either stream.
      assert.ok(!stdout.includes(secret), 'the secret reached stdout');
      assert.ok(!stderr.includes(secret), 'the secret reached stderr');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await rm(dataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

/* ---------------------------------------------------------------- *
 * Schema — mapping only, no second session
 * ---------------------------------------------------------------- */

describe('database schema (M4 B1)', () => {
  it('contains document tables and app_user, and no login-session table', async () => {
    const directory = await tempDirectory('insighthub-schema-');
    const opened = await openDocumentStore(directory);
    const authz = await createAuthz({ dataPath: directory });
    try {
      assert.ok(isAppUserStore(opened.store));
      await opened.store.upsertByClerkUserId({ clerkUserId: 'user_schema' });
    } finally {
      authz.close();
      await opened.store.close();
    }

    const sqlite = await loadSqliteModule();
    try {
      const documentDb = new sqlite.DatabaseSync(join(directory, DATABASE_FILE_NAME));
      try {
        const tables = (
          documentDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all() as Array<Record<string, unknown>>
        ).map((row) => String(row['name']));
        assert.deepEqual(tables, ['app_user', 'document', 'document_meta', 'document_update']);

        const columns = (
          documentDb.prepare('PRAGMA table_info(app_user)').all() as Array<Record<string, unknown>>
        ).map((row) => String(row['name']));
        assert.deepEqual(columns, [
          'id',
          'clerk_user_id',
          'email',
          'display_name',
          'created_at',
          'updated_at',
        ]);
        // Mapping only: no token, expiry or password column can hide here.
        for (const forbidden of ['token', 'expires_at', 'password', 'session']) {
          assert.ok(!columns.includes(forbidden), `app_user must not have a ${forbidden} column`);
        }
      } finally {
        documentDb.close();
      }

      // The membership database is the other durable file; it must not have grown a session
      // table either (demo sessions stay in the process-scoped `Map`).
      const authzDb = new sqlite.DatabaseSync(join(directory, AUTHZ_DATABASE_FILE_NAME));
      try {
        const tables = (
          authzDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<
            Record<string, unknown>
          >
        ).map((row) => String(row['name']));
        assert.ok(tables.length > 0, 'the membership table exists');
        for (const table of tables) {
          assert.ok(!/session/i.test(table), `unexpected session-like table: ${table}`);
        }
      } finally {
        authzDb.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
