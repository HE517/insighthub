# InsightHub 面试总纲（单文件版）— 实现、数据、算法、术语、边界

> **Evidence commit：`57a9bee`**（源码行号/permalink 锚点）。本文件把 01–06 六份深挖报告与
> 数据/算法说明合并成一份，重点回答三件事：**这个数字怎么测的、为什么选这个指标、这个英文名词/
> 算法到底是什么**。所有“没测过/没实现”的地方都明确标注。

---

## 0. 先读：三种状态词

| 词 | 含义 | 本项目例子 |
| --- | --- | --- |
| **IMPLEMENTED** | 代码已存在并接入运行路径 | Yjs 协同、IndexedDB 离线、Preview、AI provider seam |
| **VERIFIED** | 有可复现的真实运行记录 | 78/78 浏览器、100k benchmark、241 B Redux |
| **PLANNED / NOT IMPLEMENTED** | 只有设计或未接入 | AI 流式（SSE）、虚拟化、OT、Monaco |
| **NOT VERIFIED** | 实现了但无成功记录 | 外部 LLM live（OpenAI 429 / Kimi 400 未重试） |

面试中三档不能混：`implemented` 不等于 `verified`，`planned` 不能讲成“线上稳定”。

---

## 1. 项目与架构（30 秒版）

团队 Markdown 知识工作台。核心链路：

```
React 19 ── CodeMirror 6 ── Yjs(Y.Doc/Y.Text) ── WebSocket(binary) ── Express room
   │              │                    │
   │              └── IndexedDB(y-indexeddb) 离线/重开
   ├── Redux：activeDocumentId / connection / realtime 元数据（正文永不进入）
   ├── Clerk：身份 → internal user → document membership → role → capabilities
   └── AI：instruction → provider → AiSuggestionDraft → 校验 → Diff → Accept/Reject
```

**唯一正文真源**：`Y.Text('content')`。React/Redux 都不持有正文。服务端房间有 `Y.Doc`，持久化到
SQLite（WAL）。

源码入口：`apps/web/src/App.tsx`（lazy ClerkRoot → AppShell → DocumentWorkspace）、
`apps/server/src/app.ts`（HTTP）、`apps/server/src/ws.ts`（升级/帧分发）、
`apps/server/src/rooms/registry.ts`（房间与权限）。

---

## 2. 简历六条 → 实现 → 证据（压缩表）

| Bullet | 真实实现 | 核心源码 | 证据 | 关键限制 |
| --- | --- | --- | --- | --- |
| 业务场景 | 文档目录 + 房间 + 编辑器 + AI 面板 | `App.tsx`、`DocumentWorkspace.tsx` | `smoke/*`、`b125/1` | 无 comment/search/WYSIWYG |
| 协同/离线 | CM6↔Y.Text binding、Yjs update、binary WS、IndexedDB、Undo origin | `collabTextBinding.ts`、`sync-provider.ts`、`room.ts`、`persistence.ts` | `collab/independent-contexts`、`chaos/*`、`indexeddb/*` | 只验证 two users；30s 断网未测 |
| 大文档性能 | Y.Text 单源、Redux 元数据、100k benchmark、profile | `documentSlice.ts`、`tests/perf/*` | 3 进程、n=900/9、241 B | 病理 fixture；非 production P95 |
| 异步/RBAC | abort+requestId、capabilities、HTTP/WS 鉴权 | `AiDirectory.tsx`、`permission.ts`、`registry.ts` | `p2/*`、`stale/directory-list` | requestId 未压测；metadata stale N/A |
| 懒加载/Preview | `React.lazy` + Suspense + 400ms debounce + 无 raw HTML | `MarkdownPreview.tsx`、`previewFeed.ts` | `preview/1..5`、78/78 | 100k Preview 420s 未 ready |
| AI 编辑 | provider seam、结构化 draft、锚定校验、Diff、Accept 事务 | `ai/*`、`ai-anchor.ts`、`apply.ts`、`diff.ts` | `m3/5..11` | 外部 live NOT VERIFIED |

---

## 3. 数据总表（每个数字都带定义）

