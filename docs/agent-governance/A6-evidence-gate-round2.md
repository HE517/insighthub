# A6 · Evidence Gate 第二轮 — A 独立 browser context 协作 / C HTTP stale-response

**Status：** done（A PASS；C 的「document metadata」一半实测 **NOT APPLICABLE**，改测真实可取消路径并通过；无产品缺陷、无产品改动）
**Branch：** `agent/a6-evidence-collab`
**Worktree：** `D:\前端\react\项目\面试项目\Insighthub-wt-a6-evidence-collab`
**Base：** `9f4879f`（`docs(evidence): D-086 second-round evidence scope`）
**Commit：** `7245ceb`（证据代码提交；本报告在其后的独立提交里）
**日期：** 2026-10-25
**环境：** Windows 11（win32 10.0.26200 x64）· Chrome **155.0.8059.85**（headless）· Node **v22.14.0** · pnpm 10.34.7

**结论先说。** `docs/DECISIONS.md` D-086 批准的两项证据都已落地为**可重复的 committed 场景**，并且
`node tests/browser/run.mjs` **73/73 全绿、退出码 0**（ports released、11 个临时目录已清理、无残留句柄）。

- **A（独立 browser context 协作）→ PASS。** 两个 `Target.createBrowserContext` 独立 context（独立 cookie
  jar、独立 `localStorage`、独立 IndexedDB 分区）分别以 `demo-ada`(editor) 与 `demo-grace`(owner) 进入同一
  文档，并发执行前端 insert、尾部 insert、token delete、token replace；两轮编辑时间窗**实测重叠**
  （117 ms / 125 ms，388 ms / 252 ms），最终 A 编辑器文本 = B 编辑器文本 = 服务端 witness 文本（56 字符，
  与预期文本逐字相等），`sha256(Y.encodeStateVector(doc))` 三方完全一致
  （`bda0ea9c…803fdef`，19 字节，3 个 client）。`realtime/two-tabs-converge` 是同 profile 双 tab，**不再**
  被当作多人协作证据。
- **C（HTTP stale response）→ 如实降级 + 改测真实路径并 PASS。** 静态与动态都确认客户端在**打开/切换文档时
  不发任何 document-metadata HTTP 请求**（整段只有 `POST /api/session/bootstrap`；切换是 WS `join-room`
  → `room-joined`）。因此「document metadata stale response」记 **NOT APPLICABLE**，改测客户端唯一带
  `AbortController` 的 HTTP 读路径 `AiDirectory` 的 `GET /api/documents`：用 CDP `Fetch` 在 **response 阶段**
  扣住真实 200（body 4640 B / 28 个 document id），在窗口内真实切换 A→B，页面自己的请求日志在 **69 ms**
  后出现 `AbortError`（远早于内部 5 s timeout），再强行放行时浏览器拒绝投递
  （`Fetch.fulfillRequest → Invalid InterceptionId`）；随后 `active-document`、编辑器文本、面板状态全部仍是 B，
  重新打开目录得到**与服务端逐条同序**的列表且只有 B 是 `aria-current`，陈旧标记从未进入 DOM。

**没有发现产品缺陷。** 本轮没有改 `apps/**`、`packages/**`、`docs/CONTRACTS.md`、`docs/DECISIONS.md`、
`package.json`；改动只在 `tests/browser/**` 与本文件。

---

## A. 功能结果（本轮真实观测值）

运行命令（完整门禁）：

```bash
node tests/browser/run.mjs
# scenarios: 73 · passed 73 · failed 0 · errored 0
# postflight: ports 5173, 3101: released · temporary data directories removed: 11
#             live handles after teardown: none (the process exits on its own)
```

### A.1 `collab/independent-contexts` — PASS（2118 ms）

