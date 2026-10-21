# A7 · M2 Milestone Closure Review — TOOLING-P2 之后能否关闭

- 审查者：A7（独立 Integration / Architecture Review）
- Worktree：`D:\前端\react\项目\面试项目\Insighthub-wt-a7-m2-closure`
- 分支：`agent/a7-m2-closure` @ `2b82a60fa482494de5ee11b063c916ad9fd2675c`
- 基线：`main` @ 同一 SHA（clean）、无 remote
- 审查日期：2026-10-21
- 本轮唯一新增文件：`docs/agent-governance/A7-m2-closure-review.md`

---

## 0. 结论先行

**判定：GO WITH CONDITIONS（实现、证据、工具链均可关闭；记录面还差一条 P2 修正）。**

1. **TOOLING-P2 真的修好了。** 我不是采信 D-071，而是自己复现了 A/B：同一失败形状下，
   用 stock `Awareness` 的对照跑到 **60 s 仍不退出、且聚合汇总一行都没打印**；改用
   `createTestAwareness` 后 **35.4 s、exit 1、`# tests 182 / # pass 181 / # fail 1`**。
   "全部 PASS 后不退出"与"失败被挂起吞掉"这条链路，现在**可观测地**变成了红色退出。
2. **四门禁在本 HEAD 全绿**：typecheck 0（10.6 s）／root test 0（42.7 s，vitest 34 files·378 tests +
   server **181/181**，聚合汇总 4 行齐全）／build 0（25.3 s）／浏览器 **48/48**（311.4 s，端口释放、
   11 个临时目录清理、无残留句柄）。
3. **重复运行稳定**：server 套件 **5/5**、root `pnpm test` **3/3**，全部自行退出并打印聚合汇总。
4. **关闭条件 B3 / F1 / F2 / F3 / F5(B2) 全部成立**（§8）。
5. **唯一阻断项是记录事实**：`docs/TASKS.md:379` 仍写 "**M2 Phase 2（权限/认证）尚未开始**"，
   与 Phase 2 COMPLETE（同文件 L461、D-070 §2 的官方口径）直接相反。一行修正即可（§7 N-1，P2，A0）。
6. **不建议在未修该行的情况下创建 `m2-closed`。** 若项目负责人明确豁免并留痕，可另论；
   否则应先落一个**仅文档**的提交，再把 tag 打在该提交上。

**关闭与打 tag 仍须项目负责人一次明确授权（D-070 §3 第 8 条）。这既不是我的权限，也不是 A0 的权限。**

---

## 1. 任务状态

| 项 | 值 |
| --- | --- |
| Status | **done**（审查完成；未修改代码/测试/契约/其它文档） |
| Branch | `agent/a7-m2-closure` |
| Worktree | `Insighthub-wt-a7-m2-closure` |
| Commit | 验证基线 `2b82a60`；本报告以**仅文档**提交落在本分支上（不合并、不 push、不打 tag） |
| 工作树 | clean（报告提交后 `git status --porcelain` 为空） |

---

## 2. 本轮目标

在项目负责人以 D-070 暂停 M2 关闭、把 **TOOLING-P2（测试进程偶发不退出）** 定为唯一 blocker、
A3 修完并由 A0 合入（D-071）之后，独立判断 **M2 现在能否关闭并创建 `m2-closed`**。
判据不是"实现做完了"，而是三件事同时成立：**四门禁真实全绿**、**TOOLING-P2 的机制被独立复现且失败不再被挂起吞掉**、
**仓库记录与事实一致**（M2 NOT CLOSED、Phase 2 COMPLETE、不得出现更强的安全承诺）。

---

## 3. 完成了什么

- 在**干净安装**的 worktree 上重跑四门禁，给出真实 exit code、真实测试计数、真实墙钟时间，
  并对每一次 server 运行单独记录**聚合汇总是否打印**（`1..N` / `# tests` / `# pass` / `# fail`）。
- 用**故障注入探针**独立复现 TOOLING-P2 的机制：`createTestAwareness` 版本失败后 **exit 1**；
  stock `Awareness` 对照组失败后 **不退出且无聚合汇总**。两个探针随后删除，工作树恢复 clean。