| 指标 | 值 | 定义（起止 / 样本 / 聚合） | 环境 | 原始文件 |
| --- | --- | --- | --- | --- |
| editor ready | p50 654 / p95 680 / max 680 ms | start：`page.goto` 前 `Date.now()`；end：页面内轮询到 `EditorState.doc.length === fixture.chars` 的那一帧（rAF 间隔） | n=3 独立进程；Chrome 155；Windows 11；**local production build** | `tests/perf/results/perf-prod-run-*.json`、`perf-production-multiround.json` |
| input latency（model） | p50 268.8 / p95 371.3 / max 511.4 ms | 页面内 `beforeinput` capture t0 → CodeMirror 事务完成后的 `input` 监听（注册在 CM handler 之后）t1；rAF 再记 next-frame | n=900（3 进程×3 轮×100）；同环境 | 同上 |
| input（next frame） | 269.6 / 372.3 / 512.3 ms | t0 → 下一帧 rAF | 同上 | 同上 |
| WebSocket reconnect | p50 763 / p95 770 / max 770 ms（restore→connected） | `setOffline(false)` 起 → `connection-status` 变 `connected`；每次断网 250ms | n=9（3×3） | 同上 |
| Long Task | 397–400 / run；max 430–511 ms | `PerformanceObserver({type:'longtask'})`；>50ms 的 task 计入 | 3 进程 | 同上 |
| Redux state | **241 B** | `JSON.stringify(store.getState())` 长度；store 由 fiber 树找到 Provider | n=3；100k 编辑 300 次后 | 同上 |
| bundle | 1,058,970 raw / 340,811 gzip | Vite production build；gzip level 9（node zlib） | 构建产物（**Preview 合入前**） | `perf-prod-run-*.json` |
| bundle（Preview 后） | 主 973.10 / 318.41；lazy chunk 160.46 / 48.99 | 同上 | 当前 HEAD 构建 | `docs/TASKS.md`、`docs/interview/…QA.md` |
| Preview debounce | **400 ms** | **配置常量** `PREVIEW_DEBOUNCE_MS`；从 Y.Text 更新到 preview 重渲染的等待窗口 | 单测 + 浏览器观测 416ms | `previewFeed.ts:40`、`preview/2` |
| 浏览器套件 | 默认 **78/78**；remote **83（注册未跑）** | 73 + 5 preview | Chrome 155 | `7585263` 运行、`tests/browser/artifacts` |
| stale abort | 69–78 ms | 200 响应被 CDP hold；切换文档触发 abort → `AbortError` | 1 场景 | `stale/directory-list` |
| profile | Markdown inline 89.6% JS | 20 次输入 trace + CPU profile；`@codemirror/lang-markdown` self time / total profiled | dev build（函数名未压缩） | `profile-100k.json` |

### 3.1 为什么用这些指标（不是随便挑）

- **editor ready**：用户点开文档到“能编辑”的感知点；不用 FCP/LCP，因为这是 SPA 壳已加载后的
  “文档数据 + 编辑器可交互”阶段，FCP 早在空壳时就发生了。
- **input latency（model）**：输入到模型落地的延迟，是协同/编辑正确性的核心；next-frame 是用户
  真正看到字符的帧，二者都报，避免只挑好看的。
- **reconnect**：离线是 first-class；断网恢复时间是协同体验的关键。
- **Long Task**：>50ms 阻塞主线程，直接对应输入卡顿；比 FPS 更能定位“一次卡多久”。
- **Redux size**：验证“正文不进全局状态”不是口号，而是运行时事实。
- **bundle**：验证 lazy 拆分收益；分开报 raw/gzip，避免只报 gzip 显得小。
- **memory**：`performance.memory` 是非标准采样，只报 sampled peak，不作为主指标。

### 3.2 p95 的两个口径（必须讲清）

- `tests/perf/run.mjs`：`index = floor(p/100 * (n-1))`（nearest-rank 变体）→ ready p95 = **654**。
- `tests/perf/aggregate.mjs`：`index = ceil(p/100 * n) - 1` → p95 = **680（= max，n=3）**。
- 简历写 680 时，面试要说“这是 aggregate 的 ceil 口径；单进程 floor 口径是 654，n=3”。

**算法（nearest-rank percentile）**：排序样本 → 取第 `ceil(p/100 × n)` 个（从 1 计）或等价的
`ceil(...)-1`（0 计）。n 小的时候 p95 会等于 max；所以必须同时给 n。

---

