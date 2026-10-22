/**
 * Shared harness for the A3 integration tests.
 *
 * Every test in this directory exercises **real WebSocket connections against a real
 * server on an ephemeral port**, because the behaviour under test (frame routing,
 * room isolation, heartbeat reaping, backpressure) is exactly the behaviour a mock
 * would hide. `port: 0` plus `server.address().port` keeps parallel runs from
 * colliding on a fixed 3001.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROTOCOL_VERSION,
  WS_MESSAGE_TYPES,
  awarenessStateSchema,
  createEnvelope,
  decodeSyncFrame,
  encodeAwarenessFrame,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  parseServerMessage,
  readSyncMessageType,
  type AwarenessState,
  type JoinRoomPayload,
  type RoomJoinedPayload,
  type WsServerMessage,
} from '@insighthub/shared';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';

import { createApp } from '../app.js';
import {
  createAuthz,
  createIdentityDeps,
  isAppUserStore,
  type AuthzService,
  type SessionVerifier,
} from '../authz/public.js';
import type { AuthMode, ServerConfig } from '../config.js';
import { isDocumentMetaStore, StoreDocumentCatalog } from '../persistence/document-meta.js';
import { openDocumentStore } from '../persistence/open-store.js';
import type { DocumentStore } from '../persistence/types.js';
import { attachWebSocketServer, type WebSocketHandle, type WebSocketServerOptions } from '../ws.js';
import { PermissiveTestAuthz } from './test-authz.js';

/** One recorded inbound frame. Binary frames keep their raw bytes. */
export type ReceivedFrame =
  { kind: 'text'; message: WsServerMessage } | { kind: 'binary'; bytes: Uint8Array };

/**
 * Bootstrap a demo session over HTTP and return the `Cookie` header value for the WS upgrade.
 *
 * The demo bootstrap is the one place a client may name an identity (`docs/CONTRACTS.md` §17.0,
 * §17.3). Everything after it is decided by the session token, which is why the tests do not have
 * — and must not get — a way to pass a `userId` to the socket.
 */
