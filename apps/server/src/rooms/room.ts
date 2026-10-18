/**
 * One document room: the server's `Y.Doc` for a `documentId`, plus the fan-out of
 * sync and awareness traffic to the peers in it.
 *
 * Design notes a reviewer should be able to check against the contract:
 *
 * - **The room owns exactly one `Y.Doc`.** It is a replica for relaying, not a
 *   second source of truth in the "mirrored Markdown string" sense: every mutation
 *   arrives as a Yjs update and is applied through Yjs, so there is no competing
 *   copy (`docs/ARCHITECTURE.md` §0).
 * - **Framing is never done here.** Every outbound frame comes from the shared
 *   codec (`@insighthub/shared`); every inbound one arrives already decoded and
 *   validated. This file adds no frame header, checks no length prefix and parses
 *   no outer envelope (`AGENTS.md` R12).
 * - **Awareness is never persisted.** It lives in the room's in-memory `Awareness`
 *   instance and dies with the room (`docs/CONTRACTS.md` §9).
 * - **The room never sees a file.** Durable bytes belong to `DocumentStore`, which
 *   the registry drives; the room exposes `apply` and `broadcast` as separate steps so
 *   the registry can order `apply → persist → broadcast` (`docs/ARCHITECTURE.md` §7.2,
 *   §7.7).
 *
 * ## M2: the room has an explicit lifecycle (`docs/DECISIONS.md` D-049)
 *
 * ```text
 * CREATED ──► HYDRATING ──► READY
 *    │            │            │
 *    │            └────────────┴──► UNHEALTHY ──► DESTROYED
 *    └──────────────────────────────► DESTROYED
 * ```
 *
 * The state is not documentation: every guard below reads it, so "what is allowed right
 * now" has one answer. Two transitions are deliberately impossible:
 *
 * - `UNHEALTHY → READY` — recovery is "destroy and hydrate a fresh room", never a
 *   half-healing of memory the store cannot back (`D-049`).
 * - `HYDRATING → READY` without `completeHydration()` — the barrier is the only exit.
 */
import {
  MAX_AWARENESS_CLIENTS_PER_UPDATE,
  SYNC_MESSAGE_TYPES,
  TRANSACTION_ORIGINS,
  encodeAwarenessFrame,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  readSyncMessageType,
  readSyncStep1StateVector,
  readSyncStep2Payload,
  readSyncUpdatePayload,
  type DecodedAwarenessFrame,
  type DecodedBinaryFrame,
  type DecodedSyncFrame,
} from '@insighthub/shared';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { Peer } from './peer.js';

/**
 * The frozen lifecycle states (`docs/DECISIONS.md` D-049, `docs/ARCHITECTURE.md` §7.5).
 *
 * Exported as a value tuple so a test can assert the exact set and so nothing can invent a
 * sixth state by typo.
 */
export const ROOM_STATES = ['created', 'hydrating', 'ready', 'unhealthy', 'destroyed'] as const;

export type RoomState = (typeof ROOM_STATES)[number];

/**
 * Bound on the frames a room will hold while hydrating (`docs/ARCHITECTURE.md` §7.6).
 *
 * A conforming client never sends before `room-joined`, so this queue exists only for a
 * client that races its own handshake. It is bounded because "hold everything until ready"
 * is unbounded memory controlled by a peer.
 */
export const HYDRATION_BACKLOG_MAX_FRAMES = 256;

/** Byte bound on the hydration backlog, for frames far larger than the frame ceiling. */
export const HYDRATION_BACKLOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Log tag for a backlog overflow.
 *
 * **Not a wire error code** (`docs/DECISIONS.md` D-050, `docs/CONTRACTS.md` §14.9). The
 * wire answer is `INTERNAL_ERROR`, because a cumulative backlog overflow is a server-side
 * lifecycle condition, not an oversized frame. Reporting `FRAME_TOO_LARGE` would tell a
 * client "your frame was too big" and send it off shrinking frames while the real problem
 * is that the server has not finished hydrating.
 */
