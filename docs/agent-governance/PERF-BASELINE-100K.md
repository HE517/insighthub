# Performance Baseline — 100,000-line Markdown

**Scope: current baseline only.** This report is not a before/after optimization comparison. It records the behaviour of the current commit on one local host, with no PASS/FAIL thresholds.

## Environment

| Fact | Value |
| --- | --- |
| Measurement commit | `9f4879f` (`9f4879febd3a87f02130dff6199fee32962e31d1`) |
| Product-code changes | none; only `tests/perf/**` and this report were added |
| Branch | `agent/a6-evidence-perf` |
| Worktree | `D:\前端\react\项目\面试项目\Insighthub-wt-a6-evidence-perf` |
| Host | Windows 11 Home China 10.0.26200 (x64) |
| CPU | 13th Gen Intel(R) Core(TM) i5-1340P (16 logical CPUs) |
| RAM | 15.7 GiB |
| Node | v22.14.0 |
| Chrome | Chrome/155.0.8059.85 |
| Browser mode | headless |
| Generated at | 2026-10-25T10:31:06.349Z |
| Stack | real server + real Vite dev server, ports 3301/5183 |

## Fixture

| Fact | Value |
| --- | --- |
| Path | `tests/perf/fixtures/100k-lines.md` |
| Lines | 100,000 |
| Characters (UTF-16) | 6,788,895 |
| Bytes (UTF-8) | 6,788,895 B |
| SHA-256 | `0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c` |
| Second generation SHA-256 | `0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c` |
| Deterministic | yes — both generations byte-identical |
| Line template | `line-<i>: The quick brown fox jumps over the lazy dog 0123456789.` |

There is no randomness, clock read, padding or locale formatting in the generator. The same commit produced the same bytes twice in this run, and the checked-in file was verified against the generator before the benchmark started.

## Method and operation sequence

1. `pnpm build` produced `apps/web/dist`; `pnpm typecheck` and `pnpm test` were green.
2. `openDocumentStore` opened a temporary SQLite data directory and a real `Y.Doc` wrote the fixture into `Y.Text` key `content`; `store.append` committed it (sequence 1). This is a server-side seed through the production persistence seam, not a product-code change.
3. The real server and Vite dev server started on the ports above.
4. A real Chrome opened `http://127.0.0.1:5183/`; the page first opened its default document, then switched to `a6-perf-100k`.
5. Ready was defined as the live `EditorView` state holding exactly the fixture character count; the live text was then SHA-256-hashed and compared with the fixture.
6. Input latency: 3 rounds × 100 real `Input.insertText` transactions at the start of the document. Each round cleared the transaction recorder and verified exactly 100 one-character insert transactions.
7. Reconnect: 3 iterations of `setOffline(true)` (close the live WebSocket) → 250 ms outage → `setOffline(false)` → wait for `connection-status=connected`.
8. Long Tasks were collected by a test-injected `PerformanceObserver` from page start to the end of the run. It is **test instrumentation, not production telemetry**.
9. Bundle sizes were read from the current `apps/web/dist/assets/*.js` with `node:zlib` gzip.
10. `performance.memory` was sampled five times, 200 ms apart, only to report what Chrome exposed.

## Results

### Ready and first WebSocket

| Metric | Value |
| --- | --- |
| Ready duration (page.goto start → 100k model ready) | 3246 ms |
| Editor text SHA-256 at ready | `0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c` |
| Editor text matches fixture | yes |
| `.cm-content` / `.cm-editor` at ready | 1 / 1 |
| First WebSocket connected after navigation | 2395 ms |

### Input latency

All values are milliseconds, measured inside the page. `model` ends at the `.cm-content` input listener (after CodeMirror applied the transaction); `next frame` ends at the next `requestAnimationFrame`. p50/p95 use the nearest-rank index `floor(p × (n−1))` on the sorted samples; raw samples are in the JSON.

