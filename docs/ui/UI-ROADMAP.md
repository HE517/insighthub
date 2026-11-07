# InsightHub 路线图与决策包（A0，供 Owner 评审）

- 基线：`62b39d3` + UI-2 工作台重组分支
- 定位（建议）：**面向研发团队的 Markdown 活文档工作台——AI 只提议，每一处改动都由人审阅落笔。**
- 本文只做**设计与决策**，不承诺排期；P0/P1/P2 是待评审路线，不是已排期需求。
- 状态：`IMPLEMENTED` / `PASS` / `NOT VERIFIED` / `NOT IMPLEMENTED` / `BLOCKED`

---

## 0. 判断

现有真实优势是“AI 审阅流 + 离线协同 + 服务端权限 + 纯 Markdown”。要把定位兑现成团队产品，前置缺口是**版本历史、成员管理、真实模型/多人验证**（P0）；导出与分段接受是差异化加深（P1）；评论、搜索、大文档是协作闭环（P2）。

工作台重组（UI-2）已完成：目录左栏、文档中栏、AI 审阅右栏、绿系视觉、状态呈现。它不改产品语义，也不关闭任何 P0。

---

## 1. P0 — 版本历史

**问题**：现在只有 Undo/Redo（会话内、按 origin），团队没有“改坏了能回去”的能力；AI 改坏文档无法回退会直接损伤信任。

**必须区分两层**：

| 层 | 是什么 | 用户可见 | 现状 |
| --- | --- | --- | --- |
| 恢复快照（recovery） | SQLite/Yjs 的物理备份、compaction、崩溃恢复 | 否 | 已有备份脚本/快照，但未做生产演练 |
| 版本（version） | 用户可浏览、命名、恢复的文档历史 | 是 | `NOT IMPLEMENTED` |

**建议方案（选项 A）**：
- 生成时机：① 每次 AI Accept 之后；② 每累计 N 次提交或 T 分钟（建议 N=50 或 T=10min）；③ 用户手动“保存版本”。
- 内容：`document_version(id, document_id, sequence, title, author_id, created_at, yjs_state BLOB, kind)`；`kind = auto | manual | pre-restore`。
- 保留期：手动版本永久（可删）；自动版本 30 天 / 每文档最多 200 个（取一）。
- 权限：查看 = `canRead`；恢复 = `canEdit`（是否仅 Owner 见 D-V1）；删除版本 = `canManageMembers`。
- 恢复语义：**先写一个 `pre-restore` 版本保存当前内容**，再用一条带 `origin='restore'` 的 Yjs transaction 把目标状态合入当前文档；恢复本身产生一个新版本。并发/离线客户端通过正常 CRDT 收敛，不强制踢线；恢复 action 不删除历史。
- 与并发：恢复是“把旧状态作为新编辑合入”，不是回滚数据库；因此不会吞掉恢复期间其他人的编辑（需要冲突提示：恢复后 UI 显示“已从版本 X 恢复，当前含他人编辑”）。
- 验收：版本列表分页；恢复前快照存在；恢复后 A/B/服务端收敛；离线客户端重连收敛；Undo 可撤销恢复；权限拒绝 404/403 一致。

**决策点 D-V1**：谁可恢复——Owner only（更安全）还是 Editor 也可（更顺手）？建议 Owner + Editor，删除版本仅 Owner。
**决策点 D-V2**：自动版本粒度——按时间（10min）还是按提交数（50）？建议时间，避免高频小编辑产生噪声。

**依赖**：SQLite 迁移（新表）、Yjs state 编码/解码、恢复事务 origin、UI 版本列表/预览/恢复确认。
**顺序**：先做服务端版本表与恢复 API + 测试，再做 UI。

---

## 2. P0 — 成员管理

**问题**：Owner 能力只在服务端，产品里无法邀请同事；“团队产品”不成立。

**拆成四个动作**：

| 动作 | 谁可操作 | 服务端 | 未决问题 |
| --- | --- | --- | --- |
| 邀请 | Owner（建议） | `POST /api/documents/:id/invitations` | 未注册邮箱：发邮件？只生成 pending？站内链接？ |
| 接受 | 被邀请人 | `POST /api/invitations/:token/accept` | 邀请有效期（7 天）；重复接受幂等 |
| 改角色 | Owner | `PATCH /api/documents/:id/members/:userId` | 最后一个 Owner 不能降级 |
| 移除 | Owner | `DELETE /api/documents/:id/members/:userId` | 最后一个 Owner 不能移除；撤权后的 WS 会话 |

