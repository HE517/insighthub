# Resume Evidence — InsightHub

**Evidence commit:** `874f107` · **Branch:** `agent/resume-evidence` · **Date:** 2026-10-26
**Nature:** docs-only, audit material. This directory changes no code, test, package manifest, or
frozen document. It records what already exists, where it is, what was measured, and what is not
supported.

---

## 0. What this directory is — and is not

This is a **claim-to-evidence pack** for five resume bullets. Each report follows the same nine
sections: the verbatim claim, its meaning, the real implementation path, exact source locations,
the tests that exercise it, the measured numbers with their environment and source file, failure
behaviour, limitations (`VERIFIED` / `NOT VERIFIED` / `NOT IMPLEMENTED` / scope), and a 60–90 second
interview explanation.

It is **not** a release note, a production-readiness statement, or a redesign. The project's own
scope and non-goals remain `docs/PROJECT.md`; the claim rulings remain
`docs/DECISIONS.md` D-081 / D-082 / D-085 / D-086 and `docs/agent-governance/A7-claim-evidence-review.md`.

**Environment of every number cited here** (unless a report says otherwise): Windows 11
10.0.26200 x64 · 13th Gen Intel Core i5-1340P · 15.7 GiB · Node **v22.14.0** · pnpm **10.34.7** ·
Chrome **155.0.8059.85**, headless. This is a local developer machine, not a production deployment.

**Provenance of "current" code.** All permalinks are pinned to `874f107`. The behavioural
measurements were taken earlier, but on code that is byte-identical for the relevant trees:

```text
git diff 1807ea1..874f107 -- tests/browser apps packages   → empty   (73/73 run applies to HEAD's test/product code)
git diff 01d3963..874f107 -- tests/browser apps packages   → empty   (100k runs apply to HEAD's product/test code)
```

Only `tests/perf/**` and `docs/**` changed between those measurement commits and `874f107`. No
number below was re-measured at `874f107`; that is stated as a limitation in each report.

---

## 1. The five bullets, verbatim

> **B1.** 业务场景：面向团队知识共享，构建支持文档协同编辑、阅读与 AI 辅助修改的知识工作台。
>
> **B2.** 基于 CodeMirror 6 + Yjs 实现 Markdown 实时协同编辑，以 Y.Doc / Y.Text 作为正文唯一数据源，通过 WebSocket 同步增量更新，并结合 IndexedDB 支持离线编辑、重开恢复及双用户并发状态收敛。
>
> **B3.** 面向大文档场景隔离编辑器高频状态与 Redux，全量正文不进入全局状态；在 10 万行 / 约 6.8 MB Markdown 基准下，Redux state 约 241 B，本地 production build 编辑器 ready P95 680 ms、WebSocket 重连 P95 770 ms。
>
> **B4.** 处理文档切换、权限变化及异步结果回写的一致性问题，通过状态归属校验避免过期结果覆盖当前页面，并按 Owner / Editor / Viewer 驱动前端编辑能力。
>
> **B5.** 设计 AI 辅助编辑的生成建议 → Diff Preview → Accept / Reject 非破坏式交互；使用 Playwright 覆盖协作、离线、权限及异常网络等核心链路，当前全量浏览器回归 73/73 PASS。

The wording above is quoted verbatim and is **not** rewritten in the reports. Where it overstates
the evidence, the report says so in §8 and the status below is downgraded.

---

## 2. Resume index

