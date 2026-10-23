/**
 * M4 B6 — schema versioning, migration and integrity (`docs/DECISIONS.md` D-082 D2/D4).
 *
 * The rules under test are about **failure behaviour**, not happy paths:
 *
 * - a new database is created at `user_version = 1`, and opening it again is a no-op;
 * - a pre-B6 (`user_version = 0`) database is migrated to 1 *once*, with every row preserved;
 * - a database written by a **newer** binary is refused (`DATA_SCHEMA_TOO_NEW`), never
 *   "opened as best we can" and never modified;
 * - a corrupt or truncated file is refused (`DATA_INTEGRITY_FAILED`) and is not replaced with
 *   an empty database — the data-loss mode this milestone exists to remove.
 *
 * All fixtures are real files in a per-test temporary directory (`docs/DECISIONS.md` D-041).
 * The process-level cases spawn the actual entrypoint, because "the store throws" and "the
 * server exits 1 and prints the code" are different claims.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as Y from 'yjs';

import { isAppUserStore } from '../authz/public.js';
import { isDocumentMetaStore } from './document-meta.js';
import { applyStoredDocument } from './hydrator.js';
import { openDocumentStore } from './open-store.js';
import { CURRENT_SCHEMA_VERSION, SCHEMA_TABLES, ensureSchema, readUserVersion } from './schema.js';
import { DATABASE_FILE_NAME } from './sqlite-store.js';
import { isSqliteCapabilityError, loadSqliteModule, type SqliteModule } from './sqlite-runtime.js';
import { runServerExpectingRefusal } from './test-process.js';
import type { DocumentStore } from './types.js';

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-schema-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/* ---------------------------------------------------------------- *
 * Fixtures and helpers
 * ---------------------------------------------------------------- */

function databaseFile(dataPath: string): string {
  return join(dataPath, DATABASE_FILE_NAME);
}

/** A raw connection, for reading `PRAGMA user_version` or seeding a legacy file. */
async function openRaw(file: string): Promise<RawDb> {
  const sqlite = await loadSqliteModule();
  return new sqlite.DatabaseSync(file);
}

function tableNames(db: RawDb): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row['name']));
}

function rowCount(db: RawDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.['count'] ?? 0);
}

/** An update that appends `value` to a document's `content` text. */
function updateAppending(doc: Y.Doc, value: string): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const text = doc.getText('content');
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

