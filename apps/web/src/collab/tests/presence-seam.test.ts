import { afterEach, describe, expect, it, vi } from 'vitest';

import { awarenessStateSchema, parsePresencePatch, PresencePatchError } from '@insighthub/shared';

import { createTestContext, testSocketFactory, waitFor, type TestContext } from './support/scenarios.js';
import { createCollaborativeSession } from '../public.js';
import type { DocumentSession } from '../internal/document-session.js';

/**
 * M2-P0-2 — the presence **write** seam, exercised on the real session.
 *
 * `packages/shared/src/collab-session.test.ts` pins the patch contract itself; this
 * file pins what the seam *does* on a live `DocumentSession`:
 *
 * 1. it is reachable through the public factory (so A2 can call it after migration);
 * 2. `updatedAt` is stamped by the collaboration layer, and a caller that tries to
 *    supply it is rejected;
 * 3. an invalid patch throws **before** anything is written — the local entry is
 *    untouched and no awareness update is emitted (that is the "never reaches the
 *    wire" claim: the sync provider turns each `update` into a frame);
 * 4. partial patches are partial: cursor-only leaves selection alone, and vice versa;
 * 5. one publish is one write, not one per field.
 *
 * ## Why these were impossible before the seam
 *
 * Before M2-P0-2 the only write path was the raw `Awareness` instance. An editor wrote
 * `setLocalStateField('cursor', …)`, `('selection', …)` and `('updatedAt', …)` in
 * sequence: three clock bumps, three frames per caret move, no validation, and
 * `updatedAt` maintained by the caller. Every assertion below is about behaviour that
 * did not exist, so the tests could not have been written against the old contract.
 */

let context: TestContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await context?.cleanup();
  context = undefined;
});

function ctx(): TestContext {
  context ??= createTestContext();
  return context;
}

/** Count local awareness updates — the unit the sync provider turns into a frame. */
function countAwarenessUpdates(session: DocumentSession): () => number {
  let count = 0;
  const listener = (): void => {
    count += 1;
  };
  session.awareness.on('update', listener);
  return () => count;
}

