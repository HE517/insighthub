# P0-1 服务端版本恢复 — A7 最终实现复核

- **审查角色：** A7（集成 / 架构审查），独立于 A0
- **审查对象：** 已合并的 P0-1 服务端版本恢复（schema v3 + FIFO restore + op-id + Owner-only + API）
- **Base：** `main @ 6c59667`（审查开始时工作树 clean；审查期间出现并发未提交 docs 变更，见 §0.2）
- **日期：** 2026-11-08
- **结论先说：** **GO WITH FIXES**
  - **功能实现：GO。** C1–C5 的运行时语义、C9 的测试进 gate、D-090 的六项裁决均已在真实 SQLite + 真实 HTTP + 真实 WebSocket 上复核；`pnpm typecheck` 0、根 `pnpm test` **608 vitest + 557 server**、实验 33/33，均在 `6c59667` 的代码/测试树上实际跑过。
  - **收口：GO WITH FIXES。** 8 项裁决里唯一的 FAIL 是**规范性接口文档没有更新**（`docs/CONTRACTS.md §12/§14`、`docs/ARCHITECTURE.md §7.3/§7.9/§7.10`，§1.7）；另有一个**迁移失败错误码归属**的小缺陷（§2.2 R-1）和两项**测试覆盖缺口**（1011 close code、no-op restore 的 HTTP 分支，§2.2 R-2/R-5）。它们都不影响数据正确性，也不要求改运行时行为。
  - **不建议 NO-GO：** 没有发现“恢复错文本 / 丢正文 / 双 apply / 泄露”级别的实现缺陷；没有发现“测试绿但实现未接线”。
  - **本报告只新增这一个文件。** 没有改代码、测试或其它 docs；没有合并/push；没有给出上线或部署保证。

---

## 0. 审查范围、基线与命令

### 0.1 被审输入

| 类别 | 文件 |
| --- | --- |
| 契约 | `docs/agent-governance/P0-1-CONTRACTS.md`（C1–C10）、`docs/DECISIONS.md` D-090（`docs/DECISIONS.md:3775-3792`） |
| 设计审查 | `docs/agent-governance/A7-restore-design-review.md`（§3.1 的 8 条实现验收、§4 T1–T14、§5 C1–C10） |
| 实现 | `apps/server/src/versions/{restore,text-diff}.ts`、`apps/server/src/persistence/{schema,sqlite-store,document-versions,types}.ts`、`apps/server/src/rooms/{registry,room}.ts`、`apps/server/src/app.ts`、`apps/server/src/ws.ts`、`apps/server/src/index.ts` |
| 测试 | `versions/{text-diff,restore.integration,restore.offline,restore.authz}.test.ts`、`persistence/{restore-store,schema-v3}.test.ts` |
| 证据 | `docs/agent-governance/A5-P0-1-restore-authz-audit.md`；A3/A6 报告为对话输入，本报告对 A6 的核对以合入的 `restore.offline.test.ts`（2 个用例）和 commit 为准 |

### 0.2 工作树状态（含审查期间的并发变更留痕）

- 审查开始时（`6c59667`）：`git status --porcelain` 为**空**。
- 审查过程中，工作树出现**非 A7 作者**的未提交变更：
  - ` M docs/TASKS.md`（新增 P0-1 IMPLEMENTED 段落）；
  - `?? docs/agent-governance/P0-1-MIGRATION.md`（迁移/回滚说明，2026-11-08 17:53:48 写入）。
- 本报告对这些文件**只作工作树上下文引用**，不把它们当作 `6c59667` 的已提交内容；A0 收口前必须 commit/pin（§2.1 M-2）。
- 本报告新增后，工作树预期为：上面两项 + `?? docs/agent-governance/A7-p0-1-implementation-review.md`。A7 没有修改任何已跟踪文件。

### 0.3 实际运行的命令与退出码

以下均为本轮在 `D:\前端\react\项目\面试项目\Insighthub` 的**实际运行**，不是引用旧输出：

| 命令 | 观察结果 | 退出码 |
| --- | --- | --- |
| `pnpm typecheck` | `packages/shared` / `apps/server` / `apps/web` 全部 `Done` | **0** |
| `pnpm test:server` | `# tests 557` / `# suites 177` / `# pass 557` / `# fail 0` / `# skipped 0` | **0** |
| `pnpm test` | vitest `Test Files 56 passed (56)`、`Tests 608 passed (608)`；随后 server `# tests 557` / `# pass 557` / `# fail 0` | **0** |
| `node tests/experiments/version-restore.mjs` | `checks: 33` / `failed: 0`；`mergedText = betALPHA`、`converged = true`；`undoOther = restored` | **0** |

- 运行时的**已跟踪代码/测试**与 `6c59667` 一致；工作树只有上述两个 docs 变化，不参与编译或测试。
- **没有运行 `pnpm build`**：它不在本任务的复核命令集内；`docs/TASKS.md`（未提交）声称 `build 0`，本报告不把它当作独立证据。
- **没有做变异实验**：任务要求只读，未改实现；A5 报告的 6 个变异（M1–M6）是 A5 的证据，本报告只复核其断言与方法，不重跑变异。

### 0.4 审查口径

