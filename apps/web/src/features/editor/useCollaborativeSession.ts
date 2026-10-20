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
 * | `useSessionRole` | `getRole()` | `docs/CONTRACTS.md` §17.9: the role is a getter, never state. |
 *
 * Nothing here returns document text. `session.text` is a `Y.Text` and is handed
 * straight to the editor binding; it is never converted to a string in React
 * state, because that would be the second copy of the body that
 * `docs/ARCHITECTURE.md` §0 forbids.
 *
 * Nothing here mirrors the role into Redux or module state either. `session.getRole()`
 * is a getter and the value is re-read on every notification; the only copy is the
 * snapshot this store hands to React for the duration of one render.
 */
import { useMemo, useSyncExternalStore } from 'react';

import type {
  AwarenessState,
  CollaborativeSession,
  CollaboratorInfo,
  ConnectionStatus,
  DocumentRole,
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

/**
 * This client's role in the current document, or `null` while it is UNKNOWN.
 *
 * ## Where the value comes from
 *
 * `session.getRole()` — the frozen seam of `docs/CONTRACTS.md` §17.9, which A1 fills from
 * `room-joined.role` after validating it with `isDocumentRole`. This hook is the **only**
 * way the editor reads the role, and it reuses the same `createSessionStore` subscription
 * as every other accessor here: §17.9 rule 4 says a role change is announced through the
 * existing session subscription, and no second mechanism is added.
 *
 * ## What `null` means, and what it must not mean
 *
 * `null` = the server has not told this client a trustworthy role (before the first join,
 * while offline/reconnecting, after a denied join, after `destroy()`). It is **not**
 * `viewer`: rendering a read-only editor on `null` would lock a user out of their own
 * unsent text (`AGENTS.md` R10, §17.9 gating consequence). The gate
 * (`features/permissions/capabilityGate.ts`) deliberately keeps `readOnly: false` for it.
 *
 * ## What this hook does NOT do
 *
 * It is not a security boundary, it does not persist or copy the role into Redux/module
 * state, and it does not write it into Yjs awareness. The server re-derives the role from
 * membership at every enforcement point (§17.5), so a client that lied to itself here
 * would only change which controls it shows.
 */
export function useSessionRole(session: CollaborativeSession): DocumentRole | null {
  return useSessionSnapshot(session, selectRole);
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

/**
 * The session's own answer to "what is my role". One call, no re-derivation, no payload
 * parsing: the seam (§17.9) already validated `room-joined.role` with `isDocumentRole`.
 */
export function selectRole(session: CollaborativeSession): DocumentRole | null {
  return session.getRole();
}
