/**
 * Test-only substitution of the A1-owned collaboration seam.
 *
 * ## The problem
 *
 * `useCollaborativeDocument` is implemented by A1 in
 * `apps/web/src/collab/public.ts`, and until A1 lands it returns
 * `{ state: 'initializing' }` forever. A2 is explicitly not blocked on A1
 * (`docs/TASKS.md` M1-A2), so the editor needs a way to be driven by the typed
 * double without editing A1's file — and without a bundler alias, because the
 * production bundle must keep using the real seam.
 *
 * ## The mechanism
 *
 * `vi.mock('../../collab/public.js', …)` replaces the module **for one test
 * file only**. The mocked hook creates, owns and destroys a
 * `FakeCollaborativeSession`, mirroring the contract the real hook must satisfy:
 * it resolves to `active` from local state (never waiting for the network) and
 * disposes the session when `documentId` changes or the component unmounts.
 *
 * That also makes the A2 lifecycle tests meaningful: they assert on the *editor's*
 * behaviour given a session, and on the fact that a switched document tears the
 * old session down — which is A2's `document switch cleanup` criterion.
 */
import { useEffect, useRef, useState } from 'react';

import type { CollaborativeSessionResult } from '@insighthub/shared';

import {
  FakeCollaborativeSession,
  type FakeCollaborativeSessionOptions,
} from '../testing/fakeCollaborativeSession.js';

export interface MockCollabControls {
  /** Sessions created since the module was loaded, newest last. */
  created: FakeCollaborativeSession[];
  /** Sessions destroyed since the module was loaded, newest last. */
  destroyed: FakeCollaborativeSession[];
  /** Force the next session creation to fail, to exercise the `failed` branch. */
  failNext: string | null;
  reset(): void;
}

/** Shared with the mocked module so tests can observe session creation. */
export const mockCollabControls: MockCollabControls = {
  created: [],
  destroyed: [],
  failNext: null,
  reset(): void {
    mockCollabControls.created.length = 0;
    mockCollabControls.destroyed.length = 0;
    mockCollabControls.failNext = null;
  },
};

/** Body of the mocked `useCollaborativeDocument`. */
export function useFakeCollaborativeDocument(
  options: FakeCollaborativeSessionOptions,
): CollaborativeSessionResult {
  const sessionRef = useRef<FakeCollaborativeSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The rest of the options are read once, at creation, exactly like the real
  // factory. Holding them in a ref rather than in the dependency list is what
  // stops a new inline options object on every render from recreating the
  // session — the same trap the real hook has to avoid.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // `documentId` is the identity that matters: a different document is a
  // different session, and the previous one must be destroyed first so it can
  // never publish an event into the new document's UI (CONTRACTS §5.4).
  const documentId = options.documentId;

  useEffect(() => {
    const failure = mockCollabControls.failNext;
    if (failure !== null) {
      mockCollabControls.failNext = null;
      setError(failure);
      return;
    }

    const session = new FakeCollaborativeSession(optionsRef.current);
    sessionRef.current = session;
    mockCollabControls.created.push(session);
    setError(null);

    return () => {
      session.destroy();
      mockCollabControls.destroyed.push(session);
      sessionRef.current = null;
    };
  }, [documentId]);

  if (error !== null) return { state: 'failed', error };

  const session = sessionRef.current;
  if (session === null) return { state: 'initializing' };
  return { state: 'active', session };
}
