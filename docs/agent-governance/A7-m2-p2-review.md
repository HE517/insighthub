# M2 Phase 2 · 独立终审报告（A7）

> 审查基座：`agent/a6-m2-phase2-browser-authz @ fee4f64`
> （= `13712c5` main + `e79d653` merge A3 + A6 浏览器证据）
> 本文件是 A7 分支 `agent/a7-m2-p2-review` 上**唯一**的改动。
> 审查方式：读代码 + 读契约 + **自己重跑四门禁**，不接受任何转述的绿。

---

## 0. 结论先行

**GO（放行合入 `main`，附 3 条必须随发布记录落地的条件）。**

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| 安全属性（服务端权威） | **成立** | A5 判定核心、A3 执行点、A6 浏览器证据三方互证；四门禁全绿 |
| P2-1…P2-9 验收矩阵 | **9/9 通过** | 6 条有浏览器实测（P2-1/2/3/4/5/9）；P2-6 按矩阵为 Node（403 由生产 handler 探针产生）；P2-7 由四门禁 + 场景计数承担；P2-8 由 grep 复核承担。见 §8 |
| 既有能力回归 | **无回归** | 36 个既有浏览器场景一个未少（§7.5），typecheck/test/build 全绿 |
| 冻结契约 | **合规**：版本 6 / 协议 2，改动有 D-061、D-062 授权前置 | 见 §9 |
| A6 是否放宽执行点 / 弱化断言 | **否** | `fee4f64` 未改任何生产文件（14 个文件全在 `tests/browser/**`）；新增场景断言与标题一致；续签两处已显式记录 |
| 未完成项 | **1 条真实缺口**：`room-joined.role` 有通道无消费者 → UI 门控不生效、viewer 本地分叉 | §5 F1、§11 裁定 4 |

**没有代码级阻塞。** 三条放行条件全是"记录与归属"性质（§11.2），不涉及再写一遍生产逻辑。
唯一真正的功能缺口（客户端不消费 role、不处理 `FORBIDDEN`、401 不重新 bootstrap）属于 **A1 + A2**，
不是本轮任何执行点的缺陷，但它**必须**写进发布说明，否则"权限门控已完成"会被误读。

---

## 1. 任务状态

| 项 | 值 |
| --- | --- |
| **Status** | **done**（终审完成，结论 GO；未 merge、未 push、未动 `main`） |
| **Branch** | `agent/a7-m2-p2-review` |
| **Worktree** | `D:\前端\react\项目\面试项目\Insighthub-wt-a7-m2-p2-review` |
| **审查 commit** | `fee4f64`（被审对象）；`main` 是其祖先，集成可 fast-forward |
| **本报告的 commit** | 本文件所在提交（`git log -1 --format=%h`）；提交内容无法包含自身哈希，故不写死 |
| **生产的改动** | **0**。A7 只写这一份报告，不改代码、不改契约、不动别人的 worktree |

---

## 2. 本轮目标

M2 Phase 2 的最后一关：在 A5（判定核心 + HTTP）、A3（WS 执行点 + `room-joined.role`）、
A6（浏览器证据 + 测试夹具）三条腿都落地之后，独立判断**它们是否互相印证**，
**P2-1…P2-9 是否每条都有其声称层级的真实证据**，**A6 有没有靠放宽执行点或弱化断言换取绿色**，
并给出可发布的 GO / NO-GO。本轮结束后应存在的事实是：M2 Phase 2 的授权闭环（HTTP + WS + 浏览器）
可被一个没有参与实现的人用命令复现，且已知缺口被逐条点名，而不是留在报告措辞里。

---

## 3. 完成了什么

- **三方互证复核**：把 A5 的判据、A3 的执行点、A6 的浏览器证据按**同一条断言**对齐（§8.2 表），
  确认 `SyncStep1=canRead` / `SyncStep2+Update=canEdit` 是"一处规则表 → 一个执行点 → 一次真实按键"的链条，
  不是三份互不引用的声明。
- **P2-1…P2-9 逐条定级**（§8.1）：明确哪条有浏览器实测、哪条只有 Node、哪条**在冻结词表下不可构造**。
  结论：6 条有浏览器证据（P2-1/2/3/4/5/9）；P2-6 为 Node（403 由生产 handler 探针产生）；
  P2-7 由四门禁 + 场景计数承担；P2-8 由 grep 复核承担；
  不可构造的是"无 `canRead` 的字面第三态"（同一 return 覆盖，另有可构造形态的 Node 测试）
  和"HTTP body 里塞 `userId`"（没有这样的端点）。
- **A6 五个待决点 + 六条未验证内容逐条裁定**（§11.1、§10），每条给"接受/不接受 + 归属 + 最小修复面"。
- **独立复核 A6 的改动范围**：`fee4f64` 只碰 `tests/browser/**`（14 个文件，见 §7.5）；
  场景数 36 → 44 且**既有 36 个一个未少**；新增 8 个场景的断言逐条读过，与标题一致；
  `m2/C` 与 `performance/5000` 的两处 `renewBrowserSession` 调用已核实是**同一件事的两次显式声明**，
  且被 `p2/S` 单独记录为限制。
- **四门禁实跑**（本轮由我执行，真实输出与退出码见 §7）：`typecheck` / `test` / `build` /
  真实浏览器 44/44，并且独立验证了"无遗留 Chrome、无遗留临时目录、无遗留句柄、端口已释放"。
- **发现 5 条 A7 独有 finding**（§5）：1 条真实功能缺口、1 条安全边界需契约澄清、
  1 条测试夹具语义陷阱、2 条记录质量问题。均**未被 A5/A3/A6 报告点名**。

---

## 4. 技术实现

### 4.1 数据流（谁是权威）

```text
insighthub_session cookie (HttpOnly, 进程内 12h)
  └─ authz.resolveSession(cookie) ──► userId        ← 唯一身份来源，payload/header/query 不参与
       └─ roleFor(documentId, userId) ──► DocumentRole   ← 唯一成员关系来源（authz.db）
            └─ documentCapabilities[capability](role) ──► boolean   ← 唯一规则表
                 ├─ HTTP: GET /api/documents[/:id]  → 401 / 404(三态合一) / 403 / 200
                 └─ WS:   升级 401 · join ROOM_NOT_FOUND · SYNC 写 FORBIDDEN · 读/awareness 放行
```

- **HTTP 侧（A5）**：`authorizeDocument()` 先解 session（`unauthenticated`）；再判
  `role === null || !canRead` → `not_found`（**同一行、同一个 return**）；随后才查文档元数据，
  元数据缺失 → **同一个 `not_found` 值**（`authz.ts` L228–241）。四个出口都不是 HTTP 层的判断，
  HTTP 只把 decision 翻译成状态码，所以三种"不该告诉你"的状态在结构上无法漂成三种响应。
  （精确边界：契约字面上的第三态"有成员关系但无 `canRead`"在冻结词表下不可达，见 §8.3 B1。）
