# P0-1 收口复审（`6c59667` 之后的修复与 G1/R-1/R-5/R-2 批次）

- **审查角色：** A7（集成 / 架构审查），独立于 A0
- **审查对象：** `main` 上 `6c59667..7c3fae4` 的增量：R-1 迁移错误码、R-3 delete 级联、G1 执行时复核、R-5 no-op restore、R-2 1011 断言，以及对应的规范性文档修订
- **Base / HEAD：** `main @ 7c3fae4`（`7c3fae450d8c15efdf7a46dd6e60b762e1db3102`）
- **日期：** 2026-11-08
- **结论先说：** **GO**
  - 本批 6 个复审面（M-1 / R-3 / R-1 / G1 / R-5+R-2 / 文档一致性）**全部 PASS**，全量门禁在 `7c3fae4` 上实跑通过：`pnpm typecheck` **0**、`pnpm test` **608 vitest + 565 server**、`pnpm build` **0**。
  - **没有必须修项。** 有 3 条 docs/注释级建议修（S-1、S-2、S-3）和 1 条测试增强建议（S-4），都不影响运行时行为，不阻塞本批登记。
  - **本批可以登记为 `IMPLEMENTED`（服务端）。** 登记文本必须保留“未部署 / 生产 NOT VERIFIED / 无浏览器与 B12 证据”的限定；本报告不是上线许可。
  - 本报告只新增这一个文件。没有改代码、测试或其它 docs；没有 merge/push；没有把 Node/SQLite/HTTP/WS 证据说成浏览器或生产证据。

---

## 0. 审查范围、基线与命令

### 0.1 被审提交与增量

本轮只审 `6c59667` 之后的收口增量，**不重复审 P0-1 首版全量**。范围：

| 提交 | 内容 |
| --- | --- |
| `b455b50` / `dace604` | A7 首轮修复：规范性文档、`delete` 级联、架构/迁移说明 |
| `25b0728` / `e0b9a1a` / `962a5da` | R-1：v3 DDL 移入 `migrateToSchema3`、失败码归属、同名 view 测试；G1 契约记录 |
| `35de421` / `7c3fae4` | G1：`#runRestore` 在 FIFO slot 内复核；4 条排队测试 |
| `69c1466` / `13dfc10` | R-5/R-2：no-op restore、同 op 重试、真实 1011 close 断言 |

被审文件（增量）：

- 实现：`apps/server/src/persistence/{schema,sqlite-store}.ts`、`apps/server/src/rooms/{registry,test-harness}.ts`、`apps/server/src/versions/restore.ts`、`apps/server/src/app.ts`
- 测试：`schema-v3.test.ts`、`restore-store.test.ts`、`restore.integration.test.ts`、`restore.recheck.test.ts`
- 文档：`docs/CONTRACTS.md`、`docs/ARCHITECTURE.md`、`docs/DECISIONS.md`、`docs/TASKS.md`、`docs/agent-governance/P0-1-MIGRATION.md`

`packages/shared/**`、根/子包 `package.json`、`pnpm-workspace.yaml` 在本区间**没有改动**；没有新增生产依赖。

### 0.2 工作树状态（含审查期间的并发变更留痕）

- 审查开始时（约 19:25）：`git status --porcelain` 为**空**，与任务给定的 clean base 一致。
- 审查执行门禁期间，工作树出现**非 A7 作者**的未提交变更：
  - ` M docs/TASKS.md`：把 P0-1 段落更新为“`7c3fae4`：608 + 565（全部 typecheck 0 / build 0）”。
- 本报告**没有**修改 `docs/TASKS.md`；上述内容只作为“工作树里已有人登记”的上下文，**不作为本报告的证据**。本报告的计数来自 §0.3 自己实跑的命令。
- 本报告新增后，工作树预期为：` M docs/TASKS.md`（非 A7）+ `?? docs/agent-governance/A7-p0-1-closeout-review.md`（本报告）。A0 收口时需要把两者一起 commit/pin，或明确 TASKS 的归属后再提交。

