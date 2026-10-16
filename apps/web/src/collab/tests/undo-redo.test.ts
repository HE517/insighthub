import { afterEach, describe, expect, it } from 'vitest';
import { TRANSACTION_ORIGINS } from '@insighthub/shared';

import { createTestContext, type TestContext } from './support/scenarios.js';

/**
 * Requirement 7: a local undo must never revert a remote collaborator's edit.
 *
 * The mechanism is origin scoping, not bookkeeping: `Y.UndoManager` is created with
 * `trackedOrigins: UNDO_TRACKED_ORIGINS` (local, ai), and anything that arrives from
 * the network is applied with `insighthub:remote` (`docs/ARCHITECTURE.md` §3.1,
 * R13). These tests apply each client's edits with the origin that client would
 * really use, then assert the merged outcome.
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

describe('collaboration-safe undo', () => {
  it('undoes only the local insert and keeps a remote insert', async () => {
    const session = await ctx().create();

    // Client A types "A" — a local, undo-tracked edit.
    session.transact((text) => text.insert(0, 'A'));
    // Client B inserts "B" at the end — arriving over the wire, so it is stamped
    // `remote` exactly as the sync provider stamps it.
    session.doc.transact(() => {
      session.text.insert(1, 'B');
    }, TRANSACTION_ORIGINS.remote);

    expect(session.text.toString()).toBe('AB');
    expect(session.getUndoState()).toEqual({ canUndo: true, canRedo: false });

    session.undo();

    // A's own edit is gone; B's remote text is untouched.
    expect(session.text.toString()).toBe('B');
    expect(session.getUndoState()).toEqual({ canUndo: false, canRedo: true });
    session.destroy();
  });

  it('redoes the local edit without restoring remote content', async () => {
    const session = await ctx().create();
    session.transact((text) => text.insert(0, 'local'));
    session.doc.transact(() => {
      session.text.insert(5, '-remote');
    }, TRANSACTION_ORIGINS.remote);

    session.undo();
    expect(session.text.toString()).toBe('-remote');
    session.redo();
    expect(session.text.toString()).toBe('local-remote');
    session.destroy();
  });

  it('does not track persistence replay as an undoable local edit', async () => {
    const session = await ctx().create();
    // Simulates the IndexedDB provider replaying a stored update at startup.
    session.doc.transact(() => {
      session.text.insert(0, 'restored');
    }, TRANSACTION_ORIGINS.persistence);

    expect(session.text.toString()).toBe('restored');
    expect(session.getUndoState()).toEqual({ canUndo: false, canRedo: false });
    session.destroy();
  });

  it('tracks accepted AI edits, because they are local in origin', async () => {
    const session = await ctx().create();
    session.transact((text) => text.insert(0, 'draft'), TRANSACTION_ORIGINS.ai);
    expect(session.getUndoState().canUndo).toBe(true);
    session.undo();
    expect(session.text.toString()).toBe('');
    session.destroy();
  });

  it('honours a caller-supplied local origin', async () => {
    const session = await ctx().create({ localOrigin: TRANSACTION_ORIGINS.ai });
    // The default origin for `transact` is the configured one, which is tracked.
    session.transact((text) => text.insert(0, 'seeded'));
    expect(session.getUndoState().canUndo).toBe(true);
    session.undo();
    expect(session.text.toString()).toBe('');
    session.destroy();
  });

  it('reports an empty undo state after a remote-only edit', async () => {
    const session = await ctx().create();
    session.doc.transact(() => {
      session.text.insert(0, 'from a peer');
    }, TRANSACTION_ORIGINS.remote);
    expect(session.getUndoState()).toEqual({ canUndo: false, canRedo: false });
    expect(() => session.undo()).not.toThrow();
    expect(session.text.toString()).toBe('from a peer');
    session.destroy();
  });
});