export async function bootstrapSessionCookie(
  httpBaseUrl: string,
  demoUserId: string,
): Promise<string> {
  const response = await fetch(`${httpBaseUrl}/api/session/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // No keep-alive. Node's `fetch` pools sockets process-wide, and a pooled socket is a live
      // handle that keeps the *test process* alive after the last assertion — the gate would then
      // print every result and never exit (TOOLING-P2). One request per connection keeps the
      // handle's lifetime inside the test that made it.
      connection: 'close',
    },
    body: JSON.stringify({ demoUserId }),
    // Bounded: an unbounded `fetch` inherits undici's 300 s timers, so a stuck request would look
    // like a hung gate instead of a failed assertion (TOOLING-P2).
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 200) {
    throw new Error(`session bootstrap failed: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('session bootstrap did not set a cookie');
  // Drain the body so the socket is finished with before we return.
  await response.text();
  const match = /(insighthub_session=[^;,\s]+)/.exec(setCookie);
  if (match === null) throw new Error(`no session cookie in: ${setCookie}`);
  return match[1];
}

export interface TestServer {
  readonly port: number;
  readonly url: string;
  /** Base HTTP URL — for `POST /api/session/bootstrap` and the document API. */
  readonly httpUrl: string;
  readonly handle: WebSocketHandle;
  /** The durable store this server uses. Owned by the harness unless one was injected. */
  readonly store: DocumentStore;
  /** Directory holding the database file (`undefined` when a store was injected). */
  readonly dataPath: string | undefined;
  /**
   * The **real** authorization service this server was built with.
   *
   * Exposed so a test can bootstrap a session and hold the token the HTTP layer would set as a
   * cookie; the socket layer only receives it when `authorization: 'enforced'`.
   */
  readonly authz: AuthzService;
  close(): Promise<void>;
}

/**
 * Options for a test server.
 *
 * `store` and `dataPath` are additive to the transport's own options:
 *
 * - **neither** (the default): a fresh temporary directory and a store inside it, owned and
 *   removed by the harness. This is the isolation `docs/DECISIONS.md` D-041 requires — a
 *   test run can never touch the development database at `./.insighthub-data`;
 * - **`dataPath` only**: open a store in that directory (used to reopen the same durable
 *   state within one process while keeping the cleanup explicit);
 * - **`store` only**: use the caller's store, typically a wrapper that injects failures
 *   (scenarios F and I) or blocks hydration (scenario K). The caller then owns its lifetime.
 */
export interface TestServerOptions extends WebSocketServerOptions {
  /** Directory for a harness-created store. Ignored when `store` is supplied. */
  dataPath?: string;
  /**
   * Which authorization service the **WebSocket** layer receives.
   *
   * - `'permissive'` (default): a double that admits every socket and grants every capability.
   *   The M1/M2-P0 suites join arbitrary document ids that exist in no membership table, so a
   *   real service would deny them all and the suites would stop testing room mechanics
   *   (`test-authz.ts` states the trade-off).
   * - `'enforced'`: the real `AuthzService` (created on this server's data directory). A session
   *   cookie is required at the upgrade and memberships decide document access — this is the
   *   mode every Phase 2 test uses, and the only mode production ever runs.
   *
   * In both modes the HTTP layer always gets the real service, so the API side is never
   * permissive.
   */
  authorization?: 'permissive' | 'enforced';
  /**
   * `AUTH_MODE` for **both** transports. Defaults to `demo`, so every pre-B2 caller keeps the
   * demo-session behaviour it was written against.
   */
  authMode?: AuthMode;
  /**
   * The Clerk verifier for `authMode: 'clerk'` (a fake in tests — no network). Ignored in demo
   * mode, where the existing session lookup is the identity source.
   */
  verifier?: SessionVerifier | null;
}

/**
 * Boot an HTTP + WebSocket server on an ephemeral port, with an isolated durable store.
 *
 * Every test in this directory exercises **real WebSocket connections against a real
 * server on a real SQLite database**, because the behaviour under test (frame routing,
 * room isolation, heartbeat reaping, backpressure, durable ordering) is exactly the
 * behaviour a mock would hide. `port: 0` plus `server.address().port` keeps parallel runs
 * from colliding on a fixed 3001.
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const {
    dataPath: requestedDataPath,
    store: injectedStore,
    authorization = 'permissive',
    authMode = 'demo',
    verifier = null,
    ...transportOptions
  } = options;

  let store: DocumentStore;
  let dataPath: string | undefined;
  let ownsStore = false;

  if (injectedStore !== undefined) {
    store = injectedStore;
  } else {
    const directory = requestedDataPath ?? mkdtempSync(join(tmpdir(), 'insighthub-a3-test-'));
    const opened = await openDocumentStore(directory);
    store = opened.store;
    dataPath = opened.dataPath;
    // `requestedDataPath` belongs to the caller (it is being reopened deliberately); a
    // freshly created temp directory belongs to this server and is removed on close.
    ownsStore = requestedDataPath === undefined;
  }

  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    corsOrigin: 'http://localhost:5173',
    wsPath: '/ws',
    authMode,
    // Present only when the harness opened the store, so `attachWebSocketServer`'s
    // fail-closed check (dataPath without a store) can never fire here.
    ...(dataPath === undefined ? {} : { dataPath }),
  };

  // `createApp` requires an authorization service (A0 integration exception, D-062 §2), and the
  // HTTP surface must always be the real one — a permissive app would make the API tests
  // meaningless. When the store was injected there is no data directory, so the membership
  // table gets a temporary one of its own.
  const authzDirectory = dataPath ?? mkdtempSync(join(tmpdir(), 'insighthub-authz-test-'));
  // The document-metadata source is wired exactly as `index.ts` wires it, so no test can pass on a
  // fixture that production does not use (`persistence/document-meta.ts`).
  const documents = isDocumentMetaStore(store) ? new StoreDocumentCatalog(store) : undefined;
  const authz = await createAuthz({
    dataPath: authzDirectory,
    ...(documents === undefined ? {} : { documents }),
  });
  const ownsAuthz = dataPath === undefined;

  // The socket layer gets the real service only when the test asked for enforcement; see
  // `TestServerOptions.authorization` for why the default is the permissive double.
  const socketAuthz = authorization === 'enforced' ? authz : new PermissiveTestAuthz();

  // Both transports get the same identity seam, exactly as `index.ts` wires it. In demo mode the
  // verifier is unused; in clerk mode the fake stands in for Clerk and the real `app_user`
  // mapping runs against the harness store.
  const identityOptions = { verifier, appUsers: isAppUserStore(store) ? store : null };
  const identity = createIdentityDeps(authMode, socketAuthz, identityOptions);

  // M4 B9: when a test supplies a structured logger, both transports use it — the same wiring
  // `index.ts` has — so an accepted upgrade can be traced back to the HTTP bootstrap request.
  const server: Server = createServer(
    createApp(
      config,
      authz,
      undefined,
      identityOptions,
      undefined,
      options.log === undefined ? {} : { logger: options.log },
    ),
  );
  const handle = attachWebSocketServer(server, config, {
    ...transportOptions,
    store,
    authz: socketAuthz,
    identity,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    port,
    url: `ws://127.0.0.1:${port}${config.wsPath}`,
    httpUrl: `http://127.0.0.1:${port}`,
    handle,
    store,
    dataPath,
    authz,
    close: async () => {
      await handle.close();
      // Close the databases before removing their directories: on Windows an open handle makes
      // the removal fail, and a leaked temp directory per test run is its own bug.
      authz.close();
      await store.close();

      // `server.close()` only calls back once every HTTP connection has drained, and the
      // document-API tests use `fetch`, whose keep-alive pool holds sockets open. Unbounded, that
      // is the same "the gate never returns" failure as TOOLING-P2 — so: release idle sockets
      // immediately, and hard-drop whatever is left if the drain does not finish in time.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 2_000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections?.();
      });

      if (ownsStore && dataPath !== undefined) {
        rmSync(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
      if (ownsAuthz) {
        rmSync(authzDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    },
  };
}

/**
 * A test client: a real `ws` socket with a recorded frame log.
 *
 * Frames are recorded as they arrive so a test can assert both what was received and,
 * more importantly, what was **not** received (room isolation is a negative
 * assertion).
 */
export class TestClient {
  readonly socket: WebSocket;
  readonly frames: ReceivedFrame[] = [];
  /** Resolvers waiting for a frame that has not arrived yet. */
  readonly #waiters = new Set<() => void>();
  #closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.frames.push({ kind: 'binary', bytes: new Uint8Array(raw) });
      } else {
        const parsed = parseServerMessage(JSON.parse(raw.toString()));
        // A frame the shared parser rejects is a bug in the server, not a test
        // detail: surface it here so a malformed reply cannot pass as "no message".
        assert.ok(parsed.success, `server sent a frame the shared parser rejects: ${parsed.error}`);
        if (!parsed.success || parsed.data === undefined) return;
        this.frames.push({ kind: 'text', message: parsed.data });
      }
      for (const waiter of [...this.#waiters]) waiter();
    });

    socket.on('close', () => {
      this.#closed = true;
      for (const waiter of [...this.#waiters]) waiter();
    });
  }

  /** Connect and complete the `connected` handshake. */
  /**
   * Connect and complete the `connected` handshake.
   *
   * `cookie` carries the server-issued session when the transport enforces authentication
   * (`docs/CONTRACTS.md` §17.5). It is the **only** identity carrier the upgrade reads, which is
   * why there is no `userId` option here: a test must not be able to helpfully self-declare one
   * through the harness.
   */
  static async connect(
    url: string,
    options: { cookie?: string; origin?: string } = {},
  ): Promise<TestClient> {
    const headers: Record<string, string> = {};
    if (options.cookie !== undefined) headers['cookie'] = options.cookie;
    // A real browser always sends `Origin` on a WebSocket handshake (M4 B4). Tests that need to
    // behave like one set it here; tests that must behave like a non-browser client omit it.
    if (options.origin !== undefined) headers['origin'] = options.origin;
    const socket = new WebSocket(url, Object.keys(headers).length === 0 ? {} : { headers });

    // The recording listeners must be attached synchronously, before the `open` event
    // can fire: the server writes `connected` as soon as the upgrade completes, so a
    // listener attached after awaiting `open` would miss the handshake entirely.
    const client = new TestClient(socket);
    await client.#waitForOpen();
    // The handshake is always first, so waiting for it here removes an ordering hazard
    // from every test.
    await client.waitForText('connected');
    return client;
  }

  /**
   * Attempt a connection and wait for the upgrade to be **refused**.
   *
   * Used by the negative tests: an unauthenticated upgrade must fail before a socket exists, so
   * the observable outcome is a handshake error carrying the HTTP status — not a socket that
   * opens and is then closed for an unexplained reason.
   */
  static async expectRefused(
    url: string,
    cookie?: string,
    origin?: string,
  ): Promise<number | undefined> {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers['cookie'] = cookie;
    if (origin !== undefined) headers['origin'] = origin;
    const socket = new WebSocket(url, Object.keys(headers).length === 0 ? {} : { headers });
    return await new Promise<number | undefined>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('upgrade was neither refused nor opened')),
        5000,
      );
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        socket.terminate();
        resolve(response.statusCode);
      });
      socket.once('open', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('the upgrade was accepted'));
      });
      socket.once('error', (error: Error & { statusCode?: number }) => {
        clearTimeout(timer);
        resolve(error.statusCode);
      });
    });
  }

  #waitForOpen(timeoutMs = 10_000): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      // Bounded on purpose: if neither `open` nor `error` ever fires, an unbounded wait is a
      // hung gate rather than a failing test (TOOLING-P2).
      const timer = setTimeout(() => {
        reject(new Error(`the socket neither opened nor errored within ${timeoutMs}ms`));
      }, timeoutMs);
      this.socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Text messages received so far, in order. */
  textMessages(): WsServerMessage[] {
    return this.frames.flatMap((frame) => (frame.kind === 'text' ? [frame.message] : []));
  }

  /** Binary frames received so far, in order. */
  binaryFrames(): Uint8Array[] {
    return this.frames.flatMap((frame) => (frame.kind === 'binary' ? [frame.bytes] : []));
  }

  /** Drop everything received so far, so a later wait sees only new frames. */
  clear(): void {
    this.frames.length = 0;
  }

  /**
   * Resolve once `predicate` is satisfied by some recorded frame.
   *
   * Checks existing frames first, so it can never miss a frame that already arrived —
   * the race a naive "wait for the next message" promise would introduce.
   */
  async waitForFrame(
    predicate: (frame: ReceivedFrame) => boolean,
    description: string,
    timeoutMs = 5000,
  ): Promise<ReceivedFrame> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return existing;

    return await new Promise<ReceivedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(
          new Error(
            `timed out waiting for ${description}; received ${this.frames.length} frame(s): ` +
              `${JSON.stringify(this.textMessages().map((message) => message.type))}`,
          ),
        );
      }, timeoutMs);

      const check = (): void => {
        const found = this.frames.find(predicate);
        if (found === undefined) return;
        clearTimeout(timer);
        this.#waiters.delete(check);
        resolve(found);
      };

      this.#waiters.add(check);
      check();
    });
  }

  /** Wait for the next text message of a given type that has not arrived yet. */
  async waitForText<T extends WsServerMessage['type']>(
    type: T,
    timeoutMs = 5000,
  ): Promise<Extract<WsServerMessage, { type: T }>> {
    const frame = await this.waitForFrame(
      (candidate) => candidate.kind === 'text' && candidate.message.type === type,
      `a ${type} message`,
      timeoutMs,
    );
    assert.equal(frame.kind, 'text');
    return frame.message as Extract<WsServerMessage, { type: T }>;
  }

  /** Wait for a text `error` with a specific frozen code. */
  async waitForError(
    code: string,
    timeoutMs = 5000,
  ): Promise<Extract<WsServerMessage, { type: 'error' }>> {
    const frame = await this.waitForFrame(
      (candidate) =>
        candidate.kind === 'text' &&
        candidate.message.type === WS_MESSAGE_TYPES.error &&
        candidate.message.payload.code === code,
      `an error with code ${code}`,
      timeoutMs,
    );
    assert.equal(frame.kind, 'text');
    return frame.message as Extract<WsServerMessage, { type: 'error' }>;
  }

  /** Wait until the socket has closed. */
  async waitForClose(timeoutMs = 5000): Promise<void> {
    if (this.#closed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Give the server a chance to send anything else, then return what it sent. */
  async settle(milliseconds = 120): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  /**
   * Send a `join-room`.
   *
   * `protocolVersion` is typed `unknown` on purpose: the structural/mismatch boundary is
   * part of the contract, so tests must be able to send an older integer, a future integer
   * or a non-integer (string, null) and assert which error code each produces.
   *
   * Only `undefined` means "use the current version". A bare `??` would also substitute for
   * `null`, which silently turned a null-version test case into a valid join — the harness
   * must not have coercion quirks of its own when the point is to probe the server's.
   */
  join(documentId: string, options: { requestId?: string; protocolVersion?: unknown } = {}): void {
    const payload: JoinRoomPayload = {
      documentId,
      protocolVersion:
        options.protocolVersion === undefined
          ? PROTOCOL_VERSION
          : (options.protocolVersion as number),
      mode: 'readwrite',
    };
    this.send(createEnvelope(WS_MESSAGE_TYPES.joinRoom, payload, options));
  }

  /** Join and wait for the acknowledgement, returning its payload. */
  async joinAndWait(
    documentId: string,
    options: { requestId?: string; protocolVersion?: unknown } = {},
  ): Promise<RoomJoinedPayload> {
    this.clear();
    this.join(documentId, options);
    const message = await this.waitForText(WS_MESSAGE_TYPES.roomJoined);
    return message.payload;
  }

  leave(documentId: string): void {
    this.send(createEnvelope(WS_MESSAGE_TYPES.leaveRoom, { documentId }));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Send raw text, for malformed-frame tests. */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes);
  }

  close(code?: number): void {
    this.socket.close(code);
  }

  /** Sever the connection without a close frame, as a crashed client would. */
  destroy(): void {
    this.socket.terminate();
  }
}