- “PASS”必须同时满足：源码语义正确 + 有测试实际覆盖该语义 + 测试在本轮 gate 中绿。
- “PASS（附注）”表示实现正确，但测试证据少一条具体断言；该缺口列在 §2.2，不改变功能裁决。
- 行号以 `6c59667` 的工作树为准；涉及 `P0-1-MIGRATION.md` 的行号明确标注“未提交工作树”。

---

## 1. 逐条裁决（对应任务要求的 8 项）

### 1.1 第 1 项 — schema 2→3 迁移

**裁决：PASS。**

| 子项 | 结论 | 源码 / 测试证据 |
| --- | --- | --- |
| 版本号 3 | PASS | `schema.ts:97` `CURRENT_SCHEMA_VERSION = 3`；`schema.ts:246-256` 已是 3 → 校验对象后 `unchanged` |
| 三对象（两表 + 索引 + 列） | PASS | `schema.ts:616-646`（`document_version`、`document_version_doc_seq`、`restore_operation`）；`schema.ts:570-579` / `489-503`（`content_revision`）；`SCHEMA_TABLES:135-143`、`SCHEMA_INDEXES:146` |
| `content_revision` 初始化 | PASS | `schema.ts:489-500`：`MAX(MAX(document_update.seq), snapshot_seq)`；测试 `schema-v3.test.ts:137-179`（log 5 / snapshot 3 → 5）、`:181-200`（二次打开不重算）、`:202-227`（迁移后 capture 继承 5） |
| 单事务 | PASS | `schema.ts:272-294` 把 `createSchemaObjects` + 成员导入 + `migrateToSchema3` + `PRAGMA user_version` 全部包在 `runInTransaction`（`transaction.ts:17-31`） |
| 失败回滚 | PASS | 回滚测试 `schema-v3.test.ts:234-306`：`user_version` 保持 2、无 `restore_operation`、无 `document_meta.content_revision`、无新索引；错误码 `RESTORE_SCHEMA_MIGRATION_FAILED`（`schema.ts:300-306`） |
| 幂等 | PASS | `schema.ts:246-256`；测试 `schema-v3.test.ts:181-200` |
| `TOO_NEW` | PASS | `schema.ts:170-180`；测试 `schema-v3.test.ts:313-338`（3 可开、4 拒绝） |
| 回滚说明是否足够 | PASS（附注） | 代码内 `schema.ts:36-54`；本轮工作树新增 `P0-1-MIGRATION.md:31-44`（**未提交**）明确写出“不能直接回旧二进制；用迁移前备份”。附注见 §2.2 R-1（迁移失败错误码归属） |

**说明（不扣分）：** 回滚测试用“v2 库里预先存在一个 kind 非法的 `document_version`”触发 `assertVersionInvariants`，证明的是**v3 步骤失败后的整体回滚**，不是“磁盘写满导致 `ALTER TABLE` 失败”的注入。任务契约只要求“用 v2 数据库 + 迁移失败注入”，该测试满足；它确实在 `ALTER` 已执行后失败并断言列/表/索引全部回滚，强度足够。

### 1.2 第 2 项 — `appendRestore` 单事务

**裁决：PASS。**

| 子项 | 结论 | 源码 / 测试证据 |
| --- | --- | --- |
| 一个 SQLite 事务 | PASS | `sqlite-store.ts:456-552`，外层 `#transaction`（`:856-858`）→ `runInTransaction`（`transaction.ts:17-31`） |
| op-id lookup 先于 revision | PASS | `sqlite-store.ts:463-483` 在 `:491-495` 之前；服务层同样 `registry.ts:792-805` 先于 `:807-811` |
| revision 是 content revision | PASS | `#readContentRevision` 读 `document_meta.content_revision`（`sqlite-store.ts:789-793`）；`types.ts:49-65` 的 `contentChanged` 由 room 的 `Y.Text` delta 决定（`room.ts:502-520`），join 的 empty update 不推进（`sqlite-store.ts:363-368`） |
| 成功 4 行 | PASS | `sqlite-store.ts:503-542`：pre-restore 版本、restore update、restored 版本、operation；`restore-store.test.ts:229-306`；集成 `restore.integration.test.ts:534-633` |
| 重试 0 行 | PASS | `sqlite-store.ts:468-483` 命中且 hash 相同 → `replayed`；测试 `restore-store.test.ts:282-299`、`restore.integration.test.ts:563-575`（含 store 重开、stale `baseRevision`）、`:589-604` |
| 跨文档 op id 独立且不泄露 | PASS | 唯一键 `(document_id, operation_id)`（`schema.ts:636-646`）；查询/写入都带 `document_id`（`sqlite-store.ts:219-227`）；测试 T13 `restore.integration.test.ts:1051-1100`、store 半边 `restore-store.test.ts:587-654` |
| `sequence` 语义 | PASS | 响应/版本行/op 行取 `restoredRevision = currentRevision + 1`（`:519-527`）；日志序号 `logSequence` 单独返回（`:499`、`:544-549`）；`types.ts:114-135` 明确两个计数器不同 |
| 失败 0 行 | PASS | `appendRestore` 抛错由 `#guard('restore')` 包装（`:838-847`）；四个写点注入见 `restore-store.test.ts:475-580` 与 `restore.integration.test.ts:446-528` |

**两个实现观察（不构成本批 FAIL）：**