| 观测项 | 真实值 |
| --- | --- |
| 授权 fixture | `authz fixture: inserted a6-collab-independent demo-ada=editor`、`… demo-grace=owner`（测试 fixture 写 `authz_document_membership`，不是产品 seed） |
| 两个独立 context | `03A207F664F102A1934D049EB548AB8F` / `F3A0C8C3640588CC0894B17B7F61A04E`（`distinct: true`） |
| 存储分区 | A 写 `localStorage['__qa-context-probe']='A'` → B 读到 `null` |
| Cookie jar | 每个 context 恰好 1 个 `insighthub_session`，两者均 `HttpOnly`，**token 值不同**（只记录比较结果，不记录 token） |
| 身份/角色（浏览器渲染） | A: `demo-ada` → `Ada Lovelace` → `role: editor`；B: `demo-grace` → `Grace Hopper` → `role: owner`；两侧 `active-document` 均为 `a6-collab-independent` |
| 基线（由真实 `WireOracle` 以 `demo-grace` 身份写入并保持连接作 witness） | `ALPHA1122334455667788|middle|OMEGA9988776655443322`（50 字符） |
| round 1：并发前端 insert / 尾部 insert（逐字符真实输入） | A 窗口 `[1792923692301, 1792923692419]`（117 ms），B `[1792923692308, 1792923692433]`（125 ms），**overlap = true（111 ms）** |
| round 2：A 用 20 次真实 `Delete` 删除已知 token，B 用 1 次 `Ctrl+Shift+ArrowLeft` 选中已知 token 后逐字符输入替换 | A `[1792923692423, 1792923692811]`（388 ms），B `[1792923692562, 1792923692814]`（252 ms），**overlap = true（249 ms）** |
| 收敛（条件轮询，非固定 sleep） | A 56 字符 = B 56 字符 = server witness 56 字符；文本逐字等于预期 `[A-FRONT-2026]|middle|[B-OMEGA-REPLACED-20][B-BACK-2026]` |
| 编辑器未重挂载 | A/B `viewId` 与基线相同（2），远端更新不是整体替换 |
| **state-vector digest** | A = B = witness = `bda0ea9ca9b212d932a55fcce6c83881cb3f95406879da7e2333c81fe803fdef`；`stateVectorBytes: 19`、`clients: 3`、`textLength: 56`（只记录 digest/长度，**正文不出页面**） |
| 页面诊断 | 两页 `pageErrors: []`、`consoleErrors: []` |
| context 清理 | 场景内 dispose 成功（`{A:true,B:true}`），runner 无残留 context |

> digest 是「同一 CRDT 状态的确定性函数」，不是跨轮常量：每个 `Y.Doc` 的 `clientID` 随机，所以下一轮
> 同一份文档会得到不同 digest。断言因此是 `A = B = server`，而不是某个字面量。

### A.2 `stale/directory-list` — PASS（1187 ms）

**第一步（要求先静态确认）：客户端打开/切换文档时没有任何 document-metadata HTTP 请求。**

| 观测项 | 真实值 |
| --- | --- |
| 打开 + 切换期间页面自己的 `/api/**` 日志 | `[{method:'POST', path:'/api/session/bootstrap', t:236, status:200}]` — 仅此一条 |
| `GET /api/documents/:id` 计数 | **0**（断言） |
| 结论 | **NOT APPLICABLE**：打开/切换只走 WS `join-room` → `room-joined`。服务端路由存在，但客户端在此路径上从不调用 |

**第二步（改测最接近的真实 stale 路径：`AiDirectory` 的 `GET /api/documents`，R9 有 `AbortController` + 单调 requestId）。**

