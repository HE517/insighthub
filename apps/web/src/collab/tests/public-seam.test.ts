import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COLLAB_PUBLIC_MODULE,
  createCollaborativeSession,
  useCollaborativeDocument,
} from '../public.js';
import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { FakeIndexedDb } from './support/fake-indexeddb.js';
import type {
  CollaborativeSession,
  CollaborativeSessionOptions,
  CollaborativeSessionResult,
} from '@insighthub/shared';

/**
 * The frozen A1↔A2 seam itself.
 *
 * A2 compiles against these two functions, so their shape is part of the contract
 * (`docs/CONTRACTS.md` §8). These tests pin the two properties A2 relies on:
 *
 * 1. **Type identity.** Each function still satisfies the shared signature exactly.
 *    The checks below are compile-time (`expectTypeOf` would be equivalent); if a
 *    future edit widened a return type or changed a parameter, `pnpm typecheck`
 *    fails here rather than in A2.
 * 2. **The hook's first value is `initializing`.** Rendering the hook once (without a
 *    DOM, via `react-dom/server`) must produce the union's initial variant, and must
 *    not throw because no IndexedDB/WebSocket is available — effects do not run
 *    during server rendering, which is exactly the "async work starts in an effect"
 *    shape the contract implies.
 */

let context: TestContext | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
});

