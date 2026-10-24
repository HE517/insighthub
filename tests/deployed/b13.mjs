/**
 * B13 — **deployed** functional smoke against the staging service, with a real Clerk
 * development session and the real OpenAI provider path.
 *
 * ## Why Playwright here
 *
 * Clerk's bot protection (Turnstile) blocks headless sign-ups. The official way through it is a
 * Clerk **Testing Token**, which `@clerk/testing` injects by intercepting the Clerk Frontend API
 * requests and marking the captcha as bypassed. That is the mechanism this script uses; the
 * token itself is minted at runtime and never printed.
 *
 * `playwright-core` drives the Chrome already installed on this machine (no browser download).
 *
 * ## Credentials (runtime only, gitignored, never printed)
 *
 * `CLERK_SECRET_KEY` — mints the Testing Token and deletes the disposable test user afterwards.
 * `VITE_CLERK_PUBLISHABLE_KEY` — already present in `apps/web/.env.local`; used by `clerkSetup`.
 *
 * ## What the run proves
 *
 * Clerk sign-up (`+clerk_test` email, OTP 424242) → real Clerk session → `app_user` mapping →
 * `New document` self-service → owner authorization → edit → real AI generation → Diff Preview →
 * Accept → Reject → sign-out. No fixture seeds a document or a membership.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { clerkSetup, setupClerkTestingToken } from '@clerk/testing/playwright';
import { chromium } from 'playwright-core';

import { findBrowser } from '../browser/lib/chrome.mjs';

const BASE = process.env.INSIGHTHUB_B13_URL ?? 'https://insighthub-staging-he517.onrender.com/';
const EMAIL = `insighthub-b13-${Date.now()}+clerk_test@example.com`;
const PASSWORD = `Insighthub-b13-${Date.now()}-Passw0rd!`;
const CODE = '424242';

function loadLocalEnv() {
  const files = [
    resolve('tests/deployed/.env.local'),
    resolve('apps/server/.env.local'),
    resolve('apps/web/.env.local'),
  ];
  const values = {};
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (match === null) continue;
      values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...values, ...process.env };
}

const env = loadLocalEnv();
const secret = env.CLERK_SECRET_KEY ?? '';
const publishable = env.VITE_CLERK_PUBLISHABLE_KEY ?? env.CLERK_PUBLISHABLE_KEY ?? '';
if (secret === '' || publishable === '') {
  console.error(
    '[b13] CLERK_SECRET_KEY and VITE_CLERK_PUBLISHABLE_KEY must be available at runtime (env or .env.local). Nothing was sent.',
  );
  process.exit(2);
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
};

async function deleteTestUser(userId) {
  const response = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  return response.status;
}

/** All the DOM facts the checks care about, read in one round trip. */
async function snapshot(page) {
  return page.evaluate(() => ({
    gate: document.querySelector('[data-testid="auth-gate"]')?.getAttribute('data-state') ?? null,
    signIn: Boolean(document.querySelector('[data-testid="clerk-sign-in"]')),
    inputs: [...document.querySelectorAll('input')].map((i) => ({ name: i.name, type: i.type })),
    active: document.querySelector('[data-testid="active-document"]')?.textContent ?? null,
    sessionFailed: document.querySelector('[data-testid="session-failed"]')?.textContent ?? null,
    role: document.body.innerText.match(/role: (\w+)/)?.[1] ?? null,
    panel: Boolean(document.querySelector('[data-testid="ai-panel"]')),
    proposal: Boolean(document.querySelector('[data-testid="ai-proposal"]')),
    diff: Boolean(document.querySelector('[data-testid="ai-diff"]')),
    aiStatus: document.querySelector('[data-testid="ai-status"]')?.textContent ?? null,
    aiEmpty: document.querySelector('[data-testid="ai-empty"]')?.textContent ?? null,
    text: document.querySelector('.cm-content')?.innerText ?? '',
    bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
  }));
}

