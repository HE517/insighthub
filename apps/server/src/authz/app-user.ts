/**
 * The **internal user mapping** (`docs/CONTRACTS.md` §18.1).
 *
 * ```text
 * VerifiedIdentity (Clerk sub, email, name)
 *   → app_user (internal id, clerk_user_id UNIQUE, email, display_name)
 *   → document membership → DocumentRole → documentCapabilities
 * ```
 *
 * ## Mapping only
 *
 * `app_user` is not a session store: it has no token, no expiry and no password. Clerk owns
 * the authentication session (§18.2); this row only answers "which internal id does this
 * verified Clerk user denote?" so that document membership — which is keyed by internal
 * `userId` — keeps working exactly as it did for demo identities (`authz/**` and the WS
 * layer never learn that Clerk exists).
 *
 * ## Why the interface lives here and the SQL lives in `persistence/**`
 *
 * `authz/**` owns the decision vocabulary; `persistence/**` owns the durable adapter. The
 * interface is small enough to be implemented by the same SQLite store that already owns
 * `insighthub.db` — the file the contract puts `app_user` in — without `authz/**` opening a
 * second database or learning SQL. `createAuthz` does not need this store in demo mode; it
 * is injected only when `AUTH_MODE=clerk` (see `identity.ts`).
 */
import type { VerifiedIdentity } from './session-verifier.js';

/**
 * One mapping row.
 *
 * `email` and `displayName` are nullable because Clerk may not have them; `createdAt` /
 * `updatedAt` are epoch milliseconds, the same unit the rest of the server stores.
 */
export interface AppUser {
  readonly id: string;
  readonly clerkUserId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The mapping seam the HTTP identity resolver needs.
 *
 * Every method is `Promise`-returning to match `DocumentStore`/`DocumentMetaStore`
 * (`docs/CONTRACTS.md` §14.6) even though the current adapter is synchronous: an async
 * adapter must not change the caller's shape.
 */
export interface AppUserStore {
  /**
   * Map a verified Clerk user to exactly one internal id, creating the row lazily.
   *
   * **Idempotent**: the same `clerkUserId` always returns the same internal id, including
   * under concurrent first requests. A changed email/display name updates the profile
   * columns and the `updatedAt` stamp, never the id or the `createdAt`.
   */
  upsertByClerkUserId(identity: VerifiedIdentity): Promise<string>;

  /** The mapping row for an internal id, or `null` when it does not exist. */
  findById(internalUserId: string): Promise<AppUser | null>;

  /** The mapping row for a Clerk user id, or `null` when it does not exist. */
  findByClerkUserId(clerkUserId: string): Promise<AppUser | null>;
}

/** True when `value` can serve the internal-user mapping (the SQLite store does). */
export function isAppUserStore(value: unknown): value is AppUserStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof AppUserStore, unknown>>;
  return (
    typeof candidate.upsertByClerkUserId === 'function' &&
    typeof candidate.findById === 'function' &&
    typeof candidate.findByClerkUserId === 'function'
  );
}
