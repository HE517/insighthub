# UI-0 只读审计 — 采纳参考 UI 前的现状核对

- **阶段**：UI-0（只读；未改任何产品/测试代码）
- **绑定 SHA**：`f33e23e`（本报告所有结论以该 commit 为准）
- **浏览器**：Chrome **157.0.8103.38**（注意：与历史证据的 155 不同，见 §4.3）
- **日期**：2026-11-07
- **总体状态**：`PARTIAL` — a–e 与基线完成；**UI 采纳矩阵 `BLOCKED`：工作区/附件中找不到 `InsightHub.html`**

> 状态词：`PASS` / `IMPLEMENTED` / `NOT IMPLEMENTED` / `NOT VERIFIED` / `BLOCKED`。

---

## 0. 阻塞项（必须先解决）

已在以下位置递归搜索，未找到 `InsightHub.html`：

- 仓库工作区 `Insighthub/**`（含 worktrees）；
- `D:\前端\react\项目\面试项目\**` 的常见目录（`notes/plan/简历/面试/tmp/.codex-temp`）；
- `C:\Users\hrm17\Downloads`、`Desktop`、`Documents`、`.dsh/attachments`；
- git 全历史对象（`git rev-list --all --objects`）。

**结论**：原型文件未进入本会话可访问的文件系统。矩阵无法逐元素核对，需提供路径（见 D0）。

---

## 1. UI 采纳矩阵（原型元素 → 源码 → 能力 → 方案）

> **BLOCKED**：原型 DOM 未读取，下表的“原型元素”来自任务描述（localStorage、textarea、模拟邀请、规则化假 AI）与现有 UI 清单，**不是**对原型的逐元素核对。拿到文件后需逐项替换为真实选择器/截图。

| # | 原型元素（待核对） | 对应源码/符号 | 真实能力状态 | 处理方案 |
| --- | --- | --- | --- | --- |
| 1 | 左侧文档列表 / 当前项高亮 | `AiDirectoryView`（`AiDirectory.tsx:228-360`）、`aria-current`（`:342-344`） | `IMPLEMENTED`；目录即文档列表 | 保留结构；UI-1 仅换 token/间距/文案 |
| 2 | 顶部标题 + 用户/角色 | `DocumentHeader.tsx`（`active-document:97`、role chip `:132-137`）、`ClerkIdentity.tsx:58-84` | `IMPLEMENTED`；角色未知时不渲染 chip | 保留 testid；UI-1 只改布局与样式 |
| 3 | 编辑器（原型 textarea） | `CollaborativeMarkdownEditor.tsx`（`markdown-editor`） | `IMPLEMENTED`（CodeMirror 6，非 textarea） | **不照搬 textarea**；保留真实编辑器 |
| 4 | 预览视图 | `MarkdownPreview.tsx`、`MarkdownPreviewRenderer.tsx` | `IMPLEMENTED`；只读、无 raw HTML | UI-1 只改排版 token |
| 5 | 本地 localStorage 持久化 | `persistence.ts` + `y-indexeddb` | `IMPLEMENTED`，但用 IndexedDB + Yjs，**不是 localStorage** | **不采纳** localStorage 方案 |
| 6 | 新建文档按钮/弹窗 | `AiDirectory.tsx`（`new-document`）、`newDocumentFlow.ts:63-80`、`POST /api/documents` | `IMPLEMENTED`；无 title 输入弹窗（默认 `Untitled document`） | UI-2 可加“标题输入弹窗”，但必须走真实接口（见 D2） |
| 7 | 邀请成员弹窗（模拟） | **无服务端接口**（§2b） | `NOT IMPLEMENTED` | UI-2 不实现；UI-3 需先做后端（D3） |
| 8 | AI 面板（规则化假 AI） | `AiSuggestPanel.tsx`、`AiDirectory.tsx`、`aiProvider.ts` | 真实 provider seam；默认本地确定性 provider；外部 live `NOT VERIFIED` | **不照搬假 AI**；UI-2 只改面板布局与状态 |
| 9 | 状态条 / 保存提示 | `ConnectionStatusBadge.tsx`、`OfflineNotice`、`undo-state` | `IMPLEMENTED`；没有“已保存”承诺 | UI-1 改样式与文案；不得加假“saved” |
| 10 | 主题 / 配色 / 圆角 / 阴影 | `styles.css` 的 CSS 变量 | `IMPLEMENTED`（现有 token） | UI-1 用 token 覆盖，逐项对照原型 |
| 11 | 空态（无文档/无建议） | `ai-directory-empty`、`ai-empty` | `IMPLEMENTED` | UI-1 改文案/视觉；UI-2 加“示例文档”需 D2 |
| 12 | 响应式/窄屏 | 无 | `NOT IMPLEMENTED` | UI-4，需 D4 批准 |
| 13 | 退出登录 | `ClerkIdentity.tsx:79-84`（`sign-out`） | `IMPLEMENTED` | UI-2 移到顶栏；保留 testid |
| 14 | 角色标识 / 协作者列表 | `DocumentHeader.tsx:130-170`、`CollaboratorList.tsx:35-39` | `IMPLEMENTED` | UI-2 顶栏重组；保留 id |