- 重复运行验证：`pnpm --filter @insighthub/server test` **5 次**、root `pnpm test` **3 次**。
- 独立重做 B3 的 diff 形状证明（`a3ff4a9..57b9b5b`，逐行机器分类）与全仓字节级乱码扫描。
- 逐条核对 F1 / F2 / F3 / F5(B2)、D-070 §3 八条、tags / remote / `main` 状态、PROJECT/TASKS 的状态口径、
  M3 七条具名风险与代码/测试现状是否一致。

---

## 4. 技术实现（本轮没有产品实现，只有审查方法）

数据流与判据：

```text
D-070 §3（八条 acceptance）
   ├─ 机制：root cause 必须可解释           → 我用 A/B 探针复现（不是读报告）
   ├─ 判据：不得用 timeout/force kill 造假  → 检查 scripts / package.json / 全套 grep
   ├─ 稳定性：两个命令都要自行退出          → 5 × server + 3 × root，逐次记录聚合汇总
   ├─ 门禁：最终 integrated HEAD 四门禁     → 我自己跑四门禁
   └─ 记录：clean tree / A7 review / 授权   → git status + 本文件 + 留给负责人
```

- **B3 用字节级分类，不信控制台输出。** 我第一遍用 PowerShell `Get-Content` 看文件时，
  `—`/`§` 也会显示成 `鈥?`/`搂`——这正是 A7 上一轮 D-066 §1 记下的教训（"乱码检测必须走字节级"）。
  因此最终判断全部改用 Node 以 UTF-8 读取：**真正的 mojibake 只有 6 行，且都在
  `authz-enforcement.test.ts` 的诊断字符串实参里**；`capabilityGate.ts`、`readOnlyNoticeCopy.ts`
  等文件在 UTF-8 下是干净的，控制台的"乱码"是 GBK 解码假象。
- **TOOLING-P2 用对照实验定位因果。** 唯一变量是 `Awareness` 的续期定时器是否 `unref`：
  其余代码（失败断言、缺失 `destroy()`、`node:test` 结构）完全相同。对照组复现挂起、
  实验组红色退出，因果链闭合。

---

## 5. 发现并修复的问题

**本轮我没有修改任何产品代码、测试或既有文档，因此没有"修复"项。** 所有发现见 §7；
其中 N-1 是唯一阻断关闭的记录问题（P2），其余为 P3。

---

## 6. Files Changed

| 文件 | 职责 | 状态 |
| --- | --- | --- |
| `docs/agent-governance/A7-m2-closure-review.md` | 本轮审查报告（唯一交付物） | 新增 |
| `apps/server/src/rooms/a7-tooling-probe.test.ts` | 故障注入探针（临时，验证 `createTestAwareness` 后删除） | 已删除，未提交 |
| `apps/server/src/rooms/a7-control-probe.test.ts` | 对照组探针（临时，stock `Awareness`，验证后删除） | 已删除，未提交 |

探针删除后 `git status --porcelain` 为空，`HEAD` 仍为 `2b82a60`。

---

## 7. Tests / Validation（真实结果）

环境：Windows、Node **v22.14.0**、pnpm **10.34.7**；
`pnpm install --frozen-lockfile` **13.6 s、288 包、exit 0**（本 worktree 原无 `node_modules`）。

### 7.1 四门禁（本 HEAD）

| # | 命令 | 真实结果 | exit | 墙钟 | 聚合汇总 |
| --- | --- | --- | --- | --- | --- |
| 1 | `pnpm typecheck` | shared / web / server 三个 `tsc --noEmit` 全 `Done` | **0** | 10.6 s | n/a |
| 2 | `pnpm test` | vitest **34 files / 378 tests passed**；server **`1..64` / `# tests 181` / `# pass 181` / `# fail 0`** | **0** | 42.7 s | **4 行全部打印** |
| 3 | `pnpm build` | `✓ built in 12.15s`；主 bundle **1,409.45 kB**（gzip 458.67 kB） | **0** | 25.3 s | n/a |
| 4 | `node tests/browser/run.mjs` | **scenarios: 48 · passed 48 · failed 0 · errored 0**；postflight：`ports 5173, 3101: released`、`temporary data directories removed: 11`、`live handles after teardown: none` | **0** | 311.4 s | 汇总行打印 |

`f1/1`…`f1/4` 在我的运行里逐条 PASS：
`f1/1` 14918 ms、`f1/2` 1422 ms、`f1/3` 3779 ms、`f1/4` 5787 ms。

