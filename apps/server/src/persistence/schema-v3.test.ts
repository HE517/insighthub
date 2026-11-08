/**
 * P0-1 schema 3 — the 2 → 3 migration (`docs/agent-governance/P0-1-CONTRACTS.md` C2;
 * `docs/DECISIONS.md` D-090 §7).
 *
 * ## What is proven
 *
 * - a **v2** database (membership in `insighthub.db`, no version tables, no `content_revision`)
 *   is migrated to 3 in one transaction, preserving every row;
 * - `content_revision` is **initialised** from the document's committed revision
 *   (`MAX(MAX(log seq), snapshot_seq)`), so the first restore after an upgrade compares against
 *   something real instead of 0;
 * - a second open is a no-op (`unchanged`), i.e. the migration is idempotent;
 * - a failure inside the 3-specific step rolls the **whole** upgrade back: `user_version` stays
 *   2, `restore_operation` never appears, `document_meta` does not gain the column, and the
 *   startup exits with `RESTORE_SCHEMA_MIGRATION_FAILED` (not the membership code);
 * - schema 3 itself is not treated as "too new", while 4 still is.
 *
 * ## The fixture is written literally
 *
 * Like the v0 fixture in `schema.test.ts`, the v2 database is created from a literal copy of the
 * schema-2 DDL instead of by importing `createSchemaObjects`. A historical fixture that imports
 * today's DDL stops being historical the moment the schema changes again.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { isDocumentVersionStore } from './document-versions.js';
import { openDocumentStore } from './open-store.js';
import {
  CURRENT_SCHEMA_VERSION,
  DOCUMENT_VERSION_DOC_SEQ_INDEX,
  DOCUMENT_VERSION_TABLE,
  RESTORE_OPERATION_TABLE,
  ensureSchema,
  readUserVersion,
} from './schema.js';
import { DATABASE_FILE_NAME } from './sqlite-store.js';
import { isSqliteCapabilityError, loadSqliteModule, type SqliteModule } from './sqlite-runtime.js';

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-schema-v3-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/* ---------------------------------------------------------------- *
 * The schema-2 fixture
 * ---------------------------------------------------------------- */

/** The schema-2 DDL, literally: the shape a shipped v2 binary leaves behind. */
function createV2Fixture(db: RawDb): void {
  db.exec(`
    CREATE TABLE document (
      document_id TEXT PRIMARY KEY,
      snapshot BLOB NOT NULL,
      snapshot_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE document_update (
      document_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      update_bytes BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, seq)
    );
    CREATE TABLE document_meta (
      document_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE app_user (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL UNIQUE,
      email TEXT,
      display_name TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE authz_document_membership (
      document_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (document_id, user_id)
    );
    CREATE INDEX authz_document_membership_user ON authz_document_membership(user_id);
  `);
  db.exec('PRAGMA user_version = 2');
}

/**
 * A v2 database with one document whose log reached sequence 5 and whose snapshot covers 3.
 *
 * The two numbers differ on purpose: the correct initial `content_revision` is their maximum
 * (5), and a migration that used only the log or only the snapshot would be visibly wrong.
 */
