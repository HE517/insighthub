#!/usr/bin/env node
/**
 * A6 — unified-launcher, Origin and Simplified-Chinese error-state evidence.
 *
 * This runs the **shipped one-command launcher** (`scripts/dev.mjs`, the same entry `pnpm dev`
 * uses) on a non-default port pair, opens the URL it prints in a real Chromium, and records the
 * real HTTP responses behind the states the task names.
 *
 * Why a separate script and not a `run.mjs` scenario: `run.mjs` starts the two children directly,
 * so it cannot answer "does the shipped launcher accept its own browser's writes?".
 *
 * What is produced (all under `tests/browser/artifacts/ui-cn/`, because this task forbids editing
 * `docs/`):
 *
 * - `screenshots/*.png` — normal state, directory, created document, AI proposal/applied/stale,
 *   the `zzz` instruction error, HTTP-offline, WS-offline, reconnected, the foreign-Origin 403,
 *   the 401 session-invalid state and the viewer read-only state;
 * - `evidence.json` — every check, every recorded request/response, the launcher's printed URL;
 * - `EVIDENCE.md` — the same, readable;
 * - `dev-launcher.log`, `foreign-vite.log` — the real child output.
 *
 * No mocks: the browser, servers, session cookie, memberships and durable store are real. The
 * collaboration-socket offline path is the suite's existing documented control (close the socket
 * and point new ones at a refused port), so the client's own reconnect/backoff runs; the HTTP
 * offline path is CDP network emulation.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activeDocumentId,
  editorState,
  openApp,
  readApiCalls,
  readConnectionStatus,
  readEditorGate,
  readHistoryButtons,
  readUndoState,
  roleChipText,
  setOffline,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
  waitUntil,
} from './lib/app.mjs';
import { configureAuthzFixture } from './lib/authz-fixture.mjs';
import { newPage } from './lib/cdp.mjs';
import { Browser } from './lib/chrome.mjs';
import { waitForDurableText } from './lib/durable-store.mjs';
import { openWireSocket } from './lib/wire-socket.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const artifactRoot = path.join(here, 'artifacts', 'ui-cn');
const screenshotRoot = path.join(artifactRoot, 'screenshots');
const launcherLogPath = path.join(artifactRoot, 'dev-launcher.log');
const foreignViteLogPath = path.join(artifactRoot, 'foreign-vite.log');
const evidencePath = path.join(artifactRoot, 'evidence.json');
const reportPath = path.join(artifactRoot, 'EVIDENCE.md');

const WEB_PORT = Number(process.env.INSIGHTHUB_UI_CN_WEB_PORT ?? 5190);
const SERVER_PORT = Number(process.env.INSIGHTHUB_UI_CN_SERVER_PORT ?? 3012);
const FOREIGN_WEB_PORT = Number(process.env.INSIGHTHUB_UI_CN_FOREIGN_WEB_PORT ?? 5191);
const APP_URL = `http://127.0.0.1:${WEB_PORT}/`;
const APP_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const FOREIGN_URL = `http://127.0.0.1:${FOREIGN_WEB_PORT}/`;
const FOREIGN_ORIGIN = 'http://evil.example';
const BACKEND_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const evidence = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  launcher: {
    command: 'node scripts/dev.mjs',
    inputEnv: { INSIGHTHUB_WEB_PORT: String(WEB_PORT), PORT: String(SERVER_PORT) },
    derivedByLauncher: {
      CORS_ORIGIN: APP_ORIGIN,
      INSIGHTHUB_WEB_ORIGIN: APP_ORIGIN,
      INSIGHTHUB_SERVER_PORT: String(SERVER_PORT),
    },
    printedUrl: null,
    pid: null,
    logPath: path.relative(repoRoot, launcherLogPath),
  },
  foreignVite: { port: FOREIGN_WEB_PORT, url: FOREIGN_URL, pid: null },
  checks: [],
  http: [],
  browser: {},
  screenshots: [],
  notes: [],
};

let failures = 0;

function check(name, condition, observed) {
  const passed = Boolean(condition);
  evidence.checks.push({ name, pass: passed, observed });
  if (!passed) {
    failures += 1;
    const error = new Error(`CHECK FAILED: ${name} — observed ${JSON.stringify(observed)}`);
    error.check = name;
    throw error;
  }
  return observed;
}

function note(name, value) {
  evidence.notes.push({ name, value });
}

async function shot(page, name) {
  const file = path.join(screenshotRoot, `${name}.png`);
  await page.screenshot(file);
  const relative = path.relative(repoRoot, file);
  evidence.screenshots.push({ name, path: relative });
  return relative;
}

function tcpClosed(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const settle = (closed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(false));
    socket.once('error', () => settle(true));
  });
}

async function waitForTcpClosed(port, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpClosed(port)) return true;
    await sleep(150);
  }
  return false;
}

async function waitForHttp(url, { timeoutMs = 120_000, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return response.status;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error?.message ?? error);
    }
    await sleep(250);
  }
  throw new Error(`${label} did not answer within ${timeoutMs}ms: ${last}`);
}

async function killTree(child, label) {
  if (child === undefined || child === null || child.exitCode !== null) return 'already-exited';
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(10_000).then(() => true)]);
  if (timedOut) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return `${label}: had to SIGKILL`;
  }
  return `${label}: exited`;
}

async function http(label, method, route, { cookie, origin, body } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = cookie;
  if (origin !== undefined) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BACKEND_URL}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  const row = {
    label,
    method,
    route,
    origin: origin ?? null,
    withCookie: cookie !== undefined,
    status: response.status,
    contentType: response.headers.get('content-type'),
    accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    bodyText: text.slice(0, 1_000),
    json,
  };
  evidence.http.push(row);
  return row;
}

async function waitForPanelPhase(page, phase) {
  await waitUntil(
    async () =>
      (await page.evaluate(
        () => document.querySelector('[data-testid="ai-panel"]')?.getAttribute('data-phase'),
      )) === phase,
    { label: `the AI panel to reach data-phase="${phase}"`, timeoutMs: 25_000 },
  );
}

async function main() {
  await mkdir(screenshotRoot, { recursive: true });
  for (const [label, port] of [
    ['web', WEB_PORT],
    ['backend', SERVER_PORT],
    ['foreign web', FOREIGN_WEB_PORT],
  ]) {
    check(`the ${label} port ${port} is free before the run`, await tcpClosed(port), port);
  }

  const dataPath = mkdtempSync(path.join(tmpdir(), 'insighthub-ui-cn-'));
  evidence.launcher.dataPath = dataPath;
  note('data path', dataPath);

  const launcherLogFd = openSync(launcherLogPath, 'w');
  const launcher = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'dev.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      INSIGHTHUB_WEB_PORT: String(WEB_PORT),
      PORT: String(SERVER_PORT),
      INSIGHTHUB_DATA_PATH: dataPath,
      VITE_CLERK_PUBLISHABLE_KEY: '',
    },
    stdio: ['ignore', launcherLogFd, launcherLogFd],
    windowsHide: true,
  });
  closeSync(launcherLogFd);
  evidence.launcher.pid = launcher.pid;

  let foreignVite = null;
  let browser = null;
  let page = null;
  let pageForeign = null;
  let pageViewer = null;
  let pageEmpty = null;
  try {
    const webStatus = await waitForHttp(APP_URL, { label: 'the launcher web URL' });
    const healthStatus = await waitForHttp(`${BACKEND_URL}/health`, { label: 'the backend' });
    check('the launcher serves the web app', webStatus === 200, webStatus);
    check('the launcher backend is healthy', healthStatus === 200, healthStatus);

    const launcherLog = await readFile(launcherLogPath, 'utf8');
    const printedUrl = launcherLog.match(/open (http:\/\/[^\s]+)/)?.[1] ?? null;
    evidence.launcher.printedUrl = printedUrl;
    check(
      'the launcher prints the non-default URL that is actually opened',
      printedUrl === APP_ORIGIN,
      { printedUrl, expected: APP_ORIGIN, log: launcherLog.trim().split('\n').slice(0, 8) },
    );
    evidence.launcher.logExcerpt = launcherLog.trim().split('\n').slice(0, 12);

    const foreignLogFd = openSync(foreignViteLogPath, 'w');
    foreignVite = spawn(
      process.execPath,
      [path.join(repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js')],
      {
        cwd: path.join(repoRoot, 'apps', 'web'),
        env: {
          ...process.env,
          INSIGHTHUB_WEB_PORT: String(FOREIGN_WEB_PORT),
          INSIGHTHUB_SERVER_HOST: '127.0.0.1',
          INSIGHTHUB_SERVER_PORT: String(SERVER_PORT),
          VITE_CLERK_PUBLISHABLE_KEY: '',
        },
        stdio: ['ignore', foreignLogFd, foreignLogFd],
        windowsHide: true,
      },
    );
    closeSync(foreignLogFd);
    evidence.foreignVite.pid = foreignVite.pid;
    check('the foreign Vite origin starts', (await waitForHttp(FOREIGN_URL)) === 200, FOREIGN_URL);

    browser = await Browser.launch({ headed: false });
    evidence.browser = {
      product: browser.version.product,
      userAgent: browser.version.userAgent,
      executablePath: browser.executablePath,
    };
    page = await newPage(browser.connection);
    const fixture = configureAuthzFixture({ serverUrl: BACKEND_URL, dataPath: () => dataPath });

    /* ---------------- normal path on the printed URL ---------------- */
    const documentId = `a6-ui-cn-launcher-${Math.random().toString(36).slice(2, 8)}`;
    await openApp(page, { url: APP_URL, documentId, as: 'demo-ada' });
    const connected = await waitForConnectionStatus(page, 'connected', { timeoutMs: 45_000 });
    check('the demo session reaches WS connected on the launcher URL', connected === 'connected', connected);

    const identity = await page.evaluate(() => ({
      href: location.href,
      origin: location.origin,
      identityText: document.querySelector('[data-testid="session-identity"]')?.textContent?.trim() ?? null,
      claimed: window.__qa?.demoIdentity ?? null,
    }));
    evidence.browser.identity = identity;
    check('the page is the printed origin', identity.origin === APP_ORIGIN, identity);
    check(
      'the demo session was established by the real server',
      (identity.identityText ?? '').includes('Ada') && identity.claimed === 'demo-ada',
      identity,
    );

    await typeInEditor(page, 'launcher evidence seed');
    await waitForEditorText(page, (text) => text.includes('launcher evidence seed'), {
      label: 'the seed keystrokes in the editor',
    });

    await page.click('[data-testid="ai-open"]');
    await waitUntil(
      async () =>
        await page.evaluate(
          () =>
            document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ===
            'ready',
        ),
      { label: 'the directory to load on the launcher origin', timeoutMs: 30_000 },
    );
    await shot(page, '01-directory-ready');

    const callsBeforeCreate = (await readApiCalls(page)).length;
    await page.click('[data-testid="new-document"]');
    const createdId = await waitUntil(
      async () => {
        const current = await activeDocumentId(page);
        return current !== null && current !== documentId && UUID_PATTERN.test(current)
          ? current
          : false;
      },
      { label: 'the workspace to switch to the created document', timeoutMs: 40_000 },
    );
    await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
    const createCalls = (await readApiCalls(page))
      .slice(callsBeforeCreate)
      .filter((call) => call.method === 'POST' && call.path === '/api/documents');
    evidence.browser.create = { createdId, calls: createCalls };
    check(
      'a write on the launcher origin is a real 201, not 403 origin_not_allowed',
      createCalls.some((call) => call.status === 201),
      createCalls,
    );
    const refusedWrites = (await readApiCalls(page)).filter(
      (call) => (call.method === 'POST' || call.method === 'DELETE') && call.status === 403,
    );
    check(
      'no launcher-origin write was refused with 403 origin_not_allowed',
      refusedWrites.length === 0,
      refusedWrites,
    );

    const ownerGate = await waitUntil(
      async () => {
        const gate = await readEditorGate(page);
        return gate.roleTag === roleChipText('owner') ? gate : false;
      },
      { label: 'the created document role chip (角色：所有者)', timeoutMs: 40_000 },
    );
    evidence.browser.createdGate = {
      roleTag: ownerGate.roleTag,
      contentEditable: ownerGate.contentEditable,
      viewReadOnly: ownerGate.viewReadOnly,
    };
    check('the creator joins the new document as owner and can edit', ownerGate.contentEditable === 'true', ownerGate);
    await shot(page, '02-new-document-created');

    // A proposal / apply / stale sequence on the created document.
    if ((await page.evaluate(() => document.querySelector('[data-testid="ai-panel"]'))) === null) {
      await page.click('[data-testid="ai-open"]');
    }
    await waitForPanelPhase(page, 'idle');
    await typeInEditor(page, ' uppercase this');
    await page.click('[data-testid="ai-intent"][data-intent="uppercase"]');
    await page.click('[data-testid="ai-generate"]');
    await waitForPanelPhase(page, 'proposal');
    await shot(page, '03-ai-proposal-chinese');
    const proposal = await page.evaluate(() => ({
      status: document.querySelector('[data-testid="ai-status"]')?.textContent?.trim() ?? null,
      summary: document.querySelector('[data-testid="ai-summary"]')?.textContent?.trim() ?? null,
      accept: document.querySelector('[data-testid="ai-accept"]')?.textContent?.trim() ?? null,
      reject: document.querySelector('[data-testid="ai-reject"]')?.textContent?.trim() ?? null,
    }));
    evidence.browser.proposal = proposal;
    check(
      'the proposal controls are Chinese (接受 / 拒绝)',
      proposal.accept === '接受' && proposal.reject === '拒绝',
      proposal,
    );
    check('the proposal status is Chinese', (proposal.status ?? '').includes('建议已就绪'), proposal);

    await page.click('[data-testid="ai-accept"]');
    await waitForPanelPhase(page, 'applied');
    await shot(page, '04-ai-applied-chinese');

    // The document is uppercase now; `add-todo` still produces a real change.
    await page.click('[data-testid="ai-intent"][data-intent="add-todo"]');
    await page.click('[data-testid="ai-generate"]');
    await waitForPanelPhase(page, 'proposal');
    await typeInEditor(page, ' +local');
    await sleep(400);
    await page.click('[data-testid="ai-accept"]');
    await waitForPanelPhase(page, 'stale');
    const stale = await page.evaluate(() => ({
      reason: document.querySelector('[data-testid="ai-stale"]')?.getAttribute('data-reason') ?? null,
      text: document.querySelector('[data-testid="ai-stale"]')?.textContent?.trim() ?? null,
      status: document.querySelector('[data-testid="ai-status"]')?.textContent?.trim() ?? null,
    }));
    evidence.browser.stale = stale;
    check('the expired proposal carries the typed reason revision', stale.reason === 'revision', stale);
    check('the expired proposal copy is Chinese', (stale.text ?? '').includes('文档已在本地被修改'), stale);
    await shot(page, '05-ai-stale-chinese');

    /* ---------------- unknown local instruction: zzz ---------------- */
    await page.click('[data-testid="ai-instruction"]');
    await page.pressKey('a', { modifiers: 2 });
    await page.insertText('zzz');
    await page.click('[data-testid="ai-generate"]');
    await waitUntil(
      async () =>
        await page.evaluate(
          () => document.querySelector('[data-testid="ai-status"]')?.getAttribute('data-provider-error'),
        ),
      { label: 'the unknown-instruction provider error', timeoutMs: 20_000 },
    );
    const unknown = await page.evaluate(() => ({
      providerError: document.querySelector('[data-testid="ai-status"]')?.getAttribute('data-provider-error') ?? null,
      status: document.querySelector('[data-testid="ai-status"]')?.textContent?.trim() ?? null,
      empty: document.querySelector('[data-testid="ai-empty"]')?.textContent?.trim() ?? null,
      localHint: document.querySelector('[data-testid="ai-local-hint"]')?.textContent?.trim() ?? null,
      instruction: document.querySelector('[data-testid="ai-instruction"]')?.value ?? null,
    }));
    evidence.browser.unknownInstruction = unknown;
    check('zzz is the typed unknown-instruction failure', unknown.providerError === 'unknown-instruction', unknown);
    check('the provider title is Chinese', unknown.status === '本地提供器无法识别该指令。', unknown);
    check('the next-step copy is Chinese', (unknown.empty ?? '').includes('请调整指令后重新生成'), unknown);
    check('the preset hint is Chinese', unknown.localHint === '请选择预设操作', unknown);
    await shot(page, '06-ai-unknown-instruction');

    /* ---------------- HTTP offline (CDP network emulation) ---------------- */
    await page.send('Network.enable');
    await page.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await page.click('[data-testid="ai-directory-refresh"]');
    await waitUntil(
      async () =>
        await page.evaluate(
          () =>
            document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ===
              'error' &&
            document
              .querySelector('[data-testid="ai-directory-error"]')
              ?.getAttribute('data-directory-error') === 'network',
        ),
      { label: 'the directory network failure while the browser network is offline', timeoutMs: 30_000 },
    );
    const offlineHttp = await page.evaluate(() => ({
      kind: document.querySelector('[data-testid="ai-directory-error"]')?.getAttribute('data-directory-error') ?? null,
      title: document.querySelector('.ai-directory__error-title')?.textContent?.trim() ?? null,
      detail: document.querySelector('.ai-directory__error-detail')?.textContent?.trim() ?? null,
    }));
    evidence.browser.offlineHttp = offlineHttp;
    check('a real offline HTTP refresh is the typed network failure', offlineHttp.kind === 'network', offlineHttp);
    check('the offline directory copy is Chinese', (offlineHttp.title ?? '').includes('网络已断开'), offlineHttp);
    await shot(page, '07-http-offline');

    await page.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await page.click('[data-testid="ai-directory-refresh"]');
    await waitUntil(
      async () =>
        await page.evaluate(
          () => document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') === 'ready',
        ),
      { label: 'the directory to recover after the network returns', timeoutMs: 30_000 },
    );

    /* ---------------- WS offline (real connection refusal), reconnect, write ---------------- */
    await setOffline(page, true);
    const offlineStatus = await waitForConnectionStatus(page, ['offline', 'reconnecting', 'error'], {
      timeoutMs: 45_000,
    });
    evidence.browser.offlineStatus = offlineStatus;
    await shot(page, '08-ws-offline');
    check('the browser reports an offline/reconnecting state', offlineStatus !== 'connected', offlineStatus);

    await setOffline(page, false);
    const reconnected = await waitForConnectionStatus(page, 'connected', { timeoutMs: 60_000 });
    check('the client reconnects after the network returns', reconnected === 'connected', reconnected);
    await shot(page, '09-reconnected');

    await typeInEditor(page, ' after-reconnect');
    await waitForEditorText(page, (text) => text.includes('after-reconnect'), {
      label: 'the post-reconnect keystroke',
    });
    const durableAfterReconnect = await waitForDurableText(
      dataPath,
      createdId,
      (text) => text.includes('after-reconnect'),
      { timeoutMs: 45_000, label: 'the post-reconnect edit in durable storage' },
    );
    evidence.browser.reconnectWrite = {
      editorHasMarker: true,
      durableLength: durableAfterReconnect.length,
      durableHasMarker: durableAfterReconnect.includes('after-reconnect'),
    };
    check(
      'a write after reconnect reaches the server durable store',
      evidence.browser.reconnectWrite.durableHasMarker,
      evidence.browser.reconnectWrite,
    );

    /* ---------------- browser-visible foreign Origin ---------------- */
    pageForeign = await newPage(browser.connection);
    await openApp(pageForeign, { url: FOREIGN_URL, documentId: 'demo-document', as: 'demo-ada' });
    await waitUntil(
      async () => await pageForeign.evaluate(() => document.querySelector('[data-testid="ai-open"]') !== null),
      { label: 'the foreign-origin page shell', timeoutMs: 30_000 },
    );
    const foreignIdentity = await pageForeign.evaluate(() => ({
      origin: location.origin,
      identity: document.querySelector('[data-testid="session-identity"]')?.textContent?.trim() ?? null,
    }));
    evidence.browser.foreignOrigin = foreignIdentity;
    check(
      'the foreign page is a different origin',
      foreignIdentity.origin === `http://127.0.0.1:${FOREIGN_WEB_PORT}`,
      foreignIdentity,
    );

    const foreignCallsBefore = (await readApiCalls(pageForeign)).length;
    await pageForeign.click('[data-testid="ai-open"]');
    await waitUntil(
      async () =>
        await pageForeign.evaluate(
          () =>
            document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ===
            'ready',
        ),
      { label: 'the foreign-origin directory (safe GET is allowed, writes are not)', timeoutMs: 30_000 },
    );
    await pageForeign.click('[data-testid="new-document"]');
    await waitUntil(
      async () =>
        await pageForeign.evaluate(
          () => document.querySelector('[data-testid="new-document-error"]') !== null,
        ),
      { label: 'the foreign-origin creation refusal', timeoutMs: 20_000 },
    );
    const foreignError = await pageForeign.evaluate(() => ({
      kind: document.querySelector('[data-testid="new-document-error"]')?.getAttribute('data-create-error') ?? null,
      text: document.querySelector('[data-testid="new-document-error"]')?.textContent?.trim() ?? null,
      activeDocument: document.querySelector('[data-testid="active-document"]')?.textContent?.trim() ?? null,
    }));
    const foreignCalls = (await readApiCalls(pageForeign))
      .slice(foreignCallsBefore)
      .filter((call) => call.method === 'POST' && call.path === '/api/documents');
    evidence.browser.foreignOriginCreation = { error: foreignError, calls: foreignCalls };
    check(
      'the foreign-origin write is answered 403 in the browser',
      foreignCalls.some((call) => call.status === 403),
      foreignCalls,
    );
    check('the foreign-origin UI reports the typed 403 failure', foreignError.kind === 'http', foreignError);
    check('the foreign-origin UI copy is Chinese', (foreignError.text ?? '').includes('请求来源被拒绝'), foreignError);
    await shot(pageForeign, '10-foreign-origin-403');

    /* ---------------- session invalid: revoke the browser's own cookie ---------------- */
    const cookies = await page.getCookies({ urls: [APP_URL] });
    const sessionCookie = cookies.find((cookie) => cookie.name === 'insighthub_session') ?? null;
    check(
      'the browser holds the HttpOnly session cookie',
      sessionCookie !== null && sessionCookie.httpOnly === true,
      {
        present: sessionCookie !== null,
        httpOnly: sessionCookie?.httpOnly ?? null,
        sameSite: sessionCookie?.sameSite ?? null,
      },
    );
    const browserCookie = `insighthub_session=${sessionCookie.value}`;
    evidence.browser.sessionCookie = {
      name: sessionCookie.name,
      httpOnly: sessionCookie.httpOnly,
      tokenLength: sessionCookie.value.length,
    };

    const revoke = await http('revoke the browser session', 'DELETE', '/api/session', {
      cookie: browserCookie,
      origin: APP_ORIGIN,
    });
    check('DELETE /api/session answers 204 for the browser session', revoke.status === 204, revoke);
    const afterRevoke = await http('GET /api/session with the revoked cookie', 'GET', '/api/session', {
      cookie: browserCookie,
    });
    check('the revoked session is 401 on HTTP', afterRevoke.status === 401, afterRevoke);

    await page.click('[data-testid="ai-directory-refresh"]');
    await waitUntil(
      async () =>
        await page.evaluate(
          () =>
            document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ===
              'error' &&
            document.querySelector('[data-testid="ai-directory-error"]') !== null,
        ),
      { label: 'the unauthorized directory error state', timeoutMs: 30_000 },
    );
    const unauthorized = await page.evaluate(() => ({
      kind: document.querySelector('[data-testid="ai-directory-error"]')?.getAttribute('data-directory-error') ?? null,
      title: document.querySelector('.ai-directory__error-title')?.textContent?.trim() ?? null,
      detail: document.querySelector('.ai-directory__error-detail')?.textContent?.trim() ?? null,
    }));
    evidence.browser.sessionInvalid = unauthorized;
    check('the directory error is the typed unauthorized kind', unauthorized.kind === 'unauthorized', unauthorized);
    check('the 401 copy is Chinese', (unauthorized.title ?? '').includes('会话已失效'), unauthorized);
    await shot(page, '11-session-invalid-401');

    /* ---------------- viewer permission UI (Chinese read-only notice) ---------------- */
    pageViewer = await newPage(browser.connection);
    await openApp(pageViewer, { url: APP_URL, documentId: 'demo-document', as: 'demo-linus' });
    await waitForConnectionStatus(pageViewer, 'connected', { timeoutMs: 45_000 });
    const viewerGate = await waitUntil(
      async () => {
        const gate = await readEditorGate(pageViewer);
        return gate.roleTag === roleChipText('viewer') ? gate : false;
      },
      { label: 'the seeded viewer role chip', timeoutMs: 40_000 },
    );
    evidence.browser.viewer = {
      roleTag: viewerGate.roleTag,
      contentEditable: viewerGate.contentEditable,
      viewReadOnly: viewerGate.viewReadOnly,
      noticeTitle: viewerGate.notice.title,
      noticeDetail: viewerGate.notice.detail,
      undoAria: (await readHistoryButtons(pageViewer)).undo.ariaLabel,
      undoState: await readUndoState(pageViewer),
    };
    check('the seeded viewer is read-only in the browser', viewerGate.contentEditable === 'false', viewerGate);
    check('the viewer notice headline is Chinese', viewerGate.notice.title === '你的角色为只读', viewerGate.notice);
    check(
      'the viewer notice names the role in Chinese',
      (viewerGate.notice.detail ?? '').includes('只读查看者'),
      viewerGate.notice,
    );
    await shot(pageViewer, '12-viewer-readonly-chinese');

    /* ---------------- direct Origin / session / non-disclosure evidence ---------------- */
    const ada = await fixture.bootstrap('demo-ada');
    const adaCookie = ada.cookie;
    const evilWrite = await http('foreign-Origin write', 'POST', '/api/documents', {
      cookie: adaCookie,
      origin: FOREIGN_ORIGIN,
      body: {},
    });
    check('a foreign-Origin write is 403', evilWrite.status === 403, evilWrite);
    check(
      'the foreign-Origin body is exactly { error: "origin_not_allowed" }',
      evilWrite.json?.error === 'origin_not_allowed' && Object.keys(evilWrite.json).length === 1,
      evilWrite.json,
    );
    const allowedWrite = await http('allowed-Origin write', 'POST', '/api/documents', {
      cookie: adaCookie,
      origin: APP_ORIGIN,
      body: {},
    });
    check('the same write from the launcher origin is 201', allowedWrite.status === 201, allowedWrite);
    check(
      'the allowed write returns the server default title',
      allowedWrite.json?.title === 'Untitled document',
      allowedWrite.json,
    );
    const evilNoCookie = await http('foreign-Origin write without a session', 'POST', '/api/documents', {
      origin: FOREIGN_ORIGIN,
      body: {},
    });
    check('the Origin guard runs before authorization (403, not 401)', evilNoCookie.status === 403, evilNoCookie);

    const foreignSocket = await openWireSocket(WS_URL, {
      cookie: adaCookie,
      headers: { origin: FOREIGN_ORIGIN },
    });
    const foreignUpgrade = await foreignSocket.settled();
    // `settled()` resolves on the status; the body is read from the refused response afterwards
    // (see `WireSocket#upgrade`), so give that read its bounded window before inspecting it.
    let foreignUpgradeDetail = foreignSocket.upgrade;
    for (let attempt = 0; attempt < 40 && foreignUpgradeDetail.body === null; attempt += 1) {
      await sleep(50);
      foreignUpgradeDetail = foreignSocket.upgrade;
    }
    foreignSocket.close();
    evidence.browser.foreignUpgrade = {
      kind: foreignUpgrade.kind,
      status: foreignUpgrade.status,
      body: foreignUpgradeDetail.body,
      headers: foreignUpgradeDetail.headers,
    };
    check(
      'the WebSocket upgrade from a foreign Origin is refused 403 origin_not_allowed',
      foreignUpgrade.kind === 'refused' &&
        foreignUpgrade.status === 403 &&
        JSON.parse(foreignUpgradeDetail.body || '{}').error === 'origin_not_allowed',
      evidence.browser.foreignUpgrade,
    );
    const allowedSocket = await openWireSocket(WS_URL, {
      cookie: adaCookie,
      headers: { origin: APP_ORIGIN },
    });
    const allowedUpgrade = await allowedSocket.settled();
    allowedSocket.close();
    check('the WebSocket upgrade from the launcher origin opens', allowedUpgrade.kind === 'open', allowedUpgrade);

    const linus = await fixture.bootstrap('demo-linus');
    const privateDoc = await http('linus creates its own document', 'POST', '/api/documents', {
      cookie: linus.cookie,
      origin: APP_ORIGIN,
      body: { title: 'ui-cn private' },
    });
    check('the private document is created for linus', privateDoc.status === 201, privateDoc);
    const privateId = privateDoc.json?.documentId ?? 'ui-cn-private-missing';
    const notMember = await http('ada reads linus’s document', 'GET', `/api/documents/${privateId}`, {
      cookie: adaCookie,
    });
    const unknownDocument = await http(
      'ada reads an unknown document',
      'GET',
      `/api/documents/a6-ui-cn-unknown-${Date.now()}`,
      { cookie: adaCookie },
    );
    const own = await http('linus reads its own document', 'GET', `/api/documents/${privateId}`, {
      cookie: linus.cookie,
    });
    evidence.browser.nonDisclosure = { notMember, unknown: unknownDocument, own };
    check('a document outside the membership is 404', notMember.status === 404, notMember);
    check('an unknown document is 404', unknownDocument.status === 404, unknownDocument);
    check(
      'both 404 bodies are byte-identical (no existence leak)',
      notMember.bodyText === unknownDocument.bodyText &&
        notMember.contentType === unknownDocument.contentType,
      { notMember: notMember.bodyText, unknown: unknownDocument.bodyText },
    );
    check('the owner of the document still reads it as 200', own.status === 200, own);
    const anonymous = await http('no session reads a document', 'GET', `/api/documents/${privateId}`);
    check('no session is still 401 (session validation preserved)', anonymous.status === 401, anonymous);

    /* ---------------- empty directory (the real empty state) ---------------- */
    // The demo fixture seeds every identity with at least one membership, so the only honest way to
    // reach the product's empty state is to remove them for one identity, observe the browser, and
    // restore them. This is a real server list (`[]`), not a stubbed response.
    const linusMemberships = await fixture.membershipsOf('demo-linus');
    note('linus memberships before the empty-directory probe', linusMemberships);
    for (const membership of linusMemberships) {
      await fixture.revoke(membership.documentId, 'demo-linus');
    }
    pageEmpty = await newPage(browser.connection);
    await openApp(pageEmpty, { url: APP_URL, as: 'demo-linus' });
    await waitUntil(
      async () => await pageEmpty.evaluate(() => document.querySelector('[data-testid="ai-open"]') !== null),
      { label: 'the empty-directory page shell', timeoutMs: 30_000 },
    );
    await pageEmpty.click('[data-testid="ai-open"]');
    await waitUntil(
      async () =>
        await pageEmpty.evaluate(
          () =>
            document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ===
            'empty',
        ),
      { label: 'the empty directory to reach data-state=empty', timeoutMs: 30_000 },
    ).catch(async (error) => {
      const last = await pageEmpty.evaluate(() => ({
        directory: document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ?? null,
        errorKind: document.querySelector('[data-testid="ai-directory-error"]')?.getAttribute('data-directory-error') ?? null,
        errorText: document.querySelector('[data-testid="ai-directory-error"]')?.textContent?.trim() ?? null,
        empty: document.querySelector('[data-testid="ai-directory-empty"]')?.textContent?.trim() ?? null,
        items: document.querySelectorAll('[data-testid="ai-directory-item"]').length,
        connection: document.querySelector('[data-testid="connection-status"]')?.getAttribute('data-status') ?? null,
        identity: document.querySelector('[data-testid="session-identity"]')?.textContent?.trim() ?? null,
        sessionFailed: document.querySelector('[data-testid="session-failed"]')?.textContent?.trim() ?? null,
        apiCalls: (window.__qa?.apiCalls ?? []).slice(-8),
      }));
      throw new Error(`${error.message}; empty-directory state: ${JSON.stringify(last)}`);
    });
    const emptyDirectory = await pageEmpty.evaluate(() => ({
      state: document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ?? null,
      empty: document.querySelector('[data-testid="ai-directory-empty"]')?.textContent?.trim() ?? null,
      itemCount: document.querySelectorAll('[data-testid="ai-directory-item"]').length,
      errorPresent: document.querySelector('[data-testid="ai-directory-error"]') !== null,
    }));
    evidence.browser.emptyDirectory = emptyDirectory;
    check('the empty directory is a real empty server list, not an error', emptyDirectory.state === 'empty' && emptyDirectory.itemCount === 0 && emptyDirectory.errorPresent === false, emptyDirectory);
    check('the empty directory copy is Chinese (没有可阅读的文档)', emptyDirectory.empty === '没有可阅读的文档', emptyDirectory);
    await shot(pageEmpty, '13-directory-empty-chinese');
    for (const membership of linusMemberships) {
      await fixture.grant(membership.documentId, 'demo-linus', membership.role);
    }
    await pageEmpty.close();
    pageEmpty = null;

    evidence.browser.finalState = {
      connection: await readConnectionStatus(page),
      activeDocument: await activeDocumentId(page),
      editorLength: (await editorState(page)).text.length,
      apiCallCount: (await readApiCalls(page)).length,
    };
    evidence.finishedAt = new Date().toISOString();
    evidence.failures = failures;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await writeFile(reportPath, renderReport(), 'utf8');
    console.log(`\nui-cn evidence: ${evidence.checks.length} checks, ${failures} failure(s)`);
    console.log(`  page: ${APP_URL} (launcher pid ${launcher.pid})`);
    console.log(`  screenshots: ${path.relative(repoRoot, screenshotRoot)}`);
    console.log(`  evidence: ${path.relative(repoRoot, evidencePath)}`);
    console.log(`  report: ${path.relative(repoRoot, reportPath)}`);
    return 0;
  } catch (error) {
    evidence.finishedAt = new Date().toISOString();
    evidence.failures = failures;
    evidence.error = {
      message: error?.message ?? String(error),
      check: error?.check ?? null,
      stack: error?.stack ?? null,
      lastNote: evidence.notes.at(-1) ?? null,
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8').catch(() => {});
    await writeFile(reportPath, renderReport(), 'utf8').catch(() => {});
    console.error(`\nui-cn evidence FAILED: ${error?.message ?? error}`);
    if (error?.stack) console.error(error.stack);
    return 1;
  } finally {
    if (page !== null) await page.close().catch(() => {});
    if (pageForeign !== null) await pageForeign.close().catch(() => {});
    if (pageViewer !== null) await pageViewer.close().catch(() => {});
    if (pageEmpty !== null) await pageEmpty.close().catch(() => {});
    if (browser !== null) {
      evidence.browserClosed = await browser.close().catch((error) => ({ error: String(error) }));
    }
    if (foreignVite !== null) {
      evidence.foreignVite.stop = await killTree(foreignVite, 'foreign Vite');
    }
    evidence.launcher.stop = await killTree(launcher, 'launcher');
    evidence.portsReleased = {
      web: await waitForTcpClosed(WEB_PORT),
      backend: await waitForTcpClosed(SERVER_PORT),
      foreignWeb: await waitForTcpClosed(FOREIGN_WEB_PORT),
    };
    await rm(dataPath, { recursive: true, force: true }).catch(() => {});
    try {
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      await writeFile(reportPath, renderReport(), 'utf8');
    } catch {
      /* best effort */
    }
  }
}

