/**
 * Runtime prerequisite for the durable store: **capability-checked** `node:sqlite`
 * (`docs/ARCHITECTURE.md` §7.11, `docs/DECISIONS.md` D-051).
 *
 * ## The rule this file enforces
 *
 * The server must not start in a memory-only mode. Refusing to start is the correct
 * behaviour when durable storage cannot be opened, because a silent memory-only server is
 * exactly the M1 data-loss mode (`docs/DECISIONS.md` D-051). So this module does one
 * thing and refuses loudly: it either returns a verified SQLite module or throws an error
 * that names the unmet requirement.
 *
 * ## Why the check runs real statements instead of constructing a database
 *
 * Measured, not assumed (`docs/DECISIONS.md` D-041): **a corrupt or unreadable file does
 * not necessarily throw at `new DatabaseSync(path)` — the failure surfaces on the first
 * statement.** A check that only constructs therefore proves nothing. This check:
 *
 * 1. loads the module through a **dynamic** import, so a runtime without `node:sqlite`
 *    produces this module's diagnostic instead of an `ERR_UNKNOWN_BUILTIN_MODULE` thrown
 *    at ESM module-evaluation time, before any of our code could report it;
 * 2. verifies the API surface the design was verified against;
 * 3. creates and opens the configured data directory;
 * 4. checks the volume has enough free space to be worth starting on (M4 B6, `DATA_DISK_LOW`);
 * 5. sets `PRAGMA journal_mode = WAL` and checks the answer;
 * 6. round-trips a BLOB containing NUL bytes (byte-for-byte);
 * 7. exercises `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
 *
 * Every step is part of the design's contract with the runtime, so a pass here is
 * evidence for all of them rather than for "the module exists".
 */
import { mkdirSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

import { SQLITE_BUSY_TIMEOUT_MS } from './constants.js';

/** The verified runtime API surface. Typed from `@types/node`, so it cannot drift. */
export type SqliteModule = typeof import('node:sqlite');

/** Minimum runtime the design was verified against; quoted in the diagnostic. */
export const MINIMUM_NODE_FOR_SQLITE = 'Node 22.5.0 (verified on v22.14.0)';

export type SqliteCapabilityFailure =
  | 'SQLITE_RUNTIME_UNAVAILABLE'
  | 'DATA_PATH_UNAVAILABLE'
  | 'SQLITE_PROBE_FAILED'
  | 'STORE_OPEN_FAILED'
  | 'DATA_DISK_LOW'
  | 'DATA_INTEGRITY_FAILED'
  | 'DATA_SCHEMA_TOO_NEW';

/**
 * A startup-blocking capability failure.
 *
 * `hint` is written for the operator reading the server log, and is never serialised to a
 * WebSocket client (`docs/CONTRACTS.md` §7: the code is the contract, and no path or SQL
 * crosses the wire).
 */
export class SqliteCapabilityError extends Error {
  readonly code: SqliteCapabilityFailure;
  readonly hint: string;

  constructor(code: SqliteCapabilityFailure, message: string, hint: string, cause?: unknown) {
    super(message);
    this.name = 'SqliteCapabilityError';
    this.code = code;
    this.hint = hint;
    if (cause !== undefined) this.cause = cause;
  }
}

/** `true` when `error` is the startup-blocking capability failure (for one clean catch). */
export function isSqliteCapabilityError(error: unknown): error is SqliteCapabilityError {
  return error instanceof SqliteCapabilityError;
}

let cachedModule: SqliteModule | null = null;

/**
 * Load `node:sqlite`, once, with a typed failure.
 *
 * Cached because the workspace has a single database file and re-importing per store would
 * be pure overhead. Never returns a partially usable module: the API surface is verified
 * before the module is handed out.
 */
export async function loadSqliteModule(): Promise<SqliteModule> {
  if (cachedModule !== null) return cachedModule;

  let sqlite: SqliteModule;
  try {
    sqlite = await import('node:sqlite');
  } catch (cause) {
    throw new SqliteCapabilityError(
      'SQLITE_RUNTIME_UNAVAILABLE',
      `this server requires the built-in \`node:sqlite\` module, which this runtime does not provide (minimum: ${MINIMUM_NODE_FOR_SQLITE})`,
      'Upgrade Node. InsightHub does not use a third-party SQLite driver and will not fall back to memory-only storage.',
      cause,
    );
  }

  // The design was verified against this exact surface (§7.11). Checking it here keeps the
  // failure at startup with one clear message instead of a TypeError on the first write.
  const required = ['DatabaseSync'] as const;
  for (const member of required) {
    if (typeof sqlite[member] !== 'function') {
      throw new SqliteCapabilityError(
        'SQLITE_RUNTIME_UNAVAILABLE',
        `\`node:sqlite\` on this runtime does not expose ${member} (minimum: ${MINIMUM_NODE_FOR_SQLITE})`,
        'Upgrade Node. A missing capability is a runtime problem, not something this server can work around.',
      );
    }
  }

  cachedModule = sqlite;
  return sqlite;
}

/** What a successful capability check reports, for the startup log line. */
export interface SqliteCapabilityReport {
  readonly journalMode: string;
  readonly dataPath: string;
}

/**
 * Default free-space floor before the store is opened: **100 MiB** (M4 B6, `DATA_DISK_LOW`).
 *
 * Why a startup floor at all: a full disk does not make SQLite fail at open, it makes the
 * **next keystroke's `append`** fail with `SQLITE_FULL` — i.e. it surfaces as an editor error
 * for a user, long after the operator could have noticed. Refusing to start while there is
 * still a meaningful amount of space turns an imminent runtime failure into a diagnosable
 * startup refusal. 100 MiB is deliberately a floor, not a capacity plan.
 */
export const DEFAULT_DATA_MIN_FREE_BYTES = 100 * 1024 * 1024;

/** The slice of `statfs(2)` this check reads; injectable so the check itself is testable. */
export interface FileSystemSpace {
  /** Blocks available to an unprivileged process. */
  readonly bavail: number | bigint;
  /** Block size in bytes. */
  readonly bsize: number | bigint;
}

/** How the preflight measures free space. Defaults to `fs.statfsSync`. */
export type StatfsProbe = (path: string) => FileSystemSpace;

/** Optional injections for the capability check. Production passes nothing. */
export interface CapabilityOptions {
  /**
   * Free-space probe. Tests pass a fake to exercise `DATA_DISK_LOW` without filling a disk;
   * production omits it and gets `statfsSync`.
   */
  readonly statfs?: StatfsProbe;
  /**
   * Overrides `DATA_MIN_FREE_BYTES`. `0` disables the floor, so tests that are not about disk
   * space can open a store without depending on the host volume.
   */
  readonly minFreeBytes?: number;
}

/**
 * The configured free-space floor.
 *
 * `DATA_MIN_FREE_BYTES` follows the `INSIGHTHUB_DATA_PATH` precedent (§7.10): an environment
 * override of an operational policy, not a protocol value. An empty, malformed or negative
 * value falls back to {@link DEFAULT_DATA_MIN_FREE_BYTES}; an explicit `0` disables the check
 * (used by tests and by an operator who accepts the risk on a deliberately tiny volume).
 *
 * Only a plain non-negative integer is accepted. A lenient `parseInt` would read
 * `DATA_MIN_FREE_BYTES=100MiB` as 100 bytes and silently disable the floor — a typo must not
 * turn a safety check off.
 */
export function readMinFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DATA_MIN_FREE_BYTES?.trim();
  if (raw === undefined || raw === '') return DEFAULT_DATA_MIN_FREE_BYTES;
  if (!/^\d+$/.test(raw)) return DEFAULT_DATA_MIN_FREE_BYTES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_DATA_MIN_FREE_BYTES;
}

