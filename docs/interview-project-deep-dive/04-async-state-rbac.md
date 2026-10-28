# 04 · 异步竞态治理与 RBAC 一致性（AbortController / requestId / Owner-Editor-Viewer）

> **Evidence commit（本报告所有 `path:Lx-Ly` 与 permalink 的锚点）**：`57a9bee5f2f8d6ff30f2a8373b61328546475183`
> **报告序号**：04/05 · **性质**：docs-only（不改代码/测试/package.json）
> **证据来源**：浏览器场景在 `1807ea1` 跑出 **73/73 PASS, exit 0**。`git diff 1807ea1..57a9bee` 对三个关键场景文件（`08-evidence-gate.mjs` / `20-m2-phase2-authz.mjs` / `21-m2-f1-role-ui.mjs`）**为空**；`apps/` 有增量（Markdown Preview 等），但本报告引用的 authz / 请求取消 / capabilityGate 代码行已逐条对 HEAD 核对。**场景总数后来增长**（见 §12.6）。
> **一句话口径**：权限那半边证据强（多层同一判定 + 真实浏览器 + 服务端拒绝）；异步那半边**只有目录列表一条真实可取消路径**，"document metadata stale" 是 `NOT APPLICABLE`，"requestId guard" 是未压测的 residual。

---

## 1. 简历原句（逐字）与 claim 拆分

> 异步竞态治理：针对文档快速切换、权限变化导致的请求竞态，使用 AbortController 主动取消失效请求，并结合 Owner / Editor / Viewer 权限状态统一控制编辑器能力，避免旧请求结果覆盖当前文档状态。

| # | Claim | 判定 | 证据 | 必须补的限定 |
| --- | --- | --- | --- | --- |
| C1 | 文档快速切换导致的请求竞态 | **PASS（但对象要改）** | 真实可取消路径是 `AiDirectory` 的 `GET /api/documents`（`AiDirectory.tsx:116-142`）；切换文档时面板卸载 → cleanup abort | 切文档本身**不发** metadata 请求，它是 WS `join-room`；所以不能说"文档内容请求有竞态" |
| C2 | 权限变化导致的请求竞态 | **REWORD** | 权限变化不产生 HTTP 请求（cookie 不变）；真实机制是"服务端每帧重查 role"，客户端 role 只在 `room-joined` 更新 | 应说"权限变化导致的**授权结论过期**"，而不是"请求竞态"；UI 会滞后（实测 3 s，D-066 §5 禁止说"即时生效"） |
| C3 | 使用 AbortController 主动取消失效请求 | **PASS** | `api.ts:52-110`（每个请求自带 controller + 5 s timeout）；`AiDirectory.tsx:119-123`；`AiSuggestPanel.tsx:206-208`；`remoteProvider.ts` 同纪律 | 只有一条路径被**真实浏览器**证明（目录列表，69–78 ms `AbortError`），其余是代码纪律 + 单测 |
| C4 | 结合 Owner / Editor / Viewer 统一控制编辑器能力 | **PASS** | 唯一规则表 `permission.ts:37-44`；UI 经 `capabilityGate.ts:53-81`；编辑器两个 facet + 投递层；服务端 HTTP/WS 各自重查 | `commenter` 是服务端层级，**没有**浏览器场景（`docs/PROJECT.md:38-39`） |
| C5 | 避免旧请求结果覆盖当前文档状态 | **PASS（传输层+UI 层）/ 未压测（guard 本身）** | 旧 200 被浏览器拒绝投递（`Invalid InterceptionId`）；`active-document`、编辑器文本、目录都守在 B；陈旧标记不进 DOM（`08-evidence-gate.mjs:771-847`） | `requestId` 的"旧响应真的到达并被丢弃"这一支**构造不出来**（`DECISIONS.md:3735`），只能作为 residual 承认 |

**一句话修正版（建议就这么讲）**：
> 异步这块我做的是"所有权 + 关闸"：目录请求在文档切换时被 AbortController 取消（真实 200 被扣住、切换后 69 ms 出现 AbortError、浏览器拒绝投递）；权限这块我做的是"同一张能力表在 HTTP、WS 每一帧、UI 三处重复判定"，服务端才是边界，UI 只决定显示什么。

---

## 2. 业务问题

**用户看到的现象（两个，别混在一起）**

1. **"我切到 B 了，为什么列表还是 A 的？"** 快速切换文档时，之前发出去的请求还在路上。它回来时如果直接 `setState`，就会把 A 时代的数据写进 B 的界面。用户不一定能说出哪里错，但会看到"当前文档 B、列表里 A 是 current"这种自相矛盾的画面。
2. **"我是 viewer，为什么还能编辑？"** 前端把 role 当权限来源时，改一个 DOM 属性就能写。真正的问题是：**服务端有没有独立地拒绝**。

**为什么这两件事是同一个问题**
两者都是"**谁有权决定当前状态**"：

- 异步请求的所有权属于**发起它的那个页面/文档**；一旦那个所有权消失（切文档、卸载、重新生成），它的结果就必须作废——即使它"成功"了。
- 权限的所有权属于**服务端**；客户端只能显示，不能授予。

**本项目对这两条的产品承诺（写在 `PROJECT.md` 里）**

- "Switching documents quickly must never display document A's content inside document B."（`docs/PROJECT.md:40-41`）
- "A `viewer` cannot mutate a document, and the block happens on the server, not only in the UI."（`docs/PROJECT.md:63-64`）
- 并发协作证据只到**两个用户**（`docs/PROJECT.md:18-21`：两个独立 browser profile；三个以上未验证）。

**为什么不能靠"防抖/延时"解决**
防抖只是降低概率：只要请求可能在切换后才回来，就必须有"作废"机制。延时更糟——它把正确性变成时间赌博。

---

## 3. 完整流程

### 3A. 竞态：A 请求 → 切 B → B 先回 → A 后回

先纠正一个常见误解：**这个客户端在打开/切换文档时不发任何 document-metadata HTTP 请求**（`08-evidence-gate.mjs:577-595` 用页面自己的请求日志断言 `GET /api/documents/:id` 计数为 **0**）。切换是 `documentSelected` → `AppShell` 的 `key` 变化 → 旧 workspace 卸载 → 新 session → WS `join-room` → `room-joined`。

所以真实的竞态对象是**目录列表**（`AiDirectory` 的 `GET /api/documents`），流程如下：

| # | 时刻（页面时钟，实测） | 发生什么 | 层 | 状态 | 同步/异步 | 如果失败/如果没做 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 725 | 用户点 Refresh → `load()`：先 abort 上一个 controller，再建新 controller，`requestId += 1`，`setState(loading)` | React → HTTP | `directory = loading`；`abortRef` 持有 controller | 同步发起，异步等待 | 不 abort 旧的 → 两个请求竞争，谁后回谁赢 |
| 2 | 725 | `requestJson` 再包一层 controller（链式 abort）+ 5 s timeout | `api.ts` | 传输层 | 异步 | 不设 timeout → 网络黑洞时永远 loading |
| 3 | ~764 | 用户切到 B（真实 UI 输入 + Enter） | Redux → React | `activeDocumentId=B`，`metadata=null` | 同步 dispatch | — |
| 4 | 764→907 | 旧 workspace 卸载 → `AiDirectory` 的 cleanup 执行：`requestRef += 1`、`abortRef.abort()`、`flow.abort()` | React cleanup | 面板消失 | 同步（cleanup） | 不 abort → 请求继续，回来时组件已挂载到 B（或已卸载） |
| 5 | 794（请求后 **69 ms**） | 页面自己的请求日志出现 `error:'AbortError'`, `status:null` | 传输层 | 请求作废 | — | 若靠 5 s timeout，UI 会先"卡" 5 秒 |
| 6 | 907 | B 的 `join-room` 完成、`room-joined(B)` 到达、B 的正文渲染 | WS → 协同层 | `session(B)` active | 异步 | — |
| 7 | 之后 | 测试尝试 `Fetch.fulfillRequest` 强行放行旧 200 → Chrome 返回 `Invalid InterceptionId`（`delivered:false`） | 浏览器网络栈 | 旧响应**不可能**交付 | — | 若真被交付，则 `requestId` 是第二道闸 |
| 8 | 之后 | 重新打开目录：28 行、服务端顺序、`aria-current` 只有 B、无陈旧行 | React | `directory(B)` | 异步（新请求） | — |

