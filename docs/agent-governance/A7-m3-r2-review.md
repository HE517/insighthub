# M3 Round 2 独立终审（A7 / 独立终审门）

**Base：** `main @ c335508`（worktree HEAD 同为 `c335508`）
**Branch：** `agent/a7-m3-r2-final`
**Worktree：** `D:\前端\react\项目\面试项目\Insighthub-wt-a7-m3-r2-final`
**日期：** 2026-10-22
**结论先说：GO WITH CONDITIONS** —— 用于**把 M3 标为 CLOSED**。
代码与行为层面 **P1 = 0**，四门禁与两套浏览器证据在本 HEAD 全绿（默认 **68/68**、remote **73/73**）。
但 CLOSED 之前还有 **3 条 P2（全部是文档/决策记录与实现不一致）** 必须先由 A0 处置，另有 **5 条 P3**、**16 条必须进发布说明的 residual/limitation**，以及项目负责人对 CLOSED/tag 的授权。**这些不由我或 A0 自行决定。**

---

## 0. 我的独立性声明

- 我不采信任何 agent 的自述作为结论依据。A5 报告、A6 场景、A3/A4 的报告描述只当作"待验证的假设"；每条结论下面给的是我读到的代码行、我自己跑出来的输出，或我自己构造的探针结果。
- 我在本 worktree 里删掉了缺失的 `node_modules` 状态后重新 `pnpm install --frozen-lockfile`，四门禁由我串行执行；两套浏览器套件各跑一次（先默认 68，再 remote 73），跑前确认 `3111`/`5181` 空闲，跑后确认已释放。
- 我写了两个一次性探针（web 7 例、server 3 例），**跑完全部删除**；最终 `git status` 只有本报告一个新增文件（§16）。
- 我没有改任何生产代码、测试、契约、seed 或其它 docs；没有 commit / merge / push / tag / 关闭 milestone。

---

## 1. 任务状态

- `Status`: **done**（审查本身完成；被审对象 = M3 round 2，基线 `c335508`）
- `Branch`: `agent/a7-m3-r2-final` ／ `Commit`: **未提交**（本轮唯一交付物是本报告）
- `Release Recommendation`: **GO WITH CONDITIONS**（对 `m3-closed`）
- `P1 = 0 / P2 = 3 / P3 = 5`

## 2. 本轮目标

在 `c335508` 上独立回答：

1. round 2 新增的**服务端** `POST /api/ai/suggest` + `OpenAiProvider` + `AI_PROVIDER=stub`，以及客户端 `RemoteProvider` + provider 工厂 + AI directory，是否真的满足 D-080 与 `CONTRACTS §11.2` 的冻结语义；
2. 两个修复（`applySuggestion` 的 `documentId` 守卫；remote provider 的折叠光标归一化 + no-op draft 拒绝）是否真的成立、是否有回归测试；
3. round 1 的 A–H 与 F1–F12 是否被本轮破坏；
4. D-078 的 original-scope reconciliation 在 round 2 之后应如何更新（directory、真实 provider）；
5. `AI_PROVIDER=openai` 的生产启用前置是否已被记录；
6. 能否把 M3 标为 CLOSED。

## 3. 结论摘要（结论，不是活动）

- **四门禁与两套浏览器证据在本 HEAD 全绿**：typecheck 0 / test 0（vitest **509** + server **229**）/ build 0 / browser **68/68** + remote **73/73**（§5）。
- **六项关键性质由我自己独立复核**（§6），不是只读测试名：服务端只返回 draft 且不读 store；404 四态逐字节一致；失败矩阵全部固定 body；生产 bundle 无凭据；`documentId` 守卫在**三段校验会放行**的跨文档 insert 上把它拒成 `malformed` 且文本不变；remote provider 的折叠光标与 no-op draft 行为正确。
- **A–H 全部 PASS**（§9）；round 1 的 7 个 AI 场景与 53 个既有场景在本 HEAD 全部重跑通过，零回归。
- **R2-1（directory）能力上 DONE，但有一条与 D-078 明文不一致的行为**（选择另一文档时面板关闭，而 D-078 写"面板保持打开"，且代码注释把 D-078 引用成"支持关闭"）→ **N2（P2）**。
- **R2-2（真实 provider）应判"实现完成、未做 live 验证"**：适配器 + 失败矩阵 + 真实 HTTP 链路（stub）+ 浏览器证据都有；**从未调用真实 OpenAI**（无 key，且 D-080 §4 禁止 Gate 联网）。它不是 `NOT IMPLEMENTED`，也**不是**"已验证的真实模型"。
- **round 1 条件**：F1/F3/F4/F5/F6/F7 仍关闭，F8 半关闭（`listDocuments` 已有消费者），F9/F10/F11/F12 仍按记录保留；**但 F2 从未被真正关闭** —— `ARCHITECTURE.md` §3 的"locally or remotely"原句仍在，而 D-077 §1 声称已改写 → **N1（P2）**。
- **M4 生产启用前置只被"分散提及"，没有被记录成一道门**（§11）→ **N8（P3，A0）**。

## 4. 复核方法

| 手段 | 具体做法 |
| --- | --- |
| 读代码 | 以 `CONTRACTS §11.2` / D-080 为规格逐条对照实现；错误矩阵逐行对应 |
| 自跑门禁 | 串行跑四门禁；两套浏览器套件各一次（不同 `INSIGHTHUB_E2E_AI_MODE`） |
| 自写探针 | web 7 例 + server 3 例，全部删除；不 mock Yjs、不 mock authz |
| 交叉验证 | A5/A6 的结论只在"我也观察到同一现象"时引用，且引用的是我的运行输出 |
| 反向证据 | 用 `validateSuggestionAgainstDocument` 先证明"校验会放行"，再证明守卫拒绝——避免把"守卫没被触发"误读为"守卫有效" |
| 静态检索 | 生产 bundle 的凭据检索；AI 模块 import 面；`applySuggestion` / `listDocuments` / `aiAcceptRequiredRole` 的消费者计数 |
| 范围对照 | `git diff 990b9be..HEAD`（round 2 窗口）确认改动面与未触碰面 |

**round 2 窗口的改动面**（`git diff --stat 990b9be..HEAD`，节选）：新增 `apps/server/src/ai/**`（4 个生产模块 + 4 个测试 + test-support）、`apps/web/src/features/ai/{aiProvider,remoteProvider}.ts` 与测试、`features/editor/{AiDirectory.tsx,aiDirectoryCopy.ts,aiDirectory.test.ts}`、`tests/browser/suite/33-m3-remote.mjs`；改 `app.ts`/`index.ts`（挂载与启动日志）、`AiSuggestPanel.tsx`、`DocumentWorkspace.tsx`、`apply.ts`（+`documentId`）、`remoteProvider.ts`（两个修复）、`CONTRACTS §11.2`、`DECISIONS D-080`、`TASKS/PROJECT/ARCHITECTURE`、`packages/shared/src/ai-suggestion.ts`（draft / selection 三个导出 schema）。**`binary-frame.ts` / `protocol.ts` 未改；`SHARED_CONTRACT_VERSION` 仍 8、`PROTOCOL_VERSION` 仍 2；没有新增依赖。**

