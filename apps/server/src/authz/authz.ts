/**
 * The authorization decision core.
 *
 * ```text
 * cookie → session → userId → document membership → DocumentRole
 *        → documentCapabilities → decision
 * ```
 *
 * (`docs/ARCHITECTURE.md` §8.1.) Every layer has exactly one decision point and all of them
 * live here; `app.ts` only maps decisions to HTTP responses and never decides anything itself.
 *
 * ## Two rules this file is built around
 *
 * 1. **`documentCapabilities` is the only rule table.** `can()` resolves a role and then calls
 *    the frozen predicate for that capability. There is no second table, no `role === 'editor'`
 *    comparison and no capability logic in a route handler. A duplicated rule is how a `canEdit`
 *    in HTTP and a `canEdit` in the WebSocket gate end up disagreeing, and the disagreement is
 *    always found after a viewer has already edited something.
 *
 * 2. **A caller never supplies identity.** `userId` enters this module from exactly one place —
 *    a token looked up in the session store. No method here accepts a user id from a request
 *    body, header or query. `bootstrap` accepts a *demo identity claim*, which is the one place
 *    §17.0 allows a claim, and even there the value is only ever matched against the roster.
 *
 * ## Non-disclosure is decided here, not in the HTTP layer
 *
 * `authorizeDocument` collapses three different caller states — unknown document, no
 * membership, membership without `canRead` — into the single `not_found` decision. Because it
 * is one branch producing one value, the three cases cannot drift into three different
 * responses; `forbidden` is produced only when `canRead` already held (§17.4).
 */
import {
  documentCapabilities,
  type DocumentCapability,
  type DocumentMeta,
  type DocumentRole,
} from '@insighthub/shared';

import { SESSION_COOKIE_NAME, readSessionCookie } from './cookies.js';
import {
  DEMO_MEMBERSHIPS,
  assertDemoFixtureIsConsistent,
  findDemoIdentity,
} from './demo-fixture.js';
import { DemoDocumentCatalog, type DocumentCatalog } from './documents.js';
import { openMembershipStore, type MembershipStore } from './membership-store.js';
import { SessionStore } from './session-store.js';

/** What a caller may learn about its own session (§17.4 response bodies). */
export interface AuthzSession {
  readonly userId: string;
  readonly displayName: string;
  /** ISO 8601. The absolute expiry of this token. */
  readonly expiresAt: string;
}

/**
 * Result of a bootstrap attempt.
 *
 * `token` is deliberately **not** part of `AuthzSession`: it exists only so the HTTP layer can
 * put it in a `Set-Cookie` header, and keeping it out of the session object is what makes
 * "the token never reaches a JSON body" a property of the types rather than of a code review.
 */
export type BootstrapOutcome =
  | { readonly kind: 'issued'; readonly token: string; readonly session: AuthzSession }
  | { readonly kind: 'invalid_demo_identity' };

/**
 * The answer to "may this request see this document?".
 *
 * Four cases, and no fifth: the non-disclosure rule needs `not_found` to be one value for three
 * caller states, so an `unknown_document` / `not_a_member` / `not_readable` split is not merely
 * unnecessary here — it is the bug the contract forbids.
 */
export type DocumentAccessDecision =
  | {
      readonly kind: 'granted';
      readonly document: DocumentMeta;
      readonly role: DocumentRole;
      readonly session: AuthzSession;
    }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'forbidden' };

/** The answer to "which documents may this caller list?". */
export type DocumentListDecision =
  | { readonly kind: 'listed'; readonly userId: string; readonly documents: readonly DocumentMeta[] }
  | { readonly kind: 'unauthenticated' };

