/**
 * Schema versioning, creation and migration for the durable document database
 * (`docs/DECISIONS.md` D-082 D2/D4, M4 B6).
 *
 * ## Why a version at all
 *
 * Until B6 the schema was created by `CREATE TABLE IF NOT EXISTS` on every open. That works
 * while the schema never changes, but it cannot answer two questions an operator will ask the
 * moment an upgrade goes wrong:
 *
 * 1. *Which* schema is this file? `IF NOT EXISTS` silently tolerates a file that is missing a
 *    table, so "the store half-initialised" and "the store is fine" look identical.
 * 2. Is this file **newer** than the binary? A future release that adds a column must not be
 *    opened by an old binary that would then write rows the new schema cannot represent.
 *
 * `PRAGMA user_version` is the version marker: it lives in the database header, is written by
 * SQLite itself, needs no extra table, and is read with one statement. The current schema is
 * **3** (P0-1 version restore, `docs/agent-governance/P0-1-CONTRACTS.md` C2; D-090 §7).
 *
 * ## The cases
 *
 * | On-disk `user_version` | Meaning | Action |
 * | --- | --- | --- |
 * | `0`, no known table | a new database | create the objects and record `3`, one transaction |
 * | `0`, known tables | a pre-B6 database | migrate to `3`, one transaction, data untouched |
 * | `1` | B6 schema (no membership table) | migrate to `3`, one transaction |
 * | `2` | membership in the document database | migrate to `3`, one transaction |
 * | `3` | current | verify the tables/indexes/columns exist, do nothing |
 * | `> 3` | written by a newer binary | **refuse** with `DATA_SCHEMA_TOO_NEW` |
 *
 * There is deliberately no "best effort" branch for `> 3`: opening a newer file read-write is
 * how an old binary corrupts data it does not understand, and the alternative — opening it
 * read-only and pretending everything works — would turn a version mismatch into silent write
 * failures later.
 *
 * ## Schema 3 — version history and content revision (P0-1, D-090)
 *
 * ```text
 * document_version(document_id, sequence, …, yjs_state, kind)
 * restore_operation(document_id, operation_id, request_hash, version_id, sequence, created_at)
 * document_meta.content_revision INTEGER NOT NULL DEFAULT 0
 * ```
 *
 * `sequence` on a version row is the **content revision** at capture time, not a log
 * position: `baseRevision` compares against the same number, so a join's empty update cannot
 * invalidate a preview (D-RC1 / A7 P1-6). The v2 → v3 migration initialises
 * `content_revision` from each document's current revision (`MAX(MAX(seq), snapshot_seq)`) so a
 * pre-existing document is not reported as "revision 0" with history behind it.
 *
 * Migration 2 → 3 is one transaction (the same primitive as v0/v1 → v2): the two tables, the
 * index, the new column and the `user_version` bump commit or roll back together. A failure
 * leaves `user_version = 2` with no half-created table, and an older binary that later sees a
 * version-3 file refuses it with `DATA_SCHEMA_TOO_NEW` instead of writing rows it cannot
 * represent.
 *
 * ## Schema 2 — membership moves into the document database (D-084 method C)
 *
 * B12.5 creates a document and its owner membership atomically. Cross-database transactions are
 * not available in WAL mode, so membership now lives in `insighthub.db` next to the document.
 * The v1 → v2 migration:
 *
 * ```text
 * BEGIN IMMEDIATE
 *   create authz_document_membership (+ user_id index)
 *   if legacy authz.db exists and has the old table:
 *     open it READ-ONLY, copy (document_id, user_id, role) with INSERT OR IGNORE
 *   validate row count / uniqueness / role vocabulary / no duplicate membership
 *   PRAGMA user_version = 2
 * COMMIT
 * ```
 *
 * Any failure rolls the **whole** transaction back: `user_version` stays 1 and the new table is
 * never left behind. The failure is typed `MEMBERSHIP_MIGRATION_FAILED` (a
 * {@link SqliteCapabilityError}) so startup cannot mistake a half-migration for a fresh store.
 *
 * **The legacy file is never deleted and never read at runtime.** `authz.db` is opened only by
 * this migration, read-only, for audit/recovery. Once the schema is 2, `ensureSchema` returns
 * `unchanged` and the file is untouched for the rest of the process's life.
 *
 * Migration is **idempotent**: a second open sees version 2 and returns `unchanged`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isDocumentRole } from '@insighthub/shared';

import {
  SqliteCapabilityError,
  isSqliteCapabilityError,
  type SqliteModule,
} from './sqlite-runtime.js';
import { runInTransaction } from './transaction.js';

type Db = InstanceType<SqliteModule['DatabaseSync']>;

/** The schema this binary writes and understands. Bump only with a real migration. */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * The membership table, now in `insighthub.db` (`docs/DECISIONS.md` D-084 method C).
 *
 * The `authz_` prefix is kept: the table still belongs to the authorization domain even though
 * it is stored in the document file. The name is also the migration's compatibility anchor.
 */
