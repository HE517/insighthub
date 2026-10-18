import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';

import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { readSyncMessage } from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

import {
  WS_MESSAGE_TYPES,
  createConnectedMessage,
  createErrorMessage,
  createRoomJoinedMessage,
  decodeBinaryFrame,
  encodeAwarenessFrame,
  encodeSyncFrame,
  encodeSyncStep1,
  encodeSyncUpdate,
  isFatalErrorCode,
  parseClientMessage,
  type RoomJoinedPayload,
  type WsErrorCode,
} from '@insighthub/shared';

/**
 * Contract-compatible in-process collaboration server (A1 test support).
 *
 * M1-A3 owns the real server. A1 must not wait for it
 * (`docs/TASKS.md` §"Parallel development"), so this double implements exactly the
 * frozen wire semantics A1's client depends on, using the **same shared codec and
 * parsers** the real server uses — never a private framing:
 *
 * | Frozen rule (`docs/CONTRACTS.md`) | Implemented here |
 * | --- | --- |
 * | `connected` greeting with `protocolVersion: 2` | yes |
 * | one socket = at most one room, `join-room(B)` while in A is an **atomic replace** | yes (§5.4) |
 * | binary frame before a successful join → `ROOM_NOT_JOINED`, socket stays open | yes (§6.3) |
 * | SYNC handshake is **client-initiated**: client `SyncStep1` → server `SyncStep2` + server `SyncStep1` → client `SyncStep2` | yes (§10.2) |
 * | a `join-room` with the wrong `protocolVersion` → `PROTOCOL_VERSION_MISMATCH` | yes |
 * | malformed / oversize binary → reported error | yes, via the shared codec |
 * | awareness fan-out + removal on leave/close | yes (§9.1) |
 *
 * It is deliberately small: rooms are never persisted, there is no heartbeat and no
 * backpressure. Those belong to A3 and are A6's chaos scope.
 */

export interface SyncExchange {
  readonly kind: 'sync-step1-in' | 'sync-step2-out' | 'sync-step2-in';
  readonly bytes: number;
  readonly connectionId: string;
}

export interface TestServerOptions {
  /** Content of the room document before any client joins. */
  initialContent?: string;
  /** The server's own awareness entry (published so clients can see a peer). */
  awarenessUser?: { id: string; name: string; color?: string };
}

interface ClientSocketLike {
  readyState: number;
  send(data: Uint8Array | string, options?: { binary: boolean }): void;
  close(code?: number, reason?: string): void;
}

interface ClientRecord {
  id: string;
  socket: ClientSocketLike;
  mode: 'readonly' | 'readwrite';
  /** True once `room-joined` has been sent for `roomId`. */
  joined: boolean;
  roomId: string | undefined;
  /** Awareness client ids known to belong to this socket (usually one). */
  awarenessClients: Set<number>;
  /** Identity used as the transaction origin when applying this socket's updates. */
  syncOrigin: { socket: string };
}

export class ContractTestServer {
  /** Flipped by tests to simulate a network outage. */
  offline = false;

  /** When set, `join-room` is rejected with this code (join failure paths). */
  rejectJoinWith: WsErrorCode | undefined;

  /** Every sync exchange observed, in order (used for byte-size assertions). */
  readonly syncExchanges: SyncExchange[] = [];

  readonly doc: Y.Doc;

  readonly roomDocumentId: string;

  readonly awareness: Awareness;

  private readonly connections = new Map<string, ClientRecord>();

  private readonly sockets = new Set<Duplex>();

  /**
   * Every upgrade this server has ever accepted, including connections that have
   * since closed.
   *
   * Monotonic on purpose: `connectionCount` is a *live* set, so after a fatal error
   * it drops to zero when the client (or this server) closes the socket. A regression
   * that opens one more socket would then be invisible to a `connectionCount`
   * comparison — "0 stayed 0" and "1 → 0 → 1" look alike — while a monotonic counter
   * makes "did another connection attempt ever happen?" a total, order-independent
   * fact.
   */
  private acceptedConnections = 0;

  private server: http.Server | undefined;

