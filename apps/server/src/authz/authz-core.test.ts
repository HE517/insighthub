/**
 * The decision core: roster, durable membership, `roleFor`, `can`, and the non-disclosure branch.
 *
 * Layer: **Node only** — this file is about the decisions themselves. The HTTP status each
 * decision maps to is proven in `http-session.test.ts` (P2-3) and
 * `capability-matrix.test.ts` (P2-4/P2-6).
 *
 * Every assertion about capabilities is written as an equality against
 * `documentCapabilities[capability](role)` rather than as a hardcoded `true`/`false`. That is
 * deliberate: if the frozen rule table ever changes, these tests move with it instead of encoding
 * a second copy of the rules that could drift from it.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DOCUMENT_ROLES,
  documentCapabilities,
  type DocumentCapability,
  type DocumentRole,
} from '@insighthub/shared';

import { createAuthz, type AuthzService } from './authz.js';
import {
  DEMO_DOCUMENTS,
  DEMO_IDENTITIES,
  DEMO_MEMBERSHIPS,
  assertDemoFixtureIsConsistent,
} from './demo-fixture.js';
import { DemoDocumentCatalog } from './documents.js';
import { openMembershipStore } from './membership-store.js';
import { loadSqliteModule } from '../persistence/sqlite-runtime.js';
import { AUTHZ_DATABASE_FILE_NAME } from './membership-store.js';

const CAPABILITIES: readonly DocumentCapability[] = [
  'canRead',
  'canComment',
  'canEdit',
  'canManageMembers',
];

/**
 * One live `(documentId, userId)` pair per role, taken from the demo fixture.
 *
 * The fixture is built so each role is somebody's **highest** role on some document — that is
 * what makes "commenter cannot edit" a real refusal rather than a missing membership.
 */
const CALLER_FOR_ROLE: Record<DocumentRole, { readonly documentId: string; readonly userId: string }> = {
  viewer: { documentId: 'demo-document', userId: 'demo-linus' },
  commenter: { documentId: 'demo-team-notes', userId: 'demo-ada' },
  editor: { documentId: 'demo-document', userId: 'demo-grace' },
  owner: { documentId: 'demo-document', userId: 'demo-ada' },
};

let dataPath = '';
let authz: AuthzService;

before(async () => {
  dataPath = await mkdtemp(join(tmpdir(), 'insighthub-authz-core-'));
  authz = await createAuthz({ dataPath });
});

after(async () => {
  authz.close();
  await rm(dataPath, { recursive: true, force: true });
});

describe('demo roster (§17.3)', () => {
  it('is a fixed, server-side list of exactly three identities', () => {
    assert.equal(DEMO_IDENTITIES.length, 3);
    const ids = DEMO_IDENTITIES.map((identity) => identity.userId);
    assert.equal(new Set(ids).size, 3, 'ids must be unique');
    for (const identity of DEMO_IDENTITIES) {
      assert.ok(identity.userId.length > 0);
      assert.ok(identity.displayName.length > 0);
      // The web UI labels the local session "You"; a demo name containing it would make the
      // local/remote distinction in the presence UI ambiguous.
      assert.ok(!identity.displayName.includes('You'), identity.displayName);
    }
  });

  it('never creates a user from an unknown claim', () => {
    // §17.3: an unknown demoUserId is a 400, never a new user. The core answers
    // `invalid_demo_identity` for every shape of junk, so no route can turn input into identity.
    const junk: unknown[] = [
      'demo-nobody',
      '',
      undefined,
      null,
      42,
      { userId: 'demo-ada' },
      ['demo-ada'],
      true,
    ];
    for (const claim of junk) {
      assert.equal(
        authz.bootstrap(claim, undefined).kind,
        'invalid_demo_identity',
        `claim ${JSON.stringify(claim)} must not create an identity`,
      );
    }
    // And the roster is unchanged afterwards: still three, and no session was minted.
    assert.equal(DEMO_IDENTITIES.length, 3);
  });

  it('has a self-consistent fixture', () => {
    // Throws with a list of problems when a membership points at an unknown user/document, a
    // document has no membership, or the metadata is not a valid DocumentMeta.
    assert.doesNotThrow(() => assertDemoFixtureIsConsistent());
    assert.ok(DEMO_MEMBERSHIPS.length >= DOCUMENT_ROLES.length, 'every role must be reachable');
  });
});

