# A5 只读审计 —— P0-1 版本恢复的权限与状态一致性

- 角色：A5（Permission & State Consistency）
- Worktree：`D:\前端\react\项目\面试项目\Insighthub-wt-p0-1-a5`
- Branch：`agent/p0-1-a5-audit`，base `547ddb9`
- 模式：**只读审计**；未修改实现、未修改 `docs/`、未修改 web。本轮代码变更只有
  `apps/server/src/versions/restore.authz.test.ts`（新增）与本报告。
- 审计对象：`apps/server/src/app.ts`、`authz/authz.ts`、`rooms/registry.ts`、
  `persistence/{sqlite-store,document-versions}.ts`、`versions/restore.ts`、
  `apps/server/src/versions/restore.integration.test.ts`；契约
  `docs/agent-governance/P0-1-CONTRACTS.md`（C1–C5）+ `docs/DECISIONS.md` D-090。

---

## A. 结论总览

| # | 审计点 | 判定 | 一句话结论 |
| --- | --- | --- | --- |
| 1 | D-V1 仅 Owner；list 用 `canRead` | **PASS** | HTTP 恢复路由用 `authorizeDocument(...,'canManageMembers')`，仅 owner 命中；Editor/Viewer 403、无 membership/未知文档 404、无会话 401 `session_required`；list 用 `canRead`，Viewer 可列不可恢复。 |
| 2 | 撤权后用同一 op id 重试 | **PASS** | 授权判定在路由入口、**早于** body 与 `restoreVersion`（op-id 命中在服务层内部）；撤权后重试返回 403/404，响应体只有 `{error}`，0 行、不泄露原 `versionId`/`sequence`。**新增测试 1/2/3 覆盖。** |
| 3 | 同 op id 不同请求 / 不同文档 | **PASS** | 同 hash 返回原结果且 0 行（T3，含 store 重开）；不同 hash → 409 `operation_conflict`（T3、新增测试 4）；op 表按 `(document_id, operation_id)` 隔离，跨文档 op id 独立且读不到 A 的 versionId（T13）。 |
| 4 | body 严格性 | **PASS** | 仅允许 `{baseRevision: 非负安全整数, operationId: 8..128}`；未知字段/类型/负数/小数/超长/8 空格/数组 body 全部 400，且 0 行；顺序为 401 → 404/403 → 400（新增测试 5）。 |
| 5 | `yjs_state` / 列表泄露 | **PASS** | `selectVersions` 不查 `yjs_state`，summary 显式映射 6 字段；新增测试 6 断言响应中不存在任何一个版本 BLOB 的 hex/base64、不存在正文文本；`currentRevision` 仅为该文档正文修订号（整数）。 |
| 6 | 与 `authorizeDocument`/`canManageMembers` 一致性；第二条权限路径 | **PASS（附残余）** | 唯一规则表 `documentCapabilities`；HTTP 两个版本端点都走 `authorizeDocument`；WS 逐帧用同一 `can()`。**不存在第二条“规则”**；但 `DocumentVersionService` 内部不做授权，`actorId` 由 HTTP 传入、被信任（见 F2/G1）。 |

**实现缺陷：0 个。** 6 条审计点全部通过；发现的都是契约内的设计取舍/残余风险（F 节），没有需要改实现的缺陷。

---

## B. 方法与红/绿证明

1. 先读契约 C1–C5、D-090、以及实现与既有测试，逐条建立“哪一行代码保证该性质”。
2. 对未被既有套件覆盖的断言写最小测试（真实 HTTP + 真实 SQLite + 真实 `AuthzService`；
   直接写 `authz_document_membership` 表模拟撤权/降级，每次都用 `server.authz.roleFor()`
   回读，证明**运行中的**服务器确实看到了变更）。
3. 每条新增测试都先确认“会红”：对本 worktree 的**已跟踪实现文件**做一次性变异 → 只跑新测试
   → 观察到预期失败 → `git checkout -- <file>` 还原。变异不进入最终 diff（见 D 节）。

---

## C. 逐条审计证据

### C1 — D-V1 仅 Owner；Editor/Viewer 403；无 membership/未知文档 404；未登录 401 `session_required`；list 用 `canRead`

**实现证据**