**未注册邮箱**（建议）：生成一次性邀请链接 + 站内 pending 记录，**不自动创建用户**；对方登录后接受。原因：Clerk 负责账号，产品不建第二套身份；也避免“邮件发不出去就是假功能”。
**撤权后会话**：服务端逐帧重查（已有），并在移除时主动关闭该用户在该文档的 socket；离线客户端的本地编辑保留在本地，重连 join 被 404/403 拒绝，UI 明确“已失去访问权限”，**不得**把本地修改上传。
**最后一个 Owner**：必须在同一事务内校验；拒绝并返回稳定错误码。
**验收**：邀请→接受→改角色→移除全链路；未注册邮箱路径；最后 Owner 拒绝；撤权后 HTTP/WS 双拒绝；被移除者离线重连不写库；404 非泄露。
**决策点 D-M1**：邀请是否发真实邮件（需要邮件服务，新增依赖）？建议 V1 只做站内邀请链接。
**决策点 D-M2**：Editor 是否可邀请 Viewer？建议否，仅 Owner。

---

## 3. P0 — 真实模型 live 与多人验证

### 3.1 B12 外部模型 live（单列）

**现状**：provider seam 与适配器已实现；外部调用**没有成功记录**。OpenAI 曾 429 `credit_balance_exhausted`；Kimi 401（endpoint 修正）后 400 `invalid_request_error`，改 prompt-only 后**未重试**。

**一次真实请求的授权单**（需 Owner 批准）：

| 项 | 建议 |
| --- | --- |
| 环境 | 本机/免费 staging，非生产 |
| provider / model | Kimi CN `https://api.moonshot.cn/v1`，`kimi-k3`（默认）；备选 OpenAI |
| 预算 | 1 次请求，max 4096 tokens，30s 超时，0 retry |
| 成功条件 | HTTP 200 + `AiSuggestionDraft` 通过 schema + 客户端锚定/预览成功；记录耗时、token、错误分类 |
| 失败处理 | 记录 status/provider code，不重试，不伪造成功 |

**决策点 D-A1**：是否批准这次调用及预算？未批准前 B12 保持 `NOT VERIFIED`。

### 3.2 多人验证（2 → 5 → 更高）

**场景设计**（可重复）：
- 独立身份 + 独立 browser context（现有 `collab/independent-contexts` 扩到 N）；
- 同段并发、不相交区域、断线补差、最终收敛；
- 指标：收敛时间、消息数、内存、Long Task；报告**团队人数 / 同时活跃数 / 实际测试数**三者分开。
- 2 人：已有证据（A=B=server + digest）。
- 5 人：新增脚本，5 个 context，写入不同区域 + 中途断线 1 人；断言 5 方 digest 一致。
- 更高：先到 10 人；上限由压测结果决定，不预先承诺 20/50。

**决策点 D-A2**：5 人验证是否批准（本地，无外部成本）？建议批准。
**决策点 D-A3**：是否把“5–20 人”写进对外文案？在 5 人通过前不建议。

---

## 4. P1 — 导出、分段接受、采纳记录

### 4.1 Markdown 导出
- 入口：文档头“导出 .md”；
- 权限：`canRead`；导出当前 `Y.Text` 快照（时点明确：点击时）；
- 内容：纯 Markdown，无隐藏元数据；文件名 `title.md`（title 为 id 时用 id）；
- 失败：下载被浏览器拦截/空文档 → 明确提示；
- 验收：Viewer 可导出；无权限 404；导出内容 hash 与 Y.Text 一致。

### 4.2 分段接受（按 hunk）
- 入口：Diff 每个 hunk 的复选框 + “接受选中”；
- 语义：一次 Accept 可产生 1..N 个 Yjs transaction（建议一个事务包含多个 operation，保持 Undo 一次）；
- 重叠修改：每个 hunk 应用前重新校验 `expectedText`；部分过期 → 该 hunk 标 stale，其余可接受；
- Undo：整次部分接受作为一个 undo step（origin `ai`）；
- 验收：全选=原 Accept；部分接受只改选中；重叠/过期不写；Undo 一次回退该次部分接受。

