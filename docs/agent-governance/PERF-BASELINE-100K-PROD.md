# Performance Evidence Gate — local production-build vs dev-mode baseline (100k)

Same host, same Chrome, same fixture, same operation sequence and sample counts as the dev-mode
baseline. Only the **serving path** differs:

| Run mode | What serves the page | What this is |
| --- | --- | --- |
| `dev` | Vite dev server (on-demand module transform) + `tsx` server | development baseline |
| `build` | **`apps/server/dist/index.js`** serving **`apps/web/dist`** (Express static), no Vite | local production-build baseline |

Neither is a production P95: Render Free is not used, TLS/Clerk are not in this path, and the
product code is unchanged between the two groups. **This is not a before/after optimisation
comparison** — there is no pre-optimization commit, and no optimisation was applied.

**Product commit**: `01d3963` (unchanged) · **Host**: Windows 11 10.0.26200 · i5-1340P · 15.7 GiB ·
**Chrome/155.0.8059.85** · Node v22.14.0
**Fixture**: 100,000 lines / 6,788,895 chars · sha256 `0d12688d…` (identical in both groups)
**Samples**: 3 runs each; input 900 (3×3×100); reconnect 9; Long Task 3 runs each.

## Side by side

| Metric | dev-mode (p50 / p95 / max) | local production-build (p50 / p95 / max) |
| --- | --- | --- |
| editor ready | 1845 / **6301** / 6301 ms | **654 / 680 / 680 ms** |
| input latency (model) | 283.3 / 422.0 / 592.5 ms | **268.8 / 371.3 / 511.4 ms** |
| input latency (next frame) | 284.2 / 423.0 / 593.8 ms | 269.6 / 372.3 / 512.3 ms |
| first WebSocket connected | 1231 / 5721 / 5721 ms | **223 / 264 / 264 ms** |
| WS reconnect (restore→connected) | 772 / 780 / 780 ms | **763 / 770 / 770 ms** |
| WS reconnect (offline→connected) | 1035 / 1043 / 1043 ms | **1024 / 1033 / 1033 ms** |

### Long Tasks (test instrumentation)

| Group | per-run count | per-run total | per-run max |
| --- | --- | --- | --- |
| dev | 399 / 394 / 398 | 114,626 / 122,671 / 123,084 ms | 655 / 592 / 491 ms |
| build | 400 / 397 / 397 | 110,880 / 114,695 / 112,771 ms | 430 / 454 / 511 ms |

### Bundle (production build; identical artifact in both groups)

| File | raw | gzip |
| --- | --- | --- |
| `index-Dm35hFbk.js` | 970,271 B | 316,847 B |
| `ClerkRoot-*.js` (lazy) | 85,786 B | 22,693 B |
| `y-indexeddb-*.js` (lazy) | 2,913 B | 1,271 B |
| **Total** | **1,058,970 B** | **340,811 B** |

### Memory (sampled, Chrome non-standard `performance.memory`)

- dev: peak sampled 46,211,761 B
- build: peak sampled **62,111,484 B** (5 samples, 200 ms apart)

`diagnostic sampled values only; cross-mode difference not causally attributed` — `performance.memory`
is non-standard and sampled, and the current data does not support a causal claim about the
difference.

### Redux no-body-mirror assertion (dynamic)

All 3 build runs: state **241 B**, keys `connection`/`document`/`realtime`, **no fixture marker and
no `line-99999:`** in the serialized state. Same result as the dev runs.

## What the difference means (and does not mean)

- The build path is faster on every metric, but this is a **serving-path difference**, not an
  optimisation: dev serves unbundled modules and transforms on demand; build serves one bundled
  file. Nothing in CodeMirror/Yjs/Redux changed.
- Ready p95 680 ms vs 6301 ms is dominated by run 1 of the dev group being a cold process; the
  dev min (1531 ms) is the fairer comparison point against the build p50 (654 ms).
- Long Task counts remain high in both groups (~397–400 per run, including the benchmark's 900
  input transactions). **This is an observation, not a verdict**; if it is worth reducing, the next
  step is a trace/profile to find the top contributors, not a speculative CodeMirror/Yjs edit.

## Claims

Now supportable:

- a deterministic 100,000-line benchmark exists and is reproducible (fixture sha256);
- a 100k document loads and is editable in both dev and production-build serving paths;
- Redux does not hold the Markdown body (241 B state, dynamic check);
- reconnect has measured data (n=9 per group).

Still **not** supportable:

- production P95 (no production deployment measurement);
- "performance optimised" or "before/after improvement X%" (no optimisation was made);
- any SLO for 100k input latency.

## Files

- `tests/perf/build-stack.mjs` — built server + built web on one origin, no Vite
- `tests/perf/run.mjs --build` — same measurement flow, fiber-reached `EditorView` instead of the
  dev-only module probe
- `tests/perf/aggregate.mjs` — pools N runs (prefix argument)
- `tests/perf/results/perf-prod-run-1..3.json`, `perf-production-multiround.json`