- **WS 侧（A3）**：身份在 `server.on('upgrade')` 里解析后存 `WeakMap<IncomingMessage,string>`，
  从不进入帧读取路径（`ws.ts` L165/L206）；join 的两个失败分支（`authorizeJoin` 钩子与
  `#resolveJoinRole` 返回 null）**使用同一个字符串字面量**
  `'no room can be opened for this document'`（`registry.ts` L353–378）；BINARY 闸门在**生命周期门之前、
  任何 `await` 之前**（`registry.ts` L578–584），拒绝时直接 return，因此
  apply / persist / broadcast 三步一步都不会发生。
- **数据平面读写分离**：`#authorizeFrame` 用 `readSyncMessageType()` 区分
  `step1`（canRead）、`step2`/`update`（canEdit）、`awareness`（canRead）（`registry.ts` L714–758）；
  `room.replyToSyncStep1(frame, participant, canEdit)` 把"要不要向对端索要状态向量"
  绑定到 canEdit，所以 viewer 的握手**只收不发**，不会在每次 join 时制造一条注定被拒的 `FORBIDDEN`
  （`room.ts` L387–423）。
- **浏览器侧（A6）**：全部证据取自**页面自己**——`window.__qa.inboundControl/outboundControl`
  是真实收发的 TEXT 帧，`reconstructDurableDocument()` 直接重放 `insighthub.db` 的
  snapshot+log，cookie 用 CDP `Network.getCookies`（能看见 HttpOnly）与 `document.cookie` 对照。

### 4.2 生命周期

| 对象 | 创建 | 销毁 | 关键点 |
| --- | --- | --- | --- |
| session | `POST /api/session/bootstrap`（吊销同客户端旧 token） | 12h 过期 / `DELETE` / **进程退出** | process-scoped 是**限制**，不是安全属性 |
| membership | 启动时 `INSERT OR IGNORE` 种子 + 测试夹具落盘 | 无（无删除 API） | 重启后仍在（Node 有直证；浏览器侧是 `p2/S` 续签后写入成功所隐含，见 §8.3 A4） |
| socket 身份 | upgrade 时解析一次 | 随 socket | **不随 token 吊销而重算**（§11.1 裁定 2） |
| room | 首个被授权的 join | 最后一人离开 / 连接断开 / 关闭 | 失败 join 不动既有房间：门在所有 mutation 之前 |

### 4.3 设计选择与否掉的替代

| 选择 | 否掉的替代 | 否掉理由 |
| --- | --- | --- |
| 服务端 session → userId | 客户端声明 `userId` | 声明式身份让授权变成建议（D-061 §1） |
| `roleFor` + `can()` 同步、无 I/O | `await` 后再判定 | 判定与副作用之间出现窗口，答案可能已变（`membership-store.ts` L19–27） |
| 一个 `not_found` 值覆盖三种状态 | 三个不同错误码/文案 | 会泄露"文档是否存在"（§17.4/§17.5） |
| 每条 BINARY 帧重新问一次能力 | join 时缓存 canEdit | 角色可在连接期间改变（P2-5），缓存会把旧答案一直供应下去 |
| `authz.db` 与 `insighthub.db` 物理分离 | 在 A3 的库里加表 | 不耦合 schema、不与每次 keystroke 的 append 争写锁（`membership-store.ts` L5–17） |
| 测试夹具直写 `authz.db` + 校验表/列 | 生产加一个 seed 端点 | seed 端点等于改 §17.3（D-063 §2a 已否决） |

---

## 5. 发现并修复的问题

**本轮我修复了 0 个问题**——A7 的职责是判定与指派，不是顺手改。以下 5 条是**新发现**，
按严重度排序，每条给出五字段与归属（均**不阻塞本 Gate**，理由逐条写明）。

### F1（P2，真实功能缺口）`room-joined.role` 有通道、无消费者

| 字段 | 内容 |
| --- | --- |
| **Problem** | 服务端在 `room-joined` 里下发了 `role`，但客户端从未读取它：`documentRoleReceived` reducer 只有定义、全仓**没有任何 dispatch**（`grep` 唯一命中是 `documentSlice.ts:67` 的定义）。于是 `state.document.role` 恒为 `null`，`capabilityGate(null)` 按设计返回 `canEdit: true`，只读提示永不出现。viewer 在编辑器里打字时，文本会留在本地，服务端回 `FORBIDDEN` 后**本地文本不回收、界面无任何提示**。本轮实测证据：`p2/1` 的 evidence 里 `viewer local text still holds its own refused edit: {"containsRefusedText":true}`。 |
| **Root Cause** | D-062 决定 1 只派发了"**通道**"（`room-joined.role`，A3 实现），从未派发"**消费端**"（A1 把 role 暴露到 session/public，A2 dispatch 到 Redux 并用它门控）。A5 在 `features/permissions/**` 里留了正确的门控代码，但它等在一条没人接上的线上。 |
| **Impact** | 不影响安全属性：服务器不 apply / 不 persist / 不 broadcast，peer 看不到，socket 保持可读（这三条都已实测）。影响的是**诚实性**：用户以为写成功了。不是数据丢失，是"看起来保存了"。 |
| **Fix（建议，未执行）** | A1：provider 在 `room-joined` 上暴露 `role`（只读、schema 校验）；A2：`dispatch(documentRoleReceived(role))`，`capabilityGate.readOnly` 为真时切只读态，并对 `FORBIDDEN` 给出可见提示（或回滚本地未确认文本）。 |
| **Regression Test** | 目前**没有**：新增一个浏览器场景"viewer 页面在打字前就是只读的，或打字后出现可见拒绝提示"。在修复前它会红——这正是它该有的状态。 |

### F2（P2，安全边界需契约澄清）吊销/过期不追溯已建立的 socket

| 字段 | 内容 |
| --- | --- |
| **Problem** | `DELETE /api/session` 之后，同一 token 在 HTTP 与 WS 升级上都是 401（实测：`p2/5-session-revocation-is-everywhere` 两条路径）。但**已经打开的 socket 继续可写**：本轮实测 `an already-open socket after the revocation: {"writeApplied":true}`。12h 过期同机理（session 只在 upgrade 解析一次，帧门只查 membership）。 |
| **Root Cause** | 身份解析发生在 upgrade，每帧只问 `authz.can()`（查 membership）。契约 §17.2 的"everywhere"说的是**请求**，已建 socket 不是请求；§17.5 也没说吊销要断连。所以这是**契约留白**，不是实现违约。 |
| **Impact** | 在一个真实产品里属于"吊销不彻底"：被撤销的客户端最多还能写到 socket 断开为止。当前没有 token 泄漏路径（§8.1 P2-9 全绿），所以现实暴露面小，但语义模糊会一路带进 M3。 |
| **Fix（建议，未执行）** | 二选一，**由 A0 定**：(a) 一行契约澄清"吊销/过期对外发起的请求立即 401；已建立的 socket 在关闭或心跳失败前仍按其身份工作"（成本最低，需 D-064）；(b) A3 在 `revoke` 时关闭该 token 的 socket，或在帧门重解 session（更贵，会引入每次按键一次 session 查找）。 |
| **Regression Test** | `p2/5b` 已把该行为**记录**为 note 而非断言——这是对的（断言一个未冻结的语义等于私自定契约）。定契约后：若选 (a) 加一条断言固化"仍可写"，若选 (b) 加一条断言"已断开"。 |

