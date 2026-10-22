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
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
    env: { ...process.env, ...env },
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
  #serverEnv;
  #webEnv;
  #dataPath = null;
  /** Every temporary directory this stack created, so `dispose` can remove all of them. */
  #createdDataPaths = new Set();
  #restartCount = 0;

  constructor({ repoRoot, serverPort = DEFAULT_SERVER_PORT, webPort = DEFAULT_WEB_PORT, dataPath = null }) {
    this.#repoRoot = repoRoot;
    this.#serverPort = serverPort;
    this.#webPort = webPort;
    // The Vite proxy reads `PORT` for its backend target, and the server reads the
    // same variable for its listen port — one value keeps them in agreement.
    this.#serverEnv = { PORT: String(serverPort), HOST: '127.0.0.1' };
    // `INSIGHTHUB_WEB_PORT` is what `apps/web/vite.config.ts` listens on, so a second
    // worktree can run the suite without fighting the first one for 5173/3101.
    this.#webEnv = {
      PORT: String(serverPort),
      INSIGHTHUB_SERVER_HOST: '127.0.0.1',
      INSIGHTHUB_WEB_PORT: String(webPort),
    };
    this.#dataPath = dataPath;
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
      env: { ...this.#serverEnv, INSIGHTHUB_DATA_PATH: this.#dataPath },
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
      env: this.#webEnv,
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

  async stopWeb() {
    if (this.#web === null) return;
    await terminate(this.#web.child, { graceful: true });
    this.#web = null;
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