function seedV2Document(db: RawDb): void {
  db.prepare(
    'INSERT INTO document (document_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)',
  ).run('doc-v2', new Uint8Array([1, 2, 3]), 3, 1_700_000_000_000);
  const insertUpdate = db.prepare(
    'INSERT INTO document_update (document_id, seq, update_bytes, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const sequence of [4, 5]) {
    insertUpdate.run('doc-v2', sequence, new Uint8Array([sequence]), 1_700_000_000_000);
  }
  db.prepare(
    `INSERT INTO document_meta (document_id, title, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('doc-v2', 'v2 title', 'demo-ada', 1_700_000_000_000, 1_700_000_000_000);
  db.prepare(
    'INSERT INTO authz_document_membership (document_id, user_id, role) VALUES (?, ?, ?)',
  ).run('doc-v2', 'demo-ada', 'owner');
}

async function openRaw(dataPath: string): Promise<RawDb> {
  mkdirSync(dataPath, { recursive: true });
  const sqlite = await loadSqliteModule();
  return new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));
}

/* ---------------------------------------------------------------- *
 * Migration
 * ---------------------------------------------------------------- */

describe('P0-1 schema 3 — migration from schema 2', () => {
  it('migrates rows, creates the version tables and initialises content_revision', async () => {
    const dataPath = join(root, 'v2');
    const db = await openRaw(dataPath);
    try {
      createV2Fixture(db);
      seedV2Document(db);
      assert.equal(readUserVersion(db), 2);

      assert.deepEqual(ensureSchema(db, dataPath), {
        version: CURRENT_SCHEMA_VERSION,
        action: 'migrated',
      });
      assert.equal(readUserVersion(db), 3);

      // The rows survive.
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM document').get()?.['c']), 1);
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM document_update').get()?.['c']), 2);
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM document_meta').get()?.['c']), 1);

      // `content_revision` starts at MAX(log seq 5, snapshot seq 3).
      const meta = db
        .prepare('SELECT title, owner_id, content_revision FROM document_meta WHERE document_id = ?')
        .get('doc-v2');
      assert.equal(meta?.['title'], 'v2 title');
      assert.equal(meta?.['owner_id'], 'demo-ada');
      assert.equal(meta?.['content_revision'], 5);

      // The version objects exist and are empty.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row['name']));
      assert.ok(tables.includes(DOCUMENT_VERSION_TABLE));
      assert.ok(tables.includes(RESTORE_OPERATION_TABLE));
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => String(row['name']));
      assert.ok(indexes.includes(DOCUMENT_VERSION_DOC_SEQ_INDEX));
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second open is unchanged', async () => {
    const dataPath = join(root, 'v2-idempotent');
    const first = await openRaw(dataPath);
    try {
      createV2Fixture(first);
      seedV2Document(first);
      assert.equal(ensureSchema(first, dataPath).action, 'migrated');
      assert.deepEqual(ensureSchema(first, dataPath), {
        version: CURRENT_SCHEMA_VERSION,
        action: 'unchanged',
      });
      assert.equal(
        Number(first.prepare('SELECT content_revision FROM document_meta').get()?.['content_revision']),
        5,
        'a second pass must not re-initialise (or double) the revision',
      );
    } finally {
      first.close();
    }
  });

  it('opens through the real store after the migration and accepts a version row', async () => {
    const dataPath = join(root, 'v2-store');
    const fixture = await openRaw(dataPath);
    try {
      createV2Fixture(fixture);
      seedV2Document(fixture);
      ensureSchema(fixture, dataPath);
    } finally {
      fixture.close();
    }

    const opened = await openDocumentStore(dataPath);
    try {
      assert.ok(isDocumentVersionStore(opened.store));
      const version = await opened.store.captureDocumentVersion({
        documentId: 'doc-v2',
        title: 'from v2',
        authorId: 'demo-ada',
        state: new Uint8Array([9]),
        kind: 'manual',
      });
      assert.equal(version.sequence, 5, 'the version inherits the migrated content revision');
    } finally {
      await opened.store.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * Rollback
 * ---------------------------------------------------------------- */

describe('P0-1 schema 3 — a failed migration rolls the whole upgrade back', () => {
  it('keeps user_version = 2 and leaves no half-created v3 object', async () => {
    const dataPath = join(root, 'rollback');
    const db = await openRaw(dataPath);
    try {
      createV2Fixture(db);
      seedV2Document(db);
      // A pre-existing `document_version` with a kind the schema-3 vocabulary does not know.
      // The validation inside the migration must reject it, which is the failure injected here
      // without a production test hook: the real code path refuses the real file.
      db.exec(`
        CREATE TABLE document_version (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          title TEXT NOT NULL,
          author_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          yjs_state BLOB NOT NULL,
          kind TEXT NOT NULL
        )
      `);
      db.prepare(
        `INSERT INTO document_version
           (id, document_id, sequence, title, author_id, created_at, yjs_state, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('foreign-version', 'doc-v2', 1, 'foreign', 'someone', 1_700_000_000_000, new Uint8Array([1]), 'weird');

      await assert.rejects(
        openDocumentStore(dataPath),
        (error: unknown) => {
          assert.ok(isSqliteCapabilityError(error));
          if (!isSqliteCapabilityError(error)) return false;
          assert.equal(error.code, 'RESTORE_SCHEMA_MIGRATION_FAILED');
          return true;
        },
      );

      assert.equal(readUserVersion(db), 2, 'the version marker must not advance');
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row['name']));
      assert.ok(
        !tables.includes(RESTORE_OPERATION_TABLE),
        'the transaction must roll the new table back',
      );
      const columns = db
        .prepare('PRAGMA table_info(document_meta)')
        .all()
        .map((row) => String(row['name']));
      assert.ok(
        !columns.includes('content_revision'),
        'the added column must roll back with the transaction',
      );
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => String(row['name']));
      assert.ok(
        !indexes.includes(DOCUMENT_VERSION_DOC_SEQ_INDEX),
        'the index created in the transaction must roll back',
      );
      // The pre-existing (foreign) table is fixture data, not something the transaction created;
      // it is left exactly as it was.
      assert.equal(
        Number(db.prepare('SELECT COUNT(*) AS c FROM document_version').get()?.['c']),
        1,
      );
    } finally {
      db.close();
    }
  });

  it('attributes a v3 DDL failure to RESTORE_SCHEMA_MIGRATION_FAILED (R-1)', async () => {
    const dataPath = join(root, 'rollback-ddl');
    const db = await openRaw(dataPath);
    try {
      createV2Fixture(db);
      seedV2Document(db);
      // A pre-existing object with the target table's name makes CREATE TABLE fail before the
      // version validation. Before R-1 this failure surfaced as MEMBERSHIP_MIGRATION_FAILED.
      db.exec('CREATE VIEW document_version AS SELECT document_id AS id FROM document');

      await assert.rejects(
        openDocumentStore(dataPath),
        (error: unknown) => {
          assert.ok(isSqliteCapabilityError(error));
          if (!isSqliteCapabilityError(error)) return false;
          assert.equal(error.code, 'RESTORE_SCHEMA_MIGRATION_FAILED');
          return true;
        },
      );

      assert.equal(readUserVersion(db), 2, 'the version marker must not advance');
      const view = db
        .prepare("SELECT type FROM sqlite_master WHERE name = 'document_version'")
        .get();
      assert.equal(view?.['type'], 'view', 'the pre-existing view must survive the rollback');
    } finally {
      db.close();
    }
  });
});

describe('P0-1 schema 3 — DATA_SCHEMA_TOO_NEW semantics are preserved', () => {
  it('accepts 3 as current and refuses 4', async () => {
    const dataPath = join(root, 'guard');
    mkdirSync(dataPath, { recursive: true });

    // A real schema-3 database is accepted.
    const open = await openDocumentStore(dataPath);
    await open.store.close();

    const db = await openRaw(dataPath);
    try {
      db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    } finally {
      db.close();
    }

    await assert.rejects(
      openDocumentStore(dataPath),
      (error: unknown) => {
        assert.ok(isSqliteCapabilityError(error));
        if (!isSqliteCapabilityError(error)) return false;
        assert.equal(error.code, 'DATA_SCHEMA_TOO_NEW');
        return true;
      },
    );
  });
});
