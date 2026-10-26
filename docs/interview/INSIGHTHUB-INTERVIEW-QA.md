# InsightHub 面试问答（按简历亮点，压力面版本）

> 依据：`docs/resume-evidence/`（证据包，pin `874f107`）+ `docs/agent-governance/` 实测数据 +
> 当前代码。先看第 0 节：**简历里 4 处措辞与事实不符，必须先改**，否则任何追问都会穿。

---

## 0. 先说穿：简历与事实的 4 处偏差

| 简历原文 | 事实 | 处理 |
| --- | --- | --- |
| `React 18` | `apps/web/package.json` 是 **React 19**（`^19.0.0`） | 改成 React 19；被问到 19 的差异要能答（Actions/`use`、ref as prop、Compiler 可选） |
| “针对 AI **流式响应增量更新渲染**内容” | **没有流式**。AI 是一次 `POST /api/ai/suggest`，服务端返回完整 `AiSuggestionDraft`；UI 在等待期只有 `generating` 状态 | 删掉“流式/增量”；改为“生成期 pending/error 状态 + 完整 draft 校验后渲染” |
| “对远端协作更新进行**批量合并与防抖**” | Yjs 文本更新在 `doc.on('update')` 里**逐条**发（`sync-provider.ts:446-453`）；只有 **awareness 50ms 合并**（`awareness.ts:39`） | 改成“presence 50ms 合并；文本更新按 Yjs 增量逐条发送，依赖 CRDT 幂等/无序” |
| “权限模块 `React.lazy` 代码拆分” | `ClerkRoot` 确实 lazy（`App.tsx:76-80`），但**权限判定本身在主包** | 说“Clerk 认证壳 lazy”，不要说权限模块整体 lazy |

B3 的 P95 还要加限定词：**本地 production build**（built server + built web、无 TLS/Clerk/Render），
不是 production P95。

---

## 1. 业务场景

**Q1. 这个产品到底解决谁的什么问题？为什么不是“又一个笔记软件”？**
A：目标用户是 5–50 人团队里需要共同维护同一份 Markdown 的人（需求文档、运行手册、会议纪要）。
差异不在编辑器功能，而在**同一份正文的多人并发 + 权限分级 + AI 只提建议不直接改**。V1 的闭环是：
Clerk 登录 → 文档目录 → 进入房间 → CodeMirror 编辑/预览 → 角色决定能否写 → AI 生成建议 → Diff →
Accept 才写入。没有评论、没有搜索、没有 WYSIWYG，这是刻意收窄的 V1。

**Q2. 为什么先做协同再做 AI？反过来行不行？**
A：AI 的 Accept 必须落在 Yjs 事务里，并且要能撤销、要不破坏远端编辑。如果先做 AI，就得先发明一套
正文状态和撤销模型，之后接协同会推翻它。先把 `Y.Text` 定为唯一 truth、把 undo origin 隔离好，
AI 只是一类新的 transaction origin。

**Q3. 这个项目的“不能做”清单是什么？为什么？**
A：评论、搜索、WYSIWYG、多区域/HA、K8s/Redis/Postgres。V1 是单实例 Render + 单区域 + 持久盘，
允许短暂停机；引入这些会把“可部署”变成“要运维一个平台”，与一个人的交付能力不匹配。

---

## 2. 多人协同与离线恢复

**Q1. 输入一个字符，完整调用链是什么？**
A：`EditorView` 的 `dispatch` → `collabTextBinding` 把 CodeMirror transaction 映射成 `Y.Text`
的 insert/delete（同一事务、在调用返回前写完）→ `Y.Doc` 产生 update →
`sync-provider` 的 `doc.on('update')` 把它编码成 binary SYNC frame（`encodeSyncUpdate`）→
WebSocket 二进制帧 → 服务端 `room.ts` 的 `applySyncPayload` 应用到房间 `Y.Doc` → 持久化
（`store.append`，带 sequence）→ 广播给房间内其他连接 → 对端 `applyUpdate`，绑定层把 Y.Text
变化映射回 EditorView。控制面（join-room、错误、角色）走 TEXT JSON，数据面走 BINARY，两者不混。

**Q2. 为什么用 CRDT 而不是 OT？**
A：OT 需要中心化的 transform 与严格顺序，服务端要理解每个操作的语义；CRDT 的 update 幂等、无序、
可重复应用，断线重连只要交换 state vector 就能补齐。代价是元数据膨胀和“按字符 tombstone”，
对我们这种单文档、几十人规模可接受。OT 更适合强中心、低延迟、超大并发的场景。

