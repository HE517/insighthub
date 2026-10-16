/**
 * The document room registry: membership, routing, lifecycle and the atomic
 * replace transition.
 *
 * ## The invariant this file exists to hold
 *
 * `docs/CONTRACTS.md` §5.4 / `AGENTS.md` R15: **one socket carries at most one
 * active document room.** That is enforced structurally, not by convention:
 *
 * - A connection's room is a single field, `SocketContext.activeRoom` — there is no
 *   representation in which a socket holds two rooms, so "join a second room"
 *   cannot be written by accident.
 * - `joinRoom` is a **fully synchronous** function. JavaScript runs it to
 *   completion before any other socket event can be handled, so the transition
 *   "leave A, then join B" is never observable in a half-applied state: no other
 *   handler can run between the two halves, and no `await` exists between them.
 *   That is what makes the replace *atomic* rather than merely ordered.
 * - Every failure is decided **before** the first mutation. The refusals (protocol
 *   mismatch, refused document) return before anything is touched, so a refused
 *   join can never leave the socket room-less while the server believes it
 *   succeeded, and can never leave an awareness ghost in the room it kept.
 * - There is exactly one transition function, `#detach`, used by leave, disconnect
 *   and replace. A second copy is how the awareness cleanup gets forgotten in one
 *   of those three paths.
 */
import {
  PROTOCOL_VERSION,
  WS_ERROR_CODES,
  decodeBinaryFrame,
  type JoinRoomPayload,
  type WsErrorCode,
} from '@insighthub/shared';

import type { SocketContext } from './context.js';
import { PeerImpl, type Peer, type SocketLike } from './peer.js';
import { DocumentRoom, type AwarenessRejection, type RoomSnapshot } from './room.js';

/**
 * The failure variant of a codec decode result.
 *
 * Declared structurally because the codec's own union does not discriminate through a
 * negated `success` field (see `isDecodeFailure`). `code` is exactly the two frozen
 * candidates the codec can report.
 */
interface BinaryDecodeFailure {
  success: false;
  error: typeof WS_ERROR_CODES.INVALID_BINARY_FRAME | typeof WS_ERROR_CODES.FRAME_TOO_LARGE;
  detail?: string;
}

/**
 * Outcome of routing one inbound frame.
 *
 * `code` is the frozen vocabulary value to report; whether the socket dies is
 * decided from that code by `isFatalErrorCode` at the transport, so the "does this
 * socket die?" question has one answer (`docs/CONTRACTS.md` §7).
 */
export type RouteOutcome = { ok: true } | { ok: false; code: WsErrorCode; message: string };

/**
 * Narrow a codec result to its failure variant.
 *
 * The codec types a decode outcome as
 * `{ success: true; frame } | { success: false; error }`, but its error field is
 * declared with optional inverse members, which stops TypeScript from discriminating
 * the union through a negated `success`. This predicate states the narrowing that the
 * runtime shape already guarantees, rather than weakening the code type to include the
 * codec's `'ok'` member.
 */
function isDecodeFailure(
  result: ReturnType<typeof decodeBinaryFrame>,
): result is BinaryDecodeFailure {
  return !result.success;
}

/** Where the registry logs. Defaults to the console; tests inject a recorder. */
export interface RegistryLogger {
  warn(message: string, detail?: Record<string, unknown>): void;
}

const defaultLogger: RegistryLogger = {
  warn: (message, detail) => {
    if (detail === undefined) console.warn(`[rooms] ${message}`);
    else console.warn(`[rooms] ${message}`, detail);
  },
};

export interface RoomRegistryOptions {
  logger?: RegistryLogger;
  /**
   * Gate consulted before a room is created for a `documentId`.
   *
   * M1 has no document store and no permissions, so the default opens every room
   * (`docs/CONTRACTS.md` §12). It exists as a seam for M2: returning false is what
   * `ROOM_NOT_FOUND` means for this server — "the server refused to open the room".
   */
  authorizeJoin?: (documentId: string) => boolean;
}

export class RoomRegistry {
  readonly #rooms = new Map<string, DocumentRoom>();
  readonly #contexts = new Map<Peer, SocketContext>();
  readonly #logger: RegistryLogger;
  readonly #authorizeJoin: (documentId: string) => boolean;

  constructor(options: RoomRegistryOptions = {}) {
    this.#logger = options.logger ?? defaultLogger;
    this.#authorizeJoin = options.authorizeJoin ?? (() => true);
  }

  /* ---------------------------------------------------------------- *
   * Connection lifecycle
   * ---------------------------------------------------------------- */

  /** Register a freshly accepted socket. The caller sends the handshake. */
  registerSocket(socket: SocketLike, connectionId: string): SocketContext {
    const peer: Peer = new PeerImpl(socket, connectionId);
    const context: SocketContext = {
      connectionId,
      peer,
      activeRoom: null,
      awarenessClients: new Set<number>(),
    };
    this.#contexts.set(peer, context);
    return context;
  }

