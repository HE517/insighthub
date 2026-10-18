/**
 * M2-P0-2 step 2: the editor publishes presence through the frozen seam only.
 *
 * ## What is proven here
 *
 * The migration replaced three raw `awareness.setLocalStateField` calls (cursor,
 * selection, `updatedAt`) with one `session.publishPresence(patch)`. These tests pin the
 * properties that made the old code wrong, so a future edit cannot quietly reintroduce
 * them:
 *
 * - exactly **one** seam call per cursor/selection update;
 * - `selection: null` for a collapsed cursor, `{ from, to }` for a real selection;
 * - A2 never sends `updatedAt` (its absence is asserted, not assumed);
 * - a partial patch does not clear the other field (the seam's merge rule);
 * - an invalid patch throws before writing and never becomes visible to peers.
 *
 * ## Why these run against `FakeCollaborativeSession`
 *
 * The fake implements `CollaborativeSession` and reuses the shared `parsePresencePatch`
 * for validation, so these tests exercise the same contract the real session satisfies
 * without opening a socket or IndexedDB. They are contract tests, not browser evidence:
 * the component-level wiring (`EditorView` update -> `publishEditorPresence`) still needs
 * a DOM and stays with the browser suite (A6).
 */
import { describe, expect, it, vi } from 'vitest';

import { PRESENCE_PATCH_FIELDS, PresencePatchError, type PresencePatch } from '@insighthub/shared';

import {
  presencePatchForRange,
  publishEditorPresence,
  type PresencePublisher,
} from './editorPresence.js';
import { createFakeCollaborativeSession } from './testing/fakeCollaborativeSession.js';

function createSession() {
  return createFakeCollaborativeSession({
    documentId: 'presence-seam',
    user: { id: 'me', name: 'Me' },
    initialText: 'hello world',
  });
}

/** A publisher that records what the editor asked it to publish. */
function recordingPublisher() {
  const published: PresencePatch[] = [];
  const publisher: PresencePublisher = {
    publishPresence: (patch) => {
      published.push(patch);
    },
  };
  return { publisher, published };
}

describe('presencePatchForRange', () => {
  it('publishes a collapsed cursor with selection null', () => {
    expect(presencePatchForRange({ anchor: 4, head: 4 })).toEqual({
      cursor: { anchor: 4, head: 4 },
      selection: null,
    });
  });

  it('publishes a real selection normalised to from <= to', () => {
    expect(presencePatchForRange({ anchor: 9, head: 2 })).toEqual({
      cursor: { anchor: 9, head: 2 },
      selection: { from: 2, to: 9 },
    });
  });

  it('keeps a forward selection as given', () => {
    expect(presencePatchForRange({ anchor: 2, head: 9 })).toEqual({
      cursor: { anchor: 2, head: 9 },
      selection: { from: 2, to: 9 },
    });
  });

  it('never names a field outside the contract', () => {
    const patch = presencePatchForRange({ anchor: 1, head: 3 });
    expect(Object.keys(patch).sort()).toEqual([...PRESENCE_PATCH_FIELDS].sort());
    // `updatedAt` is the collaboration layer's; sending it is a contract violation.
    expect(patch).not.toHaveProperty('updatedAt');
    expect(patch).not.toHaveProperty('user');
  });
});

describe('publishEditorPresence', () => {
  it('calls the seam exactly once per cursor update', () => {
    const { publisher, published } = recordingPublisher();

    publishEditorPresence(publisher, { anchor: 3, head: 3 });

    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({ cursor: { anchor: 3, head: 3 }, selection: null });
  });

  it('calls the seam once even when the selection changes', () => {
    const { publisher, published } = recordingPublisher();

    publishEditorPresence(publisher, { anchor: 0, head: 5 });

    // One call, not the old three: a single awareness update means a single frame.
    expect(published).toHaveLength(1);
    expect(published[0]?.selection).toEqual({ from: 0, to: 5 });
  });

  it('calls the seam once per update across a sequence of movements', () => {
    const { publisher, published } = recordingPublisher();

    publishEditorPresence(publisher, { anchor: 1, head: 1 });
    publishEditorPresence(publisher, { anchor: 2, head: 2 });
    publishEditorPresence(publisher, { anchor: 2, head: 4 });

    expect(published).toHaveLength(3);
  });
});

