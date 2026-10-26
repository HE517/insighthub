# Candidate A — block-structured 100k diagnostic comparison

**Goal**: quantify how much of the pathological fixture's input cost is caused by its **single
6.8 MB paragraph**. No product code, fixture replacement, parser guard or architecture change.

| | pathological (official baseline) | block-structured (this run) |
| --- | --- | --- |
| Lines | 100,000 | 100,000 |
| Characters | 6,788,895 | **6,859,314** (+1.0 %) |
| sha256 | `0d12688d…` | `294af99d…` |
| Structure | **one paragraph** (single `\n`s, no blank lines) | headings + blank-line paragraphs + lists + fenced code blocks |
| Host / browser | Windows 11 10.0.26200 · Chrome/155.0.8059.85 | same |
| Serving | built server + built web (Express static, no Vite) | same |
| Operation sequence | 3 × 100 real `Input.insertText("x")` at document start | same |

## Side by side

| Metric | pathological | block-structured |
| --- | --- | --- |
| editor ready (n=3) p50 / p95 / max | 654 / 680 / 680 ms | **453 / 458 / 458 ms** |
| input model p50 (per-round, 3 rounds) | 268.8 ms | **2.2–2.6 ms** |
| input model p95 (per-round) | 371.3 ms | **3.1–3.7 ms** |
| input model max (per-round) | 511.4 ms | **≤ 7.3 ms** |
| input next-frame p50 (per-round) | 269.6 ms | **15.2–15.4 ms** (frame cadence) |
| Long Tasks per **300** inputs | ~397–400 | **1–2** |
| Long Task max | 511 ms | **107–126 ms** |
| CPU profile top | Markdown `finishLeaf` 40.5 % / `parseInline` 36.6 % (89.6 % of JS) | **no function above 0.7 %**; 72.8 % idle, `(program)` 12.3 % |
| Redux state | 241 B, no body markers | **253 B, no body markers** |

## Reading

- The **same 100k lines / ~6.8 MB** document, with real block boundaries, drops input model p95 from
  **371 ms to ~3.5 ms** and Long Tasks from **~400 to 1–2**.
- The CPU profile confirms the mechanism: the pathological document is one paragraph, so the
  Markdown inline parser re-examines the whole document per edit; with block boundaries, parsing is
  localized and no function dominates.
- Ready time also improves (654 → 453 ms), consistent with less initial marking work.
- This is a **fixture-structure effect**, not a product optimisation, and not a before/after
  comparison. The official pathological fixture is unchanged and remains the baseline.

## Consequence for Candidate B

The block fixture shows **no product-level input-latency problem** for realistically structured
Markdown at 100k lines. Candidate B (parser-range guard / viewport-only parsing) is therefore **not
justified by this evidence** and stays unapproved. It would only be proposed again if a *real*
product document reproduces the single-huge-paragraph shape and user-visible stalls.

## Limits

- Diagostic only: no thresholds, no production P95, no "optimized" claim.
- The block fixture is **generated**, not committed (the generator is deterministic; the sha256
  above is the contract). Official fixture untouched.
- Long-task counts are per run; the block runs show 1–2 for 300 inputs, so the pathological number is
  not a property of 100k Markdown in general.

## Files

- `tests/perf/fixture-block.mjs` — deterministic block fixture generator
- `tests/perf/block-benchmark.mjs` — production-build measurement + CPU profile for the block fixture
- `tests/perf/results/perf-block-run-1..3.json`