### F3（P3，测试夹具语义陷阱）`role: null` 并不阻止夹具写入 membership

| 字段 | 内容 |
| --- | --- |
| **Problem** | `run.mjs` 的 `newAppPage({ role })` 文档承诺 `null = 不碰 membership（场景自己管理）`，但同一函数随后调用的 `setDocumentId()` **无条件**执行 `grant(documentId, identity, 'owner', { ifAbsent: true })`（`lib/app.mjs` L112–113）。实测证据：本轮 8 个 P2 场景里每处 `role: null` 的页面都留下了一行 `authz fixture: kept-existing … (requested owner)`。今天**没有任何场景被它破坏**——因为相关 `(document, identity)` 要么有种子行、要么场景已显式 `grant` 过——但"没有播种就会静默得到 owner"这条路径是活的。 |
| **Root Cause** | "谁来安排访问"的责任被两个文件各实现了一半：`run.mjs` 用 `role` 参数表达意图，`app.mjs` 的 `setDocumentId` 用"总是 ifAbsent 补一行"保证旧场景能进房。两者没有共享同一个意图标志。 |
| **Impact** | 不影响本轮任何断言（我逐场景核对过 8 个 P2 + 3 个被改的既有场景）；影响**未来**编写"完全没有成员关系"的负向场景——那时它会先失败（红），不会静默通过，所以是"会浪费一次排查"而不是"会掩盖缺陷"。 |
| **Fix（建议，未执行）** | 让意图下行：`setDocumentId(page, id, { arrangeAccess })`，`newAppPage` 把 `role === null` 翻译成 `arrangeAccess: false`；或在 `grant` 里区分"夹具安排"与"场景声明"的来源标签并在 evidence 里分开打印。 |
| **Regression Test** | 一条 harness 自测："`role: null` 的页面打开一个全新文档后，`authz.db` 里没有该 (document, user) 行"。 |

### F4（P3，可读性）A3 两个文件的注释与测试标题是乱码

| 字段 | 内容 |
| --- | --- |
| **Problem** | `apps/server/src/rooms/authz-enforcement.test.ts`（文件头、每节标题、若干断言消息）与 `apps/server/src/persistence/restart.test.ts`（多处注释）里的中文/符号是 UTF-8 被按 GBK 解释后的残留：`§17.5` 变成 `鎼?7.5`、`→` 变成 `閳?`、`caller's` 变成 `caller閳ユ獨`。这些是**注释、文件头与 `describe`/`it` 标题**，机器判定不受影响（180/180 通过、标题照常打印）。 |
| **Root Cause** | 写入时的编码链错误（非本文件逻辑问题）；`git` 不做编码校验，typecheck 与测试也不会读注释，所以一路无人拦下。 |
| **Impact** | 审查成本与可维护性：后来者读这两份最关键的授权测试时，最需要读的部分（"这条断言为什么存在"）恰好不可读。 |
| **Fix（建议，未执行）** | A3 单独一次提交重写这些字符（`→`、`§`、`'s`），**一行断言都不动**；提交后 `git diff` 应只含注释/字符串字面量。 |
| **Regression Test** | 不需要测试；用 `.gitattributes`/编辑器配置保证 UTF-8 即可。若要防止复发，可在 `pnpm typecheck` 前加一个"仓库内不得出现 U+FFFD 与常见 GBK 残留字符"的检查（可选，非必须）。 |

### F5（P3，记录一致性）TASKS 的 A3 ownership 行与 D-062 决定互相矛盾

| 字段 | 内容 |
| --- | --- |
| **Problem** | `docs/TASKS.md` Phase 2 Ownership 表把 `packages/shared/**` 列在 **A3 的 Do Not Touch** 里，但 D-062 §1 与 §17.8 明确把 `RoomJoinedPayload.role` 与 `SHARED_CONTRACT_VERSION` 5→6 交给 A3 实现，A3 也确实改了（`a4a20ba`：`protocol.ts` +15、`index.ts` +14）。D-063 §4 只点名了 `apps/web/.../test-server.ts` 这一处越界，没有提 `packages/shared`。 |
| **Root Cause** | 决定记录（D-062）先行、派发单（TASKS）未回填。冻结契约的实际修改是**有授权的**（决定 + 版本号 + 提交信息齐全），坏在"派发单说不行、决定说行"。 |
| **Impact** | 治理面：下一个 agent 读 TASKS 会以为自己不能碰 shared，或者反过来以为可以随手改。不影响代码与门禁。 |
| **Fix（建议，未执行）** | A0 在 TASKS Phase 2 Ownership 表里给 A3 增补一行 `packages/shared/src/protocol.ts`、`index.ts` + 对应测试（按 D-062 §1 授权），或在 D-063 补一条具名例外。 |
| **Regression Test** | 不适用（文档一致性）。 |

### 另外两条**非缺陷**但必须记录的现象

- `#recordDocumentMeta` 是 fire-and-forget：元数据写失败时，文档仍可被 WS 读，只是不出现在
  `GET /api/documents` 里。这是"可见的退化"而非静默错误（`registry.ts` L386–392 已写明）。
- `document_meta` 只在"房间首次创建"时入库：Phase 2 之前就有内容、但此后无人 join 的旧库文档，
  在有人重新 join 前不会出现在列表里（D-063 §5 已记录）。

---

## 6. Files Changed

| 文件 | 职责 |
| --- | --- |
| `docs/agent-governance/A7-m2-p2-review.md`（新增） | 本报告的载体：结论、证据、裁定、交接。它是 A7 分支上**唯一**的改动，用来让"A7 审过什么"变成可引用的仓库事实，而不是聊天记录。 |

**生产代码 0 改动，测试 0 改动，契约 0 改动。** 这本身是终审该有的形状：
发现问题就指派，不自己下场改别人的范围（`agent-prompts/A7-integration-review.md` §2）。

---

## 7. Tests / Validation

所有命令都在被审 worktree `Insighthub-wt-a6-m2-p2-browser`（HEAD = `fee4f64`，工作区干净）里由我执行。
运行时：**Node v24.21.0**（本机 DSH 运行时自带；A6 自己那轮用的是 v22.14.0，两轮结论一致）。
四门禁**串行**跑，避免 build 输出与浏览器套件抢 `packages/shared/dist`。

以下均为**真实输出的节选**（`…` 表示省略，省略的只是重复的逐条 PASS 行与长标题，结论行是原文）。
完整日志在本轮运行时留在**仓库之外**，可复查：
`…\面试项目\a7-gate-{typecheck,test,build,browser}.log`；浏览器逐场景证据见
`tests/browser/artifacts/results.md`（gitignored，本轮由我这次运行生成，`Generated: 2026-10-20T05:29:27.265Z`）。

### 7.1 `pnpm typecheck`

