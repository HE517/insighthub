/**
 * Lifecycle tests for the remote-cursor overlay (DEFECT P0-3).
 *
 * What these can honestly prove in Node: that the presenter never dispatches while
 * it is being constructed, that it coalesces a turn into one dispatch, and that
 * teardown leaves no listener behind and no dispatch in flight. What they cannot
 * prove is that a real `EditorView` survives the mount - `ViewPlugin` needs a DOM -
 * so that claim stays with the real-browser suite (`cursors/*` in
 * `tests/browser/suite/03-realtime.mjs`).
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { CollaboratorInfo } from '@insighthub/shared';

import { createRemoteCursorPresence, type RemoteCursorPresence } from './remoteCursorPresence.js';
import type { AwarenessView, RemoteCursor } from './remoteCursors.js';

const SELF = 1;
const PEER = 42;

type Dispatch = (cursors: readonly RemoteCursor[]) => void;

function collaborator(overrides: Partial<CollaboratorInfo> = {}): CollaboratorInfo {
  return {
    clientId: PEER,
    user: { id: 'u-42', name: 'Ada', color: '#ff0000' },
    cursor: { anchor: 3, head: 3 },
    selection: null,
    ...overrides,
  };
}

function stateAt(head: number, name = 'Ada') {
  return {
    user: { id: 'u-42', name, color: '#ff0000' },
    cursor: { anchor: head, head },
    selection: null,
    updatedAt: 1,
  };
}

/** An awareness double that records handlers so they can be fired on demand. */
function createAwareness(entries: [number, unknown][]) {
  const states = new Map<number, unknown>(entries);
  const handlers = new Map<string, Set<(...args: never[]) => void>>();

  const awareness: AwarenessView = {
    clientID: SELF,
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

  return {
    awareness,
    states,
    /** Fire one awareness event, exactly as `y-protocols` would. */
    emit(event: 'change' | 'update'): void {
      for (const handler of [...(handlers.get(event) ?? [])]) (handler as () => void)();
    },
    listenerCount(event: 'change' | 'update'): number {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

/** A deferral that runs only when the test says the turn is over. */
function createScheduler() {
  const tasks: (() => void)[] = [];
  return {
    defer: (task: () => void): void => {
      tasks.push(task);
    },
    /** Run every queued task, in order, once. */
    flush(): void {
      for (const task of tasks.splice(0, tasks.length)) task();
    },
    pending(): number {
      return tasks.length;
    },
  };
}

interface Harness {
  presence: RemoteCursorPresence;
  dispatch: Mock<Dispatch>;
  documentLength: Mock<() => number>;
  scheduler: ReturnType<typeof createScheduler>;
  awareness: ReturnType<typeof createAwareness>;
  /** The cursor list of each dispatch, in call order. */
  dispatches(): readonly (readonly RemoteCursor[])[];
}

function createHarness(entries: [number, unknown][] = [[PEER, stateAt(4)]]): Harness {
  const awareness = createAwareness(entries);
  const scheduler = createScheduler();
  const dispatch = vi.fn<Dispatch>();
  const documentLength = vi.fn<() => number>(() => 100);

  const presence = createRemoteCursorPresence({
    awareness: awareness.awareness,
    getCollaborators: () => [collaborator()],
    localClientId: SELF,
    repaint: { documentLength, dispatch },
    defer: scheduler.defer,
  });

  return {
    presence,
    dispatch,
    documentLength,
    scheduler,
    awareness,
    dispatches: () => dispatch.mock.calls.map((call) => call[0]),
  };
}

describe('remote cursor presence — no dispatch during construction', () => {
  it('does not touch the view while the plugin is being constructed', () => {
    const harness = createHarness();

    // The decisive P0-3 assertion: in the application this code runs inside a
    // `ViewPlugin` constructor, where a dispatch throws and kills the plugin.
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(harness.scheduler.pending()).toBe(1);
  });

  it('paints once on the next turn, with the derived cursors', () => {
    const harness = createHarness();

    harness.scheduler.flush();

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    expect(harness.documentLength).toHaveBeenCalledTimes(1);
    expect(harness.dispatches()[0]).toHaveLength(1);
    expect(harness.dispatches()[0]![0]).toMatchObject({
      clientId: PEER,
      head: 4,
      user: { name: 'Ada', color: '#ff0000' },
    });
  });

  it('never paints the local client as a remote cursor', () => {
    const harness = createHarness([[SELF, stateAt(9)]]);
    harness.scheduler.flush();

    expect(harness.dispatches()[0]).toEqual([]);
  });
});

describe('remote cursor presence — coalescing', () => {
  it('collapses an awareness change and its update event into one repaint', () => {
    const harness = createHarness();
    harness.scheduler.flush();
    expect(harness.dispatch).toHaveBeenCalledTimes(1);

    // `y-protocols` emits both events for a single awareness change.
    harness.awareness.emit('change');
    harness.awareness.emit('update');

    expect(harness.scheduler.pending()).toBe(1);
    harness.scheduler.flush();
    expect(harness.dispatch).toHaveBeenCalledTimes(2);
  });

  it('dispatches the state as it is when the paint runs, not when it was scheduled', () => {
    const harness = createHarness([[PEER, stateAt(1)]]);
    harness.scheduler.flush();

    harness.awareness.emit('change');
    // The peer moves again before the scheduled paint runs.
    harness.awareness.states.set(PEER, stateAt(7));
    harness.scheduler.flush();

    expect(harness.dispatches()[1]![0]!.head).toBe(7);
  });

  it('reads the collaborator list from the validated accessor on every paint', () => {
    const awareness = createAwareness([[PEER, stateAt(2)]]);
    const scheduler = createScheduler();
    const dispatch = vi.fn<Dispatch>();
    let collaborators: CollaboratorInfo[] = [collaborator({ user: { id: 'u-42', name: 'Ada' } })];

    createRemoteCursorPresence({
      awareness: awareness.awareness,
      getCollaborators: () => collaborators,
      localClientId: SELF,
      repaint: { documentLength: () => 100, dispatch },
      defer: scheduler.defer,
    });
    scheduler.flush();
    expect(dispatch.mock.calls[0]![0][0]!.user.name).toBe('Ada');

    // A rename arrives through the accessor, not through the awareness payload.
    collaborators = [collaborator({ user: { id: 'u-42', name: 'Ada Lovelace' } })];
    awareness.emit('change');
    scheduler.flush();

    expect(dispatch.mock.calls[1]![0][0]!.user.name).toBe('Ada Lovelace');
  });
});

describe('remote cursor presence — listener lifecycle', () => {
  it('subscribes to both awareness events', () => {
    const harness = createHarness();
    expect(harness.awareness.listenerCount('change')).toBe(1);
    expect(harness.awareness.listenerCount('update')).toBe(1);
  });

  it('unsubscribes from both events on destroy', () => {
    const harness = createHarness();
    harness.presence.destroy();

    expect(harness.presence.destroyed).toBe(true);
    expect(harness.awareness.listenerCount('change')).toBe(0);
    expect(harness.awareness.listenerCount('update')).toBe(0);
  });

  it('stops repainting after destroy', () => {
    const harness = createHarness();
    harness.scheduler.flush();
    expect(harness.dispatch).toHaveBeenCalledTimes(1);

    harness.presence.destroy();
    harness.awareness.emit('change');
    harness.awareness.emit('update');
    harness.scheduler.flush();

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it('drops the mount-time paint when the plugin is destroyed before the turn ends', () => {
    const harness = createHarness();
    expect(harness.scheduler.pending()).toBe(1);

    // The reconfigure/unmount case: the plugin is created and torn down in the same
    // turn, so the deferred paint must not reach the dead view.
    harness.presence.destroy();
    harness.scheduler.flush();

    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it('drops a scheduled awareness repaint when destroy happens first', () => {
    const harness = createHarness();
    harness.scheduler.flush();

    harness.awareness.emit('change');
    expect(harness.scheduler.pending()).toBe(1);

    harness.presence.destroy();
    harness.scheduler.flush();

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on destroy', () => {
    const harness = createHarness();
    harness.presence.destroy();
    expect(() => harness.presence.destroy()).not.toThrow();
    expect(harness.awareness.listenerCount('change')).toBe(0);
  });
});
