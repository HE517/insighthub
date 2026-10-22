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

/** A positive integer override, or `undefined` so the module's frozen default applies. */
function readPositiveOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Default durable-storage directory, relative to the process working directory.
 *
 * A development default, not a production one: `docs/ARCHITECTURE.md` §7.10 fixes
 * `./.insighthub-data` for dev, and every test passes its own temporary directory
 * (`docs/DECISIONS.md` D-041) so a test run can never touch this path.
 */
export const DEFAULT_DATA_PATH = './.insighthub-data';

/**
 * Development default for `CORS_ORIGIN`, and the Vite dev-server origin.
 *
 * Exported so the production gate (`startup.ts`) refuses **the same string** this module would
 * otherwise apply: duplicating the literal there would let the two drift apart and quietly stop
 * detecting "production is still using the development default" (`docs/DECISIONS.md` D-082 D2).
 */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:5173';

/**
 * How a request becomes an identity (`docs/CONTRACTS.md` §18.6).
 *
 * `demo` is the development/test fixture (`POST /api/session/bootstrap`); `clerk` is the
 * production path and requires a real `SessionVerifier` (M4 B2). The default is `demo`
 * because every test and the browser suite run without Clerk, and a production process that
 * leaves it at the default **must refuse to start** (`startup.ts`).
 */
export type AuthMode = 'clerk' | 'demo';

/**
 * Parse `AUTH_MODE`.
 *
 * Unknown values resolve to `demo`, which is the safe direction: in production `startup.ts`
 * refuses that combination (and reports the unknown value as `AUTH_MODE_INVALID` from the raw
 * environment), and in development `demo` is the only mode that can run without Clerk. The
 * config layer stays permissive on purpose — the startup gate owns the fail-fast decision
 * (`docs/DECISIONS.md` D-082 §5, M4 B3).
 */
export function readAuthMode(value: string | undefined): AuthMode {
  return value === 'clerk' ? 'clerk' : 'demo';
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Origin allowed to call the HTTP API and open the WebSocket. */
  corsOrigin: string;
  /**
   * Bootstrap rate limit per client address, per minute (§18.7). Defaults to 10; the browser
   * suite raises it because one run legitimately opens far more pages from one address. This is
   * a configuration seam, not a test-only branch: the limiter itself is identical.
   *
   * Optional at the type level so a hand-built config (every test harness) keeps its shape;
   * absent means the 10/min default.
   */
  bootstrapRateLimitPerMinute?: number;
  /** WebSocket upgrade path. */
  wsPath: string;
  /**
   * Identity mode (§18.6). Optional at the type level for hand-built configs, in which case
   * it means `demo` — the same default `loadConfig` applies.
   */
  authMode?: AuthMode;
  /**
   * The process environment's `NODE_ENV`, if any.
   *
   * Carried on the config rather than read from `process.env` inside `createApp` so the
   * demo-bootstrap gate is a property of the configuration a test can state, not of the
   * ambient process a test happens to share.
   */
  nodeEnv?: string;
  /**
   * Directory holding the durable store (`docs/ARCHITECTURE.md` §7.10).
   *
   * Optional at the type level only so a hand-built config can describe a transport
   * without storage. `loadConfig` always sets it, which is what makes the *server*
   * durable by construction and leaves no memory-only path for it to fall back to
   * (`docs/DECISIONS.md` D-051).
   */
  dataPath?: string;
  /**
   * AI budget overrides (D-082 D3). Absent means the frozen numbers in `ai/limits.ts`
   * (20/hour, 100/day, 1 per user, 4 per server). They exist so the browser suite can raise
   * the budgets through the same code path production reads.
   */
  aiRateLimitPerHour?: number;
  aiRateLimitPerDay?: number;
  aiMaxConcurrentPerUser?: number;
  aiMaxConcurrentServer?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readPort(env.PORT, 3001),
    host: env.HOST ?? '127.0.0.1',
    corsOrigin: env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN,
    bootstrapRateLimitPerMinute: readPort(env.BOOTSTRAP_RATE_LIMIT_PER_MINUTE, 10),
    wsPath: env.WS_PATH ?? '/ws',
    ...(readPositiveOrUndefined(env.AI_RATE_LIMIT_PER_HOUR) === undefined
      ? {}
      : { aiRateLimitPerHour: readPositiveOrUndefined(env.AI_RATE_LIMIT_PER_HOUR) }),
    ...(readPositiveOrUndefined(env.AI_RATE_LIMIT_PER_DAY) === undefined
      ? {}
      : { aiRateLimitPerDay: readPositiveOrUndefined(env.AI_RATE_LIMIT_PER_DAY) }),
    ...(readPositiveOrUndefined(env.AI_MAX_CONCURRENT_PER_USER) === undefined
      ? {}
      : { aiMaxConcurrentPerUser: readPositiveOrUndefined(env.AI_MAX_CONCURRENT_PER_USER) }),
    ...(readPositiveOrUndefined(env.AI_MAX_CONCURRENT_SERVER) === undefined
      ? {}
      : { aiMaxConcurrentServer: readPositiveOrUndefined(env.AI_MAX_CONCURRENT_SERVER) }),
    authMode: readAuthMode(env.AUTH_MODE),
    ...(env.NODE_ENV === undefined ? {} : { nodeEnv: env.NODE_ENV }),
    // An empty value is treated as unset: `INSIGHTHUB_DATA_PATH=` in a shell should not
    // mean "store at the filesystem root".
    dataPath:
      env.INSIGHTHUB_DATA_PATH !== undefined && env.INSIGHTHUB_DATA_PATH.trim() !== ''
        ? env.INSIGHTHUB_DATA_PATH
        : DEFAULT_DATA_PATH,
  };
}