### 0.3 实际运行的命令与退出码

均在 `D:\前端\react\项目\面试项目\Insighthub`、`main @ 7c3fae4` 上**本轮实际运行**：

| 命令 | 观察结果 | 退出码 |
| --- | --- | --- |
| `pnpm typecheck` | `packages/shared`、`apps/server`、`apps/web` 全部 `Done` | **0** |
| `pnpm test` | vitest：`Test Files 56 passed (56)`、`Tests 608 passed (608)`；server：`# tests 565` / `# suites 181` / `# pass 565` / `# fail 0` / `# cancelled 0` / `# skipped 0` / `# todo 0`（server 段 `duration_ms 79654.7781`） | **0** |
| `pnpm build` | `packages/shared` / `apps/server` tsc 成功；`apps/web` `vite v7.3.7` 转换 505 modules、`built in 4.39s`；仅有 chunk > 500 kB 的提示性 warning | **0** |

`pnpm test` 输出中确认以下**新增测试确实执行并通过**（不是只编译）：

- `ok … G1 — the restore is re-checked inside the FIFO slot (D-090 §10)`，4 个子测试全部 `ok`
- `ok … R-5 — restore whose target text already is the current text`
- `ok … C3 — the same operation id retried and reused`
- `ok … attributes a v3 DDL failure to RESTORE_SCHEMA_MIGRATION_FAILED (R-1)`
- `ok … P0-1 store - delete lifecycle`

计数与增量吻合：首版 557 server tests + G1 4 + R-5 1 + C3 1 + R-1 1 + delete 1 = **565**。

### 0.4 审查口径

- **PASS** 必须同时满足：源码语义正确 + 有测试实际覆盖该语义 + 测试在本轮全量门禁中绿。
- 本报告只做**只读复核**，没有改实现、没有做变异实验、没有重跑 A5/A6 的独立证据；A5/A6 的报告仍以它们自己的提交为准。
- 没有运行浏览器套件、生产部署、B12、D-V2 调度器或 retention 清理；本报告不提供这些证据。

---

## 1. 逐项裁决

### 1.1 M-1 — 规范文档补 P0-1 端点 / seam / delete 级联 / schema 3

**裁决：PASS（附注：S-1/S-2/S-3，见 §2.2）。**

| 文档面 | 要求 | 现状 | 裁决 |
| --- | --- | --- | --- |
| `docs/CONTRACTS.md` §12 | `GET …/versions`、`POST …/restore` 两个端点 | `CONTRACTS.md:730-731` 已列端点、状态码与里程碑 | PASS |
| `docs/CONTRACTS.md` §12.1 | Owner-only、请求体、4 行、op-id 重试、409、FIFO/1011、G1 | `CONTRACTS.md:747-756` 已写；含 `{versions,currentRevision}`、无 `yjs_state`、`sequence = content revision`、FIFO/1011 与 G1 | PASS |
| `docs/CONTRACTS.md` §14.1 | `appendRestore` / `findRestoreOperation` | `CONTRACTS.md:784-785` 已写“4 行 / 重试 0 行 / op-id lookup before revision / 返回原 `{versionId, sequence, requestHash}`” | PASS |
| `docs/ARCHITECTURE.md` §7.3 | seam 草图补两个成员 | `ARCHITECTURE.md:410-421` 已补 `appendRestore` / `findRestoreOperation`，并用注释说明 `apply → persist → broadcast` | PASS |
| `docs/ARCHITECTURE.md` §7.3 / §7.9 | `delete` 对版本/operation 行的级联语义 | `ARCHITECTURE.md:441` 明确“Since P0-1 it also removes … `document_version` and `restore_operation` rows”；`§7.9:580` 的 `store.delete(id)` 仍是 `removed`，与实现一致 | PASS |
| `docs/ARCHITECTURE.md` §7.10 | schema 版本号 | `ARCHITECTURE.md:592` 已从 “currently 1” 改为 **3** | PASS |

