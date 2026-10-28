# 01 · 业务场景与整体架构（InsightHub V1 深度复盘）

| 项 | 值 |
| --- | --- |
| Evidence commit | `57a9bee5f2f8d6ff30f2a8373b61328546475183` |
| Branch | `agent/interview-project-deep-dive`（基于上述 commit 新建） |
| 报告性质 | docs-only。未改代码、测试、`package.json`；未跑新的测试/性能进程 |
| 源码核对方式 | 逐文件阅读 + `Select-String` 取行号；所有 permalink 固定到 evidence commit |
| 本报告对应的简历句 | B1「业务场景：面向团队知识共享，构建支持文档协同编辑、阅读与 AI 辅助修改的知识工作台。」 |

> 事实口径（先写在这里，后文不再重复解释）：React **19**；AI **无流式**（一次性 proposal）；正文 update **无批量合并**（只有 awareness 有 50 ms 合并窗口）；`ClerkRoot` 是 lazy chunk，但**权限判定在主包**；协同证据只有**两个用户**；100k 的 P95 是**本地 production build**；**没有优化前后对比**。

---

## 1. 简历原句

逐字引用：

> 业务场景：面向团队知识共享，构建支持文档协同编辑、阅读与 AI 辅助修改的知识工作台。

拆成可反驳的技术/产品 claim：

| # | Claim | 可验证含义 | 证据落点 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | **面向团队知识共享** | 存在"团队 + 文档 + 成员身份"这一组概念，而不是单机笔记 | `docs/PROJECT.md:5-13`；`apps/server/src/authz/**`；`document_meta.owner_id` | VERIFIED（概念与数据模型）；团队规模 > 2 NOT VERIFIED |
| C2 | **知识工作台** | 有一个统一的入口外壳：文档切换、正文、协作者、身份、AI 面板在同一页面 | `AppShell.tsx:32-71`；`DocumentWorkspace.tsx:206-301` | VERIFIED，但 V1 只有"单文档工作台"，无 wiki/搜索/目录树 |
| C3 | **文档协同编辑** | 两人并发编辑同一文档，不出现冲突对话框，最终收敛 | `08-evidence-gate.mjs:251`（两个独立 context，A=B=server） | VERIFIED（恰好两个用户） |
| C4 | **阅读** | 不编辑也能打开并读到最新正文；只读角色有明确 UI 与解释 | `DocumentWorkspace.tsx:235`（`ReadOnlyNotice`）；`preview/1` | VERIFIED |
| C5 | **AI 辅助修改** | AI 产出 proposal → diff → 人工 Accept 后才进正文，且走 Yjs transaction | `AiSuggestPanel.tsx:150-260`；`apply.ts:92-133` | VERIFIED（管线）；外部大模型 live 调用 NOT VERIFIED |
| C6 | **"构建"** | 不是 PPT 规划：可运行、可测试、可构建 | `pnpm build` 输入齐全；`render.yaml` | VERIFIED（本地）；production-ready NOT VERIFIED |

一句话结论：这句话是**范围声明**，不是能力指标。最容易被追问穿的是"知识工作台"和"团队"两个词——V1 的工作台只有一个文档画布，团队证据是两个成员。

---

## 2. 业务问题

不从技术开始。一个 2–10 人的团队把文档当共享知识载体时，会真实遇到下面六类失效；InsightHub 的每条设计都对应其中一条。

**P1 同一段落被两个人同时改，后写覆盖前写。**
两个人同时补一段"发布流程"，A 补了第 3 步，B 同时删了第 5 步。如果用"整篇保存"或 LWW，谁后点保存谁赢，另一个人的工作静默消失。业务上这是**数据丢失**，不是体验问题。→ 需要合并语义，而不是保存语义（C3）。

**P2 断网/弱网时正在写的句子丢了。**
会议室 Wi-Fi 掉线 2 秒、地铁进隧道、VPN 重连——用户不会因此停止打字。如果编辑器把"能写"绑定在"连着服务器"上，用户要么被禁止输入，要么输入后失败且没有提示。→ 需要"本地先成立、网络后追平"（C3/C4）。

**P3 刷新/关页后草稿没了。**
用户以为浏览器会自动保存。只要正文只存在内存或 React state，F5 就是一次不可恢复的丢失。→ 需要本地持久化副本（C3/C4）。

**P4 AI 直接改文档，人来不及拦。**
"AI 辅助修改"如果实现成"模型输出直接写正文"，用户看到的是文档已经变了、不知道改了哪、也没法只接受一半。对知识库这是**信任崩塌**：一次错误的自动改写会让团队不再敢用。→ 需要 proposal + diff + Accept（C5）。

**P5 非成员拿到 URL 就能读。**
知识库里常有薪酬、合同、事故复盘。前端隐藏按钮不构成边界，URL 猜测和直接调 API 都能绕过。→ 需要服务端裁决的读/写权限（C1）。

**P6 快速切换文档，A 的内容显示在 B 里。**
左侧列表点两下，第二次点击的响应先到、第一次后到，页面就会把 A 的正文画在 B 的标题下。用户可能据此编辑错文档。→ 需要"一个 socket 一个房间"和会话生命周期绑定（C2/C3）。

**业务闭环（V1 的七条流，`docs/PROJECT.md:17-41`）**：写 → 协同 → 断网存活 → 让 AI 提议 → 审阅 → 权限内 → 安全切换。这七条就是本报告后续架构的验收面。

**明确不解决的业务问题（V1 non-goals，`docs/PROJECT.md:66-79`）**：企业 SSO/SCIM、组织层级、计费配额、微服务、K8s、Redis/Kafka、多区域、音视频、评论/@提及、WYSIWYG。这些不是"以后再说"的模糊项，而是写进 `PROJECT.md` 的禁令。

---

## 3. 完整实现流程

下面按**真实调用链**走一遍主路径（demo 身份模式，默认套件跑的就是它）。每步写清：输入 → 输出 / 负责层 / 状态归属 / 同步还是异步 / 失败处理。

### 3.1 启动与身份（E1–E4）

**E1 挂载**
- 输入：`index.html#root`；`main.tsx:11-14` 取容器。
- 输出：`createRoot(container).render(<StrictMode><Provider store={store}><App/></Provider></StrictMode>)`（`main.tsx:16-21`）。
- 负责层：web 入口。状态归属：Redux store 是模块级单例（`store/index.ts`）。
- 同步。失败处理：容器缺失直接 `throw`（`main.tsx:12-14`），不静默白屏。

**E2 模式判定**
- 输入：`VITE_CLERK_PUBLISHABLE_KEY`。
- 输出：`demo` 或 `clerk` 两个 root 之一（`App.tsx:81-97`）；判定函数是 `currentAppMode()`（`session/clerkMode.ts`）。
- 负责层：web 组合根。状态归属：无状态（每次渲染重算，纯函数）。
- 同步。失败处理：无 key 即 demo，不会"半配置"。

**E3a demo 身份**
- 输入：浏览器 cookie（可能没有）。
- 输出：`POST /api/session/bootstrap` → 服务端 `Set-Cookie: insighthub_session`（httpOnly）→ `{ userId, displayName }`（`app.ts:445-467`；`useServerSession.ts`）。
- 负责层：web `session/` + server `authz/`。状态归属：身份只在 hook 内，**不进 Redux**；token 只在 httpOnly cookie，JS 读不到。
- 异步。失败处理：`pending` 被当成 `unavailable` 处理——页面用本地占位身份继续渲染（`App.tsx:104-114`、`147-162`），编辑器不等网络（R10）。

**E3b Clerk 身份**
- 输入：Clerk session cookie。
- 输出：`lazy(() => import('./session/ClerkRoot.js'))`（`App.tsx:76-79`）→ `ClerkProvider` → `AuthGate` → `GET /api/session` 映射到内部 `app_user.id`。
- 负责层：web `session/ClerkRoot.tsx`、`AuthGate.tsx`；server `authz/clerk-session-verifier.ts`。
- 异步。失败处理：未登录显示 sign-in；demo build 永远不下载 Clerk SDK。

**E4 外壳与文档指针**
- 输入：`activeDocumentId`、`pendingDocumentId`（Redux）。
- 输出：topbar（brand · document switcher · identity）+ `<DocumentWorkspace key={activeDocumentId} …/>`（`AppShell.tsx:37-70`）。
- 负责层：web 布局层。状态归属：Redux `document` slice 只放 `activeDocumentId / metadata / pendingDocumentId`（`documentSlice.ts:28-43`），**没有正文字段**。
- 同步（dispatch）。失败处理：空输入不切换（`documentSlice.ts:57-60`）。

### 3.2 会话创建（E5–E7）——"本地先成立"

**E5 hook 调用**
- 输入：`documentId`、`user`（presence 身份）。
- 输出：`useCollaborativeDocument` 的判别联合 `initializing | active | failed`（`public.ts:63-121`）。
- 负责层：A1 的冻结 seam（`collab/public.ts`），编辑器**只能**从这里进。状态归属：hook 的 `useState` 只存 union，不存正文。
- 异步（effect 内 promise）。失败处理：`failed` 分支显示真实原因，仍不伪造编辑器（`DocumentWorkspace.tsx:120-126`、`143-158`）。

