# 03 · 大文档性能与状态隔离（100k 行 / Redux 241 B / CodeMirror 6）

> **Evidence commit（本报告中所有 `path:Lx-Ly` 与 permalink 的锚点）**：`57a9bee5f2f8d6ff30f2a8373b61328546475183`
> **报告序号**：03/05 · **性质**：docs-only（不改代码/测试/package.json）
> **数字测量 commit**：`c2ad879834853785e87a5239af3d65b559e1d281`（perf 结果 JSON 里 `git.commit` 字段自证）
> **产品代码差异**：`git diff c2ad879..57a9bee -- apps packages` **非空**（多出 Markdown Preview、编辑器 `hidden` 物理路径等，见 §12.9）。
> 因此本报告的口径是：**源码位置锚定 HEAD `57a9bee`，性能数字属于 `c2ad879` 的产品代码，未被重跑**。这句话在面试里也要说。

---

## 1. 简历原句（逐字）与 claim 拆分

> 大文档性能与状态隔离：针对 10 万行 / 6.8 MB Markdown 编辑场景，将正文数据与 Redux 全局状态解耦，仅保留约 241 B 元数据，通过局部状态管理降低大文本导致的全局更新开销；编辑器 Ready 时间 P95 680 ms、WebSocket 重连 P95 770 ms。

一句话里有 6 个可被追问的断言。逐条判定（`PASS` / `REWORD` / `NOT MEASURED`）：

| # | Claim（简历词） | 判定 | 证据 | 必须补的限定 |
| --- | --- | --- | --- | --- |
| C1 | 10 万行 / 6.8 MB Markdown 编辑场景 | **PASS** | `tests/perf/fixtures/100k-lines.md`：100,000 换行、6,788,895 字符、6,788,895 字节、sha256 `0d12688d…c46c`（本机重算） | 6.8 MB = 十进制 6.79 MB = 6.47 MiB；这是**人工 fixture**，不是真实用户文档 |
| C2 | 将正文数据与 Redux 全局状态解耦 | **PASS（静态+动态双重）** | 静态：`documentSlice.ts:1-35` 只允许三个字段并明文禁止 `content/markdown/text`；动态：输入 300 次后 `store.getState()` 序列化 241 B，正文标记缺席（`instrument.mjs:99-141`） | 这是**架构不变量**（`AGENTS.md` R11），不是"优化成果" |
| C3 | 仅保留约 241 B 元数据 | **REWORD** | 241 B 是**整个 store 三个 slice 的 `JSON.stringify` 长度**，不是"元数据"一个字段（`aggregate.redux.stateBytes=[241,241,241]`） | 241 B 随 `connectionId`/`activeDocumentId` 字符串长度浮动（本机用一个 36 字符 UUID 模拟会到 ~280 B）。说"整个 store 241 B"才准确 |
| C4 | 通过局部状态管理降低大文本导致的全局更新开销 | **REWORD（方向正确，无测量）** | 机制：正文只在 `Y.Text`，击键走 `collabTextBinding` → `session.transact`，**不 dispatch**；`realtimeSlice` 只留 20 条控制消息 | 没有"优化前 dispatch 一次多少钱"的对照实验，所以**不能**说"降低 X%"。它消除的是"正文进 store"这条**错误路径**，不是把一条已有路径调快 |
| C5 | 编辑器 Ready 时间 P95 680 ms | **PASS（强限定）** | `perf-production-multiround.json`：ready n=3，632/654/680，p50 654、p95 680 | ① **local production build**（built server 服务 built web，无 Vite、无 TLS、无 Clerk、无 Render）；② n=3，p95 按 `aggregate.mjs` 的 nearest-rank **就是最大值**；③ 不是线上 P95；④ 产品代码是 `c2ad879` |
| C6 | WebSocket 重连 P95 770 ms | **PASS（强限定）** | `reconnectRestoreMs` n=9：753…770，p50 763、p95 770 | 定义是 `setOffline(false)` → 连接徽章 `connected`；**断网只保持 250 ms**；另一口径 offline→connected 是 1033 ms（更大，简历没写） |

**结论**：这句话可以讲，但必须带三个限定词——**本地 production build、样本量、非线上**；并且"241 B"要说成"整个 store"而不是"元数据"。§12 把每个数字的起止点都写死。

---

## 2. 业务问题

**用户侧问题.** 知识库里存在"大文档"：一份 6.8 MB 的 Markdown，10 万行。用户要做的事很朴素：**打开它、看清它、改一个字、别丢**。不是"要求 60 fps 打字机"。

**它为什么是工程问题.** 三个约束同时成立时，常规做法会一起崩：

1. **正文有第二份真相的诱惑**：React 生态默认 `useState(text)` / Redux 存 `content`。一旦存了，就必须回答"Yjs 合并后的正文和 store 里的正文谁对"，而 CRDT 的合并结果**无法**由客户端单方面推导。
2. **击键是最高频事件**：一次击键如果变成一次全局 action，所有 `useSelector` 订阅者都会被通知；在 6.8 MB 文档上，任何"顺手把正文也放进去"的 selector 都会把每次击键变成一次全量扫描。
3. **编辑器不是纯文本域**：CodeMirror 6 的 Markdown 语言包会在编辑后重算**受影响的语法范围**；这份 fixture 恰好是"10 万行、只用单个 `\n` 连接、没有空行"，CommonMark 视其为**一个段落**，于是"受影响范围"= 全文。这决定了 §12 里 371 ms 的存在。

**产品要守住的边界（比性能更重要）**：

- 关掉页面再打开，字还在（IndexedDB + 服务端 durable store）；
- 两个人同时改，不出现"文件被他人修改"的冲突弹窗（CRDT 合并）；
- 大文档不会因为"状态设计"而**多一份正文**，从而不可能出现 A 文档的正文渲染进 B 文档。

**因此本项目选的第一性问题不是"怎么调快"，而是"正文归谁"**。性能是这条归属关系的**后果**，不是目标。

---

## 3. 完整流程（每步：输入 / 输出 / 层 / 状态 / 同步异步 / 失败）

以下按 `tests/perf/run.mjs --build` 的真实执行顺序展开（这是测量路径，也是产品打开一份 100k 文档的路径）。

