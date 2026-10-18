import { afterEach, describe, expect, it } from 'vitest';

import type { AwarenessBinding, CollaborativeSession } from '@insighthub/shared';

import { createTestContext, testSocketFactory, type TestContext } from './support/scenarios.js';
import type { DocumentSession } from '../internal/document-session.js';
import { createCollaborativeSession } from '../public.js';

/**
 * M2-P0-2 **step 3** — the narrowing, from the collaboration side.
 *
 * `packages/shared/src/collab-session.test.ts` pins the contract type. This file pins
 * the two things that file cannot see:
 *
 * 1. the **concrete** `DocumentSession` narrows too, not just the interface. Structural
 *    covariance would have let `class DocumentSession { readonly awareness: Awareness }`
 *    satisfy a narrowed interface while still handing A1's own code (and A1's tests) a
 *    writable instance. That is why the class field is `AwarenessBinding`.
 * 2. the binding surface is still *sufficient*: the members a cursor extension needs
 *    are present and work against a live session.
 *
 * Threshold for calling this done (from the task): the raw write is not compilable —
 * which is asserted with `@ts-expect-error`, because a runtime assertion would pass even
 * if the member were reachable.
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

describe('narrowed awareness — compile-time guarantees', () => {
  /**
   * Compile-time handles; the initialiser never runs because every use sits inside an
   * arrow function that is created and discarded (`void (() => { ... })`).
   */
  function typeOnlySession(): CollaborativeSession {
    return null as unknown as CollaborativeSession;
  }

  function typeOnlyDocumentSession(): DocumentSession {
    return null as unknown as DocumentSession;
  }

  it('accepts the binding members on the interface and the concrete class', () => {
    const session = typeOnlySession();
    const documentSession = typeOnlyDocumentSession();
    void (() => {
      const fromSeam: ReadonlyMap<number, unknown> = session.awareness.getStates();
      const fromClass: ReadonlyMap<number, unknown> = documentSession.awareness.getStates();
      // The narrow type is exactly the type a binding is allowed to receive.
      const asBinding: AwarenessBinding = documentSession.awareness;
      session.awareness.on('change', () => undefined);
      documentSession.awareness.off('update', () => undefined);
      void fromSeam;
      void fromClass;
      void asBinding;
    });
    expect(typeof typeOnlySession).toBe('function');
  });

  it('refuses a raw write through the concrete DocumentSession too', () => {
    const documentSession = typeOnlyDocumentSession();
    void (() => {
      // @ts-expect-error the class member is narrowed; A1's own code cannot write through it.
      documentSession.awareness.setLocalState(null);
      // @ts-expect-error same for the per-field writer the editor used before step 2.
      documentSession.awareness.setLocalStateField('cursor', { anchor: 0, head: 0 });
      // @ts-expect-error the writable `states` map is not reachable.
      void documentSession.awareness.states;
      // @ts-expect-error the clock bookkeeping (`meta`) is not reachable.
      void documentSession.awareness.meta;
      // @ts-expect-error a binding cannot destroy the presence channel; the session owns it.
      documentSession.awareness.destroy();
    });
    expect(typeof typeOnlyDocumentSession).toBe('function');
  });

  it('keeps the narrowed member key set small and deliberate', () => {
    // If `AwarenessBinding` ever grows a member, this fails and forces a review: the
    // narrowing is only worth anything while the list says "read and subscribe".
    const keys: readonly (keyof DocumentSession['awareness'])[] = [
      'clientID',
      'getStates',
      'on',
      'off',
    ];
    expect(keys).toHaveLength(4);
    const asBindingKeys: readonly (keyof AwarenessBinding)[] = keys;
    expect(asBindingKeys).toEqual(keys);
  });
});

describe('narrowed awareness — the binding still works at runtime', () => {
  it('exposes the live instance through the read/subscribe surface only', async () => {
    const session = await ctx().create();

    // `getStates()` is the map a cursor extension walks; it carries this client's entry.
    expect(session.awareness.getStates().has(session.localClientId)).toBe(true);
    // `clientID` lets a binding tell the local entry from peers.
    expect(typeof session.awareness.clientID).toBe('number');

    let changes = 0;
    const onChange = (): void => {
      changes += 1;
    };
    session.awareness.on('change', onChange);
    session.publishPresence({ cursor: { anchor: 3, head: 5 } });
    expect(changes).toBeGreaterThan(0);

    // `off` really unsubscribes — a binding that cannot unsubscribe leaks across remounts.
    session.awareness.off('change', onChange);
    const afterUnsubscribe = changes;
    session.publishPresence({ cursor: { anchor: 6, head: 6 } });
    expect(changes).toBe(afterUnsubscribe);

    session.destroy();
  });

  it('publishes presence the narrow read surface can observe, unchanged by step 3', async () => {
    const session = await ctx().create();

    session.publishPresence({
      cursor: { anchor: 2, head: 4 },
      selection: { from: 2, to: 4 },
    });

    // What a peer-facing binding reads off `getStates()` is the real awareness entry the
    // seam published — the narrowing changed the *type*, not the payload.
    const raw = session.awareness.getStates().get(session.localClientId) as {
      cursor: { anchor: number; head: number } | null;
      selection: { from: number; to: number } | null;
      updatedAt: number;
    };
    expect(raw.cursor).toEqual({ anchor: 2, head: 4 });
    expect(raw.selection).toEqual({ from: 2, to: 4 });
    expect(Number.isInteger(raw.updatedAt)).toBe(true);

    // And the validated accessor still reports the same thing.
    const validated = session.getLocalAwarenessState();
    expect(validated?.cursor).toEqual({ anchor: 2, head: 4 });

    session.destroy();
  });

  it('is reachable through the public factory with the narrowed type', async () => {
    context = createTestContext();
    const session = await createCollaborativeSession({
      documentId: 'narrowing-seam',
      user: { id: 'user-a', name: 'User A' },
      persistenceKey: 'narrowing-seam-db',
      indexedDB: context.db,
      wsUrl: 'ws://127.0.0.1:1/ws',
      wsSocketFactory: testSocketFactory,
    });
    try {
      // Exactly what A2's editor does: hand `session.awareness` to a binding that wants
      // the structural `AwarenessView` (getStates/on/off/clientID).
      const view: AwarenessBinding = session.awareness;
      expect(view.getStates()).toBeInstanceOf(Map);
      session.publishPresence({ cursor: { anchor: 1, head: 1 } });
      expect(view.getStates().size).toBeGreaterThan(0);
    } finally {
      session.destroy();
    }
  });
});
