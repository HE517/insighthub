# A5 · M3 Round 2 权限复核：新增 AI 端点与 remote provider 是否构成新的读/写旁路

**范围：** review + 定向测试（不改版、不改生产代码）。
**Base：** `main @ 860e6cd`（含 A3 端点/stub、A2 directory、A4 RemoteProvider）→ 本 worktree 分支 `agent/a5-r2-review @ 860e6cd`
**Worktree：** `D:\前端\react\项目\面试项目\Insighthub-wt-a5-r2-review`
**日期：** 2026-10-22
**结论先说：** **没有发现真实的读旁路或写旁路（P1 = 0，P2 = 0）。** `POST /api/ai/suggest` 只使用调用方提交的 `content`，不读文档存储；授权仍走 `authz.authorizeDocument(..., 'canRead')`，404 的 body 与 `GET /api/documents/:id` **逐字节一致**、应用层 headers 相同（本轮新增测试证明，`date`/TCP 连接头除外）；端点只返回 draft，**没有任何写路径**；`AI_PROVIDER=stub` 仍要求 session + `canRead`。发现 **1 条 P3 一致性隐患**（`documentId` 与 `content` 没有服务端绑定；在"insert 落在文档末尾/空文档"这种窄情形下，锚点不能独立阻止跨文档应用）和 **3 条 M4 滥用/成本输入**（无速率限制/配额、demo bootstrap 无凭据、正文出境不受 `canRead` 约束）。这些都不是权限绕过，但必须在 M4 D1/D3/D6 里处理。

---

## 0. 任务六问：逐条结论 + 证据

### 0.1 读旁路：`POST /api/ai/suggest` 是否可能让调用方读到自己没有读权限的文档内容？

**结论：不会。**

| 子问题 | 结论 | 证据 |
| --- | --- | --- |
| 服务端是否**只**使用请求体 `content`，而不是从 store 读文档？ | **是，只用请求体** | `toProviderInput` 只复制 `instruction` / `content` / `selection`，`documentId` 与 `baseRevision` 不进入 provider（`apps/server/src/ai/route.ts:197-204`）。AI 模块的 import 集合只有 `express`、`@insighthub/shared`、`../authz/public.js` 与本地 provider——**没有** `persistence/**`、`rooms/**`、`ws.ts`、`yjs`（本轮新增的静态测试 `route.invariants.test.ts` 钉住；`route.ts:41-60` 可人工复核）。测试 harness 本身**没有接 `DocumentStore`**，端点仍能返回 200（见 §7 探针）。 |
| 未知文档与无读权限的 404 是否一致？ | **一致（状态码/响应体/headers）** | 两者都经过 `authz.authorizeDocument(..., 'canRead')`（`route.ts:139-143`）→ `authz.ts:220-242` 的**同一个** `not_found` 分支。既有测试 `route.test.ts:223-269` 比较了 AI 端点的两态；本轮新增测试进一步把 AI 404 与 `GET /api/documents/:id` 404 逐项比较：status `404`、body `{"error":"not_found"}`、`content-type` / `content-length` / `etag` / `vary` / CORS 头全部相同（只排除 `date` 与 TCP 的 `connection`/`keep-alive`）。 |
| 是否有错误消息/响应字段泄露存在性或内容？ | **没有** | 所有失败体都是 `AI_RESPONSE_BODIES` 的固定对象（`route.ts:67-76`），provider 的 `message` 被忽略、只读 `kind`（`route.ts:213-238`）。200 只返回 `aiSuggestionDraftSchema` 校验后的 `{summary, operations, model?}`（`ai-suggestion.ts:160-166`），**不含** `documentId`/`baseRevision`/anchor，也**不含** `DocumentMeta`——路由拿到 `granted` 决策后直接 `break`，从不序列化其中的 `document`（`route.ts:159-161`）。 |

**诚实边界（必须一起读）：**

- "有 membership 但**没有** `canRead`"这一态在冻结角色阶梯下**不可构造**：`documentCapabilities.canRead = hasAtLeastRole(role,'viewer')`（`packages/shared/src/permission.ts:37-42`），`viewer/commenter/editor/owner` 四种角色全部为真。因此 HTTP 只能观测"未知文档"与"无 membership"两态；`authz.ts:232` 的 `!canRead` 是防御性分支。两态已证明跨端点一致，第三态只能由代码结构保证。
- **`content` 与 `documentId` 没有服务端绑定。** 服务端不持有正文（正文权威是客户端 `Y.Doc`，R11），所以"你能读某个文档"只约束 `documentId`，不约束你提交的字节。这**不是读旁路**（字节是调用方自己提供的，服务端没有替它读取任何东西），但它意味着该端点是一条**正文出境**通道（发给 OpenAI），且 `canRead` 不是配额/出境控制（见 P3-2、§11）。
- **未验证：** 真实 OpenAI 网络路径下的 4xx/5xx 行为只由适配器单测覆盖（含伪造上游 body 的 401/403/429/5xx），没有调用真实模型（D-080 §4 要求仓库 Gate 永不调用真实模型）。

### 0.2 写旁路：该端点是否可能写文档？

**结论：不可能。**

- 路由只返回 draft，不接触 `DocumentStore`、`DocumentRoom`、`Y.Doc`、WebSocket（同上静态 import 测试）。HTTP 侧没有任何文档写端点：`app.ts` 的文档路由只有 `GET /api/documents` 与 `GET /api/documents/:id`（`app.ts:226-242`）。
- 服务器唯一的文档写入路径仍是 WS BINARY `SYNC` 的 `#submitMutation`：`apply → persist → broadcast`（`registry.ts:814-860`），前置 gate 是 `#authorizeFrame` 的 `canEdit`（`registry.ts:716-760`）。`documentId` 在 AI 路由里只用于授权，不参与任何写。
- 客户端接受路径未变：`applySuggestion` → `session.transact(fn, TRANSACTION_ORIGINS.ai)`（`apps/web/src/features/ai/apply.ts:114-123`），最终仍是一个普通 `SyncUpdate`，服务端对 origin 不可区分，因此不存在"AI 专用写通道"。

