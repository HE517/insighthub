/**
 * # `authz/public.ts` — the ONLY authz surface another module may import
 *
 * A3 (Realtime Backend) wires the WebSocket enforcement points to **this file and nothing
 * else**. `apps/server/src/authz/**` is otherwise private: session storage, the membership
 * table, the demo fixture and the cookie parser are implementation and may change between
 * commits without a handoff.
 *
 * ```text
 * import { createAuthz, type AuthzService } from '../authz/public.js';
 * ```
 *
 * ## What A3 needs, and in what order
 *
 * | # | Need | Call | Semantics |
 * | --- | --- | --- | --- |
 * | 1 | upgrade: who is this? | `authz.resolveSession(request.headers.cookie)` | `AuthzSession \| null`. `null` ⇒ answer the upgrade with **HTTP 401** and establish no socket (§17.5). Never fall back to an identity from the payload/query. **M4 B1:** this is still the demo-session seam; B2 replaces the WS upgrade check with the Clerk `SessionVerifier`. |
 * | 2 | join: may this user read this room? | `authz.roleFor(documentId, userId)` then `authz.can(documentId, userId, 'canRead')` | `null` ⇒ **`ROOM_NOT_FOUND`** — the same code as an unknown document, because the non-disclosure rule needs one answer for both. |
 * | 3 | BINARY `SYNC`: may this user write? | `authz.can(documentId, userId, 'canEdit')` | `false` ⇒ reply **`FORBIDDEN`** (`WS_ERROR_CODES.FORBIDDEN`, non-fatal), do not apply, do not persist, do not broadcast, keep the socket open. |
 * | — | BINARY `AWARENESS` | `authz.can(documentId, userId, 'canRead')` | a viewer may publish its cursor; presence never requires `canEdit`. |
 *
 * ## M4 B1 — identity is resolved before authorization
 *
 * `authorizeDocument`/`listReadableDocuments` now take a **resolved internal `userId`**, not a
 * cookie. `resolveAuthenticatedUser` is the one function that turns a request into that id
 * (`AUTH_MODE=demo` → the existing demo session; `AUTH_MODE=clerk` → verified Clerk identity
 * → `app_user` mapping). The WS calls below are unchanged because they already receive a
 * `userId` from `resolveSession`.
 *
 * ## Non-negotiables that follow from the contract
 *
 * - **`join-room.mode` is never an input.** It stays in the schema for compatibility and is
 *   advisory only (§17.5, `docs/ARCHITECTURE.md` §8.3). The capability above is the answer.
 * - **No identity from the wire.** `userId` comes from `resolveSession`, i.e. from a server-side
 *   token. A `userId` in a payload, header or query must be ignored, not merely validated.
 * - **Both decisions are cheap and synchronous.** `roleFor`/`can` are synchronous by design: an
 *   `await` between "who is this" and "may they write" is a window in which the answer can
 *   change (`membership-store.ts` explains the reasoning).
 * - **A denied join must not evict a room the socket already holds.** That ordering is A3's to
 *   implement; this surface only supplies the decision.
 *
 * ## What this surface deliberately does not offer
 *
 * No `isAdmin`, no role mutation, no space/tenant check, no "full capabilities" enumeration.
 * §17.7 excludes a space entity and membership management in Phase 2, and a helper that returned
 * all four capabilities at once would invite a caller to make a decision from stale values
 * instead of asking again at the enforcement point.
 */
export {
  createAuthz,
  type AuthzOptions,
  type AuthzService,
  type AuthzSession,
  type BootstrapOutcome,
  type DocumentAccessDecision,
  type DocumentListDecision,
} from './authz.js';

export { SESSION_COOKIE_NAME } from './cookies.js';

export { SESSION_TTL_MS } from './session-store.js';

export { DEFAULT_DEMO_USER_ID, DEMO_IDENTITIES, type DemoIdentity } from './demo-fixture.js';

export type { DocumentCatalog } from './documents.js';

/* ------------------------------------------------------------------ *
 * M4 B1 — Clerk identity seam, internal user mapping, identity resolver
 * ------------------------------------------------------------------ */

export {
  createFakeSessionVerifier,
  type FakeSessionVerifierLookup,
  type SessionVerifier,
  type VerifiedIdentity,
} from './session-verifier.js';

export { isAppUserStore, type AppUser, type AppUserStore } from './app-user.js';

export {
  createIdentityDeps,
  resolveAuthenticatedUser,
  type AuthenticatedUser,
  type IdentityDeps,
  type IdentityOptions,
} from './identity.js';
