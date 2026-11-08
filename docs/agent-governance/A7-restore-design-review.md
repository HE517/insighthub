# P0 版本恢复设计审查（A7）

- **审查角色：** A7（架构 / 集成审查），独立于 A0
- **审查对象：** 选项 A（沿用 room FIFO）/ 选项 B（persist-first）的 P0 设计，以及 33 项 Yjs 实验
- **Base：** `main @ 1681193`（`merge(ui): UI-2 closeout - creation race fix + evidence (81/81)`），**工作树 dirty**
- **日期：** 2026-11-08
- **结论先说：** **GO WITH FIXES**
  - **审查基线是决策单 v1**（`30A580C3DE30869D`）。审查过程中 A0 已把决策单改为 **v2**（`58ACF2772E097652`），文本上吸收了 9 项 P1（映射见 §0.5）。**对 v2 的文本裁决是 GO；对实现仍是 NO-GO，直到 §4 的 T1–T14 与 §5 的 C1–C10 落地。**
  - **A：v1 不能按现文进入实现**；v2 已把 FIFO slot、pre-restore 时点、content revision、staging clone、op-id 顺序、optimistic apply 禁止写入文本；仍需 store 单事务方法 / HTTP wiring / lease / schema / 测试 / 契约（§3.1）。
  - **B：OWNER_DECISION_REQUIRED**；A7 **建议否决 B**。若 Owner 选 B，必须先有一条改 `CONTRACTS §14` 的 Decision 记录，并重定义 version 的 sequence 语义。
  - **另：** UI-ROADMAP 的 A/B 标签与 Undo 表述已在审查期间被并发修正（当前工作树，未提交）；必须 commit/pin，否则会回退（§2.4）。
  - **六问（针对 v1）：** Q1 **FAIL** / Q2 **FAIL** / Q3 **FAIL** / Q4 **PASS（附 1 项已解决冲突 + 1 项证据强度问题）** / Q5 **PASS（附证据措辞修正）** / Q6 **PASS（附证据措辞修正 + 强制产品提示）**；v2 对 Q1/Q3 的文本修正见 §0.5。

> 本报告只写审查结论。没有修改 `docs/ui/*`、生产代码、测试或其它文档；唯一新增文件就是本报告。

---

## 0. 审查范围与基线

### 0.1 被审文件（工作树，非 commit）

| 文件 | 状态 | SHA-256 前 16 位 |
| --- | --- | --- |
| `docs/ui/P0-RESTORE-DECISIONS.md` | 未跟踪（`??`）；**审查基线 v1 = `30A580C3DE30869D`；当前 v2 = `58ACF2772E097652`** | 见左 |
| `docs/ui/VERSION-RESTORE-EXPERIMENT.md` | 已修改（`M`） | `B0AB08ED87850024` |
| `tests/experiments/version-restore.mjs` | 已修改（`M`） | `A983EBB3D1C39313` |
| `docs/TASKS.md` | 已修改（`M`） | `0552E54362854A5C` |
| `docs/ui/UI-ROADMAP.md` | 已修改（`M`，**审查期间被并发修改**） | `D2B756F1F7BC18D7` |
| `apps/server/src/rooms/registry.ts`（冻结） | 未改 | `3A9EBEE4C4E00DE1` |
| `apps/server/src/rooms/room.ts`（冻结） | 未改 | `507F41A5D5BE044C` |
| `apps/server/src/persistence/sqlite-store.ts` | 未改 | `7B20EE22910F9DF2` |
| `apps/server/src/persistence/types.ts` | 未改 | `B0D6D756FBEACC98` |
| `apps/server/src/persistence/transaction.ts` | 未改 | `307ED1350736C0A0` |

**审计含义：** 决策单是未跟踪文件，实验文档与脚本是未提交修改。本报告的结论只对上述字节负责。**在进入实现前，A0 必须先 commit 或在任务单里 pin 上述设计/文档文件的哈希**，否则“审的是哪一版设计”无法复核。

**并发修改留痕：** 审查开始时 `docs/ui/UI-ROADMAP.md` 还是 committed 版本（无 `M`），其中“选项 A”写的是 persist-first、`:54` 写 UndoManager 跟踪 restore、`:56` 写 15 项断言。审查过程中该文件被另一个 agent 改为当前工作树版本（`M`，hash `D2B756F1F7BC18D7`），A/B 定义已与决策单对齐、Undo 改为“不让客户端 Undo”、断言数改为 33。**本报告以最终工作树为准**；§2.4 记录这两项“审查期间已解决、但尚未提交”的问题，防止它们随未提交改动丢失后重新出现。

### 0.2 我实际跑过的命令

| 命令 | 结果 |
| --- | --- |
| `node tests/experiments/version-restore.mjs` | `checks: 33` / `failed: 0`，**exit 0** |
| 同一命令连跑 10 次（解析 JSON） | 10/10：`merged=betALPHA`、`converged=true`、`undoOther=restored`、`undoAuthor=base` |
| `node --experimental-sqlite` 嵌套 `BEGIN IMMEDIATE` 探针 | 输出 `cannot start a transaction within a transaction` |
| code-point restore 的 grapheme 探针（family / flag / skin tone，4 例） | 4/4 输出**逐字等于目标**（见 §8.3） |
| `git status` / `git log` / `Get-FileHash` | 见 §0.1；HEAD `1681193` |

### 0.3 没跑的，以及为什么

- **没有跑 `pnpm typecheck` / `pnpm test` / `pnpm build`。** 本轮没有代码变更；被审功能（版本表、版本 API、恢复 UI、SQLite 事务）**没有实现**。设计通过不等于门禁通过——本报告不提供门禁证据。
- **没有跑 SQLite / HTTP / WS / browser 的 restore 集成。** 功能不存在；所有实现层结论都标 `NOT VERIFIED`（§7）。
- **没有独立复现“join 会 append empty update”**。我引用的是 `docs/ARCHITECTURE.md:423-427` 与 `apps/server/src/persistence/acceptance.test.ts:556-558` 的既有记载；这是文档/测试注释证据，不是我本轮的运行证据（明确标出）。

### 0.4 与冻结约束的对照口径

- 写入顺序与失败语义：`CONTRACTS §14.3`（`docs/CONTRACTS.md:781-785`）、`§14.6`（`:800-805`）、`§14.8`（`:815-820`）、`ARCHITECTURE §7.8`（`docs/ARCHITECTURE.md:533-560`）、`D-044`（`docs/DECISIONS.md:1334-1360`）、`D-048`（`:1447-1466`）。
- store seam：`CONTRACTS §14.1`（`:761-772`）、`§14.7`（`:807-813`）、`ARCHITECTURE §7.3`（`:396-429`）、`apps/server/src/persistence/types.ts:55-93`。
- Undo / origin：`AGENTS.md` R13（`:35`）、`CONTRACTS §6.5`（`:297-310`）、`packages/shared/src/binary-frame.ts:121-138`。
- 单房间 / 路由：`AGENTS.md` R15（`:37`）、`CONTRACTS §5.4`（`:191-224`）、`§10.2`（`:479-507`）。
- 内容单一真相：`AGENTS.md` R11（`:33`）。

### 0.5 审查后版本演进（v1 → v2）

本报告 §1 的逐条裁决针对 **v1**（`docs/ui/P0-RESTORE-DECISIONS.md`，hash `30A580C3DE30869D`）。审查期间 A0 已把决策单改为 **v2**（同路径，hash `58ACF2772E097652`），并逐条吸收 P1：

