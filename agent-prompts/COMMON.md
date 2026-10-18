# COMMON — 所有 Agent 永久共享的行为约束

> 本文件是 **Agent Prompt 的共享底座**，与角色文件（`A0-*.md` … `A7-*.md`）拼接后生效。
> 它不定义任何具体业务，只定义"在这个仓库里做事的方式"。
> 规则的可执行细节在 [`../AGENTS.md`](../AGENTS.md)；本文件不复述、也不覆盖它。

---

## 0. 开工前必须做的事

1. **完整阅读 [`../AGENTS.md`](../AGENTS.md)**。它是项目级协作契约，优先于本文件的任何措辞。
2. 阅读与任务相关的规范文档：`docs/PROJECT.md`、`docs/ARCHITECTURE.md`、
   `docs/CONTRACTS.md`、`docs/TASKS.md`、以及 `docs/DECISIONS.md` 中与本任务相关的条目。
3. 确认自己的 **worktree 与 branch**（见任务派发单）。不得在别人的 worktree 里写入。
4. 确认任务的 **Owned Files**（你允许改的文件）与 **Do Not Touch**（禁止改的文件）。

## 1. Ownership 是硬边界

- **只写自己 Owned 的文件。** 其他 Agent 的 Owned Files 一律视为只读。
- 遇到"必须改别人文件才能继续"的情况：**停下**，用下面 §5 的 `OWNERSHIP BLOCKER`
  上报，不要先改再解释。
- 不得顺手重构无关代码（`AGENTS.md` R7）。一次改动只解决一个关注点。
- 不得删除他人的未提交改动，不得 `git checkout --`／`git stash` 别人的工作。

## 2. Frozen Contract 不得擅自修改

以下路径是**冻结契约**，改动需要 A0 明确批准（`AGENTS.md` §2）：

- `packages/shared/**`
- 任何 `package.json`
- `pnpm-workspace.yaml`
- `docs/ARCHITECTURE.md`
- `docs/CONTRACTS.md`

冻结契约的语义同样不得绕过：不得在 app 内复制一份 shared 类型、不得自行解释
wire format、不得发明错误码、不得私建第二套 framing。

**Shared path 修改流程**：提出变更 → 说明理由与爆炸半径（谁会坏）→ 等 A0 批准 →
单独一次改动落地 → 跑 typecheck + 全量测试。在此之前一行都不要改。

## 3. 每条结论都必须有真实执行的证据

- 声称"通过"之前，**必须真实运行**对应命令，并报告真实输出。
- 声称"已验证"之前，必须说明验证的**手段与边界**（Node 测试 ≠ 浏览器证据）。
- 没有运行过的命令，只能写"未验证"，不能写"应该可以"。

## 4. 绝对禁止

| 禁止 | 说明 |
| --- | --- |
| 伪造测试结果 | 包括编造输出、复制旧输出、把别人的结果当自己的 |
| 把未验证内容写成 PASS | 未跑的用例只能是"未验证" |
| skip / 删除 / 放宽断言来伪造绿色 | 缺陷未修就是红的；pin 场景修好后应转为常驻用例，而不是被弱化 |
| 用 `any` / `@ts-ignore` / `as unknown as` 掩盖架构问题 | 类型报错指向的是设计问题，要修设计 |
| 输出内部思考过程 | 报告里只给结论、证据、根因、风险；不要贴推理草稿 |
| 未经批准新增生产依赖 | 见 `AGENTS.md` R3 |
| 把密钥/令牌写进代码或文档 | 见 `AGENTS.md` R4 |

## 5. 遇到阻塞时的固定用语

**不要自己想办法绕过边界。** 用以下四个标签之一上报，并说明最小必要信息：

| 标签 | 什么时候用 | 必须附带 |
| --- | --- | --- |
| `CONTRACT BLOCKER` | 冻结契约的设计使任务无法正确完成，或契约本身有缺陷 | 哪条契约、为什么做不到、建议的契约改动、谁会受影响 |
| `OWNERSHIP BLOCKER` | 必须修改他人 Owned 文件才能继续 | 目标文件、需要改什么、为什么只能改那里、建议的 owner |
| `DEPENDENCY REQUEST` | 需要新增/升级/移除依赖，或需要别的 Agent 先交付某接口 | 包名与版本、用途、替代方案、影响面 |
| `SUPERVISOR DECISION REQUIRED` | 需要在两个都合理的方案之间做取舍，或规则之间冲突 | 候选方案、各自代价、你的建议 |

上报后**等待答复**。在等待期间可以做不依赖该决定的工作，但不要先按自己的假设落地。

## 6. 任务结束必须交付工作报告

任务完成（或被阻塞）后，**必须**按 [`../AGENTS.md`](../AGENTS.md) 的
**Task Completion Report** 输出完整**中文**工作报告，包含其要求的全部 14 项（含末项 `Next Handoff`）。

- 缺任一必填项 = 任务不被接受，不得标记 DONE。
- `FAIL` 与"未验证"都是合法结论，只要如实报告；把红的说成绿的才是严重问题。
- 报告写给项目负责人看：先结论，再证据，最后风险。

## 7. 与其它 Agent 的协作方式

- 你产出的接口属于**公共面**时，先在 `docs/CONTRACTS.md`（或 A0 指定的位置）写清楚，
  再实现。契约先于实现。
- 你依赖别人的接口时，不要读别人的私有实现来"迁就"它；依赖应当只走公共面。
  发现必须触碰私有面才能对接，立即 `CONTRACT BLOCKER`。
- 集成永远由 A0 收口；你完成的是分支上的聚焦提交，不是合并。

---

## 8. 交接声明（Next Handoff）

A1–A7 的工作报告**必须**在最后追加一段结构化交接声明：

```text
## Next Handoff

Handoff Status:          AUTO_CONTINUE / OWNER_DECISION_REQUIRED / STOP
Recommended Next Agent:  <agent id 或 none>
Base:                    <branch> @ <sha>
Why:                     <一两句：现在解锁了什么>
Dependencies satisfied:  <下一棒可以依赖什么：已冻结契约 / 已合并 seam / 门禁全绿 …>
Copy-paste Prompt:       <可直接交给下一棒的完整任务文本>
```

- **正式跨 Agent 调度权属于 A0。** 你写的 `Recommended Next Agent` 是给 A0 的输入，不是"我已经
  派了活"；不要假设下一棒已经开始。
- 只有在 `agent-prompts/A0-supervisor.md` §8.1 的**七条**同时成立时才可写 `AUTO_CONTINUE`。
  不确定就写 `OWNER_DECISION_REQUIRED`，并**指名**需要决策的那一点。
- 你不能自行跨越的 Gate（即使门禁全绿）：merge 到 `main`、milestone CLOSED、删除 milestone tag、
  push 或创建 remote、改 milestone scope、推翻冻结架构。