### 0.3 stub 的滥用面：`AI_PROVIDER=stub` 是否可被外部用户无成本/无限调用或探测？

| 子问题 | 结论 | 证据 |
| --- | --- | --- |
| stub 是否仍要求 session + `canRead`？ | **是** | 路由的 guard 顺序在 provider 选择之前：session（401）→ body（400）→ `authorizeDocument(...,'canRead')`（404）→ provider（503/504/502/200）（`route.ts:87-167`）。本轮新增测试用**真实的 `AI_PROVIDER=stub` factory** 证明：无 cookie → `401 {"error":"session_required"}`；`demo-grace` 对 `demo-private-notes` → `404 {"error":"not_found"}`；`demo-linus`（viewer）→ 200、`model:"stub"`（生成只需 `canRead`）。 |
| 是否无成本/无限？ | **无外部成本，但无限（无速率限制/配额）** | stub 无网络、无 key、纯 uppercase（`stub.ts:67-116`）；仓库**没有** rate-limit 中间件（全仓检索只有注释与 §11.2 预留的 `429 rate_limited`）。`POST /api/session/bootstrap` 无凭据即可换取 session（§17.0），因此任何能访问服务器的人都能无限调用 stub。 |
| 是否有必须**现在**处理的滥用风险？ | **没有（生产拒绝 stub 之外的）** | stub 模式下滥用上限是 CPU：`content` ≤ 200 000 UTF-16 code units、body ≤ 2 MB（`route.ts:114-122`），无外部费用、无数据泄露。真正的成本风险在 `openai` 模式（P3-2/P3-3，M4 D6）。 |

补充细节：

- **2 MB body 在授权之前解析**：顺序是 session → body → `authorizeDocument`。一个已认证但**零可读文档**的调用方也能强制服务器解析一次 2 MB JSON（然后 404）。这是一个小放大，M4 的边缘限流可以覆盖；不建议为此调整 §11.2 的 guard 顺序。
- **stub 可被用来探测 provider 类型**：200 的 `model:"stub"` 暴露当前 provider 类。这不是文档泄露，反而有助于发现"生产误配 stub"。
- 生产配置必须拒绝 stub 仍由 **M4 D3** 负责；当前只有 `index.ts:105-109` 的启动警告（`ai ready stub` + 明确的 development/evidence-only 警告）。本轮复核确认：没有隐式默认、没有 OpenAI 配置失败时回退到 stub（`openai.ts:145-169` 的优先级是 total 的：stub 显式优先，否则 openai 需要 key，否则 `null`）。

### 0.4 客户端路径：`RemoteProvider` 是否可能绕过既有授权？

**结论：不会。**

- 请求形态：默认 `apiUrl('/api/ai/suggest')`、`method: POST`、`credentials: 'include'`、`content-type: application/json`、原样转发调用方 `AbortSignal`（`remoteProvider.ts:158-164`）。非 2xx 直接按状态映射为 typed error，**不读响应体**（`remoteProvider.ts:169-170`）；200 必须过 `aiSuggestionDraftSchema`（`:188-189`）且能 `buildSuggestion`（`:195-205`），否则 `invalid-output`。
- **不带 cookie** → 服务端 401 → `unauthorized`；**带错 documentId** → 服务端按该 id 授权，不可读即 404；**无读权限仍拿 200** 的前提是该 id 可读（那就是有权限）。客户端没有能让服务端"跳过授权"的参数。
- **浏览器从不接触 key**：`apps/web` 全量 grep 没有 `OPENAI_API_KEY` / `VITE_OPENAI` / `api.openai.com` / `Authorization` / `Bearer`；`aiProvider.test.ts:121-152` 对 4 个 AI 模块做同样的静态断言；生产 bundle 的 grep 也无这些（§7）。浏览器侧唯一与 AI 相关的环境变量是 `VITE_AI_PROVIDER`（只比较字面量 `"remote"`，`aiProvider.ts:61-63`），它是构建期开关，不是凭据。
- **生产 bundle 实测**：未设置 `VITE_AI_PROVIDER` 时 Vite 内联为 `local`；用 `VITE_AI_PROVIDER=remote` 构建后 bundle 里出现 `{"VITE_AI_PROVIDER":"remote"}`，说明该开关在 production build 真实生效（不是只在 dev 生效）。
- **潜在 P3（非本轮引入）**：`createRemoteProvider({ endpoint, fetchImpl })` 是测试缝；如果未来把 `endpoint` 接到不可信的运行时配置，`credentials:'include'` 会把 session cookie 发到那个 origin。当前生产没有调用方传 `endpoint`（grep 只有测试），面板用默认 provider。建议 M4 保持 endpoint 只能来自构建期/同源配置。
- 另外：`VITE_API_BASE` 也是构建期配置；若误配为跨站 origin，`SameSite=Lax` 的 cookie 可能不被发送 → 401（fail closed），这是部署风险，不是代码绕过。

### 0.5 `documentId` 与 `content` 的一致性：会不会"对 A 文档的提案被应用到 B 文档"？

**结论：正常 UI 不会；但"锚点"本身不能独立充当文档身份绑定，存在一个窄的 P3 一致性隐患。**

| 环节 | 事实 | 证据 |
| --- | --- | --- |
| UI 取数 | `documentId`、`text`、`anchorText` 在**同一个同步块**里从同一个 `session` 取得 | `AiSuggestPanel.tsx:217-232`（`documentId: session.documentId`、`text`、`anchorText: session.text`） |
| 构建 suggestion | 重新校验 `text === anchorText.toString()`，不一致直接 `TypeError` | `provider.ts:195-201` |
| 校验 | 三段：`baseRevision` → anchor 解析 → `expectedText` 精确比较；**不检查 `suggestion.documentId`** | `ai-anchor.ts:231-259`、`:272-328`；`apply.ts:86-126` |
| 服务端 | 只把 `documentId` 用于授权；draft 的 offsets 只相对 `content` | `route.ts:139-143`、`:197-204` |