**E6 工厂**
- 输入：`CollaborativeSessionOptions`。
- 输出：`createDocumentSession(options)`（`document-session.ts:460-565`）。
- 负责层：`collab/internal/**`（A1 私有）。状态归属：session 对象持有 `doc/text/awareness/undo/persistence`。
- 异步（返回 Promise）。失败处理：空 `documentId`、空用户 id/name 直接 reject（`document-session.ts:464-472`）。

**E7 单源与本地副本**
- 输入：无（新建）。
- 输出：`new Y.Doc()` → `doc.getText('content')`（`document-session.ts:474-475`）→ 挂 `y-indexeddb`（`485-503`）→ `await persistence.whenSynced`（`550`）→ 发布本地 awareness（`557`）→ `markActive()`（`559`）→ 才 `startNetwork()`（`561-563`）。
- 负责层：A1 + `persistence.ts`。状态归属：正文只在 `Y.Text`；IndexedDB 存的是**编码后的 Yjs update**，不是 Markdown 字符串（`persistence.ts:3-21`）。
- 顺序是强制的异步序列：本地 load 完成前不碰网络。失败处理：IndexedDB 不可用 → reject，宁可打不开也不"内存模式静默降级"（`persistence.ts:334-342`）；`destroy()` 在 load 期间发生 → 不再启动网络（`document-session.ts:552-554`）。

### 3.3 编辑器挂载（E8）

- 输入：`session.text`。
- 输出：`EditorState.create({ doc: session.text.toString(), … })` → `new EditorView({ state, parent: host })`（`CollaborativeMarkdownEditor.tsx:245-274`）。
- 负责层：A2（编辑器层）。状态归属：`EditorView` 是**视图**，正文权威仍是 `Y.Text`；组件没有 `value` prop、没有 `useState(text)`。
- 同步（effect 内构造）。失败处理：`host === null` 直接返回；teardown 顺序是 flush → unobserve → destroy（`309-321`）。
- 顺序细节：**先建 binding（observer）再建 view**（`219-229` 在 `245-274` 之前），否则构造期间到达的远端更新会丢失（文件头 `26-32` 行有解释）。

### 3.4 一次敲键（E9–E12）

**E9 编辑器 → Y.Text**
- 输入：CodeMirror 的一次 update 里的 changes（可能是 IME/多光标/粘贴的多个 change）。
- 输出：`onLocalChanges` → `deliverLocalChanges(readOnly, binding, changes)`（`editorEditability.ts:105-121`）→ `binding.handleLocalChanges` → `writeLocalChanges`：一次 `session.transact`，把 changes 合并后**从后往前**应用（`collabTextBinding.ts:176-202`）。
- 负责层：A2 binding + A1 session。状态归属：写入 `Y.Text`，origin = `insighthub:local`。
- 同步：返回时已经在 `Y.Text` 里，没有队列/防抖（`collabTextBinding.ts:72-86`）。失败处理：只读角色在 `deliverLocalChanges` 被挡下并 `resync`（`112-117`）；这层是"第二道防线"，第一道是 CodeMirror 的 `EditorState.readOnly` + `EditorView.editable`（`editorEditability.ts:59-61`）。

**E10 Y.Doc → 二进制帧**
- 输入：`Y.Doc` 的 `update` 事件（update bytes, origin）。
- 输出：`SyncProvider.handleDocumentUpdate` → 跳过 `!joined` 与 `remote` origin → `encodeSyncUpdate(update)` → `sendSyncFrame` → `socket.send(Uint8Array)`（`sync-provider.ts:446-453`、`489-499`）。
- 负责层：A1 网络层。状态归属：无（帧是瞬时值）。
- 同步（send 本身同步调用，网络异步）。失败处理：未 join 或 socket 非 OPEN 时丢弃并计数（`framesBeforeJoin`），不抛错（`sync-provider.ts:489-499`）。

**E11 服务端：apply → persist → broadcast**
- 输入：二进制帧。
- 输出：`ws.on('message', isBinary)`（`ws.ts:587-609`）→ `registry.handleBinaryFrame`（`registry.ts:543-616`）：先 `decodeBinaryFrame`，再确认有房间，再过 authz，再过生命周期门，最后 `#dispatchDecodedFrame`。
  - `SyncStep1` → 只读，`room.replyToSyncStep1`（`room.ts:399-423`）。
  - `SyncStep2/Update` → `#submitMutation`（`registry.ts:814-860`）：`room.applySyncPayload`（`room.ts:440-448`，`Y.applyUpdate(..., remote)`）→ `await store.append(documentId, update)` → `room.broadcastUpdate(update, author)`。
- 负责层：server 传输层（ws.ts）+ 注册表（registry）+ 房间（room）+ 存储（sqlite-store）。状态归属：server 端的 `DocumentRoom.doc` 是**中继副本**；durable 权威是 SQLite 的 snapshot+log。
- 异步（`handleBinaryFrame` 返回 Promise，因为 persist 要 await；每文档一条 FIFO 队列保证顺序）。失败处理：apply 失败 → 房间 `UNHEALTHY`，向所有参与者发 `INTERNAL_ERROR` 并 `1011` 关闭（`registry.ts:959-985`），**绝不广播一个持久化不了的状态**（D-044）。

**E12 对端应用远端更新**
- 输入：二进制帧。
- 输出：`handleMessage` 分发 → `handleBinaryMessage` → `decodeBinaryFrame` → `kind==='sync'` → `readSyncPayload` → `readSyncMessage(decoder, encoder, doc, REMOTE_ORIGIN)`（`sync-provider.ts:428-444`）。
- 负责层：A1 网络层。状态归属：`Y.Text`（origin = `insighthub:remote`）。
- 同步（解析与 apply 同步；有回包则再发一帧）。失败处理：解析异常只计数 `invalidFrames`，不 crash（`sync-provider.ts:431-436`）。

**E12' 渲染远端更新**
- 输入：`Y.Text` 的 `observe` 事件。
- 输出：observer 先看 origin（本地写直接 return）、再看重入计数，最后 `reconcileFromText()`：`text.toString()` 与 `surface.getText()` 比较，算出**一个**最小单区间变更，用 `REMOTE_SYNC_ORIGIN` 应用（`collabTextBinding.ts:153-164`、`238-259`）。
- 负责层：A2 binding。状态归属：CodeMirror state（视图），不写回 Redux。
- 同步。失败处理：`hasNonStringContent` 时整篇重设并回调 `onResync`（`247-251`）。

### 3.5 AI 与拆解（E13–E14）

**E13 AI 路径**
- 输入：用户指令 + 选区（`selectionReader` 读实时 `EditorState`）。
- 输出：`AiSuggestPanel` 生成 proposal（`AiSuggestPanel.tsx:150-260`）→ 渲染 diff → 用户 Accept → `applySuggestion` 在**一个** `TRANSACTION_ORIGINS.ai` transaction 里写 `Y.Text`（`apply.ts:92-133`）。
- 负责层：A4（AI）+ A2（面板）。状态归属：proposal 属于面板 React state，**不是**文档状态；正文只在 `Y.Text`。
- 异步（生成是请求/Provider 调用；Accept 是同步事务）。失败处理：`not-configured` 显示 503 语义错误、不产生 proposal（`m3r/2`）；面板关闭即卸载并 abort 在途生成（`DocumentWorkspace.tsx:268-277` 注释）。

**E14 切换/销毁**
- 输入：`dispatch(documentActions.documentSelected(next))`。
- 输出：Redux 换 `activeDocumentId` → `AppShell` 的 `key` 变化 → 旧 `DocumentWorkspace` 卸载 → effect cleanup → `session.destroy()`：移除 awareness 并广播、destroy sync、dispose awareness、destroy undo、`doc.off(...)`、destroy persistence（`document-session.ts:306-329`）→ 新 workspace 挂载、新 session。
- 负责层：React 生命周期 + A1。状态归属：旧 session 全部释放；新 session 从 IndexedDB 重新 hydrate。
- 同步（React 提交）+ 异步（persistence.destroy 是 Promise，故意不 await）。失败处理：`destroy()` 幂等；`disposed` 标志防止"加载完才发现已卸载"的泄漏（`public.ts:95-117`）。

---

## 4. 源码定位

所有链接固定到 `57a9bee5f2f8d6ff30f2a8373b61328546475183`。