**上表每一步的输入 → 输出**（补 §3 模板要求的"输入/输出"两列）：

1. 输入 = 用户点 Refresh；输出 = 新的 controller + `requestId=n+1` + `state=loading`。
2. 输入 = 外层 `signal`；输出 = 一个带 5 s timeout 的 `fetch`（内层 controller）。
3. 输入 = 新文档 id；输出 = `activeDocumentId=B`、`metadata=null`、workspace 重挂载。
4. 输入 = 旧 workspace 卸载；输出 = 三个 cleanup 动作（id+1、abort、abort 创建流程）。
5. 输入 = abort 信号；输出 = 页面请求日志的一条 `{status:null, error:'AbortError'}`。
6. 输入 = `join-room(B)`；输出 = `room-joined(B)` + B 的正文进入编辑器。
7. 输入 = 被扣住的旧 200；输出 = `Invalid InterceptionId`（`delivered:false`）。
8. 输入 = 重新打开面板；输出 = 28 行服务端列表、`aria-current` 只有 B。

**"直接 dispatch 为什么会覆盖"的机制**：
`load()` 的成功分支写的是 `setState({kind:'ready', documents})`（`AiDirectory.tsx:127-132`）。如果旧响应也走到这里，它会：

- 把 **A 时代的列表**写进 B 的面板 → 行集错、`aria-current` 可能标到 A；
- 在"新建文档"流程里更危险：`refreshDirectory → selectDocument(newId)` 是有顺序的（`AiDirectory.tsx:150-163`），旧响应会让一次已经被用户放弃的创建动作**在 B 的 workspace 上切换文档**；
- 若把 `activeDocumentId` 也交给响应（常见的 `dispatch(openDocument(res.id))` 写法），就会直接"旧请求把用户拽回 A"。

本项目的 guard 是**两道**：`controller.signal.aborted`（传输层）+ `requestId !== requestRef.current`（所有权层）。两者都在 `then`/`catch` 的**第一行**（`AiDirectory.tsx:127-141`）。

### 3B. 为什么"只 abort"不够

| 场景 | abort 管用吗 | 靠什么兜住 |
| --- | --- | --- |
| 响应还在网络栈里，未交付 | 管用：abort 后 Chrome 拒绝交付（`Invalid InterceptionId` 实测） | — |
| 响应**已经交付**、`.then` 已排队（微任务） | **不管用**：abort 不会撤销已 resolve 的 Promise | `requestId` 比较：旧请求的 id 已不是当前值 |
| 组件已卸载，`setState` 是空操作，但**副作用**（切文档、写 store、更新 ref）仍会发生 | 不管用 | cleanup 里 `requestRef += 1` + `abortRef.abort()`，让 late 分支在第一行返回 |
| 旧请求"成功"但语义过期（例如携带旧文档 id） | 不管用 | 领域校验：`applySuggestion` 比对 `suggestion.documentId !== port.documentId`（`apply.ts:92-99`） |

`AiDirectory.tsx:110-114` 的注释把这件事写得很直白：**abort 是主闸，id 是第二道闸**。`DECISIONS.md:3735` 进一步承认：**id 这道闸没有被压测**，因为产品每次所有权变化都会 abort，Chrome 不会交付被 abort 的响应，所以"旧响应真的到达"这个分支需要给产品加"不 abort 开关"才能构造——属于产品改动，不在证据授权范围内。

### 3C. 权限：一条判定，四层执行

```text
① 身份
   Clerk session cookie ──► @clerk/backend authenticateRequest ──► VerifiedIdentity
        （null on missing/malformed/expired/throw；不打印 token）
   demo（dev/test）──────► POST /api/session/bootstrap ──► httpOnly cookie ──► internal userId
                            │
② 内部用户（不是 Clerk sub）  └─► app_user.upsertByClerkUserId（UNIQUE + OR IGNORE）──► internal userId
                            │
③ 成员关系                  document_id + user_id + role（SQLite 表 authz_document_membership）
                            │        roleFor() 同步读取；行不可解析 ⇒ null（fail closed）
                            ▼
④ 能力（唯一规则表）        documentCapabilities{ canRead, canComment, canEdit, canManageMembers }
                            │
        ┌───────────────────┼────────────────────┬─────────────────────────┐
        ▼                   ▼                    ▼                         ▼
   HTTP GET/POST       WS join               WS 每一帧                  UI
   401 / 404 / 403     roleFor+canRead       SyncStep1/awareness:canRead  capabilityGate(role)
   200                 else ROOM_NOT_FOUND   SyncStep2/Update:canEdit     readOnly + notice
                                            FORBIDDEN（非致命，先于 apply）
```

| # | 步骤 | 输入 | 输出 | 层 | 状态 | 同步/异步 | 失败 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 解析身份 | `Cookie` 头（**唯一**输入） | `AuthenticatedUser \| null` | 服务端 authz | 无（每请求重算） | 异步（Clerk SDK） | 无 cookie / 验证抛错 → `null`；Clerk 模式 401 body 是 `session_required`，demo 模式是 `unauthenticated`（`app.ts:682-685`） |
| 2 | 映射内部用户 | `VerifiedIdentity` | 内部 `userId` | 持久化 | `app_user` 行（幂等） | 异步 | 空 `clerkUserId` → `null`（不映射，避免所有坏 token 落到同一行） |
| 3 | 查成员关系 | `(documentId, userId)` | `DocumentRole \| null` | SQLite（独立只读连接） | 无缓存 | **同步** | 无行 → `null`；role 不可解析 → `null`（fail closed） |
| 4 | 算能力 | `DocumentRole` | 4 个布尔 | 共享包 | 无 | 同步 | role 为 `null` → `can=false` |
| 5 | HTTP 判定 | `(documentId, userId, capability)` | `granted/not_found/forbidden/unauthenticated` | `authz.authorizeDocument` | 无 | 异步（要读文档元数据） | 无成员/不可读/文档不存在 → **同一个 `not_found`**（404 同 body 同头） |
| 6 | WS join | `join-room{documentId, protocolVersion}` | `room-joined{role, peers}` 或 `ROOM_NOT_FOUND` | RoomRegistry | 加入房间（原子替换） | 同步授权 + 异步 hydration barrier | 拒绝时**旧房间保持**（先校验后变更） |
| 7 | WS 帧 | 每个 binary frame | 允许 / `FORBIDDEN` | RoomRegistry | 无缓存，**逐帧重查** | 同步 | 拒绝发生在 apply/persist/broadcast **之前**；socket 不关（"读者仍是读者"） |
| 8 | UI | `session.getRole()` | `capabilityGate` → `readOnly` | React | `session` 通知驱动重读 | 同步 | role `null` → **可编辑**（不锁死用户自己的文字）；管理能力永不乐观显示 |
| 9 | 编辑器执行 | `readOnly` 布尔 | 两个 facet + 投递层 + 快捷键 | CodeMirror | `Compartment` 重配置（不重建） | 同步 | 投递层若发现"门说只读但仍有变更" → 用权威 `Y.Text` 回填（`blocked`） |

**关键点**：第 5、6、7 步都**不看**客户端声明的任何东西。`join-room.mode`、query 里的 `userId`、header 里的 `userId` 都不参与判定（`registry.ts:434-435`；`p2/2` 实测）。

---

## 4. 源码定位（≥10 处，行号已对 `57a9bee` 核对）

