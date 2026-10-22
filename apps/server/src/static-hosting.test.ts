/**
 * **M4 B7 — same-origin production static hosting, readiness and the static startup gate**
 * (`docs/DECISIONS.md` D-082 D2; `docs/CONTRACTS.md` §12/§18.6).
 *
 * Three layers, because they answer different questions:
 *
 * 1. **Pure resolver** — `resolveStaticAssets` decides whether `STATIC_DIR` is a usable build.
 *    A missing directory and a directory without `index.html` both report `STATIC_DIR_MISSING`,
 *    and the refusal message carries no configured value.
 * 2. **Real HTTP app** — a `createApp` instance is served on an ephemeral port against a
 *    temporary `dist` directory: `/` and SPA routes return the shell, a built asset is served
 *    with its real content type, unknown API paths stay JSON, `/ready` answers 200/503, source
 *    maps are not published in production, and `trust proxy` is on only in production.
 * 3. **Real process** — the entrypoint is spawned with a complete production environment whose
 *    only fault is a missing `STATIC_DIR`. It must exit **1**, print the stable code, and never
 *    reach `listen` — while having already opened the store and authz, which is what proves the
 *    documented startup order.
 *
 * The temporary directory is created per test file and removed afterwards (`docs/DECISIONS.md`
 * D-041): no test ever touches the real `apps/web/dist` or the development data directory.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Express, Request } from 'express';

import { createApp, type AppOptions } from './app.js';
import { createAuthz, type AuthzService } from './authz/public.js';
import { DEFAULT_STATIC_DIR, loadConfig, type ServerConfig } from './config.js';
import {
  isReservedPath,
  isSourceArtifact,
  isSpaNavigationRequest,
  resolveStaticAssets,
  type StaticAssets,
} from './static-hosting.js';

/* ---------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------- */

/** Marker text: finding it in a response proves the shell came from the temporary build. */
const SHELL_MARKER = 'insighthub-b7-spa-shell';

/** A source-map body that must never be served in production. */
const SOURCE_MAP_SECRET = 'SOURCE-MAP-SECRET-do-not-publish';

/** Placeholder secrets: distinctive so a log assertion can prove they were never printed. */
const CLERK_SECRET = 'sk_test_placeholder_clerk_secret_not_real';

/** The server package root (`apps/server/`), independent of the runner's working directory. */
const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));

let root = '';
let dist = '';
let emptyDist = '';
let dataPath = '';
let authz: AuthzService;

const INDEX_FILE = (): string => join(dist, 'index.html');
const STATIC_ASSETS = (): StaticAssets => ({ directory: dist, indexFile: INDEX_FILE() });

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'insighthub-b7-static-'));
  dist = join(root, 'dist');
  emptyDist = join(root, 'empty-dist');
  dataPath = join(root, 'data');

  await mkdir(join(dist, 'assets'), { recursive: true });
  await mkdir(emptyDist, { recursive: true });
  await mkdir(dataPath, { recursive: true });

  await writeFile(
    INDEX_FILE(),
    `<!doctype html><html><head><title>InsightHub</title></head><body><div id="root">${SHELL_MARKER}</div><script type="module" src="/assets/app.js"></script></body></html>\n`,
    'utf8',
  );
  await writeFile(join(dist, 'assets', 'app.js'), "console.log('static-asset-ok');\n", 'utf8');
  await writeFile(
    join(dist, 'assets', 'app.js.map'),
    JSON.stringify({ version: 3, sources: ['app.ts'], sourcesContent: [SOURCE_MAP_SECRET] }),
    'utf8',
  );

  authz = await createAuthz({ dataPath });
});

