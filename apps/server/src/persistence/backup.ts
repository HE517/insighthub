/**
 * SQLite **logical** backup, retention and restore (`docs/DECISIONS.md` D-082 D2, M4 B8).
 *
 * ## Why `VACUUM INTO` and not a file copy
 *
 * D-082 D2 requires a SQLite logical backup, nightly, retained for seven days, and a real
 * restore drill. The store runs in WAL mode, so the database is **not** one file at runtime:
 * `insighthub.db` plus `insighthub.db-wal` plus `insighthub.db-shm` together are the state.
 * Copying only `insighthub.db` while the server is running loses every transaction still in
 * the WAL, and copying the three files without a lock can capture them at different points in
 * time. `VACUUM INTO` runs inside SQLite, takes a read transaction (a consistent snapshot),
 * and writes a **single self-contained** database file with no sidecars — which is exactly
 * the "online safe" property this module promises.
 *
 * ## What each operation owns
 *
 * | Function | Owns | Never does |
 * | --- | --- | --- |
 * | `createLogicalBackup` | producing one verified snapshot file | touching the live database |
 * | `pruneBackups` | retention by **file-name timestamp** | deleting the newest backup |
 * | `restoreBackup` | atomically replacing the live file | leaving a WAL/journal behind |
 *
 * ## Retention uses the file name, not `mtime`
 *
 * The timestamp is encoded in the generated name (`insighthub-<UTC ISO>-<n>.db`). `mtime`
 * changes whenever a file is copied, unpacked or touched by a backup-sync tool, so an old
 * backup relocated yesterday would look fresh and outlive the seven-day promise. The name is
 * written once by {@link createLogicalBackup} and is the same value the operator sees. Files
 * whose names do not parse are **never** deleted: this module only prunes what it created.
 *
 * ## Failure is typed and content-free
 *
 * Every failure is a {@link BackupError} with a stable `code`, so the CLI can print a
 * diagnosable line and exit non-zero. Messages name a path or an operation, never document
 * bytes: a backup tool that echoes the data it is protecting into a log is a leak
 * (`docs/DECISIONS.md` D-044's "log the detail, never the content" rule).
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { SQLITE_BUSY_TIMEOUT_MS } from './constants.js';
import { assertDatabaseIntegrity, assertSchemaSupported } from './schema.js';
import { loadSqliteModule, type SqliteModule } from './sqlite-runtime.js';
import { DATABASE_FILE_NAME } from './sqlite-store.js';

type Db = InstanceType<SqliteModule['DatabaseSync']>;

/**
 * Stable failure codes. A caller (the CLI, a cron wrapper, a future scheduler) branches on
 * these rather than parsing an English message.
 */
export type BackupErrorCode =
  | 'INVALID_ARGUMENT'
  | 'BACKUP_SOURCE_MISSING'
  | 'BACKUP_SOURCE_UNREADABLE'
  | 'BACKUP_DIR_UNAVAILABLE'
  | 'BACKUP_CREATE_FAILED'
  | 'BACKUP_VERIFY_FAILED'
  | 'BACKUP_LIST_FAILED'
  | 'BACKUP_PRUNE_FAILED'
  | 'RESTORE_SOURCE_MISSING'
  | 'RESTORE_SOURCE_INVALID'
  | 'RESTORE_TARGET_EXISTS'
  | 'RESTORE_FAILED';

/**
 * A backup/restore failure.
 *
 * `hint` is operator-facing guidance, in the same spirit as `SqliteCapabilityError.hint`.
 * Neither field is allowed to carry document content.
 */
export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly hint: string;

  constructor(code: BackupErrorCode, message: string, hint: string, cause?: unknown) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.hint = hint;
    if (cause !== undefined) this.cause = cause;
  }
}

/** `true` when `error` is a typed backup/restore failure (for one clean catch). */
export function isBackupError(error: unknown): error is BackupError {
  return error instanceof BackupError;
}

/** The retention D-082 D2 fixes: **seven days**. */
export const DEFAULT_BACKUP_RETENTION_DAYS = 7;

/** Prefix and suffix of a backup file, used by the parser and by `listBackups`. */
export const BACKUP_FILE_PREFIX = 'insighthub-';

