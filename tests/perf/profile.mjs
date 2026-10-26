/**
 * Profiling harness for the 100k input path (diagnostic only; no product changes).
 *
 * It opens a seeded document, warms the editor, records a Chrome trace over a **fixed input
 * window** (20 real `Input.insertText("x")`), and reports where the time went: scripting, style/
 * layout, paint/composite, CodeMirror updates, Yjs, IndexedDB, WebSocket sends, React, and any
 * full-document string materialisation. It also supports a size-scaling probe (5k/25k/50k/100k).
 *
 * Usage:
 *   node tests/perf/profile.mjs                 # trace the 100k document
 *   node tests/perf/profile.mjs --scaling       # scaling probe, 20 inputs per size
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { loadInstrumentSource, installEditorProbe, setDocumentId, waitForSessionActive } from '../browser/lib/app.mjs';
import { Browser } from '../browser/lib/chrome.mjs';
import { newPage, sleep } from '../browser/lib/cdp.mjs';
import { DevStack } from '../browser/lib/stack.mjs';
import { configureAuthzFixture, DEFAULT_DEMO_USER } from '../browser/lib/authz-fixture.mjs';
import { repoRoot } from './fixture.mjs';
import { PERF_INIT_SCRIPT } from './instrument.mjs';

const DOCUMENT_ID = 'a6-perf-profile';
const WARM_INPUTS = 10;
const TRACED_INPUTS = 20;
const LINE_TEMPLATE = 'line-<i>: The quick brown fox jumps over the lazy dog 0123456789.';

function fixtureText(lines) {
  const out = [];
  for (let i = 0; i < lines; i += 1) out.push(LINE_TEMPLATE.replace('<i>', String(i)));
  return `${out.join('\n')}\n`;
}

function seedFixture(dataPath, fixturePath) {
  const tsxCli = path.join(repoRoot, 'apps', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const seedPath = path.join(repoRoot, 'tests', 'perf', 'seed.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCli, seedPath, dataPath, DOCUMENT_ID, fixturePath],
    { cwd: repoRoot, encoding: 'utf8', timeout: 300_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
  if (result.status !== 0) throw new Error(`seed failed: ${result.stdout}\n${result.stderr}`);
}

async function startStack() {
  const webPort = 5173 + Math.floor(Math.random() * 200);
  const serverPort = 3101 + Math.floor(Math.random() * 200);
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'insighthub-perf-profile-'));
  const stack = new DevStack({
    repoRoot,
    serverPort,
    webPort,
    dataPath,
    serverEnv: { CORS_ORIGIN: `http://127.0.0.1:${webPort}` },
  });
  return { stack, dataPath, serverPort, webPort };
}

async function openDocument(page, characters) {
  await page.goto(page.__appUrl);
  await waitForSessionActive(page);
  await installEditorProbe(page);
  await setDocumentId(page, DOCUMENT_ID);
  await waitForSessionActive(page);
  await installEditorProbe(page);
  await page.waitFor(
    (expected) => window.__qa?.probe?.refresh?.()?.state.doc.length === expected,
    { timeoutMs: 180_000, label: 'the fixture document', args: [characters] },
  );
}

async function typeInputs(page, count) {
  for (let index = 0; index < count; index += 1) await page.insertText('x');
}

/** Self-time split: each event owns its duration minus the durations of contained events. */
function selfTimes(events) {
  const byThread = new Map();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(event);
  }
  const result = [];
  for (const thread of byThread.values()) {
    thread.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const stack = [];
    for (const event of thread) {
      while (stack.length > 0 && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= event.ts) {
        stack.pop();
      }
      let childTime = 0;
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        // Only count direct children; deeper ones are already inside those.
        childTime = 0;
        if (parent.__childTime === undefined) parent.__childTime = 0;
        // Approximate: children are met in order, so adding every direct child is correct.
        parent.__childTime += event.dur;
      }
      result.push({ ...event, self: event.dur - 0, parentChild: childTime, parent: stack.length > 0 ? stack[stack.length - 1].name : null });
      stack.push(event);
    }
  }
  return result;
}

