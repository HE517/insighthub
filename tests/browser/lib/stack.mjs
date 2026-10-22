/**
 * Start, stop, **crash** and restart the real dev stack for the A6 suite.
 *
 * Two real processes are spawned, exactly as `pnpm dev` would:
 *
 * - `apps/server` — the real Express + `ws` server (`tsx src/index.ts`),
 * - `apps/web` — the real Vite dev server, which proxies `/ws` to the backend.
 *
 * They are spawned through `node <entry>` rather than through `pnpm` so that the
 * child we hold a handle to *is* the server. That matters for the durability
 * scenarios: killing the server must be an unambiguous, verifiable process death,
 * and starting it again must bring the identical configuration back.
 *
 * ## Durable-storage isolation (M2)
 *
 * Server persistence survives the process, so a test that reused a data directory
 * would be measuring the previous scenario. Every run therefore gets its own
 * temporary directory, passed to the server as `INSIGHTHUB_DATA_PATH`:
 *
 * - `createDataPath()` — a **new** empty directory, for a scenario that needs a
 *   clean store;
 * - an explicit restart **reuses** the current directory, which is what makes
 *   "restart and the content is still there" a meaningful assertion;
 * - `dispose()` removes every directory this stack created.
 *
 * The development default (`.insighthub-data`) is never used.
 *
 * ## Extra environment (M3 Round 2 remote-AI evidence)
 *
 * Both processes are configured entirely by environment variables, so a scenario group that
 * needs a different configuration needs a different environment. `serverEnv` / `webEnv` are
 * merged **after** the frozen defaults at construction, and {@link DevStack.setServerEnv} /
 * {@link DevStack.setWebEnv} change them for the **next** start.
 *
 * The defaults do not change: with no `serverEnv`/`webEnv` the two children receive exactly the
 * same variables as before (`PORT`, `HOST`, `INSIGHTHUB_*`). In particular:
 *
 * - `AI_PROVIDER` is **not** set, so `createServerAiProviderFromEnv` returns `null` and
 *   `POST /api/ai/suggest` answers `503 ai_provider_not_configured`;
 * - `VITE_AI_PROVIDER` is **not** set, so `readAiProviderMode()` returns `local`.
 *
 * An override whose value is `undefined` **removes** the key, including one inherited from the
 * parent process. That is what lets a scenario prove the unconfigured-server path inside a run
 * whose parent shell happens to export an AI variable.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sleep } from './cdp.mjs';

const READY_TIMEOUT_MS = 60_000;

/**
 * Default ports for the two real processes.
 *
 * Overridable so several worktrees can run the suite at the same time instead of
 * queueing on 3101/5173: `INSIGHTHUB_E2E_SERVER_PORT=<n> INSIGHTHUB_E2E_WEB_PORT=<n>
 * node tests/browser/run.mjs`. The Vite listen port is passed through
 * `INSIGHTHUB_WEB_PORT` (see `webEnv` below and `apps/web/vite.config.ts`).
 */
const DEFAULT_SERVER_PORT = Number(process.env.INSIGHTHUB_E2E_SERVER_PORT ?? 3101);
const DEFAULT_WEB_PORT = Number(process.env.INSIGHTHUB_E2E_WEB_PORT ?? 5173);

/** Run a child, buffering its output so a failure can be explained. */
function run(command, args, { cwd, env } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: childEnvironment(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    log.stdout += chunk.toString();
    if (log.stdout.length > 400_000) log.stdout = log.stdout.slice(-200_000);
  });
  child.stderr.on('data', (chunk) => {
    log.stderr += chunk.toString();
    if (log.stderr.length > 400_000) log.stderr = log.stderr.slice(-200_000);
  });
  return { child, log };
}

/**
 * The environment a child process receives.
 *
 * `undefined` in the overrides deletes the variable instead of stringifying it to `"undefined"`:
 * a caller that wants "AI_PROVIDER is really unset" must be able to override an inherited value.
 * Every value that is present is passed as a string (spawn requires that).
 */
function childEnvironment(overrides) {
  const environment = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = String(value);
  }
  return environment;
}