```text
> insighthub@0.0.0 typecheck D:\前端\react\项目\面试项目\Insighthub-wt-a6-m2-p2-browser
> pnpm -r typecheck

Scope: 3 of 4 workspace projects
packages/shared typecheck$ tsc -p tsconfig.json --noEmit
packages/shared typecheck: Done
apps/server typecheck$ tsc -p tsconfig.json --noEmit
apps/web typecheck$ tsc -p tsconfig.json --noEmit
apps/server typecheck: Done
apps/web typecheck: Done
EXIT=0
```

### 7.2 `pnpm test`

```text
> vitest run && pnpm --filter @insighthub/server test
 Test Files  31 passed (31)
      Tests  344 passed (344)
   Duration  5.93s
...
> @insighthub/server@0.0.0 test
> tsx --test --test-concurrency=1 "src/**/*.test.ts"
ℹ tests 180
ℹ suites 63
ℹ pass 180
ℹ fail 0
ℹ duration_ms 35459.3596
EXIT=0
```

**这门禁自己退出了**（35.5 s，无 `--test-force-exit`）：TOOLING-P2 的修复（`--test-concurrency=1`）
在我这轮复现为"必定退出"，不是"卡住但结果全打印"。

### 7.3 `pnpm build`

```text
> pnpm --filter @insighthub/shared build && ... server build && ... web build
vite v7.3.7 building client environment for production...
✓ 1563 modules transformed.
dist/index.html                          0.52 kB
dist/assets/index-NWlNhOkJ.css           4.51 kB │ gzip:   1.79 kB
dist/assets/y-indexeddb-DbShe-c3.js      2.91 kB │ gzip:   1.27 kB
dist/assets/index-DKBf9LX3.js        1,408.09 kB │ gzip: 458.19 kB
✓ built in 18.99s
EXIT=0
```

（`chunk > 500 kB` 是既有告警，对应 backlog 里的"主 bundle 分块"，与本轮无关。）

### 7.4 `node tests/browser/run.mjs`

```text
preflight: ports must be free (the suite runs serially)
  5173, 3101 free
starting the dev stack…
  web http://127.0.0.1:5173/
  backend http://127.0.0.1:3101
launching the browser…
  Chrome/155.0.8059.80 (C:/Program Files/Google/Chrome/Application/chrome.exe)
[PASS] p2/1-viewer-cannot-write … (3725 ms)
[PASS] p2/2-identity-cannot-be-self-declared … (4905 ms)
[PASS] p2/3-non-disclosure-404 … (694 ms)
[PASS] p2/4-role-capability-consistency … (7296 ms)
[PASS] p2/5-role-change-is-re-evaluated … (5945 ms)
[PASS] p2/5-session-revocation-is-everywhere … (11359 ms)
[PASS] p2/9-token-not-exposed-to-js … (477 ms)
[PASS] p2/S-session-scope-after-restart … (26938 ms)

scenarios: 44 · passed 44 · failed 0 · errored 0
report: …\tests\browser\artifacts\results.md

postflight:
  ports 5173, 3101: released
  temporary data directories removed: 11
  live handles after teardown: none (the process exits on its own)
EXIT=0
```

**独立的遗留检查**（不依赖 postflight 的自述，我自己再查一遍）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 遗留临时目录 | `Get-ChildItem D:\dev-temp -Directory -Filter 'insighthub-a6-run-*'` | **无**（11 个已删） |
| 遗留浏览器 | `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` 过滤 `--user-data-dir` | **无测试实例**；只剩用户自己 Chrome 的 crashpad-handler（PID 6960，`…\Google\Chrome\User Data`，13:13 启动，与套件无关） |
| 端口 | `Get-NetTCPConnection -LocalPort 5173,3101 -State Listen` | **无监听** |
| 句柄 | 套件自报 + 退出自然发生（没有 forced exit 分支触发） | **none** |

**关于 `artifacts/results.md` 的一处诚实说明**：该文件是 **gitignored、每次运行重写**的产物。
我开工时读到的是 A6 那一次（`Generated: 2026-10-19T13:16:49Z`，`node v22.14.0`，44/44，Chrome 155），
跑门禁后它被**我这一次**的运行覆盖（`Generated: 2026-10-20T05:29:27Z`，`node v24.21.0`，44/44）。
因此本报告引用的逐场景证据来自我这次独立运行；它与 A6 的那次**互不依赖且结论一致**（同为 44/44、0 fail、0 error），
这恰好也是"A6 的数字可复现"的证据。原文差异（node 版本）不改变任何判定。

### 7.5 静态与结构证据（"没被放宽"是查出来的，不是信出来的）

**A6 的改动面**（`git show --name-only --format= fee4f64`，14 个文件）：

```text
tests/browser/README.md
tests/browser/instrument/page-instrument.js
tests/browser/lib/{app,authz-fixture,cdp,chrome,durable-store,oracle,wire-socket}.mjs
tests/browser/run.mjs
tests/browser/suite/{05-performance,07-robustness,10-m2-durability,20-m2-phase2-authz}.mjs
```

**零生产文件。** `apps/**`、`packages/**` 一行未动 ⇒ A6 在物理上不可能放宽执行点
（它既没改 `ws.ts`/`registry.ts`，也没改 `authz/**`）。剩下唯一可能的"放宽"是**夹具让执行点不被触发**，
这一项用 §8.2 的互证表和下面的场景计数回答。

另外两条结构性事实：**`tests/browser/lib/harness.mjs` 未被修改**（断言实现本身一字未动，
不可能全局放松阈值/比较方式）；新增 8 个场景**没有 `knownDefect` 标签、没有 skip/todo/only**
（`grep` 命中的 `knownDefect` 全部是 `harness.mjs`/`run.mjs` 里处理该机制的既有代码）。

**场景数（`runner.scenario(` 逐文件计数，`e79d653` vs `fee4f64`）**：

| 套件 | 之前 | 之后 |
| --- | --- | --- |
| 00-smoke | 1 | 1 |
| 01-persistence | 4 | 4 |
| 02-editor | 6 | 6 |
| 03-realtime | 6 | 6 |
| 04-chaos | 5 | 5 |
| 05-performance | 2 | 2 |
| 06-lifecycle | 2 | 2 |
| 07-robustness | 1 | 1 |
| 10-m2-durability | 9 | 9 |
| 20-m2-phase2-authz | 0 | **8** |
| **合计** | **36** | **44** |

**断言与标题一致性（新增 8 条，逐条读过代码）**：