1. **无变化恢复仍写 1 条 0 字节 update 行**（`sqlite-store.ts:514` 无条件 `insertUpdate`）。这是契约行数表“成功 1 条 update”的字面实现；`hydrator.ts:98` 明确跳过 0 字节行，所以不会 poison hydrate。它不是缺陷，但契约没有说明“这条 update 可以是 0 字节”。
2. **极少数情况下 `stale` 会顺带提交 1 条 `document_meta`**：`appendRestore` 在 revision 比较（`:491-495`）之前调用 `#ensureMeta`（`:485-489`）；若文档有正文但缺 meta，`#ensureMeta` 会插入 meta 并把 `content_revision` 初始化到 log 位置，随后比较失败返回 `stale`——回调正常返回，事务提交。版本/update/operation 仍是 0 行（与 C3 的行数口径不冲突），但“stale 0 行”在“无 meta 的 legacy 文档”这一边缘不严格。生产创建路径先写 meta，常规不会触发；列为 §2.3 RES-6。

### 1.3 第 3 项 — FIFO slot / 失败语义 / lease

**裁决：PASS（附注：1011 close code 未被测试断言）。**

| 子项 | 结论 | 源码 / 测试证据 |
| --- | --- | --- |
| 整体在同一个 FIFO slot | PASS | `registry.ts:706-738`：`restoreVersion` → `runtime.queue.enqueue(() => #runRestore(...))`（`:723`）；`#runRestore` 内完成 hydrate 等待（`:778`）、op-id（`:796`）、revision（`:807`）、读版本（`:814`）、pre-restore 捕获（`:835`）、diff（`:840`）、apply（`:849-853`）、persist（`:865-876`）、broadcast（`:902-907`） |
| 无 persist-first | PASS | apply 在 `:849-859`，persist 在 `:862-881`；T1 在 `appendRestore` 前拦截，断言客户端 update 既不 apply 也不 persist、observer 无任何 frame（`restore.integration.test.ts:347-403`） |
| pre-restore 在 apply 之前 | PASS | `registry.ts:835` 在 `:849-853` 之前；T5 解码 pre-restore 行断言文本是 `base-later` 而非恢复后的 `target`（`restore.integration.test.ts:663-694`；store 半边 `restore-store.test.ts:268-273`） |
| 失败后 unhealthy / 无 broadcast | PASS | persist 抛错 → `#failRoomUnhealthy`（`registry.ts:877-881`）；实现 `:1254-1280`：标记 unhealthy、停 queue、向所有参与者发 `INTERNAL_ERROR`、`close(1011)`（`:1272-1276`）、销毁房间；T2 断言 500、0 行、observer 无 binary、`INTERNAL_ERROR`、socket 关闭、`hasRoom === false`、再次 join 能重建（`restore.integration.test.ts:446-496`） |
| 1011 close code 被断言 | **未验证（证据缺口）** | 源码 `registry.ts:1276` 明确 `close(1011, 'INTERNAL_ERROR')`，但测试 harness 的 `waitForClose()` 只等待 close 事件、不记录 code（`test-harness.ts:520-530`）；T2 只 `await observer.waitForClose()`（`restore.integration.test.ts:479`）。功能路径已执行，数值未被断言。 |
| lease / evict / 无人在线 | PASS | `restoreVersion` 在入队前 `leaseCount += 1`（`:720`），`finally` 释放（`:735-736`、`:931-937`）；`#destroyRoomIfEmpty` 在 `leaseCount > 0` 时推迟（`:1330-1349`）；T9 三例：无人在线恢复后房间被驱逐（`:639-712`）、最后一人离开后驱逐（`:714-748`）、恢复在途时驱逐被推迟（`:749-806`） |
| apply 失败不落盘、不误伤房间 | PASS | `room.applyServerUpdate` 只在 `acceptsMutations` 时返回 true（`room.ts:488-493`）；`#runRestore` 在 `:851-858` 分别处理 false（未 apply）与 throw（fail-stop） |

**说明：** `evictPending`（`registry.ts:189-191`）只被写、从未被读（`:934`、`:1339`）；驱逐实际由 `leaseCount` + `#releaseRestoreLease` 显式调用 `#destroyRoomIfEmpty` 驱动。它是无害的冗余状态，列为 §2.3 RES-8，不是缺陷。

### 1.4 第 4 项 — API 契约

**裁决：PASS。**

