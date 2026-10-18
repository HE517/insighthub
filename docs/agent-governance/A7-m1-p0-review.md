# M1-P0 集成基线 · 独立终审报告（A7）

> 结论先行：**三处 P0 缺陷确已修复并被本轮独立重跑证实**；冻结契约未被改动，原始 Agent 分支与 `main` 未被触碰。
> 但存在 **1 项证据强度缺陷**（致命错误重连测试无法观测它声称要守护的回归）与 **1 项契约缺口**（本地 presence 写入不在冻结 seam 内）。
> 最终建议：**APPROVE WITH CONDITIONS**。合入 `main` 允许，但必须先满足 2 项前置条件。

---

## 1. 任务状态与审查 commit

| 项 | 值 |
| --- | --- |
| Status | `done`（审查完成；被审对象为他人交付物，本人未提交代码） |
| Branch / Worktree | `m1-stabilization` / `D:\前端\react\项目\面试项目\Insighthub` |
| HEAD | `9be0e1a`（`9be0e1a6ed776941f2adc3dca6abd76f7161c167`） |
| 工作区 | clean（`git status --porcelain` 为空；仅 `tests/browser/artifacts/` 为 gitignore 产物） |
| `main` | `47e96e3`（未被移动，未合入） |
| 远程 | 无 remote 配置（`git remote -v` 为空），未推送 GitHub |
| 是否修改业务代码 | 否（只读审查；未提交、未 amend、未改他人分支） |

**可访问性与拓扑核验（实测）**

```
9be0e1a : commit : 2026-10-18 16:07:08 +0800 test(collab): assert the fatal-error invariant with a monotonic counter
19587fc : commit : 2026-10-18 16:01:22 +0800 test(browser): drop the fixed P0 pins and repair two assertion defects
fc542f8 : commit : 2026-10-18 16:07:07 +0800 test(browser): stop claiming P0-2/P0-3 are still open
85a1b7c : commit : 2026-10-18 14:02:25 +0800 fix(collab): install the IndexedDB global without breaking a real browser (P0-1)
270cf5e : commit : 2026-10-18 14:11:42 +0800 fix(web): render the selection a peer publishes, not just its caret
a1 in m1: YES     a2 in m1: YES     main ancestor of m1: YES
caa5376 parents: eb9f4e9 85a1b7c      ← A1 真实 merge
0d04161 parents: caa5376 270cf5e      ← A2 真实 merge
agent/a1-p0-1 = 85a1b7c（未被重写）   agent/a2-p0-23 = 270cf5e（未被重写）
两个原始 worktree 均 clean
```

集成为**真实 merge commit**，非 cherry-pick / rebase：原始 Agent 分支历史完整保留，符合"不得重置、覆盖或清理原始分支"的约束。

**缺失的输入（必须记录）**：任务书提到的 **《M1-P0 集成报告》不是仓库中的产物**——`git grep "M1-P0"` 全仓为空，`docs/` 下无该文件，`docs/TASKS.md` 也**没有任何 M1-P0 条目**。因此本次审查只能以三类证据为准：①代码与提交信息中的断言；②`tests/browser/artifacts/`（gitignore，历史上一次全绿记录）；③**本轮本人重跑的真实结果**。历史 `results.md` 已被我的重跑覆盖（覆盖前读取：`Generated 2026-10-18T08:10:11Z`，27/27，Chrome 155）。

---

## 2. 审查范围与证据来源

**范围**：`47e96e3..9be0e1a` 全部 44 个文件、7896 行新增（`git diff --stat`）。逐模块聚焦：A1 持久化、A2 编辑器/光标、A1 测试支持（`9be0e1a`）、A6 浏览器测试（`19587fc`/`fc542f8`）、冻结契约与架构。

**证据来源**：

1. 逐行代码审查（`persistence.ts`、`collabTextBinding.ts`、`remoteCursorExtension.ts`、`remoteCursorPresence.ts`、`remoteCursors.ts`、`codeMirrorSurface.ts`、`CollaborativeMarkdownEditor.tsx`、`document-session.ts`、`awareness.ts`、`sync-provider.ts`、`sessionStore.ts`、`public.ts`）。
2. 提交级 diff（`git show`）：`85a1b7c`、`0b79a93`、`a679856`、`270cf5e`、`19587fc`、`fc542f8`、`9be0e1a`。
3. 契约原文：`docs/CONTRACTS.md` §8/§9/§9.1/§9.2/§10；`packages/shared/src/collab-session.ts`。
4. **本轮真实执行**（命令与退出码见 §6）。
5. 机制性独立验证（不依赖被审代码）：用 Node 复现 P0-1 的根因（见 §3.1）。

---

## 3. 逐模块审查结论

### 3.1 A1 — IndexedDB 持久化初始化（`85a1b7c`，合入 `caa5376`）

**结论：修复正确，生产路径与注入路径均成立；存在一处"全局工厂非引用计数"的残留生命周期风险（非阻塞）。**