**矩阵状态**：`BLOCKED`（缺原型文件）。其余“真实能力”列已按源码核对，标 `PASS`。

---

## 2. 五个核实问题

### a. 创建文档接口是否接收 title？创建后初始内容走哪条路径？

**接收 title，但不是必填。**

- 路由：`apps/server/src/app.ts:547-585` `POST /api/documents`；
- 请求体解析：`app.ts:609-626` —— 接受 `{}` 或 `{ "title": string }`；未知字段/超长/空串一律 `400 invalid_request`；
- 省略时默认标题：`DEFAULT_NEW_DOCUMENT_TITLE`（`app.ts:611`、`:620`）；
- 创建：`sqlite-store.ts:411-424` `createDocumentWithOwner()` 在**一个事务**里插 `document`（空 snapshot）+ `document_meta`（title/owner）+ `document_membership`（owner）；
- 初始内容：**没有内容参数**。`EMPTY = new Uint8Array(0)`（`sqlite-store.ts:67-68`），文档从空开始；第一篇内容由客户端连接后第一次 Yjs update 写入（`room.applySyncPayload → store.append`）。
- 客户端：`newDocumentFlow.ts:63-80` 创建后先刷新目录、再切换文档；不发送初始内容。

**结论**：`IMPLEMENTED`。title 是可选入参；不存在“创建时写入初始 Markdown”的服务端路径。

### b. 是否存在按邮箱邀请、改角色、移除成员的服务端接口？未注册邮箱如何处理？

**不存在。**

- 路由清单（`app.ts:347-594`）只有：
  `GET /health`、`GET /ready`、`GET /api/meta`、`POST /api/session/bootstrap`（仅非生产）、
  `GET /api/session`、`DELETE /api/session`、`GET /api/documents`、`POST /api/documents`、
  `GET /api/documents/:id`。
- 没有 `POST /api/documents/:id/members`、`PATCH .../role`、`DELETE .../members/:userId` 之类的入口。
- membership 目前只用于**内部鉴权**（fixture/管理侧写入），产品层无邀请 UI 与 API。
- “未注册邮箱如何处理”因此 **`NOT IMPLEMENTED`**：没有邀请动作，就没有该分支；未来实现时必须决定“发邮件/只生成 pending membership/仅站内提示”。

**结论**：`NOT IMPLEMENTED`。UI-3 之前必须先做后端契约（D3）。

### c. Preview 渲染器是否支持任务列表（`- [ ]`）？

**支持，但项目没有专门的测试断言。**

- `remark-gfm` 的包描述与依赖明确包含 **tasklists**（`apps/web/node_modules/remark-gfm/package.json`）；
- `MarkdownPreviewRenderer.tsx:112-115` 只覆盖 `a` 与 `img`，其余节点走 `react-markdown` 默认渲染；
- `react-markdown` 对 GFM task list 的默认输出是 `<input type="checkbox" disabled>`（其 README 示例）；
- 项目现有 `preview/2` 只断言 headings/lists/table 等，**没有** `- [ ]` 用例。