| P1 | v2 的对应文本 | 状态 |
| --- | --- | --- |
| P1-1 | v2 `:52-62`：整个 restore 在 `runtime.queue.enqueue` 的 slot 内；`:64` 明确 `RoomRegistry` / `DocumentRoom` 入口 | **文本已吸收**；实现未验证 |
| P1-2 / P1-5 | v2 `:65`：新增 `DocumentStore` 单事务方法；“与冻结架构差异：无”不成立；`CONTRACTS §14` 修订 + Decision | **文本已吸收**；方法签名/SQL/迁移未设计 |
| P1-3 | v2 `:57`、`:66`：pre-restore 在 apply 前捕获，sequence 取 slot 内 `lastSequence` | **文本已吸收** |
| P1-4 | v2 `:67`、`:87`：room lease；evict 必须 drain/等待 | **文本已吸收**；lease 机制/HTTP wiring 未设计 |
| P1-6 | v2 `:37-38`：content revision（join 的 empty update 不计），check 在 FIFO slot 内 | **文本已吸收**；content revision 的计算口径未定义 |
| P1-7 | v2 `:56`：current staging clone + text diff，明确不是 version state-vector 差分 | **文本已吸收** |
| P1-10 | v2 `:68`：op-id lookup 先于 revision 校验；存 `{versionId, sequence}`；键 `(document_id, operation_id)` | **文本已吸收** |
| P1-11 | v2 `:69`：禁止客户端 optimistic apply | **文本已吸收**（`:69` 有笔误 `SyncSyncStep2`，P3） |
| P2/P3 | v2 `:81-94`：记录数表补行、op-id 列、retention、命名、版本行歧义（P2-2 仍标注“待明确”） | **部分吸收**；schema/API/测试仍未写 |

**对 v2 的裁决：** 文本层面 **GO**——9 项 P1 都已被写成设计约束，A/B 的定义也已在 v2 `:48-75` 与 UI-ROADMAP `:38-40` 对齐。**实现层面仍 NO-GO**，因为 §4 的 T1–T14、§5 的 C1–C10（store 方法、`document_version` schema、HTTP API、op-id 表、lease、契约修订）还没有落地；这不是文本能替代的。

> v2 的行号与 v1 不同；§1 中引用的 `P0-RESTORE-DECISIONS.md:xx` 均为 v1 行号，用于保留“审查时发现了什么”的审计链。对当前 v2 的判断以本表与 §4/§5 为准。

---

## 1. 六问逐条裁决

> 本节裁决与行号针对 **v1**（`30A580C3…`），保留“审查时到底发现了什么”的审计链；v2 的吸收情况见 §0.5。v2 的结论是“文本 GO、实现 NO-GO（§4/§5 未落地）”。

### Q1 — 选项 A 是否真的保持 `apply → persist → broadcast` 与房间 FIFO；三写事务是否与 `store.append` 兼容

**裁决：FAIL。**

A 的**意图**是对的（顺序不变、复用 FIFO、复用 1011 失败语义），但按决策单的现文不能实现。不是“实现细节没写”，而是三处冻结 seam 的硬约束与一处步骤顺序错误：

#### Q1-1 restore 没有真正进入 FIFO slot（P1）

决策单的步骤 1–2 在 HTTP handler 里完成（`docs/ui/P0-RESTORE-DECISIONS.md:42-43`），步骤 3 才 `room.apply(update)`（`:44`）。而现有唯一的 durable mutation 入口是 `#submitMutation` 里的 `runtime.queue.enqueue`（`apps/server/src/rooms/registry.ts:838-859`）：`apply`（`:842`）→ `await store.append`（`:847`）→ `broadcast`（`:851`）**都在同一个 queue task 内**。

如果按字面实现，步骤 2 计算 diff 与步骤 3 apply 之间可以插入另一条已排队的 update（`D-048:1447-1450`、`CONTRACTS §14.6:800-805`），于是 diff 是基于状态 D 算的、apply 却落到 D+U；`pre-restore` 快照也可能对应旧状态。这不是“短暂不一致”，而是**恢复的输入与生效状态不一致**。

现有代码没有任何 server-authored update 的 production 路径：

- `DocumentRoom.applyServerUpdate` 明确写着 “Not durable… nothing in production calls it”（`apps/server/src/rooms/room.ts:461-475`）；
- `DocumentRoom.applySyncPayload` 只接受 `DecodedSyncFrame`（`room.ts:440-448`），不接受一个“服务端算出来的 raw update”。

**必须：** 把 version 读取、文本 diff、pre-restore 捕获、`apply`、`persist`、`broadcast` 全部放进**同一个** `runtime.queue.enqueue` task；`RoomRegistry` 增加一个 restore 入口；`DocumentRoom` 增加“应用服务端 update 并返回它”的路径（或把 restore 包成受控 frame）。这是对冻结文件 `registry.ts` / `room.ts` 的扩展，不是“零差异”。

#### Q1-2 三写事务与 `store.append` 不兼容（P1）

决策单要求 `pre-restore` 版本 + restore log + operation id 在**一个 SQLite 事务**里（`:45-48, 53`）。但：

- `DocumentStore` 只有五个方法（`apps/server/src/persistence/types.ts:55-93`；`CONTRACTS §14.1:761-772`），没有事务句柄；
- `SqliteDocumentStore.append` 自己就开一个 `BEGIN IMMEDIATE … COMMIT`（`apps/server/src/persistence/sqlite-store.ts:283-309`，经 `transaction.ts:17-31`）；
- SQLite 的 `BEGIN` 不能嵌套（`SAVEPOINT` 可以，但现有 `runInTransaction` 用的是 `BEGIN IMMEDIATE`，不是 savepoint）。我用 `node:sqlite` 实测，在外层 `BEGIN IMMEDIATE` 内再 `BEGIN IMMEDIATE` 直接报错：`cannot start a transaction within a transaction`（§8.2）。

因此**不能**用 `store.append` 组合出这个“三写一个事务”。必须新增一个 store 方法（例如 `appendRestore({ documentId, update, preRestoreState, operationId, response })`），在它自己的 `BEGIN IMMEDIATE` 内：

1. `insertDocumentIfMissing`（与 `append` 一致，`sqlite-store.ts:289`）；
2. 复用 `Math.max(MAX(seq), snapshot_seq) + 1` 的序列分配（`:291-306`）；
3. 写 `document_version`、`document_update`、`operation_id` 三行。

`sequence` 语义本身**可以**复用（D-052 的原子分配可满足），但“事务语义与现有 `append` 兼容”这句话**不成立**——它是新增 seam，需要 `CONTRACTS §14.1/§14.7` 与 `ARCHITECTURE §7.3` 的同步修订。

#### Q1-3 pre-restore 的捕获时点写反了（P1）

步骤 3 先 `room.apply`（`:44`），步骤 4 才 “insert pre-restore version (当前正文/state)”（`:45-47`）。而 `applySyncPayload` 是直接 `Y.applyUpdate(this.doc, update)`（`room.ts:446`）——到步骤 4 时 room 的 `Y.Text` **已经包含 restore**。

结果：写下的 “pre-restore” 等于恢复后的正文；用户点击“版本历史 → 找回恢复前内容”会看到恢复后的状态。这是**设计文本的硬错误**。

**必须：** 在 apply **之前**、同一个 queue slot 内，`const pre = Y.encodeStateAsUpdate(room.doc)`，把 `pre` 写进 version 行；version 的 `sequence` 取该 slot 内 `runtime.accounting.lastSequence`（`registry.ts:848, 862-866`；hydrate 后是 `result.sequence`，`:926`）。

#### Q1-4 没有定义“房间不存在 / 最后一人离开”的 restore（P1）

restore 是 HTTP 请求，pipeline 是 room 级的；这是两套生命周期：

- `RoomRegistry` 只在 `join-room` 时建房（`registry.ts:385-394, 991-998`）；
- `createApp` 根本没有 registry 句柄（`apps/server/src/app.ts:270-288`）；registry 是在 `attachWebSocketServer` 里新建的（`apps/server/src/ws.ts:208-209`）；
- `SerialTaskQueue.stop()` 不取消正在运行的任务（`apps/server/src/persistence/serial-queue.ts:102-110`），而 `#evictRoom` 会 `room.destroy()`（`registry.ts:1091-1106`；`room.ts:609-618`）。

所以存在这些未定义状态：

1. **无人在线时 restore**：没有 room 可 apply；是“hydrate 一个临时 room 再 apply/persist/broadcast/evict”，还是 persist-only？前者保持 A 的顺序，后者就退化成 B。
2. **restore 进行中最后一人离开**：`#destroyRoomIfEmpty` 会销毁 room（`registry.ts:1035-1044`），但正在跑的 queue task 不会停；如果它正好在 `Y.encodeStateAsUpdate(room.doc)` 或 `room.apply`，就会操作已 destroy 的 `Y.Doc`。
3. **HTTP 层如何拿到 registry**：需要新 wiring（把 registry 或一个 restore service 注入 `createApp`），这是架构改动，不是“沿用现有”。

