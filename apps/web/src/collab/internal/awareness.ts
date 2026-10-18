import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';

import {
  awarenessStateSchema,
  collectValidAwarenessStates,
  type AwarenessState,
  type CollaboratorInfo,
  type PresencePatch,
} from '@insighthub/shared';

import { REMOTE_ORIGIN } from './origins.js';

/**
 * Awareness — the **single** source of truth for ephemeral presence
 * (`docs/CONTRACTS.md` §9, `docs/DECISIONS.md` D-021).
 *
 * Rules this module enforces, and why they are not negotiable:
 *
 * 1. **Never persisted.** Nothing here touches IndexedDB or Redux. On teardown the
 *    entry is removed; it is never written down.
 * 2. **Never document content.** Only identity, cursor and selection travel, and
 *    they never enter `Y.Text`.
 * 3. **Validated read path (§9.2, R14).** `getCollaborators()` runs
 *    `collectValidAwarenessStates` over the raw wire map, so a peer cannot inject a
 *    nameless user, a negative offset or a `from > to` selection into other people's
 *    UI. The raw `Awareness` is exposed only as an editor-binding input.
 * 4. **Bounded fan-out.** Outgoing updates are coalesced on a short timer and each
 *    flush mentions at most `MAX_AWARENESS_CLIENTS_PER_UPDATE` clients.
 * 5. **No leaked timer.** `y-protocols`' `Awareness` installs a 3 s interval;
 *    `dispose()` clears it, otherwise a test process would never exit (D-015).
 */

/** How long local awareness changes are coalesced before one broadcast. */
export const AWARENESS_FLUSH_DELAY_MS = 50;

const MAX_CLIENTS_PER_UPDATE = 512;

/** The presence surface the session and the editor binding use. */
export interface CollaborationAwareness {
  /** Raw instance for a Yjs/CodeMirror binding ONLY — never UI state (R14). */
  readonly raw: Awareness;
  readonly clientID: number;
  /** Remote participants, schema-validated. Never includes the local client. */
  getCollaborators(): readonly CollaboratorInfo[];
  /** The local entry exactly as this client published it (or `null`). */
  getLocalState(): AwarenessState | null;
  /**
   * Publish presence fields in **one** local-state write (M2-P0-2).
   *
   * `updatedAt` is stamped here — the collaboration layer owns it. The patch must
   * already be validated; `DocumentSession.publishPresence` runs
   * `parsePresencePatch` before calling this.
   */
  publishPresence(patch: PresencePatch): void;
  /** Update one field of the local entry (cursor/selection/identity). */
  setLocalStateField(field: 'cursor' | 'selection' | 'user', value: unknown): void;
  /** Apply an inbound awareness payload from the wire. */
  applyRemoteUpdate(bytes: Uint8Array): void;
  /** Forget every remote entry (room change / socket close). */
  clearRemoteStates(): void;
  /** Remove the local entry; the removal is broadcast through the sink. */
  removeLocalState(): void;
  /** Stop timers and intervals. Does not broadcast. */
  dispose(): void;
}

export interface AwarenessManagerOptions {
  awareness: Awareness;
  /** Local identity published on the awareness channel. */
  localState: AwarenessState;
  /** Send an encoded AWARENESS frame; returns false when it could not be sent. */
  send(bytes: Uint8Array): boolean;
  /** Called when the collaborator set may have changed. */
  onChange(): void;
  /** Broadcast pacing (tests shrink it). */
  flushDelayMs?: number;
  /**
   * Publish the local entry inside the constructor (default `true`).
   *
   * Set to `false` when the session that owns this manager is still being
   * constructed: the constructor's `setLocalState` emits `change`, and a callback
   * that touches the not-yet-assigned session would fail.
   */
  publishImmediately?: boolean;
}

export class AwarenessManager implements CollaborationAwareness {
  readonly raw: Awareness;

  private readonly localState: AwarenessState;

  private readonly send: (bytes: Uint8Array) => boolean;

  private readonly onChange: () => void;

  private readonly flushDelayMs: number;

  /** Client ids whose latest state still has to be broadcast — this client's included. */
  private readonly pending = new Set<number>();

  /** Highest clock this client published as a *removal*, so an announcement can beat it. */
  private lastRemovalClock = 0;

  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  private disposed = false;

  constructor(options: AwarenessManagerOptions) {
    this.raw = options.awareness;
    this.localState = options.localState;
    this.send = options.send;
    this.onChange = options.onChange;
    this.flushDelayMs = options.flushDelayMs ?? AWARENESS_FLUSH_DELAY_MS;

    // `change` is emitted only when something actually changed (or the local entry
    // was removed), so it is the right trigger for reader notification; `update`
    // fires on every clock tick and is the trigger for wire traffic.
    this.raw.on('change', this.handleChange);
    this.raw.on('update', this.handleUpdate);
    if (options.publishImmediately !== false) this.raw.setLocalState(this.localState);
  }