一次性探针（已删除，未提交）用真实 `Y.Doc` 实测了跨文档解析/应用：

```text
PROBE CROSS-DOC insert interior 3        {"ok":false,"reason":"anchor-unresolved"}
PROBE CROSS-DOC insert end 10            {"ok":true,"ranges":[{"index":20,"length":0}]}
PROBE CROSS-DOC insert 0 in empty        {"ok":true,"ranges":[{"index":20,"length":0}]}
PROBE CROSS-DOC replace 0..0 in empty    {"ok":false,"reason":"malformed"}
PROBE CROSS-DOC replace 0..5 interior    {"ok":false,"reason":"anchor-unresolved"}
PROBE APPLY CROSS-DOC  (A 的 insert 在 A 末尾)  {"ok":true,"applied":1}  B= "completely different [FROM-A]"
PROBE APPLY CROSS-DOC  (A 的内部 insert)        {"ok":false,"reason":"anchor-unresolved"}
```

机制：`Y.createRelativePositionFromTypeIndex` 在**文档末尾**或**空文档的 index 0** 返回 type-level 位置（`{"tname":"content","assoc":0}`，没有 `item`），它只引用根类型名 `content`，因此能在**任何**含同名 `Y.Text` 的 doc 上解析（Yjs 13.6.33 `RelativePosition.js:163-187`、`:289-341`）。而 insert 的 `expectedText` 恒为 `''`，第三段校验恒真；两个文档的本地 revision 又都从 0 起（`revision.ts` 只计 local/ai），于是第一段也过。最终 `applySuggestion` 会把 A 的提案写到 B 的末尾。

**影响定级：P3（一致性/正确性隐患，不是权限绕过）。**

- 写入仍走 **B 的** session 与服务器 `canEdit`；用户对 B 本来就有写权，A 的内容也是其可读内容，没有权限增益；viewer 即使本地调用 `applySuggestion`，服务器仍会 `FORBIDDEN`（与"离线 viewer 打字"同类的本地分叉，D-064 §2 #3）。
- 正常 UI **不可达**：面板绑定在一个 `session` 上，切换文档会 remount workspace 并关闭面板（D-078 §4 R2-1），提案不会跨 session 保留。隐患针对的是未来的第二个调用方/重构。
- 这不是 remote provider 引入的：round 1 的 local provider 同样如此；只是 round 2 的 `documentId` 来自请求体，更容易被误用。
- 建议（M4，非本轮）：`AiSuggestPanel.accept` 在调用 `applySuggestion` 前加一行 `proposal.documentId === session.documentId` 守卫（A2 文件）；或给 `AiApplyPort` 增加 `documentId` 并在 `applySuggestion` 里以既有 `malformed` 拒绝（A4 文件）。**不要**往 shared 的 `ValidationFailureReason` 里加新原因（那是 §11.1 的四原因表）。

### 0.6 错误面：401/404/503/504/502 的响应体是否都不含 operations/summary/key/prompt？

**结论：全部不含，且是固定 body。**

| 状态 | body | 说明 |
| --- | --- | --- |
| 401 | `{"error":"session_required"}` | §11.2 的词汇（与 §17.4 的 `unauthenticated` 不同是契约规定；两种 documentId 都 401，不泄露文档状态） |
| 400 | `{"error":"invalid_request"}` | 解析失败或 schema 失败；在授权之前，与文档无关 |
| 404 | `{"error":"not_found"}` | 非披露，见 §0.1 |
| 403 | `{"error":"forbidden"}` | **不可达**（`canRead` 已在 `not_found` 分支检查过）；保留为能力阶梯变化时的显式映射 |
| 503 | `{"error":"ai_provider_not_configured"}` | provider 为 null 或 provider 报 `not-configured` |
| 504 | `{"error":"provider_timeout"}` | 超时/取消 |
| 502 | `{"error":"provider_error"}` 或 `{"error":"invalid_provider_output"}` | 上游失败 / 输出不可用 |

证据：

- `route.test.ts:95-101` 的 `assertFailure` 对**每一个**失败行断言 `JSON.parse(text)` 深等于 `{error}`，并断言文本不含 `operations` / `summary`；所有失败用例都走它。
- `route.test.ts:376-397` 把假 key、instruction 放进 provider 的 message，响应逐字等于 `{"error":"provider_error"}`，且不含 secret / `Bearer` / `authorization` / instruction。
- OpenAI 适配器对上游 401/403/429/5xx **不读**响应体，只保留状态码；单测用含 key/content 的上游 body 证明不转发（`openai.ts:225-232`；`openai.test.ts:287-306` 以及 `describe('credential hygiene')`）。
- 200 也不含 key/prompt：draft schema 只有 `summary`/`operations`/`model`；`model` 是配置值（或 `stub`），不是模型输出（`openai.ts:252-255`）。
- 唯一非 §11.2 的响应是 `app.ts:161-171` 的 `500 {"error":"internal_error"}`（未知 throw），同样无细节，细节只进服务端日志。provider 的未知 throw 在路由内被映射为 502（`route.ts:237`），不会落到 500。

---

## 1. 任务状态（Status）

- `Status`: **done**
- `Branch`: `agent/a5-r2-review`
- `Worktree`: `D:\前端\react\项目\面试项目\Insighthub-wt-a5-r2-review`
- `Commit`: **未提交**（本轮新增本报告 + 一个定向测试文件；一次性探针已删除）
- `Base`: `860e6cd`（main）

## 2. 本轮目标

对 M3 Round 2 新增的 `POST /api/ai/suggest`、服务端 provider、stub 与客户端 `RemoteProvider` 做独立权限复核：确认新端点没有成为新的读旁路或写旁路；确认 404 非披露与 §17.4 一致；确认 stub 仍受 session + `canRead` 约束；确认浏览器不接触 key；沿 `buildSuggestion → validateSuggestionAgainstDocument → applySuggestion` 检查 `documentId` 与 `content` 的绑定；确认所有错误面不泄露 draft、key 或 prompt。本轮只 review、只加定向测试，不改生产代码。

