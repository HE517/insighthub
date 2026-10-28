# 05 · Lazy Loading, Markdown Preview and Debounce — InsightHub Deep Dive

> **Evidence commit:** `57a9bee5f2f8d6ff30f2a8373b61328546475183`
> **Branch:** `agent/interview-project-deep-dive` · **Nature:** docs-only（本文件不改代码/测试/package.json）
> **Permalink base:** `https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/`
> **Runtime:** React **19**（`apps/web/package.json:26`，`react`/`react-dom` `^19.0.0`）
> **Status vocabulary:** `VERIFIED` / `IMPLEMENTED, NOT VERIFIED` / `NOT IMPLEMENTED` / `NOT APPLICABLE`
> **一句话结论：** `React.lazy` 与 400 ms Preview debounce 是真的、有浏览器证据；**AI 流式是 NOT IMPLEMENTED**；
> **协作文本更新没有批量合并/防抖**（只有 awareness presence 50 ms）；「权限模块整体 lazy」不成立。

---

## 1. 简历原句（逐字）与 claim 拆分

### 1.1 原句（逐字，不改写）

> 加载与流式渲染优化：对 Markdown Preview、权限模块等非首屏模块进行 React.lazy 代码拆分；针对 AI 流式响应增量更新渲染内容，对远端协作更新进行批量合并与防抖，降低高频更新导致的渲染开销，并支持生成结果 Diff / Accept / Reject 交互。

### 1.2 逐条裁决

| # | 原句片段 | 判定 | 证据（pin 到本 commit） | 本报告如何处理 |
| --- | --- | --- | --- | --- |
| C1 | 「对 **Markdown Preview** … 进行 `React.lazy` 代码拆分」 | **真（VERIFIED）** | `MarkdownPreview.tsx:38` 的 `lazy(() => import('./MarkdownPreviewRenderer.js'))`；`MarkdownPreviewRenderer.tsx:33-35` 是**唯一** import `react-markdown` / `remark-gfm` 的模块；浏览器产物里该 chunk 与主包分离（chunk 尺寸见 §12） | §3–§7 主体 |
| C2 | 「对 **权限模块** 等非首屏模块进行 `React.lazy`」 | **不准确（PARTLY FALSE）** | 真正 lazy 的是 **Clerk 认证壳**：`App.tsx:76-79`（`ClerkRoot`）。**权限判定本身在主包**：`DocumentWorkspace.tsx:90` 直接静态 import `capabilityGate`，`DocumentWorkspace.tsx:179` 调用 `capabilityGate(role)`，`capabilityGate.ts:53` 是纯同步函数；`ReadOnlyNotice`（`DocumentWorkspace.tsx:91`）也在主包 | §1.3 纠正话术；§10 标注「权限模块 lazy」= 不得再说 |
| C3 | 「针对 **AI 流式响应增量更新渲染内容**」 | **NOT IMPLEMENTED** | 一次 `POST /api/ai/suggest` 拿完整 draft；请求体显式 `stream: false`（`openai-compatible.ts:149-150`）；`apps/**` 无 `EventSource` / `ReadableStream` / `text/event-stream` / `stream: true`。面板只有 `generating → proposal` 两态（`AiSuggestPanel.tsx:102-109`） | §1.4 明确排除；完整论述见 `06-ai-editing-llm-design.md` |
| C4 | 「对**远端协作更新**进行**批量合并与防抖**」 | **假（FALSE for text）** | Yjs 文本更新在 `sync-provider.ts:446-453` **逐条**编码发送（唯一跳过的是 `remoteOrigin` 回放）。全仓唯一的 50 ms 合并是 **awareness presence**：`awareness.ts:39` `AWARENESS_FLUSH_DELAY_MS = 50`。Preview 的 400 ms debounce 是**渲染层**，不是「协作更新合并」 | §2 / §6 / §8 反复区分「presence 合并」≠「文本更新合并」≠「preview 渲染 debounce」 |
| C5 | 「降低高频更新导致的渲染开销」 | **部分真（PARTLY TRUE，仅渲染侧）** | 有效范围：**只有 preview 的重新渲染**被 400 ms 合并（`previewFeed.ts:85-93`）。文本同步路径没有合并，编辑器也不做输入防抖 | §6.2、§12 |
| C6 | 「支持生成结果 **Diff / Accept / Reject** 交互」 | **真（VERIFIED）但不在本报告范围** | `AiSuggestPanel.tsx:248-287`、`apply.ts:92-135`；浏览器 `m3/5`、`m3/6` | 一句话带过，详见 `06` |

### 1.3 需要主动纠正的两句话（面试开场就要说）

1. **「权限模块 lazy」→ 改成「Clerk 认证壳 lazy」**。权限 capability 是同步纯函数 + 主包里的 `capabilityGate`，
   它必须在编辑器渲染的第一帧就能算出来；把它 lazy 会让「只读/可写」这个首屏决定多一次网络往返。
2. **「AI 流式增量渲染」→ 删掉**。当前是「一次请求 → 完整 draft → 校验 → 渲染」，
   不是流式；任何「增量/流式」字样都会在追问里穿。

### 1.4 本报告的边界

- 只覆盖 **lazy / Preview / debounce（渲染侧）**。
- AI 流式、Diff、Accept/Reject、provider 选型 → `06-ai-editing-llm-design.md`。
- 协作文本同步、Yjs、IndexedDB → `02-collaboration-offline.md`（同目录系列）。
- 100k 性能数字的环境与意义 → `03-large-document-performance.md`。

---

## 2. 业务问题：为什么预览不能阻塞编辑，为什么必须懒加载

### 2.1 预览是派生视图，编辑才是产品

正文唯一真相是 `Y.Text`（`AGENTS.md` R11）。预览 = `Y.Text → string → AST → DOM` 的**只读派生**，
没有写回路径：`previewFeed` 没有任何 `insert` / `delete` / `transact` 方法（`previewFeed.ts:19-24`），
`MarkdownPreview.tsx:11-12` 也写明「no path from this component to insert/delete/transact」。

因此业务上有三条硬约束：

| 约束 | 业务含义 | 实现手段 |
| --- | --- | --- |
| 预览不能拖慢编辑 | 用户 90% 时间在编辑；预览是「看一眼」 | 预览**只在可见时挂载**、**只在可见时订阅**、**编辑后 400 ms 才重渲染** |
| 切换模式不能丢状态 | 切回编辑必须还是同一个光标、同一段撤销历史、同一个滚动位置 | 编辑器**不 unmount**，只 `display: none`（`DocumentCanvas.tsx:35-57`、`styles.css:742-744`） |
| 预览不能改文档 | 只读视图一旦能写，就多出一个真相 | `previewFeed` 只 `observe` + `toString()`；浏览器断言 `Y.Text` SHA/state-vector 不变（`preview/4`） |

### 2.2 为什么「懒」是产品决策，不是技术炫技

`react-markdown` + `remark-gfm` 的依赖树（micromark / mdast / hast 等）会给首屏增加约 **49 kB gzip**
（§12）。但这 49 kB 对「打开文档开始打字」这件事**零贡献**：

- 默认模式是 `editor`（`editorMode.ts:15` `DEFAULT_EDITOR_MODE = 'editor'`），首屏根本不渲染 Markdown；
- 演示路径（demo）必须与加入 preview 之前**逐字节等价**，包括 bundle 行为
  （`App.tsx:70-79` 对 Clerk 说的是同一件事，preview 用同一手法）；
- 只有用户真的点「预览」时，才值得付这 49 kB + 一次解析。

所以「懒」在这里不是优化技巧，而是**把成本移动到真正需要它的那一刻**。
代价也很明确：**第一次**进预览要等 chunk（§12 的 359 ms 观测），且 chunk 失败时没有专门的重试 UI（§13）。

### 2.3 为什么要 debounce（而不是不 debounce）

预览可见时，正文仍然在被写：本地键盘（编辑器只是 `display:none`，binding 仍在）、
远端协作者的 update。Markdown 解析 + React 元素树的成本随文档线性甚至超线性增长
（100k 单段落是病理性放大，见 `03`），每次按键都全量重渲染是纯浪费。

业务上要的是「**停手之后看到的是最新的**」，不是「看到每一次中间态」。
这就是 trailing debounce 的语义：突发合并成一次，时间从**最后一次**变化算起。
400 ms 是**配置值**（`previewFeed.ts:40`），不是测出来的 P50（§12 会反复强调）。

---

## 3. 完整流程（每步：输入 / 输出 / 层 / 状态 / 同步异步 / 失败）

### 3.1 流程 A：进入预览（首次，含 lazy chunk）

