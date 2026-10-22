/**
 * Sign-out sequence for Clerk mode (M4 B2).
 *
 * ## The mandated order
 *
 * ```text
 * click [data-testid="sign-out"]
 *   → Clerk signOut()                ← ends the authentication session (Clerk owns it, §18.2)
 *   → DELETE /api/session            ← clears a stale demo cookie this browser may still carry
 *   → the auth gate re-renders       ← Clerk's own state change, not a navigation we perform
 * ```
 *
 * The order is the requirement's, not an implementation detail: Clerk is the authentication
 * session, so it is ended first. The `DELETE` is the **demo-cookie cleanup**, not a revocation
 * (there is no InsightHub login session to revoke, §18.2). It is best-effort and its outcome is
 * reported rather than thrown: a 401 here only means the Clerk session was already gone, and a
 * failed cleanup must never leave the user visibly signed in or trap the UI.
 *
 * ## Why this is a function and not inline in the component
 *
 * The call order is the acceptance criterion and it has to be provable without a browser or a
 * network. `performSignOut` takes its two effects as dependencies, so a unit test can record the
 * order with a mocked Clerk `signOut` and a stubbed `fetch` (see `signOut.test.ts`).
 */
import { deleteJson } from '../api.js';

/** The two effects of signing out. `clearDemoSession` defaults to the real HTTP call. */
export interface SignOutDependencies {
  /** Clerk's `signOut` from `useClerk()`. */
  readonly signOut: () => Promise<unknown>;
  /** Best-effort removal of the stale demo session cookie. */
  readonly clearDemoSession?: () => Promise<boolean>;
}

export interface SignOutResult {
  /** `true` when Clerk's `signOut` resolved (not merely when it was called). */
  readonly clerkSignOutCompleted: boolean;
  /** Whether `DELETE /api/session` succeeded (`false` also covers "no session to clear"). */
  readonly demoCookieCleared: boolean;
}

/**
 * Clear the demo cookie the browser may still hold from a pre-Clerk visit.
 *
 * `DELETE /api/session` answers `204` on success (`docs/CONTRACTS.md` §17.4) and `401` when the
 * request carries no verified session — which is exactly the normal state after Clerk's
 * `signOut` has already cleared its own cookie. A `401` is therefore an expected non-event; the
 * stale demo cookie is inert in clerk mode because identity resolution never reads it
 * (`apps/server/src/authz/identity.ts`).
 *
 * Deliberately not aborted on unmount: the cleanup's lifetime is the page's, and the component
 * that started it is about to disappear by design.
 */
export async function clearDemoSession(options: { signal?: AbortSignal } = {}): Promise<boolean> {
  const result = await deleteJson('/api/session', {
    credentials: 'include',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return result.ok;
}

/**
 * End the Clerk session, then clear any stale demo cookie. Never throws.
 *
 * `signOut` is awaited first even though it cannot prevent the cleanup: if Clerk fails, the
 * `DELETE` still runs (it is harmless), and the result says which half succeeded.
 */
export async function performSignOut(dependencies: SignOutDependencies): Promise<SignOutResult> {
  let clerkSignOutCompleted = false;
  try {
    await dependencies.signOut();
    clerkSignOutCompleted = true;
  } catch {
    // Clerk's failure is reported through the result, not rethrown: the caller is a click
    // handler, and an unhandled rejection there would be an unactionable console error.
    clerkSignOutCompleted = false;
  }

  const clear = dependencies.clearDemoSession ?? (() => clearDemoSession());
  let demoCookieCleared = false;
  try {
    demoCookieCleared = await clear();
  } catch {
    demoCookieCleared = false;
  }

  return { clerkSignOutCompleted, demoCookieCleared };
}
