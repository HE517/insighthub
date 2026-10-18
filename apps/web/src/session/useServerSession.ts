/**
 * React binding for the session bootstrap.
 *
 * ## Why the request is shared and started once
 *
 * The identity is app-wide state (one browser profile, one session cookie), so asking twice would
 * be two rotations racing to describe the same tab. `ensureSessionBootstrap` therefore memoises the
 * in-flight promise: React StrictMode double-mounts effects in development, and both mounts must
 * observe the same answer.
 *
 * ## Why nothing here blocks the editor
 *
 * The editor opens from local state as soon as the local `Y.Doc` is available
 * (`docs/ARCHITECTURE.md` §2.1, `AGENTS.md` R10). While the bootstrap is in flight the state is
 * `pending`, and a consumer must treat that exactly like `unavailable` — an identity it does not
 * have yet — instead of waiting for it.
 */
import { useEffect, useState } from 'react';

import { bootstrapSession, type SessionIdentity } from './bootstrap.js';

/**
 * The bootstrap request, started at most once per page.
 *
 * Deliberately **not** aborted on unmount: the request's lifetime is the page's, not a component's,
 * and an abort-on-unmount convention would cancel the only chance to learn the identity whenever
 * React re-mounted the effect. The request carries its own timeout (`api.ts`), so a dead server
 * still settles quickly.
 */
let pending: Promise<SessionIdentity | null> | null = null;

/** Start (or reuse) the single bootstrap request for this page. */
export function ensureSessionBootstrap(demoUserId?: string): Promise<SessionIdentity | null> {
  pending ??= bootstrapSession(
    demoUserId === undefined ? {} : { demoUserId },
  );
  return pending;
}

/**
 * Forget the in-flight request. **Tests only** — production bootstraps once per page load, and a
 * second call would be a rotation.
 */
export function resetSessionBootstrapForTests(): void {
  pending = null;
}

export type ServerSessionState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly identity: SessionIdentity }
  | { readonly status: 'unavailable' };

/**
 * The server's answer to "who is this client", as React state.
 *
 * `unavailable` is a **normal** state, not an error: it is what an offline browser sees, and the
 * app is expected to keep working with a local placeholder identity.
 */
export function useServerSession(demoUserId?: string): ServerSessionState {
  const [state, setState] = useState<ServerSessionState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    // `ensureSessionBootstrap` never rejects, so there is nothing to catch here: a failure is
    // `null`, i.e. `unavailable`.
    void ensureSessionBootstrap(demoUserId).then((identity) => {
      if (cancelled) return; // stale-response guard: unmount wins
      setState(identity === null ? { status: 'unavailable' } : { status: 'ready', identity });
    });
    return () => {
      cancelled = true;
    };
  }, [demoUserId]);

  return state;
}