**附注（不改变 PASS）：**

- 先前的 M-1 还提到 `AppendOptions.contentChanged` 与 `§14.7` 的 restore 语义；本批把 `appendRestore`/`findRestoreOperation` 写进了 §14.1，但**没有**把 `append(documentId, update, options?)` 和 `contentChanged` 写进 §14.1/§7.3 草图，也没有在 §14.7 里单列 “restored 行 sequence 是 content revision，不是 log sequence”。这些属于 **S-2**（docs 完整性），不是本批枚举项缺失，也不影响运行时/测试。
- `P0-1-CONTRACTS.md`（C1–C10）是首版冻结契约，未追加 G1；G1 由 D-090 §10 与 `CONTRACTS.md §12.1` 承载，语义没有冲突。见 §2.3。

### 1.2 R-3 — `delete()` 同事务删除 `document_version` / `restore_operation`

**裁决：PASS。**

| 子项 | 结论 | 源码 / 测试证据 |
| --- | --- | --- |
| 两个 DELETE 语句存在 | PASS | `sqlite-store.ts:108-110` 新增 `deleteVersions` / `deleteRestoreOperations`；`:178-180` 准备语句 |
| 同一事务 | PASS | `delete()` 在 `sqlite-store.ts:574-589` 的 `#transaction(...)` 内依次删 updates → versions → operations → document → meta；`#transaction` 是既有单事务原语 |
| 删除后版本/操作 0 行 | PASS | `restore-store.test.ts:656-683`：先 `appendRestore` 成功，再 `store.delete`，断言 `load === null` 且 `document_version` / `restore_operation` / `document_update` 的 `COUNT(*)` 全为 0 |
| 测试进 gate | PASS | `ok … P0-1 store - delete lifecycle` 在 565 中实际执行 |

- 测试用真实 `SqliteDocumentStore` + 真实 SQLite 文件，不用 mock；`delete` 的 idempotent 语义沿用既有 store 测试。
- 未覆盖“同 id 重建后旧版本不复活”的独立断言（见 S-4）。当前测试的 `counts = 0` + `load = null` 已能证明数据被真正删除，S-4 只是把意图写得更直白。

### 1.3 R-1 — v3 DDL 移入 `migrateToSchema3`，失败报 `RESTORE_SCHEMA_MIGRATION_FAILED`

**裁决：PASS。**

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| phase 状态存在，restore 前设置 | PASS | `schema.ts:270` 初始 `phase = 'membership'`；`:290` 在调用 `migrateToSchema3` 前设为 `'restore'`；`:291` 调用迁移 |
| v3 DDL 已在 restore phase 内 | PASS | `schema.ts:489-532` 的 `migrateToSchema3` 创建 `document_version`（`:492-503`）、索引（`:504-506`）、`restore_operation`（`:507-517`）；`createSchemaObjects` 已不再创建这三者（`:574-641` 只保留 schema-0/2 对象 + `content_revision` 列） |
| DDL 失败错误码 | PASS | catch 在 `schema.ts:295-314`；`phase === 'restore'` → `RESTORE_SCHEMA_MIGRATION_FAILED`（`:300-306`），否则 `MEMBERSHIP_MIGRATION_FAILED`（`:308-313`） |
| “同名 view”注入测试 | PASS | `schema-v3.test.ts:308-336`：v2 fixture 后 `CREATE VIEW document_version`，`openDocumentStore` 必须 reject 且 `code === 'RESTORE_SCHEMA_MIGRATION_FAILED'`；断言 `user_version` 仍为 2、view 仍存在 |
| 整体回滚 | PASS（组合证据） | 该 view 测试失败于 v3 第一条 DDL，故没有“半建表”可回滚；相邻的 `:234-306` 测试在 DDL 已执行、`assertVersionInvariants` 失败时断言 `restore_operation` 不存在、`document_meta.content_revision` 未加、索引未留、`user_version = 2`，这才是“整体回滚”的强断言 |
| 失败不升级版本 | PASS | 两个测试都断言 `readUserVersion(db) === 2` |

