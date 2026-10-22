/**
 * M4 B8 — logical backup, seven-day retention and a **real restore drill**
 * (`docs/DECISIONS.md` D-082 D2).
 *
 * The drill is deliberately not a simulation: it writes a document through the production
 * `openDocumentStore` path, closes it, takes a `VACUUM INTO` backup, **destroys the data
 * directory**, restores the backup, re-opens the store and asserts the text character for
 * character. A backup nobody ever restored is a hypothesis; this file turns it into a
 * measured result.
 *
 * The other scenarios pin the promises that make the drill safe to automate:
 *
 * - a snapshot can be taken while the server is still writing (online consistency);
 * - retention deletes by **file-name time**, keeps everything inside seven days, and never
 *   deletes the newest recovery point even when it is overdue;
 * - restore refuses to overwrite by default and leaves the existing database byte-identical;
 * - backup failures are typed, so a cron wrapper cannot mistake "no backup" for success.
 *
 * Every fixture is a real temporary directory next to the test (`docs/DECISIONS.md` D-041).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as Y from 'yjs';

import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  backupFileName,
  createLogicalBackup,
  isBackupError,
  listBackups,
  parseBackupFileName,
  pruneBackups,
  restoreBackup,
  type BackupErrorCode,
} from './backup.js';
import { applyStoredDocument } from './hydrator.js';
import { openDocumentStore } from './open-store.js';
import { DATABASE_FILE_NAME } from './sqlite-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date('2026-10-22T14:03:12.345Z');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-backup-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

/** Write one Yjs document through the production open path, then close it. */
async function seedDocument(dataPath: string, documentId: string, text: string): Promise<void> {
  const { store } = await openDocumentStore(dataPath);
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, text);
    await store.append(documentId, Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
    await store.close();
  }
}

/** Replay the durable state and return the rendered text, or `null` when never stored. */
async function readDocumentText(dataPath: string, documentId: string): Promise<string | null> {
  const { store } = await openDocumentStore(dataPath);
  const doc = new Y.Doc();
  try {
    const stored = await store.load(documentId);
    if (stored === null) return null;
    applyStoredDocument(stored, doc);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
    await store.close();
  }
}

/** Assert a typed backup failure with one of `codes`, and a non-empty operator hint. */
function assertBackupError(...codes: readonly BackupErrorCode[]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(isBackupError(error), `expected a typed BackupError, got ${String(error)}`);
    if (!isBackupError(error)) return false;
    assert.ok(
      codes.includes(error.code),
      `expected ${codes.join(' | ')}, got ${error.code}: ${error.message}`,
    );
    assert.ok(error.hint.length > 0, 'a typed failure must tell the operator what to do');
    return true;
  };
}

/** WAL/journal siblings present next to a database file. */
function sidecars(dataPath: string): string[] {
  return ['-wal', '-shm', '-journal']
    .map((suffix) => `${join(dataPath, DATABASE_FILE_NAME)}${suffix}`)
    .filter((path) => existsSync(path));
}

/**
 * Deny this process write access to `dir`, returning a restore function.
 *
 * Windows uses an `icacls` deny ACE (a directory's read-only attribute does not stop child
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
 * File naming and retention parsing
 * ---------------------------------------------------------------- */

describe('M4 B8 — backup file naming', () => {
  it('encodes a UTC ISO timestamp plus a sequence in a filesystem-safe name', () => {
    const name = backupFileName(FIXED_NOW, 2);
    // The two colons of an ISO stamp are illegal on Windows, so they become `-`; everything
    // else (date, `T`, milliseconds, `Z`) is still the UTC ISO shape.
    assert.equal(name, 'insighthub-2026-10-22T14-03-12.345Z-2.db');

    const parsed = parseBackupFileName(name);
    assert.ok(parsed !== null, `expected ${name} to parse`);
    if (parsed === null) return;
    assert.equal(parsed.createdAt.toISOString(), FIXED_NOW.toISOString());
    assert.equal(parsed.sequence, 2);

    assert.equal(parseBackupFileName('operator-notes.txt'), null);
    assert.equal(parseBackupFileName('insighthub-2026-13-01T00-00-00.000Z-1.db'), null);
    assert.equal(parseBackupFileName('insighthub-2026-10-22T14-03-12.345Z-0.db'), null);
    assert.throws(
      () => backupFileName(new Date(Number.NaN)),
      assertBackupError('INVALID_ARGUMENT'),
    );
  });

  it('pins the seven-day retention default from D-082 D2', () => {
    assert.equal(DEFAULT_BACKUP_RETENTION_DAYS, 7);
  });
});