## 3. 完成了什么

- **六问逐条给出结论 + 代码/测试证据**（§0），结论是 **P1 = 0、P2 = 0**，没有真实读/写旁路。
- **新增 4 个定向测试**（`apps/server/src/ai/route.invariants.test.ts`），把本轮复核依赖的三条性质变成可回归的断言：
  1. AI 端点的 404 与 `GET /api/documents/:id` 的 404 在状态、body、应用层 headers 上完全一致（跨端点，而不只是 AI 的两态互比）；
  2. AI 模块**不 import** 文档存储 / room registry / WS / Yjs（静态），provider 只收到请求体的 `content`（行为）；
  3. `AI_PROVIDER=stub` 不放大权限：401 / 404 仍成立，viewer 仍可生成（只需 `canRead`）。
- **确认 404 非披露是"借用同一个 decision"而不是第二套判断**：`authorizeDocument` + 固定的 `not_found` 对象。
- **确认写路径零变化**：HTTP 无写端点；AI 只产 draft；写入仍由客户端 `session.transact(ai)` 发起并经 WS `canEdit` gate。
- **确认浏览器 bundle 不含 key**：源码静态断言（既有）+ 生产 `dist` 的 grep（本轮）。
- **实测并定级一条 P3 一致性隐患**：`documentId` 不是校验的一部分；insert-at-end / empty-document 的 type-level 锚点可以跨文档解析并应用（一次性探针，已删除）。
- **整理 M4 输入**：真实认证、限流、成本/出境（§11），而不是把问题留给"以后再说"。

## 4. 技术实现（数据流、生命周期、设计选择与理由）

### 4.1 数据流（谁是权威）

```text
[browser]  session.text (Y.Text) ──► text snapshot ──┐
           session.documentId ───────────────────────┤
                                                     ▼
                              POST /api/ai/suggest {documentId, instruction, baseRevision, content, selection?}
                                                     │
[server]   session cookie ──► resolveSession ──► 401 session_required
           body ──► aiSuggestHttpRequestSchema ──► 400 invalid_request
           documentId ──► authorizeDocument(...,'canRead') ──► 404 not_found (非披露)
           provider.suggest({instruction, content, selection}, signal)
                 ├─ OpenAiProvider (server-only key; global fetch)
                 └─ StubProvider (no network, deterministic uppercase)
           draft ──► aiSuggestionDraftSchema ──► 200 {summary, operations, model?}
                                                     │
[browser]  buildSuggestion(live Y.Text) ──► anchors (RelativePosition) + local diff + baseRevision
           Diff Preview ──► Accept ──► validateSuggestionAgainstDocument
                                  ──► applySuggestion ──► session.transact(..., 'ai')
                                  ──► WS BINARY SyncUpdate ──► registry #authorizeFrame(canEdit)
                                  ──► apply → persist → broadcast
```

**正文权威始终是客户端 `Y.Text`**（R11）；服务端只拥有"文档元数据 + 房间里的 Y.Doc + 持久化日志"，AI 路由不碰房间与持久化。这既是读旁路不存在的结构性原因，也是为什么服务端无法校验 `content` 是否真属于 `documentId`。

### 4.2 生命周期

- **一次请求**：`requireSession` → 路由级 JSON parser（2 MB 传输上限）→ Zod → `authorizeDocument` → provider（自己的 `AbortController`，`res.once('close')` 时 abort）→ boundary 校验 → 200/错误体。`finally` 移除 close 监听。晚到的 provider 结果在 `controller.signal.aborted || res.writableEnded || socket.destroyed` 时丢弃，不写响应。
- **客户端**：每次 Generate 先 abort 上一次；关闭面板 abort；provider 在返回前检查 signal；面板在 `.then` 里再检查一次 `controller.signal.aborted`，因此已取消的请求不会复活提案。`RemoteProvider` 在 fetch 前、响应后、JSON 后各检查一次 abort。
- **服务端 provider**：OpenAI 适配器把调用方 signal 与内部 deadline 用 `AbortSignal.any` 合并，两者都映射为 `timeout`（§11.2 把 timeout/aborted 归为 504）；上游错误体从不读取。

### 4.3 设计选择与被否掉的替代方案

| 选择 | 被否掉的替代 | 理由 |
| --- | --- | --- |
| 服务端返回 **draft**（纯 offsets），客户端铸锚 | 服务端返回 `AiEditSuggestion`（含 anchors） | anchors 是 replica-specific；服务端铸的锚在客户端会解析错/解析不到（D-080 §1）。 |
| 授权调用**同一个** `authorizeDocument(...,'canRead')` | 在 AI 路由里自己判断"文档是否存在/是否可读" | 第二套判断就是第二个漂移点；共用 decision 让 404 的一致性成为结构性质（`route.ts:19-25`）。 |
| 失败体固定、provider message 只读 `kind` | 把 provider 的错误消息透传给客户端 | provider message 可能带请求材料（key/prompt/content）；固定体让"不泄露"成为类型/代码性质。 |
| stub 显式 `AI_PROVIDER=stub`，无隐式回退 | 缺 key 时回退到 stub / stub 作为默认 | 静默回退会让 Open 配置失败的生产服务器返回"伪造的成功编辑"（`stub.ts:23-31`）。 |
| 客户端提交快照，服务端不读正文 | 服务端从房间/存储读正文再调模型 | 正文权威在 Y.Doc；服务端读正文会新增读路径，并且需要处理"客户端正在编辑"的竞态。代价是 `content` 与 `documentId` 无法绑定（P3-1/P3-2）。 |

## 5. 发现并修复的问题

**本轮没有修改任何生产代码，也没有发现需要修复的 P1/P2 缺陷。** 以下是 1 条 P3 一致性隐患（P3-1）+ 3 条 M4 滥用/成本风险（P3-2/P3-3/P3-4）+ 1 条防御性 P3（P3-5）+ 3 条观察，均未在本轮修复（review 不改版），交 A0/M4 处理。

