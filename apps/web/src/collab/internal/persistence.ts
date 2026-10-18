import * as Y from 'yjs';

/**
 * IndexedDB persistence — Path 1 of the two independent paths out of `Y.Doc`
 * (`docs/ARCHITECTURE.md` §2).
 *
 * Responsibilities and boundaries:
 *
 * - Wraps `y-indexeddb`'s `IndexeddbPersistence`. A1 does not re-implement local
 *   storage: the provider already stores **encoded Yjs updates** (never a parallel
 *   Markdown string — `docs/ARCHITECTURE.md` §0) and replays them on open.
 * - `whenSynced` is what gates `session.state = 'active'`
 *   (`docs/CONTRACTS.md` §10.1): the editor becomes usable when *local* state is
 *   loaded, and never waits for the network.
 * - `destroy()` releases the provider: it stops listening to the document, clears
 *   its trim timer and closes the database connection. Without it the process can
 *   keep a handle open after teardown.
 *
 * The module is imported dynamically by `document-session.ts` so that a Node test
 * environment without IndexedDB fails with a clear message from A1 rather than an
 * import-time `ReferenceError` inside a dependency.
 */

/**
 * Structural stand-in for the browser `IndexedDB` global.
 *
 * `y-indexeddb`/`lib0` call `indexedDB.open(name)` and `indexedDB.deleteDatabase(name)`
 * with the classic event-callback protocol. Typing the callbacks as `any` keeps this
 * structural type *compatible with* the DOM's `IDBFactory` (which is what the page
 * actually provides) without dragging `lib.dom` into a module that must also compile
 * for a Node test double.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface IndexedDbRequestLike {
  onsuccess: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onupgradeneeded?: ((event: any) => void) | null;
}

export interface IndexedDbLike {
  open(name: string): IndexedDbRequestLike;
  deleteDatabase(name: string): IndexedDbRequestLike;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Local persistence for one document. */
export interface DocumentPersistence {
  /** Resolves once every locally stored update has been applied to the `Y.Doc`. */
  readonly whenSynced: Promise<void>;
  /** Release listeners, timers and the database connection. Idempotent. */
  destroy(): Promise<void>;
}

/** Minimal shape of `IndexeddbPersistence` that this module depends on. */
interface IndexedDbProvider {
  whenSynced: Promise<unknown>;
  destroy(): Promise<void> | void;
}

/**
 * Constructor shape of the provider.
 *
 * Exported because `PersistenceAttachOptions` accepts an override for it: making
 * provider *construction* fail is the only way to exercise the rollback path that
 * `docs/DECISIONS.md` D-046 requires, and a real `y-indexeddb` import does not fail.
 */
export type IndexedDbProviderConstructor = new (name: string, doc: Y.Doc) => IndexedDbProvider;

/**
 * Namespace prefix for the local replica.
 *
 * One database per document, and the `documentId` is part of the name so two
 * documents can never share a replica. `options.persistenceKey` overrides it —
 * tests use a throwaway name so they cannot read a developer's real replica.
 */
export const PERSISTENCE_PREFIX = 'insighthub-doc';

/** The database name used for a document (or the caller's explicit override). */
export function resolvePersistenceKey(documentId: string, override?: string): string {
  if (override !== undefined && override.trim() !== '') return override;
  return `${PERSISTENCE_PREFIX}:${documentId}`;
}

/** True when this environment can persist locally at build-free runtime. */
export function ambientIndexedDb(): IndexedDbLike | undefined {
  const candidate = (globalThis as { indexedDB?: unknown }).indexedDB;
  if (candidate === undefined || candidate === null) return undefined;
  const open = (candidate as { open?: unknown }).open;
  if (typeof open !== 'function') return undefined;
  return candidate as IndexedDbLike;
}

/** The global object, seen as the single property this module installs. */
type IndexedDbGlobalHost = { indexedDB?: unknown };

/* ---------------------------------------------------------------------- *
 * Injected-factory leases (M2-P0-3 / D-046)
 * ---------------------------------------------------------------------- */