### 7.2 重复运行（TOOLING-P2 的判据是"连续 N 次"，不是"一次侥幸"）

| 组 | 次数 | 结果 | 墙钟（每次） | 聚合汇总（每次） |
| --- | --- | --- | --- | --- |
| `pnpm --filter @insighthub/server test` | **5** | **5/5 exit 0**，均 `# pass 181 / # fail 0` | 32.9 / 33.2 / 37.3 / 37.9 / 36.1 s | `1..64`、`# tests 181`、`# pass 181`、`# fail 0` **全部打印** |
| `pnpm test`（root） | **3** | **3/3 exit 0**，vitest 34/378 + server 181/181 | 42.8 / 41.3 / 50.2 s | 同上，全部打印 |

没有任何一次挂起、没有任何一次缺聚合汇总。

### 7.3 TOOLING-P2 机制验证（决定性）

**a. helper 与不变式（读代码）**
`apps/server/src/rooms/test-harness.ts#createTestAwareness`（L580-586）创建客户端 `Awareness` 后，
取 `_checkInterval` 并 `unref()`；`test-harness.test.ts` 用 `assert.ok(timer)` +
`assert.equal(timer.hasRef?.(), false)` 把不变式**钉死**（若 `hasRef` 不存在，`undefined !== false` 会失败）。
全仓已无测试代码直接 `new Awareness(...)`：

- 迁移调用点 **7 处**（authz-enforcement 1、protocol-robustness 2、room-lifecycle 1、sync-isolation 3），
  另有 1 处新增的回归测试调用；生产端只有 `rooms/room.ts:206` 的**服务端** `Awareness`（不属本类泄漏）。

**b. 没有加"强制退出"类开关**
`package.json` 自 `74da34c` 到 HEAD **无改动**；server 脚本仍是
`tsx --test --test-concurrency=1 "src/**/*.test.ts"`（诚实地按 glob 跑全部测试）。
全仓 `*.json/ts/mjs/js/yml/ps1` 检索 `force-exit|forceExit|--test-force`：**0 命中**。
保留的 `--test-concurrency=1` 是 D-063 遗留的串行化参数，D-071 §4 已明确它**不是**本问题的修复，
也不再宣称它修好了 TOOLING-P2。

**c. 故障注入 A/B（我自己写、自己跑、自己删）**

| 变体 | 探针内容 | 结果 |
| --- | --- | --- |
| **实验组** | `createTestAwareness(doc)`，**不** `destroy()`，随后 `assert.fail(...)`；跑**完整 server 套件** | **exit 1**，35.4 s，`not ok 43`、`1..65`、`# tests 182`、`# pass 181`、`# fail 1` —— 失败可见、进程退出 |
| **对照组** | 同样失败、同样不 `destroy()`，但用 stock `new Awareness(doc)`（续期定时器仍 ref'd） | **60 s 后仍在运行**，输出里只有 `not ok 1`，**无** `# tests/# pass/# fail` 聚合汇总；随后被终止 |

对照组正是 D-071 §1 描述的形状（"结果都打完了，然后不退出"），实验组正是 D-070 §3 要恢复的性质
（"红色可见并退出"）。**机制成立，不是重跑运气。**

### 7.4 其它验证

- **C-6 / D-069 §4**：删除 `packages/shared/dist` 后 `pnpm test:unit` → **exit 0（7.4 s）**，
  `pretest:unit` 自动重建，修复有效。
- **B3 diff 形状**（见 §8.1）：115 行、非注释/非标题 **0**。
- **全仓字节级乱码扫描**（apps/packages/tests 全部 `.ts/.tsx/.mjs/.js`）：
  真 mojibake **恰好 6 行**，全在 `authz-enforcement.test.ts`；
  `room.ts` 的制表符图解、`fakeCollaborativeSession.ts` 的中文示例内容、`collaboratorPresentation.test.ts`
  的中文姓名是**合法内容**，不是转码损伤；无 U+FFFD、无控制字符残留。
- **仓库事实**：`git tag -l` = `m1-closed`、`m1-p0-baseline`、`m2-p0-gate`（**无 `m2-closed`**）；
  `git remote` 为空；`main` 与 worktree 同处 `2b82a60` 且 clean；
  `m2-p0-gate` 是 annotated tag，**tag 对象 `edfa8864d5aaac07bdacd2846a05bcaa23fa1f8f` → commit `dfc5389`**
  （注意：不是任务书里写的 `dfea886`；仓库文档本身未记录 tag SHA，只记"指向门禁全绿的最终 `main` HEAD"，
  与事实一致）。