| # | 输入 | 输出 | 层 | 状态变化 | 同步/异步 | 失败时 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 用户点击 `[data-testid="mode-preview"]`（`DocumentHeader.tsx:120-125`） | `onModeChange('preview')` | React 事件层 | `mode: 'editor' → 'preview'`（`DocumentWorkspace.tsx:198`，`useState`） | 同步 | 无（纯 UI） |
| A2 | `mode === 'preview'` | 编辑器 pane 得到 `canvas-pane--hidden`；preview pane **首次挂载** | React 渲染层 | `DocumentCanvas` 条件渲染 `preview`（`DocumentCanvas.tsx:51-55`）；**编辑器不 unmount** | 同步（commit 阶段） | 无 |
| A3 | `session` | 取到 `Y.Text`（`doc.getText('content')`，`MarkdownPreview.tsx:54`）；用 `text.toString()` 初始化 `sourceRef` | 数据层 | `sourceRef` = 当前正文快照（`MarkdownPreview.tsx:64-70`，**render 期的一次性 ref 初始化**） | 同步 | session 非 `active` 时组件根本不会被渲染（`DocumentWorkspace.tsx:116-126` 先 narrow） |
| A4 | `MarkdownPreviewRenderer` 的 lazy import | 触发 `import('./MarkdownPreviewRenderer.js')` → 浏览器请求 hashed chunk | 网络/打包层 | `Suspense` 进入 pending | **异步** | chunk 404 / 断网 / 部署半途 → promise reject → **抛给最近的 error boundary**；本仓库 `apps/web/src` 内**没有** error boundary（grep `ErrorBoundary` 0 命中）→ 已知缺口 |
| A5 | Suspense pending | 渲染 fallback：`Rendering preview…`（`MarkdownPreview.tsx:102-107`） | React 层 | `data-state="rendering"`（`MarkdownPreview.tsx:74` 初值） | 同步渲染 | fallback 是**静态文本**，不是 `aria-live`（`MarkdownPreview.tsx:29`） |
| A6 | chunk 到位 + `source` | `ReactMarkdown` 产出 DOM（`MarkdownPreviewRenderer.tsx:142-149`） | 渲染层 | 无状态变化（React commit） | 同步（本次 render） | 单条 Markdown 语法问题不会抛错；`react-markdown` 对未知语法降级为文本 |
| A7 | commit 完成 | `useEffect([source])` 调 `onRendered` → `markReady` | 副作用层 | `phase: 'rendering' → 'ready'`，`data-state` 变 `ready` | 异步（effect 在 paint 之后） | 若 renderer 抛错，A4 的失败路径优先 |
| A8 | 挂载完成 | `createPreviewFeed({text, debounceMs}).activate()` | 订阅层 | feed `active = true`；**立即** `onSnapshot(text.toString())`（`previewFeed.ts:100-106`） | 同步 | `activate` 幂等（二次调用直接 return） |

> 关键点：**A3 的 snapshot 与 A8 的 snapshot 是同一次内容的两条路径**。
> A3 保证「第一帧就有内容」，A8 保证「订阅建立时也渲染一次」。`onSnapshot` 里有
> `if (markdown === sourceRef.current) return;`（`MarkdownPreview.tsx:81`），所以不会双渲染。

### 3.2 流程 B：预览可见时的编辑 / 远端更新

| # | 输入 | 输出 | 层 | 状态变化 | 同步/异步 | 失败时 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | 本地按键或远端 Yjs update | `Y.Text` 变化 → 触发 `text.observe(onTextChange)` | Yjs / CRDT 层 | **正文唯一真相已更新**（与 preview 无关） | 同步（Yjs 事务内） | 与 preview 无关；preview 是下游 |
| B2 | observer 回调 | `cancel()` 旧 timer，起新的 `setTimeout(400)` | 定时器层 | `timer` 被替换（`previewFeed.ts:85-93`） | 异步（计时） | 若 `!active` 直接 return（`previewFeed.ts:86`，belt-and-braces） |
| B3 | 400 ms 到点 | `onSnapshot(text.toString())` | 数据层 | 无 | 异步 | 无 |
| B4 | 新快照 | 若与 `sourceRef.current` 相同 → **不重渲染**；否则写 `sourceRef`、`setPhase('rendering')`、`requestRender(+1)` | React 层 | `phase = 'rendering'`；`source` 通过 ref 更新 | 同步（setState） | 无 |
| B5 | 新 `source` | renderer 重新渲染 | 渲染层 | `data-state="rendering"`（CSS 只做 0.82 透明度，不改布局，`styles.css:902-905`） | 同步 | 无 |
| B6 | commit 完成 | `onRendered` → `phase='ready'` | 副作用层 | `data-state="ready"` | 异步 | 无 |

**这段时间里 UI 显示什么？** 显示的是**上一帧的完整预览**（不是空白、不是骨架），
`data-state="rendering"` 只让 body 轻微变淡。这就是「debounce 期间 UI 不闪」的答案（§14 Q4）。

### 3.3 流程 C：切回编辑

| # | 输入 | 输出 | 层 | 状态变化 | 同步/异步 | 失败时 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 点击 `[data-testid="mode-editor"]` | `setMode('editor')` | React 事件层 | `mode = 'editor'` | 同步 | 无 |
| C2 | `mode` 变化 | preview pane 从树里移除 → `MarkdownPreview` unmount | React 层 | 组件实例销毁 | 同步 | 无 |
| C3 | unmount cleanup | `feed.deactivate()`：`cancel()` + `text.unobserve` | 订阅层 | `active=false`，`timer=null` | 同步（cleanup 在 commit 后） | 幂等：重复 deactivate 直接 return |
| C4 | `hidden` 变 `false` | 编辑器 pane 移除 `canvas-pane--hidden`（`display` 恢复） | 样式层 | 无 | 同步 | 无 |
| C5 | 可见性恢复 | `useLayoutEffect([hidden])`：恢复 `scrollTop/scrollLeft`，必要时 `focus()`，并在下一帧再恢复一次 | 编辑器层 | 滚动位置 / 焦点恢复（`CollaborativeMarkdownEditor.tsx:337-353`） | 同步 + 一帧 rAF | rAF 被下一次隐藏取消 |

> **C3 是这套设计成立的关键**：订阅与组件生命周期绑定，所以「隐藏的预览」不是
> 「不渲染的预览」，而是**根本不存在**。这正是「hidden preview 不能在编辑器背后悄悄重渲染」的机制。

### 3.4 失败与半失败

| 场景 | 观察到的行为 | 是否数据丢失 |
| --- | --- | --- |
| lazy chunk 加载失败 | `React.lazy` reject → 最近 error boundary；**本仓库没有 boundary**，所以错误上抛到根，预览区不可用 | 不丢：正文在 `Y.Text`，编辑器仍在 DOM |
| 400 ms 内文档被清空 | 到点后 `source.trim() === ''` → 显示 `This document is empty.`（`MarkdownPreviewRenderer.tsx:139-141`） | 不丢 |
| 预览期间 session 被替换（文档切换 / 身份重挂载） | 父级 `key={session.localClientId}`（`DocumentWorkspace.tsx:298`）→ 旧预览实例销毁、新实例重挂载 `mode` 重置为 `editor` | 不丢：`mode` 是 UI 状态 |
| 预览期间角色被降级 | 不影响预览（只读视图本来就不写）；Accept 之类另属 AI 面板 | 不丢 |

---

## 4. 源码定位（≥10，行号已逐个核对）

> 所有 permalink 都 pin 到 `57a9bee5f2f8d6ff30f2a8373b61328546475183`。

