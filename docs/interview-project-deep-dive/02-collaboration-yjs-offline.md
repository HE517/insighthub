# 02 · 多人协同与离线恢复（CodeMirror 6 + Yjs + WebSocket + IndexedDB 深度复盘）

| 项 | 值 |
| --- | --- |
| Evidence commit | `57a9bee5f2f8d6ff30f2a8373b61328546475183` |
| Branch | `agent/interview-project-deep-dive`（基于上述 commit 新建） |
| 报告性质 | docs-only。未改代码、测试、`package.json`；未跑新的测试/性能进程 |
| 源码核对方式 | 逐文件阅读 + `Select-String` 取行号；所有 permalink 固定到 evidence commit |
| 本报告对应的简历句 | B2「多人协同与离线恢复…」 |

> 事实口径：React **19**；AI **无流式**；正文 update **无批量合并**（只有 awareness 有 50 ms 合并窗口）；100k 的 P95 是**本地 production build**；协同证据只有**两个用户**；断网窗口 **1–2 s**，30 s **未测**；**没有优化前后对比**。

---

## 1. 简历原句

逐字引用：

> 多人协同与离线恢复：基于 CodeMirror 6 + Yjs 实现 Markdown 实时协同编辑，以 Y.Doc / Y.Text 作为正文唯一数据源，通过 WebSocket 同步增量更新，并结合 IndexedDB 支持离线编辑、重开恢复及双用户并发状态收敛。

拆成 claim：

| # | Claim | 可验证含义 | 证据落点 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | **多人协同** | 两个独立客户端并发编辑同一文档并收敛 | `collab/independent-contexts`（`08-evidence-gate.mjs:251`） | VERIFIED（**恰好两个**；3+ NOT VERIFIED） |
| C2 | **离线恢复** | 断网期间可写；重开/重连不丢 | `indexeddb/A`、`indexeddb/B`、`chaos/offline-reconnect` | VERIFIED（窗口 1–2 s；30 s NOT VERIFIED） |
| C3 | **基于 CodeMirror 6** | 编辑器是 CM6（`@codemirror/view` 6.x），不是 textarea/Monaco | `apps/web/package.json`（`@codemirror/* ^6`） | VERIFIED |
| C4 | **基于 Yjs** | CRDT 是 `yjs@13.6`，wire 用 `y-protocols` | `document-session.ts:474`、`sync-provider.ts:3` | VERIFIED |
| C5 | **Markdown 实时协同编辑** | 文档是纯文本 Markdown；同一次按键立即进 CRDT 并出帧 | `collabTextBinding.ts:72-86`、`lang-markdown` | VERIFIED |
| C6 | **Y.Doc / Y.Text 正文唯一数据源** | 正文不镜像进 React/Redux；Redux 实测 241 B 无正文 | `docs/ARCHITECTURE.md:5-42`；`perf-production-multiround.json → aggregate.redux` | VERIFIED |
| C7 | **WebSocket 同步增量更新** | 只发 Yjs update / state-vector delta，不发整篇 | `sync-provider.ts:446-453`；`convergence.test.ts:129` | VERIFIED |
| C8 | **IndexedDB 离线编辑** | 本地副本存编码后的 Yjs update；断网可写 | `persistence.ts:334-377`；`indexeddb/B` | VERIFIED |
| C9 | **重开恢复** | 关页再开（仍离线）文本还在 | `indexeddb/A`、`indexeddb/B` | VERIFIED |
| C10 | **双用户并发状态收敛** | A、B、服务端三方文本逐字相等且 state-vector 摘要相等 | `08-evidence-gate.mjs:251-538` | VERIFIED |

**这句话最强与最弱的地方**："唯一数据源"是最强的一条（有静态类型 + 动态 241 B 双重证据）；"双用户并发状态收敛"是最需要限定的一条（只有两个 context、只测了非重叠的 insert/delete/replace）。

---

## 2. 业务问题

协同编辑器真正要解决的，是"两个人 + 一条不可靠网络 + 一个会刷新的浏览器"组合出来的失效。下面 8 个失效都能在本项目里指到具体设计；没有这些设计，产品会以"偶发丢数据"的形式烂掉。

**P1 两个人同时改，保存覆盖。**
A 在文首补一段，B 在文末删一段。整篇保存/LWW 下，后保存的人赢，另一个人的工作无声消失。这是**数据丢失**，不是冲突提示能救的。

**P2 断网期间不能写，或者写了但失败。**
用户不会因为 Wi-Fi 抖一下就停手。如果编辑器把"可输入"绑定在 socket 状态上，用户要么被锁住，要么输入后被拒绝且没有可靠的本地副本。

**P3 刷新即丢稿。**
浏览器没有"自动保存"。正文只在内存/React state 时，F5 就是不可恢复。

**P4 网络重复投递把字打重。**
移动网络、代理重试、断线重连都可能让同一个 update 到达两次。如果客户端"收到就插入"，会出现 `hellohello`。

**P5 乱序到达导致分叉。**
A 的两次编辑可能以 2→1 的顺序到达。如果按到达顺序应用且没有因果信息，两个副本会永久不同。

**P6 重连要传整篇文档。**
10 万行文档每次重连传一遍，等于把"网络抖动"放大成"带宽事件"。业务上表现为重连后编辑器卡住/流量暴涨。

**P7 本地 undo 把队友的字撤掉。**
用户按 `Ctrl+Z` 想撤自己刚打的一句，结果把队友刚写的段落撤了。这是协同产品最不可接受的行为之一，因为它破坏"我的编辑只影响我"的直觉。

**P8 一个 socket 同时挂两个文档。**
快速点两下文档列表，二进制帧就不知道该路由到哪个房间；轻则串内容，重则把 A 的编辑写进 B 的持久化日志。

对应到 V1 的验收（`PROJECT.md:55-64`）：两人并发无丢更新；断网不丢键（含关页重开）；重连后离线编辑进 durable store；被接受的行为对第二个客户端表现为普通 CRDT 编辑。**注意"不丢键"的证据是 `indexeddb/B`（重开仍在），不是"30 秒不丢"**。

---

## 3. 完整实现流程

主路径 = demo 身份 + 默认文档。每步：输入 → 输出 / 负责层 / 状态归属 / 同步还是异步 / 失败处理。

### 3.1 建会话：本地优先（E1–E6）

**E1 hook → 工厂**
- 输入：`{ documentId, user }`。
- 输出：`useCollaborativeDocument` 的 `initializing | active | failed`（`public.ts:63-121`）。
- 负责层：`collab/public.ts`（A1↔A2 唯一 seam）；A2 不许 import `collab/internal/**`。
- 状态归属：hook 的 `useState` 只存 union，不存正文。
- 异步（effect 里 promise）。失败处理：`disposed` 时对已创建的 session 立刻 `destroy()`，不泄漏 IndexedDB 连接与 awareness interval（`public.ts:95-117`）。

**E2 建 Y.Doc / Y.Text**
- 输入：无。
- 输出：`new Y.Doc()`；`doc.getText('content')`（`document-session.ts:474-475`）。`DOCUMENT_TEXT_KEY='content'` 是 A1/A2 共享的冻结常量（`binary-frame.ts:108-109`）。
- 负责层：A1 私有实现。状态归属：正文权威。
- 同步。失败处理：`documentId` 空、user id/name 空直接 reject（`460-472`）。

**E3 挂 IndexedDB 并等本地 load**
- 输入：`doc`、`key = resolvePersistenceKey(documentId, override)` = `insighthub-doc:<documentId>`（`persistence.ts:76-82`）。
- 输出：`DocumentPersistence { whenSynced, destroy }`（`persistence.ts:334-377`）；`y-indexeddb` 把已存的 update 重放进 `doc`。
- 负责层：`persistence.ts`。状态归属：IndexedDB 里是**编码后的 Yjs update**，不是 Markdown 字符串。
- **异步且是 gate**：`await persistence.whenSynced`（`document-session.ts:550`）之后才 `active`。
- 失败处理：环境没有 IndexedDB → 抛错（宁可打不开，也不静默降级成内存模式）；构造失败 → 释放全局租约并 rethrow（`persistence.ts:371-378`）。

**E4 发本地 presence**
- 输入：`{ user: {id,name,color?}, cursor:null, selection:null, updatedAt }`。
- 输出：`awarenessManager.publishLocalState()`（`document-session.ts:557`），50 ms 合并后才真正出帧（`awareness.ts:39`）。
- 负责层：`awareness.ts`。状态归属：`y-protocols` `Awareness`（内存，不持久化）。
- 异步（定时器）。失败处理：还没 join 时 `send` 返回 false，不算错误（`document-session.ts:525-527`）。

**E5 标记 active**
- 输入：无。
- 输出：`sessionState='active'`；挂 `doc.on('update')` / `doc.on('afterTransaction')` / `awareness.on('change')` 三个通知（`document-session.ts:336-342`）。
- 负责层：A1。状态归属：session 内部。
- 同步。失败处理：幂等（只在 `initializing` 时生效）。

