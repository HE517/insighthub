# Performance Evidence Gate — 100k multi-round current baseline

**Product commit**: `01d3963` (product code unchanged since `9f4879f`; this run adds only
`tests/perf/**` and the Redux instrumentation) · **Date**: 2026-10-26 · **Runs**: 3 independent
processes · **No PASS/FAIL thresholds** (first round is a baseline, not an optimisation claim).

| Environment | Value |
| --- | --- |
| Host | Windows 11 Home China 10.0.26200 · i5-1340P · 15.7 GiB · Node v22.14.0 |
| Browser | **Chrome/155.0.8059.85**, headless |
| Fixture | **100,000 lines** · 6,788,895 chars/bytes · `sha256 0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c` |
| Operation sequence | goto → switch to `a6-perf-100k` → wait for model length → 3×100 real `Input.insertText("x")` at the start → 3 offline/reconnect cycles → Long Tasks / memory / Redux snapshot → bundle from the production build |
| Samples | ready n=3 · input n=**900** (3 runs × 3 rounds × 100) · reconnect n=**9** · Long Task runs n=3 |
| Raw data | `tests/perf/results/perf-run-1..3.json`, `tests/perf/results/perf-baseline-100k-multiround.json` |

## Numbers

| Metric | p50 | p95 | max | n | Note |
| --- | --- | --- | --- | --- | --- |
| **document/editor ready** | **1845 ms** | **6301 ms** | **6301 ms** | 3 | min 1531 ms; run 1 was a cold first process (6301), runs 2/3 = 1845/1531 — kept, not averaged away |
| **input latency (model)** | **283.3 ms** | **422.0 ms** | **592.5 ms** | 900 | beforeinput → editor transaction complete |
| **input latency (next frame)** | **284.2 ms** | **423.0 ms** | **593.8 ms** | 900 | beforeinput → next animation frame |
| **first WebSocket connected** | 1231 ms | 5721 ms | 5721 ms | 3 | after navigation; run 1 cold |
| **WS reconnect (restore→connected)** | **772 ms** | **780 ms** | **780 ms** | 9 | 250 ms outage |
| **WS reconnect (offline→connected)** | 1035 ms | 1043 ms | **1043 ms** | 9 | includes the held outage |

### Long Tasks (test instrumentation, not production telemetry)

| Run | count | total duration | max | p50 | p95 |
| --- | --- | --- | --- | --- | --- |
| 1 | 399 | 114,626 ms | 655 ms | 262 ms | 447 ms |
| 2 | 394 | 122,671 ms | 592 ms | 294 ms | 414 ms |
| 3 | 398 | 123,084 ms | 491 ms | 297 ms | 400 ms |

The counts include the benchmark's own 900 input transactions; they are an observation about this
100k document, not a threshold.

### Bundle / chunks (production build, `node:zlib`)

| File | raw | gzip |
| --- | --- | --- |
| `index-lKQ_6B_M.js` | 970,442 B | 317,000 B |
| `ClerkRoot-*.js` (lazy) | 85,786 B | 22,694 B |
| `y-indexeddb-*.js` (lazy) | 2,913 B | 1,271 B |
| **Total (3 JS)** | **1,059,141 B** | **340,965 B** |

### Memory

`AVAILABLE` via Chrome's non-standard `performance.memory`; 5 samples/run, 200 ms apart.
Peak sampled **46,211,761 B**, min 46,206,473 B, heap limit 4,395,630,592 B. Reported as sampled,
not as a peak guarantee.

## Dynamic assertion — the 100k body is not mirrored into Redux

After the 300 input transactions, the harness walks the React fiber tree to the `Provider` store,
serialises `store.getState()`, and checks the body markers:

| Run | state size | keys | contains fixture text |
| --- | --- | --- | --- |
| 1 | 241 B | `connection`, `document`, `realtime` | **false** |
| 2 | 241 B | same | **false** |
| 3 | 241 B | same | **false** |

**PASS**: a 6.8 MB document produces a 241-byte Redux state with no body content. This is the
behavioural counterpart of the static rule "content lives only in `Y.Text`" (`AGENTS.md` R11).

## Flake status

- 3/3 runs exited 0; no scenario/test flake in this gate.
- Run 1's ready (6301 ms) and first WebSocket (5721 ms) are **cold-process outliers**, recorded
  separately rather than trimmed.
- Two harness fixes were needed and are part of this commit: the seed must use the `DevStack`'s
  actual data directory, and a non-5173 Vite port needs an explicit `CORS_ORIGIN` (otherwise the
  bootstrap/WS are 403).

## Caveats (read before citing)

- Interaction timing runs against the **Vite dev server**; bundle sizes come from the production
  build. They must not be combined into a single "production P95".
- **Production performance is NOT VERIFIED**; Render Free cold start/shared CPU is not a
  production P95.
- There is **no trustworthy pre-optimization commit**, so this report contains **no before/after
  comparison**.
- Long Tasks, memory and the Redux inspection are **test instrumentation**, not production
  telemetry.

## Files

- `tests/perf/fixture.mjs` — deterministic generator + sha256
- `tests/perf/seed.mjs` — server-side seed through `openDocumentStore` + `Y.Doc`
- `tests/perf/instrument.mjs` — Long Task observer, input timing, offline socket, Redux snapshot
- `tests/perf/run.mjs` — one round: real server + Vite + Chrome, writes JSON/report
- `tests/perf/aggregate.mjs` — pools N runs into p50/p95/max
- `tests/perf/results/perf-run-1..3.json`, `perf-baseline-100k-multiround.json`
