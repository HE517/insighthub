/**
 * React hooks over the frozen `CollaborativeSession` seam.
 *
 * These are the *only* places the UI reads session state, and each one reads it
 * through a validated accessor:
 *
 * | Hook | Reads | Why not the raw field |
 * | --- | --- | --- |
 * | `useSessionCollaborators` | `getCollaborators()` | R14: raw awareness is unvalidated wire data. |
 * | `useSessionConnectionStatus` | `connectionStatus` | Presentation only; never gates editing. |
 * | `useSessionUndoState` | `getUndoState()` | Undo is CRDT-scoped, not a text snapshot. |
 * | `useSessionLocalAwareness` | `getLocalAwarenessState()` | The session's own published identity. |
 *
 * Nothing here returns document text. `session.text` is a `Y.Text` and is handed
 * straight to the editor binding; it is never converted to a string in React
 * state, because that would be the second copy of the body that
 * `docs/ARCHITECTURE.md` §0 forbids.
 */
import { useMemo, useSyncExternalStore } from 'react';

import type {
  AwarenessState,
  CollaborativeSession,
  CollaboratorInfo,
  ConnectionStatus,
  UndoState,
} from '@insighthub/shared';

import { createSessionStore } from './sessionStore.js';

function useSessionSnapshot<Snapshot>(
  session: CollaborativeSession,
  selector: (session: CollaborativeSession) => Snapshot,
): Snapshot {
  // One store per (session, projection) pair. `session` changes only when the
  // document does, which is exactly when the underlying subscription must move.
  // The selectors in this module are module-level constants, so their identity is
  // stable across renders; the signature therefore asks for a stable function
  // rather than an inline arrow, which would recreate the store on every render.
  const store = useMemo(() => createSessionStore(session, selector), [session, selector]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Validated collaborators. Never `session.awareness.getStates()`. */
export function useSessionCollaborators(
  session: CollaborativeSession,
): readonly CollaboratorInfo[] {
  return useSessionSnapshot(session, selectCollaborators);
}

/** Transport status for display. Editing is allowed regardless of this value. */
export function useSessionConnectionStatus(session: CollaborativeSession): ConnectionStatus {
  return useSessionSnapshot(session, selectConnectionStatus);
}

/** Whether a local/AI-origin undo is currently available. */
export function useSessionUndoState(session: CollaborativeSession): UndoState {
  return useSessionSnapshot(session, selectUndoState);
}

/** The awareness state this client publishes about itself. */
export function useSessionLocalAwareness(session: CollaborativeSession): AwarenessState | null {
  return useSessionSnapshot(session, selectLocalAwareness);
}

export function selectCollaborators(session: CollaborativeSession): readonly CollaboratorInfo[] {
  return session.getCollaborators();
}

export function selectConnectionStatus(session: CollaborativeSession): ConnectionStatus {
  return session.connectionStatus;
}

export function selectUndoState(session: CollaborativeSession): UndoState {
  return session.getUndoState();
}

export function selectLocalAwareness(session: CollaborativeSession): AwarenessState | null {
  return session.getLocalAwarenessState();
}