**E6 启动网络**
- 输入：`resolveSocketUrl(options)`（`VITE_WS_URL` → 页面 origin `/ws` → `ws://127.0.0.1:3001/ws`，`document-session.ts:593-603`）、socket 工厂。
- 输出：`SyncProvider` 构造并 `connect()`（`document-session.ts:355-409`）。
- 负责层：`sync-provider.ts`。状态归属：`networkStatus`（`idle/connecting/reconnecting/connected/offline/error`）。
- 异步（socket 事件）。失败处理：构造 socket 抛错 → 直接 `scheduleReconnect()`（`sync-provider.ts:257-264`）；URL 无法解析有默认值兜底。

### 3.2 连接与握手（E7–E10）

**E7 socket open → join-room**
- 输入：socket `open` 事件。
- 输出：TEXT 帧 `{ type:'join-room', payload:{ documentId, protocolVersion, mode:'readwrite' } }`（`sync-provider.ts:278-288`）。
- 负责层：A1 网络层。状态归属：`joined=false`（还没确认）。
- 异步。失败处理：`sendControl` 失败返回 false，不抛（`478-487`）。

**E8 服务端 join（同步成员变更）**
- 输入：`join-room`。
- 输出：`registry.joinRoom`（`registry.ts:330-423`）：校验 protocol version → `authorizeJoin` → `authz.roleFor` + `canRead`（拒绝一律 `ROOM_NOT_FOUND`，不泄露文档是否存在）→ `#getOrCreateRoom` → `#detach` 旧房间 → `room.add` → 返回 `{room, peers, barrier, role}`。
- 负责层：server `ws.ts` + `registry.ts`。
- **同步**：整个函数没有 `await`，所以"A 房间离开、B 房间加入"对其他 socket 不可观察。
- 失败处理：所有拒绝都在第一次 mutation **之前**返回（`registry.ts:344-380`）。

**E9 hydration barrier → room-joined**
- 输入：room 的 `barrier` Promise（冷启动时是 store hydration）。
- 输出：`await barrier` → 重新校验 `peer.isOpen()` 与 `context.activeRoom === room` → 发 `room-joined({documentId, connectionId, peers, role})` → `room.sendExistingAwarenessTo(context)` → `releaseHydrationBacklog(room)`（`ws.ts:445-484`）。
- 负责层：server 传输层。状态归属：房间状态机 `created → hydrating → ready`。
- **异步**，但只延后"确认"，不延后"成员变更"（D-043）。
- 失败处理：hydrate 失败 → 房间 `UNHEALTHY`，所有参与者收 `INTERNAL_ERROR` 并 `1011`；socket 在等待期间关闭/被替换 → 丢弃结果，不发 `room-joined`（`ws.ts:463-467`、`registry.ts:911-936`）。

**E10 room-joined → SyncStep1 + awareness**
- 输入：`room-joined`（含 role）。
- 输出：`joined=true`；`onStatusChange('connected')`；`onRoomJoined`（首次不清远端 awareness，重连才清）；`sendSyncStep1()`；`sendLocalAwareness()`（`sync-provider.ts:337-354`）。
- 负责层：A1。状态归属：`joined/roomRole/networkStatus`。
- 同步（send 立即）。失败处理：`room-joined` 的 `documentId` 与本 provider 不符 → 记 `invalidControlMessage` 并丢弃（R15 防御，`338-343`）。
- 为什么首次不清：服务端在 join 时会补发房间里已有的 awareness；首次清空会把这份 roster 删掉（曾导致 `getCollaborators()` 为空，`document-session.ts:146-156`）。

### 3.3 本地编辑 → 出帧（E11–E14）

**E11 CodeMirror update**
- 输入：一次 `ViewUpdate` 的 `changes`（可能多个）。
- 输出：`onLocalChanges(changes)` 回调（`CollaborativeMarkdownEditor.tsx:200-207` → `codeMirrorSurface.ts`）。
- 负责层：A2 适配器。状态归属：`EditorState`（视图）。
- 同步。失败处理：binding 还是 `null`（view 构造中）时直接 return，避免把 seed 当用户输入（`200-203`）。

**E12 只读闸门 + 写 Y.Text**
- 输入：changes + `readOnly`。
- 输出：`deliverLocalChanges`：只读 → `binding.resync('read-only-role')` 返回 `blocked`；否则 `binding.handleLocalChanges(changes)`（`editorEditability.ts:105-121`）。
- 负责层：A2。状态归属：写入 `Y.Text`。
- 同步。失败处理：只读时**不删** `Y.Doc` 里已有内容，只是把视图重新对齐（`101-103`）。

**E13 一次 transaction**
- 输入：changes。
- 输出：`writeLocalChanges`：`mergeAdjacentChanges` → 从后往前 `delete/insert`，全部在 `target.transact(..., localOrigin)` 一次事务里（`collabTextBinding.ts:176-202`）。
- 负责层：A2 binding + A1 `session.transact`（`document-session.ts:268-272`）。
- 同步：返回时已在 `Y.Text`。
- 失败处理：`destroyed` 或空 changes 直接 return（`199-202`）；offset 由 CodeMirror 保证是"变更前文档"坐标系，倒序应用保证前面的 offset 仍有效。

**E14 Y.Doc update → 二进制帧**
- 输入：`(update: Uint8Array, origin)`。
- 输出：`handleDocumentUpdate`：`!joined` → return；`origin===remoteOrigin` → return；否则 `encodeSyncUpdate(update)` → `sendSyncFrame` → `socket.send`（`sync-provider.ts:446-453`、`489-499`）。
- 负责层：A1。状态归属：`stats.syncFramesOut`。
- 同步（发送调用）。失败处理：socket 非 OPEN 或未 join → 丢弃并计数（`framesBeforeJoin`）；`send` 抛错 → 返回 false，不冒泡（`467-476`）。

### 3.4 服务端：apply → persist → broadcast（E15–E18）

**E15 解码 + 门禁**
- 输入：BINARY 帧 bytes。
- 输出：`ws.on('message', isBinary)`（`ws.ts:587-609`）→ `registry.handleBinaryFrame`（`543-616`）：`decodeBinaryFrame`（16 MiB 上限、最小 2 字节、frameType∈{0,1}、SYNC 内型∈{0,1,2}、截断/尾随字节都拒绝，`binary-frame.ts:47-65`）→ 无房间 → `ROOM_NOT_JOINED`（非致命）→ 找 participant → authz（`canEdit` / `canRead`）→ 生命周期门。
- 负责层：server。状态归属：无（纯路由）。
- 异步。失败处理：解码失败 → `INVALID_BINARY_FRAME` / `FRAME_TOO_LARGE`（致命，关 socket）；authz 失败 → `FORBIDDEN`（非致命，socket 留着）；hydrating 时入 backlog（上限 256 帧 / 8 MiB），溢出 → 房间 `UNHEALTHY` + `INTERNAL_ERROR`（D-050）。

**E16 apply + persist + broadcast**
- 输入：已授权的 `DecodedSyncFrame`。
- 输出：`#submitMutation` 在每文档 `SerialTaskQueue` 里：`room.applySyncPayload(frame)`（`Y.applyUpdate(doc, update, 'insighthub:remote')`，`room.ts:440-448`）→ `await store.append(room.documentId, update)` → `room.broadcastUpdate(update, author)`（`registry.ts:838-859`）。
- 负责层：registry（唯一同时认识 room 与 store 的层）。
- 异步（persist）。状态归属：`DocumentRoom.doc` + SQLite `document_update`。
- 失败处理：apply 返回 null → 什么都不做；persist reject → `#failRoomUnhealthy`（所有参与者 `INTERNAL_ERROR` + `1011`，**不广播**）；`replyToSyncStep1` 返回 true → 只读路径，不进队列。

**E17 对端接收**
- 输入：SYNC 帧。
- 输出：`handleBinaryMessage` → `decodeBinaryFrame` → `readSyncPayload`：`readSyncMessage(decoder, encoder, doc, REMOTE_ORIGIN)`；如有回包，用 `encodeSyncFrame` 补上帧头再发（`sync-provider.ts:384-444`）。
- 负责层：A1。状态归属：`Y.Text`（remote origin）。
- 同步（解析 + apply）。失败处理：解析抛错 → `invalidFrames++`，不 crash；`encoding.length(encoder)===0` → 不回包。

**E18 渲染到 CodeMirror**
- 输入：`Y.Text` 的 `observe` 事件。
- 输出：observer 检查 origin → 检查 `applyingRemote` → `reconcileFromText()`：`text.toString()` vs `surface.getText()` → `singleRangeChange` → `surface.applyDelta([change], REMOTE_SYNC_ORIGIN)`（`collabTextBinding.ts:153-164`、`238-259`）。
- 负责层：A2 binding。状态归属：`EditorState`。
- 同步。失败处理：`hasNonStringContent` → `surface.setText(...)` 整篇重设并回调 `onResync('non-string-content')`。

### 3.5 断网、重连、销毁（E19–E22）

