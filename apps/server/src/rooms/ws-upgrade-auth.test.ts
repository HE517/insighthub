/**
 * **M4 B2** — WebSocket upgrade authentication (`docs/CONTRACTS.md` §18.4; D-082 D1).
 *
 * ## What this file proves
 *
 * | # | Claim | How |
 * | --- | --- | --- |
 * | §18.4 | an unauthenticated upgrade is refused with `401` and **no socket** | a raw TCP upgrade gets the HTTP response back; the registry's connection count stays 0 |
 * | §18.4 | a verified Clerk session may open a socket | `TestClient.connect` with the cookie completes the `connected` handshake |
 * | §18.1 | the socket speaks for the mapped **internal** `app_user` id | membership is seeded for the internal id only; `room-joined.role` proves the join decision used it, and a write through the real frame gate is persisted. Seeding the membership under the raw Clerk `sub` instead is refused |
 * | §18.3/§17.4 | the 401 body matches the transport | raw response body is `{"error":"session_required"}` (clerk) / `{"error":"unauthenticated"}` (demo) |
 * | §18.4 | verification failure fails closed | a verifier that throws still produces `401` and no socket |
 * | §17.5 | demo mode is unchanged | the demo cookie still upgrades and joins; no cookie is still refused |
 *
 * ## What it deliberately does not do
 *
 * No network: the Clerk verifier is an injected fake (`createFakeSessionVerifier`). A real
 * Clerk instance accepting a real session is a staging smoke (B2/A6), not deterministic
 * evidence. Every server here is a real HTTP+WS server on an ephemeral port with a real SQLite
 * store and the real `AuthzService`.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { after, describe, it } from 'node:test';

import { WS_ERROR_CODES, encodeSyncUpdate } from '@insighthub/shared';
import * as Y from 'yjs';

import {
  createFakeSessionVerifier,
  isAppUserStore,
  type VerifiedIdentity,
} from '../authz/public.js';
import { openMembershipStore } from '../authz/membership-store.js';
import type { ServerConfig } from '../config.js';
import { attachWebSocketServer } from '../ws.js';
import {
  bootstrapSessionCookie,
  startTestServer,
  TestClient,
  type TestServer,
} from './test-harness.js';

/* ------------------------------------------------------------------ *
 * Fixtures — fake Clerk identities, no network
 * ------------------------------------------------------------------ */

const ADA_SUB = 'user_clerk_ws_ada';
const GRACE_SUB = 'user_clerk_ws_grace';
const ADA_COOKIE = 'clerk_session=verified-ws-ada';
const GRACE_COOKIE = 'clerk_session=verified-ws-grace';

const ADA_IDENTITY: VerifiedIdentity = {
  clerkUserId: ADA_SUB,
  email: 'ws-ada@example.com',
  displayName: 'WS Ada',
};
const GRACE_IDENTITY: VerifiedIdentity = {
  clerkUserId: GRACE_SUB,
  email: 'ws-grace@example.com',
  displayName: 'WS Grace',
};

const clerkVerifier = createFakeSessionVerifier(({ cookie }) => {
  if (cookie === ADA_COOKIE) return ADA_IDENTITY;
  if (cookie === GRACE_COOKIE) return GRACE_IDENTITY;
  return null;
});

const servers: TestServer[] = [];
const clients: TestClient[] = [];

after(async () => {
  for (const client of clients) client.destroy();
  for (const server of servers) await server.close();
});

/** Demo-mode server with the real authorization service on the socket. */
async function demoServer(): Promise<TestServer> {
  const server = await startTestServer({ authorization: 'enforced' });
  servers.push(server);
  return server;
}

/** Clerk-mode server with the same real authorization service; the verifier is a fake. */
async function clerkServer(verifier = clerkVerifier): Promise<TestServer> {
  const server = await startTestServer({
    authorization: 'enforced',
    authMode: 'clerk',
    verifier,
  });
  servers.push(server);
  return server;
}

/** Add one membership row for an internal user (the test owns this fixture). */
async function seedMembership(
  server: TestServer,
  userId: string,
  documentId: string,
  role: 'owner' | 'editor' | 'viewer',
): Promise<void> {
  assert.ok(server.dataPath !== undefined, 'the harness owns a data directory');
  const memberships = await openMembershipStore(server.dataPath);
  try {
    memberships.seed([{ documentId, userId, role }]);
  } finally {
    memberships.close();
  }
}

/** The durable text of a document, replayed through a fresh Y.Doc. */
async function durableText(server: TestServer, documentId: string): Promise<string | null> {
  const stored = await server.store.load(documentId);
  if (stored === null) return null;
  const doc = new Y.Doc();
  const { applyStoredDocument } = await import('../persistence/hydrator.js');
  applyStoredDocument(stored, doc);
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}

/** Append text locally and return the incremental update that carries it. */
function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText('content');
  const before = Y.encodeStateVector(doc);
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Send a raw HTTP upgrade request and read the refusal.
 *
 * The `ws` client surfaces a refused upgrade as an `unexpected-response` event without the body,
 * but the contract is about the **HTTP response**, not about what `ws` exposes: this helper
 * reads the bytes on the wire, so both the status and the body are asserted.
 */