/** The text a fresh server would rebuild from the store alone. */
async function storedText(store: DocumentStore, documentId: string): Promise<string | null> {
  const stored = await store.load(documentId);
  if (stored === null) return null;
  const doc = new Y.Doc();
  try {
    applyStoredDocument(stored, doc);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

/**
 * The schema as the **pre-B6** binary created it.
 *
 * Deliberately written out literally rather than imported from `schema.ts`: this is a
 * historical fixture, and importing the current DDL would make it possible for a future schema
 * change to silently change what "an old database" means in this test.
 */
const LEGACY_V0_SCHEMA = [
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

/**
 * Build a `user_version = 0` database with one row in every table.
 *
 * This is what a database created by the previous milestone looks like: the tables, real
 * content, and **no version marker** — which is precisely the case the migration must handle
 * without losing anything.
 */
async function createLegacyV0(
  dataPath: string,
  update: Uint8Array,
  includeAppUser = true,
): Promise<void> {
  mkdirSync(dataPath, { recursive: true });
  const db = await openRaw(databaseFile(dataPath));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const schema = includeAppUser ? LEGACY_V0_SCHEMA : LEGACY_V0_SCHEMA.slice(0, 3);
    for (const statement of schema) db.exec(statement);

    db.prepare(
      'INSERT INTO document (document_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, ?, ?)',
    ).run('legacy-document', new Uint8Array(0), 0, 1_700_000_000_000);
    db.prepare(
      'INSERT INTO document_update (document_id, seq, update_bytes, created_at) VALUES (?, ?, ?, ?)',
    ).run('legacy-document', 1, update, 1_700_000_000_100);
    db.prepare(
      'INSERT INTO document_meta (document_id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('legacy-document', 'Legacy title', 'legacy-owner', 1_700_000_000_000, 1_700_000_000_100);
    if (includeAppUser) {
      db.prepare(
        'INSERT INTO app_user (id, clerk_user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        'legacy-internal-user',
        'clerk_legacy_1',
        'legacy@example.com',
        'Legacy User',
        1_700_000_000_000,
        1_700_000_000_100,
      );
    }
  } finally {
    db.close();
  }
}

/** Assert the rejection is the typed startup refusal with the expected stable code. */
async function assertStartupRefusal(
  open: () => Promise<unknown>,
  code: 'DATA_INTEGRITY_FAILED' | 'DATA_SCHEMA_TOO_NEW',
): Promise<void> {
  await assert.rejects(open, (error: unknown) => {
    assert.ok(isSqliteCapabilityError(error), `expected a typed refusal, got ${String(error)}`);
    if (!isSqliteCapabilityError(error)) return false;
    assert.equal(error.code, code);
    assert.ok(error.hint.length > 0, 'a startup refusal must tell the operator what to do');
    return true;
  });
}

/* ---------------------------------------------------------------- *
 * Creating and re-opening
 * ---------------------------------------------------------------- */

describe('M4 B6/B12.5 — a new database is created at schema version 2', () => {
  it('records user_version = 2 and creates every schema table', async () => {
    const dataPath = join(root, 'new');
    const doc = new Y.Doc();
    const update = updateAppending(doc, 'first content');

    const opened = await openDocumentStore(dataPath);
    try {
      await opened.store.append('doc-new', update);
    } finally {
      await opened.store.close();
    }
    doc.destroy();

    const db = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(db), CURRENT_SCHEMA_VERSION);
      assert.equal(readUserVersion(db), 2, 'B12.5 freezes the current schema at 2');
      const names = tableNames(db);
      for (const table of SCHEMA_TABLES) {
        assert.ok(
          names.includes(table),
          `schema 2 must contain ${table}, found ${names.join(', ')}`,
        );
      }
    } finally {
      db.close();
    }
  });

  it('re-opening does not re-run the migration (idempotent)', async () => {
    const dataPath = join(root, 'idempotent');
    const doc = new Y.Doc();
    const update = updateAppending(doc, 'kept across opens');

    const first = await openDocumentStore(dataPath);
    try {
      await first.store.append('doc-idempotent', update);
    } finally {
      await first.store.close();
    }
    doc.destroy();

    const db = await openRaw(databaseFile(dataPath));
    try {
      assert.deepEqual(ensureSchema(db, dataPath), { version: 2, action: 'unchanged' });
    } finally {
      db.close();
    }

    // The public seam agrees: a second open reads the same content and leaves version 2.
    const second = await openDocumentStore(dataPath);
    try {
      assert.equal(await storedText(second.store, 'doc-idempotent'), 'kept across opens');
    } finally {
      await second.store.close();
    }

    const after = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(after), 2);
      assert.equal(rowCount(after, 'document_update'), 1, 'reopening must not duplicate rows');
    } finally {
      after.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * Pre-B6 migration
 * ---------------------------------------------------------------- */

describe('M4 B6/B12.5 — a pre-B6 database migrates to version 2 without losing data', () => {
  it('preserves document content, metadata and the app_user mapping', async () => {
    const dataPath = join(root, 'legacy');
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'legacy content');
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    await createLegacyV0(dataPath, update);

    // The fixture really is an old file, not a new one with the marker removed.
    const before = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(before), 0);
      assert.equal(rowCount(before, 'document_update'), 1);
    } finally {
      before.close();
    }

    const opened = await openDocumentStore(dataPath);
    try {
      assert.equal(await storedText(opened.store, 'legacy-document'), 'legacy content');

      assert.ok(isDocumentMetaStore(opened.store), 'the SQLite store owns document metadata');
      const meta = await opened.store.documentMeta('legacy-document');
      assert.equal(meta?.title, 'Legacy title');
      assert.equal(meta?.ownerId, 'legacy-owner');

      assert.ok(isAppUserStore(opened.store), 'the SQLite store owns the app_user mapping');
      const user = await opened.store.findById('legacy-internal-user');
      assert.equal(user?.clerkUserId, 'clerk_legacy_1');
      assert.equal(user?.email, 'legacy@example.com');
      assert.equal(user?.displayName, 'Legacy User');
    } finally {
      await opened.store.close();
    }

    const after = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(after), 2, 'the migration must record the version');
      assert.equal(rowCount(after, 'document'), 1);
      assert.equal(rowCount(after, 'document_update'), 1);
      assert.equal(rowCount(after, 'document_meta'), 1);
      assert.equal(rowCount(after, 'app_user'), 1);
      assert.equal(rowCount(after, 'authz_document_membership'), 0);
      // Re-running the migration on the migrated file must be a no-op, not a second pass.
      assert.deepEqual(ensureSchema(after, dataPath), { version: 2, action: 'unchanged' });
    } finally {
      after.close();
    }
  });

  it('is idempotent when ensureSchema runs twice on the same pre-B6 file', async () => {
    const dataPath = join(root, 'legacy-idempotent');
    const doc = new Y.Doc();
    const update = updateAppending(doc, 'twice');
    doc.destroy();
    await createLegacyV0(dataPath, update);

    const db = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(db), 0);
      assert.deepEqual(ensureSchema(db, dataPath), { version: 2, action: 'migrated' });
      assert.deepEqual(ensureSchema(db, dataPath), { version: 2, action: 'unchanged' });
      assert.equal(rowCount(db, 'document_update'), 1, 'no row may be rewritten or duplicated');
    } finally {
      db.close();
    }
  });

  it('adds a table an older milestone lacked without touching existing rows', async () => {
    // A genuine upgrade path: a file created before `app_user` existed (M2) has no such table.
    // The pre-B6 open ran `CREATE TABLE IF NOT EXISTS` on every start, so the migration does the
    // same — it can only *add* the empty table an older milestone lacked; it never alters an
    // existing one. Without this the store would fail when it prepared an `app_user` statement.
    const dataPath = join(root, 'legacy-without-app-user');
    const doc = new Y.Doc();
    const update = updateAppending(doc, 'pre-B1 content');
    doc.destroy();
    await createLegacyV0(dataPath, update, false);

    const before = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(before), 0);
      assert.ok(!tableNames(before).includes('app_user'));
    } finally {
      before.close();
    }

    const opened = await openDocumentStore(dataPath);
    try {
      assert.equal(await storedText(opened.store, 'legacy-document'), 'pre-B1 content');
    } finally {
      await opened.store.close();
    }

    const after = await openRaw(databaseFile(dataPath));
    try {
      assert.equal(readUserVersion(after), 2);
      assert.ok(tableNames(after).includes('app_user'), 'schema 2 requires the app_user table');
      assert.equal(rowCount(after, 'app_user'), 0);
      assert.equal(rowCount(after, 'document_update'), 1, 'the old rows must be untouched');
    } finally {
      after.close();
    }
  });

  it('re-opening a migrated database does not migrate it a second time', async () => {
    const dataPath = join(root, 'legacy-reopen');
    const doc = new Y.Doc();
    const update = updateAppending(doc, 'reopen');
    doc.destroy();
    await createLegacyV0(dataPath, update);

    const first = await openDocumentStore(dataPath);
    await first.store.close();

    const second = await openDocumentStore(dataPath);
    try {
      assert.equal(await storedText(second.store, 'legacy-document'), 'reopen');
    } finally {
      await second.store.close();
    }

    const db = await openRaw(databaseFile(dataPath));
    try {
      assert.deepEqual(ensureSchema(db, dataPath), { version: 2, action: 'unchanged' });
      assert.equal(rowCount(db, 'app_user'), 1);
    } finally {
      db.close();
    }
  });
});