- `apps/server/src/app.ts:737` — 恢复路由：`authz.authorizeDocument(documentId, user.userId, 'canManageMembers')`。
- `apps/server/src/app.ts:721-754` — 未会话 → 401 `session_required`；`not_found` → 404；`forbidden` → 403；`granted` 才继续。
- `apps/server/src/app.ts:824` — 列表路由：同一 `authorizeDocument(..., 'canRead')`。
- `packages/shared/src/permission.ts:41` — `canManageMembers: hasAtLeastRole(role,'owner')`，即只有 `owner`（`editor`/`commenter`/`viewer` 均 false）。
- `apps/server/src/authz/authz.ts:240` — 无 membership / 无 `canRead` / 未知文档统一 `not_found`（一个分支，三个状态不可分叉）；`authz.ts:247` — 具备 `canRead` 后 capability 不足才 `forbidden`。

**测试证据（既有，已运行绿）**

- `restore.integration.test.ts:866` `lets the Owner restore` → 200。
- `:884` `refuses an Editor with 403 and writes nothing` → 403 `{error:'forbidden'}`，0 行。
- `:905` `answers 404 for no membership and for an unknown document (non-disclosure)` → 两者都 404 `{error:'not_found'}`。
- `:934` `requires a session: 401 session_required, for restore and for the list` → restore 与 list 都是 401 `{error:'session_required'}`。
- `:952` `lets a viewer list versions but not restore (canRead vs Owner-only)` → list 200（且无 `state` 字段）、restore 403。
- `:981` `does not list versions of a document the caller cannot read` → 404。

**判定：PASS。** 新增测试 2 额外把“降级为 viewer 后 list 仍 200、restore 403”放进同一次撤权场景；变异 M4（list 改成 `canManageMembers`）使其变红，证明该断言确实锁住 `canRead`。

### C2 — 撤权后，用同一 operationId 重试必须 403/404，不能靠 op-id 命中绕过，且不泄露原 versionId/sequence

**实现证据（顺序即性质）**

- `app.ts:721` 解析会话 → `app.ts:737` 授权 → `app.ts:756-767` 解析/校验 body → `app.ts:769` 才调用 `versions.restoreVersion(...)`。
- op-id 命中发生在服务层内部：`rooms/registry.ts:796-805`（`findRestoreOperation` → hash 相同返回原结果）且 `sqlite-store.ts:468-481`（事务内再次查 op 表）。
- 因此**授权先于任何 op-id 读取**：撤权后无法命中 op 表，403/404 在进入服务层之前就已决定。
- 拒绝响应体是冻结的单字段：`app.ts:135-189` 的 `RESPONSE_BODIES`；404/403 分支不写任何版本字段。

**新增测试**

- 测试 1 `A5/P0-1 — retry after the Owner loses membership (D-V1, C3)`：Owner 先成功（200，`versionId`/`sequence=3`）→ 当 Owner 时同 op id 重试 **200 且逐字节等于原结果**（对照）→ `DELETE` membership 并回读 `roleFor===null` → 同 op id 重试 **404 `{error:'not_found'}`**；断言响应体 key 只有 `error`、不含 `versionId`/`sequence`/原 version id、行数不变、正文仍是第一次恢复的 `target`；同一会话 `GET /versions` 也 404。
- 测试 2：降级为 `viewer` → 同 op id 重试 **403 `{error:'forbidden'}`**，0 行；list 仍 200（`canRead`）。
- 测试 3：先发一次 `stale_revision`（409，**operation 表 0 行**）→ 降级 → 同 op id 重试 **403**，证明“失败的请求没有留下可命中的 op 行”。

**红/绿**：变异 M1（`app.ts:737` 的 `'canManageMembers'` → `'canRead'`）后测试 2、3 变红（分别拿到 200 重放 / 409），而测试 1 仍绿（无 membership 时 `canRead` 也为 false）——正是“能力位是唯一判据”的证明。变异 M2（`authz.ts:240` 把 `role===null` 改成 `forbidden`）后测试 1、5 变红（404 → 403），证明非泄露 404 被锁住。

### C3 — 同一 operationId 的不同请求

**实现证据**