/** Terminate a process and, on Windows, its whole tree. Graceful where possible. */
async function terminate(child, { graceful = false } = {}) {
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    if (process.platform === 'win32') {
      // Windows has no SIGTERM for a detached process tree; `taskkill /F` is the only
      // reliable death. The durability scenarios treat that as the crash case on
      // purpose — SQLite's WAL recovers it — and a *graceful* shutdown is exercised
      // through the same path only on POSIX.
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill(graceful ? 'SIGTERM' : 'SIGKILL');
    }
  } catch {
    child.kill();
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(8_000).then(() => true)]);
  if (timedOut) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function waitForHttp(url, { timeoutMs = READY_TIMEOUT_MS, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await sleep(200);
  }
  throw new Error(`${label ?? url} did not become ready within ${timeoutMs}ms: ${lastError}`);
}

/**
 * True when a **TCP** connection to the port is refused.
 *
 * `isPortClosed` above probes `/health`, which is correct for the backend but wrong for the Vite
 * port while the backend is up: Vite proxies `/health`, so the probe would report "open" even
 * after Vite itself has exited. A restart with a different `VITE_*` environment needs the
 * listener itself to be gone, so this asks the transport directly.
 */
function isTcpPortClosed(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const settle = (closed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(false));
    socket.once('error', () => settle(true));
  });
}

/** Wait until a TCP port refuses connections, or throw. */
async function waitForTcpPortClosed(port, { host = '127.0.0.1', timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTcpPortClosed(port, host)) return;
    await sleep(100);
  }
  throw new Error(`port ${port} is still accepting TCP connections`);
}

/** True when nothing accepts a TCP connection on the port. */
export async function isPortClosed(port, host = '127.0.0.1') {
  try {
    await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return true;
  }
}

/** Wait until a port accepts a connection, or throw. */
export async function waitForPortOpen(port, { host = '127.0.0.1', timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortClosed(port, host))) return;
    await sleep(100);
  }
  throw new Error(`port ${port} never started accepting connections`);
}

/** Wait until nothing accepts a connection on the port, or throw. */
export async function waitForPortClosed(port, { host = '127.0.0.1', timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortClosed(port, host)) return;
    await sleep(100);
  }
  throw new Error(`port ${port} is still accepting connections`);
}

export class DevStack {
  #repoRoot;
  #serverPort;
  #webPort;
  #server = null;
  #web = null;
  /**
   * Extra variables merged **after** the frozen defaults (`PORT`, `HOST`, `INSIGHTHUB_*`).
   *
   * Kept as overrides rather than a resolved object so `setServerEnv({ AI_PROVIDER: undefined })`
   * can mean "delete this key" instead of "set it to the string `undefined`".
   */
  #serverEnvOverrides;
  #webEnvOverrides;
  #dataPath = null;
  /** Every temporary directory this stack created, so `dispose` can remove all of them. */
  #createdDataPaths = new Set();
  #restartCount = 0;

  constructor({
    repoRoot,
    serverPort = DEFAULT_SERVER_PORT,
    webPort = DEFAULT_WEB_PORT,
    dataPath = null,
    serverEnv = {},
    webEnv = {},
  }) {
    this.#repoRoot = repoRoot;
    this.#serverPort = serverPort;
    this.#webPort = webPort;
    this.#serverEnvOverrides = { ...serverEnv };
    this.#webEnvOverrides = { ...webEnv };
    this.#dataPath = dataPath;
  }

  /** The server environment the next start will use (defaults first, overrides last). */
  #resolvedServerEnv() {
    // The server reads `PORT` for its listen port; the Vite proxy reads the same variable for
    // its backend target, so one value keeps them in agreement.
    //
    // One suite run opens far more pages from 127.0.0.1 than a human ever would, so the
    // bootstrap guard (10/min by default) would answer 429 mid-run. The limit is configuration,
    // not a test-only branch: raising it here keeps the guard itself under test.
    return {
      PORT: String(this.#serverPort),
      HOST: '127.0.0.1',
      BOOTSTRAP_RATE_LIMIT_PER_MINUTE: '10000',
      // One suite run performs far more AI generations for demo-ada than the 20/hour budget
      // allows; raising it through the same configuration keeps the limiter code under test.
      AI_RATE_LIMIT_PER_HOUR: '10000',
      AI_RATE_LIMIT_PER_DAY: '100000',
      ...this.#serverEnvOverrides,
    };
  }