| Bullet | Implementation | Test evidence | Metrics | Status | Report | Interview confidence |
| --- | --- | --- | --- | --- | --- | --- |
| **B1** business context / knowledge workbench | `App.tsx` → `AppShell` → `DocumentWorkspace`; demo/Clerk identity; `Y.Text` body; AI panel; server-authoritative permissions | No dedicated test (scope claim). Paths are exercised by `b125/1`, `editor/mounts-on-existing-ytext`, `p2/3`; `m3r/2` exists but is remote-gated (not part of the 73) | None claimed for this bullet; 73/73 is the suite status, not a business metric | **SUPPORTED WITH LIMITATION** | [01-business-context.md](01-business-context.md) | **HIGH** |
| **B2** CodeMirror 6 + Yjs, single body source, WS increments, IndexedDB offline, two-user convergence | `collabTextBinding.ts`; `document-session.ts`; `sync-provider.ts`; `persistence.ts`; `room.ts` + `registry.ts` | `collab/independent-contexts`; `indexeddb/A..D`; `chaos/offline-reconnect`; `chaos/duplicate-inbound-frames`; `realtime/local-undo-does-not-revert-remote-text` | Two independent contexts; 56-char final text equal A = B = server; state-vector sha256 `bda0ea9c…` (19 B, 3 clients); 73/73 | **SUPPORTED WITH LIMITATION** | [02-collaboration-offline.md](02-collaboration-offline.md) | **HIGH** |
| **B3** 100k / 6.8 MB, Redux 241 B, local production-build ready/reconnect P95 | `documentSlice.ts` (no body); `instrument.mjs` dynamic Redux probe; `tests/perf/**` | 3 independent perf processes; dynamic Redux snapshot after 300 inputs; deterministic fixture sha256 | ready **654 / 680 / 680 ms** (p50/p95/max, n=3); reconnect **763 / 770 / 770 ms** (n=9); input **268.8 / 371.3 / 511.4 ms** (n=900); Redux **241 B**; Long Tasks **400 / 397 / 397** | **SUPPORTED WITH LIMITATION** | [03-large-document-performance.md](03-large-document-performance.md) | **MEDIUM** |
| **B4** permissions + stale-response ownership | `permission.ts`; `authz.ts`; `app.ts` HTTP guard; `registry.ts` join/frame auth; `capabilityGate.ts`; `AiDirectory.tsx`; `AiSuggestPanel.tsx` | `p2/1`, `p2/2`, `p2/3`, `p2/4`, `p2/5`, `p2/9`, `f1/1`, `f1/4`, `m3/10`, `stale/directory-list` | Real 200 held at CDP (4,640 B / 28 ids); abort after **69 ms** (README records **69–78 ms** across two runs); UI stays on B | **SUPPORTED WITH LIMITATION** | [04-permission-async-consistency.md](04-permission-async-consistency.md) | **MEDIUM** |
| **B5** AI proposal → Diff → Accept/Reject; "Playwright" 73/73 | `AiSuggestPanel.tsx`; `apply.ts`; `provider.ts` / `remoteProvider.ts`; server `ai/route.ts`; `ai-anchor.ts`; real-browser **CDP** harness | `m3/5`, `m3/6`, `m3/7`, `m3/9`, `m3/10`, `m3/11`; full suite 73/73 | 73/73 default (78 registered, 5 remote-gated); remote 78 **not run**; external AI live **0 successful calls** | **SUPPORTED WITH LIMITATION** | [05-ai-editing-quality.md](05-ai-editing-quality.md) | **MEDIUM** |

Status vocabulary: `SUPPORTED` = direct, committed, reproducible evidence with wording inside the
evidence; `SUPPORTED WITH LIMITATION` = capability exists but the sentence needs the named
qualification; `NOT VERIFIED` = implementation exists without a successful verification record;
`REMOVE` = the feature does not exist. Only **HIGH** or **MEDIUM** confidence is allowed on a
resume; every `REMOVE` item below must not appear.

---

## 3. Claims that must not stay on the resume

The following are **not** supported by this repository. Several were explicitly ordered deleted by
`D-086 §3`; do not implement a feature merely to make a bullet true.

