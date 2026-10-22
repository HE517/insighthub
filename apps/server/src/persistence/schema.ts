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
 * **1**.
 *
 * ## The three cases
 *
 * | On-disk `user_version` | Meaning | Action |
 * | --- | --- | --- |
 * | `0`, no known table | a new database | create the objects and record `1`, one transaction |
 * | `0`, known tables | a pre-B6 database | migrate to `1`, one transaction, data untouched |
 * | `1` | current | verify the tables exist, do nothing |
 * | `> 1` | written by a newer binary | **refuse** with `DATA_SCHEMA_TOO_NEW` |
 *
 * There is deliberately no "best effort" branch for `> 1`: opening a newer file read-write is
 * how an old binary corrupts data it does not understand, and the alternative — opening it
 * read-only and pretending everything works — would turn a version mismatch into silent write
 * failures later.
 *
 * ## What migration may and may not do
 *
 * The B6 migration only *records* the version; it performs no `ALTER TABLE` and rewrites no
 * row. It does re-run the same idempotent `CREATE TABLE IF NOT EXISTS` statements the pre-B6
 * open ran on **every** start, so a file from an older milestone that predates (say) the
 * `app_user` table gains that empty table instead of failing to prepare a statement later.
 * That statement pair is in one `BEGIN IMMEDIATE … COMMIT`, so a crash mid-migration leaves
 * either version 0 or version 1, never a half-written header.
 *
 * Migration is therefore **idempotent**: a second open sees version 1 and returns `unchanged`.
 */
import { SqliteCapabilityError, type SqliteModule } from './sqlite-runtime.js';
import { runInTransaction } from './transaction.js';

type Db = InstanceType<SqliteModule['DatabaseSync']>;

/** The schema this binary writes and understands. Bump only with a real migration. */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Every table schema version 1 is expected to contain.
 *
 * Exported for tests and for the startup check below; the order is the creation order.
 */
export const SCHEMA_TABLES = ['document', 'document_update', 'document_meta', 'app_user'] as const;

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
 * Runs **after** {@link assertDatabaseIntegrity} and after WAL is established, so every write
 * here happens on a database SQLite already considers structurally sound. Every branch that
 * writes is one transaction (see the file header).
 */
export function ensureSchema(db: Db, dataPath: string): SchemaState {
  // The version guard is repeated here (the caller already ran it before enabling WAL) so that
  // a direct caller — a test, or a future maintenance entrypoint — cannot bypass it.
  const version = assertSchemaSupported(db, dataPath);

  const existing = tableNames(db);

  if (version === CURRENT_SCHEMA_VERSION) {
    const missing = SCHEMA_TABLES.filter((table) => !existing.has(table));
    if (missing.length > 0) {
      throw new SqliteCapabilityError(
        'DATA_INTEGRITY_FAILED',
        `the durable database claims schema version ${version} but is missing ${missing.join(', ')}: ${dataPath}`,
        'The schema marker and the actual tables disagree, so the file was modified or truncated outside InsightHub. Restore a backup; the server will not invent the missing structure.',
      );
    }
    return { version, action: 'unchanged' };
  }

  // Version 0: either a brand-new file or a pre-B6 database. `document`/`document_update` are
  // the oldest tables, so their presence is what distinguishes the two.
  const isLegacy = SCHEMA_TABLES.some((table) => existing.has(table));

  runInTransaction(db, () => {
    // Idempotent by construction: on a new file this creates everything; on a pre-B6 file it
    // only adds a table an older milestone lacked, and never alters an existing one.
    createSchemaObjects(db);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });

  return { version: CURRENT_SCHEMA_VERSION, action: isLegacy ? 'migrated' : 'created' };
}

/**
 * The schema-1 objects. These are exactly the four tables the pre-B6 open created, with the
 * same columns and constraints; moving them here is what lets creation and migration share one
 * definition.
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
      updated_at INTEGER NOT NULL
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

/** SQLite may report an INTEGER as `number` or `bigint`; normalise to `number`. */
function readInteger(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}
