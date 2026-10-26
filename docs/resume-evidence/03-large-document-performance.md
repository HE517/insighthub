# 03 · Large-Document Performance and State Isolation

**Evidence commit:** `874f107` · **Report:** 03/05 · **Date:** 2026-10-26 · **Nature:** docs-only

This is the most number-heavy report. Read §2 before quoting any number: **none of them is a
production P95**, and no optimisation was applied.

---

## 1. Resume Claim

> 面向大文档场景隔离编辑器高频状态与 Redux，全量正文不进入全局状态；在 10 万行 / 约 6.8 MB Markdown 基准下，Redux state 约 241 B，本地 production build 编辑器 ready P95 680 ms、WebSocket 重连 P95 770 ms。

The sentence is unusually precise and, as written, defensible: it says **本地 production build**
(local production-build path), not "production". Keep that qualifier; removing it turns a measured
number into a false claim.

---

## 2. What It Means

**产品能力.** A 100,000-line / ~6.8 MB Markdown document opens, is editable, and reconnects in a
browser without the document body entering global state. The user-visible promise is *"a very large
document still opens and accepts typing"*, not *"typing is fast"*: the measured input p95 is
371.3 ms on this pathological fixture, which is far from a smooth-editor SLO.

**架构设计.** The body lives only in `Y.Text`; Redux holds `activeDocumentId`, metadata and UI
state. High-frequency editor state (text, selection, presence) stays inside the session/editor
layer. This is the same invariant as `AGENTS.md` R11, measured dynamically instead of asserted.

**测试证据.** A deterministic fixture with a sha256, a benchmark harness that drives real Chrome,
real input events and real WebSocket reconnects, three independent runs, and a dynamic Redux
snapshot taken through the React fiber tree. The harness sets **no PASS/FAIL threshold** — it is a
baseline, not a release gate.

**性能数据.** Local production-build path (built server + built web, Express static, no Vite) on one
Windows 11 laptop: ready p50/p95/max **654 / 680 / 680 ms** (n=3), reconnect **763 / 770 / 770 ms**
(n=9), Redux **241 B**. The dev-server comparison and the pathological input profile are included
below as diagnostics, not as resume numbers.

---

## 3. How It Is Implemented

### A. Why the Markdown body never enters Redux