export const AUTHZ_MEMBERSHIP_TABLE = 'authz_document_membership';

/** Index on `user_id`: `GET /api/documents` reads every row for one user. */
export const AUTHZ_MEMBERSHIP_USER_INDEX = 'authz_document_membership_user';

/**
 * The **legacy** authorization database file that schema 2 replaces.
 *
 * It is never opened by the runtime; only {@link ensureSchema}'s v1 → v2 migration reads it
 * (read-only) and it is deliberately left in place for audit/recovery.
 */
export const LEGACY_AUTHZ_DATABASE_FILE_NAME = 'authz.db';

/** `document_meta` column added by schema 3 (P0-1, D-RC1). */
export const DOCUMENT_META_CONTENT_REVISION_COLUMN = 'content_revision';

/** Version history table (schema 3). */
export const DOCUMENT_VERSION_TABLE = 'document_version';

/** Index behind `GET /api/documents/:id/versions` (`sequence DESC` per document). */
export const DOCUMENT_VERSION_DOC_SEQ_INDEX = 'document_version_doc_seq';

/** Idempotency table for restores (schema 3, D-OP1). */
export const RESTORE_OPERATION_TABLE = 'restore_operation';

/**
 * Every table a schema-3 database is expected to contain.
 *
 * Exported for tests and for the startup check below; the order is the creation order.
 */
export const SCHEMA_TABLES = [
  'document',
  'document_update',
  'document_meta',
  'app_user',
  AUTHZ_MEMBERSHIP_TABLE,
  DOCUMENT_VERSION_TABLE,
  RESTORE_OPERATION_TABLE,
] as const;

/** Every index a schema-3 database is expected to contain. */
export const SCHEMA_INDEXES = [AUTHZ_MEMBERSHIP_USER_INDEX, DOCUMENT_VERSION_DOC_SEQ_INDEX] as const;

/** What {@link ensureSchema} actually did, for tests and diagnostics. */
export type SchemaAction = 'created' | 'migrated' | 'unchanged';

export interface SchemaState {
  readonly version: number;
  readonly action: SchemaAction;
}

/** The on-disk schema version (`PRAGMA user_version`), normalised to a number. */
export function readUserVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get();
  return readInteger(row?.['user_version']);
}

/**
 * Refuse a file written by a newer binary, before anything writes to it.
 *
 * This is a separate step from {@link ensureSchema} because the caller runs it **before**
 * `PRAGMA journal_mode = WAL`: establishing WAL is a write, and a version-2 file this binary
 * does not understand must not be touched at all — not even by a pragma that "only" changes
 * the journal mode. Returns the version for the caller's use.
 */
export function assertSchemaSupported(db: Db, dataPath: string): number {
  const version = readUserVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new SqliteCapabilityError(
      'DATA_SCHEMA_TOO_NEW',
      `the durable database schema is version ${version}, but this server supports up to version ${CURRENT_SCHEMA_VERSION}; refusing to open it: ${dataPath}`,
      'Run the newer InsightHub release that created this file, or restore the backup that matches this release. Downgrading the file in place is not supported.',
    );
  }
  return version;
}