## 5. 四门禁（我在 `c335508` 上自跑，真实计数、exit code、耗时）

安装前提：worktree 无 `node_modules`。

```text
$ pnpm install --frozen-lockfile
Progress: resolved 288, reused 288, downloaded 0, added 288, done
Done in 13.8s using pnpm v10.34.7
exit code: 0（本次调用墙钟 13.8 s）
```

| # | 命令 | exit | 真实计数 | 耗时（墙钟） |
| --- | --- | --- | --- | --- |
| 1 | `pnpm typecheck` | **0** | shared / server / web 三个 project `Done` | **9.9 s** |
| 2 | `pnpm test` | **0** | vitest `Test Files 45 passed (45)` / `Tests 509 passed (509)`；server `# tests 229` / `# suites 81` / `# pass 229` / `# fail 0` | **56.5 s**（node:test 自身 43.6 s） |
| 3 | `pnpm build` | **0** | shared+server tsc，web `tsc --noEmit && vite build`；172 modules；主 chunk `965.13 kB`（gzip 316.16）；CSS 20.67 kB | **20.7 s**（vite 5.94 s） |
| 4 | `node tests/browser/run.mjs`（`INSIGHTHUB_E2E_SERVER_PORT=3111 INSIGHTHUB_E2E_WEB_PORT=5181`） | **0** | `scenarios: 68 · passed 68 · failed 0 · errored 0` | **323 s** |
| 5 | 同 4 + `INSIGHTHUB_E2E_AI_MODE=remote` | **0** | `scenarios: 73 · passed 73 · failed 0 · errored 0` | **322.5 s** |

**这些数字与最终交付树的关系：** 门禁与两套套件是在"只有 `c335508` 的代码、本报告尚未写入"的工作树上跑的；之后我只新增了两个一次性探针（跑完删除）与本报告（docs，不参与 typecheck/test/build）。代码面在门禁之后没有任何改动，`git status` 最终只有本报告。

**计数口径说明（避免读者误读）：**

- vitest **509** vs A5 复核时的 **506**：两个修复提交各自带测试（`apply.test.ts` 跨文档 +1、`remoteProvider.test.ts` 折叠光标/无变化 +2，`git diff --stat 82f9c76..HEAD` 只动了这两个测试文件），**509 = 506 + 3**；server **229** 与 A5 一致（round 2 的端点测试在 A5 之前已合入）。
- **`pnpm test` 不打印任何合并总数**：它是 `vitest run && pnpm --filter @insighthub/server test`，先后打印两套互不相干的 reporter（`Test Files / Tests` 与 `# tests / # pass / # fail`）。"509 + 229" 必须人工相加。这是脚本结构，不是本轮新问题。
- **浏览器套件的聚合汇总确实打印**：`scenarios: N · passed N · failed 0 · errored 0`；默认跑 postflight 显示 `ports 5181, 3111: released`、`temporary data directories removed: 11`、`live handles after teardown: none`；remote 跑同样显示 `ports 5181, 3111: released`、`temporary data directories removed: 12`、`live handles after teardown: none`。
- remote 跑的顺序与设计一致：先跑完 68 个默认场景（含 `ui/8`），然后 `m3r/1` 在组边界把栈切到 `AI_PROVIDER=stub` + `VITE_AI_PROVIDER=remote`，再跑 `m3r/1…m3r/5`；`m3r/2` 在 `finally` 里把后端恢复为 stub，下一个场景重新 `ensureRemoteAiStack`。五个 m3r 全部 PASS。
- 全程只有一个浏览器套件在跑（两跑串行），没有跨 worktree 并行。

## 6. 关键性质：我自己构造/执行的复核

### 6.1 探针 A（web，7 例）——`applySuggestion` 的 `documentId` 守卫

文件临时创建为 `apps/web/src/features/ai/a7r2Probe.test.ts`，`pnpm exec vitest run` → **7 passed / 0 failed / exit 0**（985 ms），跑完删除。核心三例：

| 用例 | 我的断言与实测 |
| --- | --- |
| A 文档的 **insert-at-end** 提案，在 B 文档上用真实 `Y.Doc` 应用 | `validateSuggestionAgainstDocument(suggestion, docB, 0)` → **`{ok:true}`**（type-level 锚点 + `expectedText===''` + 两边 revision 都 0，三段校验确实会放行）；随后 `applySuggestion(applyPort(docB,'doc-b'), …)` → **`{ok:false, reason:'malformed'}`**；`docText(docB)` **逐字未变** |
| **空文档 insert@0** 提案照搬到非空 B | 同上：validation **ok**、apply **`malformed`**、B 不变 |
| 阳性对照：同一提案在自己的文档上 | **`{ok:true, applied:1}`**，A 变为 `alpha FROM-A` —— 守卫没有误拒 |

这条比"读测试名"更强的地方在于：它证明了**守卫是唯一拦住跨文档写入的那一层**（否则 validation 会放行）。仓库里也有永久回归测试（`apply.test.ts:321-334`）。

### 6.2 探针 A 的另外 4 例——remote provider 的两个修复

| 用例 | 实测 |
| --- | --- |
| 折叠光标 `{from:3,to:3}` | 请求体**没有** `selection` 键（`Object.prototype.hasOwnProperty === false`） |
| 真实选区 `{from:0,to:5}` | 请求体 `selection === {from:0,to:5}`，原样发送 |
| **schema 合法但无变化**的 draft（`replace 0..5 -> 'alpha'`，不是空文本退化用例） | `RemoteProviderError{kind:'invalid-output'}`；文档文本不变 |
| schema 合法且真的改变 | 返回 `AiEditSuggestion`（`documentId` 保留、1 个 operation、diff 含 `+++ proposed`），**此时仍未写文档** |

A4 的永久单测也覆盖这两条（`remoteProvider.test.ts:210-242`），我读了断言并复跑了整个文件（在门禁的 509 里）；上面是我自己的最小复现。

### 6.3 探针 B（server，3 例）——404 非披露、失败矩阵、seam 输入

文件临时创建为 `apps/server/src/ai/a7r2Probe.test.ts`，`tsx --test` → **3 suites / 3 pass / 0 fail / exit 0**（896 ms），跑完删除。用真实 `createApp` + 真实 `authz` + 真实 HTTP server，唯一注入的是 provider。

