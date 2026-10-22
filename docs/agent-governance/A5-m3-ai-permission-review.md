# A5 · M3 第四棒：AI 接受路径的权限一致性复核

**范围：** review + 定向验证（不改版）。
**Base：** `main @ 20c3470`（含 A4 编排层与 A2 Diff Preview UI）→ `agent/a5-m3-ai-permission @ 20c3470`
**日期：** 2026-10-22
**结论先说：** **没有发现任何真实的权限绕过（P1/P2 = 0）**。UI（已知非编辑角色）与服务端（WS 数据面 frame gate）两层是闭合的，AI 接受写入**不是**一条新通道，它和打字/撤销走同一条 `Y.Doc → Yjs transaction → WS SYNC Update → registry frame gate` 路径。唯一需要纠正的是任务前提本身：**离线时 `getRole()` 恒为 `null`，不存在"已知角色是 viewer 但离线"这个状态**；离线 viewer 能点 Accept，是因为"未知角色按可编辑处理"（R10 / CONTRACTS §17.9），与"离线 viewer 能打字"完全同类，属 D-064 §2 第 3 项已裁定的"已知缺陷、非安全缺陷"。本报告用真实浏览器实测了这条链（本地文本、IndexedDB、重连、重载、以及角色被提升后的滞后提交），并给出是否加 `reason:'forbidden'` 预检的赞成/反对与影响面。**建议：现在不加**（理由见 §11）。

---

## 0. 任务点对点回答（四问）

| # | 问题 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | viewer/commenter 能否通过 UI 触发 AI 写入？ | **不能**（在线、已知角色时）。Accept 在 `!canEdit` 时 `disabled`，且 `accept()` 内还有一道 `if (!canEdit) return`；对 disabled 按钮做程序化 `.click()` 不产生 DOM 事件，实测文本与帧都没变。viewer 为浏览器实测；commenter 走同一条 `canEdit === false` 的 gate（代码级 + `editorRoleGate.test.ts` / `documentCapabilities`），未单独做浏览器实测。 | `AiSuggestPanel.tsx:200`、`:248`；探针步骤 3/4（Accept `disabled: true`，`.click()` 后文本仍 `alpha beta`，出站 SYNC 帧不变） |
| 2 | AI 写入是否与其他写走同一条受控路径？有没有旁路？ | **是同一条**：`applySuggestion` → `session.transact(fn, ai)` → `doc.transact` → sync-provider 的 `doc.on('update')` → `encodeSyncUpdate` → 服务端 `#authorizeFrame`（`SyncStep2`/`Update` 需 `canEdit`）→ `#submitMutation`（apply → persist → broadcast）。**没有旁路**：HTTP 无任何写端点；服务端 `store.append` 只有 registry 一处；awareness 不承载文档内容。 | `apply.ts:114-123`；`sync-provider.ts:174`、`:446-452`；`registry.ts:716-760`、`:814-860`；`app.ts:110-217`；`registry.ts:847`（唯一 `store.append`） |
| 3 | 离线（角色未知）点 Accept 会发生什么？ | 本地 `Y.Text` 立即改、IndexedDB 持久化、**服务器从未收到**；重连后本地文本**原样保留**（不被纠正），服务器仍是旧文本；再重载页面，本地分叉仍在（客户端持久分叉）。若之后被提升为 `editor` 并发生一次新 join，这段分叉会作为普通 CRDT 更新被上传并落库。 | 探针步骤 5–9（见 §7 的实测输出）；机制见 §4.3 |
| 4 | 是否该在 `applySuggestion` 上加咨询性预检？ | **现在不建议加**（反对）。它对被质疑的离线窗口**完全无效**（离线 `getRole()` 是 `null`，预检不会触发），在线窗口本来就有 UI + `accept()` 双守卫；而它要动 A4 的 `apply.ts`、A2 的面板与文案、并给 `ApplyResult` 增加第五种 reason。若 A0 要"纵深防御"，可做，但必须写成"冗余护栏，不是安全修复"，且不得声称它解决本地分叉。 | §11 |

---

## 1. 任务状态（Status）

- `Status`: **done**
- `Branch`: `agent/a5-m3-ai-permission`
- `Worktree`: `D:\前端\react\项目\面试项目\Insighthub-wt-a5-m3-ai-permission`
- `Commit`: **未提交**（本轮只新增本报告；一次性探针已删除，工作树其余干净）

## 2. 本轮目标

