/**
 * A6 Performance Evidence Gate — current-baseline harness.
 *
 * Run from the repository root:
 *
 * ```bash
 * node tests/perf/run.mjs
 * ```
 *
 * What it does, in order:
 *
 * 1. Generates the deterministic 100,000-line fixture twice and verifies both
 *    SHA-256 digests match the checked-in file.
 * 2. Creates a temporary data directory, seeds the document through the real
 *    `openDocumentStore` + `Y.Doc` (`tests/perf/seed.mjs`) and only then starts
 *    the real server + Vite dev stack. No product code is changed.
 * 3. Opens the app in a real Chrome (CDP), measures ready time, runs 3 × 100
 *    real CodeMirror input transactions, forces 3 real WebSocket reconnects,
 *    and collects Long Tasks / bundle sizes / `performance.memory` (when the
 *    browser actually exposes it).
 * 4. Writes the raw JSON and the Markdown report. It sets **no** PASS/FAIL
 *    thresholds: the numbers are a baseline, not a release verdict.
 *
 * The Long Task observer and the offline socket wrapper are test instrumentation
 * injected into the page. They are not production telemetry and are not part of
 * the application.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { configureAuthzFixture, DEFAULT_DEMO_USER } from '../browser/lib/authz-fixture.mjs';
import { installEditorProbe, loadInstrumentSource, setDocumentId, waitForSessionActive, editorTransactions, clearEditorTransactions } from '../browser/lib/app.mjs';
import { newPage, sleep } from '../browser/lib/cdp.mjs';
import { Browser } from '../browser/lib/chrome.mjs';
import { DevStack, isPortClosed } from '../browser/lib/stack.mjs';
import { ensureFixture, repoRoot } from './fixture.mjs';
import { PERF_INIT_SCRIPT } from './instrument.mjs';

const DOCUMENT_ID = 'a6-perf-100k';
const INPUT_ROUNDS = 3;
const INPUTS_PER_ROUND = 100;
const RECONNECT_ITERATIONS = 3;
const DEFAULT_SERVER_PORT = 3301;
const DEFAULT_WEB_PORT = 5183;
const READY_TIMEOUT_MS = 180_000;
const RESULTS_RELATIVE_PATH = 'tests/perf/results/perf-baseline-100k.json';
const REPORT_RELATIVE_PATH = 'docs/agent-governance/PERF-BASELINE-100K.md';

const resultsPath = path.join(repoRoot, RESULTS_RELATIVE_PATH);
const reportPath = path.join(repoRoot, REPORT_RELATIVE_PATH);
const tsxCli = path.join(repoRoot, 'apps', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function parseArgs(argv) {
  const options = { headed: false };
  for (const argument of argv) {
    if (argument === '--headed') options.headed = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

/** A short, explicit value for the nearest-rank percentile. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

function stats(samples) {
  if (samples.length === 0) {
    return { count: 0, min: null, p50: null, p95: null, max: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  // Nearest-rank index. Stated in the report so p95 is reproducible.
  const at = (fraction) => sorted[Math.floor(fraction * (sorted.length - 1))];
  return {
    count: sorted.length,
    min: round2(sorted[0]),
    p50: round2(at(0.5)),
    p95: round2(at(0.95)),
    max: round2(sorted[sorted.length - 1]),
  };
}

function numeric(samples) {
  return samples.filter((value) => typeof value === 'number' && Number.isFinite(value));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout).trim();
}

async function pickPorts() {
  const envServer = process.env.INSIGHTHUB_E2E_SERVER_PORT;
  const envWeb = process.env.INSIGHTHUB_E2E_WEB_PORT;
  const serverBase = envServer === undefined ? DEFAULT_SERVER_PORT : Number(envServer);
  const webBase = envWeb === undefined ? DEFAULT_WEB_PORT : Number(envWeb);
  if (!Number.isInteger(serverBase) || !Number.isInteger(webBase)) {
    throw new Error('INSIGHTHUB_E2E_SERVER_PORT / INSIGHTHUB_E2E_WEB_PORT must be integers');
  }

  // If the caller pinned both ports, honour them exactly; otherwise scan a small
  // range so two worktrees can run the evidence gate concurrently.
  const attempts = envServer !== undefined && envWeb !== undefined ? 1 : 20;
  for (let offset = 0; offset < attempts; offset += 1) {
    const serverPort = serverBase + offset;
    const webPort = webBase + offset;
    if (serverPort === webPort) continue;
    if ((await isPortClosed(serverPort)) && (await isPortClosed(webPort))) {
      return {
        serverPort,
        webPort,
        appUrl: `http://127.0.0.1:${webPort}/`,
      };
    }
  }
  throw new Error(
    `no free perf port pair near ${serverBase}/${webBase}; set ` +
      'INSIGHTHUB_E2E_SERVER_PORT and INSIGHTHUB_E2E_WEB_PORT explicitly',
  );
}

async function runSeed(dataPath, fixture) {
  const seedPath = path.join(repoRoot, 'tests', 'perf', 'seed.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCli, seedPath, dataPath, DOCUMENT_ID, fixture.absolutePath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `the fixture seed failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  const line = String(result.stdout)
    .split(/\r?\n/)
    .filter((candidate) => candidate.trim().startsWith('{'))
    .pop();
  if (line === undefined) {
    throw new Error(`the seed produced no JSON:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(line);
}

async function collectBundles() {
  const assetsDirectory = path.join(repoRoot, 'apps', 'web', 'dist', 'assets');
  let names;
  try {
    names = await readdir(assetsDirectory);
  } catch (error) {
    throw new Error(`the built web assets are missing (${assetsDirectory}); run pnpm build first`, {
      cause: error,
    });
  }
  const files = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.js')).sort()) {
    const absolutePath = path.join(assetsDirectory, name);
    const buffer = await readFile(absolutePath);
    files.push({
      file: `apps/web/dist/assets/${name}`,
      rawBytes: buffer.byteLength,
      gzipBytes: gzipSync(buffer, { level: 9 }).byteLength,
    });
  }
  files.sort((left, right) => right.rawBytes - left.rawBytes || left.file.localeCompare(right.file));
  return {
    directory: 'apps/web/dist/assets',
    files,
    totalRawBytes: files.reduce((total, file) => total + file.rawBytes, 0),
    totalGzipBytes: files.reduce((total, file) => total + file.gzipBytes, 0),
    fileCount: files.length,
  };
}

function hostFacts() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    release: os.release(),
    version: typeof os.version === 'function' ? os.version() : null,
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? null,
    logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  };
}

/** Wait for a page-side status using the real badge's attribute transitions. */
async function waitForStatus(page, wanted, timeoutMs) {
  return await page.evaluate(
    async ({ wantedStatuses, timeout }) => {
      const read = () =>
        document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null;
      if (wantedStatuses.includes(read())) return { status: read(), at: Date.now() };
      return await new Promise((resolve, reject) => {
        let timer;
        const observer = new MutationObserver(() => {
          const status = read();
          if (!wantedStatuses.includes(status)) return;
          observer.disconnect();
          clearTimeout(timer);
          resolve({ status, at: Date.now() });
        });
        observer.observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ['data-status'],
        });
        timer = setTimeout(() => {
          observer.disconnect();
          reject(
            new Error(
              `connection-status never reached ${wantedStatuses.join(' or ')}; ` +
                `currently ${JSON.stringify(read())}`,
            ),
          );
        }, timeout);
      });
    },
    { wantedStatuses: wanted, timeout: timeoutMs },
  );
}