**必须：** 明确 restore 的 room lease（请求期间保活；无 room 时 hydrate 一个受 lease 保护的 room）；evict 前检查 lease；queue task 开始时检查 `room.acceptsMutations` / `room.destroyed`（`room.ts:238-240`）。

#### Q1-5 “与冻结架构差异：无”不成立（P1）

运行顺序确实没变（这点 PASS），但实现需要动四处冻结面：

| 面 | 需要的改动 | 现有证据 |
| --- | --- | --- |
| `DocumentStore` | 新增单事务方法 | `types.ts:55-93`；`CONTRACTS §14.1:761-772` |
| `RoomRegistry` | 新增 restore 入口 / lease | `registry.ts:838-859`、`991-998` |
| `DocumentRoom` | server-authored update 的 apply 路径 | `room.ts:440-448`、`461-475` |
| HTTP wiring | `createApp` 拿到 registry | `app.ts:270-288`；`ws.ts:208-209` |
| Schema | `document_version` 表 + migration | 现有 `apps/server/src` 搜不到 `document_version`；`CURRENT_SCHEMA_VERSION = 2`（`apps/server/src/persistence/schema.ts:76`） |

所以决策单 `:65` 的“与冻结架构差异：无”应改成：“**运行时顺序不变；但持久化 seam、registry/room 的入口、HTTP wiring、schema 均需扩展，需 A0 批准 + Decision 记录**”。

#### Q1-6 `revision` 作为 baseRevision 会误报 409（P1）

`DocumentMeta.revision` 的定义是“最高已提交 sequence”（`sqlite-store.ts:581-601`，`:597` 的 `Math.max(highestLogSequence, snapshotSequence)`）。而一次 join 的握手 `SyncStep2` 会 append 一行 2-byte empty update：

- `docs/ARCHITECTURE.md:423-427`：“A join alone can append a 2-byte empty update, because a client's `SyncStep2` goes through the same `apply → persist → broadcast` path”；
- `apps/server/src/persistence/acceptance.test.ts:556-558`：“The handshake itself appends a row per client”。

于是：用户 preview 时记录 `baseRevision = R`；另一个人 join（内容没变）→ revision 变 `R+1`；用户确认 → 409。**409 与内容无关，是握手噪声。**

**必须：** 定义 restore 用的 revision 语义：

- 优先：**content revision**（只统计改变正文的 append；empty update 不计）；
- 或者：把 revision check 放进 queue，并对 `update.byteLength` 为 empty/2-byte 的 append 不算；
- 无论哪种，都要写进 `CONTRACTS §1` / `§12` 的 revision 语义，不能只在决策单里写“revision”。

#### Q1-7 “读取版本 yjs_state，计算 relative update”的措辞会导出空更新（P1）

如果实现者按字面做：读版本的 `yjs_state` → `versionDoc`，然后 `Y.encodeStateAsUpdate(versionDoc, stateVector(currentRoom))`。当版本是当前状态的**祖先**时，current 已经包含 version 的全部 struct，差分为空——**恢复不会删除任何新内容**，正文不变。

正确做法在实验 §6 里已经给出：在 **current 的 staging clone** 上做文本 diff、应用 restore transaction，再 `Y.encodeStateAsUpdate(staging, stateVector(current))`（`tests/experiments/version-restore.mjs:219-224`；`docs/ui/UI-ROADMAP.md:37` 也写对了）。决策单 `:43` 的“读取版本 yjs_state，计算 relative update”必须改成这个描述，否则实现者会写出“恢复后正文等于当前正文”的 bug。

**Q1 结论（v1）：FAIL。** A 的方向正确，但以上 7 项是进入实现的硬前提；其中 Q1-1、Q1-2、Q1-3 是“不修就一定错”的级别。v2 文本已吸收 Q1-1…Q1-7（§0.5），但实现层未验证。

---

### Q2 — 选项 B 是否偏离冻结架构；需要什么 Decision 记录；log 顺序 vs apply 顺序的风险

**裁决：FAIL**（偏离的**分类**正确，但治理要求与举证不完整）。

#### Q2-1 偏离是实质性的（PASS 于“识别”，但需要写全）

- **顺序：** `CONTRACTS §14.3:781-785` 写死 “apply → persist → broadcast”；`ARCHITECTURE §7.8:535-541` 同；`D-044:1336` 同。B 是 persist → apply，反转了第一步和第二步。
- **append 的语义：** `CONTRACTS §14.1:769` 与 `types.ts:59-73` 都定义 `append` 是 “append one **already-applied** update”。B 会 append 一条 room 尚未 apply 的 update，语义不符。
- **单一 pipeline：** `D-048:1447-1450` 要求同一 document 的 durable mutation 经过**单一** FIFO pipeline。B 如果跑在 queue 外，就是第二条 pipeline，直接违反 D-048；如果跑在 queue 内，不违反 D-048，但仍反转 §14.3。决策单 `:79-81` 的 risk 描述默认 B 在 queue 外（“步骤 3-4 之间到达的普通 update 会先 apply/append/broadcast”），却没说 B 到底入不入队——这个选择决定风险形态，必须写清。

#### Q2-2 需要什么 Decision 记录（决策单没写）

不是把 `D-RW1` 打个勾就够。若 Owner 选 B，至少需要一条新的 `D-0xx`，明确：

1. 修改 `CONTRACTS §14.3` 与 `§14.1` 的“already-applied”语义；
2. B 是否在 FIFO slot 内（决定 log/apply 顺序风险是否存在）；
3. `document_version.sequence` 在 persist-first 下的定义（见 Q2-3）；
4. persist 成功、apply 失败（或两者之间崩溃）的恢复语义。

按 `AGENTS.md:40-49`，`docs/CONTRACTS.md` 属 Supervisor approval 范围；按 `CONTRACTS §13:744-751`，破坏性变更要 bump 版本并记录。B 不改 wire（`PROTOCOL_VERSION` 不必动），但 `§14` 必须改。

#### Q2-3 真正的风险：不是“log 顺序 ≠ apply 顺序”本身，而是 poison pill 与 version sequence

- **如果 B 在 queue 内：** 普通 update 不会插到 persist 与 apply 之间，log 顺序 = apply 顺序，决策单说的交错风险**不成立**。真正的风险变成：**persist 成功、apply 失败**（或进程在两者之间崩溃）。一条 durable 的 restore 已经进 log；如果 apply 因任何原因抛错，后续每次 hydrate 都会在 `Y.applyUpdate` 上失败（`rooms/room.ts:446`；`persistence/hydrator.ts:85-99` 的 hydrate 路径同样 apply），房间永久 `UNHEALTHY`。这是 **durable poison pill**：比“顺序交错”更难恢复，且 `#failRoomUnhealthy` 只能销毁内存，删不掉那条坏 log。
- **如果 B 在 queue 外：** 才有决策单说的 log/apply 分叉；同时 `document_version.sequence`（`docs/ui/UI-ROADMAP.md:31` 的 schema）不再对应“log prefix 的状态”，version 的 sequence 语义要重定义，或者 version 行只能靠自己的 `yjs_state` 自包含（那就不要用 sequence 做回放）。

#### Q2-4 决策单引用的测试不存在

`docs/ui/P0-RESTORE-DECISIONS.md:81` 说“可能违反现有 FIFO 测试对 **apply 顺序 = log 顺序** 的断言”。我查了：

- `apps/server/src/persistence/serial-queue.test.ts:22-99`：只断言 queue 的 enqueue 顺序、不交错、跨文档独立；
- `apps/server/src/persistence/acceptance.test.ts:507-567`：断言 “no broadcast before commit”（`:537-541`）与 sequence 严格递增（`:559-567`）。

**没有** “apply 顺序 = log 顺序” 的断言。风险方向是对的，举证错了；这也意味着 B 若实施，**必须新写**这条测试（见 T1/T2），不能指望现有套件兜底。

#### Q2-5 A/B 标签：当前工作树已对齐（审查期间被并发修改）

