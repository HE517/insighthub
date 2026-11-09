/**
 * **P0-2 member transactions** — the store-level invariants behind the HTTP API.
 *
 * Layer: **Node only**, real SQLite in a temporary data directory. The claims here cannot be
 * made through the HTTP surface alone:
 *
 * - every write re-checks the Owner **inside** its transaction, so two concurrent transfers
 *   cannot both succeed;
 * - a failure in the middle of a transfer rolls the demotion back, leaving exactly one owner;
 * - the owner row is immutable through change/remove/leave and those refusals write nothing.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createAuthz, type AuthzService } from './authz.js';
import { isAppUserStore } from './app-user.js';
import {
  createMemberService,
  type MemberErrorCode,
  type MemberService,
} from './members.js';
import { openMembershipStore, type MembershipRow } from './membership-store.js';
import { isDocumentCreationStore } from '../persistence/document-creation.js';
import { isDocumentMetaStore, StoreDocumentCatalog } from '../persistence/document-meta.js';
import { openDocumentStore } from '../persistence/open-store.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { loadSqliteModule } from '../persistence/sqlite-runtime.js';

describe('P0-2 member transactions', () => {
  let dataPath = '';
  let opened: Awaited<ReturnType<typeof openDocumentStore>>;
  let authz: AuthzService;
  let members: MemberService;

  before(async () => {
    dataPath = await mkdtemp(join(tmpdir(), 'insighthub-members-'));
    opened = await openDocumentStore(dataPath);
    const documents = isDocumentMetaStore(opened.store)
      ? new StoreDocumentCatalog(opened.store)
      : undefined;
    authz = await createAuthz({
      dataPath,
      ...(documents === undefined ? {} : { documents }),
    });
    members = await createMemberService({
      dataPath,
      authz,
      appUsers: isAppUserStore(opened.store) ? opened.store : null,
      demoEmails: true,
    });
  });

  after(async () => {
    members.close();
    authz.close();
    await opened.store.close();
    await rm(dataPath, { recursive: true, force: true });
  });

  async function newDocument(): Promise<string> {
    const documentId = `members-${randomUUID()}`;
    const store = opened.store;
    assert.ok(isDocumentCreationStore(store));
    await store.createDocumentWithOwner({
      documentId,
      title: 'Members',
      ownerUserId: 'demo-ada',
    });
    return documentId;
  }

  async function rowsFor(documentId: string): Promise<readonly MembershipRow[]> {
    const store = await openMembershipStore(dataPath);
    try {
      return store.rowsForDocument(documentId);
    } finally {
      store.close();
    }
  }

  function expectRefusal<T>(
    outcome: { ok: true; value: T } | { ok: false; code: MemberErrorCode },
    code: MemberErrorCode,
  ): void {
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.code, code);
  }

  it('refuses to remove, demote or leave the Owner and writes nothing', async () => {
    const documentId = await newDocument();
    assert.equal((await members.invite(documentId, 'demo-ada', 'grace@insighthub.test', 'editor')).ok, true);

    expectRefusal(await members.leave(documentId, 'demo-ada'), 'last_owner');
    expectRefusal(await members.remove(documentId, 'demo-ada', 'demo-ada'), 'owner_requires_transfer');
    expectRefusal(
      await members.changeRole(documentId, 'demo-ada', 'demo-ada', 'editor'),
      'owner_role_immutable',
    );

    // The target owner was not touched by any of the three refusals.
    assert.deepEqual(
      (await rowsFor(documentId)).map((row) => ({ userId: row.userId, role: row.role })),
      [
        { userId: 'demo-ada', role: 'owner' },
        { userId: 'demo-grace', role: 'editor' },
      ],
    );
  });

  it('keeps exactly one owner when two transfers race', async () => {
    const documentId = await newDocument();
    assert.equal((await members.invite(documentId, 'demo-ada', 'grace@insighthub.test', 'editor')).ok, true);
    assert.equal((await members.invite(documentId, 'demo-ada', 'linus@insighthub.test', 'viewer')).ok, true);

    // Both requests were authorized while ada was still the Owner; only the first transaction
    // may commit. The loser must be refused on the Owner row it now finds.
    const [first, second] = await Promise.all([
      members.transferOwner(documentId, 'demo-ada', 'demo-grace'),
      members.transferOwner(documentId, 'demo-ada', 'demo-linus'),
    ]);
    const successes = [first, second].filter((outcome) => outcome.ok);
    const failures = [first, second].filter((outcome) => !outcome.ok);
    assert.equal(successes.length, 1, 'exactly one transfer may commit');
    assert.equal(failures.length, 1, 'the losing transfer must be refused');
    assert.equal((failures[0] as { ok: false; code: string }).code, 'forbidden');

    const rows = await rowsFor(documentId);
    assert.equal(rows.filter((row) => row.role === 'owner').length, 1, 'exactly one owner row');
    const owner = rows.find((row) => row.role === 'owner');
    assert.ok(owner?.userId === 'demo-grace' || owner?.userId === 'demo-linus');
    assert.equal(rows.find((row) => row.userId === 'demo-ada')?.role, 'editor');
  });

  it('rolls the transfer back when the promotion statement fails', async () => {
    const documentId = await newDocument();
    assert.equal((await members.invite(documentId, 'demo-ada', 'linus@insighthub.test', 'viewer')).ok, true);

    // Real SQLite failure injection: abort the promotion (`linus` → owner). The demotion of ada
    // runs first, so the surrounding transaction is what restores the pre-transfer state.
    const sqlite = await loadSqliteModule();
    const db = new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(`
        CREATE TRIGGER inject_member_promotion_failure
        BEFORE UPDATE ON authz_document_membership
        WHEN NEW.user_id = 'demo-linus' AND NEW.role = 'owner'
        BEGIN
          SELECT RAISE(ABORT, 'injected promotion failure');
        END
      `);

      await assert.rejects(
        async () => await members.transferOwner(documentId, 'demo-ada', 'demo-linus'),
        /injected promotion failure/,
      );
    } finally {
      try {
        db.exec('DROP TRIGGER IF EXISTS inject_member_promotion_failure');
      } finally {
        db.close();
      }
    }

    // Nothing changed: ada is still the Owner, linus is still a viewer, exactly one owner.
    const rows = await rowsFor(documentId);
    assert.deepEqual(
      rows.map((row) => ({ userId: row.userId, role: row.role })).sort((a, b) =>
        a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
      ),
      [
        { userId: 'demo-ada', role: 'owner' },
        { userId: 'demo-linus', role: 'viewer' },
      ],
    );
    assert.equal(rows.filter((row) => row.role === 'owner').length, 1);
  });

  it('invites idempotently and only closes sockets when the role actually changes', async () => {
    const documentId = await newDocument();
    const revocations: Array<readonly string[]> = [];
    // The callback the composition root wires to the room registry; spying on it proves that a
    // no-op invite does not disconnect a member, while a real role change does.
    const spied = await createMemberService({
      dataPath,
      authz,
      appUsers: isAppUserStore(opened.store) ? opened.store : null,
      demoEmails: true,
      onMembershipChanged: (_documentId, userIds) => {
        revocations.push(userIds);
      },
    });
    try {
      assert.equal((await spied.invite(documentId, 'demo-ada', 'grace@insighthub.test', 'editor')).ok, true);
      assert.deepEqual(revocations, [['demo-grace']]);

      // Same role again: 200-equivalent success, one row, and no disconnect.
      const same = await spied.invite(documentId, 'demo-ada', 'grace@insighthub.test', 'editor');
      assert.equal(same.ok, true);
      assert.equal(revocations.length, 1, 'a no-op invite must not close the socket');

      const changed = await spied.invite(documentId, 'demo-ada', 'grace@insighthub.test', 'viewer');
      assert.equal(changed.ok, true);
      assert.equal(revocations.length, 2, 'a real role change revokes once');
      assert.deepEqual(revocations[1], ['demo-grace']);

      const rows = await rowsFor(documentId);
      assert.equal(rows.filter((row) => row.userId === 'demo-grace').length, 1);
      assert.equal(rows.find((row) => row.userId === 'demo-grace')?.role, 'viewer');
    } finally {
      spied.close();
    }
  });

  it('does not resurrect a removed demo membership on restart', async () => {
    // Regression for the P0-2 interaction with demo seeding: membership became mutable, so
    // re-applying the fixture on every start would silently undo a removal (and a revocation)
    // after a restart. The fixture may only be applied to an empty table.
    const directory = await mkdtemp(join(tmpdir(), 'insighthub-members-restart-'));
    try {
      const first = await createAuthz({ dataPath: directory });
      const service = await createMemberService({
        dataPath: directory,
        authz: first,
        demoEmails: true,
      });
      try {
        const removal = await service.remove('demo-document', 'demo-ada', 'demo-grace');
        assert.equal(removal.ok, true);
        assert.equal(first.roleFor('demo-document', 'demo-grace'), null);
      } finally {
        service.close();
        first.close();
      }

      const reopened = await createAuthz({ dataPath: directory });
      try {
        assert.equal(
          reopened.roleFor('demo-document', 'demo-grace'),
          null,
          'a removed member must not be re-seeded on restart',
        );
        assert.equal(reopened.roleFor('demo-document', 'demo-ada'), 'owner');
        assert.equal(reopened.roleFor('demo-document', 'demo-linus'), 'viewer');
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
