/**
 * M4 B8 — CLI contract for `backup-cli.ts` (`docs/DECISIONS.md` D-082 D2).
 *
 * The functions in `backup.ts` are tested directly in `backup.test.ts`; this file tests the
 * part an operator and a nightly job actually see: argument parsing, the environment
 * defaults, the exact `backup=<file> bytes=<n> pruned=<n>` line, and exit code 1 on failure.
 *
 * `runBackupCli` returns an exit code and takes injected IO, so "fails with exit 1" is an
 * assertion rather than a subprocess whose output has to be scraped. The command is still
 * exercised end to end — real SQLite, real files, real restore — because it calls the same
 * functions the cron job will.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as Y from 'yjs';

import { backupFileName, createLogicalBackup } from './backup.js';
import {
  BACKUP_CLI_HELP,
  readCliBackupDir,
  readCliDataPath,
  runBackupCli,
  type BackupCliIo,
} from './backup-cli.js';
import { DEFAULT_DATA_PATH } from '../config.js';
import { applyStoredDocument } from './hydrator.js';
import { openDocumentStore } from './open-store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insighthub-backup-cli-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

interface Collected {
  readonly io: BackupCliIo;
  readonly out: string[];
  readonly err: string[];
}

function collect(): Collected {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

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

describe('M4 B8 — backup CLI', () => {
  it('prints usage and exits 0 for --help', async () => {
    const captured = collect();
    assert.equal(await runBackupCli(['--help'], {}, captured.io), 0);
    assert.deepEqual(captured.err, []);
    assert.match(captured.out.join('\n'), /Usage:/);
    // The default is an operator contract, not an implementation detail: it must be stated.
    assert.match(captured.out.join('\n'), /<dataPath>\/\.\.\/backups/);
    assert.equal(captured.out.join('\n'), BACKUP_CLI_HELP);
  });

  it('uses the documented data and backup directory defaults', () => {
    assert.equal(readCliDataPath({}), resolve(DEFAULT_DATA_PATH));
    const dataPath = join(root, 'env-defaults');
    assert.equal(
      readCliBackupDir({ INSIGHTHUB_DATA_PATH: dataPath }, resolve(dataPath)),
      join(root, 'backups'),
    );
    assert.equal(
      readCliBackupDir({ INSIGHTHUB_DATA_PATH: dataPath, BACKUP_DIR: join(root, 'custom') }),
      join(root, 'custom'),
    );
  });

  it('creates a backup, prunes the overdue one and prints only path/byte/count fields', async () => {
    const dataPath = join(root, 'cli-data');
    const backupDir = join(root, 'cli-backups');
    await seedDocument(dataPath, 'doc-cli', 'cli backup content');
    mkdirSync(backupDir);

    const overdue = join(backupDir, backupFileName(new Date('2020-01-01T00:00:00.000Z'), 1));
    writeFileSync(overdue, 'overdue');

    const captured = collect();
    const code = await runBackupCli(
      ['backup'],
      { INSIGHTHUB_DATA_PATH: dataPath, BACKUP_DIR: backupDir },
      captured.io,
    );

    assert.equal(code, 0, `unexpected failure: ${captured.err.join('\n')}`);
    assert.deepEqual(captured.err, []);
    assert.equal(captured.out.length, 1);

    const line = captured.out[0] ?? '';
    const match = /^backup=(.+) bytes=(\d+) pruned=(\d+)$/.exec(line);
    assert.ok(match !== null, `unexpected output shape: ${line}`);
    if (match === null) return;

    const backupPath = match[1];
    assert.ok(backupPath.length > 0, 'the printed file path must not be empty');
    assert.ok(existsSync(backupPath), 'the printed file must exist');
    assert.ok(Number(match[2]) > 0, 'a backup must contain bytes');
    assert.equal(match[3], '1', 'the overdue backup must have been pruned');
    assert.equal(existsSync(overdue), false);
  });

  it('refuses to restore over a live database without --force, then succeeds with it', async () => {
    const livePath = join(root, 'cli-live');
    const sourcePath = join(root, 'cli-source');
    const backupDir = join(root, 'cli-restore-backups');
    await seedDocument(livePath, 'doc-cli-restore', 'live content survives a refusal');
    await seedDocument(sourcePath, 'doc-cli-restore', 'restored content wins with force');
    const backup = await createLogicalBackup({
      dataPath: sourcePath,
      backupDir,
      now: new Date('2026-10-22T00:00:00.000Z'),
    });

    const refused = collect();
    const refusedCode = await runBackupCli(
      ['restore', backup.path],
      { INSIGHTHUB_DATA_PATH: livePath },
      refused.io,
    );
    assert.equal(refusedCode, 1);
    assert.deepEqual(refused.out, []);
    assert.match(refused.err.join('\n'), /RESTORE_TARGET_EXISTS/);
    assert.equal(
      await readDocumentText(livePath, 'doc-cli-restore'),
      'live content survives a refusal',
    );

    const forced = collect();
    const forcedCode = await runBackupCli(
      ['restore', backup.path, '--force'],
      { INSIGHTHUB_DATA_PATH: livePath },
      forced.io,
    );
    assert.equal(forcedCode, 0, `unexpected failure: ${forced.err.join('\n')}`);
    assert.match(forced.out.join('\n'), /^restored=.+ bytes=\d+$/);
    assert.equal(
      await readDocumentText(livePath, 'doc-cli-restore'),
      'restored content wins with force',
    );
  });

  it('exits 1 for a missing command, an unknown command and malformed arguments', async () => {
    const noCommand = collect();
    assert.equal(await runBackupCli([], {}, noCommand.io), 1);
    assert.match(noCommand.err.join('\n'), /Usage:/);

    const unknown = collect();
    assert.equal(await runBackupCli(['frobnicate'], {}, unknown.io), 1);
    assert.match(unknown.err.join('\n'), /unknown command 'frobnicate'/);

    const missingFile = collect();
    assert.equal(await runBackupCli(['restore'], {}, missingFile.io), 1);
    assert.match(missingFile.err.join('\n'), /requires a backup file/);

    const twoFiles = collect();
    assert.equal(await runBackupCli(['restore', 'a.db', 'b.db'], {}, twoFiles.io), 1);
    assert.match(twoFiles.err.join('\n'), /exactly one backup file/);

    const unknownOption = collect();
    assert.equal(await runBackupCli(['restore', 'a.db', '--bogus'], {}, unknownOption.io), 1);
    assert.match(unknownOption.err.join('\n'), /unknown option '--bogus'/);

    const backupWithArgs = collect();
    assert.equal(await runBackupCli(['backup', 'extra'], {}, backupWithArgs.io), 1);
    assert.match(backupWithArgs.err.join('\n'), /'backup' takes no arguments/);
  });
});
