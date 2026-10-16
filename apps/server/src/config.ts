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

export interface ServerConfig {
  port: number;
  host: string;
  /** Origin allowed to call the HTTP API and open the WebSocket. */
  corsOrigin: string;
  /** WebSocket upgrade path. */
  wsPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readPort(env.PORT, 3001),
    host: env.HOST ?? '127.0.0.1',
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
    wsPath: env.WS_PATH ?? '/ws',
  };
}
