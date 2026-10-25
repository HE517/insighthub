# Capability Evidence Gate — Phase 1 静态 inventory

**Commit**: `d73d6f5` · **Machine**: Windows 11 · **Browser**: Chrome 155.0.8059.85 (headless) ·
**Node**: v22.14.0 · **Date**: 2026-10-25

**方法**：只读扫描代码、已提交的测试场景与构建产物；**未新增测试、未补功能、未发真实请求**。
每一项都给出 `PASS / FAIL / NOT IMPLEMENTED / NOT VERIFIED`，并注明证据文件。所有结论都可以
被后续 Gate 的真实运行推翻——本文件是 inventory，不是最终 verdict。

> 规则：简历/项目描述里写了什么，**不构成**该项必须 PASS 的理由。缺失项如实标
> `NOT IMPLEMENTED`，等 Owner 决定是否补。

---

## Gate A — Collaboration / Offline convergence

| # | 要求 | 状态 | 现有证据 | 缺口 |
| --- | --- | --- | --- | --- |
| A1 | 两个**完全独立** browser context 并发编辑（insert/delete/replace），A/B/Server 文本一致，记录 state-vector/hash | **NOT VERIFIED** | `realtime/two-tabs-converge`（两个 tab，**同一 profile/context**；仅 insert） | 无独立 contexts；无 delete/replace 并发；未记录 state-vector/hash |
| A2 | Offline → 离线编辑 → 恢复 → 收敛，记录 reconnect duration | **PASS（行为）** / duration **NOT VERIFIED** | `chaos/offline-reconnect`、`indexeddb/C-offline-then-reconnect-converges` | 场景不断言/输出 reconnect duration 指标 |
| A3 | 重复 delivery / idempotency | **PASS** | `chaos/duplicate-inbound-frames`（同一 Yjs update 三次） | — |
| A4 | Undo 隔离（只撤 local/AI） | **PASS** | `realtime/local-undo-does-not-revert-remote-text`、`m3/1` | — |
| A5 | IndexedDB 持久化 wiring + 离线重开恢复 | **PASS** | wiring: `collab/internal/document-session.ts`（`IndexedDbLike`/`y-indexeddb`）；场景 `indexeddb/A..D`（B 覆盖 offline→reload(offline)→恢复） | “A 离线编辑 → 关闭 → 离线重开 → 联网收敛”由 B+C 组合覆盖，未在**同一场景**串起来 |

**Gate A verdict（inventory）**：3 PASS、1 PASS(行为)/1 指标缺失、1 NOT VERIFIED。没有 FAIL。

---

## Gate B — Performance / Observability

| # | 要求 | 状态 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| B1 | 100,000 行 deterministic fixture | **NOT IMPLEMENTED** | `performance/5000-lines-invariants` 只有 5,000 行 | 无 100k fixture；无固定生成器 |
| B2 | load/ready、input p50/p95/max、Long Task、preview、reconnect duration、bundle、memory | **NOT IMPLEMENTED**（部分样例存在） | `05-performance.mjs` 记录 10 次 keystroke 与 remote-update 的耗时；`index-lKQ_6B_M.js` 948KB raw / **310KB gzip**、`ClerkRoot` 84/22KB、`y-indexeddb` 3/1KB | 无 p50/p95 聚合（仅 10 样本、未多轮）、无 Long Task、无 memory、无 preview |
| B3 | PerformanceObserver（Event/LongTask/marks） | **NOT IMPLEMENTED** | `apps/web/src` 与 `apps/server/src` 无 `PerformanceObserver` / `performance.mark` | — |
| B4 | sendBeacon telemetry（hidden/unload、批量、无正文、失败不阻塞） | **NOT IMPLEMENTED** | 无 `sendBeacon` / telemetry endpoint | — |
| B5 | preview update duration | **NOT IMPLEMENTED** | 无 Markdown preview 功能（只有 AI **Diff Preview**，语义不同） | — |
| B6 | 高频事务不把整份 Markdown 镜像进 Redux | **IMPLEMENTED / 静态 PASS，动态 NOT VERIFIED** | `store/documentSlice.ts` 只允许 `activeDocumentId`/`metadata`/UI state，明确禁止 `content`/`markdown`/`text` | 无专门的自动化断言“高频输入后 store 仍不含正文” |
| B7 | preview debounce | **NOT IMPLEMENTED** | 无 preview | — |
| B8 | editor/preview/code-highlight 的 module splitting | **PARTIAL / NOT IMPLEMENTED（按该项口径）** | 只有 `ClerkRoot` 与 `y-indexeddb` 懒加载 chunk | 无 editor/preview/highlight 路由级拆分；主 chunk 948KB |
| B9 | pre-optimization baseline | **UNAVAILABLE** | `git log --grep=perf` 无真实性能基线 commit | 只能报告 **current baseline**，不得编造“优化前” |

