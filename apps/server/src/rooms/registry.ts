/**
 * The document room registry: membership, routing, lifecycle, the atomic replace
 * transition, the hydration barrier and the per-document durable mutation pipeline.
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
 *
 * ## M2: why `joinRoom` is still synchronous (`docs/DECISIONS.md` D-043)
 *
 * Durable hydration needs asynchronous I/O, and the tempting fix is "make `joinRoom`
 * async". That would reopen exactly the class of bug M1 closed: during an `await`, the
 * socket could be "out of A but not yet in B", and both the atomic-replace tests and the
 * one-room reasoning rest on that step never yielding.
 *
 * So the join is **two-phase**: membership stays synchronous and unchanged, and only the
 * `room-joined` *acknowledgement* is deferred behind the hydration barrier. `room-joined`
 * is already the contract's "before the data plane" gate (`docs/CONTRACTS.md` §4), so
 * deferring it needs no protocol change.
 *
 * ## M2: the three-layer ownership rule (`docs/ARCHITECTURE.md` §7.2)
 *
 * ```text
 * RoomRegistry   membership, room identity, eviction policy, the hydration barrier, the pipeline
 * DocumentRoom   the in-memory Y.Doc, awareness, relay decisions
 * DocumentStore  durable bytes, append ordering, compaction, transactions
 * ```
 *
 * `DocumentStore` never sees a socket; `DocumentRoom` never sees a file; the registry is the
 * only place that knows both exist. That is why the pipeline's three phases live here: the
 * room exposes `apply` and `broadcast` separately, and this file puts `persist` between them.
 */
import {
  PROTOCOL_VERSION,
  WS_ERROR_CODES,
  decodeBinaryFrame,
  type DecodedBinaryFrame,
  type DecodedSyncFrame,
  type JoinRoomPayload,
  type WsErrorCode,
} from '@insighthub/shared';
import * as Y from 'yjs';

import {
  COMPACTION_LOG_BYTES_THRESHOLD,
  COMPACTION_UPDATE_THRESHOLD,
} from '../persistence/constants.js';
import { DocumentHydrator } from '../persistence/hydrator.js';
import { SerialTaskQueue } from '../persistence/serial-queue.js';
import type { DocumentStore } from '../persistence/types.js';
import type { SocketContext } from './context.js';
import { PeerImpl, type Peer, type SocketLike } from './peer.js';
import {
  DocumentRoom,
  HYDRATION_BACKLOG_OVERFLOW_TAG,
  type AwarenessRejection,
  type BacklogEntry,
  type RoomParticipant,
  type RoomSnapshot,
} from './room.js';

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
 * How the hydration barrier settled for one joiner.
 *
 * `evicted` and `unhealthy` are both "do not send `room-joined`", but for different
 * reasons and with different logging: `evicted` means the room is gone because everyone
 * left while it was loading (a normal race), `unhealthy` means it failed and the
 * participants have already been notified.
 */
export type HydrationOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'unhealthy' | 'evicted' };

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

/**
 * Compaction accounting for one room (`docs/DECISIONS.md` D-042).
 *
 * Counted from what the pipeline actually did — rows appended since the last snapshot and
 * the payload bytes those rows carried — rather than by querying the store, so the frozen
 * five-method seam needs no extra introspection call. `load()` gives the true starting
 * values, so the counters stay accurate across a restart.
 */
interface CompactionAccounting {
  /** Highest committed sequence this room knows about. */
  lastSequence: number;
  /** Update rows appended since the snapshot was last replaced. */
  appendedSinceSnapshot: number;
  /** Payload bytes of those rows. */
  bytesSinceSnapshot: number;
}

/** Registry-owned state that is not the room's business. */
interface RoomRuntime {
  readonly queue: SerialTaskQueue;
  readonly accounting: CompactionAccounting;
  /** Single-flight hydration promise shared by every concurrent joiner (D-043 point 3). */
  readonly barrier: Promise<HydrationOutcome>;
}

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
  /**
   * The durable store (`docs/ARCHITECTURE.md` §7.3).
   *
   * When present, every room hydrates through it and every document mutation is persisted
   * before it is broadcast. When absent the registry behaves as M1: rooms are `READY`
   * immediately and nothing is persisted.
   *
   * Absent is only reachable from a hand-built config. `apps/server/src/index.ts` always
   * supplies a store and fails startup if one cannot be opened, so the *server* has no
   * memory-only mode (`docs/DECISIONS.md` D-051); a registry without a store is a library
   * wiring a transport without durable storage, and it says so in the log.
   */
  store?: DocumentStore;
}

