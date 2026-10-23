/**
 * M4 B12.5 — schema 2 membership migration (`docs/DECISIONS.md` D-084 method C).
 *
 * Layer: **Node only**, real files in a per-test temporary directory. The claims are about
 * failure behaviour as much as the happy path:
 *
 * - a v1 `insighthub.db` plus a legacy `authz.db` with two memberships migrates to schema 2, and
 *   the runtime seam reads the rows from the new table;
 * - the row count / uniqueness / role vocabulary are asserted **inside** the migration
 *   transaction, so a bad legacy row rolls the whole thing back;
 * - `user_version` stays 1 and the new table is absent after a failed migration;
 * - the legacy file is never deleted, never rewritten, and never read once the schema is 2;
 * - reopening a migrated database is a no-op (idempotent).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { openMembershipStore } from '../authz/membership-store.js';
import { openDocumentStore } from './open-store.js';
import {
  AUTHZ_MEMBERSHIP_TABLE,
  AUTHZ_MEMBERSHIP_USER_INDEX,
  LEGACY_AUTHZ_DATABASE_FILE_NAME,
  readUserVersion,
} from './schema.js';
import { DATABASE_FILE_NAME } from './sqlite-store.js';
import { isSqliteCapabilityError, loadSqliteModule, type SqliteModule } from './sqlite-runtime.js';

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;

/**
 * The schema-1 objects, written out literally (same reasoning as `schema.test.ts`): this is a
 * historical fixture, not a second copy of the current DDL that a future change could silently
 * update.
 */
const SCHEMA_V1 = [
  `CREATE TABLE document (
     document_id TEXT PRIMARY KEY,
     snapshot BLOB NOT NULL,
     snapshot_seq INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE document_update (
     document_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     update_bytes BLOB NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (document_id, seq)
   )`,
  `CREATE TABLE document_meta (
     document_id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE app_user (
     id TEXT PRIMARY KEY,
     clerk_user_id TEXT NOT NULL UNIQUE,
     email TEXT,
     display_name TEXT,
     created_at INTEGER,
     updated_at INTEGER
   )`,
] as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-membership-migration-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function databaseFile(dataPath: string): string {
  return join(dataPath, DATABASE_FILE_NAME);
}

function legacyFile(dataPath: string): string {
  return join(dataPath, LEGACY_AUTHZ_DATABASE_FILE_NAME);
}