| 场景 | 标题声称 | 实际断言（代码位置） |
| --- | --- | --- |
| `p2/1` | FORBIDDEN 在浏览器里、不入库、peer 看不到、socket 继续可读 | 真实 `Input.insertText` → 等 `FORBIDDEN`；`liveDocumentSockets>=1` 且 socket 数不变且无 1008 关闭；durable 尾不含该文本；owner peer 文本不含；owner 后续编辑仍到达 viewer（`suite/20…mjs` L168–230） |
| `p2/2` | payload/query/header 的 `userId` 与 `mode=readwrite` 都不改变结论 | 客户端自己的 join 确实带 `mode:readwrite`（先证明"线上真有这个 claim"）；注入 `userId` 后 `room-joined.role` 仍是 `viewer`；仍被 `FORBIDDEN`；query+header 的 oracle 同样 `viewer` 且被拒；HTTP 带 claim 时 `/api/session` 仍是 `demo-linus`（L274–406） |
| `p2/3` | 未知文档与无权文档 404 完全一致；无 session 401 | 页面自己的 `fetch`：`anonymous=401`、`unknown=404`、`notMember=404`、`mine=200`；两个 404 的 **body 逐字节相等** + header 集合深度相等（仅排除 `date`）；Node 侧再比一遍；列表不含无权文档（L461–529） |
| `p2/4` | 同一角色在 capabilities/HTTP/join/frame/role 五处同答 | owner/editor/viewer 三行表格，每行 6 个断言（join 被接收、HTTP 与 canRead 一致、`room-joined.role` 与 membership 一致、frame 结果与 canEdit 一致、persisted/broadcast 与 canEdit 一致、浏览器真实按键结果与 canEdit 一致）（L647–702） |
| `p2/5a` | 降职被拒、升职被接受，都不重连 | 浏览器：editor 写入成功 → `grant` 改为 viewer → 下一次按键 `FORBIDDEN` 且不入库、socket 数不变、旧写入仍在；oracle 同一 socket：viewer 时 update 被拒，`grant` 为 editor 后同一 socket 写入入库并被广播（L743–833） |
| `p2/5b` | 吊销后同 token 处处 401 | `DELETE`=204；`GET /api/session`=401；文档 API=401；升级经 Vite 代理与直连后端**两条路径**都 `refused` 且 `status=401`；另一个新 session 仍能连（排除"服务器坏了"）；页面自己吊销后 200→204→401（L867–976） |
| `p2/9` | cookie 在浏览器里但 JS 读不到，body/存储/日志都没有 token | CDP 读到 cookie 且 `httpOnly=true`/`path=/`/无毒 `secure`；`document.cookie`/localStorage/sessionStorage 均不含；`/api/session` body 键恰为 `displayName,expiresAt,userId`；bootstrap body 同样三键且不含 token 且 `Set-Cookie` 对脚本不可见；服务端日志不含 token；轮换后新 token 仍 HttpOnly（L1011–1146） |
| `p2/S` | 记录重启对 session 的影响，续签后能写 | 重启前 200 → 重启后 401（HTTP 与升级）；20 s 采样 `statusesObserved=["reconnecting"]`、`connectedAtAnyPoint=false`、`reBootstrapped=false`；续签后回到 `connected` 且写入入库（L1175–1246） |

**两处续签调用（`m2/C`、`performance/5000`）**：`git show fee4f64 -- …` 确认各**只加一行**
`await ctx.authz.renewBrowserSession(...)`，都带注释说明"续签是为了让本场景的主题（耐久性 / 5000 行不重挂）
可测，而不是在测会话恢复"，且 `p2/S` 单独把客户端不自愈记录为限制。
**判定：不是弱化断言，是缩小场景主语**——但因此 `m2/C` 的绿**不能**被读成"客户端重启后自愈"。

---

## 8. Acceptance Criteria

### 8.1 逐条判定

| # | 判据 | 声称证据层 | 本轮我确认的证据层 | 判定 |
| --- | --- | --- | --- | --- |
| **P2-1** | viewer 发送 SYNC update：不 apply / 不 persist / 不 broadcast；发送方收 `FORBIDDEN`；第二个 peer 看不到；socket 仍收他人更新 | browser | **browser**（`p2/1`，真实按键 + 浏览器收到的 error 帧 + durable 字节 + owner 后续编辑到达）+ Node 因果补充 | **PASS** |
| **P2-2** | payload / API body / header / query 里塞 `userId` 全部无效；`mode=readwrite` 无效 | Node + browser | **browser + Node**（`p2/2`；HTTP 的"body"无适用端点，见 8.3） | **PASS** |
| **P2-3** | 无 session = 401；未知 / 无成员 / 无 `canRead` 三者完全相同；capability 不足才 403 | Node | **browser（超出要求）+ Node**（`p2/3` 两个 404 逐字节相等；字面第三态不可构造，但由同一 return 覆盖，另有"成员关系在、元数据缺"的可构造形态被 Node 测试覆盖，见 8.3 B1） | **PASS** |
| **P2-4** | 同一角色在 API / WS join / WS frame / capabilities 四处同答 | Node | **browser + Node**（`p2/4` 五处 + 浏览器真实按键；`capability-matrix.test.ts` 四能力 × 四角色） | **PASS** |
| **P2-5** | 角色变更后重新判定；重启后成员关系仍在；`DELETE` 后同 token 处处 401 | browser + Node | **browser + Node**（`p2/5a`/`p2/5b`/`p2/S`；Node `membership durability` 两条） | **PASS**（附 2 条边界，见 8.3） |
| **P2-6** | `canManageMembers` 仅 owner；editor 调成员相关能力 = 403 | Node | **Node**（`capability-matrix.test.ts` 用**生产 handler** 参数化到 `canManageMembers`，403 是真实输出；没有成员管理端点，故用探针路由——已在其文件头说明） | **PASS** |
| **P2-7** | 四门禁全绿；M1 + M2-P0 既有场景一个不减 | 全部 | **四门禁实跑 + 场景计数表**（36 → 44，既有 36 一个未少） | **PASS** |
| **P2-8** | 不出现被禁措辞；bootstrap 不得被描述为 password auth | grep + A6 | **grep 复核**：`防止跨用户冒用` / `跨用户冒用` / `无密码用户名登录` / `passwordless login prevent` 共 7 处命中，**全部**落在三张"禁止清单"自身（`CONTRACTS` §17.0 L806–810、`DECISIONS` D-061 §2 L1992/L1997、`TASKS` D-061 原文 L468 与 P2-8 条目 L521）——P2-8 自己给了这个豁免。UI 文案（`session-identity`、`M2 Permissions · …`）无冒用暗示。 | **PASS** |
| **P2-9** | `document.cookie` 读不到；token 不在任何 JSON body / 日志 / Redux / localStorage / awareness；bootstrap body 不含 token | browser + Node | **browser + Node**（`p2/9` 六项；Node `http-session.test.ts` "appears in no response body"）。awareness 未单独验证（见 8.3） | **PASS** |

### 8.2 三层互证（A5 判据 ↔ A3 执行点 ↔ A6 浏览器）

同一条断言在三个位置被独立实现/观测，且**指向同一个答案**：

