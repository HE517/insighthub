/**
 * A **permissive** `AuthzService` double for the M1/M2-P0 suites.
 *
 * ## Why this file exists, and what it is not
 *
 * The M1/M2-P0 tests are about room mechanics: membership cardinality, atomic replace, sync
 * relay, hydration, persistence. They join arbitrary document ids (`doc-roster`,
 * `doc-solo-a`, …) that exist in no membership table, and they never bootstrap a session —
 * because at the time they were written there was no authorization layer to satisfy.
 *
 * Turning the real decision core on for those suites would do one of two useless things:
 * deny every join (`ROOM_NOT_FOUND`, since no membership exists), or force every test to
 * first create a membership — which the public surface cannot do (`membership-store.ts` is
 * private to A5). Either way the suites would stop testing room mechanics and start testing
 * fixture wiring.
 *
 * So the harness default is this double: *everyone may read and edit everything*. That is
 * exactly what those tests assume, stated once instead of implied.
 *
 * ## It is never a production path
 *
 * `apps/server/src/index.ts` always constructs the real service and
 * `attachWebSocketServer` **refuses to start** when a data-path-configured server has no
 * `authz` (`docs/DECISIONS.md` D-062 point 4 applied to the WS seam). The only caller of this
 * file is `test-harness.ts`, and the Phase 2 suites that actually test enforcement ask for
 * `authorization: 'enforced'` and get the real service.
 *
 * ## It cannot accrue rules
 *
 * `roleFor` returns a constant and `can` delegates to the frozen `documentCapabilities` table
 * rather than answering `true` per capability. If someone ever adds a capability, this double
 * follows it automatically — it has no policy of its own to drift from A5's.
 */
import {
  documentCapabilities,
  type DocumentCapability,
  type DocumentMeta,
  type DocumentRole,
} from '@insighthub/shared';

import type {
  AuthzService,
  AuthzSession,
  BootstrapOutcome,
  DocumentAccessDecision,
  DocumentListDecision,
} from '../authz/public.js';
import { SESSION_COOKIE_NAME } from '../authz/public.js';

/** The identity every permissively-wired socket speaks for. */
export const PERMISSIVE_TEST_USER_ID = 'test-permissive-user';

/**
 * The role the double reports for every document.
 *
 * `owner` because the suites exercise behaviour that a viewer is (correctly) not allowed to
 * do — writing documents, for one. Reporting a narrower role would make those tests fail for
 * an authorization reason they are not about.
 */
const PERMISSIVE_TEST_ROLE: DocumentRole = 'owner';

export class PermissiveTestAuthz implements AuthzService {
  readonly cookieName = SESSION_COOKIE_NAME;
  readonly membershipCount = 0;

  /**
   * Always a session, whoever asks.
   *
   * Returning a session for `undefined` is the point: the M1-era `TestClient` connects with no
   * cookie, and a double that demanded one would force every legacy test to bootstrap before
   * its first assertion.
   */
  resolveSession(): AuthzSession | null {
    return {
      userId: PERMISSIVE_TEST_USER_ID,
      displayName: 'Permissive Test User',
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    };
  }

  /** Unsupported in this mode. Returns the vocabulary's own refusal rather than inventing one. */
  bootstrap(): BootstrapOutcome {
    return { kind: 'invalid_demo_identity' };
  }

  destroySession(): boolean {
    return false;
  }

  roleFor(): DocumentRole | null {
    return PERMISSIVE_TEST_ROLE;
  }

  /** The frozen rule table, applied to the constant role — no second policy. */
  can(_documentId: string, _userId: string, capability: DocumentCapability): boolean {
    return documentCapabilities[capability](PERMISSIVE_TEST_ROLE);
  }

  /**
   * Not used by the socket layer, and deliberately fail-closed: if someone ever passes this
   * double to `createApp`, the HTTP surface answers "unauthenticated" rather than granting
   * everything.
   */
  async authorizeDocument(): Promise<DocumentAccessDecision> {
    return { kind: 'unauthenticated' };
  }

  async listReadableDocuments(): Promise<DocumentListDecision> {
    return { kind: 'unauthenticated' };
  }

  close(): void {
    // Holds no resources.
  }
}

/** Not used by the double; exported so a test can build a `DocumentMeta` if it needs one. */
export function permissiveDocumentMeta(documentId: string): DocumentMeta {
  const now = new Date(0).toISOString();
  return {
    id: documentId,
    title: documentId,
    revision: 0,
    ownerId: PERMISSIVE_TEST_USER_ID,
    createdAt: now,
    updatedAt: now,
  };
}
