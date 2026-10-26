/**
 * Aggregate several independent `run.mjs` results into one multi-round baseline.
 *
 * Each `run.mjs` measures one process (ready, 3×100 inputs, 3 reconnects). This script answers the
 * question a single run cannot: how stable are the numbers across rounds? It reports nearest-rank
 * p50/p95/max over the pooled samples and keeps every per-run value, so a cold first run is visible
 * instead of averaged away.
 *
 * Input:  tests/perf/results/perf-run-*.json
 * Output: tests/perf/results/perf-baseline-100k-multiround.json
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = 'tests/perf/results';
const prefix = process.argv[2] ?? 'perf-run';
const outputName =
  process.argv[3] ?? (prefix === 'perf-run' ? 'perf-baseline-100k-multiround.json' : `${prefix}-multiround.json`);
const pattern = new RegExp(`^${prefix}-\\d+\\.json$`);
const files = readdirSync(dir)
  .filter((name) => pattern.test(name))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
if (files.length === 0) throw new Error(`no ${prefix}-*.json to aggregate`);

const runs = files.map((file) => ({
  file,
  payload: JSON.parse(readFileSync(path.join(dir, file), 'utf8')),
}));

/** Nearest-rank percentile over an ascending array (same convention as run.mjs). */
function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1],
    mean: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 100) / 100,
  };
}

const ready = stats(runs.map((run) => run.payload.results.ready.durationMs));
const inputModel = stats(
  runs.flatMap((run) => run.payload.results.input.roundStats.flatMap((round) => round.samples.map((s) => s.inputToModelMs))),
);
const inputFrame = stats(
  runs.flatMap((run) =>
    run.payload.results.input.roundStats.flatMap((round) => round.samples.map((s) => s.inputToNextFrameMs)),
  ),
);
const reconnectRestore = stats(
  runs.flatMap((run) => run.payload.results.reconnect.samples.map((s) => s.restoreToConnectedMs)),
);
const reconnectOffline = stats(
  runs.flatMap((run) => run.payload.results.reconnect.samples.map((s) => s.offlineToConnectedMs)),
);
const firstWebSocket = stats(
  runs
    .map((run) => run.payload.results.firstWebSocket?.connectedAfterNavigationMs)
    .filter(Number.isFinite),
);
const longTasks = runs.map((run) => ({
  run: Number(run.file.match(/\d+/)[0]),
  count: run.payload.results.longTasks.count,
  totalDurationMs: run.payload.results.longTasks.totalDurationMs,
  maxDurationMs: run.payload.results.longTasks.maxDurationMs,
  p50: run.payload.results.longTasks.p50Ms,
  p95: run.payload.results.longTasks.p95Ms,
}));
const redux = runs.map((run) => ({ run: Number(run.file.match(/\d+/)[0]), ...run.payload.results.redux }));
const last = runs[runs.length - 1].payload;

const aggregate = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceType: 'multi-round current baseline; no PASS/FAIL thresholds',
  caution:
    last.servingMode?.startsWith('build')
      ? 'Local Windows host, built server + built web (Express static, no Vite) for interaction timing; bundle sizes come from the same production build. Not production P95. Long Tasks and Redux inspection are test instrumentation.'
      : 'Local Windows host, Vite dev server for interaction timing; bundle sizes come from the production build. Not production P95. Long Tasks and Redux inspection are test instrumentation.',
  git: last.git,
  host: last.host,
  chrome: last.chrome,
  fixture: last.fixture,
  rounds: runs.length,
  perRun: runs.map((run) => ({
    run: Number(run.file.match(/\d+/)[0]),
    generatedAt: run.payload.generatedAt,
    readyMs: run.payload.results.ready.durationMs,
    firstWebSocketMs: run.payload.results.firstWebSocket?.connectedAfterNavigationMs ?? null,
    inputModel: run.payload.results.input.model,
    inputFrame: run.payload.results.input.nextFrame,
    reconnect: run.payload.results.reconnect.restoreToConnectedMs,
    longTasks: run.payload.results.longTasks,
    memory: run.payload.results.memory,
    redux: run.payload.results.redux,
  })),
  aggregate: {
    readyMs: ready,
    inputModelMs: inputModel,
    inputFrameMs: inputFrame,
    firstWebSocketMs: firstWebSocket,
    reconnectRestoreMs: reconnectRestore,
    reconnectOfflineMs: reconnectOffline,
    longTasks,
    redux: {
      allAvailable: redux.every((entry) => entry.available === true),
      allBodyAbsent: redux.every(
        (entry) => entry.containsFixtureMarker === false && entry.containsLine99999 === false,
      ),
      stateBytes: redux.map((entry) => entry.bytes),
      keys: redux[0]?.keys ?? [],
    },
  },
  sampleCounts: {
    ready: ready?.count ?? 0,
    input: inputFrame?.count ?? 0,
    reconnect: reconnectRestore?.count ?? 0,
    longTaskRuns: longTasks.length,
  },
  bundle: last.results.bundle,
  memory: last.results.memory,
  chromeVersion: last.chrome.product,
};

const output = path.join(dir, outputName);
writeFileSync(output, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(aggregate.aggregate, null, 2));
console.log(`wrote ${output}`);
