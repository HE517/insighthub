/**
 * The identity this client publishes through Yjs awareness.
 *
 * ## M2 Phase 2: the identity comes from the server
 *
 * Until Phase 2 this module generated a random demo identity per tab and the server never saw it
 * (`docs/TASKS.md` "现状重建"). The identity now comes from
 * `POST /api/session/bootstrap` → `userId` + `displayName`, i.e. from a **server-issued session**
 * resolved from an `httpOnly` cookie.
 *
 * Stated at exactly the strength the contract allows (`docs/CONTRACTS.md` §17.0): the session
 * stops a client from self-declaring identity on later requests. The bootstrap itself proves no
 * ownership of the identity it claims.
 *
 * ## Why there is still a local fallback
 *
 * A browser with no server — or one whose bootstrap failed — must still show a presence name that
 * is *its own*, otherwise two tabs collapse into one collaborator and the M1 acceptance criterion
 * ("two browsers see each other's edits") stops being observable (`AGENTS.md` R10). The fallback is
 * a display placeholder **only**: it is never sent as an authorization input, because authorization
 * lives in the server session, not in awareness.
 *
 * No secret, token or credential is involved (AGENTS.md R4).
 */
import type { CollaborativeSessionOptions } from '@insighthub/shared';

/**
 * The two fields presence needs from any server-issued identity.
 *
 * Both the demo bootstrap (`SessionIdentity`) and the Clerk mapping (`ClerkServerIdentity`) satisfy
 * it; the awareness user is display metadata only, so the session's expiry is irrelevant here.
 */
export interface PresenceIdentity {
  readonly userId: string;
  readonly displayName: string;
}

/** A per-tab suffix so two tabs on one machine stay two collaborators. */
const TAB_SUFFIX = Math.random().toString(36).slice(2, 6);

/**
 * The placeholder identity, built once per page.
 *
 * Module-level (not per call) so repeated renders and repeated session creations cannot produce two
 * different names for the same tab.
 */
const FALLBACK_USER: CollaborativeSessionOptions['user'] = {
  id: `local-${TAB_SUFFIX}`,
  name: `You (${TAB_SUFFIX})`,
};

/**
 * Map a server identity to the awareness `user`, falling back to the per-tab placeholder.
 *
 * The returned object is intentionally rebuilt on each call: `useCollaborativeDocument` keys its
 * effect on `user.id` / `user.name` **strings**, so a new wrapper with the same values cannot
 * restart a session. What must never change under a live session is the pair of strings, and that
 * only changes when the server identity itself changes (one transition, when the bootstrap lands).
 */
export function presenceUserFor(
  identity: PresenceIdentity | null | undefined,
): CollaborativeSessionOptions['user'] {
  if (identity === null || identity === undefined) return FALLBACK_USER;
  return { id: identity.userId, name: identity.displayName };
}

/** The placeholder used when no server identity is available. Exported for tests. */
export function fallbackPresenceUser(): CollaborativeSessionOptions['user'] {
  return FALLBACK_USER;
}