**审查开始时**（committed UI-ROADMAP）的“建议方案（选项 A）”（`:29`）描述的却是 **persist-first**（`:38`），与决策单的 A（FIFO）相反。当前工作树版本已改为：

- `docs/ui/UI-ROADMAP.md:38-40`：**A（A0 推荐）** = 沿用 room FIFO；**B** = 单独 persist-first，需 Owner 批准并重新证明 FIFO/顺序；
- 决策单 `docs/ui/P0-RESTORE-DECISIONS.md:35-87`：A = FIFO，B = persist-first。

两者现在一致，**A/B 标签碰撞在当前工作树已解决**。但这只是未提交修改；如果只 review committed 版本，Owner 仍可能按“UI-ROADMAP 的 A = persist-first”裁决。**要求：commit 前把 `D-RW1` 的 A/B 定义在决策单里写成一句话定义**（“A = apply→persist→broadcast；B = persist→apply→broadcast”），不要只依赖标题。

**Q2 结论：FAIL。** B 偏离冻结架构；需要新 Decision 记录 + §14 修订；A7 建议**否决 B**。理由：A 的“apply 失败不落盘”恰好避免 poison pill；B 的“持久化失败不改房间”是很窄的优点，换来的是 §14 改写 + poison pill + version sequence 重定义，不划算。

---

### Q3 — 决策单的记录数表是否成立

**裁决：FAIL。** 逐行审计如下（表在 `docs/ui/P0-RESTORE-DECISIONS.md:57-63`）：

| 行 | 决策单结论 | A7 | 证据与原因 |
| --- | --- | --- | --- |
| 成功 | 1 / 1 / 1 | **PASS（有条件）** | 三件 artifact 各 1 行成立，前提是 Q1-2 的单事务方法存在、且每次 restore 只写 1 条 pre-restore。**但**：`document_version` 表当前不存在（`apps/server/src` 无此表）；若按 `UI-ROADMAP:41` “恢复自身产生一个新版本”，版本行是 **2** 不是 1。表中没有说明“版本行”是否计入。 |
| 成功但响应丢失 | 1 / 1 / 1；同 op id 命中 → 不再写，返回原结果 | **FAIL** | 决策单步骤 2 先校验 revision（`:43`），步骤 4 才 insert op id（`:45-48`）。restore 成功后 revision 从 R 变 R+1；重试带 `baseRevision=R` 会在步骤 2 得到 409，**到不了** op-id 命中。必须把 op-id lookup 放到 revision 校验之前。并且 op-id 行必须存 original result（`versionId`、`sequence`），否则“返回原结果”没有数据可返回；`D-OP1` 只选了表（`:108`），没定义列。 |
| 提交后、响应前进程重启 | 1 / 1 / 1；持久层已有；重试命中 | **FAIL** | 同上的 ordering。另有客户端前提：进程重启/页面刷新后，客户端必须仍持有同一 `operationId`；若 op id 只在内存，重试会变成新 op id → 409。决策单没有定义 op id 的客户端持久化。 |
| 提交前进程重启 | 0 / 0 / 0；重试创建 1/1/1 | **PASS（有未写假设）** | 行数成立，但假设“重启期间没有其它 append”。若有，重试的 baseRevision 已变 → 409，不是 1/1/1。另外 A 在 `room.apply` 之后、事务之前失败时，room 会被 `#failRoomUnhealthy` 销毁并 1011（`registry.ts:959-985`），不是决策单 `:66` 说的“短暂不一致”。 |
| 相同请求重试 N 次 | 1 / 1 / 1；幂等 | **FAIL** | 同 ordering。另有两个未定义：(a) 同一 op id + **不同 body** 怎么办（应拒绝或比对 request hash，否则会拿旧结果）；(b) op-id 唯一键若只有 `operation_id` 而没有 `document_id`，跨文档重放可能读到别的文档的 versionId（信息泄露）。 |
| （缺失）事务内 append 失败 | — | **缺失** | A 是 rollback → 0/0/0；B 是 1/0/0（pre-restore 已提交）。决策单 §4 的 `:93-94` 只说“同上”，没有分开 A/B。 |
| （缺失）restore 期间房间 evict / 最后一人离开 | — | **缺失** | 见 Q1-4；`serial-queue.ts:102-110` 不取消运行中任务，`#evictRoom` 会 destroy。 |
| （缺失）客户端 optimistic apply 后断线重连 | — | **缺失** | 若客户端在 HTTP 返回前把 restore 本地 apply 了，失败/超时后它会通过 SyncStep2 把 restore 当普通 update 重传；结果是 1 条 log、**0 条 pre-restore、0 条 op id**，恢复前的找回入口丢失。见 P1-11。 |
| （缺失）两个 restore 并发确认 | — | **缺失** | 两个请求各自在 queue 外通过 revision 校验，排队后第二个覆盖第一个；如果 revision check 不在 queue slot 内，409 保护不了。 |
| （缺失）compaction 之后的 pre-restore 版本 | — | **缺失** | compaction 会删除已消费的 log 行（`sqlite-store.ts:311-321`，`registry.ts:1053-1088`）；pre-restore 版本必须靠自己的 `yjs_state` 自包含，不能靠“sequence + 回放”。需要测试（T10）。 |

**补充：** “成功但响应丢失”和“提交后、响应前进程重启”的**持久层状态完全相同**（1/1/1），差别只在客户端是否重启；表把它们分成两行没有错，但容易让人以为有两种不同的 commit 结果，建议合并并注明“客户端可见差异”。

**Q3 结论（v1）：FAIL。** 记录数表只有“成功”行在补足条件下成立；三行幂等相关结论按 v1 的步骤顺序**不成立**；缺失至少 5 类行。v2 `:77-94` 已补行（§0.5），但表里的“重试命中 / 返回原结果”仍必须由 §4 T3/T4 在真实 store 上证明。

---

### Q4 — 恢复不可被客户端 Undo、通过 `pre-restore` 找回，是否与 R13 / 现有 undo 契约冲突

**裁决：PASS（附 1 项已解决冲突 + 1 项证据强度问题）。**

#### Q4-1 与 R13 / `UNDO_TRACKED_ORIGINS` 的关系：不冲突，且是既有契约的推论

- R13（`AGENTS.md:35`）：本地 undo 只回退 local/AI origin 的编辑，绝不回退 remote；不得用 text-snapshot restore 实现 undo；使用 `UNDO_TRACKED_ORIGINS`。
- 冻结的 origins：`TRANSACTION_ORIGINS` 四个值，`UNDO_TRACKED_ORIGINS = [local, ai]`（`CONTRACTS §6.5:297-310`；`packages/shared/src/binary-frame.ts:121-138`）。
- 服务端 restore 的路径：room 以 `TRANSACTION_ORIGINS.remote` apply（`rooms/room.ts:446`），再以 `SyncUpdate` 广播给所有参与者（`room.ts:456-459`）。**在“客户端不做 optimistic apply”（P1-11）的前提下，所有客户端（包括发起者）收到的都是 remote update**，不在任何 `UndoManager` 的 tracked origins 里。

所以“客户端 Undo 不撤回恢复”**不需要新例外**；它是现有 origin 规则的自然结果。PASS。

#### Q4-2 不要新增 `restore` origin；更不要把它放进 tracked origins

- 决策单 `:22` 说“V1 建议把 `restore` 排除在 `UNDO_TRACKED_ORIGINS` 之外”。方向对，但**当前设计根本不需要新增 origin**：服务端 restore 用 remote 就够了。
- 如果产品坚持要一个客户端 `restore` origin：它是 `packages/shared` 的 `TransactionOrigin` 联合变更（`binary-frame.ts:121-132`），属于 `CONTRACTS §6.5` 的契约变更，按 `§13:744-751` 要改文本并 bump `SHARED_CONTRACT_VERSION`；而且它**必须不**在 `UNDO_TRACKED_ORIGINS` 里。当前没有理由付这个成本。

#### Q4-3 Undo 表述冲突：当前工作树已对齐（审查期间被并发修改）

**审查开始时**（committed UI-ROADMAP）`:54` 写“restore 是一条 `origin='restore'` 的 transaction，UndoManager 跟踪它”，这与决策单 `D-UD1`（`:111`，“恢复是否可被客户端 Undo：否（推荐）”）以及 R13 的 origin 表**直接冲突**。