| 审查点 | 判定 | 证据 |
| --- | --- | --- |
| 属性描述符处理 | PASS | [persistence.ts:127-161](apps/web/src/collab/internal/persistence.ts#L127-L161)：先取 `Object.getOwnPropertyDescriptor`，身份相同则**完全不动**，否则 `defineProperty`（`configurable: true`），失败转成可读错误 |
| `destroy()` 恢复原始描述符 | PASS | [persistence.ts:153-160](apps/web/src/collab/internal/persistence.ts#L153-L160) 恢复**描述符**而非值；`previous === undefined` 时 `delete`；[persistence.ts:214-220](apps/web/src/collab/internal/persistence.ts#L214-L220) 在 `finally` 中恢复，`destroyPromise ??=` 保证幂等 |
| 浏览器生产路径 | PASS | 身份分支证明：[persistence.test.ts:240-242](apps/web/src/collab/tests/persistence.test.ts#L240-L242) 断言会话存活期间 `window.indexedDB` 仍是 **getter-only accessor**（该用例本轮实测通过）；浏览器 27/27 全绿（真 Chrome 155，真实 IDB） |
| 注入 factory 路径 | PASS | [persistence.test.ts:249-299](apps/web/src/collab/tests/persistence.test.ts#L249-L299)：注入值确实到达 `lib0`（真实工厂 `createdNames` 为空），销毁后 accessor 复原 |
| 根因真实性 | PASS（独立复现） | 我用 Node 复现同一机制：`THREW: TypeError: Cannot set property indexedDB of #<Object> which has only a getter`；`descriptor after attempt: get=function, set=undefined`；`defineProperty worked, value identity=true`。即"strict 模式对 getter-only own accessor 赋值必抛"，与提交说明一致 |

**残留风险（L1）**：全局工厂**没有引用计数**。两个并发会话（都注入 factory 时）：

```
s1: install → previous=undefined, global=A, restore1=delete
s2: host.indexedDB === A → 返回 noop（restore2 空）
s1.destroy() → delete global      ← s2 仍存活，却失去全局 A
```

反面同样成立：`installGlobalIndexedDb` 在 `await createProviderConstructor()` **之前**执行（[persistence.ts:201-204](apps/web/src/collab/internal/persistence.ts#L201-L204)），并发创建时 s1 的 provider 可能读到 s2 装的 factory。

**影响面**：生产浏览器**不受影响**——`useCollaborativeDocument` / `DocumentWorkspace` 从不传 `indexedDB`，`factory === globalThis.indexedDB` 必然命中身份分支（noop）。风险只存在于注入环境（Node 测试、未来的嵌入方）。现有测试 [public-seam.test.ts:145-150](apps/web/src/collab/tests/public-seam.test.ts#L145-L150) 恰好是 LIFO 销毁，**未覆盖非 LIFO 顺序**。

### 3.2 A2 — 编辑器与实时协作（`0b79a93`、`a679856`、`270cf5e`，合入 `0d04161`）

**结论：P0-2 / P0-3 的修复在机制与证据上都成立；生命周期与解绑正确；存在一项契约缺口（presence 写路径）与一项热路径开销，均非阻塞。**

| 审查点 | 判定 | 证据 |
| --- | --- | --- |
| 本地编辑是否在 editor update 返回前进入 `Y.Text` | PASS | [collabTextBinding.ts:199-202](apps/web/src/features/editor/collabTextBinding.ts#L199-L202) → `writeLocalChanges` 同步 `transact`，无队列/无阈值；适配器在同一 `view.dispatch` 内回调 [codeMirrorSurface.ts:68-89](apps/web/src/features/editor/codeMirrorSurface.ts#L68-L89)。浏览器实测 `editorLength === yTextLength`（281753 = 281753，5000 行文档） |
| 远端编辑是否可能覆盖未同步本地输入 | PASS（结构性排除） | 不再存在"未同步的本地输入"：写入同步完成，远端事务无法在 `dispatch` 内插入。三重复环防护：origin 检查（[L157](apps/web/src/features/editor/collabTextBinding.ts#L157)）、重入计数（[L161](apps/web/src/features/editor/collabTextBinding.ts#L161)）、派生注解（[codeMirrorSurface.ts:77-88](apps/web/src/features/editor/codeMirrorSurface.ts#L77-L88)）。真实键击后远端单字符仍为 1 插 0 删（实测 `{"count":1,"inserted":1,"deleted":0}`） |
| UndoManager / 文档切换 / 编辑器销毁 | PASS | 无 CodeMirror `history()`，撤销走会话 `UndoManager`（[CollaborativeMarkdownEditor.tsx:136-139](apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L136-L139)）；binding 先建后建 view，销毁顺序 flush→unobserve→view.destroy（[L169-178](apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L169-L178)）；`UndoManager` 随会话销毁（[document-session.ts:235](apps/web/src/collab/internal/document-session.ts#L235)） |
| 远端光标/选区调度 | PASS | 构造函数**零 dispatch**（[remoteCursorExtension.ts:189-207](apps/web/src/features/editor/remoteCursorExtension.ts#L189-L207)），首帧改为 microtask + 合并（[remoteCursorPresence.ts:104-122](apps/web/src/features/editor/remoteCursorPresence.ts#L104-L122)），并带 `destroyed` 守卫 |
| 事件解绑 | PASS | [remoteCursors.ts:191-202](apps/web/src/features/editor/remoteCursors.ts#L191-L202) 同时 `off('change')`/`off('update')`；[remoteCursorPresence.ts:124-129](apps/web/src/features/editor/remoteCursorPresence.ts#L124-L129) 幂等销毁；`remoteCursorPresence.test.ts` 12 例覆盖"构造期不触达 view""销毁后不重绘""销毁丢弃已排程绘制" |
| 跨房间隔离 | PASS | 页面级重挂载（`DocumentWorkspace` 按 `documentId` key）+ 每会话独立 `Awareness` + `clearRemoteStates`。浏览器实测：切房后 `caretCount:1` 且 `labels:["Other Room Peer"]`、协作者行同为 `Other Room Peer`，旧房 `Ghost Peer` 无残留 |
| 选区渲染（`270cf5e`） | PASS | [remoteCursors.ts:139-177](apps/web/src/features/editor/remoteCursors.ts#L139-L177) 把 `cursor` 与 `selection` 当**两个独立字段**处理，`selection` 不因 `cursor` 折叠被丢弃；补了 25 行单测 |

**发现（M2，契约缺口）**：本地 presence **写**路径不在冻结 seam 内。A2 直接写裸实例：

```ts
// CollaborativeMarkdownEditor.tsx:200-202
session.awareness.setLocalStateField('cursor', ...)
session.awareness.setLocalStateField('selection', ...)
session.awareness.setLocalStateField('updatedAt', Date.now())   // A2 自己重实现 A1 的记账
```

A1 其实已实现 `setCursor`/`setSelection`（[document-session.ts:166-174](apps/web/src/collab/internal/document-session.ts#L166-L174)），但**它们不在 `CollaborativeSession` 接口里**（[collab-session.ts](packages/shared/src/collab-session.ts) §8 无这两个成员），A2 无法通过类型调用，只能走裸实例。`CONTRACTS.md` §9.2 的例外只覆盖"binding 输入"，未覆盖"写入"。后果：presence 写入出现两套实现，`updatedAt` 由 A2 私有维护；若 A1 日后在 `setLocalStateField` 里加入合并/校验，A2 会静默绕过。

**发现（L2，热路径开销，分析结论非实测）**：P0-2 修复使每次键击成为真实事务后，通知扇出**首次**落在打字热路径上：

```
1 次键击 → doc 'update' + doc 'afterTransaction' + 3× awareness 'change'
         = 5 次 notify → 4 个 sessionStore 各自重算快照 → 订阅组件重渲染
```
依据：[document-session.ts:253-255](apps/web/src/collab/internal/document-session.ts#L253-L255)（doc 双事件）、[awareness.ts:287-305](apps/web/src/collab/internal/awareness.ts#L287-L305)（change→onChange）、[sessionStore.ts](apps/web/src/features/editor/sessionStore.ts)（每次 notify 重算、快照引用必变）。**实测延迟仍可接受**（5000 行/281742 字符：本地输入 sync 中位 **1.7ms**、p95 **2ms**；toPaint 中位 28.6ms、p95 57.9ms），故不构成阻塞，但"每次按键 5 次通知"值得记录。

**性能风险（P0-2 的逐次事务）结论**：可接受。每次 editor update = 1 个 Yjs 事务 = 1 个 outbound frame + 1 条 IndexedDB 记录，代价实测 ~1.7ms@280KB；`Y.UndoManager` 自己的 capture timeout 负责撤销步聚合，不需要外层队列。

### 3.3 A6 — 浏览器测试与断言修改（`19587fc`、`fc542f8`）

**结论：pin 与 workaround 的移除合理；两处断言"修复"是真修复，而非放宽；未发现跳过、降级、伪造或不合理重试。本轮独立重跑 27/27。**

**pin / workaround 移除的合理性**

- `defect-pins.mjs`（108 行）与 `P0_1_WORKAROUND` shim 全部删除（`git grep` 确认无残留代码引用，文件不存在）。
- 移除后**所有**场景都走未修改的生产路径：一旦 P0-1 回归，`createCollaborativeSession` 再次 reject → 没有任何文档能打开 → 27 个场景集体失败。**覆盖由"1 个专门 pin"变为"全部场景"，不是减少。**

**两处断言修改的独立判定**

| 场景 | 改动前 | 改动后 | 我的判定 |
| --- | --- | --- | --- |
| `indexeddb/C` 重连挂载 | `assertEqual(mounts, 1)` | `viewId` 恒等 + 相对基线 delta | **增强**。我的实测证据：基线 `{"viewId":1,"mounts":2}` → 重连后 `{"viewId":1,"mounts":2}`。StrictMode 已核实存在（[main.tsx:17](apps/web/src/main.tsx#L17) `<StrictMode>`），双挂载是框架行为，`===1` 必然为红；新断言多了一条"同一个 EditorView 实例"的强约束 |
| `cursors/presence-lifecycle-clears` 跨房光标 | `caretCount === 0` | 无旧房标签 + 逐个标签归属本房协作者 + `caretCount >= 1` | **增强**。我的实测证据：切房后 `collaborators.count:1`、`rows:["O Other Room Peer @1"]`、`cursors:{caretCount:1,labels:["Other Room Peer"]}`。旧断言在"新房本来就有 peer"时必然为红；新断言同时给出**正反两半**（旧房不得残留 / 新房必须渲染），排除了"从不渲染"冒充"隔离正确" |

附带收益：`afterDisconnect.caretCount === 0` 原本因 P0-3 而**空转**（永远没有光标），现已是有意义的证据——实测 `caretCount:0, labelCount:0`。

**`fc542f8` 独立核对**：逐行读完，只有 9 处注释与 1 个字段名（`includesCrdtLeg:false` → `crdtLegSeparatelyTimed:false`）变化，**无任何断言被改动**。提交说明与 diff 一致。

**"没有靠跳过/降级/重试拿全绿"的核查（实测）**

- `git grep "skip|knownDefect|retry|todo|\.only"` → 仅剩 harness/README 里的机制说明，**0 个场景被 skip、0 个 `knownDefect` 标签**。
- harness 明确"失败不吞、退出码非 0、不重试"（[harness.mjs:1-17](tests/browser/lib/harness.mjs#L1-L17)）。
- 唯一一处 `.catch` 在 `05-performance`，但后续 `assertEqual(applied.inserted, 1)` / `assertEqual(applied.deleted, 0)` 立即裁决，无法静默通过（[05-performance.mjs:243-258](tests/browser/suite/05-performance.mjs#L243-L258)）。
- 当前套件 27 场景 / 136 处断言。

### 3.4 A1 测试支持（`9be0e1a`）

**结论：`totalConnectionsOpened` 的计数语义正确，修复了"比较两个 0"的真缺陷；但测试的观测窗口短于重连退避，仍无法观测它声称守护的回归（M1，需修）。**

**正确的部分**

- 计数器单调、只增不减，插入点正确（[test-server.ts:244](apps/web/src/collab/tests/support/test-server.ts#L244)，每个被接受的 socket 一次），不参与 `handleClose` 递减。
- 旧断言的缺陷是真实的：fatal 主动关 socket → `connectionCount` 从 1 掉到 0 → 旧断言变成"比较 0 与 0"，既会假红也会空转。换成单调计数器在**语义维度**上确属加强。

**M1 缺陷：窗口 120ms < 退避 1000ms**

```
sync-provider.ts:54   RECONNECT_BASE_DELAY_MS = 1_000
sync-provider.ts:497-507  delay = min(base * 2**attempt, max)；attempt 在 connected 时归零
sync.test.ts:204-207  waitFor(status==='error') → sleep(120) → 断言计数不变
scenarios.ts:20-21    TEST_RECONNECT_BASE_MS=20 / MAX=60  ← 定义了，但全仓从未使用
```

`createTestContext()` 只注入 `awarenessFlushDelayMs`，**没有注入缩短后的重连退避**（[scenarios.ts:47-93](apps/web/src/collab/tests/support/scenarios.ts#L47-L93)；`git grep TEST_RECONNECT` 仅命中定义处）。因此在测试上下文中，fatal 后若真有重连，首次尝试发生在 **≈1000ms**，而断言在 **120ms** 就已采样——即使把 `this.active = false` 整行删掉，该用例仍会绿。

**根因**：断言窗口与受测机制的时标不匹配；计数器本身没问题。
**影响**：`a fatal code stops the reconnect loop` 这条 P0 级不变量**目前没有有效测试**（产品实现另有 `active=false` + `detachHandlers` 双重保护，[sync-provider.ts:352-358](apps/web/src/collab/internal/sync-provider.ts#L352-L358)、[L529-540](apps/web/src/collab/internal/sync-provider.ts#L529-L540)，所以这是**证据缺陷而非产品缺陷**）。
**顺带**：`9be0e1a` 提交信息称"stronger: a reconnect loop that opens and immediately closes would keep the live count at zero while reconnecting forever"——计数语义上成立，但因为窗口太短，整体并不比原来更能证明"循环已停止"。这属于证据描述超出证据强度。
**修复建议（Owner: A1，1–5 行）**：给该用例注入 `reconnectBaseDelayMs: 20`（即启用已存在的 `TEST_RECONNECT_BASE_MS`），或把等待改到 >1000ms；改完再跑 10 次。

**稳定性复核（实测）**：`npx vitest run .../sync.test.ts` 连续 **5 次全绿（9/9，exit 0）**——历史上的 flaky 症状在本轮未复现。

---

## 4. 问题清单（按严重程度排序）

| # | 级别 | 问题 | 位置 | 根因 | 影响 | 验证/复现 | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1 | **中** | 致命错误重连不变量不可观测：120ms 窗口 vs 1000ms 退避 | [sync.test.ts:204-207](apps/web/src/collab/tests/sync.test.ts#L204-L207)、[sync-provider.ts:54](apps/web/src/collab/internal/sync-provider.ts#L54)、[scenarios.ts:20-21](apps/web/src/collab/tests/support/scenarios.ts#L20-L21) | 断言采样时标 ≪ 受测机制时标；压缩退避常量定义了却未接线 | P0 级不变量（fatal 后不得重连）无有效回归保护；提交说明高估了证据强度 | 常量与注入点已逐行核对；`git grep` 证明常量未被使用。**未做变异测试**（不得改他人产品代码） | A1 |
| M2 | **中** | 本地 presence 写路径不在冻结 seam 内，A2 直写裸 awareness 并自行维护 `updatedAt` | [CollaborativeMarkdownEditor.tsx:200-202](apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L200-L202)、[document-session.ts:166-174](apps/web/src/collab/internal/document-session.ts#L166-L174)、[collab-session.ts](packages/shared/src/collab-session.ts) | 冻结接口暴露 `awareness` 却没有 presence 写方法，§9.2 例外只覆盖"binding 输入" | 同一语义两套写入实现；A1 后续加合并/校验会被静默绕过（当前功能正确，浏览器已验证） | 接口成员与调用点比对；`CONTRACTS.md` §8/§9.2 原文 | A0（契约）+ A2 |
| L1 | 低-中 | 全局 IndexedDB 工厂非引用计数，重叠会话可互相删除/窃取全局 | [persistence.ts:127-161](apps/web/src/collab/internal/persistence.ts#L127-L161)、[persistence.ts:201-204](apps/web/src/collab/internal/persistence.ts#L201-L204) | 安装/恢复是"保存-还原"而非计数；install 在异步 import 之前 | **生产不受影响**（身份分支 noop）；注入环境非 LIFO 销毁或并发创建时串用工厂；无测试覆盖 | [public-seam.test.ts:145-150](apps/web/src/collab/tests/public-seam.test.ts#L145-L150) 仅覆盖 LIFO；调用图核对 | A1 |
| L2 | 低 | 每次键击 5 次 notify × 4 个 store 重算（P0-2 修复后首次进入热路径） | [document-session.ts:253-255](apps/web/src/collab/internal/document-session.ts#L253-L255)、[awareness.ts:287-305](apps/web/src/collab/internal/awareness.ts#L287-L305)、[sessionStore.ts](apps/web/src/features/editor/sessionStore.ts) | 通知粗粒度（doc 双事件 + 3 次 awareness 写入） | 未测；实测输入延迟中位 1.7ms/p95 2ms（5000 行），当前可接受 | 代码路径分析 + 浏览器性能证据 | A1 + A2 |
| L3 | 低 | 悬空文档引用：指向已删除的 `defect-pins.mjs` | [persistence.test.ts:207](apps/web/src/collab/tests/persistence.test.ts#L207) | pin 文件被 `19587fc` 删除，A1 注释未同步 | 读者按图索骥找不到对应证据文件 | `Test-Path tests/browser/suite/defect-pins.mjs` → `False` | A1 / A0 |
| L4 | 低（流程） | A0 代改 A6 所有权文件（`19587fc`/`fc542f8`）无所有权说明；`docs/TASKS.md` 状态板未更新，且全仓无 "M1-P0" 记录 | 提交 `19587fc`、`fc542f8`；[docs/TASKS.md](docs/TASKS.md) | 直接改而非先挂 `OWNERSHIP BLOCKER`；`TASKS.md` 本次范围内零改动 | 审计链断点；负责人从状态板读不到 P0 回合（仍显示 M1-A1/A6 `todo`、M1-A2/A3 `review`） | `git diff --name-status 47e96e3 9be0e1a -- docs/TASKS.md` 为空；`git grep "M1-P0"` 为空 | A0 |
| L5 | 低 | `void this.persistence.destroy()` 若 reject 会成为未处理拒绝（既有代码） | [document-session.ts:241](apps/web/src/collab/internal/document-session.ts#L241) | 异步销毁被 `void` 丢弃 | 极端路径下 Node 测试可能出现 unhandled rejection 噪声 | 代码阅读；本轮未触发 | A1 |

**"本轮没有发现问题"的部分**：A6 的两处断言修复与 pin 移除、`fc542f8` 的纯注释改动、`270cf5e` 的选区渲染逻辑、`remoteCursorPresence` 的调度与解绑、A2 的双向环防护——**均未发现可指摘缺陷**。

---

## 5. 冻结契约与架构兼容性

**文件层面（实测）**

```
git diff --name-only 47e96e3 9be0e1a -- packages/shared docs/CONTRACTS.md docs/ARCHITECTURE.md pnpm-workspace.yaml package.json */package.json
→ 空
```
`packages/shared/**`、`docs/CONTRACTS.md`、`docs/ARCHITECTURE.md`、所有 `package.json`、`pnpm-workspace.yaml` **全部未改**；**未新增任何生产依赖**。本次范围内变动的治理文件只有 `AGENTS.md` + `agent-prompts/**`（`3b62527`，A0 自己的所有权范围）。

**语义层面（不只凭"文件没改"）**——逐调用链核对：

| 契约 | 实现是否仍然符合 | 依据 |
| --- | --- | --- |
| §10.1 开序：本地持久化 → `active` → 才连网 | **符合** | [document-session.ts:371-389](apps/web/src/collab/internal/document-session.ts#L371-L389) 先 `attach`，[L436-448](apps/web/src/collab/internal/document-session.ts#L436-L448) `await whenSynced` → `markActive()` → `startNetwork()`；P0-1 修复正是在这条链的第一环上 |
| §9 / §9.2 presence 唯一通道 + 校验后读取 | **读路径符合** | UI 只走 `getCollaborators()`（[remoteCursors.ts:77-118](apps/web/src/features/editor/remoteCursors.ts#L77-L118)、[useCollaborativeSession.ts](apps/web/src/features/editor/useCollaborativeSession.ts)）；裸 awareness 仅作 binding 输入。**写路径有缺口，见 M2** |
| §9.1 离开即清、无幽灵光标 | **符合** | 浏览器实测 `after departure: caretCount 0 / labelCount 0` |
| §8 seam 封闭性（A2 不得 import internal） | **符合** | A2 只 import `@insighthub/shared` 类型 + `collab/public.js`；`session-options.ts` 的 `declare module` 是附加可选字段，未移除/改名任何冻结成员（属可接受 seam，A7 记录在案） |
| §6 二进制 framing / 错误码 | **未被触碰** | 范围内无 shared 改动；`test-server.ts` 仅加计数器 |
| §5.4 / R15 一 socket 一 room | **符合** | 切文档销毁旧会话（[public.ts:113-118](apps/web/src/collab/public.ts#L113-L118)），`DocumentWorkspace` 按 `documentId` 重挂载；浏览器 `chaos/document-switch-race` 通过 |
| R11 单一真相（正文只在 `Y.Text`） | **符合** | 编辑器无 `value`/`onChange(text)`/`useState(text)`；binding 不存正文；`reconcileFromText` 读权威 |
| R13 undo 只回退本地/AI | **符合** | `UNDO_TRACKED_ORIGINS`；浏览器 `after local undo: "REMOTE-BASE\|REMOTE-TAIL"`（远端不丢） |
| R10 离线一等公民 | **符合** | `indexeddb/B`、`chaos/offline-reconnect` 实测通过 |

**架构结论**：P0 修复全部落在既有权衡内（A1 只碰 `collab/internal/**`，A2 只碰 `features/editor/**`，未越界），没有引入第二真相、未自建 framing、未发明错误码。唯一架构性折痕是 M2 的 presence 写路径。

---

## 6. 测试证据与未验证内容

### 6.1 本轮真实执行（全部由我本人运行，含退出码）

| # | 命令 | 观察结果 | 退出码 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck` | shared / server / web 三包 `tsc --noEmit` 全 Done | **0** |
| 2 | `pnpm test`（第 1 次） | 服务端 `node:test`：58 pass / 0 fail / 0 skipped | **0** |
| 3 | `pnpm test`（第 2 次，干净重定向取 vi 汇总） | **Test Files 23 passed (23) / Tests 250 passed (250)**；服务端 **58 pass, fail 0, skipped 0, todo 0** | **0** |
| 4 | `pnpm build` | `tsc`（shared→server→web）+ `vite build` ✓ 1559 modules，`built in 16.01s`（警告：主 chunk 1403KB > 500KB 建议分块） | **0** |
| 5 | `npx vitest run .../sync.test.ts` ×5 | 每次 `Tests 9 passed (9)` | **0/0/0/0/0** |
| 6 | 端口独占核验 | `Get-NetTCPConnection` 对 5173 / 3101 均无监听 | — |
| 7 | `node tests/browser/run.mjs`（真 Chrome） | **scenarios: 27 · passed 27 · failed 0 · errored 0**；Chrome/155.0.8059.80；`appUrl http://127.0.0.1:5173/`、`backend http://127.0.0.1:3101` | **0** |
| 8 | P0-1 根因独立复现（Node，不依赖被审代码） | `THREW: TypeError: Cannot set property indexedDB of #<Object> which has only a getter` | 0 |

浏览器套件产物 `tests/browser/artifacts/results.md`（gitignore）已被本轮覆盖：`Generated 2026-10-18T08:40:48Z`，`## Scenarios — 27 total, 27 passed, 0 failed, 0 errored`。

**从本轮结果中抽取的关键实测数字**

- `indexeddb/C`：基线 `{"viewId":1,"mounts":2}` → 重连后 `{"viewId":1,"mounts":2}`（证明新断言形式正确、旧 `===1` 必然为红）。
- `cursors/presence-lifecycle-clears`：切房后 `caretCount:1`、`labels:["Other Room Peer"]`、`rows:["O Other Room Peer @1"]`（证明归属断言成立而"0 光标"断言错误）。
- `performance/5000-lines-invariants`：281742 字符 / 5000 行；本地输入 sync 中位 1.7ms、p95 2ms；`editorLength === yTextLength === 281753`、`diverged:false`（P0-2 在真浏览器的直接证据）。
- `editor/local-edit-reaches-ytext`、`editor/remote-edit-preserves-unsent-local-text`、`cursors/remote-caret-and-selection-render`、`chaos/offline-reconnect`、`lifecycle/repeated-open-switch-cycles`（20 轮无增长）全部 PASS。

### 6.2 尚未验证 / 无法验证

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 《M1-P0 集成报告》原文 | **BLOCKED** | 仓库不存在该产物（`git grep "M1-P0"` 为空）；我无法核对报告叙述与实现是否一致，只能核对提交信息 |
| M1 的"修复前必红"主张（P0-1/P0-2/P0-3 的 red-first） | **部分未验证** | 只做了机制层复现（P0-1 的 TypeError 已实测）。P0-2/P0-3 的"修复前红"依赖历史产物与提交说明，**未在旧代码上重跑**（不得回退他人分支/产品代码） |
| 变异测试（证明 M1 缺陷会被测试漏掉） | **未执行** | 需要改他人产品代码（删 `active=false`），超出只读审查授权；已用常量与注入点的静态证据替代 |
| 生产构建产物在浏览器中的运行 | **未验证** | 浏览器套件跑的是 Vite dev server（StrictMode 生效）；`dist/` 未被浏览器驱动 |
| 真实多用户/弱网/长时间浸泡 | **未验证** | 套件是单机双标签页 + CDP 网络模拟 |
| 服务端持久化 | **BLOCKED（M1 范围外）** | 见 §7 |
| 多会话重叠 + 注入 factory 的非 LIFO 场景 | **未验证（无测试）** | 见 L1 |
| 跨浏览器（Firefox/Safari） | **未验证** | 仅 Chromium 155 |

---

## 7. 已知风险（含服务端持久化缺失）

1. **服务端无持久化（最高业务风险，M1 范围内已声明）**：房间是纯内存的，最后一个成员离开即销毁（[registry.ts:380](apps/server/src/rooms/registry.ts#L380)、[room-lifecycle.test.ts:133](apps/server/src/rooms/room-lifecycle.test.ts#L133)）。**含义**：正文唯一持久副本是各客户端 IndexedDB；若某文档最后一个离线副本被清（清缓存、换设备、隐私模式），内容即不可恢复，且新用户打开只会看到空文档。`docs/DECISIONS.md` D-027 已把"持久化"记入 **M2 P0**——本报告确认该风险**仍然存在且未缓解**，M1 发布必须向使用者明示。
2. **presence 写路径双实现**（M2）：见上。
3. **全局工厂生命周期**（L1）：生产安全，注入环境有缝。
4. **键击通知扇出**（L2）：未测项；当前延迟可接受，但如果后续把 collaborator UI 扩大订阅面，会线性恶化。
5. **主 bundle 1403KB**（构建警告）：M0/M1 已知，非本次引入。
6. **审计链不完整**（L4）：无 M1-P0 状态记录、无集成报告，仅靠提交信息承载结论。
7. **单浏览器证据**：所有"浏览器已验证"仅指 Chromium 155 + dev server。

---

## 8. 对 A0 代执行其他 Agent 范围修改的独立审查结论

被代改的范围有三处：A1 的测试支持（`9be0e1a`）、A6 的浏览器套件（`19587fc`/`fc542f8`）、以及 A1/A2 测试文件在集成中的调整。

| 维度 | 判定 | 说明 |
| --- | --- | --- |
| 是否越界改产品代码 | **否** | `9be0e1a` 只改 `collab/tests/support/test-server.ts` + `sync.test.ts`；`19587fc`/`fc542f8` 只改 `tests/browser/**`。A1/A2 的产品文件由各自分支提交，A0 未在其中夹带 |
| 改动是否必要且正确 | **基本成立** | flaky 的 fatal 测试确实需要单调计数器（真缺陷）；pin/workaround 在被修后必须删除（否则 pin 长期为红会污染门禁）；两处断言确为"断言了产品从未承诺的行为" |
| 是否借代改削弱验收 | **未发现** | 逐 hunk 核对：无 skip、无阈值放宽、无重试；被改的两处断言均**增强**（相对基线 + 实例恒等 / 正反 + 归属） |
| 是否留痕 | **部分不合格** | `9be0e1a` 有明确 ownership note（"A0 edited this test support during M1-P0 integration…"）——**合格**；`19587fc`/`fc542f8` **没有任何所有权/授权说明**，也无 `docs/DECISIONS.md` 条目——**不合格**（AGENTS.md R2 + COMMON §1 要求先挂 `OWNERSHIP BLOCKER` 再改） |
| 是否存在"自审放行"风险 | **存在结构性风险，本次结论仍独立** | A0 既改测试又是门禁判定者。我的独立性正体现在：我没有采信任何"27/27"陈述，而是自己起栈跑到 27/27；并通过实测数字反证了 A6 的断言修复是必要的（mounts=2、新房 caret=1），也反证了 A1 提交里"stronger"的说法过头（M1） |

**结论**：代改的**内容**可接受，**流程留痕**不完整。建议 A0 补一条决策记录（例如 D-039）说明：为何在 M1-P0 集成期直接修改 A1/A6 测试支持、批准人是谁、删除 pin 的依据是什么。

---

## 9. 验收标准逐条判定

| # | 验收标准 | 判定 | 证据 |
| --- | --- | --- | --- |
| AC-1 | P0-1：真实浏览器能打开文档（生产路径，无 shim） | **PASS** | 我的 27/27（无 workaround 代码）；`indexeddb/A\|B\|C\|D`、`smoke/harness` 全 PASS |
| AC-2 | P0-1：`destroy()` 后恢复**原始描述符** | **PASS** | [persistence.test.ts:249-299](apps/web/src/collab/tests/persistence.test.ts#L249-L299) 通过（`pnpm test` 绿） |
| AC-3 | P0-1：注入 factory 仍被真正使用，且不污染宿主页 | **PASS** | 同用例断言真实工厂 `createdNames === []`；生产路径断言 accessor 存活 |
| AC-4 | P0-0：多会话重叠时全局 factory 生命周期正确 | **FAIL（未覆盖）** | 非引用计数；仅 LIFO 场景有测试（L1） |
| AC-5 | P0-2：本地编辑在 update 返回前进入 `Y.Text` | **PASS** | 代码同步写入；单测"逐字符断言 `Y.Text` 不落后"；浏览器 `editorLength===yTextLength` |
| AC-6 | P0-2：远端编辑不得吞掉尚未同步的本地输入 | **PASS** | `editor/remote-edit-preserves-unsent-local-text` PASS；单测"远端紧随本地不位移" |
| AC-7 | P0-2：逐次事务的性能可接受 | **PASS（有边界）** | 实测 sync 中位 1.7ms/p95 2ms @280KB；未覆盖超长文档/低端设备 |
| AC-8 | P0-3：`ViewPlugin` 构造函数不得 dispatch | **PASS** | 构造函数零 dispatch；`remoteCursorPresence.test.ts` 12 例；浏览器光标真实渲染 |
| AC-9 | P0-3 延伸：远端**选区**必须渲染 | **PASS** | `cursors/remote-caret-and-selection-render` PASS；`selection` 独立字段处理 |
| AC-10 | 远端光标/选区调度合并、销毁后不重绘 | **PASS** | microtask 合并 + `destroyed` 守卫；销毁相关 3 个单测通过 |
| AC-11 | 事件解绑（change/update 双解绑） | **PASS** | `off` 成对；`unsubscribes from both events on destroy` 通过 |
| AC-12 | 跨房间隔离（旧房光标不得进入新房，新房须渲染自己的） | **PASS** | 我的实测 `caretCount:1 / labels:["Other Room Peer"]`；`chaos/document-switch-race` PASS |
| AC-13 | UndoManager 生命周期、无第二套历史 | **PASS** | 无 `history()`；会话销毁销毁 `UndoManager`；`realtime/local-undo-does-not-revert-remote-text` PASS |
| AC-14 | A6：P0 pin 与 workaround 移除合理、无覆盖损失 | **PASS** | 无 shim 时全场景跑真实路径；`defect-pins.mjs` 已删且无残留引用 |
| AC-15 | A6：重连挂载计数保持/增强 | **PASS** | 相对基线 delta + `viewId` 恒等；实测 `2→2`、`viewId 1→1` |
| AC-16 | A6：跨房光标归属断言保持/增强 | **PASS** | 正反 + 归属三重断言；实测数据支持 |
| AC-17 | A6：未通过跳过/降级/伪造/重试取全绿 | **PASS** | 0 skip、0 `knownDefect`、harness 不重试、失败非 0 退出 |
| AC-18 | A1：`totalConnectionsOpened` 能检出 fatal 后的意外重连 | **FAIL** | 计数语义正确，但 120ms 窗口 < 1000ms 退避 → 检不出（M1） |
| AC-19 | A1：无新的计数语义错误或测试竞态 | **PASS** | 单调、不递减、每 socket 一次；`sync.test.ts` 连续 5 次绿 |
| AC-20 | 冻结契约未被改，且语义兼容 | **PASS** | 文件零改动 + 逐调用链核对（§5） |
| AC-21 | 无未批准生产依赖 | **PASS** | 范围内 `package.json` 零改动 |
| AC-22 | 门禁 `typecheck`/`test`/`build` 全绿 | **PASS** | 三次真实执行 exit 0（250+58 用例，0 skip） |
| AC-23 | 真实浏览器回归全绿 | **PASS（限 Chromium dev server）** | 我本人跑出 27/27 exit 0 |
| AC-24 | 集成报告可供核对 | **BLOCKED** | 仓库无该产物；无 M1-P0 状态记录 |

---

## 10. 最终 Release Recommendation

### 结论：**APPROVE WITH CONDITIONS（有条件放行）**

- **不是 REJECT**：三处 P0 缺陷的修复在机制、单测与真浏览器三层都成立，冻结契约完好，无数据丢失回归，无断言造假。
- **不是无条件 APPROVE**：M1（测试无法观测其守护的不变量）使一条 P0 级不变量失去回归保护；M2（presence 写路径契约缺口）是需要在架构层留痕的折痕；而支撑"全绿"叙述的集成报告与状态记录**不存在**。

### 阻塞项（合入 `main` 前必须完成）

| ID | 严重级别 | 内容 | Owner | 修复后如何验证 |
| --- | --- | --- | --- | --- |
| C1 | 中（阻塞） | 让 fatal 重连不变量**可被观测**：为该用例注入压缩退避（用已存在的 `TEST_RECONNECT_BASE_MS=20`）或把等待放到 >1000ms | A1 | `npx vitest run .../sync.test.ts` 连跑 10 次全绿；临时删 `active=false` 时该用例应转红（变异验证，由 owner 执行） |
| C2 | 中（阻塞，留痕即可） | 为 presence 写路径缺口 + 非引用计数全局工厂补一条 A0 决策记录，并把 A2 直写裸 awareness 标注为"M1 已知折痕 / M2 收口"；同时修掉 [persistence.test.ts:207](apps/web/src/collab/tests/persistence.test.ts#L207) 的悬空引用 | A0 (+A1 一行注释) | `docs/DECISIONS.md` 新增条目；`git grep defect-pins` 无命中 |

### 非阻塞观察（可随基线进入下一阶段，但必须记录在案）

- L1 多会话重叠的全局工厂生命周期（生产安全，注入路径有缝；建议补一个非 LIFO 的重叠用例）。
- L2 每次键击 5 次通知 × 4 个 store 重算（实测延迟可接受，但未纳入性能断言）。
- L5 `void persistence.destroy()` 的潜在未处理拒绝。
- `docs/TASKS.md` 状态板落后于现实（仍写 M1-A1/A6 `todo`），需 A0 更新。
- 主 bundle 1403KB 的分块建议（M0 遗留）。

### 审查覆盖面（诚实边界）

- **看了**：范围内全部 44 个文件/7896 行的新增内容；6 个提交的完整 diff；契约 §5/§6/§8/§9/§10 原文；调用链（会话创建→持久化→网络→编辑器→presence→通知→React 订阅）。
- **跑了**：`typecheck`、`test`×2、`build`、`sync.test.ts`×5、真 Chrome 浏览器套件 27 场景、P0-1 根因独立复现、端口与提交拓扑核验。
- **没看/没跑**：集成报告（不存在）；旧代码上的 red-first 重跑（禁止回退他人分支）；变异测试（禁止改产品代码，转由 C1 要求 owner 执行）；生产 `dist/` 的浏览器验证；Firefox/Safari；真实多机弱网；M2 的持久化方案。

---

## 11. 是否允许将 `m1-stabilization` 合入 `main`

**允许，但有前置条件（先满足 C1 + C2，再合）。**

- **C1（必须）**：修好 fatal 重连测试的可观测性并复跑通过——理由是这条不变量属于 P0 门禁本身，若以现有形态合入，`main` 会长期携带一个"看起来在守、实际守不住"的测试，未来的重连回归将无人拦截。
- **C2（必须，代价很低）**：补齐决策留痕 + 修掉悬空引用——理由是本次集成本身就是 A0 代改他人范围的产物，缺少留痕会让下一次同样操作失去约束。
- **合入方式**：现有拓扑已经正确（`main` = `47e96e3` 是其祖先，`caa5376`/`0d04161` 是真实 merge，原始分支历史完整）。满足条件后**继续用 merge**（不要再 rebase/压缩），以保留 A1/A2 的提交级证据。
- **合入后必须同步**：`docs/TASKS.md` 增加 M1-P0 回合状态；`docs/DECISIONS.md` 记录 D-039；README/发布说明向使用者明示"服务端无持久化，正文仅存于客户端 IndexedDB"。
- **不建议**：把 `main` 合入后再补 C1——那会把证据缺陷带进主线，且修复时无法再用"修复前红"自证。

---

## 12. 最终 Git 状态

```
$ git status --porcelain=v1
（空 — 工作区 clean）

$ git status -sb
## m1-stabilization

$ git rev-parse HEAD
9be0e1a6ed776941f2adc3dca6abd76f7161c167

$ git rev-parse main
47e96e39e3618581782b66c84292a117acfaeec2          （未被移动）

$ git branch -vv
  agent/a1-p0-1     85a1b7c [worktree: .../Insighthub-wt-a1-p0-1]   （原始分支，未动）
  agent/a2-p0-23    270cf5e [worktree: .../Insighthub-wt-a2-p0-23]  （原始分支，未动）
  agent/a6-chaos    f031063
* m1-stabilization  9be0e1a
  main              47e96e3

$ git status --ignored --porcelain=v1
!! tests/browser/artifacts/      （本轮重跑覆盖的产物，gitignore，不计入工作树）
```

- 我对仓库的写入**仅有** `tests/browser/artifacts/`（套件自身的输出目录，gitignore），**未修改任何被跟踪文件**，未提交、未创建分支、未改动任何 worktree。
- 未合入 `main`，未推送 GitHub（无 remote）。
- 临时日志在仓库外：`D:\dev-temp\a7-typecheck/test/test2/build/browser/sync-1..5.log`；ACL 诊断报告 `D:\dev-temp\dsh-acl-recovery-insighthub\acl-report-*.jsonl`（该诊断判定 `NOT_THIS_CLASS`，**未做任何权限改动**）。

---

**一句话给项目负责人**：这份基线值得进入下一阶段——三个 P0 都是真的修好了，我是自己起服务、起真 Chrome 跑出 27/27 才这么说的；但它现在还不能算"可无条件相信的全绿"：一条 P0 级不变量背后的测试在时间尺度上根本看不见自己要抓的 bug，而解释这一切的集成报告在仓库里不存在。把这两件事补上（分别约 1 行测试改动和 1 条决策记录），`m1-stabilization` 就可以合入 `main`。
