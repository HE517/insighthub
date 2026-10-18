import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  DOCUMENT_TEXT_KEY,
  UNDO_TRACKED_ORIGINS,
  parsePresencePatch,
  type AwarenessState,
  type CollaborativeSession,
  type CollaboratorInfo,
  type ConnectionStatus,
  type PresencePatch,
  type SessionState,
  type TransactionOrigin,
  type UndoState,
} from '@insighthub/shared';

import { AwarenessManager } from './awareness.js';
import { LOCAL_ORIGIN, REMOTE_ORIGIN } from './origins.js';
import {
  attachDocumentPersistence,
  ambientIndexedDb,
  resolvePersistenceKey,
  type DocumentPersistence,
  type IndexedDbLike,
} from './persistence.js';
import { SyncProvider, type SyncSocketFactory } from './sync-provider.js';
import type { SessionOptions } from './session-options.js';

/**
 * The `CollaborativeSession` implementation (A1 private).
 *
 * ## Lifecycle, in the frozen order (`docs/CONTRACTS.md` §10.1)
 *
 * ```
 * create Y.Doc
 *   ↓ attach IndexedDB persistence
 *   ↓ wait for LOCAL state to load   → state = 'active'   ← the editor is usable HERE
 *   ↓ connect WebSocket → join-room → room-joined
 *   ↓ SyncStep1 (client state vector)
 *   ↓ SyncStep2 from the server + server SyncStep1
 *   ↓ client SyncStep2 → converged
 * ```
 *
 * The factory resolves after the third line and only then starts the network, so
 * "active with the socket down" is a supported state rather than a degraded one:
 * `docs/ARCHITECTURE.md` §2.1 forbids the UI from gating editing on the connection.
 *
 * ## Document identity
 *
 * One `Y.Doc`, therefore one `Y.Text`, and that instance is handed to the editor as
 * `session.text`. No string copy of the body exists anywhere in this module — not
 * in React, not in Redux, not in a local cache (R11, `docs/ARCHITECTURE.md` §0).
 *
 * ## Reconnect
 *
 * `disconnect()` and a dropped socket both leave the `Y.Doc`, the IndexedDB replica
 * and the undo history untouched. Reconnecting re-runs only the network half: the
 * same document re-joins and re-advertises its state vector, so offline edits are
 * merged rather than replaced, and a reconnect never builds a second document.
 */

/** Test seams. Production passes none of these. */
export interface DocumentSessionDependencies {
  /** IndexedDB implementation override. */
  indexedDB?: IndexedDbLike;
  /** WebSocket constructor override. */
  socketFactory?: SyncSocketFactory;
  /** Persistence attach hook, so a test can substitute or fail it. */
  attachPersistence?: typeof attachDocumentPersistence;
  /** Override the awareness coalescing window. */
  awarenessFlushDelayMs?: number;
  /** Start the network path automatically once local state is loaded. Default true. */
  startNetwork?: boolean;
  /** Reconnect pacing overrides (tests compress the backoff). */
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  joinRetryDelayMs?: number;
}

/**
 * The concrete session object.
 *
 * Exported (from `internal/**`, never from the A2 seam) so A1's tests can reach the
 * parts of the implementation that are deliberately absent from the frozen public
 * interface — the sync provider, its counters, and the cursor/selection setters.
 */
export class DocumentSession implements CollaborativeSession {
  readonly documentId: string;

  readonly doc: Y.Doc;

  readonly text: Y.Text;

  readonly awareness: Awareness;

  private readonly awarenessManager: AwarenessManager;

  private readonly undoManager: Y.UndoManager;

  private readonly persistence: DocumentPersistence;

  private readonly defaultOrigin: TransactionOrigin;

  /** Listeners registered through `subscribe()` (caller-scoped). */
  private readonly scopedListeners = new Set<() => void>();

  /** Test seams: pacing overrides and injection points for the network path. */
  private readonly dependencies: DocumentSessionDependencies;

  private syncProvider: SyncProvider | undefined;

  private sessionState: SessionState = 'initializing';

  private networkStatus: ConnectionStatus = 'idle';

  /**
   * Whether this session has already processed a `room-joined`.
   *
   * Remote awareness is cleared on join because awareness is room-scoped and entries
   * from a previous room must not survive into the next. But on the **first** join there
   * is nothing stale to clear, and clearing removes the collaborator roster the server
   * deliberately sends with the join — so presence stayed invisible until peers happened
   * to republish (up to the 30 s renewable by `y-protocols`). Found by the M1-A0.2
   * cross-agent test: the server held both entries while `getCollaborators()` was empty.
   */
  #hasJoinedOnce = false;