/**
 * The generated name shape.
 *
 * A UTC ISO timestamp contains `:`, which is not a legal character in a Windows file name, so
 * the two colons are replaced with `-`. Everything else about the stamp is ISO 8601 / UTC
 * (`Z` suffix, millisecond precision), and the trailing `-<n>` keeps two backups taken in the
 * same millisecond apart.
 *
 * ```text
 * insighthub-2026-10-22T14-03-12.345Z-1.db
 * ```
 */
export const BACKUP_FILE_PATTERN =
  /^insighthub-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z-(\d+)\.db$/;

/**
 * The WAL/journal siblings of `insighthub.db`.
 *
 * A restored database must not inherit them: they describe the *old* file. `-wal` and `-shm`
 * are WAL artefacts and `-journal` is the rollback journal; all three are removed around a
 * replace, and the restored file is a rollback-journal database so none is created again.
 */
const DATABASE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** The tables every restorable database must carry; `document` is the content seam. */
const REQUIRED_BACKUP_TABLES = ['document', 'document_update'] as const;

/** One backup file discovered in a backup directory. */
export interface BackupFileInfo {
  readonly path: string;
  readonly fileName: string;
  /** Timestamp parsed from the file name, **not** `mtime`. */
  readonly createdAt: Date;
  /** The `-<n>` suffix, used to break ties between equal timestamps. */
  readonly sequence: number;
  readonly bytes: number;
}

export interface CreateLogicalBackupOptions {
  /** Directory holding the live `insighthub.db`. */
  readonly dataPath: string;
  /** Directory the snapshot is written into. Created when missing. */
  readonly backupDir: string;
  /** Injected clock, so a file name is assertable without waiting for wall time. */
  readonly now: Date;
}

export interface LogicalBackup {
  readonly path: string;
  readonly bytes: number;
}

export interface PruneBackupsOptions {
  readonly backupDir: string;
  readonly now: Date;
  /** Defaults to the D-082 D2 retention of seven days. */
  readonly retentionDays?: number;
}

export interface RestoreBackupOptions {
  readonly backupPath: string;
  /** Target data directory; `insighthub.db` inside it is replaced. */
  readonly dataPath: string;
  /**
   * Allow replacing an existing database. `false` by default: an accidental restore over a
   * live store is data loss, so overwriting is an explicit decision.
   */
  readonly force?: boolean;
}

export interface RestoredDatabase {
  readonly path: string;
  readonly bytes: number;
}

/* ---------------------------------------------------------------- *
 * Naming and discovery
 * ---------------------------------------------------------------- */

/**
 * The backup file name for `now` and `sequence`.
 *
 * Exported so tests and operators can predict the name instead of globbing, and so the
 * retention parser has exactly one counterpart on the writing side.
 */
export function backupFileName(now: Date, sequence = 1): string {
  assertValidDate(now, 'backup timestamp');
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new BackupError(
      'INVALID_ARGUMENT',
      `backup sequence must be a positive integer, got ${String(sequence)}`,
      'This is a programming error: the sequence is chosen by createLogicalBackup.',
    );
  }
  return `${BACKUP_FILE_PREFIX}${now.toISOString().replaceAll(':', '-')}-${sequence}.db`;
}

/**
 * Parse a generated backup name back to its creation time and sequence.
 *
 * Returns `null` for anything this module did not generate — including a different prefix, a
 * malformed timestamp, or a non-ISO shape. `null` means "not ours, leave it alone", which is
 * why prune can never delete an unrelated file that happens to sit in the backup directory.
 */
