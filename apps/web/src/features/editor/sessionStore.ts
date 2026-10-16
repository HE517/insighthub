/**
 * A per-session external store for the collaborator UI.
 *
 * ## Why this exists instead of a Redux dispatch
 *
 * Collaborator presence changes on every remote keystroke. Dispatching that into
 * Redux would put another peer's cursor movement on the local typing path, and
 * would make the whole store (and every subscriber) react to it. Reading it
 * through `useSyncExternalStore` keeps the update inside the components that
 * actually render collaborators.
 *
 * ## Why the snapshot is cached
 *
 * `useSyncExternalStore` compares snapshots by reference and will loop forever if
 * `getSnapshot` returns a fresh object each call. `session.getCollaborators()`
 * has no obligation to return a stable array, so the store snapshots once per
 * change (on subscribe notification) rather than once per render.
 *
 * ## Rule this implements
 *
 * The only accessor used is the session's validated one
 * (`getCollaborators()`), never `session.awareness.getStates()`
 * (`AGENTS.md` R14, `docs/CONTRACTS.md` §9.2).
 */
import type { CollaborativeSession } from '@insighthub/shared';

export interface SessionStore<Snapshot> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Snapshot;
}

export function createSessionStore<Snapshot>(
  session: CollaborativeSession,
  selector: (session: CollaborativeSession) => Snapshot,
): SessionStore<Snapshot> {
  let snapshot = selector(session);
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    snapshot = selector(session);
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (unsubscribe === null) {
        // One session subscription for all listeners, created on first use and
        // released when the last listener leaves.
        unsubscribe = session.subscribe(notify);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribe !== null) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    },

    getSnapshot(): Snapshot {
      return snapshot;
    },
  };
}