/* ---------------------------------------------------------------- *
 * The real restore drill
 * ---------------------------------------------------------------- */

describe('M4 B8 — restore drill (real store, real files, real VACUUM INTO)', () => {
  it('restores the exact document text after the live data directory is destroyed', async () => {
    const dataPath = join(root, 'drill-data');
    const backupDir = join(root, 'drill-backups');
    // Chinese + emoji + a unique marker: an assertion that passes on a lossy path would be
    // suspicious, so the payload exercises multi-byte UTF-8 as well.
    const text = 'M4-B8 restore drill · 逐字恢复演练 ✅ · unique-7f3c9a';

    await seedDocument(dataPath, 'doc-drill', text);
    assert.equal(await readDocumentText(dataPath, 'doc-drill'), text);

    const backup = await createLogicalBackup({ dataPath, backupDir, now: FIXED_NOW });

    assert.equal(backup.path, join(backupDir, backupFileName(FIXED_NOW, 1)));
    assert.ok(existsSync(backup.path), 'the backup file must exist');
    assert.equal(backup.bytes, statSync(backup.path).size);
    assert.ok(backup.bytes > 0, 'an empty backup is not a backup');
    // One self-contained file, and the live directory is not littered either: the source
    // connection is opened and closed by the backup, leaving only `insighthub.db` behind.
    assert.deepEqual(readdirSync(backupDir), [basename(backup.path)]);
    assert.deepEqual(readdirSync(dataPath), [DATABASE_FILE_NAME]);

    // Destroy the live data directory: this is the disaster the drill is about.
    rmSync(dataPath, { recursive: true, force: true });
    assert.equal(existsSync(join(dataPath, DATABASE_FILE_NAME)), false);

    const restored = await restoreBackup({ backupPath: backup.path, dataPath });
    assert.equal(restored.path, join(dataPath, DATABASE_FILE_NAME));
    assert.ok(restored.bytes > 0);
    // The restore itself leaves exactly one file: no WAL, no journal, no temporary copy.
    assert.deepEqual(readdirSync(dataPath), [DATABASE_FILE_NAME]);
    assert.deepEqual(sidecars(dataPath), []);

    // Re-open through the production path and assert the text **character for character**.
    assert.equal(await readDocumentText(dataPath, 'doc-drill'), text);
  });

  it('takes an online-consistent snapshot while the store is still open', async () => {
    const dataPath = join(root, 'online-data');
    const backupDir = join(root, 'online-backups');
    const { store } = await openDocumentStore(dataPath);
    const doc = new Y.Doc();

    try {
      doc.getText('content').insert(0, 'before the snapshot');
      await store.append('doc-online', Y.encodeStateAsUpdate(doc));

      // The server is still running: the store is open and its WAL holds committed updates.
      const backup = await createLogicalBackup({ dataPath, backupDir, now: FIXED_NOW });

      // A write *after* the snapshot must not be in it.
      doc.getText('content').insert(doc.getText('content').length, ' — after the snapshot');
      await store.append('doc-online', Y.encodeStateAsUpdate(doc));

      const restoredPath = join(root, 'online-restored');
      await restoreBackup({ backupPath: backup.path, dataPath: restoredPath });
      assert.equal(await readDocumentText(restoredPath, 'doc-online'), 'before the snapshot');
    } finally {
      doc.destroy();
      await store.close();
    }
  });

  it('does not overwrite a backup taken in the same millisecond', async () => {
    const dataPath = join(root, 'collision-data');
    const backupDir = join(root, 'collision-backups');
    await seedDocument(dataPath, 'doc-collision', 'sequence keeps snapshots apart');

    const first = await createLogicalBackup({ dataPath, backupDir, now: FIXED_NOW });
    const second = await createLogicalBackup({ dataPath, backupDir, now: FIXED_NOW });

    assert.equal(basename(first.path), backupFileName(FIXED_NOW, 1));
    assert.equal(basename(second.path), backupFileName(FIXED_NOW, 2));
    assert.ok(existsSync(first.path) && existsSync(second.path));
    assert.deepEqual(
      listBackups(backupDir).map((entry) => entry.fileName),
      [basename(first.path), basename(second.path)],
    );
  });
});

/* ---------------------------------------------------------------- *
 * Retention
 * ---------------------------------------------------------------- */