**Q3. 重复帧、乱序帧怎么办？**
A：Yjs update 幂等且可交换，重复 apply 不会改变状态；乱序也能收敛。测试
`chaos/duplicate-inbound-frames` 直接重放捕获的二进制帧，断言最终文本一致；服务端不做业务层去重，
因为 CRDT 已经保证。真正要防的是“同一 socket 两个房间”，这靠 R15：`join-room` 原子替换。

**Q4. 断网时输入会不会丢？重连怎么收敛？**
A：不会丢。编辑先落本地 `Y.Doc`，`y-indexeddb` 持久化；WS 断了只是不同步。重连后
`SyncStep1`（本地 state vector）→ 服务端回 `SyncStep2`（缺失的 update），双向补齐。
实测断网窗口 1–2s；30s 断网**没有测**，这是 limitation。服务端重启时，客户端 session 走带外补发
重新建立，不依赖旧 socket。

**Q5. 为什么 IndexedDB 不是“缓存”而是正文副本？冲突怎么办？**
A：它是本地 Y.Doc 的持久化，不是文本快照。离线编辑产生的是正常的 Yjs update，重连后与服务端
update 做 CRDT 合并，不需要“谁覆盖谁”。如果用文本快照，就必须有冲突解决策略，那才会丢数据。

**Q6. Undo 为什么不会撤销别人的编辑？**
A：`Y.UndoManager` 只跟踪指定 origin 的事务：本地输入、AI accept 等（`UNDO_TRACKED_ORIGINS`）；
远端 update 用 `remoteOrigin` 应用，不在 tracked 集合里，所以 undo 不会回滚别人的字符。
测试 `realtime/local-undo-does-not-revert-remote-text` 先让远端插入，再本地 undo，断言远端文本仍在。
没有用“文本快照恢复”，因为那会破坏并发结构。

**Q7. 两个人同时在同一位置输入会怎样？**
A：Yjs 用 client id + clock 决定顺序，双方最终看到相同顺序；不会出现“丢一个字符”。
测试 `collab/independent-contexts` 用两个独立 browser context（独立 storage、独立 session），
最终 A = B = server，并用 state-vector sha256 做 digest 比对。**只验证了两个用户**，3+ 未验证。

**Q8. 为什么一个 socket 只能一个房间？**
A：二进制帧没有文档 id，靠连接绑定房间才能无歧义路由。允许两个房间会让“这条 update 属于谁”
变成猜测。所以 `join-room` 到另一个文档是原子替换：旧房间离开、新房间加入，期间的帧明确拒绝。

**Q9. 服务端怎么保证不丢更新？**
A：房间 `Y.Doc` apply 后同步 `store.append(documentId, update)` 拿 sequence，再广播；
持久化失败会走错误路径而不是静默继续。测试 `10-m2-durability` 覆盖“房间清空、进程重启、
离线客户端 + 重启、compaction、持久化失败、文档隔离”。

**Q10. 你们的协同在浏览器层面怎么证明不是“看起来同步”？**
A：三层：页面内读真实 `EditorState` 文本；独立 Yjs peer（`WireOracle`）从服务端读同一房间；
服务端 durable store 再读一次。三者一致才算 PASS；另外用 `state-vector` digest 而不是文本比对，
避免“文本碰巧一样”。

---

## 3. 大文档性能与状态隔离

**Q1. 为什么正文不进 Redux？**
A：正文的 mutation source 是 `Y.Text`，Redux 只存 `activeDocumentId`、权限、连接状态、协作者元数据。
把 6.8MB 放进 Redux 会带来：每次 keystroke 一次不可变拷贝、所有 selector 失效、DevTools 序列化爆炸。
R11 把这条写成硬约束；实测 100k 文档的 Redux state 是 **241 B**，且不含正文标记。

**Q2. 241 B 是怎么测的，不是“看代码觉得小”？**
A：在真实浏览器里，用测试注入的 `__perf.reduxSnapshot()` 从 React fiber 找到 Provider store，
`JSON.stringify(store.getState())`，断言不含 fixture 标记、大小 < 8KB。3 次独立进程都是 241 B。
这是**动态断言**，不是静态推断。

**Q3. P95 680ms 是怎么来的？能叫 production P95 吗？**
A：3 个独立进程、每次 3×100 次真实 `Input.insertText`；ready 的 p50/p95/max = 654/680/680 ms，
reconnect restore→connected = 763/770/770 ms（n=9）。环境是 Windows 11 + Chrome 155 + **本地
production build**（`apps/server/dist` 静态托管 `apps/web/dist`，无 Vite）。**不是 production P95**：
没有 TLS/Clerk/Render，也没有生产流量。

**Q4. 为什么 ready 在 dev 是 1845ms、build 是 654ms？差在哪？**
A：dev 用 Vite 按需 transform 模块，首屏要下载/编译大量 ESM；build 是一个 bundle。这个差异是
**服务路径**，不是产品优化。也正因为如此，dev 的 6301ms 冷启动不能拿来当 build 的数字。