/**
 * Why the global is touched at all, and why installing is a *stack* rather than a
 * snapshot.
 *
 * `lib0/indexeddb.js` (and therefore `y-indexeddb`) reads the **global** `indexedDB`
 * by bare identifier inside its helpers rather than taking it as a parameter, so an
 * injected implementation can only be honoured by putting it on the global object for
 * the lifetime of the provider.
 *
 * ## Why this is not `globalThis.indexedDB = factory` (DEFECT P0-1)
 *
 * In a real browser `window.indexedDB` is an **own accessor with a getter and no
 * setter**, and every ES module is strict mode, so a plain assignment throws on the
 * first line of the persistence path:
 *
 * ```text
 * TypeError: Cannot set property indexedDB of #<Window> which has only a getter
 * ```
 *
 * That rejected `createCollaborativeSession` for every document in every real
 * browser — the editor never opened. The browser's accessor is `configurable`, so
 * `Object.defineProperty` may legally replace it; that is the mechanism used here,
 * and `restoreDescriptor` puts the original accessor back rather than a value.
 *
 * ## Why a stack instead of one snapshot (M2-P0-3 / D-039 §4)
 *
 * A single snapshot ("remember the descriptor, put it back on release") is only
 * correct for one handle at a time. With two overlapping sessions it silently
 * corrupts the global:
 *
 * ```text
 * A installs FA  → snapshots the ambient descriptor
 * B installs FB  → snapshots A's descriptor
 * A.destroy()    → restores the ambient descriptor  ← B is still live and now reads it
 * B.destroy()    → restores A's descriptor          ← a fake factory, permanently global
 * ```
 *
 * There is no error in that sequence; the second session just writes to the wrong
 * database. The fix is a module-level stack of installation layers plus a reference
 * count per layer, so a release only unwinds what is actually on top and nothing that
 * another live holder still depends on (`docs/DECISIONS.md` D-046).
 *
 * The production browser path never reaches any of this: when the resolved factory
 * already *is* the global, `acquireIndexedDbLease` returns a no-op and the page's
 * property is not written at all, not even with an identical value.
 */

/**
 * One installation layer.
 *
 * Layers are pushed in install order and popped from the top, so
 * `previousDescriptor` always describes exactly the property state the layer found.
 * Unwinding top-down therefore restores the property correctly even when the
 * *releases* happen in a different order than the installs.
 */
interface IndexedDbLeaseLayer {
  /** The factory this layer wrote onto the global. */
  readonly factory: IndexedDbLike;
  /** `globalThis.indexedDB` immediately before this layer installed. */
  readonly previousDescriptor: PropertyDescriptor | undefined;
  /** Live acquisitions of this layer. Reaches zero when the last holder releases. */
  refCount: number;
  /** True once `refCount` hit zero. A retired layer unwinds when it reaches the top. */
  retired: boolean;
}

/** Release one acquisition. Idempotent: extra calls are no-ops, never errors. */
export type IndexedDbLeaseRelease = () => void;

/** Nothing was installed, so there is nothing to undo. */
const noopRelease: IndexedDbLeaseRelease = () => {};

/**
 * The module-level installation stack.
 *
 * Empty on the production browser path and empty again after the last injected
 * session releases. It is deliberately a module singleton rather than per-session
 * state: the global property it protects is itself a module singleton, and the whole
 * point is that concurrent sessions agree on who owns it.
 */
const leaseStack: IndexedDbLeaseLayer[] = [];

function topLeaseLayer(): IndexedDbLeaseLayer | undefined {
  if (leaseStack.length === 0) return undefined;
  return leaseStack[leaseStack.length - 1];
}

/**
 * Put `descriptor` back on the global property.
 *
 * `undefined` means the property did not exist (the Node test environment before a
 * double is installed), so the correct restore is to delete it rather than to leave a
 * stray `indexedDB: undefined` data property behind.
 */
function restoreDescriptor(
  host: IndexedDbGlobalHost,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    delete (host as Record<string, unknown>).indexedDB;
    return;
  }
  Object.defineProperty(host, 'indexedDB', descriptor);
}

/**
 * Unwind every retired layer that has reached the top of the stack.
 *
 * A retired layer that is *not* on top stays put and is skipped over, because the
 * layers above it are still live and the property must keep reading their factory.
 * It unwinds on a later release, once everything above it is gone — which is what
 * makes a non-LIFO teardown order safe.
 */
function drainRetiredLayers(): void {
  const host = globalThis as IndexedDbGlobalHost;
  for (;;) {
    const top = topLeaseLayer();
    if (top === undefined || !top.retired) return;
    leaseStack.pop();
    // Identity guard: only put back what this layer installed. If something else has
    // written the property since — a foreign writer, or a page that re-defined it —
    // restoring here would clobber an owner this module does not own. The layer is
    // retired either way; leaving the foreign value alone is the conservative choice.
    if (host.indexedDB === top.factory) restoreDescriptor(host, top.previousDescriptor);
  }
}

/**
 * Build the release function for **one acquisition** of `layer`.
 *
 * The idempotency flag is per acquisition, not per layer: two acquisitions can share
 * a layer through its `refCount`, and each must decrement exactly once. Calling one
 * acquisition's release twice is a no-op rather than an error, so a double
 * `destroy()` cannot over-decrement and pop the global from under a sibling.
 */
function createLeaseRelease(layer: IndexedDbLeaseLayer): IndexedDbLeaseRelease {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    layer.refCount -= 1;
    if (layer.refCount > 0) return;
    layer.retired = true;
    drainRetiredLayers();
  };
}

/**
 * Install `factory` as the global `indexedDB` that `lib0` reads, or register another
 * reference to the installation that is already there.
 *
 * Returns the release function for this acquisition. Idempotent, and safe to call for
 * a factory that needs no installation.
 */