| 子项 | 结论 | 源码 / 测试证据 |
| --- | --- | --- |
| Owner-only（`canManageMembers`） | PASS | `app.ts:737`；能力表 `packages/shared/src/permission.ts:41`（`hasAtLeastRole(role,'owner')`）；T11 `restore.integration.test.ts:866-882`；A5 降级测试 `restore.authz.test.ts:324-371` |
| Editor 403 | PASS | `app.ts:745-747`；T11 `:884-903`（0 行、正文不变）；viewer 也 403（`:952-979`） |
| 无 membership 404 | PASS | `authz` 的 `not_found` 分支（`app.ts:742-744`）；T11 `:905-932`（真实存在的私有文档 + 未知文档，两者 body 相同） |
| 401 body `session_required` | PASS | `app.ts:725`（restore）、`:814`（list）；T11 `:934-950` 两路由都断言 |
| 409 两种 | PASS | `stale_revision` + `currentRevision`（`app.ts:791-794`）；`operation_conflict`（`:795-797`）；T3 冲突（`restore.integration.test.ts:577-587`）、T6 stale（`:850-854`）、A5 冲突测试（`restore.authz.test.ts:422-495`） |
| 400 严格 body | PASS | `parseRestoreBody`（`app.ts:643-671`）：恰好 2 键、`baseRevision` 非负安全整数、`operationId` 8..128 且非全空白；`app.ts:756-767` 统一 400；T14 `restore.integration.test.ts:1106-1166`、A5 扩展 `restore.authz.test.ts:501-587` |
| 401/404/403 先于 400 | PASS | 顺序 `app.ts:721-727` → `:737-754` → `:756-767`；A5 测试 `restore.authz.test.ts:501-587` 逐层验证 |
| GET versions 返回 `{versions,currentRevision}` | PASS | `app.ts:843-847`；T3 `:606-625`；A5 `restore.authz.test.ts:589-663`（顶层键恰为两个） |
| 无 `yjs_state` | PASS | `selectVersions` 不查 BLOB（`sqlite-store.ts:214-218`）；summary 只映射 6 字段（`:894-907`）；T11 `:962-966`；A5 还断言响应不含 BLOB 的 hex/base64、不含正文 |
| 响应 `versionId` = restored | PASS | `restoredVersionId` 是本次新插入的 `kind='restored'` 行（`sqlite-store.ts:523-533`），响应直接用它（`app.ts:787`）；T3 断言 `readDocumentVersion(kind)` 为 `restored`（`restore-store.test.ts:256-258`） |
| 响应 `sequence` = content revision | PASS | `restoredRevision`（`sqlite-store.ts:519-527`）；T3 断言 `sequence === 3` 且 `currentRevision === versions[0].sequence`（`restore.integration.test.ts:551-625`） |
| 成功响应在 broadcast 之后 | PASS | `registry.ts:900-907` 先 broadcast，`:909` return；HTTP 在 `app.ts:786-788` 之后才写响应 |
| 500 `restore_failed` | PASS | `app.ts:801-803`；T2 断言 500 且 body 恰为 `{error:'restore_failed'}` |
| 客户端不能提交 update/text/actor | PASS | `parseRestoreBody` 只接受两个键（`app.ts:648-649`）；`requestHash` 的 actor 来自 `user.userId`（`:777-782`）；T14 逐项 400，且普通编辑不产生版本/operation 行 |

**附注：** `GET /versions` 的 `canRead` 路径在 `app.ts:832-834` 有一个 403 分支；当前角色词表下 `canRead` 是最低能力，任何成员都有，因此该分支实际不可达。它不是缺陷（防御性分支），但契约/文档不应把它写成可达语义。

### 1.5 第 5 项 — Unicode helper

**裁决：PASS。**

| 子项 | 结论 | 源码 / 测试证据 |
| --- | --- | --- |
| code point 边界 | PASS | `text-diff.ts:54-81`：`Array.from` 求公共前后缀，再用 `from.slice(0,prefix).join('').length` 转回 UTF-16 索引；不会切代理对 |
| 生产路径确实使用该 helper | PASS | `restore.ts:159-166` 调用 `restoreTextDiff` / `applyTextEdits`；registry `:840` 调用 `computeRestoreUpdate` |
| grapheme known limitation 写明 | PASS | `text-diff.ts:24-33` 明确“边界是 code point，不是 grapheme；最终正文逐字正确” |
| 测试进 gate | PASS | `text-diff.test.ts:54-116`（5 个 code-point 用例 + 4 个 grapheme 用例 + 1 个真实 `Y.Text`）；属 `apps/server/src/**/*.test.ts`，在本轮 557 中实际执行 |
| 与实验脚本一致 | PASS | `node tests/experiments/version-restore.mjs` 33/33；但实验不在 gate，只作设计证据（C9） |

**说明：** 生产 helper 的测试是**重新实现**的 5 + 4 用例，不是把 `.mjs` 的 33 项搬进 gate；这符合 C9（“关键 restore 测试放 `apps/server/src/**/*.test.ts`”），也避免了实验脚本作为门禁。实验的 undo 证据仍只证明“远端副本没有历史所以 undo 不动”（apply 之后才创建 `UndoManager`），这是**设计证据**的旧 P3-4，不是生产断言；本批不要求修。

### 1.6 第 6 项 — 测试真实性与门禁

