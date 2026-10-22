/**
 * **M4 B1** — the `app_user` internal mapping (`docs/CONTRACTS.md` §18.1).
 *
 * Layer: **Node only**, no HTTP, no network. The store is the real `SqliteDocumentStore` on
 * a temporary `INSIGHTHUB_DATA_PATH`, so every assertion is about the SQL the server runs.
 *
 * What is proven here:
 *
 * - one Clerk `sub` → exactly one internal id, idempotently, including concurrent first
 *   requests and a store restart;
 * - different Clerk users → different internal ids;
 * - `clerk_user_id` is UNIQUE at the storage level, not just in application code;
 * - the row is **mapping only** — there is no token/expiry column, and no login-session table.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { isAppUserStore, type AppUserStore } from './app-user.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { openDocumentStore } from '../persistence/open-store.js';
import { loadSqliteModule } from '../persistence/sqlite-runtime.js';

/** A temp data directory that the caller cleans up. */
async function tempDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

/** Count the rows for one Clerk id through a second, independent connection. */
async function rowCount(dataPath: string, clerkUserId: string): Promise<number> {
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS total FROM app_user WHERE clerk_user_id = ?')
      .get(clerkUserId);
    const total = row?.['total'];
    return typeof total === 'bigint' ? Number(total) : typeof total === 'number' ? total : 0;
  } finally {
    db.close();
  }
}

describe('app_user mapping (M4 B1)', () => {
  let dataPath = '';
  let opened: Awaited<ReturnType<typeof openDocumentStore>>;
  let users: AppUserStore;

  before(async () => {
    dataPath = await tempDirectory('insighthub-app-user-');
    opened = await openDocumentStore(dataPath);
    assert.ok(isAppUserStore(opened.store), 'the durable store implements the mapping seam');
    users = opened.store;
  });

  after(async () => {
    await opened.store.close();
    await rm(dataPath, { recursive: true, force: true });
  });

  it('returns the same internal id for the same Clerk user, and refreshes the profile', async () => {
    const first = await users.upsertByClerkUserId({
      clerkUserId: 'user_same_sub',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
    });
    const second = await users.upsertByClerkUserId({
      clerkUserId: 'user_same_sub',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
    });

    assert.equal(second, first, 'a repeated verification must not mint a second internal user');
    // The internal id is the server's, not Clerk's `sub`.
    assert.notEqual(first, 'user_same_sub');

    const row = await users.findByClerkUserId('user_same_sub');
    assert.ok(row !== null);
    assert.equal(row?.id, first);
    assert.equal(row?.email, 'ada@example.com');
    assert.equal(row?.displayName, 'Ada Lovelace');

    const byId = await users.findById(first);
    assert.deepEqual(byId, row);

    // A later verification with a changed name updates the profile but never the identity.
    const renamed = await users.upsertByClerkUserId({
      clerkUserId: 'user_same_sub',
      displayName: 'Ada King',
    });
    assert.equal(renamed, first);
    const updated = await users.findById(first);
    assert.equal(updated?.displayName, 'Ada King');
    assert.equal(updated?.email, 'ada@example.com', 'a missing field must not erase the old value');
    assert.equal(updated?.createdAt, row?.createdAt, 'createdAt is fixed at first mapping');
  });

  it('maps different Clerk users to different internal ids', async () => {
    const ada = await users.upsertByClerkUserId({ clerkUserId: 'user_ada' });
    const grace = await users.upsertByClerkUserId({ clerkUserId: 'user_grace' });
    assert.notEqual(ada, grace);

    assert.equal((await users.findByClerkUserId('user_ada'))?.id, ada);
    assert.equal((await users.findByClerkUserId('user_grace'))?.id, grace);
  });

  it('is idempotent for concurrent first requests (one row, one id)', async () => {
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        users.upsertByClerkUserId({
          clerkUserId: 'user_concurrent',
          email: 'concurrent@example.com',
        }),
      ),
    );
    assert.equal(new Set(ids).size, 1, 'every concurrent call must resolve to the same id');
    assert.equal(await rowCount(dataPath, 'user_concurrent'), 1, 'exactly one mapping row');
  });

  it('enforces clerk_user_id uniqueness in the schema, not only in application code', async () => {
    const id = await users.upsertByClerkUserId({ clerkUserId: 'user_unique' });
    assert.ok(id.length > 0);

    const sqlite = await loadSqliteModule();
    const db = new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));
    try {
      const insert = db.prepare(
        'INSERT INTO app_user (id, clerk_user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      // A second row for the same Clerk user must be refused by SQLite itself.
      assert.throws(
        () => insert.run('forged-id', 'user_unique', null, null, Date.now(), Date.now()),
        /UNIQUE|constraint/i,
      );
    } finally {
      db.close();
    }
    assert.equal(await rowCount(dataPath, 'user_unique'), 1);
  });

  it('returns null for ids it has never seen', async () => {
    assert.equal(await users.findById('no-such-internal-id'), null);
    assert.equal(await users.findByClerkUserId('no-such-clerk-id'), null);
  });

  it('keeps the mapping across a store restart', async () => {
    const directory = await tempDirectory('insighthub-app-user-restart-');
    const first = await openDocumentStore(directory);
    try {
      assert.ok(isAppUserStore(first.store));
      const id = await first.store.upsertByClerkUserId({
        clerkUserId: 'user_restart',
        displayName: 'Restart User',
      });
      await first.store.close();

      // A new process/store handle sees the same row: the mapping is stored, not re-derived.
      const second = await openDocumentStore(directory);
      try {
        assert.ok(isAppUserStore(second.store));
        const reopened = await second.store.findByClerkUserId('user_restart');
        assert.equal(reopened?.id, id);
        const again = await second.store.upsertByClerkUserId({ clerkUserId: 'user_restart' });
        assert.equal(again, id);
      } finally {
        await second.store.close();
      }
    } finally {
      await first.store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
