# P0-1 服务端版本恢复 — 契约冻结（C1–C10）

- 状态：**FROZEN**（A0 批准；A7 复核 GO WITH FIXES 后修订）
- 基线：`main @ 6364605`
- Owner 裁决（D-090）：D-RC1 正文修订号 + 409；D-RW1 **A**；D-OP1 独立操作表；
  D-V1 仅 Owner；D-V2 10min 且正文有变化；D-UD1 pre-restore 历史找回、恢复不进 Undo。
- 本批实现：服务端路径 + 迁移；**不含** UI、B12、生产 Gate。

---

## C1. Store seam（单事务 restore）

新增 `DocumentStore.appendRestore(...)`（命名可在实现中调整，语义固定）：

```ts
appendRestore(input: {
  documentId: string;
  operationId: string;
  requestHash: string;          // hash(baseRevision, versionId, actor, documentId)
  expectedRevision: number;     // content revision captured at preview
  versionId: string;            // selected historical version
  authorId: string;             // restore initiator (Owner)
  preRestoreState: Uint8Array;  // snapshot BEFORE apply
  restoreUpdate: Uint8Array;    // relative update computed against current text
  restoredState: Uint8Array;    // state AFTER apply (for the new version row)
  now: number;
}): Promise<{ versionId: string; sequence: number } | { conflict: number } | { replayed: {versionId,sequence} }>
```

- **一个 SQLite 事务**完成：读 meta → op-id 命中先返回 → revision 比较 → 写 `pre-restore` 版本 →
  追加 restore update（sequence = `max(MAX(seq), snapshot_seq)+1`）→ 更新 `document_meta` →
  写 `restored` 版本 → 写 `restore_operation`。
- 不能嵌套 `store.append`（其自带 `BEGIN IMMEDIATE`）；由新方法内部复用分配逻辑。
- 失败：整个事务回滚（0 行），错误向上抛；调用方走既有 unhealthy/1011 语义。

## C2. Schema v3（migration 2 → 3）

```sql
CREATE TABLE document_version (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,          -- 版本捕获时的正文修订号
  title TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  yjs_state BLOB NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','manual','pre-restore','restored'))
);
CREATE INDEX document_version_doc_seq ON document_version(document_id, sequence DESC);

CREATE TABLE restore_operation (
  document_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  version_id TEXT NOT NULL,           -- 响应里的 restored version id
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, operation_id)
);

ALTER TABLE document_meta ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
```

- 迁移单事务，`PRAGMA user_version = 3`；失败回滚，`DATA_SCHEMA_TOO_NEW` 逻辑保持。
- `content_revision`：只在**正文变化**时递增；join 的 empty update 不算。首次迁移时用当前
  `document_meta.revision` 初始化，避免 0 与历史不一致。
- `pre-restore` 版本保留期不受自动版本 30d/200 条清理影响（实现清理时豁免）。

## C3. operation 记录

- 唯一键 `(document_id, operation_id)`；`request_hash` 防“同一 op id 不同请求”。
- 命中且 hash 相同 → 返回原 `{versionId, sequence}`，**0 新行**；
- 命中但 hash 不同 → `409` 或 `400 operation_id_conflict`（实现选 409 `operation_conflict`，不泄露原结果）。
- 保留期 **30 天**（> 最大重试窗口）；清理任务不得早于 30 天；本批只定义，不做调度器。

## C4. API

### POST `/api/documents/:id/versions/:versionId/restore`

请求：`{ "baseRevision": number, "operationId": "8..128 chars" }`

| 状态 | body | 说明 |
| --- | --- | --- |
| 200 | `{ "versionId": string, "sequence": number }` | `versionId` = **恢复后新产生的版本行**（restored），不是所选历史版本 |
| 400 | `{ "error": "invalid_request" }` | body/schema/长度/未知字段 |
| 401 | `{ "error": "session_required" }` | 无会话 |
| 403 | `{ "error": "forbidden" }` | 有 membership 但不是 Owner |
| 404 | `{ "error": "not_found" }` | 文档/版本不可见、无 membership（非泄露） |
| 409 | `{ "error": "stale_revision", "currentRevision": number }` | baseRevision 不是当前正文修订号；重新预览 |
| 409 | `{ "error": "operation_conflict" }` | 同 op id、不同请求 |
| 500 | `{ "error": "restore_failed" }` | 事务/内部失败；不广播 |

- 成功响应在 **broadcast 之后**返回；客户端必须持久化 operationId 直到收到响应。
- 同一 op id 重试（含 `baseRevision` 已过期）返回原结果（op-id lookup 先于 revision）。

### GET `/api/documents/:id/versions`（本批可只做 store；若做 HTTP）

- 权限 `canRead`；返回 `{versions:[{id, sequence, title, authorId, createdAt, kind}]}`，按 sequence desc；
- 不返回 `yjs_state`；不泄露无权限文档（404）。

## C5. 顺序约束

服务端发起的 durable mutation 也走同一 FIFO pipeline：
`runtime.queue.enqueue(documentId, task)` → `apply → persist → broadcast`；**不得**新增
persist-first 路径（D-RW1=A）。整个 restore（读版本、diff、pre-restore 捕获、apply、persist、
broadcast）必须在**同一 task** 内。

## C6. UI-ROADMAP

A/B 定义、Undo 表述、33 项断言已提交/pin（`6364605`）；UI 不在本批。

## C7. 产品文案（后续 UI）

- “恢复已应用；当前正文含并发/离线编辑，可能不等于所选版本原文。”
- 提供 `pre-restore` 版本入口；不要用 revision 差编造“N 条并发编辑”。

## C8. 命名

文档版本 restore 与备份 `restoreBackup` / `backup-cli restore` 区分：API/日志/UI 用
`version restore` / `restore version`；备份恢复只用 `backup restore`。

## C9. 测试进 gate

关键 restore 测试放 `apps/server/src/**/*.test.ts`，由 `pnpm test` 执行；`tests/experiments/**`
只是设计证据，不作为验收门禁。T1–T14 见 A7 报告 §4。

## C10. Decision 记录

D-090（本文件与 `docs/DECISIONS.md`）正式记录：A 的 store seam、version 表、operation 表、
content_revision、Owner-only、409、pre-restore 豁免、恢复不进 Undo。

---

## 迁移/回滚

- 迁移 2→3：`BEGIN IMMEDIATE` 建表/加列/初始化 content_revision → `PRAGMA user_version=3` → COMMIT。
- 回滚：任何失败整体回滚，`user_version` 保持 2；旧二进制遇到 3 会 `DATA_SCHEMA_TOO_NEW`（只读/拒绝），不会写坏。
- 回滚演练：测试用 v2 数据库 + 迁移失败注入，断言 `user_version=2`、无半表。

## 行数定义（一次成功 / 重试）

| 操作 | document_version | document_update | restore_operation | 合计新行 |
| --- | --- | --- | --- | --- |
| 成功一次 | 2（pre-restore + restored） | 1 | 1 | **4** |
| 同 op id 重试 | 0 | 0 | 0 | **0**（返回原结果） |
| 事务内失败 | 0 | 0 | 0 | **0** |
| 提交前崩溃 | 0 | 0 | 0 | **0** |
| 提交后崩溃/响应丢失 | 2 | 1 | 1 | **4**（重试 0） |