async function rawUpgrade(
  port: number,
  options: { cookie?: string; path?: string } = {},
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (statusMatch === null) {
        reject(new Error(`upgrade answered with no HTTP status: ${JSON.stringify(received)}`));
        return;
      }
      const separator = received.indexOf('\r\n\r\n');
      resolve({
        status: Number(statusMatch[1]),
        body: separator === -1 ? '' : received.slice(separator + 4),
      });
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('timed out waiting for the upgrade response'));
    }, 5_000);

    socket.on('data', (chunk: Buffer | string) => {
      received += chunk.toString('latin1');
    });
    socket.on('close', finish);
    socket.on('error', () => {
      if (received.length > 0) finish();
      else {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('the upgrade connection failed'));
        }
      }
    });
    socket.on('connect', () => {
      const lines = [
        `GET ${options.path ?? '/ws'} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ];
      if (options.cookie !== undefined) lines.push(`Cookie: ${options.cookie}`);
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    });
  });
}

/** True when the refusal left no socket, no room participant and no connection. */
function assertNoSocket(server: TestServer): void {
  assert.equal(server.handle.clientCount(), 0, 'an unauthenticated upgrade must not register');
  assert.equal(server.handle.wss.clients.size, 0, 'no WebSocket may exist after a refusal');
}

/* ------------------------------------------------------------------ *
 * AUTH_MODE=clerk — the upgrade is a Clerk-authenticated boundary
 * ------------------------------------------------------------------ */

describe('AUTH_MODE=clerk — upgrade authentication (§18.4)', () => {
  it('refuses a missing session with 401 session_required and no socket', async () => {
    const server = await clerkServer();

    const refused = await rawUpgrade(server.port);
    assert.equal(refused.status, 401);
    assert.deepEqual(JSON.parse(refused.body), { error: 'session_required' });
    assertNoSocket(server);
  });

  it('refuses a session the verifier rejects, and never opens a socket', async () => {
    const server = await clerkServer();

    const refused = await rawUpgrade(server.port, { cookie: 'clerk_session=forged' });
    assert.equal(refused.status, 401);
    assert.deepEqual(JSON.parse(refused.body), { error: 'session_required' });
    assertNoSocket(server);

    // Same answer for a `userId` in the query string: identity comes from the cookie only.
    const asserted = await rawUpgrade(server.port, { path: '/ws?userId=demo-ada' });
    assert.equal(asserted.status, 401);
    assert.deepEqual(JSON.parse(asserted.body), { error: 'session_required' });
    assertNoSocket(server);
  });

  it('fails closed when the verifier itself throws', async () => {
    const server = await clerkServer(
      createFakeSessionVerifier(() => {
        throw new Error('clerk backend unavailable');
      }),
    );

    // `identity.ts` logs only the error class for a verifier throw; silence it for this test.
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const refused = await rawUpgrade(server.port, { cookie: ADA_COOKIE });
      assert.equal(refused.status, 401);
      assert.deepEqual(JSON.parse(refused.body), { error: 'session_required' });
      assertNoSocket(server);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('opens a socket for a verified session and joins as the mapped internal user', async () => {
    const server = await clerkServer();

    // The mapping row is created exactly the way the first authenticated request creates it.
    assert.ok(isAppUserStore(server.store));
    const internalUserId = await server.store.upsertByClerkUserId(ADA_IDENTITY);
    assert.notEqual(internalUserId, ADA_SUB, 'the internal id must not be the Clerk sub');
    await seedMembership(server, internalUserId, 'clerk-document', 'owner');

    const client = await TestClient.connect(server.url, { cookie: ADA_COOKIE });
    clients.push(client);

    const joined = await client.joinAndWait('clerk-document');
    assert.equal(joined.role, 'owner', 'the join decision used the mapped internal id');

    // The frame gate is unchanged and also runs on that internal id: a write is accepted and
    // reaches the durable store.
    client.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'clerk wrote this')));
    await waitFor(
      async () => (await durableText(server, 'clerk-document')) === 'clerk wrote this',
      'the authenticated socket to persist a SYNC update',
    );

    assert.equal(server.handle.clientCount(), 1);
  });

  it('does not authorize a membership keyed by the Clerk sub', async () => {
    const server = await clerkServer();

    // A membership row that names the raw Clerk `sub` must be invisible: the socket speaks for
    // the internal id, which is a different value (`docs/CONTRACTS.md` §18.1).
    await seedMembership(server, GRACE_SUB, 'clerk-sub-keyed', 'owner');

    const client = await TestClient.connect(server.url, { cookie: GRACE_COOKIE });
    clients.push(client);
    client.join('clerk-sub-keyed');
    const error = await client.waitForError(WS_ERROR_CODES.ROOM_NOT_FOUND);
    assert.equal(error.payload.code, WS_ERROR_CODES.ROOM_NOT_FOUND);
  });

  it('refuses to start a clerk-mode socket layer without the shared identity resolver', () => {
    const config: ServerConfig = {
      port: 0,
      host: '127.0.0.1',
      corsOrigin: 'http://localhost:5173',
      wsPath: '/ws',
      authMode: 'clerk',
    };

    // Reaching the demo `authz.resolveSession` fallback here would let a demo cookie open a
    // production socket, so the wiring mistake is a construction failure.
    assert.throws(
      () => attachWebSocketServer(createServer(), config, {}),
      /AUTH_MODE=clerk requires IdentityDeps/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * AUTH_MODE=demo — regression
 * ------------------------------------------------------------------ */

describe('AUTH_MODE=demo — the existing upgrade behaviour is unchanged', () => {
  it('refuses no session with 401 unauthenticated and no socket', async () => {
    const server = await demoServer();

    const refused = await rawUpgrade(server.port);
    assert.equal(refused.status, 401);
    assert.deepEqual(JSON.parse(refused.body), { error: 'unauthenticated' });
    assertNoSocket(server);
  });

  it('still upgrades and joins with a bootstrapped demo session', async () => {
    const server = await demoServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    const client = await TestClient.connect(server.url, { cookie });
    clients.push(client);
    assert.equal(client.closed, false);
    assert.equal((await client.joinAndWait('demo-document')).role, 'owner');
  });
});