export function parseBackupFileName(
  fileName: string,
): { readonly createdAt: Date; readonly sequence: number } | null {
  const match = BACKUP_FILE_PATTERN.exec(fileName);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const sequence = Number(match[8]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;

  const createdAt = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  // `Date.UTC` happily rolls `2026-13-01` into 2027-01-01. Round-tripping the components is
  // what rejects an impossible stamp instead of silently assigning it a different day.
  if (
    createdAt.getUTCFullYear() !== year ||
    createdAt.getUTCMonth() !== month - 1 ||
    createdAt.getUTCDate() !== day ||
    createdAt.getUTCHours() !== hour ||
    createdAt.getUTCMinutes() !== minute ||
    createdAt.getUTCSeconds() !== second ||
    createdAt.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  return { createdAt, sequence };
}

/**
 * Every backup this module generated in `backupDir`, oldest first.
 *
 * A missing directory is an empty list, not an error: "nothing to prune" and "the directory
 * was never created" are the same operational state. Unparseable entries are skipped.
 */
export function listBackups(backupDir: string): readonly BackupFileInfo[] {
  const directory = resolve(backupDir);
  if (!existsSync(directory)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    throw new BackupError(
      'BACKUP_LIST_FAILED',
      `the backup directory could not be read: ${directory}`,
      'Check that the path exists, is a directory, and is readable by this process.',
      cause,
    );
  }

  const backups: BackupFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseBackupFileName(entry.name);
    if (parsed === null) continue;

    const path = join(directory, entry.name);
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch (cause) {
      throw new BackupError(
        'BACKUP_LIST_FAILED',
        `a backup file disappeared while the directory was being listed: ${path}`,
        'Retry the operation; a concurrent prune or external tool changed the directory.',
        cause,
      );
    }

    backups.push({
      path,
      fileName: entry.name,
      createdAt: parsed.createdAt,
      sequence: parsed.sequence,
      bytes,
    });
  }

  backups.sort((left, right) => {
    const byTime = left.createdAt.getTime() - right.createdAt.getTime();
    return byTime !== 0 ? byTime : left.sequence - right.sequence;
  });
  return backups;
}

/* ---------------------------------------------------------------- *
 * Backup
 * ---------------------------------------------------------------- */

/**
 * Create one consistent logical snapshot of the live store.
 *
 * The source connection is opened by this function (never reused from the running server) and
 * `VACUUM INTO` is left to take its own read transaction, so this is safe while the server is
 * serving traffic. `VACUUM INTO` refuses an existing target, so the name is chosen against the
 * current directory contents rather than overwritten.
 *
 * The result is verified before it is reported: journal mode is normalised to `DELETE` (a
 * self-contained file with no `-wal`), `PRAGMA quick_check` runs, and the two document tables
 * must exist. A backup that cannot be restored is worse than no backup, because it is believed.
 * A failed verification deletes the file instead of leaving a plausible-looking corrupt
 * snapshot behind for prune to protect as "the newest".
 */
export async function createLogicalBackup(
  options: CreateLogicalBackupOptions,
): Promise<LogicalBackup> {
  assertValidDate(options.now, 'backup timestamp');
  const dataPath = resolve(options.dataPath);
  const backupDir = resolve(options.backupDir);
  const sourcePath = join(dataPath, DATABASE_FILE_NAME);

  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new BackupError(
      'BACKUP_SOURCE_MISSING',
      `there is no durable database to back up at ${sourcePath}`,
      'Check INSIGHTHUB_DATA_PATH. A backup of a missing database must fail rather than create an empty one.',
    );
  }

  ensureBackupDirectory(backupDir);

  const sqlite = await loadSqliteModule();
  const targetPath = nextFreeBackupPath(backupDir, options.now);

  let source: Db;
  try {
    source = new sqlite.DatabaseSync(sourcePath);
  } catch (cause) {
    throw new BackupError(
      'BACKUP_SOURCE_UNREADABLE',
      `the durable database could not be opened for backup: ${sourcePath}`,
      'Stop the server and inspect the file. A backup must not silently skip an unreadable database.',
      cause,
    );
  }

  try {
    source.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    // `VACUUM INTO` is the logical copy: it serialises the database (schema + rows) into a
    // brand-new file through SQLite itself, which is why the WAL is included consistently.
    source.exec(`VACUUM INTO ${quoteSqlLiteral(targetPath)}`);
  } catch (cause) {
    throw new BackupError(
      'BACKUP_CREATE_FAILED',
      `the logical backup could not be written to ${backupDir}`,
      'Check that the backup directory is writable and that the volume has free space.',
      cause,
    );
  } finally {
    try {
      source.close();
    } catch {
      // A failed close does not change the outcome; the snapshot was already written (or not).
    }
  }

  try {
    verifyLogicalBackup(sqlite, targetPath);
    const bytes = statSync(targetPath).size;
    if (bytes <= 0) {
      throw new BackupError(
        'BACKUP_VERIFY_FAILED',
        `the backup file is empty: ${targetPath}`,
        'The snapshot could not be verified, so it is not reported as a successful backup.',
      );
    }
    return { path: targetPath, bytes };
  } catch (cause) {
    // Do not leave an unverifiable file where retention would protect it as the newest backup.
    try {
      rmSync(targetPath, { force: true });
    } catch {
      // The original failure is the one worth reporting.
    }
    if (isBackupError(cause)) throw cause;
    throw new BackupError(
      'BACKUP_VERIFY_FAILED',
      `the backup could not be verified: ${targetPath}`,
      'The snapshot was written but did not pass integrity checks; it has been removed. Check free space and the health of the source database.',
      cause,
    );
  }
}

