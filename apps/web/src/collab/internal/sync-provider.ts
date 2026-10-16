import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { readSyncMessage } from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  PROTOCOL_VERSION,
  WS_MESSAGE_TYPES,
  createEnvelope,
  decodeBinaryFrame,
  encodeAwarenessFrame,
  encodeSyncFrame,
  encodeSyncStep1,
  encodeSyncUpdate,
  isFatalErrorCode,
  parseServerMessage,
  type ConnectionStatus,
  type TransactionOrigin,
} from '@insighthub/shared';

/**
 * The network path — Path 2 of the two independent paths out of `Y.Doc`
 * (`docs/ARCHITECTURE.md` §2).
 *
 * ## Frozen wire behaviour this module implements
 *
 * - **Two planes, one socket.** TEXT frames carry the JSON control envelope;
 *   BINARY frames carry Yjs sync + awareness. Every frame on both planes is
 *   produced and validated by the shared codec and the shared parsers — this module
 *   never parses a frame by hand and never invents a frame type (`AGENTS.md` R12).
 * - **One socket, one room** (§5.4, R15). This provider is bound to exactly one
 *   `documentId` for its whole lifetime; it has no API that could route a frame to
 *   a second room.
 * - **Client-initiated sync** (§10.2). After `room-joined` the client sends
 *   `SyncStep1` with its own state vector; the server replies `SyncStep2 + SyncStep1`
 *   and the client answers with `SyncStep2`. Sync is therefore delta-based: a
 *   reconnect transfers what is missing, not the document.
 * - **No data-plane frame before `room-joined`** (§4). Anything that would be sent
 *   earlier is dropped and counted, because a conforming server answers
 *   `ROOM_NOT_JOINED` and that is a protocol error, not a normal state.
 * - **Reconnect never rebuilds the document.** The `Y.Doc` and the IndexedDB
 *   replica outlive every socket. A reconnect re-runs only the network half of the
 *   open sequence, so offline edits are still in the document and are captured by
 *   the new `SyncStep1` (§10.3).
 *
 * ## Non-goals (frozen)
 *
 * No sequence numbers, no OT, no per-update acknowledgement, no business-layer
 * de-duplication. Yjs updates are idempotent and order-independent, so duplicates
 * and out-of-order delivery are handled by the CRDT (§10.3).
 */

/** Reconnect backoff. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 10_000;

/** How many times a non-fatal join rejection is retried before giving up quietly. */
const MAX_JOIN_RETRIES = 3;
const JOIN_RETRY_DELAY_MS = 500;

/**
 * Structural WebSocket surface the provider uses.
 *
 * Deliberately minimal: it is satisfied by the browser `WebSocket` and by an
 * in-process Node transport, so the collab layer needs no `lib.dom` types and the
 * tests need no DOM implementation.
 *
 * Handler attachment goes through `setOn*`. The browser adapter below queues
 * anything it receives before a handler exists and replays it on `setOnOpen`, so the
 * server's greeting cannot be lost to a task-ordering race on a fast connection.
 */
export interface SyncSocket {
  binaryType: string;
  readyState: number;
  setOnOpen(handler: () => void): void;
  setOnMessage(handler: (event: { data: unknown }) => void): void;
  setOnError(handler: () => void): void;
  setOnClose(handler: () => void): void;
  /** Clear every handler. Called during teardown. */
  detachHandlers(): void;
  send(data: Uint8Array | string): void;
  close(): void;
}

/** The browser WebSocket constants, without depending on `lib.dom` at runtime. */
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export interface SyncSocketFactory {
  new (url: string): SyncSocket;
}

export interface SyncProviderCallbacks {
  /** Network path state — informational for the UI, never a gate on editing. */
  onStatusChange(status: ConnectionStatus): void;
  /** `room-joined` accepted: the room is now this socket's only room. */
  onRoomJoined(documentId: string): void;
  /** The room was left (explicit disconnect or socket close). */
  onRoomLeft(): void;
  /** Typed server error from the frozen vocabulary. */
  onServerError(code: string, message: string, fatal: boolean): void;
}

