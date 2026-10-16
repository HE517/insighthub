/**
 * Frozen A1 ↔ A2 seam — READ THIS BEFORE EDITING.
 *
 * Ownership (see `docs/TASKS.md` M1-A0/M1-A1/M1-A2):
 *
 * - **A1 (Collaboration Agent)** replaces the throwing placeholder below with the
 *   real `createCollaborativeSession` implementation and adds
 *   `useCollaborativeDocument`. Both must satisfy the types in
 *   `@insighthub/shared` (`CollaborativeSession`, `CollaborativeSessionResult`).
 * - **A2 (Editor Frontend Agent)** IMPORTS from this module and never from
 *   `apps/web/src/collab/internal/**`. A2 must not reach into the IndexedDB
 *   provider, the reconnect queue, the state-vector logic or the socket framing.
 *
 * Why this file exists at all: without it, A1 waited on "the editor binding from
 * A2" while A2 waited on "the session from A1". The interface is frozen in
 * `packages/shared/src/collab-session.ts`, so both agents can start immediately:
 * A2 may develop against an in-memory test double implementing
 * `CollaborativeSession` until A1 lands the real factory.
 *
 * The only thing A1 may change here is the body of the two exported functions —
 * their names, parameter shapes and return types are frozen, because A2 compiles
 * against them.
 */
import type {
  CollaborativeSession,
  CollaborativeSessionOptions,
  CollaborativeSessionResult,
} from '@insighthub/shared';

/** Stable module path A2 imports the factory from. */
export const COLLAB_PUBLIC_MODULE = 'apps/web/src/collab/public.ts';

/** Error text used while the real implementation is still pending (M1-A1). */
const NOT_IMPLEMENTED =
  'createCollaborativeSession is not implemented yet (M1-A1 owns this file body)';

/**
 * Create a collaboration session for one document.
 *
 * Contract (frozen):
 * - Resolves once **local** state is available. It MUST NOT wait for the
 *   network: `docs/ARCHITECTURE.md` §3 requires the editor to be usable offline,
 *   so local IndexedDB load gates `active`, and the socket connects afterwards.
 * - Rejects only on unrecoverable local failure (e.g. IndexedDB unavailable).
 * - The caller owns teardown and must call `session.destroy()`.
 */
export function createCollaborativeSession(
  options: CollaborativeSessionOptions,
): Promise<CollaborativeSession> {
  // M1-A1: implement against the frozen `CollaborativeSession` contract.
  void options;
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}

/**
 * React hook wrapper around `createCollaborativeSession`.
 *
 * Contract (frozen): returns the discriminated union from shared, so consumers
 * narrow with `result.state === 'active'` instead of checking for `null`.
 * It must clean the session up on unmount and on `documentId` change.
 */
export function useCollaborativeDocument(
  options: CollaborativeSessionOptions,
): CollaborativeSessionResult {
  // M1-A1: implement the async factory above, then drive this hook from it.
  // Returning `initializing` for a reachable-but-unimplemented dependency is
  // deliberate: it is the honest state until the factory resolves.
  void options;
  return { state: 'initializing' };
}