/** Create the backup directory, distinguishing "exists as a file" from "cannot create". */
function ensureBackupDirectory(backupDir: string): void {
  try {
    if (existsSync(backupDir) && !statSync(backupDir).isDirectory()) {
      throw new BackupError(
        'BACKUP_DIR_UNAVAILABLE',
        `the backup path exists but is not a directory: ${backupDir}`,
        'Point BACKUP_DIR at a directory (or leave it unset to use the default).',
      );
    }
    mkdirSync(backupDir, { recursive: true });
  } catch (cause) {
    if (isBackupError(cause)) throw cause;
    throw new BackupError(
      'BACKUP_DIR_UNAVAILABLE',
      `the backup directory could not be created: ${backupDir}`,
      'Point BACKUP_DIR at a writable directory on a volume with free space.',
      cause,
    );
  }
}

/**
 * The first `-<n>` suffix whose file does not exist yet.
 *
 * `VACUUM INTO` fails on an existing file, and two backups in the same millisecond are
 * possible, so the name is probed rather than assumed. The loop is bounded because a
 * three-digit collision means something is wrong with the directory, not with the clock.
 */
function nextFreeBackupPath(backupDir: string, now: Date): string {
  for (let sequence = 1; sequence <= 999; sequence += 1) {
    const candidate = join(backupDir, backupFileName(now, sequence));
    if (!existsSync(candidate)) return candidate;
  }
  throw new BackupError(
    'BACKUP_CREATE_FAILED',
    `more than 999 backups share the same timestamp in ${backupDir}`,
    'This is not a normal clock condition. Inspect the backup directory before retrying.',
  );
}

/**
 * Prove the snapshot is usable before it is reported.
 *
 * `journal_mode = DELETE` makes the file self-contained: if `VACUUM INTO` ever produced a WAL
 * database, this checkpoints it and removes the sidecar so the artifact is one file. The
 * `quick_check` then reuses the same integrity rule the server applies at startup, and the
 * table check catches the "valid but empty file" case that would otherwise restore as an empty
 * store.
 */
function verifyLogicalBackup(sqlite: SqliteModule, backupPath: string): void {
  let db: Db | null = null;
  try {
    db = new sqlite.DatabaseSync(backupPath);
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

    const modeRow = db.prepare('PRAGMA journal_mode = DELETE').get();
    const mode = typeof modeRow?.['journal_mode'] === 'string' ? modeRow['journal_mode'] : '';
    if (mode.toLowerCase() !== 'delete') {
      throw new BackupError(
        'BACKUP_VERIFY_FAILED',
        `the backup is not in rollback-journal mode (reported: ${mode || 'unknown'})`,
        'A backup must be one self-contained file; a WAL backup could lose its last transactions when copied alone.',
      );
    }

    // Throws `SqliteCapabilityError` on damage; the caller converts it to a BackupError.
    assertDatabaseIntegrity(db, backupPath);
    assertRequiredTables(db, backupPath);
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing useful to add to a verification failure.
    }
  }
}

/** Throw when the backup cannot represent the document seam at all. */
function assertRequiredTables(db: Db, databasePath: string): void {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row['name'])),
  );
  const missing = REQUIRED_BACKUP_TABLES.filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw new BackupError(
      'BACKUP_VERIFY_FAILED',
      `the database is valid SQLite but is missing ${missing.join(', ')}: ${databasePath}`,
      'This is not an InsightHub document database (or it is an empty file). Restore a real backup or back up the correct data path.',
    );
  }
}

