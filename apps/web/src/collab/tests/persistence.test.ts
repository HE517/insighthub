import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, waitFor, type TestContext } from './support/scenarios.js';
import { FakeIndexedDb } from './support/fake-indexeddb.js';
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