| # | 位置 | 符号 | 职责 | Permalink |
| --- | --- | --- | --- | --- |
| 1 | `apps/web/src/features/editor/MarkdownPreview.tsx:31-38` | `lazy`, `MarkdownPreviewRenderer` | **唯一的 lazy 边界**；把 `react-markdown` 全部关进独立模块 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/MarkdownPreview.tsx#L31-L38 |
| 2 | `MarkdownPreview.tsx:54-70` | `text`, `sourceRef`, `sessionRef` | 读 `Y.Text`；render 期一次性初始化快照；replica 变化时重取 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/MarkdownPreview.tsx#L54-L70 |
| 3 | `MarkdownPreview.tsx:76-89` | `useEffect` + `createPreviewFeed` | 订阅生命周期 = 组件生命周期；cleanup 调 `deactivate` | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/MarkdownPreview.tsx#L76-L89 |
| 4 | `MarkdownPreview.tsx:95-111` | `Suspense`, `data-state` | 静默 fallback；把「是否 ready」暴露给 CSS/测试 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/MarkdownPreview.tsx#L95-L111 |
| 5 | `apps/web/src/features/editor/previewFeed.ts:39-40` | `PREVIEW_DEBOUNCE_MS` | **400 ms 配置值**（不是测量值） | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/previewFeed.ts#L39-L40 |
| 6 | `previewFeed.ts:85-93` | `onTextChange`, `cancel`, `timer` | trailing debounce：每次变化重启窗口 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/previewFeed.ts#L85-L93 |
| 7 | `previewFeed.ts:100-113` | `activate`, `deactivate` | 进入即渲染一次（不 debounce）；退出清 timer + `unobserve` | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/previewFeed.ts#L100-L113 |
| 8 | `apps/web/src/features/editor/MarkdownPreviewRenderer.tsx:38-63` | `SAFE_PROTOCOLS`, `safePreviewUrl` | 协议 allowlist（`http:`/`https:`/`mailto:` + 相对 + `#fragment`） | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/MarkdownPreviewRenderer.tsx#L38-L63 |
| 9 | `MarkdownPreviewRenderer.tsx:78-105` | `PreviewLink`, `PreviewImage` | 被拒链接降级为 `<span>`；图片只留 alt，**永远不产生 `src`** | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/MarkdownPreviewRenderer.tsx#L78-L105 |
| 10 | `MarkdownPreviewRenderer.tsx:133-149` | `useEffect([source])`, `ReactMarkdown` | commit 后回报 ready；`remarkGfm` + `urlTransform` + 只覆盖 `a`/`img` | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/MarkdownPreviewRenderer.tsx#L133-L149 |
| 11 | `apps/web/src/features/editor/DocumentCanvas.tsx:35-57` | `DocumentCanvas` | 编辑器 pane 永远渲染（`display:none`）；preview 只条件挂载 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/DocumentCanvas.tsx#L35-L57 |
| 12 | `apps/web/src/features/editor/DocumentWorkspace.tsx:198` | `const [mode, setMode]` | **唯一的模式 bit**，UI state，未持久化 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/DocumentWorkspace.tsx#L198 |
| 13 | `DocumentWorkspace.tsx:279-300` | `DocumentCanvas` props | 传 `hidden={mode==='preview'}`；preview `key={session.localClientId}` | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/DocumentWorkspace.tsx#L279-L300 |
| 14 | `apps/web/src/features/editor/DocumentHeader.tsx:107-125` | 分段控件 | `aria-pressed` 表达状态；`mode-editor`/`mode-preview` 是 UI 契约 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/DocumentHeader.tsx#L107-L125 |
| 15 | `apps/web/src/features/editor/editorMode.ts:12-15` | `EditorMode`, `DEFAULT_EDITOR_MODE` | 两个词表集中一处，默认 `editor` | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/editorMode.ts#L12-L15 |
| 16 | `apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx:337-353` | `useLayoutEffect([hidden])` | 只做 CSS 做不到的事：恢复滚动/焦点，不重建 view | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L337-L353 |
| 17 | `apps/web/src/styles.css:742-744` | `.canvas-pane--hidden` | `display: none`（不是 `visibility`、不是卸载） | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/styles.css#L742-L744 |
| 18 | `apps/web/src/styles.css:893-905` | `.markdown-preview` | 只复刻排版 token；`data-state` 只改透明度 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/styles.css#L893-L905 |
| 19 | `apps/web/src/App.tsx:62-97` | `ClerkRoot` lazy | **另一处真实 lazy**，但拆的是认证壳，不是权限判定 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/App.tsx#L62-L97 |
| 20 | `apps/web/src/features/permissions/capabilityGate.ts:53-80` | `capabilityGate` | 同步纯函数；**在主包**，与 lazy 无关 | https://github.com/HE517/insighthub/blob/57a9bee5f2f8d6ff30f2a8373b61328546475183/apps/web/src/features/permissions/capabilityGate.ts#L53-L80 |

---

## 5. 状态归属表

| 状态 | 归属 | 创建 / 销毁 | 是否持久化 | 是否进 Redux | 证据 |
| --- | --- | --- | --- | --- | --- |
| 正文 `body` | **`Y.Text`**（`doc.getText('content')`） | session 生命周期 | 是（y-indexeddb + 服务端 store） | **否** | `MarkdownPreview.tsx:53-54`、`binary-frame.ts:109` |
| `mode`（editor/preview） | `ActiveDocument` 的 `useState` | workspace 挂载时创建；文档切换 remount 时重置 | 否 | **否** | `DocumentWorkspace.tsx:198` |
| 渲染快照 `sourceRef` | `MarkdownPreview` 的 `useRef<string \| null>` | 预览组件挂载时 init；unmount 丢弃 | 否 | 否 | `MarkdownPreview.tsx:64-70` |
| `phase`（rendering/ready） | `MarkdownPreview` 的 `useState` | 同上 | 否 | 否 | `MarkdownPreview.tsx:74` |
| `feed.active` + `timer` | `createPreviewFeed` 的闭包 | `activate()` 建订阅；`deactivate()` 清 timer | 否 | 否 | `previewFeed.ts:71-72,100-113` |
| 编辑器 `EditorView` / binding / undo / selection | CodeMirror + `collabTextBinding` | **跨模式存活**（不 unmount） | undo 历史在内存 | 否 | `DocumentCanvas.tsx:4-18`、`CollaborativeMarkdownEditor.tsx:309-322` |
| 滚动位置 / 是否曾有焦点 | `scrollMemory` / `hadFocus` refs | 编辑器挂载期 | 否 | 否 | `CollaborativeMarkdownEditor.tsx:154-159` |
| Redux（`document` / `connection` / `realtime`） | Redux store | app 生命周期 | 否（`activeDocumentId` 等元数据） | 是 | 浏览器 `preview/5` 断言前后 keys 相同、无 body 字符串 |
| awareness presence | Yjs awareness | session 生命周期 | 否 | 否 | 本流程不触碰 |

**要能脱口而出的一句：** 预览这条链路上，**没有任何一处**把正文复制进持久状态。
`sourceRef` 是「渲染快照」，只被 `Y.Text` 覆盖、从不写回、且随组件销毁。

---

## 6. 技术选型（需求 / 候选 / 当前 / 为什么 / 放弃 / 代价）

### 6.1 引入方式：静态 import vs `React.lazy` vs 路由级拆分

| 维度 | 静态 import | **当前：组件级 `React.lazy`** | 路由级拆分 |
| --- | --- | --- | --- |
| 首屏是否下载 49 kB gzip | 是 | **否**（点预览才下载） | 否，但本应用**没有 router**（单 workspace，靠 `documentId` 切换） |
| 首进预览成本 | 0 | **+一次 chunk 加载**（观测 359 ms） | 同左 |
| 失败面 | 无 | chunk 失败 = 新失败模式 | 同左 |
| 结论 | 否 | **是** | 不适用（无路由） |

> **为什么不做路由级**：应用是「一个 workspace + 文档切换」（`DocumentWorkspace.tsx:15-22`），
> 没有 route table。为 preview 引入 router 是架构级改动，收益为零。

### 6.2 更新策略：无 / throttle / **debounce** / rAF / `useDeferredValue`

| 候选 | 语义 | 为什么不用 / 用 |
| --- | --- | --- |
| 无 | 每次 update 都渲染 | 病理性文档每次按键全量解析，直接放弃 |
| throttle（固定间隔必发） | 每 400 ms 至少渲染一次 | 会在用户**持续打字**时不停渲染中间态，正是要避免的 |
| **trailing debounce 400 ms** | 停手 400 ms 后渲染一次 | ✅ 用户要的是「最终一致」，中间态无价值；实现只有 20 行、可 node 测试 |
| `requestAnimationFrame` 合并 | 每帧最多一次 | 只合并到 16 ms，对 Markdown 全量解析远远不够 |
| `useDeferredValue` | 让 React 把低优先级渲染让出去 | React 19 可用，但**它不会减少解析次数**：每次 `source` 变都会重新解析一次，只是可被打断。100k 文档仍会卡；且它无法「合并突发」 |
| `useMemo` | 缓存计算结果 | **不能替代 debounce**：`source` 每变一次就 miss 一次，memo 只避免「相同输入重复算」，而这里输入每次都不同 |

**为什么 `useMemo` 不是 debounce（高频追问）：** memo 的 key 是输入；debounce 的作用是**减少输入的数量**。
两者不在同一层：一个减少重复计算，一个减少渲染次数。

### 6.3 首次渲染：debounce 进入 vs **立即快照**

| 候选 | 用户看到 | 结论 |
| --- | --- | --- |
| 进入也走 400 ms | 先空白 400 ms，再出现内容 | 不可接受（闪一下空白） |
| **进入立即 `onSnapshot`** | 立刻有内容，之后才 debounce | ✅ `previewFeed.ts:104-105` 明确注释「must not open empty」 |

### 6.4 编辑器在预览模式下：unmount vs `display:none` vs 双挂载

| 候选 | 代价 |
| --- | --- |
| `mode === 'preview' ? null : <Editor/>` | 每次切换重建 `EditorView` + binding，丢光标、丢撤销历史、丢滚动 |
| **`display: none`（当前）** | 隐藏的编辑器仍接收远端 update、仍持有 DOM（内存不释放）；但换来实例级连续 |
| 双挂载（编辑器和预览都常驻） | 预览会在后台订阅 + 重渲染，正是要避免的 |

