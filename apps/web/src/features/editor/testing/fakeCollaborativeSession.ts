/**
 * An in-memory `CollaborativeSession` test double.
 *
 * ## Why this exists
 *
 * M1-A1 owns the real implementation behind `apps/web/src/collab/public.ts`.
 * M1-A2 must not wait for it (`docs/TASKS.md` M1-A2 "Dependencies"), so this
 * double implements the **frozen** `CollaborativeSession` interface — nothing
 * more and nothing less — and the UI is developed and tested against it. When A1
 * lands, the only change is which factory feeds the editor.
 *
 * It is deliberately typed as `CollaborativeSession`, so if the interface and
 * this file ever disagree the typecheck fails rather than the integration
 * silently doing something else.
 *
 * ## What it does NOT fake cheaply
 *
 * It uses a **real** `Y.Doc`, real `Y.Text`, real `Y.UndoManager` and a real
 * awareness event contract, because the interesting A2 behaviour (echo
 * suppression, delta translation, undo scoping) depends on real CRDT semantics.
 * A hand-rolled stub that returns strings would test nothing.
 *
 * ## Not production code
 *
 * It performs no persistence and no networking, which is exactly the part A2 does
 * not own. It must never be imported by application code; only tests and the
 * optional development fallback do.
 */
import * as Y from 'yjs';

import {
  DOCUMENT_TEXT_KEY,
  TRANSACTION_ORIGINS,
  awarenessStateSchema,
  parsePresencePatch,
  type AwarenessState,
  type CollaborativeSession,
  type CollaborativeSessionOptions,
  type CollaboratorInfo,
  type ConnectionStatus,
  type PresencePatch,
  type SessionState,
  type TransactionOrigin,
  type UndoState,
} from '@insighthub/shared';

/**
 * Minimal awareness implementation with the same event contract as
 * `y-protocols`' `Awareness` (`on`/`off` with `'change'` and `'update'`), so the
 * cursor extension can be exercised without a socket.
 */
class FakeAwareness {
  private readonly states = new Map<number, unknown>();
  private readonly handlers = new Map<string, Set<(...args: never[]) => void>>();
  private localState: unknown = null;

  constructor(readonly clientID: number) {}

  getStates(): ReadonlyMap<number, unknown> {
    return this.states;
  }

  getLocalState(): unknown {
    return this.localState;
  }

  setLocalState(state: unknown): void {
    this.localState = state;
    this.states.set(this.clientID, state);
    this.emit();
  }

  setLocalStateField(field: string, value: unknown): void {
    const base =
      typeof this.localState === 'object' && this.localState !== null
        ? (this.localState as Record<string, unknown>)
        : {};
    this.localState = { ...base, [field]: value };
    this.states.set(this.clientID, this.localState);
    this.emit();
  }

  /** Test helper: pretend a peer published this state. */
  setRemoteState(clientId: number, state: unknown): void {
    this.states.set(clientId, state);
    this.emit('update');
  }

  removeRemoteState(clientId: number): void {
    this.states.delete(clientId);
    this.emit('update');
  }

  on(eventName: string, eventHandler: (...args: never[]) => void): void {
    const set = this.handlers.get(eventName) ?? new Set();
    set.add(eventHandler);
    this.handlers.set(eventName, set);
  }

  off(eventName: string, eventHandler: (...args: never[]) => void): void {
    this.handlers.get(eventName)?.delete(eventHandler);
  }

  emit(eventName = 'change'): void {
    for (const handler of this.handlers.get(eventName) ?? []) {
      (handler as () => void)();
    }
    for (const handler of this.handlers.get('change') ?? []) {
      (handler as () => void)();
    }
  }
}

export interface FakeCollaborativeSessionOptions extends CollaborativeSessionOptions {
  /** Seeds `Y.Text`. Defaults to a small Markdown body. */
  initialText?: string;
  /** Published through awareness at creation, like a real session would. */
  publishLocalState?: boolean;
  /** Overrides the ignored origin used for simulated remote updates. */
  remoteOrigin?: TransactionOrigin;
}

export const DEFAULT_FAKE_DOCUMENT = `# InsightHub

协作编辑演示文档。

- 绑定：CodeMirror ⇄ Y.Text
`;

