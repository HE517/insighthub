/**
 * Server configuration.
 *
 * Every value is overridable through the environment so that tests and the
 * browser can agree on ports without editing code. Defaults are intentionally
 * development-friendly and non-secret: no credentials are read here.
 */

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

/**
 * Default durable-storage directory, relative to the process working directory.
 *
 * A development default, not a production one: `docs/ARCHITECTURE.md` §7.10 fixes
 * `./.insighthub-data` for dev, and every test passes its own temporary directory
 * (`docs/DECISIONS.md` D-041) so a test run can never touch this path.
 */
export const DEFAULT_DATA_PATH = './.insighthub-data';

export interface ServerConfig {
  port: number;
  host: string;
  /** Origin allowed to call the HTTP API and open the WebSocket. */
  corsOrigin: string;
  /** WebSocket upgrade path. */
  wsPath: string;
  /**
   * Directory holding the durable store (`docs/ARCHITECTURE.md` §7.10).
   *
   * Optional at the type level only so a hand-built config can describe a transport
   * without storage. `loadConfig` always sets it, which is what makes the *server*
   * durable by construction and leaves no memory-only path for it to fall back to
   * (`docs/DECISIONS.md` D-051).
   */
  dataPath?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readPort(env.PORT, 3001),
    host: env.HOST ?? '127.0.0.1',
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
    wsPath: env.WS_PATH ?? '/ws',
    // An empty value is treated as unset: `INSIGHTHUB_DATA_PATH=` in a shell should not
    // mean "store at the filesystem root".
    dataPath:
      env.INSIGHTHUB_DATA_PATH !== undefined && env.INSIGHTHUB_DATA_PATH.trim() !== ''
        ? env.INSIGHTHUB_DATA_PATH
        : DEFAULT_DATA_PATH,
  };
}