**Q5. input P95 371ms 为什么这么高？你优化了吗？**
A：没有优化，而且这是**病理 fixture**：100k 行用单换行连接、没有空行，整篇是一个 Markdown 段落，
inline parser 每次编辑都要重扫。CPU profile：`@codemirror/lang-markdown` 的 `finishLeaf`（40.5%）+
`parseInline`（36.6%）= **89.6% 的 JS 时间**；20 次输入产生 21 个 ≥50ms Long Task。
用 block-structured 变体（同样的 100k 行/6.8MB 量级）对照，p95 从 371ms 降到 ~3.5ms，Long Task 1–2 个——
证明是 fixture 结构放大，不是产品代码里有个 O(N) 循环。

**Q6. 那真实用户文档会不会也卡？**
A：取决于是否有超大单段落。正常有标题/空行/列表的文档，解析是局部的；只有“6.8MB 一个段落”
这种病理输入才会触发。下一步若要做，是 parser-range guard / viewport-only parsing，但这会牺牲
大文档高亮，必须先有产品决策，不能偷偷改。

**Q7. 为什么不用虚拟化/分片文档？**
A：会改变 `Y.Text` 单一 truth 与锚点语义，AI 的 RelativePosition、undo、协同都会受影响；这是架构级
改动，不是性能补丁。当前选择是先把问题量化，再决定是否值得。

**Q8. Long Task 400 个/300 次输入，算不算性能事故？**
A：在这个病理 fixture 下是；但它是**观察**不是 SLO。正常 block 文档 300 次输入只有 1–2 个。
我们没有把它包装成“已优化”，也没有 production 数据。

**Q9. 如果面试官说“241 B 太小了，肯定是你没把内容放进去”——怎么证明？**
A：三条：代码层 `documentSlice` 没有 content 字段；动态层序列化整个 store 后搜 fixture 标记为 false；
行为层 100k 文档编辑后文本仍在 `Y.Text`/EditorState（hash 与 fixture 一致）。三者互相独立。

---

## 4. 异步竞态治理

**Q1. 你说的“状态归属校验”具体防的是什么？**
A：两类。第一类是**目录列表**：切换文档时旧的 `GET /api/documents` 可能后到，覆盖新文档的列表。
实现是 `AbortController` + `requestId` 双重校验：请求发出时记 id，响应回来只接受最新 id；
abort 后旧响应即使到达也丢弃。第二类是 **AI 建议**：`requestId` 绑定文档，切换文档后旧结果不能
落到新文档的 Diff 上。

**Q2. AbortController 真的取消了请求，还是只是忽略结果？**
A：两者都有：`abort()` 让浏览器取消 fetch（真实网络层），同时 `requestId` 保证即使响应已到达，
也会因为 id 不匹配被丢弃。测试 `stale/directory-list` 在 CDP 层把 200 响应 hold 住，切换文档后
触发 abort，实测 69–78ms 内变成 `AbortError`，之后的响应被 Chrome 拒绝投递（`Invalid InterceptionId`）。

**Q3. 那“document metadata stale”呢？**
A：**NOT APPLICABLE**。客户端打开/切换文档时不发 metadata HTTP 请求（文档内容来自 Yjs/WS），
所以不存在这个竞态。不要把它说成已验证；我们验证的是目录列表这条真实存在的可取消请求。

**Q4. 旧 WebSocket / 旧 session 的迟到消息怎么处理？**
A：session 有 generation/所有权：切换文档会替换 room（R15），旧 socket 的帧没有明确房间就拒绝；
绑定层只接受当前 session 的 doc。角色变化时编辑器是 reconfigure 而不是 remount，避免把旧状态
带到新权限下。

**Q5. 权限变化时前端怎么“立刻”只读？**
A：服务端是权威：角色变化会广播/回包，前端 `capabilityGate` 重新计算 `canEdit`，CodeMirror 变成
`EditorState.readOnly`，同时显示只读提示。但前端只读只是 UX，服务端在 WS 写入路径仍会拒绝——
测试 `m3/10` 和 `p2/1` 都验证了“客户端伪造角色也会被服务端拒绝”。

**Q6. Owner / Editor / Viewer 的差异到底在哪？**
A：capability 不是角色字符串：`canRead`、`canComment`、`canEdit`、`canManageMembers`。
Owner 全有；Editor 可读可写不可管成员；Viewer 只读（`canComment` 目前没有评论功能，是预留 tier）。
HTTP 用 `requireCapability`，WS join 用 `resolveJoinRole`，写入帧再校验一次，三层一致。