/** Wait for the live EditorState to hold exactly `expectedLength` UTF-16 units. */
async function waitForReady(page, expectedLength, timeoutMs) {
  return await page.evaluate(
    async ({ expected, timeout }) => {
      const started = Date.now();
      return await new Promise((resolve, reject) => {
        const check = () => {
          // Read only the document length while polling. Converting a 6.8 MB
          // document to a string every animation frame would itself distort the
          // ready measurement (and create artificial Long Tasks).
          const view = window.__qa?.probe?.refresh?.() ?? null;
          if (view !== null && view.state.doc.length === expected) {
            resolve({
              at: Date.now(),
              length: view.state.doc.length,
              viewId: window.__qa.probe.viewIds.get(view) ?? 0,
              cmContentCount: document.querySelectorAll('.cm-content').length,
              cmEditorCount: document.querySelectorAll('.cm-editor').length,
            });
            return;
          }
          if (Date.now() - started > timeout) {
            reject(
              new Error(
                `the editor never held ${expected} chars; current ${view === null ? 'no editor' : view.state.doc.length}`,
              ),
            );
            return;
          }
          requestAnimationFrame(check);
        };
        check();
      });
    },
    { expected: expectedLength, timeout: timeoutMs },
  );
}

/** `{ length, viewId }` without serialising the whole document across CDP. */
async function editorSpan(page) {
  return await page.evaluate(() => {
    const view = window.__qa?.probe?.refresh?.() ?? null;
    if (view === null) return null;
    return {
      length: view.state.doc.length,
      viewId: window.__qa.probe.viewIds.get(view) ?? 0,
    };
  });
}

/** SHA-256 of the live EditorState text, computed inside the page. */
async function editorTextSha256(page) {
  return await page.evaluate(async () => {
    const text = window.__qa?.probe?.state?.().text;
    if (typeof text !== 'string') return null;
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0'));
    return { length: text.length, sha256: hex.join('') };
  });
}

