import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { FakeIndexedDb } from './support/fake-indexeddb.js';
import { createDocumentSession, type DocumentSession } from '../internal/document-session.js';
import {
  attachDocumentPersistence,
  PERSISTENCE_PREFIX,
  resolvePersistenceKey,
  type DocumentPersistence,
} from '../internal/persistence.js';

/**
 * Requirement 2: IndexedDB persistence.
 *
 * ## What these tests do and do not prove
 *
 * They run the **real** `y-indexeddb` provider against an in-memory IndexedDB
 * double, so they prove the wiring: a document replica is created under a
 * document-scoped name, local updates are written to the `updates` store, a
 * *second* `Y.Doc` replays them, and `destroy()` detaches the provider so nothing
 * more is written.
 *
 * They do **not** prove that browser IndexedDB behaves the same way. The double
 * commits synchronously, has no quota and no real crash durability. The browser
 * path (edit → reload → offline → content restored) is a manual runbook in
 * `apps/web/src/collab/README.md`; claiming it from a Node test would be a false
 * claim, which `AGENTS.md` R5 forbids.
 */

let context: TestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

function ctx(): TestContext {
  context ??= createTestContext();
  return context;
}

describe('IndexedDB persistence', () => {
  it('scopes the replica name to the document, with an explicit override', () => {
    expect(resolvePersistenceKey('doc-1')).toBe(`${PERSISTENCE_PREFIX}:doc-1`);
    expect(resolvePersistenceKey('doc-1', 'throwaway')).toBe('throwaway');
    expect(resolvePersistenceKey('doc-1', '   ')).toBe(`${PERSISTENCE_PREFIX}:doc-1`);
  });

  it('recreates the local state in a fresh Y.Doc (edit → reload)', async () => {
    const documentId = ctx().nextId('persist');
    const persistenceKey = `reload-${documentId}`;

    const first = await ctx().create({ documentId, persistenceKey });
    expect(first.state).toBe('active');
    first.transact((text) => text.insert(0, 'offline draft'));
    // y-indexeddb writes on the `update` event; one task boundary is enough for the
    // in-memory store to hold it.
    await waitFor(
      () => ctx().db.records(persistenceKey).length > 0,
      'the local replica to receive the update',
    );
    first.destroy();

    const reloaded = await ctx().createFor(documentId, { persistenceKey });
    expect(reloaded.state).toBe('active');
    expect(reloaded.text.toString()).toBe('offline draft');
    // The restored content is CRDT state, not a string snapshot: a second doc that
    // receives the state update merges normally.
    expect(reloaded.doc.getText('content').toString()).toBe('offline draft');
    reloaded.destroy();
  });

  it('keeps two documents in separate replicas', async () => {
    const first = await ctx().create();
    const second = await ctx().create();
    first.transact((text) => text.insert(0, 'alpha'));
    second.transact((text) => text.insert(0, 'beta'));

    expect(first.text.toString()).toBe('alpha');
    expect(second.text.toString()).toBe('beta');
    expect(ctx().db.createdNames.length).toBeGreaterThanOrEqual(2);
    first.destroy();
    second.destroy();
  });

  it('restores without a network and reports no connection dependency', async () => {
    const documentId = ctx().nextId('offline');
    const persistenceKey = `offline-${documentId}`;

    const online = await ctx().create({ documentId, persistenceKey });
    online.transact((text) => text.insert(0, 'written while offline'));
    await waitFor(() => ctx().db.records(persistenceKey).length > 0, 'the update to be persisted');
    online.destroy();

    // No session in this test ever had a network path: durability is Path 1 alone.
    const offlineReload = await ctx().createFor(documentId, { persistenceKey });
    expect(offlineReload.connectionStatus).toBe('idle');
    expect(offlineReload.state).toBe('active');
    expect(offlineReload.text.toString()).toBe('written while offline');
    offlineReload.destroy();
  });

  it('stops writing to the replica after destroy()', async () => {
    const documentId = ctx().nextId('detach');
    const persistenceKey = `detach-${documentId}`;

    const session = await ctx().create({ documentId, persistenceKey });
    session.transact((text) => text.insert(0, 'before'));
    await waitFor(() => ctx().db.records(persistenceKey).length > 0, 'first write');
    const writesBefore = ctx().db.records(persistenceKey).length;

    session.destroy();
    // A late edit on the detached document must not reach the store: the provider
    // released its `update` listener and closed the database.
    session.transact((text) => text.insert(6, ' after'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx().db.records(persistenceKey).length).toBe(writesBefore);
  });

  it('restores a replica twice without duplicating content', async () => {
    const documentId = ctx().nextId('idempotent');
    const persistenceKey = `idempotent-${documentId}`;

    const first = await ctx().create({ documentId, persistenceKey });
    first.transact((text) => text.insert(0, 'once'));
    await waitFor(() => ctx().db.records(persistenceKey).length > 0, 'first write');
    first.destroy();

    const second = await ctx().createFor(documentId, { persistenceKey });
    const third = await ctx().createFor(documentId, { persistenceKey });
    expect(second.text.toString()).toBe('once');
    expect(third.text.toString()).toBe('once');
    second.destroy();
    third.destroy();
  });

  it('injects the provided factory as the ambient global and restores it', () => {
    const db = new FakeIndexedDb();
    const restore = db.install();
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBe(db);
    restore();
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------- *
 * DEFECT P0-1 regression pins
 * ---------------------------------------------------------------------- */

/**
 * Give `globalThis` the descriptor a Chromium page actually has for
 * `window.indexedDB`: an **own accessor with a getter and no setter**. Under the
 * strict mode every ES module runs in, `globalThis.indexedDB = factory` therefore
 * throws `TypeError: Cannot set property indexedDB of #<Object> which has only a
 * getter` — exactly what made `createCollaborativeSession` reject in a real browser
 * while the workspace's Node tests, where the property is simply absent, stayed
 * green.
 *
 * `IDBKeyRange` is installed as a plain data property because `lib0/indexeddb`
 * reads it the same way and `y-indexeddb` needs it to replay updates; the defect is
 * about `indexedDB` alone.
 *
 * The returned function puts both original descriptors back verbatim.
 */
function installBrowserShapedIndexedDb(ambient: FakeIndexedDb): () => void {
  const host = globalThis as Record<string, unknown>;
  const indexedDb = Object.getOwnPropertyDescriptor(host, 'indexedDB');
  const keyRange = Object.getOwnPropertyDescriptor(host, 'IDBKeyRange');

  Object.defineProperty(host, 'indexedDB', {
    get: () => ambient,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(host, 'IDBKeyRange', {
    value: FakeIndexedDb.keyRange,
    writable: true,
    enumerable: true,
    configurable: true,
  });

  return () => {
    for (const [key, descriptor] of [
      ['indexedDB', indexedDb],
      ['IDBKeyRange', keyRange],
    ] as const) {
      if (descriptor === undefined) delete host[key];
      else Object.defineProperty(host, key, descriptor);
    }
  };
}

/** A unique replica name, so the pins cannot read another test's database. */
function uniqueKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Both pins below are **red against the pre-fix module** and green with the
 * descriptor-safe installation in `internal/persistence.ts`. They assert the
 * contract behaviour (a document opens, local updates persist) on the production
 * code path — no seam, no shim, no monkey patch of the module under test.
 *
 * They are still Node evidence: they pin the *descriptor shape* that breaks
 * `lib0`'s global lookup, not browser storage behaviour. Real-Chromium coverage of
 * the defect is now the ordinary browser scenarios (`smoke/harness`, `indexeddb/*`),
 * which all run the unmodified production path: the dedicated pin
 * (`tests/browser/suite/defect-pins.mjs`, owner A6) was deleted once the fix landed,
 * and the P0-1 test-only shim was removed with it — see `docs/DECISIONS.md` D-039.
 */
describe('global IndexedDB installation (DEFECT P0-1)', () => {
  it('opens a document when the ambient global is a getter-only accessor', async () => {
    const ambient = new FakeIndexedDb();
    const restoreGlobals = installBrowserShapedIndexedDb(ambient);
    const persistenceKey = uniqueKey('browser-shaped');
    let session: DocumentSession | undefined;

    try {
      // No `indexedDB` seam anywhere: the module resolves the ambient global, which
      // is the production browser path. Before the fix this rejected with a
      // TypeError from `installGlobalIndexedDb`.
      session = await createDocumentSession(
        {
          documentId: 'browser-shaped-document',
          user: { id: 'user-a', name: 'User A' },
          persistenceKey,
          wsUrl: 'ws://127.0.0.1:1/ws',
          wsSocketFactory: testSocketFactory,
        },
        { startNetwork: false },
      );

      expect(session.state).toBe('active');
      session.transact((text) => text.insert(0, 'getter-only global'));
      await waitFor(
        () => ambient.records(persistenceKey).length > 0,
        'the local update to reach the replica',
      );

      // Because the ambient factory *is* the factory, nothing is installed: the
      // page's own accessor must survive untouched for the session's lifetime.
      const during = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
      expect(typeof during?.get).toBe('function');
      expect(during?.set).toBeUndefined();
    } finally {
      session?.destroy();
      restoreGlobals();
    }
  });

  it('injects a supplied implementation over a getter-only global and restores the accessor', async () => {
    const pageFactory = new FakeIndexedDb();
    const injected = new FakeIndexedDb();
    const restoreGlobals = installBrowserShapedIndexedDb(pageFactory);
    const persistenceKey = uniqueKey('injected-over-accessor');
    let session: DocumentSession | undefined;

    try {
      session = await createDocumentSession(
        {
          documentId: 'injected-over-accessor-document',
          user: { id: 'user-a', name: 'User A' },
          persistenceKey,
          indexedDB: injected,
          wsUrl: 'ws://127.0.0.1:1/ws',
          wsSocketFactory: testSocketFactory,
        },
        { startNetwork: false },
      );

      expect(session.state).toBe('active');
      session.transact((text) => text.insert(0, 'injected factory'));
      await waitFor(
        () => injected.records(persistenceKey).length > 0,
        'the update to reach the injected factory',
      );
      // The real browser factory must not have been used: the injection reached
      // `lib0`, which is only possible if the global was replaced.
      expect(pageFactory.createdNames).toEqual([]);

      // The replacement is a writable data property holding the injection — the
      // shape a strict-mode assignment cannot produce on a getter-only accessor.
      const during = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
      expect(during?.value).toBe(injected);
      expect(during?.writable).toBe(true);

      session.destroy();
      session = undefined;
      // Teardown must restore the original *accessor*, not leave a data property on
      // the host page (the pre-fix restore wrote the old value back by assignment).
      await waitFor(
        () => typeof Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')?.get === 'function',
        'the original getter-only accessor to be restored',
      );
      expect(Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')?.set).toBeUndefined();
      expect((globalThis as { indexedDB?: unknown }).indexedDB).toBe(pageFactory);
    } finally {
      session?.destroy();
      restoreGlobals();
    }
  });
});

/* ---------------------------------------------------------------------- *
 * M2-P0-3 — injected-factory leases (D-046)
 * ---------------------------------------------------------------------- */

/**
 * Regression tests for the defect `docs/DECISIONS.md` D-039 §4 recorded and D-046
 * froze the fix for.
 *
 * ## The pre-fix failure chain these tests reproduce
 *
 * The old `installGlobalIndexedDb` was a **single snapshot**: it captured
 * `Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')` and restored that one
 * descriptor on teardown, with idempotency only per handle (`destroyPromise`). There
 * was no stack and no cross-handle reference count. With two overlapping sessions:
 *
 * ```text
 * A installs FA  → snapshots the ambient descriptor
 * B installs FB  → snapshots A's descriptor
 * A.destroy()    → restores the ambient descriptor  (B is still live → wrong factory)
 * B.destroy()    → restores A's descriptor          (a fake factory, permanently global)
 * ```
 *
 * ## Which assertion is the discriminator, per test
 *
 * Each test below pins one row of D-046's table. The assertion marked `← RED pre-fix`
 * is the one the old module failed; the others are invariants that must hold in both
 * worlds and stop the test from passing for the wrong reason.
 *
 * | # | D-046 row | Fails pre-fix because |
 * | --- | --- | --- |
 * | 1 | nested factories | `A.destroy()` pops the ambient layer out from under live B |
 * | 2 | non-LIFO destroy | restoring per release, not per stack: the end state is a fake factory |
 * | 3 | same factory, two references | the second install short-circuits to a no-op, so one release restores everything |
 * | 4 | construction-failure rollback | the failed install restores *its* snapshot, leaving the layer below as a fake factory |
 * | 5 | ambient browser factory | (green pre-fix) guards that the fix does not start writing the global on the production path |
 *
 * Test 5 is deliberately a **no-regression guard**, not a defect reproduction: the
 * production path already short-circuited before the fix, and D-046 requires that it
 * keeps doing so with zero writes. Saying it "was red" would be false.
 *
 * ## What this is not
 *
 * Node evidence about a module-level property on `globalThis`. It pins descriptor
 * identity and lease ordering; it says nothing about real browser storage behaviour
 * (that is the A6 `tests/browser/**` gate). The ambient global here is a getter-only
 * accessor, i.e. the shape a Chromium `window.indexedDB` actually has.
 */
describe('injected IndexedDB factory lifecycle (M2-P0-3 / D-046)', () => {
  /** The descriptor of the global property under test, read fresh every time. */
  function descriptor(): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  }

  /** The value `lib0` would read from the bare `indexedDB` identifier. */
  function currentFactory(): unknown {
    return (globalThis as { indexedDB?: unknown }).indexedDB;
  }

  /**
   * Attach persistence for throwaway documents, tracking every handle so a failing
   * assertion cannot leave a lease installed and poison the next test.
   */
  function createLedger() {
    const handles: DocumentPersistence[] = [];
    const docs: Y.Doc[] = [];

    const start = (
      factory: FakeIndexedDb,
      key: string,
      loadProviderConstructor?: () => Promise<never>,
    ): Promise<DocumentPersistence> => {
      const doc = new Y.Doc();
      docs.push(doc);
      return attachDocumentPersistence({
        doc,
        key,
        indexedDB: factory,
        ...(loadProviderConstructor === undefined ? {} : { loadProviderConstructor }),
      }).then(
        (persistence) => {
          handles.push(persistence);
          return persistence;
        },
        (error: unknown) => {
          // A rejected attach has already rolled its own lease back; only the doc
          // needs cleaning up, and it is in `docs`.
          throw error;
        },
      );
    };

    return {
      /** Start an attach and wait for the local replica, as a caller would. */
      async attach(factory: FakeIndexedDb, key: string): Promise<DocumentPersistence> {
        const persistence = await start(factory, key);
        await persistence.whenSynced;
        return persistence;
      },
      /** The same attach, but the caller owns the promise (used for interleaving). */
      start,
      async releaseAll(): Promise<void> {
        for (const handle of handles.splice(0).reverse()) {
          try {
            await handle.destroy();
          } catch {
            /* teardown of an already-failed provider is not the assertion here */
          }
        }
      },
      disposeDocs(): void {
        for (const doc of docs.splice(0)) doc.destroy();
      },
    };
  }

  it('keeps every overlapping session reading its own injected factory', async () => {
    const ambient = new FakeIndexedDb();
    const factoryA = new FakeIndexedDb();
    const factoryB = new FakeIndexedDb();
    const restoreGlobals = installBrowserShapedIndexedDb(ambient);
    const initial = descriptor();
    const ledger = createLedger();

    try {
      const persistenceA = await ledger.attach(factoryA, 'overlap-a');
      expect(currentFactory()).toBe(factoryA);

      const persistenceB = await ledger.attach(factoryB, 'overlap-b');
      expect(currentFactory()).toBe(factoryB);

      // Non-LIFO in the sense that matters for the defect: the *earlier* session ends
      // first. Its teardown must not pop the global out from under the live one.
      await persistenceA.destroy();
      // ← RED pre-fix: the single-snapshot restore put the ambient factory back, so a
      // still-live B silently resolved a *different* database than the one it injected.
      expect(currentFactory()).toBe(factoryB);

      // The observable consequence of that window: B's writes must stay in B's store.
      expect(ambient.createdNames).toEqual([]);
      expect(factoryA.createdNames).toEqual(['overlap-a']);
      expect(factoryB.createdNames).toEqual(['overlap-b']);

      await persistenceB.destroy();
      expect(descriptor()).toEqual(initial);
    } finally {
      await ledger.releaseAll();
      ledger.disposeDocs();
      restoreGlobals();
    }
  });

  it('unwinds the stack when sessions are destroyed out of order', async () => {
    const ambient = new FakeIndexedDb();
    const factoryA = new FakeIndexedDb();
    const factoryB = new FakeIndexedDb();
    const factoryC = new FakeIndexedDb();
    const restoreGlobals = installBrowserShapedIndexedDb(ambient);
    const initial = descriptor();
    const ledger = createLedger();

    try {
      const persistenceA = await ledger.attach(factoryA, 'stack-a');
      const persistenceB = await ledger.attach(factoryB, 'stack-b');
      const persistenceC = await ledger.attach(factoryC, 'stack-c');
      expect(currentFactory()).toBe(factoryC);

      // Release the bottom layer first: it retires but must not restore, because two
      // live layers sit above it.
      await persistenceA.destroy();
      // ← RED pre-fix: the ambient descriptor came back with B and C still live.
      expect(currentFactory()).toBe(factoryC);

      // Release the top layer: the middle layer is next and still live, so the stack
      // stops there rather than unwinding through it.
      await persistenceC.destroy();
      expect(currentFactory()).toBe(factoryB);

      // Release the middle layer: now the already-retired bottom layer is on top, so
      // it unwinds too and the original descriptor comes back exactly.
      await persistenceB.destroy();
      expect(descriptor()).toEqual(initial);
      // ← RED pre-fix: the final state was A's installed data property (a fake
      // factory left permanently on the global), never the ambient accessor.
      expect(currentFactory()).toBe(ambient);
      expect(typeof descriptor()?.get).toBe('function');
    } finally {
      await ledger.releaseAll();
      ledger.disposeDocs();
      restoreGlobals();
    }
  });

  it('counts references when the same factory is installed twice', async () => {
    const ambient = new FakeIndexedDb();
    const shared = new FakeIndexedDb();
    const restoreGlobals = installBrowserShapedIndexedDb(ambient);
    const initial = descriptor();
    const ledger = createLedger();

    try {
      const first = await ledger.attach(shared, 'refcount-a');
      const second = await ledger.attach(shared, 'refcount-b');
      expect(currentFactory()).toBe(shared);

      // The second acquisition is a second reference to the same installation, not a
      // new layer: releasing one must leave the factory installed for the other.
      await first.destroy();
      // ← RED pre-fix: the second install short-circuited to a no-op, so this single
      // release restored the ambient descriptor while `second` was still live.
      expect(currentFactory()).toBe(shared);

      await second.destroy();
      expect(descriptor()).toEqual(initial);
    } finally {
      await ledger.releaseAll();
      ledger.disposeDocs();
      restoreGlobals();
    }
  });

  it('rolls the global back when provider construction fails', async () => {
    const ambient = new FakeIndexedDb();
    const factoryA = new FakeIndexedDb();
    const factoryB = new FakeIndexedDb();
    const restoreGlobals = installBrowserShapedIndexedDb(ambient);
    const initial = descriptor();
    const ledger = createLedger();
    let failConstruction: ((error: Error) => void) | undefined;

    try {
      const persistenceA = await ledger.attach(factoryA, 'rollback-a');

      // Hold B's construction open so the release of A can be ordered before it — the
      // composition that makes the pre-fix rollback wrong.
      const pendingB = ledger.start(
        factoryB,
        'rollback-b',
        () =>
          new Promise<never>((_resolve, reject) => {
            failConstruction = reject;
          }),
      );
      // The lease is installed synchronously, before the provider is constructed.
      expect(currentFactory()).toBe(factoryB);

      await persistenceA.destroy();
      expect(currentFactory()).toBe(factoryB);

      failConstruction?.(new Error('provider construction failed'));
      await expect(pendingB).rejects.toThrow(/provider construction failed/);

      // Construction failure must release its own layer; unwinding the retired layer
      // below it must reach the original descriptor, not A's injected factory.
      // ← RED pre-fix: the failed install restored *its* snapshot (A's data property),
      // so a fake factory stayed on the global with nobody owning it.
      expect(descriptor()).toEqual(initial);
      expect(currentFactory()).toBe(ambient);
    } finally {
      await ledger.releaseAll();
      ledger.disposeDocs();
      restoreGlobals();
    }
  });

  it('never writes the global on the production path (no injected factory)', async () => {
    const pageFactory = new FakeIndexedDb();
    const restoreGlobals = installBrowserShapedIndexedDb(pageFactory);
    const initial = descriptor();
    const definePropertySpy = vi.spyOn(Object, 'defineProperty');
    const doc = new Y.Doc();
    let persistence: DocumentPersistence | undefined;

    try {
      // No `indexedDB` option: the module resolves the ambient global, which is the
      // production browser path. Installing it would be a no-op *and* a mutation of
      // the host page, so it must not happen at all.
      persistence = await attachDocumentPersistence({ doc, key: 'production-path' });
      await persistence.whenSynced;

      const writesToTheGlobal = definePropertySpy.mock.calls.filter(
        ([target, property]) => target === globalThis && property === 'indexedDB',
      );
      expect(writesToTheGlobal).toEqual([]);
      // The page's own getter must survive untouched for the whole lifetime.
      expect(descriptor()?.get).toBe(initial?.get);
      expect(descriptor()?.set).toBeUndefined();
      expect(currentFactory()).toBe(pageFactory);

      doc.getText('content').insert(0, 'production path');
      await waitFor(
        () => pageFactory.records('production-path').length > 0,
        'the ambient factory to receive the local update',
      );

      await persistence.destroy();
      persistence = undefined;
      expect(
        definePropertySpy.mock.calls.filter(
          ([target, property]) => target === globalThis && property === 'indexedDB',
        ),
      ).toEqual([]);
      // Teardown must leave the descriptor byte-for-byte what it was: the same
      // accessor object, not a re-created one and not a data property.
      expect(descriptor()).toEqual(initial);
      expect(descriptor()?.get).toBe(initial?.get);
    } finally {
      await persistence?.destroy();
      definePropertySpy.mockRestore();
      doc.destroy();
      restoreGlobals();
    }
  });
});