  /**
   * The context for a peer, or undefined once it has disconnected.
   *
   * Keyed by the peer object rather than by the raw socket, so this layer never
   * holds a reference to a socket it does not own.
   */
  contextFor(peer: Peer): SocketContext | undefined {
    return this.#contexts.get(peer);
  }

  /**
   * Tear a connection down: leave its room, drop its awareness (broadcasting the
   * removal), and delete its context.
   *
   * Idempotent, because a socket can be torn down by several routes at once (client
   * close frame, heartbeat termination, server shutdown) and every one of them runs
   * this.
   */
  disconnect(context: SocketContext): void {
    if (!this.#contexts.has(context.peer)) return;

    if (context.activeRoom !== null) {
      this.#detach(context);
    }
    this.#contexts.delete(context.peer);
    context.awarenessClients.clear();
  }

  get connectionCount(): number {
    return this.#contexts.size;
  }

  /* ---------------------------------------------------------------- *
   * join-room / leave-room
   * ---------------------------------------------------------------- */

  /**
   * Route a `join-room`.
   *
   * Cases, from `docs/CONTRACTS.md` §5.4:
   *
   * | Situation | Behaviour |
   * | --- | --- |
   * | not in a room | create/attach the room, reply `room-joined` |
   * | already in this room | idempotent re-join, reply `room-joined` |
   * | in a different room | atomic replace, reply `room-joined(B)` |
   *
   * Returns the roster for the `room-joined` acknowledgement, or a typed failure.
   * The acknowledgement is returned rather than sent so the transport owns the wire
   * and this layer stays testable without a socket.
   */
  joinRoom(
    context: SocketContext,
    payload: JoinRoomPayload,
  ):
    | { ok: true; documentId: string; peers: string[]; room: DocumentRoom }
    | { ok: false; code: WsErrorCode; message: string } {
    // ---- Validation first: nothing below this point can refuse. ----
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        code: WS_ERROR_CODES.PROTOCOL_VERSION_MISMATCH,
        message: `server speaks protocol version ${PROTOCOL_VERSION}`,
      };
    }
    if (!this.#authorizeJoin(payload.documentId)) {
      return {
        ok: false,
        code: WS_ERROR_CODES.ROOM_NOT_FOUND,
        message: 'no room can be opened for this document',
      };
    }

    const documentId = payload.documentId;

    // ---- Single synchronous transition. ----
    const room = this.#getOrCreateRoom(documentId);

    if (context.activeRoom !== room) {
      // `#detach` covers both "was in room A" and "was in no room": awareness
      // removal, membership removal and (when A becomes empty) A's destruction all
      // happen here, before this socket is added to B. Because this function is
      // synchronous, no peer of A and no peer of B can observe an intermediate
      // state — and no state exists in which the socket is in both rooms or in
      // neither while the server has already replied successfully.
      this.#detach(context);
      room.add(context);
      context.activeRoom = room;
    }

    const peers = room
      .participants()
      .filter((participant) => participant !== context)
      .map((participant) => participant.peer.connectionId);