describe('roleFor — membership is the only source of a role', () => {
  it('returns exactly the seeded role for every fixture row', () => {
    for (const membership of DEMO_MEMBERSHIPS) {
      assert.equal(
        authz.roleFor(membership.documentId, membership.userId),
        membership.role,
        `${membership.userId} on ${membership.documentId}`,
      );
    }
  });

  it('returns null for a non-member, an unknown document and an unknown user', () => {
    // `null` is the single value that drives the non-disclosure 404, so it must not be
    // conflated with a default role.
    assert.equal(authz.roleFor('demo-private-notes', 'demo-grace'), null);
    assert.equal(authz.roleFor('demo-team-notes', 'demo-linus'), null);
    assert.equal(authz.roleFor('no-such-document', 'demo-ada'), null);
    assert.equal(authz.roleFor('demo-document', 'demo-nobody'), null);
    assert.equal(authz.roleFor('', 'demo-ada'), null);
    assert.equal(authz.roleFor('demo-document', ''), null);
  });
});

describe('can — one rule table, reused (P2-4 core level)', () => {
  it('agrees with documentCapabilities for every role × capability', () => {
    // Table-driven on purpose: 4 roles × 4 capabilities, and the expected value is computed from
    // the shared predicate rather than written by hand.
    for (const role of DOCUMENT_ROLES) {
      const caller = CALLER_FOR_ROLE[role];
      for (const capability of CAPABILITIES) {
        const expected = documentCapabilities[capability](role);
        assert.equal(
          authz.can(caller.documentId, caller.userId, capability),
          expected,
          `${role} ${capability}`,
        );
      }
    }
  });

  it('denies every capability when there is no membership', () => {
    for (const capability of CAPABILITIES) {
      assert.equal(
        authz.can('demo-private-notes', 'demo-grace', capability),
        false,
        `non-member must not have ${capability}`,
      );
    }
  });

  it('grants canManageMembers to the owner and to nobody else (P2-6)', () => {
    for (const role of DOCUMENT_ROLES) {
      const caller = CALLER_FOR_ROLE[role];
      assert.equal(
        authz.can(caller.documentId, caller.userId, 'canManageMembers'),
        role === 'owner',
        `${role} canManageMembers`,
      );
    }
  });

  it('does not let a higher role imply a lower one on a different document', () => {
    // `ada` owns `demo-document` and is only a commenter on `demo-team-notes`. If roles leaked
    // across documents — a per-user role cache, say — this would be the first thing to break.
    assert.equal(authz.can('demo-document', 'demo-ada', 'canEdit'), true);
    assert.equal(authz.can('demo-team-notes', 'demo-ada', 'canEdit'), false);
    assert.equal(authz.can('demo-team-notes', 'demo-ada', 'canComment'), true);
  });
});