/* ------------------------------------------------------------------ *
 * Yjs fixtures
 * ------------------------------------------------------------------ */

/** Fill a document with paragraphs, for a realistic full-sync payload. */
export function fillDocument(doc: Y.Doc, paragraphs: number, wordsPerParagraph = 24): number {
  const text = doc.getText('content');
  doc.transact(() => {
    for (let index = 0; index < paragraphs; index += 1) {
      const words = Array.from(
        { length: wordsPerParagraph },
        (_, word) => `w${index}x${word}`,
      ).join(' ');
      text.insert(text.length, `Paragraph ${index}: ${words}\n`);
    }
  }, 'insighthub:local');
  return text.length;
}

/** A `Y.Doc` with content, plus the encoded full-state update for it. */
export function makePeerDocument(content: string): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, content);
  return { doc, update: Y.encodeStateAsUpdate(doc) };
}

/**
 * Create a client-side `Awareness` that can never keep a test process alive.
 *
 * `y-protocols`' constructor starts a **ref'd** timer (≈3 s) that renews the local clock.
 * Every test that uses one cleans it up with `awareness.destroy()`, but that call sits on the
 * success path: when an assertion fails first, the timer survives. A `node:test` child that
 * has already printed its own results then never exits, the coordinator waits for it forever,
 * and the gate prints every test result without ever printing the aggregate summary — which
 * is also why the red `not ok` stayed hidden (`docs/TASKS.md` TOOLING-P2, `docs/DECISIONS.md`
 * D-070).
 *
 * Unref'ing the handle removes that failure mode without changing awareness behaviour: while
 * a test is running, its server and sockets keep the event loop alive, so renewal still fires
 * on schedule; once the test is over, a missed `destroy()` can waste a little CPU but cannot
 * block process exit.
 *
 * Every client-side `Awareness` in this suite must be created here.
 */
