# M2 最终审查 · 独立终审报告（A7）

> 审查对象：M2 整体 = **M2-P0**（已发布 `m2-p0-gate` = `dfc5389`）+ **M2 Phase 2 / P1**（session 认证 + 文档授权）。
> 审查基线：`agent/a7-m2-final-review` @ **`06ecf14`**（final integrated main，clean）。
> 本文件是 A7 在本 worktree 内**唯一**新增的文件。未改代码、契约、测试或其它文档；未 merge / push / tag / 关闭里程碑。

---

## 0. 结论先行

**判定：GO WITH CONDITIONS（有条件放行）。**

- **代码与证据层面**：M2 的两半都可以成立。四门禁由我本人在这一 HEAD 上从干净状态重跑，全绿；真实浏览器 **48/48**、
  exit 0；A6 的 7 个文件**只落在 `tests/browser/**`**；三个重新瞄准的场景**没有删掉或放宽任何 `FORBIDDEN` 断言**，
  而且拒绝被钉在**新**帧上；F3 的两条隐式写 membership 路径都已关闭并有数据库级否定证据。
- **M2 的五个关闭条件（B3 / F1 / F2 / F3 / F5）全部满足**，其中 B3 的"注释与标题 0 残留、全文件 ≠ 0"我用
  **字节级**扫描 + 自己重跑 `--unified=0` 分类独立复现。
- **不能直接宣布关闭的原因不是代码，而是仓库自己的文档**：`CONTRACTS` / `ARCHITECTURE` / `PROJECT` / `TASKS`
  仍有四处把一个**已实现、已浏览器验证**的能力写成 "NOT implemented / NOT STARTED / 门控当前不生效"，
  并把 `SHARED_CONTRACT_VERSION` 写成 **2**（代码是 **7**）。这正是 A7 在 M2-P0 Gate 判过的 P1 同类缺陷
  （D-059 P1）、以及 D-060 §4 已经修过一次的同类缺陷，在 Phase 2 上复发。
- 这些条件**全部是文档级**（owner A0），没有一条需要改代码、改契约形状或补测试；因此它们是"关闭动作的前置"，
  而不是"实现未完成"。

一句话：**M2 的实现可以关闭，M2 的仓库状态还不能。** 先让仓库不再否认自己做了什么，再让项目负责人授权关闭。

---

## 1. 任务状态

| 项 | 值 |
| --- | --- |
| Status | **done**（审查完成；结论为有条件放行） |
| Branch | `agent/a7-m2-final-review` |
| Worktree | `D:\前端\react\项目\面试项目\Insighthub-wt-a7-m2-final` |
| Commit（被审查基线） | `06ecf14`（审查前 clean，审查后仅本文件） |
| 产出 | `docs/agent-governance/A7-m2-final-review.md`（唯一新增文件） |

---

## 2. 本轮目标

本轮不是实现，而是**最后一关的独立判断**：M2 作为一个里程碑（M2-P0 + Phase 2 + 收口缺口）是否可以关闭；
如果不能，缺的是**实现**还是**记录**；以及哪些残留必须作为具名风险带进 M3。判据是证据，不是各 Agent 的报告。

---

## 3. 完成了什么

- 在 `06ecf14` 上从"无 `node_modules`"的干净 worktree 重新 `pnpm install --frozen-lockfile`，然后**本人重跑四门禁**
  并记录真实计数与 exit code（§5）。没有任何一项沿用他人输出。
- 独立复核 A6 提交范围（`7ae4974`：7 文件全部 `tests/browser/**`）与合并范围（`91bcf77`：`apps/web/src` + `tests/browser`，
  无 `docs/**`、无 `packages/**`、无 `apps/server/**`）。
- 逐行读三个重新瞄准的场景（`p2/1`、`p2/2`、`p2/4`）及其共享断言库 `lib/role-gate.mjs`，并**机械列出**
  `git show 7ae4974 -- suite/20` 的**每一条被删除的行**，核对"没有删掉或放宽断言"。
- 核对 F3 的两个写点（`run.mjs#newAppPage`、`lib/app.mjs#setDocumentId`），确认 `role: null` 既不写也不让
  `setDocumentId` 写，且 null 窗口**不经过** `WireOracle.connect` 的默认 `membership: true`。
- 全仓 `grep` 生产代码的测试钩子（`__qa` / `window.__`）→ **0**。
- 独立复核 B3：用**字节级 UTF-8** 扫描三个文件（不是控制台解码），并自己重跑
  `git diff --unified=0 a3ff4a9 57b9b5b` 的逐行分类。
- 实测 `pnpm test:unit` 在缺少 `packages/shared/dist` 时的行为（$21$ 个测试文件失败、exit 1），验证 D-068 §4 的
  `pretest` 修复只覆盖 `pnpm test` 这一条脚本。
- 判定 M2 五个关闭条件，并给出 6 条放行条件（严重级别 / owner / 复核方法）与 7 条要带进 M3 的具名风险。

---

## 4. 复核方法与独立性说明

1. **证据优先**：任务书里"Re-run the four gates yourself"是硬约束，所以 §5 的每条结果都来自本 worktree 的这一 HEAD。
2. **不信自述**：A6 报告、D-068 的计数、A0 的 diff 审计，我都用独立的命令重新测了一遍（§6.11、§6.2、§6.1）。
3. **一个方法论教训（本轮亲自踩到）**：用 PowerShell 控制台读 UTF-8 文件时，非 ASCII 字符会被控制台代码页二次解码，
   `→` 会显示成 `鈫?`、`—` 会显示成 `鈥?`。我第一遍扫描因此得出"`index.ts` 注释仍有乱码"的**假发现**，
   用 `[System.IO.File]::ReadAllBytes` + 严格 `UTF8Encoding` 复核后确认文件是干净的（0 × U+922B，3 × U+2192）。
   **结论：乱码检测必须走字节级，不能走控制台输出。** 这与 D-066 §1（"不能只扫汉字，还要扫控制字符与 U+FFFD"）
   是同一类错误的两个方向。

---

## 5. 四门禁（我在 `06ecf14` 上重跑，真实计数与 exit code）

环境：Windows 10.0.26200 (x64)、Node **v22.14.0**、pnpm 10.34.7；`pnpm install --frozen-lockfile` 干净安装（288 包）。

| # | 命令 | 真实结果 | exit |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck` | `packages/shared` / `apps/web` / `apps/server` 三个 `tsc -p … --noEmit` 全部 `Done` | **0** |
| 2 | `pnpm test` | `pretest` 先 `pnpm --filter @insighthub/shared build`；`vitest run` **34 files / 378 tests passed**（5.67 s）；server `tsx --test --test-concurrency=1` **180/180 pass, 0 fail**（50.8 s，**自己退出**） | **0** |
| 3 | `pnpm build` | vite 7.3.7；web `dist/assets/index-B9wEwH6p.js` **1 409.45 kB**（gzip 458.67 kB），css 4.76 kB，18.72 s | **0** |
| 4 | `node tests/browser/run.mjs` | **scenarios: 48 · passed 48 · failed 0 · errored 0**；postflight：`ports 5173, 3101: released`；`temporary data directories removed: 11`；`live handles after teardown: none` | **0** |

补充事实：