| 观测项 | 真实值 |
| --- | --- |
| 被扣住的响应 | `GET http://127.0.0.1:5173/api/documents`，`responseStatusCode: 200`，`Fetch.getResponseBody` 4640 B，含 28 个真实 document id（`a6-chaos-*`、`a6-collab-independent`、… ） |
| 扣住期间页面自己的请求 | `{path:'/api/documents', t:725, status:null, error:null}` — 应用的 `fetch` **确实未 settle**（pending 恰好 1 条） |
| 窗口内真实切换 | `setDocumentId(page, 'a6-stale-directory-b')`（页内时钟：请求 725 → 切换开始 764 → 切换完成 907） |
| **是否 abort** | **是**：同一条日志在 **794**（请求后 69 ms）变为 `error:'AbortError'`、`status:null` —— 早于 `requestJson` 内部 5 s timeout，因此是**切换引起的 abort**，不是超时 |
| 强行放行旧响应 | `Fetch.fulfillRequest` → `Invalid InterceptionId`（`delivered:false`）：浏览器拒绝投递一个页面侧已 abort 的响应 |
| 放行之后 UI/session | `activeDocument: a6-stale-directory-b`、编辑器 13 字符 = B 正文、`directoryPresent:false`、`directoryError:null`、`connectionStatus:connected`、陈旧标记 `STALE-RESPONSE-MARKER` **未出现在 DOM** |
| 请求日志最终状态 | 该请求仍是 `{status:null, error:'AbortError'}`（若真被投递成 200，`status` 会被写成 200） |
| 切换后重新打开目录 | 28 行，`aria-current` **只有** `a6-stale-directory-b`；渲染顺序与同一 session 的 `GET /api/documents` **逐条相同**；无陈旧行 |
| 页面诊断 | `pageErrors: []`（abort 不被渲染为失败：无 `ai-directory-error`、无 `session-failed`） |

### A.3 两个 claim 的最终状态

| Claim | 状态 | 依据 |
| --- | --- | --- |
| A1「两个完全独立 browser context 并发 insert/delete/replace，A/B/Server 文本一致，记录 state-vector/hash」 | **PASS** | §A.1（context id、存储/cookie 隔离、两轮时间窗重叠、三方文本相等、三方 digest 相等） |
| C2「document metadata 延迟 → 切 B → B 先回 → A 后回 → UI 保持 B」 | **NOT APPLICABLE**（metadata 请求不存在）+ **PASS**（真实可取消路径） | §A.2：客户端无该请求；`GET /api/documents` 被扣住 → 切换 → abort（69 ms）→ 浏览器拒投递 → UI/列表保持 B |
| C4「AbortController 实际使用」 | **PASS（此路径）** | 页面自己的请求日志出现 `AbortError`，且浏览器在 abort 后拒绝投递 |

---

## B. Files Changed

只改测试基础设施与治理报告，**没有任何产品文件**：

| 文件 | 职责 |
| --- | --- |
| `tests/browser/lib/cdp.mjs` | 新增 `createBrowserContext` / `disposeBrowserContext`，并让 `newPage(connection, { browserContextId })` 能在指定 context 内建页；既有 `newPage(connection)` 行为不变 |
| `tests/browser/run.mjs` | context 生命周期：`newBrowserContext()` / `closeBrowserContext()` 进 scenario context，`afterEach` 与 `finally` 兜底 dispose；`newAppPage` / `openInstrumentedPage` 增加 `browserContextId` 透传（默认 `undefined`，其它 71 个场景零影响） |
| `tests/browser/lib/oracle.mjs` | 新增 `WireOracle.stateVectorHash()`（`node:crypto` 对 `Y.encodeStateVector(doc)` 做 SHA-256），作为服务端侧 digest 见证 |
| `tests/browser/lib/app.mjs` | 新增真实输入辅助：`moveCaret`、`caretToStart`、`caretToEnd`（均为真实键事件） |
| `tests/browser/instrument/page-instrument.js` | 新增只读 `window.__qa.docStateVector()`：经 React fiber 取**活 session** → 用页面自己加载的同一 `yjs` 模块 URL 调 `Y.encodeStateVector` → SHA-256；不开启事务、不改文档、不导出正文 |
| `tests/browser/suite/08-evidence-gate.mjs` | 两个新场景：`collab/independent-contexts`、`stale/directory-list`（含全部断言与证据行） |
| `tests/browser/README.md` | 场景计数 71→73（远程模式 76→78）；新增「Independent browser contexts / State-vector digests / HTTP stale-response ownership」三节；`window.__qa` 控制表加 `docStateVector()`；场景表与 D-086 映射表 |
| `docs/agent-governance/A6-evidence-gate-round2.md` | 本报告 |