- **安全承诺**：全仓检索 `立即生效 / 登出即断 / 自动恢复 / 自愈 / impersonation`，命中全部落在
  "禁止这种说法"的禁令文本或历史审查记录里，**没有一处**把请求级吊销写成即时吊销、
  把重启写成自愈、或把 demo bootstrap 写成 credential-level 认证。D-070 §4 的四条冻结表述
  在 `CONTRACTS` §17.2/§17.5、`TASKS` L491/L573、`ARCHITECTURE` §8.4 中仍可检索到。

---

## 8. Acceptance Criteria（逐项）

### 8.1 五个关闭条件

| 条件 | 判定 | 证据 |
| --- | --- | --- |
| **B3**（注释修复） | **PASS** | 我重跑 `git diff --unified=0 a3ff4a9..57b9b5b`：**115 行（+58/−57）**；字节级逐行分类 = 注释 **85 行（43 处）** + `describe`/`it` 标题 **30 行（15 对）** + **其它 0**；两版本 `describe`=10、`it`=21 **计数不变**。残留 mojibake **恰好 6 行**（L285/289/311/390/422/598，U+95B3/U+7368），**全部**是诊断字符串实参（4 处 `waitFor` 描述 + 2 处 `assert.*` 第 3 实参）；注释与标题内 0。仓库无任何"mojibake 已清零"表述，反而有三处明文禁止。 |
| **F1**（role → UI） | **PASS** | `document-session.ts:259-266` 的 `getRole()` 是**派生门**（`sessionState==='active' && networkStatus==='connected' ? roomRole : null`），`destroy()` 同时清 `roomRole`；`parseRoomJoinedRole` 用 `isDocumentRole` 校验、坏值一律 `null`。消费链 `useCollaborationSession.ts:124` → `capabilityGate` → `editorEditability`（`EditorState.readOnly` + `EditorView.editable`）/`runSessionHistory` / `readOnlyNoticeCopy`。§17.9 六条规则逐条对得上。`f1/1…f1/4` 在我自己的 48/48 运行里全 PASS。 |
| **F2**（吊销） | **PASS（作为具名风险）** | `CONTRACTS` §17.2 "Revocation scope … request-scoped, not retroactive"、§17.5 "Live socket + revocation" 写的是事实；实现确实**未做**：`authz.ts:205` 只 `sessions.revoke(token)`，不触碰已建 socket。TASKS "M3 前置" **R1** 具名记录。按 D-064 §2 第 2 项，这是**接受为 backlog 的契约澄清**，不阻断关闭，但发布说明不得称"吊销立即生效"。 |
| **F3**（夹具） | **PASS** | 两处隐式写点均关闭：`run.mjs#newAppPage`（L157-164）`role === null ⇒ arrangeAccess=false`，且不再调 `authz.grant`；`app.mjs#setDocumentId`（L133-137）新增 `arrangeAccess`，默认 `true` 保持遗留调用点行为不变。`f1/3` 的**否定证据**：开页前 `writesBefore=0 / membershipRow=null`，窗口期内仍为 0/null（L465-475、L528+），且 `offlineFirst` 保证从未 join。 |
| **F5 / B2**（ownership 行） | **PASS** | `TASKS` Phase 2 ownership 表 A3 行现在写的是"**例外（D-062 §1 已授权，A7 F5 指出本行与之处矛盾）**"，与 D-062 §1 不再冲突。 |

### 8.2 D-070 §3 的八条 acceptance