export class FakeCollaborativeSession implements CollaborativeSession {
  readonly documentId: string;
  readonly text: Y.Text;
  readonly doc: Y.Doc;
  /**
   * Structurally compatible with `y-protocols`' `Awareness` for everything the
   * editor binding uses (`clientID`, `getStates`, `on`, `off`, `setLocalState*`).
   * The cast is confined to this declaration: the double is test-only, and the
   * alternative — pulling in a real `Awareness` — would require a `Y.Doc` plus a
   * heartbeat interval that only exists to be torn down in tests.
   */
  readonly awareness: CollaborativeSession['awareness'];
  private readonly fakeAwareness: FakeAwareness;

  private readonly undoManager: Y.UndoManager;
  private readonly listeners = new Set<() => void>();
  private readonly user: CollaborativeSessionOptions['user'];
  private readonly remoteOrigin: TransactionOrigin;

  private sessionState: SessionState = 'active';
  private transport: ConnectionStatus = 'offline';
  /** Invalidated on every awareness mutation; see `getCollaborators`. */
  private collaboratorsCache: CollaboratorInfo[] | null = null;

  constructor(options: FakeCollaborativeSessionOptions) {
    this.documentId = options.documentId;
    this.user = options.user;
    this.remoteOrigin = options.remoteOrigin ?? TRANSACTION_ORIGINS.remote;

    this.doc = new Y.Doc();
    this.text = this.doc.getText(DOCUMENT_TEXT_KEY);
    this.fakeAwareness = new FakeAwareness(this.doc.clientID);
    // No cast (M2-P0-2 step 3): `FakeAwareness` exposes `clientID`, `getStates`, `on`
    // and `off`, which is exactly `AwarenessBinding`. Its extra write helpers are
    // reachable only through `fakeAwareness`, the test-control handle — never through
    // the seam member.
    this.awareness = this.fakeAwareness;

    this.undoManager = new Y.UndoManager(this.text, {
      trackedOrigins: new Set([
        options.localOrigin ?? TRANSACTION_ORIGINS.local,
        TRANSACTION_ORIGINS.ai,
      ]),
    });

    const initial = options.initialText ?? DEFAULT_FAKE_DOCUMENT;
    if (initial.length > 0) {
      // Seeded with the *persistence* origin, exactly like a real session whose
      // IndexedDB replay has already happened: the loaded content is not something
      // the user typed, so it must not sit on top of the undo stack (otherwise the
      // first undo would erase the document the user opened).
      this.doc.transact(() => this.text.insert(0, initial), TRANSACTION_ORIGINS.persistence);
    }

    if (options.publishLocalState !== false) {
      this.setLocalAwareness(this.buildLocalState());
    }

    // The real factory resolves once LOCAL state is available; a fake session is
    // therefore born `active` with the socket still down. Keeping that ordering
    // in the double is what lets A2 test "editable while offline" honestly.
  }

  get state(): SessionState {
    return this.sessionState;
  }

  get connectionStatus(): ConnectionStatus {
    return this.transport;
  }

  get localClientId(): number {
    return this.fakeAwareness.clientID;
  }

  getCollaborators(): readonly CollaboratorInfo[] {
    // Cached per awareness version. `useSyncExternalStore` compares snapshots by
    // reference and loops forever on an unstable one, so the accessor must not
    // build a fresh array on every read — this mirrors the real accessor's
    // obligation rather than hiding it.
    if (this.collaboratorsCache !== null) return this.collaboratorsCache;

    const collaborators: CollaboratorInfo[] = [];
    for (const [clientId, state] of this._statesView()) {
      // The real accessor validates against the shared schema; so does this one,
      // otherwise the double would be *more* permissive than the contract and a
      // malformed-payload test would pass for the wrong reason.
      const parsed = awarenessStateSchema.safeParse(state);
      if (!parsed.success) continue;
      collaborators.push({
        clientId,
        user: parsed.data.user,
        cursor: parsed.data.cursor,
        selection: parsed.data.selection,
      });
    }

    this.collaboratorsCache = collaborators;
    return collaborators;
  }

  /**
   * The raw, unvalidated awareness map.
   *
   * Exposed by name so a test can prove that UI code never calls it (`AGENTS.md`
   * R14). Application code must use `getCollaborators()` instead.
   */
  _statesView(): ReadonlyMap<number, unknown> {
    return this.fakeAwareness.getStates();
  }

  /** Invalidate the collaborator snapshot after any awareness mutation. */
  private invalidateCollaborators(): void {
    this.collaboratorsCache = null;
  }

  getLocalAwarenessState(): AwarenessState | null {
    const parsed = awarenessStateSchema.safeParse(this.fakeAwareness.getLocalState());
    return parsed.success ? parsed.data : null;
  }