export const HYDRATION_BACKLOG_OVERFLOW_TAG = 'HYDRATION_BACKLOG_OVERFLOW';

/**
 * What `DocumentRoom` needs from its owner.
 *
 * The room does not know what a `Peer` is beyond this: fan-out is "send to every
 * participant", and a participant that has gone away is skipped.
 */
export interface RoomParticipant {
  readonly peer: Peer;
  /** Awareness ids this participant has spoken for; see `SocketContext`. */
  readonly awarenessClients: Set<number>;
}

/** One frame held while the room is hydrating, with the participant it came from. */
export interface BacklogEntry {
  readonly participant: RoomParticipant;
  readonly frame: DecodedBinaryFrame;
}

/** Read-only introspection, used by tests and operational logging. */
export interface RoomSnapshot {
  documentId: string;
  /** Current lifecycle state (`docs/DECISIONS.md` D-049). */
  state: RoomState;
  peerCount: number;
  /** Frames currently held by the hydration backlog. */
  hydrationBacklogFrames: number;
  /** Awareness entries the server currently holds for this room. */
  awarenessClientIds: number[];
  awarenessEntryCount: number;
  /** UTF-16 length of the room's `Y.Text`, for the incremental-sync assertion. */
  textLength: number;
}

/**
 * Why an awareness frame was not relayed.
 *
 * Rejections are returned rather than thrown: awareness is untrusted input from
 * peers, and one abusive client must not be able to take a room down.
 */
export type AwarenessRejection = 'too-many-clients' | null;

/** Outcome of offering a frame to the hydration backlog. */
export type BacklogOffer = 'queued' | 'overflow';

/**
 * Turn a room's `Awareness` into a relay-only store: no identity, no local entry.
 *
 * See `DocumentRoom.awareness` for why each step is required. The interval handle is
 * private to `y-protocols`, so it is read through a narrow structural view.
 */
function suppressServerAwarenessOwnership(awareness: awarenessProtocol.Awareness): void {
  // (1) Clear the phantom entry and identity the constructor installed, then stop the
  //     heartbeat that would republish it.
  //
  //     `y-protocols`' constructor does two things before we get control: it assigns
  //     `clientID = doc.clientID` (a random id) and calls `setLocalState({})`. That
  //     leaves the room holding a participant with an empty `{}` state — not valid
  //     presence, since it has no `user`, so peers would count a collaborator they
  //     cannot render. Both maps are cleared here and the id is cleared last, so nothing
  //     survives for the id that was just assigned.
  awareness.states.clear();
  awareness.meta.clear();
  (awareness as unknown as { clientID: number | null }).clientID = null;

  const timerView = awareness as unknown as { _checkInterval?: unknown };
  if (timerView._checkInterval !== undefined && timerView._checkInterval !== null) {
    clearInterval(timerView._checkInterval as NodeJS.Timeout);
    // Left as a consistent property value so a later `awareness.destroy()` still works.
    timerView._checkInterval = null;
  }

  // (2) `getLocalState()` now returns `null` and stays that way, so the server can never
  //     publish presence about itself and never claims an id a peer might also use.
}

export class DocumentRoom {
  readonly documentId: string;
  readonly doc: Y.Doc;
  /**
   * Awareness for this room only.
   *
   * The server is a **pure relay** for presence: it stores what peers publish and
   * forwards it, and it must never appear as a participant itself.
   *
   * Both guards below exist for that reason, and both are needed:
   *
   * 1. `clientID` is cleared, so the server claims no identity.
   * 2. `y-protocols`' `Awareness` constructor installs a heartbeat that re-publishes
   *    `localState` every 3 s. With `localState` initialised to `{}`, that heartbeat
   *    would insert an entry for the server — and an entry of `{}` is not valid
   *    presence: it has no `user`, so peers would render a participant with no name,
   *    and `session.getCollaborators()` would filter it out, leaving a presence count
   *    that never matches the rendered list. Removing the interval makes the server's
   *    awareness store contain peer entries only. The server does not need the ageing
   *    behaviour that interval provides either: it forwards every update it receives
   *    and removes a peer's entries the moment that peer leaves, so no state here can
   *    go stale on its own.
   *
   * `destroy()` below is still mandatory: it tears the instance down and releases the
   * document.
   */
  readonly awareness: awarenessProtocol.Awareness;