async function waitFor(page, predicate, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await snapshot(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

async function clickText(page, label) {
  // Clerk renders hidden duplicate labels; only a *visible* element is clickable.
  const button = page.getByRole('button', { name: label, exact: true }).filter({ visible: true });
  const locator =
    (await button.count()) > 0
      ? button.first()
      : page.getByText(label, { exact: true }).filter({ visible: true }).first();
  await locator.waitFor({ state: 'visible', timeout: 60_000 });
  await locator.click();
  await page.waitForTimeout(600);
}

process.env.CLERK_SECRET_KEY = secret;
process.env.CLERK_PUBLISHABLE_KEY = publishable;
await clerkSetup();

const browser = await chromium.launch({
  executablePath: findBrowser(process.env.INSIGHTHUB_BROWSER),
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await setupClerkTestingToken({ page });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('[data-testid="clerk-sign-in"]', { timeout: 120_000 });
  await page.waitForSelector('[data-testid="clerk-sign-in"] input', { timeout: 120_000 });
  record('sign-in-screen', true, 'gate signed-out with Clerk widget');

  await clickText(page, 'Sign up');
  await page.waitForSelector('input[name="emailAddress"]', { timeout: 60_000 });

  if ((await page.locator('input[name="firstName"]').count()) > 0) {
    await page.fill('input[name="firstName"]', 'InsightHub');
  }
  if ((await page.locator('input[name="lastName"]').count()) > 0) {
    await page.fill('input[name="lastName"]', 'B13');
  }
  await page.fill('input[name="emailAddress"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await clickText(page, 'Continue');

  /*
   * With a `+clerk_test` address and a password, Clerk signs in without a code. If a future
   * instance does ask for one, the test code is 424242 — but only handle it when the gate is
   * still up, otherwise "Continue" no longer exists and the click would time out.
   */
  await page.waitForTimeout(2000);
  /*
   * Clerk asks for a verification code after this sign-up. Its input carries no `name`, so the
   * reliable signal is the visible "verification code" copy plus the single visible text field.
   */
  const verifying = (await page.getByText('verification code').count()) > 0;
  if (verifying) {
    // Clerk's code field can be visually hidden behind styled digit boxes, so `fill()` refuses
    // it: focus the real input and type, which still drives React's onChange.
    const otp = page.locator('input').first();
    await otp.evaluate((element) => element.focus());
    await page.keyboard.type(CODE);
    await page.waitForTimeout(3000);
    if ((await page.getByText('verification code').count()) > 0) {
      await clickText(page, 'Continue');
    }
  }

  const signedIn = await waitFor(page, (s) => s.gate === null, 'signed-in app', 150_000);
  record('clerk-sign-up', signedIn.gate === null, 'real Clerk session established');

  const workspace = await waitFor(
    page,
    (s) => s.active !== null || s.sessionFailed !== null,
    'workspace',
    150_000,
  );
  record('app-user-mapping', workspace.sessionFailed === null, `active=${workspace.active}`);

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/session', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  record(
    'session-mapped-internal-id',
    session.status === 200 &&
      typeof session.body?.userId === 'string' &&
      session.body.userId !== '',
    `status=${session.status}`,
  );

  // A brand-new user has no documents: the switch destroys the empty workspace and creates one.
  await page.click('[data-testid="ai-open"]');
  await waitFor(page, (s) => s.panel, 'ai panel');
  await page.waitForSelector('[data-testid="new-document"]', { timeout: 60_000 });
  const before = await snapshot(page);
  await page.click('[data-testid="new-document"]');
  const created = await waitFor(
    page,
    (s) => s.active !== null && s.active !== before.active && s.panel === false,
    'document creation and switch',
    150_000,
  );
  record(
    'new-document-self-service',
    /^[0-9a-f-]{36}$/i.test(created.active ?? ''),
    `active=${created.active}`,
  );

  const owner = await waitFor(
    page,
    (s) => s.sessionFailed === null && s.role === 'owner',
    'owner editor',
    150_000,
  );
  record('owner-authorization', owner.role === 'owner', `role=${owner.role}`);

  await page.waitForSelector('.cm-content', { timeout: 60_000 });
  await page.click('.cm-content');
  await page.keyboard.type('B13 deployed smoke: the quick brown fox jumps over the lazy dog. ');
  await page.waitForTimeout(1200);

  await page.click('[data-testid="ai-open"]');
  await waitFor(page, (s) => s.panel, 'ai panel for generation');
  await page.waitForSelector('[data-testid="ai-instruction"]', { timeout: 60_000 });
  await page.fill('[data-testid="ai-instruction"]', 'Replace the word "brown" with "red".');
  await page.click('[data-testid="ai-generate"]');
  const proposed = await waitFor(
    page,
    (s) => s.proposal && s.diff,
    'proposal and diff preview',
    180_000,
  );
  record(
    'real-ai-proposal-and-diff',
    proposed.proposal && proposed.diff,
    'provider returned a draft',
  );

  const beforeAccept = proposed.text;
  await page.click('[data-testid="ai-accept"]');
  const accepted = await waitFor(page, (s) => s.proposal === false, 'accept applied', 60_000);
  record(
    'ai-accept-applied',
    accepted.text !== beforeAccept,
    `changed=${accepted.text !== beforeAccept}`,
  );

  await page.click('[data-testid="ai-open"]');
  await waitFor(page, (s) => s.panel, 'panel for reject');
  await page.waitForSelector('[data-testid="ai-instruction"]', { timeout: 60_000 });
  await page.fill('[data-testid="ai-instruction"]', 'Make the sentence shoutier.');
  await page.click('[data-testid="ai-generate"]');
  await waitFor(page, (s) => s.proposal, 'second proposal', 180_000);
  const beforeReject = await snapshot(page);
  await page.click('[data-testid="ai-reject"]');
  const rejected = await waitFor(page, (s) => s.proposal === false, 'reject cleared', 60_000);
  record('ai-reject-writes-nothing', rejected.text === beforeReject.text, 'text unchanged');

  await page.click('[data-testid="sign-out"]');
  await waitFor(page, (s) => s.gate === 'signed-out', 'signed-out gate', 90_000);
  record('sign-out', true, 'gate returned to signed-out');

  const userId = await page.evaluate(() => globalThis.Clerk?.user?.id ?? null);
  if (typeof userId === 'string' && userId.startsWith('user_')) {
    const status = await deleteTestUser(userId);
    console.log(`[b13] test user cleanup status=${status}`);
  } else {
    console.log('[b13] test user cleanup skipped (no user id on the page)');
  }
} catch (error) {
  const diagnosis = await snapshot(page).catch(() => null);
  record(
    'probe',
    false,
    `${error instanceof Error ? error.message : String(error)} | ${JSON.stringify(diagnosis)}`,
  );
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(
  `\nSUMMARY checks=${results.length} pass=${results.length - failed.length} fail=${failed.length}`,
);
if (failed.length > 0) process.exitCode = 1;