| # | Must not claim | Why | Evidence |
| --- | --- | --- | --- |
| 1 | "production P95", "线上 P95", "生产环境性能" | The 100k numbers are a **local production-build** path (Express static, no Vite), not a deployment: no TLS, no Clerk, no Render, one machine. | `PERF-BASELINE-100K-PROD.md:11-13`, `PROFILE-100K.md:76`, `D-086 §2` |
| 2 | "性能优化完成", "提升 X%", "优化前 → 优化后" | No optimisation was applied and there is no trustworthy pre-optimisation baseline. | `CAPABILITY-EVIDENCE-INVENTORY.md:41` (B9 `UNAVAILABLE`), `PERF-BASELINE-100K-PROD.md:12-13`, `PERF-BASELINE-100K-MULTIROUND.md:82-83` |
| 3 | "3+ 用户并发", "多用户（三人以上）" | Only **two** independent browser contexts/users were tested. Three-way concurrent editing is `NOT VERIFIED`; `m2/J` is three cold joins/hydration, not concurrent editing. | `PROJECT.md:21`, `A7-claim-evidence-review.md:83`, `tests/browser/README.md:419` |
| 4 | "Markdown preview", "preview incremental", "preview debounce" | No Markdown preview feature exists. The only "preview" is the **AI Diff Preview** (`aria-label="Unified diff preview"`), a different thing. | `CAPABILITY-EVIDENCE-INVENTORY.md:37` (B5), `A7-claim-evidence-review.md:135`, `AiSuggestPanel.tsx:429` |
| 5 | "search", "cancel stale search", "搜索结果竞态" | No search feature exists. | `CAPABILITY-EVIDENCE-INVENTORY.md:55` (C3), `A7-claim-evidence-review.md:134` |
| 6 | "production PerformanceObserver", "生产端性能观测" | `PerformanceObserver` exists only inside the test harness, and the JSON says "test instrumentation". `apps/**` + `packages/**` contain no `PerformanceObserver`. | `CAPABILITY-EVIDENCE-INVENTORY.md:35` (B3), `instrument.mjs:144-147`, `A7-claim-evidence-review.md:137` |
| 7 | "sendBeacon telemetry", "hidden/unload 上报" | No `sendBeacon` and no telemetry endpoint anywhere. | `CAPABILITY-EVIDENCE-INVENTORY.md:36` (B4), `A7-claim-evidence-review.md:138` |
| 8 | "comment 功能", "评论 / @ 提及" | A `commenter` **permission tier** exists server-side; the product has no comment object or UI. Browser suite mentions it 0 times. | `PROJECT.md:39`, `permission.ts:10-44`, `A7-claim-evidence-review.md:90` |
| 9 | "Playwright 覆盖 73/73" | The 73/73 suite is a **CDP** harness driving real Chromium; it adds zero dependencies. `playwright-core` is a root devDependency used only by the opt-in deployed smoke `tests/deployed/b13.mjs`. | `tests/browser/README.md:22-36`, `package.json:28-30`, `tests/deployed/b13.mjs:12,29,131` |
| 10 | "remote 78/78 PASS" | 78 is the **registered** count (73 default + 5 env-gated `m3r/*`); the remote group was not run in the evidence round. | `tests/browser/README.md:83`, `A6-evidence-gate-round2.md:211-212`, `A7-claim-evidence-review.md:300` |
| 11 | "真实 AI provider 已跑通 / AI live PASS" | External provider live is `NOT VERIFIED`: OpenAI returned `429 credit_balance_exhausted`; Kimi returned `400 invalid_request_error`, then `response_format` was removed and **not retried**. | `D-085:3646`, `kimi.ts:27-32`, `A7-claim-evidence-review.md:56,302`, `PROJECT.md:52` |
| 12 | "production ready" | M3 CLOSED ≠ production ready; B11/B8/B14 are blocked by payment, free staging is ephemeral/test-only. | `PROJECT.md:52-53`, `A7-claim-evidence-review.md:58` |
| 13 | "document metadata stale 防护" | Measured: the client sends **no** document-metadata HTTP request on open/switch. That half is `NOT APPLICABLE`; the tested path is the directory list. | `A6-evidence-gate-round2.md:69-76`, `D-086 §4:3732` |
| 14 | "requestId ownership guard 已验证" | The guard exists (`AiDirectory.tsx:110-134`) but the race where a stale response actually arrives cannot be constructed without changing the product (every ownership change aborts; CDP refuses to deliver). | `A6-evidence-gate-round2.md:151,200-202`, `D-086 §4:3735` |
| 15 | "断网 30 秒不丢键" | Measured offline windows are 1–2 s; no 30 s scenario exists. "No keystroke lost" is supported by `indexeddb/B`. | `PROJECT.md:60-61`, `A7-claim-evidence-review.md:112` |
| 16 | "bundle 已拆分 / 按路由优化" | The main bundle is 970,271 B raw / 316,847 B gzip; only `ClerkRoot` and `y-indexeddb` are lazy chunks. Editor/preview/highlight splitting does not exist. | `PERF-BASELINE-100K-PROD.md:38-45`, `CAPABILITY-EVIDENCE-INVENTORY.md:40` (B8) |
| 17 | "AI 默认会 rewrite/expand/shorten" | The default client provider is a deterministic five-instruction table, not a language model. Free-form rewriting needs a configured external model, which is not live-verified. | `localProvider.ts:11-37`, `A7-claim-evidence-review.md:86` |

If a sentence is not in this table but is not backed by a cited file in its report, it does not
belong on the resume either.

---

## 4. How to audit this pack in ten minutes

```powershell
# 0. The evidence commit this pack is pinned to
git rev-parse HEAD                                  # 874f107bb3e2fdfdac2aff55172dee9ff990a1a8

# 1. Prove the measured code is the current code (both must print nothing)
git diff 1807ea1..HEAD -- tests/browser apps packages
git diff 01d3963..HEAD -- tests/browser apps packages

# 2. Re-check any reported source line (example; repeat with the paths in §4 of each report)
Select-String -Path apps/web/src/store/documentSlice.ts -Pattern 'activeDocumentId' |
  Select-Object LineNumber, Line

# 3. Re-run the browser gate (73 default; ~serial, owns ports 3101/5173)
pnpm build                       # packages/shared must be compiled for the oracle client
node tests/browser/run.mjs

# 4. Re-run the 100k production-build baseline (needs a prior pnpm build)
node tests/perf/run.mjs --build --out=tests/perf/results/perf-prod-run-1.json
node tests/perf/aggregate.mjs perf-prod-run perf-production-multiround.json
```