当前工作树版本已改为：

- `docs/ui/UI-ROADMAP.md:48`：“Undo：**V1 不让客户端 Undo 撤回共享恢复**；找回恢复前内容走 `pre-restore` 版本历史（产品语义见决策单）。”

这与 `D-UD1` / R13 一致，**冲突在当前工作树已解决**。但这仍是未提交修改；必须 commit 并 pin，否则回退到 committed 版本会重新引入“只有发起者能撤销共享恢复”的实现风险。

#### Q4-4 实验的 undo 证据只证明了一半

- `otherReplicaAfterUndo = "restored"` 的测试在 apply **之后**才创建 `UndoManager`（`tests/experiments/version-restore.mjs:200-204`）。一个没有历史的 UndoManager，`undo()` 本来就不动；它不能证明“tracked 了 restore 的远端副本也无法 undo”。有效的反例测试应该是：在 apply 之前创建 UndoManager，`trackedOrigins` 含 `restore`，以 `remote` origin apply，再 undo → 不变。
- `authorReplicaAfterUndo = "base"` 是有效的，但它模拟的是**客户端本地** restore transaction（`:197-206`）。A/B 的生产路径是服务端 apply 后广播；发起者收到的也是 remote update，所以**生产里作者侧也不应能 undo**。`authorReplicaAfterUndo = "base"` 是 counterfactual，不是生产行为。
- 实验的“独立副本撤销语义”只覆盖“远端副本没有历史所以 undo 不动”，没有覆盖“如果 tracked 了 restore，undo 会怎样”；UI-ROADMAP 现在不要求 tracked，所以这不是正确性缺口，但它是**证据强度**缺口。
- `UI-ROADMAP` 旧版 `:54` 的“Undo 保留期间并发编辑”在实验里没有测试（restore 之后没有并发编辑再 undo）。如果将来真的 tracked，这个才是难点；现在标 `NOT VERIFIED`。

#### Q4-5 `pre-restore` 找回与 R13 不冲突

“版本历史 → pre-restore → 恢复”是**再恢复一次**，是一次新的 forward edit，不是 undo，不触碰 R13 的 origin 规则。PASS。

但有一个 retention 前提：pre-restore 版本不能作为“自动版本”被 30 天 / 200 条策略清理掉，否则“找回入口”会消失（见 §5 C2 / P2-4）。

**Q4 结论：PASS。** 产品语义（不可 undo、pre-restore 找回）与 R13/现有 undo 契约兼容；UI-ROADMAP 的相反表述在当前工作树已对齐（未提交，需 commit/pin）；实验的 undo 证据要换成“remote origin + 预先创建 UndoManager”的测试。

---

### Q5 — Unicode 修复（code point 边界）是否足够；grapheme cluster 是否必须现在处理

**裁决：PASS。Grapheme cluster 不阻塞。**

#### Q5-1 code point 修复本身正确

`restoreTo` 用 `[...string]` 取 code point 序列求公共前后缀，再用 `join('').length` 把 code point 偏移转回 UTF-16 索引（`tests/experiments/version-restore.mjs:63-90`）。5 个用例分别断言发起端、编码传输后的对端、对端长度（`:125-134`），全 PASS。对 surrogate pair 而言这足够了：删除/插入的边界不会落在代理对中间。

#### Q5-2 grapheme cluster：不是 P0 阻塞项

我补了 4 个探针（用同样的 code-point 算法）：

| 用例 | 结果 |
| --- | --- |
| family 中间替换 `a👨‍👩‍👧b` → `a👨‍👦‍👧b` | 输出逐字等于目标 |
| family 删成员 `a👨‍👩‍👧b` → `a👨‍👧b` | 输出逐字等于目标 |
| 国旗替换 `x🇨🇳y` → `x🇺🇸y` | 输出逐字等于目标 |
| 肤色替换 `x👍🏽y` → `x👍🏿y` | 输出逐字等于目标 |

原因：算法删除/插入的边界落在 code point 上，最终字符串**必然**等于 target；grapheme cluster 只影响“这次编辑删了 cluster 的哪几个 code point”，不影响最终正文。它影响的是 transient 的协作粒度 / 远端 cursor 锚点，不是数据正确性。

**结论：** 不需要现在引入 `Intl.Segmenter`。把它写成 known limitation 即可：“删除/插入边界按 code point，不按 grapheme；光标/锚点可能落在 cluster 内部；最终正文仍逐字正确。”

#### Q5-3 “真实缺陷”的措辞要收窄

生产代码里没有 `restoreTo`（只有实验脚本）。所以这是“**实验第一版实现**里的真实缺陷 / 设计期已避免的缺陷”，不是“线上已发生的 bug”。`docs/ui/VERSION-RESTORE-EXPERIMENT.md:20` 的“这是一个真实缺陷”容易被读成生产回归；建议改成“实验实现的真实缺陷；生产尚未实现，因此不是已发布缺陷”。

#### Q5-4 legacy 输出的括号注释不准（P3）

`legacyFailures` 的实际值是 `"hello �\ude03"`，其中 `�` 是 U+FFFD，后面是 lone low surrogate `\ude03`。我实测的 code unit 序列是 `["68","65","6c","6c","6f","20","fffd","de03"]`。文档 `VERSION-RESTORE-EXPERIMENT.md:16` 写“孤立高代理 + 低代理”不准确：高代理被替换成了 U+FFFD，不是保留为 lone high surrogate。**结论（正文损坏）成立，括号要改。**

#### Q5-5 生产可移植性（必须补）

5 个用例只验实验 helper。实现生产 restore 时，必须把同样的 5 个 case（+ ZWJ/flag/skin-tone known-limitation case）跑在**生产 diff 函数**上；若生产用 UTF-16 diff 或别的库，缺陷会回来。

另外：`vitest.config.ts:36-42` 的 include 不包含 `tests/experiments/**`，所以这 33 项**不在 `pnpm test` gate** 里。它们目前是“手工证据”，不是“门禁证据”。见 §5 C9 / T7。

**Q5 结论：PASS。** code-point 修复足够；grapheme cluster 不阻塞；但要把“真实缺陷”的叙述收窄、修正 U+FFFD 的括号，并把测试搬进 gate / 生产 helper。

---

### Q6 — 离线同区间编辑的 `betALPHA` 是否被正确描述为“CRDT 合并、非目标原文”；产品是否必须提示

**裁决：PASS（附证据措辞修正 + 强制产品提示）。**

#### Q6-1 语义描述方向正确

`docs/ui/VERSION-RESTORE-EXPERIMENT.md:48-54` 写得很清楚：

- 最终正文 `betALPHA`；
- “CRDT 决定，非字符串覆盖”；
- “不能承诺恢复后正文等于版本原文”；
- 预期正文 = “无并发时 = 目标版本正文；有并发时 = CRDT 合并结果（本例 `betALPHA`），两端一致”。

这符合实验的实际行为：`restoreTo(online, 'beta')` 与 offline 的 `delete(0,5)` + `insert(0,'ALPHA')` 合并后，两端收敛；`betALPHA` 是 CRDT 的合并结果，不是 `beta`，也不是 `alpha`。PASS。

#### Q6-2 但 `betALPHA` 没有被断言（P3）

实验只断言：

- `check('offline and restored peers converge', textOf(online), textOf(offline))`（`:185`）；
- `check('the offline edit is not silently lost from the offline replica before merge', offlineBefore, 'alpha')`（`:187`）。

`mergedText` 只出现在 summary（`:245`）。所以 `betALPHA` 是**观测值**，不是契约。我在本机跑了 10 次，10/10 都是 `betALPHA` + `converged=true`；但这仍不是“Yjs 保证的固定字面量”（并发插入位置由 CRDT 决定，clientID tie-break 可能变化）。文档应写：“本实验观测到 `betALPHA`；保证的是收敛与双方 struct 不被静默丢弃，不是这个字面量。”

#### Q6-3 `:51` “离线编辑的字符仍在”比实验强（P3）