| 断言 | A5（判据） | A3（执行点） | A6（浏览器实测） |
| --- | --- | --- | --- |
| `SyncStep1` 只要 `canRead` | `can(...,'canRead')`（`authz.ts` L213–218） | 闸门 L744–748 放行；`replyToSyncStep1(...,canEdit)` 对 viewer **不发**服务端 step1（`room.ts` L417–421） | `p2/1`：viewer 页面渲染出既有内容；`p2/4`：viewer join 被接收且 HTTP 200 |
| `SyncStep2`/`Update` 要 `canEdit` | 同上 | 闸门 L750–757；拒绝发生在 `#dispatchDecodedFrame` 之前 ⇒ 不 apply/persist/broadcast | `p2/1`：`FORBIDDEN` 帧 + durable 尾未变 + owner 未收到 + 无 1008 关闭；`p2/4`：viewer 按键不入库、editor/owner 入库且被广播 |
| join 拒绝与"文档不存在"同码同文案 | `roleFor` 返回 null ⇒ 一个 `not_found` 值 | 两个失败分支同一个字面量（L353–378）；判定在一切 mutation 之前 | 仅 Node（`authz-enforcement` L202–220 断言 `code` **与** `message` 都相等）；浏览器侧只断言 `room-joined.role`，**没有**替这条背书 |
| 失败 join 不驱逐既有房间 | — | 门在 `#detach` 之前（L371–401），因此"原子替换只属于成功 join" | 仅 Node（L222–243：observer 看到 peers 仍是 1，且 mover 仍能写原房间） |
| `room-joined.role` 仅 UI 门控、无权威 | `roleFor` 的返回值 | 只写进 `room-joined`（`ws.ts` L281–287）；**从不读取**客户端上行的 role（无相应字段与代码路径） | 浏览器读到自己那一帧 `role`（`p2/1`/`p2/2`/`p2/4`）；**且客户端全仓无消费者**（F1），故"改它只能改自己看到什么"在本轮是空集——服务端根本不接这条上行 |

结论：三者**互相印证**，不是各说各话。特别地，"SYNC 读写分离"这条最有价值的结论
（D-063 §1/c 的契约勘误）在三层都有独立落点：A5 提供 `can`，A3 按消息类型分档，
A6 在真实浏览器里用一次真实打字把它证伪/证实。

### 8.3 证据层边界（必须写进结论的三类）

**A. 仍然只有 Node 证据（不得读作浏览器证据）**

1. **join 拒绝与"文档不存在"同码同文案** —— Node 断言了 code 和 message 都相等；浏览器套件没有这条。
2. **失败 join 不驱逐既有房间** —— 只有 Node。
3. **P2-6 的 403** —— Node，且是用**生产 handler**加探针路由"参数化"出来的 403（Phase 2 没有成员管理端点，
   `§17.3` 禁止为了制造 403 而新增端点）。这条按验收矩阵本就声明为 Node，**不构成缺口**，但它是"能力表的 403"，
   不是"某个真实端点拒绝 editor"。
4. **重启后成员关系仍在** —— Node 有直证（`membership durability — survives a process restart`）；
   浏览器侧是**隐含证据**（`p2/S` 续签后写入成功，而写需要 owner 的 `canEdit`），严格说是"推断"而非"直证"。

**B. 在冻结词表/协议下不可构造（A6 已记录，我复核确认不可构造）**

1. **`§17.4` 的第三态（成员关系存在但 `canRead` 不成立）** —— `DOCUMENT_ROLES` 里**每个角色都能读**
   （`p2/3` 现场算了一遍 `readDeniedRoles.length === 0` 并写进 evidence）。要造出来必须新增一个"不能读"的角色，
   那等于改冻结词表。精确的说法是：
   - **代码覆盖了它**：该判断与 `role === null` 共用同一个 `return { kind: 'not_found' }`，因此它**无法**回答成别的值；
   - **测试覆盖了一个不同的、可构造的第三态**："成员关系存在、但 catalog 描述不了这个文档"
     （`authz-core.test.ts` L255–307：`DemoDocumentCatalog` 里删掉 `demo-document`，ada 仍持有 owner 行，
     结果必须是 `not_found`，并且**不得凭空编造 metadata**）；
   - **现场（浏览器/HTTP）只能构造两个状态**：未知文档、无成员关系。所以 `p2/3` 的"404 逐字节相等"
     是对**两个真实可达状态**的证明，"三态合一"的第三态是结构保证 + 另一种可构造形态的 Node 测试，
     两者都已落在结论里，不靠"看起来应该一样"。
2. **"HTTP body 里塞 `userId`"** —— Phase 2 没有任何接收 body 的授权端点（`bootstrap` 收的是 `demoUserId` 声明，
   且被 roster 白名单约束）。P2-2 的 body 项只在 bootstrap 上成立，其余载体是 query/header/payload。
3. **`SyncStep1`/`AWARENESS` 的 `canRead` 否定分支** —— 进不了房就发不了帧，正常流程不可达，属防御性代码（D-063 §5）。
4. **已打开 socket 上的吊销** —— 契约未覆盖（F2）。

**C. 只在浏览器里能证明的（Node 无法替代）**

`p2/3` 的 404 逐字节相等（页面自己的 fetch 穿过 Vite 代理）、`p2/9` 的 HttpOnly 与存储可见性、
`p2/1` 的"真实按键 → 浏览器收到 `FORBIDDEN`"、`p2/5a` 的"同一 socket 上降职立即生效"。

---

## 9. 与其它 Agent 的集成关系

| 关系 | 内容 |
| --- | --- |
| **依赖谁** | A5：`authz/public.ts`（`resolveSession` / `roleFor` / `can`）与 `authorizeDocument` 的三态合一——A3 只 import 这个文件，没读 A5 的私有实现（`registry.ts` L64 只 import `type AuthzService`）。A3：WS 执行点与持久化元数据源。A1/A2：客户端身份（bootstrap）与 `room-joined.role` 的消费面。 |
| **谁依赖我** | A0 的集成决策（是否按本报告 GO 合并）、M2 发布说明的措辞（F1/F2 必须写进去）、下一阶段（Phase 2.5/M3）的任务拆分（F1/F2/F3）。 |
| **我触及的公共面** | **无**。只新增一份文档。 |
| **契约是否变化** | 本轮**没有**新增变化。被审区间内的变化是既有的、已授权的：`WS_ERROR_CODES.FORBIDDEN`（A5，v4→5，D-061）、`RoomJoinedPayload.role`（A3，v5→6，D-062 §1 / §17.8）、`§17.5` 的 SYNC 读写分离**勘误**（A0 写进契约，D-063 §1/c 记录"A3 是对的、契约写错了"）。`PROTOCOL_VERSION` 保持 2。 |
| **集成拓扑** | `main(13712c5)` 是 `fee4f64` 的祖先 ⇒ A6 分支合入 `main` 可 fast-forward，不存在冲突窗口（与 D-063 §3 的"避免红窗口"策略一致）。 |
| **越界与具名例外** | A3 改了 `packages/shared/**`（有 D-062 授权，但 TASKS 的 Do-Not-Touch 未回填 → F5）；A3 改了 `apps/web/src/collab/tests/support/test-server.ts`（D-063 §4 已具名）。A6 只改 `tests/browser/**`（已核）。A7 只写报告。 |

---

## 10. Known Risks / 未验证内容

> 说明：A6 的报告本身**没有入库**（它在会话中交付，仓库里只留下 commit message、README、
> `artifacts/results.md` 三处落点）。因此下面按 **A6 在仓库内留下的对照物**复述"六条未验证内容"并逐条裁定；
> 若 A6 报告的 §10 条目措辞不同，裁定标准与结论不因此改变（每条都给了"能不能接受"和"归谁"）。

