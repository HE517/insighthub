/**
 * # DEMO FIXTURE — not user data, not a feature
 *
 * Server-side constants for the two things Phase 2 needs to be *exercisable*: who may claim an
 * identity (`docs/CONTRACTS.md` §17.3 roster) and which document a given demo user may read,
 * comment on, edit or manage (the seeded membership fixture).
 *
 * Everything in this file is **demo data owned by A5**. Reading it as a product feature is a
 * mistake this header exists to prevent:
 *
 * | What it is | What it is **not** |
 * | --- | --- |
 * | A fixed list of demo identities | a user table, a signup flow, a profile store |
 * | A seeded membership fixture | membership management, invitations, an admin UI |
 * | Demo document metadata | the durable documents source (that is A3's `persistence/**`) |
 *
 * §17.3 is explicit that an unknown `demoUserId` is a `400` and **never** a new user, so this
 * list is the whole of the user universe: there is no code path that adds to it.
 *
 * ## Why the document catalog is here at all
 *
 * `GET /api/documents` and `GET /api/documents/:id` return `DocumentMeta` (§17.4), and the
 * membership rows alone do not carry a title. The durable documents source is A3's
 * (`apps/server/src/persistence/**`, read-only documents data source in the next leg), so this
 * round injects a **demo catalog** through the `DocumentCatalog` seam and labels it here.
 * `createAuthz({ documents })` accepts a replacement, which is how the real source lands
 * without touching `authz/**`.
 *
 * ## Why the timestamps are fixed constants
 *
 * A fixture whose `createdAt` is `new Date()` makes every assertion about it depend on the
 * clock. These are fixed instants so a test can compare whole `DocumentMeta` objects.
 */
import {
  documentMetaSchema,
  isDocumentRole,
  type DocumentMeta,
} from '@insighthub/shared';

import type { MembershipRow } from './membership-store.js';

/** One demo identity. `userId` is the stable id; `displayName` is what presence shows. */
export interface DemoIdentity {
  readonly userId: string;
  readonly displayName: string;
}

/**
 * The roster (§17.3). Exactly three identities, fixed ids, no roles attached.
 *
 * Roles deliberately do **not** live here: the same identity is an `owner` of one document and
 * a `commenter` of another, which is the whole point of document-level membership. A
 * "role on the user" field would collapse two layers that §17/§8.1 keep apart.
 *
 * Names avoid the substring `You`: the web UI labels the local session "You", and a demo name
 * containing it would make "is this the local caret or a remote one?" ambiguous in the
 * presence UI and in the browser suite's assertions.
 */
export const DEMO_IDENTITIES: readonly DemoIdentity[] = [
  { userId: 'demo-ada', displayName: 'Ada Lovelace' },
  { userId: 'demo-grace', displayName: 'Grace Hopper' },
  { userId: 'demo-linus', displayName: 'Linus Torvalds' },
];

/** The identity a client claims when it has no reason to pick another one. */
export const DEFAULT_DEMO_USER_ID = 'demo-ada';

/** Look up a roster entry. Returns `null` for anything that is not an exact roster id. */
export function findDemoIdentity(demoUserId: unknown): DemoIdentity | null {
  if (typeof demoUserId !== 'string') return null;
  return DEMO_IDENTITIES.find((identity) => identity.userId === demoUserId) ?? null;
}

/** A seeded membership row: the durable unit of authorization (§17.3). */
export type DemoMembership = MembershipRow;

/**
 * Demo documents.
 *
 * `demo-document` is the id the web client opens by default
 * (`apps/web/src/store/documentSlice.ts`), so the default page load is a document with three
 * distinct roles on it rather than a 404.
 */