  /**
   * Publish the local entry.
   *
   * Deferred construction calls this once the owning session exists; it is
   * idempotent, so an already-published entry is simply re-announced.
   */
  publishLocalState(): void {
    if (this.disposed) return;
    this.raw.setLocalState(this.localState);
  }

  get clientID(): number {
    return this.raw.clientID;
  }

  getCollaborators(): readonly CollaboratorInfo[] {
    const valid = collectValidAwarenessStates(this.raw.getStates());
    const collaborators: CollaboratorInfo[] = [];
    for (const [clientId, state] of valid) {
      if (clientId === this.raw.clientID) continue;
      collaborators.push({
        clientId,
        user: state.user,
        cursor: state.cursor,
        selection: state.selection,
      });
    }
    collaborators.sort((left, right) => left.clientId - right.clientId);
    return collaborators;
  }

  getLocalState(): AwarenessState | null {
    const parsed = awarenessStateSchema.safeParse(this.raw.getLocalState());
    return parsed.success ? parsed.data : null;
  }

  setLocalStateField(field: 'cursor' | 'selection' | 'user', value: unknown): void {
    if (this.disposed) return;
    const current = this.raw.getLocalState();
    if (current === null) return;
    this.raw.setLocalState({ ...current, [field]: value });
  }

  /**
   * Publish presence in one write.
   *
   * Why this is not just three `setLocalStateField` calls (what the editor used to do):
   *
   * 1. **One awareness update, not three.** `setLocalState` bumps the awareness clock
   *    and emits `update` every time, and the sync provider turns each emit into a
   *    frame. Publishing cursor, selection and `updatedAt` separately cost three
   *    frames per caret move.
   * 2. **`updatedAt` is owned here.** The caller cannot forget it, cannot supply it,
   *    and cannot leave it stale.
   * 3. **The merged state is validated before the write.** The patch is already
   *    validated by `parsePresencePatch`, but the merge base comes from the live
   *    awareness entry, which the raw instance can still reach. Refusing to publish a
   *    state the read side would reject keeps "what this client publishes" inside the
   *    contract even in a migration window where a caller still writes the raw object.
   */
  publishPresence(patch: PresencePatch): void {
    if (this.disposed) return;
    const current = this.raw.getLocalState();
    if (current === null) return;

    const next: Record<string, unknown> = { ...current };
    // `undefined` means "leave unchanged"; `null` means "clear". Spread only the keys
    // the caller actually named, so a cursor-only patch cannot clear the selection.
    if (patch.cursor !== undefined) next.cursor = patch.cursor;
    if (patch.selection !== undefined) next.selection = patch.selection;
    // The collaboration layer owns this field, unconditionally.
    next.updatedAt = Date.now();

    const parsed = awarenessStateSchema.safeParse(next);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<state>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`refusing to publish an invalid local presence state: ${detail}`);
    }
    this.raw.setLocalState(parsed.data);
  }

  applyRemoteUpdate(bytes: Uint8Array): void {
    if (this.disposed) return;
    // `remote` origin keeps this out of the undo-tracked set (R13) and tells the
    // change handler that these entries came from a peer.
    applyAwarenessUpdate(this.raw, bytes, REMOTE_ORIGIN);
  }

  /**
   * Forget every remote entry.
   *
   * Awareness is room-scoped, so entries learned from a previous room must not
   * survive into the next one. Each departure is published with a **bumped clock**,
   * which is what lets a peer that left and comes back be believed again: see
   * `removeLocalState`.
   *
   * `meta` is deliberately left untouched — it is the record of the last clock seen
   * for each client, and `y-protocols` never deletes it. Dropping it would make a
   * later `applyAwarenessUpdate` from that client be ignored as stale, and would make
   * `encodeAwarenessUpdate` throw on a missing meta entry.
   */
  clearRemoteStates(): void {
    if (this.disposed) return;
    const remote: number[] = [];
    for (const clientId of this.raw.getStates().keys()) {
      if (clientId !== this.raw.clientID) remote.push(clientId);
    }
    if (remote.length > 0) removeAwarenessStates(this.raw, remote, REMOTE_ORIGIN);
  }

  /**
   * Remove the local entry and publish the removal — a departure, not a blip.
   *
   * The clock has to be bumped here rather than left to `setLocalState(null)`. With
   * an unbumped clock the removal would be encoded at exactly the clock peers already
   * hold for this client, and `applyAwarenessUpdate` ignores an update whose clock is
   * not strictly greater — so the removal would be silently dropped and every peer
   * would keep a ghost cursor for a client that is gone (§9.1).
   */
  removeLocalState(): void {
    if (this.disposed) return;
    if (this.raw.getLocalState() === null) return;
    const clock = this.bumpLocalClock();
    this.raw.states.delete(this.raw.clientID);
    this.pending.delete(this.raw.clientID);
    this.lastRemovalClock = clock;
    // Send the removal directly rather than through the coalescing timer: the socket
    // is about to close and peers must not keep a ghost cursor. `states` is passed
    // explicitly because the entry is already deleted: without it `encodeAwarenessUpdate`
    // would read `states.get(clientID) || null` and produce the same removal, but the
    // library's parameter type does not model `null`.
    const removalStates = new Map<number, { [key: string]: unknown }>();
    this.send(
      encodeAwarenessUpdate(
        this.raw,
        [this.raw.clientID],
        removalStates as unknown as Parameters<typeof encodeAwarenessUpdate>[2],
      ),
    );
  }

  /**
   * Publish the local entry as fresh presence.
   *
   * Used on every successful join, not only on a change. It must bump the clock for
   * two reasons:
   *
   * 1. A reconnect is a new socket. Peers that were already in the room dropped this
   *    client when its previous socket closed, so the entry has to be re-established
   *    — and the room's socket that promised `outdatedTimeout` cleanup is not
   *    guaranteed to have removed it.
   * 2. `removeLocalState` (`destroy()`) published a *higher* clock for this client. A
   *    later announcement at the old clock would be ignored as stale, so a session
   *    that was destroyed and recreated for the same document could never become
   *    visible again.
   *
   * `updatedAt` is refreshed with it, because peers expire an entry that has made no
   * progress after `outdatedTimeout`; fresh presence is exactly what this is.
   */
  announceLocalState(): void {
    if (this.disposed) return;
    const state = this.raw.getLocalState();
    if (state === null) return;

    const clock = this.bumpLocalClock();
    if (clock <= this.lastRemovalClock) {
      // Guard against a removal that raced this announcement: never publish an entry
      // that a peer would be entitled to discard as older than the departure.
      this.raw.meta.set(this.raw.clientID, {
        clock: this.lastRemovalClock + 1,
        lastUpdated: Date.now(),
      });
    }
    this.pending.delete(this.raw.clientID);
    this.send(encodeAwarenessUpdate(this.raw, [this.raw.clientID]));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pending.clear();
    this.raw.off('change', this.handleChange);
    this.raw.off('update', this.handleUpdate);
    // Frees the y-protocols check interval and the entry it holds.
    this.raw.destroy();
  }

  /**
   * Advance this client's own awareness clock and refresh its liveness stamp.
   *
   * Mirrors what `setLocalState` and `removeAwarenessStates` do internally (`clock + 1`,
   * `lastUpdated = now`), which is required for a removal and a re-announcement to be
   * accepted rather than discarded as stale.
   */
  private bumpLocalClock(): number {
    const clientId = this.raw.clientID;
    const previous = this.raw.meta.get(clientId);
    const clock = (previous === undefined ? 0 : previous.clock) + 1;
    this.raw.meta.set(clientId, { clock, lastUpdated: Date.now() });
    return clock;
  }

  private readonly handleChange = (): void => {
    if (this.disposed) return;
    this.onChange();
  };

  private readonly handleUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (this.disposed) return;
    // Echo suppression only: an update that arrived from the wire is never sent
    // back to the peer it came from.
    if (origin === REMOTE_ORIGIN) return;
    for (const clientId of changes.added) this.pending.add(clientId);
    for (const clientId of changes.updated) this.pending.add(clientId);
    for (const clientId of changes.removed) this.pending.add(clientId);
    if (this.pending.size === 0) return;
    this.scheduleFlush();
  };

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushDelayMs);
    // Never hold a Node test process open just for presence (D-015).
    if (typeof this.flushTimer === 'object' && this.flushTimer !== null) {
      const handle = this.flushTimer as { unref?: () => void };
      handle.unref?.();
    }
  }

  private flush(): void {
    if (this.disposed) return;
    if (this.pending.size === 0) return;
    const clients: number[] = [];
    for (const clientId of this.pending) {
      clients.push(clientId);
      if (clients.length >= MAX_CLIENTS_PER_UPDATE) break;
    }
    this.pending.clear();
    if (clients.length === 0) return;
    this.send(encodeAwarenessUpdate(this.raw, clients));
  }
}