| # | 未验证 / 仅记录的内容 | 我在本轮观察到的事实 | 裁定 |
| --- | --- | --- | --- |
| 1 | **viewer 本地分叉**（被拒后客户端本地文本保留） | `p2/1` evidence：`containsRefusedText: true`（我这轮实测同样是 true） | **接受为已知缺陷**（F1）。不是安全缺陷：服务端、durable store、peer 三处都没有这段文本。归属 **A2**（只读态/提示/回滚）+ **A1**（role 通道）。 |
| 2 | **吊销不追溯既有 socket** | `p2/5b` evidence：`writeApplied: true` | **不接受为"安全属性"**，接受为**待定契约**（F2）。必须由 **A0** 在 D-064 里定"everywhere 是否含已建 socket"；实现改动归 **A3**。 |
| 3 | **重启后是否续签 / 客户端是否自愈** | `p2/S`：`reBootstrapped=false`、`statusesObserved=["reconnecting"]`、`connectedAtAnyPoint=false`；harness 续签后恢复 | **接受为 Phase 2 限制**：客户端的 401 重 bootstrap 不存在。归属 **A1**（provider）+ **A2**（接线）。**硬约束**：不得把 `m2/C`/`performance/5000` 的绿读成会话恢复。 |
| 4 | **`room-joined.role` 未接 UI** | `documentRoleReceived` 无 dispatch（全仓 1 处定义、0 处调用）；`capabilityGate(null)` 返回 `canEdit:true` | **接受为未完成项**（F1 的另一半）。D-062 决定 1 只交付了通道。归属 **A1 + A2**，并建议 A0 把它从"隐含"提为**显式任务**（不是 backlog 注释）。 |
| 5 | **`authz.db` 不随文档删除级联** | Phase 2 无删除 API ⇒ 当前不可观测（`membership-store.ts` L15–17 已写明） | **接受**。约束：将来引入删除 API 的那一次改动**必须**同时处理级联或改为软删，且要有测试。归属 **A3**（删除实现方）。 |
| 6 | **Node-only 的断言不得当浏览器证据** | 见 §8.3 A 组四条 | **接受为证据层事实**。发布说明与后续报告**不得**把"join 同码同文案 / 失败 join 不驱逐 / P2-6 403"写成浏览器验证。 |

**其它已知风险（非本轮引入，随基线进入下一阶段）**

- 跨浏览器未验证（Firefox/Safari）；真实多机弱网未做（backlog）。
- 主 bundle 1.41 MB（gzip 458 kB），已有分块 backlog。
- `synchronous = FULL` 仍硬编码 `NORMAL`（D-060 §2 勘误）。
- 文档元数据只在"首次 join"入库（D-063 §5）：旧库里"有内容但此后无人 join"的文档在列表里不可见。

**我没有验证的内容**（诚实边界）：Firefox/Safari；`authz.db` 的并发写压力（夹具是单写者）；
恶意 Yjs update 的语义攻击面（本轮只覆盖类型/权限门，不做 CRDT fuzz）；A1/A2 的 401 恢复路径
（不存在，所以无从验证）；生产环境 TLS 下 `Secure` 属性的实际下发（只有 `p2/9` 断言了 plain-HTTP 下**不**下发）。

---

## 11. Need Supervisor Decision

### 11.1 A6 报告的 5 个待决点（逐条裁定）

| # | 待决点 | 裁定 | 理由与归属 |
| --- | --- | --- | --- |
| 1 | **重启后续签的可接受性** | **接受（有条件）** | 续签发生在 harness，不是客户端能力；`p2/S` 已用实测记录"页面永不回到 connected、0 次重新 bootstrap"。门禁的"重启"场景因此只测持久化与收敛，不测会话恢复。条件：发布说明必须写明"重启后需重新 bootstrap（客户端尚未实现）"，且 `m2/C`/`performance/5000` 的绿不得被引用为客户端自愈。归属 **A1 + A2**。 |
| 2 | **吊销不追溯** | **接受为待定契约，不接受为安全属性** | 实测已建 socket 在 `DELETE /api/session` 后仍能写入（同一机理也覆盖 12h 过期）。§17.2 的"everywhere"仅覆盖请求。**需 A0 二选一**：契约澄清（推荐，一行 + D-064）或 A3 实现"吊销即断连/每帧重解"。 |
| 3 | **viewer 本地分叉** | **接受为已知缺陷，非安全缺陷** | 服务端拒写在副作用之前；本地文本保留是客户端行为。归属 **A2**（提示/回滚/只读态）+ **A1**（role）。**不得**表述为"viewer 能改文档"。 |
| 4 | **`room-joined.role` 未接 UI** | **接受为未完成项，需显式派发** | 通道侧（A3）已交付且被浏览器实测；消费侧（A1/A2）从未派发。这是一个**计划缺口**，不是实现缺陷。建议 A0 在 TASKS 增一条 Phase 2.5 任务，并把 `capabilityGate` 的现有实现作为验收点。 |
| 5 | **`authz.db` 不级联** | **接受** | 无删除 API ⇒ 不可观测。约束写进 §10 表：引入删除能力的改动必须同时处理。归属 **A3**。 |

### 11.2 发布建议（Release Recommendation）

**1. 结论：GO —— 放行合入 `main`（有条件）。**
安全属性成立、验收矩阵 9/9、四门禁全绿、36 个既有场景无减少、A6 未触碰任何生产文件、
`main` 是 `fee4f64` 的祖先（可 fast-forward）。合并动作归 **A0**；A7 不 merge、不 push、不动 `main`。

**2. 放行条件（严重级别见下表；没有一条阻断合入 `main`，B1/B2/B3 阻断 **M2 关闭与本 Gate 的发布说明**）**

| # | 项 | 严重级别 | 归属 | 修复后如何验证 |
| --- | --- | --- | --- | --- |
| B1 | 发布说明**不得**声称"UI 权限门控已生效"或"吊销立即生效"；把 F1、F2 与 §10 的限制写进 M2 发布记录（建议新增 D-064） | **P1（诚实性）** | **A0** | 文档 review：发布说明出现这两句话即退回；D-064 必须逐条引用 §11.1 |
| B2 | 修正 `TASKS.md` A3 ownership 行（`packages/shared` 与 D-062 §1 的矛盾，F5） | **P3（治理）** | **A0** | `git show` 该行：A3 的 Do-Not-Touch 不再包含已授权的 `protocol.ts`/`index.ts` |
| B3 | 修复 `rooms/authz-enforcement.test.ts` 与 `persistence/restart.test.ts` 的乱码注释（F4），**一行断言都不动** | **P3（可读性）** | **A3** | 修复后 `pnpm test` 仍 180/180；`git diff --stat` 只落在注释/标题；`grep '鎼\|閳'` 为 0 |

**3. 非阻塞观察（可以随基线进入下一阶段，但必须记录在案）**

- F3（`role: null` 不阻止夹具补写 membership）：今天无影响，改夹具前先修语义。
- 注释过期两处：`apps/server/src/index.ts` 头注释仍写"WS 未接线"（实际已接线）；
  `authz-enforcement.test.ts` L321 仍写"§17.5 表格要求 canEdit"（勘误后已不是）。
