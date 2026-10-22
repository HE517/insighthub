/**
 * The **Clerk identity seam** (`docs/CONTRACTS.md` §18.1).
 *
 * ```text
 * request cookie ──► SessionVerifier.verify ──► VerifiedIdentity | null
 *                                              └─► app_user mapping (internal id)
 *                                              └─► document membership → DocumentRole
 * ```
 *
 * ## What this file is, and what it deliberately is not
 *
 * This file owns the **interface and the fake**; the real implementation is
 * `authz/clerk-session-verifier.ts` (`createClerkSessionVerifier`, M4 B2). Keeping the interface
 * here means `identity.ts`, `app.ts` and the WebSocket upgrade depend on `SessionVerifier`, not
 * on `@clerk/backend`, and the suite can run without the network.
 *
 * `index.ts` constructs the real verifier for `AUTH_MODE=clerk`; the fake is never constructed
 * by production code and is only reachable through an injected test option.
 *
 * ## Why the fake is allowed to exist in `src/`
 *
 * The contract's HTTP/WS behaviour in clerk mode must be provable **without** a Clerk
 * account and without the network (`docs/CONTRACTS.md` §18; the project's test-determinism
 * rule). A fake that lives in `src/` and is injected through `createApp` is the smallest
 * seam that makes that possible. It is never constructed by `index.ts`, so it cannot become
 * a production path by default.
 *
 * ## The request shape
 *
 * Only the raw `Cookie` header is passed, because that is the one carrier the server reads
 * (§18.3, §17.2). The verifier is responsible for reading Clerk's own cookie(s) out of it —
 * the shape of those cookies is B2's business, not this interface's. Passing the whole
 * `Request` would let a verifier consult an `Authorization` header or a query parameter and
 * quietly create a second identity carrier.
 */

/**
 * A Clerk user, **as verified by the server**.
 *
 * `clerkUserId` is Clerk's `sub`: stable, server-issued, and never derived from anything a
 * browser body or query parameter says. `email`/`displayName` are optional profile
 * attributes; their absence must not deny access (a Clerk user may not have a name set).
 */
export interface VerifiedIdentity {
  readonly clerkUserId: string;
  readonly email?: string;
  readonly displayName?: string;
}

/** What the HTTP layer needs from a Clerk backend. */
export interface SessionVerifier {
  /**
   * Verify the session carried by `cookie`.
   *
   * Returns `null` for an absent, malformed, expired, revoked or unknown session — the one
   * answer that becomes `401 session_required`. Implementations must not throw for a bad
   * cookie; the caller treats a throw as "not verified" as a second line of defence.
   */
  verify(request: { cookie: string | undefined }): Promise<VerifiedIdentity | null>;
}

/** A lookup used by {@link createFakeSessionVerifier}; may be async or throw on purpose. */
export type FakeSessionVerifierLookup = (request: {
  readonly cookie: string | undefined;
}) => VerifiedIdentity | null | Promise<VerifiedIdentity | null>;

/**
 * Build an injectable verifier for tests and for local `AUTH_MODE=clerk` wiring checks.
 *
 * The fake deliberately invents **no** cookie format: the lookup receives the raw `Cookie`
 * header and decides. That keeps a test from encoding an assumption B2 has not frozen, and
 * it makes "verification failed" (`null`), "backend failed" (a throw) and "no cookie"
 * (`undefined`) all expressible.
 */
export function createFakeSessionVerifier(lookup: FakeSessionVerifierLookup): SessionVerifier {
  return {
    async verify(request: { cookie: string | undefined }): Promise<VerifiedIdentity | null> {
      return await lookup(request);
    },
  };
}