| # | Problem（可观测） | Root Cause（机制） | Impact | Fix（本轮未做） | Regression Test |
| --- | --- | --- | --- | --- | --- |
| **P3-1** | 用 A 文档铸的 **insert-at-end**（或空文档 insert）提案，在 `baseRevision` 相同的 B 文档上可以通过三段校验并被 `applySuggestion` 应用；实测 B 变成 `"completely different [FROM-A]"` | `Y.createRelativePositionFromTypeIndex` 在末尾/空文档返回 **type-level** 位置（`tname:"content"`，无 item），只引用根类型名；insert 的 `expectedText` 恒为 `''`，第三段校验恒真；`validateSuggestionAgainstDocument` / `applySuggestion` **都不比较 `suggestion.documentId`** | **不是权限绕过**：写仍走 B 的 session + 服务器 `canEdit`；用户对 B 本有写权，A 的内容也本可读；正常 UI 不可达（面板随 documentId 切换卸载）。但"锚点"不能独立充当文档身份绑定，未来第二个调用方/重构可能命中 | 建议（M4）：`AiSuggestPanel.accept` 加 `proposal.documentId === session.documentId` 守卫（A2），或给 `AiApplyPort` 加 `documentId` 并以 `malformed` 拒绝（A4）；不改 shared 的 `ValidationFailureReason` | 本轮为一次性探针（已删除），见 §0.5 输出；若要固化，应由 A4/A1 在 `apply.test.ts` / `ai-anchor.test.ts` 落"跨文档应拒绝"的用例 |
| **P3-2** | 任何有 session 的调用方可以为一个自己可读的 `documentId` 提交最多 200 000 字符的**任意** `content`，端点返回 200；`canRead` 只验证 `documentId` | 正文权威在客户端，服务端没有（也不应有）正文可比对；`content` 与 `documentId` 无绑定 | 不是读/写旁路；是**正文出境 + 成本**风险：`openai` 模式下任何 session 都能把任意文本发给运营方付费的模型。`canRead` 不是配额/出境控制 | 不改端点语义（契约如此）；M4 D6 用速率/字节/预算配额限制，M4 D1 用真实认证收紧调用者；文档出境策略（DLP）需 owner 决定 | 无需新测试；新测试 `route.invariants.test.ts` 已把"provider 只收到 body content"钉住（这是设计，不是缺陷） |
| **P3-3** | `AI_PROVIDER=stub` / `openai` 下端点**无速率限制、无配额**；`POST /api/session/bootstrap` 无凭据即可拿 session，因此任何能访问服务器的人都能无限调用 | 仓库没有 rate-limit 中间件（`429 rate_limited` 在 §11.2 预留，M4 D6 才实现）；demo bootstrap 是 §17.0 的既有模型 | stub 模式：CPU/DoS（≤2 MB body、≤200k 字符/请求）；`openai` 模式：运营方费用可被无限消耗。**不是权限旁路，是 M4 成本/DoS 前置** | 不在本轮修；M4 D3 拒绝 stub、D1 真实认证、D6 限流（每 session/user/document、请求速率、字节、预算、429） | 无（缺限流本身没有测试；M4 D6 落测试） |
| **P3-4** | 已认证但**零可读文档**的调用方仍可让服务器解析最多 2 MB 的 JSON（然后 404）；`express.json` 在 `authorizeDocument` 之前 | guard 顺序按 §11.2：session → body → 授权；body parser 是路由级 2 MB | 小的 CPU/内存放大，不涉及数据 | 不建议为此调整 guard 顺序；M4 边缘限流/较小 body 上限可覆盖 | 无 |
| **P3-5** | `createRemoteProvider({ endpoint })` 若未来接不可信运行时值，`credentials:'include'` 会把 session cookie 发到该 origin | 测试缝同时是生产可传参的 option；当前生产无调用方传 endpoint | 潜在 cookie 外泄（需 future 调用方 + 跨站/同站子域条件），当前不可达 | M4 保持 endpoint 只来自构建期/同源；或加 `endpoint === apiUrl(AI_SUGGEST_ENDPOINT)` 断言 | 无（当前无调用方） |
| **O-1** | `403 forbidden` 分支在 AI 路由中不可达；"membership 存在但无 `canRead`"在 HTTP 上不可构造 | 路由只要求 `canRead`；`canRead` 对四种角色恒真 | 不影响安全；是覆盖边界。测试只能比较两态（未知文档 / 无 membership） | 无需修；报告明确写出，避免后人把"三态都测过"说过头 | 新测试覆盖两态 + 跨端点 |
| **O-2** | 请求里的 `baseRevision` 被服务端 schema 接受但**完全不使用** | `baseRevision` 是客户端 staleness 输入；服务端不持有"当前 revision"（服务端 Y.Doc 的 revision 语义与客户端本地计数器不同） | 服务端不能拒绝过期请求；staleness 仍由客户端三段校验保证（D-075）。不是缺陷，但不要让读者以为服务端做了 staleness 校验 | 无需修；契约 §11.2 只把它列为请求字段 | 无 |
| **O-3** | A5 round 1 的 P3-c（`generate()` 程序化守卫只看 `tracker`，不查 `canRead`）在 remote 模式仍在 | 面板的 Generate 只 `disabled={!canRead || tracker===null}`；`generate()` 内没有 `if (!canRead) return` | remote 模式下即使程序化触发，服务端仍会 404（比 round 1 多一层兜底） | 无需本轮处理；若 A2 愿意，可加一行守卫 | 无 |

## 6. Files Changed

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `docs/agent-governance/A5-m3-r2-permission-review.md` | **新增（未提交）** | 本报告；review 的唯一报告交付物 |
| `apps/server/src/ai/route.invariants.test.ts` | **新增（未提交）** | 4 个定向回归测试：跨端点 404 一致、AI 模块无 store/room/ws/yjs 依赖、provider 只收到 body content、stub 仍受 session+canRead 约束。只读/仅测试，无生产代码依赖变化 |