**Q7. 没有 membership 的用户会看到 404 还是 403？为什么？**
A：**404**，非泄露：不告诉调用者“这个文档存在但你没权限”。未认证是 401。测试 `p2/3` 覆盖
non-disclosure；`p2/2` 覆盖身份不可自声明。

**Q8. 你的 requestId guard 压测过吗？**
A：没有。只做了功能测试（旧结果不覆盖），没有做高并发/乱序压力测试。这是明确的 residual，
不把它说成“已验证高并发”。

---

## 5. 加载与“流式渲染”优化

**Q1. React.lazy 具体拆了什么？收益多少？**
A：两处：`ClerkRoot`（认证壳）和 `MarkdownPreviewRenderer`（`react-markdown` + `remark-gfm`）。
预览 chunk 是 **160.46 kB raw / 48.99 kB gzip**，主包只增加 **0.99 kB gzip**（引用 lazy chunk 文件名）。
主 chunk 里 `micromark`/`react-markdown` 引用为 0。收益是“不打开预览/不登录 Clerk 就不下载”。

**Q2. lazy chunk 加载失败怎么办？**
A：`React.lazy` 失败会抛到最近的 error boundary；当前预览只做了 `data-state="rendering|ready"`，
没有专门的 retry UI——这是已知缺口。正确做法是 error boundary + “重试加载”按钮，并把失败上报成
可观测事件（但不能为此加 telemetry 依赖）。

**Q3. “AI 流式响应增量更新渲染”是怎么实现的？**
A：**诚实回答：没有实现。** 当前是一次请求返回完整 `AiSuggestionDraft`，UI 只有 `generating` 和
最终 proposal 两个状态。如果要做流式，需要：服务端 SSE/stream → 增量 JSON 片段 → 客户端 buffer +
schema 校验 → 只在完整 draft 通过校验后才允许 Accept；流式过程中的半成品绝不能写 Y.Text。
这属于未实现能力，不应写进简历。

**Q4. 那“远端协作更新批量合并与防抖”呢？**
A：文本更新**没有**批量合并：`doc.on('update')` 逐条编码发送，靠 Yjs 幂等/无序保证正确性；
批量合并会引入额外延迟和“何时 flush”的状态机，收益在局域网内不明显。真正做合并的是 **awareness
presence**：50ms `flushDelayMs` 合并同一批 presence 变化（`awareness.ts:39`），避免光标移动刷爆
控制面。所以正确表述是“presence 50ms 合并”，不是“协作更新批量合并”。

**Q5. 为什么不做输入防抖再同步？**
A：会破坏“实时协同”的语义，也会让断线前的最后输入停留在本地更久；Yjs update 本身很小（单字符
insert 几十字节），逐条发是可接受的。防抖适合“搜索/预览渲染”，不适合 CRDT 同步。

**Q6. 100k 文档进入 Markdown Preview 会怎样？**
A：会卡。实测浏览器进入预览在 420s 场景预算内**没有到达 ready**（node 端 parse+render 约 719ms，
但浏览器 DOM 提交远慢于此）。所以 preview 只对普通文档可用；100k 场景是明确的 limitation，
我们没有声称“实时预览大文档”。如果要做，需要分片渲染/虚拟化或 worker 解析，且不能破坏 Y.Text 单一源。

**Q7. 你的 lazy 拆分有没有可能反而变慢？**
A：会：首次进入预览要额外加载 49 kB gzip chunk + 解析，实测首次 359ms、第二次 63ms。
所以拆分的前提是“预览不是首屏必需”；如果产品要求打开即预览，就应该进主包或 preload。

**Q8. 如果让你重做一次，你会改哪三件事？**
A：① fixture 从第一天就同时维护 pathological 与 block-structured 两套，避免把 fixture 效应
误判成产品问题；② preview 从一开始就做 100k 的降级策略（分片/虚拟化），而不是等发现 420s 卡死；
③ 认证壳 lazy 的同时给 lazy chunk 失败做 retry + error boundary，而不是只处理 happy path。

---

## 6. 收尾：三个“红线”回答

1. **“你这个能上线吗？”** —— 能部署（Render 单实例 + 持久盘 + 备份脚本），但**不能声称 production
   ready**：生产性能未验证、AI 外部 provider 无成功 live 记录、持久盘/恢复演练仍被付费阻塞。
2. **“73/73 还是 78/78？”** —— 当前默认是 **78/78**（73 + 5 个 preview 场景）；**78 不是 remote 数**，
   remote 模式是 83（78 + 5），且**没有跑**。
3. **“有没有优化前后对比？”** —— 没有。没有可信的 pre-optimization commit，任何“提升 X%”都不成立；
   只有 current baseline 与两次不同 fixture 的对照。