/* ---------------------------------------------------------------- *
 * Retention
 * ---------------------------------------------------------------- */

/**
 * Delete backups older than `retentionDays`, **except** the newest one.
 *
 * Age is read from the file name (see the file header for why not `mtime`). The comparison is
 * strict: a backup exactly at the cutoff survives, so "seven days" means seven full days.
 *
 * The newest backup is always kept even when it is older than the window — a store that has
 * not been backed up for eight days still has one recovery point, and deleting it would turn
 * an overdue backup into no backup at all. Unknown file names are never touched.
 */
export async function pruneBackups(options: PruneBackupsOptions): Promise<readonly string[]> {
  assertValidDate(options.now, 'prune timestamp');
  const retentionDays = options.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new BackupError(
      'INVALID_ARGUMENT',
      `retentionDays must be a finite non-negative number, got ${String(retentionDays)}`,
      'Use the default of 7 days unless an operator has explicitly chosen otherwise.',
    );
  }

  const backupDir = resolve(options.backupDir);
  const backups = listBackups(backupDir);
  if (backups.length === 0) return [];

  // `listBackups` sorts oldest first, so the last entry is the most recent recovery point.
  const newest = backups.at(-1);
  const cutoff = options.now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];

  for (const backup of backups) {
    if (newest !== undefined && backup.path === newest.path) continue;
    if (backup.createdAt.getTime() >= cutoff) continue;

    try {
      rmSync(backup.path, { force: true });
      deleted.push(backup.path);
    } catch (cause) {
      throw new BackupError(
        'BACKUP_PRUNE_FAILED',
        `an expired backup could not be deleted: ${backup.path}`,
        'Check the permissions of the backup directory. Retention that silently stops working is how backups accumulate without bound.',
        cause,
      );
    }
  }

  return deleted;
}

/* ---------------------------------------------------------------- *
 * Restore
 * ---------------------------------------------------------------- */