## 4. 关键算法展开

### 4.1 Yjs / CRDT（YATA）— 库实现，不是本项目实现

- 每个字符是一个 item，带唯一 id = `(clientID, clock)`；插入时记录左右邻居；
- 并发插入时按 **YATA** 规则（origin 链 + 冲突比较 clientID）确定顺序；
- 删除不是移除，而是打 **tombstone（墓碑）**，所以 update 可重复应用；
- 因此 update **幂等（idempotent）**：apply 两次结果一样；**可交换（commutative）**：乱序 apply
  仍收敛。这是“断线重连只需交换缺失 update”的数学基础。
- **不是 OT**：OT 需要中心服务器对每个操作做 transform，依赖严格顺序；本项目没有实现 OT。

### 4.2 State Vector 与同步握手

`state vector` = 每个 client 的“我已看到的最大 clock”映射。同步协议（y-protocols）：

1. 客户端发 **SyncStep1(stateVector)**：“我有哪些”；
2. 服务端回 **SyncStep2(diff)**：只发缺失的 update；
3. 服务端也发 SyncStep1，客户端回 SyncStep2（双向补齐）；
4. 之后的增量 update 直接广播。

复杂度：diff 只与缺失量相关，不是全量文档。

### 4.3 二进制帧与控制面

- 文本帧（TEXT）= JSON 控制消息：`join-room`、`room-joined`、`error`、`role` 等；
- 二进制帧（BINARY）= Yjs sync/awareness：首字节 type `0=SYNC`、`1=AWARENESS`，payload 由
  `y-protocols` 编码；编码/解码在 `packages/shared/src/binary-frame.ts`；
- 不 base64、不自定义第二套 framing；一个 socket 只承载一个房间（R15）。

### 4.4 UndoManager 的 origin 隔离

`Y.UndoManager` 只把 **tracked origins** 的 transaction 放进 undo 栈（本地输入、AI accept）。
远端 update 用 `remoteOrigin` apply，不在集合里 → undo 不会回滚别人的字符。没有用“文本快照”。
源码：`UNDO_TRACKED_ORIGINS`（shared）、`sync-provider` 的 `remoteOrigin`。

### 4.5 debounce（Preview）

```
onUpdate:
  last = snapshot
  if timer: clearTimeout(timer)
  timer = setTimeout(render, 400)
```
**尾沿触发**：连续更新只在最后一次后 400ms 渲染。切走时 `clearTimeout` + 取消订阅。
为什么不用 throttle：预览不需要固定频率刷新，只需要“编辑停下来后一次正确渲染”；throttle 会在
持续输入时每 400ms 渲染一次，浪费且可能渲染中间态。

### 4.6 AbortController + requestId（异步竞态）

竞态：请求 A（文档 A）→ 用户切 B → 请求 B 返回 → A 返回覆盖 B。
- `AbortController.abort()` 取消在途 fetch，但**响应可能已经到达**（abort 与响应回调竞速）；
- 因此还需要 `requestId`（单调递增）+ document identity：响应回来时 `id !== current` 直接丢弃；
- 结论：**abort 是带宽/资源优化，所有权校验才是正确性保证**。

### 4.7 RBAC：role → capability

```
Clerk session → internal userId → document membership → role
  role → capabilities: canRead / canComment / canEdit / canManageMembers
  capabilities → HTTP guard + WS join/frame guard + UI editable/readonly
```
`canUndo` 不是权限，是 undo 状态（`getUndoState`）。403/404：无 membership 用 **404 非泄露**，
未认证 401。权限变化不发 HTTP 请求，真实机制是**授权结论过期**：服务端逐帧重查，前端 UI 可能滞后
（实测约 3s）。`document + owner membership` 在同一 SQLite 事务中创建（原子）。

### 4.8 AI：draft-only + 锚定校验

```
instruction → provider(stub|openai|kimi) → AiSuggestionDraft
  → Zod schema → 客户端 mint anchor(RelativePosition + expectedText, baseRevision)
  → proposal → unified diff → Accept(单 ai-origin 事务) / Reject(无 mutation)
```
**LLM 永不直接写 Y.Text**。Accept 前的三重校验：`baseRevision` → anchor 解析 → `expectedText`
精确匹配。`RelativePosition` 编码的是“相对某个 item 的位置”，所以别人在前面插入字符后仍能解析到
正确位置；普通 index 会漂移。