/* ---------------------------------------------------------------- *
 * Newer schema
 * ---------------------------------------------------------------- */

describe('M4 B6 — a newer schema is refused, never opened best-effort', () => {
  it('rejects user_version = 3 with DATA_SCHEMA_TOO_NEW and leaves the file untouched', async () => {
    const dataPath = join(root, 'too-new');
    const opened = await openDocumentStore(dataPath);
    try {
      await opened.store.append('doc-too-new', new Uint8Array([1, 2, 3, 4]));
    } finally {
      await opened.store.close();
    }

    const db = await openRaw(databaseFile(dataPath));
    try {
      db.exec('PRAGMA user_version = 3');
    } finally {
      db.close();
    }

    const file = databaseFile(dataPath);
    const bytesBefore = readFileSync(file);

    await assertStartupRefusal(() => openDocumentStore(dataPath), 'DATA_SCHEMA_TOO_NEW');

    assert.deepEqual(
      readFileSync(file),
      bytesBefore,
      'a database written by a newer binary must not be modified at all',
    );

    const after = await openRaw(file);
    try {
      assert.equal(readUserVersion(after), 3);
      assert.equal(rowCount(after, 'document_update'), 1, 'the existing row must still be there');
    } finally {
      after.close();
    }
  });

  it('rejects a version marker whose tables are missing (DATA_INTEGRITY_FAILED)', async () => {
    const dataPath = join(root, 'marker-only');
    mkdirSync(dataPath, { recursive: true });
    const db = await openRaw(databaseFile(dataPath));
    try {
      // Claims schema 2 while the database has no tables at all: the marker and the file
      // disagree, so neither "make it up" nor "start empty" is acceptable.
      db.exec('PRAGMA user_version = 2');
    } finally {
      db.close();
    }

    await assertStartupRefusal(() => openDocumentStore(dataPath), 'DATA_INTEGRITY_FAILED');
  });
});

