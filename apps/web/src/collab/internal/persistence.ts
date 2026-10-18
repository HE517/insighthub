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

type IndexedDbProviderConstructor = new (name: string, doc: Y.Doc) => IndexedDbProvider;

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

/**
 * Install `factory` as the global `indexedDB` that `lib0` reads, returning a
 * function that restores the previous state of the property.
 *
 * `lib0/indexeddb.js` (and therefore `y-indexeddb`) reads the **global**
 * `indexedDB` by bare identifier inside its helpers rather than taking it as a
 * parameter, so an injected implementation can only be honoured by putting it on
 * the global object for the lifetime of the provider.
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
 * browser — the editor never opened. Workspace Node tests could not see it, because
 * there the property is absent and assignment simply creates a new data property.
 * The browser's accessor is `configurable`, so `Object.defineProperty` may legally
 * replace it; that is the mechanism used here.
 *
 * Two rules follow, and both are load-bearing:
 *
 * 1. **Do not touch the property when it already is the factory.** In production the
 *    factory resolved by `attachDocumentPersistence` *is* `globalThis.indexedDB`, so
 *    there is nothing to install and Chromium's descriptor is left exactly as it
 *    defined it. Only a genuinely different, injected implementation is written.
 * 2. **Restore the descriptor, not the previous value.** Capturing
 *    `Object.getOwnPropertyDescriptor` and putting that descriptor back restores the
 *    original accessor. Remembering only the *value* (what assignment did) would
 *    leave a writable data property on `window` forever after `destroy()` — a
 *    permanent mutation of the host page, and one that leaked whenever two sessions
 *    overlapped.
 */
function installGlobalIndexedDb(factory: IndexedDbLike): () => void {
  const host = globalThis as IndexedDbGlobalHost;
  const previous = Object.getOwnPropertyDescriptor(host, 'indexedDB');

  // Rule 1. `host.indexedDB` is the very expression `lib0` evaluates, so identity
  // with the factory means the provider will read the right object with no change.
  if (host.indexedDB === factory) return () => {};

  try {
    Object.defineProperty(host, 'indexedDB', {
      value: factory,
      writable: true,
      enumerable: previous?.enumerable ?? true,
      configurable: true,
    });
  } catch (error) {
    // A non-configurable property can be shadowed neither by assignment nor by
    // `defineProperty`. Report that as an unrecoverable local failure rather than
    // letting `y-indexeddb` write to the wrong database.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      'the supplied IndexedDB implementation cannot be installed as the global the ' +
        `persistence provider reads: ${reason}`,
    );
  }

  // Rule 2. Put the original descriptor back, whether it was an accessor or data.
  return () => {
    if (previous === undefined) {
      delete (host as Record<string, unknown>).indexedDB;
      return;
    }
    Object.defineProperty(host, 'indexedDB', previous);
  };
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

  const restoreGlobal = installGlobalIndexedDb(factory);
  try {
    const Provider = await createProviderConstructor();
    const provider = new Provider(options.key, options.doc);

    let destroyPromise: Promise<void> | undefined;
    const whenSynced: Promise<void> = provider.whenSynced.then(() => undefined);

    return {
      whenSynced,
      destroy(): Promise<void> {
        // Idempotent: repeated teardown must not double-close the database or
        // restore the injected global twice.
        destroyPromise ??= (async () => {
          try {
            await provider.destroy();
          } finally {
            restoreGlobal();
          }
        })();
        return destroyPromise;
      },
    };
  } catch (error) {
    restoreGlobal();
    throw error;
  }
}