在不改版的前提下，独立复核 M3 "AI 接受"这条写入路径的权限一致性：确认 UI、客户端写入、服务端三层各自的判定点与它们是否闭合；确认 AI 路径没有引入新的写入/持久化通道；用真实浏览器实测"离线且角色未知时 Accept"的实际行为（本地文本、durable、重连、重载、后续角色变化）；并就是否在 `applySuggestion` 上加咨询性预检给出赞成/反对与影响面，交 A0 裁定。

## 3. 完成了什么

- **三层判定点逐条复核并闭合**：UI（`capabilityGate` + Accept 双守卫）、客户端写入（`applySuggestion` 只经由 `session.transact(ai)`）、服务端（`SyncStep2`/`Update` 需 `canEdit`；拒绝发生在 apply/persist/broadcast 之前）。
- **前提纠正（实测）**：连接断开后 `getRole()` 返回 `null`（不是"记住的 viewer"），因此离线时 `capabilityGate(null)` 给出 `canEdit: true`，Accept **是可点的**——这不是"A2 的 disabled 失效"，而是"未知角色不锁编辑"这一冻结规则的直接后果。
- **真实浏览器实测了完整链路**：viewer 在线 → Accept disabled 且程序化点击无效 → 断网 → 角色变 `null`、编辑器变可编辑、Accept 变可用 → 真实点击 Accept → 本地 `ALPHA BETA`、durable 仍 `alpha beta`、IndexedDB 落 4 条 update → 重连后本地仍是 `ALPHA BETA`、durable 仍 `alpha beta`、0 个 `FORBIDDEN` → 重载并用同一 profile 重开文档后本地分叉仍在（update 记录 6 条）→ 把该用户提升为 `editor` 再重连后 **durable 变成 `ALPHA BETA`**（滞后提交）。
- **确认无权限绕过**：HTTP 无写端点；服务端唯一的 `store.append` 在 registry 的受控 pipeline 里；awareness 与持久化都不构成文档写入通道；AI 在服务端**零代码**（D-075 §4）。
- **给出预检方案的赞成/反对与影响面**，并明确"它不是解决离线分叉的手段"。

## 4. 技术实现（三层判定与离线分叉机制）

### 4.1 三层判定点

```text
[UI]        session.getRole() ──▶ capabilityGate(role) ──▶ gate.capabilities.canEdit
                                     │
                                     ├─ DocumentWorkspace 把 gate 传给 AiSuggestPanel
                                     ├─ Accept: disabled = !canEdit || phase !== 'proposal'
                                     └─ accept(): if (!canEdit) return          ← 第二道（程序化点击）

[客户端写]   applySuggestion(port, suggestion, currentRevision)
              ├─ validateSuggestionAgainstDocument（revision → anchor → expectedText）
              └─ port.transact(fn, TRANSACTION_ORIGINS.ai) ─▶ session.transact ─▶ doc.transact
                                                              └─ doc.on('update') ─▶ encodeSyncUpdate （joined 时）

[服务端]     handleBinaryFrame
              ├─ #authorizeFrame: SYNC SyncStep1 / AWARENESS → canRead
              │                   SYNC SyncStep2 / Update   → canEdit，否则 FORBIDDEN（非致命）
              │                   （决策在 await 之前，per-frame 不缓存）
              └─ #submitMutation: apply（room.applySyncPayload）→ persist（store.append）→ broadcast
```

| 层 | 判定点 | 回答的问题 | 是否闭合 | 证据 |
| --- | --- | --- | --- | --- |
| UI | `capabilityGate(role).capabilities.canEdit`（`DocumentWorkspace.tsx:151`） | 是否显示/启用 Accept | **闭合（已知角色）** | `AiSuggestPanel.tsx:200`、`:248`；探针步骤 3/4 |
| 客户端写 | `applySuggestion` → `session.transact(..., 'ai')` | 写入是否走唯一 Yjs 通道 | **闭合（与打字同一条）** | `apply.ts:114-123`；`sync-provider.ts:174`、`:446-452`；探针「离线 accept 期间出站 SYNC 帧 1→1」 |
| 服务端 | `#authorizeFrame` 的 `canEdit` | 是否允许这次 mutation 落库/广播 | **闭合** | `registry.ts:716-760`、`:814-860`；既有 P2-1 测试 `apps/server/src/rooms/authz-enforcement.test.ts:272-318` |

> 注意：`applySuggestion` **本身没有、也不应该有**权限检查（它拿的是 `Pick<CollaborativeSession,'doc'|'transact'>` 这个窄端口）；`features/ai/**` 里没有任何 `role`/`canEdit` 引用。权限判定只发生在 UI（决定是否调用）与服务端（决定是否接受），这符合 `ARCHITECTURE §8.2`：UI 不是安全边界，服务端是。