export const DEMO_DOCUMENTS: readonly DocumentMeta[] = [
  {
    id: 'demo-document',
    title: 'Demo document',
    revision: 0,
    ownerId: 'demo-ada',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'demo-team-notes',
    title: 'Team notes',
    revision: 0,
    ownerId: 'demo-grace',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'demo-private-notes',
    title: 'Private notes',
    revision: 0,
    ownerId: 'demo-ada',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
];

/**
 * Demo memberships — the fixture that makes every role reachable (§17.3).
 *
 * The coverage is deliberate and the table is small on purpose:
 *
 * | Document | ada | grace | linus |
 * | --- | --- | --- | --- |
 * | `demo-document` | owner | editor | viewer |
 * | `demo-team-notes` | commenter | owner | — (no membership) |
 * | `demo-private-notes` | owner | — (no membership) | — (no membership) |
 *
 * `commenter` has to be somebody's *highest* role somewhere, otherwise "commenter cannot edit"
 * could never be told apart from "commenter is not really a member". `linus` has no row on two
 * documents, which is the "not yours" case of the non-disclosure rule (§17.4).
 */
export const DEMO_MEMBERSHIPS: readonly DemoMembership[] = [
  { documentId: 'demo-document', userId: 'demo-ada', role: 'owner' },
  { documentId: 'demo-document', userId: 'demo-grace', role: 'editor' },
  { documentId: 'demo-document', userId: 'demo-linus', role: 'viewer' },
  { documentId: 'demo-team-notes', userId: 'demo-grace', role: 'owner' },
  { documentId: 'demo-team-notes', userId: 'demo-ada', role: 'commenter' },
  { documentId: 'demo-private-notes', userId: 'demo-ada', role: 'owner' },
];

/**
 * Fail fast when the fixture has drifted from what it claims.
 *
 * Two independent things are checked, and both would otherwise be silent:
 *
 * 1. **Schema conformance** — every demo document must satisfy the frozen `DocumentMeta`
 *    schema. A fixture that is not a valid `DocumentMeta` would make `GET /api/documents`
 *    return something no client may parse.
 * 2. **Referential integrity** — every membership must point at a roster user and a catalog
 *    document, and every document must have at least one membership. A membership row for an
 *    unknown user grants nothing, and a document nobody can read is a fixture bug that shows
 *    up as a confusing `404` in a report instead of as a startup failure here.
 *
 * Called from `createAuthz`, so a broken fixture refuses to start rather than producing an
 * authorization surface that quietly answers wrong.
 */
export function assertDemoFixtureIsConsistent(): void {
  const problems: string[] = [];

  for (const candidate of DEMO_DOCUMENTS) {
    const parsed = documentMetaSchema.safeParse(candidate);
    if (!parsed.success) {
      problems.push(`document ${candidate.id}: not a valid DocumentMeta`);
    }
  }

  const documentIds = new Set(DEMO_DOCUMENTS.map((document) => document.id));
  const userIds = new Set(DEMO_IDENTITIES.map((identity) => identity.userId));
  const seenPairs = new Set<string>();
  const documentedIds = new Set<string>();

  for (const membership of DEMO_MEMBERSHIPS) {
    if (!documentIds.has(membership.documentId)) {
      problems.push(`membership ${membership.documentId}/${membership.userId}: unknown document`);
    }
    if (!userIds.has(membership.userId)) {
      problems.push(`membership ${membership.documentId}/${membership.userId}: unknown user`);
    }
    if (!isDocumentRole(membership.role)) {
      problems.push(`membership ${membership.documentId}/${membership.userId}: invalid role`);
    }
    const pair = `${membership.documentId}\u0000${membership.userId}`;
    if (seenPairs.has(pair)) {
      problems.push(`membership ${membership.documentId}/${membership.userId}: duplicate`);
    }
    seenPairs.add(pair);
    documentedIds.add(membership.documentId);
  }

  for (const document of DEMO_DOCUMENTS) {
    if (!documentedIds.has(document.id)) {
      problems.push(`document ${document.id}: no membership grants access to it`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`the demo authorization fixture is inconsistent: ${problems.join('; ')}`);
  }
}