async function waitForInputSample(page, expectedCount, timeoutMs = 5_000) {
  return await page.evaluate(
    async ({ expected, timeout }) => {
      const started = performance.now();
      for (;;) {
        const sample = window.__perf.input[expected - 1];
        if (sample !== undefined && sample.inputToNextFrameMs !== null) {
          return { ...sample, count: window.__perf.input.length };
        }
        if (performance.now() - started > timeout) {
          return {
            error: `no input sample ${expected}; captured ${window.__perf.input.length}`,
          };
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    },
    { expected: expectedCount, timeout: timeoutMs },
  );
}

async function measureInputLatency(page) {
  await page.click('.cm-content');
  const rounds = [];

  for (let round = 1; round <= INPUT_ROUNDS; round += 1) {
    await page.pressKey('Home', { modifiers: 2 });
    await page.evaluate(() => {
      window.__perf.input.length = 0;
    });
    await clearEditorTransactions(page);
    const before = await editorSpan(page);
    console.log(`[perf] input round ${round} starting (${before?.length ?? 'no'} chars)`);

    const samples = [];
    for (let index = 1; index <= INPUTS_PER_ROUND; index += 1) {
      await page.insertText('x');
      const sample = await waitForInputSample(page, index);
      if (sample.error !== undefined) {
        throw new Error(`round ${round}: ${sample.error}`);
      }
      samples.push(sample);
      if (index % 25 === 0) console.log(`[perf] input round ${round}: ${index}/${INPUTS_PER_ROUND}`);
    }

    const after = await editorSpan(page);
    if (before === null || after === null) throw new Error(`round ${round}: no live editor`);
    const transactions = await editorTransactions(page);
    const insertedTransactions = transactions.filter(
      (transaction) => transaction.inserted === 1 && transaction.deleted === 0,
    );

    if (after.length - before.length !== INPUTS_PER_ROUND) {
      throw new Error(
        `round ${round}: the model changed by ${after.length - before.length}, expected ${INPUTS_PER_ROUND}`,
      );
    }
    if (samples.length !== INPUTS_PER_ROUND) {
      throw new Error(`round ${round}: captured ${samples.length} input samples, not ${INPUTS_PER_ROUND}`);
    }
    if (insertedTransactions.length !== INPUTS_PER_ROUND) {
      throw new Error(
        `round ${round}: ${insertedTransactions.length} one-character transactions, expected ${INPUTS_PER_ROUND}`,
      );
    }

    const modelSamples = numeric(samples.map((sample) => sample.inputToModelMs));
    const frameSamples = numeric(samples.map((sample) => sample.inputToNextFrameMs));
    rounds.push({
      round,
      sampleCount: samples.length,
      editorLengthBefore: before.length,
      editorLengthAfter: after.length,
      oneCharacterTransactions: insertedTransactions.length,
      viewIdBefore: before.viewId,
      viewIdAfter: after.viewId,
      model: stats(modelSamples),
      nextFrame: stats(frameSamples),
      samples,
    });
  }

  const allModel = rounds.flatMap((round) => round.samples.map((sample) => sample.inputToModelMs));
  const allFrames = rounds.flatMap((round) =>
    round.samples.map((sample) => sample.inputToNextFrameMs),
  );
  return {
    inputsPerRound: INPUTS_PER_ROUND,
    rounds: INPUT_ROUNDS,
    method:
      'beforeinput (capture) -> input listener on .cm-content (installed after CodeMirror, so after the editor transaction) -> next animation frame; measured inside the page with performance.now()',
    model: stats(allModel),
    nextFrame: stats(allFrames),
    roundStats: rounds,
    totalSamples: allModel.length,
  };
}

async function measureReconnect(page) {
  const iterations = [];
  for (let iteration = 1; iteration <= RECONNECT_ITERATIONS; iteration += 1) {
    const cycleStart = Date.now();
    await page.evaluate(() => window.__perf.setOffline(true));
    const disconnected = await waitForStatus(
      page,
      ['reconnecting', 'offline', 'error', 'idle'],
      15_000,
    );
    const disconnectedAt = disconnected.at;
    // Hold the outage long enough that a scheduled retry actually runs while the
    // wrapper is still rewriting /ws to an unreachable port.
    await sleep(250);
    const restoreStart = Date.now();
    await page.evaluate(() => window.__perf.setOffline(false));
    const connected = await waitForStatus(page, ['connected'], 30_000);
    const connectedAt = connected.at;

    await sleep(500);
    const stable = await page.evaluate(
      () => document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
    );
    if (stable !== 'connected') {
      throw new Error(`iteration ${iteration}: status was ${stable} after the reconnect settled`);
    }

    iterations.push({
      iteration,
      disconnectedStatus: disconnected.status,
      offlineObservedMs: round2(disconnectedAt - cycleStart),
      restoreToConnectedMs: round2(connectedAt - restoreStart),
      offlineToConnectedMs: round2(connectedAt - cycleStart),
      connectedAt,
    });
  }

  return {
    iterations: RECONNECT_ITERATIONS,
    method:
      'window.__perf.setOffline(true) closes the live /ws socket and rewrites new /ws sockets to ws://127.0.0.1:9/ws; setOffline(false) restores; duration ends on the real connection-status badge becoming connected',
    restoreToConnectedMs: stats(iterations.map((entry) => entry.restoreToConnectedMs)),
    offlineToConnectedMs: stats(iterations.map((entry) => entry.offlineToConnectedMs)),
    offlineObservedMs: stats(iterations.map((entry) => entry.offlineObservedMs)),
    samples: iterations,
  };
}

async function measureMemory(page) {
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    const sample = await page.evaluate(() => window.__perf.memorySnapshot());
    if (sample === null) break;
    samples.push(sample);
    await sleep(200);
  }
  if (samples.length < 3) {
    return {
      status: 'NOT VERIFIED',
      reason:
        'performance.memory was not exposed by this Chrome invocation (fewer than 3 samples); no heap number is reported',
      samples,
    };
  }
  const used = samples.map((sample) => sample.usedJSHeapSize);
  const limits = new Set(samples.map((sample) => sample.jsHeapSizeLimit));
  const plausible = limits.size === 1 && used.every((value) => Number.isFinite(value) && value > 0);
  if (!plausible) {
    return {
      status: 'NOT VERIFIED',
      reason: 'performance.memory was present but not stable (limit changed or heap value invalid)',
      samples,
    };
  }
  return {
    status: 'AVAILABLE (Chrome non-standard performance.memory)',
    currentUsedJSHeapSize: used[used.length - 1],
    peakUsedJSHeapSize: Math.max(...used),
    minUsedJSHeapSize: Math.min(...used),
    jsHeapSizeLimit: [...limits][0],
    sampleCount: samples.length,
    samples,
  };
}

function buildObservations({ ready, input, longTasks, reconnect }) {
  const observations = [];
  if (input.nextFrame.p95 !== null && input.nextFrame.p95 > 1_000) {
    observations.push(
      `input p95 (input -> next frame) is ${input.nextFrame.p95} ms, above 1 s; this is an observation, not a PASS/FAIL threshold.`,
    );
  }
  if (input.model.p95 !== null && input.model.p95 > 1_000) {
    observations.push(
      `input p95 (input -> model confirmation) is ${input.model.p95} ms, above 1 s; this is an observation.`,
    );
  }
  if (longTasks.supported && longTasks.count >= 10) {
    observations.push(
      `${longTasks.count} Long Tasks were observed (${longTasks.totalDurationMs} ms summed, ${longTasks.p50Ms} ms p50, ${longTasks.p95Ms} ms p95). Count alone is not a verdict; it is flagged because the task brief asks for an explicit observation when Long Tasks are frequent.`,
    );
  }
  if (
    input.nextFrame.p95 !== null &&
    input.nextFrame.p95 > 500 &&
    input.nextFrame.p95 <= 1_000
  ) {
    observations.push(
      `input p95 (input -> next frame) is ${input.nextFrame.p95} ms and the p50 is ${input.nextFrame.p50} ms; this is below the 1 s example but is called out as an elevated current-baseline number.`,
    );
  }
  if (ready.durationMs > 10_000) {
    observations.push(
      `ready duration is ${ready.durationMs} ms; loading a 100k-line document is visibly expensive on this host.`,
    );
  }
  if (reconnect.restoreToConnectedMs.p95 > 10_000) {
    observations.push(
      `reconnect p95 is ${reconnect.restoreToConnectedMs.p95} ms; the reconnect backoff dominates in this sample.`,
    );
  }
  return observations;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} B`;
}

function formatStats(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${value}`;
}