export class RoomRegistry {
  readonly #rooms = new Map<string, DocumentRoom>();
  readonly #runtime = new Map<DocumentRoom, RoomRuntime>();
  readonly #contexts = new Map<Peer, SocketContext>();
  readonly #logger: RegistryLogger;
  readonly #authorizeJoin: (documentId: string) => boolean;
  readonly #store: DocumentStore | undefined;
  readonly #hydrator: DocumentHydrator | undefined;

  constructor(options: RoomRegistryOptions = {}) {
    this.#logger = options.logger ?? defaultLogger;
    this.#authorizeJoin = options.authorizeJoin ?? (() => true);
    this.#store = options.store;
    this.#hydrator = options.store === undefined ? undefined : new DocumentHydrator(options.store);

    if (this.#store === undefined) {
      // Loud on purpose: a transport running without durable storage is exactly the M1
      // data-loss mode, so it must never be a quiet default (`docs/DECISIONS.md` D-051).
      this.#logger.warn(
        'room registry started WITHOUT durable storage; document mutations will not be persisted',
        { reason: 'no DocumentStore was supplied' },
      );
    }
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
   * Returns the roster for the `room-joined` acknowledgement, the room, and the **hydration
   * barrier** the transport must await before sending that acknowledgement. The
   * acknowledgement is returned rather than sent so the transport owns the wire and this
   * layer stays testable without a socket.
   *
   * Membership is applied synchronously; only the barrier is asynchronous (D-043).
   */
  joinRoom(
    context: SocketContext,
    payload: JoinRoomPayload,
  ):
    | {
        ok: true;
        documentId: string;
        peers: string[];
        room: DocumentRoom;
        barrier: Promise<HydrationOutcome>;
      }
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
      // removal, membership removal and (when A becomes empty) A's eviction all
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
    //
    // The barrier is the M2 addition: it resolves when the room is `READY`, and the
    // transport must await it before acknowledging (D-043).
    const runtime = this.#requireRuntime(room);
    return { ok: true, documentId, peers, room, barrier: runtime.barrier };
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
   * Hydration barrier release
   * ---------------------------------------------------------------- */

  /**
   * Replay the frames that arrived while the room was hydrating, in arrival order.
   *
   * Called by the transport **after** it has sent this joiner's `room-joined`, so the
   * contract's "no data-plane frame before the acknowledgement" ordering holds for the
   * frames' author (`docs/CONTRACTS.md` §4). Idempotent: the first caller drains the queue
   * and later callers find it empty.
   *
   * A frame whose author left during hydration is dropped, not replayed: replaying it would
   * persist an edit on behalf of a socket that is gone and relay it to nobody.
   */
  releaseHydrationBacklog(room: DocumentRoom): Promise<RouteOutcome[]> {
    if (!room.acceptsMutations) return Promise.resolve([]);

    const drained: BacklogEntry[] = room.drainBacklog();
    if (drained.length === 0) return Promise.resolve([]);

    const outcomes: Promise<RouteOutcome>[] = [];
    for (const entry of drained) {
      // Re-validate after the barrier (`docs/DECISIONS.md` D-049 obligation 1). A socket can
      // close, or be atomically replaced into another room, while hydration is in flight;
      // replaying its frames would persist an edit on behalf of a socket that is gone and
      // relay it to nobody.
      const context = this.#contexts.get(entry.participant.peer);
      if (context === undefined) continue;
      if (context.activeRoom !== room) continue;
      if (!context.peer.isOpen()) continue;
      outcomes.push(this.#dispatchDecodedFrame(room, context, entry.frame));
    }
    return Promise.all(outcomes);
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
   * 4. **Then the lifecycle gate.** A `HYDRATING` room holds the frame in its bounded
   *    backlog without applying or answering it; a frame that would overflow the backlog
   *    makes the room `UNHEALTHY` with `INTERNAL_ERROR`, never `FRAME_TOO_LARGE`
   *    (`docs/DECISIONS.md` D-050).
   */
  async handleBinaryFrame(context: SocketContext, raw: Uint8Array): Promise<RouteOutcome> {
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

    // ---- Lifecycle gate (D-049) ----
    if (room.state === 'hydrating' || room.state === 'created') {
      if (room.enqueueBacklog(participant, frame) === 'overflow') {
        this.#logger.warn('hydration backlog overflowed; failing the room', {
          tag: HYDRATION_BACKLOG_OVERFLOW_TAG,
          documentId: room.documentId,
          connectionId: context.connectionId,
          backlogFrames: room.backlogFrames,
          backlogBytes: room.backlogBytes,
        });
        // A cumulative backlog overflow is a server-side lifecycle condition, so the wire
        // answer is INTERNAL_ERROR and never FRAME_TOO_LARGE (D-050). The failure is
        // reported to every participant by `#failRoomUnhealthy`.
        this.#failRoomUnhealthy(room, 'hydration backlog overflow');
        return { ok: true };
      }
      return { ok: true };
    }

    if (!room.acceptsMutations) {
      return {
        ok: false,
        code: WS_ERROR_CODES.INTERNAL_ERROR,
        message: 'this room is not accepting updates',
      };
    }

    return this.#dispatchDecodedFrame(room, participant, frame);
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
    for (const runtime of this.#runtime.values()) {
      runtime.queue.stop('shutdown');
    }
    this.#runtime.clear();
    for (const room of this.#rooms.values()) {
      room.destroy();
    }
    this.#rooms.clear();
  }