**说明（不扣分）：**

- view 测试证明的是“v3 阶段内的失败归到 restore 错误码”。它不区分错误究竟由 `CREATE TABLE` 抛出，还是由随后的 `assertVersionInvariants` 捕获；两者都在 `phase = 'restore'` 内，最终错误码一致，因此对 R-1 的诊断归属目标而言覆盖是充分的。
- `schema.ts:569-573` 的 `createSchemaObjects` 文档注释仍写着“the last two are the P0-1 version history …”，与迁移后的代码不符（DDL 已移走）。这是 **S-1**，纯注释，不影响行为。
- `schema-v3.test.ts:202-227` 仍覆盖“真实 store 打开后 capture 继承迁移后的 content revision”；`ensureSchema` 的幂等/TOO_NEW 测试未改动且仍绿。

### 1.4 G1 — 在 FIFO slot 内、hydration 后、op-id lookup 前、apply 前复核权限

**裁决：PASS。**

| 要求 | 证据 | 结论 |
| --- | --- | --- |
| HTTP 入口鉴权保留 | `app.ts:725-759`：先 `resolveAuthenticatedUser`（401），再 `authz.authorizeDocument(..., 'canManageMembers')`，映射 401/404/403；入口 check 在 body 解析之前 | PASS |
| 复核在 FIFO slot 内 | `registry.ts:723-724` 把 `#runRestore` 放进 `runtime.queue.enqueue`；`#runRestore` 整体（`:771-941`）都在该 task 内 | PASS |
| hydration 之后 | `#runRestore` 先 `await runtime.barrier`（`:779-780`），再检查 `room.destroyed/acceptsMutations`（`:781-783`），然后才复核（`:785-813`） | PASS |
| op-id lookup 之前 | 复核 `:797-813`；`store.findRestoreOperation` 在 `:823-836`；顺序正确 | PASS |
| apply 之前 | apply 在 `:880-890`；persist 在 `:893-912`；broadcast 在 `:931-940`；复核早于所有这些写点 | PASS |
| 复核由 HTTP 层注入，registry 不直接调用 authz | `restore.ts:45-97` 定义 `RestoreRecheckDecision` / `RestoreRecheck` 与必填的 `request.recheckAuthorization`；`app.ts:784-803` 构造闭包并复用 `authorizeDocument`；`registry.ts:797-813` 只调用 `request.recheckAuthorization()` | PASS |
| registry 无**新增** authz 反向依赖 | `#runRestore` 不 import/调用 `authz`；`registry.ts:64` 的 `type { AuthzService }` 是既有 WS join 鉴权 seam（A5），本批没有新增依赖。严格说 registry 仍有这个**既有**类型导入，但它不是 G1 路径，也不构成 G1 的新反向依赖 | PASS（附注） |
| 撤权 404 / 降级 403，body 不泄露 | `app.ts:835-842` 把 `forbidden` 映射为 403，与入口同 body；`restore.recheck.test.ts:292-302` 的 `expectRefusal` 断言 body 恰为 `{error}`、不含 `versionId`/`sequence`；404 在 `:495`、403 在 `:559`；重试用例还断言原 `firstVersionId` 不出现（`:639-644`） | PASS |
| 0 新行 | 测试 1/2 断言 versions/operations 不变，updates 只增加“占住 FIFO 的那次 append”（`:499-503`、`:561-565`）；测试 3 断言恰好 `versions:3, updates:4, operations:1`（`:648-652`）。**restore 自身 0 行**，那条 +1 update 属于排队占位 append，不是被拒 restore | PASS |
| 无 restore 广播 | 测试 1 断言 observer 只收到 1 个 binary frame 且 payload 等于占位 empty update（`:515-523`）；测试 2 只断言 1 个 frame（`:578-583`）；测试 3 只断言 1 个 frame（`:655-660`） | PASS |
| 同 op id 不 replay | `restore.recheck.test.ts:595-666`：先真实成功一次（200、3 versions/3 updates/1 op、text `target`），再让**同一 op id + 同一 body** 排队，撤权后得到 404，且行数变为 3/4/1、正文仍 `target`、无第二次广播 | PASS |
| 4 条测试**真的排到队列** | `runQueuedRestore`（`:386-462`）在 `:405` `holdAppends()` 卡住占位 append，`sender.sendBinary(syncStep2Frame(...))`，然后 `:431-434` 轮询 `server.handle.registry.mutationQueueDepth(DOC) === 2`，并断言 `responseSettled === false`（`:435-446`）；`mutationQueueDepth` 返回 `queue.pending`（`registry.ts:989-993`），`pending` 的语义是“running + waiting”（`serial-queue.ts:60-63`）。控制组（`:672-748`）在同样排队位置成功，证明该机制不是“请求根本没入队” | PASS |