/** Counters for observability and tests. They are not protocol state. */
export interface SyncProviderStats {
  syncFramesOut: number;
  syncFramesIn: number;
  awarenessFramesOut: number;
  awarenessFramesIn: number;
  /** Binary frames the shared codec rejected. A server-side fault. */
  invalidFrames: number;
  /** Data-plane frames that were refused because no room was joined yet. */
  framesBeforeJoin: number;
}

export interface SyncProviderOptions {
  documentId: string;
  doc: Y.Doc;
  url: string;
  socketFactory: SyncSocketFactory;
  remoteOrigin: TransactionOrigin;
  callbacks: SyncProviderCallbacks;
  /** Publishes the local awareness entry, including the required clock bump. */
  announceLocalAwareness: () => void;
  /** Handles an inbound AWARENESS payload. */
  applyAwareness: (bytes: Uint8Array) => void;
  /** Drops every remote awareness entry (socket close / disconnect). */
  resetAwareness: () => void;
  /** Backoff pacing (tests shrink it). */
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  joinRetryDelayMs?: number;
}

export class SyncProvider {
  private readonly options: SyncProviderOptions;

  private socket: SyncSocket | undefined;

  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private joinRetryTimer: ReturnType<typeof setTimeout> | undefined;

  private attempt = 0;

  private joinAttempts = 0;

  /** True between `connect()` and `disconnect()`/`destroy()`. */
  private active = false;

  private connecting = false;

  private joined = false;

  private readonly stats: SyncProviderStats = {
    syncFramesOut: 0,
    syncFramesIn: 0,
    awarenessFramesOut: 0,
    awarenessFramesIn: 0,
    invalidFrames: 0,
    framesBeforeJoin: 0,
  };

  constructor(options: SyncProviderOptions) {
    this.options = options;
    this.options.doc.on('update', this.handleDocumentUpdate);
  }

  /** True once the server acknowledged `join-room` on the current socket. */
  get isJoined(): boolean {
    return this.joined;
  }

  get statistics(): Readonly<SyncProviderStats> {
    return this.stats;
  }

  /** Open the network path. Safe to call when already connected. */
  connect(): void {
    if (this.active) return;
    this.active = true;
    this.attempt = 0;
    this.open();
  }

  /**
   * Close the network path.
   *
   * The `Y.Doc`, the IndexedDB replica and the undo history all stay alive; only
   * the socket and its timers go away. This is a deliberate offline state, not an
   * error path, so no reconnect is scheduled.
   */
  disconnect(): void {
    this.active = false;
    this.clearTimer();
    this.clearJoinTimer();
    this.closeSocket();
    this.leaveRoom();
    this.options.callbacks.onStatusChange('offline');
  }

  /** Full teardown: timers, listeners and socket. Idempotent. */
  destroy(): void {
    this.active = false;
    this.clearTimer();
    this.clearJoinTimer();
    this.closeSocket();
    this.joined = false;
    this.options.doc.off('update', this.handleDocumentUpdate);
  }

  /* ---------------------------------------------------------------- *
   * Outbound
   * ---------------------------------------------------------------- */

  /** `SyncStep1`: advertise this client's state vector and ask for the delta. */
  sendSyncStep1(): void {
    this.sendSyncFrame(encodeSyncStep1(this.options.doc));
  }

  /**
   * Publish the local awareness entry (used right after joining a room).
   *
   * The frame is produced by the awareness manager, not here: re-announcing presence
   * requires a **clock bump**, or a room that had already dropped this client (its
   * previous socket closed) discards the announcement as older than the removal it
   * recorded, and the client stays invisible to its peers. The manager owns the
   * awareness clock; this method only decides *when*.
   */
  sendLocalAwareness(): void {
    if (!this.socketIsOpen()) return;
    if (!this.joined) {
      this.stats.framesBeforeJoin += 1;
      return;
    }
    this.options.announceLocalAwareness();
  }

  /* ---------------------------------------------------------------- *
   * Socket lifecycle
   * ---------------------------------------------------------------- */

