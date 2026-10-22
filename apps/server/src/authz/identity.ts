/**
 * **Identity resolution**, shared by HTTP and the AI route (`docs/CONTRACTS.md` §18).
 *
 * ```text
 * AUTH_MODE=demo   cookie ──► AuthzService.resolveSession ──► demo userId   (unchanged §17.2)
 * AUTH_MODE=clerk  cookie ──► SessionVerifier.verify      ──► VerifiedIdentity
 *                       └──► AppUserStore.upsertByClerkUserId ──► internal userId
 * ```
 *
 * ## The one rule this module exists to enforce
 *
 * Identity is decided **once**, before authorization. `authorizeDocument` and
 * `listReadableDocuments` now take the resolved internal `userId`; they no longer look at a
 * cookie. That is what lets the same document-membership decision serve a demo session and a
 * verified Clerk user without a branch in `authz.ts`:
 *
 * ```text
 * resolveAuthenticatedUser(request) → userId → membership → DocumentRole → capabilities
 * ```
 *
 * It also keeps the §18.2 rule honest: there is no second session. The demo `Map` remains
 * the demo authentication mechanism; a Clerk user gets **no local session row at all** —
 * only the `app_user` mapping row, which carries no token and no expiry.
 *
 * ## Failure is one answer: `null`
 *
 * A missing cookie, an invalid/expired Clerk session, a verifier that throws (Clerk backend
 * unavailable or a malformed cookie), and a verifier that returns an empty `clerkUserId` all
 * produce `null`. The HTTP layer maps that to `401` (`session_required` in clerk mode,
 * `unauthenticated` in demo mode — the frozen §17.4 body). Distinguishing these cases to a
 * caller would tell an attacker whether a guessed cookie was structurally valid.
 *
 * ## Why `expiresAt` is absent for Clerk
 *
 * Demo sessions have a server-tracked absolute expiry (§17.2). A Clerk session does not: its
 * lifetime, rotation and revocation are Clerk's (§18.2). Returning a locally invented expiry
 * would be exactly the second session system the contract forbids, so `expiresAt` is present
 * only when the demo store supplied one.
 */
import type { AuthMode } from '../config.js';
import type { AppUserStore } from './app-user.js';
import type { AuthzService } from './authz.js';
import type { SessionVerifier, VerifiedIdentity } from './session-verifier.js';

/**
 * The identity one request speaks for.
 *
 * `userId` is always an **internal** id: a demo roster id in demo mode, an `app_user.id` in
 * clerk mode. Document membership, `roleFor`, `can` and the WebSocket layer only ever see
 * this value, never a Clerk `sub` (§18.1's mapping chain).
 */
export interface AuthenticatedUser {
  readonly userId: string;
  readonly displayName: string;
  /** ISO 8601; only demo sessions carry a server-tracked expiry (see the file header). */
  readonly expiresAt?: string;
}

/** The injectable halves of Clerk mode. Absent in demo mode by construction. */
export interface IdentityOptions {
  readonly verifier?: SessionVerifier | null;
  readonly appUsers?: AppUserStore | null;
}

/** What `resolveAuthenticatedUser` needs. Built once per app, not per request. */
export interface IdentityDeps {
  readonly mode: AuthMode;
  readonly authz: AuthzService;
  readonly verifier: SessionVerifier | null;
  readonly appUsers: AppUserStore | null;
}

/**
 * Validate the mode's dependencies at construction time.
 *
 * A server that started in clerk mode without a verifier would answer `401` to everything —
 * indistinguishable from "nobody is signed in", and exactly the kind of wiring mistake that
 * takes hours to diagnose. Failing at construction turns it into a startup error. B2 supplies
 * the real verifier and removes the last missing piece.
 */
export function createIdentityDeps(
  mode: AuthMode,
  authz: AuthzService,
  options: IdentityOptions = {},
): IdentityDeps {
  if (mode === 'clerk') {
    if (options.verifier === undefined || options.verifier === null) {
      throw new Error(
        'AUTH_MODE=clerk requires a SessionVerifier; B2 provides createClerkSessionVerifier',
      );
    }
    if (options.appUsers === undefined || options.appUsers === null) {
      throw new Error('AUTH_MODE=clerk requires an AppUserStore for the internal user mapping');
    }
    return { mode, authz, verifier: options.verifier, appUsers: options.appUsers };
  }
  return { mode: 'demo', authz, verifier: null, appUsers: null };
}

/**
 * Resolve the internal identity for one request, or `null` when it cannot be authenticated.
 *
 * The raw `Cookie` header is the only input (§18.3/§17.2). No `Authorization` header, body
 * field, query parameter or `userId` cookie is consulted — a caller cannot declare who it is
 * (§17.1).
 */
export async function resolveAuthenticatedUser(
  request: { readonly cookie: string | undefined },
  deps: IdentityDeps,
): Promise<AuthenticatedUser | null> {
  if (deps.mode === 'demo') {
    const session = deps.authz.resolveSession(request.cookie);
    if (session === null) return null;
    return {
      userId: session.userId,
      displayName: session.displayName,
      expiresAt: session.expiresAt,
    };
  }

  const verifier = deps.verifier;
  const appUsers = deps.appUsers;
  // Unreachable through `createIdentityDeps`; kept as a fail-closed guard in case a future
  // caller hand-builds `IdentityDeps`.
  if (verifier === null || appUsers === null) return null;

  let identity: VerifiedIdentity | null;
  try {
    identity = await verifier.verify({ cookie: request.cookie });
  } catch (error) {
    // A verifier failure (Clerk unreachable, malformed token) is "not verified". Only the
    // error **class** is logged: a backend SDK's message can embed token material, and §18.3
    // forbids the session token ever reaching a log line.
    console.warn(
      '[auth] session verification failed:',
      error instanceof Error ? error.name : 'unknown verifier error',
    );
    return null;
  }

  // A verifier returning an empty sub is broken or hostile. Fail closed rather than mapping
  // every such user onto one internal id (`clerk_user_id` is UNIQUE, so it would at least not
  // create rows — but it would still be an identity, which is worse).
  if (identity === null || identity.clerkUserId.trim() === '') return null;

  const internalUserId = await appUsers.upsertByClerkUserId(identity);
  // Prefer the freshly verified profile, then the stored mapping (a later verification may
  // omit a field Clerk returned before), then the identity's email, and only then the id.
  // The extra read is one row by primary key; it keeps `GET /api/session` from degrading a
  // known display name to a UUID just because Clerk omitted the name this time.
  const stored = await appUsers.findById(internalUserId);
  return {
    userId: internalUserId,
    displayName:
      identity.displayName ??
      stored?.displayName ??
      identity.email ??
      stored?.email ??
      internalUserId,
  };
}