**结论**：`IMPLEMENTED`（库能力）+ `NOT VERIFIED`（本项目未测）。UI-2 若把任务列表纳入验收，必须新增断言（复选框 disabled、不产生事件）。

### d. 目录当前项的 `aria-current` 在测试中如何被选取？

- 生产：`AiDirectory.tsx:342-344` 在 `data-testid="ai-directory-item"` 的行上设置
  `aria-current={current ? 'true' : undefined}`；非当前项**没有该属性**。
- 测试读取：
  - `tests/browser/suite/08-evidence-gate.mjs:94-99`：`node.getAttribute('aria-current') === 'true'`；
  - `tests/browser/suite/32b-m4-b125.mjs:133`：`item.getAttribute('aria-current')`；
  - `:537`：断言“创建前恰好一行是 aria-current”。

**结论**：`PASS`。选取方式是 `[data-testid="ai-directory-item"][aria-current="true"]`（或读取属性后过滤），不是 class。

### e. 退出登录、协作者列表、连接徽标、角色标识当前组件位置

| 元素 | 组件 / 位置 |
| --- | --- |
| 退出登录 | `apps/web/src/session/ClerkIdentity.tsx:79-84`（`data-testid="sign-out"`）；由 `ClerkIdentity` 渲染在身份区域 |
| 协作者列表 | `apps/web/src/features/collaborators/CollaboratorList.tsx:35-39`（`data-testid="collaborator-list"`）；在 `DocumentHeader.tsx:170` 挂载 |
| 连接徽标 | `apps/web/src/features/status/ConnectionStatusBadge.tsx:36-42`（`data-testid="connection-status"`）；在 `DocumentHeader.tsx:130` 挂载；离线提示 `OfflineNotice` 同文件 `:58` |
| 角色标识 | `DocumentHeader.tsx:132-137`：`<span class="role-chip">role: {gate.role}</span>`；role 为 `null` 时不渲染 |

**结论**：`PASS`。

---

## 3. 基线（绑定 `f33e23e`）

### 3.1 默认浏览器套件

| 项 | 结果 |
| --- | --- |
| 命令 | `node tests/browser/run.mjs` |
| 结果 | **78/78 PASS, exit 0** |
| 浏览器 | Chrome **157.0.8103.38** headless |
| 端口 | 5173 / 3101 释放；临时目录清理 |
| 备注 | 73 基础 + 5 preview；remote 83 注册但**未跑** |

### 3.2 test id 全量清单（44 个，源码中唯一）

`active-document, ai-accept, ai-close, ai-diff, ai-directory, ai-directory-empty, ai-directory-error, ai-directory-item, ai-directory-refresh, ai-empty, ai-generate, ai-instruction, ai-intent, ai-open, ai-panel, ai-proposal, ai-reject, ai-stale, ai-status, ai-summary, auth-boot, auth-gate, clerk-identity, clerk-server-identity, clerk-sign-in, clerk-user-email, clerk-user-name, collaborator-list, connection-status, editor-resync, markdown-editor, markdown-preview, markdown-preview-content, markdown-preview-loading, mode-editor, mode-preview, new-document, new-document-error, offline-notice, session-failed, session-identity, session-initializing, sign-out, undo-state`

> 约定：UI-1/2 只新增 id；以上 44 个的**语义与存在性**不得改变。

### 3.3 输入延迟基线（同机、同 100k fixture、local production build）

环境：Windows 11 / i5-1340P / 15.7 GiB / Node 22.14.0 / **Chrome 157.0.8103.38** / 100,000 行、6,788,895 chars、sha256 `0d12688d…`；操作：文档开头 3×100 次真实 `Input.insertText("x")`，页面内 `beforeinput→input→next frame`。

| Run | N | P50（model） | Max（model） | P50（next frame） | Max（next frame） | ready |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 300 | 963.3 ms | 1349.7 ms | **965.0 ms** | **1351.3 ms** | 629 ms |
| 2 | 300 | — | — | **1003.2 ms** | **1250.9 ms** | 632 ms |