describe('M4 B8 — seven-day retention', () => {
  it('deletes only backups older than seven days and never an unparseable file', async () => {
    const backupDir = join(root, 'prune');
    mkdirSync(backupDir);

    const now = new Date('2026-10-22T00:00:00.000Z');
    const old8 = join(backupDir, backupFileName(new Date(now.getTime() - 8 * DAY_MS), 1));
    const old30 = join(backupDir, backupFileName(new Date(now.getTime() - 30 * DAY_MS), 1));
    const exactly7 = join(backupDir, backupFileName(new Date(now.getTime() - 7 * DAY_MS), 1));
    const recent1 = join(backupDir, backupFileName(new Date(now.getTime() - 1 * DAY_MS), 1));
    const unrelated = join(backupDir, 'operator-notes.txt');

    for (const path of [old8, old30, exactly7, recent1, unrelated]) {
      writeFileSync(path, 'placeholder bytes; prune reads the name, not the content');
    }

    // The files were just created, so their `mtime` is *now*. A mtime-based policy would keep
    // all of them; only name-based age deletes the overdue ones. That is what makes this test
    // evidence for the documented choice.
    assert.ok(statSync(old8).mtimeMs > now.getTime(), 'mtime must be fresh while the name is old');

    const deleted = await pruneBackups({ backupDir, now });

    assert.deepEqual([...deleted].sort(), [old8, old30].sort());
    assert.deepEqual(
      readdirSync(backupDir).sort(),
      [basename(exactly7), basename(recent1), 'operator-notes.txt'].sort(),
      'exactly seven days old is still inside the window; a foreign file is never touched',
    );
    assert.deepEqual(
      listBackups(backupDir).map((entry) => entry.fileName),
      [basename(exactly7), basename(recent1)],
    );
  });

  it('never deletes the newest backup, even when every backup is overdue', async () => {
    const backupDir = join(root, 'prune-newest');
    mkdirSync(backupDir);
    const now = new Date('2026-10-22T00:00:00.000Z');
    const staleOldest = join(backupDir, backupFileName(new Date(now.getTime() - 30 * DAY_MS), 1));
    const staleNewest = join(backupDir, backupFileName(new Date(now.getTime() - 8 * DAY_MS), 1));
    writeFileSync(staleOldest, 'x');
    writeFileSync(staleNewest, 'x');

    const deleted = await pruneBackups({ backupDir, now });
    assert.deepEqual(deleted, [staleOldest]);
    assert.deepEqual(readdirSync(backupDir), [basename(staleNewest)]);

    // A single overdue backup is still the only recovery point: keep it.
    const singleDir = join(root, 'prune-single');
    mkdirSync(singleDir);
    const only = join(singleDir, backupFileName(new Date(now.getTime() - 30 * DAY_MS), 1));
    writeFileSync(only, 'x');
    assert.deepEqual(await pruneBackups({ backupDir: singleDir, now }), []);
    assert.ok(existsSync(only));
  });

  it('rejects a malformed retention window instead of quietly disabling retention', async () => {
    const backupDir = join(root, 'prune-invalid');
    await assert.rejects(
      () => pruneBackups({ backupDir, now: FIXED_NOW, retentionDays: -1 }),
      assertBackupError('INVALID_ARGUMENT'),
    );
    await assert.rejects(
      () => pruneBackups({ backupDir, now: FIXED_NOW, retentionDays: Number.NaN }),
      assertBackupError('INVALID_ARGUMENT'),
    );
  });
});

/* ---------------------------------------------------------------- *
 * Refusal and force
 * ---------------------------------------------------------------- */