  constructor(params: {
    documentId: string;
    doc: Y.Doc;
    text: Y.Text;
    awareness: Awareness;
    awarenessManager: AwarenessManager;
    undoManager: Y.UndoManager;
    persistence: DocumentPersistence;
    defaultOrigin: TransactionOrigin;
    dependencies: DocumentSessionDependencies;
  }) {
    this.documentId = params.documentId;
    this.doc = params.doc;
    this.text = params.text;
    this.awareness = params.awareness;
    this.awarenessManager = params.awarenessManager;
    this.undoManager = params.undoManager;
    this.persistence = params.persistence;
    this.defaultOrigin = params.defaultOrigin;
    this.dependencies = params.dependencies;
  }

  get state(): SessionState {
    return this.sessionState;
  }

  get connectionStatus(): ConnectionStatus {
    return this.networkStatus;
  }

  get localClientId(): number {
    return this.awarenessManager.clientID;
  }

  /** Wire counters, for tests and diagnostics only. Never protocol state. */
  get networkStatistics(): Readonly<Record<string, number>> | undefined {
    return this.syncProvider?.statistics;
  }

  /**
   * Publish this client's presence — the seam implementation (M2-P0-2).
   *
   * Validation runs **before** anything is written: `parsePresencePatch` is the same
   * rule the read side applies (it reuses `awarenessCursorSchema` /
   * `awarenessSelectionSchema`), and it throws `PresencePatchError` for a bad patch.
   * A rejected patch therefore leaves the local awareness entry untouched and produces
   * no awareness update, so nothing invalid can reach the wire.
   *
   * Validation is deliberately first, ahead of the disposed/missing-state checks: an
   * invalid patch is a caller bug whether or not the session still exists, and
   * silently swallowing it would hide the bug until the session is alive again.
   */
  publishPresence(patch: PresencePatch): void {
    const validated = parsePresencePatch(patch);
    this.awarenessManager.publishPresence(validated);
  }

  /**
   * Publish the local cursor position.
   *
   * Internal convenience over `publishPresence`, kept so the M1 tests and any in-repo
   * caller have one obvious way to move the caret. It routes through the validated
   * seam rather than writing the raw instance, so there is exactly one write path.
   */
  setCursor(cursor: { anchor: number; head: number } | null): void {
    this.publishPresence({ cursor });
  }

  /** Publish the local selection range (or `null` when nothing is selected). */
  setSelection(selection: { from: number; to: number } | null): void {
    this.publishPresence({ selection });
  }

  getCollaborators(): readonly CollaboratorInfo[] {
    return this.awarenessManager.getCollaborators();
  }

  getLocalAwarenessState(): AwarenessState | null {
    return this.awarenessManager.getLocalState();
  }

  transact(fn: (text: Y.Text) => void, origin: TransactionOrigin = this.defaultOrigin): void {
    this.doc.transact(() => {
      fn(this.text);
    }, origin);
  }

  undo(): void {
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.redo();
  }

  getUndoState(): UndoState {
    return { canUndo: this.undoManager.canUndo(), canRedo: this.undoManager.canRedo() };
  }

  connect(): void {
    if (this.sessionState === 'destroyed') return;
    if (this.syncProvider === undefined) {
      throw new Error('the collaboration session has no network path');
    }
    this.syncProvider.connect();
  }

  disconnect(): void {
    if (this.sessionState === 'destroyed') return;
    this.syncProvider?.disconnect();
  }

  subscribe(listener: () => void): () => void {
    this.scopedListeners.add(listener);
    return () => {
      this.scopedListeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.sessionState === 'destroyed') return;
    this.sessionState = 'destroyed';

    // 1. Remove the local awareness entry and broadcast the removal while the
    //    socket is still writable, so peers drop this cursor now rather than after
    //    the 30 s expiry (`docs/CONTRACTS.md` §9.1).
    this.awarenessManager.removeLocalState();
    this.syncProvider?.destroy();
    // 2. Release the presence channel: the y-protocols check interval, the entry
    //    and the outbound coalescing timer (D-015: a live interval keeps Node up).
    this.awarenessManager.dispose();
    // 3. Release the undo history and its document observers.
    this.undoManager.destroy();
    // 4. Detach this session's observers so a torn-down session can never notify.
    this.doc.off('update', this.notify);
    this.doc.off('afterTransaction', this.notify);
    this.awareness.off('change', this.notify);
    // 5. Release local persistence (listeners, trim timer, database connection).
    void this.persistence.destroy();
    this.scopedListeners.clear();
  }

  /* ---------------------------------------------------------------- *
   * Internal wiring (not part of the frozen A2 seam)
   * ---------------------------------------------------------------- */

  /** Called by the factory once local state has loaded. Idempotent. */
  markActive(): void {
    if (this.sessionState !== 'initializing') return;
    this.sessionState = 'active';
    this.doc.on('update', this.notify);
    this.doc.on('afterTransaction', this.notify);
    this.awareness.on('change', this.notify);
  }