| 用例 | 我的断言与实测 |
| --- | --- |
| AI unknown / AI 无 membership / `GET /api/documents/:id` unknown / GET 无 membership | 四份快照 **完全 deepEqual**：`status 404`、body `{"error":"not_found"}`、`content-type application/json; charset=utf-8`、`content-length`/`etag`/`vary`/CORS 相同（只排除 `date` 与 TCP 的 `connection`/`keep-alive`）；都**没有** `set-cookie`，body 不含 `operations`/`summary`。且该用例的 provider 设计成"被调用就抛错"——404 用例通过即证明**授权先于 provider** |
| 401 / 503（provider=null）/ 504 / 502 provider / 502 invalid-output / **schema 非法的 draft** 六态 | 每个响应 `JSON.parse` 深等于 `{"error": …}`；文本不含 `operations`/`summary`/`SECRET`/instruction 片段。provider 的 message 里我故意塞了 `SECRET-KEY sk-live-xyz` 与 prompt 原文，**一个都没出现在响应里** |
| seam 输入 | 200 的 body 键恰好 `['operations','summary']`；provider 收到的对象键恰好 `['content','instruction','selection']`（**没有** `documentId`/`baseRevision`），`content` 是请求体里我编的"服务端不存在的快照"，`JSON.stringify(input)` 不含 `documentId` |

### 6.4 服务端不读 store（源码 + 结构 + 行为）

- **结构**：`startAiHarness` 调 `createApp(config, authz, aiProvider)`，**根本没有 `DocumentStore`/`DocumentRoom`**，端点仍 200 —— 没有可读的服务端正文源。
- **源码**：`apps/server/src/ai/{route,provider,openai,stub}.ts` 的 import 面只有 `express`、`@insighthub/shared`、`../authz/public.js` 与本地模块；没有 `persistence/**`、`rooms/**`、`ws.js`、`yjs`、`app.js`（A5 的静态测试 + 我自己复核 import 段）。
- **行为**：provider 收到的 `content` 与我在请求体里编的内容逐字相同（§6.3 第三行）。

### 6.5 生产 bundle 无凭据

`pnpm build` 产物 `apps/web/dist/**` 逐文件检索（我自己的正则）：`OPENAI` / `api.openai.com` / `Bearer` / `Authorization` / `sk-[A-Za-z0-9]{8}` / `VITE_OPENAI` **全部 0 匹配**；`/api/ai/suggest` 出现 1 次（预期，前端会调），`VITE_AI_PROVIDER` 作为**变量名**出现 1 次（不是 key）。这与我读到的 `aiProvider.ts` 只比较字面量 `"remote"`、`remoteProvider.ts` 只用 `credentials:'include'` 一致。

### 6.6 其余静态事实

| 事实 | 我的检索 |
| --- | --- |
| `applySuggestion` 生产消费者只有面板一处，且传 `documentId: session.documentId` | `AiSuggestPanel.tsx:257-265` |
| `listDocuments` 现在有生产消费者 | `AiDirectory.tsx:48,95` |
| `aiAcceptRequiredRole` 仍**零**消费者 | 三个包 grep 只有 `packages/shared/src/ai-suggestion.ts:186` 定义处（D-077 §3.2 已裁定"保留"，不算回归） |
| 服务端没有文档写端点 | `app.ts` 的文档路由仍只有 `GET /api/documents`、`GET /api/documents/:id`；唯一写入仍是 `registry.ts` 的 WS pipeline |
| Express 版本 | `express ^5.1.0`（async handler 的 rejection 会被全局 error handler 转成 `500 internal_error`，不会悬挂请求） |

## 7. Round 1 条件（F1–F12）是否被本轮破坏

只回答"是否被 round 2 破坏 / 是否仍成立"，不重开旧账。

| # | round-1 处置 | 本 HEAD 的事实 | 判定 |
| --- | --- | --- | --- |
| F1 文档状态 | 已修（PROJECT/TASKS 不再写 not started） | `PROJECT.md:40`、`TASKS.md:770-777` 仍是"round 1 已实现、未 CLOSED"；**没有**"not started"（唯一的 `not started` 是 M4 行，正确） | **未破坏**（但见 N3：round-2 的状态又需更新） |
| F2 `ARCHITECTURE` "remotely" | D-077 §1 声称已改写 | **`ARCHITECTURE.md:150-152` 原句仍在**："If the document has moved on (locally or remotely) by the time the user clicks Accept, the suggestion is stale"。后面新增的三段校验说明**没有删改前一段** | **未关闭（N1，P2）**——不是被 round 2 破坏，而是 D-077 的"已修"表述过强 |
| F3 §11.1 删除 anchor 括号 | 已修 | `CONTRACTS.md:610` 现写"deleted region still resolves … caught by check 3" | 仍关闭 |
| F4 D-076 §4b 离线 viewer | 已修 | `DECISIONS.md:3078-3084` 有"勘误（A5/A7 实测纠正）" | 仍关闭 |
| F5 D-075 "不发网络请求" | 已修 | `DECISIONS.md:2990-2992` 区分"AI 生成本身不发请求"与 directory 工具 | 仍关闭 |
| F6 revision/undo 注释 | 已修 | `revision.ts:53-66` 明确 undo 不移动计数器、fail-closed | 仍关闭 |
| F7 `toJSON` 注释 | 已修 | `ai-anchor.ts:65-68`、`ai-suggestion.ts:34-36` 明确 13.6.33 无实例 `toJSON()` | 仍关闭 |
| F8 未使用面 | 记录 | `listDocuments` **已接线**（directory）；`aiAcceptRequiredRole` 仍零消费者（已裁定保留） | **半关闭**，与 D-077 一致 |
| F9 provider 同步抛出 | 记录不修 | 面板仍 `void provider.suggest(…).then(…)`，没有 try；两个 provider 都是 `async`，仍不可达 | 未破坏 |
| F10 transact 中途抛错 | 记录 | 未变 | 未破坏 |
| F11 大文本 diff 预览 | 记录 | 未变 | 未破坏 |
| F12 `anchor-unresolved` / commenter 仅 Node | 记录 | 浏览器仍只有 revision / text-mismatch；无 commenter 场景 | 未破坏（仍须写进 residual） |

**结论：round 2 没有破坏任何已关闭项。** 但 F2 的关闭是**名义上的**：D-077 §1 的"改写"只新增了后文，没有删掉冲突原句。这条是 round-2 终审的 N1。

## 8. D-078 reconciliation：directory 与真实 provider 的真实状态

### 8.1 directory：PARTIAL → **DONE**（能力上），但带一条行为偏差（N2）

D-078 §4 R2-1 要求的六件事，我逐条验收：