- 门禁 2 在**装完依赖、还没 `build`** 的树上就跑通了 → D-068 §4 的 `pretest` 修复是有效的（不是靠我提前 build 掩盖）。
- `results.json` 的 summary：`{"total":48,"pass":48,"fail":0,"error":0,"unexpectedFailures":0,"pinnedOpen":[],"ok":true}`；
  cleanup：`portsStillOpen: []`、`remainingHandles: []`、`removedDataPaths` 11 条。
- 48/48 中包含 `p2/1…p2/9`、`f1/1…f1/4`、`m2/A…K`、M1 的 27 场景之一部分；**没有任何场景被 skip**（`results.json` 无 skip 字段，
  测试框架也没有 skip 机制）。
- `pnpm build` 的主 bundle 1.41 MB 属于既有 backlog（"主 bundle 分块"），不在 M2 判据内。
- 端口 3101/5173 在运行前确认为空闲（`Get-NetTCPConnection` 无监听），运行后再次确认为空。

---

## 6. 逐项独立核查（对应任务书 1–12）

### 6.1 范围与提交（检查 #2）

| 项 | 命令 / 证据 | 结论 |
| --- | --- | --- |
| A6 只碰 `tests/browser/**` | `git show --stat 7ae4974` → `README.md`、`instrument/page-instrument.js`、`lib/app.mjs`、`lib/role-gate.mjs`（新）、`run.mjs`、`suite/20-…mjs`、`suite/21-…mjs`（新）；7 files, +1557/−34 | **PASS**（5 改 + 2 新，全部在 `tests/browser/**`） |
| 合并范围 | `git show --stat 91bcf77` → `apps/web/src/**`（12 文件）+ `tests/browser/**`（7 文件） | **PASS**（无 `docs/**`、`packages/**`、`apps/server/**`；A2 + A6 一次性进入，`main` 未出现红窗口） |
| 无越界改他人文件 | 我的门禁运行结束时 `git status --porcelain` 为空 | **PASS** |

### 6.2 三个重新瞄准的场景（检查 #3）

我把 `git show 7ae4974 -- tests/browser/suite/20-m2-phase2-authz.mjs` 的**每一条 `-` 行**列出来逐一分类，
删除行只有三类：

1. 文件头表格与注释（`P2-1`/`P2-2`/`P2-4` 的描述行）；
2. 三个 `typeInEditor(...)` 调用——即"UI 现在不再产生的那种写"；
3. **两个** `waitForServerErrorCode(viewer, 'FORBIDDEN', …)` 调用（`p2/1`、`p2/2`）与**一个**同款调用（`p2/4`）。

**没有删除任何 `assert(...)` 行；`FORBIDDEN` 断言不是被删掉，而是被换成更强形式：**

| 场景 | UI 侧（真实浏览器） | 服务端侧（非 UI 路径） |
| --- | --- | --- |
| `p2/1` | `assertUiReadOnly`（`.cm-content[contenteditable="false"]`、live `EditorState.readOnly === true`、notice 可见且文案诚实） + `assertKeystrokeProducesNoWrite`（真实 `Input.insertText` 后文档不变、**出站 SYNC 帧计数不变**） | `sendBypassWrite`（冻结 codec 构造的 SYNC update，走**页面自己的已认证 socket**，`frameType === 0` 被断言）→ `waitForBypassDenial(afterCount)` 要求**新**帧；再断言 socket 数不变、无 1008、durable 不含该文本、他人看得到、owner 后续编辑仍到达 |
| `p2/2` | 同上（在注入 `userId` / `mode=readwrite` 之后仍只读） | 同上，且**新增**断言 "a mode=readwrite + userId claim must not buy a broadcast to the other peer" |
| `p2/4` | 逐角色 `assertUiEditable` / `assertUiReadOnly`，矩阵新增 3 列（`contentEditable`、`viewReadOnly`、`noticePresent`），并对每行断言"与 `canEdit` 一致" | viewer 行用 `sendBypassWrite` + `waitForBypassDenial`；owner/editor 行仍真实打字并等 durable |

四条 UI 断言的**真实性**我逐条验证了数据来源（`tests/browser/lib/app.mjs`）：

- `contentEditable`：读 `.cm-content` 的真实属性；
- `viewReadOnly`：`window.__qa.probe.state()` → `probe.refresh()` 用 `EditorView.findFromDOM(host)` **每次重新取活视图**，
  再读 `view.state.readOnly`，不是缓存的 prop；
- notice 可见：`getBoundingClientRect()` 宽高 > 0 **且** `display/visibility/opacity` 三个都检查；
- "没有出站 SYNC 帧"：只数 `direction === 'out' && kind === 'binary' && frameType === 0`，**故意排除 awareness**
  （§17.5 允许 viewer 发光标），注释与实现一致。

**结论：PASS。** 拒绝被钉在新帧上（实测证据里能看到 `forbiddenFramesBefore: 1 → forbiddenFramesNow: 2`），
不存在"任意早先同码帧蒙混"的通道。

### 6.3 F3：`role: null` 的两条隐式写点（检查 #4）

| 写点 | 代码 | 结论 |
| --- | --- | --- |
| `tests/browser/run.mjs#newAppPage` | `const arrangeAccess = role !== null;` → 只有为真才 `authz.grant(..., { ifAbsent: true })`；并把 `{ arrangeAccess }` 传给 `setDocumentId` | **已关闭**：`role: null` 时**一次 grant 都不发** |
| `tests/browser/lib/app.mjs#setDocumentId` | `export async function setDocumentId(page, documentId, { arrangeAccess = true } = {})`，`if (arrangeAccess) grant(..., 'owner', { ifAbsent: true })` | **已关闭**：`arrangeAccess: false` 时完全不碰 `authz.db` |

**null 路径没有走到 `WireOracle.connect` 的默认 `membership: true`**：`f1/3` 全程不使用 `WireOracle`
（`grep` 该场景无 `WireOracle.connect`），null 窗口由 `newAppPage({ role: null, offlineFirst: true })` 构造，
`offlineFirst` 的 `addInitScript('window.__qa.setOffline(true);')` 排在 instrumentation 之后、任何应用脚本之前。

否定证据（不是论证）：`f1/3` 断言 `ctx.authz.log.length === 0` **且** `membership()` 为 `null`——**窗口前后各一次**；
随后显式 `grant('editor')` 得到 `action === 'inserted'`（若夹具此前偷偷写过，这里会是 `replaced/exists`）。

**结论：PASS。** D-065 §5 的 evidence condition 由"把可能伤害结论的路径关掉"满足，而不是"证明它没伤害"。

### 6.4 生产代码里的测试钩子（检查 #5）

`grep -r "__qa|window\.__" apps/**` → **0 处**。浏览器观测全部来自
`Page.addScriptToEvaluateOnNewDocument` 注入的 `tests/browser/instrument/page-instrument.js`，
生产文件未被 instrument。**PASS。**

### 6.5 只读提示的文案与渲染（检查 #6）

`apps/web/src/features/permissions/readOnlyNoticeCopy.ts`：

- `title: 'Read-only for your role'`；`detail`：`Your role on this document is "<role>", which does not include editing.`
  + `Typing is disabled in this editor, and no change is written to the document.`