**裁决：PASS（附注见 §2.2 R-2、R-4、R-5）。**

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| T1–T14 是否真的覆盖 | PASS | T1 `restore.integration.test.ts:307-440`；T2 `:446-528`；T3/T4 `:534-633`；T5/T9/T10 `:639-807`；T6 `:813-859`；T11 `:865-997`；T12 `:1003-1045`；T13 `:1051-1100`；T14 `:1106-1166`；T7 `text-diff.test.ts:54-116`；T8 `restore.offline.test.ts:592-599` |
| A5 6 个 | PASS | `restore.authz.test.ts` 恰好 6 个 `it`：`:255`（撤权后重试）、`:324`（降级 viewer）、`:377`（失败不留 op 行）、`:422`（同 op id 不同请求）、`:501`（严格 body + 顺序）、`:589`（列表只暴露元数据） |
| A6 2 个 | PASS | `restore.offline.test.ts:592-599`，两序各一；断言收敛、正文含 `ALPHA`、durable 一致、重试 0 行（`:526-579`） |
| 608 + 557 是否在合并 SHA 跑过 | PASS | 本轮 `6c59667` 上实际运行：根 `pnpm test` → 608 vitest + 557 server，exit 0（§0.3）。已跟踪代码/测试与该 SHA 一致，工作树只有 docs 差异 |
| 是否存在“测试绿但实现未接线” | PASS（无发现） | 生产链：路由 → `versions.restoreVersion`（`app.ts:769`）→ `#runRestore`（`registry.ts:723`）→ `computeRestoreUpdate`（`:840`）→ `room.applyServerUpdate`（`:851`）→ `store.appendRestore`（`:865`）→ `broadcastUpdate`（`:906`）。`text-diff` 由 `restore.ts` 使用；`listVersions/contentRevision` 由 `app.ts:843-846` 使用。`captureDocumentVersion` 是 D-V2 的未来 seam，明确**不在本批生产调用**（`document-versions.ts:94-101`），不是“假测试” |
| 真实依赖 | PASS | 集成/A5/A6 测试用真实 `startTestServer`（真实 SQLite、真实 HTTP、真实 ws）；`test-harness.ts:234-258` 让 HTTP app 与 ws 共用**同一个** `RoomRegistry`；`index.ts:268-288` 生产同样共用，`ws.ts:220` 不再建第二个。store 测试用真实 `SqliteDocumentStore`，不是 mock |
| T2 的 1011 断言 | **附注（缺口）** | 见 §1.3：源码有 `close(1011)`，T2 只断言 close，不断言 code |
| T14 的客户端义务 | **附注（范围）** | T14 证明“服务端不接受客户端计算出的 restore body”，但无法证明“未来客户端不本地 optimistic apply”；后者是客户端/UI 批次义务，本批没有客户端代码（见 §2.2 R-4） |

**A5 变异证据说明：** A5 报告记录 M1–M6 六次变异均先红后还原（`A5-P0-1-restore-authz-audit.md:161-174`）。本轮按要求只读，**没有重跑变异**；本报告只确认其测试断言确实锁住了对应行为，不把 A5 的变异输出当作本轮的独立证据。

### 1.7 第 7 项 — 与冻结架构的差异

**裁决：FAIL（仅规范性文档；运行时实现 PASS）。**

**7a. 运行时 seam / registry / HTTP wiring / schema：PASS。**

| 面 | 结论 | 证据 |
| --- | --- | --- |
| store seam | PASS | `DocumentStore.appendRestore` + `findRestoreOperation`（`types.ts:93-197`、`sqlite-store.ts:456-568`）；`DocumentVersionStore` 作为独立读能力（`document-versions.ts:86-110`）；与 C1 的“单事务 restore”语义一致 |
| sequence 复用 | PASS | `#nextSequence = max(MAX(seq), snapshot_seq)+1`（`sqlite-store.ts:775-781`），与 `append` 共用 |
| registry | PASS | `RoomRegistry` 实现 `DocumentVersionService`（`registry.ts:237`、`:706-752`）；lease/evict 扩展（`:717-736`、`:1330-1349`） |
| room | PASS | `applyServerUpdate` 成为生产入口，注释从“nothing calls it”改为 P0-1 路径（`room.ts:476-493`）；origin 为 remote（`:515`），客户端 Undo 不跟踪该远端 update |
| HTTP wiring | PASS | `createApp` 注入 `versions`（`app.ts:229-236`、`:413-417`）；`index.ts:271-288` 先建 registry，再同时交给 app 与 `attachWebSocketServer`（`:328`）；`ws.ts:144-155` 接受外部 registry，`:220` 只在缺省时新建 |
| schema | PASS | v3 三对象 + `content_revision`；`CURRENT_SCHEMA_VERSION=3`（`schema.ts:97`）；迁移单事务（§1.1） |
| 未记录的运行时偏差 | 无阻断 | 两个实现观察见 §1.2；一个错误码归属见 §2.2 R-1；删除生命周期见 §2.2 R-3 / §4 OD-1 |

**7b. 规范性接口文档：FAIL。**

`docs/CONTRACTS.md` 是 AGENTS.md §2/§6 指定的跨边界接口文本，但 P0-1 的端点和 seam 没有写进去：

- `docs/CONTRACTS.md:719-730` 的 HTTP API 表**没有** `POST …/versions/:versionId/restore`，也没有 `GET …/versions`；`§12` 也没有 C4 的 400/401/403/404/409/500 语义。
- `docs/CONTRACTS.md:761-772` 的 `DocumentStore` 仍只有 5 个成员，没有 `appendRestore` / `findRestoreOperation` / `AppendOptions.contentChanged`；`§14.7:807-813` 仍是只讲 `append` 的序列原子性。
- `docs/ARCHITECTURE.md:396-421` 的 `DocumentStore` 草图仍是 5 方法；`:562-571` 的 `delete` 语义写着“durable **removed**”，但实现 `delete`（`sqlite-store.ts:570-581`）不删除 `document_version` / `restore_operation`；`:580` 还写着 schema “currently 1”（在 schema 2 时就已陈旧，现在是 3）。
- 这不是“没有记录”：D-090（`docs/DECISIONS.md:3775-3792`）和 `P0-1-CONTRACTS.md` 确实冻结了 C1–C10；但 AGENTS.md §6 要求规范性 seam 先写进 `docs/CONTRACTS.md`，A7 设计审查 §5 的 C1/C4/C5 也明确要求同步修订。**当前 `docs/CONTRACTS.md`/`docs/ARCHITECTURE.md` 仍会让 UI/客户端 agent 找不到这两个端点。**