/**
 * Verify the database with `PRAGMA quick_check` before anything writes to it.
 *
 * ## Why `quick_check` and not `integrity_check`
 *
 * Both walk the b-tree structures and report page/overflow/ordering errors. `integrity_check`
 * additionally verifies every index against its table, including UNIQUE indexes — a much more
 * expensive pass on a large database, and startup latency is paid on every restart.
 *
 * `quick_check` is the right trade here because the expensive checks it skips are already
 * enforced on the write path: the `document_update` primary key and `app_user.clerk_user_id`
 * UNIQUE constraint are checked by SQLite on every insert, and the store never trusts an index
 * for correctness (its reads are keyed by primary key). What remains — a torn page, a truncated
 * file, a foreign file — is exactly what `quick_check` catches. A corrupt file must fail here,
 * loudly, rather than hydrate as an empty document and then persist that emptiness over the
 * real data (`docs/ARCHITECTURE.md` §7.10, D-051).
 *
 * Throws {@link SqliteCapabilityError} with code `DATA_INTEGRITY_FAILED`; this is a startup
 * failure, not a recoverable read error.
 */
export function assertDatabaseIntegrity(db: Db, dataPath: string): void {
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare('PRAGMA quick_check').all();
  } catch (cause) {
    throw new SqliteCapabilityError(
      'DATA_INTEGRITY_FAILED',
      `the durable database failed \`PRAGMA quick_check\` and cannot be used: ${dataPath}`,
      'Move the database aside and restore a backup; do not delete it before checking whether it can be recovered. The server will not start on an unverified database.',
      cause,
    );
  }

  // A healthy database answers exactly one row: `ok`. Any other row is a reported problem
  // (`database disk image is malformed`, `*** in database main ***`, …).
  const problems = rows.filter((row) => row['quick_check'] !== 'ok');
  if (problems.length > 0) {
    throw new SqliteCapabilityError(
      'DATA_INTEGRITY_FAILED',
      `\`PRAGMA quick_check\` reported ${problems.length} problem(s) in the durable database: ${dataPath}`,
      'Move the database aside and restore a backup; do not delete it before checking whether it can be recovered. The server will not start on an unverified database.',
    );
  }
}

/**
 * Bring the database to {@link CURRENT_SCHEMA_VERSION}, or refuse.
 *
 * Runs **after** the integrity check and after WAL is established, so every write here happens
 * on a database SQLite already considers structurally sound. Every branch that writes is one
 * transaction (see the file header).
 *
 * `sqlite` is only needed when a legacy `authz.db` has to be read (a v0/v1 → v2 migration of a
 * deployment that predates B12.5). It is passed in rather than imported statically so a runtime
 * without `node:sqlite` still gets the diagnostic from `sqlite-runtime.ts`, and so a test can
 * provide the module explicitly.
 */