- 不含 `saved` / `saving` / `immediately` / `instant`（浏览器断言用同一份 `READ_ONLY_NOTICE_BANNED_WORDS` 复核）；
- `gate.role === null` → **返回 `null`**（未知角色既不只读、也不出提示）；
- `gate.readOnly !== true` → `null`（可编辑角色看不到提示）。

渲染侧 `ReadOnlyNotice.tsx`：`role="status"`、`data-testid="read-only-notice"`，
由 `DocumentWorkspace.tsx` 用**同一个** `capabilityGate(role)` 渲染，文案不在组件里二次抄写。

**结论：PASS，且文案没有暗示"保存"。** "no change is written to the document" 是对本地写路径的诚实描述，
不是对服务端持久化的承诺。

### 6.6 角色滞后没有被说成能力（检查 #7）

- `f1/1` 真的在**降级 3 秒后**读 UI：`assertEqual(lag.roleTag, 'role: editor')` +
  `assertEqual(lag.contentEditable, 'true')`，并在 evidence 里写明"NOT a defect … This measurement is why D-066 §5
  forbids claiming that a role change reaches the UI immediately"。**这是测量，不是主张。**
- D-064 §1 的三条禁令仍在原地（`吊销立即生效 / 登出即断开`、`重启后客户端自愈`、`UI 权限门控已生效`）；
  D-066 §5 的第四条（`角色变更即时反映到 UI`）仍在原地；`tests/browser/README.md`
  "Two things a green run must not be read as claiming" 同步保留两条禁令式表述。
- **但**：D-064 §1 的**第 1 条**（"UI 权限门控已生效"为假）在 F1 关闭后已经**在事实层面过时**，且没有任何
  取代记录 → 见 §8 的 F-A7-3。禁令 2/3/4 全部正确且必要。

### 6.7 吊销仍是请求级（检查 #8）

- `CONTRACTS` §17.2 "Revocation scope (Phase 2 limitation)"：**request-scoped, not retroactive**，
  已建立的 socket 保留准入身份；§17.5 "Live socket + revocation" 同义；`PROTOCOL_VERSION` 不变。
- `p2/5-session-revocation-is-everywhere` 对已开 socket 的写**记为 evidence 而不作断言**：
  `{"writeApplied": …}` + 注释 "not asserted: the contract speaks about requests"。
- 我在全仓 `.md` 检索 `登出即断开 / logout disconnects / 吊销立即生效 / 自愈`：命中**全部**落在
  "禁止这种说法"的禁令文本里，**没有一处**把登出描述成断连、或把重启描述成自愈。

**结论：PASS。** 吊销没有被写成"立即生效"，也没有被写成"登出会断开"。

### 6.8 `setDocumentId` 的 `options` 兼容性（检查 #9）

签名：`setDocumentId(page, documentId, { arrangeAccess = true } = {})`。

全部调用点（`grep -rn "setDocumentId(" tests/browser`）：

| 调用点 | 参数 | 行为 |
| --- | --- | --- |
| `lib/app.mjs:82`（`openApp`） | 2 个 | `arrangeAccess = true` → 与修改前**完全一致**（写 `owner`、`ifAbsent`） |
| `suite/02, 03, 04, 06, 21` | 2 个 | 同上，**遗留行为不变** |
| `run.mjs:164` | 3 个（新） | 唯一显式传 `arrangeAccess` 的调用点，`role: null` 时为 `false` |

**结论：PASS。** 默认值保持"写"的一侧，所以"legacy call sites 行为不变"是可验证的事实，不是声明。

### 6.9 证据产物（检查 #10）

产物位置是 **`tests/browser/artifacts/`**（`git check-ignore` 命中 `.gitignore:31`），不是仓库根的 `artifacts/`
（根本不存在该目录）。`results.md` 实测内容：

| 项 | 值 |
| --- | --- |
| 真实 Chrome | `Chrome/155.0.8059.80`，`@43a195105613ac83c21d3f14de279f4a045c7da0`，`C:/Program Files/Google/Chrome/Application/chrome.exe` |
| backend URL | `http://127.0.0.1:3101`；app `http://127.0.0.1:5173/` |
| 端口释放 | postflight `ports 5173, 3101: released`；`cleanup.portsStillOpen = []` |
| 临时目录 | `temporary data directories removed: 11`；11 条全在 `D:\dev-temp\insighthub-a6-*`；开发默认 `.insighthub-data` 未被触碰（worktree 内不存在） |
| 活句柄 | `live handles after teardown: none (the process exits on its own)`；`cleanup.remainingHandles = []` |
| 文件编码 | `results.md` 是**合法 UTF-8**（严格解码通过，U+FFFD = 0，`—` ×61、`’` ×12） |

**我自己这一轮没有新增临时目录**：`D:\dev-temp` 下没有任何 `insighthub-*` 目录的 `LastWriteTime` 晚于本次运行开始
（我 `pnpm test` 期间只新增了 `tsx` 编译缓存）。**PASS。**

诚实附注（不是本 HEAD 的缺陷）：`D:\dev-temp` 里仍有 **38 个** `insighthub-a3-test-*` / `insighthub-acceptance-*` /
`insighthub-capability-test-*` / `insighthub-restart-*` 目录，时间戳为 **10/18–10/19**，属于更早的 Agent 运行
（很可能是 TOOLING-P2 挂起期间被强杀的那几次）。本次运行没有产生同类残留，因此不构成对 `06ecf14` 的门禁结论。

### 6.10 P2 矩阵对证据的对照（检查 #11）

| # | 判据 | 本轮证据 | 判定 |
| --- | --- | --- | --- |
| P2-1 | viewer 不能改；不 apply/persist/broadcast；`FORBIDDEN`；第二 peer 看不到；socket 仍能收 | `p2/1` 浏览器（双断言，**我本轮跑过**） | **PASS（browser）** |
| P2-2 | `userId` 在 join payload / body / header / query 全部无效；`mode` 无效 | `p2/2` 浏览器（页面 socket 注入 join payload；oracle 走 query/header）+ server authz 单测 | **PASS（Node + browser）** |
| P2-3 | 无 session = 401；未知/无成员/无 `canRead` 三者 404 完全一致；不足才 403 | `capability-matrix.test.ts` / `authz-core.test.ts` / `http-session.test.ts`（Node）**plus** `p2/3` 浏览器逐字节比较 | **PASS（Node，且超出要求地有浏览器证据）** |
| P2-4 | 同一角色在 `documentCapabilities` / API / WS join / WS frame 四处同答案 | `p2/4` 表驱动（浏览器执行写/被拒）+ Node 矩阵 | **PASS** |
| P2-5 | 角色变更后重新判定；重启后成员关系仍在；`DELETE /api/session` 后处处 401 | `p2/5-role-change-is-re-evaluated`、`p2/5-session-revocation-is-everywhere`、`m2/B`、`authz-core.test.ts`「survives a process restart」 | **PASS（browser + Node），但 401 的"处处"按 §17.2 的**请求级**范围成立** |
| P2-6 | `canManageMembers` 仅 owner；editor 调成员能力 = 403 | `capability-matrix.test.ts` P2-6 段 + `authz-core.test.ts`（Node） | **PASS（Node-only，见下）** |
| P2-7 | 既有门禁不回归、场景一个不少 | 我本轮四门禁；M1 场景仍在 `results.json`（48 = 原 44 + 4 个 `f1/*`） | **PASS** |
| P2-8 | 不出现被禁措辞 | 我自己的 grep（`无密码` / `passwordless` / `防止跨用户冒用` / `已实现认证` / `authenticated users`）共 8 处命中，**全部**在"禁止清单"自身或引用禁令的注释里 | **PASS** |
| P2-9 | `document.cookie` 读不到；不出现在 body / 日志 / localStorage / awareness / bootstrap 响应 | `p2/9` 浏览器（`Network.getCookies` vs `document.cookie`、storage、`/api/session`、bootstrap body、server log） | **PASS（Node + browser）** |