**未改动：** `packages/shared/**`、`apps/server/src/{app,ws,index,authz/**,rooms/**,persistence/**}`、`apps/server/src/ai/{route,provider,openai,stub}.ts`、`apps/web/**`、`tests/browser/suite/**`、`package.json`、`pnpm-workspace.yaml`、`docs/CONTRACTS.md`、`docs/DECISIONS.md`、`docs/ARCHITECTURE.md`、`docs/TASKS.md`、`AGENTS.md`。一次性探针 `zz-review-probe.test.ts` / `zz-apply-probe.test.ts` 已删除。

## 7. Tests / Validation

### 7.1 项目门禁（最终工作树，真实输出摘录）

```text
$ pnpm install
Packages: +288
Done in 13.6s using pnpm v10.34.7

$ pnpm typecheck
packages/shared typecheck: Done
apps/server typecheck: Done
apps/web typecheck: Done
typecheck exit=0

$ pnpm test
 Test Files  45 passed (45)
      Tests  506 passed (506)          ← vitest（与基线一致）
# tests 229
# pass 229
# fail 0                              ← server（基线 225 + 本轮新增 4）
test exit=0

$ pnpm build
✓ 172 modules transformed.
✓ built in 4.60s
build exit=0
```

说明：`pnpm test` 同时跑 vitest 与 server（node:test）。新增的 4 个测试全部在 server 侧，所以 vitest 仍是 506，server 由 **225 → 229**。构建有既有的 chunk >500 kB 警告（`index-*.js` 约 965 kB），与改动无关，exit 0。

### 7.2 定向测试（新增，未提交）

```text
$ pnpm --filter @insighthub/server exec tsx --test src/ai/route.invariants.test.ts
# tests 4
# pass 4
# fail 0
```

四个测试分别证明：跨端点 404 的 status/body/headers 一致；provider 只收到 body `content`；AI 四个模块不 import store/rooms/ws/yjs/authz 内部；stub 下 401/404/200（viewer）仍成立。

### 7.3 一次性探针（已删除，未提交）

- **404 跨端点**：AI unknown / AI no-membership / GET unknown / GET no-membership 四份快照完全相同：`status 404`、`content-length 21`、`content-type application/json; charset=utf-8`、`etag W/"15-IapEsyUJs++crm3elUM5fZoGyC4"`、`vary Origin`、CORS 头相同、body `{"error":"not_found"}`。
- **provider 输入**：`200 [{"instruction":"Add a greeting at the very top.","content":"CLIENT-SUPPLIED-CONTENT, not the stored document"}]`——提交内容原样进入 provider，`documentId`/`baseRevision` 不在其中。
- **跨文档锚点/应用**：输出见 §0.5；关键三条：内部 insert → `anchor-unresolved`；A 末尾 insert → `{"ok":true,"applied":1}`，B = `"completely different [FROM-A]"`；空文档 insert 0 → 可解析到 B 末尾。
- 探针文件为 `apps/server/src/ai/zz-*-probe.test.ts`，运行后已删除；`git status` 只剩本报告与 `route.invariants.test.ts`。

### 7.4 浏览器侧凭据（代码 + 产物）

- **源码检索（grep tool，`apps/web/src`）**：`OPENAI_API_KEY` / `VITE_OPENAI` / `api.openai.com` / `Authorization` / `Bearer` → **无匹配**；`aiProvider.test.ts:121-152` 对 4 个 AI 模块做同样的静态断言。
- **生产 `dist` 检索**（PowerShell 对 `apps/web/dist/assets/*.js` 逐文件做 regex）：`api/ai/suggest` 与 `VITE_AI_PROVIDER` 出现在主 bundle（预期）；`OPENAI_API_KEY` / `VITE_OPENAI` / `api.openai.com` / `Authorization` / `Bearer` 全部 **无匹配**；`y-indexeddb-*.js` 无任何匹配。
- **构建期开关实测**：`VITE_AI_PROVIDER=remote` 重新构建 web 后，bundle 中出现 `SC={BASE_URL:"/",DEV:!1,MODE:"production",PROD:!0,SSR:!1,VITE_AI_PROVIDER:"remote"}`，说明该开关在 production build 真实生效。

### 7.5 未运行的验证（如实标注）

- **没有调用真实 OpenAI**（仓库 Gate 禁止；D-080 §4）。
- **没有跑浏览器套件**：本轮的权限判定点都在 Node/HTTP 层；remote 模式的 UI 错误文案/交互不在本轮范围。`tests/browser/suite/**` 未触碰（A6 并行）。
- **没有做负载/DoS 实测**：P3-3/P3-4 是代码事实（无 rate-limit、无配额、2 MB body 在 authz 前解析），不是压测结论。
- **没有实测"吊销/过期在请求飞行中"**：请求在授权检查时已获准，之后 session 被吊销仍会完成（§17.2 的 request-scoped 语义）；本轮未构造该竞态。

## 8. Acceptance Criteria

本轮没有新的 milestone 验收项；按六问 + §11.2 的表逐项判定：

| # | 判据 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | AI 端点不能读到文档存储中的内容 | **PASS** | 静态 import 测试 + provider 输入探针 + harness 无 `DocumentStore` 仍 200 |
| 2 | 未知文档 / 无读权限的 404 与 §17.4 一致 | **PASS（两态）** | 新测试跨端点比较 status/body/headers；第三态不可构造（O-1） |
| 3 | 端点不能写文档 | **PASS** | 静态 import 测试；`app.ts` 无写端点；唯一写入路径 registry `canEdit` gate |
| 4 | stub 仍需 session + `canRead` | **PASS** | 新测试用真实 stub factory：401 / 404 / 200(viewer) |
| 5 | 客户端不能绕过授权；浏览器不接触 key | **PASS** | `credentials:'include'` + 服务端 401/404；源码与 bundle grep |
| 6 | 错误面不含 operations/summary/key/prompt | **PASS** | `assertFailure` 覆盖全部失败行；credential hygiene 用例；OpenAI 适配器不读上游 body |
| 7 | `documentId` 与 `content` 的一致性 | **PASS（正常 UI）/ P3 隐患（跨文档锚点）** | 面板同一 session 取数 + `buildSuggestion` 再校验；探针证明 type-level 锚点的窄例外 |
| 8 | 无新增 P1/P2 权限绕过 | **PASS** | 本报告 §0；未改动生产代码 |
| 9 | 基线未被破坏 | **PASS** | typecheck 0 / vitest 506 / server 229（0 fail）/ build 0 |