export function ensureSchema(db: Db, dataPath: string, sqlite?: SqliteModule): SchemaState {
  // The version guard is repeated here (the caller already ran it before enabling WAL) so that
  // a direct caller — a test, or a future maintenance entrypoint — cannot bypass it.
  const version = assertSchemaSupported(db, dataPath);

  const existing = tableNames(db);

  if (version === CURRENT_SCHEMA_VERSION) {
    const missing = missingSchemaObjects(db, existing);
    if (missing.length > 0) {
      throw new SqliteCapabilityError(
        'DATA_INTEGRITY_FAILED',
        `the durable database claims schema version ${version} but is missing ${missing.join(', ')}: ${dataPath}`,
        'The schema marker and the actual tables disagree, so the file was modified or truncated outside InsightHub. Restore a backup; the server will not invent the missing structure.',
      );
    }
    return { version, action: 'unchanged' };
  }

  // Versions 0 and 1 both migrate to 2. `document`/`document_update` are the oldest tables, so
  // their presence is what distinguishes "brand-new file" from "a file an older milestone
  // wrote"; the action is diagnostic only.
  const isLegacy = ['document', 'document_update', 'document_meta', 'app_user'].some((table) =>
    existing.has(table),
  );

  // Tracks which step of the migration failed so the stable error code names the right one:
  // a v3 failure must not be reported as a membership-migration failure (which would send an
  // operator looking at `authz.db` for a version-table problem). A mutable record rather than a
  // local string: the assignment happens inside the transaction callback, and control-flow
  // analysis would otherwise freeze the local's type at its initial value.
  const migrationState: { phase: 'membership' | 'restore' } = { phase: 'membership' };

  try {
    runInTransaction(db, () => {
      // Idempotent by construction: on a new file this creates everything; on a v0/v1/v2 file it
      // only adds the objects an older milestone lacked, and never alters an existing one.
      createSchemaObjects(db);

      // D-084: copy the old `authz.db` rows into the new table, inside this same transaction.
      // The read-only legacy handle is closed by the helper before validation continues.
      migrationState.phase = 'membership';
      importLegacyMemberships(db, dataPath, sqlite);

      // The checks run *inside* the transaction, so a rejected migration rolls back the table,
      // the index, every copied row and the version marker together.
      assertMembershipInvariants(db, dataPath);

      // P0-1 (D-090 §7): schema 3 adds the two version tables and `content_revision`. One
      // transaction with everything above: a failure rolls back the whole upgrade and leaves
      // `user_version` at its previous value.
      migrationState.phase = 'restore';
      migrateToSchema3(db);

      db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    });
  } catch (error) {
    // A failure here is one of the two migration steps failing, whether it came from DDL, the
    // legacy read or a validation rule. The transaction primitive has already rolled everything
    // back; report it with a stable code and an operator sentence that names the step.
    if (isSqliteCapabilityError(error)) throw error;
    if (migrationState.phase === 'restore') {
      throw new SqliteCapabilityError(
        'RESTORE_SCHEMA_MIGRATION_FAILED',
        `schema migration to version ${CURRENT_SCHEMA_VERSION} failed and was rolled back; the document-version and restore-operation tables were NOT created and the previous schema version is unchanged: ${dataPath}`,
        'The database is unchanged and usable by the previous release. Fix the reported cause (an unreadable table, a full disk) and restart; do not delete the database.',
        error,
      );
    }
    throw new SqliteCapabilityError(
      'MEMBERSHIP_MIGRATION_FAILED',
      `schema migration to version ${CURRENT_SCHEMA_VERSION} failed and was rolled back; membership was NOT migrated from the legacy ${LEGACY_AUTHZ_DATABASE_FILE_NAME}: ${dataPath}`,
      `The legacy ${LEGACY_AUTHZ_DATABASE_FILE_NAME} is kept unchanged for audit/recovery, and the database remains at its previous schema version. Fix the reported cause (a malformed role or duplicate row is the usual one) and restart; do not delete the legacy file.`,
      error,
    );
  }

  return { version: CURRENT_SCHEMA_VERSION, action: isLegacy ? 'migrated' : 'created' };
}

/** Schema objects that version 3 claims but the file does not actually contain. */
function missingSchemaObjects(db: Db, existing: Set<string>): string[] {
  const missing: string[] = SCHEMA_TABLES.filter((table) => !existing.has(table));
  const indexes = indexNames(db);
  for (const index of SCHEMA_INDEXES) {
    if (!indexes.has(index)) missing.push(`index ${index}`);
  }
  // `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table, so the column is
  // validated separately: a file claiming version 3 without it would fail every restore at the
  // first UPDATE, long after startup.
  if (existing.has('document_meta') && !columnNames(db, 'document_meta').has(DOCUMENT_META_CONTENT_REVISION_COLUMN)) {
    missing.push(`column document_meta.${DOCUMENT_META_CONTENT_REVISION_COLUMN}`);
  }
  return missing;
}

/**
 * Copy every row of the legacy `authz_document_membership` table into `insighthub.db`.
 *
 * The legacy connection is **read-only** (`readOnly: true`), so a bug here cannot rewrite or
 * delete the audit copy. Absent file or absent table is not an error: a deployment that never
 * had memberships has nothing to copy. A present-but-unreadable table is an error and rolls the
 * transaction back.
 */