| # | 条目 | 判定 | 说明 |
| --- | --- | --- | --- |
| 1 | 可解释的机制级 root cause | **PASS** | D-071 §1 的解释（失败路径跳过 `destroy()` → ref'd 3 s 续期定时器 → 子进程不退出 → 聚合汇总不打印）被我 §7.3c 的 A/B 实验独立复现。 |
| 2 | 不依赖 timeout / force kill / `--test-force-exit` | **PASS** | 脚本未改；全仓 0 命中。`--test-concurrency=1` 保留但已明确不是修复，且它不是"强制退出"。 |
| 3 | server 套件与 root `pnpm test` 都稳定自行退出 | **PASS** | 5/5 + 3/3，均自带 exit 0 与聚合汇总。 |
| 4 | 重复运行、连续 N 次记录 | **PASS** | 本轮独立记录 5 + 3 次（另有四门禁各 1 次）。 |
| 5 | 修复后在最终 integrated HEAD 重跑四门禁 | **PASS（由本轮补齐）** | 我在 `2b82a60` 上跑完 typecheck/test/build/browser 四门；D-071 §3 当时只跑了前三项，`TASKS` L601 已如实记为"浏览器门待完成"——**记录是诚实的**，本轮把它补上。 |
| 6 | working tree clean | **PASS** | 探针删除后 `git status --porcelain` 为空。 |
| 7 | 再交 A7 做 closure review | **PASS** | 本文件。 |
| 8 | A7 通过后 A0 再请求一次 `m2-closed` 授权 | **未满足（待发生）** | 这是**授权动作**，不是缺陷；本项目前不得自行打 tag。 |

### 8.3 仓库事实

| 项 | 判定 | 证据 |
| --- | --- | --- |
| 无 `m2-closed` | **PASS** | `git tag -l` 只有 `m1-closed` / `m1-p0-baseline` / `m2-p0-gate`。 |
| `m2-p0-gate` 未移动 | **PASS** | tag 对象 `edfa8864d5aaac07bdacd2846a05bcaa23fa1f8f` → commit `dfc5389`（D-060 的 release commit）。 |
| 无 remote、未 push | **PASS** | `git remote` 0 条。 |
| `main` 与 worktree | **PASS** | 均为 `2b82a60`，`git status` 均 clean。 |
| M2 = NOT CLOSED | **PASS** | `TASKS` L379/L380/L461、`PROJECT` L39 都写 NOT CLOSED；`m2-closed` 明文"不存在、不得创建"。 |
| Phase 2 = COMPLETE | **FAIL（一处）** | `TASKS` L461、`PROJECT` L39 写 COMPLETE；但 **`TASKS` L379 仍写"M2 Phase 2（权限/认证）尚未开始"**（另 L396 历史引文仍带 `(NOT STARTED)`、L381 决策范围仍停在 `D-040…D-060`）。→ **N-1**。 |
| 无更强安全承诺 | **PASS** | 见 §7.4 最后一条。 |

### 8.4 条件分级（按严重级别 / owner / 复核方法）

| ID | 条件 | 级别 | Owner | 复核方法 |
| --- | --- | --- | --- | --- |
| **C-A7-M2-1** | 修 `TASKS` M2 段状态：L379 改"Phase 2 已实现并合入 `main`；M2 仍 **NOT CLOSED**（D-070）"，L396 的历史引文标注"（当时）"或改写，L381 决策范围补到 `D-071`；顺带把 L97（M1 期历史表）标为"截至 M1 收口" | **P2** | **A0** | `grep -n "尚未开始" docs/TASKS.md` → 0；L379 与 L461 不再互相矛盾；`grep -n "D-040…D-071\|D-040…D-071" docs/TASKS.md` → ≥1 |
| **C-A7-M2-2** | 修 `PROJECT` L39 的关闭前置："等 A7 final review 与负责人授权" → "A7 review 已完成（D-069）；唯一 blocker TOOLING-P2 已修（D-070/D-071），待负责人授权 `m2-closed`"；决策范围补 `D-070/D-071` | **P3** | **A0** | 人工读该行，并与 D-070 §2 的状态词表逐词对齐 |
| **C-A7-M2-3** | 修正 D-071 §2 的"6 处调用点"为 **7 处**（或写"6 个测试文件中的 7 处"） | **P3** | **A0** | `git show 3fe6a54 \| grep -c '^-.*new Awareness'` → 7 |
| **C-A7-M2-4** | 在 `D-064 §1` 禁令 1 行加一句"**已由 D-069 §3 取代（作废）**"的就地指针，避免读者只读 D-064 时被反向误导 | **P3** | **A0** | 打开 `DECISIONS.md` L2191，行内出现 `D-069` |
| **C-A7-M2-5** | 把 R8（`heartbeat.ts` stale reap timer）真正写进 `TASKS` 的 Backlog 段（当前只在 D-071 §5/TOOLING-P2 段提过，Backlog 段没有它） | **P3** | **A0** | `grep -n "reap\|heartbeat" docs/TASKS.md` 的 Backlog 段命中 |

