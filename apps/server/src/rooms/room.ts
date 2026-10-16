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
  type DecodedSyncFrame,
} from '@insighthub/shared';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { Peer } from './peer.js';

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

/** Read-only introspection, used by tests and operational logging. */
export interface RoomSnapshot {
  documentId: string;
  peerCount: number;
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
      peerCount: this.#participants.size,
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
   * Sync (frozen client-initiated handshake — docs/CONTRACTS.md §10.2)
   * ---------------------------------------------------------------- */

  /**
   * Handle a decoded SYNC frame from `from`.
   *
   * The handshake is client-initiated, so the only message the server *answers* is
   * `SyncStep1` — with `SyncStep2` followed by its own `SyncStep1`, which is what
   * the contract's `SyncStep1 → SyncStep2 + SyncStep1 → SyncStep2` sequence
   * describes. `Update` is applied and relayed by `handleUpdate`. `SyncStep2` is
   * applied and answers nothing, because the server never initiates an exchange.
   */
  handleSync(decoded: DecodedSyncFrame, from: RoomParticipant): void {
    if (this.#destroyed) return;

    const messageType = readSyncMessageType(decoded);

    if (messageType === SYNC_MESSAGE_TYPES.step1) {
      const peerStateVector = readSyncStep1StateVector(decoded);
      if (peerStateVector === null) return;

      // SyncStep2 is the delta between what we hold and what the peer advertised. A
      // state vector is a few dozen bytes, so this reply is proportional to the
      // *missing* content, never to the size of the document — the property M1-A3
      // criterion 4 asks us to prove by measurement rather than by assertion.
      from.peer.sendBinary(encodeSyncStep2(this.doc, peerStateVector));
      // ...then our own state vector, so the client answers with the SyncStep2 that
      // carries what we are missing.
      from.peer.sendBinary(encodeSyncStep1(this.doc));
      return;
    }

    if (messageType === SYNC_MESSAGE_TYPES.update) {
      this.handleUpdate(decoded, from);
      return;
    }

    // SyncStep2 answers a SyncStep1 this server sent. It carries the peer's knowledge as
    // `varint(messageYjsSyncStep2)` + `varint8Array(update)`, so the **payload must be
    // unwrapped before applying it**: passing `decoded.bytes` to `Y.applyUpdate` feeds the
    // length prefix where an update header belongs, and yjs then reads a struct reference
    // in the wrong format and throws `Unexpected end of array`.
    //
    // Found by the M1-A0.2 cross-agent integration test — neither A1's nor A3's own suite
    // could see it, because each tested its half against its own dual (D-029).
    const update = readSyncStep2Payload(decoded);
    if (update === null) return;
    Y.applyUpdate(this.doc, update, TRANSACTION_ORIGINS.remote);

    // ...and relay it to the room, because a SyncStep2 can carry edits the other peers
    // have never seen. The reconnect case is the one that matters (`docs/CONTRACTS.md`
    // §10.3): a client that edited while disconnected delivers those edits in its
    // SyncStep2, and a client that was never disconnected never sends an `Update` for
    // them — so without this relay it stays permanently behind while the server and the
    // reconnecting peer are converged. Also found by the M1-A0.2 cross-agent test.
    //
    // Re-framed as a `messageYjsUpdate` (the shared codec's helper) rather than forwarding
    // the SyncStep2 envelope: a receiver applies an `Update` through its ordinary update
    // path, which is exactly the semantics a relay of already-applied content needs.
    this.broadcastBinary(encodeSyncUpdate(update), from);
  }

  /**
   * Apply a peer's incremental update and relay the identical bytes.
   *
   * The frame body is `varint(messageYjsUpdate)` + `varint8Array(update)`, so the update
   * is extracted with the shared accessor before use — the body is not itself an update
   * (`@insighthub/shared` `readSyncUpdatePayload` documents the failure mode). Relaying
   * those exact bytes (rather than the room's own state) matters: peers must merge what
   * the author wrote, not a re-encoding of it.
   */
  handleUpdate(decoded: DecodedSyncFrame, from: RoomParticipant): void {
    if (this.#destroyed) return;

    const update = readSyncUpdatePayload(decoded);
    if (update === null) return;

    Y.applyUpdate(this.doc, update, TRANSACTION_ORIGINS.remote);
    this.broadcastBinary(encodeSyncUpdate(update), from);
  }

  /**
   * Apply an update the server produced itself (not received from a peer).
   *
   * Used by tests and by any future server-side writer. Stamped with the remote
   * origin so a client's local undo tracking is never confused by server-authored
   * content.
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
   */
  handleAwareness(decoded: DecodedAwarenessFrame, from: RoomParticipant): AwarenessRejection {
    if (this.#destroyed) return null;

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

  /** Send a binary frame to everyone except `except` (`null` = everyone). */
  broadcastBinary(frame: Uint8Array, except: RoomParticipant | null): void {
    if (this.#destroyed) return;
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
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#participants.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