## 9. 与其它 Agent 的集成关系

| 关系 | 说明 |
| --- | --- |
| 依赖 A3 | `POST /api/ai/suggest` 的挂载、session/`canRead` 顺序、固定错误体、provider 工厂；本轮只读复核 + 在 `apps/server/src/ai/` 加测试 |
| 依赖 A4 | `RemoteProvider` 的请求形态、`buildSuggestion` 的 `text === anchorText` 校验、`applySuggestion` 不收 `documentId`；本轮未改 `apps/web/**` |
| 依赖 A2 | `AiSuggestPanel` 的 Generate/Accept 门控、`documentId/text/anchorText` 同块取数、面板随文档切换卸载；本轮未改 |
| 依赖 A1 | `createOperationAnchor` / `validateSuggestionAgainstDocument` 的锚点语义；P3-1 的机制来自 `ai-anchor.ts` + Yjs 13.6.33 的 type-level 位置 |
| 依赖 A5 既有实现 | `authz.authorizeDocument` 的单一 `not_found` 分支；`documentCapabilities` 的单一规则表 |
| 下游 A6 | 若 A6 要加 remote 模式浏览器场景：401/404/503 的 UI 文案、Generate 在无 session 下的表现；本轮未触碰 `tests/browser/suite/**` |
| 下游 A7 | M3 Round 2 终审可直接引用本报告 §0/§7；需要重新判断的是 §11 的决定 |
| 下游 A0 | 本报告 + 新测试文件；需要 A0 决定是否保留测试、是否排期 P3-1 的加固、M4 前置 |
| 契约 | **未改动** `SHARED_CONTRACT_VERSION`、`PROTOCOL_VERSION`、任何 `packages/shared` 类型或冻结响应体 |

**测试计数变化（跨 agent 可见）：** server 测试 225 → 229（新增 4 个）。若 A0/A7 用"225"作为基线数字，请更新为 229；vitest 仍 506。

## 10. Known Risks / 未验证内容

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实 OpenAI 网络路径 | **未验证** | Gate 只用 fake provider；live smoke 需要 key，本轮未跑 |
| 第三态 404（membership 有但无 canRead） | **不可构造** | 冻结角色阶梯下所有角色 `canRead = true`；只能代码级保证（O-1） |
| 跨文档锚点（P3-1） | **Node 探针实测 1 次**，未固化为永久测试 | 仅在 `insert at end` / `empty insert` 的 type-level 锚点成立；内部 edit 安全 |
| 无速率限制 / 配额（P3-3） | **代码事实**，未压测 | stub 模式是 CPU；`openai` 模式是运营成本。M4 D6 |
| 2 MB body 在 authz 前解析（P3-4） | **代码事实**，未实测放大 | 建议 M4 边缘限流覆盖 |
| `content`/`documentId` 无绑定（P3-2） | **设计使然** | 正文权威在客户端；`canRead` 不是出境/配额控制 |
| 请求飞行中的 session 吊销 | **未实测** | §17.2 的 request-scoped 语义；M4 若要收紧需显式 abort |
| 浏览器 404/401 文案 | **未跑浏览器** | 属 A2/A6；本轮不声称 UI 行为 |
| 生产误配 stub | **未在部署层验证** | 只有启动警告；M4 D3 必须拒绝 |
| 跨 worktree 并行 | **未涉及** | 本轮只跑 Node/HTTP 测试，没有占用固定端口 |

**不作出的声明：** 本报告**不**声称"AI 端点对成本滥用是安全的"，也**不**声称"锚点能证明提案属于某个文档"。准确的表述是：**没有读写权限旁路；端点的授权边界是 `documentId` 的 `canRead`，不是提交内容的归属；跨文档应用只在窄的 type-level 锚点情形下可能出现，且不带来权限增益。**

## 11. Need Supervisor Decision

### 决策 1：是否现在安排 P3-1（`documentId` 一致性）的加固？

**A5 建议：不在本轮/不在 M3 关闭前做，列入 M4。** 理由：正常 UI 不可达（面板随文档切换卸载），且它不是权限绕过；现在改 `apply.ts`/`AiSuggestPanel.tsx` 会跨 A4/A2 ownership，并可能触碰 shared 的失败原因表。若 A0 要"纵深防御"，最小方案是 A2 在 `accept()` 里加一行 `proposal.documentId === session.documentId` 守卫（不动 shared、不动 `ApplyResult`），并明确它只是冗余护栏。

| 方案 | 内容 | 赞成 | 反对 |
| --- | --- | --- | --- |
| **A（推荐）** | M4 处理；本轮只记录 P3-1 + 探针证据 | 零风险；不改 ownership；正常 UI 不可达 | 未来第二个调用方不会自动获得护栏 |
| B | A2 面板加一行 documentId 守卫 | 最小、无 shared 改动、可立即防未来调用方 | 不改 `applySuggestion` 本身；仍依赖调用方在面板内 |
| C | A4 给 `AiApplyPort` 加 `documentId`，`applySuggestion` 以 `malformed` 拒绝 | 对所有调用方生效 | 改 A4 文件 + 测试；`malformed` 语义被复用（可接受，但不新增原因） |

### 决策 2：M4 的启用前置（真实认证 / 限流 / 成本）

**A5 建议：在 M4 D1（真实认证）、D3（生产配置拒绝 stub + openai 必需 key fail-fast）、D6（限流/配额/429）完成之前，不把 `AI_PROVIDER=openai` 当作可对外生产的能力。** 当前事实：demo bootstrap 无凭据（§17.0），端点无速率限制/配额；`canRead` 只证明"能读某个文档"，不限制提交内容。发布说明不得声称"AI 端点已具备成本/滥用防护"。