after(async () => {
  authz.close();
  await rm(root, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- *
 * 1. Pure resolution
 * ---------------------------------------------------------------- */

describe('resolveStaticAssets — the production build check (M4 B7)', () => {
  it('accepts a directory containing index.html and returns absolute paths', () => {
    const resolution = resolveStaticAssets(dist);
    assert.equal(resolution.kind, 'available');
    if (resolution.kind !== 'available') return;
    assert.equal(resolution.assets.directory, dist);
    assert.equal(resolution.assets.indexFile, INDEX_FILE());
  });

  it('refuses a missing directory with STATIC_DIR_MISSING and no configured value', () => {
    const missing = join(root, 'does-not-exist');
    const resolution = resolveStaticAssets(missing);
    assert.equal(resolution.kind, 'missing');
    if (resolution.kind !== 'missing') return;
    assert.equal(resolution.refusal.code, 'STATIC_DIR_MISSING');
    assert.ok(
      !resolution.refusal.message.includes(missing),
      'the refusal must never print the configured path',
    );
  });

  it('refuses a directory without index.html with the same code', () => {
    const resolution = resolveStaticAssets(emptyDist);
    assert.equal(resolution.kind, 'missing');
    if (resolution.kind !== 'missing') return;
    assert.equal(resolution.refusal.code, 'STATIC_DIR_MISSING');
    assert.ok(!resolution.refusal.message.includes(emptyDist));
  });

  it('refuses an empty or absent STATIC_DIR', () => {
    for (const value of [undefined, '', '   ']) {
      assert.equal(resolveStaticAssets(value).kind, 'missing');
    }
  });
});

describe('config — STATIC_DIR (M4 B7)', () => {
  it('defaults to the repository apps/web/dist, independent of the working directory', () => {
    const config = loadConfig({});
    assert.equal(config.staticDir, DEFAULT_STATIC_DIR);
    assert.ok(DEFAULT_STATIC_DIR.endsWith(join('apps', 'web', 'dist')));
  });

  it('reads STATIC_DIR, treating an empty value as unset', () => {
    assert.equal(loadConfig({ STATIC_DIR: dist }).staticDir, dist);
    assert.equal(loadConfig({ STATIC_DIR: '' }).staticDir, DEFAULT_STATIC_DIR);
  });
});

describe('static-hosting predicates (M4 B7)', () => {
  const request = (method: string, path: string, accept: string | undefined): Request =>
    ({ method, path, headers: accept === undefined ? {} : { accept } }) as unknown as Request;

  it('reserves the API, socket and probe prefixes by path segment', () => {
    for (const path of ['/api', '/api/', '/api/meta', '/ws', '/health', '/ready', '/apiary']) {
      if (path === '/apiary') continue;
      assert.equal(isReservedPath(path), true, `${path} must be reserved`);
    }
    // A path that merely starts with the same letters is not the reserved surface.
    assert.equal(isReservedPath('/apiary'), false);
    assert.equal(isReservedPath('/health-check'), false);
  });

  it('falls back only for GET/HEAD navigations outside the reserved prefixes', () => {
    assert.equal(isSpaNavigationRequest(request('GET', '/some/route', 'text/html')), true);
    assert.equal(
      isSpaNavigationRequest(request('GET', '/some/route', 'text/html,application/xhtml+xml')),
      true,
    );
    assert.equal(isSpaNavigationRequest(request('GET', '/some/route', '*/*')), false);
    assert.equal(isSpaNavigationRequest(request('GET', '/some/route', undefined)), false);
    assert.equal(isSpaNavigationRequest(request('POST', '/some/route', 'text/html')), false);
    assert.equal(isSpaNavigationRequest(request('GET', '/api/unknown', 'text/html')), false);
    assert.equal(isSpaNavigationRequest(request('GET', '/ready', 'text/html')), false);
  });

  it('recognises build metadata that production must not publish', () => {
    assert.equal(isSourceArtifact('/assets/app.js.map'), true);
    assert.equal(isSourceArtifact('/assets/app.ts'), true);
    assert.equal(isSourceArtifact('/assets/style.scss'), true);
    assert.equal(isSourceArtifact('/assets/app.js'), false);
    assert.equal(isSourceArtifact('/assets/app.css'), false);
    assert.equal(isSourceArtifact('/index.html'), false);
  });
});

/* ---------------------------------------------------------------- *
 * 2. Real HTTP app
 * ---------------------------------------------------------------- */

interface RunningApp {
  readonly baseUrl: string;
  readonly app: Express;
  close(): Promise<void>;
}

/**
 * Build and listen on an ephemeral port.
 *
 * `options.staticAssets === undefined` means "the temporary build"; an explicit `null` means
 * "the API only". Production is the default posture, because that is the configuration the
 * static rules exist for.
 */
async function startApp(
  options: {
    readonly nodeEnv?: string;
    readonly staticAssets?: StaticAssets | null;
    readonly isReady?: () => boolean;
  } = {},
): Promise<RunningApp> {
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    corsOrigin: 'https://app.insighthub.example',
    wsPath: '/ws',
    authMode: 'demo',
    nodeEnv: options.nodeEnv ?? 'production',
    dataPath,
  };

  const appOptions: AppOptions = {
    staticAssets: options.staticAssets === undefined ? STATIC_ASSETS() : options.staticAssets,
    ...(options.isReady === undefined ? {} : { isReady: options.isReady }),
  };

  const app = createApp(config, authz, null, {}, undefined, appOptions);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // `fetch` keeps sockets alive; drop them so the suite does not wait on the pool.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A response body read as JSON, typed loosely for assertion. */
async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('same-origin static hosting (M4 B7, production)', () => {
  let production: RunningApp;

  before(async () => {
    production = await startApp();
  });

  after(async () => {
    await production.close();
  });

  it('serves index.html at / for a browser navigation', async () => {
    const response = await fetch(`${production.baseUrl}/`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
    const body = await response.text();
    assert.ok(body.includes(SHELL_MARKER), 'the SPA shell must be the built index.html');
  });

  it('serves a built asset with its real content type', async () => {
    const response = await fetch(`${production.baseUrl}/assets/app.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await response.text(), "console.log('static-asset-ok');\n");
  });

  it('falls back to index.html for a client-side route', async () => {
    for (const path of ['/documents/123', '/some/spa/route?tab=comments', '/workspace']) {
      const response = await fetch(`${production.baseUrl}${path}`, {
        headers: { accept: 'text/html' },
      });
      assert.equal(response.status, 200, `${path} must be a navigation`);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      assert.ok((await response.text()).includes(SHELL_MARKER));
    }
  });

  it('keeps the JSON 404 for a non-navigation request', async () => {
    const response = await fetch(`${production.baseUrl}/some/spa/route`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await json(response), { error: 'not_found' });
  });

  it('keeps the JSON 404 for an unknown API path, even with Accept: text/html', async () => {
    const response = await fetch(`${production.baseUrl}/api/unknown`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await json(response), { error: 'not_found' });
  });

  it('keeps /api/meta, /health and the frozen API routes', async () => {
    const meta = await fetch(`${production.baseUrl}/api/meta`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(meta.status, 200);
    assert.equal((await json(meta))['name'], 'insighthub-server');

    const health = await fetch(`${production.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await json(health), { status: 'ok' });

    // Production never mounts the demo bootstrap fixture (§18.5); it must stay a JSON 404.
    const bootstrap = await fetch(`${production.baseUrl}/api/session/bootstrap`, {
      method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(bootstrap.status, 404);
    assert.deepEqual(await json(bootstrap), { error: 'not_found' });
  });

  it('answers a non-GET client route with the JSON 404, never the shell', async () => {
    const response = await fetch(`${production.baseUrl}/some/spa/route`, {
      method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await json(response), { error: 'not_found' });
  });

  it('treats a path that only starts like a reserved prefix as a navigation', async () => {
    const response = await fetch(`${production.baseUrl}/apiary`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(SHELL_MARKER));
  });

  it('does not publish source maps in production', async () => {
    // The file exists on disk — the refusal is the server's, not the build's.
    const programmatic = await fetch(`${production.baseUrl}/assets/app.js.map`);
    assert.equal(programmatic.status, 404);
    assert.ok(!(await programmatic.text()).includes(SOURCE_MAP_SECRET));

    const navigation = await fetch(`${production.baseUrl}/assets/app.js.map`, {
      headers: { accept: 'text/html' },
    });
    // A navigation-shaped request may receive the shell, but never the source map bytes.
    assert.ok(!(await navigation.text()).includes(SOURCE_MAP_SECRET));
  });

  it('enables trust proxy only in production', async () => {
    assert.equal(production.app.get('trust proxy'), 1);

    for (const nodeEnv of [undefined, 'development', 'test'] as const) {
      const devConfig: ServerConfig = {
        port: 0,
        host: '127.0.0.1',
        corsOrigin: 'http://localhost:5173',
        wsPath: '/ws',
        authMode: 'demo',
        ...(nodeEnv === undefined ? {} : { nodeEnv }),
        dataPath,
      };
      const devApp = createApp(devConfig, authz, null);
      assert.equal(
        devApp.get('trust proxy'),
        false,
        `NODE_ENV=${String(nodeEnv)} must not trust a forwarded header`,
      );
    }
  });
});

describe('GET /ready (M4 B7)', () => {
  it('answers 200 ready for a production app with the web build mounted', async () => {
    const app = await startApp();
    try {
      const response = await fetch(`${app.baseUrl}/ready`, {
        headers: { accept: 'text/html' },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await json(response), { status: 'ready' });
    } finally {
      await app.close();
    }
  });

  it('answers 503 starting while the injected readiness predicate is false, and health stays 200', async () => {
    let ready = false;
    const app = await startApp({ isReady: () => ready });
    try {
      const starting = await fetch(`${app.baseUrl}/ready`);
      assert.equal(starting.status, 503);
      assert.deepEqual(await json(starting), { status: 'starting' });

      // Liveness is independent of readiness: a restarting-or-starting process is still alive.
      const health = await fetch(`${app.baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await json(health), { status: 'ok' });

      ready = true;
      const readyNow = await fetch(`${app.baseUrl}/ready`);
      assert.equal(readyNow.status, 200);
      assert.deepEqual(await json(readyNow), { status: 'ready' });
    } finally {
      await app.close();
    }
  });

  it('is not ready in production without a web build (staticReady is part of readiness)', async () => {
    const app = await startApp({ staticAssets: null });
    try {
      const response = await fetch(`${app.baseUrl}/ready`);
      assert.equal(response.status, 503);
      assert.deepEqual(await json(response), { status: 'starting' });
    } finally {
      await app.close();
    }
  });

  it('is ready outside production even without a web build', async () => {
    const app = await startApp({ nodeEnv: 'development', staticAssets: null });
    try {
      const response = await fetch(`${app.baseUrl}/ready`);
      assert.equal(response.status, 200);
    } finally {
      await app.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * 3. Real process — the startup refusal
 * ---------------------------------------------------------------- */

interface RefusalRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the real entrypoint with a **complete** production environment whose only fault is the
 * static directory, so an exit can only be the B7 check (not an earlier B3 gate).
 *
 * The store and authz therefore really open inside the child; their log lines are asserted
 * below to prove the documented order.
 */
function runProductionEntrypoint(staticDir: string, childDataPath: string): RefusalRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '0',
    HOST: '127.0.0.1',
    AUTH_MODE: 'clerk',
    CLERK_SECRET_KEY: CLERK_SECRET,
    CLERK_PUBLISHABLE_KEY: '',
    VITE_CLERK_PUBLISHABLE_KEY: '',
    CORS_ORIGIN: 'https://app.insighthub.example',
    INSIGHTHUB_DATA_PATH: childDataPath,
    AI_PROVIDER: 'disabled',
    STATIC_DIR: staticDir,
    NO_COLOR: '1',
  };

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('production entrypoint — STATIC_DIR_MISSING (M4 B7)', () => {
  it('exits 1 before listening, after the store and authz opened, without printing a value', async () => {
    const childDataPath = await mkdtemp(join(tmpdir(), 'insighthub-b7-refusal-'));
    const missingStaticDir = join(childDataPath, 'no-web-build');

    try {
      const result = runProductionEntrypoint(missingStaticDir, childDataPath);

      assert.equal(
        result.status,
        1,
        `expected exit code 1\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /refusing to start: STATIC_DIR_MISSING/,
        'the stable code must be printed',
      );

      // Startup order: the store and authorization subsystem were already open when the static
      // check refused, and the server never listened.
      assert.match(result.stdout, /store\s+ready/);
      assert.match(result.stdout, /authz\s+ready/);
      assert.doesNotMatch(result.stdout, /http\s+ready/, 'the server must not have listened');
      assert.doesNotMatch(
        result.stdout,
        /\[server\] ready\s+http/,
        'no readiness endpoint was announced',
      );

      // No configured value or secret may reach either stream.
      for (const forbidden of [CLERK_SECRET, missingStaticDir]) {
        assert.ok(!result.stdout.includes(forbidden), `stdout leaked ${JSON.stringify(forbidden)}`);
        assert.ok(!result.stderr.includes(forbidden), `stderr leaked ${JSON.stringify(forbidden)}`);
      }
    } finally {
      await rm(childDataPath, { recursive: true, force: true });
    }
  });

  it('refuses the same way when the directory exists but has no index.html', async () => {
    const childDataPath = await mkdtemp(join(tmpdir(), 'insighthub-b7-empty-'));
    const staticDir = join(childDataPath, 'empty-dist');
    await mkdir(staticDir, { recursive: true });

    try {
      const result = runProductionEntrypoint(staticDir, childDataPath);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /refusing to start: STATIC_DIR_MISSING/);
      assert.doesNotMatch(result.stdout, /http\s+ready/);
    } finally {
      await rm(childDataPath, { recursive: true, force: true });
    }
  });
});