  /** True once the network path has been attached (the socket may be down). */
  get hasNetwork(): boolean {
    return this.syncProvider !== undefined;
  }

  /**
   * Attach the network path and connect.
   *
   * Called by the factory only after local state is loaded, which is what keeps the
   * "local first, then server" ordering of §10.1 honest.
   */
  startNetwork(url: string, socketFactory: SyncSocketFactory): void {
    if (this.syncProvider !== undefined || this.sessionState === 'destroyed') return;
    this.syncProvider = new SyncProvider({
      documentId: this.documentId,
      doc: this.doc,
      url,
      socketFactory,
      remoteOrigin: REMOTE_ORIGIN,
      callbacks: {
        onStatusChange: (status) => {
          if (this.networkStatus === status) return;
          this.networkStatus = status;
          this.notify();
        },
        onRoomJoined: () => {
          // Awareness is room-scoped: a fresh join must not inherit peer entries from a
          // previous room. Skipped on the first join for this session, where nothing can
          // be stale and the server's roster of existing collaborators must survive.
          if (this.#hasJoinedOnce) {
            this.awarenessManager.clearRemoteStates();
          }
          this.#hasJoinedOnce = true;
          this.notify();
        },
        onRoomLeft: () => {
          this.notify();
        },
        onServerError: () => {
          this.notify();
        },
      },
      announceLocalAwareness: () => {
        this.awarenessManager.announceLocalState();
      },
      applyAwareness: (bytes) => {
        this.awarenessManager.applyRemoteUpdate(bytes);
      },
      resetAwareness: () => {
        this.awarenessManager.clearRemoteStates();
      },
      reconnectBaseDelayMs: this.dependencies.reconnectBaseDelayMs,
      reconnectMaxDelayMs: this.dependencies.reconnectMaxDelayMs,
      joinRetryDelayMs: this.dependencies.joinRetryDelayMs,
    });
    this.syncProvider.connect();
  }

  /** Send an encoded awareness frame produced by the awareness manager. */
  sendAwarenessFrame(bytes: Uint8Array): boolean {
    return this.syncProvider?.sendAwarenessFrame(bytes) ?? false;
  }

  /** Broadcast the local awareness entry right now (used by tests and `connect`). */
  announceAwareness(): void {
    this.syncProvider?.sendLocalAwareness();
  }

  /** Notify `subscribe()` listeners that observable session state changed. */
  notifyStateChange(): void {
    this.notify();
  }

  private readonly notify = (): void => {
    for (const listener of [...this.scopedListeners]) listener();
  };
}

/** The origin set a local undo may revert, taken from the frozen contract (R13). */
export const SESSION_UNDO_ORIGINS: readonly TransactionOrigin[] = UNDO_TRACKED_ORIGINS;

/**
 * Create a session for one document.
 *
 * Resolves once **local** state is available. The network path is started
 * immediately afterwards unless `dependencies.startNetwork === false` (tests that
 * want to drive `connect()`/`disconnect()` explicitly).
 */
