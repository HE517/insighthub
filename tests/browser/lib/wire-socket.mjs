/**
 * A browser-shaped WebSocket facade over the workspace's own `ws` client.
 *
 * ## Why this exists at all
 *
 * Node 22's global `WebSocket` cannot send a request header, and since M2 Phase 2 the
 * collaboration upgrade is authenticated: it must carry `Cookie: insighthub_session=…`
 * (`docs/CONTRACTS.md` §17.5). The suite therefore needs a client that can set that header,
 * and it must be able to observe the **refusal** of an upgrade (HTTP `401`) rather than only
 * "the socket failed".
 *
 * The alternative — copying a token into a query string or a custom header the server might
 * read — would be a different mechanism than the one the product uses, so the test would stop
 * proving the real path. This adapter keeps the tested path identical (a cookie on the
 * handshake) and adds one observable the browser won't give a page: the status code of a
 * refused upgrade.
 *
 * `ws` is already a dependency of `apps/server` (`apps/server/package.json`); nothing is added.
 * It is resolved through `deps.mjs` from the workspace anchors, like `yjs` and `y-protocols`.
 *
 * ## Surface
 *
 * Deliberately the small browser subset the suite uses (`addEventListener`, `send`, `close`,
 * `readyState`, `binaryType`) so a raw-socket scenario reads the same as before, plus:
 *
 * | Member | Purpose |
 * | --- | --- |
 * | `settled()` | resolves once with `{ kind: 'open' \| 'refused' \| 'error' \| 'closed', … }` |
 * | `upgrade` | `{ status, headers, body }` of a refused upgrade (`401` is observable) |
 */
import { importDependency } from './deps.mjs';

let wsImplementationPromise;

async function loadWebSocketImplementation() {
  wsImplementationPromise ??= importDependency('ws').then((module) => {
    const implementation = module.WebSocket ?? module.default;
    if (typeof implementation !== 'function') {
      throw new Error('the resolved `ws` module exposed no WebSocket constructor');
    }
    return implementation;
  });
  return await wsImplementationPromise;
}

/** One socket plus its upgrade outcome. */
export class WireSocket {
  #socket;
  #listeners = new Map();
  #settle;
  #settledPromise;
  #upgrade = { status: null, headers: null, body: null };