/**
 * Replace the live database with a backup, atomically.
 *
 * Order, and why:
 *
 * 1. the source is validated with `PRAGMA quick_check` and the schema-version guard **before**
 *    anything is written, so an unusable backup cannot destroy the current file;
 * 2. a non-empty target is refused unless `force` (`RESTORE_TARGET_EXISTS`) — the target counts
 *    as occupied when the database or any of its WAL/journal sidecars exist;
 * 3. the bytes are copied to a temporary file **in the target directory** (same volume, so the
 *    rename is atomic) and fsynced;
 * 4. stale `-wal`/`-shm`/`-journal` files from the database being replaced are removed, then
 *    the temporary file is renamed over `insighthub.db`;
 * 5. the result is asserted to have no sidecars, so a restore never hands the next server a
 *    journal that describes a different file.
 *
 * The store must be closed while this runs; nothing here can stop a running process from
 * reopening the old file. The CLI states that requirement in its help text, and the
 * `RESTORE_TARGET_EXISTS` refusal is the backstop for an operator who runs it anyway.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoredDatabase> {
  const backupPath = resolve(options.backupPath);
  const dataPath = resolve(options.dataPath);
  const targetPath = join(dataPath, DATABASE_FILE_NAME);
  const force = options.force === true;

  if (!existsSync(backupPath)) {
    throw new BackupError(
      'RESTORE_SOURCE_MISSING',
      `the backup file does not exist: ${backupPath}`,
      'Pass the path printed by `backup`, or list the backup directory.',
    );
  }
  const backupStat = statSync(backupPath);
  if (!backupStat.isFile() || backupStat.size === 0) {
    throw new BackupError(
      'RESTORE_SOURCE_INVALID',
      `the backup is not a non-empty file: ${backupPath}`,
      'Point restore at a verified backup produced by the backup command.',
    );
  }

  const sqlite = await loadSqliteModule();
  verifyRestorableBackup(sqlite, backupPath);

  const sidecars = DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${targetPath}${suffix}`);
  const occupied = [targetPath, ...sidecars].filter((path) => existsSync(path));
  if (occupied.length > 0 && !force) {
    throw new BackupError(
      'RESTORE_TARGET_EXISTS',
      `the target already holds a database: ${targetPath}`,
      'Stop the server and pass `--force` to replace it. Refusing by default is what keeps a mistyped restore from overwriting live data.',
    );
  }

  try {
    mkdirSync(dataPath, { recursive: true });
  } catch (cause) {
    throw new BackupError(
      'RESTORE_FAILED',
      `the target data directory could not be created: ${dataPath}`,
      'Check that the path is writable.',
      cause,
    );
  }

  // Same directory as the target: a rename across volumes would degrade to a copy and could
  // leave a half-written `insighthub.db` behind.
  const temporaryPath = join(dataPath, `.insighthub-restore-${randomUUID()}.db.tmp`);
  let replaced = false;
  try {
    copyFileSync(backupPath, temporaryPath);
    fsyncFile(temporaryPath);

    // These describe the database being replaced. Removing them before the rename keeps the
    // window where new bytes and old journals coexist at zero.
    for (const sidecar of sidecars) rmSync(sidecar, { force: true });

    renameSync(temporaryPath, targetPath);
    replaced = true;
  } catch (cause) {
    throw new BackupError(
      'RESTORE_FAILED',
      `the backup could not be installed at ${targetPath}`,
      'The existing database is unchanged; inspect the target directory before retrying.',
      cause,
    );
  } finally {
    if (!replaced) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // A leftover temporary file is less harmful than masking the original failure.
      }
    }
  }

  // The copied file is a rollback-journal database, so this should already hold. Assert it
  // rather than assume: a stale journal left next to it would be read as a hot journal.
  const leftovers = sidecars.filter((sidecar) => existsSync(sidecar));
  if (leftovers.length > 0) {
    throw new BackupError(
      'RESTORE_FAILED',
      `the restored database has a stale sidecar: ${leftovers.join(', ')}`,
      'Remove the listed file(s) before starting the server; a journal beside the restored file is not part of it.',
    );
  }

  // The installed file is a byte copy of the validated backup, so its size is already known.
  // Re-`stat`ing would add a failure point *after* a successful restore.
  return { path: targetPath, bytes: backupStat.size };
}

/**
 * Validate a backup before it can replace anything.
 *
 * The same checks the server applies at startup are used here — a backup that would be refused
 * on open must be refused at restore time, while the operator still has the old file. The
 * schema guard is included so a backup written by a **newer** binary is rejected with a clear
 * code instead of being installed and then failing the next start with `DATA_SCHEMA_TOO_NEW`.
 */
function verifyRestorableBackup(sqlite: SqliteModule, backupPath: string): void {
  let db: Db | null = null;
  try {
    db = new sqlite.DatabaseSync(backupPath);
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    assertDatabaseIntegrity(db, backupPath);
    assertRequiredTables(db, backupPath);
    assertSchemaSupported(db, backupPath);
  } catch (cause) {
    if (cause instanceof BackupError) throw cause;
    throw new BackupError(
      'RESTORE_SOURCE_INVALID',
      `the backup is not a usable InsightHub database: ${backupPath}`,
      'Use a backup that passed creation-time verification. The current database has not been touched.',
      cause,
    );
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing useful to add to a validation failure.
    }
  }
}

/** `fsync` a copied file so a crash after the rename cannot expose unflushed bytes. */
function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/* ---------------------------------------------------------------- *
 * Internals
 * ---------------------------------------------------------------- */

/** Reject an invalid clock before it becomes an unparseable file name. */
function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BackupError(
      'INVALID_ARGUMENT',
      `${label} is not a valid Date`,
      'This is a programming error: pass a real clock value.',
    );
  }
}

/**
 * Quote a filesystem path as a SQL string literal.
 *
 * SQLite string literals escape a single quote by doubling it and treat backslash literally,
 * which is exactly what a Windows path needs. The path is never taken from user input in
 * production — it is built from `BACKUP_DIR` — but quoting is not optional: an apostrophe in
 * a directory name would otherwise break the statement (and a naive interpolation would be an
 * injection seam).
 */
function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