**assoc 细节**：start 用 `assoc=0`（粘前），end 用 `assoc=-1`（粘后）；在区间**末端追加**不算
stale（`END_ASSOC=-1` 故意把它排除），只有**区间内部**被改才算 `text-mismatch`。

### 4.9 unified diff（LCS）

`apps/web/src/features/ai/diff.ts`：按行 split → LCS 动态规划得到 equal/delete/insert 脚本 →
按 3 行上下文分组为 hunk。**上限 2,000,000 个 DP cell**；超过就退化为“整段删除+整段插入”
（仍然正确，只是不最小）。纯函数、只用于显示；真正 apply 的索引由 anchors 重新推导。

### 4.10 限流（固定窗口）

`apps/server/src/ai/limits.ts`：每用户 20/h、100/day，每 server 1/user、4 并发，30s 超时，
0 retry。窗口是**固定窗口**，锚定“该用户上一次窗口过期后的第一个请求”，不是 token bucket。
并发上限用 acquire/release 计数。

### 4.11 Long Task 与 50ms

`PerformanceObserver({type:'longtask'})` 记录 >50ms 的主线程任务（浏览器规范阈值）。它是
“主线程被占住”的证据，不是某一段代码的耗时；归因要靠 CPU profile（本项目用 `Profiler`）。

---

## 5. 英文术语表（面试常问）

| 术语 | 解释（结合本项目） |
| --- | --- |
| **CRDT** | Conflict-free Replicated Data Type；并发副本无需协调即可收敛。Yjs 是 CRDT。 |
| **OT** | Operational Transformation；需要中心 transform。**本项目未实现**。 |
| **YATA** | Yjs 使用的 CRDT 算法；item 带左右 origin，按规则排序。库内部，不是本项目代码。 |
| **Y.Doc / Y.Text** | 文档容器 / 文本类型；`Y.Text` 是正文唯一真源。 |
| **state vector** | client→最大 clock 的映射；SyncStep1 用它换缺失 update。 |
| **update** | Yjs 增量二进制；幂等、可交换。 |
| **awareness** | 在线状态/光标等临时 presence；非正文；50ms 合并。 |
| **tombstone** | 删除标记；保留结构以支持并发。 |
| **LWW** | Last-Write-Wins；简单但会丢并发编辑。**未采用**。 |
| **idempotent** | 重复执行结果不变；Yjs update 幂等。 |
| **commutative** | 交换顺序结果不变；Yjs update 可交换。 |
| **origin** | Yjs transaction 的来源标签；用于 undo 隔离和回环抑制。 |
| **RelativePosition** | 相对某个 item 的位置编码；并发编辑后仍可解析。 |
| **expectedText** | 生成时选区的原文；apply 前必须精确匹配。 |
| **fail-closed** | 校验失败就拒绝，而不是放行。AI 输出/鉴权都如此。 |
| **RBAC** | 基于角色的访问控制；本项目 role → capabilities。 |
| **capability** | 具体能力位（canRead/canEdit/canComment/canManageMembers）。 |
| **AbortController** | 浏览器取消 fetch 的 API；需配合 requestId 保证正确性。 |
| **debounce** | 连续触发结束后执行一次；Preview 400ms。 |
| **throttle** | 固定窗口最多执行一次；本项目未用于 Preview。 |
| **code splitting** | 把代码拆成按需加载的 chunk；Vite 动态 import。 |
| **React.lazy / Suspense** | 懒加载组件 + 加载边界；Preview/ClerkRoot 使用。 |
| **chunk** | 构建产物分块；Preview renderer 48.99 kB gzip。 |
| **gzip** | 压缩算法；bundle 报 raw + gzip。 |
| **Long Task** | >50ms 的主线程任务；PerformanceObserver 采集。 |
| **p50 / p95** | 分位数；nearest-rank 计算，必须给 n。 |
| **TTI / FCP / LCP** | 通用 Web 性能指标；**本项目未用**（不是 SPA 首屏叙事）。 |
| **WAL** | SQLite 预写日志；本项目 `journalMode: wal`。 |
| **optimistic UI** | 先改 UI 再等服务器；本项目正文不适用（Yjs 本地先行就是真源）。 |
| **SSE** | Server-Sent Events；**AI 流式未实现**。 |