  /** The Vite environment the next start will use. */
  #resolvedWebEnv() {
    // `INSIGHTHUB_WEB_PORT` is what `apps/web/vite.config.ts` listens on, so a second
    // worktree can run the suite without fighting the first one for 5173/3101.
    return {
      PORT: String(this.#serverPort),
      INSIGHTHUB_SERVER_HOST: '127.0.0.1',
      INSIGHTHUB_WEB_PORT: String(this.#webPort),
      /*
       * The suite always runs the **demo** web path. `apps/web/.env.local` may hold a real
       * `VITE_CLERK_PUBLISHABLE_KEY` (the owner's Clerk instance); Vite would then render the
       * Clerk sign-in gate and no scenario would ever reach `POST /api/session/bootstrap`.
       * Process env wins over `.env` files in Vite, so an explicit empty value keeps the
       * suite on the demo path. Clerk-mode browser evidence belongs to the staging smoke
       * (B13), not to this local suite.
       */
      VITE_CLERK_PUBLISHABLE_KEY: '',
      ...this.#webEnvOverrides,
    };
  }

  /**
   * Change the extra server environment for the **next** server start.
   *
   * Takes effect on `startServer` / `restartServer`; a value of `undefined` deletes the key.
   * Used by the M3 Round 2 remote-AI group to flip `AI_PROVIDER=stub` on and off without
   * touching the default (unset) configuration every other scenario measures.
   */
  setServerEnv(overrides = {}) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete this.#serverEnvOverrides[key];
      else this.#serverEnvOverrides[key] = String(value);
    }
  }

  /**
   * Change the extra Vite environment for the **next** web start.
   *
   * `VITE_*` variables are inlined at module-transform time in dev, so a change only takes
   * effect after `stopWeb()` + `startWeb()`; `undefined` deletes the key.
   */
  setWebEnv(overrides = {}) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete this.#webEnvOverrides[key];
      else this.#webEnvOverrides[key] = String(value);
    }
  }

  /** Extra server variables currently staged for the next start (never includes port/host). */
  get extraServerEnv() {
    return { ...this.#serverEnvOverrides };
  }

  /** Extra Vite variables currently staged for the next start (never includes port/host). */
  get extraWebEnv() {
    return { ...this.#webEnvOverrides };
  }

  get serverPort() {
    return this.#serverPort;
  }

  get webPort() {
    return this.#webPort;
  }

  get appUrl() {
    return `http://127.0.0.1:${this.#webPort}/`;
  }

  get wsUrl() {
    return `ws://127.0.0.1:${this.#webPort}/ws`;
  }

  /** The directory the running server persists into. */
  get dataPath() {
    return this.#dataPath;
  }

  /** The server child's pid, for "is it really a different process" assertions. */
  get serverPid() {
    return this.#server?.child.pid ?? null;
  }

  get serverRunning() {
    return this.#server !== null && this.#server.child.exitCode === null;
  }

  /** How many times the server process has been started (1 = never restarted). */
  get serverStarts() {
    return this.#restartCount;
  }

  /**
   * Create a **new**, empty, uniquely named data directory.
   *
   * Deliberately not applied: a scenario decides when to restart onto it, so
   * "clean state" is an explicit transition rather than an invisible one.
   */
  async createDataPath(label = 'm2') {
    const directory = await mkdtemp(path.join(tmpdir(), `insighthub-a6-${label}-`));
    this.#createdDataPaths.add(directory);
    return directory;
  }

  async start() {
    if (this.#dataPath === null) this.#dataPath = await this.createDataPath('run');
    await this.startServer();
    await this.startWeb();
  }

  async startServer() {
    if (this.#server !== null) return;
    if (this.#dataPath === null) this.#dataPath = await this.createDataPath('run');
    const entry = path.join(
      this.#repoRoot,
      'apps',
      'server',
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    );
    const { child, log } = run(process.execPath, [entry, 'src/index.ts'], {
      cwd: path.join(this.#repoRoot, 'apps', 'server'),
      env: { ...this.#resolvedServerEnv(), INSIGHTHUB_DATA_PATH: this.#dataPath },
    });
    this.#server = { child, log };
    this.#restartCount += 1;
    try {
      // `/health` is served only after the durable store opened, so a successful
      // probe is also evidence that the capability check passed (`D-051`).
      await waitForHttp(`http://127.0.0.1:${this.#serverPort}/health`, {
        label: 'the backend',
      });
    } catch (error) {
      await this.stopServer();
      throw new Error(`${error.message}\n--- server output ---\n${log.stdout}\n${log.stderr}`);
    }
  }

  async startWeb() {
    if (this.#web !== null) return;
    const entry = path.join(
      this.#repoRoot,
      'apps',
      'web',
      'node_modules',
      'vite',
      'bin',
      'vite.js',
    );
    const { child, log } = run(process.execPath, [entry], {
      cwd: path.join(this.#repoRoot, 'apps', 'web'),
      env: this.#resolvedWebEnv(),
    });
    this.#web = { child, log };
    try {
      await waitForHttp(this.appUrl, { label: 'the Vite dev server' });
    } catch (error) {
      await this.stopWeb();
      throw new Error(`${error.message}\n--- vite output ---\n${log.stdout}\n${log.stderr}`);
    }
  }

  /** Kill the backend gracefully where the platform allows it. */
  async stopServer() {
    if (this.#server === null) return;
    await terminate(this.#server.child, { graceful: true });
    this.#server = null;
    await waitForPortClosed(this.#serverPort);
  }

  /**
   * Kill the backend **without** a graceful shutdown.
   *
   * This is the process-death case the durability scenarios need: no `SIGTERM`
   * handler runs, `store.close()` never happens, and the WAL is left exactly as the
   * last committed transaction wrote it. A restart must still recover.
   */
  async crashServer() {
    if (this.#server === null) return;
    await terminate(this.#server.child, { graceful: false });
    this.#server = null;
    await waitForPortClosed(this.#serverPort);
  }

  /**
   * Crash the server and start a **new process** on the same data directory.
   *
   * Returns the pid before and after, which is what lets a scenario prove this was a
   * real process restart rather than a reconnect.
   */
  async restartServer({ dataPath } = {}) {
    const before = this.serverPid;
    await this.crashServer();
    if (dataPath !== undefined && dataPath !== null) this.#dataPath = dataPath;
    await this.startServer();
    return { before, after: this.serverPid };
  }

  /** Crash and start again on a brand-new, empty data directory. */
  async restartServerOnFreshDataPath(label = 'scenario') {
    const before = this.serverPid;
    await this.crashServer();
    this.#dataPath = await this.createDataPath(label);
    await this.startServer();
    return { before, after: this.serverPid, dataPath: this.#dataPath };
  }

  /**
   * Stop Vite and wait until its port is released.
   *
   * The wait is what makes a **restart with a different environment** safe: Vite runs with
   * `strictPort`, so starting the replacement while the previous listener is still bound would
   * fail (or, worse, be answered by the old process with the old `VITE_*` values).
   */
  async stopWeb() {
    if (this.#web === null) return;
    await terminate(this.#web.child, { graceful: true });
    this.#web = null;
    await waitForTcpPortClosed(this.#webPort);
  }

  serverLog() {
    return this.#server === null ? '' : `${this.#server.log.stdout}\n${this.#server.log.stderr}`;
  }

  webLog() {
    return this.#web === null ? '' : `${this.#web.log.stdout}\n${this.#web.log.stderr}`;
  }

  /** Crash, stop Vite, and remove every temporary data directory this stack made. */
  async dispose() {
    await this.stopWeb();
    await this.crashServer();
    const removed = [];
    for (const directory of this.#createdDataPaths) {
      try {
        await rm(directory, { recursive: true, force: true });
        removed.push(directory);
      } catch {
        /* best effort: a leaked temp dir must not fail the run */
      }
    }
    this.#createdDataPaths.clear();
    return removed;
  }
}