  private open(): void {
    if (!this.active || this.connecting) return;
    this.connecting = true;
    this.joined = false;
    this.options.callbacks.onStatusChange(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let raw: unknown;
    try {
      raw = new this.options.socketFactory(this.options.url);
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }

    const socket = toSyncSocket(raw);
    this.socket = socket;
    // ArrayBuffer keeps the hot path free of Blob copies.
    socket.binaryType = 'arraybuffer';
    // Only the open handler is attached here; it flushes anything the transport
    // received before this point (see `toSyncSocket`).
    socket.setOnOpen(this.handleOpen);
    socket.setOnMessage(this.handleMessage);
    socket.setOnError(this.handleSocketError);
    socket.setOnClose(this.handleClose);
  }

  private readonly handleOpen = (): void => {
    this.connecting = false;
    // `connected` is the server's own hello; `join-room` follows it.
    this.sendControl(
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, {
        documentId: this.options.documentId,
        protocolVersion: PROTOCOL_VERSION,
        mode: 'readwrite' as const,
      }),
    );
  };

  private readonly handleMessage = (event: { data: unknown }): void => {
    const data = event.data;
    if (typeof data === 'string') {
      this.handleControlMessage(data);
      return;
    }
    this.handleBinaryMessage(data);
  };

  private readonly handleSocketError = (): void => {
    // `close` always follows an error, so recovery is handled there exactly once.
  };

  private readonly handleClose = (): void => {
    this.connecting = false;
    this.socket = undefined;
    if (this.joined) this.leaveRoom();
    if (!this.active) return;
    this.options.callbacks.onStatusChange('reconnecting');
    this.scheduleReconnect();
  };

  /* ---------------------------------------------------------------- *
   * Inbound: control plane (TEXT)
   * ---------------------------------------------------------------- */

  private handleControlMessage(raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.invalidControlMessage('server sent a text frame that is not JSON');
      return;
    }

    const parsed = parseServerMessage(decoded);
    if (!parsed.success || parsed.data === undefined) {
      this.invalidControlMessage(parsed.error ?? 'server message failed validation');
      return;
    }

    const message = parsed.data;
    if (message.type === WS_MESSAGE_TYPES.connected) {
      this.attempt = 0;
      return;
    }

    if (message.type === WS_MESSAGE_TYPES.roomJoined) {
      if (message.payload.documentId !== this.options.documentId) {
        // A room this provider never asked for is a protocol fault on one socket =
        // one room. Dropping it is the only safe reaction (R15).
        this.invalidControlMessage('room-joined for a document this session did not join');
        return;
      }
      this.joined = true;
      this.joinAttempts = 0;
      this.clearJoinTimer();
      this.options.callbacks.onStatusChange('connected');
      this.options.callbacks.onRoomJoined(message.payload.documentId);
      // Client-initiated handshake (§10.2) and presence announcement. Both are
      // sent only now, because no data-plane frame may precede `room-joined`.
      this.sendSyncStep1();
      this.sendLocalAwareness();
      return;
    }