### 4.2 关键代码事实

- `accept()` 里守卫与调用相邻：
  ```ts
  if (proposal === null || tracker === null) return;
  if (!canEdit) return;                        // ← 程序化点击也写不进去
  const result = applySuggestion({ doc: session.doc, transact: … }, proposal, tracker.get());
  ```
- `acceptDisabled = !canEdit || phase.kind !== 'proposal'`；title 为 `Read-only for your role`。
- `gate` 的唯一来源是 `useSessionRole(session)` → `session.getRole()`（没有 Redux 镜像、没有第二份角色状态）。
- AI 写入的 origin 是 `ai`；服务端 wire 上**没有 origin 字段**，所以对服务器而言它就是一个普通 `SyncUpdate`，与按键产生的 update 在授权上不可区分——这正是我们想要的"同一条受控路径"。

### 4.3 离线分叉的机制（为什么"永久保留"）

```text
断网 → networkStatus !== 'connected' → getRole() 返回 null（不是缓存的 viewer）
     → capabilityGate(null): canEdit = true（R10 / §17.9：未知角色不得锁死编辑）
     → Accept 可点 → applySuggestion 写本地 Y.Text（origin ai）
     → y-indexeddb 立即持久化（不 debounce）
     → 因为 joined=false，update 不发；重连后也只有 SyncStep1 出站

重连（角色仍是 viewer）：
  客户端发 SyncStep1（读请求）
  服务端回 SyncStep2（客户端缺的内容）+ 自己的 SyncStep1 —— 仅当 canEdit
  viewer 没有 canEdit ⇒ 服务端**不发** SyncStep1 ⇒ 客户端**永远不会**被要求发 SyncStep2
  ⇒ 分叉不上传、不被拒绝（0 个 FORBIDDEN）、也不被删除（Yjs 收到 update 只合并，不删除本地结构）
  ⇒ 本地副本（含 IndexedDB）永久保留分叉；服务器/其他客户端永远看不到

若之后被提升为 editor 并发生一次新 join：
  服务端发 SyncStep1 ⇒ 客户端回 SyncStep2（携带完整本地状态）⇒ 分叉作为普通 CRDT 更新上传并落库
```

这解释了为什么探针里"重连后 0 个 FORBIDDEN"：**服务器从来没收到这段分叉**，所以谈不上"拒绝"；它不是"被拒绝后仍保留"，而是"从未提交"。同时这也是它无法自愈的原因：没有任何一方向另一方声明"你的副本多了一段"。

## 5. 发现并修复的问题

**本轮没有修改任何生产代码，也没有发现需要修复的真实缺陷（P1/P2 = 0）。** 以下是 4 个 P3 观察 + 1 个前提纠正，均未修，交 A0 决定是否立项。