| # | 步骤 | 输入 | 输出 | 层 | 状态变化 | 同步/异步 | 失败会怎样 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 校验 fixture | 仓库内 `tests/perf/fixtures/100k-lines.md` | `{lineCount, characters, bytes, sha256, secondGenerationSha256, observedOnDiskSha256}` | 测试进程（Node） | 无（只读） | 同步 | 生成器两次摘要不等 → 抛错；磁盘文件与生成器不符 → 抛错并提示删除重建（`fixture.mjs:64-80`） |
| 2 | 起 build 栈 | `apps/server/dist/index.js` + `apps/web/dist` | 单端口 HTTP 服务（Express static + `/api` + `/ws`） | Node 进程 | 新进程、临时 `dataPath` | 异步（轮询 `/health`，上限 60 s） | 缺 dist → `run pnpm build first`；进程早退/健康超时 → 带最后 1500 字符输出抛错（`build-stack.mjs:50-95`） |
| 3 | 播种文档 | fixture 文件路径 | SQLite 里一条 Yjs update（`sequence`） | 服务端持久化 | durable（重启不丢） | 异步（`tsx` 子进程） | fixture 为空 → 抛错；store 在 `finally` 关闭（`seed.mjs:29-44`） |
| 4 | 导航与身份 | `appUrl` + demo 身份（`window.__qaIdentity`） | 页面、demo session cookie | 浏览器 / HTTP | `connection` slice 从 `idle` 起 | 异步 | 401/网络失败 → `useCollaborativeDocument` 返回 `{state:'failed'}`，编辑器不出现 |
| 5 | 切到 100k 文档 | switcher 输入 `a6-perf-100k` + Enter | `documentSelected` action | React/Redux → 协同层 | `document.activeDocumentId` 变更、`metadata=null`、`AppShell` 的 `key` 变化 → workspace 重挂载 | 同步 dispatch，异步副作用 | 空 id 被 reducer 忽略（`documentSlice.ts:57-65`）；新 session 失败 → 失败面板，旧文档已卸载 |
| 6 | 建 session | `documentId` / `user` / `wsUrl` | `Y.Doc` + `Y.Text` + `Awareness` + `UndoManager` + IndexedDB 句柄 | 协同层（`collab/internal`） | `initializing → active`（**先本地后网络**） | 异步（`await persistence.whenSynced`） | IndexedDB 打不开 → 在 `attachPersistence` 处失败（而不是 `y-indexeddb` 永久挂起），session 失败 |
| 7 | join 房间 | `join-room {documentId, protocolVersion}` | `room-joined {role, peers}` + SyncStep1/SyncStep2 | WS 服务端 + 客户端 | 一个 socket 只持一个房间；第二次 join 是**原子替换** | 同步授权 + 异步 hydration barrier | 无 membership → `ROOM_NOT_FOUND`（与"文档不存在"同码，不泄露存在性）；被拒后旧房间保持 |
| 8 | 就绪判定 | 每帧读 `EditorView.state.doc.length` | `ready.at` 时间戳 | 页面内 | 无 | 同步轮询（`requestAnimationFrame`） | 180 s 内长度不达标 → 抛错；**刻意不 `toString()`**，否则会用测量本身制造 Long Task（`tests/perf/run.mjs:240-272`） |
| 9 | 输入延迟 | 真实 `Input.insertText("x")` × 100 × 3 轮 | 每条 `{inputToModelMs, inputToNextFrameMs}` | 页面内（CDP 驱动） | `Y.Text` 增长 300 字符 | `beforeinput` 捕获 → CM handler → 本监听器 → 下一帧 | 长度增量 ≠ 100 或"单字符事务数" ≠ 100 → 抛错（`tests/perf/run.mjs:452-464`） |
| 10 | Redux 动态取证 | 运行中的 fiber 树 | `{available, bytes, keys, containsFixtureMarker, containsLine99999}` | 页面内（原型 `store.getState()`） | 无 | 同步（一次求值） | 找不到 store → `available:false`；聚合层把"任一轮不可用"判为失败信号（`allAvailable`） |
| 11 | 重连 | `setOffline(true)` → 250 ms → `setOffline(false)` | 三次 `restoreToConnectedMs` | 页面内 socket 包装 + 真服务端 | `connection.status` 走 `reconnecting → connected` | 异步（真实退避重连） | 30 s 内未 `connected` → 抛错；稳定 500 ms 后仍非 connected → 抛错（`tests/perf/run.mjs:498-533`） |
| 12 | 长任务/内存/包体 | `PerformanceObserver` / `performance.memory` / `apps/web/dist/assets` | Long Task 计数与分布、堆采样、raw+gzip | 页面内 + Node | 无 | 异步收集 | Long Task 不受支持 → `supported:false`（不伪装成 0）；内存 < 3 样本 → `NOT VERIFIED`（`tests/perf/run.mjs:546-560`） |
| 13 | 聚合 3 进程 | `perf-prod-run-1..3.json` | `perf-production-multiround.json` | Node | 无 | 同步 | 没有输入文件 → 抛错；**不设 PASS/FAIL 阈值**（`aggregate.mjs:23,79`） |

**"同步/异步"这一列是设计点，不是描述**：正文写入(`transact`)是**同步**的，连接、持久化、重连是**异步**的。第 6 步的"先本地后网络"（`document-session.ts:477-503,550-563`）保证了网络慢/断线不会阻塞"能打字"。

---

## 4. 源码定位（≥10 处，行号已对 `57a9bee` 核对）

