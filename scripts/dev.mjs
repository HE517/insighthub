#!/usr/bin/env node
/**
 * One-command development launcher.
 *
 * The browser talks to Vite, and Vite proxies `/api` and `/ws` to the backend. The backend still
 * validates the browser's `Origin` against `CORS_ORIGIN` (dev must not disable CSRF checks), so
 * the front-end port, the proxy target and the allowed origin have to be derived from the same
 * values. Doing that here is what makes `pnpm dev` work on any free port instead of only 5173.
 *
 * Usage:
 *   pnpm dev
 *   $env:INSIGHTHUB_WEB_PORT=5180; $env:PORT=3002; pnpm dev
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Read the server's gitignored `.env.local` (AI keys/model). The server itself does not load
 * dotenv in development; without this the file is inert and the AI panel stays on the local
 * deterministic provider. Only keys the shell has not set are filled, so an explicit
 * `$env:AI_PROVIDER` still wins.
 */
function loadServerEnvFile() {
  const path = resolve('apps/server/.env.local');
  if (!existsSync(path)) return {};
  const parsed = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

const webHost = process.env.INSIGHTHUB_WEB_HOST ?? '127.0.0.1';
const webPort = Number(process.env.INSIGHTHUB_WEB_PORT ?? 5173);
const serverPort = Number(process.env.PORT ?? 3001);
const origin = `http://${webHost}:${webPort}`;
const fileEnv = loadServerEnvFile();
const resolvedAiProvider = process.env.AI_PROVIDER ?? fileEnv.AI_PROVIDER ?? 'disabled';

const env = {
  ...fileEnv,
  ...process.env,
  // Vite reads these two: its listen port and the proxy target.
  INSIGHTHUB_WEB_HOST: webHost,
  INSIGHTHUB_WEB_PORT: String(webPort),
  INSIGHTHUB_SERVER_PORT: String(serverPort),
  // The server reads these: where it listens, and which browser origin it trusts.
  PORT: String(serverPort),
  INSIGHTHUB_WEB_ORIGIN: origin,
  CORS_ORIGIN: origin,
  // A configured server-side provider needs the web client to call the endpoint instead of the
  // deterministic local provider. `stub` stays local: it is not a model.
  VITE_AI_PROVIDER:
    process.env.VITE_AI_PROVIDER ??
    (resolvedAiProvider === 'openai' || resolvedAiProvider === 'kimi' ? 'remote' : 'local'),
  // `apps/web/.env.local` may hold a real Clerk publishable key. The development server runs
  // `AUTH_MODE=demo` (no Clerk secret), so loading Clerk in the browser would show a sign-in
  // gate or a Clerk session the server cannot map, while every API call gets 401. Process env
  // wins over Vite's `.env` files; an explicit empty value keeps normal dev on the demo path.
  // Set INSIGHTHUB_DEV_CLERK=1 to restore the owner's Clerk key when the server is configured
  // for Clerk as well.
  VITE_CLERK_PUBLISHABLE_KEY:
    process.env.INSIGHTHUB_DEV_CLERK === '1' ? process.env.VITE_CLERK_PUBLISHABLE_KEY ?? '' : '',
};

console.log('');
console.log(`  InsightHub dev — open ${origin}`);
console.log(`  API/WS proxy → http://127.0.0.1:${serverPort}`);
console.log('');

const child = spawn('pnpm', ['-r', '--parallel', 'dev'], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const stop = (signal) => {
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