    if (message.type === WS_MESSAGE_TYPES.error) {
      const { code, message: text } = message.payload;
      const fatal = isFatalErrorCode(code);
      this.options.callbacks.onServerError(code, text, fatal);
      if (fatal) {
        // The peer cannot continue on this connection, so retrying would only
        // repeat the same rejection: stop the reconnect loop and surface it.
        this.active = false;
        this.options.callbacks.onStatusChange('error');
        this.closeSocket();
        return;
      }
      // A non-fatal rejection (most likely `ROOM_NOT_JOINED`) is retried a bounded
      // number of times: the socket stays open and the server never asked us to
      // leave, so the room is simply not established yet.
      this.scheduleJoinRetry();
    }
  }

  private invalidControlMessage(detail: string): void {
    this.stats.invalidFrames += 1;
    this.options.callbacks.onServerError('INVALID_MESSAGE', detail, false);
  }

  /* ---------------------------------------------------------------- *
   * Inbound: data plane (BINARY)
   * ---------------------------------------------------------------- */

  private handleBinaryMessage(data: unknown): void {
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
      this.stats.invalidFrames += 1;
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    const decoded = decodeBinaryFrame(bytes);
    if (!decoded.success || decoded.frame === undefined) {
      // The server chose to send something the frozen codec rejects. Reporting it
      // is enough here: a conforming server would have closed the socket itself.
      this.stats.invalidFrames += 1;
      this.options.callbacks.onServerError(
        decoded.error ?? 'INVALID_BINARY_FRAME',
        decoded.detail ?? 'undecodable binary frame',
        false,
      );
      return;
    }

    if (decoded.frame.kind === 'awareness') {
      this.stats.awarenessFramesIn += 1;
      this.options.applyAwareness(decoded.frame.bytes);
      return;
    }

    this.stats.syncFramesIn += 1;
    this.readSyncPayload(decoded.frame.bytes);
  }

  /**
   * Feed a SYNC payload to `y-protocols`.
   *
   * `readSyncMessage` writes its answer into the same encoder: a `SyncStep1` from
   * the server becomes our `SyncStep2`, while a `SyncStep2`/`Update` produces no
   * reply. This is the frozen client half of the handshake, unchanged from the
   * official protocol — the shared codec only strips the frame-type header.
   *
   * What it writes is the SYNC **payload** (`messageType` + length-prefixed body),
   * i.e. exactly what `decodeBinaryFrame` hands back out. It is NOT a whole frame, so
   * the frame-type header must be added with `encodeSyncFrame` before it goes on the
   * wire. Sending the raw payload would prepend the payload's own first byte as the
   * frame type — a `1` reads as AWARENESS, and the peer correctly rejects the result.
   */
  private readSyncPayload(payload: Uint8Array): void {
    const decoder = decoding.createDecoder(payload);
    const encoder = encoding.createEncoder();
    try {
      readSyncMessage(decoder, encoder, this.options.doc, this.options.remoteOrigin);
    } catch {
      this.stats.invalidFrames += 1;
      return;
    }
    if (encoding.length(encoder) === 0) return;
    const reply = encoding.toUint8Array(encoder);
    this.sendSyncFrame(
      encodeSyncFrame((target) => {
        encoding.writeUint8Array(target, reply);
      }),
    );
  }

  private readonly handleDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (!this.joined) return;
    // Skip the replay performed by the local persistence provider: those structs
    // are already known to the server or will be covered by the next `SyncStep1`,
    // and re-sending them would be pure noise on the wire.
    if (origin === this.options.remoteOrigin) return;
    this.sendSyncFrame(encodeSyncUpdate(update));
  };

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  private canSend(): boolean {
    return this.joined && this.socketIsOpen();
  }

  private socketIsOpen(): boolean {
    return this.socket !== undefined && this.socket.readyState === SOCKET_OPEN;
  }

  private sendBinary(frame: Uint8Array): boolean {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  private sendControl(message: { type: string; payload: unknown; ts: string }): boolean {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== SOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private sendSyncFrame(frame: Uint8Array): void {
    if (!this.socketIsOpen()) return;
    // `join-room` is a prerequisite of every data-plane frame (§4), so anything
    // produced before the acknowledgement is intentionally dropped and counted: a
    // conforming server answers `ROOM_NOT_JOINED` for it.
    if (!this.joined) {
      this.stats.framesBeforeJoin += 1;
      return;
    }
    if (this.sendBinary(frame)) this.stats.syncFramesOut += 1;
  }

  /* ---------------------------------------------------------------- *
   * Reconnect
   * ---------------------------------------------------------------- */

  private scheduleReconnect(): void {
    if (!this.active || this.retryTimer !== undefined) return;
    const base = this.options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    const max = this.options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(base * 2 ** this.attempt, max);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.open();
    }, delay);
    unrefTimer(this.retryTimer);
  }

  private scheduleJoinRetry(): void {
    if (!this.active || this.joined || this.joinRetryTimer !== undefined) return;
    if (this.joinAttempts >= MAX_JOIN_RETRIES) return;
    this.joinAttempts += 1;
    this.options.callbacks.onStatusChange('reconnecting');
    this.joinRetryTimer = setTimeout(() => {
      this.joinRetryTimer = undefined;
      if (!this.active || this.joined) return;
      this.sendControl(
        createEnvelope(WS_MESSAGE_TYPES.joinRoom, {
          documentId: this.options.documentId,
          protocolVersion: PROTOCOL_VERSION,
          mode: 'readwrite' as const,
        }),
      );
    }, this.options.joinRetryDelayMs ?? JOIN_RETRY_DELAY_MS);
    unrefTimer(this.joinRetryTimer);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = false;
    if (socket === undefined) return;
    socket.detachHandlers();
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  private clearTimer(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearJoinTimer(): void {
    if (this.joinRetryTimer === undefined) return;
    clearTimeout(this.joinRetryTimer);
    this.joinRetryTimer = undefined;
  }

  /**
   * Mark the room as left and forget peer presence.
   *
   * Awareness is scoped to a room, so entries learned from it must not survive the
   * room: the table in `docs/CONTRACTS.md` §10.3 requires the awareness entry to be
   * removed when a room ends, and a stale cursor would otherwise be rendered for a
   * peer that is no longer in the document.
   */
  private leaveRoom(): void {
    const wasJoined = this.joined;
    this.joined = false;
    this.options.resetAwareness();
    if (wasJoined) this.options.callbacks.onRoomLeft();
  }

  /** Send an awareness frame produced by the awareness manager. */
  sendAwarenessFrame(bytes: Uint8Array): boolean {
    if (!this.canSend() || bytes.byteLength === 0) return false;
    if (!this.sendBinary(encodeAwarenessFrame(bytes))) return false;
    this.stats.awarenessFramesOut += 1;
    return true;
  }
}

/** Node timers keep the process alive; presence and retry timers must not. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== 'object' || timer === null) return;
  const handle = timer as { unref?: () => void };
  handle.unref?.();
}

/** The browser `WebSocket` members the adapter touches. */
interface RawWebSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: Uint8Array | string): void;
  close(): void;
}