| # | 位置（`path:Lx-Ly`） | 符号 | 职责 | Permalink |
| --- | --- | --- | --- | --- |
| 1 | `apps/web/src/store/documentSlice.ts:28-43` | `DocumentState`, `initialState` | Redux 只允许 `activeDocumentId` / `metadata` / `pendingDocumentId` | [L28-L43](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/store/documentSlice.ts#L28-L43) |
| 2 | `apps/web/src/store/documentSlice.ts:12-22` | 文件头注释 | 明文禁止 `content/markdown/text`，并解释为什么 `role` 也不进 store | [L12-L22](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/store/documentSlice.ts#L12-L22) |
| 3 | `apps/web/src/store/documentSlice.ts:57-71` | `documentSelected`, `documentMetadataReceived` | 切文档时**主动清空** metadata（陈旧元数据比没有更糟） | [L57-L71](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/store/documentSlice.ts#L57-L71) |
| 4 | `apps/web/src/store/realtimeSlice.ts:11-41` | `MAX_LOG`, `serverMessageReceived` | 控制面消息最多留 20 条；**不承载 Yjs update，也不承载正文** | [L11-L41](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/store/realtimeSlice.ts#L11-L41) |
| 5 | `apps/web/src/store/connectionSlice.ts:11-25` | `ConnectionState` | 传输状态（`status/connectionId/attempt/lastError`）——241 B 的主要来源 | [L11-L25](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/store/connectionSlice.ts#L11-L25) |
| 6 | `apps/web/src/store/index.ts:7-13` | `configureStore` | 三个 reducer，无第四 slice，无 middleware 存正文 | [L7-L13](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/store/index.ts#L7-L13) |
| 7 | `apps/web/src/collab/internal/document-session.ts:474-475` | `new Y.Doc()` / `doc.getText(DOCUMENT_TEXT_KEY)` | **正文唯一 owner** | [L474-L475](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L474-L475) |
| 8 | `apps/web/src/collab/internal/document-session.ts:268-272` | `transact(fn, origin)` | 一次本地写入 = 一个带 origin 的 Yjs 事务（undo 可识别） | [L268-L272](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L268-L272) |
| 9 | `apps/web/src/collab/internal/document-session.ts:306-328` | `destroy()` | 固定顺序拆网络/awareness/undo/IndexedDB，保证"旧 session 不复活" | [L306-L328](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L306-L328) |
| 10 | `apps/web/src/features/editor/collabTextBinding.ts:176-189` | `writeLocalChanges` | 击键 → **一个** Yjs 事务；多变更**从后往前**应用 | [L176-L189](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/collabTextBinding.ts#L176-L189) |
| 11 | `apps/web/src/features/editor/collabTextBinding.ts:238-259` | `reconcileFromText` | 远端更新后按"权威字符串 vs 编辑器字符串"算最小单区间，**不解析 `Y.TextEvent.delta`** | [L238-L259](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/collabTextBinding.ts#L238-L259) |
| 12 | `apps/web/src/features/editor/codeMirrorSurface.ts:104-108` | `hasText` | 用 `Text.eq` 比较，**避免为比较而 `toString()` 6.8 MB** | [L104-L108](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/codeMirrorSurface.ts#L104-L108) |
| 13 | `apps/web/src/features/editor/codeMirrorSurface.ts:110-135` | `applyDelta` | 远端变更 → 一次 CodeMirror transaction；offsets 钳制 + selection 显式映射 | [L110-L135](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/codeMirrorSurface.ts#L110-L135) |
| 14 | `apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx:245-271` | `EditorState.create` | 从 `Y.Text` 启封；扩展清单：markdown/lineNumbers/lineWrapping/updateListener | [L245-L271](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L245-L271) |
| 15 | `apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx:36-39` | 文件头注释 | **不装 `history()`**：撤销只有 `Y.UndoManager`，两套撤销是 bug | [L36-L39](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L36-L39) |
| 16 | `apps/web/src/AppShell.tsx:67-69` | `key={activeDocumentId}` | 切文档 = 重挂载 workspace，不会两个 session 并存 | [L67-L69](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/AppShell.tsx#L67-L69) |
| 17 | `tests/perf/fixture.mjs:20-43` | `LINE_COUNT`, `LINE_TEMPLATE`, `buildFixtureText` | 确定性 100k 生成器（1-based 行号、单 `\n`、尾部换行） | [L20-L43](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/fixture.mjs#L20-L43) |
| 18 | `tests/perf/fixture.mjs:57-103` | `ensureFixture` | 两次生成比对 + 磁盘比对 + 返回事实（含 `observedOnDiskSha256`） | [L57-L103](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/fixture.mjs#L57-L103) |
| 19 | `tests/perf/instrument.mjs:99-141` | `perf.reduxSnapshot` | fiber 找 `Provider` 的 `store` → `getState()` → `JSON.stringify` → 两个正文标记检测 | [L99-L141](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/instrument.mjs#L99-L141) |
| 20 | `tests/perf/instrument.mjs:197-212` | 输入采样 | `beforeinput` → `.cm-content` 的 `input` 监听（装在 CM 之后）→ rAF | [L197-L212](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/instrument.mjs#L197-L212) |
| 21 | `tests/perf/run.mjs:43-51` | `INPUT_ROUNDS`/`INPUTS_PER_ROUND`/`RECONNECT_ITERATIONS` | 3 × 100 输入、3 次重连、ready 超时 180 s | [L43-L51](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/run.mjs#L43-L51) |
| 22 | `tests/perf/run.mjs:921-937` | ready + 正文校验 | `ready.at - navigationStartedAt`；文档长度与 **sha256 必须等于 fixture** | [L921-L937](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/run.mjs#L921-L937) |
| 23 | `tests/perf/aggregate.mjs:30-43` | `stats` | nearest-rank p50/p95/max + mean（`ceil(p/100*n)-1`） | [L30-L43](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/aggregate.mjs#L30-L43) |
| 24 | `tests/perf/build-stack.mjs:49-69` | `BuildStack.start` | built server 服务 built web；`NODE_ENV` 不设（保留 demo bootstrap） | [L49-L69](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/tests/perf/build-stack.mjs#L49-L69) |
| 25 | `apps/web/src/collab/internal/awareness.ts:38-39` | `AWARENESS_FLUSH_DELAY_MS = 50` | **唯一的批处理**：光标/选区 50 ms 合并；文本不合并 | [L38-L39](https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/awareness.ts#L38-L39) |

（共 25 处；§4 之外的关键文件还有 `packages/shared/src/...` 的 Yjs 帧编解码，与本报告无关，不列。）

---

## 5. 状态归属表

| 状态 | 唯一 owner | 存放位置 | 生命周期 | 谁读 | 谁写 | 为什么不能换地方 |
| --- | --- | --- | --- | --- | --- | --- |
| 文档正文 | `Y.Doc` / `Y.Text` | `document-session.ts:474-475` | session 存活期；durable 副本在 SQLite + IndexedDB | 编辑器（经 binding）、AI 工具、Preview | `session.transact`（本地/远端/AI 三种 origin） | CRDT 合并语义不可在客户端重算；两份真相必然漂移 |
| 光标/选区（本地） | `EditorState.selection` | CodeMirror state | 编辑器存活期 | 编辑器、awareness | 用户 | 高频、无需持久化、UI 私有 |
| 远端在线状态 | `Awareness`（经 `session.publishPresence` 写、`getCollaborators()` 读） | `awarenessManager` | 房间存活期；不持久化 | 协作者列表、远端光标 | 校验后的 patch | 裸 `Awareness` 是线上 `Map<number,unknown>`，不能做业务 UI（R14） |
| 当前文档 id | Redux `document.activeDocumentId` | `documentSlice.ts:30` | 应用存活期 | `AppShell`、切换器、AI 目录 | `documentSelected` | 它是"UI 指向哪个房间"，不是正文 |
| 服务端元数据 | Redux `document.metadata` | `documentSlice.ts:32` | 编译期存在，**运行时恒为 `null`**（`documentMetadataReceived` 全仓库无 dispatcher，只有定义） | 未来渲染用 | 无人 | 客户端根本不发 metadata 请求（见 04 §3B），所以字段空着比塞假数据好 |
| 切换器草稿 | Redux `document.pendingDocumentId` | `documentSlice.ts:34` | 输入期间 | 输入框 | `pendingDocumentIdChanged` | 纯 UI 草稿，与打开哪个文档解耦 |
| 连接状态 | Redux `connection` | `connectionSlice.ts:11-25` | 应用存活期 | 状态徽章、离线提示 | WS 事件 | 低频（几次/分钟），可全局 |
| 控制面消息日志 | Redux `realtime`（最多 20 条） | `realtimeSlice.ts:11-41` | 应用存活期，环形截断 | 调试面板 | `serverMessageReceived` | 有界，防泄漏；**永不含 update/正文** |
| 权限 role | **不落 store**：`session.getRole()` → `useSessionRole` | session | 每次 `room-joined` 重算 | `capabilityGate` | 协同层 | 存进 store 就会"可以 dispatch 一个权限"，且会与 seam 的 `null` 语义打架（`documentSlice.ts:15-22`） |
| 撤销栈 | `Y.UndoManager`（只跟本端/AI origin） | `document-session.ts:534-536` | session 存活期 | 撤销按钮、`Mod-z` | 用户 | CodeMirror `history()` 无法区分远端编辑（R13） |

**一句话**：**会随击键变化的东西（正文、选区）一律不进 Redux；进 Redux 的只有"指向/开关/低频状态"**。

---

## 6. 技术选型（需求 → 候选 → 当前 → 为什么 → 放弃什么 → 代价）

### 6.1 正文放哪儿（本题核心）

| 方案 | 是否可行 | 正确性 | 更新开销 | 失败模式 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A. body 全放 Redux**（`document.content: string`） | 可实现 | **致命**：与 CRDT 形成第二真相；远端合并结果无法在 reducer 里重放 | 每次击键一个全局 action；所有 `useSelector` 被通知；DevTools/time-travel 持有 6.8 MB 快照 | 远端编辑到达时，store 与 `Y.Text` 必有一方过期；`undo` 语义分裂 | **REJECTED** |
| **B. React 局部状态**（`useState(text)` + `onChange`） | 可实现 | 同样违反单真相；切换文档/重挂载会丢字 | 每次击键触发组件重渲染；6.8 MB 字符串作为 props 比较成本高 | 受控组件在 100k 上打字会明显掉帧；与 Yjs 观察者互相触发 | **REJECTED** |
| **C. `Y.Text` 唯一真相 + Redux 只放控制状态** | 当前实现 | 单一真相；合并由 CRDT 决定 | 击键**不 dispatch**；只有连接状态等低频事件进 store | 需要额外的 binding 层保证"编辑器↔Y.Text"双向、且不互相回声 | **ADOPTED** |

**为什么放弃 A/B（要能讲出机制，而不是口号）**：
- 字符串在 JS 里不可变、按引用共享，所以"内存翻倍"不是主要问题（真正翻倍的是序列化/DevTools 快照）。**主要问题是正确性**：CRDT 的合并结果是一个**只能由 Yjs 计算**的函数，把它塞进 reducer 意味着要手写合并，或接受"store 落后于文档"。
- 其次是 **dispatch 扇出**：一次击键 = 一次 action = 一次全 store 通知。在 100k 文档上，任何 selector 只要碰正文就是 O(6.8 MB)——而这类 selector 会因为"方便"被不断写出来。
- 第三是 **生命周期**：文档切换要卸载 session；如果正文在 store 里，你必须写代码保证"切走的正文被清掉"，否则就会出现 A 文档内容显示在 B 文档里。现在这是结构性的：workspace 以 `activeDocumentId` 为 `key`，旧组件连同它的 `Y.Doc` 一起消失（`AppShell.tsx:67-69`）。

### 6.2 编辑器：CodeMirror 6，而不是 Monaco

| 维度 | CodeMirror 6（当前） | Monaco |
| --- | --- | --- |
| 实际使用的包 | `@codemirror/state` / `view` / `commands` / `lang-markdown`（`apps/web/package.json`） | 未安装（`NOT USED`） |
| 状态模型 | 不可变 `EditorState` + `Transaction`，`updateListener` 天然适合做"一次 update = 一次 Yjs 事务"的桥 | 命令式 `IModel`/`deltaDecorations`，Yjs 绑定要靠 `Y.Text` observe + `executeEdits` 手工对齐 |
| 体积 | 只装用到的 4 个包；本报告测得的 main chunk 970,271 B 里同时含 React/ReactDOM/Redux/antd/CodeMirror，**无法把编辑器单独归因**（Clerk 与 y-indexeddb 是独立 lazy chunk） | 完整包体通常更大；本项目从未构建过，**没有可比数字** |
| 协作生态 | 与 `y-protocols` 的 awareness/relative position 模型贴合（远端光标用 `getCollaborators()` 渲染） | 需自建 |
| 移动端/IME | CM6 的 `EditorView.editable` + `readOnly` facet 直接支持本项目的只读语义 | 需另一套 API |
| 结论 | **ADOPTED** | **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED** |

**诚实的边界**：仓库里**没有** editor-selection 的 ADR（`docs/DECISIONS.md` 搜不到 "Monaco"），也没有做过 Monaco 的对比实验。所以面试里只能说"我当时按这些约束选了 CM6"，**不能**说"CM6 比 Monaco 快/小 X%"。

### 6.3 测量方式：真实 Chrome + CDP，而不是 jsdom/Playwright

| 需求 | 候选 | 当前 | 为什么 | 代价 |
| --- | --- | --- | --- | --- |
| 真实输入事件 | jsdom 合成事件 / Playwright / CDP `Input.insertText` | CDP（`tests/browser/lib/cdp.mjs`） | jsdom 没有排版与真实 IME 路径；CDP 能同时拿到 `Tracing`/`Profiler`/`Fetch` 拦截 | 自己维护一套 CDP 客户端（无 Playwright 依赖） |
| 页面内计时 | `performance.now()` 从外部测 / 页面内埋点 | 页面内注入（`Page.addScriptToEvaluateOnNewDocument`） | 外部测量会把 CDP 往返算进延迟 | 注入脚本本身是**测试代码**，必须标注非生产遥测 |
| 生产路径 | Vite dev / 构建后 | 两者都跑，报告分列 | dev 的 on-demand transform 会让 ready 时间失真（6301 ms vs 680 ms） | 需要 `build-stack.mjs` 维护第二条启动路径 |

---

## 7. 关键实现细节（能撑住追问的 8 个点）

1. **"一次击键 = 一个 Yjs 事务"，且没有队列。** `handleLocalChanges` 同步调用 `writeLocalChanges`（`collabTextBinding.ts:199-202`），`flushLocalEdits()` 是**空函数**（`:209-211`）。注释给了理由：队列会让"编辑器显示 X"与"文档包含 X"解耦，而队列里的 offsets 描述的是**可能已被远端移动过**的文档。**这是本项目唯一的"文本无批处理"证据**；有批处理的只有 awareness（50 ms，`awareness.ts:38-39`）。
2. **多变更从后往前应用。** 同一次 update 里的 offsets 都相对"更新开始时"的文档，所以倒序才不让前面的插入影响后面的偏移（`collabTextBinding.ts:176-189`）。
3. **远端变更不解析 delta，而是算"最小单区间"。** 直接翻译 `Y.TextEvent.delta` 时，一个事务里"先删后插"和"先插后删"的混合坐标系极易算错，而这恰好是粘贴/多光标/远端合并才会触发的稀有路径。`reconcileFromText` 改成"权威串 vs 编辑器串 → `singleRangeChange`"（`:238-259`），代价是每次远端更新一次字符串比较，但**本地击键路径完全不碰**。
4. **比较不物化正文。** `hasText` 用 `Text.eq(Text.of(text.split('\n')))`（`codeMirrorSurface.ts:104-108`），避免"为了判断是否相等而把 6.8 MB 变成字符串"。
5. **远端 update 落地时显式映射选区。** `applyDelta` 用 `view.state.selection.map(ChangeSet.of(specs, docLength))`（`:124-134`），否则远端编辑会把本端光标留在陈旧 offset 上；offsets 还做了钳制，保证畸形变更退化成"有界修改"而不是抛异常。
6. **编辑器先有 observer，后有 view。** 先 `createCollabTextBinding`（attach `text.observe`），再 `new EditorView`（`CollaborativeMarkdownEditor.tsx:218-273`）。否则构造期间到达的远端变更会丢，编辑器静默分叉。
7. **只读是 `Compartment` 重配置，不是重建编辑器。** 角色降级时 `editability.reconfigure(...)`（`:367-375`），`EditorView`/binding/undo 全部保留——否则会把"还没写进 `Y.Text` 的本地文字"丢掉。
8. **241 B 的取证是"从 fiber 里偷 store"，不是读全局变量。** `instrument.mjs:99-141` 从 `#root` 的 `__reactContainer$` 出发 BFS fiber 树，找 `memoizedProps.store.getState`，再 `JSON.stringify`。这样连"应用把 store 挂到 `window` 上"都不需要，构建产物里也能跑（`findEditorView` 同理，`:49-80`）。

**附：为什么 ready 测量不 `toString()`**——`tests/perf/run.mjs:240-272` 的注释写明：每帧把 6.8 MB 转成字符串会**自己制造** Long Task，从而污染 ready 时间。所以它只读 `view.state.doc.length`。这类"测量不能改变被测对象"的细节，是这份证据可信的原因。

---

## 8. 为什么不用 X

| X | 为什么没用于"正文状态" | 如果非要用，代价是什么 |
| --- | --- | --- |
| Redux Toolkit + `createEntityAdapter` 存正文 | 它是"规范化集合"工具，不是 CRDT；解决不了合并 | 仍要第二真相；adapter 的 `ids/entities` 会在 6.8 MB 上产生大量浅拷贝 |
| Zustand / Jotai / Valtio 存正文 | 换库不换问题：仍是"客户端侧的第二份真相" | 订阅粒度更细，但正确性问题一模一样；还多一个依赖（R3 需批准） |
| React Context 传正文 | 任何 context 变更都会重渲染所有消费者 | 100k 场景下等于每次击键全树渲染 |
| `useSyncExternalStore` 直读 `Y.Text` | 需要把"文本"切片成可比较的快照，而 6.8 MB 的快照比较本身就贵 | 只适合"少量派生值"（本项目的 role/undo 就是这么做的），不适合正文 |
| Immer 手动 patch 正文 | 要手写 CRDT 合并 | 必然与 Yjs 结果不一致 |
| CodeMirror `history()` 作为撤销 | 无法区分远端编辑与本地编辑 | 会把协作者的改动一起撤掉（R13 禁止） |
| Monaco | 未评估（`NOT USED`） | 见 §6.2；没有数字，不做比较 |

---

## 9. Used 知识点（定义 / 在哪 / 为什么 / 追问 / 答案）

### 9.1 单一真相（Single Source of Truth）与 CRDT

- **定义**：对同一份可变数据只允许一个权威副本，其他都是派生视图。
- **在哪**：`document-session.ts:474-475`（`Y.Text`）、`documentSlice.ts:12-22`（禁止正文字段）、`CollaborativeMarkdownEditor.tsx:4-17`（"没有 `value` prop、没有 `onChange(value)`、没有 `useState(text)`"）。
- **为什么**：Yjs 的合并结果只能由 CRDT 计算；任何镜像都会在"远端编辑 + 本地编辑同时发生"时漂移。
- **追问**："那预览呢？" → 预览是 `Y.Text → derived string → renderer`（D-087 §1），仍然不写回、不进 Redux。
- **答案**：真相只有一份；派生视图可以有无数个，但都不能写回。

### 9.2 Yjs 事务与 origin

- **定义**：`doc.transact(fn, origin)` 把一组操作打包成一个原子更新；`origin` 是本地标记，用来区分来源。
- **在哪**：`document-session.ts:268-272`；`UNDO_TRACKED_ORIGINS` 决定哪些 origin 可撤销（`:534-536`）。
- **为什么**：origin 同时服务三件事——undo 追踪、binding 防回声（`transaction.origin === localOriginToken` 直接 return，`collabTextBinding.ts:153-166`）、以及"AI 编辑与用户编辑可分别撤销"。
- **追问**："为什么不用布尔 `applyingRemote`？" → 用了，但它是**计数器**（`:145-149`），因为 Yjs 事务可以嵌套。
- **答案**：一次用户输入 = 一个事务 = 一个网络帧 = 一个 undo item。

### 9.3 CodeMirror 6 的不可变 state 与 facet/compartment

- **定义**：`EditorState` 不可变；`Transaction` 描述变更；`Compartment` 允许在不重建 view 的前提下替换一组扩展。
- **在哪**：`CollaborativeMarkdownEditor.tsx:245-271`（初始 state）、`:367-375`（只读重配置）、`editorEditability.ts:59-61`（两个 facet 一起设）。
- **为什么**：只设 `EditorState.readOnly` 会让 DOM 仍可输入再被丢弃（"看起来坏了"）；只设 `EditorView.editable` 又挡不住程序化命令。
- **追问**："`readOnly` 能防住 Ctrl+Z 吗？" → 不能。手写 keymap 不继承 CM 的检查，所以 `runSessionHistory` 自己判 `readOnly`（`editorEditability.ts:82-91`）。
- **答案**：UI 只读是两处 facet + 一处投递层 + 一处快捷键，共四道，但都不是安全边界。

### 9.4 Yjs Awareness 的合并窗口

- **定义**：awareness 是"临时在线状态"，不持久化、不参与 CRDT 合并。
- **在哪**：`awareness.ts:38-39`（50 ms 合并）、`MAX_CLIENTS_PER_UPDATE` 512（`:41`）。
- **为什么**：光标每移动一像素都发一帧会打爆带宽；而文本不能这样合并（会破坏"一次击键一个事务"的语义）。
- **追问**："50 ms 会不会让别人看到旧光标？" → 会，最多 50 ms；这是可接受的取舍，且**只影响 presence，不影响正文**。
- **答案**：唯一被允许的批处理是 presence，50 ms。

### 9.5 nearest-rank 百分位

- **定义**：`sorted[ceil(p/100*n)-1]`（或 `floor(f*(n-1))`），不对样本插值。
- **在哪**：`aggregate.mjs:30-43`；`tests/perf/run.mjs:74-88`。
- **为什么**：小样本下"p95"若插值会凭空造出一个不存在的观测值。
- **追问**："n=3 的 p95 有意义吗？" → 在 aggregate 的约定下它就是**最大值**；所以我同时给 min/p50/max 和逐轮值。
- **答案**：p95 是"最差那一档"的代号，n 小的时候要连原始样本一起报。

### 9.6 Long Task / PerformanceObserver

- **定义**：主线程上 >50 ms 的任务；`PerformanceObserver({type:'longtask'})` 可观测。
- **在哪**：`instrument.mjs:146-168`（测试注入）。
- **为什么**：p95 输入延迟是"平均感受"，Long Task 计数是"卡顿次数"；后者更能解释"为什么用户觉得卡"。
- **追问**："这是线上监控吗？" → **不是**，`apps/**` 里没有任何 `PerformanceObserver`/`performance.mark`/`sendBeacon`。
- **答案**：测试仪表，必须标注。

### 9.7 fiber 树反射（测试技巧）

- **定义**：React 16+ 的 fiber 通过 `__reactContainer$<random>` 挂在容器 DOM 上，可 BFS 到 `Provider` 的 props。
- **在哪**：`instrument.mjs:49-80`（找 `EditorView`）、`:99-141`（找 store）。
- **为什么**：生产构建没有 Vite 的模块 URL，浏览器测试无法 `import` 到应用内部对象；fiber 是唯一稳定入口。
- **追问**："这不就是作弊吗？" → 它是**只读反射**，不 dispatch、不改文档；而且正是它让"正文不在 store"从断言变成测量。
- **答案**：只读、只用于测试、构建产物里也能跑。

### 9.8 确定性与可复现

- **定义**：同一 commit 必须产出同一字节。
- **在哪**：`fixture.mjs:57-103`（两次生成 + 磁盘比对）。
- **为什么**：性能数字没有 sha256 就没有意义——你无法证明两次跑的是同一份输入。
- **追问**："为什么不直接提交一个大文件？" → 提交了，但同时保留生成器与摘要校验；两者不一致就是硬错误。
- **答案**：fixture 的 sha256 是这份性能证据的"被测对象身份证"。

---

## 10. Related but not used（**RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**）

> 以下技术**在仓库中不存在实现**，只作为"我知道它、但我没做"的对照。面试里只能用来回答"你考虑过吗"，不能用来描述系统。

- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：Monaco Editor（编辑器替换）。仓库无依赖、无构建、无对比数字。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：CodeMirror 虚拟滚动/视口内解析（`viewport` 定制、`EditorView.viewportChanged` 驱动的局部高亮）。当前是 `markdown()` 默认行为。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：解析范围护栏（超大段落跳过语言解析 / 只解析视口）。`docs/agent-governance/PROFILE-100K.md:60-66` 明确列为"未实现候选"，且块结构对照实验后**判定不成立**（`docs/agent-governance/PROFILE-100K-BLOCK.md:41-46`）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：Web Worker 里跑 Markdown 解析。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：`requestIdleCallback` 分片解析、增量 Lezer 解析器的自定义分块。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：Redux 中间件批量合并 action（本项目**没有**批处理；只有 awareness 50 ms）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：react-virtualized / 虚拟列表（正文不是列表渲染）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：生产端 PerformanceObserver / RUM / `sendBeacon`。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：路由级 code splitting（实际只有 `ClerkRoot` 与 `y-indexeddb` 两个 lazy chunk，main 仍是单块 970,271 B）。
- **RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED**：SharedArrayBuffer / OffscreenCanvas / WASM 解析。

---

## 11. 测试：Given / When / Then（含文件、scenario、拓扑、注入、raw）

这一节的对象是**基准测量**，不是 PASS/FAIL 门禁。`tests/perf/run.mjs` 自己的头注释写明"sets **no** PASS/FAIL thresholds"（`tests/perf/run.mjs:21-22`）。但它仍然是测试：起真进程、驱动真输入、写可复算的 JSON。

**拓扑（三个独立进程，串行）**

```
node tests/perf/run.mjs --build        ← 进程 1（独立临时 dataPath、独立端口）
node tests/perf/run.mjs --build        ← 进程 2
node tests/perf/run.mjs --build        ← 进程 3
node tests/perf/aggregate.mjs perf-prod-run perf-production-multiround.json
```

每个进程内部：`BuildStack`（built server + built web，无 Vite）→ 真实 Chrome（CDP）→ 1 次导航 ready → 3×100 输入 → 1 次 Redux 快照 → 3 次离线/重连 → Long Task/内存/包体。

### T1 · fixture 确定性

- **Given** 生成器（`LINE_COUNT=100_000`，1-based 行号，单 `\n`，尾部换行）与仓库内已提交的 `100k-lines.md`
- **When** 调 `ensureFixture()`
- **Then** 两次生成的 sha256 必须相等；磁盘文件的 sha256 必须等于生成值，否则**抛错**（不是警告）
- **文件/行**：`tests/perf/fixture.mjs:57-103` · **scenario 名**：无（脚本级断言）· **注入**：无 · **raw**：`fixture.{characters:6788895, bytes:6788895, sha256:"0d12688d…", deterministic:true, observedOnDiskSha256:"0d12688d…"}`；本机 `Get-FileHash` 复核同值，`newlines=100000`

### T2 · 就绪 + 正文一致性（built 路径）

- **Given** 已 seed 的 100k 文档、built 栈、真实 Chrome
- **When** 导航 → 在 switcher 里输入文档 id 回车 → 每帧轮询 `view.state.doc.length`
- **Then** 长度 == 6,788,895；**且页面内算出的文本 sha256 == fixture sha256**；否则抛错
- **文件/行**：`tests/perf/run.mjs:921-937`、`tests/perf/run.mjs:303-318`（build 就绪）、`instrument.mjs:84-92`（页内 sha256）
- **注入**：`Page.addScriptToEvaluateOnNewDocument(PERF_INIT_SCRIPT)` · **raw**：ready 逐轮 680 / 654 / 632；`ready.editorSha256 == fixture.sha256`，`shaMatchesFixture:true`

### T3 · 输入循环完整性（防"测了个假的"）

- **Given** 光标置于文首（`Ctrl+Home`）
- **When** 3 轮 × 100 次真实 `Input.insertText("x")`
- **Then** 每轮模型增长**恰好** 100；采样数**恰好** 100；单字符事务数**恰好** 100；否则抛错
- **文件/行**：`tests/perf/run.mjs:324-360`（build 版）、`:421-496`（dev 版）
- **注入**：CDP 输入 + 页面内 `beforeinput` 捕获 · **raw**：`inputModelMs {count:900, min:246, p50:268.8, p95:371.3, max:511.4}`

### T4 · Redux 不含正文（动态）

- **Given** 300 次真实输入之后
- **When** 从 fiber 找到 store，`JSON.stringify(store.getState())`
- **Then** `bytes` 记录、`keys` 为 `connection/document/realtime`、`containsFixtureMarker === false`、`containsLine99999 === false`；三轮聚合 `allAvailable && allBodyAbsent`
- **文件/行**：`instrument.mjs:99-141`、`tests/perf/run.mjs:955-956`、`aggregate.mjs:109-116`
- **raw**：`redux.stateBytes = [241,241,241]`、`allBodyAbsent:true`、`keys:[connection,document,realtime]`

### T5 · 重连（真实断网路径）

- **Given** 已连接页面
- **When** `setOffline(true)`（关闭真 socket 并把新 `/ws` 改写到 `127.0.0.1:9`）→ 等状态离开 `connected` → **250 ms** → `setOffline(false)` → 等徽章回到 `connected`
- **Then** 30 s 内必须回到 `connected`；稳定 500 ms 后仍是 `connected`
- **文件/行**：`tests/perf/run.mjs:498-533`、`instrument.mjs:244-305`
- **注入**：`window.WebSocket` 子类包装（HMR socket 不动）· **raw**：`restoreToConnectedMs {count:9, min:753, p50:763, p95:770, max:770}`

### T6 · Long Task / 内存 / 包体

- **Given** 同一次运行
- **When** 收集 `PerformanceObserver` 缓冲、`performance.memory` 5 次采样、`apps/web/dist/assets` 文件大小
- **Then** 只**记录**，不判定；不支持时写 `supported:false` / `NOT VERIFIED`
- **文件/行**：`instrument.mjs:146-168`、`tests/perf/run.mjs:546-560`、`tests/perf/run.mjs:963-975`
- **raw**：Long Task 400 / 397 / 397（max 430 / 454 / 511 ms）；内存峰值 62,111,484 B；包体 970,271+85,786+2,913 = **1,058,970 B** raw、340,811 B gzip

### T7 · 块结构对照（诊断，非产品）

- **Given** 另一个**生成但不提交**的 100k 块结构文档（6,859,314 字符，sha256 `294af99d…`）
- **When** 同一 built 栈、同一操作序列
- **Then** 记录同指标，用来分离"fixture 结构"与"100k 行本身"
- **文件/行**：`tests/perf/fixture-block.mjs`、`tests/perf/block-benchmark.mjs`、`docs/agent-governance/PROFILE-100K-BLOCK.md:18-28`
- **raw**：ready 418/453/458（min/p50/max，n=3）；input model p50 2.3/2.3/2.4（三个 run 的 round-1）、p95 3.0–3.9（全部 9 轮）；Long Task **1/2/2**；Redux **253 B**

### T8 · CPU 归因（诊断）

- **Given** 预热 10 次输入后的 100k 编辑器
- **When** 开 `Profiler` + `Tracing`，打 20 次真实输入
- **Then** 输出子系统占比、Top 函数、Long Task 窗口统计
- **文件/行**：`tests/perf/profile.mjs:28-29,300-369`
- **raw**：`cpu.subsystems.CodeMirror.selfMs = 5368.3` / `totalProfiledMs = 5987.742` → **89.65%**；`longTasksInWindow {count:21, p50:264.766, p95:278.111, max:282.228, inputs:20}`；`categories.styleLayout.selfMs 13.648`、`paintComposite 10.285`、React 4.226

**这套测量证明了什么**：确定性 100k fixture 存在且可复现；100k 文档在 dev 与 built 两条服务路径上都能打开并接受真实输入；300 次输入后 store 里没有正文；重连有 n=9 的实测。
**没证明什么**：任何 SLO；任何 before/after；任何线上表现；任何"优化已完成"。

---

## 12. 数字定义（起止点 / n / p95 约定 / cold-warm / dev-build / 机器 / Chrome / 文件）

### 12.1 每个数字的"起"与"止"

| 指标 | 起点 | 终点 | 怎么测 |
| --- | --- | --- | --- |
| **ready** | `navigationStartedAt = Date.now()`，**在 `page.goto` 之前**（`tests/perf/run.mjs:899`） | 轮询到 `EditorView.state.doc.length === 6_788_895` 的那一帧（`:303-318`） | 页面内 `rAF` 轮询；不 `toString()` |
| **inputToModelMs** | `beforeinput` 捕获阶段的 `performance.now()`（`instrument.mjs:226-236`） | `.cm-content` 上**装在 CodeMirror 之后**的 `input` 监听器读到的 `performance.now()`（`:197-212`） | 同一 task 内已包含 CM 的事务与同步解析 |
| **inputToNextFrameMs** | 同上 | 紧随其后的 `requestAnimationFrame` | 含一次合成机会 |
| **reconnectRestoreMs** | `setOffline(false)` 调用前 | 连接徽章 `data-status` 变 `connected` 的时刻 | 徽章是真实 DOM，不是内部字段 |
| **reconnectOfflineMs** | `setOffline(true)` 调用前 | 同上 | 比 restore 多一个 250 ms 断网窗口 + 发现断开的时间 |
| **Long Task** | 平台定义：主线程任务 > 50 ms | 任务结束 | 测试注入的 `PerformanceObserver`，`buffered:true` |
| **Redux bytes** | 300 次输入之后 | `JSON.stringify(store.getState()).length` | fiber → `Provider.store` |
| **bundle raw/gzip** | `apps/web/dist/assets/*.js` | 三个文件求和 | Node 读文件 + `gzipSync` |

### 12.2 n 与 p95 约定（这里最容易被打假）

- ready **n=3**（3 个独立进程各 1 次导航），输入 **n=900**（3×3×100），重连 **n=9**（3×3）。
- 百分位是 nearest-rank，但**两个文件实现不同**：
  - `tests/perf/run.mjs:80`：`sorted[floor(f*(n-1))]`
  - `aggregate.mjs:34`：`sorted[ceil(p/100*n)-1]`
- 后果（本机按 raw 复算）：
  - ready 排序 `[632, 654, 680]` → `tests/perf/run.mjs` 口径 p95 = **654**，`aggregate.mjs` 口径 p95 = **680**（= max）。简历上的 680 用的是**聚合口径**。
  - reconnect 排序 `[753,758,759,760,763,763,764,767,770]` → 两口径分别为 **767** / **770**。
- 所以"P95 680 / 770"在 n=3 / n=9 下**等于或接近最大值**，必须同时报 min/p50/max 和逐轮值，否则会被误读成"稳定分布"。

### 12.3 cold / warm

- ready 是**冷启动导航**（每个进程只有一次导航；进程内的输入轮次不复测 ready）。
- 输入是**热的**（同一编辑器、光标在文首，300 次连续输入）。profile 在正式打点前还额外预热 **10** 次输入（`profile.mjs:28,323`）。
- dev 组的 run 1 是冷进程（ready 6301 ms / 首连 5721 ms），报告**保留**了它，没有丢弃（`PERF-BASELINE-100K-MULTIROUND.md:20`）。这是"p95 680 不是每台机器都保证"的直接证据。

### 12.4 dev vs build

| | dev | local production build |
| --- | --- | --- |
| 谁服务页面 | Vite dev server（按需 transform）+ `tsx` 服务端 | `apps/server/dist/index.js` 服务 `apps/web/dist`（Express static） |
| ready p50/p95/max | 1845 / **6301** / 6301 | **654 / 680 / 680** |
| 输入 p50/p95/max | 283.3 / 422.0 / 592.5 | **268.8 / 371.3 / 511.4** |
| 首连 WS | 1231 / 5721 / 5721 | 223 / 264 / 264 |
| 重连 restore | 772 / 780 / 780 | **763 / 770 / 770** |

**build ≠ production**：没有 TLS、没有 Clerk、没有 Render、没有 CDN、没有真实网络；`NODE_ENV` 甚至特意不设，以便 demo bootstrap 可用（`build-stack.mjs:1-12`）。它证明的是**服务路径差异**（打包 vs 按需），不是线上性能。

### 12.5 机器与浏览器

Windows 11 Home China 10.0.26200 x64 · 13th Gen Intel Core **i5-1340P**（16 逻辑 CPU）· 16,890,716,160 B 内存 · Node **v22.14.0** · **Chrome/155.0.8059.85 headless** · CDP protocol 1.3。数据来自 `perf-production-multiround.json` 的 `host`/`chrome` 字段。应用侧是 **React 19.0.0 + Redux Toolkit 2.5 + CodeMirror 6**（`apps/web/package.json`）。

### 12.6 文件（数字的落盘位置）

- `tests/perf/results/perf-prod-run-1.json` / `-2` / `-3`：单进程原始样本（含逐条 Long Task 与逐条输入样本）
- `tests/perf/results/perf-production-multiround.json`：3 进程聚合（`aggregate` / `perRun` / `sampleCounts` / `bundle` / `memory`）
- `tests/perf/results/perf-run-1..3.json` + `perf-baseline-100k-multiround.json`：dev 对照
- `tests/perf/results/profile-100k.json`：CPU/子系统/Long Task 窗口
- `tests/perf/results/scaling-probe.json`：5k/25k/50k/100k 输入 p50
- `tests/perf/results/perf-block-run-1..3.json`：块结构对照

### 12.7 241 B 到底是什么

`JSON.stringify` 之后整个 store 的长度，键为 `connection` / `document` / `realtime`。构成：`connection.status/connectionId/attempt/lastError` + `document.activeDocumentId/metadata(null)/pendingDocumentId` + `realtime.messages([])/receivedCount(0)/lastError`。**它不是常量**：`connectionId` 与文档 id 的长度直接改变字节数（用一个 36 字符 UUID 模拟会到 ~280 B）。所以正确说法是"这次运行里整个 store 序列化 241 B"，而不是"元数据固定 241 B"。

### 12.8 输入 371.3 ms 的地位

它是**这份病理 fixture**上的 p95，不是"100k Markdown 编辑器"的通用值。块结构对照（同 100k 行、同操作序列）把它压到 **3.0–3.9 ms** p95（9 轮逐轮 p95 的最小/最大值），Long Task 从 ~400 降到 **1–2**。这是**fixture 结构效应**，不是产品优化。

### 12.9 时效性与 HEAD 差异（必须主动说）

- 数字测量于 `c2ad879`（JSON 的 `git.commit` 自证）；`57a9bee` 的产品代码**已变化**：新增 Markdown Preview（`MarkdownPreview.tsx`、`react-markdown`/`remark-gfm` 依赖）、`DocumentCanvas.tsx`、编辑器 `hidden` 物理路径与滚动记忆。这些是**增量**（不改变"正文只在 Y.Text"的结构），但：
  - **bundle 必然大于 1,058,970 B**（react-markdown 等进了构建）；
  - **ready 没有被重跑**，且 Preview 的派生渲染在 100k 上并不轻——`tests/browser/README.md:330` 记录了一次 100k 预览尝试在 420 s 预算内**没有**到达 `data-state="ready"`，因此**不作任何 100k 预览性能声明**。
- 结论：数字可用，但必须写清"测量 commit + 未重跑"。**不要**把 1,058,970 B 说成 HEAD 的包体。

---

## 13. 边界与面试答法

### 13.1 真实的边界

| 边界 | 事实 | 怎么讲 |
| --- | --- | --- |
| 不是线上 P95 | 本机 Windows + headless Chrome + Express static；无 TLS/CDN/Render | "本地 production build 的 P95，不是线上" |
| 样本很小 | ready n=3、重连 n=9；p95 接近最大值 | 主动给 min/p50/max |
| 输入并不快 | p95 371 ms、Long Task ~400/轮 | "能改、不丢字，但不是流畅编辑器" |
| fixture 病理化 | 10 万行单段落 → Markdown inline parser 89.65% | 给块结构对照数字，说明是结构放大 |
| 未做优化 | 无 pre-opt commit、无 before/after | "我没有优化，我做的是归属和测量" |
| 测量仪表非遥测 | `apps/**` 无 PerformanceObserver | "这是测试注入，不是线上监控" |
| monaco 未评估 | 无依赖、无数字 | "没做过对比，不能比较" |
| HEAD 未重跑 | `c2ad879` 产品代码；HEAD 多了 Preview | "数字是那个 commit 的" |

### 13.2 三档问答

- **30 秒**：见 §16。
- **90 秒**：见 §16。
- **被问"你这算优化吗"**：**不算**。优化需要"改动前后同一指标对比"；我做的是把正文从错误的容器里拿出来（架构不变量），以及建立一套可复算的测量。如果要说优化，我只能说"避免了一条会让每次击键都全局通知的路径"，而这**没有**量化对照。

---

## 14. 追问 ≥15（附一句话答案）

1. **正文不进 Redux，那"当前编辑内容"组件之间怎么共享？** 不共享正文；需要正文的组件读 `session.text`（同一个 `Y.Doc`），或者在预览里派生。
2. **241 B 会不会随文档变大而变大？** 不会，正文不在里面；它会随 id 长度变。
3. **`metadata` 为什么一直是 null？** 客户端没有 metadata 请求；`documentMetadataReceived` 全仓库无 dispatcher。这是"字段预留但未接线"，要主动承认。
4. **一次击键产生几个 Yjs update？** 一个（一次 `transact`），也就是一个网络帧。
5. **为什么不做输入批处理（如 16 ms 合并）？** 队列会让显示与真相解耦，且 offsets 会因远端更新失效；项目里唯一批处理是 awareness 50 ms。
6. **远端更新来了，怎么保证光标不跳？** `applyDelta` 用 `ChangeSet.map` 显式映射 selection。
7. **为什么不用 `Y.TextEvent.delta` 直接把远端变更翻译成 CM 变更？** 多操作事务的坐标系是混合的，容易只在粘贴/多光标/合并时出错。
8. **编辑器怎么保证不从 Y.Text 反向覆盖？** observer 里 `transaction.origin === localOriginToken` 直接 return（防回声），外加 `applyingRemote` 计数。
9. **撤销为什么不用 CodeMirror history？** 它无法区分远端编辑；用 `Y.UndoManager` + `UNDO_TRACKED_ORIGINS`。
10. **ready 680 ms 是"打开就能打字"吗？** 是"文档长度到位"，不是"可交互"。可交互更严格，没测。
11. **为什么 p95 680 而不是 654？** 两个文件百分位实现不同；680 是聚合口径（= max）。
12. **Long Task 400 条是不是说明有内存泄漏？** 不是，是"每次输入一个长任务"，由 Markdown inline 解析造成；总时长与输入次数同阶。
13. **89.65% 怎么算的？** `cpu.subsystems.CodeMirror.selfMs 5368.3 / totalProfiledMs 5987.742`，取自 `profile-100k.json`。
14. **块结构对照是不是在"改 fixture 让数字好看"？** 不是替换；官方 fixture 未动，块 fixture 只生成不提交，且明确标注为诊断。
15. **为什么 bundle 不拆？** 没做；main 仍是单块 970,271 B，只有 `ClerkRoot` 与 `y-indexeddb` 懒加载。
16. **这个测量能复现吗？** 能：同一 commit + 同一 fixture sha256 + 同一 Chrome + 同一操作序列；但机器/温度/后台进程会改变绝对值。
17. **为什么用 CDP 而不是 Playwright？** 要 `Tracing`/`Profiler`/`Fetch` 拦截与真实输入，且不想引入大依赖；代价是自己维护 CDP 客户端。
18. **如果让你继续做，第一步是什么？** 在 HEAD 重跑一次（Preview 已进构建），再决定是否值得做解析范围护栏；不做没有证据的优化。

---

## 15. 决策复盘表

| 决策 | 当时的选择 | 备选 | 结果 | 复盘点（如果重来） |
| --- | --- | --- | --- | --- |
| 正文归属 | `Y.Text` 唯一真相，Redux 只放控制状态 | body 进 Redux / React state | **对**：跨文档污染在结构上不可能；241 B store 可被动态证明 | 应在 M1 就把"禁止正文字段"写成测试（现在只有注释 + 一次动态快照） |
| 编辑器 | CodeMirror 6（4 个包） | Monaco（未评估） | **可接受**：CM6 的不可变 state 与事务模型让 binding 可测 | 应补一页选型记录；否则面试只能讲"按约束选的" |
| 测量方式 | 真实 Chrome + CDP + 页面内埋点 | jsdom / Playwright / 线上 RUM | **对**：能同时拿输入、Long Task、CPU profile、包体 | 埋点应更早标准化（现在 profile 与 run 各有一套） |
| fixture | 提交 100k 单段落 + sha256 + 双生成校验 | 随机大文件 / 不提交 | **对**：可复现、可审计 | 应同时提交块结构 fixture（现在只生成），否则"结构效应"要靠重跑 |
| 服务路径 | dev 与 build 都测，分列报告 | 只测 build | **对**：暴露了 dev 的 6301 ms 冷启动 | build 与 production 的差别要写在标题上（现在写在正文） |
| 阈值 | 不设 PASS/FAIL | 设 SLA | **对**：这是 baseline，不是门禁 | 如果要当门禁，必须先有稳定机器与预算 |
| 优化 | 不做 | 加解析护栏 | **对（有证据）**：块结构下无产品级问题 | 若真实文档出现超长段落，再启动；需 owner 批准 |
| 打包 | 不拆 | 路由级 splitting | **欠债**：main 970 kB | 若要拆，先测 TTI，不要为了数字拆 |

---

## 16. 30 秒 / 90 秒 / 3 分钟

**30 秒**
> 10 万行、6.8 MB 的 Markdown，我把正文只放在 Y.Text，Redux 只留当前文档 id、连接状态这类控制信息。用真实 Chrome 跑 300 次真实输入后从 fiber 里读出 store，序列化只有 241 B，正文标记一个都没有。本地 production build 上 ready p95 680 ms、重连 p95 770 ms，样本是 3 和 9，不是线上数字。

**90 秒**
> 大文档我先解决"正文归谁"，不是调参。6.8 MB 正文如果进 Redux，就有两份真相：Yjs 的合并结果没法在 reducer 里重放，而且每次击键都会变成一次全局 action。所以正文只在 Y.Text，进入编辑器的路径是"击键 → 一次 Yjs 事务 → 一个网络帧"，没有队列也没有批处理；唯一允许批处理的是光标那类 awareness，50 毫秒合并。
> 证据是可复算的：deterministic fixture 100,000 行、6,788,895 字符、sha256 固定；三个独立进程、真实 Chrome、3×100 次真实输入、3 次真实断网重连；ready 680/654/632，重连中位 763。输入 p95 是 371 ms，Long Task 每轮约 400 条，这些我没藏——profile 显示 89.65% 的 JS 时间在 CodeMirror 的 Markdown inline parser，因为这份 fixture 是 10 万行单段落；换成块结构后 p95 降到 3ms 级、Long Task 只剩 1–2 条。
> 所以我的结论是：这是"正确、可持久、能编辑"，不是"流畅"；而且我没有做优化，也没有优化前基线，不会说提升百分之多少。

**3 分钟**（在 90 秒基础上按顺序加这四段）
1. **状态归属**：给出 §5 表的三层——`Y.Text`（正文）、CodeMirror state（选区）、Redux（id/连接/UI）；点明 `metadata` 字段其实恒为 null（因为客户端不发 metadata 请求），并解释 241 B 是整个 store 不是元数据。
2. **binding 的三个防回声机制**：origin 比较、`applyingRemote` 计数、远端变更按"最小单区间"重算而不是解析 delta。
3. **测量方法学**：为什么必须 build 路径、为什么不 `toString()`、为什么 p95 在 n=3 时就是 max、为什么 Long Task 是测试仪表而不是遥测。
4. **边界**：not production P95、no optimization、fixture 病理化、HEAD 已加 Preview 未重跑、Monaco 未评估。

---

## 17. ASCII：一份 100k 文档从打开到可编辑

```
                         ┌──────────────────────────────┐
  fixture (committed)    │ tests/perf/fixtures/          │
  100,000 lines          │   100k-lines.md               │
  6,788,895 chars        │   sha256 0d12688d…c46c        │
                         └───────────────┬──────────────┘
                                         │ seed.mjs (tsx, 真 openDocumentStore)
                                         ▼
                         ┌──────────────────────────────┐
                         │ SQLite: Yjs update (durable) │
                         └───────────────┬──────────────┘
                                         │ GET /ws → join-room
                                         ▼
 ┌───────────────┐   documentSelected    ┌──────────────────────────────┐
 │ Redux         │ ────────────────────▶ │ AppShell key=activeDocumentId│
 │  connection   │                       │  → remount DocumentWorkspace │
 │  document     │ ◀──── 241 B ────┐     └──────────────┬───────────────┘
 │  realtime     │                 │                    │ createDocumentSession
 └───────────────┘                 │                    ▼
        ▲                          │     ┌──────────────────────────────┐
        │ 只有控制状态              │     │ Y.Doc                        │
        │ (无正文)                  │     │  └─ Y.Text  ◀── 唯一正文     │
        └──────────────────────────┘     │  ├─ Awareness (50 ms 合并)   │
                                         │  ├─ Y.UndoManager            │
                                         │  └─ IndexedDB replica        │
                                         └──────────────┬───────────────┘
                                                        │ observe / transact
                                                        ▼
                                         ┌──────────────────────────────┐
                                         │ CodeMirror 6 EditorView      │
                                         │  EditorState (immutable)     │
                                         │  markdown() / lineNumbers    │
                                         │  updateListener ──▶ binding  │
                                         └──────────────────────────────┘

击键路径（同步，无批处理）:
  beforeinput ─▶ CM input handler ─▶ handleLocalChanges ─▶ session.transact
             ─▶ Y.Text ─▶ 1 个 WS 帧 ─▶ 服务端 apply/persist/broadcast

远端路径:
  WS 帧 ─▶ Y.applyUpdate ─▶ Y.Text.observe ─▶ reconcileFromText
        ─▶ singleRangeChange ─▶ 1 个 CM transaction（selection 显式 map）
```

---

## 18. 记忆点（面试时能立刻复述的 8 条）

1. **口径三件套**：100k/6.8MB 是**人工 fixture**；680/770 是**本地 production build**；n=3/n=9 所以 p95 接近 max。
2. **241 B 是整个 store**，不是"元数据"；它随 id 长度浮动；它由"fiber 里偷 store"动态证明，且正文两个标记都缺席。
3. **一次击键 = 一个 Yjs 事务 = 一个网络帧**；`flushLocalEdits()` 是空的（没有批处理）；唯一的 50 ms 批处理是 awareness。
4. **远端变更不解析 delta**，而是"权威串 vs 编辑器串 → 最小单区间"，因为多操作事务的坐标系是混合的。
5. **不是优化**：没有 pre-opt 基线、没有 before/after；做的是归属 + 测量。
6. **371 ms 是 fixture 病理值**：10 万行单段落 → Markdown inline parser 占 89.65%；块结构对照降到 3ms 级。
7. **测量有纪律**：ready 不 `toString()`、dev 与 build 分列、Long Task 标注"测试仪表"、fixture 双生成比 sha256。
8. **诚实的空缺**：Monaco 没评估、bundle 没拆、HEAD 加了 Preview 但没重跑 100k、metadata 字段恒为 null。
