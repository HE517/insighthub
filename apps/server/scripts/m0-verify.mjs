/**
 * One-off M0 runtime verification. Not part of the product code.
 *
 * Proves, against a real backend process:
 *   1. the server starts from source (tsx)
 *   2. GET /health  -> 200 {"status":"ok"}
 *   3. GET /api/meta -> 200
 *   4. WS  /ws      -> a `connected` frame that the shared parser accepts
 *   5. Vite dev server serves the app shell, and /health is proxied through it
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { parseServerMessage } from '@insighthub/shared';
import { WebSocket } from 'ws';

const SERVER_DIR = fileURLToPath(new URL('../', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const VITE_BIN = fileURLToPath(
  new URL('../../web/node_modules/vite/bin/vite.js', import.meta.url),
);

const PORT = process.env.VERIFY_PORT ?? '3101';
const WEB_PORT = process.env.VERIFY_WEB_PORT ?? '5175';
const BASE = `http://127.0.0.1:${PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

async function waitFor(label, probe, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(400);
    }
  }
  throw new Error(`${label} did not become ready: ${lastError}`);
}

function startServer() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`  [server] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`  [server:err] ${chunk}`));
  return child;
}

function startWeb() {
  const child = spawn(
    process.execPath,
    [VITE_BIN, '--port', WEB_PORT, '--strictPort', '--host', '127.0.0.1'],
    { cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT } },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`  [web] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`  [web:err] ${chunk}`));
  return child;
}

const server = startServer();
const web = startWeb();

try {
  await waitFor('server /health', async () => {
    const response = await fetch(`${BASE}/health`);
    if (!response.ok) throw new Error(`status ${response.status}`);
  });
  record('server process started (tsx, src/index.ts)', true, `port ${PORT}`);

  const health = await fetch(`${BASE}/health`);
  const healthBody = await health.json();
  record(
    'GET /health returns 200 {"status":"ok"}',
    health.status === 200 && healthBody.status === 'ok',
    `${health.status} ${JSON.stringify(healthBody)}`,
  );

  const meta = await fetch(`${BASE}/api/meta`);
  const metaBody = await meta.json();
  record('GET /api/meta returns 200', meta.status === 200, JSON.stringify(metaBody));

  const notFound = await fetch(`${BASE}/definitely-not-a-route`);
  record('unknown path returns 404', notFound.status === 404, `status ${notFound.status}`);

  const message = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timer = setTimeout(() => reject(new Error('no frame within 8s')), 8000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(raw.toString());
      ws.close();
    });
    ws.once('error', reject);
  });
  const parsed = parseServerMessage(JSON.parse(message));
  record(
    'WS /ws sends a valid connected handshake',
    parsed.success && parsed.data?.type === 'connected',
    message,
  );

  await waitFor('vite dev server', async () => {
    const response = await fetch(WEB);
    if (!response.ok) throw new Error(`status ${response.status}`);
  });
  const page = await fetch(WEB);
  const html = await page.text();
  record(
    'vite dev server serves the app shell',
    page.status === 200 && html.includes('/src/main.tsx'),
    `${page.status}, ${html.length} bytes`,
  );

  const proxied = await fetch(`${WEB}/health`);
  const proxiedBody = await proxied.json();
  record(
    'vite proxies /health to the backend',
    proxied.status === 200 && proxiedBody.status === 'ok',
    `${proxied.status} ${JSON.stringify(proxiedBody)}`,
  );
} catch (error) {
  record('runtime verification', false, error instanceof Error ? error.message : String(error));
} finally {
  // Vite owns an esbuild child process; killing only the launcher can leave
  // that child holding the port and printing a confusing shutdown error.
  for (const child of [web, server]) {
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  }
  await delay(1500);
}

const failed = results.filter((item) => !item.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