describe('M4 B8 — restore refuses to destroy live data', () => {
  it('refuses to overwrite an existing database without force and modifies nothing', async () => {
    const livePath = join(root, 'refuse-live');
    const sourcePath = join(root, 'refuse-source');
    const backupDir = join(root, 'refuse-backups');

    await seedDocument(livePath, 'doc-refuse', 'live content that must survive');
    await seedDocument(sourcePath, 'doc-refuse', 'backup content that must not leak in');

    const targetFile = join(livePath, DATABASE_FILE_NAME);
    const bytesBefore = readFileSync(targetFile);

    const backup = await createLogicalBackup({
      dataPath: sourcePath,
      backupDir,
      now: FIXED_NOW,
    });

    await assert.rejects(
      () => restoreBackup({ backupPath: backup.path, dataPath: livePath }),
      assertBackupError('RESTORE_TARGET_EXISTS'),
    );

    assert.deepEqual(
      readFileSync(targetFile),
      bytesBefore,
      'a refused restore must not modify a single byte',
    );
    assert.deepEqual(readdirSync(livePath), [DATABASE_FILE_NAME], 'no temporary file was left');
    assert.equal(await readDocumentText(livePath, 'doc-refuse'), 'live content that must survive');
  });

  it('force replaces the database, removes stale sidecars and installs the backup bytes', async () => {
    const livePath = join(root, 'force-live');
    const sourcePath = join(root, 'force-source');
    const backupDir = join(root, 'force-backups');

    await seedDocument(livePath, 'doc-force', 'old live content');
    await seedDocument(sourcePath, 'doc-force', 'restored backup content');
    const backup = await createLogicalBackup({
      dataPath: sourcePath,
      backupDir,
      now: FIXED_NOW,
    });

    const targetFile = join(livePath, DATABASE_FILE_NAME);
    // A crash can leave these behind. They describe the old database and must not be reused
    // with the restored file.
    writeFileSync(`${targetFile}-wal`, 'stale wal');
    writeFileSync(`${targetFile}-shm`, 'stale shm');
    writeFileSync(`${targetFile}-journal`, 'stale journal');

    const restored = await restoreBackup({
      backupPath: backup.path,
      dataPath: livePath,
      force: true,
    });

    assert.ok(restored.bytes > 0);
    assert.deepEqual(
      readdirSync(livePath),
      [DATABASE_FILE_NAME],
      'no sidecar and no temporary copy may remain',
    );
    assert.deepEqual(sidecars(livePath), []);
    assert.deepEqual(
      readFileSync(targetFile),
      readFileSync(backup.path),
      'the installed file is exactly the backup file',
    );
    assert.equal(await readDocumentText(livePath, 'doc-force'), 'restored backup content');
  });

  it('rejects a missing or non-SQLite backup before touching the target', async () => {
    const dataPath = join(root, 'invalid-target');

    await assert.rejects(
      () => restoreBackup({ backupPath: join(root, 'does-not-exist.db'), dataPath }),
      assertBackupError('RESTORE_SOURCE_MISSING'),
    );

    const garbage = join(root, 'garbage.db');
    writeFileSync(garbage, 'this is not a SQLite database');
    await assert.rejects(
      () => restoreBackup({ backupPath: garbage, dataPath }),
      assertBackupError('RESTORE_SOURCE_INVALID'),
    );
    assert.equal(
      existsSync(dataPath),
      false,
      'a rejected restore must not create the target directory',
    );
  });
});

/* ---------------------------------------------------------------- *
 * Backup failure is typed
 * ---------------------------------------------------------------- */

describe('M4 B8 — a failed backup is a typed failure, never a silent success', () => {
  it('fails when there is no source database to back up', async () => {
    await assert.rejects(
      () =>
        createLogicalBackup({
          dataPath: join(root, 'missing-data'),
          backupDir: join(root, 'missing-backups'),
          now: FIXED_NOW,
        }),
      assertBackupError('BACKUP_SOURCE_MISSING'),
    );
  });

  it('fails when the backup path is a file instead of a directory', async () => {
    const dataPath = join(root, 'file-backup-data');
    await seedDocument(dataPath, 'doc-file-backup', 'content');
    const notADirectory = join(root, 'backups-is-a-file');
    writeFileSync(notADirectory, 'x');

    await assert.rejects(
      () => createLogicalBackup({ dataPath, backupDir: notADirectory, now: FIXED_NOW }),
      assertBackupError('BACKUP_DIR_UNAVAILABLE'),
    );
  });

  it('fails when the backup directory cannot be written to', async (t) => {
    const dataPath = join(root, 'readonly-data');
    await seedDocument(dataPath, 'doc-readonly-backup', 'content');

    const backupDir = join(root, 'readonly-backups');
    mkdirSync(backupDir);
    const restore = denyDirectoryWrites(backupDir);
    if (restore === null) {
      t.skip('this platform/environment could not make a directory read-only');
      return;
    }

    try {
      // Prove the restriction is real before asserting anything: an elevated/root process
      // bypasses it, and then the test would be measuring nothing.
      let restricted = false;
      try {
        writeFileSync(join(backupDir, '.write-probe'), 'x');
      } catch {
        restricted = true;
      }
      if (!restricted) {
        t.skip('the current user can write to the restricted directory (root/elevated)');
        return;
      }

      await assert.rejects(
        () => createLogicalBackup({ dataPath, backupDir, now: FIXED_NOW }),
        assertBackupError('BACKUP_CREATE_FAILED', 'BACKUP_DIR_UNAVAILABLE'),
      );
    } finally {
      restore();
      rmSync(join(backupDir, '.write-probe'), { force: true });
    }
  });
});