| 要求 | 事实 | 证据 |
| --- | --- | --- |
| 把 `listDocuments` 接进 AI 面板 | 已接：`AiDirectory` 在面板右栏，挂载即 `GET /api/documents`，Refresh 重取，卸载 abort | `AiDirectory.tsx:74-142`；`m3r/3`、`m3r/4` |
| 只读 | 没有任何写调用；只 dispatch 既有 `documentSelected` | `DocumentWorkspace.tsx:163-172` |
| 列出"当前身份可读"的文档 | 服务端 `GET /api/documents` 的唯一权威；不是前端猜测 | `m3r/3` 的 `directory.items` |
| 标出当前文档 | `aria-current="true"` + `current` 标签，恰好一行 | `m3r/3` 断言 `currentMarkers.length === 1` |
| 选中另一文档复用既有切换语义 | `dispatch(documentActions.documentSelected)`，无新 action / 新路由 | `DocumentWorkspace.tsx:163-172`；`m3r/3` |
| **"面板保持打开"** | **未实现**：`App.tsx` 按 `documentId` key 住 workspace，切换即卸载面板；`m3r/3` 明确断言 `panelPresent=false`，需要重新打开 | `DECISIONS.md:3206` vs `AiDirectory.tsx:29-35`、`33-m3-remote.mjs:898-908`、`m3r/3` 运行结果 |

**我的判定：directory 作为一项能力 = DONE**（有真实浏览器证据、有服务端权威、无新写路径），**但 R2-1 的"面板保持打开"这一条未实现**，且实现方的注释把 D-078 引用成"明确支持关闭"——这是对决策记录的错误引用。**N2（P2，A0/A2）**。

补充一句必须写进文档的话：directory 在 `VITE_AI_PROVIDER=local`（默认）下**也会**在面板打开时发一次 `GET /api/documents`。这与更新后的面板文案（"The document list is read from the server."）一致，但"local 模式完全不发网络请求"的旧表述不能再被引用。

### 8.2 真实 provider：**IMPLEMENTED（adapter）/ 未做 live 验证**，不是 `NOT IMPLEMENTED`

D-078 §2 的表是**以 `881dd0e` 为代码事实**的时点记录（它自己写明了）。在 `c335508` 上，真实 provider 的事实是：

