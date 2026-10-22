/**
 * The Clerk-mode server session: `GET /api/session` (M4 B2, `docs/CONTRACTS.md` §18).
 *
 * ## Why this is a separate read from the demo bootstrap
 *
 * In `AUTH_MODE=demo` the client *claims* an identity once per page with
 * `POST /api/session/bootstrap` (`bootstrap.ts`), and the answer carries an `expiresAt` because the
 * demo session is a server-side record. In `AUTH_MODE=clerk` there is no bootstrap endpoint at all
 * (§18.5: it is absent outside development) and no server-tracked expiry (§18.2: Clerk owns the
 * session lifetime), so the server's answer is the two-field mapping
 * `{ userId, displayName }` of the verified Clerk user (`apps/server/src/app.ts#sessionBody`).
 * Asking for the demo shape here would reject every valid clerk response.
 *
 * ## What this module deliberately does not do
 *
 * It never calls `getToken()` and never sees a credential. Clerk's browser SDK keeps the session
 * in its own cookie and the request only has to allow cookies to travel (`credentials: 'include'`,
 * same-origin deployment per D-082 D2). No token enters React state, Redux or web storage
 * (`AGENTS.md` R4; the user's B2 constraint), because there is nowhere in this module it could be
 * put.
 */
import { useEffect, useState } from 'react';

import { requestJson } from '../api.js';

/** The identity the server mapped the verified Clerk user onto. Never a credential. */
export interface ClerkServerIdentity {
  readonly userId: string;
  readonly displayName: string;
}

/**
 * Validate `GET /api/session` before using it.
 *
 * Only the two §18 fields are required. Extra fields are dropped — including `expiresAt`, which a
 * demo server may still send if a stale cookie is somehow presented; keeping it would invent a
 * server-side lifetime for a Clerk session that does not have one.
 *
 * The same hand-written checks as `bootstrap.ts` (the web app has no schema dependency), and the
 * same 80-character awareness bound: a longer name would be silently rejected by
 * `awarenessUserSchema` and the client would publish no presence at all.
 */
export function parseClerkServerIdentity(value: unknown): ClerkServerIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const userId = record['userId'];
  const displayName = record['displayName'];
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (typeof displayName !== 'string' || displayName.length === 0) return null;
  return { userId, displayName: displayName.slice(0, 80) };
}

export interface ClerkServerSessionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Ask the server who the verified Clerk user maps to.
 *
 * Resolves `null` — never throws — when there is no usable answer (401 while Clerk is still
 * settling, offline, timeout, malformed body). The caller treats that as "identity not available
 * yet", not as an error: the editor must never wait for the network (`AGENTS.md` R10).
 */
export async function fetchClerkServerSession(
  options: ClerkServerSessionOptions = {},
): Promise<ClerkServerIdentity | null> {
  const result = await requestJson<unknown>('GET', '/api/session', {
    credentials: 'include',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (!result.ok) return null;
  return parseClerkServerIdentity(result.data);
}

export type ClerkServerSessionState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly identity: ClerkServerIdentity }
  | { readonly status: 'unavailable' };

/**
 * React binding for {@link fetchClerkServerSession}.
 *
 * Mounted only inside the authenticated gate, so a signed-out visitor never asks. The effect
 * aborts on unmount (the gate unmounts on sign-out), and the `active` flag keeps a response that
 * settles after the abort from writing state for a user who is already gone — R9's stale-response
 * rule, applied to the identity read.
 *
 * Not memoised across mounts on purpose: unlike the demo bootstrap there is no rotation to
 * de-duplicate, and the next sign-in may be a different Clerk user. One idempotent `GET` per
 * mount is the honest cost.
 */
export function useClerkServerSession(): ClerkServerSessionState {
  const [state, setState] = useState<ClerkServerSessionState>({ status: 'pending' });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetchClerkServerSession({ signal: controller.signal }).then((identity) => {
      if (!active) return; // the gate unmounted / the signed-in user changed
      setState(identity === null ? { status: 'unavailable' } : { status: 'ready', identity });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return state;
}