export interface AuthzOptions {
  /** Directory holding `authz.db` — the same `INSIGHTHUB_DATA_PATH` the document store uses. */
  readonly dataPath: string;
  /**
   * Document metadata source. Defaults to the demo catalog; the durable source is A3's and is
   * injected here when it exists (`documentCatalog` seam, see `documents.ts`).
   */
  readonly documents?: DocumentCatalog;
  /**
   * Clock. A test seam: the 12 h lifetime is an absolute timestamp, so proving expiry without
   * it would mean a test that sleeps for 12 hours or mutates private state.
   */
  readonly now?: () => number;
}

/**
 * The stable authorization surface.
 *
 * A3 consumes exactly this through `authz/public.ts` (`docs/TASKS.md` M2 Phase 2 dependency
 * order). The three things the WS leg needs are `resolveSession`, `roleFor` and `can`; the rest
 * exists for the HTTP layer in this leg.
 */
export interface AuthzService {
  /** Cookie name the session travels in. Exposed so no caller hardcodes it. */
  readonly cookieName: string;
  /** Number of durable membership rows. Startup log only. */
  readonly membershipCount: number;

  /** Resolve a `Cookie` header value to the identity it denotes, or `null`. */
  resolveSession(cookieHeader: string | undefined): AuthzSession | null;

  /** Claim a demo identity and mint a session. Rotation revokes the caller's previous token. */
  bootstrap(demoUserId: unknown, cookieHeader: string | undefined): BootstrapOutcome;

  /** Revoke the session the cookie denotes. Returns whether a live session was destroyed. */
  destroySession(cookieHeader: string | undefined): boolean;

  /** The caller's role on one document, or `null` when there is no membership. */
  roleFor(documentId: string, userId: string): DocumentRole | null;

  /** The single capability question. Resolves a role, then asks `documentCapabilities`. */
  can(documentId: string, userId: string, capability: DocumentCapability): boolean;

  /** Authorize one document read (§17.4's 401 / 403 / 404 rule). */
  authorizeDocument(
    documentId: string,
    cookieHeader: string | undefined,
    capability: DocumentCapability,
  ): Promise<DocumentAccessDecision>;

  /** The documents where the caller has at least `canRead`. */
  listReadableDocuments(cookieHeader: string | undefined): Promise<DocumentListDecision>;

  close(): void;
}

class Authz implements AuthzService {
  readonly cookieName = SESSION_COOKIE_NAME;
  readonly #sessions: SessionStore;
  readonly #memberships: MembershipStore;
  readonly #documents: DocumentCatalog;

  constructor(sessions: SessionStore, memberships: MembershipStore, documents: DocumentCatalog) {
    this.#sessions = sessions;
    this.#memberships = memberships;
    this.#documents = documents;
  }

  get membershipCount(): number {
    return this.#memberships.count();
  }