/**
 * Adapt a `WebSocket`-shaped object (browser `WebSocket`, Node 22 `WebSocket`, or an
 * injected test transport) to `SyncSocket`.
 *
 * The adapter exists for one reason beyond naming: **it queues**. The provider
 * constructs the socket and attaches its handlers on the next statements, and a
 * server is free to send its greeting in the same tick the connection opens. A
 * browser honours that by queueing messages until `onmessage` is assigned; this
 * adapter makes the same guarantee explicit for any transport, so a fast server
 * cannot make the client miss `connected`.
 */
export function toSyncSocket(raw: unknown): SyncSocket {
  if (isSyncSocket(raw)) return raw;
  const socket = raw as RawWebSocket;
  const pending: Array<{ data: unknown }> = [];
  let openHandler: (() => void) | null = null;
  let messageHandler: ((event: { data: unknown }) => void) | null = null;
  let errorHandler: (() => void) | null = null;
  let closeHandler: (() => void) | null = null;

  const flush = (): void => {
    if (messageHandler === null) return;
    for (const event of pending.splice(0, pending.length)) {
      messageHandler(event);
    }
  };

  socket.onopen = () => {
    openHandler?.();
  };
  socket.onmessage = (event) => {
    if (messageHandler === null) {
      pending.push({ data: event.data });
      return;
    }
    messageHandler({ data: event.data });
  };
  socket.onerror = () => {
    errorHandler?.();
  };
  socket.onclose = () => {
    closeHandler?.();
  };

  return {
    get binaryType(): string {
      return socket.binaryType;
    },
    set binaryType(value: string) {
      socket.binaryType = value;
    },
    get readyState(): number {
      return socket.readyState;
    },
    setOnOpen(handler: () => void): void {
      openHandler = handler;
      if (socket.readyState > SOCKET_CONNECTING) handler();
    },
    setOnMessage(handler: (event: { data: unknown }) => void): void {
      messageHandler = handler;
      flush();
    },
    setOnError(handler: () => void): void {
      errorHandler = handler;
    },
    setOnClose(handler: () => void): void {
      closeHandler = handler;
    },
    detachHandlers(): void {
      openHandler = null;
      messageHandler = null;
      errorHandler = null;
      closeHandler = null;
      pending.length = 0;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    },
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
}

/** True when the value already implements the provider's socket surface. */
function isSyncSocket(value: unknown): value is SyncSocket {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SyncSocket>;
  return (
    typeof candidate.setOnOpen === 'function' &&
    typeof candidate.setOnMessage === 'function' &&
    typeof candidate.detachHandlers === 'function'
  );
}