function importLegacyMemberships(db: Db, dataPath: string, sqlite: SqliteModule | undefined): void {
  const legacyPath = join(dataPath, LEGACY_AUTHZ_DATABASE_FILE_NAME);
  if (!existsSync(legacyPath)) return;

  if (sqlite === undefined) {
    throw new Error(
      `a legacy ${LEGACY_AUTHZ_DATABASE_FILE_NAME} exists but the SQLite module was not supplied to the migration`,
    );
  }

  const legacy = new sqlite.DatabaseSync(legacyPath, { readOnly: true });
  try {
    legacy.exec('PRAGMA busy_timeout = 5000');
    const table = legacy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(AUTHZ_MEMBERSHIP_TABLE);
    // "authz.db exists" but it was never a membership database: nothing to copy.
    if (table === undefined) return;

    const rows = legacy
      .prepare(
        `SELECT document_id, user_id, role FROM ${AUTHZ_MEMBERSHIP_TABLE} ORDER BY document_id ASC, user_id ASC`,
      )
      .all();

    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${AUTHZ_MEMBERSHIP_TABLE} (document_id, user_id, role) VALUES (?, ?, ?)`,
    );
    const countStatement = db.prepare(`SELECT COUNT(*) AS total FROM ${AUTHZ_MEMBERSHIP_TABLE}`);
    const countRows = (): number => readInteger(countStatement.get()?.['total']);
    const before = countRows();
    let inserted = 0;
    for (const row of rows) {
      const documentId = row['document_id'];
      const userId = row['user_id'];
      const role = row['role'];
      // The legacy schema declared all three columns NOT NULL TEXT. A row that is not text is a
      // foreign/corrupt file: fail rather than coerce it into a membership.
      if (
        typeof documentId !== 'string' ||
        typeof userId !== 'string' ||
        typeof role !== 'string'
      ) {
        throw new Error('a legacy membership row is not text');
      }
      const result = insert.run(documentId, userId, role);
      inserted += Number(result.changes);
    }
    const after = countRows();
    // Row-count validation (D-084): the new table is `before` pre-existing rows plus exactly the
    // legacy rows that were actually inserted. `ignored` explains the only legitimate difference
    // (an identical primary key already present); anything else is a migration bug.
    const ignored = rows.length - inserted;
    if (after !== before + inserted) {
      throw new Error(
        `migrated membership row count mismatch: before=${before}, legacy=${rows.length}, inserted=${inserted}, ignored=${ignored}, after=${after}`,
      );
    }
    if (before === 0 && after !== rows.length) {
      throw new Error(
        `legacy membership row count ${rows.length} does not match the migrated table ${after}`,
      );
    }

    // `INSERT OR IGNORE` can ignore a row only because an identical primary key already exists
    // in the new table (normal v1 migration starts empty, so this is the defensive path). Verify
    // the stored role is still exactly the legacy role; a conflicting pre-existing row must not
    // silently keep a different privilege.
    const selectOne = db.prepare(
      `SELECT role FROM ${AUTHZ_MEMBERSHIP_TABLE} WHERE document_id = ? AND user_id = ?`,
    );
    for (const row of rows) {
      const documentId = String(row['document_id']);
      const userId = String(row['user_id']);
      const expectedRole = String(row['role']);
      const stored = selectOne.get(documentId, userId);
      if (stored === undefined || stored['role'] !== expectedRole) {
        throw new Error(
          `legacy membership ${documentId}/${userId} did not migrate with its exact role`,
        );
      }
    }
  } finally {
    legacy.close();
  }
}

/**
 * Assert the invariants D-084 requires of the migrated table: unique `(document_id, user_id)`,
 * only the existing `DocumentRole` vocabulary, and no duplicate membership.
 *
 * Runs inside the migration transaction; any throw rolls the whole migration back.
 */
function assertMembershipInvariants(db: Db, dataPath: string): void {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         (SELECT COUNT(*) FROM (SELECT DISTINCT document_id, user_id FROM ${AUTHZ_MEMBERSHIP_TABLE})) AS distinct_total
       FROM ${AUTHZ_MEMBERSHIP_TABLE}`,
    )
    .get();
  const total = readInteger(counts?.['total']);
  const distinctTotal = readInteger(counts?.['distinct_total']);
  if (total !== distinctTotal) {
    throw new Error(
      `the migrated membership table has ${total} rows but ${distinctTotal} distinct (document_id, user_id) pairs: ${dataPath}`,
    );
  }

  const rows = db.prepare(`SELECT document_id, user_id, role FROM ${AUTHZ_MEMBERSHIP_TABLE}`).all();
  for (const row of rows) {
    const documentId = row['document_id'];
    const userId = row['user_id'];
    const role = row['role'];
    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new Error('the migrated membership table contains an empty document_id');
    }
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('the migrated membership table contains an empty user_id');
    }
    // Fail closed here rather than at read time: a role outside the frozen vocabulary is not a
    // membership the decision core can honour, so the migration must not claim success.
    if (!isDocumentRole(role)) {
      throw new Error(
        `the migrated membership table contains an invalid role (${String(role)}) for ${documentId}/${userId}`,
      );
    }
  }
}

