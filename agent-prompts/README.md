# `agent-prompts/` — Agent Prompt 的版本化 Source of Truth

这个目录是 InsightHub 多 Agent（A0–A7）**提示词的唯一权威来源**。
项目负责人派发任务时不再需要粘贴长规范：规范在仓库里，随代码一起版本化。

---

## 1. System Prompt 的逻辑组成

一个 Agent 实际遵循的规则 = **三层拼接**：

```
COMMON.md                      共享行为约束（所有 Agent 相同）
  + A{n}-<role>.md             该角色的长期职责与不变量
  + AGENTS.md                  项目级协作契约（DoD、Ownership、Review、报告制度）
```

三者职责不同，**不要互相复制**：

| 层 | 回答什么问题 | 谁维护 | 变更频率 |
| --- | --- | --- | --- |
| `COMMON.md` | "在这个仓库里，什么行为是允许的？" 边界、阻塞上报、禁止事项、报告义务 | A0 | 低 |
| `A{n}-*.md` | "我这个角色长期负责什么、不负责什么、哪些不变量不能破？" | A0 | 低（角色稳定） |
| `AGENTS.md` | "任何任务都必须满足什么才算完成？" DoD、Ownership、冻结契约、报告格式 | A0 | 低（制度稳定） |
| **任务派发单** | "这一次具体要做什么？" 目标、branch/worktree、Owned Files、验收标准 | A0 | 每任务 |

**关键分工**：前三层是**长期不变的**，第四层才是每次任务真正需要写的。
这也是为什么派发任务不再需要长提示词。

## 2. 什么内容放哪里（避免重复与漂移）

| 内容类型 | 放这里 | 不放这里 |
| --- | --- | --- |
| 通用行为红线（不得伪造测试、不得越权改文件） | `COMMON.md` | 各角色文件 |
| 角色职责边界（A2 不碰 IndexedDB 实现） | `A{n}-*.md` | `COMMON.md` |
| 架构级不变量（正文只在 `Y.Text`） | `AGENTS.md`（并有 `docs/ARCHITECTURE.md` 详述） | 角色文件里重述 |
| 契约字段与 wire 格式 | `docs/CONTRACTS.md` | 任何 prompt 文件 |
| 任务目标、验收标准、验证命令 | **派发单**（一次性） | 仓库里的 prompt 文件 |
| 本任务的具体缺陷坐标（文件:行） | **派发单** | 角色文件（缺陷会变化） |

> 原则：**规则进仓库，任务进派发单。** 角色文件里出现"修 P0-1 时改 xx 行"这种内容，
> 就是放错了层——缺陷会修完，规则要长期有效。

## 3. 一次任务实际需要写多少字

有了这套文件，A2 的下一次任务派发单只需要：

```
修复 P0-2 / P0-3。
branch = agent/a2-p0-23，worktree = <路径>。
Owned：collabTextBinding.ts / remoteCursorExtension.ts。
完成后执行 AGENTS.md DoD，按 Task Completion Report 输出中文报告。
```

不需要再粘贴：行为规范、报告模板、角色边界、禁止事项、契约纪律。
这些都在 `COMMON.md` + `A2-editor-frontend.md` + `AGENTS.md` 里。

## 4. 如何把这三层喂给 Agent

两种方式，按环境选一种（详见 [`../docs/agent-governance/harness-setup.md`](../docs/agent-governance/harness-setup.md)）：

**方式 A：项目指令文件自动加载（推荐）**

DeepSeek Harness 的 `dsh-agent-instructions` 会自动加载工作区里的
`AGENTS.md`（以及同目录的 `AGENTS.local.md` 覆盖层）。因此：

- `AGENTS.md` 每次会话自动生效（无需粘贴）。
- 角色层用 worktree 根的 `AGENTS.local.md` 指向对应角色文件（一次性创建）。

**方式 B：显式引用（通用）**

会话第一条消息里写一行"先读 `agent-prompts/COMMON.md` 与
`agent-prompts/A2-editor-frontend.md`，然后按派发单工作"。

两种方式都**不是**把文件内容粘进对话——是把文件路径交给 Agent。

## 5. 变更纪律

- 本目录与 `AGENTS.md` 同属治理面：改动需 A0 决策，且单独提交
  （`docs(agents): ...`），不与业务代码混合。
- 角色职责发生变化时，**同时**更新对应 `A{n}-*.md` 与 `AGENTS.md` §3，
  避免两处说法打架。
- 冻结契约（`packages/shared/**`、`docs/CONTRACTS.md` 等）**不在本目录**，
  也不得在此处被"重新定义"——本目录只引用它们。

## 6. 文件清单

| 文件 | 角色 |
| --- | --- |
| `COMMON.md` | 共享行为底座：Ownership、冻结契约、阻塞用语、禁止事项、报告义务 |
| `A0-supervisor.md` | Supervisor / Architect / Integration Lead |
| `A1-collaboration.md` | Collaboration / Yjs |
| `A2-editor-frontend.md` | Editor Frontend |
| `A3-realtime-backend.md` | Realtime Backend |
| `A4-ai-document.md` | AI Document Editing |
| `A5-permission-state.md` | Permission & State Consistency |
| `A6-qa-chaos.md` | QA / Chaos Engineering |
| `A7-integration-review.md` | Integration / Architecture Review |