---

## 6. 数据怎么测（可复现步骤）

### 6.1 100k benchmark

```bash
pnpm build                                    # production artifacts
node tests/perf/run.mjs --build \
  --out=tests/perf/results/perf-prod-run-1.json
node tests/perf/aggregate.mjs perf-prod-run perf-production-multiround.json
```
- fixture：`tests/perf/fixture.mjs` 生成，sha256 校验；
- seed：`tests/perf/seed.mjs` 走真实 `openDocumentStore`；
- 服务：`build-stack.mjs` 启动 `apps/server/dist` 托管 `apps/web/dist`（无 Vite）；
- 浏览器：真实 Chrome via CDP；每轮 3×100 输入、3 次重连。

### 6.2 Redux 241 B

页面内注入 `perf.reduxSnapshot()`：从 `#root` 的 React fiber 找 Provider 的 `store` →
`getState()` → `JSON.stringify` → 长度 + 正文 marker 检查。**不是**代码推断。

### 6.3 Preview debounce

单测 fake timers 证明 400ms 窗口；浏览器场景用第二个 Yjs peer 在预览可见时写入，页面内采样
`Y.Text` 落地时间与 preview DOM 更新时间，得到 416ms 观测。**400ms 是配置值，416ms 是观测量。**

### 6.4 profile

`node tests/perf/profile.mjs`：`Profiler.start` + `Tracing.start` 覆盖固定 20 次输入；
解析 CPU profile 的 self time（按 function/url），trace 的 self time（按 name）与 Long Task。

---

## 7. 不能说的与必须说的

**不能说**：
- “production P95 680/770”（是 local production build）；
- “性能已优化/提升 X%”（无 pre-opt baseline，未优化）；
- “3+ 用户已验证”“30s 断网不丢”；
- “AI 流式渲染”“AI 已线上验证”；
- “73/73 是当前默认”（当前 78/78；73 是历史轮）。

**必须说**：
- 241 B 是**整个 store**序列化，不是“仅元数据”；正文不在其中；
- 680 是 aggregate ceil 口径（run.mjs floor = 654，n=3）；
- 100k 是病理单段落 fixture；block 对照 input p95 ~3.5ms；
- 100k Preview 在浏览器 420s 内未 ready；
- 权限变化不发 HTTP：是**授权结论过期**，不是“请求竞态”；
- `requestId` guard 未压测；metadata stale = NOT APPLICABLE。

---

## 8. 面试速答（20 条）

1. **正文为什么不进 Redux？** 高频事务 + 单一真源；100k 实测整个 store 241 B 且无正文。
2. **Yjs vs OT？** CRDT 幂等/可交换；OT 需中心 transform，本项目未实现。
3. **update 为什么能乱序？** YATA + tombstone，apply 与顺序无关。
4. **state vector 是什么？** 每个 client 的最大 clock；SyncStep1/2 只补缺失。
5. **为什么一 socket 一房间？** 二进制帧无 doc id，靠连接绑定房间。
6. **undo 为什么不动别人？** 只跟踪本地/AI origin，remote 不在栈里。
7. **IndexedDB 存什么？** Yjs state/update，不是 Markdown string。
8. **重连怎么收敛？** SyncStep1 → SyncStep2，双向补齐。
9. **241 B 怎么来的？** fiber 找 store → getState → stringify。
10. **680 怎么算？** aggregate ceil 口径；n=3；run.mjs floor 是 654。
11. **input 371 为什么高？** 单段落 Markdown inline parser 89.6%；block 对照 3.5ms。
12. **Long Task 是什么？** >50ms 主线程任务；profile 归因。
13. **AbortController 够吗？** 不够，响应可能已返回；要 requestId + identity。
14. **Viewer 只读能绕过吗？** 能改前端，服务端 join/write 拒绝。
15. **404 为什么不是 403？** 非泄露，不暴露文档存在。
16. **React.lazy 原理？** loader 返回 Promise，bundler 切 chunk，Suspense 等加载。
17. **lazy 和 useMemo？** 加载 vs 计算复用；不能互替。
18. **debounce vs throttle？** 结束点 vs 固定窗口；Preview 用 debounce。
19. **AI 为什么不能直接写 Y.Text？** 输出不可信/可能 stale/需确认/必须 CRDT 事务。
20. **Kimi 怎么选？** 国内 endpoint、成本、中文、OpenAI-compatible；默认 `kimi-k3`；provider 可换。