**E19 断网**
- 输入：socket `close`。
- 输出：`handleClose`：`socket=undefined`；`if (joined) leaveRoom()`（清远端 awareness + `onRoomLeft` 让 role 变 null）；`active` 时 `onStatusChange('reconnecting')` 并 `scheduleReconnect()`（`sync-provider.ts:303-310`）。
- 负责层：A1。状态归属：`networkStatus`。
- 异步（backoff 定时器，`1000 * 2^attempt` 上限 10000 ms，`505-516`）。
- 失败处理：`Y.Doc`、IndexedDB、undo 全部**不动**；`disconnect()` 不安排重连（`201-208`）。

**E20 重连**
- 输入：定时器触发。
- 输出：`open()` → `join-room` → `room-joined` → `SyncStep1`（本地 state vector，**已经包含离线期间的编辑**）→ 服务端 `SyncStep2 + SyncStep1` → 客户端 `SyncStep2`（`sync-provider.ts:251-276`、`337-354`、`room.ts:399-423`）。
- 负责层：A1 + server room。
- 异步。失败处理：join 被非致命拒绝 → 最多重试 3 次（间隔 500 ms，`518-535`）；致命错误 → `active=false`、状态 `error`、关 socket，停止重连（`356-367`）。

**E21 销毁**
- 输入：workspace 卸载 / 换文档。
- 输出：`destroy()` 固定顺序：`sessionState='destroyed'` + `roomRole=null` → 移除本地 awareness 并广播 → `syncProvider.destroy()` → `awarenessManager.dispose()`（清 3 s interval 与合并定时器）→ `undoManager.destroy()` → `doc.off` ×2 + `awareness.off` → `persistence.destroy()` → 清 listeners（`document-session.ts:306-329`）。
- 负责层：A1。状态归属：全部释放。
- 同步 + 异步（persistence.destroy 是 Promise，故意不 await）。
- 失败处理：幂等；顺序不能换——awareness 必须在 socket 还可写时移除，否则对端要等 30 s 过期。

**E22 Undo**
- 输入：`Mod-z` / `Mod-Shift-z` / `Mod-y`。
- 输出：keymap 调 `runSessionHistory(readOnly, session, 'undo'|'redo')`（`CollaborativeMarkdownEditor.tsx:254-265`）→ `session.undo()` → `undoManager.undo()`（`document-session.ts:274-280`）。
- 负责层：A1（UndoManager）+ A2（键位）。
- 同步。失败处理：只读时直接 `return true`，不执行 undo（`editorEditability.ts:82-91`）；undo 产生的 `Y.Text` 变更 origin 仍是被跟踪的 origin，所以 observer 不会把它当远端更新，也不会把它重复写回。

---

## 4. 源码定位

固定到 `57a9bee5f2f8d6ff30f2a8373b61328546475183`。

| # | 位置 | Symbol | 职责 | Permalink |
| --- | --- | --- | --- | --- |
| 1 | `apps/web/src/collab/public.ts:63-121` | `useCollaborativeDocument` | 一个文档一个 session；换 id 销毁重建 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/public.ts#L63-L121 |
| 2 | `apps/web/src/collab/internal/document-session.ts:460-565` | `createDocumentSession` | 本地先成立；Y.Doc/Y.Text/Awareness/UndoManager/Persistence 的组装 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L460-L565 |
| 3 | `apps/web/src/collab/internal/document-session.ts:474-475` | `new Y.Doc`, `doc.getText` | 唯一正文容器 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L474-L475 |
| 4 | `apps/web/src/collab/internal/document-session.ts:534-536` | `new Y.UndoManager` | 只跟踪 local + ai | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L534-L536 |
| 5 | `apps/web/src/collab/internal/document-session.ts:306-329` | `destroy` | 五步释放顺序；awareness 先于 socket 关闭 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/document-session.ts#L306-L329 |
| 6 | `apps/web/src/collab/internal/persistence.ts:334-377` | `attachDocumentPersistence` | 挂 `y-indexeddb`；`whenSynced` 是 active 的门 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/persistence.ts#L334-L377 |
| 7 | `apps/web/src/collab/internal/persistence.ts:96-294` | 租约栈 | 处理 getter-only `window.indexedDB` 与并发 session | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/persistence.ts#L96-L294 |
| 8 | `apps/web/src/collab/internal/sync-provider.ts:337-354` | `room-joined` 分支 | 顺序：connected → onRoomJoined → SyncStep1 → 本地 awareness | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/sync-provider.ts#L337-L354 |
| 9 | `apps/web/src/collab/internal/sync-provider.ts:446-453` | `handleDocumentUpdate` | 本地 update → 二进制帧；跳过 remote origin | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/sync-provider.ts#L446-L453 |
| 10 | `apps/web/src/collab/internal/sync-provider.ts:428-444` | `readSyncPayload` | 远端 SYNC 交给 `y-protocols`；回包要补帧头 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/sync-provider.ts#L428-L444 |
| 11 | `apps/web/src/collab/internal/awareness.ts:39` | `AWARENESS_FLUSH_DELAY_MS` | 唯一的时间窗：presence 50 ms 合并 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/collab/internal/awareness.ts#L39 |
| 12 | `apps/web/src/features/editor/collabTextBinding.ts:153-164` | `observer` | 回环防线 1/2：origin + 重入计数 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/collabTextBinding.ts#L153-L164 |
| 13 | `apps/web/src/features/editor/collabTextBinding.ts:176-202` | `writeLocalChanges` | 一次 update = 一个 transaction；倒序应用 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/collabTextBinding.ts#L176-L202 |
| 14 | `apps/web/src/features/editor/collabTextBinding.ts:238-259` | `reconcileFromText` | 远端 → 视图：用 diff 而不是 delta | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/collabTextBinding.ts#L238-L259 |
| 15 | `apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx:245-274` | `EditorState.create`, `new EditorView` | 视图从 `Y.Text` seed；binding 先于 view | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L245-L274 |
| 16 | `apps/server/src/rooms/registry.ts:543-616` | `handleBinaryFrame` | 解码 → 房间 → authz → 生命周期 → dispatch | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/rooms/registry.ts#L543-L616 |
| 17 | `apps/server/src/rooms/registry.ts:814-860` | `#submitMutation` | apply → persist → broadcast（每文档串行） | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/rooms/registry.ts#L814-L860 |
| 18 | `apps/server/src/rooms/room.ts:399-448` | `replyToSyncStep1`, `applySyncPayload` | delta 计算；unwrap 后 apply（remote origin） | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/rooms/room.ts#L399-L448 |
| 19 | `apps/server/src/ws.ts:580-613` | `ws.on('message')` | TEXT/BINARY 分流；binary 只交给 registry | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/server/src/ws.ts#L580-L613 |
| 20 | `packages/shared/src/binary-frame.ts:121-138` | `TRANSACTION_ORIGINS`, `UNDO_TRACKED_ORIGINS` | origin 词表与 undo 白名单 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/packages/shared/src/binary-frame.ts#L121-L138 |

---

## 5. 状态归属表

| State | Owner | 持久化 | 是否 Redux | 生命周期 | 为什么 |
| --- | --- | --- | --- | --- | --- |
| `Y.Doc` | `DocumentSession` | 否（由 IDB + SQLite 各自持有副本的编码） | 否 | session | 一个文档一个 CRDT 实例；重建 = 丢历史 |
| `Y.Text('content')` | `Y.Doc` | 同上 | 否 | 同 doc | 正文唯一权威 |
| 本地 IndexedDB 副本 | `y-indexeddb`（`insighthub-doc:<id>`） | 是 | 否 | 跨 session/刷新/标签页 | 离线与重开的依据 |
| Undo 栈 | `Y.UndoManager` | 否 | 否 | session（destroy 时释放） | 只对 local/ai 生效 |
| 远端 awareness 表 | `y-protocols` `Awareness` | **否** | 否 | 房间 | presence 是瞬时的；持久化会产生幽灵 |
| 本地 awareness 条目 | `AwarenessManager` | **否** | 否 | 房间；destroy 时广播移除 | 同上 |
| `networkStatus` | `SyncProvider` → session getter | 否 | 否 | socket | 高频、只驱动 badge |
| `joined` / `roomRole` | `SyncProvider` / `DocumentSession` | 否 | 否 | 房间（room 结束清空） | 角色属于房间，不属于客户端 |
| `EditorView` / `EditorState` | `CollaborativeMarkdownEditor` ref | 否 | 否 | 每 session 一次 | 视图；含选区与滚动 |
| 远端光标装饰 | CodeMirror `Compartment` | 否 | 否 | view | 由 awareness 派生 |
| 服务端 `DocumentRoom.doc` | `RoomRegistry` | 否（内存中继） | 否 | 房间（空则驱逐） | 转发用副本 |
| 服务端 update log | SQLite `document_update` | 是 | 否 | 永久（compact 后截断） | 崩溃恢复的权威 |
| 服务端 snapshot | SQLite `document` | 是 | 否 | 驱逐时更新 | 加速 hydrate |
| AI proposal | `AiSuggestPanel` | 否 | 否 | 面板 | 待审对象，不是正文 |

**一句话**：真正被持久化的只有两处——浏览器的 Yjs update 副本与服务端的 snapshot+log；其余全是可重建的瞬时状态。

---

## 6. 技术选型（重点）

> 证据边界：编辑器与 CRDT 的选择在 `PROJECT.md:81-105` 是**固定栈**，仓库里没有 Monaco/OT 的对比实验。下表的否定理由是设计理由，不是 benchmark 结论。