  /* ---------------------------------------------------------------- *
   * Internals — dispatch
   * ---------------------------------------------------------------- */

  /** Route one already-validated frame for a `READY` room. */
  async #dispatchDecodedFrame(
    room: DocumentRoom,
    participant: RoomParticipant,
    frame: DecodedBinaryFrame,
  ): Promise<RouteOutcome> {
    if (frame.kind === 'awareness') {
      // Presence is ephemeral and never persisted (`docs/CONTRACTS.md` §9), so it bypasses
      // the durable pipeline entirely: making presence durable would be a second presence
      // channel, which D-021 deleted.
      const rejection: AwarenessRejection = room.handleAwareness(frame, participant);
      if (rejection === 'too-many-clients') {
        // Abuse limit from the frozen contract. Awareness never closes a socket: it is
        // ephemeral, untrusted and bounded, so dropping the frame is the whole remedy.
        // The reason is logged and never sent, because the vocabulary has no code for
        // it and the contract for untrusted presence data is to discard.
        this.#logger.warn('dropped an awareness update that exceeded the client limit', {
          documentId: room.documentId,
          connectionId: participant.peer.connectionId,
          clients: frame.clients.length,
        });
      }
      return { ok: true };
    }

    // Read-only: a SyncStep1 answer appends nothing, so it needs no durable slot.
    if (room.replyToSyncStep1(frame, participant)) return { ok: true };

    return this.#submitMutation(room, participant, frame);
  }

  /**
   * Phase-ordered durable mutation: `apply → persist → broadcast` (D-044), serialized per
   * document (D-048).
   *
   * ## Why the task's rejection is not returned to the caller as an error
   *
   * `#failRoomUnhealthy` already sent `INTERNAL_ERROR` to **every** participant and closed
   * them (D-044 point 2). Returning a code here as well would deliver a second error to the
   * author, and the transport would then close a socket that is already closing.
   */
  #submitMutation(
    room: DocumentRoom,
    participant: RoomParticipant,
    frame: DecodedSyncFrame,
  ): Promise<RouteOutcome> {
    const runtime = this.#runtime.get(room);
    const store = this.#store;

    if (runtime === undefined) {
      return Promise.resolve({
        ok: false,
        code: WS_ERROR_CODES.INTERNAL_ERROR,
        message: 'the room has no runtime state',
      });
    }

    if (store === undefined) {
      // No durable storage configured: apply and relay synchronously, with M1 semantics.
      // Only reachable from a transport built without a store (see `RoomRegistryOptions`).
      const update = room.applySyncPayload(frame);
      if (update !== null) room.broadcastUpdate(update, participant);
      return Promise.resolve({ ok: true });
    }

    return runtime.queue
      .enqueue(async () => {
        // Phase 1 — apply. Inside the queue slot, so no other mutation for this document
        // can observe or interleave with this step.
        const update = room.applySyncPayload(frame);
        if (update === null) return;

        // Phase 2 — persist, awaited. If this rejects, no peer has been told anything, so
        // the server never claims a state it cannot recover (D-044).
        const sequence = await store.append(room.documentId, update);
        this.#recordCommit(runtime, sequence, update.byteLength);

        // Phase 3 — broadcast, only after the bytes are durable.
        room.broadcastUpdate(update, participant);
      })
      .then(
        (): RouteOutcome => ({ ok: true }),
        (error: unknown): RouteOutcome => {
          this.#failRoomUnhealthy(room, describeStoreFailure(error));
          return { ok: true };
        },
      );
  }

  #recordCommit(runtime: RoomRuntime, sequence: number, bytes: number): void {
    runtime.accounting.lastSequence = Math.max(runtime.accounting.lastSequence, sequence);
    runtime.accounting.appendedSinceSnapshot += 1;
    runtime.accounting.bytesSinceSnapshot += bytes;
  }

  /* ---------------------------------------------------------------- *
   * Internals — hydration
   * ---------------------------------------------------------------- */

  /**
   * Create the room's runtime and start its **single-flight** hydration.
   *
   * Single-flight matters twice over (D-043 point 3): N concurrent joiners for a cold
   * document must not produce N reads of the same bytes, and — more importantly — must not
   * produce two competing `Y.Doc` replicas of one document.
   */
  #createRuntime(room: DocumentRoom): RoomRuntime {
    const accounting: CompactionAccounting = {
      lastSequence: 0,
      appendedSinceSnapshot: 0,
      bytesSinceSnapshot: 0,
    };
    const queue = new SerialTaskQueue();

    // Every room walks the same state machine, whether or not it has anything to load, so
    // `acceptsMutations` has exactly one meaning (D-049).
    room.beginHydration();

    let barrier: Promise<HydrationOutcome>;
    if (this.#hydrator === undefined) {
      // No store: nothing can be loaded, so the barrier is already released.
      room.completeHydration();
      barrier = Promise.resolve<HydrationOutcome>({ ok: true });
    } else {
      barrier = this.#runHydration(room, accounting);
    }

    return { queue, accounting, barrier };
  }

  /**
   * Load and replay, then release the barrier — or fail the room.
   *
   * **A hydration failure must never degrade to an empty document** (D-043 point 6): telling
   * a user "your document could not be read" as "your document is empty" is the worst form
   * of data loss, because the next successful append would persist that emptiness over the
   * real history.
   */
  async #runHydration(
    room: DocumentRoom,
    accounting: CompactionAccounting,
  ): Promise<HydrationOutcome> {
    const hydrator = this.#hydrator;
    if (hydrator === undefined) return { ok: true };

    try {
      const result = await hydrator.hydrate(room.documentId, room.doc);

      // The last member may have left while the load was in flight; the room is destroyed
      // and the result is discarded rather than applied to a corpse (D-049 obligation 1).
      if (room.destroyed) return { ok: false, reason: 'evicted' };

      room.completeHydration();
      accounting.lastSequence = result.sequence;
      accounting.appendedSinceSnapshot = result.appliedUpdates;
      accounting.bytesSinceSnapshot = result.logBytes;

      return { ok: true };
    } catch (error) {
      if (room.destroyed) return { ok: false, reason: 'evicted' };
      this.#failRoomUnhealthy(room, describeStoreFailure(error));
      return { ok: false, reason: 'unhealthy' };
    }
  }

  /* ---------------------------------------------------------------- *
   * Internals — failure
   * ---------------------------------------------------------------- */

  /**
   * Stop a room permanently and tell its participants (D-044, D-048).
   *
   * The seven obligations, in order:
   *
   * 1. room → `UNHEALTHY`;
   * 2. the pipeline stops and nothing further is accepted or attempted — including the
   *    updates **already queued**, which are never broadcast;
   * 3. every participant receives `INTERNAL_ERROR` and the server closes the socket;
   * 4. the in-memory room is destroyed, so memory cannot drift from durable state;
   * 5. everything already committed stays valid — the store is never rolled back;
   * 6. the author's client still holds its replica and re-sends through the ordinary
   *    state-vector handshake after reconnecting;
   * 7. the detail is logged and never sent (`docs/CONTRACTS.md` §7).
   *
   * Idempotent: a heartbeat reap racing a persist failure must not double-report or throw.
   */
  #failRoomUnhealthy(room: DocumentRoom, reason: string): void {
    if (room.destroyed || room.state === 'unhealthy') return;

    this.#logger.warn('room marked unhealthy; closing its participants', {
      documentId: room.documentId,
      reason,
    });

    room.markUnhealthy(reason);

    const runtime = this.#runtime.get(room);
    runtime?.queue.stop('unhealthy');

    for (const participant of room.participants()) {
      // Non-fatal by contract is a *client* semantic (keep reconnecting), not a server one:
      // the server still closes the socket, because it cannot serve this room any more.
      // 1011 ("internal error") names the cause honestly; 1008 would claim a policy
      // violation.
      participant.peer.sendError(
        WS_ERROR_CODES.INTERNAL_ERROR,
        'the server could not persist this document; reconnect to retry',
      );
      participant.peer.close(1011, 'INTERNAL_ERROR');
    }

    this.#evictRoom(room);
  }

  /* ---------------------------------------------------------------- *
   * Internals — membership
   * ---------------------------------------------------------------- */

  #getOrCreateRoom(documentId: string): DocumentRoom {
    const existing = this.#rooms.get(documentId);
    if (existing !== undefined) return existing;
    const room = new DocumentRoom(documentId);
    this.#rooms.set(documentId, room);
    this.#runtime.set(room, this.#createRuntime(room));
    return room;
  }

  #requireRuntime(room: DocumentRoom): RoomRuntime {
    const runtime = this.#runtime.get(room);
    if (runtime === undefined) {
      throw new Error(`no runtime for room ${room.documentId}`);
    }
    return runtime;
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
   * 4. evict the room when the last participant leaves — **eviction, not deletion**:
   *    the durable document is retained and the next join hydrates a fresh room
   *    (`docs/ARCHITECTURE.md` §7.9).
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

    // Compaction happens here, at eviction, and never on the update hot path
    // (`docs/DECISIONS.md` D-042). The snapshot is encoded *now*, synchronously, because the
    // `Y.Doc` is about to be destroyed; the durable write itself is fired off without
    // blocking eviction, so a slow disk cannot delay the next joiner's room.
    this.#compactAtEviction(room);
    this.#evictRoom(room);
  }

  /**
   * Fold the log into a snapshot if the frozen thresholds are crossed.
   *
   * Failure is logged and ignored: compaction is an optimisation, not a correctness step.
   * The log is still intact and complete, so the document remains fully recoverable — which
   * is exactly why the thresholds can be tuned without touching the contract.
   */
  #compactAtEviction(room: DocumentRoom): void {
    const store = this.#store;
    const runtime = this.#runtime.get(room);
    if (store === undefined || runtime === undefined) return;
    if (!room.acceptsMutations) return; // never snapshot a half-hydrated or failed room
    if (!compactionDue(runtime.accounting)) return;

    const documentId = room.documentId;
    const throughSequence = runtime.accounting.lastSequence;
    if (throughSequence <= 0) return;

    let snapshot: Uint8Array;
    try {
      snapshot = Y.encodeStateAsUpdate(room.doc);
    } catch (error) {
      this.#logger.warn('could not encode a snapshot at eviction; leaving the log intact', {
        documentId,
        reason: describeStoreFailure(error),
      });
      return;
    }

    // Accounting is reset optimistically: this room is being destroyed, so a second
    // compaction for it cannot happen, and a failed compaction simply leaves the log as it
    // was (still correct, only larger).
    runtime.accounting.appendedSinceSnapshot = 0;
    runtime.accounting.bytesSinceSnapshot = 0;

    void store.compact(documentId, snapshot, throughSequence).catch((error: unknown) => {
      this.#logger.warn('compaction at eviction failed; the log is unchanged and still valid', {
        documentId,
        throughSequence,
        reason: describeStoreFailure(error),
      });
    });
  }

  /** Remove a room from the registry and destroy its memory. Never touches durable state. */
  #evictRoom(room: DocumentRoom): void {
    if (this.#rooms.get(room.documentId) === room) {
      this.#rooms.delete(room.documentId);
    }
    const runtime = this.#runtime.get(room);
    if (runtime !== undefined) {
      runtime.queue.stop('evicted');
      this.#runtime.delete(room);
    }
    // Clear the membership first so a close handler racing this eviction cannot detach into
    // a destroyed room and re-enter eviction.
    for (const participant of room.participants()) {
      const context = this.#contexts.get(participant.peer);
      if (context !== undefined && context.activeRoom === room) context.activeRoom = null;
    }
    room.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * True when the log is big enough to be worth folding into a snapshot.
 *
 * Frozen thresholds from `docs/DECISIONS.md` D-042: **more than** 200 rows **or more than**
 * 1 MB, whichever is reached first — hence the strict comparisons, so "200 rows" is still
 * under the limit and the 201st triggers it.
 */
function compactionDue(accounting: CompactionAccounting): boolean {
  return (
    accounting.appendedSinceSnapshot > COMPACTION_UPDATE_THRESHOLD ||
    accounting.bytesSinceSnapshot > COMPACTION_LOG_BYTES_THRESHOLD
  );
}

/**
 * A short, log-safe description of a failure.
 *
 * Never a stack, a path or a SQL fragment, because this string can end up in a log line an
 * operator pastes into an issue — and because the same discipline keeps it from being
 * accidentally sent on the wire (`docs/CONTRACTS.md` §7).
 */
function describeStoreFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown store failure';
}