| # | Problem（可观测） | Root Cause（机制） | Impact | Fix（本轮未做） | Regression Test |
| --- | --- | --- | --- | --- | --- |
| P3-a | 离线 viewer 点 Accept 后：本地文本变了、IndexedDB 有分叉、durable 没变；重连不纠正；重载后仍在；提升为 editor 再重连后被上传 | `getRole()` 离线返回 `null`（§17.9 rule 2）→ `capabilityGate(null).canEdit = true`（R10）→ `applySuggestion` 无权限检查地写本地；服务端从不向非 editor 发 SyncStep1，分叉永不出站 | 用户本地看到"我改了"，其他人看不到；该用户升权后这段编辑会被网络补交。**不构成越权写**（服务器在副作用前拒绝一切非 editor 的 mutation），且与"离线 viewer 打字"同类；D-064 §2 #3 已裁定为"已知缺陷、非安全缺陷" | 不建议本轮修。若要收紧，属 permission semantics 变化（D-073 §2），需 A0/owner 决定：见 §11 的 A/B/C/D | 建议 A6 落一个永久场景（AI 版 offline unknown-role Accept），断言与探针相同 |
| P3-b | `aiAcceptRequiredRole`（shared 冻结的 "accept 需 ≥ editor"）**零消费者** | UI 用的是 `gate.capabilities.canEdit`（= `hasAtLeastRole(role,'editor')`），语义当前等价；两处都能表达"accept 需要 editor" | 今天无行为差异；将来若能力阶梯或 required role 改动，两份表达可能漂移，且测试不会发现（没有地方读它） | 建议不改：`documentCapabilities.canEdit` 是唯一规则表，UI 不应再引入第二份判定。若一定要接线，让 shared 内部把 `aiAcceptRequiredRole` 作为 `canEdit` 的定义（或反之），而不是在面板里再判一次；改 shared 需 A0 批准 | 单测：对 4 个角色断言 `documentCapabilities.canEdit(role) === aiAcceptRequiredRole.safeParse(role).success`（今天为真，用于钉住"语义等价"） |
| P3-c | `generate()` 的程序化守卫只查 `tracker === null`，不查 `canRead`；按钮 `disabled={!canRead || tracker===null}` | 生成是只读操作（只读本地 `Y.Text`），按钮 disabled 已挡住真实点击；`canRead` 对四种已知角色恒真、`null` 也视为可读，因此当前**不可达** | 仅在未来出现"无 canRead 的角色"或绕过 disabled 的调用方时才会"从本地副本生成提案"；不写文档、不跨网络，影响低 | 可加一行 `if (!canRead) return;`（A2 文件，属 A2 范围），或不做 | 目前无测试能覆盖（jsdom 不可用），需浏览器场景 |
| P3-d | A2 声称的"Accept 在 `!canEdit` 时 disabled，程序化 `.click()` 无效"在本轮之前**没有已提交的测试**覆盖 AI 面板 | 面板依赖 DOM，Node 测试环境无 jsdom；A6 的 browser suite 里也没有 `ai-accept`/`ai-panel` 选择器 | 该断言此前只有代码阅读，没有可证伪证据；一旦 UI 改动（例如把 Accept 换成 `<div onClick>` 或去掉 `disabled`）不会被门禁抓到 | 建议 A6 在 `tests/browser/suite/**` 增加永久场景（A6 正在并行写永久场景，本轮未触碰） | 探针已一次性验证（见 §7），需固化为永久场景 |
| 前提纠正 | 任务原文："已知角色是 viewer 但离线时点 Accept" | 离线时 `getRole()` 返回 `null`（`document-session.ts:259-266`；`session-role.test.ts:145-147` 钉住 `role === null && status === 'offline'`） | 讨论对象应从"已知 viewer 的 Accept"改为"未知角色的 Accept"；这也意味着任何"在 applySuggestion 里查 role"的预检在离线窗口**不会触发** | 无需修代码；报告与后续交接按此表述 | 已有测试 `session-role.test.ts` |

## 6. Files Changed

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `docs/agent-governance/A5-m3-ai-permission-review.md` | **新增（未提交）** | 本报告；唯一交付物 |
| `tests/browser/lib/a5-probe-offline-viewer-accept.mjs` | 新增后又删除（未提交） | 一次性探针：真实浏览器实测离线 viewer Accept。已删除，避免与 A6 的 `suite/**` 并行工作冲突，也避免把未评审的探针留在树里 |

生产代码、`packages/shared/**`、`apps/server/**`、`apps/web/src/features/**`、`tests/browser/suite/**`、`package.json`：**零改动**（`git status` 只出现本报告）。

## 7. Tests / Validation

### 7.1 项目门禁（本轮真实输出，摘录关键行）

```text
$ pnpm install
Progress: resolved 288, reused 288, downloaded 0, added 288
Done in 15.6s using pnpm v10.34.7

$ pnpm typecheck
Scope: 3 of 4 workspace projects
packages/shared typecheck: Done
apps/server typecheck: Done
apps/web typecheck: Done
exit code: 0

$ pnpm test
 Test Files  41 passed (41)
      Tests  465 passed (465)
# tests 181        ← server (node:test)
# pass  181
# fail  0
exit code: 0

$ pnpm build
✓ built in 4.07s
exit code: 0
```

说明：`pnpm test` 的 vitest 部分与 server 部分都吃到同一轮输出（`vitest 465` + `server 181`）。**没有新增/修改任何被门禁覆盖的测试文件**，所以本轮不存在"用新增测试改门禁结果"的情况。报告定稿前在最终工作树上又跑了一次 `pnpm test`：`exit 0`，仍是 `Test Files 41 passed` / `Tests 465 passed` / `server # pass 181`。

### 7.2 一次性探针（真实 Chrome + 真实 Vite + 真实后端 + 真实 SQLite + 真实 IndexedDB）

环境：`DevStack`（后端 `127.0.0.1:3101`、Vite `127.0.0.1:5173`）、真实 Chromium（CDP）、每轮独立临时 data 目录、真实 `authz.db` 与 `insighthub.db`。文档 `a5-m3-ai-probe`：`demo-ada` = owner（用 `WireOracle` 通过真实 wire 播种 `alpha beta`），`demo-linus` = viewer（fixture 写真实 membership 行）。页面的 session 与角色都来自真实 `POST /api/session/bootstrap` 与真实 `room-joined.role`。