/**
 * Schema-3 upgrade step, run **inside** the migration transaction.
 *
 * `ALTER TABLE … ADD COLUMN` is the only SQLite way to add a column in place, and it cannot be
 * written as `ADD COLUMN IF NOT EXISTS`. The branch is therefore explicit and idempotent: a
 * table that already has the column (a fresh database created by {@link createSchemaObjects},
 * or a re-run after a rollback) is left alone.
 *
 * The initialisation is not cosmetic. A v2 document has a real history; leaving
 * `content_revision = 0` would make its first restore compare `baseRevision = 0` against a
 * document with edits behind it and either always 409 or, worse, accept a preview taken
 * against nothing. It is set to the same number `DocumentMeta.revision` reported before this
 * schema existed — `MAX(MAX(log seq), snapshot_seq)` — so the first restore after an upgrade
 * behaves like the last one before it.
 */
function migrateToSchema3(db: Db): void {
  if (!columnNames(db, 'document_meta').has(DOCUMENT_META_CONTENT_REVISION_COLUMN)) {
    db.exec(
      `ALTER TABLE document_meta ADD COLUMN ${DOCUMENT_META_CONTENT_REVISION_COLUMN} INTEGER NOT NULL DEFAULT 0`,
    );
    db.exec(
      `UPDATE document_meta SET ${DOCUMENT_META_CONTENT_REVISION_COLUMN} = MAX(
         COALESCE((SELECT MAX(u.seq) FROM document_update u WHERE u.document_id = document_meta.document_id), 0),
         COALESCE((SELECT d.snapshot_seq FROM document d WHERE d.document_id = document_meta.document_id), 0)
       )`,
    );
  }

  assertVersionInvariants(db);
}

/**
 * Validate the schema-3 objects before the transaction is allowed to commit.
 *
 * Runs inside the migration transaction, so a failure rolls back the tables, the index, the new
 * column and the version marker together. The column checks exist because `CREATE TABLE IF NOT
 * EXISTS` silently accepts a table with the wrong shape — exactly the half-migrated state the
 * version marker is meant to make impossible.
 */
function assertVersionInvariants(db: Db): void {
  const tables = tableNames(db);
  for (const table of [DOCUMENT_VERSION_TABLE, RESTORE_OPERATION_TABLE]) {
    if (!tables.has(table)) {
      throw new Error(`schema 3 requires table ${table}, which the migration did not create`);
    }
  }
  if (!indexNames(db).has(DOCUMENT_VERSION_DOC_SEQ_INDEX)) {
    throw new Error(`schema 3 requires index ${DOCUMENT_VERSION_DOC_SEQ_INDEX}`);
  }
  if (!columnNames(db, 'document_meta').has(DOCUMENT_META_CONTENT_REVISION_COLUMN)) {
    throw new Error(`schema 3 requires document_meta.${DOCUMENT_META_CONTENT_REVISION_COLUMN}`);
  }

  // A version row whose kind is outside the frozen vocabulary could not be listed or restored;
  // refusing the migration is better than shipping a row no reader can interpret.
  const invalidKinds = db
    .prepare(
      `SELECT COUNT(*) AS total FROM ${DOCUMENT_VERSION_TABLE}
       WHERE kind NOT IN ('auto', 'manual', 'pre-restore', 'restored')`,
    )
    .get();
  if (readInteger(invalidKinds?.['total']) > 0) {
    throw new Error(`the migrated ${DOCUMENT_VERSION_TABLE} table contains an unknown kind`);
  }
}