| # | 位置 | Symbol | 职责 | Permalink |
| --- | --- | --- | --- | --- |
| 1 | `apps/web/src/main.tsx:16-21` | `createRoot`, `Provider` | 把 React 挂到 `#root`，Redux store 从这里进入组件树 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/main.tsx#L16-L21 |
| 2 | `apps/web/src/App.tsx:76-79` | `ClerkRoot`（`lazy`） | 只有配置了 publishable key 才下载 Clerk SDK | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/App.tsx#L76-L79 |
| 3 | `apps/web/src/App.tsx:81-97` | `App` | 唯一一次模式判定，切换的是 **root** 而不是外壳 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/App.tsx#L81-L97 |
| 4 | `apps/web/src/App.tsx:104-114` | `DemoApp` | demo 身份 + 外壳；身份失败不阻塞编辑器 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/App.tsx#L104-L114 |
| 5 | `apps/web/src/AppShell.tsx:32-71` | `AppShell` | 两种身份模式共用的 topbar + 工作区 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/AppShell.tsx#L32-L71 |
| 6 | `apps/web/src/AppShell.tsx:68` | `key={activeDocumentId}` | 换文档 = 销毁旧 session 再建新的（一 socket 一房间） | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/AppShell.tsx#L68 |
| 7 | `apps/web/src/features/editor/DocumentWorkspace.tsx:112-126` | `DocumentWorkspace` | 判别联合三分支；只有 active 分支有 `Y.Text` | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/DocumentWorkspace.tsx#L112-L126 |
| 8 | `apps/web/src/features/editor/DocumentWorkspace.tsx:279-300` | `DocumentCanvas` | 同一 `EditorView` 在编辑/预览间切换，不重挂载 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/DocumentWorkspace.tsx#L279-L300 |
| 9 | `apps/web/src/collab/public.ts:63-121` | `useCollaborativeDocument` | 冻结 seam 的 React 入口；换 `documentId` 就销毁重建 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/public.ts#L63-L121 |
| 10 | `apps/web/src/collab/internal/document-session.ts:460-565` | `createDocumentSession` | 单 `Y.Doc`、先本地后网络、构造 UndoManager/Awareness | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L460-L565 |
| 11 | `apps/server/src/app.ts:270-288` | `createApp` | HTTP 组合根：config/authz/AI/identity 全部注入 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/app.ts#L270-L288 |
| 12 | `apps/server/src/app.ts:429-503` | `mountAuthorizationRoutes` | session bootstrap / GET / DELETE 的冻结状态映射 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/app.ts#L429-L503 |
| 13 | `apps/server/src/app.ts:594` | `GET /api/documents/:id` | 生产读路径，走 `canRead` 的同一个决策核 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/app.ts#L594 |
| 14 | `apps/server/src/ws.ts:160-215` | `attachWebSocketServer` | 传输层组合根：`noServer` + 显式 upgrade 处理 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/ws.ts#L160-L215 |
| 15 | `apps/server/src/ws.ts:305-388` | `handleUpgrade` | 先 Origin 再身份，拒绝时**不建立 socket** | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/ws.ts#L305-L388 |
| 16 | `apps/server/src/persistence/schema.ts:417-483` | `createSchemaObjects` | 五张表：document / document_update / document_meta / app_user / membership | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/persistence/schema.ts#L417-L483 |
| 17 | `packages/shared/src/collab-session.ts:298-396` | `CollaborativeSession` | A1↔A2 冻结接口：正文/awareness/role/undo/connect 的全部形状 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/packages/shared/src/collab-session.ts#L298-L396 |
| 18 | `render.yaml:14-88` | — | 单 Render Web Service + 单盘 + 同源构建的部署事实 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/render.yaml#L14-L88 |

补充（架构约束的文档锚点，不是代码）：`docs/PROJECT.md:66-79`（non-goals）、`docs/ARCHITECTURE.md:5-42`（单源规则）、`docs/ARCHITECTURE.md:101-129`（启动顺序）。

---

## 5. 状态归属表

| State | Owner | 持久化 | 是否 Redux | 生命周期 | 为什么 |
| --- | --- | --- | --- | --- | --- |
| 文档正文 | `Y.Doc` / `Y.Text('content')` | IndexedDB（Yjs update 编码）+ 服务端 SQLite（snapshot+log） | **否** | 与 session 同生命周期；换文档即换实例 | 唯一权威；放进 Redux 会每键重渲染并产生第二份真相（R11 / `ARCHITECTURE.md:5-42`） |
| `activeDocumentId` | Redux `document` slice | 否 | 是 | 进程生命周期 | 纯展示指针；它变化触发 workspace remount（`documentSlice.ts:28-35`） |
| `pendingDocumentId` | Redux `document` slice | 否 | 是 | 输入框生命周期 | 切文档前的草稿输入，属于 UI（`AppShell.tsx:52-60`） |
| `metadata` | Redux `document` slice | 否（服务端才是权威） | 是 | 当前文档 | 渲染用元数据；换文档时清空，避免旧元数据（`documentSlice.ts:61-65`） |
| 角色 / capability | `DocumentSession.roomRole` → `getRole()` | **否** | **否** | 房间生命周期；room 结束变 `null` | 服务端裁决；镜像到 Redux 会在"unknown"时给出错误猜测（`document-session.ts:259-266`、`capabilityGate.ts:53-81`） |
| 连接状态 | `SyncProvider` → `DocumentSession.networkStatus` | 否 | 否 | socket 生命周期 | 高频、瞬时；只驱动 badge（`document-session.ts:364-368`） |
| 协作者 presence | `y-protocols` `Awareness`（room 内） | **否**（明确不持久化） | 否 | 房间生命周期 + 30 s 过期 | 存在性数据，持久化会导致"幽灵协作者"（`room.ts:192`、`awareness.ts:24-36`） |
| `EditorView` / `EditorState` | `CollaborativeMarkdownEditor` 的 `useRef` | 否 | 否 | 每 session 一次；预览切换不销毁 | 视图，不是真相；重建会丢 undo/滚动/选区 |
| AI proposal + phase | `AiSuggestPanel` `useState` | 否 | 否 | 面板挂载期间 | proposal 是"待审对象"，不是文档状态（R8） |
| `aiOpen` / `mode` | `DocumentWorkspace` `useState` | 否 | 否 | workspace 生命周期 | 纯 UI；换文档重置（`DocumentWorkspace.tsx:193-198`） |
| 本地副本 | `IndexedDB`（`insighthub-doc:<id>`） | 是（浏览器） | 否 | 跨刷新/跨标签，按文档隔离 | 离线/刷新的唯一依靠（`persistence.ts:76-82`） |
| 服务端房间文档 | `DocumentRoom.doc` | 否（内存中继） | 否 | 房间从创建到驱逐 | 转发用副本，不是第二权威（`room.ts:5-20`） |
| 持久化文档 | SQLite `document` + `document_update` | 是 | 否 | 永久 | 崩溃/重启后的唯一恢复源（`schema.ts:417-436`） |
| demo session token | 浏览器 httpOnly cookie | 是（cookie） | 否 | TTL `SESSION_TTL_MS` | JS 不可读，避免 XSS 直接偷 token（`app.ts:815-829`） |
| Clerk session | Clerk 自己的 cookie | 由 Clerk 管 | 否 | Clerk 管 | 不自建第二套 session（D-082 D1） |

**读法**：这张表就是"为什么 Redux 不装正文"的完整答案——Redux 里 4 个字段全是展示用；任何高频/大体积/需权威裁决的东西都不在里面。100k 基准下 Redux state 实测 **241 B**（keys: `connection`/`document`/`realtime`，`tests/perf/results/perf-production-multiround.json` → `aggregate.redux`）。

---

## 6. 技术选型（重点）

> 先声明证据边界：这套栈在 `docs/PROJECT.md:81-105` 是**固定栈**，仓库里没有 Monaco/ProseMirror/Postgres 的对比实验记录。因此下表的"放弃原因"是**设计理由与约束**，不是实测结论；能引到决策记录的我会标 D-编号。