实测输出（原样摘录）：

```text
### 2. connected viewer
  roleChip: role: viewer
  contentEditable: false
  viewReadOnly: true
  text: alpha beta

### 3. proposal while connected
  present: true
  disabled: true
  title: Read-only for your role

### 4. programmatic Accept while connected viewer
  before: alpha beta
  after: alpha beta
  outboundSyncFrames: 1                       ← 程序化点击没有产生任何写帧

### 5. offline (role is null, not "known viewer")
  roleChip: null
  contentEditable: true
  viewReadOnly: false
  acceptPresent: true
  acceptDisabled: false
  acceptTitle: Apply this suggestion to the document
  status: reconnecting

### 6. offline viewer Accept (measured)
  editorText: ALPHA BETA
  durableBefore: alpha beta
  durableAfter: alpha beta
  localReplicaRecords: 4
  localReplica: {"present":true,"stores":[{"name":"custom","count":0},{"name":"updates","count":4}]}
  outboundSyncFramesBefore: 1
  outboundSyncFramesAfter: 1                  ← 离线写入没有出站

### 7. after reconnect
  roleChip: role: viewer
  viewReadOnly: true
  editorText: ALPHA BETA
  durable: alpha beta
  forbiddenErrorFrames: 0                     ← 服务器从未收到分叉，因此没有 FORBIDDEN
  outboundSyncFrames: 2                       ← 只有重连那一次 SyncStep1
  inboundControl: ["connected","room-joined","connected","room-joined"]

### 8. after reload (same profile, document re-opened)
  documentBeforeReopen: demo-document         ← 重载后 Redux 文档选择回默认，需重开文档
  editorText: ALPHA BETA
  roleChip: role: viewer
  viewReadOnly: true
  durable: alpha beta
  localReplica: {"present":true,"stores":[{"name":"updates","count":6}]}   ← 分叉被持久重放

### 9. after promotion to editor + rejoin
  editorText: ALPHA BETA
  durable: ALPHA BETA                         ← 被提升后的一次 join 把分叉补交上去

PROBE RESULT: all assertions held.
```

**探针的边界（必须如实标注）**

- 只跑了 **1 次完整成功**（真实浏览器）。第二次重跑没有产出：harness 固定使用 `5173`/`3101` 且不并行安全（`tests/browser/README.md`），而 A6 的并行 worktree（`Insighthub-wt-a6-m3-ai-evidence`）在自己的套件里占用了这两个端口；被观察时端口由 A6 worktree 的两个 node 进程持有（`vite.js` 与 `src/index.ts`）。我没有终止它们，也没有改动 A6 的工作树；本轮随后删除了探针文件。
- 第一次运行的进程退出码为 `1`，但**所有断言都通过并且打印了 `PROBE RESULT`**。日志无法区分这是 node 自身的退出码还是 PowerShell 对 stderr 的包装（脚本在失败分支才设置 `process.exitCode = 1`，而失败分支没有执行），因此本报告**不把该退出码当作 PASS/FAIL 依据**，只引用打印出来的断言与实测值。
- 第 9 步只验证"提升后有新 join 时会被补交"这一条路径；没有验证"同一 socket 上角色被服务端重新判定（无新 join）"的情形——那种情形下客户端仍以为自己是 viewer（§17.5：没有 server→client 角色变更消息），编辑器保持只读，AI Accept 保持 disabled，因此分叉也不会在那一刻出站。

## 8. Acceptance Criteria