`:187` 只检查合并**前**的 offline 文本；它没有断言合并后 `ALPHA` 仍在。summary 的 `mergedText` 含 `ALPHA`，但不是 assertion。应加一条等价断言，例如：

```js
check('offline insertion survives the merge', mergedText.includes('ALPHA'), true);
```

否则“离线编辑的字符仍在”是 observed，不是 proven。

#### Q6-4 产品必须提示（结论：**必须**）

`docs/ui/P0-RESTORE-DECISIONS.md:98` 与实验 `:52` 已经写了“UI 提示含并发/离线编辑”。我把它升级为**强制**：

1. restore 成功后，如果期间有任何 append / 离线端重连，**不能只显示“已恢复”**；必须显示：“恢复已应用；当前正文含并发/离线编辑，可能不等于所选版本原文。”
2. 提供两个可操作入口：“查看 pre-restore 版本”与“查看当前 vs 目标 diff”。
3. 仅提示、不阻断，符合 R10（离线是一等状态）和 `D-RC1`（拒绝 + 重新预览只覆盖**确认时已提交**的变更，不覆盖确认后才到达的编辑）。

#### Q6-5 不要用 revision 差值编造 “N 条并发编辑”（当前工作树已删除该说法）

**committed 版** `UI-ROADMAP:52` 曾写“N 由确认时的 revision 与恢复时 revision 计算”。这是**错的**：

- revision 是 append 序号，包含 join 的 2-byte empty update（见 Q1-6）；
- 一条 update 可能包含很多编辑；
- revision 也会因 AI/远端写入而变，未必是“并发编辑”。

当前工作树版本已删掉这句话（`:45-48` 只保留“UI 必须提示含并发/离线编辑”），所以这不是当前设计的 P2。但实现时仍要守住：产品文案不能用这个 N；要显示就显示“有并发编辑”；如果一定要计数，必须定义口径（例如实际 diff 的 operation 数），并在契约里写清。

#### Q6-6 “无并发时 = 目标正文”的时点

这个结论只在 **restore 提交的那一刻**成立；之后到达的编辑按 CRDT 合并。文案应写：“恢复提交时的正文 = 目标版本；之后/并发的编辑仍会合并。” 这不是缺陷，是措辞精度。

**Q6 结论：PASS。** 语义描述正确；`betALPHA` 是观测值不是断言；产品提示必须存在，且不能编造 N。

---

## 2. 发现清单（按严重度）

### 2.1 P1（进入实现前必须解决）

| ID | 问题 | 对应 |
| --- | --- | --- |
| P1-1 | restore 没有真正进入 per-document FIFO slot；HTTP 计算与 room apply 可被并发 update 插入 | Q1-1 |
| P1-2 | 三写事务无法用 `store.append` 组合（嵌套 `BEGIN`）；需要新 store 方法 + 契约修订 | Q1-2 |
| P1-3 | pre-restore 在 `room.apply` 之后捕获，会写成恢复后的状态 | Q1-3 |
| P1-4 | 没有定义“无人在线 / 最后一人离开 / evict 与运行中 restore”的生命周期；HTTP 层没有 registry 句柄 | Q1-4 |
| P1-5 | “与冻结架构差异：无”不成立；store seam / registry / room / HTTP wiring / schema 都要改 | Q1-5 |
| P1-6 | `revision` 是 log 位置，join 的 empty update 会误报 409；restore 的 revision 语义未定义 | Q1-6 |
| P1-7 | “读取版本 yjs_state 计算 relative update”会导出空更新；必须用 current staging clone + text diff | Q1-7 |
| P1-10 | op-id lookup 在 revision 校验之后，响应丢失/重启后的重试会 409，幂等不成立 | Q3 |
| P1-11 | 客户端 optimistic apply 未禁止：失败/超时后本地 restore 会被 SyncStep2 当普通 update 重传，绕过 pre-restore / op-id（0 pre-restore、0 op id） | Q3 缺失行 / T14 |

> 注：Q3 的 P1-10 与 Q1 的 P1-1 有重叠（都在 queue/ordering 上），但修复点不同：P1-1 是“进 queue”，P1-10 是“op-id 先于 revision”。P1-8/P1-9 已移到 §2.4（审查期间被并发修正，需 commit/pin）。

### 2.2 P2（设计合入前 / 写测试前必须解决）

| ID | 问题 |
| --- | --- |
| P2-1 | 记录数表缺少“事务内 append 失败”“evict”“optimistic apply 重传”“并发 restore”“compaction 后 pre-restore”行（Q3） |
| P2-2 | 记录数表未说明“恢复自身产生一个新版本”（UI-ROADMAP:41）是否计入版本行（Q3） |
| P2-3 | 记录数表未说明“提交前重启”假设期间无其它 append（Q3） |
| P2-4 | pre-restore 版本的 retention / GC：不能被自动版本 30 天 / 200 条清掉（§4 C2） |
| P2-5 | op-id 表：唯一键必须 `(document_id, operation_id)`；存 original result；存 request hash；保留期 > 最大重试窗口（Q3） |
| P2-6 | 客户端 op-id 持久化（刷新/重启后仍能重用）未定义（Q3） |
| P2-7 | 命名碰撞：文档版本 restore vs 备份 `restoreBackup` / backup-cli `restore`（`apps/server/src/persistence/backup.ts`、`backup-cli.ts`）；API/文档要区分 |
| P2-8 | 33 项实验不在 `pnpm test` gate（`vitest.config.ts:36-42` 不包含 `tests/experiments/**`） |

### 2.3 P3（证据/措辞精度）

| ID | 问题 |
| --- | --- |
| P3-1 | “孤立高代理 + 低代理”应为 U+FFFD + lone low surrogate（Q5-4） |
| P3-2 | “真实缺陷”应为“实验实现的真实缺陷；生产尚未实现”（Q5-3） |
| P3-3 | “离线编辑的字符仍在”未被断言（Q6-3） |
| P3-4 | other-replica undo 测试在 apply 之后才建 UndoManager，证明力弱；author replica 是 client-side counterfactual（Q4-4） |
| P3-5 | “retry applies exactly once”只是文本级，不是行级（实验 §6 没有 SQLite） |
| P3-6 | `betALPHA` 未被断言；10/10 稳定不等于契约（Q6-2） |

### 2.4 审查期间已解决、但尚未提交的两项（需 commit/pin）

| ID | 原问题（committed UI-ROADMAP） | 当前工作树状态 | 风险 |
| --- | --- | --- | --- |
| R-1 | `UI-ROADMAP:29/38` 的“选项 A”实际描述 persist-first，与决策单 A 相反 | `:38-40` 已写成 A = FIFO、B = persist-first | 未提交；只 review committed 版本会按错的设计裁决 D-RW1 |
| R-2 | `UI-ROADMAP:54` 说 UndoManager 跟踪 restore，与 D-UD1 / R13 冲突 | `:48` 已写成“V1 不让客户端 Undo 撤回共享恢复” | 未提交；回退会重新引入“只有发起者能撤销共享恢复” |

> 这两项原本在我的 P1 清单里；审查期间 UI-ROADMAP 被并发修改（`M`，hash `D2B756F1F7BC18D7`），所以我按最终工作树降级。**它们仍然是“未提交”状态**：A0 必须 commit 并 pin，否则本报告的通过条件不成立。另外，`UI-ROADMAP:50` 已把“15 项断言”改为“33 项”，原 P2-10 也随之解决。

---

## 3. A/B 裁决建议

### 3.1 选项 A：**v2 文本已吸收；实现仍 NO-GO，直到以下前置条件落地**

**v2 的 `:52-69` 已把 P1-1…P1-7、P1-10、P1-11 写成设计约束（§0.5）。以下 8 条是“实现验收”的前置条件（覆盖 9 项 P1），全部满足才 GO：**