| 选择 | 需求 | 候选 | 当前 | 为什么 | 放弃的候选与原因 | 代价 |
| --- | --- | --- | --- | --- | --- | --- |
| 编辑器 | Markdown 纯文本、可绑定外部文档、可控扩展 | textarea / contenteditable / Monaco / CodeMirror 6 | **CodeMirror 6**（`@codemirror/view`、`lang-markdown`） | 状态模型是 immutable `EditorState` + transaction，能把"编辑器变更"精确转成 Yjs 操作；扩展按需组合；初始化与包体成本低于 IDE 级编辑器（未做基准） | textarea：没有语法高亮/装饰/多光标，选区与 IME 行为要自己补；contenteditable：DOM 即状态，远端 reconcile 会打架；Monaco：为 IDE 设计，体积与 worker 模型对"一个 Markdown 画布"过重（**未实现，未做基准**） | 需要自己写 binding、reconcile、remote cursor 扩展（约 4 个模块） |
| 协同算法 | 并发编辑不丢、不弹冲突框、离线可编辑 | LWW / OT / CRDT（Yjs、Automerge） | **Yjs CRDT** | 离线期间本地可自由编辑，重连是 merge 而不是 rebase；`Y.Text` 直接可绑编辑器；`y-protocols` 有官方 wire format | LWW：整段覆盖，正是 P1；OT：需要中心化 transform 与版本号，离线编辑要排队重放，服务端要保存操作历史（**RELATED — NOT IMPLEMENTED**） | CRDT 元数据（client id/tombstone）永久增长；需要 compaction（D-042） |
| 传输 | 增量、双向、低开销、可控房间语义 | HTTP 轮询 / SSE / Socket.IO / 原生 WebSocket + `ws` | **原生 WebSocket（`ws`）+ 自定义 provider** | 需要"一个 socket 一个房间 + join ack + role + 类型化错误"的控制面；原生 WS 让文本帧/二进制帧天然分流 | SSE：单向；轮询：延迟与流量不可接受；Socket.IO：多一层自有协议与降级逻辑，且我们已经有冻结的 envelope（**未引入**） | 重连、心跳、backoff、房间状态机全部自己写（`sync-provider.ts` 698 行） |
| 本地持久化 | 刷新/断网不丢，且不能存第二份 Markdown | localStorage / 自写 IndexedDB / `y-indexeddb` | **`y-indexeddb`** | 直接持久化**编码后的 Yjs update**，恢复时重放即可，天然与 CRDT 一致 | localStorage：同步 API、容量小、只能存字符串（会变成第二真相）；自写 IDB：要自己处理 update 合并与版本 | 需要处理 `lib0` 读全局 `indexedDB` 的问题；注入式工厂要用引用计数租约（`persistence.ts:96-294`） |
| 客户端状态 | 低频展示状态与高频文档分离 | Context / Zustand / Jotai / Redux Toolkit | **Redux Toolkit** | DevTools 可审计；`document` slice 只有 3 个字段，天然适合"只放指针"；团队/面试可读性强 | Context：任何更新重渲染整棵子树；Zustand/Jotai：更轻，但需要另一套约定来禁止"把正文塞进去"；RTK 的 slice 边界本身是文档（**未引入**） | 多一个依赖与样板；真正高频的状态（正文）反而不能放进来 |
| 认证 | 团队身份、Email+Google、不自建密码 | 自建 session / Auth.js / Clerk | **Clerk**（`@clerk/clerk-react` + `@clerk/backend`） | V1 明确不自建 password/Argon2/reset（D-082 D1）；映射链固定为 Clerk→内部 user→membership→role | 自建：密码存储、重置、邮件、风控全是新表面；Auth.js：仍要自己管 user 表与 session 语义（**未引入**） | 外部依赖与费用；demo 模式仍需一套 fixture；Clerk SDK 虽是 lazy chunk，权限判定仍在主包 |
| 数据库 | 单实例、事务、崩溃一致性、零运维 | 内存 / 文件 / SQLite / Postgres | **`node:sqlite`（`DatabaseSync`）** | 内置零依赖；WAL；事务能保证 snapshot 替换 + 日志截断原子（D-041 实测清单） | 内存：M1 的丢数据模式；手写文件：崩溃一致性要自己实现；Postgres：单实例 V1 不需要第二个服务与网络跳（D-082 D2 明确不引入） | `DatabaseSync` 同步阻塞事件循环，snapshot 必须移出热路径（D-041 代价 2） |
| 部署 | 一个 origin、一张持久盘、可回滚 | K8s / 多服务 / Render 单实例 | **Render Web Service + Persistent Disk**（`render.yaml`） | 同源部署消掉 CORS/跨站 cookie；单进程同时服务 API/WS/静态文件；`/ready` 与 `/health` 分离 | K8s：单实例无 HA，编排是纯成本；前后端分 origin：cookie 与 CORS 复杂度上升（D-082 D2） | 部署/重启有短暂停机；无水平扩展；备份是同盘（异地备份是运维任务） |

**一句话总览**：前端 React 19 + Vite 7 + Redux Toolkit 2 + antd 5 + CodeMirror 6；协同 Yjs 13 + `y-protocols` + `lib0` + `y-indexeddb` + 原生 WebSocket；后端 Express 5 + `ws` + Zod + `node:sqlite` + Clerk backend；共享层 `packages/shared` 是唯一跨边界类型来源。

---

## 7. 关键实现细节

挑 10 个"面试能讲、代码能指"的点。

**D1 正文单源 + 三层防回环。**
`Y.Text` 是唯一正文。编辑器更新有两条方向，必须防止"远端更新被误读成本地输入再写回去"。三层机制：origin 检查（本地写直接 return）、重入计数（`applyingRemote`）、派生变更标记（`REMOTE_SYNC_ORIGIN` symbol）——`collabTextBinding.ts:153-164`、`syncOrigin.ts:1-25`。少任何一层都会出现"undo 只生效一次"或文本重复。

**D2 本地写不排队。**
`handleLocalChanges` 在返回前就把变更写进 `Y.Text`（`collabTextBinding.ts:72-86`、`176-202`）。理由：排队会让"编辑器显示 X"与"文档包含 X"脱钩，而排队中的 offset 描述的是一个远端更新可能已经改过的版本。批量合并只发生在**一次 CodeMirror update 内部的多个 change**（IME/多光标/粘贴），不是跨 update 的时间窗。

**D3 客户端发起 SyncStep1。**
`room-joined` 之后客户端才发 `SyncStep1`（自己的 state vector），服务端回 `SyncStep2 + SyncStep1`，客户端再回 `SyncStep2`（`sync-provider.ts:337-354`、`room.ts:399-423`）。选客户端发起而不是服务端推送：浏览器最清楚"本地 IndexedDB 已 load 完"，服务端要推送就得为每个客户端维护 readiness，并可能把文档推给根本不渲染的人（`ARCHITECTURE.md:124-129`）。

**D4 双平面：TEXT=JSON 控制，BINARY=Yjs 数据。**
`ws` 天然区分 string / binary，不需要带内判别位。二进制帧布局是 `varUint frameType(0=SYNC,1=AWARENESS) + payload`，SYNC payload 完全交给 `y-protocols/sync`（`binary-frame.ts:26-45`、`67-72`）。禁止把 Yjs update base64 进 JSON（R12）：+33% 体积 + 每次按键一次 JSON parse。

**D5 一 socket 一房间，且替换是原子的。**
`SocketContext.activeRoom` 是**单个字段**，类型上就无法表示"两个房间"；`joinRoom` 是**全同步**函数，`#detach` 与 `room.add` 之间没有 `await`，所以"离开 A、加入 B"不会出现中间态（`registry.ts:1-30`、`396-406`）。前端对应的是 `key={activeDocumentId}`（`AppShell.tsx:68`）。

**D6 两阶段 join：成员同步、确认异步。**
hydrate 需要 I/O，但把 `joinRoom` 改成 async 会重新打开中间态 bug。于是成员变更保持同步，只有 `room-joined` 的**发送**被 hydration barrier 挡住（`ws.ts:445-484`、`registry.ts:481-519`）。`room-joined` 本来就是契约里的"数据面之前"门（§4），所以不需要改协议。

**D7 服务端 apply → persist → broadcast。**
先 apply（在每文档 FIFO 队列里）、再 `await store.append`、最后才 broadcast（`registry.ts:814-860`）。持久化失败 → 房间 `UNHEALTHY`、所有参与者收 `INTERNAL_ERROR`、socket `1011` 关闭；**绝不广播一个恢复不了的状态**（D-044）。代价是每条 update 多一次 SQLite 写。

**D8 presence 只有一个通道，且服务端不是参与者。**
`y-protocols` 的 `Awareness` 构造时会装 3 s 心跳并给自己一个空 `{}` 状态；服务端必须清掉 `states/meta/clientID` 并停掉 interval，否则对端会看到一个"没有名字的协作者"（`room.ts:142-165`）。客户端出站 awareness 有 50 ms 合并窗口（`awareness.ts:39`），入站是 schema 校验后的 `getCollaborators()`（R14）。

**D9 本地持久化的"全局工厂"租约。**
`lib0/indexeddb` 是按裸标识符读全局 `indexedDB` 的，所以注入实现只能写全局；但浏览器里 `window.indexedDB` 是**getter-only**，直接赋值会在严格模式下抛错（曾导致所有真实浏览器打不开文档）。修法是 `Object.defineProperty` + **模块级租约栈 + 引用计数**，非 LIFO 销毁也安全（`persistence.ts:96-294`）。生产路径（工厂就是全局）根本不写属性。

**D10 角色 `null` = unknown，而不是默认值。**
`getRole()` 只在 `state==='active' && connectionStatus==='connected' && roomRole!==null` 时返回角色（`document-session.ts:259-266`）；`capabilityGate(null)` 明确 `readOnly:false`（`capabilityGate.ts:53-67`）。猜 `editor` 会给出服务端必拒的控件，猜 `viewer` 会把用户锁在自己的未发送文本外面。服务端在每个执行点重新裁决，所以 `null` 只损失诚实度、不损失安全性。

---

## 8. 为什么不用 X

每条只写**本项目**的真实理由；没有实测的地方明确说"没有对比实验"。