- hash 输入显式列名：`versions/restore.ts:97-111`，覆盖 `documentId/versionId/baseRevision/actorId`；op id 本身不入 hash（它是 key）。
- `app.ts:777-782` 只用**已校验**字段 + 已解析的 `user.userId` 计算 `requestHash`，客户端无法提交 actor。
- 命中且 hash 相同 → 原结果（`registry.ts:800-805` / `sqlite-store.ts:479-484`）；不同 → `operation_conflict`（`registry.ts:801-803` / `sqlite-store.ts:472-477`），不返回原 `versionId`/`sequence`。
- 表唯一键 `(document_id, operation_id)`（C2 DDL）；store 查询/写入都带 `document_id`（`sqlite-store.ts:224-227, 468-470`）。

**测试证据**

- T3（`restore.integration.test.ts:535`）：同 op id 同请求重试（含 `baseRevision` 已过期、store 重开）→ 200 原结果、0 行；同 op id + `baseRevision+1` → 409 `operation_conflict`。
- T13（`:1052`）：同 op id 用在另一个文档 → 独立操作、各自 200；B 的列表不含 A 的 version；用 A 的 versionId 通过 B 恢复 → 404。
- 新增测试 4：同 op id、**不同 versionId**（同一文档、baseRevision 用当前值以隔离变量）→ 409 `operation_conflict`，响应体只有 `{error}`、不含第一次的 versionId、0 行；随后**新 op id** 恢复同一 version → 200（对照，证明不是 version 无效）。

**红/绿**：变异 M3（`registry.ts:801` 的 `!==` 改成 `===`，即“不同 hash 就重放”）→ 测试 4 变红（拿到 200 重放），同时测试 1 的“Owner 重放”对照也变红。

### C4 — 恢复请求 body 严格性（400 且 0 行）

**实现证据**

- `app.ts:643-671` `parseRestoreBody`：必须是对象、**恰好 2 个键**且为 `baseRevision`/`operationId`；`baseRevision` 必须 `typeof number && Number.isSafeInteger && >= 0`；`operationId` 必须 `string`、长度 8..128、`trim()` 后非空。
- 解析在授权之后（`app.ts:756-767`），解析失败统一 400 `{error:'invalid_request'}`；没有任何字段可用于提交 update/text/actor。
- 事务只接受 `documentId/versionId/baseRevision/operationId/requestHash/actorId`（`restore.ts:46-57`），actor 由会话解析，不接受 body。

**测试证据**

- T14（`restore.integration.test.ts:1107`）：`update`/`text`/`actorId` 未知字段、缺 `operationId`、短 `operationId`、负/小数/字符串 `baseRevision` → 全部 400 且 0 行；普通编辑不会变成 restore。
- 新增测试 5 扩展：131 字符 `operationId`、8 个空格的 `operationId`、`baseRevision = Number.MAX_SAFE_INTEGER+1`、`true`、`null`、额外 `documentId`/`versionId`、数组 body → 全部 400 `{error:'invalid_request'}`、0 行、正文不变。
- 同时锁定顺序：同一畸形 body → 无会话 **401 `session_required`**；无 membership（`demo-private-notes`）→ **404 `not_found`**；viewer → **403 `forbidden`**；只有 Owner 才得到 400。

**红/绿**：变异 M5（去掉“恰好 2 键”检查 + 把 128 上限放宽到 10000）→ 测试 5 变红（131 字符 body 被接受并执行）。

**说明（契约内取舍，不是缺陷）**：C4 的 400 行描述的是“已通过身份/授权”的请求；对 viewer/非成员，400 会让请求可被用来探测“body 是否合法”，因此 401→404/403→400 的顺序是更严格的选择，`app.ts:698-712` 也明确写了该顺序。报告把它记为 A0 可复核项（G2）。

### C5 — `yjs_state` 永不返回；无权限文档 404；`currentRevision` 是否泄露

**实现证据**

- `sqlite-store.ts:214-218`：`selectVersions` 的 SELECT 列表**不含** `yjs_state`；`sqlite-store.ts:894-907` `toDocumentVersionSummary` 只产出 `{id,sequence,title,authorId,createdAt,kind}`。
- `app.ts:843-847`：列表响应固定 `{versions, currentRevision}`；`currentRevision` 来自 `document_meta.content_revision`（正文修订号，`document-versions.ts:103-109`、`sqlite-store.ts:452-454`）。
- 无权限文档：`authz.ts:240` 的 `not_found` 分支先于任何 store 读取；T11 `:981` 与新增测试 1 的 list 404 都覆盖。

**新增测试 6**