async function openRaw(file: string, readOnly = false): Promise<RawDb> {
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(file, readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** A schema-1 database with one document row, as a B6-era deployment would leave it. */
async function createSchemaV1(dataPath: string, documentId = 'existing-document'): Promise<void> {
  mkdirSync(dataPath, { recursive: true });
  const db = await openRaw(databaseFile(dataPath));
  try {
    for (const statement of SCHEMA_V1) db.exec(statement);
    db.prepare(
      'INSERT INTO document (document_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, 0, ?)',
    ).run(documentId, new Uint8Array(0), 1_700_000_000_000);
    db.prepare(
      'INSERT INTO document_meta (document_id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(documentId, 'Existing title', 'existing-owner', 1_700_000_000_000, 1_700_000_000_000);
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
}

/** The old A5-owned `authz.db` with the rows a v1 deployment would have accumulated. */
async function createLegacyAuthz(
  dataPath: string,
  rows: ReadonlyArray<readonly [string, string, string]>,
): Promise<void> {
  mkdirSync(dataPath, { recursive: true });
  const db = await openRaw(legacyFile(dataPath));
  try {
    db.exec(`
      CREATE TABLE authz_document_membership (
        document_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (document_id, user_id)
      )
    `);
    const insert = db.prepare(
      'INSERT INTO authz_document_membership (document_id, user_id, role) VALUES (?, ?, ?)',
    );
    for (const [documentId, userId, role] of rows) insert.run(documentId, userId, role);
  } finally {
    db.close();
  }
}

async function countLegacyRows(dataPath: string): Promise<number> {
  const db = await openRaw(legacyFile(dataPath), true);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM ${AUTHZ_MEMBERSHIP_TABLE}`).get();
    return Number(row?.['total'] ?? 0);
  } finally {
    db.close();
  }
}

function tableNames(db: RawDb): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row['name']));
}

function indexNames(db: RawDb): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row['name']));
}

describe('M4 B12.5 — v1 → v2 membership migration', () => {
  it('copies the legacy rows, preserves the document, and reads them through the runtime seam', async () => {
    const dataPath = join(root, 'happy');
    await createSchemaV1(dataPath);
    await createLegacyAuthz(dataPath, [
      ['existing-document', 'legacy-owner', 'owner'],
      ['existing-document', 'legacy-viewer', 'viewer'],
    ]);
    const legacyBefore = readFileSync(legacyFile(dataPath));

    const opened = await openDocumentStore(dataPath);
    try {
      assert.equal((await opened.store.load('existing-document')) !== null, true);
    } finally {
      await opened.store.close();
    }

    const db = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(db), 2, 'the migration must record schema 2');
      assert.ok(tableNames(db).includes(AUTHZ_MEMBERSHIP_TABLE));
      assert.ok(indexNames(db).includes(AUTHZ_MEMBERSHIP_USER_INDEX), 'user_id index exists');

      const counts = db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             (SELECT COUNT(*) FROM (SELECT DISTINCT document_id, user_id FROM ${AUTHZ_MEMBERSHIP_TABLE})) AS distinct_total
           FROM ${AUTHZ_MEMBERSHIP_TABLE}`,
        )
        .get();
      assert.equal(Number(counts?.['total']), 2, 'legacy row count = migrated row count');
      assert.equal(Number(counts?.['distinct_total']), 2, '(document_id, user_id) is unique');

      // Every role is from the frozen DocumentRole vocabulary.
      const roles = db
        .prepare(`SELECT DISTINCT role FROM ${AUTHZ_MEMBERSHIP_TABLE} ORDER BY role ASC`)
        .all()
        .map((row) => String(row['role']));
      assert.deepEqual(roles, ['owner', 'viewer']);
    } finally {
      db.close();
    }

    // Runtime reads the new table, not the legacy file.
    const memberships = await openMembershipStore(dataPath);
    try {
      assert.equal(memberships.roleFor('existing-document', 'legacy-owner'), 'owner');
      assert.equal(memberships.roleFor('existing-document', 'legacy-viewer'), 'viewer');
      assert.equal(memberships.count(), 2);
    } finally {
      memberships.close();
    }

    // The legacy file is byte-identical and still holds its two rows (audit/recovery copy).
    assert.deepEqual(readFileSync(legacyFile(dataPath)), legacyBefore, 'legacy file is unchanged');
    assert.equal(await countLegacyRows(dataPath), 2);

    // Re-opening is idempotent: no second copy, no second migration.
    const reopened = await openDocumentStore(dataPath);
    await reopened.store.close();
    const after = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(after), 2);
      const row = after.prepare(`SELECT COUNT(*) AS total FROM ${AUTHZ_MEMBERSHIP_TABLE}`).get();
      assert.equal(Number(row?.['total']), 2, 'reopening must not duplicate rows');
    } finally {
      after.close();
    }
  });

  it('never reads the legacy file again once the schema is 2', async () => {
    const dataPath = join(root, 'no-runtime-legacy-read');
    await createSchemaV1(dataPath);
    await createLegacyAuthz(dataPath, [['doc-a', 'user-a', 'owner']]);

    const first = await openDocumentStore(dataPath);
    await first.store.close();

    // A row added to the legacy file after migration must grant nothing: runtime never reads it.
    const legacy = await openRaw(legacyFile(dataPath));
    try {
      legacy
        .prepare(
          `INSERT INTO ${AUTHZ_MEMBERSHIP_TABLE} (document_id, user_id, role) VALUES (?, ?, ?)`,
        )
        .run('doc-a', 'user-late', 'owner');
    } finally {
      legacy.close();
    }

    const memberships = await openMembershipStore(dataPath);
    try {
      assert.equal(
        memberships.roleFor('doc-a', 'user-late'),
        null,
        'legacy-only row grants nothing',
      );
      assert.equal(memberships.count(), 1);
    } finally {
      memberships.close();
    }
  });

  it('rolls the whole migration back when a legacy role is not a DocumentRole', async () => {
    const dataPath = join(root, 'bad-role');
    await createSchemaV1(dataPath);
    await createLegacyAuthz(dataPath, [
      ['doc-a', 'user-a', 'owner'],
      ['doc-a', 'user-b', 'wizard'],
    ]);
    const legacyBefore = readFileSync(legacyFile(dataPath));

    await assert.rejects(
      () => openDocumentStore(dataPath),
      (error: unknown) => {
        assert.ok(isSqliteCapabilityError(error), `expected typed refusal, got ${String(error)}`);
        if (!isSqliteCapabilityError(error)) return false;
        assert.equal(error.code, 'MEMBERSHIP_MIGRATION_FAILED');
        assert.match(error.message, /legacy authz\.db/);
        return true;
      },
    );

    const db = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(db), 1, 'a failed migration must leave the version at 1');
      assert.ok(
        !tableNames(db).includes(AUTHZ_MEMBERSHIP_TABLE),
        'the membership table must not exist after rollback (not even empty)',
      );
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS total FROM document').get()?.['total']),
        1,
        'existing document rows are untouched',
      );
    } finally {
      db.close();
    }

    // The legacy file is the recoverable copy: unchanged and still holding both rows.
    assert.deepEqual(readFileSync(legacyFile(dataPath)), legacyBefore);
    assert.equal(await countLegacyRows(dataPath), 2);
  });

  it('migrates a v1 database with no legacy file to an empty membership table', async () => {
    const dataPath = join(root, 'no-legacy');
    await createSchemaV1(dataPath);

    const opened = await openDocumentStore(dataPath);
    await opened.store.close();

    const db = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(db), 2);
      assert.ok(tableNames(db).includes(AUTHZ_MEMBERSHIP_TABLE));
      assert.equal(
        Number(
          db.prepare(`SELECT COUNT(*) AS total FROM ${AUTHZ_MEMBERSHIP_TABLE}`).get()?.['total'],
        ),
        0,
      );
    } finally {
      db.close();
    }
  });

  it('creates no authz.db on a fresh deployment: the runtime has exactly one database file', async () => {
    const dataPath = join(root, 'fresh');
    const opened = await openDocumentStore(dataPath);
    await opened.store.close();

    assert.equal(existsSync(legacyFile(dataPath)), false, 'runtime must not create authz.db');
    assert.ok(existsSync(databaseFile(dataPath)), 'insighthub.db is the only database');
  });
});