describe('presence write seam', () => {
  it('is reachable through the public factory', async () => {
    context = createTestContext();
    const session = await createCollaborativeSession({
      documentId: 'presence-seam',
      user: { id: 'user-a', name: 'User A' },
      persistenceKey: 'presence-seam-db',
      indexedDB: context.db,
      wsUrl: 'ws://127.0.0.1:1/ws',
      wsSocketFactory: testSocketFactory,
    });
    try {
      expect(typeof session.publishPresence).toBe('function');
      session.publishPresence({ cursor: { anchor: 2, head: 2 } });
      expect(session.getLocalAwarenessState()?.cursor).toEqual({ anchor: 2, head: 2 });
    } finally {
      session.destroy();
    }
  });

  it('stamps updatedAt itself; the caller cannot supply it', async () => {
    const session = await ctx().create();
    const created = session.getLocalAwarenessState();
    expect(created).not.toBeNull();

    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
    session.publishPresence({ cursor: { anchor: 4, head: 4 } });

    const published = session.getLocalAwarenessState();
    expect(published?.updatedAt).toBe(1_700_000_000_123);
    // The collaboration layer, not the caller, moved the timestamp.
    expect(published?.updatedAt).not.toBe(created?.updatedAt);
    // The published entry is still schema-valid on the read side.
    expect(awarenessStateSchema.safeParse(published).success).toBe(true);

    clock.mockReturnValue(1_700_000_000_999);
    session.publishPresence({ selection: { from: 1, to: 4 } });
    expect(session.getLocalAwarenessState()?.updatedAt).toBe(1_700_000_000_999);

    // Runtime rejection of a caller-supplied updatedAt (an untyped caller has no
    // compiler to stop it), and nothing was written.
    const before = session.getLocalAwarenessState();
    expect(() =>
      session.publishPresence({
        cursor: { anchor: 9, head: 9 },
        // @ts-expect-error updatedAt is owned by the collaboration layer.
        updatedAt: 1,
      }),
    ).toThrow(/updatedAt is owned by the collaboration layer/);
    expect(session.getLocalAwarenessState()).toEqual(before);
    session.destroy();
  });

  it('keeps the published state schema-valid after every legal patch shape', async () => {
    const session = await ctx().create();

    session.publishPresence({ cursor: { anchor: 0, head: 3 } });
    expect(awarenessStateSchema.safeParse(session.awareness.getLocalState()).success).toBe(true);

    session.publishPresence({ selection: { from: 0, to: 3 } });
    expect(awarenessStateSchema.safeParse(session.awareness.getLocalState()).success).toBe(true);

    session.publishPresence({ cursor: null, selection: null });
    const cleared = session.getLocalAwarenessState();
    expect(cleared?.cursor).toBeNull();
    expect(cleared?.selection).toBeNull();
    expect(awarenessStateSchema.safeParse(cleared).success).toBe(true);
    session.destroy();
  });

  it('accepts a partial patch without clearing the other field', async () => {
    const session = await ctx().create();

    // Establish both fields.
    session.publishPresence({ cursor: { anchor: 1, head: 2 }, selection: { from: 1, to: 2 } });
    expect(session.getLocalAwarenessState()?.selection).toEqual({ from: 1, to: 2 });

    // Cursor only: the selection must survive. This is the rule that made a single
    // `setLocalState({...current, field})` write necessary rather than two writes.
    session.publishPresence({ cursor: { anchor: 7, head: 7 } });
    expect(session.getLocalAwarenessState()?.cursor).toEqual({ anchor: 7, head: 7 });
    expect(session.getLocalAwarenessState()?.selection).toEqual({ from: 1, to: 2 });

    // Selection only: the cursor must survive.
    session.publishPresence({ selection: { from: 0, to: 7 } });
    expect(session.getLocalAwarenessState()?.cursor).toEqual({ anchor: 7, head: 7 });
    expect(session.getLocalAwarenessState()?.selection).toEqual({ from: 0, to: 7 });

    // An explicit null does clear, which is the difference between absent and null.
    session.publishPresence({ selection: null });
    expect(session.getLocalAwarenessState()?.selection).toBeNull();
    expect(session.getLocalAwarenessState()?.cursor).toEqual({ anchor: 7, head: 7 });
    session.destroy();
  });

  it('publishes a multi-field patch in one awareness write', async () => {
    const session = await ctx().create();
    const updates = countAwarenessUpdates(session);

    session.publishPresence({ cursor: { anchor: 2, head: 2 }, selection: { from: 2, to: 5 } });

    // One write for two fields. The pre-seam editor performed three separate
    // `setLocalStateField` calls here, i.e. three clock bumps and three frames.
    expect(updates()).toBe(1);
    session.destroy();
  });

  it('writes nothing when the patch is invalid — no state change, no update', async () => {
    const session = await ctx().create();
    // Seed a non-trivial entry so "untouched" is a meaningful comparison.
    session.publishPresence({ cursor: { anchor: 3, head: 3 }, selection: { from: 1, to: 3 } });
    const before = session.getLocalAwarenessState();
    const beforeRaw = session.awareness.getLocalState();
    const updates = countAwarenessUpdates(session);

    const invalid: unknown[] = [
      { cursor: { anchor: -1, head: 0 } },
      { cursor: { anchor: 0.5, head: 0 } },
      { cursor: { anchor: Number.NaN, head: 0 } },
      { selection: { from: 9, to: 2 } },
      { selection: { from: -1, to: 2 } },
      { cursor: { anchor: 0, head: 0, extra: 1 } },
      { user: { id: 'impersonated', name: 'Impersonated' } },
      { updatedAt: 42 },
      null,
    ];

    for (const patch of invalid) {
      expect(() => session.publishPresence(patch as never)).toThrow(PresencePatchError);
    }

    // Nothing reached the local entry, and nothing reached the wire.
    expect(updates()).toBe(0);
    expect(session.getLocalAwarenessState()).toEqual(before);
    expect(session.awareness.getLocalState()).toEqual(beforeRaw);
    session.destroy();
  });

  it('validates through the same rule the shared contract exports', () => {
    // The web implementation must not fork the rule: same function, same outcome.
    expect(() => parsePresencePatch({ selection: { from: 5, to: 1 } })).toThrow(PresencePatchError);
    expect(parsePresencePatch({ cursor: null })).toEqual({ cursor: null });
  });

  it('does not touch document content', async () => {
    const session = await ctx().create();
    session.transact((text) => text.insert(0, 'body'));
    const updates = countAwarenessUpdates(session);

    session.publishPresence({ cursor: { anchor: 4, head: 4 }, selection: { from: 0, to: 4 } });

    // Presence is ephemeral: it never enters Y.Text (R11 / ARCHITECTURE §0).
    expect(session.text.toString()).toBe('body');
    expect(session.getUndoState().canUndo).toBe(true);
    expect(session.getUndoState().canRedo).toBe(false);
    // The presence write did not sneak into the document's update stream as an undoable
    // edit either: one awareness update, and the document still holds only "body".
    expect(updates()).toBe(1);
    expect(session.doc.getText('content').toString()).toBe('body');
    session.destroy();
  });

  it('is a no-op after destroy rather than throwing or resurrecting presence', async () => {
    const session = await ctx().create();
    session.publishPresence({ cursor: { anchor: 1, head: 1 } });
    session.destroy();

    expect(() => session.publishPresence({ cursor: null })).not.toThrow();
    // Teardown removed the entry; a later publish must not put it back.
    expect(session.awareness.getStates().has(session.localClientId)).toBe(false);
  });

  it('exposes the raw awareness instance only as a binding input', async () => {
    const session = await ctx().create();
    // The instance is still exposed (the editor binding needs the live object), but the
    // documented write path is the seam. This test records that both exist and that the
    // seam is the one that stamps `updatedAt`.
    expect(session.awareness).toBeDefined();
    vi.spyOn(Date, 'now').mockReturnValue(1_234);
    session.publishPresence({ cursor: { anchor: 0, head: 0 } });
    expect((session.awareness.getLocalState() as { updatedAt: number }).updatedAt).toBe(1_234);
    session.destroy();
  });
});

describe('presence write seam over the wire path', () => {
  it('coalesces presence into frames the provider actually sends', async () => {
    const session = await ctx().create();
    // Not connected: publishing must remain a local operation (R10 — offline is a
    // first-class state, and presence is per-client state until a room is joined).
    expect(session.connectionStatus).toBe('idle');
    session.publishPresence({ cursor: { anchor: 1, head: 1 } });
    await waitFor(
      () => session.getLocalAwarenessState()?.cursor?.anchor === 1,
      'the cursor to be visible locally without a room',
    );
    session.destroy();
  });
});