    // The room is returned so the transport can send `room-joined` **before** any
    // data-plane frame. Delivering pre-existing awareness from inside this method put a
    // BINARY frame ahead of the join acknowledgement, which `docs/CONTRACTS.md` §4
    // forbids and which made a real A1 client discard the payload (it clears remote
    // awareness while processing `room-joined`). Found by the M1-A0.2 cross-agent test.
    return { ok: true, documentId, peers, room };
  }

  /**
   * Route a `leave-room`.
   *
   * `leave-room(B)` while in A is a **no-op**: A stays active. Treating a stale
   * document id as "leave everything" would silently drop a live room, which is the
   * class of bug the cardinality table exists to prevent.
   */
  leaveRoom(context: SocketContext, documentId: string): { ok: true; left: boolean } {
    const room = context.activeRoom;
    if (room === null || room.documentId !== documentId) {
      return { ok: true, left: false };
    }
    this.#detach(context);
    return { ok: true, left: true };
  }

  /* ---------------------------------------------------------------- *
   * Data plane
   * ---------------------------------------------------------------- */

  /**
   * Route one raw BINARY frame.
   *
   * Order of operations, which the frozen contract fixes:
   *
   * 1. **Decode first.** The shared codec bounds the frame against
   *    `MAX_BINARY_FRAME_BYTES` before any decode work, so an oversized frame costs
   *    one error rather than an allocation.
   * 2. **Then require a room.** A data-plane frame before a successful `join-room`
   *    is `ROOM_NOT_JOINED` and is **non-fatal** — the socket stays open, because a
   *    client racing its own handshake is normal.
   * 3. A frame that fails to decode is reported with the codec's own code, which is
   *    fatal for `INVALID_BINARY_FRAME` and `FRAME_TOO_LARGE`.
   */
  handleBinaryFrame(context: SocketContext, raw: Uint8Array): RouteOutcome {
    const decoded = decodeBinaryFrame(raw);
    if (isDecodeFailure(decoded)) {
      return { ok: false, code: decoded.error, message: decoded.detail ?? 'invalid binary frame' };
    }

    const room = context.activeRoom;
    if (room === null) {
      return {
        ok: false,
        code: WS_ERROR_CODES.ROOM_NOT_JOINED,
        message: 'binary collaboration frames require a successful join-room first',
      };
    }

    const participant = room.participants().find((entry) => entry === context);
    if (participant === undefined) {
      // Defensive: a context's room must contain the context. Reaching this means an
      // internal invariant broke, and routing the frame anyway would deliver an
      // update to a room this socket is not in.
      return {
        ok: false,
        code: WS_ERROR_CODES.INTERNAL_ERROR,
        message: 'room membership is inconsistent for this connection',
      };
    }

    // The predicate above guarantees the failure branch is gone, so a frame is present.
    const frame = decoded.frame;
    if (frame === undefined) {
      return {
        ok: false,
        code: WS_ERROR_CODES.INVALID_BINARY_FRAME,
        message: 'no frame was produced for this binary message',
      };
    }

    if (frame.kind === 'sync') {
      room.handleSync(frame, participant);
      return { ok: true };
    }

    const rejection: AwarenessRejection = room.handleAwareness(frame, participant);
    if (rejection === 'too-many-clients') {
      // Abuse limit from the frozen contract. Awareness never closes a socket: it is
      // ephemeral, untrusted and bounded, so dropping the frame is the whole remedy.
      // The reason is logged and never sent, because the vocabulary has no code for
      // it and the contract for untrusted presence data is to discard.
      this.#logger.warn('dropped an awareness update that exceeded the client limit', {
        documentId: room.documentId,
        connectionId: context.connectionId,
        clients: frame.clients.length,
      });
    }
    return { ok: true };
  }

  /* ---------------------------------------------------------------- *
   * Introspection (tests + operational logging)
   * ---------------------------------------------------------------- */

  roomCount(): number {
    return this.#rooms.size;
  }

  hasRoom(documentId: string): boolean {
    return this.#rooms.has(documentId);
  }

  /** Throws if the id is unknown; used by tests that just asserted otherwise. */
  requireRoom(documentId: string): DocumentRoom {
    const room = this.#rooms.get(documentId);
    if (room === undefined) throw new Error(`no room for documentId ${documentId}`);
    return room;
  }

  roomSnapshots(): RoomSnapshot[] {
    return [...this.#rooms.values()].map((room) => room.snapshot());
  }

  /** Destroy every room and forget every connection. Used by server shutdown. */
  destroy(): void {
    for (const context of this.#contexts.values()) {
      context.activeRoom = null;
      context.awarenessClients.clear();
    }
    this.#contexts.clear();
    for (const room of this.#rooms.values()) {
      room.destroy();
    }
    this.#rooms.clear();
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #getOrCreateRoom(documentId: string): DocumentRoom {
    const existing = this.#rooms.get(documentId);
    if (existing !== undefined) return existing;
    const room = new DocumentRoom(documentId);
    this.#rooms.set(documentId, room);
    return room;
  }

  /**
   * Remove `context` from whatever room it is in, cleaning up after it.
   *
   * The single detach path, used by `leave-room`, `disconnect` and the first half of
   * an atomic replace, so those three cannot disagree about awareness cleanup:
   *
   * 1. remove the socket's awareness entries from the room and broadcast the removal
   *    to the peers that remain (`docs/CONTRACTS.md` §9.1);
   * 2. remove the socket from the room's participant set;
   * 3. clear the context's room field, so the socket is unambiguously room-less;
   * 4. destroy the room when the last participant leaves — M1 has no persistence, so
   *    an empty room holds nothing worth keeping and would otherwise leak one
   *    `Y.Doc` plus one awareness timer per document ever opened.
   */
  #detach(context: SocketContext): void {
    const room = context.activeRoom;
    if (room === null) return;

    room.removeAwareness(context.awarenessClients);
    context.awarenessClients.clear();

    room.remove(context);
    context.activeRoom = null;

    this.#destroyRoomIfEmpty(room);
  }

  #destroyRoomIfEmpty(room: DocumentRoom): void {
    if (!room.isEmpty) return;
    // Only the instance still registered for this document may be destroyed, so a
    // room re-created during teardown cannot be destroyed by a stale reference.
    if (this.#rooms.get(room.documentId) === room) {
      this.#rooms.delete(room.documentId);
    }
    room.destroy();
  }
}