  private port = 0;

  constructor(roomDocumentId: string, options: TestServerOptions = {}) {
    this.roomDocumentId = roomDocumentId;
    this.doc = new Y.Doc();
    if (options.initialContent !== undefined && options.initialContent !== '') {
      this.doc.getText('content').insert(0, options.initialContent);
    }
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState({
      user: options.awarenessUser ?? { id: 'server-peer', name: 'Server Peer' },
      cursor: null,
      selection: null,
      updatedAt: 1,
    });
    // Fan the server's own presence out to connected clients.
    this.doc.on('update', this.fanOutDocUpdate);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Total connections ever accepted (monotonic; see `acceptedConnections`). */
  get totalConnections(): number {
    return this.acceptedConnections;
  }

  /** Client ids currently in the room (this is what "presence" means server-side). */
  get awarenessClientIds(): number[] {
    return [...this.awareness.getStates().keys()];
  }

  /** Append text to the room document as if a peer had typed it. */
  applyPeerEdit(insertAt: number, text: string): void {
    this.doc.getText('content').insert(insertAt, text);
  }

  /**
   * Replace one remote awareness entry with arbitrary (possibly invalid) state.
   *
   * `states` is typed `Map<number, any>` by `y-protocols` precisely because entries
   * are whatever a peer sent, so an untrusted value is written here on purpose: this
   * is how the validated read path is tested.
   */
  injectAwarenessState(clientId: number, state: unknown): void {
    this.awareness.states.set(clientId, state as Record<string, unknown>);
    this.awareness.meta.set(clientId, { clock: 1, lastUpdated: Date.now() });
  }

  /** Remove a remote awareness entry without closing its socket (departure test). */
  dropAwarenessState(clientId: number): void {
    this.awareness.states.delete(clientId);
    this.fanOutAwareness([clientId], []);
  }

  async start(): Promise<string> {
    const server = http.createServer();
    this.server = server;
    server.on('upgrade', (request, socket) => {
      if (this.offline) {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1')
        .update(`${request.headers['sec-websocket-key'] ?? ''}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.registerClient(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server did not receive a TCP port');
    }
    this.port = address.port;
    return this.url;
  }

  async stop(): Promise<void> {
    this.offline = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.connections.clear();
    this.doc.off('update', this.fanOutDocUpdate);
    this.awareness.destroy();
    this.doc.destroy();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /* ---------------------------------------------------------------- *
   * Connection handling
   * ---------------------------------------------------------------- */

  private registerClient(socket: Duplex): void {
    this.acceptedConnections += 1;
    this.sockets.add(socket);
    const record: ClientRecord = {
      id: randomUUID(),
      socket: {
        readyState: 1,
        send: (data: Uint8Array | string) => {
          writeWebSocketFrame(socket, data);
        },
        close: (code?: number) => {
          writeCloseFrame(socket, code ?? 1000);
        },
      },
      mode: 'readwrite',
      joined: false,
      roomId: undefined,
      awarenessClients: new Set<number>(),
      syncOrigin: { socket: randomUUID() },
    };
    this.connections.set(record.id, record);

    const reader = new WebSocketFrameReader(
      (data) => this.handleFrame(record, data),
      () => this.handleClose(record),
    );
    socket.on('data', (chunk: Buffer) => reader.push(chunk));
    socket.on('error', () => this.handleClose(record));
    socket.on('close', () => this.handleClose(record));

    // The greeting is scheduled rather than written inline: a client-side HTTP
    // implementation (Node's http client, used by the test transport) discards bytes
    // that arrive in the same tick as the `101` response, before it has handed the
    // socket over. One `setImmediate` makes the greeting deterministic.
    setImmediate(() => {
      if (this.connections.has(record.id)) this.sendText(record, createConnectedMessage(record.id));
    });
  }

  private handleClose(record: ClientRecord): void {
    if (!this.connections.delete(record.id)) return;
    if (record.awarenessClients.size > 0) {
      // Socket close is an implicit leave: remove the entry and broadcast it, which
      // is the only presence signal peers get (D-021).
      const departed = [...record.awarenessClients];
      for (const clientId of departed) this.awareness.states.delete(clientId);
      this.fanOutAwareness([], departed);
    }
    this.broadcastPeers();
  }

  private handleFrame(record: ClientRecord, data: Uint8Array | string): void {
    if (data instanceof Uint8Array) {
      this.handleBinary(record, data);
      return;
    }
    this.handleText(record, data);
  }

  private handleText(record: ClientRecord, raw: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.sendError(record, 'INVALID_MESSAGE', 'frame is not JSON');
      return;
    }

    const parsed = parseClientMessage(decoded);
    if (!parsed.success || parsed.data === undefined) {
      // The real server distinguishes an unknown `type` from an invalid payload;
      // both are fatal for the socket (docs/CONTRACTS.md §7).
      const type = (decoded as { type?: unknown }).type;
      const code: WsErrorCode =
        typeof type === 'string' && !Object.values(WS_MESSAGE_TYPES).includes(type as never)
          ? 'UNKNOWN_MESSAGE_TYPE'
          : 'INVALID_MESSAGE';
      this.sendError(record, code, parsed.error ?? 'invalid client message');
      return;
    }

    const message = parsed.data;
    if (message.type === WS_MESSAGE_TYPES.joinRoom) {
      if (this.rejectJoinWith !== undefined) {
        this.sendError(record, this.rejectJoinWith, 'join refused by the test server');
        return;
      }
      // NOTE: `parseClientMessage` already enforces `protocolVersion === 2` through
      // the shared literal schema, so a v1 peer fails as INVALID_MESSAGE here. A
      // server that wants the dedicated code validates the raw payload first — that
      // path is exercised with `sendRawToAll` in the protocol-mismatch test.
      this.joinRoom(record, message.payload.documentId, message.payload.mode);
      return;
    }

    if (message.type === WS_MESSAGE_TYPES.leaveRoom) {
      if (message.payload.documentId !== record.roomId) {
        // `leave-room(B)` while in A is a no-op (§5.4).
        return;
      }
      this.leaveRoom(record);
    }
  }

  private joinRoom(record: ClientRecord, documentId: string, mode: 'readonly' | 'readwrite'): void {
    if (record.roomId === documentId && record.joined) {
      // Idempotent re-join.
      this.sendText(record, createRoomJoinedMessage(this.rosterPayload(record, documentId)));
      return;
    }
    if (record.roomId !== undefined && record.roomId !== documentId) {
      // Atomic replace: leave A (including its awareness entry) and join B in one
      // transition, then acknowledge B. No leave acknowledgement is sent (§5.4).
      this.leaveRoom(record);
    }
    record.roomId = documentId;
    record.mode = mode;
    record.joined = true;
    this.sendText(record, createRoomJoinedMessage(this.rosterPayload(record, documentId)));
    // The room's existing awareness is NOT sent here. The client is required to drop
    // awareness learned for a previous room when it handles `room-joined`
    // (`clearRemoteStates`), so anything sent before that acknowledgement would be
    // cleared by design. Existing presence is therefore delivered on the client's
    // first awareness frame, below — the same ordering a real server gets for free.
    this.broadcastPeers();
  }

  private leaveRoom(record: ClientRecord): void {
    if (record.awarenessClients.size > 0) {
      const departed = [...record.awarenessClients];
      for (const clientId of departed) this.awareness.states.delete(clientId);
      this.fanOutAwareness([], departed);
      record.awarenessClients.clear();
    }
    record.roomId = undefined;
    record.joined = false;
    this.broadcastPeers();
  }

  private rosterPayload(record: ClientRecord, documentId: string): RoomJoinedPayload {
    return {
      documentId,
      connectionId: record.id,
      peers: [...this.connections.values()]
        .filter((other) => other.id !== record.id && other.joined)
        .map((other) => other.id),
    };
  }

  private broadcastPeers(): void {
    for (const record of this.connections.values()) {
      if (!record.joined || record.roomId === undefined) continue;
      this.sendText(record, createRoomJoinedMessage(this.rosterPayload(record, record.roomId)));
    }
  }

  /* ---------------------------------------------------------------- *
   * Data plane
   * ---------------------------------------------------------------- */

  private handleBinary(record: ClientRecord, bytes: Uint8Array): void {
    const decoded = decodeBinaryFrame(bytes);
    if (!decoded.success || decoded.frame === undefined) {
      this.sendError(
        record,
        (decoded.error ?? 'INVALID_BINARY_FRAME') as WsErrorCode,
        decoded.detail ?? 'undecodable frame',
      );
      return;
    }

    if (!record.joined) {
      // Non-fatal: the socket stays open (§6.3).
      this.sendError(record, 'ROOM_NOT_JOINED', 'join a room before sending data frames');
      return;
    }

    if (decoded.frame.kind === 'awareness') {
      const before = new Set(this.awareness.getStates().keys());
      applyAwarenessUpdate(this.awareness, decoded.frame.bytes, 'test-server');
      for (const clientId of this.awareness.getStates().keys()) {
        if (!before.has(clientId)) record.awarenessClients.add(clientId);
      }
      for (const clientId of decoded.frame.clients) record.awarenessClients.add(clientId);
      // Send this client everything present in the room, so a client that has just
      // joined learns about peers that were already there. (A real server gets this
      // ordering naturally: every peer announces itself when it joins, and the
      // joiner's own announcement is what triggers the fan-out it can observe.)
      const room = [...this.awareness.getStates().keys()];
      if (room.length > 0) {
        this.sendBinary(record, encodeAwarenessFrame(encodeAwarenessUpdate(this.awareness, room)));
      }
      this.fanOutAwareness([...record.awarenessClients], []);
      return;
    }

    const payload = decoded.frame.bytes;
    const messageType = decoding.readVarUint(decoding.createDecoder(payload));
    if (messageType === 0) {
      this.syncExchanges.push({
        kind: 'sync-step1-in',
        bytes: bytes.byteLength,
        connectionId: record.id,
      });
    }

    const decoder = decoding.createDecoder(payload);
    const encoder = encoding.createEncoder();
    // Stamp the application with a per-connection origin so the fan-out below can
    // broadcast it to the *other* clients while never echoing it back to its sender.
    readSyncMessage(decoder, encoder, this.doc, record.syncOrigin);
    if (encoding.length(encoder) > 0) {
      const encoderBytes = encoding.toUint8Array(encoder);
      // `readSyncMessage` writes the SYNC *payload* (`messageType` + length-prefixed
      // body) — the same bytes `decodeBinaryFrame` hands back out. It is NOT a whole
      // frame, so the frame-type header has to be added before it goes on the wire;
      // shipping it raw is exactly the "second framing scheme" R12 forbids, and the
      // client is right to reject it as an undecodable frame.
      const reply = encodeSyncFrame((target) => {
        encoding.writeUint8Array(target, encoderBytes);
      });
      this.syncExchanges.push({
        kind: 'sync-step2-out',
        bytes: reply.byteLength,
        connectionId: record.id,
      });
      this.sendBinary(record, reply);
      // Client-initiated handshake: the server replies to SyncStep1 with
      // SyncStep2 *and* its own SyncStep1 (§10.2).
      this.sendBinary(record, encodeSyncStep1(this.doc));
    }
  }

  private readonly fanOutDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const sender = [...this.connections.values()].find((record) => record.syncOrigin === origin);
    const frame = encodeSyncUpdate(update);
    for (const record of this.connections.values()) {
      if (!record.joined || record === sender) continue;
      this.sendBinary(record, frame);
    }
  };

  private fanOutAwareness(addedOrUpdated: number[], removed: number[]): void {
    const clients = [...new Set([...addedOrUpdated, ...removed])];
    if (clients.length === 0) return;
    const frame = encodeAwarenessFrame(encodeAwarenessUpdate(this.awareness, clients));
    for (const record of this.connections.values()) {
      if (!record.joined) continue;
      this.sendBinary(record, frame);
    }
  }

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  private sendText(record: ClientRecord, message: { type: string; payload: unknown }): void {
    record.socket.send(JSON.stringify({ ...message, ts: new Date().toISOString() }));
  }

  private sendBinary(record: ClientRecord, frame: Uint8Array): void {
    record.socket.send(frame);
  }

  private sendError(record: ClientRecord, code: WsErrorCode, message: string): void {
    this.sendText(record, createErrorMessage(code, message));
    // The fatal/non-fatal split is taken from the shared vocabulary rather than
    // re-implemented here, so the double cannot disagree with the contract.
    if (!isFatalErrorCode(code)) return;
    this.connections.delete(record.id);
    record.socket.close(1002);
  }

  /** Send one awareness frame that this test authored (e.g. a hostile peer). */
  pushAwarenessFrame(clientIds: number[]): void {
    const frame = encodeAwarenessFrame(encodeAwarenessUpdate(this.awareness, clientIds));
    for (const record of this.connections.values()) {
      if (record.joined) this.sendBinary(record, frame);
    }
  }

  /** Send the same already-encoded frame twice (duplicate delivery). */
  pushRawBinaryToAll(frame: Uint8Array): void {
    for (const record of this.connections.values()) {
      if (record.joined) this.sendBinary(record, frame);
    }
  }

  /**
   * Send a raw TEXT payload to every joined client, bypassing validation.
   *
   * Used to exercise the client's reaction to control-plane faults the shared
   * parser would otherwise reject as `INVALID_MESSAGE` — for example a
   * `protocolVersion: 1` join rejection, or the payload shape freeze from D-022.
   */
  sendRawToAll(json: string): void {
    for (const record of this.connections.values()) {
      if (record.joined) record.socket.send(json);
    }
  }

  /**
   * Reject every joined client with a typed error, on the **production** fatal path.
   *
   * This goes through `sendError`, so a fatal code writes the error frame *and* closes
   * the socket (`docs/CONTRACTS.md` §7), which is what A3's server does. That
   * combination is the whole point: `sendRawToAll` alone leaves the socket open, so the
   * client closes it itself and detaches its handlers first — meaning the close event a
   * still-active provider would react to never reaches it, and a "fatal must not
   * reconnect" test built on it can never fail.
   */
  failAllWith(code: WsErrorCode, message: string): void {
    for (const record of [...this.connections.values()]) {
      if (record.joined) this.sendError(record, code, message);
    }
  }

  /**
   * Drop every live socket without a close handshake, as a network failure would.
   *
   * Used as the positive control for the fatal-error pin: it proves that the client's
   * own reconnect path *is* observable through `totalConnections` inside
   * `TEST_RECONNECT_OBSERVE_MS`, so "no new connection" in that same window is
   * evidence rather than a race.
   */
  dropAllConnections(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /** The frozen `room-joined` payload shape, for the D-022 regression assertion. */
  roomJoinedPayloadShape(documentId: string): Record<string, unknown> {
    const message = createRoomJoinedMessage({
      documentId,
      connectionId: 'shape-check',
      peers: [],
    });
    return message.payload as unknown as Record<string, unknown>;
  }
}

/* ------------------------------------------------------------------ *
 * WebSocket framing over a raw TCP socket
 * ------------------------------------------------------------------ */

function writeWebSocketFrame(socket: Duplex, data: Uint8Array | string): void {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const opcode = typeof data === 'string' ? 0x1 : 0x2;
  socket.write(encodeFrame(payload, opcode));
}

function writeCloseFrame(socket: Duplex, code: number): void {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  socket.write(encodeFrame(payload, 0x8));
  socket.end();
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const length = payload.byteLength;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Minimal RFC 6455 server-side reader.
 *
 * Only client→server frames are decoded (masked, as the spec requires). Fragmented
 * messages are accumulated, because WebSocket implementations are free to split a
 * large binary frame across continuation frames.
 */
class WebSocketFrameReader {
  private buffer = Buffer.alloc(0);

  private fragments: Buffer[] = [];

  private fragmentOpcode = 0;

  constructor(
    private readonly onMessage: (data: Uint8Array | string) => void,
    private readonly onClose: () => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.readFrame()) {
      /* keep reading */
    }
  }

  private readFrame(): boolean {
    const buffer = this.buffer;
    if (buffer.byteLength < 2) return false;
    const first = buffer[0]!;
    const second = buffer[1]!;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.byteLength < offset + 2) return false;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.byteLength < offset + 8) return false;
      const big = buffer.readBigUInt64BE(offset);
      length = Number(big);
      offset += 8;
    }

    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.byteLength < offset + length) return false;

    let payload = buffer.subarray(offset, offset + length);
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
    }
    this.buffer = buffer.subarray(offset + length);

    if (opcode === 0x8) {
      this.onClose();
      return false;
    }
    if (opcode === 0x9 || opcode === 0xa) return true; // ping/pong: ignored by the double

    if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    }

    if (!fin) return true;
    const complete = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1) this.onMessage(complete.toString('utf8'));
    else this.onMessage(new Uint8Array(complete));
    return true;
  }
}

/**
 * Browser-shaped WebSocket client over a raw TCP socket.
 *
 * The handshake is written and parsed by hand instead of using `http.request`. That
 * is deliberate: Node's HTTP client discards bytes that arrive in the same tick as
 * the `101` response, which silently swallowed the server's `connected` greeting and
 * made every wire-level test flaky-by-design. Owning the socket means the byte
 * stream is handled in exactly one place and the test transport cannot lose a frame.
 *
 * Handlers are plain properties (like the DOM API), so a test can await the open
 * event without an event-target implementation. Only the members the provider uses
 * are provided.
 */
export class TestWebSocketClient {
  binaryType = 'arraybuffer';

  readyState = 0;

  onopen: (() => void) | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;

  onerror: (() => void) | null = null;

  onclose: (() => void) | null = null;

  /**
   * Messages that arrived before a handler was attached.
   *
   * The real `WebSocket` queues inbound messages until the page assigns `onmessage`,
   * and the collaboration provider assigns its handlers immediately *after*
   * constructing the socket — so a server greeting can legitimately arrive first.
   * Losing it here would make the whole wire suite depend on task ordering, which is
   * exactly the class of bug this double must not introduce.
   */
  private readonly pendingMessages: Array<Uint8Array | string> = [];

  private openNotified = false;

  private lastError: Error | undefined;

  private socket: import('node:net').Socket | undefined;

  private buffered: Buffer = Buffer.alloc(0);

  private handshakeComplete = false;

  private handedOver = false;

  private readonly emitter = new EventEmitter();

  private readonly reader = new WebSocketFrameReader(
    (data) => this.deliver(data),
    () => this.settle(3),
  );

  constructor(url: string) {
    const parsed = new URL(url);
    const key = randomUUID().replace(/-/g, '').slice(0, 22) + '==';
    const port = parsed.port === '' ? (parsed.protocol === 'wss:' ? 443 : 80) : Number(parsed.port);
    const path = parsed.pathname === '' ? '/ws' : `${parsed.pathname}${parsed.search}`;

    const socket = net.connect({ host: parsed.hostname, port }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n\r\n`,
      );
    });
    this.socket = socket;

    socket.on('data', (chunk: Buffer) => this.push(chunk));
    socket.on('error', (error: Error) => {
      this.lastError = error;
      this.notifyError();
      this.finish();
      // A failed connection must not keep the event loop alive.
      socket.destroy();
    });
    socket.on('close', () => this.finish());
  }

  /** Resolve once the socket is open (or reject on failure). */
  waitForOpen(): Promise<void> {
    if (this.readyState === 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error('test websocket failed to open'));
      };
      const cleanup = (): void => {
        this.emitter.off('open', onOpen);
        this.emitter.off('error', onError);
      };
      this.emitter.on('open', onOpen);
      this.emitter.on('error', onError);
    });
  }

  /** Resolve after `ms` milliseconds of wall clock. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ---------------------------------------------------------------- *
   * Handler attachment
   *
   * The collaboration provider configures the socket after constructing it, so a
   * server frame can arrive first. Attaching `onopen`/`onmessage` therefore replays
   * anything already received — the same guarantee the browser `WebSocket` gives.
   * ---------------------------------------------------------------- */

  setOnOpen(handler: () => void): void {
    this.onopen = handler;
    if (this.readyState === 1 && !this.openNotified) {
      this.openNotified = true;
      handler();
    }
  }

  setOnMessage(handler: (event: { data: unknown }) => void): void {
    this.onmessage = handler;
    this.flushMessages();
  }

  setOnError(handler: () => void): void {
    this.onerror = handler;
  }

  setOnClose(handler: () => void): void {
    this.onclose = handler;
    if (this.readyState === 3) handler();
  }

  /** Clear every callback (used by the provider during teardown). */
  detachHandlers(): void {
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.pendingMessages.length = 0;
  }

  send(data: Uint8Array | string): void {
    const socket = this.socket;
    if (socket === undefined || this.readyState !== 1) {
      throw new Error('test websocket is not open');
    }
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    // Client frames MUST be masked (RFC 6455 §5.3); the server double verifies it by
    // unmasking, exactly as a real `ws` server does.
    socket.write(maskFrame(bytes, typeof data === 'string' ? 0x1 : 0x2));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 2;
    const socket = this.socket;
    if (socket === undefined) {
      this.settle(3);
      return;
    }
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000, 0);
    try {
      socket.write(maskFrame(payload, 0x8));
    } catch {
      /* the peer is already gone */
    }
    this.settle(3);
    socket.end();
  }

  /** Split the HTTP handshake from the frame stream, then hand bytes to the reader. */
  private push(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (!this.handshakeComplete) {
      const end = this.buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buffered.subarray(0, end).toString('latin1');
      const statusLine = head.split('\r\n')[0] ?? '';
      this.handshakeComplete = true;
      this.buffered = this.buffered.subarray(end + 4);
      if (!statusLine.includes('101')) {
        this.notifyError();
        this.settle(3);
        return;
      }
      this.readyState = 1;
      this.handedOver = true;
      this.emit('open');
    }
    if (this.handedOver && this.buffered.byteLength > 0) {
      const pending = this.buffered;
      this.buffered = Buffer.alloc(0);
      this.reader.push(pending);
    }
  }

  /**
   * Deliver a decoded message, or queue it until `onmessage` exists.
   *
   * Delivery is synchronous once a handler is attached: a real browser dispatches on
   * a task, but the provider's own state machine is driven by these callbacks, and
   * tests assert on the state after awaiting them.
   */
  private deliver(data: Uint8Array | string): void {
    if (this.onmessage === null) {
      this.pendingMessages.push(data);
      return;
    }
    this.onmessage({ data });
  }

  private flushMessages(): void {
    if (this.onmessage === null) return;
    const queued = this.pendingMessages.splice(0, this.pendingMessages.length);
    for (const data of queued) {
      this.onmessage({ data });
    }
  }

  private emit(event: 'open' | 'error'): void {
    if (event === 'open') {
      if (this.openNotified) return;
      if (this.onopen === null) return; // replayed by `setOnOpen`
      this.openNotified = true;
      this.onopen();
      return;
    }
    this.onerror?.();
    this.emitter.emit(event);
  }

  /** Notify failure without tripping the EventEmitter's "unhandled error" throw. */
  private notifyError(): void {
    this.onerror?.();
    // `waitForOpen` listens for this; other callers do not, hence `listenerCount`.
    if (this.emitter.listenerCount('error') > 0) this.emitter.emit('error');
  }

  /** Record the failure, then close exactly once. */
  private finish(): void {
    if (this.lastError !== undefined) this.notifyError();
    this.settle(3);
  }

  /** Move to CLOSED and fire `onclose` exactly once. */
  private settle(state: number): void {
    if (this.readyState === 3) return;
    this.readyState = state;
    if (state !== 3) return;
    this.onclose?.();
  }
}

/** Encode a client→server frame: FIN + opcode, masked payload. */
function maskFrame(payload: Buffer, opcode: number): Buffer {
  const length = payload.byteLength;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}