- **Next.js**：本项目是"一个 SPA + 一个同源 API/WS 进程"。正文必须留在客户端 `Y.Text`，SSR/RSC 拿不到也不该拿正文；`COLLAB_SESSION_CONSTRAINTS` 明确写了 "Server-side rendering must not call this"（`collab-session.ts:409-420`）。引入 Next 会多一个 server runtime、多一套构建与路由，而 Express 已经承担了 API/WS/静态托管（`render.yaml` 同源）。`PROJECT.md:103-105` 把它列为明确不采用。
- **NestJS**：服务端只有约 10 条路由（`app.ts:346-408`），复杂度在房间状态机与 SQLite 流水线，不在路由组合。装饰器 + DI 容器不会让 `registry.ts` 的 1100 行变简单，只会再加一层模块系统。故保持 Express 5 + 显式注入（`createApp(config, authz, aiProvider, identity, aiLimits, options)`）。
- **Kubernetes / 容器编排**：V1 明确 single instance / single region / no HA / 可接受短暂停机（D-082 D2）。没有水平扩展，就没有编排要解决的问题；反而多出 probe、资源配额、ingress 与镜像流水线。
- **Redis**：presence 是 Yjs awareness，room-scoped、内存态、随房间销毁；单实例下没有跨进程 fan-out 需求。引入 Redis 等于给 presence 造第二个通道——正是 D-021 删掉的东西。只有当"多实例 + 跨实例广播"成为真实需求时才成立，而那是 non-goal。
- **Postgres**：单进程、单盘、单写者，SQLite 的事务/WAL 已够；`node:sqlite` 零新增依赖（D-041 还实测了 WAL、BLOB、回滚、快照替换）。Postgres 会引入第二个服务、连接串/凭据、迁移工具与网络跳。代价是同步 API 阻塞事件循环，所以 snapshot 压缩被移出热路径。
- **Socket.IO**：我们需要的是"一 socket 一房间 + join ack 带 role + 冻结错误码 + 双平面"。Socket.IO 自带协议、房间与降级，会和已冻结的 envelope（`{type,payload,requestId?,ts}`）重复；`ws` 让 TEXT/BINARY 的分流是免费的。
- **自建认证**：密码存储、重置、邮件、风控、WebSocket upgrade 认证都是新表面；D-082 D1 明确"不自建 password storage / Argon2 / password reset"，只保留 internal user 映射。
- **富文本 / WYSIWYG**：文档模型是 Markdown（`PROJECT.md:79`）。WYSIWYG 会把"正文 = 纯文本"变成"正文 = 结构化文档树"，与 `Y.Text` 单源、diff、AI 的 `expectedText` 校验全部冲突。V1 只做**只读 Markdown 预览**（`preview/*`），不做所见即所得。
- **评论 / 搜索**：`commenter` 只是服务端权限梯级，没有评论对象与 UI；搜索会引入索引与第二个查询面。两者都是 non-goal（`PROJECT.md:78`），且没有任何简历句依赖它们。
- **LangChain / LangGraph**：AI 只有一条 `POST /api/ai/suggest`（draft-only），provider 是窄接口（`ServerAiProvider`）。编排框架会把"一次请求 → 一个 proposal"变成不可审计的链，并且多一堆依赖。
- **多区域 / active-active**：与 single-region 决策直接冲突；CRDT 虽然理论上能跨区合并，但 durable store、备份、会话都没有跨区语义。

---

## 9. Used in this project 知识点

每个知识点给：定义 / 在哪 / 为什么 / 常见追问 / 项目答案。

**K1 单一数据源（Single Source of Truth）**
定义：同一份状态只有一个可写权威，其他都是派生视图。在哪：`ARCHITECTURE.md:5-42`、`documentSlice.ts:1-23`、`collabTextBinding.ts:1-63`。为什么：镜像副本必然漂移，漂移后一方任意获胜，远端编辑被覆盖、undo 不安全。追问："那 React 里显示的文字算不算副本？" 答案：算**瞬时渲染值**，由 `EditorState` 持有，从不作为权威写回；组件没有 `value`/`onChange(text)`。

**K2 CRDT 与 Y.Text**
定义：可交换/可结合的复制数据类型，副本以任意顺序合并都收敛。在哪：`document-session.ts:474-475`（唯一 `Y.Text('content')`）。为什么：离线编辑必须能本地先发生，重连只 merge。追问："Y.Text 和字符串有什么区别？" 答案：字符串没有 client id、时钟、墓碑；`Y.Text` 有，所以能判断"这两个插入是并发的"。

**K3 状态向量（state vector）**
定义：每个 client 已知的最大 clock 映射，用来算"你缺什么"。在哪：`sync-provider.ts:225-227`（发）、`room.ts:407-421`（按对端 vector 算 delta）。为什么：重连传输量与**缺失内容**成正比，不与文档大小成正比（`convergence.test.ts:129` 断言"encode a reconnect delta, not the document"）。追问："state vector 会很大吗？" 答案：与 client 数成正比，几十字节量级；实测 19 B / 3 clients。

**K4 Yjs transaction 与 origin**
定义：一次原子变更集合，带一个 `origin` 标记来源。在哪：`document-session.ts:268-272`、`binary-frame.ts:121-138`。为什么：origin 同时解决 undo 归属、回环抑制、持久化重放识别。追问："origin 是安全边界吗？" 答案：不是。它只是本地标记；服务端权限由 authz 在每个帧上裁决。

**K5 UndoManager 的 trackedOrigins**
定义：只记录指定 origin 的变更，其余不可撤销。在哪：`document-session.ts:534-536`。为什么：本地 undo 绝不能回滚队友的文字（R13）。追问："那 AI 的修改能撤销吗？" 答案：能，`ai` 在 `UNDO_TRACKED_ORIGINS` 里；`remote` 与 `persistence` 不在。

**K6 WebSocket 双平面**
定义：同一连接上按帧类型分流控制面与数据面。在哪：`ws.ts:580-613`、`binary-frame.ts:26-45`。为什么：JSON 适合控制消息且可读；Yjs update 已经是紧凑二进制，base64 会 +33% 并多一次 parse。追问："为什么不全部用 JSON？" 答案：每次按键都要付 base64 与 parse 的成本，而且会把 y-protocols 的官方编码再包一层。

**K7 IndexedDB 作为 CRDT 副本**
定义：浏览器内的持久化 key-value/对象存储。在哪：`persistence.ts:334-377`。为什么：刷新/断网/崩溃后恢复；存 update 而不是字符串，恢复即重放。追问："为什么不存 Markdown？" 答案：Markdown 丢了 client id/时钟/墓碑，用它恢复会把两个从未离线的客户端变成并发写者，已删除内容会复活（D-042）。

**K8 React key 的 remount 语义**
定义：`key` 变化 = 卸载旧实例、挂载新实例（不是更新）。在哪：`AppShell.tsx:68`。为什么：一 socket 一房间；换文档必须销毁旧 session，否则可能同时存在两个房间或把 A 的事件送进 B 的 UI。追问："用 useEffect 清理不行吗？" 答案：也行，但 key 让"生命周期 = 文档身份"成为结构事实，清理顺序不依赖 effect 依赖数组是否写对。

**K9 Zod schema 作为跨边界契约**
定义：运行时校验 + `z.infer` 派生类型。在哪：`packages/shared/src/*.ts`、`parseServerMessage`（`sync-provider.ts:325-329`）。为什么：R1 要求跨边界类型只有一个来源；运行时也要拒绝未知 `type` 而不是忽略（D-003）。追问："校验失败怎么办？" 答案：控制面回 `INVALID_MESSAGE` / `UNKNOWN_MESSAGE_TYPE`，数据面回 `INVALID_BINARY_FRAME`；都不是静默忽略。

**K10 httpOnly cookie + CORS credentials**
定义：JS 不可读的 cookie；跨 origin 请求必须显式凭据与显式 origin。在哪：`app.ts:815-829`、`app.ts:289-293`（拒绝 `*`）。为什么：token 不进 JS 可达空间，XSS 不能直接读；`*` + credentials 是浏览器非法组合，且等于"任何站点可用你的 cookie 调 API"。追问："那 CSRF 呢？" 答案：`security/origin.ts` 在路由前拒绝跨源的状态变更请求。

**K11 SQLite WAL + snapshot/log**
定义：预写日志模式；快照 + 追加日志的持久化表示。在哪：`schema.ts:417-436`、`registry.ts:1046-1088`（驱逐时压缩）。为什么：append 是 O(1) 小写；恢复 = apply snapshot + 顺序 apply 日志；压缩只在驱逐时做，不进热路径。追问："为什么不每次写整篇？" 答案：那会把每次按键变成整篇 I/O，并且丢失 CRDT 元数据。

**K12 同源部署**
定义：页面、API、WebSocket 来自同一个 origin。在哪：`render.yaml`、`static-hosting.ts`、`app.ts:392-399`。为什么：没有跨站 cookie，没有 CORS 预检，cookie 的 `SameSite=Lax` 足够；`/api/**` 永远不会被 SPA fallback 抢走。追问："为什么不做前后端分离？" 答案：分离只增加 cookie/CORS/部署单元，V1 没有独立扩缩容需求（D-082 D2）。

---

## 10. Related but not used

以下全部是 `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED`：本项目**没有**采用，也不要在面试里说成"我们做了"。

- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Operational Transformation（OT）**：ShareDB/ot.js 那类中心化 transform。本项目用 CRDT；仓库里没有 OT 实现。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Monaco Editor**：VS Code 内核。本项目用 CodeMirror 6；没有 Monaco 依赖，也没有包体/性能对比数据。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **ProseMirror / TipTap / Slate**：富文本/结构化编辑。正文模型是 Markdown 纯文本。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Automerge**：另一种 CRDT 库。没有引入，也没有 benchmark。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **y-websocket 客户端库**：本项目自己实现 provider（`sync-provider.ts`），只复用 `y-protocols` 的**编码**与 `y-websocket` 的帧类型约定（D-015）。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Socket.IO**：房间/降级/自定义协议。本项目用原生 `ws` + 自有控制面。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Redis / Redis Pub-Sub**：跨实例广播与 presence 共享。单实例 V1 不需要。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **PostgreSQL / Prisma / Drizzle**：本项目用 `node:sqlite` + 手写 SQL，没有 ORM。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Kubernetes / Docker Compose 编排**：部署是 Render 单服务 + 单盘。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Next.js / Remix / SSR 框架**：本项目是 Vite SPA + Express 同源托管。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **NestJS / tRPC / GraphQL**：服务端是 Express + 冻结 REST/WS 契约。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **LangChain / LangGraph / 向量库**：AI 是单次 draft 请求，无 RAG、无 agent 编排。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Service Worker / Background Sync**：离线靠 IndexedDB + 重连，不靠 SW 后台队列。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **WebRTC / y-webrtc**：P2P 协同；本项目是星型（client ↔ server room）。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **评论、@提及、全文搜索、WYSIWYG**：`commenter` 只是权限梯级；没有评论/搜索对象与 UI。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **生产级可观测性（OTel/Sentry/PerformanceObserver）**：`PerformanceObserver` 只存在于测试仪器（`tests/perf/instrument.mjs`），产品代码里没有。

---

## 11. 测试与验证

口径：下列场景都是**已提交的真实 Chromium（CDP）场景**，串行执行、断言失败即进程非 0、无重试。**本次报告没有重跑**；"raw result" 列是仓库里记录的运行结果，不是我现在跑出来的。

| # | Given / When / Then | test file · scenario | 拓扑 | 注入 | raw result（记录值） |
| --- | --- | --- | --- | --- | --- |
| T1 | **Given** 一个已认证成员 **When** 点"新建文档" **Then** 走真实 `POST /api/documents`（201）并切到服务端 UUID，以 `owner` 身份进入可编辑房间 | `tests/browser/suite/32b-m4-b125.mjs` · `b125/1-create-document-switches` | 真实 Chromium + 真实 Express/WS + 真实 SQLite | 无（真实 HTTP） | 201 + 切换到 UUID + `owner` room + 可编辑（`docs/resume-evidence/01-business-context.md:123` 记录） |
| T2 | **Given** 服务端已有正文 **When** 页面打开该文档 **Then** 编辑器在**已有** `Y.Text` 上挂载，而不是空 buffer 再同步 | `tests/browser/suite/02-editor.mjs` · `editor/mounts-on-existing-ytext` | 同上 | 无 | 编辑器文本 = 预置正文（同上 `:124`） |
| T3 | **Given** 三个 caller 状态（未知文档 / 非成员 / 未认证）**When** 请求文档 **Then** 响应只能靠冻结的 401/404 规则区分，未知与非成员**字节相同** | `tests/browser/suite/20-m2-phase2-authz.mjs` · `p2/3-non-disclosure-404` | 同上 | 无 | 404 body 一致；401 仅在未认证（同上 `:125`） |
| T4 | **Given** 远端 AI provider 未配置 **When** 点 Generate **Then** 503 + 类型化 `not-configured` 错误，**没有** proposal、**没有** Accept、两个 store 都不动 | `tests/browser/suite/33-m3-remote.mjs` · `m3r/2-remote-provider-unconfigured` | 同上；`INSIGHTHUB_E2E_AI_MODE=remote` | 配置缺失（env） | 503 且无 proposal（同上 `:126`；该场景属于 remote 组，默认套件不跑） |
| T5 | **Given** 编辑模式有内容 **When** 切到预览再切回 **Then** 同一个 `EditorView` 保留（不重挂载），滚动与 undo 不丢 | `tests/browser/suite/34-markdown-preview.mjs` · `preview/1-toggle-preserves-editor` | 同上 | 无 | `editorMounts` 不变（场景断言；`preview/*` 是合并后新增的 5 个场景） |
| T6 | **Given** 文档里有 `<script>`、`<img onerror>`、`javascript:` 链接 **When** 渲染预览 **Then** 它们都不成为元素，`on*` 与 `javascript:` 不出现，图片只显示 alt | `tests/browser/suite/34-markdown-preview.mjs` · `preview/3-security` | 同上 | 恶意 Markdown fixture | 断言通过（场景名即断言集） |
| T7 | **Given** 默认套件 **When** 串行跑完 **Then** 全部通过、端口释放、临时数据目录清理、无 live handle | `node tests/browser/run.mjs` | 真实浏览器 + 真实进程 | — | 默认套件 **78 个场景**；合并后记录 **78/78 PASS**（`7585263`，`docs/TASKS.md` / `docs/resume-evidence/README.md` 记录）。远程组另 +5，**未跑** |

**关键边界**：T1–T7 证明"入口链路存在且失败诚实"，不证明市场规模、不证明 production-ready、不证明 3 人以上协同。

---

## 12. 性能数据定义

本句（B1）**不包含性能 claim**。为避免把 B3 的数字错误地挂到业务句上，这里只定义"如果要说性能，每个数字的边界是什么"，以及本报告实际测了什么。

| 指标 | 起点 → 终点 | n | p50 / p95 / max | cold/warm | 环境 | 原始文件 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 编辑器 ready | 页面导航开始 → `.cm-editor` 可用 | 3 | 654 / **680** / 680 ms | **cold**（每次新页面/新进程） | 本地 production build（built server + built web，Express static，无 Vite） | `tests/perf/results/perf-production-multiround.json` → `aggregate.readyMs` | MEASURED（属于 B3，不属于本句） |
| WebSocket 重连（restore→connected） | `setOffline(false)` / 恢复网络 → `connection-status=connected` | 9 | 763 / **770** / 770 ms | **warm**（同页、同 `Y.Doc`，仅 socket 重建；250 ms 断网窗口） | 同上 | 同上 → `aggregate.reconnectRestoreMs` | MEASURED（属于 B3） |
| WebSocket 重连（offline→connected） | 进入 offline 状态 → `connected` | 9 | 1024 / **1033** / 1033 ms | warm | 同上 | 同上 → `aggregate.reconnectOfflineMs` | MEASURED（B3 诊断值，不在简历句里） |
| Redux state 体积 | 300 次真实输入后，从 React fiber 树取 store 并序列化 | 3 runs | 241 B（三次都是） | warm | 同上；keys = `connection`/`document`/`realtime` | 同上 → `aggregate.redux.stateBytes` | MEASURED（B3） |
| "团队知识共享"的业务指标（活跃团队数、留存、协作频次） | — | — | — | — | — | — | **NOT MEASURED**（仓库里没有任何 analytics/用户研究） |
| 入口链路延迟（打开文档到可编辑） | — | — | — | — | — | — | **NOT MEASURED**（没有为该指标单独采集；ready 680 ms 是 100k 大文档场景） |

机器与版本：Windows 11 10.0.26200 x64、i5-1340P（16 逻辑核）、15.7 GiB、Node v22.14.0、Chrome **155.0.8059.85 headless**（`host`/`chrome` 字段来自同一 JSON）。fixture：`tests/perf/fixtures/100k-lines.md`，100000 行、6,788,895 字符、sha256 `0d12688d…`。

必须同时说出的三句话：① 这是**本地 production build**，不是线上；② **cold 只有 ready，重连是 warm**；③ **没有优化前后对比**，dev-server 的差异是"服务路径差异"，不是优化收益。

---

## 13. 边界与 limitation

| # | Limitation | 事实 | 面试怎么答（一句话） |
| --- | --- | --- | --- |
| L1 | 协同只有**两个用户** | 证据是两个独立 browser context / 两个身份（`PROJECT.md:21`）；三人以上 NOT VERIFIED | "我验证的是两个独立 profile 的并发 insert/delete/replace，三方文本与 state-vector 摘要都相等；三人以上我没测，所以简历里写的是双用户。" |
| L2 | 断网窗口只有 **1–2 s** | `chaos/offline-reconnect` sleep 1 s；perf 用 250 ms；30 s 未测 | "我测的是 1–2 秒抖动，不是 30 秒长断网；30 秒会不会有问题我不知道，所以不说 '30 秒不丢'。" |
| L3 | 外部大模型 **live 未跑通** | 默认是确定性指令表；OpenAI 429 / Kimi 400 的记录在 `D-085`；0 次成功 live | "AI 部分是完整管线：proposal→diff→Accept→Yjs transaction；但真实模型调用没有成功记录，默认 provider 是规则表。" |
| L4 | **production-ready NOT VERIFIED** | M3 CLOSED ≠ production ready；B11 持久盘/restart、B8 备份恢复、B14 终审 blocked by payment | "M4 的代码与本地门禁在，但持久盘部署、备份恢复演练、生产终审没做完，所以我不会说 production ready。" |
| L5 | 无 search / comment / WYSIWYG | `commenter` 只是权限梯级；无评论对象/UI/索引 | "评论只是权限模型里的一档，不是功能；搜索和 WYSIWYG 是 non-goal。" |
| L6 | 单实例 / 单区域 / 无 HA | D-082 D2 明确；部署/重启可短暂停机 | "V1 就是单实例单区域；没有水平扩展，也就没有 Redis/K8s 的必要。" |
| L7 | 浏览器只有 Chromium | Chrome 155 headless；Firefox/Safari 无证据 | "浏览器证据只有 Chromium 155 headless，别的内核我没跑。" |
| L8 | demo 身份不是真实认证 | `POST /api/session/bootstrap` 只在 dev/test 挂载（`app.ts:445`；§18.5） | "demo bootstrap 是测试夹具；生产走 Clerk，这个端点在 production 根本不挂载。" |
| L9 | 100k 进预览在浏览器里超时 | 记录：420 s 内未 ready；已写成 limitation，不拿 20k 冒充 100k | "预览在 100k 行文档上没能在 420 秒内 ready，我用 20k 场景证明功能、不用它冒充 100k。" |
| L10 | "知识工作台"只有单文档画布 | 无 wiki/目录树/backlinks/org 层级 | "它是文档工作台，不是企业知识平台；没有 wiki、目录树、组织层级。" |