export function createTestAwareness(doc: Y.Doc): awarenessProtocol.Awareness {
  const awareness = new awarenessProtocol.Awareness(doc);
  const timer = (awareness as unknown as { _checkInterval?: { unref?: () => void } | null })
    ._checkInterval;
  timer?.unref?.();
  return awareness;
}

/** Encode a valid awareness state for a client id. */
export function makeAwarenessState(name: string): AwarenessState {
  return awarenessStateSchema.parse({
    user: { id: `user-${name}`, name, color: '#3366ff' },
    cursor: { anchor: 0, head: 0 },
    selection: null,
    updatedAt: Date.now(),
  });
}

/* ------------------------------------------------------------------ *
 * Frame construction / inspection
 * ------------------------------------------------------------------ */

export const FRAME = {
  sync: 0,
  awareness: 1,
} as const;

/** Build a SYNC frame from a document's full state (a `messageYjsUpdate`). */
export function syncUpdateFrame(doc: Y.Doc): Uint8Array {
  return encodeSyncUpdate(Y.encodeStateAsUpdate(doc));
}

/** Build a SYNC Update frame from raw update bytes. */
export function syncUpdateFrameFromBytes(update: Uint8Array): Uint8Array {
  return encodeSyncUpdate(update);
}

/** Build a client SyncStep1 frame. */
export function syncStep1Frame(doc: Y.Doc): Uint8Array {
  return encodeSyncStep1(doc);
}

