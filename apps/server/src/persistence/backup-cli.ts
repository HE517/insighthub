/**
 * Operator entry point for the M4 B8 backup and restore drill (`docs/DECISIONS.md` D-082 D2).
 *
 * ```bash
 * # from apps/server
 * pnpm exec tsx src/persistence/backup-cli.ts backup
 * pnpm exec tsx src/persistence/backup-cli.ts restore /var/data/backups/insighthub-….db --force
 * pnpm exec tsx src/persistence/backup-cli.ts --help
 * ```
 *
 * ## Why this is a thin shell over `backup.ts`
 *
 * The logic lives in {@link createLogicalBackup}, {@link pruneBackups} and
 * {@link restoreBackup} so it is testable without a process, and the nightly job and the drill
 * run exactly the code the tests exercise. This file only resolves the environment, parses the
 * two commands and maps failures to an exit code.
 *
 * ## What it may print
 *
 * File paths, byte counts and counts only. Document content never reaches stdout/stderr, and
 * a failure prints the stable error code plus the operator hint — no SQL, no stack trace, no
 * data (`docs/DECISIONS.md` D-044's logging rule).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DATA_PATH } from '../config.js';
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  createLogicalBackup,
  isBackupError,
  pruneBackups,
  restoreBackup,
} from './backup.js';

/** Where the CLI writes. Injectable so a test can assert the contract without a subprocess. */
export interface BackupCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const DEFAULT_IO: BackupCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/**
 * Usage text.
 *
 * The default backup directory is stated explicitly because it is the one decision an
 * operator must know before running this on Render: `<dataPath>/../backups`, i.e. a **sibling**
 * of the data directory. Keeping it outside the directory it protects is deliberate — deleting
 * or losing the data directory must not delete the recovery copies with it.
 */
export const BACKUP_CLI_HELP = `InsightHub logical backup / restore (SQLite VACUUM INTO)

Usage:
  backup-cli.ts backup
  backup-cli.ts restore <backup-file> [--force]
  backup-cli.ts --help

Commands:
  backup    Create one consistent snapshot of insighthub.db and prune backups older than
            ${DEFAULT_BACKUP_RETENTION_DAYS} days. Prints: backup=<file> bytes=<n> pruned=<n>
  restore   Replace insighthub.db with <backup-file>. Refuses when a database (or one of its
            WAL/journal files) already exists unless --force is passed.
            Prints: restored=<file> bytes=<n>

Environment:
  INSIGHTHUB_DATA_PATH   Directory holding insighthub.db (default: ${DEFAULT_DATA_PATH})
  BACKUP_DIR             Backup directory (default: <dataPath>/../backups)

Notes:
  - Stop the server before restore. Nothing in this tool can prevent a running server from
    reopening the file it already has open.
  - Backups are taken online with VACUUM INTO; the server may keep running during "backup".
  - Exit code is 0 on success and 1 on any failure. Document content is never printed.`;

/**
 * Resolve the data directory with the same precedence `loadConfig` applies.
 *
 * The default comes from `config.ts` rather than a second literal: a backup tool that silently
 * backs up a different default path than the server writes to is worse than no default.
 */
export function readCliDataPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INSIGHTHUB_DATA_PATH?.trim();
  return resolve(raw !== undefined && raw !== '' ? raw : DEFAULT_DATA_PATH);
}

/**
 * Resolve the backup directory: `BACKUP_DIR` when set, otherwise the sibling `backups`
 * directory of the resolved data path.
 */
export function readCliBackupDir(
  env: NodeJS.ProcessEnv = process.env,
  dataPath: string = readCliDataPath(env),
): string {
  const raw = env.BACKUP_DIR?.trim();
  return raw !== undefined && raw !== '' ? resolve(raw) : resolve(dataPath, '..', 'backups');
}

/**
 * Run one CLI invocation and return its exit code.
 *
 * Returning a number (rather than calling `process.exit`) keeps the function testable and makes
 * "fails with exit 1" an assertion instead of a mock.
 */
export async function runBackupCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: BackupCliIo = DEFAULT_IO,
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    io.err(BACKUP_CLI_HELP);
    return 1;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(BACKUP_CLI_HELP);
    return 0;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(BACKUP_CLI_HELP);
    return 0;
  }

  switch (command) {
    case 'backup':
      return await runBackup(rest, env, io);
    case 'restore':
      return await runRestore(rest, env, io);
    default:
      io.err(`error: unknown command '${command}'`);
      io.err(BACKUP_CLI_HELP);
      return 1;
  }
}

/** `backup`: create one snapshot, then apply the seven-day retention. */
async function runBackup(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: BackupCliIo,
): Promise<number> {
  if (args.length > 0) {
    io.err(`error: 'backup' takes no arguments (got ${args.join(' ')})`);
    return 1;
  }

  const dataPath = readCliDataPath(env);
  const backupDir = readCliBackupDir(env, dataPath);
  const now = new Date();

  try {
    const backup = await createLogicalBackup({ dataPath, backupDir, now });
    const pruned = await pruneBackups({
      backupDir,
      now,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
    });
    io.out(`backup=${backup.path} bytes=${backup.bytes} pruned=${pruned.length}`);
    return 0;
  } catch (error) {
    return reportFailure(error, io);
  }
}

/** `restore <file> [--force]`: install a validated backup over `insighthub.db`. */
async function runRestore(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: BackupCliIo,
): Promise<number> {
  let backupPath: string | null = null;
  let force = false;

  for (const arg of args) {
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg.startsWith('-')) {
      io.err(`error: unknown option '${arg}'`);
      return 1;
    }
    if (backupPath !== null) {
      io.err('error: restore takes exactly one backup file');
      return 1;
    }
    backupPath = arg;
  }

  if (backupPath === null) {
    io.err('error: restore requires a backup file');
    io.err(BACKUP_CLI_HELP);
    return 1;
  }

  try {
    const restored = await restoreBackup({
      backupPath,
      dataPath: readCliDataPath(env),
      force,
    });
    io.out(`restored=${restored.path} bytes=${restored.bytes}`);
    return 0;
  } catch (error) {
    return reportFailure(error, io);
  }
}

/**
 * Print a failure without leaking content, and return exit code 1.
 *
 * The typed `code` goes first so the line can be grepped by a cron wrapper; the hint is the
 * part that tells an operator what to do next.
 */
function reportFailure(error: unknown, io: BackupCliIo): number {
  if (isBackupError(error)) {
    io.err(`error: ${error.code}: ${error.message}`);
    io.err(`hint: ${error.hint}`);
    return 1;
  }
  io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

/* ---------------------------------------------------------------- *
 * Process entry point
 * ---------------------------------------------------------------- */

/**
 * Run when this file is the process entry point, not when a test imports it.
 *
 * The path comparison is done on resolved file-system paths (`import.meta.url` is a URL) so a
 * Windows drive path and a `file://` URL are not compared as strings.
 */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBackupCli(process.argv.slice(2));
}