| 选择 | 需求 | 候选 | 当前 | 为什么 | 放弃原因 | 代价 |
| --- | --- | --- | --- | --- | --- | --- |
| 编辑器 | 纯文本 Markdown、可被外部文档驱动、可控扩展 | textarea / contenteditable / **Monaco** / CodeMirror 6 | **CodeMirror 6** | `EditorState` + transaction 让"编辑器变更"可精确映射为 Yjs 操作；扩展按需；无 worker | textarea：无高亮/多光标/装饰；contenteditable：DOM 即状态，远端 reconcile 会与用户输入打架；**Monaco 是 ALTERNATIVE，未引入**：IDE 体量 + worker/语言服务模型对单文档过重，且与"轻量 Markdown"不匹配 | 自己写 binding/reconcile/cursor 扩展 |
| CRDT | 并发合并、离线可写、无冲突框 | LWW / **OT** / Automerge / Yjs | **Yjs** | `Y.Text` 可直接绑编辑器；`y-protocols` 是官方 wire；离线即 merge | LWW：整段覆盖（P1）；**OT 是 ALTERNATIVE，未实现**：需中心化 transform + 版本号 + 离线操作排队重放，服务端要存操作历史 | 元数据增长；compaction |
| 线格式 | 两种流量、可互操作、不发明协议 | 自定义 JSON / 自定义二进制 / **y-protocols 编码 + frame header** | **`y-protocols` + `lib0`**（D-015） | SYNC payload 完全由 y-protocols 写读，codec 只加/去 frame-type 头，byte-faithful 有测试 | 自定义 JSON：base64 +33% 与每键 parse；自定义二进制：独占格式、无人能互操作 | 依赖 `y-protocols` 的编码稳定性 |
| 同步方向 | 谁决定"可以开始同步" | 服务端 push / 客户端 SyncStep1 | **客户端发起** | 浏览器知道本地 IDB 何时 load 完；服务端 push 要维护 per-client readiness | 服务端 push：可能把文档推给不渲染的人，且需要额外就绪状态（`ARCHITECTURE.md:124-129`） | 每个新 join 都要一次往返 |
| 本地持久化 | 刷新/断网不丢、不产生第二真相 | localStorage / 自写 IDB / **y-indexeddb** | **`y-indexeddb`** | 存编码后的 update；恢复 = 重放 | localStorage：同步、容量小、只能字符串；自写：要自己做 update 合并与 schema | 全局工厂注入的租约复杂度 |
| Undo | 只撤自己、能撤 AI、不能撤队友 | CodeMirror history / 快照回滚 / **Y.UndoManager** | **`Y.UndoManager(trackedOrigins: local,ai)`** | CRDT 级撤销，天然知道哪些 item 是谁的；与远端 origin 隔离 | CM history：只懂 CM 文档，undo 会与远端更新冲突并写回 CRDT；快照回滚：会撤掉队友（R13 明令禁止） | 500 ms capture window 会合并相邻操作；栈在内存 |
| Presence | 光标/选区/身份，实时但不持久 | 控制面 JSON 消息 / **Yjs awareness** | **awareness** | 同一个 socket、同一套帧；自带 clock 与过期；随房间销毁 | 控制面 presence：会变成第二个通道（D-021 已删除） | 30 s 过期语义；server 要伪装成非参与者 |
| 传输 | 一条连接承载控制 + 数据 | 两条 socket / **一条 socket 双平面** | **一条 socket** | R15：一 socket 一房间，二进制帧无歧义路由；控制面与数据面用 string/binary 天然分流 | 两条 socket：需要两套重连/心跳/房间状态，且难以保证顺序 | 切文档必须销毁重建（不能预打开） |

---

## 7. 关键实现细节

**D1 回环必须用三层，不是一层。**
`editor → Y.Text` 是本地写；`Y.Text → editor` 是远端应用。如果只靠"origin 检查"，`session.undo()` 这类**本地 origin** 的写也会被 observer 当成自己的写而跳过——但 undo 之后编辑器必须跟着变。所以三层是：① origin 检查（跳过"我们自己刚写的"）；② `applyingRemote` 重入计数（跳过"正在应用远端时嵌套产生的事件"）；③ `REMOTE_SYNC_ORIGIN` 派生标记（告诉 surface"这次变更来自真相，不是用户输入"）。缺 ③ 会让 undo 一次后失效并把远端文本记进本地 undo 栈（`collabTextBinding.ts:25-53`、`syncOrigin.ts:1-25`）。

**D2 本地写"立即"，没有队列/防抖。**
`handleLocalChanges` 返回时变更已在 `Y.Text`（`collabTextBinding.ts:72-86`、`199-202`）。队列会让 offset 描述一个已经被远端更新移动过的文档；而"一次 CodeMirror update 内部的多个 change"仍然被合并成**一个** transaction（`mergeAdjacentChanges` + 倒序应用），所以 paste/IME/多光标只产生一帧。**这正是"文本 update 无批量合并"的准确含义**：跨 update 没有时间窗合并。

**D3 远端 reconcile 用 diff，不翻译 `Y.TextEvent.delta`。**
delta 的 offset 在"一次事务包含多个操作"时是 old/new 混合坐标系，手写翻译只在罕见的多操作事务（paste、多光标、远端 merge）上错——也就是最不可能被手测覆盖的情况。所以直接比较 `text.toString()` 与 `surface.getText()`，算**一个**最小单区间变更；一个字符的远端编辑就是一个字符的编辑器变更（`collabTextBinding.ts:213-259`；测试断言见 `textDiff` 相关用例）。代价是每次远端 update 一次字符串比较；远端更新是人的打字速率，可接受。

**D4 origin 是本地语义，不是安全边界。**
四个 origin：`local` / `remote` / `persistence` / `ai`（`binary-frame.ts:121-132`）。`local` 与 `ai` 可被 undo；`remote` 不可；`persistence` 用于标记"启动重放"，避免把历史当成本地新编辑重新广播（`sync-provider.ts:447-452` 会跳过 remote；persistence 的重放在 join 前发生，也不会出帧）。

**D5 UndoManager 的边界。**
`new Y.UndoManager(text, { trackedOrigins: new Set(UNDO_TRACKED_ORIGINS) })`（`document-session.ts:534-536`）。已知行为：默认 `captureTimeout` 500 ms，会把"打完字立刻 Accept"合并成一个 undo item（记录在 D-081 residual 8）。这不是 bug，但也不是"一次操作一次 undo"。

**D6 R15：一 socket 一房间，替换是原子的。**
`SocketContext.activeRoom` 是单字段（类型上不能有两个）；`joinRoom` 全同步，`#detach` 与 `room.add` 之间没有 `await`（`registry.ts:1-30`、`396-406`）；`#detach` 是 leave/disconnect/replace 三条路径**唯一**的转换函数（`1022-1033`）。前端用 `key={activeDocumentId}` 让"换文档 = 卸载 + 重建"（`AppShell.tsx:68`）。

**D7 state vector 让重连是 delta，不是整篇。**
客户端 `SyncStep1(doc)` 发送自己的 vector；服务端 `encodeSyncStep2(doc, peerVector)` 只回缺失部分，再发自己的 `SyncStep1` 拉客户端的离线编辑（`room.ts:399-423`）。单测直接断言这一点：`convergence.test.ts:129` "encodes a reconnect delta, not the document"。

**D8 幂等与乱序：没有 sequence number、没有 per-update ACK。**
`sync-provider.ts:46-51` 明确写了 non-goals：无序号、无 OT、无逐条确认、无业务层去重。Yjs update 本身幂等且与顺序无关，重复/乱序由 CRDT 吸收。这不是"省事"，而是**把正确性交给算法**：`chaos/duplicate-inbound-frames` 注入同一帧三次，文本仍只出现一次（`04-chaos.mjs:109-157`）。

**D9 awareness 的三个易错点。**
① 服务端必须是纯中继：`y-protocols` 构造时会装 3 s 心跳并给自己 `{}` 状态，必须清 `states/meta/clientID` 并停 interval，否则对端看到一个没有名字的协作者（`room.ts:142-165`）；② 重新宣布必须**bump clock**，否则房间会把它当成比"已记录的移除"更旧而丢弃（`sync-provider.ts:229-245`）；③ join 时要把房间里**已有**的 awareness 补给新来者，否则 presence 要等 30 s 续期才可见（`room.ts:517-545`）。

**D10 IndexedDB 的 getter-only 陷阱。**
`lib0/indexeddb` 按裸标识符读全局 `indexedDB`，注入实现只能写全局；但真实浏览器里 `window.indexedDB` 是 getter-only，ES module 是严格模式，直接赋值抛 `TypeError: Cannot set property indexedDB … which has only a getter`——这曾让**所有真实浏览器**打不开文档。修法是 `Object.defineProperty` + 模块级**租约栈 + 每层引用计数**，非 LIFO 销毁也安全；生产路径根本不写这个属性（`persistence.ts:96-294`）。