| # | 位置 | 符号 | 职责 | Permalink |
| --- | --- | --- | --- | --- |
| 1 | `packages/shared/src/permission.ts:10-44` | `DOCUMENT_ROLES`, `documentCapabilities` | 四个角色 + 唯一能力表（`canRead/canComment/canEdit/canManageMembers`） | [L10-L44](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/packages/shared/src/permission.ts#L10-L44) |
| 2 | `apps/server/src/authz/clerk-session-verifier.ts:139-158` | `verify` | cookie → `VerifiedIdentity`；任何失败都 `null`，不打印 token | [L139-L158](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/authz/clerk-session-verifier.ts#L139-L158) |
| 3 | `apps/server/src/authz/clerk-session-verifier.ts:180-201` | `toVerifiedIdentity` | 只认 SDK 的"已登录 + 有 userId"；空 `sub` → `null` | [L180-L201](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/authz/clerk-session-verifier.ts#L180-L201) |
| 4 | `apps/server/src/authz/identity.ts:108-162` | `resolveAuthenticatedUser` | HTTP 与 WS upgrade 共用的身份解析；`null` 即失败 | [L108-L162](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/authz/identity.ts#L108-L162) |
| 5 | `apps/server/src/persistence/sqlite-store.ts:443-464` | `upsertByClerkUserId` | Clerk sub → 内部 id（UNIQUE + `OR IGNORE`；内部 id 由 `randomUUID` 生成） | [L443-L464](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/persistence/sqlite-store.ts#L443-L464) |
| 6 | `apps/server/src/authz/membership-store.ts:94-106` | SQL 语句 | 成员关系就是一行表数据（`authz_document_membership`） | [L94-L106](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/authz/membership-store.ts#L94-L106) |
| 7 | `apps/server/src/authz/membership-store.ts:149-156` | `roleFor` | 无行 → `null`；不可解析 → `null`（fail closed，绝不默认 viewer） | [L149-L156](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/authz/membership-store.ts#L149-L156) |
| 8 | `apps/server/src/authz/authz.ts:220-250` | `can`, `authorizeDocument` | role → 能力 → 决策；三种"读不到"折成同一个 `not_found` | [L220-L250](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/authz/authz.ts#L220-L250) |
| 9 | `apps/server/src/app.ts:661-680` | `createDocumentAccessHandler` | 生产 HTTP handler：identity → 绑定 id → `authorizeDocument` → 映射 | [L661-L680](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/app.ts#L661-L680) |
| 10 | `apps/server/src/app.ts:704-725` | `respondToDocumentAccess` | 401/404/403/200 + 穷尽性守卫（新增决策类型不映射就编译失败） | [L704-L725](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/app.ts#L704-L725) |
| 11 | `apps/server/src/app.ts:546-585` | `POST /api/documents` | identity(401) → 严格 body(400) → 一次原子插入(201)；id/owner 是服务端事实 | [L546-L585](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/app.ts#L546-L585) |
| 12 | `apps/server/src/persistence/sqlite-store.ts:399-424` | `createDocumentWithOwner` | 文档行 + 元数据行 + owner 成员行，**一个** `BEGIN IMMEDIATE … COMMIT` | [L399-L424](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/persistence/sqlite-store.ts#L399-L424) |
| 13 | `apps/server/src/rooms/registry.ts:330-406` | `joinRoom` | 先校验/授权、后变更；第二个房间是**原子替换**（`#detach` 再 `room.add`） | [L330-L406](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/rooms/registry.ts#L330-L406) |
| 14 | `apps/server/src/rooms/registry.ts:437-459` | `#resolveJoinRole` | `roleFor` + `canRead`；`join-room.mode` 不是授权输入 | [L437-L459](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/rooms/registry.ts#L437-L459) |
| 15 | `apps/server/src/rooms/registry.ts:716-760` | `#authorizeFrame` | 逐帧重查：SyncStep1/awareness 要 `canRead`，SyncStep2/Update 要 `canEdit`；`FORBIDDEN` 非致命且先于 apply | [L716-L760](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/rooms/registry.ts#L716-L760) |
| 16 | `apps/server/src/ws.ts:19-28` | upgrade 认证说明 | socket 建立前认证；未认证得到裸 401，**不建立 socket** | [L19-L28](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/ws.ts#L19-L28) |
| 17 | `apps/web/src/features/permissions/capabilityGate.ts:53-81` | `capabilityGate` | role → 4 个布尔；**未知 role 可编辑**，管理能力永不乐观 | [L53-L81](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/permissions/capabilityGate.ts#L53-L81) |
| 18 | `apps/web/src/features/editor/editorEditability.ts:59-61` | `editorEditability` | `EditorState.readOnly` + `EditorView.editable` 同时设 | [L59-L61](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/editorEditability.ts#L59-L61) |
| 19 | `apps/web/src/features/editor/editorEditability.ts:105-121` | `deliverLocalChanges` | 第二道："门说只读"时拒绝投递并用权威正文回填 | [L105-L121](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/editorEditability.ts#L105-L121) |
| 20 | `apps/web/src/features/editor/editorEditability.ts:82-91` | `runSessionHistory` | Ctrl+Z 也要过只读门（手写 keymap 不继承 CM 检查） | [L82-L91](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/editorEditability.ts#L82-L91) |
| 21 | `apps/web/src/features/editor/useCollaborativeSession.ts:73-101` | `useSessionRole` | 唯一 role 读取路径（`session.getRole()`），不镜像到 Redux | [L73-L101](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/useCollaborativeSession.ts#L73-L101) |
| 22 | `apps/web/src/features/editor/DocumentWorkspace.tsx:167-179` | `capabilityGate(role)` | 全应用**唯一**构造 gate 的地方 | [L167-L179](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/DocumentWorkspace.tsx#L167-L179) |
| 23 | `apps/web/src/features/editor/AiDirectory.tsx:108-141` | `abortRef`, `requestRef`, `load` | abort + 单调 id；只有当前请求能落地 | [L108-L141](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/AiDirectory.tsx#L108-L141) |
| 24 | `apps/web/src/features/editor/AiDirectory.tsx:175-185` | cleanup | 卸载/切文档：`requestRef += 1`、abort 请求、abort 创建流程 | [L175-L185](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/AiDirectory.tsx#L175-L185) |
| 25 | `apps/web/src/api.ts:52-110` | `requestJson` | 每个请求自带 controller、5 s timeout、`aborted` 与 `timeout` 分开归类 | [L52-L110](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/api.ts#L52-L110) |
| 26 | `apps/web/src/features/editor/AiSuggestPanel.tsx:181-246` | `abortRef`, `generate` | 每次 Generate 先 abort 上一个；late 结果两处拦（signal + `.aborted`） | [L181-L246](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/AiSuggestPanel.tsx#L181-L246) |
| 27 | `apps/web/src/features/ai/apply.ts:92-99` | `applySuggestion` | 提案必须属于当前文档，否则 `malformed` | [L92-L99](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/ai/apply.ts#L92-L99) |
| 28 | `apps/web/src/AppShell.tsx:13-16,67-69` | `key={activeDocumentId}` | 切文档 = 重挂载，旧 session 随之销毁（一个 socket 一个房间） | [L13-L16](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/AppShell.tsx#L13-L16) |
| 29 | `apps/web/src/collab/public.ts:80-121` | `useCollaborativeDocument` | effect 的依赖是"真正需要新 session 的值"；cleanup 里 `destroy()` | [L80-L121](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/public.ts#L80-L121) |
| 30 | `apps/web/src/collab/internal/document-session.ts:306-328` | `destroy()` | 固定顺序：awareness → socket → undo → observers → IndexedDB | [L306-L328](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L306-L328) |

（共 30 处。）

---

## 5. 状态归属表

| 状态 | owner | 存在哪 | 生命周期 | 谁写 | 谁读 | 为什么不能换 |
| --- | --- | --- | --- | --- | --- | --- |
| 身份（Clerk session） | Clerk | 浏览器 cookie（`HttpOnly`） | Clerk 决定 | Clerk | 服务端 verifier | 客户端 JS 读不到（`p2/9` 实测） |
| 内部 userId | 服务端 `app_user` | SQLite 行 | 永久 | `upsertByClerkUserId` | 所有授权判定 | 用 Clerk `sub` 当成员键，重建用户会继承旧权限 |
| 成员关系 role | 服务端 membership 表 | SQLite `authz_document_membership` | 永久 | `INSERT OR IGNORE` / 变更 | `roleFor` | 客户端缓存 = 一个可被改写的授权输入 |
| 当前会话的 role | `DocumentSession.roomRole` | 内存（session） | 一次成功 join 到房间结束 | `room-joined`（经 `isDocumentRole` 校验） | `session.getRole()` → `useSessionRole` | 房间结束就清空；存 Redux 会活过房间 |
| 能力（4 布尔） | `capabilityGate(role)` 的**派生值** | 每次渲染计算 | 一次渲染 | 无（纯函数） | UI 组件 | 缓存会产生"权限已变、UI 未变"的第二真相 |
| 只读（编辑器） | CodeMirror `Compartment` | `EditorState` | 编辑器存活期，可原地重配置 | `editability.reconfigure` | CM 输入路径 | 重建编辑器会丢掉未落盘的本地文字 |
| 在途请求 | `abortRef` + `requestRef` | `AiDirectory` 组件实例 | 组件挂载期 | `load()` / cleanup | `load()` 的 then/catch | 放在 store 里会让"取消"变成一次全局状态变更 |
| 当前文档 | Redux `document.activeDocumentId` | store | 应用期 | `documentSelected` | `AppShell` / 目录 | 它是"UI 指向"，不是权限也不是正文 |
| 目录列表 | `AiDirectory` 局部 state | 组件 state | 面板打开期 | 当前请求的 then | 目录视图 | 放全局会让"面板关闭后还有一份旧列表" |
| 提案（AI） | `AiSuggestPanel` 局部 state | 组件 state | 面板打开期，`key=localClientId` 换副本即丢弃 | provider 结果 / Accept | 面板 | 提案绑定某一次文档副本，跨副本没有意义 |

**两条归属规则**（可以背）：

1. **能授权的东西归服务端**（身份、成员、role、能力判定）。
2. **会过期的东西归发起它的那个实例**（请求、列表、提案、session）。

---

## 6. 技术选型

### 6.1 取消机制：AbortController（而不是"忽略结果"）

| 需求 | 候选 | 当前 | 为什么 | 放弃什么 |
| --- | --- | --- | --- | --- |
| 让在途 HTTP 真正停下 | 只忽略回调 / `AbortController` | **AbortController** | 释放连接、让浏览器拒绝交付、让 UI 立刻结束 loading | 需要把 signal 穿过每一层（`requestJson` → `listDocuments` → 组件） |
| 保证"只有最新答案能落地" | 时间戳比较 / 单调 `requestId` | **`requestId` + `signal.aborted`** | 时间戳会受时钟回拨影响；id 是本地单调计数 | 每个异步入口都要维护一个 ref（重复代码） |
| 超时 | 无 / 全局 fetch 包装 | `requestJson` 内 5 s + `TimeoutError` 归类 | 超时与"被切换取消"必须能区分（否则会把取消显示成失败） | 5 s 是拍的值，没有按接口调优 |

**被否掉的方案**：把"当前请求 id"放进 Redux。理由是它会让 abort 这个动作变成一次全局渲染，并且把"组件生命周期"错误地提升成"应用状态"。

### 6.2 认证：Clerk，而不是自建密码

| 维度 | Clerk（当前，D-082 §1） | 自建密码（Argon2 + reset + session 表） |
| --- | --- | --- |
| 需求 | V1：Email + Google 登录，服务端可验证，HTTP 与 WS upgrade 都能用 | 同样能实现 |
| 实际选择 | `@clerk/clerk-react` + `@clerk/backend`；服务端只保存 `app_user` 映射 | **REJECTED** |
| 为什么 | 不重复造"密码存储/重置/邮件/风控"；`authenticateRequest` 已覆盖签名、过期、吊销；**不再造第二套 durable login session**（D-082 §1 第 4 条） | — |
| 代价 | 外部依赖、需要两个 key（publishable 公开 / secret 仅服务端）、Clerk 不可用即无法登录 | 全部自己承担，且有真实的安全风险 |

**必须说的边界**：**生产 Clerk 登录没有 live 验证**（`docs/PROJECT.md:9-10`：demo bootstrap 在 M4 改为 Clerk，但未 live 验证）；demo bootstrap 只能存在于 dev/test（D-082 §1 要求配置层拒绝）。

### 6.3 存储：SQLite（单实例），不是 Postgres

| 维度 | SQLite（当前） | Postgres |
| --- | --- | --- |
| 需求 | 单实例、单 region、数据量小（文档 + 成员 + app_user） | 多实例/HA 才需要 |
| 事务 | `BEGIN IMMEDIATE … COMMIT`；**同库三行可原子**（这正是 B12.5 要的） | 同样支持，但要多一个服务 |
| 为什么不用 PG | 多一个进程/连接池/迁移工具/备份策略；V1 明确 single instance | **REJECTED**（D-082 §2：不引入 Postgres/K8s/Redis/Kafka，除非有真实证据） |
| 代价 | 单写者；WAL 下一写多读；跨库事务不存在（所以成员表从 `authz.db` 搬进 `insighthub.db`，D-084） | 运维复杂度、成本 |

**关键细节**：成员表原来在独立文件 `authz.db`，为了"文档 + 元数据 + owner 成员"三者原子，**搬进主库**（`membership-store.ts:5-25` 记录了这次推翻）。这是一个很好的"决策被证据推翻"的例子。

### 6.4 部署：单实例 + 持久盘，不是 K8s

| 维度 | 当前（D-082 §2） | K8s / 多实例 |
| --- | --- | --- |
| 拓扑 | 一个 Render Web Service、一个 Node 进程、同源静态 + API + WS + SQLite + 持久盘 | 需要共享存储/粘性会话/房间状态外置 |
| 为什么不行 | WebSocket 房间与 awareness 是**进程内**状态；多实例要么粘性路由要么外置 pub/sub | 超出 V1 范围（`docs/PROJECT.md:74-77` 明列为 non-goal） |
| 代价 | 部署/重启有短暂停机；不能水平扩容 | — |

**这条要主动说**：正因为房间在进程内，**session 也是进程内的**（demo 模式），所以 `p2/S` 记录"重启后旧 session 失效且页面不会自动重新 bootstrap"。这不是 bug，是单实例设计的直接后果。

---

## 7. 关键实现细节（8 个点）

1. **abort 链是两层的**：组件的 `abortRef.controller` → `requestJson` 内部 controller（`api.ts:58-60` 监听外层 signal 并 abort 内层）。好处是"组件的取消"和"5 s 超时"能区分：`TimeoutError` vs `aborted`（`:91-101`）。测试正是靠这个区分证明"是切换取消的，不是超时"。
2. **两处 late-result 拦截，不是一处**：`AiDirectory` 在 `then` 和 `catch` 的第一行都写 `if (controller.signal.aborted || requestId !== requestRef.current) return;`（`:127-141`）。少写一处，abort 后到达的 rejection 会把面板变成错误态。
3. **cleanup 里同时做三件事**：`requestRef += 1`（让已排队的 then 失效）、`abortRef.abort()`（让传输层停下）、`flow.abort()`（让"新建文档"流程不要在已离开的 workspace 上切换）。只做 abort 会漏掉"已 resolve 但未执行"的微任务（`AiDirectory.tsx:175-185`）。
4. **AI 提案同样两道闸，且第三道在写入时**：`generate` 每次先 abort 旧的（`AiSuggestPanel.tsx:206`），late 结果检查 `signal.aborted`（`:237,242`），`applySuggestion` 再检查 `documentId`（`apply.ts:99`）。第三道是关键：前两道都在客户端内存里，第三道拒绝的是"提案与文档不匹配"这个**语义**事实。
5. **服务端授权不缓存**：`#authorizeFrame` 每帧重查（`registry.ts:716-760`）。这就是为什么"降级后下一次击键立刻被拒"（`p2/5` 实测 durable 未变、socket 数不变），而 UI 还显示旧 role（`f1/1` 实测 3 s）。
6. **拒绝是非致命的**：`FORBIDDEN` 不关 socket（`registry.ts:706-709`）。关掉会把"你不能写"变成"你不能留"，而 viewer 的存在意义就是读。测试断言了 `closeCode !== 1008`（`20-m2-phase2-authz.mjs:244-247`）。
7. **非泄露是"同码同体"而不是"友好提示"**：`authorizeDocument` 把"无成员/不可读/文档不存在"折成同一个 `not_found`（`authz.ts:236-240`），`respondToDocumentAccess` 对 `not_found` 只有一个分支（`app.ts:709-711`）。`p2/3` 是逐字节比较 body 与 header。
8. **创建的三行是原子的**：`createDocumentWithOwner` 在**一个连接、一个 `BEGIN IMMEDIATE`** 里插文档/元数据/owner 成员（`sqlite-store.ts:399-424`）。第三行失败会回滚前两行，所以不存在"有文档没有 owner"。这直接支撑 `b125/1` 的"创建后立刻是 owner、可编辑"。

---

## 8. 为什么不用 X

| X | 为什么没用 | 代价/后果 |
| --- | --- | --- |
| 全局 fetch 拦截器统一 abort | 取消是**所有权**问题，不是 URL 问题；拦截器不知道"哪个组件/文档拥有这个请求" | 需要每个调用点自己带 signal（现状），重复但明确 |
| 用时间戳判断新旧 | 时钟可回拨；同毫秒内多个请求无法排序 | 单调计数器更便宜且可测 |
| 把 `requestId` 放进 Redux | 取消会触发全局渲染；生命周期被提升为应用状态 | 现在是组件 ref |
| 乐观 UI（先改 UI 再等服务端） | 权限失败会让用户看到"写进去了又回滚" | 现在是"拒绝 → UI 回填权威正文"（`deliverLocalChanges` 的 `blocked` 分支） |
| 客户端缓存 role | 缓存会活过房间；降级/吊销后仍显示旧权限 | 现在 role 随 `room-joined` 更新、随房间结束清空 |
| 角色变更推送（server push） | **未实现**；协议里没有这个消息 | UI 滞后直到下一次 join（实测 3 s）；服务端仍逐帧拒绝 |
| 基于 `join-room.mode` 的写模式 | 客户端声明不能作为授权输入 | `mode` 被完全忽略（`registry.ts:434-435`） |
| 用 403 区分"文档存在但无权" | 会泄露存在性 | 统一 404（`p2/3` 同体比较） |
| 自建密码 / Postgres / K8s | 见 §6.2–6.4 | V1 明确不做 |

---

## 9. Used 知识点（定义 / 在哪 / 为什么 / 追问 / 答案）

### 9.1 AbortController 与 signal 传播

- **定义**：`AbortController` 提供 `signal`；`fetch` 收到 abort 会以 `AbortError` 拒绝；`signal` 可链式转发。
- **在哪**：`api.ts:57-64`（内层 controller 监听外层 signal）、`AiDirectory.tsx:119-123`、`AiSuggestPanel.tsx:206-208`。
- **为什么**：取消必须**传播到传输层**，否则只是"忽略结果"，连接与资源仍在。
- **追问**："abort 之后 Promise 还会 resolve 吗？" → 不会 resolve，会以 `AbortError` reject；但如果响应**已经**交付，reject 也来不及了，所以要 id。
- **答案**：abort 管传输，id 管所有权。

### 9.2 单调请求 id（ownership token）

- **定义**：组件内单调递增计数器，每次发起请求 +1；回调只在"我的 id 仍是当前值"时生效。
- **在哪**：`AiDirectory.tsx:110-123`。
- **为什么**：Promise 的回调是微任务，"作废"必须有一个可比较的值；abort 状态可能来不及反映。
- **追问**："id 会溢出吗？" → JS number 到 2^53，实际不可能；真要严谨可以换成 `AbortController` 的 identity 比较（两者都持有即可）。
- **答案**：id 是"这张票还有效吗"的唯一凭据。

### 9.3 请求竞态的三种错法

- **定义**：stale read（旧读覆盖新状态）、stale write（旧写落到新实体）、lost update（新写被旧写覆盖）。
- **在哪**：目录列表是 stale read；`applySuggestion` 的 `documentId` 检查是防 stale write；`room-joined` 单房间是防 lost update（第二个 join 原子替换旧房间）。
- **为什么**：三种错法的修法不同——read 用 abort+id，write 用实体校验，并发用原子替换。
- **追问**："你的项目里三种都有吗？" → read 有真实浏览器证据；write 有 `apply.ts` 的校验 + m3/9 场景；"lost update"在 CRDT 层由 Yjs 合并解决，不用锁。
- **答案**：先分类，再选工具。

### 9.4 RBAC 与 capability 模型

- **定义**：RBAC 是"用户→角色→权限"；capability 是"这个角色能不能做这个动作"的布尔函数。
- **在哪**：`permission.ts:37-44`。
- **为什么**：把"角色名比较"收敛成"一张表"，UI 与服务端就不会漂移；加角色只改一处。
- **追问**："为什么不用 `role === 'editor'`？" → 那种写法会在每个组件里重复，且加 `commenter` 时会漏。
- **答案**：唯一规则表 + 派生，而不是复制。

### 9.5 非泄露（non-disclosure）与 404/403 语义

- **定义**：不能通过响应差异判断"资源是否存在"。
- **在哪**：`authz.ts:236-240`、`app.ts:709-711`、`registry.ts:369-372`（WS 也用 `ROOM_NOT_FOUND`）。
- **为什么**：403 对"存在但无权"、404 对"不存在"，两者之差就是存在性 oracle。
- **追问**："那用户体验不是很差？" → 对**能读**的调用者才给 403（此时存在性已不是秘密），对读不到的人统一 404。
- **答案**：先判"能不能读"，读不到就 404；能读再看具体能力，才允许 403。

### 9.6 会话吊销与"请求级"边界

- **定义**：吊销是让 token 立即失效；"请求级"意味着每次请求都重新验证，而不是靠已建立的连接。
- **在哪**：`app.ts:481-502`（`DELETE /api/session` → 204；demo 模式 revoke；Clerk 模式无本地 session 可撤）；`p2/5-session-revocation` 断言 HTTP 与 WS upgrade 都 401。
- **为什么**：WebSocket 是长连接，如果只在 upgrade 时验证，吊销后旧 socket 仍可写——所以**每一帧**都要查 role（`#authorizeFrame`）。
- **追问**："已建立的 socket 会被踢掉吗？" → 不会立刻；它的**写**会被拒（因为 role 查不到 → `canEdit=false`）。这是"请求级吊销"的真实含义。
- **答案**：吊销对"新请求/新帧"生效，不对"已建立的连接"做强制断开。

### 9.7 SQLite 事务与单写者

- **定义**：`BEGIN IMMEDIATE` 立即取写锁；WAL 允许一写多读。
- **在哪**：`sqlite-store.ts:399-424`、`membership-store.ts:174-198`（seed 也用一个事务）。
- **为什么**：三行必须同生共死；跨库做不到（所以成员表搬进主库）。
- **追问**："为什么成员读用独立连接？" → 让授权判定是一条同步读，不排在文档写后面（`membership-store.ts:19-22`）。
- **答案**：原子性靠同库事务，读性能靠独立只读连接。

### 9.8 "UI 不是安全边界"

- **定义**：任何前端状态都可被用户/脚本改写；安全判定必须在服务端。
- **在哪**：`capabilityGate.ts:14-19`、`editorEditability.ts:27-32`、`ARCHITECTURE.md §8.2`。
- **为什么**：`f1/4` 用 schema-valid 的伪造 `room-joined(role:'owner')` 把 UI 变成可编辑，写入仍 `FORBIDDEN`。
- **追问**："那 UI 门有什么意义？" → 不让用户看到注定失败的按钮；减少"以为能写"的挫败；但**不承担**安全。
- **答案**：UI 管体验，服务端管边界。

---

## 10. Related but not used（**RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**）

- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：`AbortSignal.timeout()` / `AbortSignal.any()`（当前是手写 controller + `setTimeout`）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：TanStack Query / SWR 的 `cancelRefetch`、`keepPreviousData`、请求去重。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：RxJS `switchMap`（"新请求自动退订旧请求"的经典解）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：服务端推送角色变更（协议里没有该消息；UI 只能等下一次 `room-joined`）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：OPA / Casbin 等策略引擎（当前是 44 行 TS 常量表）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：自建密码（Argon2）、邮箱验证、密码重置。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：Postgres / Redis / K8s / 多实例 / 粘性会话 / 房间状态外置。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：搜索（无搜索功能，因此**没有**搜索竞态保护可讲；`DECISIONS.md:3714` 明确不纳入）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：评论功能（`commenter` 只是服务端权限层级，无 UI、无浏览器场景）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：乐观锁 / `If-Match` / revision 条件写（HTTP 层没有；并发正确性交给 CRDT）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：CSRF token（当前靠 SameSite cookie + origin 校验，未引入 token）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：AI 流式输出（SSE / `text/event-stream` / `ReadableStream`）。全仓库 `apps/**` 里这三者一处都没有；AI proposal 是**一次性 JSON 响应**，因此不存在"边生成边落地"的流式取消语义，也就没有对应的流式竞态可讲。

---

## 11. 测试：Given / When / Then（文件 / scenario / 拓扑 / 注入 / raw）

**拓扑（所有浏览器场景相同）**

```
真实 Chrome（CDP，headless）
   ├── Target.createBrowserContext（每个用户独立 storage/cookies）
   └── 页面
        ├── window.__qa（请求日志、socket 计数、错误码计数、编辑器状态）
        └── CDP：Fetch 拦截 / Network 模拟离线 / Input 真实按键

真实服务端（Express + ws + SQLite 临时 dataPath）
   └── WireOracle（Node 侧真 Yjs 客户端，充第三方见证者）
```

**注入手段**：`ctx.authz.grant(...)`（写成员行）、`WireOracle`（真 Yjs socket）、CDP `Fetch.enable`（扣住真实响应）、`deliverServerFrame`（把伪造的 schema-valid 帧投进页面自己的 handler）、`window.__qa`（页面自己的 fetch 日志，不是 CDP 日志）。

### T1 · `p2/1-viewer-cannot-write`

- **Given** 种子文档 `demo-document`（ada=owner、grace=editor、linus=viewer），owner 已写入可读内容
- **When** ① viewer 页面用真实按键尝试输入；② 绕开 UI，用页面**自己的** socket 发一条真实 SYNC update
- **Then** ① `EditorState.readOnly === true`、DOM `contenteditable="false"`、按键不产生 SYNC 帧；② 服务端回 `FORBIDDEN`；durable 文本 3 s 后仍不含该标记；owner 看不到；socket 不关（无 1008）；之后 owner 的编辑仍能到达 viewer
- **文件/行**：`tests/browser/suite/20-m2-phase2-authz.mjs:148-301`
- **raw 断言**：`liveDocumentSockets >= 1`、`sockets` 数不变、`closeCode !== 1008`、`durable` 不含 `VIEWER-WRITE`

### T2 · `p2/2-identity-cannot-be-self-declared`

- **Given** viewer 页面
- **When** 客户端声明 `mode:'readwrite'`，并把 `userId` 注入 join payload；oracle 另外尝试 query / header / payload 三种声明
- **Then** `room-joined.role` 仍是 `viewer`；UI 仍只读；该 socket 上的写仍被拒
- **文件/行**：`20-m2-phase2-authz.mjs:306-501`
- **证明**：身份是服务端解析的，不是客户端声明的

### T3 · `p2/3-non-disclosure-404`

- **Given** 未知 id、无成员关系的 id、自己的 id、无 session
- **When** 页面自己的 `fetch`
- **Then** "未知"与"非成员"的 status/body/headers **逐字节相同**；无 session 是 401
- **文件/行**：`20-m2-phase2-authz.mjs:506-635`

### T4 · `p2/4-role-capability-consistency`

- **Given** owner/editor/viewer 三种真实页面
- **When** 同一张表逐项询问
- **Then** `documentCapabilities` = `authz.can` = HTTP = WS join = WS 帧 = `room-joined.role` = 浏览器可编辑状态；viewer 被拒，owner/editor 落盘
- **文件/行**：`20-m2-phase2-authz.mjs:640-848`；Node 侧三方一致：`apps/server/src/authz/capability-matrix.test.ts:1-23`（含"HTTP 列用生产 handler 挂在探测路由上"的自述）

### T5 · `p2/5-role-change-is-re-evaluated`

- **Given** editor 页面 + 一条 live oracle socket
- **When** (a) 把 linus 降级为 viewer 后，页面继续真实输入；(b) 把 oracle 身份从 viewer 提升为 editor，然后在**同一 socket** 上写
- **Then** (a) 下一次击键得到 `FORBIDDEN`，durable 不含新文本，socket 数不变，降级前的文本仍在；(b) 提升后同一 socket 写入被接受、落盘、并广播给 owner
- **文件/行**：`20-m2-phase2-authz.mjs:853-977`
- **证明**：能力门是**逐帧**重查，不是 join 时缓存

### T6 · `p2/5-session-revocation-is-everywhere`

- **Given** 已 bootstrap 的 session
- **When** `DELETE /api/session`，然后同一 token 走 HTTP 与 WS upgrade（经代理与直连两条路）
- **Then** 两者都 401；已建立的 socket 的状态也被测量并记录
- **文件/行**：`20-m2-phase2-authz.mjs:982-1133`

### T7 · `p2/9-token-not-exposed-to-js`

- **Given** 浏览器已持有 session cookie
- **When** 对比 `Network.getCookies`（浏览器实际持有）与 `document.cookie`、`localStorage`、`sessionStorage`、`/api/session` 响应、bootstrap body、服务端日志
- **Then** cookie 是 `HttpOnly`；token 不出现在任何 JS 可读面
- **文件/行**：`20-m2-phase2-authz.mjs:1138-1284`

### T8 · `f1/1-viewer-is-read-only-and-not-remounted`

- **Given** editor 页面，`.cm-editor` 被打了标记，记录了 mount/unmount 计数与 `EditorView` id
- **When** (a) 服务端把成员降级为 viewer，**等 3 s**（不发新 join）；(b) 断网再恢复，触发新的 `room-joined`
- **Then** (a) UI **仍是 editor**（`role: editor`、`contentEditable="true"`）且编辑器**没有重挂载**——这是被断言的期望，不是缺陷；(b) 角色未知期间 `roleTag === null` 且仍可编辑（不锁死）；恢复后变成 viewer：`contenteditable="false"`、`EditorState.readOnly`、出现诚实的只读提示；**同一个 `.cm-editor` 元素**、mount 计数不变
- **文件/行**：`tests/browser/suite/21-m2-f1-role-ui.mjs:119-344`
- **证明**：UI 会滞后（3 s），服务端不滞后；只读是重配置不是重建

### T9 · `f1/4-ui-gate-is-not-a-security-boundary`

- **Given** viewer 页面
- **When** 把一个 **schema-valid** 的伪造 `room-joined(role:'owner')` 投进页面自己的消息处理函数；然后真实按键 + 显式 SYNC 帧
- **Then** UI 变可编辑、提示消失；但按键产生的 SYNC 帧被 `FORBIDDEN`，显式帧也被 `FORBIDDEN`；无 apply/persist/broadcast；socket 不重连、仍在接收
- **文件/行**：`21-m2-f1-role-ui.mjs:619-794`
- **证明**：赢了 UI 不等于赢了服务端

### T10 · `m3/10-ai-viewer-cannot-accept`

- **Given** viewer 页面，文档里有种子文本
- **When** 打开 AI 面板 → 生成（只需 `canRead`）→ 程序化点击被禁用的 Accept
- **Then** 提案与 diff 正常渲染；Accept `disabled` 且 title 含 "Read-only"；点击后编辑器文本、durable 文本、出站 SYNC 帧数**三者都不变**
- **文件/行**：`tests/browser/suite/31-m3-ai.mjs:982-1109`
- **证明**：AI 写入同样受权限门控，且是"生成可读、应用需写"

### T11 · `stale/directory-list`

- **Given** 文档 A 与 B 都属于 AUTHOR；页面在 A；目录面板已打开过（会发 `GET /api/documents`）
- **When** CDP 在**响应阶段**扣住一次真实的 200（body 4,640 B / 28 个 document id）；在这段时间里通过真实 UI 切到 B；然后尝试 `Fetch.fulfillRequest` 强行放行
- **Then** ① 页面自己的请求日志在请求后 **69 ms** 变 `AbortError`（`status:null`，早于 5 s timeout）；② 强行放行被 Chrome 拒绝（`Invalid InterceptionId`）；③ `active-document` = B、编辑器是 B 的正文、目录已卸载、无错误提示；④ 重新打开目录 = 28 行、服务端顺序、`aria-current` 只有 B、陈旧标记不进 DOM；⑤ 页面 0 error
- **文件/行**：`tests/browser/suite/08-evidence-gate.mjs:543-853`（关键断言 705-720、771-808、810-847）
- **另一条**：场景开头断言"打开/切换不发 metadata 请求"（`metadataCalls.length === 0`，`:590-595`）——这就是 metadata stale 被判 `NOT APPLICABLE` 的**机制**证据
- **raw**：两次记录分别 69 ms / 78 ms（`A6-evidence-gate-round2.md:84`、`tests/browser/README.md:421`）

**Node 侧补充**：`apps/server/src/rooms/authz-enforcement.test.ts:142-265`（upgrade 401、join 角色、非泄露同码、`mode` 非授权输入）与 `:271+`（viewer 的 SYNC 被拒、不落盘、不广播）。

---

## 12. 数字定义

### 12.1 abort 延迟（69 / 78 ms）

- **起点**：页面 `__qa.apiCalls` 里这条请求的 `t`（`performance.now()` 相对页面启动）。
- **终点**：同一条记录被写成 `{status:null, error:'AbortError'}` 的时刻。
- **实测**：请求 725 → 切换开始 764 → abort 794（**69 ms**）；切换完成 907。第二次记录 **78 ms**。
- **判定条件**：必须 `< 5000`（内部 timeout），否则无法证明"是切换取消的"（`08-evidence-gate.mjs:716-720`）。
- **性质**：这是**取消延迟**，不是产品 SLO；断言是不等式，不是等值。

### 12.2 被扣住的响应

`GET /api/documents` → `200`；`Fetch.getResponseBody` = **4,640 B**，含 **28** 个真实 document id。放行尝试 → `Invalid InterceptionId`（`delivered:false`）。
这两条的作用：证明"扣住的是真实完整答案"，以及"浏览器拒绝交付已 abort 的响应"。

### 12.3 角色变更的 UI 滞后（3 s）

- **起点**：`ctx.authz.grant(documentId, linus, 'viewer')` 返回（成员行已改）。
- **终点**：`readEditorGate` 读数。中间 `sleep(3_000)`，且**不**触发新 join。
- **结果**：`roleTag === 'role: editor'`、`contentEditable === 'true'`、无提示、无重挂载。
- **含义**：这是**被断言**的期望（D-066 §5）。安全性由服务端逐帧拒绝保证，不由 UI 保证。

### 12.4 n 与样本

| 数字 | n | 说明 |
| --- | --- | --- |
| 69 ms abort | 1 次运行 | 另一轮记录 78 ms，属同一场景 |
| 28 行 / 4,640 B | 1 次扣住 | 依赖当时 data 目录里的真实文档数 |
| 3 s 滞后 | 1 次测量 | 是"sleep 3 s 后仍未变"的观测，不是精确上限 |
| 73/73 | 1 次完整套件 | 在 `1807ea1`；exit 0 |

### 12.5 环境

Windows 11 10.0.26200 x64 · Chrome **155.0.8059.85** headless · Node v22.14.0 · pnpm 10.34.7。仅 Chromium。

### 12.6 套件规模与时效（必须说）

- `1807ea1` 的完整运行是 **73/73、exit 0**。
- 之后仓库增加了 Markdown Preview（`34-markdown-preview.mjs`）等场景，`tests/browser/README.md:77-83` 现在的口径是 **78 默认 / 83 remote**。
- 因此："73/73"是**那次**的记录，不是当前总数；权限与 stale 场景的断言未被改动（`git diff 1807ea1..57a9bee -- tests/browser/suite/20* tests/browser/suite/21* tests/browser/suite/08*` 为空）。

### 12.7 状态码口径

- `401`：无/坏 session。Clerk 模式 body `{error:"session_required"}`，demo 模式 `{error:"unauthenticated"}`（`app.ts:682-685`）。
- `404 {error:"not_found"}`：不存在 **或** 无成员 **或** 成员不可读（三者同体）。
- `403 {error:"forbidden"}`：**能读**但缺该能力（例如 `canEdit`/`canManageMembers`）。
- `201 {documentId, title}`：创建成功；**不返回** owner/revision/capability。
- WS：`ROOM_NOT_FOUND`（join 拒绝，与 404 同精神）、`FORBIDDEN`（帧拒绝，非致命）。

### 12.8 本报告明确不适用的量（N/A，不要硬凑）

| 模板项 | 状态 | 原因 |
| --- | --- | --- |
| p95 / 百分位 | **N/A** | 这一条没有任何分布型指标：abort 是"单次事件的时间差"，3 s 是"sleep 后仍未变"的观测。给 p95 会是无意义的伪精确。 |
| cold / warm | **N/A** | 只测"切换窗口内的一次取消"和"一次角色变更后的 3 s"，没有冷/热启动对照。 |
| dev-build 对照 | **N/A（但要说清跑在哪）** | 浏览器套件跑在 **Vite dev 栈**（默认端口 5173 / 服务器 3101），不是 perf 那套 built 路径；所以本报告的数字**不能**与 03 的 "local production build" 数字并列比较。 |
| bundle / 包体 | **N/A** | 与权限/取消无关；包体数字属于 03。 |
| 机器 / Chrome / 文件 | **已有** | 见 §12.5、§11 的每条 `文件/行`、以及 §12.1–12.3 的 raw。 |

---

## 13. 边界与面试答法

### 13.1 真实边界（按"会不会被追问"排序）

| 边界 | 事实 | 一句话 |
| --- | --- | --- |
| **metadata stale = NOT APPLICABLE** | 客户端打开/切换文档**不发** `GET /api/documents/:id`（断言计数 0） | "这一半我没有测，因为请求不存在；我测的是真实存在的目录列表请求" |
| **requestId guard 未压测** | 产品每次所有权变化都 abort，Chrome 不交付被 abort 的响应；要构造需给产品加"不 abort"开关 | "第一道闸（abort）有实测，第二道闸（id）是代码纪律，没有压测" |
| **权限变化不是"请求竞态"** | 权限变化不发请求；是"授权结论可能过期" | "我把措辞改成'授权结论过期'，机制是服务端逐帧重查" |
| **UI 会滞后 3 s** | 没有 role 推送消息 | "事件级最终一致：UI 等下一次 join，服务端立刻拒" |
| **只有两个用户** | 两个独立 browser profile；3+ 未验证 | "并发协作的证据到两个用户为止" |
| **commenter 无 UI** | 服务端层级存在、无评论功能 | "它只是权限层级，不是产品功能" |
| **Clerk 未 live 验证** | M4 已接线，`docs/PROJECT.md:9-10` 明示 | "生产登录没做过 live 验证" |
| **session 是进程内** | 重启后旧 session 失效、页面不自动重 bootstrap（`p2/S`） | "单实例设计的直接后果，不是 bug" |
| **只测 Chromium** | 155 headless | "Firefox/Safari 未验证" |

### 13.2 三档答法要点

- **30 秒**：讲两条——目录请求 abort + 权限四层同判。
- **90 秒**：加"为什么 abort 不够（响应可能已交付）+ requestId 是第二道闸但未压测"，以及"UI 滞后 3 s、服务端不滞后"。
- **3 分钟**：加"404 非泄露、逐帧重查、原子创建、以及我明确没做的（请求推送角色、搜索竞态、commenter UI）"。

---

## 14. 追问 ≥15（附答案）

1. **"旧响应覆盖"具体会坏在哪？** 列表行集变旧、`aria-current` 标错；创建流程会在已离开的 workspace 上切文档；若响应用来设 `activeDocumentId`，会把用户拽回 A。
2. **abort 了为什么还要 requestId？** 响应可能已交付、`.then` 已排队；abort 撤销不了已 resolve 的 Promise。
3. **requestId 压测过吗？** 没有。产品总在所有权变化时 abort，Chrome 不交付；要压测需产品加开关（`DECISIONS.md:3735`）。
4. **为什么切文档不发 metadata 请求？** 切换是 WS `join-room`；`document.metadata` 字段存在但没有 dispatcher（全仓库只有定义）。
5. **那 `metadata` 字段留着不奇怪吗？** 是预留；空着比塞假数据好；`documentSelected` 还会主动清空它。
6. **role 为什么不放 Redux？** 会活过房间、会变成可 dispatch 的权限；seam 的 `null` 语义也无法表达。
7. **UI 显示 editor 但服务端已降级，会怎样？** 下一次击键 `FORBIDDEN`，不落盘、不广播、socket 不关；页面 3 s 内仍显示旧 role（已测）。
8. **为什么不推送角色变更？** 协议里没有该消息；引入它要改 frozen contract，收益不抵（服务端已即时拒绝）。
9. **`FORBIDDEN` 为什么不关 socket？** viewer 的存在意义是读；关掉等于"你不能留"。
10. **404 和 403 怎么分？** 读不到（无成员/不可读/不存在）→ 404；能读但缺能力 → 403。
11. **创建时 owner 怎么保证？** 文档/元数据/owner 成员三行在**一个** `BEGIN IMMEDIATE` 里；第三行失败整体回滚。
12. **为什么成员表和文档同库？** 跨库没有事务；B12.5 要求原子，所以从 `authz.db` 搬进 `insighthub.db`。
13. **WS upgrade 也认证吗？** 是；未认证得到裸 401、不建立 socket；HTTP 与 WS 共用 `resolveAuthenticatedUser`。
14. **吊销后已建立的 socket 会断吗？** 不会立刻；它的写会被拒（每帧重查 role）。这是"请求级吊销"。
15. **伪造 `room-joined` 能提权吗？** 不能。`f1/4` 让 UI 变可编辑，写入仍被服务端拒。
16. **AI 提案跨文档会怎样？** `applySuggestion` 拒绝（`documentId` 不匹配，`malformed`）；面板还以 `session.localClientId` 为 key，换副本即丢弃。
17. **为什么不用 RxJS/TanStack Query？** 依赖面（R3）；这里只有两条异步路径，手写更可控，也更方便用 CDP 做真实断言。
18. **这套东西在 3 个用户/多实例下还成立吗？** 权限判定成立（无状态查表）；房间与 session 是进程内，多实例需要粘性路由或外置房间状态——V1 明确不做。

---

## 15. 决策复盘表

| 决策 | 选择 | 备选 | 结果 | 复盘 |
| --- | --- | --- | --- | --- |
| 取消机制 | AbortController + 单调 id | 只忽略结果 / 时间戳 / 全局拦截器 | **对**：两级闸 + 5 s timeout 可区分 | id 这道闸应补一个"不 abort"测试开关，否则永远只能是 residual |
| role 归属 | 只在 session（seam），不进 Redux | 存 store / 存 context | **对**：房间结束即失效 | 应在 M2 就把"store 无 role"写成测试（现在只有注释 + `f1/3` 间接证明） |
| UI 只读实现 | `Compartment` 重配置 | 重建编辑器 / `pointer-events` / `contenteditable` 手工切换 | **对**：不丢未落盘文字、不重挂载 | 手写 keymap 的 Ctrl+Z 差点漏（D-064 记录的真 bug），这类"手写绑定不继承 facet"应列为 review checklist |
| 授权判定 | 每帧重查 | join 时缓存 | **对**：降级即时生效 | 代价是每帧两次 SQLite 读；在单实例小表下可接受，应记下这个 O(1) 假设 |
| 非泄露 | 三态合一的 404 | 403 说明原因 | **对**：无存在性 oracle | 排障要靠服务端日志绑定 documentId（已有 `bindRequestDocument`） |
| 成员存储 | 与文档同库（推翻 D-061） | 独立 `authz.db` | **对**：可原子 | 文档要写清"为什么推翻"，否则后人会以为是随意改 |
| 认证 | Clerk | 自建密码 | **对**：不造第二套 session | 未 live 验证；demo bootstrap 必须配置层禁用 |
| 部署 | 单实例 + 持久盘 | K8s/多实例 | **对**：V1 范围 | session/房间在进程内是硬约束，重启即有短暂不可用 |

---

## 16. 30 秒 / 90 秒 / 3 分钟

**30 秒**
> 异步这块我做了两道闸：请求带 AbortController，文档切换或面板卸载就取消；再用一个单调 requestId 保证只有当前请求能落地。权限这块一条链：Clerk 或 demo session 解析出内部 userId，查成员关系得到 role，用唯一的能力表算出 canRead/canEdit，HTTP、WebSocket 每一帧、UI 三处各自重查。前端只读只是体验，服务端才是边界——我测过伪造 role 把 UI 变成可编辑，写入仍然被 FORBIDDEN。

**90 秒**
> 先说竞态。这个客户端打开/切换文档其实不发 metadata 请求，切换是 WebSocket join-room，所以"metadata 旧响应"这一半是 NOT APPLICABLE。真实可取消的路径是 AI 目录的 `GET /api/documents`：我用 CDP 在响应阶段扣住一个真实的 200，在窗口里真实切到 B，页面自己的请求日志在 69 毫秒后出现 AbortError，远早于 5 秒超时；再强行放行，浏览器直接拒绝投递（Invalid InterceptionId），UI、编辑器、目录都守在 B。
> 为什么 abort 不够？因为响应可能已经交付、then 已经排队。所以还有第二道闸：monotonic requestId，回调第一行同时检查 signal.aborted 和 id 是否当前。这一道我没有压测，因为没有产品改动构造不出"旧响应真的到达"，我把它当 residual 说。
> 权限这块：Clerk 验证 → 内部 userId → membership 行 → role → 四能力 → HTTP/WS/UI。服务端每一帧重查，所以降级后下一次击键立刻被拒、不落盘不广播；但 UI 会滞后到下一次 join，实测 3 秒。UI 只读是 Compartment 重配置，不重建编辑器。

**3 分钟**（在 90 秒上加四段）
1. **非泄露**：404 三态合一、逐字节比较 body/header；WS join 也用 `ROOM_NOT_FOUND`。
2. **原子创建**：文档+元数据+owner 成员一个 `BEGIN IMMEDIATE`；这也是成员表从独立库搬进主库的原因。
3. **吊销**：`DELETE /api/session` 后 HTTP 与 WS upgrade 都 401；已建立 socket 不主动断，但写会被拒——"请求级吊销"。
4. **边界**：requestId 未压测、metadata NOT APPLICABLE、只在两个用户上验证、commenter 无 UI、Clerk 未 live 验证、只有 Chromium。

---

## 17. ASCII：一次"旧响应回来"的全过程

```
时刻(页面时钟)
  725 ── AiDirectory.load()
          abortRef.abort()            ← 取消上一次
          new AbortController()
          requestId = n+1
          setState(loading)
          fetch GET /api/documents ────────────────┐
                                                    │  CDP Fetch 在 Response 阶段扣住
  764 ── 用户 Enter 切到 B                          │  （真实 200，body 4640B / 28 ids）
          dispatch(documentSelected('B'))           │
          AppShell key 变化 → 旧 workspace 卸载      │
          AiDirectory cleanup:                      │
             requestRef = n+2                       │
             abortRef.abort()  ─────────────────────┼──▶ 传输层 abort
             flow.abort()                           │
  794 ── 页面请求日志：{status:null, error:'AbortError'}   ← 请求后 69 ms
  907 ── B 的 join-room / room-joined(B) 完成
          B 的正文渲染、目录已卸载
  之后 ─ Fetch.fulfillRequest 强行放行
          → Chrome: Invalid InterceptionId（拒绝交付）
          → 即使交付：then 第一行
                signal.aborted || id !== requestRef.current  ⇒ return
          → active-document=B、editor=B、无陈旧行、0 page error
```

```
权限判定（每一帧都走一遍，且不缓存）
  frame ─▶ #authorizeFrame
             ├─ awareness / SyncStep1 ──▶ authz.can(canRead)
             └─ SyncStep2 / Update   ──▶ authz.can(canEdit)
                        │
                        ├─ 允许 ─▶ apply ─▶ persist ─▶ broadcast
                        └─ 拒绝 ─▶ FORBIDDEN（非致命，socket 不关，状态不改）
```

---

## 18. 记忆点（8 条）

1. **两道闸**：`AbortController`（传输）+ 单调 `requestId`（所有权）；第一道有实测 69–78 ms，第二道未压测——**自己先说**。
2. **metadata stale 是 `NOT APPLICABLE`**：客户端根本不发那个请求（计数 0）；真实路径是目录列表。
3. **abort 不够的机制**：响应可能已交付、Promise 已 resolve；abort 撤销不了已排队的微任务。
4. **一条链、四层执行**：Clerk/demo → 内部 userId → membership → role → 四能力 → HTTP / WS join / WS 每帧 / UI。
5. **404 非泄露、403 只在"已能读"之后**；WS 用 `ROOM_NOT_FOUND` 表达同一种含混。
6. **UI 滞后、服务端不滞后**：降级后下一次击键即被拒，UI 要等下一次 `room-joined`（实测 3 s）。
7. **原子创建**：文档 + 元数据 + owner 成员，一个 `BEGIN IMMEDIATE`；这也是成员表搬家的唯一理由。
8. **诚实的空缺**：requestId 未压测、只有两个用户、commenter 无 UI、Clerk 未 live 验证、只有 Chromium、没有搜索所以没有搜索竞态。