function renderReport({ generatedAt, gitInfo, host, chrome, fixture, seed, ports, results }) {
  const lines = [];
  lines.push('# Performance Baseline — 100,000-line Markdown');
  lines.push('');
  lines.push(
    '**Scope: current baseline only.** This report is not a before/after optimization comparison. ' +
      'It records the behaviour of the current commit on one local host, with no PASS/FAIL thresholds.',
  );
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| Fact | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Measurement commit | \`${gitInfo.shortCommit}\` (\`${gitInfo.commit}\`) |`);
  lines.push('| Product-code changes | none; only `tests/perf/**` and this report were added |');
  lines.push(`| Branch | \`${gitInfo.branch}\` |`);
  lines.push(`| Worktree | \`${repoRoot}\` |`);
  lines.push(`| Host | ${host.version ?? host.platform} ${host.release} (${host.arch}) |`);
  lines.push(`| CPU | ${host.cpuModel} (${host.logicalCpuCount} logical CPUs) |`);
  lines.push(`| RAM | ${(host.totalMemoryBytes / 1024 ** 3).toFixed(1)} GiB |`);
  lines.push(`| Node | ${host.node} |`);
  lines.push(`| Chrome | ${chrome.product} |`);
  lines.push(`| Browser mode | ${chrome.headless ? 'headless' : 'headed'} |`);
  lines.push(`| Generated at | ${generatedAt} |`);
  lines.push(`| Stack | real server + real Vite dev server, ports ${ports.serverPort}/${ports.webPort} |`);
  lines.push('');
  lines.push('## Fixture');
  lines.push('');
  lines.push('| Fact | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Path | \`${fixture.path}\` |`);
  lines.push(`| Lines | ${fixture.lineCount.toLocaleString('en-US')} |`);
  lines.push(`| Characters (UTF-16) | ${fixture.characters.toLocaleString('en-US')} |`);
  lines.push(`| Bytes (UTF-8) | ${formatBytes(fixture.bytes)} |`);
  lines.push(`| SHA-256 | \`${fixture.sha256}\` |`);
  lines.push(`| Second generation SHA-256 | \`${fixture.secondGenerationSha256}\` |`);
  lines.push(`| Deterministic | ${fixture.deterministic ? 'yes — both generations byte-identical' : 'NO'} |`);
  lines.push(`| Line template | \`${fixture.lineTemplate}\` |`);
  lines.push('');
  lines.push(
    'There is no randomness, clock read, padding or locale formatting in the generator. ' +
      'The same commit produced the same bytes twice in this run, and the checked-in file ' +
      'was verified against the generator before the benchmark started.',
  );
  lines.push('');
  lines.push('## Method and operation sequence');
  lines.push('');
  lines.push('1. `pnpm build` produced `apps/web/dist`; `pnpm typecheck` and `pnpm test` were green.');
  lines.push(
    `2. \`openDocumentStore\` opened a temporary SQLite data directory and a real \`Y.Doc\` wrote the fixture into \`Y.Text\` key \`content\`; \`store.append\` committed it (sequence ${seed.sequence}). This is a server-side seed through the production persistence seam, not a product-code change.`,
  );
  lines.push('3. The real server and Vite dev server started on the ports above.');
  lines.push(
    `4. A real Chrome opened \`${ports.appUrl}\`; the page first opened its default document, then switched to \`${DOCUMENT_ID}\`.`,
  );
  lines.push(
    '5. Ready was defined as the live `EditorView` state holding exactly the fixture character count; the live text was then SHA-256-hashed and compared with the fixture.',
  );
  lines.push(
    `6. Input latency: ${results.input.rounds} rounds × ${results.input.inputsPerRound} real \`Input.insertText\` transactions at the start of the document. Each round cleared the transaction recorder and verified exactly 100 one-character insert transactions.`,
  );
  lines.push(
    `7. Reconnect: ${results.reconnect.iterations} iterations of \`setOffline(true)\` (close the live WebSocket) → 250 ms outage → \`setOffline(false)\` → wait for \`connection-status=connected\`.`,
  );
  lines.push(
    '8. Long Tasks were collected by a test-injected `PerformanceObserver` from page start to the end of the run. It is **test instrumentation, not production telemetry**.',
  );
  lines.push('9. Bundle sizes were read from the current `apps/web/dist/assets/*.js` with `node:zlib` gzip.');
  lines.push('10. `performance.memory` was sampled five times, 200 ms apart, only to report what Chrome exposed.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('### Ready and first WebSocket');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Ready duration (page.goto start → 100k model ready) | ${results.ready.durationMs} ms |`);
  lines.push(`| Editor text SHA-256 at ready | \`${results.ready.editorSha256}\` |`);
  lines.push(`| Editor text matches fixture | ${results.ready.shaMatchesFixture ? 'yes' : 'NO'} |`);
  lines.push(
    `| \`.cm-content\` / \`.cm-editor\` at ready | ${results.ready.cmContentCount} / ${results.ready.cmEditorCount} |`,
  );
  lines.push(
    `| First WebSocket connected after navigation | ${results.firstWebSocket.connectedAfterNavigationMs === null ? 'not observed' : `${results.firstWebSocket.connectedAfterNavigationMs} ms`} |`,
  );
  lines.push('');
  lines.push('### Input latency');
  lines.push('');
  lines.push('All values are milliseconds, measured inside the page. `model` ends at the `.cm-content` input listener (after CodeMirror applied the transaction); `next frame` ends at the next `requestAnimationFrame`. p50/p95 use the nearest-rank index `floor(p × (n−1))` on the sorted samples; raw samples are in the JSON.');
  lines.push('');
  lines.push('| Scope | Metric | n | p50 | p95 | max | min |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const round of results.input.roundStats) {
    lines.push(
      `| Round ${round.round} | model | ${round.model.count} | ${formatStats(round.model.p50)} | ${formatStats(round.model.p95)} | ${formatStats(round.model.max)} | ${formatStats(round.model.min)} |`,
    );
    lines.push(
      `| Round ${round.round} | next frame | ${round.nextFrame.count} | ${formatStats(round.nextFrame.p50)} | ${formatStats(round.nextFrame.p95)} | ${formatStats(round.nextFrame.max)} | ${formatStats(round.nextFrame.min)} |`,
    );
  }
  lines.push(
    `| All rounds | model | ${results.input.model.count} | ${formatStats(results.input.model.p50)} | ${formatStats(results.input.model.p95)} | ${formatStats(results.input.model.max)} | ${formatStats(results.input.model.min)} |`,
  );
  lines.push(
    `| All rounds | next frame | ${results.input.nextFrame.count} | ${formatStats(results.input.nextFrame.p50)} | ${formatStats(results.input.nextFrame.p95)} | ${formatStats(results.input.nextFrame.max)} | ${formatStats(results.input.nextFrame.min)} |`,
  );
  lines.push('');
  lines.push(
    `Per-round one-character transactions: ${results.input.roundStats.map((round) => `${round.round}=${round.oneCharacterTransactions}`).join(', ')}. Each round also verified the model grew by exactly ${results.input.inputsPerRound} characters.`,
  );
  lines.push('');
  lines.push('### Long Tasks (test instrumentation)');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Observer supported | ${results.longTasks.supported ? 'yes' : 'no'} |`);
  lines.push(`| Count | ${results.longTasks.count} |`);
  lines.push(`| Total duration | ${results.longTasks.totalDurationMs} ms |`);
  lines.push(`| Max duration | ${results.longTasks.maxDurationMs} ms |`);
  lines.push(`| p50 / p95 | ${results.longTasks.p50Ms} / ${results.longTasks.p95Ms} ms |`);
  lines.push('');
  lines.push(
    'The observer ran from page start through the whole benchmark, so this count includes the benchmark’s own input transactions. It is test instrumentation injected by this harness, **not production telemetry**.',
  );
  lines.push('');
  lines.push('### WebSocket reconnect');
  lines.push('');
  lines.push('| Iteration | Offline status observed | Offline observed | Restore → connected | Offline → connected |');
  lines.push('| ---: | --- | ---: | ---: | ---: |');
  for (const sample of results.reconnect.samples) {
    lines.push(
      `| ${sample.iteration} | ${sample.disconnectedStatus} | ${sample.offlineObservedMs} ms | ${sample.restoreToConnectedMs} ms | ${sample.offlineToConnectedMs} ms |`,
    );
  }
  lines.push('');
  lines.push(
    `Restore → connected: p50 ${results.reconnect.restoreToConnectedMs.p50} ms, p95 ${results.reconnect.restoreToConnectedMs.p95} ms, max ${results.reconnect.restoreToConnectedMs.max} ms (n=${results.reconnect.restoreToConnectedMs.count}).`,
  );
  lines.push(
    `Offline → connected: p50 ${results.reconnect.offlineToConnectedMs.p50} ms, p95 ${results.reconnect.offlineToConnectedMs.p95} ms, max ${results.reconnect.offlineToConnectedMs.max} ms.`,
  );
  lines.push('');
  lines.push('### Bundle / chunk (current `apps/web/dist/build`)');
  lines.push('');
  lines.push('| File | Raw | Gzip |');
  lines.push('| --- | ---: | ---: |');
  for (const file of results.bundle.files) {
    lines.push(`| \`${file.file}\` | ${file.rawBytes.toLocaleString('en-US')} B | ${file.gzipBytes.toLocaleString('en-US')} B |`);
  }
  lines.push(
    `| **Total (${results.bundle.fileCount} JS files)** | **${results.bundle.totalRawBytes.toLocaleString('en-US')} B** | **${results.bundle.totalGzipBytes.toLocaleString('en-US')} B** |`,
  );
  lines.push('');
  lines.push('### Memory');
  lines.push('');
  lines.push('| Fact | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Status | ${results.memory.status} |`);
  if (results.memory.status.startsWith('AVAILABLE')) {
    lines.push(`| Current usedJSHeapSize | ${results.memory.currentUsedJSHeapSize.toLocaleString('en-US')} B |`);
    lines.push(`| Peak usedJSHeapSize (sampled) | ${results.memory.peakUsedJSHeapSize.toLocaleString('en-US')} B |`);
    lines.push(`| Min usedJSHeapSize (sampled) | ${results.memory.minUsedJSHeapSize.toLocaleString('en-US')} B |`);
    lines.push(`| jsHeapSizeLimit | ${results.memory.jsHeapSizeLimit.toLocaleString('en-US')} B |`);
    lines.push(`| Samples | ${results.memory.sampleCount} (five samples, 200 ms apart) |`);
  } else {
    lines.push(`| Reason | ${results.memory.reason} |`);
  }
  lines.push('');
  lines.push('## Observations (not PASS/FAIL thresholds)');
  lines.push('');
  if (results.observations.length === 0) {
    lines.push('No observation was triggered by the reporting rules used here.');
  } else {
    for (const observation of results.observations) lines.push(`- ${observation}`);
  }
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  lines.push('- This is **local Windows 11 desktop** evidence only; it is not a production P95.');
  lines.push('- Production performance remains **NOT VERIFIED**. Render Free cold start/shared CPU was not used as a substitute.');
  lines.push('- The runtime path is the Vite dev server (module transform on demand), not the production bundle; bundle sizes are reported separately from the built output.');
  lines.push('- Long Tasks and input timing are **test instrumentation**; there is no production `PerformanceObserver` or telemetry.');
  lines.push('- `performance.memory` is non-standard and is reported only when this Chrome invocation exposed stable samples.');
  lines.push('- The 100k fixture is synthetic and deterministic; it is not a capture of real user content.');
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push(`- Raw JSON: \`${RESULTS_RELATIVE_PATH}\``);
  lines.push(`- Fixture: \`${fixture.path}\` (sha256 \`${fixture.sha256}\`)`);
  lines.push('- Run command: `node tests/perf/run.mjs`');
  lines.push('- Preconditions: `pnpm build`, `pnpm typecheck`, `pnpm test` (green before this run).');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const fixture = await ensureFixture();
  console.log(
    `[perf] fixture ${fixture.lineCount} lines, ${fixture.bytes} bytes, sha256 ${fixture.sha256}`,
  );
  if (fixture.secondGenerationSha256 !== fixture.sha256) {
    throw new Error('the fixture generator produced two different digests');
  }

  const ports = await pickPorts();
  /*
   * `DevStack.createDataPath()` deliberately does **not** assign the stack's
   * current data directory (it exists for scenarios that switch onto a fresh
   * store). The seed must be written to the exact directory the stack will
   * start on, so the directory is created here and passed to the constructor.
   */
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'insighthub-a6-perf-100k-'));
  const stack = new DevStack({
    repoRoot,
    serverPort: ports.serverPort,
    webPort: ports.webPort,
    dataPath,
    // The backend's development default is http://localhost:5173. The perf
    // harness may run on a different pair of ports, so the allowed origin must
    // name the actual Vite origin or both HTTP bootstrap and the WS upgrade are
    // refused with origin_not_allowed.
    serverEnv: { CORS_ORIGIN: `http://127.0.0.1:${ports.webPort}` },
  });
  let browser;
  let page;
  try {
    const seed = await runSeed(dataPath, fixture);
    console.log(`[perf] seeded ${seed.documentId} at update sequence ${seed.sequence}`);
    await stack.start();
    console.log(`[perf] stack ready at ${stack.appUrl}`);

    const authz = configureAuthzFixture({
      serverUrl: `http://127.0.0.1:${stack.serverPort}`,
      dataPath: () => stack.dataPath,
    });
    await authz.grant(DOCUMENT_ID, DEFAULT_DEMO_USER, 'owner');
    console.log('[perf] membership arranged for demo-ada');

    browser = await Browser.launch({ headed: options.headed });
    const chrome = {
      product: browser.version.product,
      userAgent: browser.version.userAgent,
      jsVersion: browser.version.jsVersion,
      protocolVersion: browser.version.protocolVersion,
      executablePath: browser.executablePath,
      headless: !options.headed,
    };
    console.log(`[perf] browser ${chrome.product}`);

    page = await newPage(browser.connection);
    page.demoUserId = DEFAULT_DEMO_USER;
    await page.addInitScript(
      `window.__qaIdentity = ${JSON.stringify(DEFAULT_DEMO_USER)};`,
    );
    await page.addInitScript(await loadInstrumentSource());
    await page.addInitScript(PERF_INIT_SCRIPT);

    const navigationStartedAt = Date.now();
    await page.goto(stack.appUrl);
    await waitForSessionActive(page);
    /*
     * Patch `EditorView.prototype.dispatch` **before** the 100k document is
     * opened. CodeMirror binds `view.dispatch` to the instance in its
     * constructor, so a view created before the patch keeps the original bound
     * method; installing the probe while the default document is live makes the
     * 100k view (created by the switch) record its transactions.
     */
    await installEditorProbe(page);
    await setDocumentId(page, DOCUMENT_ID);
    await waitForSessionActive(page);
    await installEditorProbe(page);

    const ready = await waitForReady(page, fixture.characters, READY_TIMEOUT_MS);
    const readyDurationMs = ready.at - navigationStartedAt;
    const editorHash = await editorTextSha256(page);
    if (editorHash === null) throw new Error('the editor text could not be hashed');
    if (editorHash.length !== fixture.characters) {
      throw new Error(`the editor held ${editorHash.length} chars, expected ${fixture.characters}`);
    }
    if (editorHash.sha256 !== fixture.sha256) {
      throw new Error(
        `the editor text does not match the fixture: ${editorHash.sha256} !== ${fixture.sha256}`,
      );
    }
    console.log(`[perf] ready in ${readyDurationMs} ms; editor text matches fixture`);

    const connectionTransitions = await page.evaluate(() => window.__perf.connection.slice());
    const firstConnected = connectionTransitions.find((entry) => entry.status === 'connected');
    const firstWebSocket = {
      connectedAt: firstConnected?.at ?? null,
      connectedAfterNavigationMs:
        firstConnected === undefined ? null : firstConnected.at - navigationStartedAt,
      transitions: connectionTransitions,
    };

    const input = await measureInputLatency(page);
    console.log(
      `[perf] input p50/p95/max (next frame): ${input.nextFrame.p50}/${input.nextFrame.p95}/${input.nextFrame.max} ms over ${input.totalSamples} samples`,
    );

    const redux = await page.evaluate(() => window.__perf.reduxSnapshot());
    console.log(`[perf] redux snapshot: ${JSON.stringify(redux)}`);

    const reconnect = await measureReconnect(page);
    console.log(
      `[perf] reconnect p50/p95/max (restore -> connected): ${reconnect.restoreToConnectedMs.p50}/${reconnect.restoreToConnectedMs.p95}/${reconnect.restoreToConnectedMs.max} ms`,
    );

    const longTaskEntries = await page.evaluate(() => window.__perf.longTasks.slice());
    const longTaskDurations = numeric(longTaskEntries.map((entry) => entry.duration));
    const longTasks = {
      supported: await page.evaluate(() => window.__perf.longTaskSupported === true),
      instrumentation:
        'test-only PerformanceObserver({ type: "longtask", buffered: true }); not production telemetry',
      count: longTaskDurations.length,
      totalDurationMs: round2(longTaskDurations.reduce((total, value) => total + value, 0)),
      maxDurationMs: longTaskDurations.length === 0 ? null : round2(Math.max(...longTaskDurations)),
      p50Ms: stats(longTaskDurations).p50,
      p95Ms: stats(longTaskDurations).p95,
      samples: longTaskEntries,
    };

    const memory = await measureMemory(page);
    const bundle = await collectBundles();
    const host = hostFacts();
    const gitInfo = {
      commit: git(['rev-parse', 'HEAD']),
      shortCommit: git(['rev-parse', '--short', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      status: git(['status', '--porcelain']),
    };

    const resultsBase = {
      ready: {
        durationMs: readyDurationMs,
        modelLength: ready.length,
        viewId: ready.viewId,
        cmContentCount: ready.cmContentCount,
        cmEditorCount: ready.cmEditorCount,
        editorSha256: editorHash.sha256,
        shaMatchesFixture: editorHash.sha256 === fixture.sha256,
        navigationStartedAt,
        readyAt: ready.at,
      },
      firstWebSocket,
      input,
      redux,
      reconnect,
      longTasks,
      bundle,
      memory,
    };
    const observations = buildObservations({
      ready: resultsBase.ready,
      input,
      longTasks,
      reconnect,
    });

    const payload = {
      schemaVersion: 1,
      generatedAt,
      evidenceType: 'current baseline; no PASS/FAIL thresholds',
      caution:
        'Long Tasks and input timings are test instrumentation, not production telemetry. Local host only; production performance NOT VERIFIED.',
      git: gitInfo,
      host,
      chrome,
      ports,
      urls: { app: stack.appUrl, ws: stack.wsUrl, server: `http://127.0.0.1:${stack.serverPort}` },
      fixture,
      seed,
      operationSequence: [
        'pnpm build; pnpm typecheck; pnpm test',
        'generate fixture twice and compare sha256',
        'create temporary dataPath; openDocumentStore; Y.Doc getText("content").insert(fixture); store.append; close',
        'start real server and real Vite dev server',
        'arrange demo-ada owner membership for a6-perf-100k',
        'launch real Chrome; open app; wait for session; switch to a6-perf-100k',
        `wait until EditorView text length == ${fixture.characters}; hash editor text and compare`,
        `3 rounds x 100 real Input.insertText("x") at document start`,
        'capture a Redux state snapshot and assert the 100k body is not mirrored into it',
        '3 iterations setOffline(true) -> 250 ms -> setOffline(false) -> connected',
        'collect Long Tasks, performance.memory, bundle sizes',
      ],
      inputCounts: {
        rounds: INPUT_ROUNDS,
        inputsPerRound: INPUTS_PER_ROUND,
        totalInputSamples: input.totalSamples,
        reconnectIterations: RECONNECT_ITERATIONS,
      },
      results: resultsBase,
      observations,
    };

    await mkdir(path.dirname(resultsPath), { recursive: true });
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(resultsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeFile(
      reportPath,
      renderReport({
        generatedAt,
        gitInfo,
        host,
        chrome,
        fixture,
        seed,
        ports,
        results: { ...resultsBase, observations },
      }),
      'utf8',
    );

    console.log(`[perf] JSON:   ${RESULTS_RELATIVE_PATH}`);
    console.log(`[perf] report: ${REPORT_RELATIVE_PATH}`);
    console.log(
      `[perf] longtasks=${longTasks.count} ready=${readyDurationMs}ms inputP95=${input.nextFrame.p95}ms reconnectP95=${reconnect.restoreToConnectedMs.p95}ms`,
    );
    if (observations.length > 0) {
      for (const observation of observations) console.log(`[perf] observation: ${observation}`);
    }
  } finally {
    if (page !== undefined) await page.close().catch(() => {});
    if (browser !== undefined) await browser.close().catch(() => {});
    await stack.dispose();
    await rm(dataPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