**D11 一次按键的成本（算力/带宽）。**
本地：一次 transaction（几个 Yjs struct）+ 一次 diff（仅远端路径）；网络：一个 SYNC 帧，大小与"这一次输入"成正比（几十到几百字节），与文档大小无关；服务端：一次 apply + 一次 SQLite append + 一次广播（O(房间人数)）。这就是为什么 100k 文档仍然可用——**没有任何一步是 O(文档大小)**，除了打开时的 hydrate 与驱逐时的 snapshot。

**D12 断线期间的编辑"已经"在 Y.Text 里。**
离线可写不是特殊模式：`Y.Text` 的写入不经过网络，`y-indexeddb` 监听同一个 doc，所以离线输入立刻进本地副本。重连只是把同样的 vector 发出去。**"offline is a first-class state" 的机制含义就是这条**。

---

## 8. 为什么不用 X

- **Monaco**（`RELATED — NOT IMPLEMENTED`）：为 IDE 设计，语言服务/worker 模型与"单文档 Markdown"不匹配；包体与初始化成本都更高。仓库里没有 Monaco 代码，也没有对比数据，所以不能说"Monaco 更慢"。
- **OT**（`ALTERNATIVE — NOT IMPLEMENTED`）：需要中心化 transform、版本号、离线操作队列重放与服务端操作历史。我们要的是"离线可自由编辑、重连 merge"，OT 的 rebase 语义会把复杂度压到服务端与客户端两边。
- **LWW（last-write-wins）**：整段/整篇覆盖，正是 P1 的数据丢失；只在"字段级、可接受丢更新"的场景合理。
- **Automerge**（`NOT IMPLEMENTED`）：同样能解决合并，但没有 `Y.Text` 与 CodeMirror 生态的等价物，迁移成本高；未做 benchmark。
- **y-websocket 客户端库**（`NOT IMPLEMENTED`）：我们复用它的**帧类型约定**（D-015），但自己实现 provider，因为需要 `join-room`/`room-joined`/`role`/冻结错误码这套控制面，以及"一 socket 一房间"的强约束；直接用它会把 socket 所有权交给库。
- **Socket.IO**：自带协议、房间、降级与 ack，会与已冻结的 envelope 重复；`ws` 的 string/binary 分流正是我们要的。
- **服务端 push 同步**：见 §6；需要 per-client readiness，且可能推送没人看的数据。
- **CodeMirror `history()`**：两套 undo 会互相打架；CM history 不知道 CRDT 的远端 item，undo 会把远端文本当本地状态写回。
- **快照式 undo（保存整篇文本再恢复）**：会撤掉队友的编辑（R13 明令禁止），且需要保存全文。
- **localStorage 存正文**：同步 API 阻塞主线程、容量小、只能存字符串——字符串就是第二真相。
- **控制面 presence 消息**：会形成第二个 presence 通道，D-021 已删除；两套 presence 必然出现"列表与光标不一致"。
- **WebRTC / y-webrtc**：星型（client ↔ server room）已经够，P2P 会引入 NAT/信令/权限穿透问题。
- **Service Worker 后台同步**：离线路径靠 IDB + 重连，不需要 SW 队列；引入 SW 会让"离线"多一个缓存层与版本问题。
- **序号 + ACK**：Yjs 不需要；加一层会引入"未确认队列"与重发逻辑，而这些正是 CRDT 已经解决的。

---

## 9. Used in this project 知识点

**K1 CRDT（Conflict-free Replicated Data Type）**
定义：副本可独立更新，合并满足交换/结合/幂等，因此任意顺序收敛。在哪：整个 `Y.Doc`。为什么：离线编辑必须本地先发生。追问："CRDT 会不会越来越大？" 答案：会，墓碑与元数据只增；所以有 snapshot 压缩（驱逐时）。项目答案：我们用 Yjs，不做业务层去重。

**K2 `Y.Text` 与 `Y.TextEvent.delta`**
定义：序列 CRDT；delta 描述一次事务的插入/删除。在哪：`collabTextBinding.ts:238-259`（**故意不用 delta**）。为什么：多操作事务的坐标系是 old/new 混合，手写翻译易错。追问："不用 delta 那你怎么知道改哪？" 答案：比较权威文本与视图文本，算一个最小单区间变更。

**K3 state vector**
定义：clientID → 已知最大 clock。在哪：`SyncStep1`。为什么：delta 传输与"谁缺什么"。追问："它和版本号有什么区别？" 答案：版本号是单一线性序；state vector 是每个 client 一个维度，能表达并发。

**K4 二进制帧与双平面**
定义：`frameType(varUint) + payload`；0=SYNC，1=AWARENESS。在哪：`binary-frame.ts:26-45`。为什么：同一 socket 承载两类流量且不互相污染。追问："为什么不用 JSON 包 Yjs？" 答案：base64 +33%，每键一次 parse。

**K5 transaction origin**
定义：Yjs 事务的来源标记。在哪：`document-session.ts:268-272`、`binary-frame.ts:121-138`。为什么：undo 归属、回环抑制、重放识别。追问："客户端能伪造 origin 吗？" 答案：能，但 origin 不是权限；服务端按 authz 裁决。

**K6 UndoManager 的 trackedOrigins / captureTimeout**
定义：按 origin 过滤的撤销栈；captureTimeout 决定相邻操作是否合并。在哪：`document-session.ts:534-536`。为什么：本地 undo 不能撤队友。追问："500 ms 合并算 bug 吗？" 答案：是已知行为（D-081 residual 8），不跨 local/remote 边界。

**K7 awareness 与 clock**
定义：`y-protocols` 的 presence 协议，每个 client 有 clock，30 s 过期。在哪：`awareness.ts`、`room.ts:495-570`。为什么：光标/选区实时但不需要持久化。追问："为什么服务端不把自己算进去？" 答案：服务端是纯中继，清掉 clientID 并停心跳，否则对端会渲染一个空 `{}` 的参与者。

**K8 IndexedDB 作为 CRDT 副本**
定义：浏览器对象存储；`y-indexeddb` 存 update。在哪：`persistence.ts`。为什么：刷新/断网不丢。追问："多个标签页会互相覆盖吗？" 答案：不会，IDB 是共享的，`indexeddb/D-two-tabs-share-one-replica` 验证两个标签页共享一个副本。

**K9 客户端发起握手**
定义：join 后由客户端发 SyncStep1。在哪：`sync-provider.ts:337-354`。为什么：客户端知道本地是否 load 完。追问："服务端为什么还要发自己的 SyncStep1？" 答案：为了拉客户端的离线编辑（客户端回 SyncStep2）。

**K10 指数退避 + 上限**
定义：`delay = min(base * 2^attempt, max)`。在哪：`sync-provider.ts:505-516`（1000 → 10000 ms）。为什么：避免断网时打爆服务端。追问："会不会永远重连？" 答案：会，直到 `disconnect()`/`destroy()`；致命错误（如版本不匹配）会停止。

**K11 房间基数（R15）**
定义：一条连接最多一个文档房间。在哪：`SocketContext.activeRoom`、`registry.joinRoom`。为什么：二进制帧没有 room id，路由必须无歧义。追问："那两个文档怎么办？" 答案：两个 session / 两个标签页。

**K12 幂等（idempotency）**
定义：同一操作应用多次与一次等价。在哪：Yjs update 语义；`chaos/duplicate-inbound-frames`。为什么：网络会重复。追问："那为什么还需要 codec 的严格校验？" 答案：幂等不等于可以接受畸形帧；截断/尾随字节必须拒绝。

---

## 10. Related but not used

全部是 `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED`。

- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Monaco Editor**：没有依赖、没有对比数据。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Operational Transformation / ShareDB / ot.js**：仓库里没有 OT 实现。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **LWW（last-write-wins）寄存器**：没有使用；会丢并发更新。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Automerge**：没有引入。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **y-websocket 客户端**：只复用帧类型约定，provider 是自己写的。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **y-webrtc / P2P**：没有使用。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **ProseMirror / TipTap / Slate**：正文是纯 Markdown。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Socket.IO**：用原生 `ws`。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **服务端推送式同步 / 服务端发起 SyncStep1**：本项目由客户端发起。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **per-update ACK / sequence number / 重发队列**：明确 non-goal（`sync-provider.ts:46-51`）。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **控制面 presence 消息**：D-021 删除。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **localStorage 正文副本**：没有使用。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **Service Worker / Background Sync**：没有使用。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **CRDT 版本历史 / 时间旅行（snapshot API）**：没有产品化的历史视图。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **多设备同一用户冲突处理**：没有验证，也没有专门逻辑。
- `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED` **服务端渲染协同内容**：明确禁止（`COLLAB_SESSION_CONSTRAINTS`）。

---

## 11. 测试与验证

口径：真实 Chromium（CDP）+ 真实 server + 真实 SQLite + 真实 IndexedDB；串行、无重试、断言失败即进程非 0。**本次报告未重跑**；"raw result" 是仓库记录的运行结果。