---

## 14. 高频追问（全部绑定本项目）

**Q1 为什么正文一定要放 `Y.Text`，放 Redux 会怎样？**
放 Redux 会每敲一个字符就触发所有订阅者重渲染（100k 文档下这是灾难），并且产生第二份真相：远端更新到达时你无法判断"store 里的文本"和"CRDT 的文本"谁对。实测证据是 300 次输入后 Redux 只有 241 B、keys 只有 `connection/document/realtime`（`perf-production-multiround.json`）。

**Q2 为什么不用 `useState(text)` + `onChange` 把编辑器包起来？**
因为那正是镜像副本。`CollaborativeMarkdownEditor` 没有 `value` prop、没有 `onChange(value)`；它只在构造时读一次 `session.text.toString()` 来 seed buffer，之后所有变更双向走 binding（`CollaborativeMarkdownEditor.tsx:245-274`）。

**Q3 `key={activeDocumentId}` 不就是一个 React 技巧吗？**
它是"一 socket 一房间"在前端的结构表达。换 key 会**卸载**旧 workspace，effect cleanup 调 `session.destroy()`，旧 socket 与房间一起消失；如果只是改 prop，就可能同时存在两个 session（`AppShell.tsx:68`、`document-session.ts:306-329`）。

**Q4 为什么服务端不是收到就广播？**
因为要保证"客户端看到的状态，服务端一定恢复得出来"。顺序是 apply → persist → broadcast；persist 失败就不广播，并把房间标 `UNHEALTHY`、让所有人 `1011` 断开（`registry.ts:814-860`、`959-985`）。否则重启后文档会回退到客户端已经看过的状态之前。

**Q5 为什么是客户端发 SyncStep1，而不是服务端推？**
浏览器最清楚本地 IndexedDB 何时 load 完；服务端推需要为每个客户端维护 readiness，还可能把文档推给根本不渲染的人。这是"我们选的方向"，不是 Yjs 的定律（`ARCHITECTURE.md:124-129`）。

**Q6 两个平面为什么不用 JSON 全部搞定？**
Yjs update 是紧凑二进制，base64 进 JSON 会 +33% 体积并且每次按键多一次 JSON parse；而控制消息（join/role/error）用 JSON 可读、可校验。`ws` 用 string vs binary 天然分流，不需要带内标记（`binary-frame.ts:8-24`）。

**Q7 你们的房间模型能支持一个用户同时开两个文档吗？**
不能，而且这是刻意的：一个 socket 最多一个房间，第二个 `join-room` 是原子替换（R15）。要同时看两个文档就是两个标签页/两个 session，不是一条连接两个房间（`registry.ts:1-30`）。

**Q8 断网时用户继续打字，写到哪里？**
写到同一个 `Y.Text`；`Y.Text` 的变更同时被 `y-indexeddb` 记录。所以关页/离线重开都还在；重连时 `SyncStep1` 把本地 vector 发上去，服务端只补差量（`document-session.ts:460-565`、`sync-provider.ts:225-227`）。

**Q9 那离线时 AI 还能用吗？**
默认 provider 是本地确定性规则表，可以；远端 provider 需要网络，失败会显示类型化错误而不是伪造 proposal。Accept 永远走本地 Yjs transaction，所以"接受"这个动作本身不依赖网络。

**Q10 权限只在前端判断吗？**
不是。前端 `capabilityGate` 只决定"显示什么控件"，是 advisory；服务端在 join 时看 `canRead`、在每个 BINARY 帧上看 `canEdit`（`registry.ts:716-760`）。前端猜错只会少显示/多显示按钮，不会越权。

**Q11 为什么角色未知时是可编辑，而不是只读？**
因为"未知"不等于"无权限"。断网/重连/首次 join 前都是 `null`；如果这时锁成只读，用户会被锁在自己的未发送文本外面（R10）。所以 `capabilityGate(null).readOnly === false`，而服务端仍然会拒绝真正越权的写。

**Q12 Clerk 是 lazy 的，是不是认证代码就不进主包？**
不是。lazy 的只有 `ClerkRoot`（`App.tsx:76-79`），`capabilityGate`/角色读取被 `DocumentWorkspace` 静态 import，仍在主包。这是有意的：demo 模式也要有权限 UI，不能为了 chunk 把权限判定拆出去。

**Q13 为什么 SQLite 敢用在"协同"这种写多的场景？**
因为写的是**小 Yjs update**（几十到几百字节），而且每文档串行队列 + WAL；真正重的是 snapshot 压缩，被移到房间驱逐时（D-042）。同步 API 阻塞事件循环是已知代价（D-041 代价 2）。

**Q14 为什么不做评论？知识库没有评论很奇怪。**
V1 的范围是"写/协同/离线/审阅 AI/权限/切换"六件事；评论需要新的对象模型（锚点、线程、通知、权限），会把 `commenter` 从权限梯级变成产品面。它是 non-goal，不是遗漏。

**Q15 这套东西换个人维护，最难的地方在哪？**
三处：① binding 的三层防回环（少一层就 undo 失效/文本重复）；② 房间状态机与 hydration barrier（`joinRoom` 必须保持同步）；③ 本地持久化的全局工厂租约（浏览器 getter-only 的坑）。这三处都有"看起来能跑、边界才炸"的特征。

**Q16 如果明天要支持 3 个以上用户，你先改什么？**
先加测试而不是先改代码：把两个独立 context 扩到三个，确认收敛；然后看 presence 上限（`MAX_AWARENESS_CLIENTS_PER_UPDATE`）与 room fan-out 的 O(n) 广播；最后才是容量与背压。当前代码没有"只支持两个"的硬限制，限制在证据。

**Q17 为什么不把 AI 也做成流式？**
V1 的 AI 是"一次 proposal + diff"，用户在 Accept 前不该看到文档变化；流式输出会让"部分建议"进入 UI，反而要处理半截 diff 与取消语义。当前是请求-响应，关闭面板即 abort（R9）。

**Q18 你们怎么证明"没有把正文塞进 Redux"不是嘴上说说？**
两层：静态上 `documentSlice` 的类型里没有正文字段，且文件头写明禁止添加（`documentSlice.ts:1-23`）；动态上 perf 仪器从 React fiber 树取 store 序列化，100k 文档 300 次输入后是 241 B，且不含 fixture marker。

---

## 15. 技术决策复盘

| Problem | Candidates | Selected | Why | Trade-off |
| --- | --- | --- | --- | --- |
| 并发编辑不丢字 | 整篇保存 / LWW / OT / CRDT | Yjs CRDT | 离线可编辑、重连 merge、无需中心化 transform | 元数据增长；需要 compaction |
| 编辑器与 CRDT 的桥 | 受控组件 / 命令式 binding | 命令式 binding（一次/session） | 避免每次 render 重建 observer；精确控制 apply 顺序 | 要自己写 reconcile 与 remote cursor |
| 传输协议 | REST 轮询 / SSE / Socket.IO / 原生 WS | 原生 WS + 自定义 provider | 双平面、join ack、role、冻结错误码 | 重连/心跳/背压全自写 |
| 房间基数 | 一 socket 多房间 / 一 socket 一房间 | 一 socket 一房间 | 二进制帧无歧义路由；切文档=销毁重建 | 不能"同连接预打开下一篇" |
| 服务端持久化 | 内存 / 文件 / SQLite / Postgres | `node:sqlite` snapshot+log | 零依赖、事务、WAL、崩溃一致性 | 同步 I/O；snapshot 必须移出热路径 |
| 本地持久化 | localStorage / 自写 IDB / y-indexeddb | `y-indexeddb` | 存 update 不存字符串，恢复即重放 | 全局工厂注入的租约复杂度 |
| 身份 | 自建 session / Auth.js / Clerk | Clerk | 不自建密码/重置/风控；映射链清晰 | 外部依赖；demo fixture 仍需保留 |
| 部署拓扑 | 分离前后端 / Next 全栈 / 单服务同源 | Render 单服务同源 | cookie/CORS 简单；一个进程三类流量 | 无水平扩展；重启短暂停机 |
| 状态分层 | 全放 Redux / 全放组件 / 按频率分层 | 正文 Y.Text、展示 Redux、会话 getter | 高频与权威分离 | 需要团队理解"哪些状态不能进 store" |
| 权限执行点 | 仅前端 / 仅 HTTP / HTTP+WS 每帧 | HTTP + WS join + WS 每帧 | 服务端是唯一边界；前端只做 advisory | 每帧一次 `can()` 调用（同步、便宜） |