`git status` 证明 `apps/**`、`packages/**`、`docs/CONTRACTS.md`、`docs/DECISIONS.md`、`package.json` 均未改动。

---

## C. Acceptance 逐条

### C.1 Gate A1（`docs/agent-governance/CAPABILITY-EVIDENCE-INVENTORY.md` Gate A #A1）

| # | 要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1-1 | 两个**完全独立** browser context | **PASS** | `Target.createBrowserContext` ×2（不同 id）；`localStorage` 探针 A→B 不可见；两侧 cookie 各 1 个且 token 不同、均 `HttpOnly` |
| A1-2 | 独立身份（两个不同 demo 用户） | **PASS** | A `demo-ada`(editor) / B `demo-grace`(owner)，身份由 fixture `authz` 行 + 服务器签发 session 决定，页面只声明 `demoUserId` |
| A1-3 | 并发 **insert** | **PASS** | round 1：A 前端 insert、B 尾部 insert，时间窗 117 ms / 125 ms 重叠 111 ms |
| A1-4 | 并发 **delete** | **PASS** | round 2：A 以 20 次真实 `Delete` 删除 `ALPHA1122334455667788`（最终文本不含该 token） |
| A1-5 | 并发 **replace** | **PASS** | round 2：B `Ctrl+Shift+ArrowLeft` 选中 `OMEGA9988776655443322` 并输入 `[B-OMEGA-REPLACED-20]`（最终文本只含替换后的文本） |
| A1-6 | 操作尽量重叠 | **PASS** | 两轮均以 `Promise.all` 同时发起；编辑窗实测重叠（111 ms / 249 ms），不是串行 |
| A1-7 | 收敛（条件轮询 + 超时诊断） | **PASS** | 三方 56 字符一致、逐字等于预期；超时消息含三方长度与首个分歧 |
| A1-8 | A 编辑器文本 == B 编辑器文本 | **PASS** | `assertEqual(stateA.text, stateB.text)` |
| A1-9 | server-final-state equality（真实 `WireOracle`） | **PASS** | witness 文本 == 两侧文本；额外：witness 的 state-vector digest 也相等 |
| A1-10 | state-vector / deterministic hash，只记 hash 不记正文 | **PASS** | `bda0ea9c…`（19 B / 3 clients）；证据里只有 hash、字节数、client 数、文档长度 |
| A1-11 | 不把同 profile 双 tab 当最终证据 | **PASS** | `collab/independent-contexts` 使用两个独立 context；README 明确写出 `realtime/two-tabs-converge` 不是该 claim 的证据 |

### C.2 Gate C（D-086 §1 C / inventory C2、C4）

