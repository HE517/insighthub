/**
 * Daily logical backups, scheduled in-process.
 *
 * ## Why in-process rather than a Render Cron Job
 *
 * D-082 D2 asks for a nightly SQLite logical backup with seven-day retention. A Render cron
 * service cannot reach the web service's persistent disk (a disk is mounted by exactly one
 * service), so an external scheduler would either need a second disk copy or an HTTP endpoint
 * that triggers backups — both worse than the simple thing: run the same `VACUUM INTO` backup
 * from the process that already owns the database, once a day.
 *
 * ## Failure behaviour
 *
 * A failed backup never throws into the server: it is reported through `onError` (the caller
 * logs it) and retried at the next tick. A backup that is merely *old* is not a failed backup;
 * the next start catches up immediately (`tick` runs on start when the newest file is stale),
 * which is what makes a restart after downtime heal the schedule.
 *
 * The timer is `unref()`ed: it must never keep the process (or a test) alive. That is the
 * lesson from TOOLING-P2, applied here by construction rather than by a test that would hang
 * if it were wrong.
 */
import path from 'node:path';

import { createLogicalBackup, listBackups, pruneBackups } from './backup.js';

/** One day, the D-082 D2 cadence. */
export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** The scheduler wakes at most hourly so a 24 h target is not missed by process start drift. */
const MAX_TICK_MS = 60 * 60 * 1_000;

export interface BackupSchedulerOptions {
  /** Directory holding the live `insighthub.db` (`INSIGHTHUB_DATA_PATH`). */
  readonly dataPath: string;
  /** Where snapshots go. Defaults to `<dataPath>/../backups`, matching the CLI. */
  readonly backupDir?: string;
  /** How old the newest backup may be before another is taken. Defaults to 24 h. */
  readonly intervalMs?: number;
  /** Passed to `pruneBackups`; defaults to the frozen seven days. */
  readonly retentionDays?: number;
  /** Injected clock, so a test can prove "stale" without waiting a day. */
  readonly now?: () => Date;
  /** Receives failures. The scheduler never throws. */
  readonly onError?: (error: unknown) => void;
  /**
   * Run the catch-up tick immediately (default). Tests that drive `tick()` themselves pass
   * `false` so a background tick cannot race the assertion.
   */
  readonly runOnStart?: boolean;
}

export interface BackupScheduler {
  /** Stop the timer. A backup already running is allowed to finish. */
  stop(): void;
  /**
   * Apply the "is a backup due?" rule once, now.
   *
   * Returns what happened so a caller (or a test) can tell "fresh, skipped" from "taken"
   * without inspecting the clock.
   */
  tick(): Promise<'skipped' | 'backed-up' | 'failed'>;
}

/**
 * Start the daily backup loop.
 *
 * The first tick runs immediately, on the promise that it is a no-op when a fresh backup
 * already exists — which is what makes a restart after downtime catch up without duplicating
 * a backup taken an hour ago.
 */
export function startBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const backupDir = options.backupDir ?? path.join(options.dataPath, '..', 'backups');
  const intervalMs = positiveOr(options.intervalMs, DEFAULT_BACKUP_INTERVAL_MS, 'intervalMs');
  const retentionDays = positiveOr(options.retentionDays, 7, 'retentionDays');
  const now = options.now ?? ((): Date => new Date());
  const onError = options.onError ?? ((): void => {});

  let running = false;
  let stopped = false;

  /** Newest backup timestamp, or `null` when the directory is empty/unreadable. */
  function newestBackupAt(): number | null {
    try {
      const files = listBackups(backupDir);
      if (files.length === 0) return null;
      return Math.max(...files.map((file) => file.createdAt.getTime()));
    } catch {
      // An unreadable/missing directory is "no backup": the next tick will try to create one.
      return null;
    }
  }

  async function tick(): Promise<'skipped' | 'backed-up' | 'failed'> {
    if (stopped) return 'skipped';
    const at = now();
    const newest = newestBackupAt();
    if (newest !== null && at.getTime() - newest < intervalMs) return 'skipped';
    if (running) return 'skipped';

    running = true;
    try {
      await createLogicalBackup({ dataPath: options.dataPath, backupDir, now: at });
      await pruneBackups({ backupDir, now: at, retentionDays });
      return 'backed-up';
    } catch (error: unknown) {
      onError(error);
      return 'failed';
    } finally {
      running = false;
    }
  }

  const timer = setInterval(
    () => {
      void tick();
    },
    Math.min(intervalMs, MAX_TICK_MS),
  );
  timer.unref();

  // Catch up immediately: a fresh backup makes this a cheap folder listing.
  if (options.runOnStart !== false) void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

function positiveOr(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`backup scheduler: ${name} must be a positive integer`);
  }
  return value;
}
