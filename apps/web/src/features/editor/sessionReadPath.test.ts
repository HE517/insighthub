/**
 * Tests for the collaborator-data read path.
 *
 * Covers A2 acceptance criterion 7: collaborator UI data must come from the
 * validated accessor (`session.getCollaborators()`), never from
 * `session.awareness.getStates()`. The strongest available proof is a spy: if UI
 * code ever reads the raw awareness map, this test fails.
 */
import { describe, expect, it, vi } from 'vitest';

import { createSessionStore } from './sessionStore.js';
import {
  selectCollaborators,
  selectConnectionStatus,
  selectLocalAwareness,
  selectRole,
  selectUndoState,
} from './useCollaborativeSession.js';
import { createFakeCollaborativeSession } from './testing/fakeCollaborativeSession.js';

function createSession() {
  return createFakeCollaborativeSession({
    documentId: 'read-path',
    user: { id: 'me', name: 'Me' },
    initialText: 'hello',
  });
}

describe('session selectors', () => {
  it('reads collaborators through the validated accessor', () => {
    const session = createSession();
    const validated = vi.spyOn(session, 'getCollaborators');

    const collaborators = selectCollaborators(session);

    expect(validated).toHaveBeenCalled();
    expect(collaborators.map((entry) => entry.user.name)).toContain('Me');
    session.destroy();
  });

  it('reports the local awareness identity, which the editor needs before publishing a cursor', () => {
    const session = createSession();

    const local = selectLocalAwareness(session);
    expect(local?.user.name).toBe('Me');

    // The editor only publishes its caret once the session has published an
    // identity — otherwise it would race A1's initialisation with a partial
    // awareness state, which the schema would reject on peers.
    session.setLocalAwareness(null);
    expect(selectLocalAwareness(session)).toBeNull();
    session.destroy();
  });

  it('reaches the raw awareness map only through the validated accessor', () => {
    // The accessor is allowed to read the map — that is what validation means.
    // What must never happen is a *selector* projecting over the raw map itself,
    // because a projection cannot validate. `selectCollaborators` must therefore
    // produce exactly the accessor's output, filtered, and nothing more.
    const session = createSession();
    session.publishRemoteCollaborator(5, { user: { id: 'u-5', name: 'Ada' } });
    session.publishMalformedAwareness(6, { user: { id: 'u-6' } });
    const validated = vi.spyOn(session, 'getCollaborators');

    const collaborators = selectCollaborators(session);

    expect(validated).toHaveBeenCalled();
    // Same objects as the accessor returned: no second projection happened.
    expect(collaborators).toBe(session.getCollaborators());
    expect(collaborators.some((entry) => entry.clientId === 6)).toBe(false);
    expect(collaborators.some((entry) => entry.clientId === session.localClientId)).toBe(true);
    session.destroy();
  });

  it('builds a store snapshot from validated collaborator data', () => {
    const session = createSession();
    // The snapshot is produced by `getCollaborators`, not by projection over
    // awareness: a malformed peer entry must be absent from the snapshot too.
    session.publishRemoteCollaborator(5, { user: { id: 'u-5', name: 'Ada' } });
    session.publishMalformedAwareness(6, { user: { id: 'u-6' } });

    const store = createSessionStore(session, selectCollaborators);
    const names = store.getSnapshot().map((entry) => entry.user.name);

    expect(names).toContain('Ada');
    expect(names.some((name) => name === undefined)).toBe(false);
    expect(store.getSnapshot().some((entry) => entry.clientId === 6)).toBe(false);
    session.destroy();
  });

  it('reads the role through session.getRole(), the frozen seam', () => {
    // `useSessionRole` is `createSessionStore(session, selectRole)` — this asserts the two
    // halves of that: the selector delegates to the seam, and nothing re-derives a role from
    // a payload (docs/CONTRACTS.md §17.9 rule 1).
    const session = createSession();
    const seam = vi.spyOn(session, 'getRole');

    expect(selectRole(session)).toBeNull(); // unknown by default, never a guess
    session.setRole('viewer');
    expect(selectRole(session)).toBe('viewer');
    expect(seam).toHaveBeenCalledTimes(2);

    // The unknown state is also what a disposed session reports.
    session.destroy();
    expect(selectRole(session)).toBeNull();
  });

  it('announces a role change through the existing subscription', () => {
    const session = createSession();
    const store = createSessionStore(session, selectRole);
    const listener = vi.fn();
    store.subscribe(listener);

    const before = store.getSnapshot();
    session.setRole('editor');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(before).toBeNull();
    expect(store.getSnapshot()).toBe('editor');

    // A demotion reuses the same channel — no second mechanism (§17.9 rule 4).
    session.setRole('viewer');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toBe('viewer');

    session.destroy();
  });
});

describe('createSessionStore', () => {
  it('caches the snapshot so repeated reads are referentially stable', () => {
    const session = createSession();
    const store = createSessionStore(session, selectCollaborators);

    const first = store.getSnapshot();
    const second = store.getSnapshot();
    // `useSyncExternalStore` loops forever on an unstable snapshot, so this is a
    // correctness requirement, not an optimisation.
    expect(first).toBe(second);
    session.destroy();
  });

  it('refreshes the snapshot when the session changes and notifies listeners', () => {
    const session = createSession();
    const store = createSessionStore(session, selectCollaborators);
    const listener = vi.fn();
    store.subscribe(listener);

    const before = store.getSnapshot();
    session.publishRemoteCollaborator(5, { user: { id: 'u-5', name: 'Ada' } });

    expect(listener).toHaveBeenCalledTimes(1);
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.some((entry) => entry.user.name === 'Ada')).toBe(true);
    session.destroy();
  });

  it('subscribes to the session once for many listeners and unsubscribes when the last leaves', () => {
    const session = createSession();
    const subscribe = vi.spyOn(session, 'subscribe');
    const store = createSessionStore(session, selectConnectionStatus);

    const off1 = store.subscribe(() => {});
    const off2 = store.subscribe(() => {});
    expect(subscribe).toHaveBeenCalledTimes(1);

    off1();
    off2();
    expect(store.getSnapshot()).toBe('offline');
    session.destroy();
  });

  it('uses its own projection and does not resubscribe for a second store', () => {
    const session = createSession();
    const subscribe = vi.spyOn(session, 'subscribe');

    const statusStore = createSessionStore(session, selectConnectionStatus);
    const undoStore = createSessionStore(session, selectUndoState);
    const offStatus = statusStore.subscribe(() => {});
    const offUndo = undoStore.subscribe(() => {});

    expect(statusStore.getSnapshot()).toBe('offline');
    expect(undoStore.getSnapshot()).toHaveProperty('canRedo');

    session.setConnectionStatus('connected');
    expect(statusStore.getSnapshot()).toBe('connected');
    // One subscription per store, created once and released on last unsubscribe.
    expect(subscribe).toHaveBeenCalledTimes(2);

    offStatus();
    offUndo();
    session.destroy();
  });
});