> C-A7-M2-1 阻断"创建 `m2-closed`"；C-A7-M2-2…5 不单独阻断，但建议与 C-A7-M2-1 同一个**仅文档**提交，
> 因为 tag 一旦创建，这批文档就是该 milestone 的说明书。

---

## 9. 本轮新发现（此前无人提出）

### N-1（P2，文档事实）`TASKS` 的 M2 段头仍说 Phase 2 "尚未开始"

- **机制**：`docs/TASKS.md:379` 是 `dfc5389`（M2-P0 release）写入的段头状态，早于 Phase 2 全部工作。
  D-069 的 C-3 只改了 Phase 2 小节里的三处（L461/L563/L574），**没有任何一次提交回头改段头**。
  于是同一文件里段落头说"尚未开始"、80 行后说"feature/evidence/review 均 COMPLETE"。
- **影响**：`TASKS` 是关闭决定的阅读入口；只读 M2 段头的人会得出"Phase 2 还没开始"的相反结论。
  这正是 D-069 把"文档仍在否认 Phase 2 存在"判为 P1 的同一缺陷类；此处只剩一行，故定 P2。
- **复核**：`git blame -L 379` 指向 `dfc5389`；`grep -n "尚未开始" docs/TASKS.md` 命中该行。

### N-2（P3，文档事实）`PROJECT` 的关闭前置仍停在"A7 final review"

- **机制**：C-1 更新了 `PROJECT` L39 的 Phase 2 状态，但没有更新同一单元格里的关闭前置；
  D-069 之后 A7 review 已完成、D-070 把 blocker 换成 TOOLING-P2，这句话因此过期。
- **影响**：不反向否认任何能力，但会让读者以为 review 还没做、不知道唯一 blocker 是什么。
- **复核**：读 `PROJECT` L39，与 D-070 §2 的五状态词表对照。

### N-3（P3，记录准确性）D-071 §2 的"6 处调用点"少算 1 处

- **机制**：`3fe6a54` 实际把 **7 处** `new Awareness(...)` 迁到 `createTestAwareness`：
  protocol-robustness ×2、sync-isolation ×3、authz-enforcement ×1、room-lifecycle ×1。
  决策记录写"6 处"。不影响行为，但属于同一类"计数与仓库不符"。
- **复核**：`git show 3fe6a54` 的 `- new Awareness` 行共 7 条。

### N-4（P3，可导航性）`D-064 §1` 禁令 1 没有就地"已被 D-069 取代"指针

- **机制**：D-069 是**追加式**取代（决策记录的正常形态），但没有回头标注 D-064 原文；
  C-4 的验收提示里曾要求"第 1 行标注被取代"，实际只做了 D-069。
- **影响**：按任务书"先读 D-064"的人会读到一条现在为假的禁令，必须再翻到 D-069 才知道它作废。
- **复核**：`DECISIONS.md` L2191 行内无 `D-069`。

### N-5（P3，backlog 一致性）R8 声称"进 backlog"，但 Backlog 段里没有它

- **机制**：`TASKS` L602 写 R8"已记入 D-071 §5，进 backlog"，但 L589-595 的 Backlog 清单没有
  `heartbeat` / reap timer 条目；R8 目前只活在 D-071 §5 与 TOOLING-P2 小节里。
- **影响**：M3 若只从 Backlog 清单继承工作项，会漏掉 R8。
- **复核**：`grep -n "reap\|heartbeat" docs/TASKS.md` 在 Backlog 段无命中。

### 已由上一轮解释、不计为新发现

- D-066 §1 的"**115 行 = 注释 43 + 标题 15 + 其它 0**"混合了"单侧行"与"成对改动"两种单位
  （43+15=58；115 是单侧行数，85 = 注释行、30 = 标题行）。A7 上一轮 §6.11 已说明这一点；
  本轮复核结论不变：**"其它 0"为真**，只是措辞容易误读（可在 C-A7-M2-1 同一提交里顺手写成"85 + 30 = 115"）。

---

## 10. 与其它 Agent 的集成关系

- **依赖**：D-070/D-071 的裁定与 A3 的修复（`3fe6a54`）、A0 的 `--no-ff` 集成（`d8a2a99`）、
  A1 的 `getRole()`（v7）、A2 的 UI 门控、A6 的 `f1/*` 证据。