**结论：** 不因文档缺失把运行时实现判 NO-GO；但 A7 不能对“冻结架构差异已记录”给 PASS。列为 §2.1 M-1（必须修，docs-only）。

### 1.8 第 8 项 — 残余

**裁决：PASS（全部为已声明/范围外/后续项；见 §2.3）。**

| 残余 | 状态 | 说明 |
| --- | --- | --- |
| D-V2 自动版本调度器 | 未实现，已声明 | `document-versions.ts:25-42`、`:94-101`；`P0-1-MIGRATION.md:52`（未提交）；TASKS 未提交段落 |
| retention（`pre-restore` 豁免、op 30 天、auto 30d/200） | 只定义，不实现 | `document-versions.ts:25-42`；C2/C3；没有清理任务 |
| UI / 浏览器 / 生产 / B12 | 不在本批 | 契约首页 `P0-1-CONTRACTS.md:7`；TASKS 未提交段落；本报告不提供这些证据 |
| 401 口径 | 已冻结例外 | restore/list 固定 `session_required`（`app.ts:725`、`:814`）；demo 其它端点用 `unauthenticated`（A5 F3、`P0-1-MIGRATION.md:59`） |
| A5 G1–G6 | 有 A0 口径，但**未提交** | `P0-1-MIGRATION.md:54-63`（未提交）给出 G1–G6 口径；G3 的“写入架构说明”尚未落地（正是 §1.7 的 ARCHITECTURE 缺口） |
| 多进程/多写者 | 明确不在 V1 | `P0-1-MIGRATION.md:70`（未提交）；单实例 FIFO 假设 |
| 格式 marks / 嵌入对象 | 文本级限制 | `P0-1-MIGRATION.md:67`；`text-diff` 只改纯文本 |

---

## 2. 必须修项、建议修、残余

### 2.1 必须修（收口前）

**M-1（docs-only，必须）— 把 P0-1 写进规范性接口文档。**

- `docs/CONTRACTS.md §12`：补两个端点、C4 的全部状态码/body、Owner-only、`{versions,currentRevision}`、无 `yjs_state`、成功响应在 broadcast 之后、op-id 重试语义。
- `docs/CONTRACTS.md §14.1/§14.7`：补 `appendRestore`、`findRestoreOperation`、`AppendOptions.contentChanged`；写明 `appendRestore` 的 4 行、op-id 先于 revision、restored 行的 sequence 是 content revision 而不是 log sequence。
- `docs/ARCHITECTURE.md §7.3`：接口草图补上述成员；`§7.9`：明确 `delete` 对 `document_version` / `restore_operation` 的语义（当前实现不删；要么改实现，要么改文本）；`§7.10`：schema “currently 1” → **3**。
- 建议同时在 `docs/DECISIONS.md` 或 `P0-1-CONTRACTS.md` 补一句：`AppendRestoreInput` 不含 `versionId`，因为 `versionId` 已进入 `requestHash`；`title` 是文档标题。这是对 C1 输入形状的唯一有意调整，应显式记录，避免下一位实现者以为漏了字段。
- **不做代码改动。** 这是 AGENTS.md §6 / A7 设计审查 §5 C1/C4/C5 的要求，不是 A7 的新增意见。

**M-2（process，必须）— commit/pin 工作树里未提交的迁移/回滚说明。**

- `docs/agent-governance/P0-1-MIGRATION.md` 当前是 `??`（未跟踪），`docs/TASKS.md` 是 ` M`（未提交）；本报告 §1.1/§1.8 对它们的引用都是**工作树上下文**。
- 如果它们是 P0-1 的交付物（它们是 A5 G1–G6 口径、迁移/回滚 runbook、D-V2/retention 范围的唯一文字记录），A0 必须在收口前 commit 并 pin；否则 `6c59667` 仍没有操作级的迁移/回滚说明，而 `TASKS` 的“IMPLEMENTED”状态也没有进入历史。
- 这不是 A7 能做的（任务禁止改其它 docs）。

### 2.2 建议修（不阻塞本批功能 GO）

**R-1（code，小，诊断正确性）— 迁移失败的错误码归属。**

- `schema.ts:270` 初始 `migrationState.phase = 'membership'`；`:276` 的 `createSchemaObjects` 在 phase 设为 `'restore'`（`:290`）**之前**创建 `document_version` / `restore_operation` / 索引（`:616-646`）。因此如果 v3 建表/建索引本身失败（磁盘满、只读、文件里有同名 view 等），catch（`:295-313`）会报 `MEMBERSHIP_MIGRATION_FAILED`，并让运维去查 `authz.db`。
- 这与 `schema.ts:265-269` 的注释（“a v3 failure must not be reported as a membership-migration failure”）和 `P0-1-MIGRATION.md:31`（失败码 `RESTORE_SCHEMA_MIGRATION_FAILED`）直接矛盾。
- 影响：**数据安全不受影响**（`runInTransaction` 已整体回滚，`user_version` 保持 2，启动拒绝）；受影响的是**运维诊断**。建议把 v3 表/索引的创建移入 `migrateToSchema3`（它已在 `'restore'` phase 内），或增加第三个 phase；并补一个“v3 DDL 失败”注入测试断言 `RESTORE_SCHEMA_MIGRATION_FAILED`。当前 `schema-v3.test.ts:234-306` 的注入发生在 `assertVersionInvariants`，覆盖不到这条路径。