function renderReport() {
  const lines = [];
  lines.push('# A6 UI-CN evidence — unified launcher, Origin guard, Chinese copy');
  lines.push('');
  lines.push(`- Started: ${evidence.startedAt}`);
  lines.push(`- Finished: ${evidence.finishedAt ?? '(not finished)'}`);
  lines.push(`- Checks: ${evidence.checks.length}, failures: ${evidence.failures ?? 'unknown'}`);
  lines.push(`- Launcher: \`${evidence.launcher.command}\` on web ${WEB_PORT} / backend ${SERVER_PORT}`);
  lines.push(`- Printed URL: ${evidence.launcher.printedUrl ?? '(not printed)'}`);
  lines.push(`- Page: ${APP_URL}`);
  lines.push(`- Foreign origin page: ${FOREIGN_URL} (not in the allow-list)`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| # | Check | Result | Observed |');
  lines.push('| --- | --- | --- | --- |');
  evidence.checks.forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | ${entry.name.replace(/\|/g, '\\|')} | ${entry.pass ? 'PASS' : 'FAIL'} | ` +
        `\`${JSON.stringify(entry.observed).replace(/\|/g, '\\|').slice(0, 300)}\` |`,
    );
  });
  lines.push('');
  lines.push('## Direct HTTP evidence');
  lines.push('');
  lines.push('| Request | Status | Origin | Body |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of evidence.http) {
    lines.push(
      `| ${row.method} ${row.route} | ${row.status} | ${row.origin ?? '(none)'} | ` +
        `\`${String(row.bodyText).replace(/\|/g, '\\|').slice(0, 220)}\` |`,
    );
  }
  lines.push('');
  lines.push('## Screenshots');
  lines.push('');
  for (const entry of evidence.screenshots) lines.push(`- [${entry.name}](${entry.path})`);
  lines.push('');
  lines.push('## Cleanup');
  lines.push('');
  lines.push(`- ports released: ${JSON.stringify(evidence.portsReleased ?? null)}`);
  lines.push(`- launcher: ${evidence.launcher.stop ?? '(not stopped)'}`);
  lines.push(`- foreign Vite: ${evidence.foreignVite.stop ?? '(not stopped)'}`);
  lines.push(`- browser: ${JSON.stringify(evidence.browserClosed ?? null)}`);
  lines.push('');
  if (evidence.error) {
    lines.push('## Failure');
    lines.push('');
    lines.push('```text');
    lines.push(evidence.error.stack ?? evidence.error.message);
    lines.push('```');
  }
  return `${lines.join('\n')}\n`;
}

const exitCode = await main();
process.exitCode = exitCode;
