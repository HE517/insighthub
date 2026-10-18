/**
 * Tests for the presence derivation.
 *
 * These cover A2 acceptance criteria 7 and 8 — "collaborator UI uses the
 * validated accessor" and "malformed awareness never reaches the UI" — at the
 * layer where the decision is actually made.
 */
import { describe, expect, it, vi } from 'vitest';

import type { CollaboratorInfo } from '@insighthub/shared';

import {
  collectRemoteCursors,
  colorForClient,
  observeAwareness,
  type AwarenessView,
} from './remoteCursors.js';

const SELF = 1;
const PEER = 42;

function collaborator(overrides: Partial<CollaboratorInfo> = {}): CollaboratorInfo {
  return {
    clientId: PEER,
    user: { id: 'u-1', name: 'Ada', color: '#ff0000' },
    cursor: { anchor: 3, head: 3 },
    selection: null,
    ...overrides,
  };
}

/** Minimal `AwarenessView` backed by a plain map. */
function awarenessWith(entries: [number, unknown][], clientID = SELF): AwarenessView {
  const states = new Map<number, unknown>(entries);
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  return {
    clientID,
    getStates: () => states,
    on: (event, handler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    off: (event, handler) => {
      handlers.get(event)?.delete(handler);
    },
  };
}

function validState(head: number, name = 'Ada') {
  return {
    user: { id: 'u-1', name, color: '#ff0000' },
    cursor: { anchor: head, head },
    selection: null,
    updatedAt: 1,
  };
}

describe('collectRemoteCursors', () => {
  it('returns a cursor for a validated peer that is in the collaborator list', () => {
    const awareness = awarenessWith([[PEER, validState(7)]]);
    const cursors = collectRemoteCursors(awareness, [collaborator()], 100, SELF);

    expect(cursors).toHaveLength(1);
    expect(cursors[0]).toMatchObject({
      clientId: PEER,
      head: 7,
      anchor: 7,
      user: { name: 'Ada', color: '#ff0000' },
      selection: null,
    });
  });

  it('never renders the local client', () => {
    const awareness = awarenessWith([[SELF, validState(2)]]);
    expect(collectRemoteCursors(awareness, [collaborator({ clientId: SELF })], 100, SELF)).toEqual(
      [],
    );
  });

  it('drops an entry whose payload is malformed', () => {
    const awareness = awarenessWith([[PEER, { user: { name: 'no id' } }]]);
    expect(collectRemoteCursors(awareness, [collaborator()], 100, SELF)).toEqual([]);
  });

  it('drops a malformed entry even when the collaborator list claims the client exists', () => {
    // Defence in depth: the accessor should already have filtered this payload,
    // but a malformed name must not be renderable under any circumstances.
    const awareness = awarenessWith([[PEER, { user: { id: 'u-1', name: 42 } }]]);
    expect(collectRemoteCursors(awareness, [collaborator()], 100, SELF)).toEqual([]);
  });

  it('drops a valid entry that cannot be attributed to a validated collaborator', () => {
    const awareness = awarenessWith([[PEER, validState(7)]]);
    expect(collectRemoteCursors(awareness, [], 100, SELF)).toEqual([]);
  });

  it('clamps offsets beyond the local document', () => {
    // A peer may legitimately be ahead of us; a range outside the document would
    // throw in CodeMirror.
    const awareness = awarenessWith([[PEER, validState(999)]]);
    const cursors = collectRemoteCursors(awareness, [collaborator()], 10, SELF);
    expect(cursors[0]!.head).toBe(10);
  });

  it('normalises a backwards selection into from <= to', () => {
    const awareness = awarenessWith([
      [PEER, { ...validState(0), cursor: { anchor: 9, head: 2 }, selection: { from: 2, to: 9 } }],
    ]);
    const cursors = collectRemoteCursors(awareness, [collaborator()], 100, SELF);
    expect(cursors[0]!.selection).toEqual({ from: 2, to: 9 });
    expect(cursors[0]!.head).toBe(2);
    expect(cursors[0]!.anchor).toBe(9);
  });

  it('renders a published selection even while the caret stayed collapsed', () => {
    // Two independent fields (`CONTRACTS.md` §9): a peer may update only
    // `selection`. Deriving the range from `cursor` alone dropped it, so a remote
    // selection never rendered.
    const awareness = awarenessWith([
      [PEER, { ...validState(0), cursor: { anchor: 5, head: 5 }, selection: { from: 2, to: 8 } }],
    ]);
    const cursors = collectRemoteCursors(awareness, [collaborator()], 100, SELF);

    expect(cursors[0]!.head).toBe(5);
    expect(cursors[0]!.selection).toEqual({ from: 2, to: 8 });
  });

  it('keeps the caret at the cursor head when a selection is published', () => {
    const awareness = awarenessWith([
      [PEER, { ...validState(0), cursor: { anchor: 8, head: 2 }, selection: { from: 2, to: 8 } }],
    ]);
    const cursors = collectRemoteCursors(awareness, [collaborator()], 100, SELF);

    // `head` is where the caret is drawn, and it must not be normalised away.
    expect(cursors[0]!.head).toBe(2);
    expect(cursors[0]!.anchor).toBe(8);
    expect(cursors[0]!.selection).toEqual({ from: 2, to: 8 });
  });

  it('falls back to the selection when the peer published no cursor', () => {
    const awareness = awarenessWith([
      [PEER, { ...validState(0), cursor: null, selection: { from: 1, to: 4 } }],
    ]);
    const cursors = collectRemoteCursors(awareness, [collaborator()], 100, SELF);
    expect(cursors[0]!.selection).toEqual({ from: 1, to: 4 });
  });

  it('produces no cursor when the peer has neither cursor nor selection', () => {
    const awareness = awarenessWith([[PEER, { ...validState(0), cursor: null, selection: null }]]);
    expect(collectRemoteCursors(awareness, [collaborator()], 100, SELF)).toEqual([]);
  });

  it('assigns a deterministic fallback colour when the peer published none', () => {
    const awareness = awarenessWith([[PEER, validState(1)]]);
    const noColor = collaborator({ user: { id: 'u-1', name: 'Ada' } });
    const first = collectRemoteCursors(awareness, [noColor], 100, SELF);
    const second = collectRemoteCursors(awareness, [noColor], 100, SELF);
    expect(first[0]!.user.color).toBe(second[0]!.user.color);
    expect(first[0]!.user.color).toBe(colorForClient(PEER));
  });
});

describe('observeAwareness', () => {
  it('notifies on change and stops after unsubscribe', () => {
    const handlers = new Map<string, Set<(...args: never[]) => void>>();
    const awareness: AwarenessView = {
      clientID: SELF,
      getStates: () => new Map(),
      on: (event, handler) => {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
      },
      off: (event, handler) => {
        handlers.get(event)?.delete(handler);
      },
    };

    const listener = vi.fn();
    const unsubscribe = observeAwareness(awareness, listener);

    // Both the `change` and the `update` event are observed (removal versus
    // movement), and either one must notify.
    expect(handlers.get('change')?.size).toBe(1);
    expect(handlers.get('update')?.size).toBe(1);
    for (const handler of handlers.get('change') ?? []) (handler as () => void)();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(handlers.get('change')?.size).toBe(0);
    expect(handlers.get('update')?.size).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