**P2-4 新增的"browser UI gate"列是否诚实？——诚实，但覆盖只有 3 个角色。**
该列测的是真实浏览器里 DOM 可编辑性 / 活 `EditorState.readOnly` / notice 是否出现，并对每行断言
`contentEditable === (canEdit ? 'true' : 'false')`、`viewReadOnly === !canEdit`、`noticePresent === !canEdit`；
这是**新增**证据（原判据只要求 Node），不是把 Node 证据改写成浏览器证据。限制有二，且都已由 A6 自述（D-068 §6）：

- `commenter` **没有浏览器行**（门控对任何非 `canEdit` 角色一致，但只在单测里覆盖）；
- `getRole() === null` 只覆盖"首帧之前（offline-first）"与"reconnecting"两种，§17.9 列的"**被拒 join 之后**"未单独覆盖。

**仍然 Node-only / 不可构造的项（如实列出）**：

| 项 | 状态 | 为什么 |
| --- | --- | --- |
| P2-6 的 HTTP 403 路径 | **Node-only** | 本 Phase 没有成员管理端点（§17.7），浏览器侧**不可构造** 403；Node 用 capability 探针证明 |
| K（hydration backlog 溢出）的浏览器证据 | **browser N/A** | 同步 `SqliteDocumentStore` 下无法稳定制造 backlog（D-056）；`m2/K` 只记录"可达性"，不得读成浏览器验证 |
| M2-P0 的 D / H / I | **Node-only** | 由 D-056 分层冻结；`acceptance.test.ts` 覆盖 |
| 客户端 401 重新 bootstrap / 重启自愈 | **未实现** | `p2/S` 记录 `reBootstrapped=false`、页面停在 `reconnecting`；续签是 harness 行为 |
| `commenter` 浏览器行、被拒 join 后的 null 窗口 | **未覆盖** | 见上 |
| Firefox / Safari | **未验证** | 只有真实 Chromium |

### 6.11 B3 的独立复核（关闭条件之一，我重做了证明而不是采信）

1. **diff 形状**：我自己跑 `git diff --unified=0 a3ff4a9 57b9b5b` 并逐行分类 → **115 行变更（+58/−57）**，
   `comments = 85`、`describe/it 标题相关 = 30`（= 15 对）、**其它 = 0**。与 A0 的"115 = 注释 43 对 + 标题 15 对 + 其他 0"一致
   （A0 数的是成对，我数的是单侧行）。
2. **残留范围**：字节级严格 UTF-8 解码 + 码点统计 →
   `authz-enforcement.test.ts` 仍有 `U+95B3 閳`×6、`U+30E6 ユ`×4、`U+7368 獨`×4，**恰好 6 处**
   （4 处 `閳ユ獨` = 应为 `’s`，2 处 `閳?` = 应为 `—`），全部落在**诊断字符串实参**内：
   L284 / L288 / L389 / L421（等待描述）与 L310 / L597（`assert.*` 第 3 实参）。
   注释与 `describe`/`it` 标题内 **0 残留**；无 U+FFFD、无控制字符；`restart.test.ts` 与 `index.ts` 干净
   （`index.ts` 有 `→`×3、`§`×1，编码正确）。
3. **全仓横向**：`apps/**` + `packages/**` + `tests/**` 共 167 个代码文件，只有上述一个文件命中。

**结论：B3 按"注释与标题 0 残留"结案是**可复现**的事实；"mojibake 已全库清零"是**假**的，
TASKS 的 B3-residual 行（6 处、不修、需负责人一次性放宽规则）准确。PASS。

---

## 7. M2 关闭条件判定（对应任务书 #12）

| 条件 | 本轮判定 | 是否可据此关闭 M2 | 依据 |
| --- | --- | --- | --- |
| **B3**（测试注释修复，含作用域化残留） | **满足** | **可以**（附一条长期禁令：不得声称"mojibake 已全库清零"） | §6.11：115 行、0 个非注释/非标题变更；6 处残留全部在诊断字符串实参内且已具名 |
| **F1**（`room-joined.role` → UI 门控真正生效） | **满足** | **可以** | A1 seam（`SHARED_CONTRACT_VERSION = 7`）+ A2 三条写路径 + A6 `f1/1…f1/4`，我本轮 48/48 复跑；`p2/1`/`f1/1` 的 UI 只读断言真实 |
| **F2**（吊销/过期是请求级） | **契约已澄清，实现未做** | **可以关闭 M2，但必须作为具名风险带入 M3** | §17.2/§17.5 已写明 "request-scoped, not retroactive"；`p2/5` 记录 `writeApplied: true` 而非断言；实现（断连或每帧重解）仍在 backlog |
| **F3**（夹具在 `role: null` 时隐式建 membership） | **满足** | **可以** | 两个写点都关闭；`f1/3` 用 `log.length === 0` + `membership() === null` 的**否定**证据，且 null 路径不经过 oracle 的默认 `membership: true` |
| **F5 / B2**（TASKS ownership 行与 D-062 矛盾） | **满足** | **可以** | TASKS Phase 2 ownership 表 A3 行已改为"D-062 §1 已授权的具名例外" |

**这五条都能接受。没有一条需要返工实现。**

**但**：M2 作为里程碑的"关闭"是一次**记录行为**，而当前仓库的四处文档还在否认这些能力存在（§8 F-A7-1）。
因此我的结论是"实现可以关闭、记录必须先修"，见 §10 的条件 C-1…C-4。

**必须带进 M3 的具名风险（7 条，缺一不可）**：

| # | 风险 | Owner | 触发条件 |
| --- | --- | --- | --- |
| R1 | 吊销/过期**不追溯**已建立 socket（`writeApplied: true`） | A3 | 任何"立即失效/会话吊销"表述 |
| R2 | session 是 **process-scoped**；重启后全部失效，客户端**没有** 401 重新 bootstrap，页面停在 `reconnecting` | A1 + A2 | 任何"重启自愈/会话自动恢复/持久会话"表述 |
| R3 | 角色变更**不推送**到客户端：UI 门控滞后到下一次成功 join（`f1/1` 实测降级后 3 s 仍是 editor） | A0 立项（新控制面消息 + `PROTOCOL_VERSION` bump） | 任何"权限变更即时生效到 UI"表述 |
| R4 | 6 处 B3-residual 诊断字符串 | A3（需负责人一次性放宽 diff 规则） | 任何"乱码清零"表述 |
| R5 | `commenter` 无浏览器行；"被拒 join 之后"的 `getRole() === null` 未单独覆盖 | A6 | 引用 P2-4 浏览器列作为全角色覆盖时 |
| R6 | `lib/app.mjs#openApp` 仍隐式写 `owner`（F3 的潜在复入口，当前无场景使用） | A6 | 新场景用 `openApp` 观察"无角色"窗口时 |
| R7 | 主 bundle 1.41 MB（未分块） | A0 backlog | 性能/首屏类声明 |