  resolveSession(cookieHeader: string | undefined): AuthzSession | null {
    const record = this.#sessions.resolve(readSessionCookie(cookieHeader));
    if (record === null) return null;
    // The roster is a constant, so a session whose user is no longer in it cannot be described.
    // Failing closed (no session) is the safe reading: an identity the server cannot name is an
    // identity it should not authorize.
    const identity = findDemoIdentity(record.userId);
    if (identity === null) return null;
    return {
      userId: identity.userId,
      displayName: identity.displayName,
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  bootstrap(demoUserId: unknown, cookieHeader: string | undefined): BootstrapOutcome {
    const identity = findDemoIdentity(demoUserId);
    // §17.3: an unknown `demoUserId` is a 400 and **never** a new user.
    if (identity === null) return { kind: 'invalid_demo_identity' };

    // Rotation (§17.2): "each successful bootstrap issues a new token and invalidates the
    // previous one **for that client**". The previous token for this client is exactly the one
    // its cookie carries, which is why rotation is driven from the cookie and not from the
    // claimed identity — a re-bootstrap from a cookie-less client has nothing to rotate.
    const previousToken = readSessionCookie(cookieHeader);
    if (previousToken !== null) this.#sessions.revoke(previousToken);

    const record = this.#sessions.issue(identity.userId);
    return {
      kind: 'issued',
      token: record.token,
      session: {
        userId: identity.userId,
        displayName: identity.displayName,
        expiresAt: new Date(record.expiresAt).toISOString(),
      },
    };
  }

  destroySession(cookieHeader: string | undefined): boolean {
    const token = readSessionCookie(cookieHeader);
    if (token === null) return false;
    return this.#sessions.revoke(token);
  }

  roleFor(documentId: string, userId: string): DocumentRole | null {
    if (documentId.length === 0 || userId.length === 0) return null;
    return this.#memberships.roleFor(documentId, userId);
  }

  can(documentId: string, userId: string, capability: DocumentCapability): boolean {
    const role = this.roleFor(documentId, userId);
    if (role === null) return false;
    // The only rule table in the system (§2 / §8.1).
    return documentCapabilities[capability](role);
  }

  async authorizeDocument(
    documentId: string,
    cookieHeader: string | undefined,
    capability: DocumentCapability,
  ): Promise<DocumentAccessDecision> {
    const session = this.resolveSession(cookieHeader);
    if (session === null) return { kind: 'unauthenticated' };

    // Branch 1 — the non-disclosure branch. Three caller states (no membership, a membership
    // that somehow cannot read, an unknown document) all leave through this one value, so the
    // responses cannot differ in status, body or headers (§17.4).
    const role = this.roleFor(documentId, session.userId);
    if (role === null || !documentCapabilities.canRead(role)) return { kind: 'not_found' };

    const document = await this.#documents.get(documentId);
    if (document === null) return { kind: 'not_found' };

    // Branch 2 — the caller can read, so existence is no longer a secret and a refusal may say
    // why. `can()` is used rather than a second capability lookup so the rule stays in one place.
    if (!this.can(documentId, session.userId, capability)) return { kind: 'forbidden' };

    return { kind: 'granted', document, role, session };
  }

  async listReadableDocuments(cookieHeader: string | undefined): Promise<DocumentListDecision> {
    const session = this.resolveSession(cookieHeader);
    if (session === null) return { kind: 'unauthenticated' };

    const documents: DocumentMeta[] = [];
    for (const row of this.#memberships.rowsForUser(session.userId)) {
      // One rule, used everywhere: the list is exactly "documents where `canRead` holds".
      if (!this.can(row.documentId, session.userId, 'canRead')) continue;
      const document = await this.#documents.get(row.documentId);
      // A membership pointing at a document the catalog does not know grants nothing. Skipping
      // it (instead of inventing metadata) keeps the list a subset of what a direct GET grants.
      if (document === null) continue;
      documents.push(document);
    }
    // Deterministic order: the response must not depend on SQLite's row order.
    documents.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return { kind: 'listed', userId: session.userId, documents };
  }

  close(): void {
    this.#sessions.clear();
    this.#memberships.close();
  }
}

/**
 * Open the authorization subsystem.
 *
 * Order matters and mirrors `openDocumentStore`: the runtime is verified, the durable rows are
 * opened, the fixture is validated, and only then is a service handed out. A broken fixture or
 * an unwritable data directory therefore fails **at startup**, not as a `404` nobody can explain.
 */
export async function createAuthz(options: AuthzOptions): Promise<AuthzService> {
  // Throws with a list of problems when the demo fixture contradicts itself. Cheap, and it
  // turns "the demo shows a 404 for a document it lists" into a startup failure.
  assertDemoFixtureIsConsistent();

  const memberships = await openMembershipStore(options.dataPath);
  try {
    // Seeding is idempotent (`INSERT OR IGNORE`), so a restart keeps whatever the table holds
    // and only fills in rows that are missing — membership survives a process restart because it
    // is *stored*, not because it is re-applied.
    memberships.seed(DEMO_MEMBERSHIPS);
  } catch (error) {
    memberships.close();
    throw error;
  }

  const documents = options.documents ?? new DemoDocumentCatalog();
  const sessions = new SessionStore(options.now ?? Date.now);
  return new Authz(sessions, memberships, documents);
}
