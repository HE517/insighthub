/**
 * B13 — **deployed** functional smoke against the staging service, with a real Clerk
 * development session and the real OpenAI provider path.
 *
 * ## Why this is not part of the default suite
 *
 * It talks to `https://insighthub-staging-he517.onrender.com`, needs a Clerk **secret key** to
 * mint a short-lived Testing Token, and spends real OpenAI tokens. The default suite must stay
 * offline and deterministic; this script is opt-in.
 *
 * ## Credentials
 *
 * Read at runtime from the environment or from gitignored `.env.local` files (never committed,
 * never printed, never written to the report):
 *
 * ```text
 * CLERK_SECRET_KEY              # mints the Testing Token and deletes the test user afterwards
 * ```
 *
 * The publishable key is not needed here: the Testing Token is passed to the page as Clerk's
 * documented `?__clerk_testing_token=` query parameter, which is what the official Playwright
 * integration does under the hood.
 *
 * ## What the run proves
 *
 * Clerk sign-up (`+clerk_test` email, OTP 424242) → real Clerk session → `app_user` mapping
 * (`GET /api/session` returns an internal id) → `New document` self-service → owner authorization
 * → edit → real AI generation → Diff Preview → Accept → Reject → sign-out. No fixture seeding.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Browser } from '../browser/lib/chrome.mjs';
import { newPage } from '../browser/lib/cdp.mjs';

const BASE = process.env.INSIGHTHUB_B13_URL ?? 'https://insighthub-staging-he517.onrender.com/';
const EMAIL = `insighthub-b13-${Date.now()}+clerk_test@example.com`;
const PASSWORD = `Insighthub-b13-${Date.now()}-Passw0rd!`;
const CODE = '424242';
const CLERK_API = 'https://api.clerk.com/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadLocalEnv() {
  const files = [resolve('tests/deployed/.env.local'), resolve('apps/server/.env.local')];
  const values = {};
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m === null) continue;
      values[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...values, ...process.env };
}

const env = loadLocalEnv();
const secret = env.CLERK_SECRET_KEY ?? '';
if (secret === '') {
  console.error(
    '[b13] CLERK_SECRET_KEY is not available at runtime (env or .env.local). Nothing was sent.',
  );
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
};

async function clerkApi(path, init = {}) {
  const response = await fetch(`${CLERK_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* error bodies are not echoed */
  }
  return { status: response.status, body };
}

/** Mint a short-lived Testing Token: bypasses the bot challenge, never authentication itself. */
async function mintTestingToken() {
  const { status, body } = await clerkApi('/testing_tokens', { method: 'POST' });
  if (status !== 200 && status !== 201) {
    throw new Error(
      `testing token request failed (status ${status}, code ${body?.errors?.[0]?.code ?? 'unknown'})`,
    );
  }
  if (typeof body?.token !== 'string' || body.token === '') {
    throw new Error('testing token response carried no token');
  }
  return body.token;
}

const browser = await Browser.launch({ headed: false });
const page = await newPage(browser.connection);

async function state() {
  return page.evaluate(() => ({
    gate: document.querySelector('[data-testid="auth-gate"]')?.getAttribute('data-state') ?? null,
    signIn: Boolean(document.querySelector('[data-testid="clerk-sign-in"]')),
    signUp: Boolean(document.querySelector('[data-testid="clerk-sign-up"]')),
    inputs: [...document.querySelectorAll('input')].map((i) => ({ name: i.name, type: i.type })),
    buttons: [...document.querySelectorAll('button')]
      .map((b) => (b.innerText ?? '').trim())
      .filter(Boolean),
    active: document.querySelector('[data-testid="active-document"]')?.textContent ?? null,
    sessionFailed: document.querySelector('[data-testid="session-failed"]')?.textContent ?? null,
    aiOpen: Boolean(document.querySelector('[data-testid="ai-open"]')),
    newDocument: Boolean(document.querySelector('[data-testid="new-document"]')),
    role: document.body.innerText.match(/role: (\w+)/)?.[1] ?? null,
    panel: Boolean(document.querySelector('[data-testid="ai-panel"]')),
    proposal: Boolean(document.querySelector('[data-testid="ai-proposal"]')),
    diff: Boolean(document.querySelector('[data-testid="ai-diff"]')),
    bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
  }));
}