### 4.3 采纳记录
- 记录：`suggestion_id`、documentId、userId、acceptedAt、hunk 数、diff hash、模型/provider；
- 隐私：不存 instruction 原文与建议全文（默认），只存 hash/长度；需要审计时由 Owner 决定是否存全文；
- 粒度：每次 Accept 一条；部分接受记录 hunk 索引；
- 查询：文档内“采纳历史”（canRead）；全局审计（Owner）。
- 决策点 D-R1：是否记录 instruction 全文？建议默认不存，避免把用户输入变成长期敏感数据。

**Git 同步**：后续候选，不排期；需要仓库授权/OAuth、冲突策略、文件路径映射，属新的产品面。

---

## 5. P2 — 评论、搜索、大文档

### 5.1 评论
- 锚定：`RelativePosition`（与 AI 锚定同源），区间 + 原文校验；文档变化后 comment 标 stale 而不是错位；
- 权限：`canComment`（Viewer 可评论）；删除评论=作者或 Owner；
- 展示：右栏/行内气泡；不改正文、不进 Y.Text。
- 验收：并发编辑后锚点不漂移；越权 404；删除后 UI 更新。

### 5.2 搜索
- 服务端全文搜索（SQLite FTS5 或内存索引），**先按 membership 过滤**再返回；
- 不返回无权限文档的标题/片段（非泄露）；
- 大文档：限制 snippet 长度；搜索请求 AbortController + requestId。
- 验收：Viewer 只搜到可读文档；无权限文档零结果；删除/撤权后立即不可搜。

### 5.3 大文档
- 已知限制：100k 单段落 Preview 420s 未 ready；
- 推进前先分层测量：读取（Y.Text→string）、解析（Markdown parser）、DOM 提交/绘制；
- 策略选项：明确文档大小边界 / 分块预览 / 虚拟化预览 / 后台解析；
- 不改 Y.Text 单源与协同语义；优化前必须有 profile 数据，禁止“猜优化”。

---

## 6. 首次体验与模板

| 方案 | 是否写库 | 是否请求模型 | 失败可见性 | 评价 |
| --- | --- | --- | --- | --- |
| A 空白引导 | 否 | 否 | 无 | 最便宜，但首分钟看不到核心卖点 |
| B 可交互只读示例 | 否（内存/静态） | 否 | 示例加载失败提示 | 推荐：能演示 Diff/Accept 流程且不产生脏数据 |
| C 真实创建模板文档 | 是（POST） | 否 | 创建失败就地提示 | 可作为第二步按钮“用模板新建” |

**建议**：先做 B（只读示例 + 一次内置 AI 建议演示，**不调用外部模型**），再提供 C 的显式按钮；当前批次沿用现有创建行为，不改。

---

## 7. 实施顺序与闸门

1. UI-2 工作台重组（本批，已完成，78/78）。
2. P0 版本历史：服务端表/恢复 API/测试 → UI 列表/恢复。
3. P0 成员管理：邀请/接受/改角色/移除 API + 测试 → UI。
4. B12 单次真实调用（Owner 授权）→ B13 deployed smoke。
5. 5 人并发验证（本地）。
6. P1 导出 → 分段接受 → 采纳记录。
7. P2 评论 → 搜索 → 大文档（先 profile）。

每步必须：typecheck / test / build / 默认浏览器套件全绿；新增行为必须有新测试；不得删断言、降阈值、改 stub 过测试。

---

## 8. 需要 Owner 决定的事项（汇总）

| ID | 事项 | 选项 | 建议 |
| --- | --- | --- | --- |
| D-V1 | 谁能恢复版本 | Owner only / Owner+Editor | Owner+Editor，删除仅 Owner |
| D-V2 | 自动版本粒度 | 10min / 每 50 提交 | 10min |
| D-M1 | 邀请方式 | 真实邮件 / 站内链接 | 站内链接（不新增邮件依赖） |
| D-M2 | Editor 能否邀请 | 能 / 不能 | 不能 |
| D-A1 | B12 单次真实调用 | 批准 / 暂缓 | 批准 1 次，Kimi kimi-k3 |
| D-A2 | 5 人并发验证 | 批准 / 暂缓 | 批准（本地无成本） |
| D-A3 | 是否对外写 5–20 人 | 现在写 / 验证后写 | 验证后写 |
| D-R1 | 采纳记录是否存 prompt 全文 | 存 / 不存 | 不存，只存 hash/长度 |
| D-T1 | 首次体验 | 空白 / 只读示例 / 模板创建 | 只读示例，再给模板按钮 |
| D-E1 | 导出格式 | 仅 .md / 含 HTML | 仅 .md |