1. **P1-1**：整个 restore（version 读取 → diff → pre-restore 捕获 → apply → persist → broadcast）在同一个 `runtime.queue.enqueue` task 内；`RoomRegistry` 提供 restore 入口；`DocumentRoom` 提供 server-authored update 的应用路径（不要用“nothing in production calls it”的 `applyServerUpdate` 而不改注释/契约）。
2. **P1-2 + P1-5**：新增 `DocumentStore` 单事务方法，复用 `Math.max(MAX(seq), snapshot_seq)+1`；同步修订 `CONTRACTS §14.1/§14.7`、`ARCHITECTURE §7.3`；把“与冻结架构差异：无”改成“运行时顺序不变、seam/入口/wiring/schema 需扩展”；A0 批准 + Decision 记录。
3. **P1-3**：pre-restore 在 apply **之前**捕获；version 的 sequence 取 slot 内 `lastSequence`。
4. **P1-4**：定义 room lease / 无人在线 / evict 的时序；`createApp` 注入 registry 或 restore service。
5. **P1-6**：定义 content revision（或 empty update 不计）；revision check 在 queue 内。
6. **P1-7**：restore update 用 current staging clone + text diff（不是 version state vector 差分）。
7. **P1-10**：op-id lookup 先于 revision 校验；op-id 行存 `{versionId, sequence}`；键 `(document_id, operation_id)`。
8. **P1-11**：禁止客户端 optimistic apply（或只允许不 tracked、失败可回滚的本地预应用）；否则失败后 SyncStep2 会把 restore 当普通 update 重传，绕过 pre-restore / op-id。

**明确不属于 A 的改动：** `apply → persist → broadcast` 的顺序本身不变；`D-048` 的单一 FIFO 不变；wire / `PROTOCOL_VERSION` / `SHARED_CONTRACT_VERSION` 不变（除非新增客户端 `restore` origin，而当前不需要）。

### 3.2 选项 B：**OWNER_DECISION_REQUIRED；A7 建议否决**

若 Owner 选 B，必须先有：

1. 一条新的 `D-0xx` Decision，改 `CONTRACTS §14.3`（顺序）与 `§14.1`（append 的 “already-applied” 语义）；
2. 明确 B 在 FIFO slot 内还是外（决定 log/apply 顺序风险是否存在）；
3. 重定义 `document_version.sequence`（log prefix ≠ apply prefix）；
4. **poison pill 测试**：persist 成功、apply 失败（或崩溃）后，下一次 hydrate 怎么办；如果答案永远是 “unhealthy”，则 B 不可接受；
5. 新写“apply 顺序 = log 顺序”测试（现有套件没有这条断言，决策单引用错了）。

**A7 立场：** 否决 B。A 的“apply 失败不落盘”恰好避免 poison pill；B 的“持久化失败不改房间”是很窄的优点，换来的是 §14 改写 + poison pill + version sequence 重定义，不划算。

### 3.3 Owner 决策项的 A7 立场

| ID | 决策单建议 | A7 立场 |
| --- | --- | --- |
| `D-RC1` 确认时 revision 变化 | 拒绝 + 重新预览 | **同意**，但 revision 必须是 content revision（P1-6）；check 必须在 queue 内；确认后才到的编辑用产品提示，不用 409 |
| `D-RW1` 写入顺序 | A | **A**；B 需 Owner 决策 + Decision 记录，A7 否决 |
| `D-OP1` operationId 存放 | 独立表 | **独立表**；唯一键 `(document_id, operation_id)`；存 original result + request hash；保留期 > 最大重试窗口 |
| `D-V1` 谁可恢复 | Owner+Editor | **Owner+Editor（`canEdit`）**；Owner-only 可复用 `canManageMembers`（`packages/shared/src/permission.ts:41` 已 owner-only） |
| `D-V2` 自动版本粒度 | 10min | **可以**，但 pre-restore 不受自动版本 200/30d 清理影响（P2-4） |
| `D-UD1` 恢复是否可 Undo | 否 | **否**；不要加进 `UNDO_TRACKED_ORIGINS`，最好连新 origin 都不加（Q4-2） |

---

## 4. 必须补的测试

> 这些测试在实现前写成设计验收；没有它们，“A 可用”只是推断。

| ID | 测试 | 证明什么 | 为什么现在没有 |
| --- | --- | --- | --- |
| T1 | restore + concurrent client update：assert apply/log/broadcast 顺序，且 diff 是在 slot 内对当时状态算的 | P1-1 | 没有 restore 实现 |
| T2 | 三写事务在每一写注入失败：assert 0/0/0、room unhealthy、无 broadcast、HTTP 5xx | P1-2 / Q3 | 没有 store 方法 |
| T3 | 同一 op id 重试 N 次（含 reopen store + stale `baseRevision`）：assert 1/1/1、返回同一 `{versionId, sequence}` | P1-10 | 没有 op-id 表 |
| T4 | 记录数：成功 / 响应丢失 / 提交前重启 / 提交后重启；逐行 assert | Q3 | 同上 |
| T5 | pre-restore 内容：decode version 的 `yjs_state`，assert 文本 == apply 前文本（不是 apply 后） | P1-3 | 没有 version 表 |
| T6 | 两个并发 restore 确认：一个 409 或串行化，不能双 apply | Q3 / P1-6 | 没有 API |
| T7 | Unicode 生产 helper：5 个 code-point case + 4 个 grapheme known-limitation case；放 `pnpm test` gate | Q5 | 现在只在 experiment `.mjs` |
| T8 | 离线同区间合并：assert 收敛 + `mergedText` 含 `ALPHA` + 产生“含并发编辑”信号 | Q6 | 实验只断言收敛 |
| T9 | 无人在线 / 最后一人离开时 restore：durable 正确、room 不半死、后续 join 能 hydrate | P1-4 | 没有实现 |
| T10 | restore → evict + compact → reload：正文保持，pre-restore 版本仍可 decode | Q3 / P2-4 | 没有实现 |
| T11 | 权限：`canEdit` 才能 restore；`canRead` 才能 list/preview；403/404 非泄露 | D-V1 | 没有 API |
| T12 | revision 语义：join 的 empty update 不 bump content revision（或 409 被明确记录） | P1-6 | revision 语义未定义 |
| T13 | op-id 跨文档重放：用 A 文档的 op id 打 B 文档，必须拒绝/不泄露 versionId | P2-5 | 没有表 |
| T14 | optimistic apply 后失败重连：assert 不会产生“无 pre-restore、无 op id”的 log 行；或客户端根本不预应用 | P1-11 | 没有客户端 restore 逻辑 |

---

## 5. 必须补的契约 / 文档修改

| ID | 文件 | 修改 |
| --- | --- | --- |
| C1 | `docs/CONTRACTS.md §14.1/§14.7`、`docs/ARCHITECTURE.md §7.3`、`apps/server/src/persistence/types.ts` | 新增单事务 restore store 方法；明确 sequence 分配复用；明确 “append one already-applied update” 在服务端 restore 下的含义。A0 批准 + Decision 记录。 |
| C2 | schema / migration | 新增 `document_version(id, document_id, sequence, title, author_id, created_at, yjs_state BLOB, kind)`；`kind = auto / manual / pre-restore`；migration `user_version 2 → 3`；pre-restore 的 retention 豁免（或更长）；author = restore 发起者，title 可默认。 |
| C3 | op-id 表 | 列：`document_id, operation_id, request_hash, version_id, sequence, created_at`；唯一键 `(document_id, operation_id)`；保留期 > 最大重试窗口；清理不能早于客户端放弃重试。 |
| C4 | `docs/CONTRACTS.md §12` | `POST /api/documents/:id/versions/:versionId/restore`，body `{baseRevision, operationId}`；响应 `{versionId, sequence}`；状态码 200/400/401/403/404/409/410/500；409 body 定义；同一 op id 重放返回原结果；客户端必须持久化 op id 直到收到响应。 |
| C5 | `docs/CONTRACTS.md §14.3` | 若选 B：改顺序 + 写 poison-pill 语义；若选 A：补一句“服务端发起的 durable mutation 也走同一 FIFO pipeline，不得另开 persist-first 路径”（把 A 的选择写成约束，防止以后有人加 B 路径）。 |
| C6 | `docs/ui/UI-ROADMAP.md` | 当前工作树已被并发修改对齐（A/B 定义、`:48` Undo、`:50` 33 项、删掉 N 计算）；A0 必须 **commit/pin**，并在决策单里补一句 A/B 定义（“A = apply→persist→broadcast；B = persist→apply→broadcast”），防止回退。A0-owned，我不能改。 |
| C7 | 产品文案 | “恢复已应用；当前正文含并发/离线编辑，可能不等于所选版本原文”；提供 pre-restore / diff 入口；不编造 N。 |
| C8 | 命名 | 文档版本 restore vs 备份 `restoreBackup` / backup-cli `restore`；API 路径、日志、UI 文案都要区分，避免运维歧义。 |
| C9 | `vitest.config.ts` / 测试结构 | 把 restore 的关键断言放进 `pnpm test` gate；`tests/experiments/**` 只能作为设计证据，不能作为验收门禁。 |
| C10 | `docs/DECISIONS.md` | `D-RC1/D-RW1/D-OP1/D-V1/D-V2/D-UD1` 落成正式 Decision；A 的 store seam / version 表也需要一条 Decision（即使不改顺序）。 |