**UI-1 采用基线**：P50 = **965 ms**，Max = **1351 ms**（run 1；run 2 P50 +4.0%，说明基线噪声约 ±5%）。

> **重要环境变化**：历史证据（`c2ad879`）是 Chrome **155**，input P50 约 268.8 ms；当前 Chrome 已升级到 **157**，同机同 fixture 的 P50 变为约 965 ms（约 3.6×）。这不是产品代码变化（`f33e23e` 相对 `c2ad879` 只有 docs 与 preview 合入），必须在 UI-1 对照时使用**本次基线**，不能拿旧数字比较。

### 3.4 同轮其他基线（仅供参考，不作为 UI-1 门禁）

- reconnect（restore→connected）P50 782 ms、max 789 ms；
- Long Task 357 个，max 1350 ms；
- `pnpm build` exit 0；构建时临时移除 `apps/web/.env.local` 以生成 demo 模式产物，之后已恢复。

---

## 4. 需要你决定的事项

| ID | 决策 | 现状/影响 | 建议 |
| --- | --- | --- | --- |
| **D0** | **提供 `InsightHub.html` 的可访问路径**（或贴到仓库 `design/`） | 矩阵 BLOCKED；没有它无法逐元素采纳 | 必须；这是进入 UI-1 的前提 |
| **D1** | 视觉采纳范围：只换 token/排版，还是连同布局/组件形态一起改？ | 现有 DOM/testid 契约很密；大改布局会连带改测试选择器 | 建议 UI-1 只换 token/间距/字体/状态条样式，布局在 UI-2 分项做 |
| **D2** | “示例文档”按钮是否允许**真实创建**文档（写服务端）？ | 当前无该按钮；真实创建会出现在目录里 | 建议允许，但必须走 `POST /api/documents` 并标注“示例”标题；禁止前端伪造内容 |
| **D3** | 邀请/成员管理是否进入 V1？ | 无后端接口（§2b）；UI 只能做禁用态 | 建议 V1 不做，或先补后端契约再排 UI-3；禁止上线“模拟邀请” |
| **D4** | 是否批准 UI-4 响应式？ | 当前无移动端适配 | 建议先完成 UI-1/2，再单独评估 |
| **D5** | UI-2 的 AI 面板“禁用自动生成、全文读取按字符数限制”具体语义？ | 当前有本地确定性 provider 与快捷意图；没有“全文读取”开关 | 需明确：是移除快捷意图，还是仅禁用远端自动生成；避免改变现有 AI 语义 |
| **D6** | 原型的“假 AI/模拟邀请”在 UI 上如何处理？ | 任务禁止上线模拟功能 | 建议：不展示，或展示为 disabled 并给出“未开放”原因 |

**决策前不进入 UI-1。**

---

## 5. 残余风险

1. **原型缺失**导致矩阵只能按现有 UI 与任务描述推断，不能声称“已逐元素采纳”。
2. **Chrome 157 基线约 1s**，与历史 155 的 268ms 差异巨大；UI-1 的 ≤10% 验收必须以本次 965ms 为基准，且同机同版本复测。
3. 套件 78/78 是默认套件；remote 83 未跑；Clerk 生产模式未在部署环境验证。
4. UI-0 未改动代码，但为了基线执行了 build 与 perf（临时移除/恢复 `apps/web/.env.local`，已确认恢复）。
5. 44 个 testid 的语义冻结；UI-2 新增行为必须新增测试，不得改旧断言。

---

## 6. Next Handoff

```text
Handoff Status: OWNER_DECISION_REQUIRED
Recommended Next Agent: A0
Base: agent/ui-0-audit @ <本报告提交>
Why: UI-0 的代码核查与基线已完成；UI 采纳矩阵被缺失的原型文件阻塞。
Dependencies satisfied: 78/78 基线；44 testid 清单；输入延迟 N=300×2；a–e 已核实。
Copy-paste Prompt: 提供 InsightHub.html 路径并回答 D1–D6；随后以 feature worktree 执行 UI-1（仅 token/布局/文案/状态条，不改行为），验收为默认套件 78/78 且输入延迟 P50 相对 965ms 恶化 ≤10%。
```