- Owner 与 viewer 各取一次列表：200；顶层 key 恰为 `['currentRevision','versions']`；每个 version 的 key 恰为 6 个冻结字段；`currentRevision === documentContentRevision === versions[0].sequence`。
- 直接读库取出该文档**所有** `yjs_state` BLOB，断言响应文本不包含它们的 hex、也不包含 base64；不包含 `yjs_state`/`"state"`；不包含正文 `base-later`/`target`。

**红/绿**：变异 M6（列表响应加一个 `state` 字段）→ 测试 6 变红（顶层 key 断言失败）。

**判定**：`currentRevision` 只是一个整数正文修订号，属于“调用者本来就能读该文档”的元数据；不包含 version id、作者、正文或其它文档信息。**PASS。**

### C6 — 与 `authorizeDocument`/`canManageMembers` 的一致性；是否存在第二条权限判断路径

**一致性（PASS）**

- 规则只有一张表：`packages/shared/src/permission.ts:33-42`；`authz.ts:220-225` 的 `can()` 只做 `role → documentCapabilities[capability]`，没有第二套 role 比较。
- HTTP 版本端点两处都走 `authorizeDocument`（`app.ts:737`, `:824`），且能力位与 C4/D-V1 一致。
- WS 逐帧闸门 `registry.ts:1008-1052` 用同一 `authz.can(...)`（`canRead` 用于 join/SyncStep1/AWARENESS，`canEdit` 用于 SyncStep2/Update）；这是**第二个调用点**、逐帧重新判定（P2-5 要求），不是第二套规则。`releaseHydrationBacklog` 还会在 replay 前重新授权（`registry.ts:533-538`）。

**“第二条路径”核查（附残余）**

- 恢复只能在 `app.ts` 的 `mountVersionRoutes` 里被触发（全仓 `restoreVersion` 调用点只有 `app.ts:769`）。
- 但 `RoomRegistry.restoreVersion/listVersions/contentRevision` **自身不做授权**：`restore.ts:46-57` 明确写“after every HTTP-level check has passed”，`actorId` 由 HTTP 传入并被信任（`registry.ts:875` 直接写库）。今天不存在绕过 HTTP 的入口；若未来有进程内调用者（脚本、新传输层、调度器），它必须自己先做授权。**记为残余风险 F2，不是当前缺陷。**

---

## D. 新增测试（文件、名称、红/绿）

文件：`apps/server/src/versions/restore.authz.test.ts`（新增，未改既有测试）

| # | 测试名（describe / it） | 覆盖审计点 | 变异实验（红） |
| --- | --- | --- | --- |
| 1 | `A5/P0-1 — retry after the Owner loses membership (D-V1, C3)` / `answers 404 not_found, adds 0 rows and never replays the original result` | 2 | M2：`authz.ts:240` 非泄露分支改 forbidden → 红（404→403） |
| 2 | `A5/P0-1 — retry after the Owner is downgraded to viewer (D-V1)` / `answers 403 forbidden for restore, keeps the list readable via canRead, writes 0 rows` | 1、2、5 | M1：restore 能力位改 `canRead` → 红（403→200）；M4：list 改 `canManageMembers` → 红（list 403） |
| 3 | `A5/P0-1 — a refused attempt does not record the operation id` / `stale_revision leaves 0 operation rows; the same id is refused after a downgrade` | 2、3 | M1 → 红（403→409） |
| 4 | `A5/P0-1 — the same operationId with a different request is a conflict (C3)` / `refuses a different versionId with 409 operation_conflict and discloses nothing` | 3 | M3：`registry.ts:801` hash 比较反相 → 红（409→200） |
| 5 | `A5/P0-1 — strict restore body, and identity/authz are decided before the body` / `orders 401/404/403 before 400, and refuses every near-valid body with 0 rows` | 4、2 | M5：放宽 body 校验 → 红（400→200）；M1 → 红（viewer 得到 400 而非 403） |
| 6 | `A5/P0-1 — the version list exposes metadata only (no yjs_state, no body)` / `returns the same metadata to Owner and viewer, with currentRevision = content revision` | 5、1 | M4 → 红（viewer 403）；M6：响应加 `state` 字段 → 红（key 集合） |

**变异实验记录**（每次均：改实现 → 只跑本文件 → 观察 red → `git checkout -- <file>`）：