---

## 16. 三版口述

### 30 秒

"InsightHub 是一个团队 Markdown 文档工作台。两个成员能实时协同编辑同一篇文档，断网还能继续写、重开后不丢，AI 的修改只以 diff 形式出现、Accept 之前文档不变。架构上我刻意做小：一个 React SPA、一个 Express + WS 进程、一个 SQLite；正文只在 `Y.Text` 里，Redux 只放文档指针和 UI 状态，权限由服务端算。"

### 90 秒

"这个项目的业务问题是团队共享文档时的六类失效：并发覆盖、断网丢字、刷新丢稿、AI 直接改坏文档、非成员越权读、快速切文档串页。

我的入口链路是 `App` → `AppShell` → `DocumentWorkspace` → 编辑器/AI 面板。身份有两种模式：demo 用服务端 fixture 的 httpOnly cookie，生产用 Clerk；不管哪种，编辑器都不等身份，先本地可用。

正文只有一个源：`Y.Doc` 里的 `Y.Text('content')`。打开文档时先挂 IndexedDB、等本地副本 load 完就 `active`，然后才连 WebSocket。编辑走 CodeMirror 的 update → binding → 一次 Yjs transaction；本地 update 直接编码成二进制帧发服务端；服务端按 apply → persist → broadcast 三步走，持久化失败就不广播。

架构边界我也能说清：单实例单区域，没有 K8s/Redis/Postgres，因为 V1 没有水平扩展需求；SQLite 是 `node:sqlite`，零新增依赖。协同证据是两个独立浏览器上下文，不是三个以上。"

### 3 分钟

"先说业务。团队把文档当共享知识载体时，最疼的不是'编辑体验'，而是四件事：两个人同时改会覆盖、网络抖一下会丢字、刷新一下草稿没了、AI 一动手文档就变了。再加上非成员越权和快速切文档串页，就是 V1 要解的六个问题。

产品上对应七条流：写、协同、断网存活、让 AI 提议、审阅、权限内、安全切换。

实现上分三层。前端 `apps/web` 是 React 19 + Vite + Redux Toolkit + CodeMirror 6；`packages/shared` 放跨边界类型、Zod schema、WS 协议；`apps/server` 是 Express 5 + `ws` + `node:sqlite`。

入口链路是 `main.tsx` → `App`（一次模式判定）→ `AppShell`（topbar + 文档切换 + 身份）→ `DocumentWorkspace`（按 `documentId` 加 key）→ `CollaborativeMarkdownEditor` / `AiSuggestPanel`。

协同的核心是单源：正文只在 `Y.Text`。编辑器是视图，没有 `value` prop，也没有 `useState(text)`。打开文档的顺序是硬性的：建 `Y.Doc` → 挂 IndexedDB → 等 `whenSynced` → 标记 `active`（此时编辑器可用，哪怕没网）→ 才连 WS。

敲一个字符，CodeMirror 的 changes 先经过只读闸门，再由 binding 在一次 Yjs transaction 里写到 `Y.Text`，本地 origin 是 `insighthub:local`。`Y.Doc` 的 update 事件把增量编码成二进制帧，走一条 socket。服务端不是收到就转发：它先 apply，再 `await store.append` 写 SQLite，最后才 broadcast；写失败就把房间标 unhealthy 并让所有人断开——绝不让客户端看到恢复不了的状态。

远端更新到达时，binding 用 origin + 重入计数 + 派生标记三层防回环，然后用"权威文本 vs 编辑器文本"的 diff 做一次最小变更，而不是翻译 Yjs delta。

离线就是 Path 1：IndexedDB 里存的是编码后的 Yjs update，不是 Markdown 字符串。所以关页、离线重开都还在；重连时客户端发 state vector，服务端只补差量。

权限上，角色来自 `room-joined.role`，`null` 表示未知；未知时 UI 保持可编辑，因为未知不等于无权限。前端 gate 只是 advisory，服务端在 join 和每个二进制帧上重新裁决。

边界我也明确：协同证据只有两个用户、断网窗口 1–2 秒、30 秒没测、外部大模型没有成功 live、production-ready 没验证。所以它是一个可演示、可审计的 V1。"

---

## 17. ASCII 白板图（与真实链路一致）

```text
┌──────────────────────────── 浏览器（一个 origin） ────────────────────────────┐
│ main.tsx:16  createRoot + <Provider store>                                    │
│   └─ App.tsx:82  currentAppMode()  ── 无 key ──► DemoApp ──► useServerSession │
│                                    └─ 有 key ──► lazy ClerkRoot → AuthGate     │
│        │                            POST /api/session/bootstrap (demo only)    │
│        ▼                                                                       │
│   AppShell.tsx:32   topbar: brand · document switcher · identity               │
│        └─ key={activeDocumentId}  → 换文档 = 卸载旧 workspace                   │
│             ▼                                                                  │
│   DocumentWorkspace.tsx:112   result.state ∈ {initializing, active, failed}     │
│        ├─ DocumentHeader   status / role / collaborators / undo / AI toggle     │
│        ├─ AiSuggestPanel   (仅 open 时挂载)  proposal + diff + Accept/Reject     │
│        └─ DocumentCanvas                                                       │
│             ├─ CollaborativeMarkdownEditor ── EditorView (视图, 非权威)          │
│             └─ MarkdownPreview (只读, 懒加载 renderer)                          │
│                                  │                                             │
│                    ┌─────────────┴──────────────┐                              │
│                    ▼                            ▼                              │
│            Y.Doc / Y.Text('content')     useCollaborativeDocument              │
│              │            │              (collab/public.ts 冻结 seam)          │
│              │            └──► binding ──► reconcileFromText（远端→视图）       │
│              │                                                                 │
│      Path 1  ▼                         Path 2 ▼                                │
│        IndexedDB                      SyncProvider                             │
│      (y-indexeddb,                    (sync-provider.ts)                       │
│       存 Yjs update)                    │                                      │
└─────────────────────────────────────────┼──────────────────────────────────────┘
                                          │  ws://<origin>/ws
                        TEXT = JSON 控制   │   BINARY = Yjs sync / awareness
                                          ▼
┌──────────────────────────── 服务端（一个 Node 进程） ─────────────────────────┐
│ ws.ts:160 attachWebSocketServer (noServer)                                     │
│   ├─ upgrade: Origin → 身份(401) → 才建立了 socket (ws.ts:305)                  │
│   └─ message: TEXT → handleControlFrame  |  BINARY → registry.handleBinaryFrame │
│                    │                              │                            │
│          join-room │                              ▼                            │
│                    ▼                    RoomRegistry (registry.ts)              │
│            RoomRegistry.joinRoom         ├─ decodeBinaryFrame（shared codec）    │
│            （同步；成员变更）               ├─ authz：canRead / canEdit          │
│                    │                     ├─ 生命周期门：hydrating → backlog      │
│                    ▼                     └─ #dispatchDecodedFrame                │
│            hydration barrier                 ├─ SyncStep1 → replyToSyncStep1     │
│            → 才发 room-joined(role)          └─ SyncStep2/Update → #submitMutation│
│                                                       │                        │
│                                                       ▼                        │
│                                          DocumentRoom (room.ts)                │
│                                           apply → persist → broadcast          │
│                                                       │                        │
│                                                       ▼                        │
│                                    SqliteDocumentStore (snapshot + update log) │
│                                    document / document_update / document_meta  │
│                                    app_user / authz_document_membership        │
└────────────────────────────────────────────────────────────────────────────────┘

AI 路径（同一张图里的另一条线）：
  DocumentHeader → AiSuggestPanel → provider（local 规则表 | remote /api/ai/suggest）
    → proposal + diff → 人工 Accept → applySuggestion（ai origin, 一个 transaction）
    → Y.Text → Path 1 / Path 2
```

图里三个容易讲错的点：① 编辑器不是"受控组件"，`EditorView` 是视图；② `room-joined` 在 hydration 之后才发，不是 join 成功就发；③ 服务端广播发生在 `store.append` **之后**。

---

## 18. 记忆点

1. **一句话架构**：一个 SPA + 一个同源 Express/WS 进程 + 一个 SQLite；正文只在 `Y.Text`，Redux 只放指针与 UI。
2. **入口链**：`main → App(一次模式判定) → AppShell(keyed workspace) → DocumentWorkspace → Editor/AI`；身份失败不阻塞编辑器。
3. **六个业务失效**：并发覆盖、断网丢字、刷新丢稿、AI 直接改稿、越权读、切文档串页——每条都能指到一个设计。
4. **三个"结构而非约定"**：`key` 表达一 socket 一房间；`activeRoom` 单字段表达不能有两个房间；`null` 角色表达"未知不是无权限"。
5. **三条必须主动说的边界**：两个用户、1–2 s 断网、本地 production build；外加 production-ready 未验证。
