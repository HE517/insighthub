/**
 * The **real** Clerk session verifier (`docs/CONTRACTS.md` §18.1, §18.3, §18.4).
 *
 * ```text
 * raw Cookie header ──► @clerk/backend authenticateRequest ──► RequestState
 *                                                              └─► VerifiedIdentity | null
 * ```
 *
 * ## What this file owns
 *
 * One thing: turning the raw `Cookie` header the server already reads into a **server-verified**
 * Clerk identity. Everything downstream — the `app_user` mapping, document membership,
 * `DocumentRole`, HTTP and WebSocket authorization — is unchanged and lives elsewhere
 * (`identity.ts`, `authz.ts`, `ws.ts`). In particular this module invents **no session**: Clerk's
 * session token is verified on every request and is never stored (§18.2).
 *
 * ## Why the raw cookie is handed to the SDK instead of parsed here
 *
 * Clerk's cookie name is not always literally `__session`: a development instance can suffix its
 * cookies, and the SDK knows how to pick the right one from the request. Parsing the header here
 * would encode an assumption the contract has not frozen and would silently break the dev
 * instance. So the whole header goes in, exactly as §18.3 says the cookie is the only carrier —
 * no `Authorization` header, body field or query parameter is ever consulted.
 *
 * ## Fail closed, and say nothing
 *
 * `verify` answers `null` for: no cookie, a malformed cookie, an unsigned/garbage token, an
 * unauthenticated `RequestState`, a state whose auth object has no `userId`, and any throw from
 * the SDK (network, JWKS, misconfiguration). It never logs. A Clerk SDK error message can embed
 * token material, and §18.3 forbids the session token ever reaching a log line — so the
 * "why" is deliberately dropped at this boundary. The caller (`identity.ts`) may log the error
 * **class** for a throw, never the message.
 *
 * ## Injectable SDK call
 *
 * `authenticateRequest` is an option, not a hard import at the call site, so the whole suite
 * runs without a Clerk account and without the network. Production wiring
 * (`apps/server/src/index.ts`) passes only a secret key and (optionally) the **public**
 * publishable key; it never passes a closure.
 *
 * ### Publishable-key note (B2 finding)
 *
 * `@clerk/backend` v3's `authenticateRequest` authenticates a *session token* through the full
 * Clerk request context, which requires the **publishable** key as well as the secret key
 * (it derives the instance's cookie names/issuer from it). The contract's server-side table
 * (§18.6) lists only `CLERK_SECRET_KEY`; the publishable key is not a secret, and the same value
 * already ships to the browser as `VITE_CLERK_PUBLISHABLE_KEY`. `index.ts` therefore accepts
 * `CLERK_PUBLISHABLE_KEY` or `VITE_CLERK_PUBLISHABLE_KEY` when present and warns once when it is
 * absent. Making it a startup refusal is B3's full configuration fail-fast, not B2's.
 */
import { createClerkClient } from '@clerk/backend';

import type { SessionVerifier, VerifiedIdentity } from './session-verifier.js';

/**
 * The signed-in auth object, as far as this adapter reads it.
 *
 * `sessionClaims` is intentionally `unknown`: the default Clerk session token carries `sub`,
 * `sid`, `iss`, … but not necessarily a profile. Only string `email`/`name` claims (added through
 * a custom session token) become `VerifiedIdentity.email`/`displayName`; their absence is not an
 * error — §18.1 makes both optional.
 */
export interface ClerkAuthObject {
  readonly userId?: string | null;
  readonly sessionClaims?: unknown;
}

/**
 * The subset of `@clerk/backend`'s `RequestState` this adapter needs.
 *
 * Structural, so a test can build one with three fields and production passes the SDK's real
 * object (which has many more). `isSignedIn` is the SDK's deprecated alias; it is still accepted
 * so a state produced by an older SDK version cannot accidentally become "signed out".
 */
export interface ClerkRequestState {
  readonly isAuthenticated: boolean;
  readonly isSignedIn?: boolean;
  toAuth(): ClerkAuthObject | null;
}

/**
 * The one SDK call this verifier delegates to.
 *
 * Injected by tests (`docs/CONTRACTS.md` §18 "no network in the suite"). It receives the
 * synthetic `Request` built from the raw cookie header, which is exactly what the real
 * `clerkClient.authenticateRequest` receives.
 */
export type ClerkAuthenticateRequest = (
  request: Request,
) => Promise<ClerkRequestState | null | undefined>;

