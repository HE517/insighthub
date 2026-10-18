import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { FakeIndexedDb } from './support/fake-indexeddb.js';
import { createDocumentSession, type DocumentSession } from '../internal/document-session.js';
import { PERSISTENCE_PREFIX, resolvePersistenceKey } from '../internal/persistence.js';

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
 * this defect is `tests/browser/suite/defect-pins.mjs` (owner: A6).
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
