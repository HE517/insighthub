# 版本恢复实验 v2 — Unicode、并发、离线与撤销语义（P0 设计证据）

- 脚本：`tests/experiments/version-restore.mjs`
- 运行：`node tests/experiments/version-restore.mjs` → exit 0
- 规模：**33 项断言**，覆盖 5 个 Unicode 用例、冲突确认、离线同区间编辑、独立副本撤销、persist-first 失败/重试
- 范围：只使用 `yjs`；**没有** SQLite 表、版本 API、版本 UI、生产 Gate

## 1. 改前失败：旧 `restoreTo` 的 UTF-16 边界

旧实现按 UTF-16 code unit 求公共前后缀；emoji 的两个 code unit 中，高代理项相同、低代理项不同，于是“公共前缀”停在 emoji 中间，删除/插入拆开了代理对。

实测（保留在脚本的 `legacyFailures` 输出里）：

| 用例 | 目标 | 旧实现结果 |
| --- | --- | --- |
| `hello 😀` → `hello 😃` | `hello 😃` | `hello \uFFFD + lone low surrogate`（替换字符 + 孤立低代理） |
| `a😀b` → `a😃b` | `a😃b` | `a\uFFFD + lone low surrogate + b` |
| `中文😀English` → `中文😃English` | `中文😃English` | `中文\uFFFD + lone low surrogate + English` |

`😀` 单纯替换恰好落在一个完整代理对时可能“看起来对”，但只要前后有共同字符（`a…b`、`hello …`），旧实现就会破坏正文。这是**实验实现里的真实缺陷**；生产 restore 尚未实现，因此不是线上事故。

## 2. 修复：按 code point 计算边界

- 用 `[...string]` 取 code point 序列求公共前后缀；
- 再把 code-point 偏移转回 UTF-16 索引（`Y.Text` 的索引单位）；
- 断言发起端与**编码传输后的对端**逐字等于目标；
- 5 个用例全部 PASS：`😀→😃`、`a😀b→a😃b`、`😀→😀😀`、`😀😀→😀`、`中文😀English→中文😃English`。

**仍未覆盖**：ZWJ 组合 emoji（👨‍👩‍👧）、旗帜、肤色修饰符等 grapheme cluster。当前按 code point 已不破坏代理对；若产品要求 grapheme 级，需要 `Intl.Segmenter` 并重新定义“删除/插入”的边界，列为后续实验。

## 3. 预览 → 他人先写 → 确认恢复（推荐 V1 策略）

**场景**：用户预览版本 V 的差异（`baseRevision=R1`）；另一成员先写入（服务端 revision 变为 R2）；用户随后点“确认恢复”。

**推荐**：`baseRevision !== currentRevision` ⇒ **返回 409 conflict，拒绝恢复，要求重新预览**；不静默覆盖。

实验：
- 拒绝后正文保持 `alphaX`（并发编辑不丢）；
- 重新预览（R2）后确认，恢复应用，最终正文为目标 `beta`。
- 结论：预期正文在拒绝时是**当前正文**，在重新预览并确认后是**目标版本正文**；两端收敛。

这避免了“用户看的是旧 diff，确认的却是新状态”的错位。

## 4. 恢复 + 离线端在同一区间编辑后重连

**场景**：A 确认恢复到 `beta`；B 离线把 `alpha` 替换成 `ALPHA`；B 重连。

**结果**（实测，CRDT 决定，非字符串覆盖）：

- 最终正文 = **`betALPHA`**（观测值，不是断言值；A7 连跑 10 次稳定）；A/B 收敛，`converged = true`。
- 恢复被接受（确认时不知道离线编辑）；离线编辑的字符仍在，但与恢复文本按 CRDT 合并，可能交错。
- **产品语义**：不能承诺“恢复后正文等于版本原文”在存在离线并发时成立；必须在恢复结果提示“含并发/离线编辑”，或对同一区间做冲突检测（V1 不推荐自动拒绝离线编辑）。

预期正文因此写成：**无并发时 = 目标版本正文；有并发时 = CRDT 合并结果（本例 `betALPHA`），两端一致**。

## 5. 服务端恢复 vs 客户端 Undo

| 角色 | 能否 Undo 恢复 | 实验 |
| --- | --- | --- |
| 发起恢复的副本（若产品把 `restore` 放进 tracked origins） | 可以，Undo 回到 pre-restore；这是反事实实验，产品 V1 不采用 | `authorReplicaAfterUndo = "base"` |
| 收到恢复的其它副本 | **不能**：恢复是远端 update，不在其 Undo 栈（注：该测试在 apply 后才建 UndoManager，证明力有限，见 A7 P3-4） | `otherReplicaAfterUndo = "restored"` |
| 断开后重连的副本 | 不能通过 Undo 撤回；只能通过版本历史 | 设计结论 |

**产品建议（V1）**：
- **恢复是共享编辑，不是客户端 Undo 的一部分**：服务端恢复后，客户端 Undo 不撤回它；
- 想找回恢复前内容，走**版本历史**：恢复时自动生成 `pre-restore` 版本，入口“版本历史 → 查看/恢复”；
- 不把本实验的内存 Undo 当作客户端验收；客户端验收要等版本历史 UI。

## 6. persist-first 失败 / 重试

- 先在临时副本计算 restore update；
- 追加失败时线上正文保持 pre-restore（`persisted`），重试只应用一次（`restored`），追加尝试 2 次（1 失败 1 成功）。
- 这是设计建议，不是实现：真正的 SQLite 事务边界见 `P0-RESTORE-DECISIONS.md`。

## 7. 结论摘要

```json
{
  "checks": 33,
  "failed": 0,
  "legacyFailures": 3,
  "mergeResult": { "offlineBefore": "alpha", "mergedText": "betALPHA", "converged": true },
  "undo": { "otherReplicaAfterUndo": "restored", "authorReplicaAfterUndo": "base" }
}
```

未实现：版本表/迁移、版本 API、恢复 UI、生产验证；均等待 Owner 授权。
