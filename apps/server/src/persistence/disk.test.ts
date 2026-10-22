/**
 * M4 B6 — disk-failure behaviour: a startup free-space preflight and runtime write failures
 * (`docs/DECISIONS.md` D-082 D2/D4).
 *
 * Two different promises are proven here, and they must not be conflated:
 *
 * 1. **Before opening**: a nearly-full volume is refused with `DATA_DISK_LOW` instead of
 *    starting and failing on a user's first keystroke. The probe is injected, so this runs
 *    deterministically without filling a real disk.
 * 2. **At runtime**: when SQLite itself fails a write (`SQLITE_FULL`, `SQLITE_READONLY`), the
 *    error reaches the caller as `StoreOperationError` — it is never swallowed and never
 *    reported as a successful append. These use real SQLite failures: a connection capped at
 *    its current page count (SQLITE_FULL) and a genuinely read-only database file
 *    (SQLITE_READONLY).
 *
 * Every fixture is a real temporary directory (`docs/DECISIONS.md` D-041).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { openDocumentStore } from './open-store.js';
import {
  DEFAULT_DATA_MIN_FREE_BYTES,
  isSqliteCapabilityError,
  loadSqliteModule,
  readMinFreeBytes,
  type CapabilityOptions,
  type SqliteModule,
} from './sqlite-runtime.js';
import { DATABASE_FILE_NAME, SqliteDocumentStore } from './sqlite-store.js';
import { runServerExpectingRefusal } from './test-process.js';
import { StoreOperationError } from './types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-disk-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

/** A `statfs` stand-in with exact numbers, so threshold cases are not disk-dependent. */
function fixedSpace(bavail: number, bsize: number): CapabilityOptions {
  return { statfs: () => ({ bavail, bsize }) };
}

/** Assert a typed startup refusal whose code is one of `codes`. */
async function assertRefusal(
  open: () => Promise<unknown>,
  codes: readonly string[],
): Promise<void> {
  await assert.rejects(open, (error: unknown) => {
    assert.ok(isSqliteCapabilityError(error), `expected a typed refusal, got ${String(error)}`);
    if (!isSqliteCapabilityError(error)) return false;
    assert.ok(
      codes.includes(error.code),
      `expected one of ${codes.join(', ')}, got ${error.code}: ${error.message}`,
    );
    assert.ok(error.hint.length > 0, 'a startup refusal must tell the operator what to do');
    return true;
  });
}

/**
 * Wrap the real `node:sqlite` module with a `DatabaseSync` capped at the database's **current**
 * page count.
 *
 * This produces a genuine `SQLITE_FULL` from SQLite's own allocator on the next write that needs
 * a new page: nothing about the store's error handling is mocked, only the connection is
 * configured as a nearly-full disk would leave it. Creating the database is done with the
 * normal module first, so the cap cannot break schema creation.
 */
async function sqliteCappedAtCurrentPageCount(): Promise<SqliteModule> {
  const real = await loadSqliteModule();

  class CappedDatabase extends real.DatabaseSync {
    constructor(path: string, options?: ConstructorParameters<typeof real.DatabaseSync>[1]) {
      // `DatabaseSync` validates a second argument even when it is `undefined`, so an empty
      // options object is passed instead of forwarding the missing one.
      super(path, options ?? {});
      const row = this.prepare('PRAGMA page_count').get();
      const pages = Number(row?.['page_count'] ?? 0);
      this.exec(`PRAGMA max_page_count = ${pages}`);
    }
  }

  return { ...real, DatabaseSync: CappedDatabase } as unknown as SqliteModule;
}

/** The SQLite error code carried by a rejected store operation. */
function rejectionCause(error: unknown): { errcode?: number; message?: string; errstr?: string } {
  assert.ok(
    error instanceof StoreOperationError,
    `expected StoreOperationError, got ${String(error)}`,
  );
  assert.equal(error.operation, 'append');
  return error.cause as { errcode?: number; message?: string; errstr?: string };
}

/**
 * Deny this process write access to `dir`, returning a restore function.
 *
 * Windows uses an `icacls` deny ACE (a directory's read-only *attribute* does not stop child
 * creation); POSIX uses `chmod 0555`. Returns `null` when the platform could not apply a
 * restriction, so the caller can skip rather than assert a condition the OS never created.
 */