| 变异 | 文件:行 | 结果（新增测试） |
| --- | --- | --- |
| M1 `canManageMembers` → `canRead` | `app.ts:737` | `ok 1`；**not ok 2、3、5**；`# fail 3` |
| M2 `role===null` → `forbidden`（关闭非泄露分支） | `authz.ts:240` | **not ok 1、5**；`# fail 2` |
| M3 op hash 比较 `!==` → `===` | `registry.ts:801` | **not ok 1、4**；`# fail 2` |
| M4 list `canRead` → `canManageMembers` | `app.ts:824` | **not ok 2、6**；`# fail 2` |
| M5 去掉“恰好 2 键”+ 长度上限放宽 | `app.ts:648,664` | **not ok 5**；`# fail 1` |
| M6 列表响应增加 `state` 字段 | `app.ts:847` | **not ok 6**；`# fail 1` |

还原后 `git status --short` 只剩 `?? apps/server/src/versions/restore.authz.test.ts`；`git diff --stat` 为空（见 H）。

**单独运行新文件**：`6 tests / 6 pass / 0 fail`，`exit=0`（`tsx --test --test-concurrency=1 src/versions/restore.authz.test.ts`，约 1.5 s）。

---

## E. 命令与退出码（真实运行）

| 命令 | 观察结果 | 退出码 |
| --- | --- | --- |
| `pnpm typecheck`（worktree 根） | `packages/shared`、`apps/server`、`apps/web` 全部 `Done` | **0** |
| `pnpm test:server` | `# tests 555`、`# pass 555`、`# fail 0`、`# skipped 0`、`# todo 0`、`duration_ms 90738.8` | **0** |
| `pnpm test`（根，vitest + server） | vitest `Test Files 56 passed (56)`、`Tests 608 passed (608)`；server `# tests 555`、`# pass 555`、`# fail 0` | **0** |

基线说明：任务给出的基线是 549；本轮新增 6 个测试后为 **555**（549+6），与 `pnpm test:server` 输出一致。根 `pnpm test` 里的 vitest 部分（608）不包含 `apps/server/**`（`vitest.config.ts` 明确 exclude），所以服务器套件在根命令里以第二段 `555` 出现。

前置：worktree 原先没有 `node_modules`；用 `pnpm install --frozen-lockfile --offline` 安装（9.4 s，未改任何清单/lockfile），并 `pnpm --filter @insighthub/shared build`（exit 0）。

---

## F. 发现（缺陷 = 0；残余风险与契约观察）

**本轮没有发现需要改实现的缺陷。** 以下为实现/契约层面的残余项，均不构成本轮 FAIL：

- **F1（残余，中）请求入口授权 vs. 在途恢复**：授权在 HTTP 路由入口判定（`app.ts:737`），随后进入文档 FIFO 队列（`registry.ts:720-723`）。若一个 restore 已通过授权、仍在排队（hydration/前序 mutation 未完成）期间 Owner 被撤权，该次 restore 仍会提交；撤权只影响**后续请求**。这是常见的 request-time authorization 语义，且 D-V1 未规定“在途撤销”；新增测试覆盖的是审计点要求的“撤权后重试”。若要更强语义，需在 FIFO slot 内重新授权（会改变契约/测试面）。**建议 A0 明确接受当前语义**（G1）。
- **F2（残余，中）服务层不自我授权**：`RoomRegistry.restoreVersion` 信任 `RestoreVersionRequest.actorId`，不做 `canManageMembers` 复核；`listVersions/contentRevision` 也不做 `canRead`。当前唯一调用者是 `app.ts`（已授权），所以不是第二条路径；但它是“授权在 HTTP 层、服务层只执行”的信任边界。建议保持并写进架构说明，或未来引入 `Authorizer` 注入（G3）。
- **F3（契约观察，低）401 body 在 demo 模式不一致**：P0-1 两个端点固定 `session_required`（`app.ts:725`, `:814`），而 demo 模式其它端点用 `unauthenticated`（`app.ts:937-939`）。C4 明确要求 `session_required`，故本轮 PASS；但客户端若按统一 body 分支处理需要知道这一例外（G2）。
- **F4（契约观察，低）`operationId` 规范化**：只做 `trim()` 后的空检查，实际使用未 trim 的原串；长度按 UTF-16 code unit 计（emoji 算 2）。契约只写“8..128 chars”，无规范化要求；不构成安全问题（客户端自己生成、重试时同一个串）。建议 A0 确认是否需要 trim 存储（G5）。
- **F5（并发观察，低）`currentRevision` 与列表非同一快照**：`app.ts:843-846` 先 list 再读 revision，两个独立读；并发编辑时 `currentRevision` 可能大于 `versions[0].sequence`。它不是泄露，只是 UI 可能马上收到一次 409 并重新预览。若要求严格相等，应把两者放进同一次 store 读（G6）。
- **F6（契约内披露，信息）列表向 viewer 显示 `authorId`**：这是 C4 冻结的字段（`{id,sequence,title,authorId,createdAt,kind}`）；viewer 能看到版本作者 id。若 `authorId` 被视为敏感，需要改契约；本轮按 C4 判 PASS（G4）。
- **F7（范围说明）`restore_operation` 无清理调度**：C3 只“定义 30 天保留”，本批不实现清理；因此 op-id 幂等窗口实际是永久的。无安全影响（更长幂等窗口只会更保守），仅为存储增长/未来清理语义的提示。