/**
 * Refuse to start when the data directory's volume is already nearly full.
 *
 * `bavail` (not `bfree`) is used because it is the space actually available to this process on
 * a volume with reserved blocks. A `statfs` failure is a startup failure too: if free space
 * cannot be measured, "assume it is fine" is the same silent-degradation mode this check
 * exists to remove — and SQLite would find out at the first write instead.
 */
function assertMinimumFreeSpace(dataPath: string, options: CapabilityOptions): void {
  const minFreeBytes = options.minFreeBytes ?? readMinFreeBytes();
  if (minFreeBytes <= 0) return;

  const probe = options.statfs ?? ((path: string): FileSystemSpace => statfsSync(path));

  let freeBytes: number;
  try {
    const stats = probe(dataPath);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch (cause) {
    throw new SqliteCapabilityError(
      'SQLITE_PROBE_FAILED',
      `the free space of the durable data directory could not be measured: ${dataPath}`,
      'The server checks free space before opening the store so a full disk is a startup refusal rather than a failed keystroke later.',
      cause,
    );
  }

  if (!Number.isFinite(freeBytes)) {
    throw new SqliteCapabilityError(
      'SQLITE_PROBE_FAILED',
      `the free space of the durable data directory was not a usable number: ${dataPath}`,
      'The server checks free space before opening the store so a full disk is a startup refusal rather than a failed keystroke later.',
    );
  }

  if (freeBytes < minFreeBytes) {
    throw new SqliteCapabilityError(
      'DATA_DISK_LOW',
      `the durable data directory has ${Math.floor(freeBytes)} bytes free, below the ${minFreeBytes}-byte minimum: ${dataPath}`,
      'Free space on the volume holding INSIGHTHUB_DATA_PATH, or lower DATA_MIN_FREE_BYTES if you accept that writes may fail with SQLITE_FULL.',
    );
  }
}

/**
 * Verify the runtime and the data directory, then throw away the probe database.
 *
 * Called by `openDocumentStore` before the real store is opened, so "refuses to start"
 * happens before any socket is accepted.
 */
export function assertSqliteCapability(
  sqlite: SqliteModule,
  dataPath: string,
  options: CapabilityOptions = {},
): SqliteCapabilityReport {
  // ---- 3. The data directory must exist and be writable. ----
  try {
    mkdirSync(dataPath, { recursive: true });
  } catch (cause) {
    throw new SqliteCapabilityError(
      'DATA_PATH_UNAVAILABLE',
      `the durable data directory could not be created or opened: ${dataPath}`,
      'Set INSIGHTHUB_DATA_PATH to a writable directory. The server will not start without durable storage.',
      cause,
    );
  }

  // ---- 4. The disk must have room for the store to actually work. ----
  // Before the probe, so a nearly-full volume is refused without writing even a temporary
  // database into it.
  assertMinimumFreeSpace(dataPath, options);

  const probePath = join(dataPath, `.insighthub-capability-probe-${process.pid}-${Date.now()}.db`);

  try {
    // ---- 5-7. A real database, real statements, real transaction. ----
    const db = new sqlite.DatabaseSync(probePath);
    try {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

      // Set it, then read it back: `PRAGMA journal_mode` reports the mode actually in force,
      // so reading after the write is what proves the runtime accepted it (a read alone
      // reports the default `delete` and would fail a correct runtime just as happily as a
      // broken one).
      db.exec('PRAGMA journal_mode = WAL');

      const journalMode = readJournalMode(db);
      if (journalMode.toLowerCase() !== 'wal') {
        throw new SqliteCapabilityError(
          'SQLITE_PROBE_FAILED',
          `\`node:sqlite\` did not accept WAL journal mode (reported: ${journalMode})`,
          'The durable store requires WAL: it is what makes snapshot replacement and log truncation atomic across a crash.',
        );
      }

      const blob = buildProbeBlob();
      db.exec('CREATE TABLE capability_probe (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)');

      // A prepared statement with a BLOB parameter: the exact shape `append` will use.
      const insert = db.prepare('INSERT INTO capability_probe (id, payload) VALUES (?, ?)');
      insert.run(1, blob);

      // BEGIN IMMEDIATE / COMMIT, then read back, then BEGIN IMMEDIATE / ROLLBACK.
      db.exec('BEGIN IMMEDIATE');
      insert.run(2, blob);
      db.exec('COMMIT');

      db.exec('BEGIN IMMEDIATE');
      insert.run(3, blob);
      db.exec('ROLLBACK');

      const select = db.prepare('SELECT id, payload FROM capability_probe ORDER BY id');
      const rows = select.all();
      const sameBytes = (a: unknown, b: Uint8Array): boolean => {
        const view = toUint8Array(a);
        if (view === null || view.byteLength !== b.byteLength) return false;
        for (let index = 0; index < b.byteLength; index += 1) {
          if (view[index] !== b[index]) return false;
        }
        return true;
      };

      if (rows.length !== 2) {
        throw new SqliteCapabilityError(
          'SQLITE_PROBE_FAILED',
          `\`node:sqlite\` did not honour BEGIN/COMMIT/ROLLBACK (expected 2 committed rows, read ${rows.length})`,
          'Transactions are what make compaction atomic. Without them the durable design cannot be honoured.',
        );
      }
      for (const row of rows) {
        if (!sameBytes(row.payload, blob)) {
          throw new SqliteCapabilityError(
            'SQLITE_PROBE_FAILED',
            '`node:sqlite` did not round-trip a BLOB byte-for-byte',
            'Yjs updates are binary and contain NUL bytes; a lossy BLOB path would corrupt every document.',
          );
        }
      }
    } finally {
      db.close();
    }

    return { journalMode: 'wal', dataPath };
  } catch (cause) {
    if (isSqliteCapabilityError(cause)) throw cause;
    throw new SqliteCapabilityError(
      'SQLITE_PROBE_FAILED',
      `the SQLite capability probe failed in ${dataPath}`,
      'The data directory exists but SQLite could not run a statement inside it. Check free space and file integrity (a corrupt database reports its failure here, not at open).',
      cause,
    );
  } finally {
    // Never leave probe artefacts in the operator's data directory.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${probePath}${suffix}`, { force: true });
      } catch {
        // A leftover probe file is harmless; a swallowed startup failure would not be.
      }
    }
  }
}

/** `PRAGMA journal_mode` returns the accepted mode in a row rather than as `run` output. */
function readJournalMode(db: InstanceType<SqliteModule['DatabaseSync']>): string {
  const row = db.prepare('PRAGMA journal_mode').get();
  if (row === undefined) return 'unknown';
  // The column is named `journal_mode`; read it without assuming key order.
  const value = row['journal_mode'];
  return typeof value === 'string' ? value : 'unknown';
}

/**
 * A BLOB that would break a lossy path: NUL bytes, every byte value, and a length that is
 * not a power of two.
 */
function buildProbeBlob(): Uint8Array {
  const blob = new Uint8Array(256);
  for (let index = 0; index < blob.length; index += 1) blob[index] = index;
  return blob;
}

/** Normalise a SQLite BLOB result to a `Uint8Array`, or `null` when it is not bytes. */
export function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/** Reset the module cache. **Tests only** — production loads it once per process. */
export function resetSqliteModuleCacheForTests(): void {
  cachedModule = null;
}