/** Build a SyncStep2 frame for a document against an optional remote state vector. */
export function syncStep2Frame(doc: Y.Doc, remoteStateVector?: Uint8Array): Uint8Array {
  return encodeSyncStep2(doc, remoteStateVector);
}

/** Build an AWARENESS frame from base64-free raw awareness update bytes. */
export function awarenessFrame(update: Uint8Array): Uint8Array {
  return encodeAwarenessFrame(update);
}

/**
 * Read the `y-protocols` sync message type out of a raw SYNC frame.
 *
 * Delegates to the shared codec so the harness cannot disagree with the server about what
 * a frame says: `decodeSyncFrame` validates the whole frame (including reading the frame
 * type as a varint, which `frame[0]` would get wrong for a multi-byte type) and
 * `readSyncMessageType` returns the sync kind. Returns `-1` for bytes that are not a valid
 * SYNC frame, which is what the previous hand-rolled version expressed as `frame[1] ?? -1`.
 */
export function syncMessageTypeOf(frame: Uint8Array): number {
  const decoded = decodeSyncFrame(frame);
  if (decoded === null) return -1;
  return readSyncMessageType(decoded) ?? -1;
}

/**
 * A minimal `lib0`-shaped decoder.
 *
 * **Why this still exists.** `sync-isolation.test.ts` drives the client half of the
 * handshake with `y-protocols`' own `readSyncMessage(decoder, encoder, doc, origin)`, and
 * that function requires a *decoder instance* with `readVarUint` / `readUint8` /
 * `readVarUint8Array`. `lib0` is a transitive dependency that pnpm does not expose to
 * `apps/server`, so a test cannot import it directly.
 *
 * This is therefore plumbing that satisfies a foreign interface, **not** a second
 * interpretation of the InsightHub wire format: the harness no longer parses frame
 * headers, sync message types or length prefixes by hand — those come from
 * `@insighthub/shared` (`decodeSyncFrame`, `readSyncMessageType`, `readSyncStep1StateVector`,
 * `readSyncUpdatePayload`). The only behaviour implemented here is lib0's decoder contract,
 * so there is nothing for a wire-format change to silently diverge from.
 */
