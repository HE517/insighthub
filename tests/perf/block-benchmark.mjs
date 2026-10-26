/**
 * Diagnostic benchmark for the **block-structured** 100k fixture (Candidate A, D-086 follow-up).
 *
 * Same host, Chrome, production-build serving path, operation sequence and instrumentation as the
 * pathological baseline; only the document's block structure differs. It reports ready + input
 * latency + Long Tasks + a CPU profile for one 100-input round, so the "single huge paragraph"
 * amplification can be quantified. The pathological fixture is untouched.
 *
 * Usage: node tests/perf/block-benchmark.mjs --out=tests/perf/results/perf-block-run-1.json
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadInstrumentSource, waitForSessionActive } from '../browser/lib/app.mjs';
import { configureAuthzFixture, DEFAULT_DEMO_USER } from '../browser/lib/authz-fixture.mjs';
import { Browser } from '../browser/lib/chrome.mjs';
import { newPage, sleep } from '../browser/lib/cdp.mjs';
import { BuildStack } from './build-stack.mjs';
import { repoRoot } from './fixture.mjs';
import { ensureBlockFixture } from './fixture-block.mjs';
import { PERF_INIT_SCRIPT } from './instrument.mjs';

const DOCUMENT_ID = 'a6-perf-100k-block';
const INPUT_ROUNDS = 3;
const INPUTS_PER_ROUND = 100;

function round2(value) {
  return Math.round(value * 100) / 100;
}
function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return { count: sorted.length, p50: round2(at(50)), p95: round2(at(95)), max: round2(sorted[sorted.length - 1]) };
}

function seed(dataPath, fixturePath) {
  const tsxCli = path.join(repoRoot, 'apps', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCli, path.join(repoRoot, 'tests', 'perf', 'seed.mjs'), dataPath, DOCUMENT_ID, fixturePath],
    { cwd: repoRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
  if (result.status !== 0) throw new Error(`seed failed: ${result.stdout}\n${result.stderr}`);
}

/** Switch documents in a built bundle without the dev-only module probe. */
async function setDocumentIdBuild(page, documentId) {
  await page.evaluate((id) => {
    const input = document.querySelector('input[aria-label="Document id"]');
    if (input === null) throw new Error('no document switcher input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, id);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, documentId);
  await page.waitFor(
    (id) =>
      document.querySelector('[data-testid="active-document"]')?.textContent?.trim() === id &&
      document.querySelector('.cm-content') !== null,
    { timeoutMs: 60_000, label: `document ${documentId}`, args: [documentId] },
  );
}
async function waitEditor(page, expected) {
  return page.evaluate(
    async ({ chars, timeout }) => {
      const started = Date.now();
      for (;;) {
        const length = window.__perf.editorLength();
        if (length === chars) return { at: Date.now(), length };
        if (Date.now() - started > timeout) throw new Error(`editor held ${String(length)} / ${chars}`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    },
    { chars: expected, timeout: 180_000 },
  );
}

function summarizeCpu(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const byKey = new Map();
  let totalUs = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const node = nodes.get(profile.samples[index]);
    const deltaUs = profile.timeDeltas[index] ?? 0;
    if (node === undefined || deltaUs <= 0) continue;
    totalUs += deltaUs;
    const frame = node.callFrame;
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url || '(native)'}`;
    const entry = byKey.get(key) ?? { functionName: frame.functionName || '(anonymous)', url: frame.url || '(native)', selfMs: 0 };
    entry.selfMs += deltaUs / 1000;
    byKey.set(key, entry);
  }
  return {
    totalProfiledMs: round2(totalUs / 1000),
    top: [...byKey.values()]
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 15)
      .map((entry) => ({ ...entry, selfMs: round2(entry.selfMs), sharePct: round2((entry.selfMs / (totalUs / 1000)) * 100) })),
  };
}

const outIndex = process.argv.findIndex((argument) => argument.startsWith('--out='));
const outPath =
  outIndex === -1
    ? path.join(repoRoot, 'tests', 'perf', 'results', 'perf-block-run.json')
    : path.resolve(process.argv[outIndex].slice('--out='.length));

const ports = { serverPort: 3301 + Math.floor(Math.random() * 200) };
const dataPath = await mkdtemp(path.join(os.tmpdir(), 'insighthub-perf-block-'));
const stack = new BuildStack({ repoRoot, serverPort: ports.serverPort, dataPath });
let browser;
let page;
try {
  const fixture = await ensureBlockFixture();
  seed(dataPath, fixture.absolutePath);
  await stack.start();
  const authz = configureAuthzFixture({ serverUrl: `http://127.0.0.1:${stack.serverPort}`, dataPath: () => stack.dataPath });
  await authz.grant(DOCUMENT_ID, DEFAULT_DEMO_USER, 'owner');

  browser = await Browser.launch({ headed: false });
  page = await newPage(browser.connection);
  page.demoUserId = DEFAULT_DEMO_USER;
  await page.addInitScript(`window.__qaIdentity = ${JSON.stringify(DEFAULT_DEMO_USER)};`);
  await page.addInitScript(await loadInstrumentSource());
  await page.addInitScript(PERF_INIT_SCRIPT);

  const navigationStartedAt = Date.now();
  await page.goto(stack.appUrl);
  await waitForSessionActive(page);
  await setDocumentIdBuild(page, DOCUMENT_ID);
  await waitForSessionActive(page);
  const ready = await waitEditor(page, fixture.characters);
  const readyMs = ready.at - navigationStartedAt;

  await page.click('.cm-content');
  await page.pressKey('Home', { modifiers: 2 });
  await sleep(200);

  await page.send('Profiler.enable');
  await page.send('Profiler.start');

  const rounds = [];
  for (let round = 1; round <= INPUT_ROUNDS; round += 1) {
    await page.pressKey('Home', { modifiers: 2 });
    await page.evaluate(() => {
      window.__perf.input.length = 0;
    });
    const before = await page.evaluate(() => window.__perf.editorLength());
    const samples = [];
    for (let index = 1; index <= INPUTS_PER_ROUND; index += 1) {
      await page.insertText('x');
      const sample = await page.evaluate(
        async (expected) => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const entry = window.__perf.input[expected - 1];
            if (entry !== undefined && entry.inputToNextFrameMs !== null) return entry;
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          return { error: 'sample timeout' };
        },
        index,
      );
      if (sample.error !== undefined) throw new Error(`round ${round}: ${sample.error}`);
      samples.push(sample);
    }
    const after = await page.evaluate(() => window.__perf.editorLength());
    rounds.push({
      round,
      before,
      after,
      samples: samples.length,
      model: stats(samples.map((entry) => entry.inputToModelMs)),
      nextFrame: stats(samples.map((entry) => entry.inputToNextFrameMs)),
    });
  }

  const { profile } = await page.send('Profiler.stop');
  const cpu = summarizeCpu(profile);
  const longTasks = await page.evaluate(() => window.__perf.longTasks.slice());
  const longTaskDurations = longTasks.map((entry) => entry.duration);
  const redux = await page.evaluate(() => window.__perf.reduxSnapshot());

  const payload = {
    generatedAt: new Date().toISOString(),
    servingMode: 'build (Express static, no Vite)',
    fixture: {
      lines: fixture.lineCount,
      characters: fixture.characters,
      bytes: fixture.bytes,
      sha256: fixture.sha256,
      file: fixture.absolutePath,
    },
    host: { platform: os.platform(), version: os.version?.() ?? null, cpus: os.cpus()[0]?.model ?? null, node: process.version },
    chrome: browser.version.product,
    readyMs,
    input: {
      rounds: rounds.map((entry) => ({ round: entry.round, model: entry.model, nextFrame: entry.nextFrame })),
      totalSamples: rounds.reduce((sum, entry) => sum + entry.samples, 0),
    },
    longTasks: {
      count: longTasks.length,
      totalMs: round2(longTaskDurations.reduce((sum, value) => sum + value, 0)),
      maxMs: longTaskDurations.length === 0 ? null : round2(Math.max(...longTaskDurations)),
      p50: stats(longTaskDurations)?.p50 ?? null,
      p95: stats(longTaskDurations)?.p95 ?? null,
    },
    cpu,
    redux,
  };
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(payload, null, 2));
  console.log(`[block] wrote ${outPath}`);
} finally {
  if (page !== undefined) await page.close().catch(() => {});
  if (browser !== undefined) await browser.close().catch(() => {});
  await stack.dispose();
  await rm(dataPath, { recursive: true, force: true });
}