---

## 8. 本轮新发现（此前无人提出）

> 下面每一条都给出**机制**与**复核命令**；均不是"看起来不对"，而是"仓库里有一句话与另一句话互相矛盾，且我指得出位置"。

### F-A7-1（P1，文档事实）基础文档仍在否认 M2 Phase 2 存在，且版本号停在 2

**机制**：Phase 2 的实现、契约（§17.4/§17.5/§17.9）与版本（4→5→6→7）是分三轮落地的，每一轮只更新了
"自己那一节 + DECISIONS"，没有一轮回去更新**入口级**的状态行。于是同一个文件内部自相矛盾：

| 位置 | 现状 | 与之矛盾的事实 |
| --- | --- | --- |
| `docs/CONTRACTS.md:9` | `SHARED_CONTRACT_VERSION = 2` | `packages/shared/src/index.ts` 导出 **7**；同文件 §17.8 写的是 7 |
| `docs/CONTRACTS.md:788` | 标题 `… (M2 Phase 2 — FROZEN, NOT implemented)` | §17.4/§17.5/§17.9 均已实现并由 48/48 浏览器证据覆盖 |
| `docs/CONTRACTS.md:791` | "Nothing in this section is implemented yet" | 同上；该文件开头还声称 "Everything here is implemented" |
| `docs/ARCHITECTURE.md:607` | 标题 `§8 … (M2 Phase 2 — FROZEN, NOT implemented)` | 同文件 §7 已标 `IMPLEMENTED`；§8 描述的就是已实现的 authz |
| `docs/PROJECT.md:39` | `M2 Phase 2 / 权限认证（**NOT STARTED**）` | D-064 已 GO，D-068 已闭环，48/48 |

**为什么算 P1 而不是 P3**：D-059 §1 把"契约/架构/TASKS 仍称 P0-1、P0-3 未实现"定为 **P1**，D-060 §4 又因同一
理由改过 `PROJECT.md`。这是**同一缺陷类的第三次复发**。M2 一旦打 tag / 写 release notes，这批文档就是该 tag
的说明书；而 `CONTRACTS` 的第 9 行是任何 agent 判断"当前契约版本"的第一入口。

**复核**：`grep -n "NOT implemented" docs/CONTRACTS.md docs/ARCHITECTURE.md` → 0；
`grep -n "SHARED_CONTRACT_VERSION = " docs/CONTRACTS.md` → `= 7`；`grep -n "NOT STARTED" docs/PROJECT.md` → 0。

### F-A7-2（P2，架构文档保留了契约**已撤回**的规则）

**机制**：A3 在实现期发现 §17.5 原文"BINARY `SYNC` requires `canEdit`"会把 `SyncStep1`（读请求）一起拒掉，
导致 viewer 永远拿不到文档、编辑器空白。契约做了**显式纠错**（`CONTRACTS` §17.5 的 Correction 段），
`registry.ts:700` 也写对了（`SyncStep1 → canRead`）。但**同一规则的两处转述没有跟着改**：

| 位置 | 文字 | 与实现的关系 |
| --- | --- | --- |
| `docs/ARCHITECTURE.md:634` | 表格行 "WebSocket frame / the room's mutation gate（BINARY `SYNC` requires `canEdit`）" | **错**：把读请求也要求写权限 |
| `apps/server/src/rooms/registry.ts:188` | 选项注释 "**BINARY `SYNC`**: `canEdit`, denying with `FORBIDDEN`" | **错**，且与同文件 L700 的总表**直接矛盾** |

**影响**：不是当前行为错误（实现正确、`authz-enforcement.test.ts:320` 还专门钉了"为什么 SyncStep1 要 canRead"），
而是**下一个实现者**若按 `ARCHITECTURE` §8.2 去写一个 enforcement 点，会复现那个让 viewer 空编辑器的 bug。
属于"纠错只落到它被发现的那一层"的经典传播缺口。

**复核**：`grep -n "requires \`canEdit\`" docs/ARCHITECTURE.md` → 0；`grep -n "SyncStep1" docs/ARCHITECTURE.md` → 有；
`grep -n "BINARY \`SYNC\`" apps/server/src/rooms/registry.ts` → L188 与 L700 口径一致。

### F-A7-3（P2，决策记录里的禁令 1 已过时，且没有取代记录）

**机制**：D-064 §1 表第 1 行把 "UI 权限门控已生效 / viewer 在界面上不能编辑" 判为**假**，理由是"0 次 dispatch"。
F1 关闭后这句话**在事实层面已经为真**（`f1/1`：`contentEditable=false`、`readOnly=true`、notice 可见、击键无写）。
D-068 只记录"F1 CLOSED"，**没有**任何一条取代 D-064 §1 第 1 行。后果是反向的诚实性风险：

- 写 release notes 的人如果照 D-064 §1 执行，会被禁止说一句现在**有 48/48 浏览器证据**的真话；
- 反过来，如果他自行"破例"，就没有任何记录说明为什么破例、破到什么范围。

**建议处置**（不是"删掉禁令"）：新增 D-069 显式收窄第 1 条——"UI 门控对**已知角色、且以最近一次成功 join 的角色为准**
已生效；仍**不得**据此声称 (a) UI 是安全边界、(b) 角色变更即时反映、(c) 服务端因此变弱"。禁令 2/3/4 原样保留。

**复核**：`grep -n "D-069" docs/DECISIONS.md` 有记录；D-064 §1 第 1 行带"已被 D-069 取代/收窄"的标注。

### F-A7-4（P2，TASKS 的状态表与它自己的缺口表互相矛盾）

**机制**：`06ecf14` 只改了 TASKS 的 **F1 行**（1 行），没有改同一节的三处状态：

| 位置 | 现状 | 应为 |
| --- | --- | --- |
| `docs/TASKS.md:461` | "…44/44 浏览器证据。**M2 仍未 CLOSED**：关闭条件见 B3 与 F1" | B3、F1 均已 CLOSED；"44/44"应为 48/48 |
| `docs/TASKS.md:563` | "客户端权限门控：**通道已通、消费侧未接** … **UI 门控当前不生效**" | 与本文件 L572（F1 **CLOSED**）直接矛盾 |
| `docs/TASKS.md:574` | F3 行仍是"证据前置条件 … A6 要么修 F3，要么证明…"（无状态） | `CLOSED（7ae4974 修掉，f1/3 否定证据）` |

**影响**：M2 的关闭决定是从这张表读出来的。一个读者若只看 L461/L563，会得出"门控不生效、M2 被 B3/F1 卡住"的
结论——而这两句话现在是错的。D-065 §1 说 specialist 不得自行调度，但 A0 自己的状态表也必须跟进。

**复核**：`grep -n "消费侧未接\|门控当前不生效" docs/TASKS.md` → 0；L461 的关闭条件列表与缺口表状态一致。

### F-A7-5（P3，F3 的修复只覆盖两条路径，第三条仍在）