| # | Given / When / Then | test file · scenario | 拓扑 | 注入 | raw result（记录值） |
| --- | --- | --- | --- | --- | --- |
| T1 | **Given** 两个**完全独立**的 browser context（各自 cookie jar/localStorage/IndexedDB）与两个身份 **When** 同时做 insert / 尾部 insert / 20×Backspace / 选词替换 **Then** A 文本 = B 文本 = 服务端见证者文本（56 字符），且三方 `sha256(Y.encodeStateVector)` 相等 | `tests/browser/suite/08-evidence-gate.mjs:251` · `collab/independent-contexts` | 2 个 `Target.createBrowserContext` + 1 个 `WireOracle`（独立 Yjs 客户端作服务端见证） | 并发键事件（`Promise.all`）；不注入网络故障 | 编辑窗口重叠 111 ms / 249 ms；最终 56 字符；digest `bda0ea9c…`，19 B，3 clients；编辑器未重挂载 |
| T2 | **Given** 客户端已收到一条 Yjs update **When** 把**同一字节帧**注入 3 次 **Then** 文本只含该变更一次，`editorMounts` 不变，无错误风暴 | `tests/browser/suite/04-chaos.mjs:109` · `chaos/duplicate-inbound-frames` | 真实页面 + oracle peer | `injectInbound(base64, 3)`（CDP 注入入站二进制帧） | 文本 = `duplicate-baseline\|`；viewId 不变；`errors === 0` |
| T3 | **Given** 已连接页面 **When** 真实断网（旧 socket 断开、新连接改写到不可达端口）+ 对端在离线期间追加 **Then** 页面自愈重连、收敛到含离线期编辑的文本、不重挂编辑器、不出现幽灵协作者 | `tests/browser/suite/04-chaos.mjs:37` · `chaos/offline-reconnect` | 页面 + oracle peer | `setOffline(true/false)` + 连接重写；sleep 1 s 断网窗口 | 状态经历 reconnecting/offline/error → `connected`；文本含 `WHILE-AWAY\|`；`viewId` 不变；collaborators ≤ 1 |
| T4 | **Given** 后端已停止 **When** 刷新页面 **Then** 文本从真实 IndexedDB 恢复（不是从服务端），连接 badge 不谎报 connected，且仍可继续输入 | `tests/browser/suite/01-persistence.mjs:41` · `indexeddb/A-reload-without-backend` | 真实浏览器 + 真实 SQLite；`stack.stopServer()` | 停进程；不做网络层 mock | `updates.sample.firstRecordType === 'binary'`；count ≥1；恢复文本含 marker；status ≠ connected；离线再输入成功 |
| T5 | **Given** 在线输入过一段 **When** 断网后输入，再**在仍离线时关页重开** **Then** 两段都在 | `tests/browser/suite/01-persistence.mjs:132` · `indexeddb/B-offline-edits-survive-reopen` | 同上 | `setOffline` + reload（重开前重新武装 offline） | 两个 marker 都在；重开前记录 `updates` 数量 |
| T6 | **Given** 离线编辑 **When** 恢复网络但不刷新 **Then** 双方收敛 | `tests/browser/suite/01-persistence.mjs:193` · `indexeddb/C-offline-then-reconnect-converges` | 同上 | `setOffline(false)` | 收敛（无 reload） |
| T7 | **Given** 同一 profile 两个标签页 **When** 各自输入 **Then** 共享一个副本并收敛 | `tests/browser/suite/01-persistence.mjs:282` · `indexeddb/D-two-tabs-share-one-replica` | 同 profile 两 tab | 无 | 同一 `insighthub-doc:<id>` 副本、两 tab 文本一致；默认套件 PASS（78/78 @ `7585263` 记录，本报告未重跑） |
| T8 | **Given** 一次 update 已提交到磁盘 **When** 真实 kill 服务端进程、同 data dir 起新进程 **Then** 磁盘上仍有该文本；新 PID ≠ 旧 PID；全新 browser profile 也能读到 | `tests/browser/suite/10-m2-durability.mjs:220` · `m2/B-real-process-restart` | 真实进程 kill + 同目录重启 + 全新 browser context | 杀进程（非 mock）；先等 `updateRows >= 1` | 崩溃前 `updateRows >= 1`；kill 后**不经过 server** 直读磁盘包含 marker；`pidAfter !== pidBefore`；新设备读到 marker |
| T9 | **Given** 离线客户端已写一段 **When** 服务端真实重启后客户端重连 **Then** 两侧收敛；且离线编辑在重连前**不在** durable store 里 | `tests/browser/suite/10-m2-durability.mjs:275` · `m2/C-offline-client-survives-restart` | 进程重启 + 离线客户端 | kill/restart；**out-of-band 续 session**（`renewBrowserSession`） | 重启前 store 含 online marker、**不含** offline marker；`pidAfter !== pidBefore`；续 session 后收敛。**不证明**客户端能自己重建 session（residual `p2/S`） |
| T10 | **Given** 本地先输入 **When** 远端 peer 追加 `REMOTE-BASE`/`REMOTE-TAIL` 后本地按 `Mod-z` **Then** 远端文本仍在，只撤本地那次 | `tests/browser/suite/03-realtime.mjs:330` · `realtime/local-undo-does-not-revert-remote-text` | 页面 + 远端 peer | 键盘事件 `Mod-z` | 文本仍含 `REMOTE-TAIL` 与 `REMOTE-BASE` |

Node 级补充（不是浏览器证据）：`convergence.test.ts:53`（重复 update 是 no-op）、`:73`（乱序收敛）、`:129`（重连只编码 delta）、`undo-redo.test.ts:29`（只撤本地）、`:77`（AI 编辑可撤）、`persistence.test.ts:56/127`（重放不重复）、`:219`（getter-only 全局可打开）、`:462`（非 LIFO 销毁）、`:531`（构造失败回滚）、`:575`（生产路径不写全局）。

**证伪边界**：T1–T10 证明两个 context 的收敛、离线重开、幂等、乱序、重启恢复与 undo 隔离；**不证明** 3+ 并发、30 s 断网、跨浏览器、重连 SLO。

---

## 12. 性能数据定义

| 指标 | 起点 → 终点 | n | min / p50 / p95 / max | cold/warm | 环境 | 原始文件 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WS 重连（restore→connected） | 恢复网络（`setOffline(false)`）→ 页面 `connection-status=connected` | **9** | 753 / **763** / **770** / 770 ms | **warm**（同页同 `Y.Doc`，只重建 socket；250 ms 断网窗口） | 本地 production build（built server + built web，Express static，无 Vite） | `tests/perf/results/perf-production-multiround.json` → `aggregate.reconnectRestoreMs` | MEASURED |
| WS 重连（offline→connected） | 进入 offline → `connected` | 9 | 1014 / 1024 / 1033 / 1033 ms | warm | 同上 | 同上 → `aggregate.reconnectOfflineMs` | MEASURED（诊断值） |
| 编辑器 ready | 导航开始 → `.cm-editor` 可用（100k fixture） | 3 | 632 / 654 / **680** / 680 ms | **cold** | 同上 | 同上 → `aggregate.readyMs` | MEASURED（属于大文档报告） |
| 输入延迟 | `beforeinput` → editor transaction 完成 | 900 | 246 / 268.8 / 371.3 / 511.4 ms | warm | 同上 | 同上 → `aggregate.inputModelMs` | MEASURED，**不在简历句里** |
| 30 s 断网恢复 | 30 s outage → connected | — | — | — | — | — | **NOT MEASURED** |
| 3+ 用户收敛时间 | 3 clients 并发 → 收敛 | — | — | — | — | — | **NOT MEASURED** |
| 多设备冲突 | 同一账号两台设备并发 | — | — | — | — | — | **NOT MEASURED**（没有该场景，也没有专门逻辑） |

定义细节：
- **reconnect restore 的起止**：perf 仪器把"恢复网络/恢复 socket"作为起点，把 `connection-status` 变为 `connected` 作为终点；**不含**用户重新打字的输入延迟。
- **n=9 的来源**：3 个独立 perf 进程 × 每进程 3 次 reconnect（`sampleCounts.reconnect=9`）。p95 是 nearest-rank，n=9 时接近最大值。
- **cold/warm**：ready 是 cold（新页面/新进程）；reconnect 是 warm（`Y.Doc`、IndexedDB、undo 都在，只换 socket）。
- **环境**：Windows 11 10.0.26200 x64、i5-1340P、15.7 GiB、Node v22.14.0、Chrome **155.0.8059.85 headless**；fixture 100k 行 / 6,788,895 字符 / sha256 `0d12688d…`。
- **不是线上**：没有 TLS/Clerk/Render；**不得**写成 "production P95"；**没有优化前后对比**，dev-server 的差异是 serving path 差异。

---

## 13. 边界与 limitation

