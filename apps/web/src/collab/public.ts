/**
 * Frozen A1 ↔ A2 seam.
 *
 * Ownership (see `docs/TASKS.md` M1-A0 / M1-A1 / M1-A2):
 *
 * - **A1 (Collaboration Agent)** owns this file. It implements the two frozen
 *   functions declared in `docs/CONTRACTS.md` §8.
 * - **A2 (Editor Frontend Agent)** IMPORTS from this module and never from
 *   `apps/web/src/collab/internal/**`. A2 must not reach into the IndexedDB
 *   provider, the reconnect logic, the state-vector exchange or the socket framing —
 *   none of them appear in the frozen interface.
 *
 * The names, parameter shapes and return types below are frozen because A2 compiles
 * against them. A2 may develop against an in-memory double typed as
 * `CollaborativeSession` and swap to the real factory without touching this file.
 *
 * Implementation note (A1): the real work lives in `internal/**`; this module is a
 * thin, stable facade, so the private layout can change without breaking A2.
 */
import { useEffect, useRef, useState } from 'react';

import type {
  CollaborativeSession,
  CollaborativeSessionOptions,
  CollaborativeSessionResult,
} from '@insighthub/shared';

import { createDocumentSession } from './internal/document-session.js';

/** Stable module path A2 imports the factory from. */
export const COLLAB_PUBLIC_MODULE = 'apps/web/src/collab/public.ts';

/**
 * Create a collaboration session for one document.
 *
 * Contract (frozen):
 * - Resolves once **local** state is available. It MUST NOT wait for the network:
 *   `docs/ARCHITECTURE.md` §2.1 requires the editor to be usable offline, so the
 *   IndexedDB load gates `active`, and the socket connects afterwards.
 * - Rejects only on unrecoverable local failure (e.g. IndexedDB unavailable).
 * - The caller owns teardown and must call `session.destroy()`.
 *
 * Once it resolves, `session.state === 'active'` and the document is editable
 * whatever `session.connectionStatus` reports. Apply edits through
 * `session.transact(fn)` so undo tracking and echo suppression behave; a direct
 * `session.text.insert(...)` bypasses undo tracking.
 */
export function createCollaborativeSession(
  options: CollaborativeSessionOptions,
): Promise<CollaborativeSession> {
  return createDocumentSession(options);
}

/**
 * React hook wrapper around `createCollaborativeSession`.
 *
 * Contract (frozen): returns the discriminated union from shared, so consumers
 * narrow with `result.state === 'active'` instead of checking for `null`. It
 * creates the session in an effect and destroys it on unmount and on
 * `documentId` change, so switching documents can never leave two live sessions
 * (or render document A's content inside document B).
 */
export function useCollaborativeDocument(
  options: CollaborativeSessionOptions,
): CollaborativeSessionResult {
  const [result, setResult] = useState<CollaborativeSessionResult>({ state: 'initializing' });

  const { documentId, persistenceKey, wsUrl } = options;
  const userId = options.user.id;
  const userName = options.user.name;
  const userColor = options.user.color;

  // Callers typically build the options object inline, so its identity changes on
  // every render. Keep the newest one in a ref: the effect then depends only on the
  // values that genuinely require a new session, instead of re-creating the
  // document on every keystroke-driven re-render.
  const latestOptions = useRef(options);
  latestOptions.current = options;

  useEffect(() => {
    let disposed = false;
    let session: CollaborativeSession | undefined;
    setResult({ state: 'initializing' });

    createCollaborativeSession({
      ...latestOptions.current,
      documentId,
      persistenceKey,
      wsUrl,
      user: {
        id: userId,
        name: userName,
        ...(userColor === undefined ? {} : { color: userColor }),
      },
    }).then(
      (created) => {
        if (disposed) {
          // The effect was torn down (or the document changed) while the local
          // replica was still loading. Release it immediately instead of leaking a
          // session, its IndexedDB connection and its awareness interval.
          created.destroy();
          return;
        }
        session = created;
        setResult({ state: 'active', session: created });
      },
      (error: unknown) => {
        if (disposed) return;
        setResult({ state: 'failed', error: describeFailure(error) });
      },
    );

    return () => {
      disposed = true;
      session?.destroy();
      session = undefined;
    };
  }, [documentId, persistenceKey, wsUrl, userId, userName, userColor]);

  return result;
}

/** Turn an unknown rejection into a short, user-facing message (never a stack trace). */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return 'failed to open the local document replica';
}