`tests/browser/lib/app.mjs:76-84` 的 `openApp(page, { url, documentId })` 仍以**两个参数**调用
`setDocumentId(page, documentId)`，即 `arrangeAccess: true` → 对任何经它打开的文档隐式写 `owner`。
当前**没有任何场景调用 `openApp`**（`grep -rn "openApp(" tests/browser` 只命中定义），所以是**潜在**复入口，
不是现存假绿。但它正是 F3 的同一机制，未来某个新场景用 `openApp` 观察"无角色"窗口就会重犯。

**建议**：让 `openApp` 透传 `arrangeAccess`（或直接删除这个已无调用者的导出）。**复核**：
`grep -rn "openApp(" tests/browser` 只剩定义，或定义里出现 `arrangeAccess`。

### F-A7-6（P3，"新帧"标准没有统一施加）

D-068 §2 把 `waitForNewServerErrorCode(afterCount)` 定为同类场景的标准，理由是旧
`waitForServerErrorCode` 只要求"曾经出现过 `FORBIDDEN`"，属**假阳性通道**。但它只在 `p2/1`/`p2/2`/`p2/4`/`f1/4` 施加：
`p2/5-role-change-is-re-evaluated` 的降级断言仍在用旧的弱形式（`suite/20:897`
`await waitForServerErrorCode(editor, 'FORBIDDEN', { documentId })`）。

风险有限（该页在降级前只成功写过、此前无 `FORBIDDEN` 帧，所以当前不会误绿），但"标准"与"实际用法"不一致，
下一次改动就可能踩到它宣称已消除的那条通道。**复核**：
`grep -c "waitForNewServerErrorCode" tests/browser/suite/20-m2-phase2-authz.mjs` ≥ 4，或 L897 改为新形式。

### F-A7-7（P3，`pretest` 只修了 `pnpm test` 一条脚本）

D-068 §4 的决定正确（`pnpm test` 单独就是完整的），但它只挂在 `test` 上。实测：删掉 `packages/shared/dist`
后 `pnpm test:unit` → **21 failed | 13 passed（34 文件），exit 1**（即 A6 当初遇到的同一故障）。
`test:server` 同理（其内部会先 build shared，故影响较小）。AGENTS §5 的门禁命令是 `pnpm test`，所以这不阻断任何结论；
但 `pnpm test:unit` 是开发时最常用的一条，它在干净树上必红。
**建议**：`test:unit` 也加 `pretest:unit`（或把 shared build 抽成 `pretest` 之外的显式 step），或在 README 写明。

---

## 9. Acceptance Criteria 总表（对应任务书 #13）

| # | 判据 | 判定 | 证据 |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck` / `pnpm test` / `pnpm build` / 浏览器套件在**本 HEAD** 全绿 | **PASS** | §5：exit 0 / 0 / 0 / 0；378 + 180 测试；48/48 场景 |
| 2 | A6 只碰 `tests/browser/**`；合并范围可核对 | **PASS** | §6.1 |
| 3 | 三场景无 `FORBIDDEN` 断言被删/放宽；拒绝钉在**新**帧；UI 只读断言真实 | **PASS** | §6.2（逐条 `-` 行分类；新帧计数 1 → 2） |
| 4 | F3 两处写点关闭；null 路径不经过 `WireOracle.connect` 默认 `membership: true` | **PASS** | §6.3 |
| 5 | `apps/**` 无 `__qa` / 测试钩子 | **PASS** | grep 0 命中 |
| 6 | 只读文案诚实、不暗示保存；DOM 渲染正确 | **PASS** | §6.5 |
| 7 | 角色滞后只被测量、不被主张；D-064 §1 三条 + D-066 §5 禁令仍在 | **PASS（禁令 1 需按 F-A7-3 收窄）** | §6.6；`f1/1` 3 s 测量 |
| 8 | 吊销仍是"请求级"；无"登出即断开"表述 | **PASS** | §6.7 |
| 9 | `setDocumentId` 的 `options` 不改变遗留调用点行为 | **PASS** | §6.8 |
| 10 | 证据产物真实（Chrome / backend URL / 端口 / 临时目录 / 活句柄） | **PASS** | §6.9 |
| 11 | P2-1…P2-9 有对应证据；P2-4 的 browser 列诚实；Node-only / 不可构造项如实标注 | **PASS（含 2 项覆盖限制与 3 项 Node-only）** | §6.10 |
| 12 | M2 五个关闭条件逐条判定 | **PASS：B3/F1/F2/F3/F5 满足，F2 需带风险** | §7 |
| 12b | 关闭所需的**记录**状态 | **FAIL** | §8 F-A7-1 / F-A7-3 / F-A7-4：四处文档仍在否认已实现的能力 |

---

## 10. 放行条件（每条含严重级别 / owner / 复核方法）

| ID | 条件 | 级别 | Owner | 修复后如何验证 |
| --- | --- | --- | --- | --- |
| **C-1** | 修 `CONTRACTS`（L9 版本表 → 7；§17 标题与 L791 改为 IMPLEMENTED，并注明由 §17.4/§17.5/§17.9 与 `f1/*`、`p2/*` 覆盖）、`ARCHITECTURE` §8 标题、`PROJECT.md:39` 的 Phase 2 状态 | **P1** | **A0** | `grep -n "NOT implemented" docs/CONTRACTS.md docs/ARCHITECTURE.md` → 0；`grep -n "SHARED_CONTRACT_VERSION = 7" docs/CONTRACTS.md` → 1；`grep -n "NOT STARTED" docs/PROJECT.md` → 0；三文件与 `packages/shared/src/index.ts` 的版本一致 |
| **C-2** | 修 `ARCHITECTURE` §8.2 的 `BINARY SYNC requires canEdit` 为 §17.5 的读/写拆分；同步 `registry.ts:188` 的总述注释 | **P2** | **A0**（文档）+ **A3**（该注释在 A3 owned 文件内，须 A0 授权后单独提交，仅注释） | `grep -n "requires \`canEdit\`" docs/ARCHITECTURE.md` → 0；`registry.ts` L188 与 L700 表述一致；`pnpm test` 仍 exit 0（纯注释改动） |
| **C-3** | 更新 `TASKS` Phase 2 状态行（44→48、关闭条件改为"F2 实现 backlog"）、「实现现状」表门控行、F3 行状态；补一句"关闭需负责人授权" | **P2** | **A0** | `grep -n "消费侧未接\|门控当前不生效" docs/TASKS.md` → 0；L461 与 L572/L574 不再矛盾；`grep -n "48/48" docs/TASKS.md` ≥ 1 |
| **C-4** | 新增 **D-069**：显式**收窄**（不是删除）D-064 §1 禁令 1；禁令 2/3/4 原样保留；写明"UI 门控生效 ≠ UI 是安全边界 ≠ 角色即时推送" | **P2** | **A0**（安全承诺措辞变更需项目负责人确认） | `grep -n "D-069" docs/DECISIONS.md`；D-064 §1 第 1 行标注被取代；三条禁令仍可检索 |
| **C-5** | `lib/app.mjs#openApp` 透传 `arrangeAccess`；`p2/5` 的降级断言改用 `waitForNewServerErrorCode` | **P3** | **A6** | `grep -rn "openApp(" tests/browser` → 定义含 `arrangeAccess`；`grep -c "waitForNewServerErrorCode" tests/browser/suite/20-…` ≥ 4；`node tests/browser/run.mjs` 仍 48/48 |
| **C-6** | 让 `pnpm test:unit`（及必要时 `test:server`）在缺少 `packages/shared/dist` 时也能独立通过，或在 README 明确其前置 | **P3** | **A0**（根 `package.json`） | 删除 `packages/shared/dist` 后 `pnpm test:unit` → exit 0（当前实测 exit 1 / 21 文件失败） |