/** Options for {@link createClerkSessionVerifier}. */
export interface ClerkSessionVerifierOptions {
  /**
   * `CLERK_SECRET_KEY`, server only (§18.6).
   *
   * Required: an empty value is a wiring error and throws at construction (startup), never
   * "every request is 401". The value is never echoed — not even inside the error.
   */
  readonly secretKey: string;
  /**
   * The **public** publishable key, if the process has it.
   *
   * See the file header: `@clerk/backend` needs it for session-token authentication. It is
   * public by definition and is never logged here.
   */
  readonly publishableKey?: string;
  /** Test seam. Production omits it and the SDK call is constructed from the keys. */
  readonly authenticateRequest?: ClerkAuthenticateRequest;
}

/**
 * A request URL the SDK can parse. The host is irrelevant to token verification (Clerk verifies
 * the JWT, not our origin) and `.invalid` is reserved, so this can never be mistaken for a real
 * deployment origin.
 */
const CLERK_REQUEST_URL = 'https://insighthub.invalid/api/session';

/**
 * Build the production verifier.
 *
 * @throws when `secretKey` is empty — a startup failure rather than a server that 401s forever.
 */
export function createClerkSessionVerifier(options: ClerkSessionVerifierOptions): SessionVerifier {
  const secretKey = typeof options.secretKey === 'string' ? options.secretKey.trim() : '';
  if (secretKey === '') {
    // Deliberately no value in the message: an error object ends up in operators' logs.
    throw new Error('createClerkSessionVerifier requires CLERK_SECRET_KEY (server only)');
  }

  const authenticate =
    options.authenticateRequest ??
    createSdkAuthenticateRequest({
      secretKey,
      ...(isNonEmpty(options.publishableKey) ? { publishableKey: options.publishableKey } : {}),
    });

  return {
    async verify(request: { cookie: string | undefined }): Promise<VerifiedIdentity | null> {
      const cookie = request.cookie;
      if (typeof cookie !== 'string' || cookie.trim() === '') return null;

      try {
        // Constructing a `Request` validates the header: a CR/LF in a hostile cookie throws a
        // `TypeError` here, which the catch turns into "not verified". The SDK also gets a
        // standard `Headers` view, so it cannot read anything but the cookie we pass.
        const clerkRequest = new Request(CLERK_REQUEST_URL, {
          method: 'GET',
          headers: { cookie },
        });
        const state = await authenticate(clerkRequest);
        return toVerifiedIdentity(state);
      } catch {
        // Intentionally silent: an SDK message can carry token material (§18.3).
        return null;
      }
    },
  };
}

/** The real `@clerk/backend` call, constructed once per verifier (no per-request client). */
function createSdkAuthenticateRequest(options: {
  readonly secretKey: string;
  readonly publishableKey?: string;
}): ClerkAuthenticateRequest {
  const client = createClerkClient({
    secretKey: options.secretKey,
    ...(options.publishableKey === undefined ? {} : { publishableKey: options.publishableKey }),
  });

  return async (request: Request) => await client.authenticateRequest(request);
}

/**
 * Normalise the SDK's `RequestState` into the frozen `VerifiedIdentity`, or `null`.
 *
 * No verification decision is made here beyond "the SDK said signed in, and its auth object
 * names a user": the signature, expiry, revocation and session lifetime are all Clerk's (§18.2).
 */
function toVerifiedIdentity(state: ClerkRequestState | null | undefined): VerifiedIdentity | null {
  if (state === null || state === undefined) return null;
  // `isAuthenticated` is the current field; `isSignedIn` is the deprecated alias.
  if (state.isAuthenticated !== true && state.isSignedIn !== true) return null;

  const auth = typeof state.toAuth === 'function' ? state.toAuth() : null;
  if (!isRecord(auth)) return null;

  const clerkUserId = typeof auth.userId === 'string' ? auth.userId.trim() : '';
  // An empty `sub` is a broken or hostile state. It must never become an identity: the mapping
  // is keyed by `clerk_user_id`, so every such request would collapse onto one internal user.
  if (clerkUserId === '') return null;

  const claims = isRecord(auth.sessionClaims) ? auth.sessionClaims : {};
  const email = readStringClaim(claims, 'email');
  const displayName = readStringClaim(claims, 'name') ?? readStringClaim(claims, 'full_name');

  return {
    clerkUserId,
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
  };
}

/** A trimmed, non-empty string claim, or `undefined`. Non-string claims are ignored. */
function readStringClaim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** True for a defined, non-blank string. */
function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A plain object (not an array, not `null`). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
