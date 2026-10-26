# Profiling phase — where each 100k input spends its 250–500 ms

**Diagnostic only.** No product code was changed, no fixture was replaced, and no optimisation was
applied. Numbers below describe the **current** 100k fixture on the dev server (unminified function
names; the same product code serves the build path).

| Environment | Value |
| --- | --- |
| Product commit | `01d3963` (unchanged) |
| Host / browser | Windows 11 10.0.26200 · Chrome/155.0.8059.85 · Node v22.14.0 |
| Fixture | 100,000 lines / 6,788,895 chars (`sha256 0d12688d…`) |
| Trace window | **20 real `Input.insertText("x")`**, warm editor, ~5.9 s wall clock |
| Instrumentation | CDP `Tracing` (timeline/v8/blink) + `Profiler` CPU profile (test-only) |

## Contributor table

| Contributor | Evidence | Approx share / time | Scaling | Confidence |
| --- | --- | --- | --- | --- |
| **CodeMirror Markdown inline parser** (`finishLeaf`, `parseInline`, `HardBreak`, `Escape`, `Entity`, `Image`, `Emphasis` from `@codemirror/lang-markdown`) | CPU profile: **5,368.3 ms of 5,987.7 ms** profiled; `finishLeaf` 40.5 %, `parseInline` 36.6 %, `HardBreak` 5.1 % | **~89.6 %** of JS time; **~268 ms per input** | 20-input p50: **5k 16 ms → 25k 70 ms → 50k 586 ms → 100k 1182 ms** (super-linear) | **high** |
| Main-thread Long Tasks caused by that parse | Trace: **21 RunTasks ≥50 ms for 20 inputs**; p50 264.8 ms, p95 278.1, max 282.2; total 5,574.7 ms | **≈1 Long Task per keystroke**; 93 % of the traced window | Same scaling as above | **high** |
| Style / layout | Trace self time **13.6 ms** (0.23 %) | negligible | flat | high |
| Paint / composite | Trace self time **10.3 ms** (0.17 %) | negligible | flat | high |
| React render/commit | CPU profile **4.2 ms** (0.07 %) | negligible | flat | high |
| IndexedDB persistence | not in the top-40; earlier sampled 1.6 ms | negligible | flat | medium (no dedicated marker) |
| Yjs transaction / update encoding | not in the top-40; **no `encodeStateAsUpdate` / `toString` sample** | negligible | unknown at larger deltas | medium |
| WebSocket send / broadcast | no sample above threshold | negligible | unknown | medium |
| Full-document string materialisation | **0 samples** matching `toString`/`sliceDoc`/`JSON.stringify`/`TextEncoder` | none observed | — | medium (sampling; a very short call could be missed) |

## Direct answers

- **Where do the 250–500 ms go?** Almost entirely into one main-thread task per input that runs
  CodeMirror's Markdown **inline** parser over the document.
- **Is there work proportional to 6.8 MB?** Yes — the parser's time grows faster than linearly in
  the size probe (16 → 70 → 586 → 1182 ms p50 for 5k/25k/50k/100k).
- **Does every input `toString()` the document?** No such sample was observed.
- **Are decorations/highlighting scanning too much?** The cost is in the Markdown **parser**, not in
  paint or decoration rendering (style/paint are <0.5 %).
- **Is Yjs expensive, or downstream observers?** Neither appears measurable here.
- **Does IndexedDB block the interaction path?** No measurable synchronous cost.
- **Does React re-render unnecessarily?** No: 4.2 ms total across 20 inputs.
- **Long Task ↔ input sample:** one-to-one (21 Long Tasks for 20 inputs).

## The likely amplifying factor (must be stated)

The fixture joins its 100,000 lines with **single `\n`s and no blank lines**, so in CommonMark/GitHub
Markdown the whole 6.8 MB document is **one paragraph**. An inline parser must then re-examine that
paragraph whenever an edit invalidates its inline context. This is a property of the **fixture**, not
necessarily of real documents, and the benchmark must not be "fixed" by silently changing it.

## Top 3 bottlenecks

1. **Markdown inline parsing of a document-sized paragraph** — 89.6 % of JS time, one Long Task per
   keystroke. This is the whole latency story at this fixture.
2. **The resulting main-thread Long Task (~265 ms)** — same root cause, but it is the user-visible
   event: the editor cannot paint or accept the next input while it runs.
3. **Fixture realism risk (diagnostic)** — the single-paragraph structure is what makes the parser
   scan the document; until a block-structured variant is measured, it is unknown how much of the
   cost real Markdown would see.

## Minimal candidates (not implemented)

| Candidate | Expected effect | Correctness risk | Architecture invariant | Test plan |
| --- | --- | --- | --- | --- |
| A. Add a **block-structured fixture variant** (blank line between lines, or headings every N lines) and profile/baseline it *alongside* the current fixture | Quantifies how much of the 1.18 s is the fixture's single paragraph; no product change | none (test data; the official fixture stays unchanged) | none | rerun `tests/perf/profile.mjs` and the 3-run baseline on both variants; report both, never replace silently |
| B. If real documents also contain very large paragraphs: evaluate a **parser-range guard** (e.g. skip language parsing above a size threshold, or parse only the viewport) | Large latency reduction for pathological docs | Degrades highlighting on huge docs; needs an explicit product decision | Does not touch Y.Text/CRDT/Redux; UI-only | needs owner approval first; then a feature-flag test and a browser scenario proving no data change |
| C. Nothing else: Yjs/React/IndexedDB/paint are below 0.5 % — optimising them now would be speculative | — | — | — | — |

## Caveats

- Dev-server profiling (unminified names). The production build shows the same order of latency
  (input p95 371–423 ms), but function names there are minified, so attribution comes from dev.
- The scaling probe does **not** pin the cursor to the document start (the baseline does), so its
  absolute values differ from the baseline; the **trend** is the claim, not the absolute number.
- CPU sampling can miss very short calls; "not observed" for Yjs/IndexedDB means "no measurable
  contribution", not "provably zero".
- No production P95 and no optimisation claim is made here.

## Files

- `tests/perf/profile.mjs` — trace + CPU profile over a fixed 20-input window; `--scaling` probe
- `tests/perf/results/profile-100k.json` — CPU profile summary, trace categories, Long Task count
- `tests/perf/results/scaling-probe.json` — 5k/25k/50k/100k input-latency p50/p95/max