| # | Limitation | 事实 | 面试怎么答 |
| --- | --- | --- | --- |
| L1 | 只有**两个用户** | 两个独立 context / 两个身份；3+ NOT VERIFIED | "我验证的是两个独立 profile 的并发编辑，三方文本与 state-vector 摘要相等；三人以上我没测，所以只说双用户。" |
| L2 | 断网窗口 **1–2 s**，30 s 未测 | `chaos/offline-reconnect` sleep 1 s；perf 250 ms | "长断网我没测；离线数据在 IndexedDB 里，理论上多久都能恢复，但我不拿'30 秒不丢'当结论。" |
| L3 | **多设备冲突未测** | 同一用户两台设备并发没有场景，也没有专门逻辑 | "同一账号多设备我没测；现在的模型是多客户端 CRDT，但我不会说它已验证。" |
| L4 | 只有 Chromium | Chrome 155 headless；Firefox/Safari 无证据 | "浏览器证据只有 Chromium 155 headless。" |
| L5 | 服务端重启后客户端不自动重建 session | `m2/C` 需要 out-of-band 续 session（记录在案） | "服务端重启是单独场景：客户端会自动重连，但 session 续期是 out-of-band 的，这一点我明确说。" |
| L6 | undo 会合并相邻操作 | `captureTimeout` 500 ms；"打字 + 立刻 Accept"可能是一个 undo item | "这是 `UndoManager` 的已知行为，不跨 local/remote 边界，但不是'一次操作一次撤销'。" |
| L7 | 没有 per-update ACK | 无序号、无重发队列；正确性靠 CRDT 幂等 | "我不需要逐条 ACK；Yjs update 幂等且顺序无关，重复/乱序由 CRDT 吸收。" |
| L8 | 元数据会增长 | 墓碑/struct 只增；靠驱逐时 snapshot 压缩（阈值 200 行或 1 MB） | "CRDT 元数据会涨，所以有 snapshot + log 与驱逐时 compaction。" |
| L9 | 无 CRDT 历史/时间旅行 | 没有产品化历史视图 | "没有版本历史功能；snapshot 只用于恢复，不暴露给用户。" |
| L10 | presence 30 s 过期语义 | 依赖 `y-protocols` 续期；destroy 时才主动移除 | "离开是靠显式移除广播 + 30 秒过期兜底；不持久化 presence。" |

---

## 14. 高频追问（全部绑定本项目）

**Q1 为什么正文一定要在 `Y.Text`，不能放 Redux？**
两个原因：正确性与性能。正确性上，镜像副本会与 CRDT 漂移，漂移后一方任意获胜，远端编辑被覆盖、undo 不安全；性能上，100k 文档每键重渲染所有订阅者不可接受。实测 300 次输入后 Redux 只有 241 B，keys 是 `connection/document/realtime`。

**Q2 一次按键到底走了哪些步骤？**
`ViewUpdate.changes` → `onLocalChanges` → `deliverLocalChanges`（只读闸门）→ `handleLocalChanges` → `writeLocalChanges`（一个 Yjs transaction，倒序应用）→ `Y.Text` → `Y.Doc 'update'` → `handleDocumentUpdate` → `encodeSyncUpdate` → socket 二进制帧。服务端 apply → persist → broadcast；对端 `readSyncMessage` → `Y.Text` → observer → `reconcileFromText` → `surface.applyDelta`。

**Q3 为什么本地写不排队？**
排队会让"编辑器显示 X"与"文档包含 X"脱钩，而队列里的 offset 描述的是一个远端更新可能已经改过的文档版本。立即写还有一个好处：`y-indexeddb` 立刻能看到这个 update，所以离线/关页都不丢。"批量"只发生在一次 update 内部的多个 change。

**Q4 远端更新为什么不用 `Y.TextEvent.delta`？**
delta 的 offset 在"一个事务多个操作"时是 old/new 混合坐标系；手写翻译只在 paste/多光标/远端 merge 这种罕见组合上错。直接比字符串、算一个最小单区间变更，对任何 delta 形状都正确，而且仍是一次编辑器 transaction。

**Q5 回环是怎么断的？**
三层：origin 检查（本地写不重放）、`applyingRemote` 重入计数（应用远端期间的嵌套事件跳过）、`REMOTE_SYNC_ORIGIN` 派生标记（surface 知道这次变更来自真相）。缺第三层时，`undo` 会让编辑器把刚撤销的文本当成"用户输入"再写回去，表现为 undo 只生效一次。

**Q6 远端 undo 为什么不会撤掉队友的字？**
`UndoManager` 只跟踪 `local` 与 `ai` 两个 origin；远端 update 用 `insighthub:remote` 应用，不在栈里。测试 `realtime/local-undo-does-not-revert-remote-text` 直接验证：undo 后 `REMOTE-TAIL`/`REMOTE-BASE` 仍在。

**Q7 重连为什么不用重传整篇？**
客户端发 `SyncStep1`（自己的 state vector），服务端用 `encodeSyncStep2(doc, peerVector)` 只回缺失的 struct；单测 `convergence.test.ts:129` 的名字就是 "encodes a reconnect delta, not the document"。

**Q8 重复帧/乱序帧怎么办？**
不管。Yjs update 幂等且与顺序无关；`sync-provider.ts:46-51` 明确不做序号/ACK/业务去重。浏览器场景把同一帧注入三次，文本只出现一次。

**Q9 为什么一 socket 只能一个房间？**
二进制帧里没有 room id（帧格式是 `frameType + payload`），路由必须无歧义。所以 `activeRoom` 是单字段，`joinRoom` 全同步，第二个 `join-room` 是原子替换。切文档在前端就是 `key` 变化 → 销毁重建。

**Q10 断网时 socket 关了，为什么编辑器还能用？**
`Y.Doc`、IndexedDB 副本、undo 栈都不依赖 socket；`disconnect()` 只关网络半部（`sync-provider.ts:201-208`）。`session.state==='active'` 在本地 load 完就成立，不等网络。

**Q11 打开文档时先连网还是先读本地？**
先读本地：`await persistence.whenSynced` 之后才 `markActive()`，然后才 `startNetwork()`。所以"离线打开"是正常状态，不是降级。

**Q12 IndexedDB 里存的是什么？**
编码后的 Yjs update（二进制），不是 Markdown 字符串。测试 `indexeddb/A` 断言 `firstRecordType === 'binary'`。存字符串会变成第二真相，并丢掉 client id/时钟/墓碑。

**Q13 为什么需要在全局上装 `indexedDB`？**
`lib0/indexeddb` 按裸标识符读全局，注入实现只能写全局。但浏览器里 `window.indexedDB` 是 getter-only，直接赋值在严格模式抛错（曾让真实浏览器全部打不开）。所以用 `defineProperty` + 租约栈 + 引用计数；生产路径根本不写。

**Q14 presence 为什么服务端不算一个参与者？**
`y-protocols` 的 `Awareness` 构造时给服务端自己一个 `{}` 状态并每 3 s 重发；不清掉的话对端会看到一个没有 `user` 的协作者，列表与计数永远对不上。所以清 `states/meta/clientID` 并停 interval。

**Q15 重连后为什么协作者没丢/没重复？**
join 时服务端会把房间里已有的 awareness 编码后补发给新来者（`room.sendExistingAwarenessTo`）；客户端**首次** join 不清远端表（否则会把这份 roster 删掉），只有重连才清。`chaos/offline-reconnect` 断言 collaborators ≤ 1。

**Q16 为什么没有 per-update ACK 也能保证不丢？**
"不丢"由两件事保证：① 本地写入先于网络，且 IndexedDB 持久化；② 重连时用 state vector 补齐。服务端在广播前 `await store.append`，所以"客户端看到"意味着"服务端已持久化"。ACK 只会增加一层状态，不增加保证。

**Q17 100k 文档为什么还能编辑？**
链路上没有一步是 O(文档大小)：本地一次 transaction、一个与输入大小成正比的帧、服务端一次 append + 广播。O(文档大小) 只出现在打开时的 hydrate 与驱逐时的 snapshot；而输入延迟实测 p95 371 ms 的主因是 Markdown inline parser（fixture 是 10 万行单段落），不是 CRDT。

**Q18 如果要支持三个以上用户，你先改哪里？**
先加证据：三个独立 context 并发，看收敛与 presence 上限；再看 room 广播 O(n) 与 awareness 每帧 client 上限（512）；容量/背压是下一步。当前代码没有"两人"的硬限制，限制在验证范围。

---

## 15. 技术决策复盘

| Problem | Candidates | Selected | Why | Trade-off |
| --- | --- | --- | --- | --- |
| 并发合并 | 整篇保存 / LWW / OT / CRDT | Yjs CRDT | 离线可编辑、重连 merge、无中心 transform | 元数据增长、需 compaction |
| 编辑器桥接 | 受控组件 / 命令式 binding | 命令式 binding（一次/session） | 避免重渲染重建 observer；精确控制 apply | 自己写 reconcile/cursor |
| 远端渲染 | 翻译 delta / diff 权威文本 | diff 单区间 | 对任何 delta 形状都正确 | 每次远端 update 一次比较 |
| 线格式 | JSON / 自定义二进制 / y-protocols | y-protocols + frame header | 官方编码、可互操作 | 依赖 y-protocols 稳定性 |
| 同步方向 | 服务端 push / 客户端 step1 | 客户端 step1 | 本地就绪由客户端知道 | 每次 join 一次往返 |
| 本地持久化 | localStorage / 自写 / y-indexeddb | y-indexeddb | 存 update，恢复即重放 | 全局工厂租约 |
| Undo | CM history / 快照 / UndoManager | UndoManager(local,ai) | 只撤自己、能撤 AI | 500 ms 合并 |
| Presence | 控制面消息 / awareness | awareness | 同 socket、同协议、随房间销毁 | 30 s 过期；server 伪装 |
| 房间基数 | 多房间 / 一房间 | 一房间 | 二进制帧可无歧义路由 | 切文档必须重建 |