**Gate B verdict（inventory）**：性能/观测大部分 **NOT IMPLEMENTED**；bundle 数字可复现；
**Render Free 的 cold start/shared CPU 不作为 production P95**，production performance
保持 **NOT VERIFIED**。

---

## Gate C — Permission / stale-response consistency

| # | 要求 | 状态 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| C1 | owner/editor/viewer 矩阵，HTTP+WS 一致，拒绝无副作用 | **PASS** | `p2/1-viewer-cannot-write`、`p2/4-role-capability-consistency`、`p2/5-role-change-is-re-evaluated`、`f1/1..4`、`m3/10-ai-viewer-cannot-accept` | — |
| C2 | Document switch：A fetch 延迟 → 切 B → B 先回 → A 后回，UI 保持 B | **NOT VERIFIED** | `chaos/document-switch-race` 覆盖的是 **WS 帧**跨文档隔离，不是 HTTP fetch 的 late response | 无 fetch 延迟注入 + late-response 覆盖测试 |
| C3 | Search：query A 延迟 → query B 先回 → A 后回，UI 保持 B；AbortController/ownership | **NOT IMPLEMENTED** | 无 search 功能 | — |
| C4 | AbortController 实际使用 | **PARTIAL** | `AiDirectory` 的 documents list、AI 请求、Clerk session 使用 AbortController | document metadata/switch 路径未见 abort |

**Gate C verdict（inventory）**：权限矩阵与拒绝无副作用 **PASS**；stale-response（HTTP）与
search 未验证/未实现。

---

## Preliminary claim-to-evidence（final 由 A7 独立复核）

| 项目描述中的说法 | inventory 结论 |
| --- | --- |
| “多人实时协作、并发编辑收敛” | 有双 tab 收敛证据；**独立 contexts/delete-replace/state-vector** 缺证据 → 表述需限定为“同一 profile 双 tab 已验证” |
| “离线编辑、重连收敛” | 行为 PASS；**reconnect duration** 未测量 |
| “重复/乱序帧幂等” | PASS |
| “Undo 只撤本地” | PASS |
| “IndexedDB 离线恢复” | PASS（组合证据） |
| “性能：100k 行、p95、Long Task” | **NOT IMPLEMENTED**（当前只有 5k 结构不变量 + 10 样本） |
| “PerformanceObserver / sendBeacon telemetry” | **NOT IMPLEMENTED** |
| “Markdown preview + debounce” | **NOT IMPLEMENTED**（不存在该功能） |
| “模块拆分优化” | 仅 Clerk/IndexedDB chunk；主包 948KB/310KB gzip → 表述需降级 |
| “RBAC 矩阵 HTTP/WS 一致” | PASS |
| “Stale response 防护” | WS 文档切换有证据；HTTP fetch 延迟场景 **NOT VERIFIED**；search **NOT IMPLEMENTED** |

## 需要 Owner 决定（不擅自补）

1. Gate B 的 **100k fixture + metrics + LongTask** 是否要作为 release gate 实现（工作量最大）。
2. **preview**（Markdown 预览）在 V1 是否存在？若不存在，项目描述必须降级，不能为了 Gate 新建功能。
3. **sendBeacon telemetry** 是否纳入 V1；若不，描述降级为 `NOT IMPLEMENTED`。
4. Gate A1 是否要求“两个独立 browser context”作为正式证据（当前只有同 profile 双 tab）。
5. Gate C2/C3 是否纳入（C3 依赖 search 功能是否存在）。

**本文件不改变任何代码、测试或产品描述。** 后续 Gate 运行会逐项替换为真实 PASS/FAIL。