---

## 6. 结论

**GO WITH FIXES。**

- **对设计方向：** A 是正确方向。它保住了 `apply → persist → broadcast`、单一 FIFO、失败即断开的既有语义；它的问题是实现 seam 与步骤顺序，不是架构选择。
- **对 A 进入实现：** **v2 文本 GO；实现 NO-GO**，直到 §4 的 T1–T14 与 §5 的 C1–C10 落地（§3.1 的 8 条实现验收）。v1 的文本是 NO-GO（Q1/Q3）。
- **对 B：** **NO-GO**（A7 建议）。若 Owner 坚持，先写 Decision 记录 + 改 `CONTRACTS §14` + 补 poison-pill 测试；在此之前不能实现。
- **对产品语义：** Q4/Q5/Q6 的结论成立：不可 undo 是 R13 的自然推论；code-point 足够、grapheme 不阻塞；`betALPHA` 是 CRDT 合并而非目标原文，产品必须提示。
- **对证据：** 33/33 实验是有效的**设计证据**，但不是门禁证据，也不覆盖 SQLite / HTTP / WS / browser。任何“A 可用”的话都必须等到 §4 的测试在真实 store 上跑过。

---

## 7. 仍为 `NOT VERIFIED` 的项

1. 生产 restore path / queue 集成（没有代码）。
2. `DocumentStore` 单事务方法、sequence 复用（没有代码）。
3. 无人在线 / 最后一人离开 / evict 期间的 restore（没有代码）。
4. 两个并发 restore 的 409 行为（没有 API）。
5. 生产发起者的 undo 行为：实验是**客户端本地** restore transaction，不是服务端 apply 后广播；`authorReplicaAfterUndo = "base"` 不能外推到生产（Q4-4）。
6. `document_version` schema / migration / retention / GC（没有表）。
7. 真 SQLite 上的 op-id 重启幂等（实验没有 SQLite）。
8. grapheme 生产行为：我只做了 scratch 探针，没有进代码（Q5-2）。
9. browser/UI：版本列表、预览、恢复确认、并发提示（没有 UI）。
10. 33 项实验不在 `pnpm test` gate（`vitest.config.ts:36-42`）。
11. “join 的 empty update 会 bump revision”：我引用的是 `ARCHITECTURE.md:423-427` 与 `acceptance.test.ts:556-558` 的既有记载，没有本轮独立复现（Q1-6）。
12. store 失败时 HTTP 5xx 与 WS 1011 的组合行为（没有 API）。
13. pre-restore 版本在 compaction 后仍可 decode（没有实现）。
14. `D-082` 的备份/单实例约束与版本表的交互（没有实现；备份 `restoreBackup` 与版本 restore 是两件事）。

---

## 8. 附录：证据

### 8.1 实验运行（33/33，exit 0）

```text
$ node tests/experiments/version-restore.mjs
exit=0
checks=33 failed=0
merge: {"offlineBefore":"alpha","mergedText":"betALPHA","converged":true}
undo: {"otherReplicaAfterUndo":"restored","authorReplicaAfterUndo":"base"}
```

10 次重复：

```text
run 1..10 : merged=betALPHA conv=True undoOther=restored undoAuthor=base
```

### 8.2 嵌套事务探针

```text
$ node --experimental-sqlite -e "... db.exec('BEGIN IMMEDIATE'); db.exec('BEGIN IMMEDIATE') ..."
nested BEGIN rejected: cannot start a transaction within a transaction
```

### 8.3 Grapheme 探针（code-point 算法，4/4 逐字等于目标）

```text
family middle swap ok= true out= "a👨‍👦‍👧b"
family drop member ok= true out= "a👨‍👧b"
flag replace        ok= true out= "x🇺🇸y"
skin tone change    ok= true out= "x👍🏿y"
```

### 8.4 legacy 输出的 code unit 序列（P3-1 的证据）

```text
current "hello 😀" -> target "hello 😃"
prefix=7 suffix=0 remove=1 insert=\ude03
out= "hello �\ude03"
code units = ["68","65","6c","6c","6f","20","fffd","de03"]
```

### 8.5 关键文件/行号索引

| 主题 | 位置 |
| --- | --- |
| A 流程 / 记录数表 | `docs/ui/P0-RESTORE-DECISIONS.md:35-66` |
| B 流程 / 风险 | `docs/ui/P0-RESTORE-DECISIONS.md:68-87` |
| A7 待复核项 | `docs/ui/P0-RESTORE-DECISIONS.md:113-120` |
| 失败/离线/Undo 表 | `docs/ui/P0-RESTORE-DECISIONS.md:89-100` |
| 实验语义 | `docs/ui/VERSION-RESTORE-EXPERIMENT.md:8-85` |
| 实验代码 | `tests/experiments/version-restore.mjs:63-90, 125-134, 185-187, 195-206, 219-235` |
| durable pipeline | `apps/server/src/rooms/registry.ts:814-860` |
| fail-unhealthy | `apps/server/src/rooms/registry.ts:959-985` |
| append / sequence | `apps/server/src/persistence/sqlite-store.ts:283-309` |
| transaction primitive | `apps/server/src/persistence/transaction.ts:17-31` |
| store seam | `apps/server/src/persistence/types.ts:55-93` |
| room apply / broadcast | `apps/server/src/rooms/room.ts:440-459` |
| queue stop | `apps/server/src/persistence/serial-queue.ts:102-110` |
| CONTRACTS §14 | `docs/CONTRACTS.md:761-820` |
| CONTRACTS §6.5 | `docs/CONTRACTS.md:297-310` |
| ARCHITECTURE §7.8 | `docs/ARCHITECTURE.md:533-560` |
| D-044 / D-048 / D-052 | `docs/DECISIONS.md:1334-1360 / 1447-1466 / 1528-1545` |
| UI-ROADMAP 版本历史 | `docs/ui/UI-ROADMAP.md:18-65` |

---

## Next Handoff

Handoff Status: OWNER_DECISION_REQUIRED

Recommended Next Agent: A0

Base: main @ 1681193（工作树 dirty；进入实现前先 commit / pin 四个被审文件）

Why: v2（`58ACF277…`）已在文本上吸收 9 项 P1（FIFO slot、pre-restore 时点、content revision、staging clone、op-id 顺序、optimistic apply 禁止、lease、单事务、架构差异），但 store 单事务方法、HTTP wiring、lease 机制、`document_version` schema、op-id 表、API 契约与 T1–T14 仍未落地；B 需要 Owner 明确裁决。实现前不得跳过 §4/§5。另：UI-ROADMAP 的 A/B 标签与 Undo 表述已被并发修正但**未提交**，A0 必须先 commit/pin。

Dependencies satisfied: v2 设计文本（hash `58ACF2772E097652`）已吸收 P1；33 项实验是设计证据，不是门禁

Copy-paste Prompt:
在 `main @ 1681193`（或 pin 后的 commit）上，按 `docs/agent-governance/A7-restore-design-review.md` 的 §4/§5 实现 P0 版本恢复：先补 C1–C10（store 单事务方法、`document_version` schema、HTTP API、op-id 表、契约修订），再按 T1–T14 写测试；v2 的 §3.1 已吸收 P1，但实现必须逐条满足 8 条验收。把审查期间已并发修改的 `docs/ui/UI-ROADMAP.md`（A/B 定义、`:48` Undo、`:50` 33 项）commit/pin。B 在 Owner 明确选择前不得进入实现。