export async function createDocumentSession(
  options: SessionOptions,
  dependencies: DocumentSessionDependencies = {},
): Promise<DocumentSession> {
  const documentId = options.documentId.trim();
  if (documentId === '') {
    throw new Error('createCollaborativeSession requires a non-empty documentId');
  }
  const userId = options.user.id.trim();
  const userName = options.user.name.trim();
  if (userId === '' || userName === '') {
    throw new Error('createCollaborativeSession requires a user with a non-empty id and name');
  }

  const doc = new Y.Doc();
  const text = doc.getText(DOCUMENT_TEXT_KEY);

  // Frozen order, step 1: attach persistence and restore local state. The network
  // is not touched until this resolves.
  //
  // `persistence: 'none'` (A0-owned option, M1-A0.2) skips Path 1 entirely: no
  // IndexedDB, no stored replica. `whenSynced` resolves immediately, so `active` is
  // still reached without the network and `docs/CONTRACTS.md` §10.1 still holds. This
  // exists for a Node harness that has no IndexedDB — a browser caller that uses it
  // loses offline durability (`docs/ARCHITECTURE.md` §2).
  const persistence =
    options.persistence === 'none'
      ? { whenSynced: Promise.resolve(), destroy: () => Promise.resolve() }
      : await (async () => {
          const attach = dependencies.attachPersistence ?? attachDocumentPersistence;
          const providedIndexedDb = dependencies.indexedDB ?? options.indexedDB;
          if (providedIndexedDb !== undefined && typeof providedIndexedDb.open !== 'function') {
            // Fail here rather than inside `y-indexeddb`: its `whenSynced` never settles
            // when the database cannot be opened, so a bad factory would hang the open
            // forever instead of reporting an unrecoverable local failure
            // (`docs/CONTRACTS.md` §8).
            throw new Error('the supplied IndexedDB implementation has no open() method');
          }
          return attach({
            doc,
            key: resolvePersistenceKey(documentId, options.persistenceKey),
            indexedDB: providedIndexedDb ?? ambientIndexedDb(),
          });
        })();

  const awareness = new Awareness(doc);

  // `session` is referenced by the awareness callbacks below. They only run after
  // the assignment, because the manager does not emit update events while the
  // session is still unset (its first local state is published inside its
  // constructor, before any observer that could reach the wire exists).
  let session: DocumentSession;

  const awarenessManager = new AwarenessManager({
    awareness,
    localState: {
      user: {
        id: userId,
        name: userName,
        ...(options.user.color === undefined ? {} : { color: options.user.color }),
      },
      cursor: null,
      selection: null,
      updatedAt: Date.now(),
    },
    // Resolved through the session so the frame travels over the provider that owns
    // the room; `false` means "no room joined yet", which is not an error.
    send: (bytes) => session.sendAwarenessFrame(bytes),
    onChange: () => session.notifyStateChange(),
    flushDelayMs: dependencies.awarenessFlushDelayMs,
    // The session object below does not exist yet; publish once it does.
    publishImmediately: false,
  });

  const undoManager = new Y.UndoManager(text, {
    trackedOrigins: new Set<TransactionOrigin>(UNDO_TRACKED_ORIGINS),
  });

  session = new DocumentSession({
    documentId,
    doc,
    text,
    awareness,
    awarenessManager,
    undoManager,
    persistence,
    defaultOrigin: options.localOrigin ?? LOCAL_ORIGIN,
    dependencies,
  });

  await persistence.whenSynced;

  // A destroy() during the local load must not resurrect the session: durability
  // comes first, then the network path, exactly as §10.1 requires.
  if (session.state === 'destroyed') return session;

  // Publish presence only now that the owner exists (see `publishImmediately`).
  awarenessManager.publishLocalState();
  // Local state is loaded: the editor may be used from here on, network or not.
  session.markActive();

  if (dependencies.startNetwork !== false) {
    session.startNetwork(resolveSocketUrl(options), resolveSocketFactory(options, dependencies));
  }
  return session;
}

/**
 * Vite's `import.meta.env`, read through a narrow structural view.
 *
 * `import.meta.env` is not part of the ECMAScript `import.meta` type: it is declared by
 * `vite/client`, which only `apps/web`'s tsconfig loads. Since M1-A0.2 the **`apps/server`
 * project also compiles this file** (the cross-agent integration test imports the public
 * seam), and there `ImportMeta` has no `env` member — which turned `pnpm typecheck` red
 * while `pnpm build` stayed green, because only web's own build included the declaration.
 *
 * The fix is deliberately local: declare exactly the two variables the collab layer reads
 * and cast the ambient object once, at one place, to that shape. The alternatives were
 * worse — adding `vite/client` to `apps/server`'s `types` would hand Vite globals to the
 * server, and augmenting the global `ImportMeta` would do so for every package including
 * `packages/shared`. `resolveSocketUrl` below does not need the cast at all, because it
 * funnels both sources through `typeof configured === 'string'`.
 */
const viteEnv = import.meta as unknown as { env?: { VITE_WS_URL?: string } };

/**
 * Resolve the WebSocket endpoint.
 *
 * Same derivation the M0 channel uses (`useRealtimeChannel.resolveWsUrl`), so the
 * collaboration session reaches the same server: explicit `VITE_WS_URL`, else the
 * page origin. The session does NOT reuse the M0 channel's socket: one socket
 * carries at most one room (R15), and the collaboration session owns its own room.
 */
export function resolveSocketUrl(options: SessionOptions): string {
  const configured = options.wsUrl ?? viteEnv.env?.VITE_WS_URL;
  if (typeof configured === 'string' && configured.trim() !== '') return configured;

  const location = (globalThis as { location?: { protocol?: string; host?: string } }).location;
  if (location?.host !== undefined && location.host !== '') {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }
  return 'ws://127.0.0.1:3001/ws';
}

/** Resolve the WebSocket constructor: dependency → option → ambient global. */
export function resolveSocketFactory(
  options: SessionOptions,
  dependencies: DocumentSessionDependencies,
): SyncSocketFactory {
  const candidate = dependencies.socketFactory ?? options.wsSocketFactory;
  if (typeof candidate === 'function') return candidate as SyncSocketFactory;

  const ambient = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ambient === 'function') return ambient as SyncSocketFactory;

  throw new Error('no WebSocket implementation is available to open the collaboration channel');
}