> 注意不对称：**编辑器保留，预览不保留**。原因不同——编辑器保留是为了「状态连续」，
> 预览不保留是为了「成本为零」。`DocumentCanvas.tsx:4-18` 把这两条写在同一段注释里。

### 6.5 Markdown 渲染器：`react-markdown` vs `marked + innerHTML` vs 自研

| 候选 | XSS 面 | 成本 | 结论 |
| --- | --- | --- | --- |
| `marked` + `dangerouslySetInnerHTML` | 必须自带 sanitizer，且 sanitizer 配错就是洞 | 小 | 否 |
| **`react-markdown` + `remark-gfm`（当前）** | **默认不解析 raw HTML**，React 转义文本；组件可覆写 | 49 kB gzip | ✅ |
| 自研 parser | 语法覆盖/维护成本高 | 大 | 否 |

### 6.6 安全模型：sanitizer vs **不产生危险节点**

| 候选 | 思路 | 结论 |
| --- | --- | --- |
| DOMPurify 清洗 HTML | 先允许 HTML，再删危险部分 | 否：没有 HTML 就没有可清洗的东西 |
| **不开 `rehype-raw`、不用 `dangerouslySetInnerHTML`、URL 协议 allowlist、图片不渲染** | 让危险节点**从未存在** | ✅ 见 §7.4 |

---

## 7. 关键实现细节

### 7.1 lazy 边界放在「只做一件事」的模块上

`MarkdownPreview.tsx` 是容器（状态、订阅、Suspense），`MarkdownPreviewRenderer.tsx` 是**唯一**
import 渲染依赖的模块。这样做的两个后果：

1. chunk 边界由**模块图**决定，而不是由某个 `if` 决定 —— 只要有人把 `react-markdown` import 到别处，
   chunk 就会静默回到主包；注释里明确写了这条纪律（`MarkdownPreviewRenderer.tsx:1-11`）。
2. 容器可以被 node 环境测试（`previewFeed.test.ts` 不需要 DOM），渲染器可以被
   `renderToStaticMarkup` 测试（`previewRenderer.test.ts`）——两层各自可测。

### 7.2 render 期初始化 ref：为什么不是 `useEffect`

```ts
const sourceRef = useRef<string | null>(null);
if (sessionRef.current !== session || sourceRef.current === null) {
  sessionRef.current = session;
  sourceRef.current = text.toString();
}
```

这是 React 官方允许的「render 期惰性初始化」模式：只要赋值是**幂等**的、且不触发其它副作用。
好处是**第一帧就有内容**；如果用 `useEffect` 初始化，首帧 `source` 是 `''`，
用户会看到一次「空文档 → 内容」的闪烁，`preview/1` 的 `data-state` 语义也会变得含糊。

`sessionRef` 的比较是给「调用方忘了按 `localClientId` 加 key」准备的兜底；生产路径上
父组件已经 `key={session.localClientId}`（`DocumentWorkspace.tsx:298`），所以正常是**新实例**而不是复用。

### 7.3 订阅生命周期：`activate` / `deactivate` 的幂等

| 方法 | 行为 | 幂等性 |
| --- | --- | --- |
| `activate()` | `active=true`；`text.observe(onTextChange)`；**同步**发一次 snapshot | 二次调用直接 return（`previewFeed.ts:101`） |
| `deactivate()` | `active=false`；`cancel()`；`text.unobserve(...)` | 二次调用直接 return（`previewFeed.ts:109`） |
| `onTextChange` | `if (!active) return` → `cancel()` → 起新 timer | 即使漏了 unobserve 也不会渲染（双保险） |

**为什么 `active` 检查是双保险而不是主机制**：主机制是「组件不挂载 → 不 activate」。
`active` 检查防的是「unobserve 尚未生效 / 回调已在队列里」的窗口。

### 7.4 安全：没有 HTML 可被解析，所以没有 sanitizer 可被配错

| 攻击面 | 处理 | 证据 |
| --- | --- | --- |
| `<script>` / `<iframe>` / `<img onerror>` | 不开 `rehype-raw` → 原始 HTML 变成**文本节点**，React 再转义 | `previewRenderer.test.ts:131-157`；浏览器 `preview/3` |
| `[x](javascript:...)` | `urlTransform=safePreviewUrl` 只放行 `http:`/`https:`/`mailto:` + 相对 + `#`；被拒后 `href=''` → 渲染成 `<span class="markdown-preview__link-blocked">`，**连可聚焦的空 anchor 都不留** | `MarkdownPreviewRenderer.tsx:51-87`；`previewRenderer.test.ts:159-189` |
| `data:` / `vbscript:` / `tel:` | 同上（`tel:` 被拒是刻意：产品不需要拨号） | `previewRenderer.test.ts:224-230` |
| 外链劫持 | `rel="noopener noreferrer"`，**不给 `target`**（预览不制造新的 browsing context） | `MarkdownPreviewRenderer.tsx:83`；浏览器断言 `hasTarget === false` |
| 追踪像素 / 混合内容 | `img` 组件**不产生 `<img>`、不写 `src`**，只显示 `[image: alt]`；浏览器断言 `performance.getEntriesByType('resource')` 里没有目标 host | `MarkdownPreviewRenderer.tsx:98-105`；`34-markdown-preview.mjs:1112-1126` |
| 屏幕阅读器被整篇文档刷屏 | 预览容器**不是** `aria-live`，fallback 也是静态文本 | `MarkdownPreview.tsx:29,95-111`；浏览器断言 `ariaLive === null` 且 descendant 数 0 |

> 诚实边界：这证明的是「本渲染器不会把 Markdown 里的 HTML 变成节点」，
> **不是**一次通用 sanitizer 审计（`34-markdown-preview.mjs:46-49` 自己就这么写）。

### 7.5 `ready` 是「commit 之后」才说的

renderer 用一个 `useEffect([source])` 调 `onRendered`。effect 在 paint 之后运行，
所以 `data-state="ready"` 的含义是「这一版快照已经进了 DOM」，而不是「setState 了」。
`onRendered` 存在 ref 里（`MarkdownPreviewRenderer.tsx:130-135`），
这样父组件传内联箭头函数也不会让 effect 每次父渲染都重跑 —— `source` 是唯一依赖。

### 7.6 模式切换不重建编辑器，但修复 CSS 做不到的两件事

`display: none` 会重置 `scrollTop`，也会让焦点丢失。所以编辑器自己：

- 在可见时每次 `scroll` 记住 `scrollDOM` 的 offset（`hidden` 时不记）；
- 恢复时**同步 + 下一帧**各设一次（CodeMirror 在 `display:none → visible` 后会重新测量，一次可能被夹到旧布局）；
- 只在「曾经有过焦点」时 `focus()`，否则用户按的是「编辑」按钮，焦点该留在按钮上。

这三条都在 `CollaborativeMarkdownEditor.tsx:337-353` 的注释里，属于「CSS 切模式」必须补齐的边角。

### 7.7 文档切换 = 重挂载 = 模式重置

`App.tsx` 用 `documentId` 给 workspace 加 key，所以切文档会销毁整个 workspace
（`DocumentWorkspace.tsx:15-22`，R15 一 socket 一房间）。副作用是 `mode` 回到 `editor`。
这是**有意的**：A 文档的预览快照绝不能出现在 B 文档上。

---

## 8. 为什么不用 X

| 没用的东西 | 为什么不用 | 如果非要用，代价是什么 |
| --- | --- | --- |
| `rehype-raw` + DOMPurify | 多一个依赖 + 一个必须配对的 sanitizer；当前产品不需要文档内嵌 HTML | 安全审计面从「无 HTML」变成「sanitizer 正确性」 |
| `<iframe sandbox>` 渲染 HTML | 引入跨文档边界、高度同步、主题隔离；收益只是支持 raw HTML | 布局/交互复杂度暴涨 |
| Web Worker 解析 Markdown | 结构化克隆 6.8 MB 文本 + 传 AST 回主线程，成本可能高于解析本身；且需要 worker 打包策略 | 首次进预览更慢，复杂度更高 |
| 虚拟化（只渲染视口内的 Markdown） | 需要可测量的块高度、滚动锚定，且会改变「整篇可 Ctrl+F」的行为 | 语义变化，不是纯性能补丁 |
| 预览常驻（隐藏但不卸载） | 会在编辑器背后持续 observe + 渲染，正是本设计要消除的成本 | 每次按键都多一次全量渲染 |
| `useDeferredValue` | 减少「渲染优先级」，不减少「解析次数」；对 100k 无解 | 复杂度上升、收益不确定 |
| `useTransition` 包住 mode 切换 | 切换本身是同步 UI，没有可延迟的重活；延迟反而让用户觉得按钮没反应 | 无收益 |
| 在 `Suspense` 里用 React 19 `use()` 拿数据 | 这里没有 promise 数据源；`Y.Text` 是同步可读的 | 无收益 |
| SSE / 流式渲染 preview | 没有流式数据源（正文是 CRDT，不是流） | 见 `06` 的 AI 流式（planned） |
| Error boundary + 重试按钮 | **确实没做**，是已知缺口（`34-markdown-preview.mjs` 也只覆盖 happy path） | 加 boundary 是明确可做的下一步 |