**G1 测试清单：** `restore.recheck.test.ts` 恰好 4 个 `it`：`:469`（404）、`:535`（403）、`:595`（不 replay）、`:672`（控制组 200 + 4 行 + 广播）。本轮全量门禁中该 suite 4/4 `ok`。

**说明：** 复核只覆盖**成员关系**（`canManageMembers`），不重新解析 session；如果只有 session 被销毁而 membership 仍在，排队的 restore 仍会完成。这是 G1 范围（在途撤权）之外，列为 §2.3 残余，不是本批缺陷。

### 1.5 R-5 / R-2 — no-op restore、同 op 重试、真实 1011

**裁决：PASS。**

| 子项 | 结论 | 证据 |
| --- | --- | --- |
| no-op restore 返回 200 | PASS | `restore.integration.test.ts:1212-1304`（R-5），`:1246` 断言 200；fixture 的版本文本与当前文本相同（`:1220-1223`） |
| `sequence` 不前进 | PASS | `:1247-1251` 断言 `response.body.sequence === seeded.baseRevision`；`:1263` 断言 `documentContentRevision` 仍是 `revisionBefore` |
| 4 行、update 为空 | PASS | `:1253-1266` 断言 versions +2、updates +1、operations +1（合计 4 行），且 `:1262` 最新 update 字节长度为 **0** |
| 不广播 | PASS | `:1266-1272` 等待后 observer `binaryFrames().length === 0` |
| 版本行语义 | PASS | `:1276-1289` 列表恰 3 条（manual + pre-restore + restored），两条新行 `sequence === revisionBefore`，响应 `versionId` 是 restored 行 |
| 之后 join 仍 hydrate 同一正文 | PASS | `:1292-1304` 驱逐后重连，room 文本仍为 `same-body` |
| 同 op 重试 0 行 | PASS | C3 测试 `:1320-1417`：第一次 200 后 `afterFirst` 记录；重试带**已过期的** `baseRevision`，`:1369` 仍 200、`:1371` 行数不变 |
| 重试无第二次广播 | PASS | `:1373-1380` 等待后 observer frames 为 0 |
| 同 op 不同请求 409 | PASS | `:1390-1410` 两个变体（不同 `baseRevision` / 不同 versionId）均为 409 `operation_conflict`，0 行、0 广播 |
| T2 真实 WS 1011 + `INTERNAL_ERROR` | PASS | `restore.integration.test.ts:494-505`：`waitForError('INTERNAL_ERROR')` 后 `waitForClose()` 返回 `{code, reason}`，`:504-505` 断言 `code === 1011`、`reason === 'INTERNAL_ERROR'`；harness 在 `test-harness.ts:335-356` 记录 close code/reason，`:460-477` 暴露 `closeCode/closeReason`，`:565-578` 的 `waitForClose` 返回记录值（close 已发生也不会竞态） |

