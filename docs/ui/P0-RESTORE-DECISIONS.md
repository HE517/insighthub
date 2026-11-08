# P0 版本恢复 — 决策单 v2（A0 提交，A7 已复核，Owner 裁决）

- 输入：`tests/experiments/version-restore.mjs`（33 项断言，exit 0）、`docs/ui/VERSION-RESTORE-EXPERIMENT.md`
- 复核：`docs/agent-governance/A7-restore-design-review.md`（A7：**GO WITH FIXES**；A 现文 NO-GO，B NO-GO）
- 范围：设计 + 实验；**未启动** SQLite 迁移、版本 API、恢复 UI、生产 Gate
- 关联：`docs/ui/UI-ROADMAP.md` §1、D-V1/V2

---

## 0. 结论先说

| 项 | 结论 |
| --- | --- |
| 选项 A（沿用 FIFO） | **方向可行；现文不能进入实现**。先满足 A7 §3.1 的 8 条前置 + §4 测试 + §5 契约，修订版经 A0 复核后可 GO。 |
| 选项 B（persist-first） | **A7 建议否决**；若 Owner 坚持，必须先有改 `CONTRACTS §14` 的 Decision 记录 + poison-pill 测试 + version sequence 重定义。 |
| 产品语义（恢复不可客户端 Undo） | 成立；恢复前内容通过 `pre-restore` 版本找回。 |
| Unicode | code point 修复足够；grapheme cluster 不阻塞（A7 Q5）。 |

---

## 1. 产品语义：服务端恢复 vs 客户端 Undo

| 动作 | 谁可见 | 是否可被客户端 Undo | 找回恢复前内容的入口 |
| --- | --- | --- | --- |
| 服务端恢复（版本回填） | 所有协作者（共享编辑） | **否**（V1 不把 `restore` 放进 `UNDO_TRACKED_ORIGINS`） | 版本历史里的 `pre-restore` 版本 |
| 本地输入 / AI Accept | 所有协作者 | 是（按 origin） | Undo / Redo |
| 他人编辑 | 所有协作者 | 否 | 版本历史 |

- 恢复是共享编辑，不是客户端 Undo；内存 Undo 实验只说明 CRDT 语义，**不作为客户端验收**。
- A7 Q4：与 R13 一致；不要新增 `restore` origin，也不要把恢复放进 tracked origins。
- 入口：文档头部“版本历史” → 列表 → 查看差异 → 恢复；恢复后提示“已从版本 X 恢复；期间并发/离线编辑已合并”。

---

## 2. 确认时的并发（D-RC1）

- 预览时记录 **content revision**（不是 log sequence；join 的 empty update 不计，见 A7 P1-6）；
- 确认时在 **per-document FIFO slot 内**比较 revision；不等 ⇒ `409 conflict`，不写入；
- 客户端重新拉取差异、再次确认；
- 确认之后才到的编辑按 CRDT 合并，不需要 409，由产品提示。

**实验**：拒绝后正文保持 `alphaX`；重新预览确认后为目标 `beta`。

---

## 3. 写入顺序：两种设计（A3 + A7 复核）

### 3.1 选项 A（推荐）：沿用 room FIFO，整个 restore 在一个 slot 内

现有冻结顺序（`registry.ts:804-806`，D-044/D-048）：`apply → persist → broadcast`，按文档串行。

```
HTTP POST /documents/:id/restore
  → registry 把 restore 任务 enqueue 到该文档的 FIFO slot
  → 在 slot 内:
      1. 读取版本 yjs_state；clone 当前正文，计算 text diff → restore update（current staging clone，不是 version state-vector 差分）
      2. 捕获 pre-restore（当前正文/state、lastSequence）  ← 必须在 apply 之前
      3. apply(server-authored update) 到 room
      4. 单个 SQLite 事务：insert pre-restore version + append restore log + insert operationId
      5. broadcast
  → 返回 { versionId, sequence }
```

- **P1-1**：整段在同一个 `runtime.queue.enqueue` task 内；`RoomRegistry` 提供 restore 入口；`DocumentRoom` 提供 server-authored update 路径。
- **P1-2/P1-5**：新增 `DocumentStore` 单事务方法（不能嵌套 `store.append` 的 `BEGIN`）；需要 `CONTRACTS §14.1/§14.7`、`ARCHITECTURE §7.3` 修订 + Decision 记录。**“与冻结架构差异：无”不成立**：运行时顺序不变，但 store seam / registry / room / HTTP wiring / schema 都要扩展。
- **P1-3**：pre-restore 在 apply 前捕获；其 sequence 取 slot 内 `lastSequence`。
- **P1-4**：定义 room lease / 无人在线 / evict 时序；`createApp` 注入 registry 或 restore service。
- **P1-10**：op-id lookup **先于** revision 校验；op-id 行存 `{versionId, sequence}`；唯一键 `(document_id, operation_id)`。
- **P1-11**：**禁止客户端 optimistic apply**；否则失败后 SyncSyncStep2 会把本地 restore 当普通 update 重传，绕过 pre-restore/op-id。