---

## 9. Used 知识点（定义 / 在哪 / 为什么 / 追问 / 答案）

### 9.1 `React.lazy` + `Suspense`

- **定义**：`lazy(() => import(...))` 返回一个「可挂起」的组件类型；首次渲染时抛出一个 thenable，
  由最近的 `<Suspense>` 接住并显示 fallback，promise resolve 后重试渲染。
- **在哪**：`MarkdownPreview.tsx:38`（`lazy`）+ `:102-110`（`Suspense`）。
- **为什么**：把 `react-markdown` 的 49 kB gzip 移出首屏。
- **追问**：「lazy 组件每次渲染都会重新 import 吗？」
- **答案**：不会。模块加载由 bundler 的 module registry 缓存；`lazy` 只保留一个 pending promise，
  resolve 后同步可用。真正会重复的是**渲染**，不是加载。

### 9.2 代码分割（chunk graph）

- **定义**：bundler 把动态 `import()` 的模块及其独占依赖拆成独立 chunk。
- **在哪**：`MarkdownPreviewRenderer.tsx` 是 `react-markdown`/`remark-gfm` 的**唯一**入口，
  所以这两个包只落在预览 chunk。
- **为什么**：chunk 边界 = 模块边界，可被 import 图静态验证。
- **追问**：「怎么证明它没回主包？」
- **答案**：产物里主 chunk 对 `react-markdown`/`micromark` 的引用为 0；
  且 §12 的 chunk 尺寸是在 build 产物里按文件名读出来的（原始 dist 不入库，见 §12.1 的 provenance 说明）。

### 9.3 trailing debounce

- **定义**：每次触发都重置计时器，只在「最后一次触发后静默 N ms」执行一次。
- **在哪**：`previewFeed.ts:85-93`。
- **为什么**：用户关心停手后的最终文本，不关心中间态。
- **追问**：「leading + trailing 有什么区别？为什么不用 leading？」
- **答案**：leading 会在**第一次**变化时立刻渲染，然后静默期内不再渲染 —— 对「打字」场景
  等于「渲染第一个字符的中间态」，是最没价值的那一帧。trailing 才对齐「停手看结果」。

### 9.4 effect 清理与订阅生命周期

- **定义**：`useEffect` 返回的函数在该次 effect 失效或组件卸载时执行。
- **在哪**：`MarkdownPreview.tsx:76-89` 的 `return () => feed.deactivate()`。
- **为什么**：把「订阅存在」与「组件存在」绑定，避免隐藏预览在后台工作。
- **追问**：「StrictMode 双挂载会不会导致两次订阅？」
- **答案**：会 mount → unmount → mount，但 `activate`/`deactivate` 幂等，且 cleanup 一定
  `unobserve`，所以稳态只有一份订阅。`previewFeed.test.ts:77-91` 直接测了「二次 activate 不再渲染」。

### 9.5 render 期 ref 惰性初始化

- **定义**：在函数组件体内对 ref 做一次幂等赋值，而不是放在 effect 里。
- **在哪**：`MarkdownPreview.tsx:64-70`。
- **为什么**：首帧就要有内容。
- **追问**：「这不是反模式吗？」
- **答案**：不是，前提是赋值**幂等**且不触发订阅/网络。React 文档明确允许「惰性初始化 ref」；
  反模式是「在 render 里做副作用」。

### 9.6 `Y.Text.observe`

- **定义**：Yjs 文本类型的事件订阅，任何事务（本地/远端/撤销）造成的变更都会触发。
- **在哪**：`previewFeed.ts:103`（observe）、`:112`（unobserve）。
- **为什么**：预览必须看到**所有**来源的变更，而不只是本地输入。
- **追问**：「observe 和 observeDeep 的区别？」
- **答案**：`observe` 只看这一层的文本变更；`observeDeep` 会冒泡子类型。
  这里只有一段扁平文本，`observe` 足够，也更便宜。

### 9.7 `urlTransform`（react-markdown 的 URL 处理钩子）

- **定义**：渲染每个链接/图片 URL 前调用的函数，返回 `''` 表示拒绝。
- **在哪**：`MarkdownPreviewRenderer.tsx:51-63,144`。
- **为什么**：默认 allowlist 还允许 `irc:`/`xmpp:`；产品不需要，闭合列表更易审计。
- **追问**：「相对 URL 怎么判断协议？」
- **答案**：用 `new URL(url, 'https://insighthub.invalid/')` 分类（这个 base **从不**被访问），
  只用于判断 protocol；`#fragment` 单独放行（同文档导航没有协议）。

### 9.8 React 转义 / 不产生危险节点

- **定义**：React 把字符串子节点当文本，不会解析成 HTML。
- **在哪**：`MarkdownPreviewRenderer.tsx:16-19` 的注释 + 测试。
- **为什么**：这是「不用 sanitizer 也安全」的根据。
- **追问**：「那 `dangerouslySetInnerHTML` 用一次会怎样？」
- **答案**：会立刻把安全模型从「无 HTML」变成「信任输入」，必须同时引入 sanitizer 和测试，
  属于产品决策，不是顺手改。

### 9.9 `display: none` vs unmount

- **定义**：前者保留 DOM 与组件实例，后者销毁。
- **在哪**：`styles.css:742-744` + `DocumentCanvas.tsx:35-57`。
- **为什么**：保留 `EditorView`/binding/undo/selection。
- **追问**：「hidden 的编辑器还会收远端更新吗？」
- **答案**：会，而且**必须**收 —— 否则切回编辑会看到旧文本。`preview/2` 专门断言
  「同一远端更新也在隐藏编辑器里」。

### 9.10 React 19 相关（本功能实际用到 / 没用到）

- **用到**：函数组件 + hooks 的既有模型；没有用 19 的新 API。
- **没用到**：`use()`、Actions、`useOptimistic`、Server Components、`useDeferredValue`。
- **追问**：「React 19 对流式/增量渲染有什么支持？」
- **答案**：19 有 `use()`/Suspense/transition 这套「可中断渲染」能力，
  但本项目既没有流式数据源，也没有用它做 preview。不要把它说成「用了 React 19 的流式能力」。

---

## 10. Related but not used

> 以下每一项都必须按这个标签说：**`RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED`**。
> 知道它、能比较它，不等于做过它。

| 项 | 标签 | 一句话说明 |
| --- | --- | --- |
| `useDeferredValue` | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 可让低优先级渲染被打断，但不减少解析次数；本项目用 debounce |
| `useTransition` / `startTransition` | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 适合「切换一个重子树」，本项目的重活在 Markdown 解析，不在 React 调度 |
| React 19 `use()` + Suspense 数据获取 | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 本项目没有 promise 数据源；`Y.Text` 同步可读 |
| Streaming SSR / RSC | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 纯 Vite SPA，没有服务端渲染 |
| 虚拟化（`react-window` 类） | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 会改变 Ctrl+F 与可访问性语义，未做 |
| Web Worker 解析 | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 未做；100k 仍是 limitation |
| `IntersectionObserver` 延迟挂载 | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 预览是按 mode 挂载，不是按可见性 |
| `content-visibility: auto` | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 未使用；可能改变布局/查找行为 |
| `useSyncExternalStore` 订阅 `Y.Text` | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 直觉方案，但会变成「每次 update 都渲染」，与本设计相反 |
| `<link rel="preload">` / `modulepreload` 预取预览 chunk | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 未做；做了会把 49 kB 又拉回首屏 |
| Error boundary + chunk 重试 | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | **明确缺口**，不是已实现 |
| SSE / 流式 Markdown 渲染 | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 无流式数据源 |
| React Compiler | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 未启用；本项目的手写 memo 只有 `useCallback(markReady)` |
| 路由级 code splitting | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 无 router |
| `requestIdleCallback` 预热 | RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED | 未做 |

---

## 11. 测试（Given / When / Then）

### 11.1 单元层（node，无 DOM）

**G1 · `previewFeed.test.ts:57-92` — 进入即渲染一次**

- **Given** 一个真实 `Y.Doc`，`Y.Text = '# Hello\n\nWorld'`
- **When** `feed.activate()`
- **Then** `snapshots === ['# Hello\n\nWorld']`；且**没有**用 fake timer；二次 `activate()` 不再渲染。

**G2 · `previewFeed.test.ts:94-141` — 400 ms 窗口与合并**

- **Given** 真实 `Y.Text`，`debounceMs` 默认 400
- **When** 在 0 ms 与 200 ms 各插入一个字符
- **Then** 399 ms 时无快照；400 ms 时恰好一次 `'abc'`（从**最后一次**变化计时）。

