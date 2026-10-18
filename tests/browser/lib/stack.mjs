/**
 * Start, stop and restart the **real** dev stack for the A6 browser suite.
 *
 * Two real processes are spawned, exactly as `pnpm dev` would:
 *
 * - `apps/server` — the real Express + `ws` server (`tsx src/index.ts`),
 * - `apps/web` — the real Vite dev server, which proxies `/ws` to the backend.
 *
 * They are spawned through `node <entry>` rather than through `pnpm` so that the
 * child we hold a handle to *is* the server. That matters for the offline tests:
 * `stopServer()` must be an unambiguous, verifiable process death, and
 * `startServer()` must bring the identical configuration back.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { sleep } from './cdp.mjs';

const READY_TIMEOUT_MS = 60_000;

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
    if (log.stdout.length > 200_000) log.stdout = log.stdout.slice(-100_000);
  });
  child.stderr.on('data', (chunk) => {
    log.stderr += chunk.toString();
    if (log.stderr.length > 200_000) log.stderr = log.stderr.slice(-100_000);
  });
  return { child, log };
}

/** Terminate a process and, on Windows, its whole tree. */
async function terminate(child) {
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
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

export class DevStack {
  #repoRoot;
  #serverPort;
  #webPort;
  #server = null;
  #web = null;
  #serverEnv;
  #webEnv;

  constructor({ repoRoot, serverPort = 3101, webPort = 5173 }) {
    this.#repoRoot = repoRoot;
    this.#serverPort = serverPort;
    this.#webPort = webPort;
    // The Vite proxy reads `PORT` for its backend target, and the server reads the
    // same variable for its listen port — one value keeps them in agreement.
    this.#serverEnv = { PORT: String(serverPort), HOST: '127.0.0.1' };
    this.#webEnv = { PORT: String(serverPort), INSIGHTHUB_SERVER_HOST: '127.0.0.1' };
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

  async start() {
    await this.startServer();
    await this.startWeb();
  }

  async startServer() {
    if (this.#server !== null) return;
    const entry = path.join(this.#repoRoot, 'apps', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const { child, log } = run(process.execPath, [entry, 'src/index.ts'], {
      cwd: path.join(this.#repoRoot, 'apps', 'server'),
      env: this.#serverEnv,
    });
    this.#server = { child, log };
    try {
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
    const entry = path.join(this.#repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
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

  /** Kill the backend. Used to make a genuine offline condition for the clients. */
  async stopServer() {
    if (this.#server === null) return;
    await terminate(this.#server.child);
    this.#server = null;
    // Confirm the socket is really gone rather than assuming it.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await isPortClosed(this.#serverPort)) return;
      await sleep(150);
    }
    throw new Error(`the backend port ${this.#serverPort} is still accepting connections`);
  }

  async stopWeb() {
    if (this.#web === null) return;
    await terminate(this.#web.child);
    this.#web = null;
  }

  serverLog() {
    return this.#server === null ? '' : `${this.#server.log.stdout}\n${this.#server.log.stderr}`;
  }

  webLog() {
    return this.#web === null ? '' : `${this.#web.log.stdout}\n${this.#web.log.stderr}`;
  }

  async dispose() {
    await this.stopWeb();
    await this.stopServer();
  }
}