**R-2（test，小）— 断言 1011 close code。**

- 源码 `registry.ts:1276` 发 `close(1011, 'INTERNAL_ERROR')`；T2 只等待 close（`restore.integration.test.ts:479`），harness 的 `waitForClose()` 不保存 code（`test-harness.ts:520-530`）。
- 建议给 `TestClient` 记录 `close` 事件的 `code`/`reason`，在 T2 断言 1011。它能把“unhealthy/1011”从源码事实升级为测试事实；不影响本批 GO。

**R-3（code/test，follow-up）— `store.delete` 与版本/op 行。**

- `sqlite-store.ts:570-581` 只删 `document_update`、`document`、`document_meta`；`document_version`（含完整 `yjs_state`）和 `restore_operation` 保留。`docs/ARCHITECTURE.md:568` 却把 `store.delete(id)` 写成“durable **removed**”。
- 当前没有生产删除路由（`app.ts` 没有 `DELETE /api/documents/:id`），`delete` 只在 `store.test.ts` 使用，所以不影响 P0-1 批次。它是**未来删除功能的前置**：一旦暴露删除，旧版本正文会残留、同 id 重建会看到旧版本；旧 `restore_operation` 行也会让同 id 重建后的同 op id 重放旧结果。列为 Owner 决策（§4 OD-1），不要求本批改代码。

**R-4（client，范围外）— 客户端义务。**
- C4 要求客户端持久化 `operationId` 直到收到响应；C8/D-UD1 要求客户端不 optimistic apply、恢复不进客户端 Undo。T14 只能证明服务端不接受客户端计算的 restore body；未来 UI 必须自己守住“不预应用 / 持久化 op id”。本批没有客户端代码，**verification 只到服务端边界**。

**R-5（test，小）— no-op restore 的 HTTP 分支未被覆盖。**
- store 半边有 `restore-store.test.ts:376-412`（目标文本已等于当前：`committed`、revision 不增、版本列表 3 条；注释说“still four rows”，但该测试没有逐步断言 update/operation 行数）；`#runRestore` 的 `restore.changed === false` 分支（跳过 apply `registry.ts:849`、跳过 broadcast `:902`、返回 200 且 `sequence === currentRevision`）没有集成/HTTP 测试。
- 建议补一例：选一个正文与当前相同的版本 → 200、`sequence === currentRevision`、2 条版本 + 1 条 0 字节 update + 1 条 operation、observer 无 binary、之后 join 仍 hydrate 出同一正文。
- 这是测试覆盖缺口，不是实现缺陷；目前只能靠读源码判断该分支安全。

### 2.3 不影响本批的残余（明确接受）

| ID | 残余 | 证据/口径 |
| --- | --- | --- |
| RES-1 | D-V2 自动版本调度器未实现 | `document-versions.ts:25-42`；`P0-1-MIGRATION.md:52`（未提交） |
| RES-2 | retention / 清理未实现 | 同上；C2/C3 只定义 |
| RES-3 | 版本历史 UI、并发提示、pre-restore 入口 | C6/C7；本批不含 UI |
| RES-4 | 浏览器 / 生产 / B12 证据 | 不在本批；不把 Node 证据当浏览器证据 |
| RES-5 | 无变化恢复写 0 字节 update 行 | `sqlite-store.ts:514`；`hydrator.ts:98` 跳过；安全但不写进契约 |
| RES-6 | `stale` 在“无 meta 的 legacy 文档”上可能提交 1 条 meta | `sqlite-store.ts:485-495`；版本/update/op 仍 0 行；常规生产路径不触发 |
| RES-7 | no-op 恢复的两条版本行 sequence 相同，列表 tie-break 为 `created_at DESC, id ASC`，不保证 restored 在 pre-restore 前 | `sqlite-store.ts:214-218`、`:505-533`；不影响数据/恢复正确性，UI 需注意排序 |
| RES-8 | `evictPending` 是只写不读的冗余字段 | `registry.ts:189-191`、`:934`、`:1339`；驱逐实际由 lease 驱动 |
| RES-9 | A5 G1–G6 的 A0 口径只在未提交的 `P0-1-MIGRATION.md:54-63`；G3 的“写入架构说明”仍缺 | 与 M-1/M-2 同一收口问题 |
| RES-10 | 实验 undo 证据是 apply 后建 `UndoManager` 的弱证据（旧 P3-4）；不在 gate | `tests/experiments/version-restore.mjs`；C9 明确实验只作设计证据 |
| RES-11 | 跨进程/多写者语义 | 单实例 FIFO；`P0-1-MIGRATION.md:70`（未提交） |
| RES-12 | 格式 marks / 嵌入对象不恢复 | `P0-1-MIGRATION.md:67`；文本级恢复的明确限制 |

---

## 3. 结论

**GO WITH FIXES。**