- **被依赖**：本报告是 D-070 §3 第 7 条；A0 只有在它通过后才能执行第 8 条（向负责人请求 tag 授权）。
- **未触碰**：`packages/shared/**`、`apps/**`、`tests/**`、`docs/CONTRACTS.md`、`docs/ARCHITECTURE.md`、
  `docs/DECISIONS.md`、`docs/TASKS.md`、`docs/PROJECT.md`、任何 `package.json`。契约未变。
- **公共面**：`CollaborativeSession.getRole()` 仍是唯一新增 seam（`SHARED_CONTRACT_VERSION = 7`，
  `PROTOCOL_VERSION = 2`）；本报告不改变任何接口。

---

## 11. Known Risks / 未验证内容

### 11.1 七条 M3 具名风险是否仍与现实一致

| # | 风险 | 现状核对 | 是否需在关闭 M2 前升级 |
| --- | --- | --- | --- |
| R1 | 吊销不追溯已建 socket | **仍真**：`authz.ts:205` 只撤销 token、不触碰已建 socket；`CONTRACTS` §17.2/§17.5 如实写明；`writeApplied: true` 见 D-064 记录 | 否（D-064 已接受）；M3 kickoff 必须点名 |
| R2 | session 进程内、401 后不重新 bootstrap | **仍真**：session-store 在内存、12 h；web 侧检索不到 401 重引导逻辑；`reBootstrapped=false` / 页面停在 `reconnecting` 见 D-064 与 A7 上一轮记录（`p2/S` 只记录事实，不断言自愈） | 否；M3 必须点名 |
| R3 | 角色变更不推送 | **仍真**：`protocol.ts` 无 role-change 消息类型（0 命中），`PROTOCOL_VERSION` 仍 2；`f1/1` 实测降级 3 s 后 UI 仍是 editor | 否；M3 若要即时性须先改契约 |
| R4 | 6 处 B3 residual 诊断字符串 | **仍真**：字节级扫描恰好 6 行 | 否；**不得**写成"清零" |
| R5 | `commenter` 无浏览器行；"被拒 join 之后"的 null 窗口未覆盖 | **仍真**：`tests/browser/suite/*.mjs` 中 `commenter` 0 命中；`f1/3` 只覆盖 offline-first | 否；引用 P2-4 时不得泛化 |
| R6 | `lib/app.mjs#openApp` 仍隐式 `arrangeAccess` | **仍真**：`openApp(` 只有定义、无调用者 | 否；**但 M3 任何新场景用 `openApp` 前必须先修** |
| R7 | 主 bundle 1.41 MB | **仍真**：本次 build 1,409.45 kB | 否 |

**结论：七条全部仍与现实一致，没有一条需要在"关闭 M2"之前升级为 blocker。**
需要在 M3 kickoff 解决的仍是 R1 / R3（契约/实现级）与 R4 / R6（表述与夹具纪律）；
R8（heartbeat stale reap timer）是 M2 新具名风险，生产参数 `interval 30 s > timeout 10 s` 下不可达
（`rooms/constants.ts:23/33`），不阻断关闭，但应补进 Backlog（C-A7-M2-5）。

### 11.2 未验证 / 覆盖边界

- **没读**：`apps/server/src/authz/**` 与 `persistence/**` 的全部实现（本轮判据是"能否关闭"，
  以契约 + 执行点 + 浏览器证据 + 门禁为准，未做逐行代码审计；那是 M2-P0 轮已完成的工作）；
  `DECISIONS.md` D-001…D-063 正文；`tests/browser/suite/00–20` 的源码（只看了运行结果）；
  `M0/M1` 全节。
- **没跑**：Firefox / Safari；真实多机弱网浸泡；A3 声称的"10/10 + 4 个 CPU 占用进程下 5/5"
  （我独立跑了 5 + 3 次，未复刻其 CPU 压力场景）；浏览器套件只跑 **1 次**（48/48），未重复；
  未在 CI/Linux 上跑。
- **未构造**：服务端房间 `Awareness` 在"测试失败且跳过 `finally`"时的泄漏（所有现有测试都在
  `try/finally` 里 `close()`；而且未关闭的 `http.Server` 本身就会让进程不退出，这种探针没有判别力）。
- **`m2-p0-gate` 的点位**：我只验证了 tag 对象/commit 与 D-060 的文字一致，未逐字节复核
  `dfc5389` 当时的四门禁结果（依赖 D-060 的记录）。