  /**
   * Publish presence through the M2-P0-2 seam.
   *
   * This double reuses `parsePresencePatch` from `@insighthub/shared` instead of deriving its
   * own rules: a second copy of "what a legal patch is" would drift, and a test would then pass
   * on patches the production seam rejects. `updatedAt` is stamped here for the same reason -
   * the collaboration layer owns it, never the caller.
   *
   * Ordering mirrors the real session (`document-session.ts` -> `awareness.ts`) so a test
   * cannot observe a difference between the double and production:
   *
   * 1. validate first, so an invalid patch throws even on a destroyed session;
   * 2. then no-op when destroyed;
   * 3. then no-op when no local state has been published yet;
   * 4. merge the patch (absent = leave unchanged, `null` = clear) and stamp `updatedAt`.
   */
  publishPresence(patch: PresencePatch): void {
    const parsed = parsePresencePatch(patch);
    if (this.sessionState === 'destroyed') return;

    const current = this.getLocalAwarenessState();
    if (current === null) return;

    const next: AwarenessState = {
      ...current,
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.selection === undefined ? {} : { selection: parsed.selection }),
      updatedAt: Date.now(),
    };
    this.setLocalAwareness(awarenessStateSchema.parse(next));
  }

  transact(fn: (text: Y.Text) => void, origin?: TransactionOrigin): void {
    this.doc.transact(() => fn(this.text), origin ?? TRANSACTION_ORIGINS.local);
    this.emit();
  }

  undo(): void {
    this.undoManager.undo();
    this.emit();
  }

  redo(): void {
    this.undoManager.redo();
    this.emit();
  }

  getUndoState(): UndoState {
    return { canUndo: this.undoManager.canUndo(), canRedo: this.undoManager.canRedo() };
  }

  connect(): void {
    this.transport = 'connecting';
    this.emit();
  }

  disconnect(): void {
    this.transport = 'offline';
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.sessionState === 'destroyed') return;
    this.sessionState = 'destroyed';
    this.listeners.clear();
    this.fakeAwareness.setLocalState(null);
    this.invalidateCollaborators();
    this.undoManager.destroy();
    this.doc.destroy();
  }

  // ---- test controls (not part of `CollaborativeSession`) --------------------

  /** Pretend the transport moved. Purely presentational for the UI. */
  setConnectionStatus(status: ConnectionStatus): void {
    this.transport = status;
    this.emit();
  }

  setLocalAwareness(state: AwarenessState | null): void {
    this.fakeAwareness.setLocalState(state);
    this.invalidateCollaborators();
    // The session's own contract is `subscribe(listener)` for "state, connection
    // or collaborator set changed" — awareness mutations are exactly that.
    this.emit();
  }

  /** Simulate a remote peer's edit, stamped with the remote origin. */
  applyRemoteText(fn: (text: Y.Text) => void): void {
    this.doc.transact(() => fn(this.text), this.remoteOrigin);
    this.emit();
  }

  /** Publish a peer's awareness state, validated by the same schema. */
  publishRemoteCollaborator(
    clientId: number,
    state: {
      user: { id: string; name: string; color?: string };
      cursor?: { anchor: number; head: number } | null;
      selection?: { from: number; to: number } | null;
      updatedAt?: number;
    },
  ): void {
    this.fakeAwareness.setRemoteState(clientId, {
      user: state.user,
      cursor: state.cursor ?? null,
      selection: state.selection ?? null,
      updatedAt: state.updatedAt ?? Date.now(),
    });
    this.invalidateCollaborators();
    this.emit();
  }

  /**
   * Publish a peer payload that does NOT satisfy the awareness schema, to prove
   * malformed input cannot reach the UI.
   */
  publishMalformedAwareness(clientId: number, payload: unknown): void {
    this.fakeAwareness.setRemoteState(clientId, payload);
    this.invalidateCollaborators();
    this.emit();
  }

  removeRemoteCollaborator(clientId: number): void {
    this.fakeAwareness.removeRemoteState(clientId);
    this.invalidateCollaborators();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private buildLocalState(): AwarenessState {
    return {
      user: {
        id: this.user.id,
        name: this.user.name,
        ...(this.user.color === undefined ? {} : { color: this.user.color }),
      },
      cursor: null,
      selection: null,
      updatedAt: Date.now(),
    };
  }
}

/** Convenience factory mirroring `createCollaborativeSession`, but synchronous. */
export function createFakeCollaborativeSession(
  options: FakeCollaborativeSessionOptions,
): FakeCollaborativeSession {
  return new FakeCollaborativeSession(options);
}