The raw browser artifacts (`tests/browser/artifacts/results.{md,json}`) and the perf JSONs are
**not** committed by this pack; the committed evidence is the report files under
`docs/agent-governance/` plus `tests/perf/results/*.json`. A re-run creates its own artifacts.

---

## 5. Shared limitations (apply to more than one bullet)

- **Local only.** No production deployment was measured. `production performance = NOT VERIFIED`;
  Render Free cold start / shared CPU is explicitly not a production P95 (`D-086 §2`).
- **Chromium only.** All 73 scenarios ran headless Chrome 155 on Windows 11; `--headed` was not
  re-run, and no Firefox/Safari evidence exists (`A6-evidence-gate-round2.md:210`).
- **Two users, not a crowd.** Concurrent editing evidence is exactly two independent contexts with
  two identities (`demo-ada` editor, `demo-grace` owner). A third concurrent editor is not verified.
- **Not a telemetry product.** Long Tasks, memory and the Redux snapshot are injected by the test
  harness. They are evidence *about* the app, not features *of* the app.
- **AI is proposal-only.** No provider writes `Y.Text`; Accept is the only write path and it is a
  single `ai`-origin transaction. External model quality/latency/cost is not measured.

---

## 6. Report map

| File | Question it answers |
| --- | --- |
| [01-business-context.md](01-business-context.md) | What is the product, who is it for, what is V1, and where does the code enter? |
| [02-collaboration-offline.md](02-collaboration-offline.md) | How do CodeMirror, Yjs, WebSocket and IndexedDB form one body with offline/reconnect? |
| [03-large-document-performance.md](03-large-document-performance.md) | Why does the body stay out of Redux, and what exactly do the 100k numbers mean? |
| [04-permission-async-consistency.md](04-permission-async-consistency.md) | How are roles enforced at HTTP/WS/UI, and what stale-response protection really exists? |
| [05-ai-editing-quality.md](05-ai-editing-quality.md) | How does a proposal become a diff and then an accepted transaction — and what is the 73/73? |

Each report ends with the same limitation vocabulary and a read-aloud interview answer. Read the
report's §8 before quoting its §1.

---

## 7. Errata — required resume wording (audit findings)

These are **not** changes to the product; they are changes the resume must make before this pack is
used in an application. The claim text itself is quoted verbatim in each report, so the evidence
stands even after the bullet is corrected.

| Bullet | Required change | Why |
| --- | --- | --- |
| B5 | Replace **"使用 Playwright"** with **"真实 Chromium（CDP）"** | The 73/73 suite is a dependency-free CDP harness (`tests/browser/README.md:22-36`). `playwright-core` exists only for the opt-in deployed smoke (`tests/deployed/b13.mjs`), so "Playwright covers collaboration/offline/permissions" is factually false. Keep "73/73 default"; never "78/78". |
| B3 | Keep **"本地 production build"**; never shorten to "production P95" | 680/770 ms are built-server + built-web, local, no TLS/Clerk/Render. `production performance = NOT VERIFIED`. |
| B4 | Say **"目录列表 stale + AbortController"**, not "document metadata stale" | The client issues no metadata HTTP request on open/switch, so metadata staleness is `NOT APPLICABLE`; the measured stale path is `GET /api/documents` (abort 69–78 ms). `requestId` guard is not stress-tested. |
| B2 | Keep **"双用户 / two independent profiles"** | A third concurrent editor is not verified; offline windows measured 1–2 s, not 30 s. |

**Post-evidence changes.** After `874f107`, the Markdown preview feature was added under D-087
(`dc20ecb`/`0f4c6aa`). It is **not** part of any bullet in this pack, and none of the "NOT
IMPLEMENTED" lists in the reports should be read as still current for preview. The 73-scenario suite
was re-run after that merge and stayed **73/73**; this does not retroactively change the evidence
commit, and no benchmark was re-run.

**Also after `874f107`.** `d1d8aec` made `aggregate.mjs` derive its `caution` from the run's
`servingMode` and regenerated the two aggregate JSONs; report 03 §6's stale-caution finding
describes `874f107`, not the current tree. The numbers were not re-measured.

**Line drift.** The preview merge (`dc20ecb`) changed
`apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx` and `.../DocumentWorkspace.tsx`; a
`:line` reference to those two files is valid only against `874f107`. Use
`git show 874f107:<path>` — every permalink in this pack already does.