| # | 要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| C-1 | 先静态确认打开/切换是否发 HTTP | **PASS** | 实测 `__qa.apiCalls` 只有 `POST /api/session/bootstrap`；`GET /api/documents/:id` 计数 0 |
| C-2 | 若不存在 → 如实记 NOT APPLICABLE | **PASS** | 场景证据与 README 明确写 `NOT APPLICABLE`（并说明服务端路由存在、客户端不调用） |
| C-3 | 改测最接近的真实 stale 路径 | **PASS** | `AiDirectory` `GET /api/documents`（唯一带 `AbortController` 的 HTTP 读路径） |
| C-4 | 只延迟目标响应（真实响应） | **PASS** | CDP `Fetch` response 阶段扣住真实 200；`getResponseBody` 4640 B / 28 个 id |
| C-5 | 窗口内切换到 B | **PASS** | 真实 UI 切换；页内时钟 725→764→907 |
| C-6 | 放行旧响应 | **PASS** | 尝试 `Fetch.fulfillRequest`，浏览器以 `Invalid InterceptionId` 拒绝（如实记录） |
| C-7 | UI/session 保持 B，不被 A 覆盖 | **PASS** | `active-document`=B、编辑器=B 正文、面板已卸载、无错误 UI、陈旧标记未进 DOM |
| C-8 | 列表不被旧响应污染 | **PASS** | 重新打开目录：28 行与 server 列表逐条同序，`aria-current` 仅 B |
| C-9 | 若实现有 AbortController，额外断言 abort | **PASS** | 页面请求日志 `AbortError`（请求后 69 ms，早于 5 s 内部超时） |
| C-10 | 「ownership guard 在 abort race 下仍阻止覆盖」 | **未验证（构造不出）** | 见 §F：产品在每次 ownership 变化时都 abort，CDP 也拒绝投递，故 `requestId` 保护本身无法在不改产品的条件下被压测 |

---

## D. Evidence（可复现命令与产物）

```bash
# 基线
pnpm install && pnpm build && pnpm typecheck && pnpm test      # 基线全绿（见 §E）

# 本轮证据（全量）
node tests/browser/run.mjs                                     # 73/73, exit 0

# 只跑两个新场景（同样全绿）
node tests/browser/run.mjs --filter collab/independent-contexts
node tests/browser/run.mjs --filter stale/directory-list
```

产物：`tests/browser/artifacts/results.md`（人读，含每个场景的 `evidence` 块）、
`tests/browser/artifacts/results.json`（机读，含 `summary` 与 `cleanup`）。
本轮 `summary` = `{total:73, pass:73, fail:0, error:0, unexpectedFailures:0, ok:true}`，
`cleanup` = `{portsStillOpen:[], remainingHandles:[]}`，`removedDataPaths` 11 个。

新场景 id 与位置：`tests/browser/suite/08-evidence-gate.mjs`
（`collab/independent-contexts`、`stale/directory-list`）。

---

## E. Regression

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | **exit 0**（基线时执行；本轮未触碰任何 build input，`apps/**`/`packages/**` 零改动） |
| `pnpm typecheck` | **exit 0**（shared / server / web 三个项目全部 Done） |
| `pnpm test` | **exit 0**：vitest（根）**53 files / 568 tests passed** + server `# tests 500 / pass 500 / fail 0` |
| `pnpm test:unit` | **exit 0**：`Test Files 53 passed (53)`、`Tests 568 passed (568)`、`Duration 8.34s` |
| `node tests/browser/run.mjs` | **exit 0**：`scenarios: 73 · passed 73 · failed 0 · errored 0`；ports released；无残留句柄 |

既有 71 个场景**未修改一行断言**（`git diff` 只涉及 §B 的文件；`08-evidence-gate.mjs` 是新增文件）。
`newPage` / `newAppPage` / `openInstrumentedPage` 的新参数默认 `undefined`，默认行为与之前逐字节等价；
`afterEach` 新增的 context 清理只对「场景自己创建的 context」生效（默认集合为空）。

---

## F. Known Risks / 未验证内容

1. **C 的 document-metadata 一半不存在（NOT APPLICABLE）。** 这不是「没测」，而是**实测**客户端在打开/切换
   文档时不发任何 metadata HTTP 请求。项目描述里若写「document metadata 的 stale response 防护」，必须降级
   为「目录列表请求（`GET /api/documents`）的 stale 防护 + AbortController」，否则就是把没有的路径写成有的。
2. **`requestId` ownership guard 未被压测。** 本产品在每次 ownership 变化时都 abort，且 CDP 拒绝投递已 abort
   的响应，所以在**不改产品**的前提下构造不出「旧响应真的到达、被 guard 丢弃」的实例。本场景证明的是
   传输层（请求被取消、浏览器不投递）+ UI 层（新文档不被覆盖），**不能**读成「guard 本身被验证」。