---

## 12. Need Supervisor Decision

1. **是否按 C-A7-M2-1 先落一个仅文档提交再打 tag。** 我的建议：**是**。改的是 `TASKS.md`（+可选 `PROJECT.md`、
   `DECISIONS.md` 的计数/指针），不碰代码，四门禁无需全量重跑（但应至少 `pnpm test` 一次以证明 tree 仍绿）。
2. **tag 落点**：我验证的 SHA 是 `2b82a60fa482494de5ee11b063c916ad9fd2675c`；若接受 C-A7-M2-1，
   应把 tag 打在**修完文档后的那个 commit** 上（它是 `2b82a60` 的后代）。若坚持打在 `2b82a60`，
   需要项目负责人**明确豁免**并留痕——那样 tag 会包含一行与事实相反的 Phase 2 状态。
3. **`m2-closed` 的创建与 push**：仍须项目负责人一次明确授权；本报告不授权，A0 也不得自行执行。

---

## 13. 给项目负责人的总结

上一轮 A7 终审给出 GO WITH CONDITIONS：实现可以关闭、仓库记录还不行；A0 修完文档后，您在最后一刻
因为 **TOOLING-P2（测试进程偶发不退出）** 叫停了关闭——这个判断后来被证明是对的：D-071 查明那不是"卡住"，
而是一次**被挂起吞掉的红色运行**。本轮我独立复现了这条机制：同样的失败形状，用 stock `Awareness` 会
60 s 不退出且不打印任何汇总；用修复后的 helper 则 35 s 内 exit 1 并打印 `# fail 1`。
四门禁在 `2b82a60` 上全绿（typecheck 0 / vitest 378 + server **181/181** / build 0 / 浏览器 **48/48**），
server 套件 5/5、root 5 + 3 次重复运行全部自行退出并带聚合汇总，工作树 clean，没有 `m2-closed`、没有 remote。
剩下的问题只有一处：`TASKS.md:379` 仍写着"Phase 2 尚未开始"，与同一文件里的 COMPLETE 和 D-070 的口径相反。
把那一行（连同几处 P3 的过期指针）改成事实，再请您做一次 `m2-closed` 授权，M2 就可以干净地关闭了。

---

## 14. Git 状态

```text
branch:  agent/a7-m2-closure
base:    2b82a60fa482494de5ee11b063c916ad9fd2675c   ← 四门禁与全部实验的验证基线
commit:  本报告所在提交（docs-only；父提交为上面的 base）
main:    2b82a60fa482494de5ee11b063c916ad9fd2675c (clean)
status:  clean（报告提交后无未跟踪/未提交改动；两个临时探针已删除、未提交）
tags:    m1-closed(43da16f -> f3c353e), m1-p0-baseline(f031063),
         m2-p0-gate(annotated edfa8864 -> dfc5389)
remote:  none
```

---

## 15. Next Handoff

```text
## Next Handoff

Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
main @ 2b82a60fa482494de5ee11b063c916ad9fd2675c

Why:
TOOLING-P2 已被独立复证为"真的修好"（失败 exit 1 + 聚合汇总；stock Awareness 对照 60 s 不退出），
四门禁全绿、5+3 次重复运行稳定、关闭条件 B3/F1/F2/F3/F5 全部成立；只剩一条 P2 文档事实
（TASKS:379 "Phase 2 尚未开始"）需要 A0 用一个仅文档提交修掉。

Dependencies satisfied:
四门禁在 2b82a60 上独立重跑全绿；server 181/181 与 root 378+181 均带聚合汇总自行退出；
48/48 浏览器（含 f1/1…f1/4）；working tree clean；无 m2-closed、无 remote。

Copy-paste Prompt:
A0：按 A7 `docs/agent-governance/A7-m2-closure-review.md` 的 C-A7-M2-1（P2）先落一个**仅文档**提交，
把 `docs/TASKS.md` L379 的"Phase 2 尚未开始"改成"Phase 2 已实现并合入 main；M2 仍 NOT CLOSED（D-070）"，
并顺带处理 L396/L381（以及可选的 C-A7-M2-2…5）。提交后跑一次 `pnpm test` 证明 tree 仍绿、确认
`git status` clean，然后**向项目负责人请求一次 `m2-closed` 授权**；在拿到授权前不得创建 tag、不得 push。
```