function acquireIndexedDbLease(factory: IndexedDbLike): IndexedDbLeaseRelease {
  const host = globalThis as IndexedDbGlobalHost;

  // Fast path — and the entire production browser path. The property already reads as
  // this factory, so `lib0` will resolve the right object with no write at all.
  if (host.indexedDB === factory) {
    const top = topLeaseLayer();
    if (top !== undefined && top.factory === factory) {
      // A second reference to the installation this module already made: count it so
      // the first release does not remove a factory the second holder still needs.
      top.refCount += 1;
      return createLeaseRelease(top);
    }
    // The page's own factory: nothing was installed, nothing to restore.
    return noopRelease;
  }

  const previousDescriptor = Object.getOwnPropertyDescriptor(host, 'indexedDB');
  try {
    Object.defineProperty(host, 'indexedDB', {
      value: factory,
      writable: true,
      enumerable: previousDescriptor?.enumerable ?? true,
      configurable: true,
    });
  } catch (error) {
    // A non-configurable property can be shadowed neither by assignment nor by
    // `defineProperty`. Report that as an unrecoverable local failure rather than
    // letting `y-indexeddb` write to the wrong database. Nothing was installed, so
    // there is no layer to roll back.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      'the supplied IndexedDB implementation cannot be installed as the global the ' +
        `persistence provider reads: ${reason}`,
    );
  }

  const layer: IndexedDbLeaseLayer = { factory, previousDescriptor, refCount: 1, retired: false };
  leaseStack.push(layer);
  return createLeaseRelease(layer);
}

/** Load the provider class lazily so importing this module never touches IndexedDB. */
async function createProviderConstructor(): Promise<IndexedDbProviderConstructor> {
  const module = (await import('y-indexeddb')) as unknown as {
    IndexeddbPersistence: IndexedDbProviderConstructor;
  };
  return module.IndexeddbPersistence;
}

export interface PersistenceAttachOptions {
  doc: Y.Doc;
  /** Database name (use `resolvePersistenceKey`). */
  key: string;
  /** Explicit IndexedDB implementation; defaults to the ambient global. */
  indexedDB?: IndexedDbLike;
  /**
   * Override the `y-indexeddb` module load.
   *
   * Test seam, in the same spirit as `DocumentSessionDependencies.attachPersistence`
   * and the injectable socket factory. It exists so the construction-failure rollback
   * required by `docs/DECISIONS.md` D-046 is verifiable: a real dynamic import of an
   * installed package does not fail, so without a seam that branch is unfalsifiable.
   * Production callers never pass it.
   */
  loadProviderConstructor?: () => Promise<IndexedDbProviderConstructor>;
}

/**
 * Attach local persistence to a document and wait for the local replica to load.
 *
 * Resolves **after** every stored update has been applied, which is what makes the
 * subsequent `active` state meaningful: the `Y.Doc` already contains all offline
 * edits before the socket is even opened, so the later `SyncStep1` advertises them
 * and the exchange is an ordinary CRDT merge (`docs/CONTRACTS.md` §10.2, §10.3).
 *
 * Rejects when the environment has no IndexedDB at all, because A1's contract is
 * local durability: silently degrading to a memory-only document would lose work
 * on refresh with no signal (R10).
 */
export async function attachDocumentPersistence(
  options: PersistenceAttachOptions,
): Promise<DocumentPersistence> {
  const factory = options.indexedDB ?? ambientIndexedDb();
  if (factory === undefined) {
    throw new Error(
      'IndexedDB is unavailable in this environment, so local document persistence cannot be established',
    );
  }

  // Acquire before constructing: `lib0` resolves the global when the provider opens
  // its database, which happens inside the constructor.
  const releaseLease = acquireIndexedDbLease(factory);
  try {
    const loadProvider = options.loadProviderConstructor ?? createProviderConstructor;
    const Provider = await loadProvider();
    const provider = new Provider(options.key, options.doc);

    let destroyPromise: Promise<void> | undefined;
    const whenSynced: Promise<void> = provider.whenSynced.then(() => undefined);

    return {
      whenSynced,
      destroy(): Promise<void> {
        // Idempotent: repeated teardown must not double-close the database. The lease
        // release carries its own per-acquisition idempotency as well, so even a
        // destroy path that called it twice could not over-decrement a shared layer.
        destroyPromise ??= (async () => {
          try {
            await provider.destroy();
          } finally {
            releaseLease();
          }
        })();
        return destroyPromise;
      },
    };
  } catch (error) {
    // Construction failed, so this acquisition never produced a provider and has no
    // `destroy()` to release it. Release here or the layer outlives the failure: the
    // next session in this realm would resolve a factory nobody owns instead of the
    // ambient one (`docs/DECISIONS.md` D-046 row "construction failure rollback").
    releaseLease();
    throw error;
  }
}
