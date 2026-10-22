#!/usr/bin/env node
/**
 * A6 · M4 B10 — **production-like gate**.
 *
 * This is not another unit suite. It boots the **real, compiled** server
 * (`apps/server/dist/index.js`) against the **real web build** (`apps/web/dist`), talks to it
 * over real HTTP and real WebSocket upgrades, kills and restarts real processes, then restores
 * a real logical backup. Every check records what the process actually did; a failed check
 * makes the script exit non-zero.
 *
 * ```bash
 * pnpm build                       # required: this gate only uses build artifacts
 * node tests/production/run.mjs
 * ```
 *
 * ## What it proves, layer by layer
 *
 * | Group | Evidence |
 * | --- | --- |
 * | production mode | `NODE_ENV=production`, clerk auth, fake credential, absolute data path, static build; `/health`, `/ready`, SPA shell, JS asset, API 404, demo bootstrap absent, Origin 403, source-map refusal |
 * | production refusals | seven real child processes, each exiting 1 with its stable code and **no listener** |
 * | dev durability | seeded document → real HTTP + WS hydration → process death → same data directory → same document |
 * | backup / restore | scheduler's `backup.completed`, non-empty file, `backup-cli.ts restore` into a new directory, content read back through `openDocumentStore` and a restarted server |
 * | corruption | garbage database → exit 1 with `DATA_INTEGRITY_FAILED`, file left untouched |
 * | graceful shutdown | a real compiled process exits 0 through its own `SIGTERM` handler (see the Windows note below) |
 *
 * ## Windows / `SIGTERM` — stated honestly
 *
 * Windows has no POSIX signals. `child.kill('SIGTERM')` is `TerminateProcess`: the child exits
 * with `code: null, signal: 'SIGTERM'` and the `process.on('SIGTERM')` handler never runs. The
 * B10 brief asks for `SIGTERM → exit 0`; that assertion is therefore **SKIPPED on win32** and
 * the gate says so. Two independent pieces of evidence are still produced:
 *
 * 1. the real process is killed with `SIGTERM`, and the **restart** proves the durable state
 *    survived that (harsher) death;
 * 2. a test-only preload (`lib/emit-sigterm-after-ready.mjs`) calls `process.emit('SIGTERM')`
 *    inside the real compiled process once `/ready` is 200, proving the product's own shutdown
 *    handler closes the transports/store and exits 0. That is **handler evidence, not OS-signal
 *    evidence**, and the check title says so.
 *
 * On POSIX the gate sends the real signal and asserts `exit 0`; the skip disappears.
 *
 * ## Credential hygiene
 *
 * The clerk secret is a generated-looking **fake**, never a real credential. It is never printed
 * by this script, and the gate asserts it does not appear in the server's structured log either.
 * `OPENAI_API_KEY` is removed from the child environment; `AI_PROVIDER=disabled`.
 *
 * ## Isolation / cleanup
 *
 * Every data directory, backup directory and restored directory is created under one
 * `mkdtemp` root. Every child is tracked. Cleanup runs in `finally`, including after a failed
 * check, and force-kills anything still alive on Windows. `--keep-temp` preserves the root for
 * debugging (the default is to remove it).
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { importDependency, loadShared, loadYjs, repoRoot } from '../browser/lib/deps.mjs';

/* ================================================================== *
 * Paths and constants
 * ================================================================== */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVER_ENTRY = join(repoRoot, 'apps', 'server', 'dist', 'index.js');
const SERVER_SOURCE_ROOT = join(repoRoot, 'apps', 'server');
const BACKUP_CLI = join(SERVER_SOURCE_ROOT, 'src', 'persistence', 'backup-cli.ts');
const WEB_DIST = join(repoRoot, 'apps', 'web', 'dist');
const WEB_INDEX = join(WEB_DIST, 'index.html');
const WEB_ASSETS = join(WEB_DIST, 'assets');
const GRACEFUL_PRELOAD = join(HERE, 'lib', 'emit-sigterm-after-ready.mjs');

/** The only browser origin the production process allows. `.test` is reserved (RFC 6761). */
const PRODUCTION_ORIGIN = 'https://example.test';
/** The development origin `config.ts` defaults to; used by the dev-mode real process. */
const DEVELOPMENT_ORIGIN = 'http://localhost:5173';

/**
 * A syntactically plausible but entirely **fake** Clerk secret.
 *
 * It is long enough that a naive "present" check cannot pass it by accident, and it is
 * deliberately a fixed, recognisable marker. It is never a real credential and is never
 * printed by this script. B10 does not call Clerk: with no real session cookie every protected
 * request fails closed before the SDK has anything to verify.
 */
const FAKE_CLERK_SECRET = 'sk_test_A6B10_FAKE_NOT_A_REAL_SECRET_0123456789abcdef';

const KEEP_TEMP = process.argv.includes('--keep-temp');

/** Environment keys this gate must own, so a developer's shell cannot change the scenario. */
const OWNED_ENV_KEYS = [
  'NODE_ENV',
  'AUTH_MODE',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'VITE_CLERK_PUBLISHABLE_KEY',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'CORS_ORIGIN',
  'INSIGHTHUB_DATA_PATH',
  'AI_PROVIDER',
  'STATIC_DIR',
  'BACKUP_ENABLED',
  'BACKUP_DIR',
  'BACKUP_RETENTION_DAYS',
  'HOST',
  'PORT',
  'WS_PATH',
  'LOG_LEVEL',
  'BOOTSTRAP_RATE_LIMIT_PER_MINUTE',
  'DATA_MIN_FREE_BYTES',
  'AI_RATE_LIMIT_PER_HOUR',
  'AI_RATE_LIMIT_PER_DAY',
  'AI_MAX_CONCURRENT_PER_USER',
  'AI_MAX_CONCURRENT_SERVER',
  'NODE_OPTIONS',
];

/* ================================================================== *
 * Small utilities
 * ================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function snippet(value, max = 260) {
  const text = String(value ?? '').replace(/\r?\n/g, '\\n');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function tail(text, lines = 8) {
  const all = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  return all.slice(-lines).join('\n');
}

function header(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function contentType(headers) {
  return String(header(headers, 'content-type') ?? '').toLowerCase();
}

/** A clean child environment with every scenario-owned key removed, then explicit overrides. */
function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of OWNED_ENV_KEYS) delete environment[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = String(value);
  }
  return environment;
}

/** One free IPv4 loopback port, released before the caller binds it. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => {
        if (port === null) reject(new Error('could not read the allocated port'));
        else resolve(port);
      });
    });
  });
}

/** True when a TCP connect to loopback:port is refused (nothing is listening). */
async function isPortClosed(port) {
  return await new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port, timeout: 600 });
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => finish(false));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(true));
  });
}

async function waitForPortClosed(port, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortClosed(port)) return true;
    await sleep(100);
  }
  return await isPortClosed(port);
}

/** One HTTP request with a bounded lifetime and no keep-alive socket left behind. */
async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 8_000,
    redirect = 'manual',
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { connection: 'close', ...headers },
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
      redirect,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON; the caller decides whether that is expected.
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `GET /ready` until 200, with the real child output in the failure path. */
async function waitForReady(baseUrl, server, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const response = await httpRequest(`${baseUrl}/ready`, { timeoutMs: 1_000 });
      if (response.status === 200) return response;
      last = `HTTP ${response.status} ${snippet(response.text)}`;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await sleep(100);
  }
  throw new Error(
    `GET /ready did not answer 200 within ${timeoutMs}ms (last: ${last})\n${tail(server.output())}`,
  );
}

/** One raw HTTP upgrade attempt. A refusal is a normal HTTP response, not an open socket. */
async function tryWebSocketUpgrade(port, origin) {
  const { request } = await import('node:http');
  return await new Promise((resolve, reject) => {
    const headers = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    };
    if (origin !== undefined) headers.origin = origin;
    const request_ = request(
      { host: '127.0.0.1', port, path: '/ws', method: 'GET', headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ kind: 'response', status: response.statusCode, headers: response.headers, body });
        });
      },
    );
    request_.on('upgrade', (response, socket) => {
      // A socket that opened is exactly the failure this helper must surface.
      socket.destroy();
      resolve({ kind: 'upgrade', status: response.statusCode, headers: response.headers, body: '' });
    });
    request_.on('error', reject);
    request_.end();
  });
}

/* ================================================================== *
 * Structured child process
 * ================================================================== */

class ServerProcess {
  #waiters = new Set();
  #exitPromise;
  #resolveExit;
  #partial = { stdout: '', stderr: '' };

