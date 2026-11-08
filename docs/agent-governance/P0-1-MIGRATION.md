# P0-1 迁移与回滚说明（schema v2 → v3）

- 实现：`apps/server/src/persistence/schema.ts`（迁移）、`sqlite-store.ts`（读写）
- 契约：`P0-1-CONTRACTS.md` C1–C3、`DECISIONS.md` D-090
- 状态：`IMPLEMENTED`（服务端）；**未部署**、`NOT VERIFIED`（生产）

## 1. v3 新增对象

| 对象 | 用途 |
| --- | --- |
| `document_version(id, document_id, sequence, title, author_id, created_at, yjs_state, kind)` | 自包含版本快照；`kind ∈ auto/manual/pre-restore/restored` |
| `document_version_doc_seq(document_id, sequence DESC)` | 版本列表分页 |
| `restore_operation(document_id, operation_id, request_hash, version_id, sequence, created_at)`，PK `(document_id, operation_id)` | op-id 幂等与结果重放 |
| `document_meta.content_revision` | 正文修订号；join 的 empty update 不递增 |

## 2. 迁移流程（单事务）

```text
BEGIN IMMEDIATE
  CREATE TABLE document_version ...
  CREATE INDEX document_version_doc_seq ...
  CREATE TABLE restore_operation ...
  ALTER TABLE document_meta ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0
  UPDATE document_meta
     SET content_revision = (SELECT MAX(MAX(seq), snapshot_seq) FROM ...)
  validate schema/rows/uniqueness
  PRAGMA user_version = 3
COMMIT
```

- 失败：整体回滚，`user_version` 保持 2，无半表；启动拒绝。**已知 R-1**：v3 建表/建索引的 DDL 失败发生在 `phase='restore'` 之前，当前可能报 `MEMBERSHIP_MIGRATION_FAILED` 而不是 `RESTORE_SCHEMA_MIGRATION_FAILED`；数据回滚不受影响，但运维诊断会指向错误的迁移。
- 幂等：已为 3 → `unchanged`；`> 3` → `DATA_SCHEMA_TOO_NEW`（旧二进制不写新库）。
- `content_revision` 初值取 `MAX(MAX(seq), snapshot_seq)`，与运行时 `#ensureMeta` 同口径。

## 3. 回滚

| 场景 | 操作 |
| --- | --- |
| 迁移失败 | 无需操作；事务已回滚，`user_version=2` |
| 迁移后要回旧二进制 | **不能直接回**：v3 库对 v2 二进制是 `DATA_SCHEMA_TOO_NEW`；需先恢复到 v2 备份文件，再启动旧二进制 |
| 数据错误 | 停服 → 用迁移前的备份（`VACUUM INTO`）替换 `insighthub.db` → 启动 v2 或重新迁移 |
| 新版本表写坏 | `document_version`/`restore_operation` 可删除重建，不影响正文；但会丢版本历史（正文仍在 update/snapshot） |

**部署前**：对生产库做一次备份并验证可打开；在副本上演练 2→3 与 v2 二进制拒绝 v3 的行为。

## 4. 运行语义

- 成功 restore 写 **4 行**：pre-restore 版本、restore update、restored 版本、operation；响应 `{versionId(restored), sequence(content revision)}`。
- 同 op id 重试：0 行，返回原结果；不同 request hash：409 `operation_conflict`。
- 失败：事务回滚 0 行；apply 已发生但 persist 失败 → 既有 unhealthy/1011、无 broadcast。
- 保留期：`restore_operation` 30 天（定义，清理未实现）；`pre-restore` 版本不受自动版本 30d/200 条清理影响（定义，清理未实现）。
- 自动版本：D-V2 10min 且正文变化；本批只留 `captureDocumentVersion` seam 与 kind，**调度器未实现**。

## 5. A0 对 A5 审计项的口径

| ID | 口径 |
| --- | --- |
| G1 在途撤权 | request-time authz；已入队 restore 在撤权后仍可能提交。V1 接受，记入限制；若要求 FIFO 内复核需改契约。 |
| G2 401 body | P0-1 路由固定 `session_required`（C4）；客户端按路由映射，不统一改。 |
| G3 服务层信任 | HTTP 是授权边界；`RoomRegistry` 不重复鉴权。保持，写入架构说明。 |
| G4 viewer 见 authorId | C4 冻结字段；接受。 |
| G5 operationId | 不 trim，8..128 UTF-16 code units；冻结。 |
| G6 currentRevision 与 list 非同一快照 | 接受；并发下 409 兜底。 |

## 6. 限制

- 文本级恢复（text diff），不恢复格式 marks/嵌入对象。
- Node/SQLite/HTTP/WS 证据；无浏览器、无生产、无 B12。
- 根 `pnpm test` 的 100k preview 测试已显式 20s timeout（断言本身 20s），非放宽产品断言。
- 跨进程并发：预检与事务之间若有其它写者，会 unhealthy/409/500；V1 单实例不触发。