**C-1…C-4 阻断"M2 宣布关闭 + 写 release notes"；C-5/C-6 不阻断，但必须进入 backlog 并在 M3 前处理或具名记录。**

---

## 11. Release Recommendation

### 11.1 结论

**有条件发布（GO WITH CONDITIONS）。** 对"M2 的实现"给出 GO；对"现在就把 M2 标 CLOSED 并写 release notes"
给出 **暂不**（C-1…C-4 为前置）。没有 NO-GO 级别的代码缺陷：四门禁全绿、48/48 浏览器证据、关闭条件的实现面
全部达成。

### 11.2 阻塞项

即 §10 的 **C-1（P1）**、**C-2 / C-3 / C-4（P2）**。四条都是文档级、都由 A0 单点可完成，且都有机器可验证的
复核命令。**没有任何一条需要改 `packages/shared/**`、wire 或生产逻辑。**

### 11.3 非阻塞观察

C-5、C-6（P3）；§6.10 的三项 Node-only 与两项覆盖限制；`D:\dev-temp` 中 38 个更早运行遗留的目录（与本次
门禁无关）；主 bundle 1.41 MB；`F2` 的实现仍在 backlog。

### 11.4 审查覆盖面

**读了**：`AGENTS.md`（R1–R16）、`agent-prompts/A7-integration-review.md`、`docs/CONTRACTS.md` §5.2 / §12 / §14–§17（含 §17.0–§17.9 全文）、
`docs/DECISIONS.md` D-060…D-068 全文（D-060/D-061/D-064/D-065/D-066/D-067/D-068 逐节；D-062/D-063 读其决定表）、
`docs/TASKS.md` M2 全节（含 P2 矩阵、四层边界、收口缺口表）、`docs/PROJECT.md` 里程碑行、`docs/ARCHITECTURE.md` §7/§8、
`tests/browser/README.md`（全文）、`tests/browser/suite/20-…`（关键场景全文 + diff 全量）、`suite/21-…`（全文）、
`lib/role-gate.mjs`（全文）、`lib/app.mjs`（`setDocumentId` / `openApp` / `readEditorGate` / `countOutboundSyncFrames` / probe）、
`apps/web/src/features/permissions/*`、`documentSlice.ts` 头注释、`packages/shared/src/collab-session.ts` 的 `getRole`、
`apps/server/src/rooms/registry.ts` 的 frame gate 与选项注释、`apps/server/src/index.ts` 头注释、`apps/server/src/authz/*.test.ts` 的用例清单。

**跑了**：四门禁（§5）+ 全仓 grep（`__qa`、禁令措辞、`mojibake`/控制字符/U+FFFD、`setDocumentId(`、`openApp(`）
+ `git show --stat 7ae4974` / `91bcf77` / `06ecf14` + `git diff --unified=0 a3ff4a9 57b9b5b` 的逐行分类 + 删除行全量列举
+ 字节级 UTF-8 扫描（167 个代码文件）+ `pnpm test:unit` 缺 dist 的对照实验 + 端口 / 临时目录 / 进程检查。

**没读 / 没跑（诚实边界）**：
- 我没有读 `apps/server/src/authz/**`、`persistence/**` 的**全部实现代码**——本轮判据是"M2 能否关闭"，
  我以契约 + 执行点 + 浏览器证据 + 门禁为准，**没有做逐行代码审计**（那属于 M2-P0 轮已完成的深度审查）。
- 我没有读 `docs/DECISIONS.md` D-001…D-059 的正文（只通过 D-059/D-060/D-064 的引用间接引用其结论）。
- 我没有读 `suite/00–07`、`10-…`、`06-lifecycle` 的源码，只读了它们的运行结果与 README 的场景映射。
- 我没有在 Firefox / Safari 上跑任何东西；没有做真实多机弱网浸泡。
- 我没有验证 `commenter` 在浏览器中的门控（该角色无浏览器行）。
- 我自己的 `pnpm install` 使用了 `--frozen-lockfile`，因此"锁文件与 `package.json` 一致"这一点只被间接验证。

---

## 12. Files Changed 与技术实现（AGENTS §4 对齐）

### 12.1 Files Changed

| 文件 | 职责 | 状态 |
| --- | --- | --- |
| `docs/agent-governance/A7-m2-final-review.md` | 本报告：M2 整体（M2-P0 + Phase 2）的独立终审结论、关闭条件判定、P2 矩阵对照、放行条件与 M3 风险清单 | **新增，唯一改动** |

**没有其它文件被修改。** 运行门禁产生的 `tests/browser/artifacts/{results.md,results.json,*.png}` 由套件自身生成、
被 `.gitignore:31` 忽略（证据，不是交付物）；我自己的临时日志在收尾时删除。

### 12.2 技术实现（本轮的"实现"= 审查方法）

- **数据流**：源码/契约（`docs/**`、`apps/**`、`packages/**`）→ 我执行的命令（门禁、`git`、`grep`、字节级扫描）
  → 原始输出 → 结论。**没有任何结论来自他人的报告或上一轮输出**；凡引用他人数字，都注明"我复跑"或"我复核"。
- **证据分层**：把每条判据映射到**它真正所在的层**（Node / 浏览器 / 静态检索），并显式标注 Node-only 与
  浏览器 N/A 的项（§6.10），避免把 Node 证据当浏览器证据。
- **设计选择**：对"是否放宽断言"这类问题，不读结论而**枚举被删除的行**（§6.2）；对"乱码是否清零"这类问题，
  不读 grep 计数而做**字节级严格解码 + 码点统计**（§4、§6.11）；对"夹具是否自证"，要求**否定证据**
  （`log.length === 0`、`membership() === null`）而不是"未观察到问题"（§6.3）。
- **为什么这样设计**：这三种做法分别针对本轮最容易出现假绿的三个位置——被弱化的断言、被控制台编码掩盖的
  乱码、被夹具悄悄发权限的"null 窗口"。否掉的替代方案是"采信 A6/D-068 的计数"，理由：A7 的职责是独立关口，
  采信即失去独立性（`agent-prompts/A7-integration-review.md` §2、§5）。

---

## 13. 与其它 Agent 的集成关系

| 方向 | 内容 |
| --- | --- |
| **我依赖** | A5（authz 判定核心、§17.4 端点）、A3（WS 执行点、`room-joined.role`、durable documents 源、B3）、A1（`getRole()` seam + v7）、A2（UI 门控三写路径）、A6（48/48 浏览器证据 + F3）、A0（契约、D-060…D-068、集成） |
| **依赖我** | A0 的里程碑关闭决定与 release notes 措辞；M3（AI）可以开始的前提是"M2 已关闭 + 权限上下文可用" |
| **我触碰的公共面** | 无。本轮只读代码，只新增 `docs/agent-governance/A7-m2-final-review.md` |
| **契约是否变更** | **否**。`SHARED_CONTRACT_VERSION = 7`、`PROTOCOL_VERSION = 2` 与 §5.2/§17.8 一致；我未提议任何 wire 变更 |