---

## 9. 口述版本

### 30 秒
“InsightHub 是一个团队 Markdown 工作台。正文只存在 Y.Text 里，CodeMirror 6 和 Yjs 绑定做实时协同，
WebSocket 传增量，IndexedDB 支持离线；Redux 只放文档 id、连接、权限这些控制状态。100k 文档实测
整个 Redux store 241 B。权限是服务端权威的 Owner/Editor/Viewer，AI 只产出建议 draft，用户点
Accept 才进 Yjs 事务。”

### 90 秒
“协同这边，输入先进 CodeMirror transaction，binding 写进 Y.Text，Yjs 产生 update，二进制帧到
服务端房间 apply + 持久化 + 广播，远端再 apply 回编辑器。断线时编辑先落本地 Y.Doc 和 IndexedDB，
重连用 state vector 双向补差。Undo 只跟踪本地和 AI origin，所以不会撤别人的字。
性能上我先用 3 个独立进程测了 100k：ready p95 680ms、reconnect 770ms，然后 profile 发现瓶颈不是
Redux/Yjs，而是单段落 Markdown 的 inline parser，占 89.6% JS；换正常 block 文档 p95 只有 3.5ms。
所以那个高延迟是 fixture 病理结构，不是产品整体性能。”

### 3 分钟
在 90 秒基础上补：RBAC 三层（HTTP/WS/UI）与 404 非泄露；abort + requestId 的所有权模型；Preview
的 lazy chunk、400ms debounce、XSS 处理；AI 的 provider abstraction、结构化 draft、RelativePosition
+ expectedText 校验、Accept 单事务；最后主动说 limitation：local build 不是 production P95、只验证
两个用户、100k Preview 浏览器 420s 未 ready、外部 LLM live 未验证。

---

## 10. 一张白板图

```
User keystroke
   │
   ▼
CodeMirror 6 (EditorView transaction)
   │  collabTextBinding
   ▼
Y.Text ──────────────► Y.Doc update
   │                        │
   │                        ├── binary WS frame ──► Express room.applySyncPayload
   │                        │                         ├── store.append(seq)  (SQLite WAL)
   │                        │                         └── broadcast ──► Remote Y.Doc ──► Remote CM
   │                        └── y-indexeddb (offline / reload)
   │
   ├── Redux: activeDocumentId / connection / realtime (NO body)
   └── Preview: Y.Text ──observe──► 400ms debounce ──► lazy renderer ──► DOM
```

---

## 11. 源码锚点（节选，完整见 01–06）

- `apps/web/src/collab/internal/document-session.ts:474-475` — `new Y.Doc()` / `getText`
- `apps/web/src/features/editor/collabTextBinding.ts:176-202` — 本地变更写入 Y.Text
- `apps/web/src/collab/internal/sync-provider.ts:446-453` — doc update → binary frame
- `apps/server/src/rooms/room.ts` — `applySyncPayload`
- `apps/server/src/rooms/registry.ts:716-760` — 逐帧授权；`:814-860` — mutation 提交
- `apps/web/src/features/editor/AiDirectory.tsx:108-141` — abort + requestId
- `packages/shared/src/permission.ts:37-44` — role → capabilities
- `apps/web/src/features/editor/MarkdownPreview.tsx:38` — `React.lazy` renderer
- `apps/web/src/features/editor/previewFeed.ts:40` — `PREVIEW_DEBOUNCE_MS = 400`
- `apps/server/src/ai/provider.ts` / `openai.ts` / `kimi.ts` — provider seam
- `packages/shared/src/ai-anchor.ts:231-325` — RelativePosition + expectedText 校验
- `apps/web/src/features/ai/apply.ts:92-136` — Accept 单事务
- `apps/web/src/features/ai/diff.ts` — LCS unified diff（2M cell 上限）
- `apps/server/src/ai/limits.ts` — 固定窗口限流（20/h、100/day、1/user、4/server）

> 完整 `path:Lx-Ly` + pinned permalink 在 01–06 报告中；本文件是总纲，不重复全部链接。