| Scope | Metric | n | p50 | p95 | max | min |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Round 1 | model | 100 | 443.5 | 579.9 | 715 | 314.8 |
| Round 1 | next frame | 100 | 444.8 | 581 | 716.3 | 315.7 |
| Round 2 | model | 100 | 389.7 | 503.7 | 526.6 | 299.5 |
| Round 2 | next frame | 100 | 390.8 | 505.1 | 527.6 | 300.5 |
| Round 3 | model | 100 | 428.5 | 514 | 587.8 | 323.4 |
| Round 3 | next frame | 100 | 430.1 | 515 | 590.9 | 324.6 |
| All rounds | model | 300 | 423.8 | 535.9 | 715 | 299.5 |
| All rounds | next frame | 300 | 424.8 | 537.3 | 716.3 | 300.5 |

Per-round one-character transactions: 1=100, 2=100, 3=100. Each round also verified the model grew by exactly 100 characters.

### Long Tasks (test instrumentation)

| Metric | Value |
| --- | --- |
| Observer supported | yes |
| Count | 385 |
| Total duration | 163356 ms |
| Max duration | 715 ms |
| p50 / p95 | 423 / 527 ms |

The observer ran from page start through the whole benchmark, so this count includes the benchmark’s own input transactions. It is test instrumentation injected by this harness, **not production telemetry**.

### WebSocket reconnect

| Iteration | Offline status observed | Offline observed | Restore → connected | Offline → connected |
| ---: | --- | ---: | ---: | ---: |
| 1 | reconnecting | 6 ms | 812 ms | 1084 ms |
| 2 | reconnecting | 10 ms | 775 ms | 1047 ms |
| 3 | reconnecting | 9 ms | 769 ms | 1039 ms |

Restore → connected: p50 775 ms, p95 775 ms, max 812 ms (n=3).
Offline → connected: p50 1047 ms, p95 1047 ms, max 1084 ms.

### Bundle / chunk (current `apps/web/dist/build`)

| File | Raw | Gzip |
| --- | ---: | ---: |
| `apps/web/dist/assets/index-Dm35hFbk.js` | 970,271 B | 316,847 B |
| `apps/web/dist/assets/ClerkRoot-BPVoNiVC.js` | 85,786 B | 22,693 B |
| `apps/web/dist/assets/y-indexeddb-DnwhTXDZ.js` | 2,913 B | 1,271 B |
| **Total (3 JS files)** | **1,058,970 B** | **340,811 B** |

### Memory

| Fact | Value |
| --- | --- |
| Status | AVAILABLE (Chrome non-standard performance.memory) |
| Current usedJSHeapSize | 49,159,347 B |
| Peak usedJSHeapSize (sampled) | 49,159,347 B |
| Min usedJSHeapSize (sampled) | 49,154,059 B |
| jsHeapSizeLimit | 4,395,630,592 B |
| Samples | 5 (five samples, 200 ms apart) |

## Observations (not PASS/FAIL thresholds)

- 385 Long Tasks were observed (163356 ms summed, 423 ms p50, 527 ms p95). Count alone is not a verdict; it is flagged because the task brief asks for an explicit observation when Long Tasks are frequent.
- input p95 (input -> next frame) is 537.3 ms and the p50 is 424.8 ms; this is below the 1 s example but is called out as an elevated current-baseline number.

## Limitations

- This is **local Windows 11 desktop** evidence only; it is not a production P95.
- Production performance remains **NOT VERIFIED**. Render Free cold start/shared CPU was not used as a substitute.
- The runtime path is the Vite dev server (module transform on demand), not the production bundle; bundle sizes are reported separately from the built output.
- Long Tasks and input timing are **test instrumentation**; there is no production `PerformanceObserver` or telemetry.
- `performance.memory` is non-standard and is reported only when this Chrome invocation exposed stable samples.
- The 100k fixture is synthetic and deterministic; it is not a capture of real user content.

## Evidence

- Raw JSON: `tests/perf/results/perf-baseline-100k.json`
- Fixture: `tests/perf/fixtures/100k-lines.md` (sha256 `0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c`)
- Run command: `node tests/perf/run.mjs`
- Preconditions: `pnpm build`, `pnpm typecheck`, `pnpm test` (green before this run).