  readonly #participants = new Set<RoomParticipant>();
  readonly #backlog: BacklogEntry[] = [];
  #backlogBytes = 0;
  #state: RoomState = 'created';
  #unhealthyReason: string | null = null;
  #destroyed = false;
  #awarenessRejections = 0;

  constructor(documentId: string) {
    this.documentId = documentId;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    suppressServerAwarenessOwnership(this.awareness);
  }

  get peerCount(): number {
    return this.#participants.size;
  }

  get isEmpty(): boolean {
    return this.#participants.size === 0;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Current lifecycle state (`docs/DECISIONS.md` D-049). */
  get state(): RoomState {
    return this.#state;
  }

  /** Why the room became unhealthy, for the server log only (never sent to a client). */
  get unhealthyReason(): string | null {
    return this.#unhealthyReason;
  }

  /**
   * True only in `READY`.
   *
   * The single predicate the registry consults before accepting a durable mutation, so
   * "may this room take an update" is answered in one place.
   */
  get acceptsMutations(): boolean {
    return this.#state === 'ready' && !this.#destroyed;
  }

  /** Frames currently held by the hydration backlog. */
  get backlogFrames(): number {
    return this.#backlog.length;
  }

  /** Bytes currently held by the hydration backlog. */
  get backlogBytes(): number {
    return this.#backlogBytes;
  }

  /** How many awareness frames this room has dropped for exceeding the limit. */
  get awarenessRejections(): number {
    return this.#awarenessRejections;
  }

  participants(): readonly RoomParticipant[] {
    return [...this.#participants];
  }

  snapshot(): RoomSnapshot {
    const text = this.doc.getText('content');
    return {
      documentId: this.documentId,
      state: this.#state,
      peerCount: this.#participants.size,
      hydrationBacklogFrames: this.#backlog.length,
      awarenessClientIds: [...this.awareness.getStates().keys()].sort((a, b) => a - b),
      awarenessEntryCount: this.awareness.getStates().size,
      textLength: text.length,
    };
  }

  add(participant: RoomParticipant): void {
    this.#participants.add(participant);
  }

  remove(participant: RoomParticipant): void {
    this.#participants.delete(participant);
  }

  has(participant: RoomParticipant): boolean {
    return this.#participants.has(participant);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle (`docs/DECISIONS.md` D-049)
   * ---------------------------------------------------------------- */

  /**
   * Enter `HYDRATING`.
   *
   * Only `CREATED → HYDRATING` is legal; anything else is a programming error in the
   * registry, so it throws rather than silently corrupting the state machine.
   */
  beginHydration(): void {
    if (this.#state !== 'created') {
      throw new Error(`cannot begin hydration from state ${this.#state}`);
    }
    this.#state = 'hydrating';
  }

  /**
   * Enter `READY`, which is the **only** moment `room-joined` may be sent and the backlog
   * may be flushed (`docs/ARCHITECTURE.md` §7.5).
   */
  completeHydration(): void {
    if (this.#state !== 'hydrating') {
      throw new Error(`cannot complete hydration from state ${this.#state}`);
    }
    this.#state = 'ready';
  }

  /**
   * Enter `UNHEALTHY` and stay there (`docs/DECISIONS.md` D-049).
   *
   * Deliberately one-way: there is no method that moves a room back to `READY`. Recovery is
   * destroying the room and hydrating a fresh one, so memory can never be half-healed into
   * a state the durable store does not have.
   *
   * Idempotent: a second failure (for example a heartbeat reap racing a persist failure)
   * must not overwrite the first reason or throw.
   */
  markUnhealthy(reason: string): void {
    if (this.#state === 'unhealthy' || this.#destroyed) return;
    this.#state = 'unhealthy';
    this.#unhealthyReason = reason;
    // The backlog is dropped rather than replayed: replaying it would publish updates this
    // room can no longer make durable, which is the failure mode D-048 point 4 forbids.
    this.#backlog.length = 0;
    this.#backlogBytes = 0;
  }

  /* ---------------------------------------------------------------- *
   * Hydration backlog (`docs/ARCHITECTURE.md` §7.6)
   * ---------------------------------------------------------------- */

  /**
   * Hold a frame until the hydration barrier releases.
   *
   * Returns `'overflow'` when either bound would be exceeded. The caller turns that into
   * `UNHEALTHY` + `INTERNAL_ERROR` (`docs/DECISIONS.md` D-050); nothing is silently dropped.
   */
  enqueueBacklog(participant: RoomParticipant, frame: DecodedBinaryFrame): BacklogOffer {
    const frameBytes = frame.bytes.byteLength;

    if (
      this.#backlog.length + 1 > HYDRATION_BACKLOG_MAX_FRAMES ||
      this.#backlogBytes + frameBytes > HYDRATION_BACKLOG_MAX_BYTES
    ) {
      return 'overflow';
    }

    this.#backlog.push({ participant, frame });
    this.#backlogBytes += frameBytes;
    return 'queued';
  }

  /**
   * Take the backlog and clear it, in arrival order.
   *
   * The caller re-validates each entry's participant before replaying it: a socket can
   * disconnect during hydration, and replaying a frame for a departed peer would both
   * persist something no one asked for and relay it to a dead socket.
   */
  drainBacklog(): BacklogEntry[] {
    const drained = [...this.#backlog];
    this.#backlog.length = 0;
    this.#backlogBytes = 0;
    return drained;
  }

  /* ---------------------------------------------------------------- *
   * Sync (frozen client-initiated handshake — docs/CONTRACTS.md §10.2)
   * ---------------------------------------------------------------- */

  /**
   * Answer a `SyncStep1` with `SyncStep2` + the server's own `SyncStep1`.
   *
   * Read-only, so it needs no persistence and no pipeline slot: it appends nothing to the
   * document. Returns `false` when the frame is not a `SyncStep1`, so the registry can fall
   * through to the mutation path.
   *
   * Only legal in `READY`: answering from a half-hydrated document would hand a client a
   * delta computed against state the server is about to replace.
   */
  replyToSyncStep1(decoded: DecodedSyncFrame, from: RoomParticipant): boolean {
    if (!this.acceptsMutations) return false;
    if (readSyncMessageType(decoded) !== SYNC_MESSAGE_TYPES.step1) return false;

    const peerStateVector = readSyncStep1StateVector(decoded);
    if (peerStateVector === null) return true;

    // SyncStep2 is the delta between what we hold and what the peer advertised. A state
    // vector is a few dozen bytes, so this reply is proportional to the *missing* content,
    // never to the size of the document — the property M1-A3 criterion 4 proves by
    // measurement, and which M2 must not regress: hydration must not turn a reconnect into
    // a full-document transfer.
    from.peer.sendBinary(encodeSyncStep2(this.doc, peerStateVector));
    // ...then our own state vector, so the client answers with the SyncStep2 that carries
    // what we are missing.
    from.peer.sendBinary(encodeSyncStep1(this.doc));
    return true;
  }

  /**
   * Extract and **apply** the document update carried by a `SyncStep2` or `Update` frame.
   *
   * This is phase 1 of `apply → persist → broadcast` and nothing else: it does not broadcast
   * and it does not persist. The registry owns the other two phases, because it is the only
   * layer that knows both the room and the store (`docs/ARCHITECTURE.md` §7.2).
   *
   * Returns the raw update (what `Y.applyUpdate` consumed, and what must be persisted and
   * relayed), or `null` when the frame carries no usable update or the room is not `READY`.
   *
   * The unwrapping is not optional: `writeSyncStep2`/`writeUpdate` encode
   * `varUint(type)` + `varint8Array(update)`, so the body is *not* the update. Passing the
   * body to `Y.applyUpdate` feeds a length prefix where an update header belongs and yjs
   * throws `Unexpected end of array` (found by the M1-A0.2 cross-agent test).
   */
  applySyncPayload(decoded: DecodedSyncFrame): Uint8Array | null {
    if (!this.acceptsMutations) return null;

    const update = readSyncStep2Payload(decoded) ?? readSyncUpdatePayload(decoded);
    if (update === null || update.byteLength === 0) return null;

    Y.applyUpdate(this.doc, update, TRANSACTION_ORIGINS.remote);
    return update;
  }

  /**
   * Phase 3: relay an already-applied, already-persisted update to the room.
   *
   * Relays the author's **original bytes** rather than a re-encoding: peers must merge what
   * the author wrote. `except` is the author, who already has it.
   */
  broadcastUpdate(update: Uint8Array, except: RoomParticipant | null): void {
    if (!this.acceptsMutations) return;
    this.broadcastBinary(encodeSyncUpdate(update), except);
  }

  /**
   * Apply an update the server produced itself (not received from a peer).
   *
   * **Not durable.** Tests use this to model causally-ordered updates arriving out of order
   * without paying for a socket round trip; it exists so a test can drive the room's CRDT
   * directly. Production writes go through the registry's pipeline so they are persisted
   * before they are broadcast — this method would bypass that, which is why nothing in
   * production calls it.
   *
   * Stamped with the remote origin so a client's local undo tracking is never confused by
   * server-authored content.
   */
  applyServerUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, TRANSACTION_ORIGINS.remote);
  }

  /* ---------------------------------------------------------------- *
   * Awareness (docs/CONTRACTS.md §9)
   * ---------------------------------------------------------------- */

  /**
   * Apply and relay an awareness update from `from`.
   *
   * Returns the rejection reason, or `null` when the frame was accepted. The
   * `MAX_AWARENESS_CLIENTS_PER_UPDATE` check runs **before**
   * `applyAwarenessUpdate`, so an over-broad update is dropped whole: applying it
   * and then failing to relay it would leave the server holding presence state no
   * peer can see, which is exactly the two-views-of-presence problem awareness is
   * meant to avoid (`docs/DECISIONS.md` D-021).
   *
   * Awareness is **not** persisted and therefore does not enter the mutation pipeline
   * (`docs/ARCHITECTURE.md` §7.12): it is ephemeral presence, and a durable presence
   * channel is precisely what D-021 deleted.
   */
  handleAwareness(decoded: DecodedAwarenessFrame, from: RoomParticipant): AwarenessRejection {
    if (this.#destroyed || this.#state === 'unhealthy') return null;

    const clients = decoded.clients;
    if (clients.length > MAX_AWARENESS_CLIENTS_PER_UPDATE) {
      this.#awarenessRejections += 1;
      return 'too-many-clients';
    }

    awarenessProtocol.applyAwarenessUpdate(this.awareness, decoded.bytes, from.peer.connectionId);

    // Remember who spoke for these ids so a later disconnect can remove them by id.
    for (const clientId of clients) {
      from.awarenessClients.add(clientId);
    }

    // Relay the sender's original bytes: re-encoding could stamp a different clock
    // than the sender's, and awareness uses the clock to order concurrent updates.
    this.broadcastBinary(encodeAwarenessFrame(decoded.bytes), from);
    return null;
  }

  /**
   * Bring a newly joined peer up to date on awareness already in the room.
   *
   * Relaying only *new* frames means a client that joins second never learns about
   * collaborators who announced before it arrived — presence would appear only when
   * someone happened to publish again (or after `y-protocols`' 30 s renewal). Found by
   * the M1-A0.2 cross-agent test: two real sessions could edit the same document while
   * `getCollaborators()` reported nobody.
   *
   * The entries are re-encoded (not a cached frame) so the peer receives the clocks the
   * server actually holds. `encodeAwarenessUpdate` throws on a client id with no `meta`
   * entry, so only ids present in `meta` are included — after `removeAwareness` the meta
   * record survives deliberately (see `clearRemoteStates` in A1), which is why this
   * guard is needed rather than assuming `states` and `meta` agree.
   *
   * Sends nothing when the room holds no awareness, so a first joiner costs no frame.
   */
  sendExistingAwarenessTo(recipient: RoomParticipant): void {
    if (this.#destroyed) return;

    const held = this.awareness.getStates();
    if (held.size === 0) return;

    const encodable = [...held.keys()].filter((clientId) => this.awareness.meta.has(clientId));
    if (encodable.length === 0) return;

    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, encodable);
    this.sendTo(recipient, encodeAwarenessFrame(update));
  }

  /**
   * Remove a participant's awareness entries and tell the remaining peers.
   *
   * This is the mechanism behind "no ghost cursors" (`docs/CONTRACTS.md` §9.1). It
   * runs on disconnect, on explicit `leave-room`, and as the first half of an
   * atomic room replace. Only entries the server actually holds are removed, so a
   * peer that never published awareness causes no spurious removal broadcast.
   */
  removeAwareness(clientIds: Iterable<number>): number[] {
    const held = this.awareness.getStates();
    const present: number[] = [];
    for (const clientId of clientIds) {
      if (held.has(clientId)) present.push(clientId);
    }
    if (present.length === 0) return [];

    // Deletes the state and bumps the clock, so the removal outranks any in-flight
    // update for the same client instead of being overwritten by it.
    awarenessProtocol.removeAwarenessStates(this.awareness, present, 'insighthub:server');

    const removal = awarenessProtocol.encodeAwarenessUpdate(this.awareness, present);
    this.broadcastBinary(encodeAwarenessFrame(removal), null);
    return present;
  }

  /* ---------------------------------------------------------------- *
   * Fan-out and teardown
   * ---------------------------------------------------------------- */

  /**
   * Send a binary frame to everyone except `except` (`null` = everyone).
   *
   * Refused in `UNHEALTHY`: a room that cannot make its state durable must not publish it
   * (`docs/DECISIONS.md` D-044, D-048 point 4).
   */
  broadcastBinary(frame: Uint8Array, except: RoomParticipant | null): void {
    if (this.#destroyed || this.#state === 'unhealthy') return;
    // Iterate a copy: a refused write can synchronously trigger the peer's close
    // handler, which calls back into `remove` and would otherwise mutate the set
    // mid-iteration.
    for (const participant of [...this.#participants]) {
      if (participant === except) continue;
      participant.peer.sendBinary(frame);
    }
  }

  /** Send a binary frame to exactly one participant. */
  sendTo(participant: RoomParticipant, frame: Uint8Array): void {
    if (this.#destroyed) return;
    participant.peer.sendBinary(frame);
  }

  /**
   * Release the room's resources.
   *
   * `Awareness.destroy()` clears the 3 s liveness timer its constructor installs: a
   * server that forgets this never exits, and a room that forgets it leaks a timer
   * per document ever opened.
   *
   * Destroying is **not** deleting: the durable state is untouched and the next join
   * hydrates a fresh room (`docs/ARCHITECTURE.md` §7.9).
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#state = 'destroyed';
    this.#backlog.length = 0;
    this.#backlogBytes = 0;
    this.#participants.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