M3 验收 **F（权限：viewer/commenter 不能通过 AI 绕过写权限；UI 不提供 + 服务端拒绝；accept 需 editor）**，逐项：

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| UI 不提供（已知非编辑角色） | **PASS** | `AiSuggestPanel.tsx:248` + `:200`；浏览器实测：`role: viewer` 时 Accept `disabled: true`、程序化 `.click()` 文本不变、出站 SYNC 帧不变 |
| 服务端拒绝越权写入（apply / persist / broadcast 之前） | **PASS** | `registry.ts:716-760`；既有 Node 测试 `authz-enforcement.test.ts:272-318`（viewer 的 Update 被 `FORBIDDEN`，未 apply、未 persist、未 broadcast、socket 保持、仍能收更新）；A6 的 `tests/browser/suite/20-m2-phase2-authz.mjs` 场景 `p2/1-viewer-cannot-write`（README 记录；本轮未运行该套件） |
| AI 写入与普通写走同一条受控路径（不是新通道） | **PASS** | 代码路径同一（§4.2）；`features/ai/**` 无 role/canEdit 引用；服务端对 wire 上的 update 不区分 origin，因此不可能为 AI 单开一条路 |
| accept 需 ≥ `editor` | **PASS** | `gate.capabilities.canEdit` = `hasAtLeastRole(role,'editor')`；`aiAcceptRequiredRole`（Zod enum：`editor` \| `owner`）当前无消费者，P3-b |
| viewer/commenter 不得通过 AI 绕过写权限 | **PASS（在线、已知角色）**；离线时是"未知角色 + 本地分叉"，不是绕过：服务器从未收到、也从未接受该写入 | 探针 §6/§7；D-064 §2 #3 的既有裁定 |
| 离线不产生重复 apply | **未验证**（不在本轮判定范围；属 A4/A6 的 D-075 §3.8 判据） | — |
| AI 全程走 Yjs transaction（D-075 §6 A） | **PASS（本轮复核，非重测）** | `apply.test.ts` 已钉住"恰好一个事务 + origin `ai`"；`apply.ts:114` |

## 9. 与其它 Agent 的集成关系

| 关系 | 说明 |
| --- | --- |
| 依赖 A1 | `CollaborativeSession.getRole()`（§17.9）、`transact(fn, origin)`、IndexedDB 持久化与重连握手；本轮的"离线 null / 分叉永不出站"结论完全建立在 A1 的 `getRole()` 语义与 sync-provider 的 SyncStep1-only 行为上 |
| 依赖 A2 | `DocumentWorkspace` 的 `gate` 传递、`AiSuggestPanel` 的 disabled + `accept()` 守卫；本轮未改这些文件 |
| 依赖 A4 | `applySuggestion` / `revision.ts`；本轮确认其"无权限检查"是设计而非疏漏，但建议不要把权限塞进这个纯函数（§11） |
| 依赖 A3 / A5 既有实现 | `registry.ts` 的 frame gate 与 mutation pipeline、`authz/**` 的单一规则表；本轮只读复核 |
| 下游 A6 | 建议新增永久浏览器场景：viewer 在线 Accept disabled + 程序化点击无效；未知角色离线 Accept 的本地/durable/重连/重载断言（A6 正在并行写永久场景，本轮未触碰 `suite/**`） |
| 下游 A7 | 终审时可直接引用本报告 §0/§4/§7；唯一需要重新判断的是 §11 的三个选项 |
| 契约 | **未改动**任何 frozen contract / version（`SHARED_CONTRACT_VERSION`、`PROTOCOL_VERSION` 未动） |

## 10. Known Risks / 未验证内容

| 项 | 状态 | 说明 |
| --- | --- | --- |
| AI-origin update 的**端到端**服务端拒绝 | **未端到端实测** | 无法在不改生产代码的前提下以"在线 viewer"身份调用 `applySuggestion`（UI 挡死，且页面 `Y.Doc` 不可从 instrumentation 触达）。证据是"同一帧类型 + 同一代码路径"：既有 Node P2-1 测试用真实 `encodeSyncUpdate` 经真实 socket 被拒（A6 的浏览器场景同理），而 AI 写入产生的就是同一帧。这是**层次等价**，不是 AI 专属拒绝的实测 |
| commenter 的 AI 路径 | **未单独实测** | 与 viewer 共用 `canEdit === false` 的同一条 `capabilityGate`；`editorRoleGate.test.ts` 与 `documentCapabilities` 已钉住 commenter 不可编辑。AI 面板层面没有 commenter 专属代码 |
| 离线分叉的"提升后补交" | **实测 1 次**（探针第 9 步） | 只验证"提升 + 新 join"路径；未验证并发编辑下补交的冲突结果（那是 CRDT 语义，不是权限问题，建议 A6 的 M3 G 覆盖） |
| 探针可重复性 | **弱** | 一次性、单次、未提交；A6 的永久场景才能作为门禁证据 |
| 浏览器版本 / 平台 | 未记录 | 探针未打印 Chromium 版本；与 A6 的 browser gate 环境不完全可复现 |
| `aiAcceptRequiredRole` 漂移 | **潜在** | 见 P3-b；今天无行为差异 |
| 跨 worktree 并行跑浏览器门禁 | **不可行（编排风险）** | 每个 worktree 的 `DevStack` 都固定使用 `5173`/`3101`，两个 worktree 同时跑真实浏览器套件会互相抢端口（本轮第二次重跑即因此无产出）。A0 排期时需要串行，或给每个 worktree 配置不同的 `serverPort`/`webPort` |
| 未验证："未知角色下 Accept 是否应该被允许"这一**产品**问题 | **不属 A5 单方可答** | 属 permission semantics；见 §11 |