---

## 14. 给项目负责人的总结

M2 的两半现在都能成立：durable persistence 与 presence seam 已在 `m2-p0-gate` 上发布，Phase 2 的
session 认证与文档授权在服务端的 HTTP 与每一个 WebSocket 帧上真正执行，viewer 在真实浏览器里既打不进字、
也绕不过服务端，而"UI 不是安全边界"这条最重要的性质有了一条不依赖夹具自证的证据。
五个关闭条件（B3 / F1 / F2 / F3 / F5）在实现与证据层面**全部满足**：B3 的"只改了注释和标题"我按字节级
diff 形状独立复现，F3 的两条隐式发权限路径已经关掉并且有数据库级的**否定**证明。
真正没到位的不是代码，而是仓库的自我描述：`CONTRACTS` 仍把契约版本写成 2、仍说 §17 "NOT implemented"，
`ARCHITECTURE` §8 与 `PROJECT` 的 M2 行仍说 Phase 2 没开始，`TASKS` 的状态表仍说 UI 门控不生效，
而 D-064 里那条"UI 门控已生效为假"的禁令在 F1 关闭后已经过时却没有取代记录。
这不是可以顺手忽略的文字问题——同一个缺陷类已经让 M2-P0 付过一次 P1 的代价（D-059/D-060），
如果现在直接打 tag，tag 里的文档会否认 tag 里已经做到的事。
因此我的建议是：**先让 A0 把 C-1…C-4 四条记录修掉（半天内可完成、全部可用 grep 验证），
再由项目负责人做一次明确的 milestone closure / tag 授权。** M2 的实现已经可以关闭，缺的只是让仓库承认它。

---

## 15. Git 状态

- Branch：`agent/a7-m2-final-review`；被审查基线：`06ecf14`（clean）。
- 审查开始时 `git status --porcelain` 为空；运行四门禁后仍为空（`tests/browser/artifacts/**`、`*.log` 均被 `.gitignore` 忽略）。
- 唯一新增的受版本控制文件：`docs/agent-governance/A7-m2-final-review.md`（本文件）。
- **未执行**：merge / push / tag / remote 创建 / 里程碑状态变更。

---

## 16. Next Handoff

```text
Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
agent/a7-m2-final-review @ 06ecf14      ← 本报告合入后即 A0 的集成 HEAD

Why:
A7 的 M2 终审已完成：实现面 PASS（四门禁我本人重跑全绿，48/48 真实浏览器），五个关闭条件满足；
剩下的是 C-1(P1) / C-2 / C-3 / C-4(P2) 四条记录级收口，以及 C-5 / C-6 两条 P3 backlog。
这四条全部属于 docs/** 与 A0 的决策记录，必须由 A0 集成。

Dependencies satisfied:
冻结契约（§17，SHARED_CONTRACT_VERSION = 7，PROTOCOL_VERSION = 2）、F1 的 UI 门控、F3 夹具修复、
B3 的 diff 级证明、48/48 浏览器证据、四门禁在 06ecf14 全绿——A0 可以直接在此基础上做记录收口。
```

**A0 必须做 / 不得做的事：**

1. 把本报告合入（唯一新增文件）；按 C-1…C-4 逐条修正记录，每条用 §10 给出的命令自证。
2. C-2 的 `registry.ts:188` 注释在 A3 的 owned 文件内：A0 需先授权，再以**仅注释**的独立提交处理（D-065 §2 的同类先例）。
3. C-4 涉及**安全承诺措辞**（D-064 §1 禁令 1 的收窄），属 D-053 §3 级别，**必须**经项目负责人确认后再落记录。
4. **不得**由 A0 自行：把 M2 标 CLOSED、创建 `m2-closed` / `m2-p2-gate`、移动或删除任何既有 tag、push / 创建 remote。
   这些都需要项目负责人的**一次明确授权**（D-053 §5、D-065 §7、D-060 §3 的先例），不是 A0 可以假定的。
5. 若负责人授权关闭：建议的释出顺序是 `C-1…C-4 → 集成 HEAD 重跑四门禁 → 负责人授权 → tag / CLOSED 记录`，
   并把 §7 的 R1–R7 七条具名风险写进 M3 的启动说明（尤其 R1 吊销不追溯、R2 重启不自愈、R3 角色不推送）。

Copy-paste Prompt:

```text
你是 A0（Supervisor / Integration Lead）。工作树：本 worktree（agent/a7-m2-final-review @ 06ecf14 合入 A7 报告后）。

任务：把 A7 的 M2 终审报告（docs/agent-governance/A7-m2-final-review.md）合入，并逐条处理它的放行条件：

C-1（P1，文档事实）：
  - docs/CONTRACTS.md L9 版本表 2 → 7（与 packages/shared/src/index.ts 及 §17.8 一致）
  - docs/CONTRACTS.md §17 标题与 L791 的 "NOT implemented / Nothing … implemented yet" → IMPLEMENTED（指向 §17.4/§17.5/§17.9 与 f1/*、p2/* 证据）
  - docs/ARCHITECTURE.md §8 标题同上
  - docs/PROJECT.md L39 的 "M2 Phase 2（NOT STARTED）" → 已实现并通过 A7 终审
  验证：grep "NOT implemented" 两个文件 = 0；CONTRACTS 版本行 = 7；PROJECT 无 "NOT STARTED"。
C-2（P2）：ARCHITECTURE §8.2 的 "BINARY SYNC requires canEdit" 改为 §17.5 的读/写拆分（SyncStep1=canRead，
  SyncStep2/Update=canEdit，AWARENESS=canRead）；registry.ts:188 的总述注释同步。
  registry.ts 属 A3 owned：先授权，再单独提交、仅注释、跑 pnpm test 证明行为未变。
C-3（P2）：docs/TASKS.md Phase 2 状态行（44→48/48；关闭条件改为 F2 实现 backlog）、「实现现状」门控行
  （"门控当前不生效"必须消失）、F3 行状态（CLOSED，7ae4974，f1/3 否定证据）。
  验证：grep "消费侧未接|门控当前不生效" = 0；L461 与 L572/L574 不再矛盾。
C-4（P2）：新增 D-069 **收窄**（不是删除）D-064 §1 禁令 1：UI 门控对已知角色、以最近一次成功 join 的角色为准
  已生效；仍不得声称 UI 是安全边界 / 角色变更即时反映 / 服务端变弱。禁令 2/3/4 保留。
  该条是安全承诺措辞，落记录前必须拿到项目负责人确认。
C-5（P3，A6）：lib/app.mjs#openApp 透传 arrangeAccess；p2/5 的降级断言改用 waitForNewServerErrorCode。
C-6（P3，A0）：让 pnpm test:unit 在缺 packages/shared/dist 时也能独立通过（当前实测 21 文件失败 / exit 1）。

之后：在集成后的 HEAD 上重跑 pnpm typecheck / pnpm test / pnpm build / node tests/browser/run.mjs（期望 48/48）。
把 §7 的 R1–R7 七条具名风险写进 M3 启动说明。

禁止：自行把 M2 标 CLOSED、创建 m2-closed / m2-p2-gate、移动或删除既有 tag、push 或创建 remote。
milestone closure 与 tag 需要项目负责人的一次明确授权；在拿到授权前，只做记录收口并给出"待授权"状态。
```
