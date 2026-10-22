/**
 * The daily backup loop: it must take a backup when one is due, skip one when it is not, and
 * never turn a failure into a thrown error or a live handle.
 *
 * These tests use a real SQLite store in a temporary directory (`openDocumentStore`), because
 * the thing being scheduled is a real `VACUUM INTO`, not a mock of it. Each test gets its own
 * root directory: `data/` holds the live database and `backups/` is its sibling, which is the
 * CLI's default layout — cleaning up the root removes exactly this test's files.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import * as Y from 'yjs';

import { backupFileName, listBackups } from './backup.js';
import { startBackupScheduler, type BackupScheduler } from './backup-scheduler.js';
import { openDocumentStore } from './open-store.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

interface Fixture {
  readonly root: string;
  readonly dataPath: string;
  readonly backupDir: string;
}

async function fixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `insighthub-sched-${label}-`));
  const dataPath = path.join(root, 'data');
  await mkdir(dataPath, { recursive: true });

  const { store } = await openDocumentStore(dataPath);
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, 'scheduler seed');
    await store.append('doc-scheduler', Y.encodeStateAsUpdate(doc));
  } finally {
    await store.close();
    doc.destroy();
  }

  return { root, dataPath, backupDir: path.join(root, 'backups') };
}

const started: BackupScheduler[] = [];

function start(
  options: Omit<Parameters<typeof startBackupScheduler>[0], 'runOnStart'>,
): BackupScheduler {
  const scheduler = startBackupScheduler({ ...options, runOnStart: false });
  started.push(scheduler);
  return scheduler;
}

after(async () => {
  for (const scheduler of started) scheduler.stop();
});

describe('backup scheduler', () => {
  it('takes a backup when the directory is empty', async () => {
    const { root, dataPath, backupDir } = await fixture('empty');
    const scheduler = start({ dataPath, now: () => new Date('2026-10-22T03:00:00.000Z') });

    assert.equal(await scheduler.tick(), 'backed-up');
    assert.equal((await readdir(backupDir)).length, 1);
    await rm(root, { recursive: true, force: true });
  });

  it('skips when the newest backup is younger than the interval', async () => {
    const { root, dataPath } = await fixture('fresh');
    const at = new Date('2026-10-22T03:00:00.000Z');
    const scheduler = start({ dataPath, now: () => at });

    assert.equal(await scheduler.tick(), 'backed-up');
    assert.equal(await scheduler.tick(), 'skipped');
    await rm(root, { recursive: true, force: true });
  });

  it('catches up when the newest backup is stale, and prunes beyond retention', async () => {
    const { root, dataPath, backupDir } = await fixture('stale');
    await mkdir(backupDir, { recursive: true });
    // A placeholder from eight days ago: only its name matters to prune.
    const staleName = backupFileName(new Date(Date.now() - 8 * DAY_MS));
    await writeFile(path.join(backupDir, staleName), '');

    const now = new Date('2026-10-22T03:00:00.000Z');
    const scheduler = start({ dataPath, now: () => now });

    assert.equal(await scheduler.tick(), 'backed-up');
    const names = (await readdir(backupDir)).sort();
    assert.equal(names.length, 1, 'the eight-day-old placeholder must be pruned');
    assert.match(names[0], /^insighthub-2026-10-22/);
    await rm(root, { recursive: true, force: true });
  });

  it('reports a failure through onError instead of throwing', async () => {
    const { root, dataPath } = await fixture('fail');
    const errors: unknown[] = [];
    const scheduler = start({
      dataPath: path.join(dataPath, 'missing-subdir'),
      now: () => new Date('2026-10-22T03:00:00.000Z'),
      onError: (error) => errors.push(error),
    });

    assert.equal(await scheduler.tick(), 'failed');
    assert.equal(errors.length, 1);
    await rm(root, { recursive: true, force: true });
  });

  it('does nothing after stop()', async () => {
    const { root, dataPath, backupDir } = await fixture('stop');
    const scheduler = start({ dataPath, now: () => new Date('2026-10-22T03:00:00.000Z') });
    scheduler.stop();

    assert.equal(await scheduler.tick(), 'skipped');
    assert.equal(listBackups(backupDir).length, 0);
    await rm(root, { recursive: true, force: true });
  });
});