`documentSlice` allows exactly three fields: `activeDocumentId`, `metadata` (server metadata for
rendering) and `pendingDocumentId` (the switcher's draft). Its header states the rule and forbids a
`content` / `markdown` / `text` field (`documentSlice.ts:1-35`). `metadata` is `DocumentMeta | null`
— title/id/timestamps, not body (`documentSlice.ts:28-35`). Role is deliberately absent as well
(`documentSlice.ts:15-22`).

`realtimeSlice` keeps at most 20 **control** messages (`MAX_LOG = 20`) for diagnostics
(`realtimeSlice.ts:11-36`); it never carries a Yjs update or a body string.

Ownership is therefore one-way:

```text
Y.Doc / Y.Text  ──owns──▶  document body
     │
     ├── editor view (CodeMirror state, ephemeral, derived)
     ├── IndexedDB replica (encoded Yjs updates)
     └── WebSocket binary sync

Redux  ──owns──▶  activeDocumentId · metadata · pendingDocumentId · connection/realtime UI
```

The dynamic proof is in the harness: after 300 real `Input.insertText("x")` transactions, it walks
the React fiber tree to the Redux `Provider`, serialises `store.getState()`, and checks for the
fixture line template and `line-99999:` (`instrument.mjs:94-141`). All three build runs:
**241 B**, keys `connection` / `document` / `realtime`, both markers `false`
(`PERF-BASELINE-100K-PROD.md:56-59`).

Why this design: putting a 6.8 MB body in Redux would make every keystroke a global store update
and create a second source of truth to reconcile with Yjs. Keeping the body out is why a 100k
document is usable at all with a 241-byte store.

### B. The fixture is deterministic, not "a big file we found"

`tests/perf/fixture.mjs` builds the document from a fixed template and a 1-based line number:

- **100,000 lines** (`LINE_COUNT = 100_000`, `fixture.mjs:20-21`);
- line template `line-<i>: The quick brown fox jumps over the lazy dog 0123456789.`
  (`fixture.mjs:26-27`);
- joined with single `\n`s plus a trailing newline (`fixture.mjs:37-43,102`);
- **6,788,895 characters / bytes**;
- **sha256 `0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c`**.

The generator is run twice in-process and both digests must match, and the checked-in file is
re-hashed; any mismatch is a hard error (`fixture.mjs:57-88`). I re-verified the committed file at
`874f107` with `Get-FileHash` / byte length: 6,788,895 bytes, 6,788,895 chars, 100,000 newlines,
same sha256. The official pathological fixture is `tests/perf/fixtures/100k-lines.md`.

A second, **generated-not-committed** block-structured variant (same 100k lines, 6,859,314 chars,
sha256 `294af99d…`) exists only to quantify how much of the cost is the fixture's structure
(`PROFILE-100K-BLOCK.md:6-14`). It does not replace the official fixture.

### C. Measurement method

The harness is five scripts, all committed:

| Script | Role |
| --- | --- |
| `fixture.mjs` | deterministic 100k fixture + double-generation sha256 check |
| `seed.mjs` | seeds the document through the real `openDocumentStore` + `Y.Doc` |
| `instrument.mjs` | test-only `PerformanceObserver` for Long Tasks, input timing, offline socket wrapper, Redux snapshot, memory |
| `run.mjs` | one round: real server + browser, 3×100 inputs, 3 reconnects, writes JSON/report |
| `aggregate.mjs` | pools N runs with nearest-rank p50/p95/max, keeps per-run values |
| `build-stack.mjs` | built `apps/server/dist/index.js` serving `apps/web/dist` (Express static, no Vite) |

**Topology and sample counts** (`PERF-BASELINE-100K-PROD.md:15-18,22-29`):

- 3 independent harness processes; each does 3 rounds × 100 real `Input.insertText("x")` at the
  start of the document → **input n = 900**;
- 3 offline/reconnect cycles per run → **reconnect n = 9** (250 ms outage);
- ready n = 3; Long Task runs n = 3; one dynamic Redux snapshot per run;
- environment: Windows 11 10.0.26200, i5-1340P, 15.7 GiB, Node v22.14.0, Chrome **155.0.8059.85**
  headless.

**What "local production build" means** (`build-stack.mjs:1-12`, `PERF-BASELINE-100K-PROD.md:6-13`):
the built server serves the built web assets on one origin; `NODE_ENV` stays unset so the demo
bootstrap is available; there is **no TLS, no Clerk, no Render** and no production deployment. It is
a serving-path comparison (bundled vs Vite on-demand), not a hardware or production comparison.

**Timing definitions** (`PERF-BASELINE-100K-MULTIROUND.md:12-13,20-25`): ready = navigation → editor
model holds the document; input = `beforeinput` → editor transaction complete (and separately →
next animation frame); reconnect = restore/offline → `connected`. Percentiles are nearest-rank;
with n=3 the p95 is effectively the maximum, and with n=9 it is near the maximum. That is why the
raw min/p50/max are all reported, not just the p95.

### D. The numbers

**Local production build** (`PERF-BASELINE-100K-PROD.md:22-29`):

| Metric | p50 | p95 | max | n |
| --- | ---: | ---: | ---: | ---: |
| editor ready | **654 ms** | **680 ms** | 680 ms | 3 (per-run 680/654/632) |
| input latency (model) | 268.8 ms | **371.3 ms** | 511.4 ms | 900 |
| input latency (next frame) | 269.6 ms | 372.3 ms | 512.3 ms | 900 |
| first WebSocket connected | 223 ms | 264 ms | 264 ms | 3 |
| WS reconnect (restore→connected) | 763 ms | **770 ms** | 770 ms | 9 |
| WS reconnect (offline→connected) | 1024 ms | 1033 ms | 1033 ms | 9 |

**Same harness on the dev server** (the comparison group, not a resume number;
`PERF-BASELINE-100K-MULTIROUND.md:18-25`):

| Metric | p50 | p95 | max | n |
| --- | ---: | ---: | ---: | ---: |
| editor ready | 1845 ms | 6301 ms | 6301 ms | 3 (min 1531; run 1 cold) |
| input latency (model) | 283.3 ms | 422.0 ms | 592.5 ms | 900 |
| first WebSocket connected | 1231 ms | 5721 ms | 5721 ms | 3 |
| WS reconnect (restore→connected) | 772 ms | 780 ms | 780 ms | 9 |
| WS reconnect (offline→connected) | 1035 ms | 1043 ms | 1043 ms | 9 |

**Long Tasks (test instrumentation only; 3 runs each)** (`PERF-BASELINE-100K-PROD.md:31-36`):

| Group | count per run | total per run | max per run |
| --- | --- | --- | --- |
| local production build | **400 / 397 / 397** | 110,880 / 114,695 / 112,771 ms | 430 / 454 / 511 ms |
| dev | 399 / 394 / 398 | 114,626 / 122,671 / 123,084 ms | 655 / 592 / 491 ms |

The counts are high in **both** groups (≈397–400 per run, including the benchmark's own 900 input
transactions). This is an observation, not a verdict. It is included here precisely because the
resume bullet omits it: the document is usable, but each input still lands in a ~370 ms p95
interaction, and there is roughly one Long Task per keystroke on the pathological fixture.

**Redux / bundle / memory**:

| Item | Value | Source |
| --- | --- | --- |
| Redux state after 300 inputs | **241 B**, keys `connection`/`document`/`realtime`, no body markers (3/3 runs) | `PERF-BASELINE-100K-PROD.md:56-59` |
| main JS bundle | `index-Dm35hFbk.js` 970,271 B raw / 316,847 B gzip | `PERF-BASELINE-100K-PROD.md:38-45` |
| lazy chunks | `ClerkRoot` 85,786 / 22,693; `y-indexeddb` 2,913 / 1,271 | same |
| total JS | 1,058,970 B raw / 340,811 B gzip | same |
| memory (sampled) | build peak 62,111,484 B (5 samples, 200 ms apart); dev peak 46,211,761 B | `PERF-BASELINE-100K-PROD.md:47-54` |

Memory is explicitly **diagnostic sampled data**, using Chrome's non-standard
`performance.memory`; the cross-mode difference is not causally attributed
(`PERF-BASELINE-100K-PROD.md:52-54`).

### E. Profiling: where the 250–500 ms actually goes

`PROFILE-100K.md` traces 20 real inputs on a warm 100k editor with CDP `Tracing` + `Profiler`
(test-only), and attributes:

- **CodeMirror Markdown inline parser ≈ 89.6 % of profiled JS time**: 5,368.3 ms of 5,987.7 ms;
  `finishLeaf` 40.5 %, `parseInline` 36.6 %, `HardBreak` 5.1 % (`PROFILE-100K.md:17-20`);
- **≈268 ms per input**, and **21 Long Tasks ≥ 50 ms for 20 inputs** (p50 264.8 ms, p95 278.1 ms,
  max 282.2 ms; 93 % of the traced window) (`PROFILE-100K.md:20`);
- scaling probe (20-input p50): **16 ms @ 5k → 70 ms @ 25k → 586 ms @ 50k → 1182 ms @ 100k** —
  super-linear (`PROFILE-100K.md:19`);
- style 0.23 %, paint 0.17 %, React 4.2 ms / 0.07 %: negligible (`PROFILE-100K.md:21-23`).

The **amplifier is the fixture's structure** (must be stated): the 100,000 lines are joined with
single `\n`s and no blank lines, so CommonMark treats the whole 6.8 MB as **one paragraph**; an
inline parser re-examines that paragraph when an edit invalidates its inline context
(`PROFILE-100K.md:43-48`). To test that explanation, the block-structured variant (same 100k lines,
real headings/blank-line paragraphs/lists/code fences) measures:

- ready **453 / 458 / 458 ms** (n=3);
- input model p50 **2.2–2.6 ms**, p95 **3.1–3.7 ms**, max ≤ 7.3 ms per round;
- Long Tasks **1–2 per 300 inputs**; max 107–126 ms;
- CPU profile: **no function above 0.7 %**; 72.8 % idle (`PROFILE-100K-BLOCK.md:18-28`).

This is a **fixture-structure effect, not a product optimisation**. The official pathological
fixture is unchanged and remains the baseline. It does not justify a parser guard: with realistic
block structure there is no product-level input-latency problem at 100k lines
(`PROFILE-100K-BLOCK.md:41-46`).

**What is explicitly not claimed:** no optimisation was made; there is no trustworthy
pre-optimisation commit; therefore there is **no "before → after" and no "X % faster"**
(`PERF-BASELINE-100K-PROD.md:12-13`, `PERF-BASELINE-100K-MULTIROUND.md:82-83`,
`CAPABILITY-EVIDENCE-INVENTORY.md:41`). The local-build vs dev comparison is a serving-path
difference (bundled vs on-demand transform), not an optimisation.

---

## 4. Source Code Locations

**Evidence commit:** `874f107`. Permalinks pinned to that SHA.

| Location | Responsibility | Symbol | Permalink |
| --- | --- | --- | --- |
| `apps/web/src/store/documentSlice.ts:1-35` | the allowed presentation fields; no body / markdown / text | `DocumentState` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/store/documentSlice.ts#L1-L35 |
| `apps/web/src/store/realtimeSlice.ts:11-36` | bounded control-message log (max 20); no body | `MAX_LOG`, `serverMessageReceived` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/store/realtimeSlice.ts#L11-L36 |
| `apps/web/src/collab/internal/document-session.ts:474-475` | the one `Y.Doc` / `Y.Text` that owns content | `new Y.Doc`, `doc.getText` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/internal/document-session.ts#L474-L475 |
| `apps/web/src/features/editor/collabTextBinding.ts:176-202` | local edits go straight into `Y.Text` in one transaction | `writeLocalChanges` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/collabTextBinding.ts#L176-L202 |
| `tests/perf/fixture.mjs:20-43` | 100k line count, fixed template, deterministic build | `LINE_COUNT`, `buildFixtureText` | https://github.com/HE517/insighthub/blob/874f107/tests/perf/fixture.mjs#L20-L43 |
| `tests/perf/fixture.mjs:57-103` | double-generation sha256 + on-disk check | `ensureFixture` | https://github.com/HE517/insighthub/blob/874f107/tests/perf/fixture.mjs#L57-L103 |
| `tests/perf/instrument.mjs:94-141` | fiber → Redux store → serialise → body-marker check | `perf.reduxSnapshot` | https://github.com/HE517/insighthub/blob/874f107/tests/perf/instrument.mjs#L94-L141 |
| `tests/perf/instrument.mjs:144-168` | `PerformanceObserver({type:'longtask'})`, test-only | Long Task observer | https://github.com/HE517/insighthub/blob/874f107/tests/perf/instrument.mjs#L144-L168 |
| `tests/perf/run.mjs:1-27` | harness contract: no thresholds; real input/reconnect | module doc | https://github.com/HE517/insighthub/blob/874f107/tests/perf/run.mjs#L1-L27 |
| `tests/perf/run.mjs:43-51` | 3 rounds, 100 inputs/round, 3 reconnects | `INPUT_ROUNDS`, `INPUTS_PER_ROUND`, `RECONNECT_ITERATIONS` | https://github.com/HE517/insighthub/blob/874f107/tests/perf/run.mjs#L43-L51 |
| `tests/perf/aggregate.mjs:30-43` | nearest-rank p50/p95/max over pooled runs | `stats` | https://github.com/HE517/insighthub/blob/874f107/tests/perf/aggregate.mjs#L30-L43 |
| `tests/perf/build-stack.mjs:1-19` | built server + built web, Express static, no Vite | `BuildStack` | https://github.com/HE517/insighthub/blob/874f107/tests/perf/build-stack.mjs#L1-L19 |
| `tests/perf/profile.mjs` | trace + CPU profile over a fixed 20-input window; `--scaling` probe | — | https://github.com/HE517/insighthub/blob/874f107/tests/perf/profile.mjs |
| `tests/perf/block-benchmark.mjs` | block-structured variant measurement + CPU profile | — | https://github.com/HE517/insighthub/blob/874f107/tests/perf/block-benchmark.mjs |

The numbers live in committed JSON: `tests/perf/results/perf-prod-run-1..3.json`,
`perf-production-multiround.json`, `perf-run-1..3.json`, `perf-baseline-100k-multiround.json`,
`profile-100k.json`, `scaling-probe.json`, `perf-block-run-1..3.json`.

---

## 5. How It Was Tested

This is a **benchmark harness**, not a PASS/FAIL gate. It is still a test in the audit sense: it
starts real processes, drives real input, and writes raw JSON that a reviewer can re-aggregate.

| Evidence run | Command (as recorded) | Result | Asserts / produces |
| --- | --- | --- | --- |
| 3-run dev baseline | `node tests/perf/run.mjs` ×3, then `node tests/perf/aggregate.mjs` | 3/3 runs exited 0; no scenario/test flake in this gate (`PERF-BASELINE-100K-MULTIROUND.md:69-71`) | fixture sha256 twice; ready/input/reconnect samples; Long Tasks; Redux snapshot; bundle/memory |
| 3-run local production build | `node tests/perf/run.mjs --build` ×3, `aggregate.mjs perf-prod-run perf-production-multiround.json` | 3 runs; same fixture and operation sequence; only the serving path differs (`PERF-BASELINE-100K-PROD.md:3-18`) | same metrics on the built path; Redux 241 B in all 3 runs |
| input-path profile | `node tests/perf/profile.mjs` | one diagnostic trace over 20 inputs | CPU profile attribution (89.6 % Markdown inline), Long Task count, scaling probe |
| block-structured comparison | `node tests/perf/block-benchmark.mjs` | 3 runs, generated fixture | shows the pathological cost is fixture structure, not 100k Markdown in general |

**What it proves.** A deterministic 100k fixture exists and is reproducible (sha256, double
generation); a 100k document loads and is editable in both the dev and built serving paths; Redux
does not contain the body after 300 real inputs; reconnect has measured data (n=9 per group).

**What it does not prove.** It does not set or meet an SLO; it does not compare before/after; it
does not measure production; and its Long Task / memory / Redux probes are harness instrumentation,
not application telemetry (`PERF-BASELINE-100K-MULTIROUND.md:27-36,76-85`).

---

## 6. Measured Evidence — audit table

Every resume number, with its exact source:

| Claim element | Value | Source file | Basis |
| --- | --- | --- | --- |
| fixture size | 100,000 lines; 6,788,895 chars/bytes | `PERF-BASELINE-100K-MULTIROUND.md:11`; verified on disk at `874f107` | generator + `Get-FileHash` |
| fixture identity | `0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c` | `PERF-BASELINE-100K-MULTIROUND.md:11`; `tests/perf/fixture.mjs:57-103` | sha256 of generated + checked-in file |
| Redux state | **241 B**; keys `connection`, `document`, `realtime`; no fixture marker / `line-99999:` | `PERF-BASELINE-100K-PROD.md:56-59`; raw `perf-production-multiround.json` → `aggregate.redux` | dynamic fiber→store snapshot after 300 inputs |
| editor ready (resume) | p50 654 / **p95 680** / max 680 ms, n=3 | `PERF-BASELINE-100K-PROD.md:24`; raw `perf-production-multiround.json` → `aggregate.readyMs` | 3 independent runs, nearest-rank |
| reconnect (resume) | p50 763 / **p95 770** / max 770 ms, n=9 | `PERF-BASELINE-100K-PROD.md:28`; raw `aggregate.reconnectRestoreMs` | 3 runs × 3 reconnects, 250 ms outage |
| input latency (not on resume) | p50 268.8 / p95 371.3 / max 511.4 ms, n=900 | `PERF-BASELINE-100K-PROD.md:25` | 3 runs × 3 rounds × 100 inputs |
| Long Tasks (not on resume) | 400 / 397 / 397 per run; max 430 / 454 / 511 ms | `PERF-BASELINE-100K-PROD.md:35-36` | test-only `PerformanceObserver` |
| dev comparison | ready 1845 / 6301 / 6301; input p95 422.0; reconnect p95 780 | `PERF-BASELINE-100K-MULTIROUND.md:18-33` | same harness, Vite dev server |
| profile | 89.6 % Markdown inline; 21 Long Tasks / 20 inputs; 16→70→586→1182 ms p50 scaling | `PROFILE-100K.md:17-20` | CDP trace + CPU profile, 20 inputs |
| block variant | input p50 2.2–2.6, p95 3.1–3.7 ms; 1–2 Long Tasks / 300 inputs | `PROFILE-100K-BLOCK.md:18-28` | built path, generated fixture |

**Statistical caveat.** These are nearest-rank percentiles over small samples: n=3 for ready, n=9
for reconnect. A p95 with n=3 is the max of three observations, not a distribution tail. The raw
per-run values are kept so a cold outlier is visible, not averaged away
(`PERF-BASELINE-100K-MULTIROUND.md:5,20`).

**Evidence-hygiene finding (no code change at `874f107`).** The aggregate JSON
`perf-production-multiround.json` carries a `caution` string that says "Vite dev server for
interaction timing"; that text is hard-coded in `aggregate.mjs:80-81` and is stale for the
production-build aggregate. The per-run JSON correctly records
`servingMode = "build (Express static, no Vite)"`, and the Markdown report is correct. Treat the
Markdown report + per-run JSON as the source of truth; do not quote the aggregate `caution` field.

**Post-evidence:** `d1d8aec` (after this pack's evidence commit) made `aggregate.mjs` derive the
`caution` from the run's `servingMode` and regenerated the two aggregate JSONs, so the paragraph
above describes `874f107`, not the current tree. The numbers themselves were not re-measured.

---

## 7. Failure / Edge Cases

**The pathological single-paragraph document.** The official fixture joins 100,000 lines with single
`\n`s, so CommonMark parses the entire 6.8 MB as one paragraph. The profile shows the consequence:
the Markdown inline parser accounts for ~89.6 % of JS time and roughly one Long Task per keystroke
(`PROFILE-100K.md:17-20,43-48`). The system does not crash or lose data — the edit still reaches
`Y.Text` and persists — but the main thread is blocked for ~265 ms per input, so the editor cannot
paint or accept the next input promptly. This is the real boundary of the current implementation:
**correct, durable, but not low-latency on this document shape**.

**A cold first process is kept, not trimmed.** In the dev group, run 1 measured ready 6301 ms and
first WebSocket 5721 ms; runs 2/3 measured 1845/1531 ms. The report records the cold values and the
min instead of silently dropping run 1 (`PERF-BASELINE-100K-MULTIROUND.md:20,70-72`). That prevents
"p95 680 ms" from being read as a warm-start guarantee in every environment.

**The fixture is not real-world Markdown.** The block-structured variant (headings, blank lines,
lists, fences) drops input p95 from 371 ms to ~3.5 ms and Long Tasks from ~400 to 1–2 per 300
inputs (`PROFILE-100K-BLOCK.md:18-34`). The honest reading is: *the pathological number is a property
of the fixture, and real Markdown may not reproduce it* — but the official baseline stays unchanged,
and neither variant is "production".

**Production build ≠ production.** Serving built assets from Express removes Vite's on-demand
transform (ready 6301 → 680 ms p95) but does not add TLS, Clerk, a CDN, a real network or a Render
instance. The improvement is a serving-path effect, not a product optimisation
(`PERF-BASELINE-100K-PROD.md:61-70`).

---

## 8. Limitations

- **`VERIFIED`（local production-build baseline）** — 100k / 6.79 MB opens and is editable on the
  built path; ready p95 680 ms (n=3), reconnect p95 770 ms (n=9), Redux 241 B (3/3 runs).
- **`NOT VERIFIED`（production P95）** — no production deployment, no TLS/Clerk/Render, one laptop.
  Never write "production P95" or "线上 680 ms". `D-086 §2` explicitly forbids using Render Free
  cold start / shared CPU as a production P95.
- **`NOT VERIFIED`（SLO）** — input p95 is 371.3 ms and Long Tasks are ~397–400 per run on this
  fixture. The document is correct, not fast. No input-latency SLO exists.
- **`NOT VERIFIED`（optimisation / before-after）** — no optimisation was applied and there is no
  trustworthy pre-optimisation baseline (`CAPABILITY-EVIDENCE-INVENTORY.md:41` B9). Do not write
  "优化完成", "提升 X %", or a before/after table.
- **Small samples** — ready n=3, reconnect n=9; p95 is nearest-rank and therefore near the max.
  This is a baseline, not a distribution study. A cold process can move ready by seconds.
- **Fixture realism** — the official fixture is one 6.8 MB paragraph; the block variant shows the
  cost is largely structural. Do not generalise 371 ms / 1182 ms to "any 100k Markdown document".
  The block fixture is generated, not committed; its sha256 is the contract.
- **Instrumentation** — Long Tasks, memory and the Redux snapshot are **test instrumentation**, not
  production telemetry. `apps/**` and `packages/**` contain no `PerformanceObserver`, no
  `performance.mark`, and no `sendBeacon` (`CAPABILITY-EVIDENCE-INVENTORY.md:35-36`).
- **Not re-run at `874f107`** — the numbers were measured on product code at `01d3963` /
  `c2ad879`; `git diff 01d3963..874f107 -- tests/browser apps packages` is empty, so the product
  code is equivalent, but the exact `874f107` tree was not re-benchmarked.
- **`NOT IMPLEMENTED`（out of scope）** — no Markdown preview, no search, no telemetry, no
  production perf observer. None of these exists, so none may be inferred from the benchmark. The
  only "preview" in the product is the AI diff preview, a different feature.
- **Bundle is not split** — the main chunk is 970,271 B raw / 316,847 B gzip; only `ClerkRoot` and
  `y-indexeddb` are lazy (`PERF-BASELINE-100K-PROD.md:38-45`). Do not claim route-level splitting.

---

## 9. Interview Explanation (60–90 seconds)

“大文档这块我先解决的是状态归属，不是调参。6.8 MB 的正文如果进 Redux，每敲一个字符就是一次全局 store 更新，还会多一份真相。所以正文只在 Y.Text 里，Redux 只放 activeDocumentId、metadata 和 UI 状态。我用 10 万行、6,788,895 字符、sha256 固定的 fixture，跑真实 Chrome、真实输入和真实重连；输入 300 次之后从 React fiber 里拿到 store 序列化，只有 241 B，正文标记一个都没有。

性能上我严格区分环境：本地 production build 是 built server 直接服务 built web、没有 Vite，ready p95 680 ms、重连 p95 770 ms，样本分别是 3 和 9；这不是线上 P95。输入 p95 是 371 ms，Long Task 每轮约 400 条，这些我没藏。

profile 显示约 89.6% 的 JS 时间在 CodeMirror 的 Markdown inline parser，因为 fixture 是 10 万行单段落；换成块结构后 p95 降到约 3.5 ms，说明这是 fixture 结构放大，不是 100k 行本身。没有做优化，也没有优化前基线，所以我不会说提升百分之多少。”