/**
 * The schema-3 objects. The first five tables are exactly the schema-2 objects with the same
 * columns, except `document_meta`, which gains `content_revision`; the last two are the P0-1
 * version history and idempotency tables.
 */
export function createSchemaObjects(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document (
      document_id TEXT PRIMARY KEY,
      snapshot BLOB NOT NULL,
      snapshot_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // The append-only log. `(document_id, seq)` is the primary key, which is also what makes the
  // "allocate MAX(seq)+1 inside one transaction" invariant enforceable by the schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_update (
      document_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      update_bytes BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, seq)
    )
  `);
  // Metadata is a separate table rather than extra columns on `document` (M2 Phase 2):
  // `document` is the *content* seam's row and is written by `append`/`compact` inside the
  // mutation pipeline, while metadata is written once at creation and read by the HTTP
  // document API. Keeping them apart means a metadata change can never take part in a
  // content transaction, and `append` keeps its narrow `(documentId, update)` shape.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_meta (
      document_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content_revision INTEGER NOT NULL DEFAULT 0
    )
  `);
  // The internal user mapping (`docs/CONTRACTS.md` §18.1). It lives in the same file as the
  // documents on purpose: it is the mapping every membership row is keyed by, not a second
  // database and not a session store — there is no token, expiry or password column here.
  // `clerk_user_id` is UNIQUE, which is what makes "the same Clerk user is one internal
  // user" a storage invariant rather than a convention.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_user (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL UNIQUE,
      email TEXT,
      display_name TEXT,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  // D-084 method C: membership lives next to the document so `POST /api/documents` can write
  // the document row, its metadata and its owner membership in ONE `BEGIN IMMEDIATE`
  // transaction. The table is still owned by the authorization domain (`authz_` prefix); the
  // physical co-location is the price of real atomicity in WAL mode. A `PRIMARY KEY
  // (document_id, user_id)` is what makes "one role per user per document" a storage fact.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AUTHZ_MEMBERSHIP_TABLE} (
      document_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (document_id, user_id)
    )
  `);
  // `GET /api/documents` resolves every membership for one user.
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${AUTHZ_MEMBERSHIP_USER_INDEX} ON ${AUTHZ_MEMBERSHIP_TABLE}(user_id)`,
  );

  // P0-1 schema 3: the version history. `yjs_state` is a self-contained encoded state (never a
  // "replay from this sequence" pointer), which is what lets a `pre-restore` row outlive log
  // compaction. `sequence` is the content revision at capture time (D-RC1).
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DOCUMENT_VERSION_TABLE} (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      title TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      yjs_state BLOB NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'pre-restore', 'restored'))
    )
  `);
  // `GET /api/documents/:id/versions` reads one document newest-first.
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${DOCUMENT_VERSION_DOC_SEQ_INDEX} ON ${DOCUMENT_VERSION_TABLE}(document_id, sequence DESC)`,
  );
  // D-OP1: one row per restore attempt that committed. The primary key is the idempotency
  // guarantee — `(document_id, operation_id)` is what makes a retry a lookup rather than a
  // second restore, and scoping it by document keeps one document's operation ids from ever
  // being answerable through another.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${RESTORE_OPERATION_TABLE} (
      document_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      version_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, operation_id)
    )
  `);
}

/** Table names present in the main database, excluding SQLite's own `sqlite_*` tables. */
function tableNames(db: Db): Set<string> {
  const names = new Set<string>();
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const name = row['name'];
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

/** Column names of one table; empty when the table does not exist. */
function columnNames(db: Db, table: string): Set<string> {
  const names = new Set<string>();
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    const name = row['name'];
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

/** Index names present in the main database. */
function indexNames(db: Db): Set<string> {
  const names = new Set<string>();
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const name = row['name'];
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

/** SQLite may report an INTEGER as `number` or `bigint`; normalise to `number`. */
function readInteger(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}