export class TestDecoder {
  readonly arr: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array) {
    this.arr = bytes;
    this.pos = 0;
  }

  readVarUint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.arr[this.pos];
      if (byte === undefined)
        throw new Error('test decoder: expected a varint, found end of buffer');
      this.pos += 1;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return value >>> 0;
  }

  readUint8(): number {
    const byte = this.arr[this.pos];
    if (byte === undefined) throw new Error('test decoder: expected a byte, found end of buffer');
    this.pos += 1;
    return byte;
  }

  readVarUint8Array(): Uint8Array {
    const length = this.readVarUint();
    const end = this.pos + length;
    if (end > this.arr.byteLength) throw new Error('test decoder: truncated byte array');
    const slice = this.arr.subarray(this.pos, end);
    this.pos = end;
    return slice;
  }

  /** A no-op sink, because `readSyncMessage` requires an encoder for its reply. */
  static scratchEncoder(): { writeUint8Array(bytes: Uint8Array): void } {
    return { writeUint8Array: () => undefined };
  }
}

/**
 * A fake `SocketLike` for the peer and heartbeat unit tests.
 *
 * Backpressure cannot be proven reliably against a loopback client — the kernel buffers
 * more than any test wants to write — so the strategy's enforcement point is unit-tested
 * through this double, where `bufferedAmount` is under the test's control. It is also an
 * `EventEmitter` so it can stand in for the heartbeat's socket shape.
 */
export class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly textFrames: string[] = [];
  readonly binaryFrames: Uint8Array[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  terminateCount = 0;
  pingCount = 0;

  send(data: string | ArrayBufferLike | Uint8Array): void {
    if (typeof data === 'string') this.textFrames.push(data);
    else this.binaryFrames.push(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  close(code?: number, reason?: string): void {
    this.closes.push(reason === undefined ? { code } : { code, reason });
    this.readyState = 3;
  }

  terminate(): void {
    this.terminateCount += 1;
    this.readyState = 3;
  }

  ping(): void {
    this.pingCount += 1;
  }
}