function denyDirectoryWrites(dir: string): (() => void) | null {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (user === undefined || user === '') return null;
    try {
      execFileSync('icacls', [dir, '/deny', `${user}:(OI)(CI)(W)`], { stdio: 'pipe' });
      return () => {
        execFileSync('icacls', [dir, '/remove:d', user], { stdio: 'pipe' });
      };
    } catch {
      return null;
    }
  }

  try {
    chmodSync(dir, 0o555);
    return () => chmodSync(dir, 0o755);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * Startup preflight
 * ---------------------------------------------------------------- */

describe('M4 B6 — free-space preflight (DATA_DISK_LOW)', () => {
  it('pins the documented 100 MiB default', () => {
    assert.equal(DEFAULT_DATA_MIN_FREE_BYTES, 100 * 1024 * 1024);
    assert.equal(readMinFreeBytes({}), DEFAULT_DATA_MIN_FREE_BYTES);
  });

  it('reads DATA_MIN_FREE_BYTES, falling back on an invalid or negative value', () => {
    // An explicit 0 is a deliberate opt-out, not a malformed value.
    assert.equal(readMinFreeBytes({ DATA_MIN_FREE_BYTES: '0' }), 0);
    assert.equal(readMinFreeBytes({ DATA_MIN_FREE_BYTES: '2048' }), 2048);
    assert.equal(readMinFreeBytes({ DATA_MIN_FREE_BYTES: '' }), DEFAULT_DATA_MIN_FREE_BYTES);
    assert.equal(
      readMinFreeBytes({ DATA_MIN_FREE_BYTES: 'not-a-number' }),
      DEFAULT_DATA_MIN_FREE_BYTES,
    );
    // A unit-suffixed typo must not be read as a tiny number and silently disable the floor.
    assert.equal(readMinFreeBytes({ DATA_MIN_FREE_BYTES: '100MiB' }), DEFAULT_DATA_MIN_FREE_BYTES);
    assert.equal(readMinFreeBytes({ DATA_MIN_FREE_BYTES: '-1' }), DEFAULT_DATA_MIN_FREE_BYTES);
  });

  it('refuses to open when the volume is below the floor, before writing anything', async () => {
    const dataPath = join(root, 'low-disk');

    await assertRefusal(() => openDocumentStore(dataPath, fixedSpace(1, 4096)), ['DATA_DISK_LOW']);

    // The check runs before the capability probe, so no temporary database and no store was
    // created — a nearly-full volume is not written to at all.
    assert.deepEqual(readdirSync(dataPath), []);
  });

  it('uses the configured floor, not a hard-coded value', async () => {
    const dataPath = join(root, 'explicit-floor');
    // 100 blocks * 1024 bytes = 102400 bytes available.
    const space = fixedSpace(100, 1024);

    // Exactly at the floor is allowed; one byte above it is refused.
    const opened = await openDocumentStore(dataPath, { ...space, minFreeBytes: 102_400 });
    await opened.store.close();

    await assertRefusal(
      () => openDocumentStore(dataPath, { ...space, minFreeBytes: 102_401 }),
      ['DATA_DISK_LOW'],
    );
  });

  it('treats minFreeBytes = 0 as an explicit opt-out', async () => {
    const dataPath = join(root, 'opt-out');
    const opened = await openDocumentStore(dataPath, { ...fixedSpace(1, 4096), minFreeBytes: 0 });
    try {
      assert.equal(opened.journalMode, 'wal');
    } finally {
      await opened.store.close();
    }
  });

  it('refuses to start when free space cannot be measured', async () => {
    // "Could not measure" must not become "assume there is room": that is the same
    // silent-degradation mode as falling back to memory-only storage.
    const dataPath = join(root, 'statfs-failure');
    await assertRefusal(
      () =>
        openDocumentStore(dataPath, {
          statfs: () => {
            throw new Error('statfs is not supported on this filesystem');
          },
        }),
      ['SQLITE_PROBE_FAILED'],
    );
    assert.equal(existsSync(join(dataPath, DATABASE_FILE_NAME)), false);
  });

  it('the real entrypoint exits 1 with DATA_DISK_LOW', () => {
    const dataPath = join(root, 'process-low-disk');

    // 1 PB: above any real volume, so the real statfs check refuses without needing a full
    // disk. This also proves the DATA_MIN_FREE_BYTES override is wired to the real process.
    const run = runServerExpectingRefusal(dataPath, {
      DATA_MIN_FREE_BYTES: '1000000000000000',
    });

    assert.equal(run.status, 1, `expected exit 1\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    assert.match(
      run.stderr,
      /refusing to start: DATA_DISK_LOW/,
      `the stable code must reach the operator log\nstderr=${run.stderr}`,
    );
    assert.doesNotMatch(run.stdout, /ws\s+ready/, 'a refused server must not listen');
    assert.equal(
      existsSync(join(dataPath, DATABASE_FILE_NAME)),
      false,
      'the low-disk refusal must not create a database',
    );
  });
});

/* ---------------------------------------------------------------- *
 * Runtime write failures
 * ---------------------------------------------------------------- */

describe('M4 B6 — a runtime write failure is never swallowed', () => {
  it('bubbles SQLITE_FULL as StoreOperationError and keeps the committed data intact', async () => {
    const dataPath = join(root, 'sqlite-full');
    const sqlite = await loadSqliteModule();

    // Create a valid schema-1 database with one committed update, using the normal module.
    const seed = SqliteDocumentStore.open(sqlite, dataPath);
    const committed = new Uint8Array([1, 2, 3]);
    try {
      await seed.append('doc-full', committed);
    } finally {
      await seed.close();
    }

    // Re-open it on a connection that cannot grow the database by even one page.
    const capped = SqliteDocumentStore.open(await sqliteCappedAtCurrentPageCount(), dataPath);
    try {
      const before = await capped.load('doc-full');
      assert.ok(before !== null);
      if (before === null) return;
      assert.equal(before.updates.length, 1);

      await assert.rejects(
        () => capped.append('doc-full', new Uint8Array(256 * 1024).fill(7)),
        (error: unknown) => {
          const cause = rejectionCause(error);
          // SQLITE_FULL (13). The point is not the number but that a real SQLite failure
          // reached the caller instead of being converted into success.
          assert.equal(cause.errcode, 13);
          assert.match(cause.errstr ?? cause.message ?? '', /full/i);
          return true;
        },
      );

      const after = await capped.load('doc-full');
      assert.ok(after !== null);
      if (after === null) return;
      assert.deepEqual(
        after.updates.map((row) => row.sequence),
        [1],
        'the failed append must not have committed a row',
      );
      assert.deepEqual([...(after.updates[0]?.update ?? [])], [...committed]);
    } finally {
      await capped.close();
    }

    // The sequence did not advance: a normal re-open accepts the next write as sequence 2.
    const reopened = await openDocumentStore(dataPath);
    try {
      assert.equal(await reopened.store.append('doc-full', new Uint8Array([4])), 2);
    } finally {
      await reopened.store.close();
    }
  });

  it('bubbles SQLITE_READONLY for a read-only database file and leaves the data readable', async () => {
    const dataPath = join(root, 'readonly-file');
    const first = await openDocumentStore(dataPath);
    const committed = new Uint8Array([5, 6, 7]);
    try {
      await first.store.append('doc-readonly', committed);
    } finally {
      await first.store.close();
    }

    const file = join(dataPath, DATABASE_FILE_NAME);
    // A read-only file in a writable directory: SQLite opens and reads it, but a write
    // transaction fails with SQLITE_READONLY (8). This is the OS-level condition, not a stub.
    chmodSync(file, 0o444);

    const reopened = await openDocumentStore(dataPath);
    try {
      await assert.rejects(
        () => reopened.store.append('doc-readonly', new Uint8Array([8])),
        (error: unknown) => {
          const cause = rejectionCause(error);
          assert.equal(cause.errcode, 8);
          assert.match(cause.message ?? '', /readonly|read-only/i);
          return true;
        },
      );

      // Reads still work and the committed bytes are unchanged.
      const stored = await reopened.store.load('doc-readonly');
      assert.ok(stored !== null);
      if (stored === null) return;
      assert.equal(stored.updates.length, 1);
      assert.deepEqual([...(stored.updates[0]?.update ?? [])], [...committed]);
    } finally {
      // Restore write access before closing/removing, or the checkpoint and cleanup fail.
      chmodSync(file, 0o666);
      await reopened.store.close();
    }

    assert.ok(readFileSync(file).byteLength > 0);
  });

  it('fails loudly when the data directory itself cannot be written', async (t) => {
    const dataPath = join(root, 'readonly-dir');
    mkdirSync(dataPath);

    const restore = denyDirectoryWrites(dataPath);
    if (restore === null) {
      t.skip('this platform/environment could not make a directory read-only');
      return;
    }

    try {
      // Prove the restriction is real before asserting anything about SQLite: an elevated or
      // root process bypasses it, and then this test would be measuring nothing.
      let restricted = false;
      try {
        writeFileSync(join(dataPath, '.write-probe'), 'x');
      } catch {
        restricted = true;
      }

      if (!restricted) {
        t.skip('the current user can write to the restricted directory (root/elevated)');
        return;
      }

      await assertRefusal(
        () => openDocumentStore(dataPath),
        ['SQLITE_PROBE_FAILED', 'DATA_PATH_UNAVAILABLE'],
      );

      // The refusal itself is the contract: no store was handed out, so nothing can silently
      // run memory-only. (Directory listing is not asserted here: the same deny ACE that
      // blocks child creation can make `scandir` fail, which is not what this test is about.)
    } finally {
      restore();
      rmSync(join(dataPath, '.write-probe'), { force: true });
    }
  });
});
