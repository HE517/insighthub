/**
 * Spawn the **real entrypoint** and expect it to refuse to start.
 *
 * M4 B6's failure modes (`DATA_INTEGRITY_FAILED`, `DATA_SCHEMA_TOO_NEW`, `DATA_DISK_LOW`) are
 * only proven at the store layer by the in-process tests. What an operator actually sees is the
 * process exit status and the stderr line, so each one is also exercised by launching
 * `src/index.ts` in a child process — the same way `startup.test.ts` proves the B3 gate.
 *
 * The environment is deliberately **development/test**, not production: B3's production gate
 * would otherwise refuse first (for an unrelated reason) and the test would pass without ever
 * reaching persistence. `AUTH_MODE=demo` and `AI_PROVIDER=disabled` make the configuration gate
 * a no-op, so the refusal can only come from the store.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** `apps/server/`, derived from this helper's URL rather than the runner's working directory. */
const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The observable result of a child that was expected to exit instead of serving. */
export interface ServerRefusalRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the entrypoint against `dataPath`, with an otherwise inert configuration.
 *
 * A 20 s timeout is far more than a refusing startup needs; it exists so a regression that
 * actually listens fails the test loudly instead of hanging the suite.
 */
export function runServerExpectingRefusal(
  dataPath: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): ServerRefusalRun {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0',
    HOST: '127.0.0.1',
    AUTH_MODE: 'demo',
    AI_PROVIDER: 'disabled',
    INSIGHTHUB_DATA_PATH: dataPath,
    NO_COLOR: '1',
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_ROOT,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