/* ---------------------------------------------------------------- *
 * Corruption
 * ---------------------------------------------------------------- */

describe('M4 B6 — a corrupt or truncated file is refused and never becomes an empty store', () => {
  it('rejects random bytes with DATA_INTEGRITY_FAILED and keeps the file as it was', async () => {
    const dataPath = join(root, 'random-bytes');
    const opened = await openDocumentStore(dataPath);
    try {
      await opened.store.append('doc-good', new Uint8Array([0, 1, 2, 3]));
    } finally {
      await opened.store.close();
    }

    const file = databaseFile(dataPath);
    const garbage = Buffer.from('this sentence is definitely not a SQLite database');
    writeFileSync(file, garbage);

    // Twice: a failed open must not "repair" the file on the second attempt either.
    await assertStartupRefusal(() => openDocumentStore(dataPath), 'DATA_INTEGRITY_FAILED');
    await assertStartupRefusal(() => openDocumentStore(dataPath), 'DATA_INTEGRITY_FAILED');

    assert.deepEqual(
      readFileSync(file),
      garbage,
      'the corrupt file must be left exactly as it was (no empty database in its place)',
    );
  });

  it('rejects a truncated database with DATA_INTEGRITY_FAILED', async () => {
    const dataPath = join(root, 'truncated');
    const opened = await openDocumentStore(dataPath);
    try {
      // Enough pages that cutting the file in half lands inside a b-tree, not at a boundary.
      for (let index = 0; index < 4; index += 1) {
        await opened.store.append('doc-big', new Uint8Array(64 * 1024).fill(index + 1));
      }
    } finally {
      await opened.store.close();
    }

    const file = databaseFile(dataPath);
    const original = readFileSync(file);
    assert.ok(original.byteLength > 32 * 1024, 'the fixture must be large enough to truncate');

    const truncated = original.subarray(0, Math.floor(original.byteLength * 0.6));
    writeFileSync(file, truncated);

    await assertStartupRefusal(() => openDocumentStore(dataPath), 'DATA_INTEGRITY_FAILED');

    // No "repair" happened: the file was not rewritten to a valid empty database.
    assert.equal(statSync(file).size, truncated.byteLength);
  });
});

/* ---------------------------------------------------------------- *
 * Real process — the operator-visible contract
 * ---------------------------------------------------------------- */

describe('M4 B6 — the real entrypoint exits 1 with the stable code', () => {
  it('exits 1 with DATA_INTEGRITY_FAILED on a corrupt database and never listens', async () => {
    const dataPath = join(root, 'process-corrupt');
    const opened = await openDocumentStore(dataPath);
    try {
      await opened.store.append('doc', new Uint8Array([9, 9, 9]));
    } finally {
      await opened.store.close();
    }

    const file = databaseFile(dataPath);
    const garbage = Buffer.from('definitely not a sqlite file');
    writeFileSync(file, garbage);

    const run = runServerExpectingRefusal(dataPath);

    assert.equal(run.status, 1, `expected exit 1\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    assert.match(
      run.stderr,
      /refusing to start: DATA_INTEGRITY_FAILED/,
      `the stable code must reach the operator log\nstderr=${run.stderr}`,
    );
    assert.doesNotMatch(run.stdout, /ws\s+ready/, 'a refused server must not listen');
    assert.deepEqual(readFileSync(file), garbage, 'the refused start must not touch the file');
  });

  it('exits 1 with DATA_SCHEMA_TOO_NEW on a newer schema', async () => {
    const dataPath = join(root, 'process-too-new');
    const opened = await openDocumentStore(dataPath);
    await opened.store.close();

    const db = await openRaw(databaseFile(dataPath));
    try {
      db.exec('PRAGMA user_version = 3');
    } finally {
      db.close();
    }

    const run = runServerExpectingRefusal(dataPath);

    assert.equal(run.status, 1, `expected exit 1\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    assert.match(run.stderr, /refusing to start: DATA_SCHEMA_TOO_NEW/);
    assert.doesNotMatch(run.stdout, /ws\s+ready/);
  });
});