async function waitFor(predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await state();
    if (predicate(last)) return last;
    await sleep(700);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

async function fill(name, value) {
  await page.click(`input[name="${name}"]`);
  await page.insertText(value);
}

async function clickText(label) {
  const ok = await page.evaluate((text) => {
    const target = [...document.querySelectorAll('button, a, [role="button"]')].find(
      (el) => (el.innerText ?? '').trim() === text,
    );
    if (!target) return false;
    target.click();
    return true;
  }, label);
  if (!ok) throw new Error(`no clickable "${label}"`);
  await sleep(900);
}

try {
  const token = await mintTestingToken();
  console.log('[b13] testing token minted (not printed)');

  await page.goto(`${BASE}?__clerk_testing_token=${encodeURIComponent(token)}`, {
    timeoutMs: 120_000,
  });
  await page.waitForSelector('[data-testid="clerk-sign-in"]', { timeoutMs: 120_000 });
  await waitFor((s) => s.inputs.length > 0, 'clerk widget', 120_000);
  record('sign-in-screen', true, 'gate signed-out with Clerk widget');

  await clickText('Sign up');
  const signUp = await waitFor(
    (s) => s.signUp || s.inputs.some((i) => i.name === 'emailAddress'),
    'sign-up form',
  );
  if (signUp.inputs.some((i) => i.name === 'firstName')) await fill('firstName', 'InsightHub');
  if (signUp.inputs.some((i) => i.name === 'lastName')) await fill('lastName', 'B13');
  await fill('emailAddress', EMAIL);
  if (signUp.inputs.some((i) => i.name === 'password')) await fill('password', PASSWORD);
  await clickText('Continue');
  await sleep(2000);

  const needsCode = await state();
  if (needsCode.inputs.some((i) => i.name === 'code' || i.type === 'text')) {
    await fill('code', CODE).catch(async () => {
      await page.click('input[inputmode="numeric"]');
      await page.insertText(CODE);
    });
    await clickText('Continue');
    await sleep(2500);
  }

  const signedIn = await waitFor((s) => s.gate === null, 'signed-in app', 120_000);
  record('clerk-sign-up', signedIn.gate === null, 'real Clerk session established');
  const workspace = await waitFor(
    (s) => s.active !== null || s.sessionFailed !== null,
    'workspace',
    120_000,
  );
  record(
    'app-user-mapping',
    workspace.sessionFailed === null,
    `active=${workspace.active} role=${workspace.role}`,
  );

  // Server-side identity must be the internal mapping, not the Clerk sub.
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/session', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  record(
    'session-mapped-internal-id',
    session.status === 200 &&
      typeof session.body?.userId === 'string' &&
      session.body.userId.length > 0,
    `status=${session.status}`,
  );

  // Create the first document through the product's own entry.
  await page.click('[data-testid="ai-open"]');
  await waitFor((s) => s.panel, 'ai panel');
  await page.waitForSelector('[data-testid="new-document"]', { timeoutMs: 60_000 });
  const before = await state();
  await page.click('[data-testid="new-document"]');
  const created = await waitFor(
    (s) => s.active !== null && s.active !== before.active && s.panel === false,
    'document creation and switch',
    120_000,
  );
  record(
    'new-document-self-service',
    /^[0-9a-f-]{36}$/i.test(created.active ?? ''),
    `active=${created.active}`,
  );

  const editorReady = await waitFor(
    (s) => s.sessionFailed === null && s.role === 'owner',
    'owner editor',
    120_000,
  );
  record('owner-authorization', editorReady.role === 'owner', `role=${editorReady.role}`);

  await page.waitForSelector('.cm-content', { timeoutMs: 60_000 });
  await page.click('.cm-content');
  await page.insertText('B13 deployed smoke: the quick brown fox jumps over the lazy dog. ');
  await sleep(1500);

  // Real AI provider path.
  await page.click('[data-testid="ai-open"]');
  await waitFor((s) => s.panel, 'ai panel for generation');
  await page.waitForSelector('[data-testid="ai-instruction"]', { timeoutMs: 60_000 });
  await page.click('[data-testid="ai-instruction"]');
  await page.insertText('Replace the word "brown" with "red".');
  await page.click('[data-testid="ai-generate"]');
  const proposed = await waitFor((s) => s.proposal && s.diff, 'proposal and diff preview', 120_000);
  record(
    'real-ai-proposal-and-diff',
    proposed.proposal && proposed.diff,
    'provider returned a draft',
  );

  const beforeAccept = await page.evaluate(
    () => document.querySelector('.cm-content')?.innerText ?? '',
  );
  await page.click('[data-testid="ai-accept"]');
  const accepted = await waitFor((s) => s.proposal === false, 'accept applied', 60_000);
  const afterAccept = await page.evaluate(
    () => document.querySelector('.cm-content')?.innerText ?? '',
  );
  record(
    'ai-accept-applied',
    beforeAccept !== afterAccept,
    `changed=${beforeAccept !== afterAccept}`,
  );

  // Reject must write nothing.
  await page.click('[data-testid="ai-open"]').catch(() => {});
  await waitFor((s) => s.panel, 'panel for reject');
  await page.waitForSelector('[data-testid="ai-instruction"]', { timeoutMs: 60_000 });
  await page.click('[data-testid="ai-instruction"]');
  await page.insertText('Make the sentence shoutier.');
  await page.click('[data-testid="ai-generate"]');
  await waitFor((s) => s.proposal, 'second proposal', 120_000);
  const beforeReject = await page.evaluate(
    () => document.querySelector('.cm-content')?.innerText ?? '',
  );
  await page.click('[data-testid="ai-reject"]');
  await waitFor((s) => s.proposal === false, 'reject cleared');
  const afterReject = await page.evaluate(
    () => document.querySelector('.cm-content')?.innerText ?? '',
  );
  record('ai-reject-writes-nothing', beforeReject === afterReject, 'text unchanged');

  // Sign out.
  await page.click('[data-testid="sign-out"]');
  await waitFor((s) => s.gate === 'signed-out', 'signed-out gate', 90_000);
  record('sign-out', true, 'gate returned to signed-out');
} catch (error) {
  record('probe', false, error instanceof Error ? error.message : String(error));
} finally {
  // Delete the disposable Clerk test user, if we can identify it.
  try {
    const user = await page.evaluate(async () => {
      const clerk = globalThis.Clerk;
      return clerk?.user?.id ?? null;
    });
    if (typeof user === 'string' && user.startsWith('user_')) {
      const deleted = await clerkApi(`/users/${user}`, { method: 'DELETE' });
      console.log(`[b13] test user cleanup status=${deleted.status}`);
    } else {
      console.log('[b13] test user cleanup skipped (no user id on the page)');
    }
  } catch {
    console.log('[b13] test user cleanup failed (non-fatal)');
  }
  await page.close();
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(
  `\nSUMMARY checks=${results.length} pass=${results.length - failed.length} fail=${failed.length}`,
);
if (failed.length > 0) process.exitCode = 1;