---

## G. 给 A0 的裁决项

1. **G1（建议接受）**：确认“授权在请求入口判定，已入队的 restore 不因随后撤权而中止”是 P0-1 的语义；若要“在途复核”，需新契约 + 新测试（会碰 `registry.ts` 的 FIFO 顺序）。
2. **G2（建议确认）**：P0-1 端点 401 固定 `session_required`，与 demo 其它端点的 `unauthenticated` 不同 — 确认按 C4 保留该例外，并在 UI/客户端错误映射中登记。
3. **G3（建议保持现状并补文档）**：`DocumentVersionService` 不自我授权、`actorId` 由 HTTP 供给；确认“HTTP 是唯一授权入口”为架构约束（写入 `ARCHITECTURE`/契约说明），或安排后续注入授权检查。
4. **G4（建议确认）**：版本列表对 viewer 暴露 `authorId` 是否可接受（C4 明列，默认接受）。
5. **G5（不阻塞）**：`operationId` 是否要求 trim/按 Unicode code point 计长；当前行为（保留原串、UTF-16 计长）无安全影响，若冻结就写进 C4 的措辞。
6. **G6（不阻塞）**：`currentRevision` 是否必须与 `versions[0].sequence` 同一快照；当前是两次读，并发下可能不同（无泄露）。

---

## H. Git 状态

- 分支：`agent/p0-1-a5-audit`；base `547ddb9`；未提交（报告与测试均为工作区新增）。
- `git status --short`：`?? apps/server/src/versions/restore.authz.test.ts`、`?? A5-P0-1-RESTORE-AUTHZ-AUDIT.md`。
- 已跟踪文件 `git diff --stat`：空 —— 实现、`docs/`、web 均未改动；6 次变异均已还原（见 D）。

## I. 下一步（Handoff）

- **Handoff Status**：`OWNER_DECISION_REQUIRED`（G1–G6 为确认/裁决项；无实现缺陷，无需修复分支）。
- **Recommended Next Agent**：`A0`（A5 不自行调度）。
- **Base**：`agent/p0-1-a5-audit @ 547ddb9`（审计测试与报告在本工作区未提交）。
- **Why**：P0-1 恢复路径的权限/幂等/body/列表不泄露已逐条验证并通过；只待 A0 对 F1–F6 的语义取舍做记录，然后决定是否把 6 个测试并入 P0-1 门禁。
- **Dependencies satisfied**：真实 SQLite + 真实 HTTP + 真实 `AuthzService`；`pnpm typecheck` 0、`pnpm test:server` 555/555、根 `pnpm test`（vitest 608 + server 555）0。
- **Copy-paste Prompt**：见下方代码块。

```text
A0：接收 A5 P0-1 只读审计结果（worktree Insighthub-wt-p0-1-a5，branch agent/p0-1-a5-audit @ 547ddb9）。
1) 复核 apps/server/src/versions/restore.authz.test.ts 的 6 个测试与 A5-P0-1-RESTORE-AUTHZ-AUDIT.md；
2) 对 G1–G6 逐项裁决并记录到 docs/DECISIONS.md（尤其 G1 在途撤权、G3 服务层信任边界）；
3) 若无异议，将新增测试纳入 P0-1 门禁并决定提交方式（不修实现）；
4) 注意：A5 未修改任何实现/docs/web，工作区只有新增测试与报告。
```