**G3 · `previewFeed.test.ts:143-161` — 远端编辑走同一 observer**

- **Given** 已 activate 的 feed
- **When** `session.applyRemoteText(t => t.insert(0, 'REMOTE '))` 并推进 400 ms
- **Then** 快照为 `'REMOTE base'`。

**G4 · `previewFeed.test.ts:164-231` — 订阅与可见性绑定**

- **Given** 未 activate / 已 deactivate 的 feed
- **When** 修改 `Y.Text` 并推进时间
- **Then** **零**快照；再次 `activate()` 时立刻给出**最新**文本（不是编辑前的旧文本）。

**G5 · `previewFeed.test.ts:234-304` — 只读（R11）**

- **Given** 文档 `'# Title\n\nBody with **bold**.'`，`spyOn` `session.transact` / `doc.transact` / `text.insert` / `text.delete`
- **When** activate → 推进 3×400 ms → deactivate → 再推进 3×400 ms
- **Then** 四个写入口**一次都没被调用**；文本 SHA-256 与 state-vector 十六进制串**完全不变**；
  100k fixture 只产生 1 个快照，且 `entryMs < 5000`（node 侧 instrumentation）。

**G6 · `previewRenderer.test.ts:34-110` — 语义 DOM**

- **Given** 逐段 Markdown（h1–h6 / p / strong / em / ul / ol / blockquote / fence / GFM table）
- **When** `renderToStaticMarkup`
- **Then** 出现对应语义元素；fence 保留 `language-ts` class；空文档有显式 empty state。

**G7 · `previewRenderer.test.ts:113-230` — 安全边界**

- **Given** `<script>` / `<img onerror>` / `<iframe>` / `[x](javascript:…)` / `[p](data:…)` / `![alt](https://…/x.png)`
- **When** 渲染
- **Then** 无 `<script>`/`<img>`/`<iframe>`；无 `on*`；`javascript:`/`data:` 被拒且**没有 `<a>`**；
  图片只剩 `[image: alt]`，`src` 不存在；安全链接有 `rel="noopener noreferrer"` 且**无 `target`**。

**G8 · `editorModeSwitch.test.ts:79-143` — 模式与不卸载**

- **Given** 渲染 workspace
- **When** 切到 preview
- **Then** `编辑` 不再 pressed、`预览` pressed；`[data-pane="editor"]` **仍在**但带 `canvas-pane--hidden`；
  preview pane 出现；`data-mode="preview"`。

### 11.2 真实浏览器（CDP，`tests/browser/suite/34-markdown-preview.mjs`）

| 场景 | Given | When | Then |
| --- | --- | --- | --- |
| `preview/1-toggle-preserves-editor` | 真实 Chromium、真实服务端、第二 peer 写入 seed 文本；键盘 `Ctrl+Home` + 10×`Shift+ArrowRight` | CDP 真点击 `mode-preview` → 再点 `mode-editor` | `.cm-editor` 数量恒为 1；DOM 节点上的 stamped marker 不变；`MutationObserver` 的 mount/unmount 计数不变；text / `viewId` / selection 不变；回编辑后还能继续输入 |
| `preview/2-renders-and-debounces` | 富文本文档（标题/列表/引用/fence/表格/链接） | 另一 Yjs peer 经**真实 WebSocket** 在预览可见时注入 `### Remote …` | 250 ms 检查点**不含**新文本；600 ms 检查点**含**；页面侧 `previewAt - landedAt ≥ 400-50 ms` 且 `≤ 2500 ms`；结构断言 h3 变 2、段落出现；隐藏编辑器也收到了同一更新且未 remount |
| `preview/3-security` | 含 script/img-onerror/iframe/javascript:/tracking image 的文档 | 进入预览 | `<script>=<img>=<iframe>=<object>=0`；`on*` 属性数组为空；`src` 属性数组为空；`window.__previewPwned === null`；只有 1 个 anchor（安全链接）且 `rel` 正确、无 `target`；`performance` 里没有 tracking/evil host 的请求；容器非 `aria-live` |
| `preview/4-large-document-20k-browser` | 用**生产持久化 seam** 种入 20k 行切片（100k 的浏览器可行子集） | 首次进入预览 | `data-state="ready"`；预览文本覆盖 ≥99% fixture；进入前后 `Y.Text` SHA-256、state-vector、`encodeStateAsUpdate` SHA **全不变**；回编辑不 remount |
| `preview/5-redux-no-body` | 带唯一 body marker 的文档 | 进入预览 | store 前后 `keys` 完全相同（没新增 slice）；无 `content/text/body` 字段；无 ≥200 字符的字符串值；`bytes < 8192`；预览确实渲染了那个「Redux 里不存在」的 marker |

### 11.3 全量套件

- 默认浏览器套件：**78/78 PASS**，合并提交 `7585263`（记录于 `docs/TASKS.md:883`；
  `docs/resume-evidence/README.md:176-181` 记录了 73 → 78 的追加过程）。
- 单元：preview 合并时 vitest **608**（`docs/TASKS.md:883`）。
- **注意**：`preview/4` 的注册 id 是 `preview/4-large-document-20k-browser`
  （`34-markdown-preview.mjs:1148`），而文件头注释（`:18`）写的是 `preview/4-100k-does-not-touch-data`。
  两者指同一个场景；**100k 的浏览器尝试是记录下来的 timeout，不是 PASS**（见 §12、§13）。

---

## 12. 数字定义（每一个都要能说出「测的是什么、不是什么」）

### 12.1 产物尺寸

| 数字 | 值 | 定义 | 不是什么 | 出处 |
| --- | --- | --- | --- | --- |
| 预览 chunk（raw） | **160.46 kB** | 构建后 lazy chunk 的未压缩字节 | 不是网络传输量（还有 gzip/brotli） | `docs/interview/INSIGHTHUB-INTERVIEW-QA.md:192`；`docs/TASKS.md:883` 记 48.99 kB gzip |
| 预览 chunk（gzip） | **48.99 kB** | 同一 chunk 的 gzip 后字节 | 不是「主包增长了 49 kB」 | 同上 |
| 主包增量（gzip） | **+0.99 kB** | 为接入 preview 在主 chunk 里新增的字节（容器/模式/样式） | 不是「省了 49 kB」——省的是**首屏不下发** | 同上 |

> **Provenance 诚实说明**：这两个数字来自构建产物清单，**`apps/web/dist` 不入库**
> （`.gitignore:6`），所以在本 commit 的 tree 里无法直接复算。复算方式：
> `pnpm build` 后看 `apps/web/dist/assets/` 里的 chunk 文件名与大小。

### 12.2 首次进预览耗时（观测，不是 benchmark）

| 数字 | 值 | 定义 | 不是什么 |
| --- | --- | --- | --- |
| 首次进预览 | **359 ms** | 一次观测：点击 → 预览 ready（**包含** lazy chunk 加载 + 解析 + 提交） | 不是 P50/P95，不是 benchmark，不是多轮采样 |
| 第二次进预览 | **63 ms** | 同页面内再次进入（chunk 已被 HTTP/module 缓存） | 不是「优化后」的对比，只是缓存效应 |

出处：`docs/interview/INSIGHTHUB-INTERVIEW-QA.md:222`。**只有一组观测**，不能说「平均 359 ms」。

### 12.3 100k 文档

| 数字 | 值 | 定义 | 不是什么 |
| --- | --- | --- | --- |
| 浏览器进入预览 | **420 s 场景预算内未 ready** | `suite/34` 的 100k 尝试在 420 s 超时；该场景**改为 20k 切片**并记录 limitation | **不是 PASS**，不是「420 s 能打开」 |
| node 端 parse+render | **~719 ms** | 100k fixture 在 node 里 `parse + React elements` 的一次计时（测试 instrumentation） | 不是浏览器渲染时间；浏览器 DOM 提交远慢于此 |

出处：`DECISIONS.md:3768`（D-087 §4）、`docs/TASKS.md:883`、`34-markdown-preview.mjs:1155-1157`。

### 12.4 debounce 与计数

| 数字 | 值 | 定义 | 不是什么 |
| --- | --- | --- | --- |
| `PREVIEW_DEBOUNCE_MS` | **400** | **配置值**（源码常量） | **不是 Preview P50**，不是实测延迟 |
| 浏览器观测延迟 | `≥ 350 ms` 且 `≤ 2500 ms`（断言边界） | 页面侧采样：`EditorState` 首次包含 needle → 预览 DOM 首次包含 needle | 采样粒度 10 ms；没记录具体值，所以**不能引用一个 P50** |
| 预览场景数 | **5** | `suite/34` 注册的 5 个场景 | 不是 100k 的证据 |

### 12.5 套件数字