3. **abort 与 timeout 的区分依赖内部 5 s 常量。** 场景断言「abort 观测时间 - 请求开始 < 5000 ms」且错误名是
   `AbortError`（`TimeoutError` 是另一名字）。若 `requestJson` 的 `timeoutMs` 默认值改变，这条判别条件要跟着更新。
4. **`docStateVector()` 依赖 React fiber 与 Vite dep URL。** 它通过 `__reactFiber$` 找到
   `CollaborativeMarkdownEditor` 的 `memoizedProps.session`，并用 resource timing 里的同一 `yjs` 模块 URL
   重新 import。React 大版本或 Vite dep 布局变化会**显式失败**（返回 `{ok:false, reason}` → 场景红），不会静默
   通过；但这是 harness 与框架内部结构的耦合，升级时要一起看。
5. **digest 不跨轮稳定（按设计）。** 见 §A.1 说明；不要把它写成「固定 hash」。
6. **只验证 headless。** 本轮 73 个场景全部在 `--headless=new` 下运行；`--headed` 未重跑。
7. **远程 AI 模式未重跑。** `INSIGHTHUB_E2E_AI_MODE=remote` 的场景数按新增规则应为 **78 = 73 + 5**，本轮
   **没有**执行远程模式（A/C 两项与 AI provider 无关），如需该数字请单独跑一次。
8. **B（100,000 行 performance baseline）不在本轮范围。** D-086 把它列为独立 `Performance Evidence Gate`，
   本轮未触碰 `05-performance.mjs`。

---

## G. Next Handoff

Handoff Status: **OWNER_DECISION_REQUIRED**
Recommended Next Agent: **A0**
Base: `agent/a6-evidence-collab` @ `7245ceb`（证据代码；本报告为紧随其后的提交）
Why: A1 与 C 的真实证据已落地并全绿（73/73），可以据此把 inventory 的 A1 从 `NOT VERIFIED` 改为 `PASS`、
把 C2 拆成 `NOT APPLICABLE（document metadata）` + `PASS（目录列表 + abort）`；需要 A0 决定 claim 的最终措辞与
是否接受「ownership guard 未被压测」作为可接受 residual。
Dependencies satisfied: `tests/browser` 全绿（73/73）、`pnpm typecheck` / `pnpm test` 全绿、无产品改动、
无契约变更。

**需要 A0 决定的三点：**

1. **措辞**：A1 是否直接记 `PASS`（建议：是，条件是注明「独立 context + state-vector digest」这两个加强项）；
   C 是否按「metadata = NOT APPLICABLE，目录列表 = PASS」拆分（建议：是）。
2. **是否要求补 ownership guard 的证据**：若要求，只能在产品侧注入（例如可配置的「不 abort」开关）——这属于
   产品改动 + 新契约，超出 A6 只加测试的授权范围（建议：记为 residual，不为此改产品）。
3. **是否现在跑远程 AI 模式**确认 78 这个数字（建议：不需要，除非要发布该数字）。

Copy-paste Prompt（给 A0 / 集成复核）：

```text
A0 复核 A6 Evidence Gate 第二轮（D-086 A/C）：
- 分支 agent/a6-evidence-collab，base 9f4879f；只新增测试基础设施与
  docs/agent-governance/A6-evidence-gate-round2.md，无产品改动。
- 门禁：pnpm typecheck、pnpm test、node tests/browser/run.mjs（73/73）均绿。
- 请判定：A1 记 PASS 的措辞；C 拆成 NOT APPLICABLE（document metadata）+
  PASS（AiDirectory GET /api/documents，abort 69ms、浏览器拒投递、UI 保持 B）；
  以及是否接受「requestId ownership guard 未被压测」为 residual。
- 不要改 tests/browser/** 的断言来让结论更好看；如需产品侧注入 abort 开关，另立任务。
```