- 元数据只在首次 join 入库；主 bundle 1.41 MB；`synchronous=NORMAL` 硬编码。
- TOOLING-P2（服务端测试默认并行不退出）**已修**且本轮复现为 35.5 s 自然退出——这条可以从风险清单划掉。

**4. 审查覆盖面（诚实边界）**

- **读了**：`CONTRACTS` §5.2/§12/§17（含 §17.5 勘误）、`DECISIONS` D-061/062/063、`TASKS` Phase 2 矩阵与四层边界、
  `tests/browser/README.md`；A5 的 `authz.ts`、`public.ts`、`documents.ts`、`membership-store.ts`（头）、`app.ts`（路由与 500）；
  A3 的 `ws.ts`、`registry.ts`（join/帧门/dispatch）、`room.ts`（SyncStep1 回复）、`test-authz.ts`、`authz-enforcement.test.ts`、
  `capability-matrix.test.ts`（探针）；A6 的 `run.mjs`、`suite/20-m2-phase2-authz.mjs` 全文、`lib/authz-fixture.mjs`、`lib/app.mjs`、
  `lib/stack.mjs`；`packages/shared/{index,protocol}.ts`；web 侧的 `capabilityGate`、`documentSlice`、`App.tsx`（grep + 关键文件）。
- **跑了**：四门禁（7.1–7.4）+ 遗留检查 + 场景计数 + `git show` 范围核对 + 禁令措辞 grep。
- **没读**：A5 的 `session-store.ts`/`tokens.ts`/`cookies.ts` 全文（只按测试名核对行为）、A3 的 `heartbeat.ts`/`peer.ts`
  （M1 已验证，本轮未改）、A6 的 `oracle.mjs`/`wire-socket.mjs` 全文（只读了被新增场景调用的部分）。
- **没跑**：Firefox/Safari；跨机弱网；CRDT 语义 fuzz；TLS 下的 cookie 属性。

---

## 12. 给项目负责人的总结

上一轮结束时，`main` 上是有判定核心却没人调用它，WS 执行点停在 A3 的分支上，
浏览器门禁是 5 通过 / 31 error——那时"权限"是一份写得很好但没被执行的契约。
现在这三段被接成了一条链：会话只由服务端签发，角色只来自成员关系，能力只来自那张冻结的规则表，
HTTP 与 WebSocket 在**同一次按键**上给出同一个答案，而且这轮由我自己重跑了四门禁：44 个浏览器场景全过、
344 + 180 个测试全过、typecheck 与 build 干净、退出码 0、没有遗留浏览器或临时目录。
A6 没有靠放宽执行点换绿色——它一个生产文件都没碰，36 个既有场景一个没少，两处续签都写在明处。
真正剩下的缺口不在服务端：客户端从来没用过 `room-joined.role`，所以 viewer 在界面上可以打字、
看到自己的字留在编辑器里，而服务器拒绝它、别的协作者也看不到它——这是"看起来保存了"，
不是"保存了不该保存的东西"，安全承诺没有因此变弱，但产品诚实性还没到位。
因此我的建议是 **GO**：M2 Phase 2 的授权闭环可以进入 `main`，同时把"UI 门控未生效"和
"吊销不追溯已建 socket"两句话写进发布记录，把它们的修复派给 A1/A2 与 A3，而不是留在报告的语气里。

---

## 13. Git 状态

```text
$ git -C Insighthub-wt-a7-m2-p2-review status --porcelain
（干净，报告已提交）
$ git -C Insighthub-wt-a7-m2-p2-review rev-parse --abbrev-ref HEAD
agent/a7-m2-p2-review
$ git -C Insighthub-wt-a7-m2-p2-review rev-parse --short HEAD
（本报告的提交）
$ git -C Insighthub-wt-a6-m2-p2-browser status --porcelain
（干净 —— 被审基座在我跑完四门禁后仍无改动；dist/ 与 artifacts/ 均被 .gitignore 覆盖）
$ git -C Insighthub merge-base --is-ancestor main fee4f64 && echo yes
yes
```

| 项 | 值 |
| --- | --- |
| 被审 worktree | `Insighthub-wt-a6-m2-p2-browser`（`agent/a6-m2-phase2-browser-authz @ fee4f64`，干净） |
| 本报告 worktree | `Insighthub-wt-a7-m2-p2-review`（`agent/a7-m2-p2-review`，干净） |
| `main` | `13712c5`，**未动**（无 merge、无 push、无 tag） |
| 工作区 | 两个 worktree 都干净；本分支只有一个新增文件 |

---

## 14. Next Handoff

```text
## Next Handoff

Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0（Supervisor / Integration Lead）

Base:
agent/a7-m2-p2-review @ 本报告提交（其父提交为 fee4f64）

Why:
M2 Phase 2 的终审结论是 GO，四门禁全绿、36→44 个浏览器场景无减少、A6 未碰生产文件；
现在只差 A0 决定"是否按本报告放行"，并把 5 条裁定落成一条决策记录（建议 D-064）。

Dependencies satisfied:
- 被审基座 fee4f64 干净，main 是其祖先（可 fast-forward，无冲突窗口）
- pnpm typecheck / pnpm test / pnpm build / node tests/browser/run.mjs 全部 exit 0（本轮由 A7 实跑）
- 浏览器 44/44，postflight：端口已释放、11 个临时目录已删、无遗留句柄；独立复查无遗留 Chrome
- 既验 36 个场景一个未少；新增 8 个场景断言与标题一致；新增的两处续签已记录
- 契约版本：SHARED_CONTRACT_VERSION=6、PROTOCOL_VERSION=2（有 D-061/D-062 授权）

Copy-paste Prompt:
你是 A0（Supervisor / Integration Lead）。A7 已对 M2 Phase 2 出具终审：
`docs/agent-governance/A7-m2-p2-review.md`（基座 agent/a6-m2-phase2-browser-authz @ fee4f64，
报告在 agent/a7-m2-p2-review 上）。

请按报告执行三件事，不要重做终审：

1) 决定是否放行：按 §11.2 的 GO 合入 main（fast-forward；main 是 fee4f64 的祖先）。
   不合入也行，但必须写出"不放行的具体条件"，不能悬置。
2) 把 §11.1 的 5 条裁定落成 D-064，其中两条必须给明确措辞：
   (a) 吊销/过期是否追溯已建立的 socket（推荐：契约澄清"请求立即 401，已建 socket 按原身份工作至断开"）；
   (b) 发布说明不得声称"UI 门控已生效"。
   同时修正 TASKS 里 A3 ownership 与 D-062 §1 的矛盾（报告 F5）。
3) 派发两条后续（不要塞进 backlog 注释）：
   - A1 + A2：消费 `room-joined.role`（`documentRoleReceived` 目前 0 次 dispatch）、只读态/可见拒绝提示、
     401 重新 bootstrap。这是报告 F1 与 §10-3/§10-4 的收口。
   - A3：单独一次提交修复两处乱码注释（`rooms/authz-enforcement.test.ts`、
     `persistence/restart.test.ts`），一行断言都不动，修完跑 pnpm test 确认 180/180。

不要 merge 之前跳过 (2)；不要让别人"顺手"改报告结论。
```