  constructor(label, child) {
    this.label = label;
    this.child = child;
    this.stdout = '';
    this.stderr = '';
    this.lines = [];
    this.exit = null;
    this.spawnError = null;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#ingest('stdout', chunk));
    child.stderr.on('data', (chunk) => this.#ingest('stderr', chunk));
    child.on('error', (error) => {
      this.spawnError = error;
      this.#resolveExit({ code: null, signal: null, error });
    });
    child.on('exit', (code, signal) => {
      this.exit = { code, signal };
      for (const waiter of [...this.#waiters]) waiter();
      this.#resolveExit({ code, signal });
    });
  }

  static spawnRequest(label, { args = [SERVER_ENTRY], env, cwd = repoRoot } = {}) {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return new ServerProcess(label, child);
  }

  #ingest(stream, chunk) {
    this[stream] += chunk;
    this.#partial[stream] += chunk;
    const parts = this.#partial[stream].split('\n');
    this.#partial[stream] = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      let json = null;
      try {
        json = JSON.parse(line);
      } catch {
        // Human line (the Node experimental-SQLite warning, for example).
      }
      this.lines.push({ stream, line, json });
    }
    for (const waiter of [...this.#waiters]) waiter();
  }

  output() {
    return `${this.stdout}\n${this.stderr}`;
  }

  hasEvent(event) {
    return this.lines.some((line) => line.json?.event === event);
  }

  event(event) {
    return this.lines.find((line) => line.json?.event === event)?.json ?? null;
  }

  /** Resolve the first event line (already received or future), or `null` on timeout. */
  async waitForEvent(event, timeoutMs = 15_000) {
    const existing = this.lines.find((line) => line.json?.event === event);
    if (existing !== undefined) return existing.json;

    return await new Promise((resolve) => {
      const check = () => {
        const found = this.lines.find((line) => line.json?.event === event);
        if (found === undefined) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
        resolve(found.json);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        resolve(null);
      }, timeoutMs);
      this.#waiters.add(check);
      check();
    });
  }

  async waitForExit(timeoutMs = 20_000) {
    if (this.exit !== null) return { ...this.exit, timedOut: false };
    if (this.spawnError !== null) throw this.spawnError;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const result = await Promise.race([this.#exitPromise, timeout]);
    clearTimeout(timer);
    if (result.timedOut) return { timedOut: true };
    if (result.error !== undefined) throw result.error;
    return { code: result.code, signal: result.signal, timedOut: false };
  }

  /** Send a signal (on Windows this is a hard `TerminateProcess`, see the file header). */
  async stop(signal = 'SIGTERM', timeoutMs = 8_000) {
    if (this.exit !== null) return { ...this.exit, timedOut: false };
    const exitPromise = this.waitForExit(timeoutMs);
    try {
      this.child.kill(signal);
    } catch {
      // The process may already be gone between the check and the call.
    }
    const result = await exitPromise;
    if (!result.timedOut) return result;
    await this.forceKill();
    return await this.waitForExit(5_000);
  }

  async forceKill() {
    if (this.exit !== null) return;
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        await new Promise((resolve) => killer.once('exit', resolve));
      } else {
        this.child.kill('SIGKILL');
      }
    } catch {
      // Best effort; the exit assertion is what reports the real outcome.
    }
  }
}

async function startCompiledServer(label, env, { args = [SERVER_ENTRY], cwd = repoRoot } = {}) {
  const port = Number(env.PORT);
  const server = ServerProcess.spawnRequest(label, { args, env, cwd });
  const listening = await server.waitForEvent('server.listening', 30_000);
  if (listening === null) {
    const exit = await server.waitForExit(1_000);
    await server.forceKill();
    throw new Error(
      `${label} did not log server.listening\n` +
        `exit=${JSON.stringify(exit)}\n${tail(server.output(), 12)}`,
    );
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl, server);
  return { server, baseUrl, port, listening };
}

/* ================================================================== *
 * Real WebSocket client (development / hydration paths)
 * ================================================================== */

class WsClient {
  #messages = [];
  #binary = [];
  #waiters = new Set();
  #closed = false;

  constructor(socket) {
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.on('open', () => this.#notify());
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#binary.push(
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      } else {
        try {
          this.#messages.push(JSON.parse(String(data)));
        } catch {
          // The server never legitimately sends a non-JSON text frame; ignore it here and let
          // the awaited message time out with the real evidence.
        }
      }
      this.#notify();
    });
    socket.on('close', () => {
      this.#closed = true;
      this.#notify();
    });
    socket.on('error', () => this.#notify());
  }

  static async connect(url, headers = {}) {
    const { WebSocket } = await loadWebSocket();
    const socket = new WebSocket(url, {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    const client = new WsClient(socket);
    await client.#waitOpen();
    return client;
  }

  #waitOpen(timeoutMs = 15_000) {
    if (this.socket.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WebSocket did not open within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  #notify() {
    for (const waiter of [...this.#waiters]) waiter();
  }

  async waitForText(type, timeoutMs = 8_000) {
    const existing = this.#messages.find((message) => message?.type === type);
    if (existing !== undefined) return existing;
    return await new Promise((resolve, reject) => {
      const check = () => {
        const found = this.#messages.find((message) => message?.type === type);
        if (found === undefined) return;
        cleanup();
        resolve(found);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `timed out waiting for WS text ${type}; received ${JSON.stringify(
              this.#messages.map((message) => message?.type),
            )}`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#waiters.delete(check);
      };
      this.#waiters.add(check);
      check();
    });
  }

  async waitForBinary(timeoutMs = 8_000) {
    if (this.#binary.length > 0) return;
    await new Promise((resolve, reject) => {
      const check = () => {
        if (this.#binary.length === 0) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for a binary frame (${timeoutMs}ms)`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#waiters.delete(check);
      };
      this.#waiters.add(check);
      check();
    });
  }

  takeBinary() {
    const frames = [...this.#binary];
    this.#binary.length = 0;
    return frames;
  }

  sendJson(value) {
    this.socket.send(JSON.stringify(value));
  }

  sendBinary(bytes) {
    this.socket.send(bytes);
  }

  async close() {
    if (this.#closed) return;
    try {
      this.socket.close();
    } catch {
      // Already closing.
    }
    const deadline = Date.now() + 3_000;
    while (!this.#closed && Date.now() < deadline) await sleep(50);
    if (!this.#closed) {
      try {
        this.socket.terminate();
      } catch {
        // Already gone.
      }
    }
  }
}

let webSocketModulePromise;
function loadWebSocket() {
  webSocketModulePromise ??= importDependency('ws').then((module) => {
    const implementation = module.WebSocket ?? module.default;
    if (typeof implementation !== 'function') {
      throw new Error('the resolved `ws` module exposed no WebSocket constructor');
    }
    return { WebSocket: implementation };
  });
  return webSocketModulePromise;
}

/**
 * Connect with a real cookie, join a real room, perform the frozen client-initiated SyncStep1
 * handshake, and apply every SYNC payload the server sends. Returns the hydrated text.
 */
async function hydrateOverWebSocket({ port, cookie, origin, documentId, expectedText }) {
  const url = `ws://127.0.0.1:${port}/ws`;
  const client = await WsClient.connect(url, { cookie, origin });
  try {
    await client.waitForText('connected');
    client.sendJson(
      shared.createEnvelope(shared.WS_MESSAGE_TYPES.joinRoom, {
        documentId,
        protocolVersion: shared.PROTOCOL_VERSION,
        mode: 'readwrite',
      }),
    );
    const joined = await client.waitForText('room-joined');

    const document = new Y.Doc();
    let applied = 0;
    let binaryFrames = 0;

    client.sendBinary(shared.encodeSyncStep1(document));
    await client.waitForBinary();

    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      for (const frame of client.takeBinary()) {
        binaryFrames += 1;
        const decoded = shared.decodeSyncFrame(frame);
        if (decoded === null) continue;
        const messageType = shared.readSyncMessageType(decoded);
        let update = null;
        if (messageType === shared.SYNC_MESSAGE_TYPES.step2) {
          update = shared.readSyncStep2Payload(decoded);
        } else if (messageType === shared.SYNC_MESSAGE_TYPES.update) {
          update = shared.readSyncUpdatePayload(decoded);
        }
        if (update !== null && update.byteLength > 0) {
          Y.applyUpdate(document, update);
          applied += 1;
        }
      }
      if (document.getText('content').toString() === expectedText) break;
      await sleep(100);
    }

    const text = document.getText('content').toString();
    if (text !== expectedText) {
      throw new Error(
        `WS hydration mismatch: expected ${JSON.stringify(expectedText)}, got ${JSON.stringify(text)}; ` +
          `binaryFrames=${binaryFrames} applied=${applied} joined=${snippet(JSON.stringify(joined.payload))}`,
      );
    }
    return {
      text,
      binaryFrames,
      applied,
      joined: joined.payload,
    };
  } finally {
    await client.close();
  }
}

/* ================================================================== *
 * Check registry / reporting
 * ================================================================== */

const results = [];

function printResult(result) {
  const duration = result.durationMs === undefined ? '' : ` (${result.durationMs}ms)`;
  console.log(`[${result.status}] ${result.id} — ${result.title}${duration}`);
  if (result.detail) console.log(`        ${result.detail}`);
  for (const line of result.evidence ?? []) console.log(`        · ${line}`);
}

async function check(id, title, fn) {
  const startedAt = Date.now();
  try {
    const value = await fn();
    const result = {
      id,
      title,
      status: 'PASS',
      detail: typeof value === 'string' ? value : (value?.detail ?? ''),
      evidence: typeof value === 'object' && value !== null ? (value.evidence ?? []) : [],
      durationMs: Date.now() - startedAt,
    };
    results.push(result);
    printResult(result);
    return result;
  } catch (error) {
    const result = {
      id,
      title,
      status: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
      evidence: [],
      durationMs: Date.now() - startedAt,
    };
    results.push(result);
    printResult(result);
    if (process.env.A6_B10_DEBUG === '1' && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return result;
  }
}

function skip(id, title, reason, evidence = []) {
  const result = { id, title, status: 'SKIP', detail: reason, evidence };
  results.push(result);
  printResult(result);
  return result;
}

function recordFail(id, title, reason) {
  const result = { id, title, status: 'FAIL', detail: reason, evidence: [] };
  results.push(result);
  printResult(result);
}

/* ================================================================== *
 * Main
 * ================================================================== */

const shared = await loadShared();
const Y = await loadYjs();

/** Assigned by `main()` after preflight, so a missing build produces a clear message. */
let openDocumentStore = null;

const state = {
  tempRoot: null,
  dirs: {},
  ports: {},
  servers: [],
  usedPorts: new Set(),
};

function createDirs() {
  const root = mkdtempSync(join(tmpdir(), 'insighthub-a6-b10-'));
  state.tempRoot = root;
  state.dirs = {
    prod: join(root, 'prod-data'),
    prodA: join(root, 'prod-a-data'),
    prodB: join(root, 'prod-b-data'),
    prodC: join(root, 'prod-c-data'),
    prodD: join(root, 'prod-d-data'),
    prodE: join(root, 'prod-e-data'),
    prodF: join(root, 'prod-f-data'),
    prodG: join(root, 'prod-g-data'),
    dev: join(root, 'dev-data'),
    backups: join(root, 'dev-backups'),
    restored: join(root, 'restored-data'),
    graceful: join(root, 'graceful-data'),
    corrupt: join(root, 'corrupt-data'),
    emptyStatic: join(root, 'empty-static'),
    missingStatic: join(root, 'missing-static'),
  };
  for (const directory of [
    state.dirs.prod,
    state.dirs.dev,
    state.dirs.restored,
    state.dirs.graceful,
    state.dirs.corrupt,
    state.dirs.emptyStatic,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  // `missingStatic` is deliberately not created: `STATIC_DIR_MISSING` must be produced for a
  // directory that does not exist, and `emptyStatic` covers the "exists but has no index.html"
  // condition.
}

function remember(server) {
  if (server !== null && server !== undefined) state.servers.push(server);
  return server;
}

function rememberPort(port) {
  state.usedPorts.add(port);
  return port;
}

async function preflight() {
  console.log('A6 · M4 B10 — production-like gate');
  console.log(`  base:      ${repoRoot}`);
  console.log(`  server:    ${SERVER_ENTRY}`);
  console.log(`  web build: ${WEB_DIST}`);
  console.log(`  node:      ${process.version} (${process.platform}/${process.arch})`);
  console.log(`  fake Clerk secret: ${FAKE_CLERK_SECRET.length} characters (not a credential)`);

  ensure(existsSync(SERVER_ENTRY), `missing ${SERVER_ENTRY}; run \`pnpm build\` first`);
  ensure(existsSync(WEB_INDEX), `missing ${WEB_INDEX}; run \`pnpm build\` first`);
  ensure(existsSync(WEB_ASSETS), `missing ${WEB_ASSETS}; run \`pnpm build\` first`);
  const assets = readdirSync(WEB_ASSETS);
  ensure(assets.some((name) => name.endsWith('.js')), 'web build has no JavaScript asset');
  ensure(assets.some((name) => name.endsWith('.js.map')), 'web build has no source map to probe');

  const major = Number.parseInt(process.version.replace(/^v/, ''), 10);
  ensure(Number.isInteger(major) && major >= 22, `Node >= 22 is required, got ${process.version}`);

  for (const name of ['prod', 'dev1', 'dev2', 'restored', 'graceful', 'corrupt']) {
    const port = rememberPort(await freePort());
    ensure(await isPortClosed(port), `preflight: port ${port} is unexpectedly open`);
    state.ports[name] = port;
  }
  console.log(
    `  ports:     prod=${state.ports.prod} dev1=${state.ports.dev1} dev2=${state.ports.dev2} ` +
      `restored=${state.ports.restored} graceful=${state.ports.graceful} corrupt=${state.ports.corrupt}`,
  );
  console.log('  credentials: OPENAI_API_KEY removed; CLERK_SECRET_KEY is a fake');
  console.log('');
}

/* ------------------------------------------------------------------ *
 * Group 1 — production-mode refusals (real processes)
 * ------------------------------------------------------------------ */

function productionEnvironment(overrides = {}) {
  return cleanEnvironment({
    NODE_ENV: 'production',
    AUTH_MODE: 'clerk',
    CLERK_SECRET_KEY: FAKE_CLERK_SECRET,
    CORS_ORIGIN: PRODUCTION_ORIGIN,
    INSIGHTHUB_DATA_PATH: state.dirs.prod,
    AI_PROVIDER: 'disabled',
    // STATIC_DIR is deliberately NOT set here: `render.yaml` does not set it either, so the
    // production server must resolve its default from `config.ts` (the repository's
    // `apps/web/dist`), and `prod/startup-config` asserts that resolved value. Refusal scenarios
    // that need a broken build override STATIC_DIR explicitly.
    HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    ...overrides,
  });
}

/** The development-mode environment used by every real dev process in this gate. */
function developmentEnvironment(port, { dataPath = state.dirs.dev, backup = false, overrides = {} } = {}) {
  return cleanEnvironment({
    NODE_ENV: 'test',
    AUTH_MODE: 'demo',
    INSIGHTHUB_DATA_PATH: dataPath,
    CORS_ORIGIN: DEVELOPMENT_ORIGIN,
    AI_PROVIDER: 'disabled',
    ...(backup
      ? {
          BACKUP_ENABLED: 'true',
          BACKUP_DIR: state.dirs.backups,
          BACKUP_RETENTION_DAYS: '7',
        }
      : {}),
    STATIC_DIR: WEB_DIST,
    HOST: '127.0.0.1',
    PORT: port,
    LOG_LEVEL: 'info',
    ...overrides,
  });
}

async function expectStartupRefusal({ id, title, env, code }) {
  await check(id, title, async () => {
    const port = Number(env.PORT);
    const process_ = remember(ServerProcess.spawnRequest(id, { env }));
    const exit = await process_.waitForExit(25_000);
    if (exit.timedOut) {
      await process_.forceKill();
      throw new Error(
        `process did not exit within 25s (refusal expected)\n${tail(process_.output(), 12)}`,
      );
    }
    if (process_.hasEvent('server.listening')) {
      throw new Error('a refused process logged server.listening');
    }
    if (exit.code !== 1) {
      throw new Error(
        `expected exit code 1, got code=${exit.code} signal=${exit.signal}\n${tail(
          process_.output(),
          12,
        )}`,
      );
    }
    const marker = `refusing to start: ${code}`;
    if (!process_.output().includes(marker)) {
      throw new Error(
        `stable code ${marker} not found in the process output\n${tail(process_.output(), 12)}`,
      );
    }
    const markerLine =
      process_.lines.find((line) => line.line.includes(marker))?.line ?? '(marker line missing)';
    const closed = await waitForPortClosed(port);
    if (!closed) throw new Error(`port ${port} still accepts connections after the refusal`);
    return {
      detail: `exit 1, stable code ${code}, no listener on ${port}`,
      evidence: [
        `refusal: ${snippet(markerLine, 320)}`,
        `events: ${process_.lines
          .flatMap((line) => (line.json?.event ? [line.json.event] : []))
          .join(', ')}`,
        `process.exit=${JSON.stringify({ code: exit.code, signal: exit.signal })}`,
      ],
    };
  });
}

async function runProductionRefusals() {
  console.log('── production startup refusals ─────────────────────────────');
  const basePort = async () => rememberPort(await freePort());

  // 1. demo auth in production. Everything else is valid, so the first refusal must be the
  //    demo contradiction rather than an unrelated setting.
  await expectStartupRefusal({
    id: 'prod/refuse-demo-auth',
    title: 'NODE_ENV=production + AUTH_MODE=demo refuses with DEMO_AUTH_IN_PRODUCTION',
    env: productionEnvironment({ AUTH_MODE: 'demo', PORT: await basePort() }),
    code: 'DEMO_AUTH_IN_PRODUCTION',
  });

  // 2. clerk mode with no server-only secret. The key is deleted, not blanked, so the process
  //    cannot inherit a real one from the shell.
  await expectStartupRefusal({
    id: 'prod/refuse-clerk-secret',
    title: 'AUTH_MODE=clerk without CLERK_SECRET_KEY refuses with CLERK_SECRET_KEY_MISSING',
    env: productionEnvironment({
      CLERK_SECRET_KEY: undefined,
      PORT: await basePort(),
      INSIGHTHUB_DATA_PATH: state.dirs.prodA,
    }),
    code: 'CLERK_SECRET_KEY_MISSING',
  });

  // 3. the development CORS origin.
  await expectStartupRefusal({
    id: 'prod/refuse-cors-origin',
    title: 'CORS_ORIGIN=http://localhost:5173 refuses with CORS_ORIGIN_INVALID',
    env: productionEnvironment({
      CORS_ORIGIN: DEVELOPMENT_ORIGIN,
      PORT: await basePort(),
      INSIGHTHUB_DATA_PATH: state.dirs.prodB,
    }),
    code: 'CORS_ORIGIN_INVALID',
  });

  // 4. a relative data path (the ephemeral-filesystem mistake D-082 D2 forbids).
  await expectStartupRefusal({
    id: 'prod/refuse-relative-data',
    title: 'a relative INSIGHTHUB_DATA_PATH refuses with DATA_PATH_INVALID',
    env: productionEnvironment({
      INSIGHTHUB_DATA_PATH: 'a6-b10-relative-data',
      PORT: await basePort(),
    }),
    code: 'DATA_PATH_INVALID',
  });

  // 5. the deterministic AI stub.
  await expectStartupRefusal({
    id: 'prod/refuse-ai-stub',
    title: 'AI_PROVIDER=stub refuses with AI_PROVIDER_STUB_FORBIDDEN',
    env: productionEnvironment({
      AI_PROVIDER: 'stub',
      PORT: await basePort(),
      INSIGHTHUB_DATA_PATH: state.dirs.prodC,
    }),
    code: 'AI_PROVIDER_STUB_FORBIDDEN',
  });

  // 6. STATIC_DIR does not exist at all.
  await expectStartupRefusal({
    id: 'prod/refuse-static-missing',
    title: 'a missing STATIC_DIR refuses with STATIC_DIR_MISSING',
    env: productionEnvironment({
      STATIC_DIR: state.dirs.missingStatic,
      PORT: await basePort(),
      INSIGHTHUB_DATA_PATH: state.dirs.prodD,
    }),
    code: 'STATIC_DIR_MISSING',
  });

  // 7. STATIC_DIR exists but has no index.html.
  await expectStartupRefusal({
    id: 'prod/refuse-static-no-index',
    title: 'a STATIC_DIR without index.html refuses with STATIC_DIR_MISSING',
    env: productionEnvironment({
      STATIC_DIR: state.dirs.emptyStatic,
      PORT: await basePort(),
      INSIGHTHUB_DATA_PATH: state.dirs.prodE,
    }),
    code: 'STATIC_DIR_MISSING',
  });
}

/* ------------------------------------------------------------------ *
 * Group 2 — the production-mode real server
 * ------------------------------------------------------------------ */

async function runProductionServer() {
  console.log('\n── production mode (real compiled process + real build) ────');
  const port = state.ports.prod;
  const env = productionEnvironment({
    PORT: port,
    INSIGHTHUB_DATA_PATH: state.dirs.prodF,
  });

  let started = null;
  try {
    started = await startCompiledServer('production', env);
    remember(started.server);
  } catch (error) {
    recordFail(
      'prod/startup',
      'the production process starts with clerk mode, an absolute data path and the real build',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const { server, baseUrl } = started;
  const indexHtml = readFileSync(WEB_INDEX, 'utf8');
  const assets = readdirSync(WEB_ASSETS);
  const indexScriptMatch = /<script[^>]+src="(\/assets\/[^"]+\.js)"/i.exec(indexHtml);
  const entryScript = indexScriptMatch?.[1] ?? null;
  const mapAsset = assets.find((name) => name.endsWith('.js.map'));

  await check(
    'prod/startup-config',
    'the production process reports production/clerk/absolute data/static build, and never logs the fake secret',
    async () => {
      const config = server.event('server.config');
      ensure(config !== null, 'server.config event is missing');
      ensureEqual(config.nodeEnv, 'production', 'server.config.nodeEnv');
      ensureEqual(config.authMode, 'clerk', 'server.config.authMode');
      ensureEqual(config.aiProvider, 'disabled', 'server.config.aiProvider');
      ensure(
        typeof config.dataPath === 'string' && /^[A-Za-z]:\\|^\//.test(config.dataPath),
        `server.config.dataPath must be absolute, got ${JSON.stringify(config.dataPath)}`,
      );
      ensureEqual(config.staticDir, WEB_DIST, 'server.config.staticDir');
      const staticReady = server.event('server.static_ready');
      ensure(staticReady?.directory === WEB_DIST, 'the default STATIC_DIR must resolve to apps/web/dist');
      const secretEvent = server.lines
        .filter((line) => line.json?.event === 'server.secret')
        .map((line) => line.json);
      const clerk = secretEvent.find((event) => event.name === 'CLERK_SECRET_KEY');
      ensure(clerk?.present === true, 'server.secret must report CLERK_SECRET_KEY present=true');
      const openai = secretEvent.find((event) => event.name === 'OPENAI_API_KEY');
      ensure(openai?.present === false, 'server.secret must report OPENAI_API_KEY present=false');
      return {
        detail: `listening on ${baseUrl}; STATIC_DIR unset -> default ${staticReady.directory}`,
        evidence: [
          `server.config: ${snippet(JSON.stringify(config), 300)}`,
          `server.static_ready: ${snippet(JSON.stringify(staticReady), 220)}`,
          `server.secret: ${snippet(JSON.stringify(secretEvent), 220)}`,
        ],
      };
    },
  );

  await check('prod/health', 'GET /health is 200 {"status":"ok"}', async () => {
    const response = await httpRequest(`${baseUrl}/health`);
    ensureEqual(response.status, 200, 'status');
    ensureEqual(response.json?.status, 'ok', 'body.status');
    ensure(contentType(response.headers).includes('application/json'), 'content-type must be JSON');
    return {
      detail: `GET /health -> 200 ${response.text}`,
      evidence: [`content-type: ${header(response.headers, 'content-type')}`],
    };
  });

  await check('prod/ready', 'GET /ready is 200 {"status":"ready"}', async () => {
    const response = await httpRequest(`${baseUrl}/ready`);
    ensureEqual(response.status, 200, 'status');
    ensureEqual(response.json?.status, 'ready', 'body.status');
    return { detail: `GET /ready -> 200 ${response.text}` };
  });

  await check('prod/static-shell', 'GET / returns the exact built index.html with <div id="root">', async () => {
    const response = await httpRequest(`${baseUrl}/`, { headers: { accept: 'text/html' } });
    ensureEqual(response.status, 200, 'status');
    ensure(contentType(response.headers).includes('text/html'), 'content-type must be HTML');
    ensureEqual(response.text, indexHtml, 'body must be byte-identical to apps/web/dist/index.html');
    ensure(response.text.includes('<div id="root"></div>'), 'the shell must contain <div id="root"></div>');
    return {
      detail: `GET / -> 200, ${response.text.length} bytes, identical to the build`,
      evidence: [`content-type: ${header(response.headers, 'content-type')}`],
    };
  });

  await check('prod/static-asset', 'the built entry JavaScript is served with a JavaScript content type', async () => {
    ensure(entryScript !== null, 'could not find the entry <script src="/assets/*.js"> in index.html');
    const response = await httpRequest(`${baseUrl}${entryScript}`);
    ensureEqual(response.status, 200, 'status');
    ensure(
      contentType(response.headers).includes('javascript'),
      `content-type must be JavaScript, got ${header(response.headers, 'content-type')}`,
    );
    ensure(response.text.length > 1_000, `asset body looks empty (${response.text.length} bytes)`);
    ensure(!response.text.trimStart().toLowerCase().startsWith('<!doctype'), 'asset must not be HTML');
    for (const [name, value] of Object.entries(response.headers)) {
      ensure(
        !name.toLowerCase().includes('sourcemap') && !String(value).toLowerCase().includes('sourcemap'),
        `unexpected source-map header: ${name}: ${value}`,
      );
    }
    return {
      detail: `GET ${entryScript} -> 200, ${response.text.length} bytes`,
      evidence: [`content-type: ${header(response.headers, 'content-type')}`],
    };
  });

  await check('prod/spa-client-route', 'GET /documents/abc with Accept: text/html returns the same SPA shell', async () => {
    const response = await httpRequest(`${baseUrl}/documents/abc`, {
      headers: { accept: 'text/html' },
    });
    ensureEqual(response.status, 200, 'status');
    ensureEqual(response.text, indexHtml, 'client route body must be the built index.html');
    return { detail: 'GET /documents/abc -> 200, same shell bytes' };
  });

  await check('prod/spa-prefix-boundary', 'GET /apiary stays a client route instead of being shadowed by /api', async () => {
    const response = await httpRequest(`${baseUrl}/apiary`, { headers: { accept: 'text/html' } });
    ensureEqual(response.status, 200, 'status');
    ensureEqual(response.text, indexHtml, '/apiary must receive the SPA shell');
    return { detail: 'GET /apiary -> 200, SPA shell (segment boundary honoured)' };
  });

  await check('prod/api-unknown-json', 'GET /api/unknown is a JSON 404, not the shell', async () => {
    const response = await httpRequest(`${baseUrl}/api/unknown`, {
      headers: { accept: 'text/html' },
    });
    ensureEqual(response.status, 404, 'status');
    ensure(contentType(response.headers).includes('application/json'), 'content-type must be JSON');
    ensureEqual(response.text, '{"error":"not_found"}', 'body');
    ensure(response.text !== indexHtml, 'an API miss must not return the shell');
    return { detail: `GET /api/unknown -> 404 ${response.text} (not the shell)` };
  });

  await check('prod/bootstrap-disabled', 'POST /api/session/bootstrap is absent in production (404 JSON, no cookie)', async () => {
    const response = await httpRequest(`${baseUrl}/api/session/bootstrap`, {
      method: 'POST',
      headers: { origin: PRODUCTION_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ demoUserId: 'demo-ada' }),
    });
    ensureEqual(response.status, 404, 'status');
    ensureEqual(response.text, '{"error":"not_found"}', 'body');
    ensure(header(response.headers, 'set-cookie') === undefined, 'the bootstrap route must not set a cookie');
    return { detail: `POST /api/session/bootstrap -> 404 ${response.text}; set-cookie absent` };
  });

  await check('prod/bootstrap-bad-origin', 'a foreign Origin on POST /api/session/bootstrap is 403 origin_not_allowed', async () => {
    const response = await httpRequest(`${baseUrl}/api/session/bootstrap`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ demoUserId: 'demo-ada' }),
    });
    ensureEqual(response.status, 403, 'status');
    ensureEqual(response.text, '{"error":"origin_not_allowed"}', 'body');
    ensure(header(response.headers, 'set-cookie') === undefined, 'a refused request must not set a cookie');
    ensure(
      header(response.headers, 'access-control-allow-origin') === undefined,
      'a refused origin must not receive CORS headers',
    );
    return { detail: `POST /api/session/bootstrap (origin: https://evil.example) -> 403 ${response.text}` };
  });

  await check('prod/sourcemap-not-served', 'a real .js.map is not served; the miss is a source-free JSON 404', async () => {
    ensure(mapAsset !== undefined, 'no .js.map was produced by the web build');
    const response = await httpRequest(`${baseUrl}/assets/${mapAsset}`, {
      headers: { accept: '*/*' },
    });
    ensureEqual(response.status, 404, 'status');
    ensure(!response.text.includes('sourcesContent'), 'the response body must not contain sourcesContent');
    ensure(
      !response.text.includes('"sources"') && !response.text.includes('"mappings"'),
      'the response body must not contain source-map fields',
    );
    return {
      detail: `GET /assets/${mapAsset} -> 404 ${response.text}`,
      evidence: [`body bytes=${response.text.length}; sourcesContent present: false`],
    };
  });

  await check('prod/sourcemap-html-no-leak', 'a navigation request for a .js.map gets the shell, never the map bytes', async () => {
    ensure(mapAsset !== undefined, 'no .js.map was produced by the web build');
    const response = await httpRequest(`${baseUrl}/assets/${mapAsset}`, {
      headers: { accept: 'text/html' },
    });
    ensureEqual(response.status, 200, 'status');
    ensureEqual(response.text, indexHtml, 'the fallback must serve the known shell, not the map');
    ensure(!response.text.includes('sourcesContent'), 'the shell must not contain sourcesContent');
    return { detail: `GET /assets/${mapAsset} (Accept: text/html) -> 200, shell bytes` };
  });

  await check('prod/ws-bad-origin', 'a WebSocket upgrade from a foreign Origin is 403 and opens no socket', async () => {
    const outcome = await tryWebSocketUpgrade(port, 'https://evil.example');
    ensureEqual(outcome.kind, 'response', 'upgrade outcome');
    ensureEqual(outcome.status, 403, 'status');
    ensureEqual(outcome.body, '{"error":"origin_not_allowed"}', 'body');
    return {
      detail: `GET /ws (Origin: https://evil.example) -> 403 ${outcome.body}; no socket established`,
    };
  });

  await check('prod/ws-no-session', 'a WebSocket upgrade with no Clerk session is 401 and opens no socket', async () => {
    const outcome = await tryWebSocketUpgrade(port, PRODUCTION_ORIGIN);
    ensureEqual(outcome.kind, 'response', 'upgrade outcome');
    ensureEqual(outcome.status, 401, 'status');
    ensureEqual(outcome.body, '{"error":"session_required"}', 'body');
    return {
      detail: `GET /ws (allowed Origin, no cookie) -> 401 ${outcome.body}; no socket established`,
    };
  });

  await check('prod/api-session-no-cookie', 'GET /api/session in clerk mode is 401 session_required', async () => {
    const response = await httpRequest(`${baseUrl}/api/session`);
    ensureEqual(response.status, 401, 'status');
    ensureEqual(response.text, '{"error":"session_required"}', 'body');
    return { detail: `GET /api/session -> 401 ${response.text}` };
  });

  await check('prod/log-no-secret', 'the structured log never contains the fake Clerk secret', async () => {
    const output = server.output();
    ensure(!output.includes(FAKE_CLERK_SECRET), 'the fake CLERK_SECRET_KEY appeared in the process log');
    ensure(!output.includes('CLERK_SECRET_KEY='), 'the log contains a CLERK_SECRET_KEY= assignment');
    return {
      detail: 'the whole stdout/stderr of the production process was scanned; secret absent',
      evidence: [`log lines captured: ${server.lines.length}`],
    };
  });

  const stop = await server.stop('SIGTERM');
  if (!stop.timedOut) {
    await waitForPortClosed(port);
  }
  if (stop.timedOut) {
    recordFail('prod/shutdown', 'the production process terminates on SIGTERM', 'did not exit within 8s');
  } else {
    // Not an acceptance criterion on Windows (hard TerminateProcess); recorded as evidence that
    // the production process can be stopped and its port released.
    console.log(
      `        (prod shutdown evidence: code=${stop.code} signal=${stop.signal}; port ${port} closed)`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Group 3 — development-mode real process: persistence, backup, restore
 * ------------------------------------------------------------------ */

const DEMO_DOCUMENT_ID = 'demo-document';

async function readDocumentFromStore(dataPath, documentId) {
  const opened = await openDocumentStore(dataPath);
  try {
    const stored = await opened.store.load(documentId);
    ensure(stored !== null, `document ${documentId} is absent from the store at ${dataPath}`);
    const document = new Y.Doc();
    if (stored.snapshot.byteLength > 0) Y.applyUpdate(document, stored.snapshot);
    for (const row of stored.updates) Y.applyUpdate(document, row.update);
    return {
      text: document.getText('content').toString(),
      snapshotBytes: stored.snapshot.byteLength,
      updates: stored.updates.length,
    };
  } finally {
    await opened.store.close();
  }
}

async function seedDocument(dataPath, documentId, text) {
  const opened = await openDocumentStore(dataPath);
  try {
    const document = new Y.Doc();
    document.getText('content').insert(0, text);
    const update = Y.encodeStateAsUpdate(document);
    const sequence = await opened.store.append(documentId, update);
    ensure(
      typeof opened.store.ensureDocumentMeta === 'function',
      'the compiled store does not expose ensureDocumentMeta',
    );
    await opened.store.ensureDocumentMeta(documentId, 'demo-ada');
    return { sequence, updateBytes: update.byteLength };
  } finally {
    await opened.store.close();
  }
}

async function bootstrapDemoCookie(baseUrl) {
  const response = await httpRequest(`${baseUrl}/api/session/bootstrap`, {
    method: 'POST',
    headers: { origin: DEVELOPMENT_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ demoUserId: 'demo-ada' }),
  });
  ensureEqual(response.status, 200, 'bootstrap status');
  ensureEqual(response.json?.userId, 'demo-ada', 'bootstrap userId');
  const setCookie = header(response.headers, 'set-cookie');
  ensure(typeof setCookie === 'string' && setCookie.length > 0, 'bootstrap did not set a cookie');
  const match = /(insighthub_session=[^;,\s]+)/.exec(setCookie);
  ensure(match !== null, `could not parse the session cookie from: ${snippet(setCookie)}`);
  ensure(/httponly/i.test(setCookie), 'the session cookie must be HttpOnly');
  ensure(/samesite=lax/i.test(setCookie), 'the session cookie must be SameSite=Lax');
  return { cookie: match[1], setCookie, response };
}

async function readDocuments(baseUrl, cookie) {
  const response = await httpRequest(`${baseUrl}/api/documents`, { headers: { cookie } });
  ensureEqual(response.status, 200, 'documents status');
  const documents = response.json?.documents;
  ensure(Array.isArray(documents), 'GET /api/documents must return a documents array');
  return { response, documents };
}

async function runDevelopmentDurability() {
  console.log('\n── development mode: persistence, backup, restore ─────────');
  const marker = `A6-B10-DURABLE-${Date.now().toString(36)}`;
  const content = `# M4 B10 durable document\n\n${marker}\n`;

  const seedResult = await check(
    'dev/seed-store',
    'seed demo-document through the compiled openDocumentStore',
    async () => {
      const seeded = await seedDocument(state.dirs.dev, DEMO_DOCUMENT_ID, content);
      const readBack = await readDocumentFromStore(state.dirs.dev, DEMO_DOCUMENT_ID);
      ensureEqual(readBack.text, content, 'seed read-back');
      return {
        detail: `append seq=${seeded.sequence}, ${seeded.updateBytes} bytes; read back ${readBack.updates} update(s)`,
        evidence: [`content marker: ${marker}`],
      };
    },
  );

  const devPort = state.ports.dev1;
  const devEnvironment = developmentEnvironment(devPort, { backup: true });

  let first = null;
  try {
    first = await startCompiledServer('dev-first', devEnvironment);
    remember(first.server);
  } catch (error) {
    recordFail(
      'dev/startup',
      'the development-mode process starts with BACKUP_ENABLED=true',
      error instanceof Error ? error.message : String(error),
    );
  }

  let cookie = null;
  let firstRevision = null;
  let firstHydration = null;

  if (first !== null) {
    const boot = await check('dev/bootstrap-demo', 'demo bootstrap is 200 and sets an HttpOnly/Lax cookie', async () => {
      const result = await bootstrapDemoCookie(first.baseUrl);
      cookie = result.cookie;
      ensure(/max-age=43200/i.test(result.setCookie) || /expires=/i.test(result.setCookie), 'cookie must carry a 12h lifetime');
      return {
        detail: `POST /api/session/bootstrap -> 200 ${snippet(JSON.stringify(result.response.json))}`,
        evidence: [`set-cookie: ${snippet(result.setCookie.replace(/insighthub_session=[^;]+/, 'insighthub_session=<redacted>'), 220)}`],
      };
    });

    if (boot.status !== 'PASS' || cookie === null) {
      recordFail('dev/http-document-list', 'GET /api/documents lists the seeded document', 'bootstrap failed');
      recordFail('dev/http-document-get', 'GET /api/documents/demo-document returns metadata', 'bootstrap failed');
      recordFail('dev/ws-hydration', 'WS join + hydration returns the seeded text', 'bootstrap failed');
    } else {
      const listed = await check(
        'dev/http-document-list',
        'GET /api/documents lists the seeded demo-document with owner demo-ada',
        async () => {
          const { response, documents } = await readDocuments(first.baseUrl, cookie);
          const document = documents.find((candidate) => candidate.id === DEMO_DOCUMENT_ID);
          ensure(document !== undefined, `demo-document absent from ${JSON.stringify(documents)}`);
          ensureEqual(document.title, DEMO_DOCUMENT_ID, 'title');
          ensureEqual(document.ownerId, 'demo-ada', 'ownerId');
          ensure(document.revision >= 1, `revision must be at least 1, got ${document.revision}`);
          firstRevision = document.revision;
          return {
            detail: `GET /api/documents -> 200 ${snippet(JSON.stringify(document))}`,
            evidence: [`content-type: ${header(response.headers, 'content-type')}`],
          };
        },
      );

      await check(
        'dev/http-document-get',
        'GET /api/documents/demo-document returns the same document through the capability gate',
        async () => {
          const response = await httpRequest(`${first.baseUrl}/api/documents/${DEMO_DOCUMENT_ID}`, {
            headers: { cookie },
          });
          ensureEqual(response.status, 200, 'status');
          ensureEqual(response.json?.id, DEMO_DOCUMENT_ID, 'id');
          ensure(Array.isArray(response.json?.id) === false, 'id sanity');
          return { detail: `GET /api/documents/demo-document -> 200 ${snippet(response.text)}` };
        },
      );

      firstHydration = await check(
        'dev/ws-hydration',
        'a real WS join + SyncStep1 handshake hydrates the exact seeded text',
        async () => {
          const hydrated = await hydrateOverWebSocket({
            port: devPort,
            cookie,
            origin: DEVELOPMENT_ORIGIN,
            documentId: DEMO_DOCUMENT_ID,
            expectedText: content,
          });
          return {
            detail: `room-joined role=${hydrated.joined?.role}; ${hydrated.binaryFrames} binary frame(s), ${hydrated.applied} applied`,
            evidence: [`hydrated text: ${snippet(JSON.stringify(hydrated.text), 180)}`],
          };
        },
      );
    }

    const backup = await check(
      'dev/backup-completed',
      'BACKUP_ENABLED=true produces backup.completed and a non-empty file within 30s',
      async () => {
        const completedPromise = first.server.waitForEvent('backup.completed', 30_000);
        const failedPromise = first.server.waitForEvent('backup.failed', 30_000);
        const outcome = await Promise.race([
          completedPromise.then((event) => (event === null ? null : { kind: 'completed', event })),
          failedPromise.then((event) => (event === null ? null : { kind: 'failed', event })),
        ]);
        ensure(outcome !== null, 'no backup.completed/backup.failed event within 30s');
        if (outcome.kind === 'failed') {
          throw new Error(`backup.failed: ${snippet(JSON.stringify(outcome.event))}`);
        }
        const event = outcome.event;
        ensure(typeof event.file === 'string' && event.file.length > 0, 'backup event has no file');
        const path = join(state.dirs.backups, event.file);
        ensure(existsSync(path), `backup file does not exist: ${path}`);
        const size = statSync(path).size;
        ensure(size > 0, `backup file is empty: ${path}`);
        ensureEqual(size, event.bytes, 'backup event bytes vs file size');
        return {
          detail: `backup.completed ${event.file} bytes=${event.bytes}`,
          evidence: [`file exists and is non-empty (${size} bytes)`],
        };
      },
    );

    if (firstHydration?.status === 'PASS') {
      // Persistence proof #1 is the content above; now kill the process and reopen the same data
      // directory with a second real process.
      const stop = await first.server.stop('SIGTERM');
      if (stop.timedOut) {
        recordFail('dev/sigterm-exit0', 'SIGTERM stops the dev process with exit 0', 'process did not exit within 8s');
      } else if (process.platform === 'win32') {
        skip(
          'dev/sigterm-exit0',
          'SIGTERM stops the dev process with exit 0',
          `Windows cannot deliver POSIX signals: the child was terminated by TerminateProcess (code=${stop.code}, signal=${stop.signal}); the handler path is covered by dev/graceful-handler-exit0`,
          [
            'platform=win32; child.kill("SIGTERM") => signal SIGTERM, code null',
            'on POSIX this check asserts exit 0',
          ],
        );
      } else {
        await check('dev/sigterm-exit0', 'SIGTERM stops the dev process with exit 0', async () => {
          ensureEqual(stop.code, 0, 'exit code');
          ensure(stop.signal === null, 'the process must exit normally, not by signal');
          return { detail: 'exit code 0 after SIGTERM' };
        });
      }

      await check('dev/port-closed', 'the stopped dev process releases its port', async () => {
        ensure(await waitForPortClosed(devPort), `port ${devPort} still accepts connections`);
        return { detail: `port ${devPort} closed after process exit` };
      });

      const secondPort = state.ports.dev2;
      let second = null;
      try {
        second = await startCompiledServer(
          'dev-second',
          developmentEnvironment(secondPort),
        );
        remember(second.server);
      } catch (error) {
        recordFail(
          'dev/restart-http',
          'a second process on the same data directory still lists the document',
          error instanceof Error ? error.message : String(error),
        );
        recordFail(
          'dev/restart-hydration',
          'the restarted process hydrates the same text over a real WS',
          'restart failed',
        );
      }

      if (second !== null) {
        const restartBoot = await check(
          'dev/restart-http',
          'a second process on the same data directory lists the document with the same revision',
          async () => {
            const boot = await bootstrapDemoCookie(second.baseUrl);
            cookie = boot.cookie;
            const { documents } = await readDocuments(second.baseUrl, cookie);
            const document = documents.find((candidate) => candidate.id === DEMO_DOCUMENT_ID);
            ensure(document !== undefined, 'demo-document absent after restart');
            ensureEqual(document.revision, firstRevision, 'revision after restart');
            return {
              detail: `GET /api/documents after restart -> 200 ${snippet(JSON.stringify(document))}`,
              evidence: [`revision before/after: ${firstRevision}/${document.revision}`],
            };
          },
        );

        if (restartBoot.status === 'PASS' && cookie !== null) {
          await check(
            'dev/restart-hydration',
            'the restarted process hydrates the same text over a real WS',
            async () => {
              const hydrated = await hydrateOverWebSocket({
                port: secondPort,
                cookie,
                origin: DEVELOPMENT_ORIGIN,
                documentId: DEMO_DOCUMENT_ID,
                expectedText: content,
              });
              return {
                detail: `room-joined role=${hydrated.joined?.role}; hydrated ${hydrated.applied} update(s) after restart`,
                evidence: [`text: ${snippet(JSON.stringify(hydrated.text), 180)}`],
              };
            },
          );
        } else {
          recordFail('dev/restart-hydration', 'the restarted process hydrates the same text', 'restart bootstrap failed');
        }

        await second.server.stop('SIGTERM');
        await waitForPortClosed(secondPort);
      }
    } else {
      recordFail('dev/sigterm-exit0', 'SIGTERM stops the dev process with exit 0', 'hydration prerequisite failed');
      recordFail('dev/port-closed', 'the stopped dev process releases its port', 'hydration prerequisite failed');
      recordFail('dev/restart-http', 'a second process reads the same document', 'hydration prerequisite failed');
      recordFail('dev/restart-hydration', 'the restarted process hydrates the same text', 'hydration prerequisite failed');
    }

    // The backup and restore checks below do not need the first process. Stop it on every path
    // (including a hydration failure) so no listener survives into the restore drill.
    if (first.server.exit === null) {
      await first.server.stop('SIGTERM');
      await waitForPortClosed(devPort);
    }

    if (backup.status !== 'PASS') {
      recordFail('dev/restore-cli', 'backup-cli.ts restore installs the snapshot into a new directory', 'backup prerequisite failed');
      recordFail('dev/restore-store-read', 'openDocumentStore reads the same text from the restored database', 'backup prerequisite failed');
      recordFail('dev/restore-server-http', 'a real process serves the restored database', 'backup prerequisite failed');
      recordFail('dev/restore-server-hydration', 'the restored database hydrates the same text over WS', 'backup prerequisite failed');
      return;
    }

    const backupFile = join(
      state.dirs.backups,
      first.server.event('backup.completed').file,
    );

    const restore = await check(
      'dev/restore-cli',
      'backup-cli.ts restore installs the snapshot into a new data directory',
      async () => {
        const env = cleanEnvironment({
          NODE_ENV: 'test',
          AUTH_MODE: 'demo',
          INSIGHTHUB_DATA_PATH: state.dirs.restored,
          BACKUP_DIR: state.dirs.backups,
          AI_PROVIDER: 'disabled',
          HOST: '127.0.0.1',
          LOG_LEVEL: 'info',
        });
        const child = ServerProcess.spawnRequest('restore-cli', {
          args: ['--import', 'tsx', BACKUP_CLI, 'restore', backupFile],
          env,
          cwd: SERVER_SOURCE_ROOT,
        });
        const exit = await child.waitForExit(30_000);
        if (exit.timedOut) {
          await child.forceKill();
          throw new Error(`restore CLI did not exit within 30s\n${tail(child.output())}`);
        }
        ensureEqual(exit.code, 0, `restore CLI exit code (stdout=${snippet(child.stdout)} stderr=${snippet(child.stderr)})`);
        const line = child.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('restored='));
        ensure(line !== undefined, `restore CLI printed no restored= line\n${tail(child.output())}`);
        return {
          detail: `backup-cli.ts restore -> exit 0: ${snippet(line, 220)}`,
          evidence: [`backup source: ${backupFile}`],
        };
      },
    );

    if (restore.status !== 'PASS') {
      recordFail('dev/restore-store-read', 'openDocumentStore reads the same text from the restored database', 'restore CLI failed');
      recordFail('dev/restore-server-http', 'a real process serves the restored database', 'restore CLI failed');
      recordFail('dev/restore-server-hydration', 'the restored database hydrates the same text over WS', 'restore CLI failed');
      return;
    }

    await check(
      'dev/restore-store-read',
      'openDocumentStore reads the exact same text from the restored database',
      async () => {
        const readBack = await readDocumentFromStore(state.dirs.restored, DEMO_DOCUMENT_ID);
        ensureEqual(readBack.text, content, 'restored store text');
        return {
          detail: `restored store: snapshot=${readBack.snapshotBytes} bytes, updates=${readBack.updates}, text matches`,
        };
      },
    );

    let restored = null;
    try {
      restored = await startCompiledServer(
        'restored',
        developmentEnvironment(state.ports.restored, { dataPath: state.dirs.restored }),
      );
      remember(restored.server);
    } catch (error) {
      recordFail(
        'dev/restore-server-http',
        'a real process serves the restored database',
        error instanceof Error ? error.message : String(error),
      );
      recordFail(
        'dev/restore-server-hydration',
        'the restored database hydrates the same text over WS',
        'restored server failed to start',
      );
    }

    if (restored !== null) {
      let restoredCookie = null;
      const restoredBoot = await check(
        'dev/restore-server-http',
        'a real process serves the restored database (bootstrap + document list)',
        async () => {
          const boot = await bootstrapDemoCookie(restored.baseUrl);
          restoredCookie = boot.cookie;
          const { documents } = await readDocuments(restored.baseUrl, boot.cookie);
          const document = documents.find((candidate) => candidate.id === DEMO_DOCUMENT_ID);
          ensure(document !== undefined, 'demo-document absent from the restored database');
          ensureEqual(document.ownerId, 'demo-ada', 'restored ownerId');
          return {
            detail: `restored process GET /api/documents -> 200 ${snippet(JSON.stringify(document))}`,
          };
        },
      );

      if (restoredBoot.status === 'PASS' && restoredCookie !== null) {
        await check(
          'dev/restore-server-hydration',
          'the restored database hydrates the same text over a real WS',
          async () => {
            const hydrated = await hydrateOverWebSocket({
              port: state.ports.restored,
              cookie: restoredCookie,
              origin: DEVELOPMENT_ORIGIN,
              documentId: DEMO_DOCUMENT_ID,
              expectedText: content,
            });
            return {
              detail: `restored room-joined role=${hydrated.joined?.role}; ${hydrated.applied} update(s) applied`,
              evidence: [`text: ${snippet(JSON.stringify(hydrated.text), 180)}`],
            };
          },
        );
      } else {
        recordFail('dev/restore-server-hydration', 'the restored database hydrates the same text over WS', 'restored bootstrap failed');
      }

      await restored.server.stop('SIGTERM');
      await waitForPortClosed(state.ports.restored);
    }
  } else {
    for (const id of [
      'dev/bootstrap-demo',
      'dev/http-document-list',
      'dev/http-document-get',
      'dev/ws-hydration',
      'dev/backup-completed',
      'dev/sigterm-exit0',
      'dev/port-closed',
      'dev/restart-http',
      'dev/restart-hydration',
      'dev/restore-cli',
      'dev/restore-store-read',
      'dev/restore-server-http',
      'dev/restore-server-hydration',
    ]) {
      recordFail(id, '(development durability)', 'the dev server did not start');
    }
  }

  // Ensure nothing survives an early failure path before the next group.
  if (first !== null && first.server.exit === null) {
    await first.server.stop('SIGTERM');
    await waitForPortClosed(devPort);
  }
}

/* ------------------------------------------------------------------ *
 * Group 4 — corrupt database refusal (real process)
 * ------------------------------------------------------------------ */

async function runCorruptionRefusal() {
  console.log('\n── corrupt database: real process refusal ───────────────────');
  const corruptPort = state.ports.corrupt;

  const prepared = await check(
    'dev/corrupt-fixture',
    'build a valid store and overwrite insighthub.db with garbage',
    async () => {
      await seedDocument(state.dirs.corrupt, 'corrupt-document', 'this row must not survive');
      const file = join(state.dirs.corrupt, 'insighthub.db');
      const garbage = Buffer.from('A6-B10: this sentence is definitely not a SQLite database');
      writeFileSync(file, garbage);
      const before = readFileSync(file);
      ensure(before.equals(garbage), 'the corrupt bytes were not written');
      return {
        detail: `wrote ${garbage.byteLength} garbage bytes over insighthub.db`,
        evidence: [`file: ${file}`],
      };
    },
  );

  if (prepared.status !== 'PASS') {
    recordFail('dev/corrupt-db-refused', 'a corrupt database refuses startup with DATA_INTEGRITY_FAILED', 'fixture failed');
    return;
  }

  const corruptFile = join(state.dirs.corrupt, 'insighthub.db');
  const bytesBefore = readFileSync(corruptFile);

  await check(
    'dev/corrupt-db-refused',
    'a corrupt database refuses startup with exit 1 and DATA_INTEGRITY_FAILED, without listening',
    async () => {
      const env = developmentEnvironment(corruptPort, { dataPath: state.dirs.corrupt });
      const process_ = remember(ServerProcess.spawnRequest('corrupt', { env }));
      const exit = await process_.waitForExit(25_000);
      if (exit.timedOut) {
        await process_.forceKill();
        throw new Error(`corrupt-store process did not exit within 25s\n${tail(process_.output(), 12)}`);
      }
      if (process_.hasEvent('server.listening')) {
        throw new Error('a process with a corrupt database logged server.listening');
      }
      ensureEqual(exit.code, 1, `exit code (code=${exit.code} signal=${exit.signal})`);
      const marker = 'refusing to start: DATA_INTEGRITY_FAILED';
      ensure(process_.output().includes(marker), `missing ${marker}\n${tail(process_.output(), 12)}`);
      const markerLine = process_.lines.find((line) => line.line.includes(marker))?.line ?? '';
      ensure(await waitForPortClosed(corruptPort), `port ${corruptPort} still accepts connections`);
      const bytesAfter = readFileSync(corruptFile);
      ensure(bytesAfter.equals(bytesBefore), 'the refused startup modified the corrupt database');
      return {
        detail: 'exit 1, DATA_INTEGRITY_FAILED, no listener, file unchanged',
        evidence: [`refusal: ${snippet(markerLine, 320)}`],
      };
    },
  );
}

/* ------------------------------------------------------------------ *
 * Group 5 — graceful shutdown handler (real process, test-only preload)
 * ------------------------------------------------------------------ */

async function runGracefulShutdownProbe() {
  console.log('\n── graceful shutdown handler (real process) ────────────────');
  const port = state.ports.graceful;
  await check(
    'dev/graceful-handler-exit0',
    'the real compiled process exits 0 through its own SIGTERM handler (process.emit probe, not an OS signal)',
    async () => {
      const env = developmentEnvironment(port, { dataPath: state.dirs.graceful });
      const process_ = remember(
        ServerProcess.spawnRequest('graceful', {
          // `--import` needs a URL, not a Windows drive path: an absolute path is parsed as the
          // `d:` URL scheme and rejected before the preload can run.
          args: ['--import', pathToFileURL(GRACEFUL_PRELOAD).href, SERVER_ENTRY],
          env,
        }),
      );
      const exit = await process_.waitForExit(30_000);
      if (exit.timedOut) {
        await process_.forceKill();
        throw new Error(`graceful probe did not exit within 30s\n${tail(process_.output(), 12)}`);
      }
      ensureEqual(exit.code, 0, `exit code (code=${exit.code} signal=${exit.signal})`);
      ensure(exit.signal === null, `expected a normal exit, got signal ${exit.signal}`);
      const shutdown = process_.event('server.shutdown');
      ensure(shutdown !== null, 'the process did not log server.shutdown');
      ensureEqual(shutdown.signal, 'SIGTERM', 'server.shutdown.signal');
      ensure(process_.hasEvent('server.listening'), 'the probe never reached server.listening');
      ensure(await waitForPortClosed(port), `port ${port} still accepts connections`);
      return {
        detail: 'exit 0 after process.emit("SIGTERM"); server.shutdown signal=SIGTERM; port closed',
        evidence: [
          'this is handler-path evidence; on win32 no POSIX signal can be delivered',
          `stdout events: ${process_.lines
            .flatMap((line) => (line.json?.event ? [line.json.event] : []))
            .filter((event) => event.startsWith('server.'))
            .join(', ')}`,
        ],
      };
    },
  );
}

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */

async function assertNoLeaks() {
  await check('cleanup/no-leaked-process', 'no child process survives the gate and every used port is closed', async () => {
    // Deliberately does NOT force-kill: cleanup() in `finally` does that. This check reports
    // whether the gate itself left anything behind, so a stopped-everywhere run is the only pass.
    const alive = state.servers.filter((server) => server.exit === null);
    ensure(alive.length === 0, `${alive.length} child process(es) still running: ${alive.map((server) => server.label).join(', ')}`);
    const openPorts = [];
    for (const port of state.usedPorts) {
      if (!(await isPortClosed(port))) openPorts.push(port);
    }
    ensure(openPorts.length === 0, `ports still open: ${openPorts.join(', ')}`);
    return {
      detail: `${state.servers.length} child process(es) tracked; all exited; ${state.usedPorts.size} port(s) closed`,
    };
  });
}

/**
 * Force-clean anything left alive, then remove the temporary root.
 *
 * Cleanup is part of the gate: a failing check must not leave a listening server or an orphan
 * database behind. Windows may hold a handle for a moment after a forced exit, so removal is
 * retried; a failure is printed but does not mask the check results.
 */
async function cleanup() {
  for (const server of state.servers) {
    if (server.exit === null) {
      await server.forceKill();
      await server.waitForExit(5_000);
    }
  }
  if (state.tempRoot === null) return;
  if (KEEP_TEMP) {
    console.log(`\n--keep-temp: preserved ${state.tempRoot}`);
    return;
  }
  try {
    rmSync(state.tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (existsSync(state.tempRoot)) {
      console.warn(`warning: temporary directory still exists: ${state.tempRoot}`);
    } else {
      console.log(`\ntemp cleaned: ${state.tempRoot}`);
    }
  } catch (error) {
    console.warn(
      `warning: could not remove ${state.tempRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* ================================================================== *
 * Entry point
 * ================================================================== */

async function main() {
  await preflight();
  const openStoreModule = await import(
    pathToFileURL(join(repoRoot, 'apps', 'server', 'dist', 'persistence', 'open-store.js')).href
  );
  openDocumentStore = openStoreModule.openDocumentStore;
  createDirs();
  console.log(`  temp:      ${state.tempRoot}\n`);

  await runProductionRefusals();
  await runProductionServer();
  await runDevelopmentDurability();
  await runCorruptionRefusal();
  await runGracefulShutdownProbe();
  await assertNoLeaks();
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
  recordFail('gate/fatal', 'the gate completed without an unhandled error', error instanceof Error ? error.message : String(error));
} finally {
  await cleanup();
}

const passed = results.filter((result) => result.status === 'PASS').length;
const failed = results.filter((result) => result.status === 'FAIL').length;
const skipped = results.filter((result) => result.status === 'SKIP').length;

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`SUMMARY checks=${results.length} pass=${passed} fail=${failed} skip=${skipped}`);
for (const result of results.filter((candidate) => candidate.status !== 'PASS')) {
  console.log(`  ${result.status} ${result.id}: ${result.detail}`);
}
if (failed > 0 || fatal !== null) {
  console.log('RESULT: FAIL');
  process.exitCode = 1;
} else if (skipped > 0) {
  console.log('RESULT: PASS (with platform-limited skips — see above)');
  process.exitCode = 0;
} else {
  console.log('RESULT: PASS');
  process.exitCode = 0;
}