**不作出的声明：** 本报告不声称"AI 路径在离线时也是安全的"；准确的表述是"离线 AI 写入与离线打字是同一类本地分叉，服务器在收到之前拒绝一切非 editor 的 mutation，因此它不是一条能改变共享文档的越权通道"。

## 11. Need Supervisor Decision

### 是否给 `applySuggestion` 加咨询性预检（`port.getRole()` 已知且无 `canEdit` → `{ok:false, reason:'forbidden'}`）？

**A5 建议：现在不加（方案 A）。**

| 方案 | 内容 | 赞成 | 反对 | 影响面 |
| --- | --- | --- | --- | --- |
| **A（推荐）** | 不改代码；把离线分叉写进残余风险与 release-note 措辞，由 A6 用永久浏览器场景钉住现状 | 零风险、零契约改动；三层判定点已闭合；离线分叉是 R10/§17.9 的既有语义，D-064 §2 #3 已裁定为"已知缺陷、非安全缺陷" | 未来若出现第二个 `applySuggestion` 调用方（命令面板、快捷键、A4 的新入口），它不会自动获得权限护栏 | 无 |
| **B** | 在 `AiApplyPort` 加**可选** `getRole?()`；`ApplyResult` 本地扩展 `'forbidden'`（**不进 shared**，避免 `SHARED_CONTRACT_VERSION` 与 §11.1 四原因表变动）；面板把 `forbidden` 渲染成"你的角色不允许"而不是 stale | 纵深防御：任何未来的直接调用方都会被拦；`testSupport.applyPort` 一处加 `getRole: () => 'editor'` 即可保住现有 14 处调用，测试改动小 | **对被测窗口完全无效**（离线 `getRole()` 是 `null`，预检不触发）；在线窗口本来已有 `disabled` + `accept()` 双守卫；把权限塞进纯 apply 函数会模糊"服务端是权威、客户端只做 UI 门控"的分层；`ApplyResult` 与 `APPLY_FAILURE_COPY`（A2 文件）都要加第五种 reason，而 copy 注释明确说"四种失败是契约文案" | A4 `apply.ts`（A4 所有）+ A2 `AiSuggestPanel.tsx` / `aiProposalCopy.ts`（A2 所有）+ `apply.test.ts` 新增 1–2 用例；属跨 ownership，需 A0 协调 |
| **C** | 在 `capabilityGate` 里把"未知角色"改成对 AI 只读（例如 `canEdit: false` 仅传给面板） | 直接消除离线 Accept | 与 §17.9 gating consequence、R10 冲突：未知角色不得锁死编辑；会让"离线可用"变成"离线禁用 AI"，且与编辑器的行为不一致；属 permission semantics 变化 | `capabilityGate.ts` + 面板；需 owner 决定（D-073 §2） |
| **D** | 记住"最后一次已知角色"，离线时按它门控 | 离线仍能拦住已知 viewer | §17.9 rule 2/3 明文禁止 stale role（"a stored role can outlive the room"）；会把"离线 viewer 打字"也一起锁死或制造更糟的不一致 | A1 `getRole()` 语义 + 契约 |

**若 A0 选 B，请同时接受两条约束：**（1）文案与报告**不得**说它"修复了本地分叉"；（2）`forbidden` 必须留在 web 侧，不得进入 `ValidationFailureReason`（那是 §11.1 的 stale 原因表，不是权限结果）。

### 另外两个需要 A0 派发的决定

1. **A6 永久场景**：建议在 `tests/browser/suite/**` 增加 `m3/ai-viewer-accept`（在线 viewer：Accept disabled + 程序化点击零写入）与 `m3/ai-offline-unknown-role`（本报告 §7 的步骤 5–8，断言本地/durable/重连/重载）。这属于 A6 的 ownership，A5 不越界。
2. **P3-b 的处置**：`aiAcceptRequiredRole` 是让 A2 的面板改用它，还是从 shared 里删除/标注为"仅文档用途"？改 shared 需 A0 批准（§2），A5 建议**不改**，只在 M3 终审记录为"语义等价但未接线"。

## 12. 给项目负责人的总结