| 数字 | 值 | 定义 | 不是什么 |
| --- | --- | --- | --- |
| 默认浏览器套件 | **78/78 PASS** | 73 原有 + 5 preview，真实 Chromium/CDP | 不是 remote 模式（remote = 83 注册，**未跑**） |
| vitest | **608** | preview 合并时的单元/集成测试数 | 不是覆盖率 |

---

## 13. 边界与答法

| 边界 | 事实 | 怎么答（不要说错） |
| --- | --- | --- |
| lazy chunk 加载失败 | `React.lazy` reject → 最近 error boundary；**仓库里没有 boundary**，也没有重试按钮 | 「这是已知缺口。正确做法是 error boundary + 重试 + 可观测事件，我没有把它包装成已实现。」 |
| 100k 文档 | 浏览器 420 s 内未 ready；node 约 719 ms 只是解析 | 「预览对普通文档可用；100k 是明确 limitation。要做得先解决分片/虚拟化/worker，且不能破坏 `Y.Text` 单一源。」 |
| 文档里有 raw HTML | 不解析，显示成字面文本 | 「这是安全模型的产品决策：预览不支持内嵌 HTML。」 |
| 图片 | 不产生 `<img>`，只有 alt 占位 | 「预览不发任何外部请求；代价是图片不显示。」 |
| 链接 | 无 `target`，同标签页导航 | 「预览不制造新的 browsing context，避免 opener 风险。」 |
| Clerk 模式下的预览 | D-087 §4 明确：**未实测** | 「只在 demo 模式实测过；Clerk 模式的 preview 没有单独证据。」 |
| 预览的可访问性 | 不是 `aria-live`，不播报更新 | 「刻意保持安静：整篇文档被播报比不播报更糟。代价是屏幕阅读器用户不会自动听到更新。」 |
| 模式状态 | `useState`，不持久化 | 「UI 状态，刷新回到编辑模式；这是设计，不是 bug。」 |
| 「权限模块 lazy」 | 不成立 | 「lazy 的是 Clerk 认证壳；权限是主包里的同步 gate。」 |
| 「协作更新批量合并」 | 不成立（文本逐条发） | 「文本按 Yjs 增量逐条发送，合并的是 awareness presence（50 ms）。」 |
| 「AI 流式」 | 不存在 | 「一次请求返回完整 draft；流式是未实现能力。」 |
| 两个用户 vs 多用户 | 协同证据恰好两个独立 context | 「只验证过两个用户；3+ 未验证。」 |

---

## 14. 追问 ≥15（每题给「短答 + 展开」）

**Q1. `React.lazy` 的原理是什么？**
短答：`lazy` 记住一个动态 import 的 promise；首次渲染时如果 promise 未完成就 throw 它，
最近的 `Suspense` 接住并显示 fallback，完成后 React 重试渲染。
展开：模块只加载一次（bundler registry），所以「懒」只影响**首次**；之后是同步可用。

**Q2. `Suspense` 在这里到底接住了什么？**
短答：接住的是「渲染器模块还没到」这一件事，不是数据请求。
展开：所以 fallback 只是一行静态文本；`data-state="rendering"` 覆盖的是「有快照但还没 commit」的窗口。

**Q3. chunk 加载失败会怎样？**
短答：`lazy` 的 promise reject，错误抛给最近的 error boundary；本仓库没有 boundary，
所以是错误上抛、预览区不可用。
展开：这是已知缺口；正确做法是 boundary + 重试按钮 + 事件上报（不新增 telemetry 依赖）。

**Q4. debounce 期间 UI 显示什么？会闪吗？**
短答：显示上一帧**完整**的预览，`data-state="rendering"` 只让 body 透明度变 0.82，不改布局。
展开：没有骨架屏、没有空白；因为快照只在到点时替换，React 也不会把旧 DOM 先清空。

**Q5. 为什么 400 ms？不是 200 或 1000？**
短答：400 ms 是**配置值**，选它是「人打字停顿的量级」与「最多等半秒」的折中。
展开：它不是测出来的 P50；改它只需要改一个常量（测试用 `debounceMs` 注入更短值）。如果要数据驱动，
应该先测「打字间隔分布」与「单次渲染成本」，本项目没做这件事。

**Q6. 100k 文档进预览为什么会卡？**
短答：Markdown 解析 + React 元素树 + DOM 提交都是全量、主线程、超线性（病理性单段落放大），
420 s 预算内没到 ready。
展开：node 侧解析约 719 ms 只是第一段成本；真正贵的是浏览器建 DOM 与样式/布局。
可行方向：分片渲染 / 虚拟化 / worker 解析，但都不能破坏 `Y.Text` 单一源与 Ctrl+F 语义。

**Q7. XSS 怎么防的？为什么不需要 sanitizer？**
短答：因为**从不解析 raw HTML**：没有 `rehype-raw`、没有 `dangerouslySetInnerHTML`，
原始 HTML 变成文本节点后由 React 转义；链接走协议 allowlist；图片不产生 `<img>`。
展开：这是「让危险节点不存在」而不是「事后清洗」。测试覆盖 script/onerror/iframe/javascript:/data:。

**Q8. 为什么不用 `useMemo` 代替 debounce？**
短答：memo 减少「相同输入重复计算」，debounce 减少「输入的数量」。
展开：`source` 每次都不同，memo 每次都 miss；真正要做的是「少渲染几次」。

**Q9. 为什么编辑器和预览的挂载策略相反？**
短答：编辑器保留是为了状态连续（`EditorView`/binding/undo/selection/scroll）；
预览不保留是为了成本为零（隐藏就不能订阅、不能重渲染）。
展开：`DocumentCanvas.tsx:4-18` 把这两个理由写在一起，避免后来者「统一」掉。

**Q10. 隐藏的编辑器还收远端更新吗？**
短答：收，而且必须收，否则切回编辑会看到旧文本。
展开：`preview/2` 断言同一远端 update 同时出现在隐藏编辑器与预览里，且没有 remount。

**Q11. 切换模式会不会丢撤销历史/光标？**
短答：不会。`EditorView` 没被销毁，selection 在 `EditorState` 里；滚动与焦点由编辑器自己恢复。
展开：`preview/1` 用真实键盘造 selection，切换往返后 anchor/head 完全一致。

**Q12. 预览会不会写文档？**
短答：不会。`previewFeed` 没有写方法；浏览器断言 `Y.Text` SHA、state-vector、durable bytes 全不变。
展开：这是 `AGENTS.md` R11 的运行时证据，不是「看代码觉得没有」。

**Q13. 首次进预览 359 ms 合理吗？**
短答：作为**一次观测**合理：它包含 chunk 下载 + 解析 + 提交；二次进入 63 ms 说明主要是加载成本。
展开：没有做多轮采样，所以不能说「平均」；如果产品要求「打开即预览」，就应该把渲染器放回主包或 preload。

**Q14. 为什么不用 `IntersectionObserver` 做懒挂载？**
短答：预览的挂载条件是「模式 = preview」，不是「滚动到可见」。
展开：用 observer 会引入「挂载了但不可见」的中间态，反而让订阅生命周期变复杂。

**Q15. 如果文档切换发生在预览中？**
短答：workspace 按 `documentId` remount，模式回到 `editor`；预览实例按 `localClientId` 加 key，
旧快照不可能出现在新文档上。
展开：这是「一 socket 一房间」（R15）在 UI 层的自然结果，不是额外机制。

**Q16. 这套设计最大的代价是什么？**
短答：两个：① 首次进预览多一次 chunk 往返，且失败没有兜底 UI；② 100k 文档预览不可用。
展开：两者都是「不为未验证场景做投机优化」的自觉选择。

**Q17. 你怎么证明「预览没有把正文放进 Redux」？**
短答：`preview/5` 从 React fiber 找到真实 store，进入预览前后 `JSON.stringify(getState())`，
断言 keys 不变、无 `content/text/body` 字段、无 ≥200 字符字符串、`bytes < 8192`。
展开：这是动态断言，不是「看 slice 定义」。

**Q18. 如果让你重做，会改哪三件事？**
短答：① 一开始就给 lazy chunk 加 error boundary + 重试；② 从一开始就把 100k 的降级策略
（分片/虚拟化）纳入设计，而不是等 420 s 超时才发现；③ 记录一次多轮采样的「进预览耗时分布」，
这样 359 ms 就不是孤证。

---

## 15. 决策复盘表