### 决策 3：是否保留本轮新增的测试文件？

**A5 建议：保留 `apps/server/src/ai/route.invariants.test.ts`（4 个测试，225 → 229）。** 它把"AI 404 = §17.4 404（跨端点）"、"AI 模块不碰 store/rooms/ws/yjs"、"provider 只收到 body content"、"stub 不放大权限"变成门禁；不包含任何 P3 隐患的 characterization（避免把隐患固化成"预期行为"）。若 A0 认为测试数量需要保持 225，可只保留第 1、2 条断言，但 A5 不建议删减。

### 决策 4（可选）：是否派 A6 加 remote 模式的浏览器场景？

建议**不需要**专门为权限加场景（权限判定点在 Node 已覆盖）；若 A6 要做 UI 证据，可加"remote 模式下 401/404 的文案与 Generate 失败不产生提案"，但这不是权限门禁的必需品。

## 12. 给项目负责人的总结

Round 2 之前，AI 只存在于浏览器里；Round 2 新增了一个真正会接触文档正文和外部模型的服务端端点，所以这一轮要回答的是"它有没有把原有的读/写边界打开一个口子"。复核结果是：没有。服务端只拿调用方自己提交的文本去生成 draft，从不读文档存储；授权仍然只经过 `authz.authorizeDocument(..., 'canRead')`，未知文档和"不是你的文档"返回完全相同的 404（本轮新增测试进一步证明它和 `GET /api/documents/:id` 的 404 连 headers 都一样）；端点本身没有写路径，接受 AI 修改仍然只能走客户端 Yjs 事务和 WebSocket 的 `canEdit` gate；浏览器侧没有 key，生产 bundle 里也没有。stub 也仍然要求登录和读权限，没有被外部用户当成免费后门。

需要如实写进风险清单的是两件事：第一，服务端无法验证"你提交的这段文本是不是你声称的那个文档的"，因为正文权威在客户端——这不是读旁路，但意味着 `canRead` 不是数据出境或成本控制；第二，锚点绑定有一个窄的例外：insert 落在文档末尾（或空文档）时，Yjs 生成的是只引用根类型名 `content` 的位置，两个文档的 revision 又都从 0 起，于是"A 的提案"在 Node 探针里被应用到了 B 的末尾。它对权限没有增益（B 本来就是你能写的），正常 UI 也到不了，但未来多一个跨文档调用方就会撞上，建议 M4 补一行 documentId 守卫。

因此本轮的建议是：接受"无 P1/P2 权限旁路"的结论；保留新增的 4 个回归测试；把 P3-1 和"无速率限制 + demo bootstrap 无凭据 + 正文出境"作为 M4 D1/D3/D6 的明确输入，而不是在 M3 关闭时用一句"权限已复核"带过。

## 13. Git 状态

```text
$ git status --short
?? apps/server/src/ai/route.invariants.test.ts
?? docs/agent-governance/A5-m3-r2-permission-review.md

$ git branch --show-current
agent/a5-r2-review

$ git log --oneline -1
860e6cd merge(integration): A4 remote AI provider - server draft to locally anchored suggestion, provider factory
```

工作树除本报告与新增测试外干净；**未 commit、未 merge、未 push、未打 tag**。一次性探针已删除。`tests/browser/suite/**`、`apps/web/**`、生产代码与 shared 契约均未改动。

## 14. Next Handoff

```text
Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
main @ 860e6cd   (agent/a5-r2-review HEAD == 860e6cd; 本 worktree 另有 2 个未提交文件)

Why:
M3 Round 2 的 AI 端点 / remote provider / stub 已独立复核：没有找到读或写的权限旁路
(P1=0, P2=0)。404 body 与 §17.4 逐字节一致、应用层 headers 相同（新增跨端点测试），
端点只使用请求体 content、无写路径，stub 仍需 session + canRead，浏览器 bundle 无 key。
需要 A0 决定：(1) 是否保留 apps/server/src/ai/route.invariants.test.ts（server 225→229）；
(2) P3-1 的 documentId 一致性加固由 A2 面板一行守卫、A4 apply 端口，还是留到 M4；
(3) M4 D1/D3/D6（真实认证 / 拒绝 stub / 限流与成本）是否作为 openai 模式对外的启用前置。

Dependencies satisfied:
- 基线 860e6cd 上四门禁全绿：typecheck 0 / vitest 506 / server 229(0 fail) / build 0
- 新增测试只依赖既有 test-support，未改生产代码、shared、web、tests/browser/suite
- 一次性探针已删除；本报告 §7 记录真实命令输出
- 未新增/修改任何 frozen contract 或 version

Copy-paste Prompt:
你是 A0（Supervisor）。A5 已完成 M3 Round 2 的权限复核，报告在
docs/agent-governance/A5-m3-r2-permission-review.md（base main @ 860e6cd，分支
agent/a5-r2-review；工作树另有未提交的
apps/server/src/ai/route.invariants.test.ts）。请复核报告并裁定：
1) 是否保留新增的 4 个 server 测试（225→229）并合入；
2) P3-1（documentId 与 content 无服务端绑定；insert-at-end/empty 的 type-level 锚点
   可跨文档被应用）的加固方式：A2 面板一行 documentId 守卫 / A4 apply 端口 /
   留到 M4（A5 建议留 M4 或 A2 最小守卫；不得把新原因加进 shared 的
   ValidationFailureReason）；
3) 是否把 M4 D1（真实认证）、D3（生产拒绝 AI_PROVIDER=stub + openai 必需 key）、
   D6（限流/配额/429/成本）作为启用 AI_PROVIDER=openai 的硬前置。A5 建议：是。
另请注意：本轮结论仅覆盖 Node/HTTP 层；真实 OpenAI 与浏览器 UI 未跑。不要改动
production code / shared contract 除非先记录 decision。
```