**说明：** R-5 的“不广播”是 250ms 窗口内的负断言；因为 restore 的响应在 apply/broadcast 决策之后才返回，测试先 `await response` 再 settle，故不是靠“等得不够久”通过的。C3 的重试同理。

### 1.6 文档一致性 — D-090 §10 / CONTRACTS §12.1 G1 / P0-1-MIGRATION R-1+G1

**裁决：PASS。**

| 文档 | 内容 | 与实现是否一致 |
| --- | --- | --- |
| `docs/DECISIONS.md` D-090 第 10 条（`:3793-3795`） | 保留 HTTP 入口鉴权；FIFO 内、apply 前再次确认当前 Owner（`canManageMembers`）；撤权返回既有非泄露 404/403；0 新行、无恢复广播；排队 restore 不得仅凭入队权限提交 | **一致**：`app.ts` 入口保留，`registry.ts:785-813` 复核，`app.ts:835-842` 映射 403，测试验证 404/403、0 行、无广播 |
| `docs/CONTRACTS.md` §12.1 G1（`:756`） | 在文档 FIFO slot 内、apply 前复核；撤权返回既有 403/404；0 行、无恢复广播；不得只凭入口权限提交 | **一致**。措辞说“before apply”是必要条件；实现更严格，复核在 op-id/read 之前，仍满足 |
| `docs/agent-governance/P0-1-MIGRATION.md` R-1（`:31`） | v3 建表/建索引移入 `migrateToSchema3`（`phase='restore'`）；DDL 失败报 `RESTORE_SCHEMA_MIGRATION_FAILED`；有“同名 view 注入”测试 | **一致**：代码与 `schema-v3.test.ts:308-336` 对得上 |
| `docs/agent-governance/P0-1-MIGRATION.md` G1（`:58`） | HTTP 入口鉴权后，文档 FIFO 内、apply 前再次确认当前 Owner；撤权 404/403、0 新行、无广播（D-090 修订） | **一致**；同样只写了“apply 前”，没有写“hydration 后 / op-id 前”的更强顺序，但与实现不矛盾 |
| `docs/TASKS.md` P0-1 段落（工作树未提交） | “`7c3fae4`：608 + 565（全部 typecheck 0 / build 0）” | 与本轮实跑一致；但这是**并发变更**，本报告不把它当独立证据（见 §0.2） |

**未要求但值得记录的差异：** `P0-1-CONTRACTS.md`（C1–C10，FROZEN）没有追加 G1；G1 由 D-090 §10 + `CONTRACTS.md §12.1` 承载。三处没有互相矛盾的表述，因此不判 FAIL；若 Owner 要求“冻结 C1–C10 必须自包含”，可另做一次 docs-only 修订（§2.3）。

### 1.7 门禁