| # | 当时决定 | 备选 | 当时的理由 | 付出的代价 | 今天会改吗 |
| --- | --- | --- | --- | --- | --- |
| 1 | 渲染器用组件级 `React.lazy` | 静态 import / 路由级 | 首屏不需要 Markdown；无 router | 首进多一次 chunk；失败面无兜底 | 保留，但**加 boundary + 重试** |
| 2 | 编辑器 `display:none` 不卸载 | 条件卸载 / 双挂载 | 保 `EditorView`/undo/selection/scroll | 隐藏 DOM 常驻内存 | 保留 |
| 3 | 预览**按需挂载** | 常驻隐藏 | 隐藏预览不能订阅/重渲染 | 每次进入都重建容器（很便宜） | 保留 |
| 4 | 400 ms trailing debounce | throttle / rAF / `useDeferredValue` | 只要最终态，合并突发 | 最多 400 ms 陈旧 | 保留，但补一次延迟分布测量 |
| 5 | 进入预览**立即**渲染，不 debounce | 统一 debounce | 不能开空屏 | 100k 时首次渲染就是重活 | 保留（配合 100k 降级再谈） |
| 6 | 不做 raw HTML | `rehype-raw` + sanitizer | 没有 HTML 就没有可清洗的东西 | 文档里的 HTML 变成文本 | 保留 |
| 7 | 图片降级为 alt | 渲染 `<img>` + CSP | 预览不发外部请求 | 图片不显示 | 保留（若要做，必须配 CSP/代理） |
| 8 | 链接不给 `target` | `target="_blank"` | 不制造新 browsing context | 点击离开当前页 | 保留 |

---

## 16. 30 秒 / 90 秒 / 3 分钟

### 30 秒（电梯版）

> 我给 Markdown 预览做了组件级 lazy 拆分：渲染器单独一个 chunk（49 kB gzip），不点预览就不下载，
> 主包只多了约 1 kB。预览只在可见时挂载并订阅 `Y.Text`，编辑后 400 ms debounce 再渲染；
> 编辑器在预览模式下只 `display:none`、不卸载，所以光标、撤销、滚动都还在。
> 预览是纯只读派生，不写正文，也不进 Redux。

### 90 秒（面试主答）

> 这条简历要拆成三件事，其中一件不成立。
> 第一，`React.lazy` 是真的：`MarkdownPreviewRenderer` 是唯一 import `react-markdown` 的模块，
> 预览 chunk 160 kB raw / 49 kB gzip，主包只增加约 1 kB。但**权限模块不是 lazy**——
> lazy 的是 Clerk 认证壳，权限判定是主包里的同步 gate，因为它必须在第一帧就能算。
> 第二，Preview 的更新策略是 400 ms trailing debounce，只在预览可见时订阅，进入预览立即渲染一次，
> 切回编辑就 `deactivate`（清 timer + unobserve）。编辑器不卸载，只 `display:none`，
> 所以 `EditorView`、binding、undo、selection、滚动都不丢；这三条有真实浏览器场景证明。
> 第三，「AI 流式增量渲染」**没有实现**，一次请求返回完整 draft；「协作更新批量合并」也没有——
> 文本按 Yjs 增量逐条发，唯一 50 ms 合并的是 awareness presence。这两句我不会说。
> 代价我也说清楚：chunk 失败没有重试 UI；100k 文档进预览在 420 s 内没 ready，是明确 limitation。

### 3 分钟（深挖版）

> （在 90 秒基础上按「数据流 → 生命周期 → 安全 → 数字 → 边界」展开）
>
> **数据流**：`Y.Text` 是唯一真相。进预览时先从 `getText('content')` 取快照，在 render 期一次性写进
> ref（保证第一帧有内容）；同时 `createPreviewFeed().activate()` 立刻再发一次快照并 `observe`。
> 之后任何来源的变化（本地按键、远端 update）都走同一个 observer：取消旧 timer、起新的 400 ms；
> 到点后 `toString()`，如果和当前快照相同就不渲染。渲染完 renderer 用 `useEffect` 回调 `ready`。
>
> **生命周期**：订阅 = 组件生命周期。切走就 unmount → `deactivate`，所以隐藏的预览不存在，
> 不可能在编辑器背后重渲染。编辑器相反：保留实例，只 `display:none`，并用一个只依赖 `hidden`
> 的 layout effect 恢复 `scrollTop`（同步 + 下一帧各一次）和焦点（仅当之前有焦点）。
>
> **安全**：不开 `rehype-raw`、不用 `dangerouslySetInnerHTML`，raw HTML 就是文本；
> 链接用协议 allowlist（http/https/mailto/相对/#），被拒就渲染成 `<span>`，连空 anchor 都不留；
> 图片只显示 alt，不产生 `src`，所以预览不会发出任何外部请求；容器不是 `aria-live`。
>
> **数字**：49 kB gzip 是 chunk，不是主包增量；400 ms 是**配置值**，不是 P50；
> 359 ms/63 ms 是一次观测（首进含 chunk 加载）；100k 浏览器 420 s 未 ready 是 limitation，
> node 719 ms 只是解析成本。
>
> **边界**：chunk 失败没有 boundary；Clerk 模式下预览未实测；raw HTML 显示为文本；
> 图片不显示；链接同标签页。这些我都当成能力边界说，不包装成特性。

---

## 17. ASCII 图

### 17.1 组件树（preview 模式）

```text
ActiveDocument (DocumentWorkspace.tsx)
├── DocumentHeader ................ [编辑][预览] aria-pressed, mode-editor/mode-preview
├── doc-notices ................... OfflineNotice / ReadOnlyNotice / undo-state(sr-only)
├── AiSuggestPanel ................ 仅 aiOpen 时挂载（另一条链路）
└── DocumentCanvas ................ data-mode="preview"
    ├── div[data-pane="editor"] ... class += canvas-pane--hidden  → display:none
    │   └── CollaborativeMarkdownEditor   ← 实例存活，binding/undo/selection 保留
    └── div[data-pane="preview"] .. 仅 preview 模式存在
        └── MarkdownPreview ......... key={session.localClientId}
            ├── section[data-testid=markdown-preview][data-state=rendering|ready]
            └── Suspense fallback="Rendering preview…"
                └── lazy(MarkdownPreviewRenderer)   ← chunk 边界
                    └── ReactMarkdown(remark-gfm, urlTransform=safePreviewUrl)
```

### 17.2 单向数据流（没有第二条箭头）

```text
            ┌──────────────── Y.Text (唯一真相) ────────────────┐
            │  doc.getText('content')                          │
            └───────┬───────────────────────────────▲──────────┘
        toString()  │                               │ observe / unobserve
                    ▼                               │
            sourceRef (渲染快照, 只读)      createPreviewFeed (400ms trailing)
                    │                               │
                    │  setState(phase)              │ onSnapshot(text)
                    ▼                               ▼
            MarkdownPreview ──source──► lazy Renderer ──DOM──► 屏幕
                    │
                    └── phase='ready' ◄── useEffect([source]) onRendered

   写路径：无。previewFeed 没有 insert/delete/transact；preview 不碰 Redux。
```

### 17.3 一次远端编辑的时序（页面侧时钟）

```text
t0        peer 经 WebSocket 写入
t0+ε      Y.Text 变化 → observer → cancel(旧) + setTimeout(400)
t0+250ms  【检查点】预览仍是旧内容   ← preview/2 断言 previewHasNeedle === false
t0+400ms  timer 到点 → toString() → sourceRef 更新 → setState('rendering')
t0+4xx    React render → commit → effect → setState('ready')
t0+600ms  【检查点】预览含新内容     ← preview/2 断言 previewHasNeedle === true
          断言：previewAt - landedAt ≥ 350ms 且 ≤ 2500ms（采样粒度 10ms）
```

### 17.4 首次进预览的 chunk 加载

```text
click [预览]
   │  setMode('preview')            (sync, React state)
   ├─► editor pane  display:none    (sync, CSS class)
   └─► preview pane  mount
         ├─ snapshot from Y.Text    (sync, render 期 ref init)
         ├─ lazy import ───────────► 浏览器请求 hashed chunk   (async, 网络)
         │     └─ 失败 → reject → 最近 error boundary（本项目：无）
         ├─ fallback "Rendering preview…"   [data-state=rendering]
         └─ chunk ok → render → commit → effect → ready
```

---

## 18. 记忆点

1. **一句话**：预览是**只读派生**；懒的是**渲染器**；debounce 的是**渲染**，不是协作同步。
2. **两个不成立**：「权限模块 lazy」→ 只有 Clerk 壳 lazy；「协作更新批量合并」→ 只有 awareness 50 ms。
3. **一个不存在**：AI 流式增量渲染 = NOT IMPLEMENTED（`stream: false`）。
4. **不对称**：编辑器**保留**（保状态），预览**不保留**（保零成本）。
5. **三个数字的正确说法**：49 kB gzip 是 **chunk**、400 ms 是**配置值**、359/63 ms 是**一次观测**。
6. **一个 limitation**：100k 文档进预览 420 s 未 ready，node 719 ms 只是解析。
7. **安全一句话**：没有 HTML 可解析，所以没有 sanitizer 可配错；图片不产生 `src`，预览不发外部请求。
8. **可背的三连**：`lazy` 在 `MarkdownPreview.tsx:38`；400 ms 在 `previewFeed.ts:40`；
   `display:none` 在 `styles.css:742`。