### 3.2 选项 B：persist-first（A7 建议否决）

- 顺序改为 persist → apply → broadcast，偏离 `CONTRACTS §14.3`；
- 需要 Decision 记录、poison-pill 测试、version sequence 重定义；
- A7：“持久化失败不改房间”的优点很窄，代价是契约改写 + poison pill 风险，**建议否决**。

### 3.3 记录数表（A + op-id 幂等）

| 情况 | pre-restore 行 | restore log 行 | op-id 行 | 说明 |
| --- | --- | --- | --- | --- |
| 成功 | 1 | 1 | 1 | 恢复自身产生的新版本计入 version 行（A7 P2-2 待明确“恢复版本”是否另计） |
| 事务内 append 失败 | 0 | 0 | 0 | 单事务回滚；room 已 apply，走 unhealthy/1011；重试 |
| 成功但响应丢失 | 1 | 1 | 1 | 重试同 op-id → 命中，返回原结果，0 新行 |
| 提交后、响应前重启 | 1 | 1 | 1 | 持久层已有；重试命中 |
| 提交前重启 | 0 | 0 | 0 | 假设期间无其它 append；重试创建 1/1/1 |
| 相同请求重试 N 次 | 1 | 1 | 1 | 幂等 |
| evict 与 restore 竞争 | — | — | — | slot 持有 lease；evict 必须 drain/等待，不能中途销毁 |
| 并发 restore 同一文档 | — | — | — | FIFO 串行；第二个按 revision/op-id 处理 |
| 客户端 optimistic apply | 0 | 0 | 0 | **禁止**，否则 SyncStep2 重传会绕过 |
| compaction 后 | 1 | 1 | 1 | pre-restore 的 yjs_state 独立于 log compaction；不被自动版本 30d/200 清理 |

- op-id 表：唯一键 `(document_id, operation_id)`；存 original result、request hash；保留期 > 最大重试窗口；客户端 op-id 需持久化（刷新/重启后重用）。
- pre-restore 版本的 retention 不能套用自动版本 30d/200 条（P2-4）。
- 命名：文档版本 restore vs 备份 `restoreBackup`/`restore-cli`，API/文档必须区分（P2-7）。

---

## 4. 失败、重试、离线与 Undo

| 场景 | 预期 |
| --- | --- |
| pre-restore/事务失败 | 事务回滚；room 已 apply 时走 unhealthy/1011；不广播；重试 |
| 提交成功、响应丢失 | op-id 命中返回原结果；不重复写 |
| 进程重启 | 提交前 0 行；提交后 1/1/1；重放收敛 |
| 离线客户端重连 | SyncStep 补差；离线编辑与恢复按 CRDT 合并（实验 `betALPHA`），UI 必须提示“含并发/离线编辑” |
| Undo | 客户端 Undo 不撤回恢复；找回走 `pre-restore` 版本历史 |
| 恢复后再恢复 | 每次生成新的 pre-restore；历史保留 |

---

## 5. 需要 Owner 裁决（A7 立场）

| ID | 问题 | A0 建议 | A7 立场 |
| --- | --- | --- | --- |
| D-RC1 | 确认时 revision 变化 | 拒绝 + 重新预览 | 同意；revision 必须是 content revision，check 在 queue 内 |
| D-RW1 | 写入顺序 | A | A；B 需 Owner 决策 + Decision 记录，A7 否决 B |
| D-OP1 | operationId 存放 | 独立表 | 独立表；唯一键 `(document_id, operation_id)`，存 result/hash，保留期 > 重试窗口 |
| D-V1 | 谁可恢复 | Owner+Editor | Owner+Editor（`canEdit`）；Owner-only 可复用 `canManageMembers` |
| D-V2 | 自动版本粒度 | 10min | 可以；pre-restore 不受自动清理影响 |
| D-UD1 | 恢复是否可 Undo | 否 | 否；不要加进 `UNDO_TRACKED_ORIGINS` |

---

## 6. A7 复核结论（原文摘要）

- 结论：**GO WITH FIXES**。
- Q1/Q2/Q3 **FAIL**（顺序、事务、revision/op-id/optimistic apply）；Q4/Q5/Q6 **PASS**（附措辞/证据修正）。
- 选项 A：**现文 NO-GO**；满足 §3.1 的 8 条前置 + §4 的 T1–T14 + §5 的 C1–C10 后，修订版经 A0 复核可 GO。
- 选项 B：**NO-GO**（A7 建议否决）。
- 必须 commit/pin 审查期间并发修正的 `UI-ROADMAP`（A/B 定义、Undo 表述、33 项断言），否则回退。
- 完整清单见 `docs/agent-governance/A7-restore-design-review.md`。

## 7. 未实现 / 未验证

- SQLite 版本表/迁移、版本 API、恢复 UI、生产 Gate：`NOT IMPLEMENTED`。
- restore 的 SQLite/HTTP/WS/browser 集成：`NOT VERIFIED`。
- 实现前必须先补齐 A7 的 9 项 P1 与测试 T1–T14；B 在任何情况下都需 Owner 明确选择。
