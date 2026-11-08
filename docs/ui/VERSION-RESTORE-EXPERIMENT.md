# 版本恢复最小可重复实验（P0 设计证据，不是实现）

- 脚本：`tests/experiments/version-restore.mjs`（只依赖 `yjs`）
- 运行：`node tests/experiments/version-restore.mjs` → exit 0，**15 项断言全部通过**
- 范围：验证“历史正文 → 新 Yjs 编辑”的语义、Undo、并发、离线重连、persist-first 失败边界
- **不包含**：SQLite 表/迁移、版本 API、版本列表 UI、生产部署

## 1. 从历史正文生成新编辑

1. 读取版本快照里的 `yjs_state`，在**临时 Y.Doc** 中还原历史正文；
2. 以当前正文为基准，求公共前后缀，得到“删除区间 + 插入文本”；
3. 在临时副本上应用，编码为 relative update（只包含差异，不替换整篇）；
4. **persist-first**：先写 `pre-restore` 版本，再追加 restore update，最后才应用到线上 room 并广播。

## 2. 已验证的语义

| 断言 | 结果 |
| --- | --- |
| 恢复后的目标正文 == 历史版本 | PASS |
| Undo 回到 pre-restore 正文 | PASS |
| Redo 重新应用恢复 | PASS |
| 他人并发追加在恢复后仍保留 | PASS |
| 两端恢复后收敛（文本相等） | PASS |
| 离线端编辑 + 恢复，重连后收敛 | PASS |
| 恢复只应用一次（文本不含重复） | PASS |
| 追加失败时线上正文不变 | PASS |
| 失败后重试只应用一次 | PASS |

## 3. 设计边界（未在实验中覆盖，需 P0 实现时补）

- **SQLite 事务**：`pre-restore` 与 restore update 的写入顺序与回滚；
- **快照保留**：自动版本 30 天/200 个上限、删除策略；
- **权限**：恢复 = `canEdit`（D-V1 待 Owner 决定是否 Owner only）；
- **UI**：版本列表、差异预览、恢复确认、并发提示；
- **服务端重放**：进程崩溃后从日志重放 restore update 的幂等；
- **真实网络**：多客户端断线时长、重连顺序、backlog 上限。

## 4. 失败/重试/离线/Undo 结论

- 失败：persist-first 让“追加失败”不改变线上正文；`pre-restore` 已写则保留，不影响重试。
- 重试：restore update 幂等；重复追加/重放不会产生第二次文本变化。
- 离线：重连通过 state-vector 补差；离线编辑与 restore 合并，恢复只出现一次。
- Undo：restore 是 `origin='restore'` 的单事务；Undo 只撤恢复本身，保留期间并发编辑。
- 并发：恢复不删历史、不做数据库回滚；确认后发生的区间外编辑保留，UI 需提示。

## 5. 运行输出（摘要）

```json
{ "checks": 15, "failed": 0 }
```

完整输出由脚本打印；本文件只保留可复述结论。P0 的数据库迁移与生产 Gate **未随本轮启动**。