| 层 | 事实 | 证据 |
| --- | --- | --- |
| 适配器 | `OpenAiProvider`：global `fetch`、无 SDK、key 只在服务端、`AbortSignal.any(caller, timeout)`、上游 body 从不读取/回显 | `openai.ts:162-258` |
| 输出验证 | 模型文本 → 严格 JSON（允许单一 ```json 围栏）→ `aiSuggestionDraftSchema` → offsets 必须在 `content` 内；任一失败 `invalid-output` | `openai.ts:301-339` |
| 失败矩阵 | 401/403/429/5xx → `provider` → 502；超时/取消 → 504；非 JSON/schema 不符 → 502 `invalid_provider_output`；未配置 → 503 | `route.ts:213-238`；`openai.test.ts`；`route.test.ts` |
| 真实 HTTP 链路 | 浏览器 → `POST /api/ai/suggest` → 服务端 stub → draft → 客户端铸锚 → 预览 → Accept → durable，全程真实 | `m3r/1`、`m3r/5`（我这跑 PASS） |
| **真实模型** | **从未联网调用**：没有 key，D-080 §4 也禁止 Gate 调真实模型 | 本轮无 live smoke |

**我的判定：** 状态词应是 **`IMPLEMENTED (server adapter, unit + failure matrix + real-HTTP-via-stub) / NOT LIVE-VERIFIED`**。
把它继续写成 `NOT IMPLEMENTED` 与代码不符；把它写成"真实模型已验证"同样不诚实。D-078 与 PROJECT/TASKS 的 round-2 状态必须按这个口径更新（**N3，P2**）。

## 9. 逐条判定（round-1 A–H + round-2 R2-1/R2-2/R2-3/R2-4）

### 9.1 A–H（D-075 §6）

| # | 判据 | 判定 | 本 HEAD 的证据 |
| --- | --- | --- | --- |
| A | Accept 走 Yjs transaction（`ai` origin），第二客户端看到普通 CRDT 编辑 | **PASS** | 默认 `m3/5` PASS；remote `m3r/1` PASS（durable 逐字符等于 `toUpperCase()`）；`apply.test.ts` 断言 `origins === [ai]` |
| B | Reject 不改 `Y.Text`（文本与 durable 均不变） | **PASS** | `m3/6` PASS（我这跑） |
| C | stale 三情形各自被拒 | **PASS**（anchor-unresolved 仅 Node） | `m3/7`（revision）、`m3/9`（text-mismatch）PASS；`anchor-unresolved` 由 Node 单测 + 我 §6.1 的 type-level 探针覆盖，**无浏览器证据** |
| D | 并发编辑后 RelativePosition 正确 | **PASS** | `m3/8`（区域外仍应用）与 `m3/9`（区域内拒绝）PASS |
| E | undo 隔离 | **PASS** | `m3/5` PASS；`m3r/1` 的 Undo/Redo 逐字符回到 baseline/uppercase；round 1 的真实 `Y.UndoManager` 结论未被本轮改动 |
| F | 权限：viewer/commenter 不能绕过；accept 需 editor | **PASS**（commenter 仅代码级） | `m3/10`、`p2/*` PASS；`features/ai/**` 仍 0 处权限判定；commenter 与 viewer 同 `canEdit=false`，**无独立浏览器场景** |
| G | 离线可生成、重连不重复 apply、多客户端收敛 | **PASS** | `m3/11` PASS（owner 恰好一次；离线 viewer 为已知本地分叉，见 residual） |
| H | 既有 53 场景零回归；四门禁 integrated HEAD 全绿 | **PASS** | 68/68（含既有 53 + m3/0…11 + ui/1…8）；typecheck/test/build 全 0（§5） |

### 9.2 round-2 新增

| # | 判据 | 判定 | 证据 / 边界 |
| --- | --- | --- | --- |
| R2-1 | directory 接线（只读、标当前、复用切换、无新写路径） | **PASS（能力）** / **P2 偏差** | `m3r/3`、`m3r/4` PASS；无新写路径；**"面板保持打开"未实现 → N2** |
| R2-2 | 真实 provider：服务端持 key、产出仍是 proposal、失败一律 fail closed；Gate 只用确定性 provider；live smoke 仅 key 存在时 opt-in | **PASS（实现+确定性证据）** / **真实模型未验证** | `openai.ts` + `openai.test.ts` + `route.test.ts` + 我 §6.3 的失败矩阵；`m3r/1`、`m3r/5` 真实 HTTP；**没有 live smoke**（无 key） |
| R2-3 | integrated Gate + A7 复审 | **PASS（门禁侧）** / 本报告 = 复审 | 四门禁 + 68/68 + 73/73 |
| R2-4 | `m3-closed` | **未执行** | 需项目负责人授权（D-053 §5 / D-073 §4） |

## 10. 新发现（P1 / P2 / P3）

**P1 = 0。** 我没有发现任何"会写错文档 / 越权写 / 数据丢失 / 契约被破坏 / 凭据外泄"的缺陷。

### P2

**N1（P2，A0，冻结文档）`ARCHITECTURE.md` §3 仍保留与 §11.1、验收 D 冲突的 stale 语义。**
- 现象：`ARCHITECTURE.md:150-152` 写 "If the document has moved on (locally or remotely) … the suggestion is stale"；§11.1（`CONTRACTS.md:588-602`）与验收 D 明确：**远端编辑不触发 check #1**，区域外远端编辑应仍可应用，区域内由 `expectedText` 拒绝。
- 机制/根因：round-1 的 F2 修复只**追加**了后文三段说明（`ARCHITECTURE.md:154-170`），没有删改冲突原句；D-077 §1 因此把 F2 记成"已改写"，实际是"部分改写"。
- 影响：后来者按第一段实现"任何远端 update 都让提案 stale"，会直接破坏 `m3/8` 的验收语义。它不改变当前代码行为，因此不是 P1。
- 复现：读 `docs/ARCHITECTURE.md:150-152` 与 `docs/CONTRACTS.md:588-602`；我这跑的 `m3/8` PASS 证明正确行为。
- 归属：**A0**（冻结面，需 Supervisor 编辑）。

**N2（P2，A0/A2，决策记录 vs 实现）directory 切文档时面板关闭，而 D-078 §4 R2-1 写"面板保持打开"；实现注释把 D-078 引用成支持关闭。**
- 现象：`DECISIONS.md:3206`（D-078 §4 第 1 行）明确"选中另一文档时复用既有文档切换语义（`documentSelected`），**面板保持打开**"；实现与证据则相反：切换后 `AiDirectory`/面板随 workspace 卸载，`m3r/3` 断言 `panelPresent=false`，用户需重新打开面板才能继续生成。
- 机制/根因：`App.tsx` 按 `documentId` key 住 `DocumentWorkspace`（一 socket 一 room，§5.4），面板在该 workspace 内，所以"保持打开"在不违反冻结生命周期的前提下**不可实现**；A2 选择了"关闭"并在 `AiDirectory.tsx:29-35` 写下 "That is the frozen lifecycle, not a regression — `docs/DECISIONS.md` D-078 §4 R2-1 explicitly keeps it" —— **这句引用与 D-078 原文相反**。
- 影响：产品行为与已接受的 owner-level 处置不一致，且代码里留了一句会被后人当证据的错误引用。它不构成安全/正确性问题（提案仍只针对当前文档，锚点不跨文档），因此不是 P1。
- 复现：读 `DECISIONS.md:3206`、`AiDirectory.tsx:29-35`、`AiSuggestPanel.tsx:53-56`、`33-m3-remote.mjs:898-908`；我这跑的 `m3r/3` PASS（它断言的正是"面板消失"）。
- 归属：**A0**（决策记录的勘误/取代）+ **A2**（若决定改行为，才动代码）。**必须二选一落纸**：要么 D-078 记勘误"面板随 workspace 关闭，R15 决定其不可保持打开"，要么实现改为在切换后自动重开面板（代价与风险另评）。

**N3（P2，A0，状态文档）D-078 / PROJECT / TASKS 的 round-2 状态未更新，若现在 CLOSED 会留下"required 能力未实现"的错误记载。**
- 现象：`PROJECT.md:40` 与 `TASKS.md:770-774` 仍写"directory PARTIAL / 真实 LLM provider NOT IMPLEMENTED / Round 2 必做"；`DECISIONS.md:3190` 的 D-078 表仍以 `881dd0e` 为事实。而 `c335508` 上两者都已有交付。
- 机制/根因：round 2 只更新了 CONTRACTS/DECISIONS(D-080)，没有回写 PROJECT/TASKS/D-078 的状态词；A0 是这些文件的 owner，A7 无权改。
- 影响：milestone CLOSED 会把"未实现"固化成历史事实，发布说明与交接会与仓库冲突（与 round-1 的 F1 同类，但这次方向相反：不是"没开工"，而是"已完成仍记未实现"）。
- 复现：`grep -n "NOT IMPLEMENTED" docs/DECISIONS.md docs/PROJECT.md`；`sed -n '770,786p' docs/TASKS.md`。
- 归属：**A0**。

### P3

**N4（P3，A6/A0，证据文档漂移）round-2 的 5 个 m3r 场景在三处文档里仍写成 4 个，且有一处旧结论已被修复推翻。**
- `tests/browser/suite/33-m3-remote.mjs:16`、`:28` 写 "four scenarios"（实际 5 个，`m3r/5` 是后加的）；
- `tests/browser/README.md:275-278` 的 m3r 表只有 4 行，而同文件 `:79` 写 `73 = 68 + 5`；
- `33-m3-remote.mjs:327-330` 仍写 "the local provider normalises the collapsed case, **the remote provider does not**"，`33-m3-remote.mjs:523-540` 的探针注释仍写"zero-length selection … the gap is reported to A0" —— 这两处都已被 `c335508` 的修复推翻（`m3r/5` 正是该修复的回归测试）。
- 影响：只影响证据的可读性/可引用性，不影响行为；但"注释说 X 未修、同一文件又在测 X 已修"会被下一个读者当成矛盾。
- 归属：**A6**（suite 注释/README 表格）/ **A0**（合入时的文档一致性）。

**N5（P3，A0，契约完整性）§11.2 没有版本影响说明，而本轮向 `packages/shared` 新增了四个导出 schema。**
- 事实：`aiOperationDraftSchema` / `aiSuggestionDraftSchema` / `aiSelectionSchema` / `aiSuggestHttpRequestSchema`（`ai-suggestion.ts:142-186`）都是新增导出；`SHARED_CONTRACT_VERSION` 仍 **8**（`index.ts:77`）。
- 判断：保持 8 很可能是**正确**的（纯新增、未删除/未收窄任何既有形状，R1 要求类型必须放 shared），但仓库的惯例是**把理由写出来**（§11.1 写了"7 → 8"及原因，§17.8 有整张版本表，`index.ts` 的 v1…v8 注释逐版说明）。§11.2 一行都没有。
- 影响：下一个改 shared AI 类型的人无法判断"加字段要不要 bump"，只能猜。
- 归属：**A0**（契约文字，可并入 N3 的同一次文档变更）。

**N6（P3，A4/A2，错误面）remote 模式下 `400 invalid_request` 被映射成通用 `provider` 错误，文案误导。**
- 事实：`instruction` 上限 2000、`content` 上限 200 000（`ai-suggestion.ts:116-123`）；超限时服务端按 §11.2 的 400 返回，客户端 `kindForStatus` 的 default 分支映射为 `provider`（`remoteProvider.ts:244-248`），UI 显示 "The AI provider failed to generate a suggestion."（`aiProposalCopy.ts` 的 remote titles）。
- 影响：用户在"指令写得过长/文档超过 200k"时看到的是"provider 失败"，会误判为服务端/模型故障；不是安全问题。
- 归属：**A4**（映射/预检）/ **A2**（文案）。建议 M4 处理：要么客户端在发送前给出明确长度错误，要么新增一个 client-side 失败 kind（不动 shared 的 `ValidationFailureReason`）。

**N7（P3，A0/A3，契约边界）§11.2 未规定"上游 429"如何映射；适配器把它并进 `provider` → 502。**
- 事实：`openai.ts:225-232` 对所有非 2xx（含 429）抛 `provider`；§11.2 的 `429 rate_limited` 行写的是**本端点**的限流（M4 D6 预留），不是上游。
- 影响：fail closed 正确，但当 OpenAI 侧限流时用户看到的是"provider failed"，运维也无法从响应区分"上游限流"与"上游 5xx"（日志里有 status，响应里没有——这是有意的防泄露，但契约应写明）。
- 归属：**A0**（补一行契约）/ **A3**（若要区分，加一个 provider message/日志字段，不改响应体）。

**N8（P3，A0 + 项目负责人，治理）`AI_PROVIDER=openai` 的生产启用前置没有被记录成一道门。**
- 现状：分散提及是有的——`CONTRACTS.md:684`（M4 D3 必须拒绝 stub）、`:674`（429 预留 M4 D6）、`DECISIONS.md:3302/3306`（fail-fast 归 M4 D3）、`DECISIONS.md:3317`（真实认证 M4 D1、成本/配额 UI M4 D6）、A5 报告 §11 决策 2（建议 D1/D3/D6 之前不得对外）。**但**：
  1. `TASKS.md:812-815` 的 M4 sketch 仍只写 "Markdown preview performance, virtualized lists, chaos/regression suite"，**没有** AI 生产启用的位置；
  2. `CONTRACTS.md:1061`（§17.7）明确说 §17 **不授权** rate limiting —— 所以"加限流"不是"实现一个 M4 TODO"，而是要有一节新的契约；
  3. `PROJECT.md:58` 的 Non-goals 明确列了 "Billing, plans, quota metering"，而 D-080 §5 把"成本记账与配额 UI（M4 D6）"记成 M4 工作 —— **binding non-goal 与被接受的决策方向冲突**（MVP 阶段 vs M4 可解释，但至少需要一句 owner 级裁定）。
- 影响：如果 CLOSED 后有人看到 "openai adapter 已实现" 就把 `AI_PROVIDER=openai` 接到公网，当前只有一条启动 WARNING 挡着（且 `demo bootstrap` 无凭据、端点无限流、正文可任填）。
- 归属：**A0**（记录）+ **项目负责人**（quota 与 non-goal 的取舍）。**建议记在哪**：新增一条 `D-081`（"AI production enablement gate"），并列进 `docs/TASKS.md` 的 M4 段；限流/配额的实现另开 `CONTRACTS` 一节；`PROJECT.md` 的非目标需要 owner 明确"运营性花钱闸/速率限制不算 billing/quota metering"或改写该行。

### 观察（不计入 P1/P2/P3）

- `aiAcceptRequiredRole` 仍无运行时消费者（D-077 §3.2 已裁定保留）。
- `m3r/1` 的"折叠光标探针"在修复后仍会生成一个**非空**提案再 Reject；它不再测量它注释里描述的 gap（已并入 N4），但作为"面板在折叠光标下不会崩"的路径仍有效。
- `round 2` 的 `route.ts` 每请求新建一个 `express.json` 解析器（微小开销，非缺陷）。
- `stub` 的 `model: "stub"` 会在 200 响应里暴露 provider 类型；这是有意的可观测性（A5 O-2 附近），不是凭据。

## 11. M4 硬前置（回答任务第 5 项）

**问题：** `AI_PROVIDER=openai` 的生产启用前置（真实认证、config fail-fast 且拒绝 stub、限流/成本）是否已被记录？

**答案：部分记录，但没有记录成"门"，且存在两处需要 owner 裁定的冲突。** 具体见 N8：

| 前置 | 当前记录位置 | 是否足够 |
| --- | --- | --- |
| config fail-fast（缺 key 时启动失败） | D-080 §3 写"归 M4 D3"；`index.ts` 现在**不** fail-fast（只 503 + 日志） | 记录在案，但**没有** M4 任务条目 |
| 生产拒绝 `AI_PROVIDER=stub` | `CONTRACTS.md:684`、D-080 §3、`index.ts:105-109` 的 WARNING | 记录在案；**当前只有警告**，M4 D3 才强制 |
| 真实认证（D1） | D-080 §5（"不做本轮：真实认证（M4 D1）"）+ A5 §11 决策 2 | 只在"本轮不做"里出现；不是启用前置条目 |
| 限流 / 配额 / 429（D6） | `CONTRACTS.md:674`（预留）、D-080 §5；`CONTRACTS.md:1061` 明确 §17 不授权 rate limiting | **不足**：无 M4 任务条目、无契约章节、且与 `PROJECT.md:58` 的 non-goal 冲突 |
| "D1/D3/D6 完成前不得对外" | 只在 A5 报告的 **决策建议**（`A5-m3-r2-permission-review.md:333-335`） | **不足**：review 报告不是决策记录 |

**结论：必须在 CLOSED 前由 A0 落一条决策记录（建议 D-081）**，内容至少包含：三个前置（D1/D3/D6）、"未完成前 `AI_PROVIDER=openai` 不得作为对外能力"、限流需要的契约入口、以及 `PROJECT.md` non-goal 与"成本/配额"口径的裁定。**项目负责人**需要对 quota 是否属于 non-goal 表态。

## 12. 关闭时必须在 docs 里保留的 residual / limitation（16 条）

以下每一条都必须进发布说明（或 release notes 的"已知限制"），不得因为 CLOSED 而删除或包装成"已完成"：

1. **真实 OpenAI 从未联网调用**：只有 fake-fetch 单测、失败矩阵与 stub 的真实 HTTP 链路；模型质量、真实 4xx/429/超时行为、prompt 的鲁棒性都未验证。发布说明不得写"已接入并验证真实模型"。
2. **`AI_PROVIDER=stub` 仅 development/evidence**：零网络、确定性 uppercase，不是模型、忽略 instruction；生产配置校验（M4 D3）必须拒绝它，当前只有启动 WARNING与 `model:"stub"` 可观测。
3. **无真实认证、无限流/配额/成本闸**：`POST /api/session/bootstrap` 无凭据即可换 session（§17.0），AI 端点无速率限制；`AI_PROVIDER=openai` 在 M4 D1/D3/D6 完成前**不得对公网启用**。
4. **`commenter` 没有独立的 AI 浏览器场景**：与 `viewer` 共用 `canEdit=false` 路径（代码级 + `p2` 服务端证据）。
5. **`anchor-unresolved` 只有 Node 证据**：浏览器覆盖 `revision` 与 `text-mismatch`；通过 shipped UI 也很难触发（session 重挂载会重建面板）。
6. **离线未知角色的 Accept 会产生本地分叉**：不出站、不被 `FORBIDDEN`、不自愈；reload 后仍在（IndexedDB），被提升为 `editor` 并重新 join 后才补交。
7. **`Y.UndoManager.captureTimeout = 500 ms` 的合并**：编辑后 500 ms 内立刻接受 AI 建议，一次 Undo 会把两者一起撤回（Yjs 既定语义，未改）。
8. **`revision` 是客户端本地量**：只计 `local`/`ai`；提案的 `baseRevision` 不可跨客户端共享，跨客户端共享提案需要新的 revision 定义与契约变更。
9. **主 bundle 未拆分**：`965.13 kB`（gzip 316.16），>500 kB 警告仍在（R7 继续）。
10. **服务端无法验证 `content` 属于 `documentId`**：正文权威在客户端；`canRead` 只约束文档 id，不是数据出境/配额控制。跨文档应用已被 `applySuggestion` 的 `documentId` 守卫在写路径拒绝（本轮新增），但服务端仍无法识别来源。
11. **directory 切换会关闭面板**（与 D-078 的"保持打开"不一致，待 N2 勘误）；目录每次打开面板都会 `GET /api/documents`，**local provider 模式也一样**（这是新增的网络调用，已由面板文案如实说明）。
12. **`aiAcceptRequiredRole` 仍无运行时消费者**（共享 RBAC 词表的一部分，D-077 §3.2 保留）。
13. **2 MB body 在授权之前解析**（A5 P3-4）：认证但零可读文档的调用方也可让服务器解析一次 2 MB JSON 再 404；M4 边缘限流可覆盖。
14. **只验证了 Chromium 155**（`Chrome/155.0.8059.85`）；Firefox/Safari 与跨平台未验证。
15. **remote 模式的 400（instruction > 2000 / content > 200k）显示为通用 provider 错误**（N6）；上限来自 shared schema，不是新增缺陷。
16. **`m3r/*` 证据默认不跑**：只有 `INSIGHTHUB_E2E_AI_MODE=remote` 才注册（默认套件仍是 68，不含 remote 链路）；任何引用"remote 已验证"的文档必须同时写明这个开关。

（另外沿用 M3 round 1 的既有 residual：R1 吊销不追溯已建 socket、R2 session 进程内、R3 角色变更不推送、R4 诊断字符串 mojibake、R5 commenter/被拒 join 覆盖、R6 `openApp` 隐式 arrangeAccess、R8 heartbeat stale reap timer、R9 bundle；本轮未重新度量 R4 的 6 处计数，也不声称它们已清零。）

## 13. 放行判定

### 13.1 结论

**GO WITH CONDITIONS —— 用于把 M3 标为 `CLOSED`。**

- 这不是 NO-GO：**P1 = 0**，A–H 全 PASS，四门禁与 68/68、73/73 都是我在 `c335508` 上自跑的真实输出；round 2 的两个修复都有回归测试与我的独立探针。
- 也不是无条件 GO：三条 P2 都是"文档/决策记录与实现不一致"，其中 N1 会让后人写出与验收 D 相反的实现，N2 是 owner-level 处置与实现相反且代码引用了错误的依据，N3 会让 CLOSED 带着"required 能力未实现"的历史记载。这些必须在关闭前清掉，否则 CLOSED 把文档债务变成历史事实（与 D-077 的处理一致）。

### 13.2 关闭前必须完成的条件

| # | 条件 | Owner | 阻塞 CLOSED？ |
| --- | --- | --- | --- |
| C1 | 删改 `ARCHITECTURE.md:150-152` 的 "locally or remotely" 句，并让 D-077 §1 的 F2 记录与实际一致（或补一条勘误） | **A0**（冻结面） | **是** |
| C2 | 对 N2 二选一并落纸：D-078 勘误（面板随 workspace 关闭，R15 决定不可保持打开）／改实现为切换后重开；同时修掉 `AiDirectory.tsx` 里错误的 D-078 引用 | **A0 + A2** | **是** |
| C3 | 更新 `PROJECT.md:40`、`TASKS.md:770-786`、D-078 的状态口径为：directory = DONE（附 N2 偏差）、真实 provider = IMPLEMENTED / NOT LIVE-VERIFIED | **A0** | **是** |
| C4 | 落一条决策记录（建议 D-081）记录 `AI_PROVIDER=openai` 的生产启用前置（D1/D3/D6），并在 TASKS M4 段落有对应条目；`PROJECT.md` 的 quota non-goal 由负责人裁定措辞 | **A0 + 项目负责人** | **是** |
| C5 | 修 N4/N5 的文档漂移（33-m3-remote 的 4→5、旧结论注释、README m3r 表；§11.2 补版本影响一行） | **A6/A0** | 建议与 C1–C4 同一次文档变更 |
| C6 | 把 §12 的 16 条 residual/limitation 写进发布说明/`docs/TASKS.md` 的 M3 记录 | **A0** | **是** |
| C7 | 项目负责人对 `m3-closed`（annotated tag 与 CLOSED 状态）作出**明确授权** | **项目负责人** | **是**（A0/A7 均无权自行决定） |
| C8 | 文档改动后，至少在最终 HEAD 重跑 `pnpm typecheck` + `pnpm test`；若动 UI/CSS 再跑浏览器套件，并把真实输出写进关闭记录 | **A0** | **是** |

### 13.3 若关闭，哪些东西**不能**被说成已完成

- 不能说"真实模型已验证"（只是适配器实现 + 确定性证据）。
- 不能说"AI 端点已有成本/滥用防护"（无认证、无限流、无配额）。
- 不能说"commenter 的 AI 路径已在浏览器验证"。
- 不能说"离线写入一定收敛"（未知角色的本地分叉不自愈）。
- 不能说"1:1 视觉/浏览器全覆盖"（只有 Chromium）。
- 不能把 `stub` 说成模型。

## 14. 诚实覆盖声明

**读了（原文，不是摘要）：**
`AGENTS.md`（会话内已加载）；`docs/CONTRACTS.md` §11 / §11.1 / §11.2 / §12 / §17.7 / §17.8；`docs/DECISIONS.md` D-075 / D-076 / D-077 / D-078 / D-079 / D-080 全文；`docs/agent-governance/A5-m3-r2-permission-review.md` 全文；`docs/agent-governance/A7-m3-final-review.md` 全文（两段）；`apps/server/src/ai/{route,provider,openai,stub,test-support,route.invariants.test}.ts`；`apps/web/src/features/ai/{provider,apply,remoteProvider,aiProvider,testSupport}.ts` 与 `apply.test.ts` 的跨文档用例、`remoteProvider.test.ts` 的请求形态/折叠光标/no-op 段；`apps/web/src/features/editor/{AiSuggestPanel.tsx,AiDirectory.tsx,aiDirectoryCopy.ts}`、`DocumentWorkspace.tsx`/`aiProposalCopy.ts`/`vite.config.ts` 的 diff；`tests/browser/suite/33-m3-remote.mjs` **全文**；`tests/browser/README.md` 与 `run.mjs` 的 diff；`tests/browser/lib/stack.mjs` 的 env 注入段；`docs/PROJECT.md` / `docs/TASKS.md` 的 M3/M4 段；`docs/ARCHITECTURE.md` §3。

**跑了（我自己执行）：**
全新 `pnpm install --frozen-lockfile`；`pnpm typecheck`；`pnpm test`；`pnpm build`；`node tests/browser/run.mjs`（默认 68/68）；`INSIGHTHUB_E2E_AI_MODE=remote`（73/73）；web 探针 7 例；server 探针 3 例；生产 bundle 凭据检索；消费者/import 静态检索。共 **6 个命令（install + 三件套 + 两套浏览器）+ 2 个探针文件 + 若干静态检索**。

**没读 / 没跑（不得当成已验证）：**
- **没有调用真实 OpenAI**（无 key；D-080 §4 禁止 Gate 联网）；没有 live smoke。
- 没有做 mutation 实验（round 2 的两个修复由永久测试 + 我的探针覆盖；round 1 的 mutation 结论未被本轮改动）。
- 没有逐行读 `tests/browser/suite/32-design-fidelity.mjs`（只确认 `ui/1…ui/8` 的 id 与其在本跑中 PASS）、`31-m3-ai.mjs`（round 1 已读，本跑执行）、`30-m3-ui-evidence.mjs` 与其余 suite。
- 没有读 `apps/server/src/authz/**`、`rooms/registry.ts`、`persistence/**` 的完整实现（只按需交叉引用）。
- 没有读 `openai.test.ts` / `route.test.ts` / `stub.test.ts` / `aiDirectory.test.ts` / `aiPanelRemote.test.ts` / `aiProvider.test.ts` 的全文（只读了关键断言段；它们在门禁中执行并通过）。
- 没有在浏览器里触发 `anchor-unresolved`，没有 commenter 的 AI 浏览器场景，没有跨浏览器验证。
- 没有做负载/DoS 实测（"无限流/2 MB 在 authz 前解析"是代码事实，不是压测结论）。
- 没有重新计数 R4 的 6 处 mojibake；没有重测 R8 heartbeat timer；没有做 R7 的 bundle 归因。
- 没有验证"两个客户端同时接受同一提案"（提案仍单客户端，D-076 §2 不支持共享）。

## 15. Files Changed / Git 状态

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `docs/agent-governance/A7-m3-r2-review.md` | **新增（未提交）** | 本报告；本轮唯一交付物 |
| `apps/web/src/features/ai/a7r2Probe.test.ts` | 新增后**已删除** | 7 个一次性探针 |
| `apps/server/src/ai/a7r2Probe.test.ts` | 新增后**已删除** | 3 个一次性探针 |
| `.a7-*.log`（5 个） | 运行日志，**已删除** | 门禁/套件输出留档 |

生产代码、测试、契约、`package.json`、`tests/browser/suite/**`：**零改动**；`git status --short` 最终只有本报告。

## 16. Next Handoff

```text
Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
main @ c335508      (agent/a7-m3-r2-final HEAD == c335508；本报告未提交)

Why:
M3 round 2 的代码与行为通过独立终审（P1=0，A–H + R2-1/R2-2 PASS，四门禁与 68/68、73/73 在
c335508 上由 A7 自跑）。CLOSED 之前必须先处置 3 条 P2：ARCHITECTURE §3 的 "locally or remotely"
原句仍在（round-1 F2 未真正关闭）、D-078 "面板保持打开" 与实现相反且代码引用了错误依据、
PROJECT/TASKS/D-078 的 round-2 状态未回写；并落一条 M4 生产启用前置的决策记录、把 16 条
residual 写进发布说明。milestone CLOSED 与 m3-closed tag 需要项目负责人明确授权。

Dependencies satisfied:
- 本报告 §5 是我在 c335508 上自跑的四门禁 + 两套浏览器套件的真实输出（exit 0）
- §6 的 10 个一次性探针（web 7 + server 3）与静态检索，探针文件已删除
- round 1 的 A–H 与 7 个 AI 场景在本 HEAD 零回归（68/68）
- remote 链路在真实浏览器上经真实 HTTP/stub 闭合（73/73），不是 Node 模拟
- 未修改任何生产代码/测试/契约/依赖；工作树只新增本报告

Copy-paste Prompt:
你是 A0（Supervisor）。A7 已完成 M3 round 2 独立终审，报告在
docs/agent-governance/A7-m3-r2-review.md（base main @ c335508，分支
agent/a7-m3-r2-final，未提交）。结论：GO WITH CONDITIONS（可用于 CLOSED，
但有 3 条 P2 + 1 条 M4 决策记录 + 发布说明前置）。请：
1) 修 N1：docs/ARCHITECTURE.md:150-152 仍写 "moved on (locally or remotely) … stale"，
   与 CONTRACTS §11.1 / 验收 D 冲突；round-1 F2 只追加了后文，没有删改原句。
2) 处置 N2：D-078 §4 R2-1 写"面板保持打开"，实现与 m3r/3 是"面板关闭"，
   且 AiDirectory.tsx:29-35 把 D-078 引用成支持关闭。二选一并落纸（勘误或改实现）。
3) 处置 N3：按本报告 §8 更新 PROJECT.md:40 / TASKS.md:770-786 / D-078 的状态：
   directory = DONE（附 N2 偏差）、真实 provider = IMPLEMENTED / NOT LIVE-VERIFIED。
4) 落一条决策记录（建议 D-081）：AI_PROVIDER=openai 的生产启用前置
   （M4 D1 真实认证、D3 拒绝 stub + fail-fast、D6 限流/成本/429），并在 TASKS M4 段落
   有条目；PROJECT.md:58 的 quota non-goal 措辞需要负责人裁定。
5) 把本报告 §12 的 16 条 residual/limitation 写进发布说明或 TASKS 的 M3 记录，
   不得写成"已完成"。
6) 文档改动后在最终 HEAD 重跑 pnpm typecheck + pnpm test（若动 UI 再跑浏览器套件），
   然后把 CLOSED 与 m3-closed tag 的授权请求交给项目负责人——这不是 A0/A7 可自行决定的。
不要改 shared 契约版本、wire 或 captureTimeout；不要顺手"修" D-076 §4(a) 的 undo 合并行为。
```