function summarize(events, window) {
  // Chrome trace timestamps and durations are microseconds; convert once, here.
  const completes = events
    .filter((event) => event.ph === 'X' && typeof event.dur === 'number')
    .map((event) => ({
      name: event.args?.data?.functionName ?? event.name,
      dur: event.dur / 1000,
      ts: event.ts / 1000,
      cat: event.cat,
      pid: event.pid,
      tid: event.tid,
    }));

  // Self time: per thread, sort by start and push a stack; a child's duration is removed from its
  // parent's self time. Accurate for the single main-thread burst that dominates input latency.
  const byThread = new Map();
  for (const event of completes) {
    const key = `${event.pid}:${event.tid}`;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(event);
  }
  for (const thread of byThread.values()) {
    thread.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const stack = [];
    for (const event of thread) {
      event.self = event.dur;
      while (stack.length > 0 && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= event.ts) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.self -= event.dur;
      stack.push(event);
    }
  }

  const byName = new Map();
  for (const event of completes) {
    const entry = byName.get(event.name) ?? {
      name: event.name,
      cat: event.cat,
      count: 0,
      total: 0,
      self: 0,
    };
    entry.count += 1;
    entry.total += event.dur;
    entry.self += Math.max(0, event.self ?? event.dur);
    byName.set(event.name, entry);
  }

  const categoryOf = (name) => {
    if (/FunctionCall|EvaluateScript|RunMicrotasks|TimerFire|v8\.|Compile|Parse|Evaluate/.test(name)) return 'scripting';
    if (/UpdateLayoutTree|Layout|RecalculateStyles|StyleRecalc/.test(name)) return 'styleLayout';
    if (/Paint|CompositeLayers|RasterTask|Commit|DrawFrame|Layerize/.test(name)) return 'paintComposite';
    if (/RunTask|ThreadControllerImpl::RunTask/.test(name)) return 'taskRoots';
    return 'other';
  };
  const categories = {};
  for (const entry of byName.values()) {
    const key = categoryOf(entry.name);
    const slot = categories[key] ?? { selfMs: 0, totalMs: 0, count: 0 };
    slot.selfMs += entry.self;
    slot.totalMs += entry.total;
    slot.count += entry.count;
    categories[key] = slot;
  }
  for (const slot of Object.values(categories)) {
    slot.selfMs = round(slot.selfMs);
    slot.totalMs = round(slot.totalMs);
  }

  const top = [...byName.values()]
    .sort((a, b) => b.self - a.self)
    .slice(0, 30)
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      totalMs: round(entry.total),
      selfMs: round(entry.self),
      category: categoryOf(entry.name),
    }));

  const serialization = completes
    .filter((event) =>
      /toString|sliceDoc|encodeStateAsUpdate|JSON\.stringify|stringify|TextEncoder|docToString|getText|encodeStateVector/.test(
        event.name,
      ),
    )
    .reduce(
      (acc, event) => {
        acc.count += 1;
        acc.totalMs += event.dur;
        acc.names[event.name] = (acc.names[event.name] ?? 0) + 1;
        return acc;
      },
      { count: 0, totalMs: 0, names: {} },
    );
  serialization.totalMs = round(serialization.totalMs);

  const runTasks = completes.filter((event) => event.name === 'RunTask');
  const longTasks = runTasks.filter((event) => event.dur >= 50);
  const longTaskDurations = longTasks.map((event) => event.dur).sort((a, b) => a - b);
  const at = (p) => (longTaskDurations.length === 0 ? null : longTaskDurations[Math.min(longTaskDurations.length - 1, Math.ceil((p / 100) * longTaskDurations.length) - 1)]);

  return {
    window,
    eventCount: events.length,
    completeCount: completes.length,
    longTasksInWindow: {
      thresholdMs: 50,
      count: longTasks.length,
      totalMs: round(longTasks.reduce((sum, event) => sum + event.dur, 0)),
      maxMs: longTaskDurations.length === 0 ? null : round(longTaskDurations[longTaskDurations.length - 1]),
      p50: at(50) === null ? null : round(at(50)),
      p95: at(95) === null ? null : round(at(95)),
      inputs: window.inputs,
    },
    traceDurationMs: round(completes.reduce((max, event) => Math.max(max, event.ts + event.dur), 0) - Math.min(...completes.map((event) => event.ts))),
    elapsedWindowMs: round(window.end - window.start),
    categories,
    top,
    serialization,
  };
}
/** CPU profile: self time per (function, url), plus a subsystem split by module URL. */
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
    const entry = byKey.get(key) ?? {
      functionName: frame.functionName || '(anonymous)',
      url: frame.url || '(native)',
      selfMs: 0,
      samples: 0,
    };
    entry.selfMs += deltaUs / 1000;
    entry.samples += 1;
    byKey.set(key, entry);
  }

  const subsystemOf = (url) => {
    if (/codemirror|@codemirror/.test(url)) return 'CodeMirror';
    if (/\/yjs|y-protocols|\/lib0/.test(url)) return 'Yjs';
    if (/react-dom|react\/|scheduler/.test(url)) return 'React';
    if (/y-indexeddb|indexeddb/.test(url)) return 'IndexedDB';
    if (/\/store\/|redux|@reduxjs/.test(url)) return 'Redux';
    if (/\/src\//.test(url)) return 'app code';
    return 'other';
  };
  const subsystems = {};
  for (const entry of byKey.values()) {
    const key = subsystemOf(entry.url);
    const slot = subsystems[key] ?? { selfMs: 0 };
    slot.selfMs += entry.selfMs;
    subsystems[key] = slot;
  }
  for (const slot of Object.values(subsystems)) slot.selfMs = round(slot.selfMs);

  const top = [...byKey.values()]
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 40)
    .map((entry) => ({
      functionName: entry.functionName,
      url: entry.url,
      selfMs: round(entry.selfMs),
      samples: entry.samples,
      sharePct: totalUs === 0 ? 0 : round((entry.selfMs / (totalUs / 1000)) * 100),
    }));

  return {
    sampleCount: profile.samples.length,
    totalProfiledMs: round(totalUs / 1000),
    subsystems,
    top,
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function trace100k() {
  const { stack, dataPath } = await startStack();
  let browser;
  let page;
  try {
    const text = fixtureText(100_000);
    const tempFixture = path.join(dataPath, 'profile-fixture.md');
    await writeFile(tempFixture, text, 'utf8');
    seedFixture(dataPath, tempFixture);
    await stack.start();

    const authz = configureAuthzFixture({ serverUrl: `http://127.0.0.1:${stack.serverPort}`, dataPath: () => stack.dataPath });
    await authz.grant(DOCUMENT_ID, DEFAULT_DEMO_USER, 'owner');

    browser = await Browser.launch({ headed: false });
    page = await newPage(browser.connection);
    page.demoUserId = DEFAULT_DEMO_USER;
    page.__appUrl = stack.appUrl;
    await page.addInitScript(`window.__qaIdentity = ${JSON.stringify(DEFAULT_DEMO_USER)};`);
    await page.addInitScript(await loadInstrumentSource());

    await openDocument(page, text.length);
    await page.click('.cm-content');
    await typeInputs(page, WARM_INPUTS);
    await sleep(50);

    const collected = [];
    page.on('Tracing.dataCollected', (params) => {
      if (Array.isArray(params.value)) collected.push(...params.value);
    });
    const tracingDone = new Promise((resolve) => {
      page.on('Tracing.tracingComplete', () => resolve());
    });

    const windowStart = Date.now();
    await page.send('Profiler.enable');
    await page.send('Profiler.start');
    await page.send('Tracing.start', {
      traceConfig: {
        includedCategories: [
          'devtools.timeline',
          'v8',
          'blink',
          'disabled-by-default-devtools.timeline',
          'devtools.timeline.frame',
        ],
      },
      transferMode: 'ReportEvents',
    });
    await typeInputs(page, TRACED_INPUTS);
    const { profile } = await page.send('Profiler.stop');
    await page.send('Tracing.end');
    await Promise.race([tracingDone, sleep(15_000)]);
    const windowEnd = Date.now();

    const summary = summarize(collected, { start: windowStart, end: windowEnd, inputs: TRACED_INPUTS });
    summary.cpu = summarizeCpu(profile);
    summary.environment = {
      chrome: browser.version.product,
      host: `${os.version?.() ?? os.release()}`,
      node: process.version,
      fixtureLines: 100_000,
      fixtureChars: text.length,
      serving: 'Vite dev (unminified names; product code unchanged)',
    };
    summary.traceBytes = Buffer.byteLength(JSON.stringify(collected));
    await mkdir(path.join(repoRoot, 'tests', 'perf', 'results'), { recursive: true });
    const out = path.join(repoRoot, 'tests', 'perf', 'results', 'profile-100k.json');
    await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
    console.log(`[profile] wrote ${out}`);
  } finally {
    if (page !== undefined) await page.close().catch(() => {});
    if (browser !== undefined) await browser.close().catch(() => {});
    await stack.dispose();
    await rm(dataPath, { recursive: true, force: true });
  }
}

async function scalingProbe() {
  const sizes = [5_000, 25_000, 50_000, 100_000];
  const rows = [];
  for (const size of sizes) {
    const { stack, dataPath } = await startStack();
    let browser;
    let page;
    try {
      const text = fixtureText(size);
      const tempFixture = path.join(dataPath, 'scaling-fixture.md');
      await writeFile(tempFixture, text, 'utf8');
      seedFixture(dataPath, tempFixture);
      await stack.start();
      const authz = configureAuthzFixture({ serverUrl: `http://127.0.0.1:${stack.serverPort}`, dataPath: () => stack.dataPath });
      await authz.grant(DOCUMENT_ID, DEFAULT_DEMO_USER, 'owner');

      browser = await Browser.launch({ headed: false });
      page = await newPage(browser.connection);
      page.demoUserId = DEFAULT_DEMO_USER;
      page.__appUrl = stack.appUrl;
      await page.addInitScript(`window.__qaIdentity = ${JSON.stringify(DEFAULT_DEMO_USER)};`);
      await page.addInitScript(await loadInstrumentSource());
      await page.addInitScript(PERF_INIT_SCRIPT);
      await openDocument(page, text.length);
      await page.click('.cm-content');
      await typeInputs(page, 5);

      const samples = await page.evaluate(async () => {
        const out = [];
        const content = document.querySelector('.cm-content');
        for (let index = 0; index < 20; index += 1) {
          const started = performance.now();
          content.dispatchEvent(new Event('noop'));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          out.push(performance.now() - started);
        }
        return out;
      });
      // The loop above measures frame cadence; the authoritative per-input figure comes from
      // window.__perf.input, so read that after 20 real inputs.
      await page.evaluate(() => {
        window.__perf.input.length = 0;
      });
      for (let index = 0; index < 20; index += 1) await page.insertText('x');
      await sleep(50);
      const measured = await page.evaluate(() => window.__perf.input.map((sample) => sample.inputToNextFrameMs));
      const clean = measured.filter((value) => typeof value === 'number');
      clean.sort((a, b) => a - b);
      const at = (p) => clean[Math.min(clean.length - 1, Math.ceil((p / 100) * clean.length) - 1)];
      rows.push({
        size,
        chars: text.length,
        samples: clean.length,
        p50: round(at(50)),
        p95: round(at(95)),
        max: round(clean[clean.length - 1]),
      });
      void samples;
      console.log(`[scaling] ${size} lines: p50=${rows[rows.length - 1].p50} p95=${rows[rows.length - 1].p95} max=${rows[rows.length - 1].max}`);
    } finally {
      if (page !== undefined) await page.close().catch(() => {});
      if (browser !== undefined) await browser.close().catch(() => {});
      await stack.dispose();
      await rm(dataPath, { recursive: true, force: true });
    }
  }
  const out = path.join(repoRoot, 'tests', 'perf', 'results', 'scaling-probe.json');
  await writeFile(out, `${JSON.stringify({ sizes, rows, note: 'diagnostic scaling probe, 20 inputs per size; not a benchmark claim' }, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(rows, null, 2));
}

const scaling = process.argv.includes('--scaling');
if (scaling) await scalingProbe();
else await trace100k();