---

## 16. 三版口述

### 30 秒

"协同这块的核心是单源：正文只在 `Y.Text` 里，CodeMirror 只是它的视图。敲一个字符，binding 立刻在一次 Yjs transaction 里写进 `Y.Text`，`Y.Doc` 的 update 事件把它编码成二进制帧发服务端；服务端按 apply → persist → broadcast 走。离线时本地先写、IndexedDB 存 update，重连用 state vector 只补差量。Undo 只撤 local/ai，不撤队友。"

### 90 秒

"这个功能要解的是'两个人 + 不可靠网络 + 会刷新的浏览器'：并发覆盖、断网丢字、重复/乱序帧、重连传整篇、undo 撤到队友。

实现上，打开文档先建 `Y.Doc` 和 `Y.Text('content')`，挂 IndexedDB 并等 `whenSynced`，这时 session 就 `active`、编辑器可用，然后才连 WebSocket。连接后客户端发 `SyncStep1`，服务端回 `SyncStep2 + SyncStep1`，是 delta 不是整篇。

本地编辑走 CodeMirror 的 changes → 只读闸门 → binding → 一次事务写 `Y.Text`。远端更新到达时，observer 用 origin + 重入计数 + 派生标记三层防回环，然后用'权威文本 vs 视图文本'的 diff 做一次最小变更，不翻译 Yjs delta。

服务端不是收到就广播：先 apply、再写 SQLite、最后才 broadcast；写失败就把房间标 unhealthy 并断开所有人，绝不让客户端看到恢复不了的状态。

证据是两个完全独立的 browser context、两个身份，并发 insert/delete/replace，最终 A=B=服务端三方文本逐字相等，state-vector 摘要也相等。边界：只有两个用户、断网窗口 1–2 秒、30 秒和多设备没测。"

### 3 分钟

"先把问题说清楚。协同编辑器不是'把 WebSocket 接上'，它要解 8 个失效：并发覆盖、断网不能写、刷新丢稿、重复帧打重、乱序分叉、重连传整篇、undo 撤队友、一条连接挂两个文档。

我的选择是 CRDT 而不是 OT，因为 OT 需要中心化 transform 和离线操作重放，而 CRDT 允许离线自由编辑、重连只是 merge。

数据流是这样的：打开文档 → `new Y.Doc()` + `getText('content')` → 挂 `y-indexeddb` → `await whenSynced` → 标 `active`（编辑器可用，不等网络）→ 连 WS → `join-room` → 服务端 hydrate 完才发 `room-joined(role)` → 客户端发 `SyncStep1`。

本地编辑：CodeMirror 的 `ViewUpdate.changes` 先过只读闸门，再交给 binding；binding 把一次 update 里的多个 change 合并、倒序应用，在**一个** Yjs transaction 里写进 `Y.Text`。返回时已经在 CRDT 里，没有队列——这是刻意的，排队会让 offset 描述一个已经变过的文档。

出帧：`Y.Doc` 的 update 事件 → 跳过未 join 和 remote origin → `encodeSyncUpdate` → 二进制帧。整个帧格式是 `frameType + payload`，0=SYNC，1=AWARENESS；SYNC 的编码完全交给 y-protocols，我们不发明协议。

服务端：解码 → 找房间 → authz → 生命周期门 → dispatch。`SyncStep1` 只读，直接回 delta；`SyncStep2/Update` 进每文档串行队列：apply、`await store.append`、broadcast。持久化失败就 fail room，绝不广播。

远端应用：客户端把 SYNC payload 交给 `readSyncMessage`，origin 是 `remote`；`Y.Text` 的 observer 发现不是本地 origin，就走 `reconcileFromText`：拿权威字符串和编辑器字符串算一个最小变更。为什么不 delta？因为多操作事务的坐标系是混合的，手写翻译只在 paste/多光标这种罕见情况错。

离线：IndexedDB 存的是编码后的 Yjs update，不是 Markdown 字符串。所以断网、关页、离线重开都还在；重连时客户端发 state vector，服务端只补缺失的 struct。

Undo：`Y.UndoManager` 只跟踪 local 和 ai；远端更新不在栈里，所以本地 undo 撤不到队友。

房间基数：一条 socket 最多一个房间，`activeRoom` 是单字段，`joinRoom` 全同步，第二个 join 是原子替换；前端用 `key={activeDocumentId}` 表达'换文档=销毁重建'。

边界我也明确：两个独立 context、断网 1–2 秒、30 秒和多设备没测、浏览器只有 Chromium、服务端重启后客户端不会自动重建 session。"

---

## 17. ASCII 白板图（与真实链路一致）

```text
[CodeMirror EditorView]                        （视图；无 value prop）
      │ 1. ViewUpdate.changes
      ▼
[codeMirrorSurface.onLocalChanges]
      │ 2.
      ▼
[deliverLocalChanges]  ── readOnly? ──yes──► binding.resync()  （视图回到真相）
      │ no                                        （不写 Y.Text）
      ▼ 3.
[collabTextBinding.handleLocalChanges]
      └─► writeLocalChanges: merge → 倒序 delete/insert，ONE transaction
              │ 4. session.transact(fn, 'insighthub:local')
              ▼
        ┌──────────────────────────────┐
        │ Y.Doc  /  Y.Text('content')  │◄──────────── 唯一正文权威
        └──────────────────────────────┘
           │ 5a. doc.on('update')            │ 5b. observe(event, tr)
           ▼                                 ▼
   [SyncProvider.handleDocumentUpdate]   [binding observer]
     skip !joined / origin==remote         origin==local? → return
           │ 6. encodeSyncUpdate            applyingRemote>0? → return
           ▼                                 │ 7. reconcileFromText()
     socket.send(Uint8Array)                 │    text.toString() vs surface
           │                                 │    singleRangeChange → applyDelta
           │ TEXT = JSON 控制                │    (REMOTE_SYNC_ORIGIN)
           │ BINARY = frameType+payload      ▼
           ▼                          [EditorView 更新，不写回 Redux]
┌──────────────────────── server ────────────────────────┐
│ ws.on('message', isBinary)                              │
│   ├─ TEXT → handleControlFrame → join-room / leave-room │
│   └─ BINARY → registry.handleBinaryFrame                │
│                 ├─ decodeBinaryFrame（16 MiB/最小 2B/   │
│                 │   frameType∈{0,1}/内型/截断/尾随）      │
│                 ├─ activeRoom? ──no──► ROOM_NOT_JOINED  │
│                 ├─ authz：canRead / canEdit             │
│                 ├─ hydrating? → backlog(256 帧/8 MiB)    │
│                 └─ dispatch                             │
│                      ├─ SyncStep1 → replyToSyncStep1     │
│                      │    send SyncStep2(doc, peerVector)│
│                      │    + SyncStep1(doc)               │
│                      └─ SyncStep2/Update                 │
│                           → 每文档 SerialTaskQueue        │
│                             1) apply  (Y.applyUpdate,    │
│                                       origin=remote)     │
│                             2) await store.append(...)   │
│                             3) broadcast(update, except)│
│                           persist 失败 → UNHEALTHY       │
│                                        → INTERNAL_ERROR  │
│                                        → close 1011      │
│                                                          │
│ DocumentRoom(Y.Doc)  ──►  SqliteDocumentStore            │
│   awareness（纯中继，server 无 clientID）  snapshot+log     │
└──────────────────────────────────────────────────────────┘

断网/重连（Path 1 不动）：
  close → Y.Doc / IDB / undo 全保留 → backoff(1s→10s) → join-room
        → room-joined → SyncStep1(本地 vector，含离线编辑)
        → SyncStep2(缺失) + SyncStep1 → SyncStep2(我的离线编辑) → 收敛

打开顺序（frozen）：
  new Y.Doc → attach y-indexeddb → await whenSynced → active（可编辑）
  → connect → join-room → room-joined → SyncStep1 → SyncStep2 ×2 → converged
```

图里四个容易讲错的点：① 本地写先于网络、且不排队；② 远端渲染用 diff，不用 delta；③ 服务端 broadcast 在 persist 之后；④ 重连不重建 `Y.Doc`/IDB/undo。

---

## 18. 记忆点

1. **单源 + 两条独立路径**：正文只在 `Y.Text`；Path 1（IndexedDB）管持久，Path 2（WebSocket）管收敛，任一可断。
2. **一次按键 = 一个 transaction = 一个二进制帧**；跨 update 没有时间窗合并，只有 awareness 有 50 ms 合并。
3. **服务端顺序是 apply → persist → broadcast**；持久化失败宁可不广播并断开，也不让客户端看到恢复不了的状态。
4. **三层防回环 + diff 式 reconcile**：origin / 重入计数 / 派生标记；远端用"权威 vs 视图"的最小单区间变更。
5. **必须主动说的边界**：两个用户、1–2 s 断网、30 s 与多设备未测、重连 770 ms 是本地 production build 的 warm 值。