- **运行时实现：GO。** C1–C5 的每一条都能在源码中找到对应行，并至少由一个真实依赖的测试覆盖；C9 的 restore 测试全部在 `pnpm test` 的 557 服务器段执行；`6c59667` 上 gate 绿。
- **收口条件：** M-1（`docs/CONTRACTS.md` / `docs/ARCHITECTURE.md`）和 M-2（commit/pin `P0-1-MIGRATION.md` + `TASKS.md`）必须先做；R-1/R-2/R-5 可与文档修复同批，也可以在 P0-1 之后的维护批次做，但不建议让它们无限期挂着（R-1 会让运维在迁移失败时看错方向；R-2/R-5 会让两条已实现的行为继续缺少测试事实）。
- **不建议 NO-GO：** 没有发现数据正确性/权限/幂等/顺序的实现缺陷；没有发现测试与生产接线脱节。
- **不要把本报告读成上线许可：** 本报告没有浏览器、生产部署、B12、D-V2 调度器、retention 或 UI 证据；版本恢复目前是**服务端 + 迁移**的实现，且 `TASKS` 的“未部署”状态（未提交）应继续保持。

---

## 4. 对 Owner / A0 的决策请求

> 只列真正需要更高层决定的；其余是 A0/工程执行项。

**OD-1（Owner，数据治理）— `store.delete` 是否必须删除版本与 op 行？**

- 现状：`delete` 不删 `document_version` / `restore_operation`（`sqlite-store.ts:570-581`），而 ARCHITECTURE 的 `delete` 文本说“durable removed”（`ARCHITECTURE.md:568`）。
- 选项 A（推荐，未来删除功能前做）：`delete` 在同一事务里删除两表；补测试“删除后 list/read 返回空、同 id 重建不复活旧版本”。
- 选项 B：保持现状，明确记录“删除文档不删除版本历史；删除功能上线前必须处理”。本批没有删除路由，B 不阻塞 P0-1。
- 请 Owner 选择 A 或 B；A7 建议**至少选 B 并记录**，若近期会做删除则选 A。

**OD-2（A0/Owner，收口范围）— 文档修复是否是 P0-1 的关闭条件？**

- A7 建议**是**：M-1 的 `docs/CONTRACTS.md` / `ARCHITECTURE.md` 更新是 AGENTS.md §6 的硬要求，也是下一位客户端/UI agent 的输入；M-2 的 `P0-1-MIGRATION.md` + `TASKS.md` 是回滚说明和状态记录，必须进入历史。
- 如果 Owner 选择“文档拆到 UI 批次”，则需要一条 Decision 记录明确接受“规范性接口文档暂时缺失”，并指定负责人和截止点；A7 不建议这样做。

**不需要 Owner 决定的项（A0/工程即可）：** R-1 迁移错误码（小代码 + 测试）、R-2 1011 断言（测试增强）、R-3 删除清理（若 OD-1 选 A，则属于后续任务）、A5 G1/G2/G4/G5/G6 的既有口径（已在未提交迁移说明中，commit 即可）。

---

## 5. 证据索引（本报告引用的关键位置）

| 主题 | 位置 |
| --- | --- |
| schema v3 常量 / 迁移入口 | `apps/server/src/persistence/schema.ts:97`、`:239-317`、`:489-538`、`:545-647` |
| 迁移回滚测试 / 幂等 / TOO_NEW | `apps/server/src/persistence/schema-v3.test.ts:136-200`、`:234-306`、`:313-338` |
| `appendRestore` / op-id / 4 行 | `apps/server/src/persistence/sqlite-store.ts:456-568`、`:775-825` |
| `AppendRestoreInput` / 两个 sequence | `apps/server/src/persistence/types.ts:93-197` |
| 版本读能力 / retention 定义 | `apps/server/src/persistence/document-versions.ts:25-110` |
| restore 结果 / hash / staging clone | `apps/server/src/versions/restore.ts:66-171` |
| code-point diff / grapheme 限制 | `apps/server/src/versions/text-diff.ts:24-33`、`:54-113` |
| registry restore / lease / unhealthy | `apps/server/src/rooms/registry.ts:706-937`、`:1254-1280`、`:1330-1349` |
| room server-authored apply | `apps/server/src/rooms/room.ts:470-520` |
| HTTP 两路由 | `apps/server/src/app.ts:643-671`、`:714-849` |
| 生产 wiring | `apps/server/src/index.ts:268-288`、`:328`；`apps/server/src/ws.ts:144-155`、`:220`；`test-harness.ts:234-258` |
| T1–T14 | `versions/restore.integration.test.ts:307-1166`；`versions/text-diff.test.ts:54-116`；`versions/restore.offline.test.ts:592-599` |
| A5 6 个 | `versions/restore.authz.test.ts:255-663` |
| store 单事务 / 跨文档 | `persistence/restore-store.test.ts:229-654` |
| D-090 | `docs/DECISIONS.md:3775-3792` |
| 契约 C1–C10 | `docs/agent-governance/P0-1-CONTRACTS.md:11-154` |
| 规范性文档缺口 | `docs/CONTRACTS.md:719-730`、`:761-772`、`:807-813`；`docs/ARCHITECTURE.md:396-421`、`:562-571`、`:580` |
| 迁移/回滚说明（未提交工作树） | `docs/agent-governance/P0-1-MIGRATION.md:16-52` |
| A5 审计（已提交） | `docs/agent-governance/A5-P0-1-restore-authz-audit.md:19-230` |