  constructor(socket, { url, cookie }) {
    this.#socket = socket;
    this.url = url;
    this.carriedCookie = cookie !== undefined;
    this.#settledPromise = new Promise((resolve) => {
      this.#settle = resolve;
    });

    socket.on('open', () => {
      this.#settle({ kind: 'open' });
      this.#emit('open', { type: 'open' });
    });

    socket.on('message', (data, isBinary) => {
      const payload = isBinary
        ? data instanceof ArrayBuffer
          ? data
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : String(data);
      this.#emit('message', { data: payload, isBinary });
    });

    socket.on('close', (code, reason) => {
      this.#settle({ kind: 'closed', code, reason: String(reason ?? '') });
      this.#emit('close', { type: 'close', code, reason: String(reason ?? '') });
    });

    socket.on('error', (error) => {
      this.#settle({ kind: 'error', message: String(error?.message ?? error) });
      this.#emit('error', { type: 'error', message: String(error?.message ?? error) });
    });

    socket.on('unexpected-response', (request, response) => {
      // The status is known synchronously and is the answer the scenario asserts, so it settles
      // immediately: reading the body is asynchronous, and `ws` may emit `error` as soon as the
      // handshake socket is torn down. Letting that race decide the outcome reported "socket
      // closed before the connection was established" instead of the real 401.
      this.#upgrade = {
        status: response.statusCode ?? null,
        headers: { ...response.headers },
        body: null,
      };
      this.#settle({ kind: 'refused', status: this.#upgrade.status });
      this.#emit('refused', { type: 'refused', status: this.#upgrade.status });

      const chunks = [];
      const finish = () => {
        this.#upgrade.body = Buffer.concat(chunks).toString('utf8');
        this.#emit('close', { type: 'close', code: 1006, reason: 'upgrade refused' });
        try {
          socket.terminate();
        } catch {
          /* already gone */
        }
      };
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', finish);
      response.on('error', finish);
      // A proxy may hold the refusal open; the status is already known, so nothing is lost by
      // ending the inspection after a bounded wait.
      const safety = setTimeout(() => {
        try {
          request.destroy();
        } catch {
          /* already gone */
        }
        finish();
      }, 2_000);
      safety.unref?.();
    });
  }

  /** `{ status, headers, body }` of a refused upgrade; `status` stays `null` when it opened. */
  get upgrade() {
    return { ...this.#upgrade };
  }

  /**
   * The refusal body, once it has been read.
   *
   * Separate from `upgrade` because the status settles synchronously while the body arrives a
   * moment later; a scenario that wants to compare refusal bodies awaits this.
   */
  async refusalBody({ timeoutMs = 5_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.#upgrade.body === null) {
      if (Date.now() >= deadline) return '';
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.#upgrade.body;
  }

  get readyState() {
    return this.#socket.readyState;
  }

  /** `true` while the connection is open (browser constant `1`). */
  get open() {
    return this.#socket.readyState === 1;
  }

  /** Resolves once with the outcome of the handshake. */
  settled() {
    return this.#settledPromise;
  }

  /** Browser-style listener registration. Returns an unsubscribe function. */
  addEventListener(type, handler, { once = false } = {}) {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    const entry = { handler, once };
    set.add(entry);
    return () => set.delete(entry);
  }

  send(data) {
    this.#socket.send(data);
  }

  close(code, reason) {
    try {
      this.#socket.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  /** Hard close: no closing handshake, so it can never keep the event loop alive. */
  terminate() {
    try {
      this.#socket.terminate();
    } catch {
      /* already gone */
    }
  }

  #emit(type, event) {
    const set = this.#listeners.get(type);
    if (set === undefined) return;
    for (const entry of [...set]) {
      if (entry.once) set.delete(entry);
      try {
        entry.handler(event);
      } catch {
        /* a broken listener must not break the transport */
      }
    }
  }
}

/**
 * Open one socket.
 *
 * `cookie` is written into the `Cookie` request header **explicitly** — the suite never relies
 * on an implicit jar, so "which session did this upgrade carry?" is always answerable.
 */
export async function openWireSocket(url, { cookie, headers = {}, handshakeTimeoutMs = 20_000 } = {}) {
  const WebSocketImplementation = await loadWebSocketImplementation();
  const requestHeaders = { ...headers };
  if (cookie !== undefined) requestHeaders.cookie = cookie;
  const socket = new WebSocketImplementation(url, {
    headers: requestHeaders,
    handshakeTimeout: handshakeTimeoutMs,
    perMessageDeflate: false,
  });
  // Binaries arrive as ArrayBuffer, exactly like the browser client's own setting.
  socket.binaryType = 'arraybuffer';
  return new WireSocket(socket, { url, cookie });
}

/** Wait for a socket to open, or throw with the refusal the server actually returned. */
export async function waitForOpen(socket, { timeoutMs = 20_000, label = 'the socket' } = {}) {
  const outcome = await Promise.race([
    socket.settled(),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)),
  ]);
  if (outcome.kind === 'open') return socket;
  if (outcome.kind === 'refused') {
    throw new Error(
      `${label} was refused during the upgrade: HTTP ${outcome.status} ` +
        `(${outcome.body || 'no body'})`,
    );
  }
  if (outcome.kind === 'timeout') {
    throw new Error(`${label} did not open within ${timeoutMs}ms`);
  }
  throw new Error(
    `${label} failed to connect (${outcome.kind}${outcome.message === undefined ? '' : `: ${outcome.message}`})`,
  );
}