在这一轮之前，"AI 能不能被 viewer 用来绕过写权限"只有 A2 的一句实现声明：Accept 在 `!canEdit` 时 disabled。本轮独立复核并实测后，在线路径是闭合的：UI 会禁用并吞掉程序化点击，任何真正到达服务端的 update 都要过 `canEdit` 的 frame gate，且 AI 没有自己的 HTTP 端点或持久化直写——它和打字走完全同一条 Yjs 事务与 WS 帧。真正需要纠正的是问题里隐含的前提：断网后客户端不再"记得"自己是 viewer，`getRole()` 变成 `null`，所以离线时 Accept 是亮的；这不是 A2 的 bug，而是"未知角色不得锁死编辑"这条冻结规则的直接后果。实测表明，离线 Accept 只在本地生效（IndexedDB 持久化、服务器零感知、0 个 FORBIDDEN），重连不会被纠正，重载后仍在；若该用户之后被提升为 editor 并重连，这段编辑会被当作普通离线编辑补交。这与"离线 viewer 打字"完全同类，D-064 早已把这类分叉裁定为已知缺陷而非安全缺陷。因此本轮不建议加预检：它对离线窗口无效、对在线窗口冗余，却要跨 A4/A2 两个 ownership 并给契约文案加第五种失败原因；真正值得做的是 A6 把这两条行为固化成永久浏览器场景，并在发布说明里用准确措辞描述"未知角色可离线编辑"。

## 13. Git 状态

```text
$ git status --short
?? docs/agent-governance/A5-m3-ai-permission-review.md
$ git branch --show-current
agent/a5-m3-ai-permission
$ git log --oneline -1
20c3470 merge(integration): A2 M3 Diff Preview - Ask AI panel, accept/reject, revision tracker, stale copy
```

工作树除 `docs/agent-governance/A5-m3-ai-permission-review.md` 外干净（一次性探针已删除）；未 commit、未 merge、未 push、未打 tag。

## Next Handoff

```text
Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
agent/a5-m3-ai-permission @ 20c3470   (== main @ 20c3470)

Why:
M3 验收 F 的三层判定点已复核并闭合：在线 viewer/commenter 无法通过 AI 写入（UI disabled + accept() 守卫 + 服务端 canEdit frame gate），AI 路径与普通写同源，未发现 P1/P2 绕过。
需要 A0 裁定的三点：(1) 是否给 applySuggestion 加 reason:'forbidden' 咨询性预检（A5 建议：不加；若加，见方案 B 的约束）；
(2) 是否派 A6 增加两个永久浏览器场景（在线 viewer Accept / 离线未知角色 Accept 的本地+durable+重连+重载）；
(3) P3-b：aiAcceptRequiredRole 零消费者，是否处理。

Dependencies satisfied:
- 四门禁在 20c3470 全绿（typecheck 0 / vitest 465 / server 181 / build 0）
- 真实浏览器实测证据已在本报告 §7（一次性探针，未提交；A6 的 suite/** 未被改动）
- 未修改任何 frozen contract / 生产代码 / 共享包
- 无 P1/P2 未决项

Copy-paste Prompt:
你是 A0（Supervisor）。A5 已完成 M3 第四棒的 AI 接受路径权限复核，报告在
docs/agent-governance/A5-m3-ai-permission-review.md（base 20c3470，分支
agent/a5-m3-ai-permission，未提交）。请复核报告并裁定三件事：
1) 是否给 apps/web/src/features/ai/apply.ts 的 applySuggestion 加咨询性预检
   （port.getRole() 已知且无 canEdit → {ok:false, reason:'forbidden'}）。A5 建议：
   不加（对离线窗口无效、在线窗口冗余，且需跨 A4/A2 ownership 并改 ApplyResult
   与 APPLY_FAILURE_COPY）。若决定加，禁止把 'forbidden' 放进 shared 的
   ValidationFailureReason，并明确它只是冗余护栏。
2) 是否派 A6 在 tests/browser/suite/** 增加两个永久场景：在线 viewer 的
   Accept disabled + 程序化点击零写入；离线未知角色（getRole()===null）Accept 的
   本地文本 / IndexedDB / durable / 重连 / 重载断言（报告 §7 的步骤 5–8）。
3) P3-b：packages/shared 的 aiAcceptRequiredRole 目前零消费者（面板用
   gate.capabilities.canEdit，当前语义等价）。是否处理、如何标注。
不要改 production code 或 shared contract 除非先记录 decision。完成后更新
docs/TASKS.md 的 M3 状态，并把 A6 场景派发出去。
```