describe('membership durability (P2-5, Node half)', () => {
  it('survives a process restart because the row is stored, not recomputed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'insighthub-authz-restart-'));

    try {
      const first = await createAuthz({ dataPath: directory });
      const seeded = first.membershipCount;
      assert.equal(seeded, DEMO_MEMBERSHIPS.length);
      first.close();

      // Insert a row the fixture would **never** seed. If a restart merely re-applied the
      // fixture, this role would be absent; because it is read from the table, it survives.
      const store = await openMembershipStore(directory);
      store.seed([{ documentId: 'demo-private-notes', userId: 'demo-grace', role: 'viewer' }]);
      store.close();

      const second = await createAuthz({ dataPath: directory });
      try {
        assert.equal(second.roleFor('demo-private-notes', 'demo-grace'), 'viewer');
        // Seeding is idempotent: reopening did not duplicate the six fixture rows.
        assert.equal(second.membershipCount, DEMO_MEMBERSHIPS.length + 1);
        // The rest of the fixture is intact.
        assert.equal(second.roleFor('demo-document', 'demo-ada'), 'owner');
      } finally {
        second.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when a stored role is not a DocumentRole', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'insighthub-authz-corrupt-'));

    try {
      const seed = await createAuthz({ dataPath: directory });
      seed.close();

      // Corrupt exactly one row, the way a hand edit or a future vocabulary would.
      const sqlite = await loadSqliteModule();
      const db = new sqlite.DatabaseSync(join(directory, AUTHZ_DATABASE_FILE_NAME));
      try {
        db.prepare('UPDATE authz_document_membership SET role = ? WHERE document_id = ? AND user_id = ?').run(
          'wizard',
          'demo-document',
          'demo-grace',
        );
      } finally {
        db.close();
      }

      const reopened = await createAuthz({ dataPath: directory });
      try {
        // Not a default role, not a crash: "no membership", which is the 404 branch.
        assert.equal(reopened.roleFor('demo-document', 'demo-grace'), null);
        assert.equal(reopened.can('demo-document', 'demo-grace', 'canRead'), false);
        // The other rows are unaffected.
        assert.equal(reopened.roleFor('demo-document', 'demo-ada'), 'owner');
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('authorizeDocument — the non-disclosure branch', () => {
  it('collapses unknown document, no membership and unreadable membership into not_found', async () => {
    const session = authz.bootstrap('demo-grace', undefined);
    assert.equal(session.kind, 'issued');
    if (session.kind !== 'issued') return;

    // `grace` has no membership on either document; `no-such-document` exists for nobody.
    // A document that exists in the membership table but not in the catalog is a third shape
    // (membership present, metadata absent) and it must also be `not_found`.
    const catalogWithoutDemoDocument = new DemoDocumentCatalog(
      DEMO_DOCUMENTS.filter((document) => document.id !== 'demo-document'),
    );
    const withoutMetadataDirectory = await mkdtemp(join(tmpdir(), 'insighthub-authz-nocat-'));
    const withoutMetadata = await createAuthz({
      dataPath: withoutMetadataDirectory,
      documents: catalogWithoutDemoDocument,
    });

    try {
      const cookie = `insighthub_session=${session.token}`;

      for (const documentId of ['demo-private-notes', 'no-such-document']) {
        const decision = await authz.authorizeDocument(documentId, cookie, 'canRead');
        assert.equal(decision.kind, 'not_found', documentId);
      }

      // Ownership of `demo-document` is real, but this catalog cannot describe it.
      const adaSession = authz.bootstrap('demo-ada', undefined);
      assert.equal(adaSession.kind, 'issued');
      if (adaSession.kind !== 'issued') return;
      const adaCookie = `insighthub_session=${adaSession.token}`;
      assert.equal((await authz.authorizeDocument('demo-document', adaCookie, 'canRead')).kind, 'granted');

      // A session is process-scoped, so the second authz instance needs its own bootstrap: the
      // first instance's token means nothing to it (that is the stated limitation, not a bug).
      const secondSession = withoutMetadata.bootstrap('demo-ada', undefined);
      assert.equal(secondSession.kind, 'issued');
      if (secondSession.kind !== 'issued') return;
      assert.equal(
        (
          await withoutMetadata.authorizeDocument(
            'demo-document',
            `insighthub_session=${secondSession.token}`,
            'canRead',
          )
        ).kind,
        'not_found',
        'membership without metadata must not fabricate a document',
      );
    } finally {
      withoutMetadata.close();
      await rm(withoutMetadataDirectory, { recursive: true, force: true });
    }
  });

  it('answers unauthenticated without a session, before looking at the document', async () => {
    for (const cookie of [undefined, '', 'insighthub_session=', 'insighthub_session=not-a-token']) {
      assert.equal(
        (await authz.authorizeDocument('demo-document', cookie, 'canRead')).kind,
        'unauthenticated',
        `cookie ${JSON.stringify(cookie)}`,
      );
    }
  });

  it('reports forbidden only when canRead already held', async () => {
    const session = authz.bootstrap('demo-linus', undefined); // viewer on demo-document
    assert.equal(session.kind, 'issued');
    if (session.kind !== 'issued') return;
    const cookie = `insighthub_session=${session.token}`;

    // A viewer can read, so existence is no longer a secret and the refusal may say why.
    const decision = await authz.authorizeDocument('demo-document', cookie, 'canEdit');
    assert.equal(decision.kind, 'forbidden');
    // …but on a document it cannot read at all, the same capability yields the opaque answer.
    assert.equal(
      (await authz.authorizeDocument('demo-private-notes', cookie, 'canEdit')).kind,
      'not_found',
    );
  });

  it('lists exactly the documents where canRead holds, in a deterministic order', async () => {
    const expectations: Record<string, string[]> = {
      'demo-ada': ['demo-document', 'demo-private-notes', 'demo-team-notes'],
      'demo-grace': ['demo-document', 'demo-team-notes'],
      'demo-linus': ['demo-document'],
    };

    for (const [demoUserId, expected] of Object.entries(expectations)) {
      const session = authz.bootstrap(demoUserId, undefined);
      assert.equal(session.kind, 'issued');
      if (session.kind !== 'issued') return;
      const decision = await authz.listReadableDocuments(`insighthub_session=${session.token}`);
      assert.equal(decision.kind, 'listed');
      if (decision.kind !== 'listed') return;
      assert.deepEqual(
        decision.documents.map((document) => document.id),
        expected,
        demoUserId,
      );
      assert.equal(decision.userId, demoUserId);
    }
  });
});
