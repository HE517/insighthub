# InsightHub 项目深挖报告 — 总索引

**Evidence commit：** `57a9bee`（所有源码行号与 permalink 固定到此 commit）
**性质：** docs-only，不改产品代码。报告区分 `IMPLEMENTED / VERIFIED / PLANNED`，不把设计路径写成线上事实。

## 报告目录

| Resume bullet | Report | 主源码 | 主测试 | 关键数据 | Confidence |
| --- | --- | --- | --- | --- | --- |
| 01 业务场景：团队知识工作台 | [01-business-and-architecture.md](01-business-and-architecture.md) | `apps/web/src/App.tsx`、`apps/server/src/app.ts`、`runtime.ts` | `smoke/*`、`b125/1` | V1 scope；单实例 | HIGH |
| 02 多人协同 + 离线恢复 | [02-collaboration-yjs-offline.md](02-collaboration-yjs-offline.md) | `collab/internal/{document-session,collabTextBinding,sync-provider,persistence}.ts`、`rooms/{room,registry}.ts` | `collab/independent-contexts`、`chaos/offline-reconnect`、`chaos/duplicate-inbound-frames`、`indexeddb/*`、`10-m2-durability` | 两个独立 context；reconnect p95 770 ms（n=9） | HIGH |
| 03 大文档性能 + Redux 隔离 | [03-performance-redux-codemirror.md](03-performance-redux-codemirror.md) | `store/documentSlice.ts`、`tests/perf/{run,aggregate,instrument,fixture,build-stack}.mjs` | 3 次独立 perf 进程；`preview/5` Redux 断言 | 100k 行/6,788,895 chars；**整个 Redux store 序列化 241 B**（正文不在其中）；ready p95 **680**（aggregate 口径；run.mjs 为 654）；reconnect p95 **770** | MEDIUM（local build） |
| 04 异步竞态 + RBAC | [04-async-state-rbac.md](04-async-state-rbac.md) | `AiDirectory.tsx`（abortRef/requestRef）、`permission.ts`、`routes/authz.ts`、`rooms/registry.ts`、`capabilityGate.ts` | `p2/1..5`、`p2/9`、`f1/1`、`f1/4`、`m3/10`、`stale/directory-list` | 目录列表 abort **69–78 ms**；metadata stale **NOT APPLICABLE** | MEDIUM |
| 05 懒加载 + Preview + debounce | [05-lazy-preview-rendering.md](05-lazy-preview-rendering.md) | `MarkdownPreview.tsx`、`previewFeed.ts`、`MarkdownPreviewRenderer.tsx`、`DocumentCanvas/Workspace` | `preview/1..5` | chunk **48.99 kB gzip**；主包 +**0.99 kB**；debounce **400 ms**；默认 **78/78** | MEDIUM |
| 06 AI 编辑 + LLM Provider | [06-ai-editing-llm-design.md](06-ai-editing-llm-design.md) | `ai/{provider,openai,kimi,openai-compatible,route,ai-anchor,apply}.ts`、`AiSuggestPanel.tsx` | `m3/5..11`；server route/limit tests | provider seam + fail-closed；外部 live **NOT VERIFIED** | MEDIUM（设计路径） |

## Interview Topic Index（按知识点复习）

| 知识点 | 报告 § |
| --- | --- |
| CodeMirror 6 编辑器架构 / transaction | 02 §4/§6/§7 |
| Yjs / CRDT / Y.Doc / Y.Text | 02 §3–§7 |
| State Vector / 增量同步 | 02 §6、§10 |
| WebSocket 双平面（JSON control / binary Yjs） | 02 §4、§6 |
| IndexedDB / y-indexeddb / 离线恢复 | 02 §3、§5、§6 |
| UndoManager / origin 隔离 | 02 §6 |
| Redux Toolkit / state ownership | 03 §5、§7 |
| 浏览器性能 / Long Task / Chrome trace | 03 §9、§10；05 §10 |
| 100k benchmark 方法 / p95 定义 | 03 §10–§12 |
| Markdown parser 性能（finishLeaf/parseInline） | 03 §10–§11 |
| AbortController / requestId / stale response | 04 §3、§6、§7 |
| RBAC / Clerk / membership / capabilities | 04 §4–§7 |
| HTTP/WS 服务端鉴权 / 404 非泄露 | 04 §4、§6 |
| React.lazy / Suspense / code splitting | 05 §4、§7、§9 |
| debounce vs throttle / useMemo 边界 | 05 §7、§8 |
| XSS / sanitization / raw HTML | 05 §6、§8 |
| AI provider abstraction | 06 §6、§13 |
| LLM 选型（OpenAI vs Kimi） | 06 §13、§14 |
| 结构化输出 / schema / fail-closed | 06 §15 |
| RelativePosition / expectedText / 并发一致性 | 06 §16 |
| SQLite / 单实例部署 / 为什么不用 Postgres/K8s | 01 §6、§8；04 §8 |

## 事实边界（先读再引用）

- P95 是 **local production build**（built server + built web），不是 production P95。\n- 241 B 是**整个 store** 的 `JSON.stringify` 长度（connection/document/realtime），**不是“元数据”本身**；with 36 字符 UUID 约 280 B。\n- ready p95 有两个口径：`run.mjs` floor 法 = **654**，`aggregate.mjs` ceil 法 = **680（= max）**；简历取 680 时必须说明聚合口径。\n- 性能数字测于 `c2ad879`（Preview 合入前）；HEAD 已含 `react-markdown/remark-gfm`，**bundle 已变大**，引用包体需重新 build。\n- “权限变化导致请求竞态”应改为**“授权结论过期”**：权限变化不发 HTTP 请求，服务端逐帧重查，UI 滞后约 3 s。
- 默认浏览器套件当前 **78/78**（73 + 5 preview）；`73/73` 是历史证据轮；remote **83 注册、未跑**。
- 只有 **two independent users** 验证；3+ 未验证；30 s 断网未测。
- 100k 是**病理单段落 fixture**，input P95 371 ms / Long Task ~400 的放大因素是 fixture 结构（block 对照 ~3.5 ms）。
- 100k 进入 Markdown Preview 在浏览器 **420 s 内未 ready**，是明确 limitation。
- AI 外部 provider **无成功 live 记录**（OpenAI 429 余额；Kimi 400 后改 prompt-only 未重试）。
- 没有可信 pre-optimization baseline，**不存在**“优化前后提升 X%”。

## 怎么用

1. 先看 [INTERVIEW-CHEATSHEET.md](INTERVIEW-CHEATSHEET.md)（2–3 页）。
2. 按简历顺序读 01→06；每份第 14 节是追问，第 16 节是口述。
3. 面试前只复习 cheatsheet + 每份第 18 节“记忆点”。
