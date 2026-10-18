# Existing Agent Migration Guide — 现有会话如何迁移到新的 prompt 体系

> 适用于**已经存在**的 Harness 会话/角色。新建会话时无需本文档：
> 只要在仓库或其 worktree 中启动，`AGENTS.md` 会自动生效（见
> [`harness-setup.md`](./harness-setup.md) §2.3）。
>
> 前置说明（重要）：**现有会话的 system prompt 无法由我改写**——Harness 没有终端用户
> prompt 编辑 API（实测确认）。因此下表给出的是"该会话应当使用哪份 prompt"，由项目
> 负责人在新建会话或 UI/Profile 中应用一次。

---

## 1. 迁移对照表

| 现有 Agent | 迁移后使用的 prompt 组合 | 角色定位 | 备注 |
| --- | --- | --- | --- |
| `00-bootstrap-supervisor` | `COMMON.md` + `A0-supervisor.md` + `AGENTS.md` | Supervisor / Architect / Integration Lead | 保留其"引导期全权负责"的历史身份，但**默认动作改为分派与审查**，不再自己吞业务实现 |
| `A1-collaboration` | `COMMON.md` + `A1-collaboration.md` + `AGENTS.md` | Collaboration / Yjs | 行为不变；新增"公共面只有 `collab/public.ts`"的显式边界 |
| `A2 Editor Frontend` | `COMMON.md` + `A2-editor-frontend.md` + `AGENTS.md` | Editor Frontend | 行为不变；新增"不得在 ViewPlugin 构造期 dispatch"等本轮已踩过的坑 |
| `A3 Realtime Backend` | `COMMON.md` + `A3-realtime-backend.md` + `AGENTS.md` | Realtime Backend | 行为不变；新增"数据面必须晚于 `room-joined`"的显式纪律 |
| `A6 QA` | `COMMON.md` + `A6-qa-chaos.md` + `AGENTS.md` | QA / Chaos Engineering | 强化"真实浏览器 vs jsdom"的界线与 Release Gate 输出要求 |
| `99-env-maintenance` | **不使用 A0–A7 任一角色文件**；只需 `COMMON.md` §3/§4/§5（真实证据、禁止事项、阻塞上报）+ `AGENTS.md` §7 范围纪律 | 环境维护，不属于产品研发团队 | 见 §3 |

> `A4` / `A5` / `A7` 目前没有对应历史会话；将来启用时直接用
> `COMMON.md` + `A{n}-*.md` + `AGENTS.md`。

---

## 2. 每个会话具体怎么切换

### 2.1 `00-bootstrap-supervisor` → A0

**变化点**：从"什么都自己做"变成"派发 + 审查 + 集成 + 决策"。

迁移后它的第一批动作应当是：

1. 读 `A0-supervisor.md` §3，确认派发单要素（任务 ID / branch / worktree / Owned /
   Do Not Touch / dependencies / acceptance / 验证命令 / 报告要求）。
2. 读 §4，确认它可以否决 Worker 交付（哪怕报告写得再好，diff 不对就不通过）。
3. 每个里程碑结束输出 **Supervisor Milestone Report**（`A0-supervisor.md` §6）。

**不需要**在新会话里粘贴旧的长提示词：那些内容已沉淀到上述三份文件。

### 2.2 `A1-collaboration` / `A2 Editor Frontend` / `A3 Realtime Backend` / `A6 QA`

四个会话的迁移步骤相同：

1. 新建（或重建）会话，工作目录指向**它自己的 worktree**（不要共用工作区）。
2. 在 worktree 根放置 `AGENTS.local.md`，内容 = 一句角色声明 + 两份文件路径 + 本次任务
   （模板见 `harness-setup.md` §3）。
3. 首次任务直接给派发单即可；`COMMON.md` 与角色文件由 `AGENTS.local.md` 指过去。

**为什么建议新建会话而不是改造旧会话**：旧会话的 system prompt 无法改写，
旧上下文里可能残留旧规则（例如旧的报告格式、"可以自己改别人的文件"之类的隐含习惯）。
新建会话的上下文干净、可复现，成本也低。

### 2.3 `99-env-maintenance` → 不进入产品 Agent 模型

它是**环境维护角色**，不负责 InsightHub 的任何模块，因此：

- **不分配** Ownership（不拥有任何 product path）。
- **不使用** `A0`–`A7` 任何角色文件：给它套上 `A2` 或 `A3` 会让它在架构讨论中
  以错误身份发言，也会让 Ownership 表失真。
- 它是**共用的工具角色**：任何 Agent 都可以请它处理环境问题，但环境改动本身不改变
  产品 Ownership。
- 它仍需遵守的通用底线：`COMMON.md` §3（真实执行）、§4（禁止事项）、
  §5（阻塞上报）。它的报告格式沿用其自身习惯，**不强制**套用 Task Completion Report
  （那份报告是为产品任务设计的；环境维护如有需要，可用其 §1/§7/§11/§13 四项精简版）。
- 边界提醒：环境的可用性由它保证，但**不得**借"修环境"之名修改产品代码或
  冻结契约（`AGENTS.md` §2 仍然适用）。

---

## 3. 迁移后的三个立即可见收益

1. **派发变短**：A2 的下一次任务只需要一句"修复 P0-2/P0-3，branch=…，完成后执行
   AGENTS.md DoD"，不再粘贴行为规范。
2. **规则只有一份**：`COMMON.md` 改了，所有 Agent 的下一轮都生效；不会再出现
   "某个会话还在用三个月前的规则"。
3. **审查有据**：Task Completion Report 是格式化的，A0/A7 可以逐项对照 diff 核验，
   而不是凭报告的语气判断可信度。

---

## 4. 迁移检查清单

- [ ] 每个产品 Agent 会话都有明确的 worktree，且互不共用
- [ ] 每个 worktree 根的 `AGENTS.local.md` 指向正确的角色文件
- [ ] `AGENTS.local.md` 未被误提交（`.gitignore` 是否已加，待项目负责人决定）
- [ ] `00-bootstrap-supervisor` 已按 A0 角色重新定调（派发优先于亲自实现）
- [ ] `99-env-maintenance` 未被塞进 A0–A7 ownership 模型
- [ ] 任一 Agent 都能在**不粘贴长文本**的前提下开始工作