describe('publishPresence seam behaviour the editor relies on', () => {
  it('writes cursor and selection into the local state', () => {
    const session = createSession();

    session.publishPresence({ cursor: { anchor: 3, head: 3 }, selection: null });

    const local = session.getLocalAwarenessState();
    expect(local?.cursor).toEqual({ anchor: 3, head: 3 });
    expect(local?.selection).toBeNull();
    session.destroy();
  });

  it('clears the selection when the cursor collapses back', () => {
    const session = createSession();

    session.publishPresence({ cursor: { anchor: 0, head: 5 }, selection: { from: 0, to: 5 } });
    expect(session.getLocalAwarenessState()?.selection).toEqual({ from: 0, to: 5 });

    session.publishPresence({ cursor: { anchor: 5, head: 5 }, selection: null });
    expect(session.getLocalAwarenessState()?.selection).toBeNull();
    session.destroy();
  });

  it('does not clear an existing selection when only the cursor is published', () => {
    const session = createSession();

    session.publishPresence({ cursor: { anchor: 0, head: 5 }, selection: { from: 0, to: 5 } });
    // The partial patch: `selection` is absent, not `null`, so it must survive.
    session.publishPresence({ cursor: { anchor: 1, head: 5 } });

    const local = session.getLocalAwarenessState();
    expect(local?.cursor).toEqual({ anchor: 1, head: 5 });
    expect(local?.selection).toEqual({ from: 0, to: 5 });
    session.destroy();
  });

  it('does not clear an existing cursor when only the selection is published', () => {
    const session = createSession();

    session.publishPresence({ cursor: { anchor: 4, head: 4 }, selection: null });
    session.publishPresence({ selection: { from: 1, to: 2 } });

    const local = session.getLocalAwarenessState();
    expect(local?.cursor).toEqual({ anchor: 4, head: 4 });
    expect(local?.selection).toEqual({ from: 1, to: 2 });
    session.destroy();
  });

  it('stamps updatedAt in the collaboration layer, not in A2', () => {
    const session = createSession();

    const before = session.getLocalAwarenessState()?.updatedAt ?? 0;
    session.publishPresence({ cursor: { anchor: 2, head: 2 } });
    const after = session.getLocalAwarenessState()?.updatedAt ?? 0;

    // The caller sent no timestamp; the seam added a valid one.
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeGreaterThanOrEqual(before);
    session.destroy();
  });

  it('rejects an invalid patch before writing and keeps peers unaffected', () => {
    const session = createSession();
    session.publishPresence({ cursor: { anchor: 1, head: 1 }, selection: null });
    const before = session.getLocalAwarenessState();
    const peersBefore = session.getCollaborators();

    // `selection.from > selection.to` violates `awarenessSelectionSchema`.
    expect(() =>
      session.publishPresence({ selection: { from: 5, to: 1 } } as never),
    ).toThrow(PresencePatchError);

    // Nothing was written: the local entry is byte-identical and no peer-visible
    // projection changed, so an invalid patch cannot reach the wire.
    expect(session.getLocalAwarenessState()).toEqual(before);
    expect(session.getCollaborators()).toEqual(peersBefore);
    session.destroy();
  });

  it('rejects a patch that tries to smuggle updatedAt', () => {
    const session = createSession();

    // An untyped caller has no compiler to stop it, so the seam rejects it at runtime.
    expect(() =>
      session.publishPresence({ cursor: { anchor: 1, head: 1 }, updatedAt: 1 } as never),
    ).toThrow(PresencePatchError);
    session.destroy();
  });

  it('rejects a negative cursor offset before writing', () => {
    const session = createSession();
    const before = session.getLocalAwarenessState();

    expect(() => session.publishPresence({ cursor: { anchor: -1, head: 0 } })).toThrow(
      PresencePatchError,
    );

    expect(session.getLocalAwarenessState()).toEqual(before);
    session.destroy();
  });

  it('is a no-op after destroy, so a late repaint cannot resurrect presence', () => {
    const session = createSession();
    session.destroy();

    expect(() => session.publishPresence({ cursor: { anchor: 1, head: 1 } })).not.toThrow();
    expect(session.getLocalAwarenessState()).toBeNull();
  });

  it('still validates the patch on a destroyed session', () => {
    const session = createSession();
    session.destroy();

    // Validation is a caller-bug guard, not a liveness check: a bad patch is bad
    // whether or not the session is alive (mirrors `document-session.ts`).
    expect(() => session.publishPresence({ cursor: { anchor: 1.5, head: 1 } })).toThrow(
      PresencePatchError,
    );
  });
});

describe('editor presence integration', () => {
  it('publishes the editor range through the seam and peers can read it back', () => {
    const session = createSession();
    // A second client in the room sees this client's entry through the validated accessor.
    const peerView = () => session.getCollaborators();

    publishEditorPresence(session, { anchor: 2, head: 7 });

    const self = peerView().find((entry) => entry.clientId === session.localClientId);
    expect(self?.cursor).toEqual({ anchor: 2, head: 7 });
    expect(self?.selection).toEqual({ from: 2, to: 7 });
    session.destroy();
  });

  it('publishes exactly one seam call per editor selection update', () => {
    const session = createSession();
    const spy = vi.spyOn(session, 'publishPresence');

    publishEditorPresence(session, { anchor: 0, head: 0 });
    publishEditorPresence(session, { anchor: 0, head: 4 });

    expect(spy).toHaveBeenCalledTimes(2);
    // `updatedAt` is never part of what the editor sends.
    for (const call of spy.mock.calls) {
      expect(call[0]).not.toHaveProperty('updatedAt');
    }
    spy.mockRestore();
    session.destroy();
  });

  it('touches only the seam member, so it has no handle on the raw awareness instance', () => {
    const published: PresencePatch[] = [];
    const touched: string[] = [];
    // A publisher that records every property the editor reaches for. `awareness` is
    // not on `PresencePublisher` (`Pick<CollaborativeSession, 'publishPresence'>`), so
    // reading it at all would show up here - which is what makes "A2 cannot write
    // through the raw instance" a runtime property, not just a convention.
    const guarded = new Proxy({} as PresencePublisher, {
      get(_target, property): unknown {
        touched.push(String(property));
        if (property === 'publishPresence') {
          return (patch: PresencePatch) => published.push(patch);
        }
        return undefined;
      },
    });

    publishEditorPresence(guarded, { anchor: 3, head: 3 });

    expect(touched).toEqual(['publishPresence']);
    expect(published).toHaveLength(1);
  });
});