**裁决：PASS。**

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm typecheck` | shared / server / web `Done` | 0 |
| `pnpm test` | 56 files / 608 vitest；181 suites / **565** server；fail 0、skipped 0 | 0 |
| `pnpm build` | shared + server tsc；web vite 505 modules / built 4.39s | 0 |

- 本轮没有跳过、没有 `only`、没有把新测试从 gate 里排除：5 个新增测试组都出现在 `pnpm test` 输出中（§0.3）。
- build 只有 chunk 体积 warning，不是失败；`dist/assets/index-f4Xdb4vS.js` 973.71 kB（gzip 318.65 kB），与 P0-1 无关，也不改变门禁结论。
- 没有运行浏览器、生产、B12；本报告不声称这些层已通过。

---

## 2. 必须修 / 建议修 / 残余

### 2.1 必须修（收口前）

**无。**

上一轮 A7 报告的 M-1（规范性文档缺失）、R-1（迁移错误码归属）、R-2（1011 断言）、R-3（delete 级联）、R-5（no-op 分支未覆盖）以及本批 G1 均已关闭，且都有本轮实跑的绿测试/门禁支撑。

### 2.2 建议修（不阻塞 `IMPLEMENTED`）

| ID | 类型 | 内容 | 建议 owner / 验证 |
| --- | --- | --- | --- |
| S-1 | 代码注释 | `schema.ts:569-573` 的 `createSchemaObjects` 注释仍说“the last two are the P0-1 version history and idempotency tables”，但这两张表已移到 `migrateToSchema3`。改成“schema-0/2 objects + `content_revision`；v3 表/索引在 `migrateToSchema3` 的 restore phase 创建” | A3/server；改后 `pnpm typecheck` 即可 |
| S-2 | docs 完整性 | `CONTRACTS.md §14.1` / `ARCHITECTURE.md §7.3` 草图仍只写 `append(documentId, update)`，没有 `options?: AppendOptions` 与 `contentChanged`；`§14.7` 也没有单列“restored 行的 sequence 是 content revision，不是 log sequence”。语义已在 D-090 #1 / `P0-1-CONTRACTS.md` C2 与代码注释里，但 seam 文本不完整 | A0（docs 批准）+ A3；只改文本 |
| S-3 | docs 完整性 | `CONTRACTS.md §12.1` 只写“成功 4 行”，没有写 **no-op restore** 的行为：200、4 行、update 0 字节、`sequence` 不前进、不广播。R-5 测试已经把它变成事实，建议补一句，避免下一位读者把“4 行”误解为“revision 必增” | A0 + A3；只改文本 |
| S-4 | 测试增强 | `restore-store.test.ts:656-683` 已断言删除后三表 0 行 + `load === null`；可再加“同 id 重建后 `listDocumentVersions` 为空、旧 op id 不 replay”的断言，使 R-3 的原始风险（同 id 复活旧版本）有直接测试 | A3；可在后续维护批次做 |

这些都不要求改运行时行为；S-2/S-3 是**文本**层面的完整性，S-1 是注释，S-4 是可选测试增强。

### 2.3 不影响本批的残余（明确接受）

| ID | 残余 | 口径 |
| --- | --- | --- |
| RES-1 | 没有浏览器 / 生产 / B12 证据 | 本批是服务端 + 迁移；Node/SQLite/HTTP/WS 证据不能当作浏览器或生产证据 |
| RES-2 | 版本历史 UI、并发提示、pre-restore 入口未实现 | P0-1 明确不含 UI；D-V2/retention 只定义未实现 |
| RES-3 | G1 只复核 membership，不复核 session 生命周期 | 入队后 session 被销毁但仍保留 Owner membership 时，排队 restore 仍可能完成；在途撤权（G1 目标）已覆盖 |
| RES-4 | 多进程/多写者语义 | V1 单实例 FIFO 假设；跨进程只保证 409/500/unhealthy，不保证并发恢复 |
| RES-5 | `P0-1-CONTRACTS.md` C1–C10 未追加 G1 | D-090 §10 + `CONTRACTS.md §12.1` 已是规范性文本；若要求冻结文档自包含，另做 docs-only 修订 |
| RES-6 | `docs/TASKS.md` 当前是未提交并发变更 | 不是 A7 写的；A0 收口时 commit/pin 或明确归属 |

---

## 3. 结论

**GO（本批收口复核通过）。**

- **M-1 / R-3 / R-1 / G1 / R-5+R-2 / 文档一致性：全部 PASS。** 每一项都有源码行和本轮实跑的测试/门禁支撑；没有发现“测试绿但实现未接线”“撤权后仍提交”“同 op 重放”“no-op 仍广播/推进 revision”这类缺陷。
- **没有必须修项。** S-1..S-4 是注释/docs/可选测试增强，不影响运行时正确性，也不改变本批 `IMPLEMENTED` 的登记结论。
- **可以登记为 `IMPLEMENTED`（服务端）。** 登记时必须保留：**未部署**、生产 `NOT VERIFIED`、无浏览器证据、无 B12；本报告不是上线/部署许可。
- **Base 仍是 `7c3fae4`。** 下一批从该 SHA 分支；`docs/TASKS.md` 与这份报告需要 A0 commit/pin 后才能成为历史。

---

## 4. Release Recommendation

1. **结论：** **建议放行本批收口（GO）**——服务端 P0-1 的 G1/R-1/R-5/R-2/R-3 与文档收口已成立；不表示生产可发布。
2. **阻塞项：** 无。
3. **非阻塞观察：** S-1（过期注释）、S-2（`AppendOptions.contentChanged`/`§14.7` docs 完整性）、S-3（no-op restore 契约句）、S-4（delete 同 id 重建测试）。建议 A0 在下一个 docs/维护批次处理，不要求本批返工。
4. **审查覆盖面（诚实边界）：** 实际看了 `6c59667..7c3fae4` 的源码/测试/文档 diff，跑了 `pnpm typecheck` / `pnpm test` / `pnpm build`；**没有**重跑 A5/A6 的独立审计、没有做变异实验、没有浏览器/生产/B12/D-V2/retention/UI 证据。

---

## 5. 任务完成报告（AGENTS.md §4 摘要）

- **Status：** `done`（复审完成）
- **Branch / Worktree / Commit：** `main` / `D:\前端\react\项目\面试项目\Insighthub` / `7c3fae4`（本报告未提交）
- **本轮目标：** 只复审 `6c59667` 之后的修复与 G1/R-1/R-5/R-2 批次，给出一份独立的收口结论。
- **完成了什么：** 逐项复核 M-1/R-3/R-1/G1/R-5/R-2/文档一致性；在 `7c3fae4` 上实跑三道门禁；确认本批可登记为服务端 `IMPLEMENTED`，并列出 4 条非阻塞建议。
- **Files Changed（A7）：** 仅新增 `docs/agent-governance/A7-p0-1-closeout-review.md`；未改代码/测试/其它 docs。
- **Tests / Validation：** 见 §0.3、§1.7；`pnpm typecheck` 0、`pnpm test` 608+565（0 fail/skip）、`pnpm build` 0。
- **Acceptance Criteria：** M-1 PASS、R-3 PASS、R-1 PASS、G1 PASS、R-5/R-2 PASS、文档一致性 PASS、门禁 PASS。
- **Known Risks：** 无浏览器/生产/B12；G1 只复核 membership；多进程语义不在 V1；S-1..S-4 未做。
- **Git 状态：** 审查开始 clean；审查中 `docs/TASKS.md` 出现非 A7 的未提交修改（内容为 608+565 登记）；本报告新增后预期 `M docs/TASKS.md` + `?? docs/agent-governance/A7-p0-1-closeout-review.md`。A7 未 commit、未 merge、未 push。

## Next Handoff

Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
main @ 7c3fae4

Why:
本批复审已 GO，没有必须修项；A0 需要决定是否把本报告与并发的 `docs/TASKS.md` 一起 commit/pin，以及 S-1..S-4 是并入本批 docs polish 还是留到维护批次。

Dependencies satisfied:
- `pnpm typecheck` / `pnpm test` / `pnpm build` 在 `7c3fae4` 全部 exit 0（608 vitest + 565 server）。
- G1/R-1/R-5/R-2/R-3/M-1（枚举项）均 PASS，证据在本报告 §1。
- 未新增生产依赖，未改 `packages/shared/**`。

Copy-paste Prompt:
复核并收口 `docs/agent-governance/A7-p0-1-closeout-review.md`：在 `main @ 7c3fae4` 上确认工作树，把该报告与当前 `docs/TASKS.md` 的 P0-1 登记一起 commit/pin；决定 S-1..S-4（docs/注释/测试增强）是否在本批或后续维护批次处理。不要把本报告当作部署、生产、浏览器或 B12 证据；不要 push。