describe('frozen public seam', () => {
  it('exposes the stable module path A2 imports', () => {
    expect(COLLAB_PUBLIC_MODULE).toBe('apps/web/src/collab/public.ts');
  });

  it('keeps the factory signature and resolves to a CollaborativeSession', async () => {
    // Compile-time: assigning the functions to the shared signatures must typecheck.
    const factory: (options: CollaborativeSessionOptions) => Promise<CollaborativeSession> =
      createCollaborativeSession;
    const hook: (options: CollaborativeSessionOptions) => CollaborativeSessionResult =
      useCollaborativeDocument;
    expect(typeof factory).toBe('function');
    expect(typeof hook).toBe('function');

    context = createTestContext();
    const session = await factory({
      documentId: 'seam-check',
      user: { id: 'user-a', name: 'User A' },
      persistenceKey: 'seam-check-db',
      wsUrl: 'ws://127.0.0.1:1/ws',
      wsSocketFactory: testSocketFactory,
      indexedDB: context.db,
    });
    // The frozen lifecycle: active from local state, no network gate.
    expect(session.state).toBe('active');
    expect(session.documentId).toBe('seam-check');
    expect(session.connectionStatus).toBeDefined();
    expect(session.getCollaborators()).toEqual([]);
    expect(session.getUndoState()).toEqual({ canUndo: false, canRedo: false });
    session.destroy();
  });

  it('rejects only on unrecoverable local failure', async () => {
    // A factory with no `open()` is the clearest local failure: it must reject
    // promptly instead of hanging on a database that can never be opened.
    await expect(
      createCollaborativeSession({
        documentId: 'seam-failure',
        user: { id: 'user-a', name: 'User A' },
        indexedDB: {} as never,
      }),
    ).rejects.toThrow(/IndexedDB/);
  });

  it('returns the initializing variant on first render, without side effects', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');

    const seen: CollaborativeSessionResult[] = [];
    function Probe() {
      const result = useCollaborativeDocument({
        documentId: 'seam-render',
        user: { id: 'user-a', name: 'User A' },
      });
      seen.push(result);
      return createElement('span', null, result.state);
    }

    const html = renderToStaticMarkup(createElement(Probe));
    expect(html).toContain('initializing');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ state: 'initializing' });
    // No session object is offered while initializing — that is what lets A2 narrow
    // on `result.state === 'active'` instead of checking for null.
    expect(seen[0]?.session).toBeUndefined();
    expect(seen[0]?.error).toBeUndefined();
  });

  it('never rejects for a network failure, only for local state', async () => {
    // A socket factory that always fails must not surface through the factory: the
    // document is usable offline (R10), so opening resolves and the network retries.
    context = createTestContext();
    const session = await createCollaborativeSession({
      documentId: 'seam-offline',
      user: { id: 'user-a', name: 'User A' },
      persistenceKey: 'seam-offline-db',
      wsUrl: 'ws://127.0.0.1:9/ws',
      wsSocketFactory: function FailingSocket() {
        throw new Error('no transport');
      } as unknown as typeof testSocketFactory,
      indexedDB: context.db,
    });

    expect(session.state).toBe('active');
    session.transact((text) => text.insert(0, 'works offline'));
    expect(session.text.toString()).toBe('works offline');
    // Undo history is unaffected by the failed transport.
    expect(session.getUndoState().canUndo).toBe(true);
    session.destroy();
  });

  it('does not create two sessions for one document id in one call site', async () => {
    context = createTestContext();
    const options: CollaborativeSessionOptions = {
      documentId: 'seam-single',
      user: { id: 'user-a', name: 'User A' },
      persistenceKey: 'seam-single-db',
      indexedDB: context.db,
      wsUrl: 'ws://127.0.0.1:1/ws',
      wsSocketFactory: testSocketFactory,
    };
    const first = await createCollaborativeSession(options);
    const second = await createCollaborativeSession(options);
    // `COLLAB_SESSION_CONSTRAINTS.oneSessionPerDocument` is a caller obligation; two
    // live instances must at least be independent objects with their own doc.
    expect(first).not.toBe(second);
    expect(first.doc).not.toBe(second.doc);
    first.destroy();
    second.destroy();
  });

  it('is safe to destroy a session whose transport never opens', async () => {
    context = createTestContext();
    const session = await createCollaborativeSession({
      documentId: 'seam-no-network',
      user: { id: 'user-a', name: 'User A' },
      persistenceKey: 'seam-no-network-db',
      indexedDB: context.db,
      wsUrl: 'ws://127.0.0.1:9/ws',
      // Injected explicitly: this suite must never reach the real network, not even
      // through the Node global `WebSocket`.
      wsSocketFactory: function FailingSocket() {
        throw new Error('no transport');
      } as unknown as typeof testSocketFactory,
    });
    const spy = vi.fn();
    session.subscribe(spy);
    // The network half is failing, but that is a normal offline state, not a failure
    // of the session (R10): document state stays `active` and the transport retries
    // with backoff rather than surfacing as an error.
    expect(session.state).toBe('active');
    await waitFor(
      () => session.connectionStatus === 'reconnecting',
      'the failed transport to enter reconnect backoff',
    );
    expect(() => session.destroy()).not.toThrow();
  });

  /**
   * M2-P0-3 / D-046 at the seam level.
   *
   * `internal/persistence.ts` pins the lease semantics directly; this test exists to
   * prove the fix survives the path a real caller takes — two sessions created through
   * the public factory, each injecting a different IndexedDB, one of them destroyed
   * while the other is live.
   *
   * The pre-fix module restored a single snapshot, so destroying the *earlier* session
   * put the ambient factory back while the later one was still running: a live session
   * silently resolved a database it never injected, and the last teardown left the
   * earlier session's factory on the global permanently (`docs/DECISIONS.md` D-039 §4).
   *
   * The global-identity assertions are the discriminator; the record assertions guard
   * the symptom (nothing may leak into a factory the session did not inject).
   */
  it('keeps overlapping injected factories independent through the public seam', async () => {
    const ambient = new FakeIndexedDb();
    const restoreGlobals = ambient.install();
    const factoryA = new FakeIndexedDb();
    const factoryB = new FakeIndexedDb();
    const initialDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const currentFactory = (): unknown => (globalThis as { indexedDB?: unknown }).indexedDB;
    const offlineTransport = function FailingSocket() {
      throw new Error('no transport');
    } as unknown as typeof testSocketFactory;
    let first: CollaborativeSession | undefined;
    let second: CollaborativeSession | undefined;

    try {
      first = await createCollaborativeSession({
        documentId: 'm2-p0-3-a',
        user: { id: 'user-a', name: 'User A' },
        persistenceKey: 'm2-p0-3-a',
        indexedDB: factoryA,
        wsUrl: 'ws://127.0.0.1:9/ws',
        wsSocketFactory: offlineTransport,
      });
      expect(currentFactory()).toBe(factoryA);

      second = await createCollaborativeSession({
        documentId: 'm2-p0-3-b',
        user: { id: 'user-b', name: 'User B' },
        persistenceKey: 'm2-p0-3-b',
        indexedDB: factoryB,
        wsUrl: 'ws://127.0.0.1:9/ws',
        wsSocketFactory: offlineTransport,
      });
      expect(currentFactory()).toBe(factoryB);

      // The earlier session ends first. Its teardown must not hand the global back to
      // the ambient factory while the later session is still alive.
      first.destroy();
      first = undefined;
      // `DocumentSession.destroy()` does not block on the persistence provider (it
      // fires the release and returns), so give the teardown a task boundary before
      // asserting. Without this the assertion would read the pre-teardown global and
      // pass even against the broken module.
      await new Promise((resolve) => setTimeout(resolve, 20));
      // ← RED pre-fix: the single-snapshot restore put the ambient factory back here.
      expect(currentFactory()).toBe(factoryB);

      // The still-live session keeps writing to the replica it injected.
      second.transact((text) => text.insert(0, 'still mine'));
      await waitFor(
        () => factoryB.records('m2-p0-3-b').length > 0,
        "the live session's update to reach its own injected factory",
      );
      expect(factoryA.records('m2-p0-3-b')).toEqual([]);
      expect(ambient.createdNames).toEqual([]);

      second.destroy();
      second = undefined;
      // ← RED pre-fix too: the last teardown restored the *first* session's factory, so
      // a fake factory stayed on the global with nobody owning it.
      await waitFor(
        () => currentFactory() === ambient,
        'the original ambient factory to be restored',
      );
      expect(Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')).toEqual(initialDescriptor);
      expect(currentFactory()).toBe(ambient);
    } finally {
      first?.destroy();
      second?.destroy();
      restoreGlobals();
    }
  });
});
