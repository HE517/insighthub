# M3 round 1 独立终审报告（A7）

**Base：** `main @ 990b9be`（A1 锚定 v8、A4 编排、A2 Diff Preview、A5 权限复核、A6 七个永久浏览器场景）
**Branch：** `agent/a7-m3-final`
**Worktree：** `D:\前端\react\项目\面试项目\Insighthub-wt-a7-m3-final`
**日期：** 2026-10-22
**结论先说：** **GO WITH CONDITIONS** —— 用于"接受 M3 round 1"，**不**用于关闭 milestone。
**P1 = 0，P2 = 2，P3 = 10**（详见 §14）。四门禁在本 HEAD 全绿（typecheck 0 / vitest **465** + server **181** / build 0 / browser **60/60**），A–H 逐条 PASS。
两条 P2 都是**文档与冻结语义不一致**（`docs/PROJECT.md` 仍写 M3 "not started"；`docs/ARCHITECTURE.md` §3 仍写"远端移动也 stale"），不是代码缺陷；关闭 milestone 前必须先清掉，并完成 A0 对 A5 三项未决项的裁定。

---

## 0. 我的独立性声明

- 我没有采信任何 agent 的自述作为结论依据。A5 报告、A6 场景的**描述**只作为"待验证的假设"；每一条结论下面给的要么是我读到的代码行，要么是我自己跑出来的输出，要么是我自己构造的探针结果。
- 我在这个 worktree 里做了**全新安装**（无 `node_modules` → `pnpm install --frozen-lockfile`），四门禁由我自己串行执行；浏览器套件跑之前我先确认 `5173`/`3101` 都是 free，跑完 postflight 确认已释放。
- 我写的探针文件（`apps/web/src/features/ai/a7Probe.test.ts`，21 个用例）跑完已删除；mutation 实验改动过 `packages/shared/src/ai-anchor.ts` 一行，已用 `git checkout` 还原并重建 shared。最终 `git status` 只有本报告一个新增文件（§21）。
- 我没有改任何生产代码、测试、契约或其它文档。

---

## 1. 任务状态

- `Status`: **done**（审查本身完成；被审对象 = M3 round 1）
- `Branch`: `agent/a7-m3-final`
- `Worktree`: `D:\前端\react\项目\面试项目\Insighthub-wt-a7-m3-final`
- `Commit`: **未提交**（本轮唯一交付物是本报告）
- **Release Recommendation**: `GO WITH CONDITIONS`（接受 round 1）；milestone 关闭 = **NO**（条件见 §15）

## 2. 本轮目标

在 `990b9be` 上独立回答：M3 round 1 是否达到了 D-075 §6 的 A–H；"提案 → 审阅 → 应用 → 撤销"这条闭环的安全语义（三段校验、revision 归属、undo 隔离、权限、离线）是否真的成立、是否有旁路；冻结契约（v8 + PROTOCOL 2）与既有文档是否与代码一致；以及还有哪些残留/新限制必须在关闭 milestone 前处理。

## 3. 完成了什么（结论，不是活动）

- **四门禁在本 HEAD 自跑全绿**：`typecheck 0` / `pnpm test 0`（vitest 465 + server 181）/ `build 0` / browser `60/60`，各有真实耗时与 exit code（§5）。
- **锚定与三段校验用对抗性探针独立验证**：多 operation 降序应用逐字正确、`replace length=0`、文档末尾 insert、空文档 insert、`expectedText` 改成相邻文本 → `text-mismatch`、删除锚定区域后 anchor **仍可解析**且结果是 `text-mismatch`（不是 `anchor-unresolved`）（§6）。
- **mutation 证伪**：把 `expectedText` 比较改成恒真后，**3 个测试文件 / 4 个测试变红**（含 `apply.test.ts` 与 `aiProposal.test.ts` 的端到端用例），还原后全绿 —— 这层保护不是恒真断言（§6.7）。
- **TOCTOU 结论**：`applySuggestion` 的 `validate → transact` 之间**没有任何异步点**（同一同步调用栈），探针用"先排队的 microtask"证明了 apply 整体在 microtask 之前完成（§6.6）。
- **revision 语义独立验证**：只计 `local`/`ai`；`remote`、`persistence`、y-indexeddb 式外部 origin 均不计数；`m3/8`/`m3/9` 依赖的正是这一点（§7）。
- **undo 隔离用真实 `Y.Doc` + `Y.UndoManager` 复现**：本地 undo 撤回自己的 local/AI 编辑、绝不回滚 remote；`captureTimeout` 合并行为可复现，属 Yjs 既定语义而非实现缺陷（§8）。
- **权限三层独立复核**：UI 门控、`applySuggestion` 无权限检查（`features/ai/**` 生产代码 0 处 role/canEdit 引用）、服务端 frame gate 在 apply/persist/broadcast 之前拒绝；在线 viewer 的程序化点击不写文本、不发 SYNC 帧；离线 `getRole() === null` 的本地分叉不出站、reload 后仍在、durable 不变（§9）。
- **契约/文档一致性**：`SHARED_CONTRACT_VERSION = 8`、`PROTOCOL_VERSION = 2`、server 与 wire 文件零改动；§11.1 与实现逐条对齐；发现 2 条 P2 与若干 P3 文档不一致（§10、§14）。
- **A–H 逐条判定**：全部 PASS，每条附我自己的证据（§11）。
- **残留 R1–R9 逐条对照 + M3 新增限制清单**（§13）。

## 4. 复核方法与独立性说明

| 手段 | 具体做法 |
| --- | --- |
| 读代码 | 以冻结文档为规格，逐条对照实现；不读测试名当证据 |
| 自跑门禁 | 全新安装后串行跑四门禁；浏览器套件独占端口 |
| 自写探针 | 21 个临时 Vitest 用例，全部用真实 `Y.Doc`/`Y.UndoManager`，不 mock Yjs；跑完删除 |
| mutation | 只改 `ai-anchor.ts` 一处比较，验证测试确实能红；还原后重建并复跑 |
| 交叉验证 | A5/A6 的结论只在"我自己也观察到同一现象"时才引用；引用时给的是我的运行输出 |
| 范围对照 | `git diff 9800612..990b9be`（M3 窗口）确认改动面，没有触碰 server/wire/依赖 |

**M3 窗口的改动面（`git diff --name-only 9800612..HEAD`）**：新增 `apps/web/src/features/ai/**`、`AiSuggestPanel.tsx`、`aiProposalCopy.ts`、`shared/ai-anchor.*`、`shared/ai-suggestion.*`、`tests/browser/suite/31-m3-ai.mjs`，改 `DocumentWorkspace.tsx` / `DocumentHeader.tsx` / `CollaborativeMarkdownEditor.tsx` / `styles.css` / 文档，另有窗口内的 R9 cursor label 修复（`95ea216`，`remoteCursorExtension.ts`，不属于 M3 AI 本体）；`apps/server/src/**`、`packages/shared/src/binary-frame.ts`、`protocol.ts`、所有 `package.json` / `pnpm-lock.yaml` **零改动**。

## 5. 四门禁（我在 `990b9be` 上自跑，真实计数、exit code、耗时）

安装前提：删除态 worktree（无 `node_modules`）。

```text
$ pnpm install --frozen-lockfile
Scope: all 4 workspace projects
Lockfile is up to date
Packages: +288
Done in 10.5s using pnpm v10.34.7
exit code: 0        （本次调用墙钟 10.7 s）
```

| # | 命令 | exit | 真实计数 | 耗时（墙钟） |
| --- | --- | --- | --- | --- |
| 1 | `pnpm typecheck` | **0** | shared / server / web 三个 project `Done` | **7.2 s** |
| 2 | `pnpm test` | **0** | vitest `Test Files 41 passed (41)` / `Tests 465 passed (465)`；server `# tests 181` / `# pass 181` / `# fail 0` | **35.1 s**（vitest 3.83 s + server 27.8 s） |
| 3 | `pnpm build` | **0** | shared+server tsc，web `tsc --noEmit && vite build`；168 modules；主 chunk `955.54 kB`（gzip 313.34） | **14.2 s**（vite 3.76 s） |
| 4 | `node tests/browser/run.mjs` | **0** | `scenarios: 60 · passed 60 · failed 0 · errored 0` | **299.4 s** |

**`pnpm test` 是否打印聚合汇总？** **没有。** 它是 `vitest run && pnpm --filter @insighthub/server test`，先后打印两套互不相干的 reporter 输出：vitest 的 `Test Files / Tests`，然后 node:test 的 `# tests / # pass / # fail`。**不存在** "646" 之类的合并总数；报告读者必须自己相加。这是脚本结构决定的，不是本轮新问题，但会让"465 + 181"这类表述依赖人工加法。

**浏览器套件细节（我自己这一跑）**：

```text
launching the browser…
  Chrome/155.0.8059.85 (C:/Program Files/Google/Chrome/Application/chrome.exe)
…
scenarios: 60 · passed 60 · failed 0 · errored 0
postflight:
  ports 5173, 3101: released
  temporary data directories removed: 11
  live handles after teardown: none (the process exits on its own)
exit code: 0（299.4 s）
```

- 跑前检查：`PORT 5173 free` / `PORT 3101 free`；跑完 postflight 显示已释放。**全程只有一个浏览器套件在跑**。
- stderr 只有 Node 的 `SQLite is an experimental feature` 警告与 PowerShell 对 Vite `>500 kB chunk` 警告的包装，**不是失败**；退出码 0 与 60/60 是判据。
- 60 = 既有 53 + M3 新增 7（`m3/5`…`m3/11`）；既有 53 场景在本轮全部 PASS（零回归）。

## 6. 锚定与校验的对抗性验证（自己构造并运行）

命令：`pnpm exec vitest run apps/web/src/features/ai/a7Probe.test.ts` → **21 passed / 0 failed / exit 0**；文件跑完已删除。

### 6.1 三个 operation、同一行、索引相近 → 降序应用

文档 `0123456789`，operations **按列表顺序** 为：`insert "AA"@3`、`replace 4..6 -> "ZZ"`、`insert "BB"@3`。

- 实测结果：`012AABB3ZZ6789`，`{ok:true, applied:3}`。
- 我另外按**升序**手工应用同一组 operations，得到不同文本并断言 `!== "012AABB3ZZ6789"` —— 证明降序（以及同 index 时"后列先应用"）是**载重**语义，不是可交换的。
- 同 index 两个 insert 的并列规则与 `apply.ts` 的 `sort((l,r)=> r.range.index-l.range.index || r.order-l.order)` 一致；结果中 `AA` 在 `BB` 之前，符合"列表顺序 = 结果顺序"。

### 6.2 边界与退化输入

| 用例 | 结果 |
| --- | --- |
| `replace` 且 `length === 0`（`abc|def` @3） | `{ok:true}`，文本 `abcXYZdef`（delete(3,0) + insert 不误删） |
| `insert` 在**文档末尾**（`abcdef` @6） | `{ok:true}`，文本 `abcdef!` |
| **空文档**上的 `insert` @0 | `{ok:true}`，文本 `hello`（空 `Y.Text` 铸出的 start 锚仍可解析） |

### 6.3 `expectedText` 改成相邻文本

`alpha beta gamma` 中 `replace 6..10 -> "BETA"`，把 `anchor.expectedText` 从 `"beta"` 改成相邻的 `"beta "`：返回 `{ok:false, reason:"text-mismatch"}`，文档逐字未变。**不是** `anchor-unresolved`、**不是** `malformed`。

### 6.4 删除锚定区域：anchor 仍能解析，结论必须是 `text-mismatch`

用真实第二个 replica（remote origin）删除 `"quick"` 后合并：

- 本地文本变为 `The  brown fox`；
- `decodeRelativePosition` + `Y.createAbsolutePositionFromRelativePosition` 实测 start 仍解析到 **index 4**（不是 null）——这正是 D-075 §2 / §11.1 说的"墓碑仍可解析"；
- `applySuggestion` 返回 **`text-mismatch`**，**不是** `anchor-unresolved`。

这条直接验证了 `expectedText` 的存在理由：只用 RelativePosition 会把这段"解析成功"当成安全。

### 6.5 冲突守卫不会误拒合法多 op

- **相邻 replace** `[0,3) -> XYZ` + `[3,6) -> UVW` + **insert 正好在第二个 replace 的独占末尾** @6：三个全应用，文本 `XYZUVW!`。
- 同 index 两个 insert：不冲突（tie-break 决定顺序）。
- **insert 落在 replace 的 start**：`{ok:false, reason:"malformed"}`，文档不变 —— 与 D-076 裁定 2（两种顺序产生不同文档，拒绝）一致。
- 结论：守卫只拒绝"无法无歧义执行"的组合；local provider 每次只产出一个 intent，且同一快照上铸出的 ranges 天然不相交，因此**没有发现对合法建议的误拒路径**。

### 6.6 TOCTOU：`validate → transact` 之间有没有异步点

**读代码结论：没有。** `applySuggestion`（`apps/web/src/features/ai/apply.ts:86-126`）依次执行：

1. `validateSuggestionAgainstDocument`（纯同步：`text.toString()` + 相对位置解析）；
2. 同步的双层冲突检查；
3. 同步排序；
4. `port.transact(...)`。

从第 1 步到第 4 步之间没有 `await`、没有 Promise、没有 `queueMicrotask`、没有 `setTimeout`；`session.transact`（`apps/web/src/collab/internal/document-session.ts:268-272`）本身也是同步 `doc.transact`。因此 JS 单线程下，不可能有另一个 update 插进"校验完成"和"写入开始"之间。

**探针佐证**：在调用 `applySuggestion` 之前排队一个 `queueMicrotask`（其中做 remote 插入），实测 update 事件顺序为 `['ai','microtask','other','after']`，`transact` 只被调用一次，且 `transact` 内部观察到的文本仍是校验时的 `base`，最终文档 `RBASE`，返回值 `{ok:true,applied:1}`。也就是说 apply 整体在 microtask 之前同步完成。

**唯一的"时间窗"在更外层**：provider 生成是 `async`（尽管本地 provider 内部没有真实 I/O）。这段窗口由 `buildSuggestion` 的 `text === anchorText.toString()` 复查（不一致 → `TypeError`）与 anchor 的 `anchor-unresolved` 兜底；探针 7 验证了快照不一致会抛错而不会铸出错误锚。**这不是 TOCTOU 写入，而是 fail-closed 的生成失败**。

### 6.7 mutation：这段保护是不是恒真断言

把 `packages/shared/src/ai-anchor.ts:325` 的

```ts
if (documentText.slice(start, end) !== expectedText) return failure('text-mismatch');
```

临时改成 `if (false) ...`，重建 shared 后跑三个测试文件：

```text
Test Files  3 failed (3)
     Tests  4 failed | 36 passed (40)
exit code: 1
```

`--reporter=verbose` 下 **4 个失败用例的精确名字**是：

1. `ai-anchor.test.ts > returns text-mismatch for a deleted range, and proves the anchor still resolves`
2. `ai-anchor.test.ts > returns text-mismatch when the region was replaced with different text`
3. `apply.test.ts > returns \`text-mismatch\` when the anchored range changed`（期望 `text-mismatch`，实际 `{ok:true,applied:1}`）
4. `aiProposal.test.ts > a REMOTE edit inside the anchored range is rejected by the anchor text, not by revision`（同上）

**测试确实能红**，这层比较不是恒真断言。还原（`git checkout -- packages/shared/src/ai-anchor.ts`）+ 重建 shared + 复跑同样三个文件：`Test Files 3 passed (3)` / `Tests 40 passed (40)` / exit 0。

## 7. revision 语义（只计 `local`/`ai`）

**代码**：`revision.ts:63-66` 的 `REVISION_COUNTED_ORIGINS = [local, ai]`；`revision.ts:118-120` 用显式成员测试而不是 `origin !== remote`，未知 origin 默认**不计数**；订阅点是 `doc.on('update')`（每个事务一次）。

**探针实测**（真实 `Y.Doc`）：

| 操作（origin） | tracker 值 |
| --- | --- |
| 初始 | 0 |
| `local` 插入 | 1 |
| `ai` 插入 | 2 |
| `remote` 插入 | **2** |
| `persistence` 插入 | **2** |
| 一个"y-indexeddb provider 对象"origin 插入 | **2** |
| 一个 `local` 事务里插两个字符 | **3**（一事务一 revision，不是一字符一 revision） |

**`m3/8` / `m3/9` 依赖的正是这一点**（我独立复现）：

- 生成时 base = 0；远端在锚定区域**外**插入 → tracker 仍 0 → check #1 通过 → 应用成功，文本同时含远端前缀与 AI 编辑（对应 `m3/8`）。
- 远端删除区域**内**文本 → tracker 仍 0 → 结果必须是 `text-mismatch`（**不是** `revision`）（对应 `m3/9`）。

**但有一个实现与注释不符的细节（新发现 F6）**：`revision.ts:56-59` 写"一次 undo step 也会让计数器 +1"。实测 **不是**：yjs 13.6.33 的 undo/redo 事务 origin 是 **UndoManager 实例本身**（`node_modules/.../yjs.cjs` 中 `popStackItem` 末尾 `}, undoManager);`），既不是 `local` 也不是 `ai`，所以 undo/redo **不移动计数器**。可复现后果：生成提案 → 打字（rev=1）→ undo（文本回到原样，rev 仍 1）→ Accept 报 `revision`，尽管文档已经回到提案的前提。这是**保守失败**（fail-closed），不是安全漏洞，但注释是错的，且用户会看到一个"明明没改却 stale"的提示。

## 8. undo 隔离（真实 `Y.Doc` + `Y.UndoManager`）

构造方式与生产一致：`new Y.UndoManager(text, { trackedOrigins: new Set([local, ai]) })`（`document-session.ts:534-536` 同样没有覆盖 `captureTimeout`）。

| 场景 | 实测 |
| --- | --- |
| local 编辑 + remote 编辑，undo 一次 | `REMOTE-base-local` → `REMOTE-base`：**local 被撤回，remote 保留**；再 undo 不变（remote 从不入栈） |
| 接受 AI 编辑 + remote 编辑，undo 一次 | `REMOTE-hello WORLD` → `REMOTE-hello world`：**AI 编辑被撤回，remote 保留** |
| 阻塞等待 500 ms 后接受的 AI 编辑 | 只撤回 AI 编辑 |
| **D-076 §4a**：同一 capture 窗口内（<500 ms）"先打字 L、立刻接受 AI A" | `ALbase` → 一次 undo → `base`（**两条都被撤回**，即两个 tracked 事务合并成一个 undo item） |
| 窗口外（>500 ms）的两次 AI 事务 | 一次 undo 只撤回较晚的那条 |

结论：`captureTimeout` 合并是 Yjs 的既定行为，**不是实现缺陷**；代码没有覆盖 `captureTimeout`，符合 D-076 §4a 的"不要为了这个改"。
边界：`undo` 期间的同步事件（editor reconcile）由 `syncOrigin.ts` 的 sentinel 防止被误当成 local 写回（`syncOrigin.ts:1-25`），浏览器 `m3/5` 也实测了"一次 Undo 只撤回 AI 编辑"。

## 9. 权限与旁路（独立复核 A5 的结论）

### 9.1 三层判定点（我读到的代码）

| 层 | 判定点 | 结论 |
| --- | --- | --- |
| UI | `DocumentWorkspace.tsx:151` `capabilityGate(role)` → `AiSuggestPanel` 的 `acceptDisabled = !canEdit \|\| phase !== 'proposal'`（`:248`）与 `accept()` 内 `if (!canEdit) return`（`:200`） | 已知 viewer/commenter：不可点、程序化点击也被第二道守卫吞掉 |
| 客户端写 | `applySuggestion` 只经 `port.transact(fn, TRANSACTION_ORIGINS.ai)`（`apply.ts:114-123`）；`features/ai/**` 生产代码 **0 处** `canEdit`/`getRole`/`DocumentRole` 引用 | **不做权限判定**（设计如此：拿的是 `{doc, transact}` 窄端口） |
| 服务端 | `#authorizeFrame`（`registry.ts:716-760`）：`SyncStep1`/`AWARENESS` 需 `canRead`，`SyncStep2`/`Update` 需 `canEdit`；拒绝发生在 `#dispatchDecodedFrame` 之前 | 越权 mutation 在 apply/persist/broadcast 之前被 `FORBIDDEN`，socket 保持可读 |

`applySuggestion` 无权限检查不是漏洞：权限的唯一权威是服务端；UI 只是"不提供入口"。`aiAcceptRequiredRole`（`ai-suggestion.ts:126`）当前**零消费者**（我 grep 了 `packages/shared`、`apps/web`、`apps/server`，只有定义处），语义与 `documentCapabilities.canEdit` 等价（`editor`/`owner`），属 A5 P3-b 的既有观察，我确认仍成立。

### 9.2 在线 viewer：Accept disabled，程序化点击零写入、零出站 SYNC 帧

这是我在自己那一跑里从 `tests/browser/artifacts/results.md` 读到的 `m3/10` 实测（该场景在我这一跑中 PASS）：

```text
viewer proposal: {"summary":"Uppercase the document","diffLength":87,"acceptDisabled":true,"acceptTitle":"Read-only for your role"}
programmatic click on the disabled Accept: {"clicked":true,"wasDisabled":true,"title":"Read-only for your role"}
after the programmatic click: {"editorText":"\"viewer seed text-h8g43y\"","durableText":"\"viewer seed text-h8g43y\"","phase":"proposal","syncFramesBefore":1,"syncFramesAfter":1}
```

文本不变、durable 不变、**出站 SYNC 帧 1 → 1**、面板仍是 `proposal`。这同时说明"程序化 `.click()` 不会绕过 React 的 disabled"，以及"没有发生任何 SYNC Update 出站"。

### 9.3 离线：`getRole() === null`，本地分叉不出站、reload 仍在、durable 不变

**代码**：`getRole()`（`document-session.ts:259-266`）在 `state !== 'active'` 或 `networkStatus !== 'connected'` 时返回 `null`；没有缓存角色。`capabilityGate(null)` 给 `canEdit: true`（R10 / §17.9）。

**我这一跑的 `m3/11` 实测**（同一场景 PASS）：

```text
viewer offline: role is unknown, not a known viewer:
  {"status":"reconnecting","roleTag":null,"contentEditable":"true","viewReadOnly":false,"phase":"proposal","acceptDisabled":false,"acceptTitle":"Apply this suggestion to the document"}
unknown-role offline Accept: {"editorText":"\"ALPHA BETA\"","durableText":"\"alpha beta\"","syncFramesBefore":1,"syncFramesAfter":1}
unknown-role divergence after reconnect: {"roleTag":"role: viewer","viewReadOnly":true,"editorText":"\"ALPHA BETA\"","durableText":"\"alpha beta\"","forbiddenFramesBefore":0,"forbiddenFramesAfter":0,"syncFrames":2}
divergence after reload: {"editorText":"\"ALPHA BETA\"","durableText":"\"alpha beta\"","replicaPresent":true,"replicaUpdateRecords":6,"replicaFirstRecordType":"binary"}
```

即：离线 Accept 只改本地 `Y.Text`、**不出站**（1 → 1）、durable 不动；重连后**0 个 FORBIDDEN**（服务器从未收到，不是"被拒绝后保留"）、本地分叉不被删除；reload 由 IndexedDB 重放（6 条 update，record 类型 `binary`），durable 仍是 `alpha beta`。owner 的离线 Accept（`m3/11` phase 1）则重连后**恰好应用一次**并让第二台设备收敛（`- [ ] ` 前缀每行恰好一个，无双重 apply）。

结论：离线写入是"未知角色 + 本地分叉"，与"离线打字"同类（D-064 §2 #3 已裁定为已知缺陷、非安全缺陷）；**不是** AI 新增的越权通道。

### 9.4 有没有新的写旁路

我按"HTTP / persistence 直写 / awareness"逐条查：

- **HTTP**：server 全部路由只有 `GET /health`、`GET /api/meta`、`POST /api/session/bootstrap`、`GET /api/session`、`DELETE /api/session`、`GET /api/documents`、`GET /api/documents/:id`（`apps/server/src/app.ts`）。**没有任何文档写端点**；`POST /api/session/bootstrap` 只发 session cookie。
- **persistence**：生产代码中 `store.append(...)` **只有一处** —— `registry.ts:847`，在 `#submitMutation` 的 `apply → persist → broadcast` 管线内；测试文件中的 append 不算。
- **awareness**：`awarenessStateSchema` 只有 `user` / `cursor` / `selection` / `updatedAt`（`awareness-state.ts:56-60`），**没有正文**；awareness frame 在 `registry.ts:774-780` 明确绕过 durable pipeline。
- **服务端 AI 代码**：`apps/server/src/**` 对 `AiEdit` / `applySuggestion` / `TRANSACTION_ORIGINS.ai` 的匹配数为 **0**。
- **契约/依赖**：M3 窗口内 `apps/server/src`、`binary-frame.ts`、`protocol.ts`、所有 `package.json`/lockfile 零改动（`git diff --stat 9800612..990b9be -- …` 为空）。

结论：**没有发现新的写旁路**。AI 写入与打字在服务端不可区分（wire 上没有 origin 字段），这正是期望的"同一条受控路径"。

## 10. 契约与文档一致性

### 10.1 版本与 wire

| 项 | 值 | 证据 |
| --- | --- | --- |
| `SHARED_CONTRACT_VERSION` | **8** | `packages/shared/src/index.ts:77`；`ai-anchor.test.ts:399-402` 钉住 |
| `PROTOCOL_VERSION` | **2** | `packages/shared/src/protocol.ts:37`；同上测试 |
| wire 是否变了 | **否** | `git diff 9800612..990b9be -- packages/shared/src/binary-frame.ts packages/shared/src/protocol.ts apps/server/src` **为空** |
| 新依赖 | **无** | `package.json` / `pnpm-lock.yaml` 在 M3 窗口内零改动 |

### 10.2 §11.1 与实现逐条对齐

| §11.1 条款 | 实现 | 对齐 |
| --- | --- | --- |
| JSON 编码必须用 `relativePositionToJSON` / `createRelativePositionFromJSON` | `ai-anchor.ts:72-77` / `:89-128`，没有 `toJSON()`、没有私有编码 | **是** |
| decode 不得抛异常 | `decodeRelativePosition` 对非 JSON / 非对象 / 缺 source / 字段类型错误全部返回 `null`；`ai-anchor.test.ts:117-138` | **是** |
| `start` assoc = 0，`replace end` assoc = -1（边界插入在范围外） | `START_ASSOC=0` / `END_ASSOC=-1`（`ai-anchor.ts:54,60`）；我另跑 Node 用例与浏览器 `m3/8`/`m3/9` | **是** |
| 三段校验顺序：revision → 解析 → 逐字文本 | `validateSuggestionAgainstDocument`（`:231-259`）先 `isSuggestionStale`，再逐 op 解析，最后 `slice !== expectedText` | **是** |
| 任一失败 = stale，绝不部分应用 | 返回 `{ok:false}` 前没有任何 `transact`；冲突检查也在 `transact` 之前 | **是** |
| revision 是客户端本地计数器，只计 local/ai | `revision.ts:63-66`；探针实测 remote/persistence/外部 origin 不计数 | **是** |
| insert 不得带 `end`，replace 必须带 | Zod 两种 shape + `.strict()`；实现另用 `hasOwnProperty` 拒绝 insert 上的 `end` | **是** |
| `index`/`length` 仅用于渲染，不是应用权威 | `apply.ts` 使用 `validation.ranges`，`operation.index/length` 不参与写入 | **是** |

**但 §11.1 里有两处文字与它自己的机制说明冲突**（见 F3）：
- 表格第 2 行括号写 `(a deleted anchor resolves to nothing)` —— 与同节后文"Yjs keeps a deleted position alive (it maps to a neighbouring index)"以及我 §6.4 的实测相反。删除区域是 **`text-mismatch`**，不是 `anchor-unresolved`。
- 上一条其实也是同一个错误理解的两种表述；建议 A0 改成"an anchor always resolves for a position that ever existed; check #3 is what catches deletion"。

### 10.3 `docs/TASKS.md` / `docs/PROJECT.md`

- `docs/PROJECT.md:40`：M3 行仍写 **`not started`**，与仓库事实（A1/A4/A2/A5/A6 全部合入、60/60）矛盾 —— **F1（P2）**。
- `docs/TASKS.md:770`：M3 标题仍写 **`NOT STARTED 实现`**；正文 `:772` 说"实现进行中"，但状态最多记录到 A4（`:772-776`），没有 A2/A5/A6/A7 的最新状态，也没有 60/60 门禁。**两者自相矛盾** —— 同属 **F1**。
- 两者都**没有**声称 M3 CLOSED，这一点是对的；但"not started"会让发布说明/交接误判。

### 10.4 D-075 / D-076 中与代码不符的句子

| 位置 | 句子 | 与代码/实测的关系 |
| --- | --- | --- |
| **D-076 §4(b)** | "已知角色为 `viewer` 但**离线**时点 Accept" | **不成立**：`getRole()` 在离线时恒为 `null`（`document-session.ts:259-266`）；我这一跑的 `m3/11` 实测离线 `roleTag: null`。A5 已在报告里纠正前提，但 **D-076 本身没有更正** —— F4（P3） |
| **D-075 §4** | "不新增运行时依赖、不新增 HTTP 端点、**不发网络请求**" | 运行时 AI 路径确实不发网络（面板只用本地 provider + `readDocumentText`），但仓库里存在 `tools.listDocuments` → `GET /api/documents`（`tools.ts:89-99`，有测试），且 CONTRACTS §11.1 的措辞是"only tools.listDocuments may use HTTP"。按字面，"不发网络请求"与代码不符 —— F5（P3） |
| **D-075 §1** | "`apps/server` 与 `apps/web` 中 0 处 AI 实现" | 这是 **kickoff 时点的仓库快照**，不是对现在的断言；今天已不成立（M3 实现存在）。不是缺陷，但引用时必须带时点 |
| **D-076 §2** | revision "只计 local/ai，远端 edit 不 fail check #1" | **与代码一致**（我实测） |
| **D-076 §3 裁定 2** | 同 index insert+replace 判 `malformed` | **与代码一致**（我探针复现） |
| **D-076 §4(a)** | captureTimeout 合并、不要改 | **与代码一致**（代码未覆盖 captureTimeout；我复现了合并） |

另外 **`docs/ARCHITECTURE.md` §3 "Staleness"** 仍写 "If the document has moved on (locally or **remotely**) … the suggestion is stale"，与 §11.1 的"远端编辑不 fail check #1，由 anchor/expectedText 判"以及验收 D **直接冲突** —— **F2（P2）**。这是冻结架构文档里残留的 D-004 语义。

## 11. A–H 逐条判定

| # | 判据（D-075 §6） | 判定 | 我自己的证据 |
| --- | --- | --- | --- |
| **A** | Accept 后修改走 Yjs transaction（`ai` origin），第二个客户端看到普通 CRDT 编辑 | **PASS** | 浏览器 `m3/5` PASS：Accept 前文本不变；Accept 后 peer 看到同一编辑；`apply.test.ts:59` 断言 `origins === [ai]`；我的 undo 探针也观察到 `ai` update 事件 |
| **B** | Reject 不改 `Y.Text`（文本与 durable 均不变） | **PASS** | 浏览器 `m3/6` PASS（我的运行）；代码 Reject 只 `setProposal(null)`（`AiSuggestPanel.tsx:228-234`） |
| **C** | stale 三情形各自被拒：revision / anchor 失效 / expectedText 不符 | **PASS** | revision：`m3/7` PASS + 我的探针；expectedText：`m3/9` PASS + 我的探针；anchor 失效：`ai-anchor.test.ts` 的 foreign-doc / different-Y.Text 用例 + 我 §6.4 的 deleted-range 探针。**anchor-unresolved 没有浏览器证据**（§13 新增限制） |
| **D** | 并发编辑后 RelativePosition 正确：区域外仍可应用，区域内 expectedText 拒绝 | **PASS** | `m3/8`（区域外 + Accept 后含双方改动）与 `m3/9`（区域内 → `text-mismatch`）在我的运行中均 PASS；Node 测试钉住"边界插入不被吸收"（start/end 两侧） |
| **E** | undo 隔离：本地 undo 能撤回自己的 AI 接受；不回滚 remote；AI 编辑不被 remote undo 影响 | **PASS** | 浏览器 `m3/5`（一次 Undo 只撤回 AI）与 `m3/1`/`m3/2`/`m3/3` PASS；我的真实 `Y.UndoManager` 探针（§8）复现 local/ai 可撤、remote 不可撤 |
| **F** | 权限：viewer/commenter 不能通过 AI 绕过；UI 不提供 + 服务端拒绝；accept 需 editor | **PASS**（commenter 仅代码级） | `m3/10` PASS（Accept disabled + 程序化点击零写入、零 SYNC 帧）；`p2/1`（服务端 FORBIDDEN、不 apply/persist/broadcast）与 `p2/4`（能力一致性）在我的运行中 PASS；`features/ai/**` 0 处权限引用；`canEdit = hasAtLeastRole(role,'editor')`。commenter 无独立浏览器实测（R5/A5 P3） |
| **G** | 离线可生成；重连不重复 apply；多客户端收敛 | **PASS** | `m3/11` phase 1 PASS：owner 离线生成 + Accept，重连后 durable/两个客户端都收敛到**恰好一次** `add-todo`（`- [ ] ` 每行一个，无双重前缀）；phase 2 的 viewer 分叉见 §9.3（已知限制，不是验收失败） |
| **H** | 既有 53 场景零回归；四门禁在 integrated HEAD 全绿 | **PASS** | 60/60（含既有 53）在 `990b9be`；typecheck 0 / test 465+181 / build 0 / browser 0（§5） |

## 12. 代码质量与隐藏风险（结论，不泛泛）

### 12.1 `AiSuggestPanel` 生命周期

- **abort**：`abortRef` 在 regenerate 前、`close` 时、unmount effect 里都 aborted（`:137-144,155-157,236-240`）；provider 自己检查 signal，组件在 `.then/.catch` 里二次检查 `controller.signal.aborted`，晚到结果不会复活提案。
- **tracker dispose**：`useLayoutEffect` 的 cleanup 调 `dispose()`（`:130-134`），StrictMode 双挂载会 dispose 中间那个；`dispose()` 幂等。
- **`key={session.localClientId}`**：`DocumentWorkspace.tsx:225`，身份重挂载换 `Y.Doc` 时强制丢弃旧提案。**即使 key 没变**（理论上 clientID 碰撞/同 doc 替换），旧提案的 anchor 会在 `validate` 阶段 `anchor-unresolved`，**fail-closed**，不会写到错误文档。
- **发现的遗漏**：只有一条 —— `void provider.suggest(input).then(...)` 没有 `try/catch` 包裹同步抛出的 provider。今天的 `createLocalProvider().suggest` 是 `async`（同步抛也会转成 rejected promise），所以**不可达**；但 `AiProvider` seam 的新实现如果同步 throw，`phase` 会卡在 `generating` 且 React 收到事件处理器异常。**F9（P3，A2）**。
- 次要点：`phase === 'stale'` 时 `proposal` 仍保留，Accept 按钮 `disabled`，但程序化点击会再次进入 `accept()` 并重新跑一遍三段校验（不是旁路，因为重新校验失败就仍失败；文档若变回 `expectedText` 才可能成功，那种情况下文本确实还是用户审阅过的）。

### 12.2 `applySuggestion` 冲突守卫会不会误拒

不会（对我的探针集而言）：相邻 replace、同 index 两个 insert、insert 在 replace 独占末尾都接受；只有"insert 落在 replace 起点"被判 `malformed`，这是 D-076 裁定 2 明确要求的（两种顺序产生不同文档）。provider 每次只产出一个 intent、同一快照铸锚，所以自然不产生重叠；手工构造的重叠被拒绝是正确行为。

### 12.3 `diff.ts` 的 LCS 在 200k 输入上的行为

- 有硬上限 `MAX_LCS_CELLS = 2_000_000`（`diff.ts:41`），超出后把 changed middle 退化成 delete-all/insert-all（**正确但不最小**）。
- 实测：200k 字符 / 5 000 行全部不同 → **6.5 ms**（走 fallback）；1 400×1 400 接近阈值（1.96 M cells，走 DP）→ **13.1 ms**。最坏分配 ~8 MB `Uint32Array`，不会在 UI 线程上出现"不可接受"的退化。
- 代价是**预览体积**：整篇重写时会渲染 N+M 行 diff（5 000 行文档 → ~10 000 行 `<pre>`）。这是显示层的 P3（F11），不是正确性问题；我没有在真实浏览器里测量这个渲染耗时。

### 12.4 `tools.listDocuments` 是死代码还是有明确下一步

**今天是死代码**：`apps/web/src/features/ai/tools.ts` 之外，生产代码**没有任何消费者**（grep 只命中 `tools.test.ts`）；面板只用 `readDocumentText`。它有完整测试、有 `GET /api/documents` 的授权约束，是 D-075 §3 第 1 项"document directory"的交付面，但没有 UI 入口，也没有后续任务明确接线。**F8（P3，A4/A0）**：要么在 M4 明确消费者，要么删除/标注为 seam，避免"看起来已实现"。

### 12.5 有没有路径把正文写进 Redux/React state

- **Redux**：`apps/web/src/store/**` 没有 `text`/`content`/`body` 字段；`documentSlice.ts:4-13` 明文禁止加。`localStorage`/`sessionStorage` 也没有正文（只有 `session/bootstrap.ts` 的注释在说"故意不存"）。
- **React state**：`AiSuggestPanel` 的 state 只有 `instruction` / `proposal` / `staleReason` / `phase` / `tracker`；`readDocumentText` 的结果是 `generate()` 里的 **local const**，立即传进 provider，不赋值给 state。
- **需要如实说明的细微点**：`proposal` 是 React state，而 `proposal.diff`（以及 `operations[].text`）**包含正文/正文片段**。这不是 R11 的"把正文镜像成第二真相"：它不可变、只用于渲染、之后不会被写回 `Y.Text`，写入永远从 anchor 重新解析。若要把 R11 读到字面最严，这里存在"内容派生字符串驻留 React state"，但它是被审阅的提案本身，不是文档副本。我判定**不构成违规**，建议在 M4 若引入真正的流式 provider 时重新审视。

### 12.6 其他

- `applySuggestion` 在 `transact` 内部如果 Yjs 抛错，Yjs 事务**不会回滚**已执行的删除/插入；`apply.ts` 注释说"validation failure 不部分应用"是对的，但"nothing is applied"不能覆盖 transact 中途抛错。当前 operations 已经过 schema + 解析验证，正常路径不可达 —— **F10（P3，A4）**。
- `AiSuggestPanel` 计算了 `describeProviderFailure().detail`，但 UI 只渲染 `title`（`statusTextFor`）；`detail` 只在 `data-provider-error` 之外未被使用。不是缺陷，但错误详情（含支持的指令列表）用户看不到 —— 观察项。

## 13. 残留清单 R1–R10 与 M3 新增限制

**先纠一个事实**：仓库里具名残留是 **R1–R9**（R1–R7 见 `docs/TASKS.md:400-407`，R8 = heartbeat stale reap timer，R9 = remote cursor label）。**没有任何文档定义 "R10" 残留**；`R10` 在本仓库只作为 `AGENTS.md` 的工程规则（离线一等公民）出现。下面按 R1–R9 对照，并在末尾说明 brief 里 R10 的处理。

| # | 现状 | M3 是否改变 | 我的依据 |
| --- | --- | --- | --- |
| **R1** 吊销/过期不追溯已建 socket | **仍成立** | **未改变** | M3 窗口 `apps/server/src/**` 零改动（diff 空）；`ws.ts` 只在 upgrade 时 `authz.resolveSession`（178-210），per-frame 只按 membership 判 role（`registry.ts:716-760`）；我的 `p2/5-session-revocation-is-everywhere` PASS 只覆盖 HTTP + 新 upgrade |
| **R2** session 进程内；重启后不自动 bootstrap | **仍成立** | **未改变** | `apps/web/src/session/**` 在 M3 窗口零改动；客户端只在启动路径 bootstrap 一次（`App.tsx` / `session/bootstrap.ts`），没有 401 后重试 |
| **R3** 角色变更不推送，UI 门控滞后到下次 join | **仍成立** | 未被 M3 改变；**对 AI 的含义被确认** | `protocol.ts` / server 零改动；`p2/5-role-change-is-re-evaluated` PASS 证明服务端每帧重判（降级后写入被拒），但 UI 不会收到角色变更；M3 的 Accept 依赖同一 gate，因此"UI 可点、服务端拒绝"与普通写同类，不是新通道 |
| **R4** 6 处 mojibake 诊断字符串 | **未复核**（未重新计数） | M3 未改 `apps/server/**` | 诚实声明：我没有重数这 6 处；M3 窗口 server 零改动，因此不应变化 |
| **R5** commenter 无浏览器证据；被拒 join 的 null 窗口未覆盖 | **仍成立**（commenter） | **AI 也继承** | `tests/browser/**` 里 `commenter` 匹配数为 0；AI 的 commenter 门控只有代码级（与 viewer 同一个 `canEdit === false`） |
| **R6** `openApp` 隐式 `arrangeAccess` | **仍成立** | 未被 M3 场景触发 | `run.mjs:156-169` 默认 `role !== null → arrangeAccess true`；但 M3 的 viewer 场景先显式 `authz.grant(..., {ifAbsent:true})`，`m3/10`/`m3/11` 的注释也说明了这一点，所以没有"夹具发权限"的假成功 |
| **R7** 主 bundle 未拆分 | **仍成立** | 数字需更新 | 本 HEAD 构建主 chunk **955.54 kB**（gzip 313.34），仍有 `>500 kB` 警告；"1.41 MB"是旧测量口径，结论（未拆分）不变 |
| **R8** heartbeat stale reap timer | **仍成立** | **未改变** | `apps/server/src/rooms/heartbeat.ts` 在 M3 窗口零改动；生产参数下不可达 |
| **R9** remote cursor label 定位缺陷 | **已修复**（本窗口内 `95ea216`）；边缘裁切仍在 | 已修 | 本机浏览器 `cursors/remote-caret-and-selection-render` PASS；`TASKS.md:767` 记录"未做位置感知翻转"的边缘情形 |
| **R10（brief 的编号）** | **仓库中不存在这条残留** | — | 需要 A0 定义或确认 brief 指的是 `AGENTS.md` R10（离线规则）；我不把工程规则当成残留风险来判定 |

### M3 新增的已知限制（必须在发布说明里如实写）

1. **确定性本地 provider 不是大模型**：它是固定 intent 表（`uppercase` / `trim-trailing-space` / `add-todo` / `replace-selection` / `delete-selection`），不做自然语言理解；D-075 §4 已冻结，报告不得说成"接入大模型"。
2. **离线未知角色的本地分叉**：`getRole()` 离线为 `null` → Accept 可点 → 只改本地/IndexedDB、不出站、不被 `FORBIDDEN`；提升为 editor 后的新 join 会把分叉补交（A5 一次性探针观察）。属"离线打字"同类，已知缺陷、非安全缺陷。
3. **`anchor-unresolved` 无浏览器证据**：Node 有 foreign-document / different-`Y.Text` 用例，但浏览器套件没有该失败形态；通过 shipped UI 也很难触发（session 重挂载会重建面板，anchor 只会因删除变成 `text-mismatch`）。
4. **commenter 的 AI 接受路径未单独浏览器实测**：与 viewer 共用 `canEdit === false`。
5. **undo 与 revision 的交互**：undo 不移动 revision tracker（F6），可能出现"文本已回到原样但仍报 revision"的保守 stale。
6. **`captureTimeout` 合并**：500 ms 内"打字 + 立刻接受"一次 Undo 撤回两条（D-076 §4a，已复现）。
7. **`listDocuments` 无消费者** / **`aiAcceptRequiredRole` 无消费者**（F8）。
8. **diff 预览体积**：大文本整篇重写时预览是 N+M 行（F11）。
9. **无外部模型、无服务端 AI、无新依赖/端点**：这是边界，不是缺陷。

## 14. 本轮新发现（P1/P2/P3）

**没有 P1。** 我没有发现任何"会写错文档 / 越权写 / 数据丢失 / 契约破坏"的缺陷。以下按级别列出；每条给机制、复现、归属。

### P2

**F1（P2，文档状态）M3 状态在两份产品/任务文档里仍写"未开始"。**
- 机制：`docs/PROJECT.md:40` 的 M3 行仍是 `not started`；`docs/TASKS.md:770` 标题仍是 `NOT STARTED 实现`，正文却写"实现进行中"且只记到 A4。两份文档没有同步 A2/A5/A6/A7 与 60/60。
- 影响：发布说明、交接、milestone 关闭记录会与仓库事实冲突；外部读者会认为 M3 没开工。
- 复现：`grep -n "not started" docs/PROJECT.md`；`sed -n '770,776p' docs/TASKS.md`（我读的是文件原文）。
- 归属：**A0**（两份文档的 owner；A7 无权改）。

**F2（P2，冻结架构文档）`ARCHITECTURE.md` §3 仍说"远端移动也 stale"。**
- 机制：`docs/ARCHITECTURE.md:166-170` 保留 D-004 语义（"moved on (locally or remotely) → stale"），与 `CONTRACTS.md` §11.1（revision 只计本地，远端由 anchor/expectedText 判）和验收 D 直接冲突；同节后文虽然已写 M3 三段校验，但前一段没有删改。
- 影响：后来者若按 §3 第一段实现"任意 update 都让提案 stale"，会直接破坏 `m3/8` 的验收语义（远端区域外编辑仍可应用）。
- 复现：读 `ARCHITECTURE.md:166-179` 与 `CONTRACTS.md:588-602`；我 §7 的 `m3/8` 探针证明正确行为是"远端不触发 revision"。
- 归属：**A0**（ARCHITECTURE 冻结面，需 Supervisor 编辑）。

### P3

**F3（P3，契约文字）§11.1 表格括号"a deleted anchor resolves to nothing"与机制相反。**
- 机制：删除区域后 Yjs 仍能解析 anchor（我的探针：start 解析到 4），真正拦截的是 check #3；该括号会让人以为 check #2 负责删除。
- 影响：可能导致未来实现弱化 `expectedText`（正是 mutation 证明会放行错误写入的那一层）。
- 复现：`CONTRACTS.md:607-611` vs `:613-615`；以及我 §6.4 的探针输出。
- 归属：**A0**。

**F4（P3，决策记录）D-076 §4(b) 的"已知 viewer 但离线"状态不存在。**
- 机制：`getRole()` 在离线时返回 `null`（不缓存角色），所以离线 Accept 是"未知角色"路径；A5 已纠正前提，但 D-076 原文没有更正。
- 影响：后人可能尝试"离线时按记忆的 viewer 拒绝"（A5 方案 D），与 §17.9 的 stale-role 禁令冲突。
- 复现：`document-session.ts:259-266`；我的 `m3/11` 输出 `offline roleTag: null`。
- 归属：**A0**（决策记录）。

**F5（P3，文档措辞）D-075 §4 "不发网络请求"与 `tools.listDocuments` 的存在不符。**
- 机制：AI 运行时路径确实不发请求，但模块里有一个受测的 `GET /api/documents`（无 UI 消费者）。
- 影响：如果发布说明照抄"没有任何网络请求"，与代码面不符；精确表述应是"AI 生成路径不发请求；唯一允许的 HTTP 是只读的文档目录工具，本轮无消费者"。
- 复现：`tools.ts:89-99`；`grep -rn "listDocuments" apps/web/src`（生产 0 消费者）。
- 归属：**A0/A4**。

**F6（P3，实现/注释不符）undo 不移动 revision 计数器，但注释说会。**
- 机制：yjs undo/redo 事务 origin 是 UndoManager 实例；`REVISION_COUNTED_ORIGINS` 只含 local/ai，所以不计数。注释 `revision.ts:56-59` 声称"一次 undo step +1"。
- 影响：`打字 → undo → Accept` 报 `revision`（文本已回到原样），是保守失败不是安全漏洞；但注释是错的，用户会看到费解的 stale。
- 复现：§8 探针"undo 后 tracker 仍为 1"；`yjs.cjs` 中 `popStackItem` 以 `undoManager` 为 origin。
- 归属：**A2**（`revision.ts` 的具名 owner 例外）。

**F7（P3，注释漂移）两处代码注释仍把 §11.1 的编码说成 `RelativePosition.toJSON()`。**
- 机制：`ai-anchor.ts:65-70` 与 `ai-suggestion.ts:34-36` 说 CONTRACTS 称之为 `toJSON()`；但 CONTRACTS 现在的 normative 名称是 `relativePositionToJSON`（并明确 yjs 13.6.33 没有实例 `toJSON()`）。
- 影响：读者可能去找不存在的 API；不影响实现。
- 复现：grep `toJSON` in 两个文件；`CONTRACTS.md:576-579`。
- 归属：**A1**。

**F8（P3，未使用面）`listDocuments` 与 `aiAcceptRequiredRole` 都无消费者。**
- 机制：前者只有测试调用；后者三个包 grep 只有定义。
- 影响：看起来"已实现"的交付面没有入口/语义接线；未来能力阶梯变化时两份表达可能漂移（A5 P3-b 已指出）。
- 复现：`grep -rn "listDocuments\|aiAcceptRequiredRole" apps/web/src packages/shared/src`。
- 归属：**A4**（tools）/ **A0**（shared 语义）。

**F9（P3，健壮性）面板没有捕获 provider 的同步抛出。**
- 机制：`void provider.suggest(input).then(...)`；若未来 provider 同步 throw，异常从事件处理器冒出，`phase` 停在 `generating`。
- 影响：默认本地 provider 不可达（async 函数）；换真实 provider 时会出现。
- 复现：代码阅读 `AiSuggestPanel.tsx:183-194`；可用一个 `suggest(){ throw new Error() }` 的 provider 在 jsdom/浏览器里复现（本仓库无 jsdom）。
- 归属：**A2**。

**F10（P3，防御性声明）`applySuggestion` 的"nothing is applied"只覆盖校验失败。**
- 机制：Yjs 事务中途抛错不会回滚已执行的 delete/insert；当前 operations 已被 schema+解析验证，正常路径不可达。
- 影响：未来若给 operation 增加新的运行时校验（如自定义约束），可能留下部分应用。
- 复现：`apply.ts:114-123`；Yjs `transact` 语义。
- 归属：**A4**。

**F11（P3，展示/性能）大文本 diff 的 fallback 会渲染 N+M 行。**
- 机制：`MAX_LCS_CELLS` 超限时 middle 整体 delete-all/insert-all；时间有界（实测 6.5 ms），但 `<pre>` 行数线性膨胀。
- 影响：整篇重写的 200k 文档预览可能很长；不是正确性问题，未在浏览器实测渲染耗时。
- 复现：§12.3 的探针计时；`diff.ts:184-190`。
- 归属：**A4**（可选优化）/ **A2**（渲染）。

**F12（P3，覆盖缺口）`anchor-unresolved` 与 commenter 的 AI 路径没有浏览器证据。**
- 机制：见 §13 新增限制 3、4。
- 影响：Criterion C/F 的这两小块只有 Node/代码级证据。
- 归属：**A6**（若要补场景）/ **A5**（commenter 结论）。

## 15. 若关闭 milestone，哪些条件必须先满足

**代码层面没有阻塞项。** 以下条件都是"文档/记录/裁定"，但 milestone CLOSED 前必须先完成（顺序建议如下）：

1. **修 F1**：`PROJECT.md` M3 行与 `TASKS.md` M3 标题/状态更新到"round 1 implemented, gate 60/60, not CLOSED"；记录 A2/A5/A6/A7 的实际状态。Owner：A0。
2. **修 F2 + F3**：删除/改写 `ARCHITECTURE.md` §3 的"remotely"句与 §11.1 表格里"deleted anchor resolves to nothing"的括号，并在 `DECISIONS.md` 留一条勘误（或并入 D-076 的补充）。Owner：A0（冻结面，需 Supervisor 编辑）。
3. **修 F4/F5**：在 D-076 里更正"已知 viewer 离线"的表述；在 D-075/D-076 或新记录里把"不发网络请求"精确化为"生成路径不发请求；`listDocuments` 是唯一允许的只读 HTTP，M3 无消费者"。Owner：A0。
4. **A0 对 A5 三项未决项作出书面裁定**：(a) 是否给 `applySuggestion` 加咨询性预检（A5 建议不加；若加，`forbidden` 不得进 `ValidationFailureReason`）；(b) `aiAcceptRequiredRole` 零消费者的处置；(c) 是否补 commenter/AI 的浏览器场景。未决就关闭 milestone，等于把"三个待定"留给下一个里程碑。
5. **处理 F6**：要么把 `revision.ts` 的 undo 注释改对并接受"type→undo→stale"的保守行为，要么明确它是一次独立变更（不要顺手改 `captureTimeout`）。Owner：A2/A0。
6. **处理 F8**：`listDocuments` 与 `aiAcceptRequiredRole` 二选一（接线 / 删除 / 标注 seam），并记录。Owner：A4/A0。
7. **接受或补 F12**：`anchor-unresolved` 与 commenter 的浏览器证据；若不补，必须在发布说明里写成"Node/代码级证据，浏览器未覆盖"。
8. **把 M3 新增限制写进发布说明**（§13 的 9 条），尤其是"确定性本地 provider 不是大模型""离线本地分叉""undo 合并"。
9. **四门禁在最终 HEAD 重跑**（文档改动后至少 `pnpm typecheck` + `pnpm test`；若动 UI 文案再跑 browser），并记录真实输出。
10. **milestone 关闭与 tag 需要项目负责人授权**；A0/A7 都不能自行决定（`AGENTS.md` §4.1 的 gate）。

## 16. Release Recommendation

### 16.1 结论

**GO WITH CONDITIONS** —— 接受 M3 round 1 的代码与行为；**NO-GO for milestone CLOSED**，直到 §15 的 1–10 完成。

- 这不是"NO-GO"：没有 P1/P2 代码缺陷，A–H 全 PASS，四门禁与 60/60 是本 HEAD 的真实输出。
- 也不是"GO"：两份产品/任务文档仍说 M3 未开始，一份冻结架构文档保留了与 §11.1 相反的 stale 语义；A5 的三项裁定还没有 A0 的书面结论。把这些带进 CLOSED 会把"文档债务"变成"历史事实"。

### 16.2 阻塞项（关闭 milestone）

- 文档修正：**F1 + F2 + F3**（可与 §15.3 的 D-076/D-075 勘误合并为一次 A0 变更）。
- 治理裁定：**§15.4** 的 A5 三项（预检 / `aiAcceptRequiredRole` / commenter 场景）必须有书面结论，不能以"未决"状态关闭。
- 记录与措辞：**§15.5–15.8**（F6、F8、F12 的处置，以及 §13 的 9 条新增限制进发布说明）。
- 最后一步：**§15.9** 在最终 HEAD 重跑门禁 + **§15.10** 项目负责人对 CLOSED/tag 的授权。

### 16.3 非阻塞观察（可带入 M4）

- **F9–F12**（provider 同步抛出、事务中途抛错的部分应用、大文本 diff 预览体积、`anchor-unresolved`/commenter 浏览器覆盖）——都不影响当前正确性。
- **F4/F5/F6/F8** 是文档或未使用面：按 §15 的裁定/勘误处理即可，不需要改行为。
- **R4/R5/R6/R7/R8** 的既有状态与 M3 新增限制（§13）。

### 16.4 审查覆盖面（诚实声明）

**读了**（原文，不是摘要）：
`AGENTS.md`；`DECISIONS.md` D-004 / D-075 / D-076；`CONTRACTS.md` §11/§11.1（含与代码交叉引用的 §17.5/§17.9 相关行）；`ARCHITECTURE.md` §3/§3.1；`packages/shared/src/ai-suggestion.ts`、`ai-anchor.ts`、`ai-anchor.test.ts`、`permission.ts`、`awareness-state.ts`、`collab-session.ts`（相关段）；`apps/web/src/features/ai/{provider,localProvider,diff,apply,tools,revision}.ts`；`apps/web/src/features/editor/{AiSuggestPanel.tsx,aiProposalCopy.ts,aiProposal.test.ts,DocumentWorkspace.tsx,DocumentHeader.tsx,syncOrigin.ts}`；`apps/web/src/collab/internal/{document-session.ts(相关段),sync-provider.ts(相关段),origins.ts}`；`apps/server/src/rooms/registry.ts`（frame gate + mutation pipeline）；`tests/browser/suite/31-m3-ai.mjs`（头注释、m3/10、m3/11 全文；其余场景 grep 标题）；`tests/browser/README.md`（前 120 行 + 目录/隔离说明）；`docs/agent-governance/A5-m3-ai-permission-review.md` 全文；`docs/TASKS.md` M3 段与残留表；`docs/PROJECT.md` 相关行；`tests/browser/artifacts/results.md` 的 m3/10、m3/11 evidence。

**跑了**（我自己执行）：
全新 `pnpm install --frozen-lockfile`；`pnpm typecheck`；`pnpm test`；`pnpm build`；`node tests/browser/run.mjs`（60/60）；21 个临时探针用例；一次 mutation（3 文件 4 测试红）并还原复跑。共 **5 个门禁命令 + 2 轮探针/mutation**。

**没读 / 没跑**（不得当成已验证）：
- `DECISIONS.md` 其余 100+ 条、`CONTRACTS.md` 除 §11/§11.1 外的全文、`ARCHITECTURE.md` 除 §3/§3.1 外的全文；只按需要交叉引用。
- 其余 10 个浏览器 suite 的源码（它们在我的 60/60 里运行过，但我没有逐行读断言）。
- `apps/web/src/collab/internal/**` 除 `transact`/`getRole`/update 发送/UndoManager 构造/IndexedDB 相关段之外的完整实现；`apps/server/src/**` 除 frame gate 与 mutation 管线外的实现。
- **没有跑第二次浏览器套件**（单次 60/60；耗时 5 分钟，端口独占）；没有跨 worktree 并行跑（A5 报告已记录端口冲突风险）。
- **没有用真实外部/大模型 provider**（D-075 §4 边界内不存在）。
- **没有独立复现 A5 的"提升为 editor 后分叉补交"第 9 步**（A5 只跑过一次；我未重跑）。
- **没有在浏览器里专门触发 `anchor-unresolved`**，也没有 commenter 的 AI 浏览器场景（F12）。
- **没有重数 R4 的 6 处 mojibake**；没有重测 R8 的 heartbeat timer；没有做 R7 的 bundle 归因分析。
- 没有验证"并发多客户端同时接受同一提案"的场景（M3 round 1 的提案是单客户端生成/应用，D-076 §2 明确不支持共享提案）。
- 没有验证 `applySuggestion` 在`transact` 中途抛错的部分应用（F10，不可达路径，仅代码阅读）。

## 17. Files Changed

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `docs/agent-governance/A7-m3-final-review.md` | **新增（未提交）** | 本报告；本轮唯一交付物 |
| `apps/web/src/features/ai/a7Probe.test.ts` | 新增后**已删除** | 21 个一次性对抗性探针；不留在树里 |
| `packages/shared/src/ai-anchor.ts` | 临时 mutation 后**已还原** | 只改 `:325` 的比较为恒真，用于证明测试会红；`git checkout` 还原并重建 |

生产代码、测试、契约、`package.json`、`apps/server/**`、`tests/browser/suite/**`：**零改动**；`git status` 最终只有本报告（§21）。

## 18. 与其它 Agent 的集成关系

| 关系 | 说明 |
| --- | --- |
| 依赖 A1 | v8 锚定/校验（`ai-anchor.ts`）、`transact(fn, origin)`、`getRole()` 的 null 语义、UndoManager 的 origin 过滤、IndexedDB 回放；我的 §6/§7/§8/§9.3 全部建立在这些实现上 |
| 依赖 A4 | provider seam、确定性本地 provider、diff、`applySuggestion`、tools；本报告逐条验证了其"validate → 单事务 apply"与"多 op 降序" |
| 依赖 A2 | `AiSuggestPanel` 的 abort/tracker/`key` 生命周期、`accept` 双守卫、`APPLY_FAILURE_COPY`；未改动 |
| 依赖 A3/A5 | 服务端 frame gate 与 mutation pipeline、权限矩阵、session/role 语义；只读复核 |
| 下游 A0 | §15 的条件与 A5 三项裁定需要 A0 决策；milestone 关闭/tag 需项目负责人授权 |
| 下游 A6（若接受条件 7） | `anchor-unresolved` 与 commenter 的 AI 浏览器场景 |
| 契约 | **未改动**任何 frozen contract / version；`SHARED_CONTRACT_VERSION=8`、`PROTOCOL_VERSION=2` 与 wire 均未变 |

## 19. 给项目负责人的总结

M3 round 1 在 `990b9be` 上确实是可运行的：四条门禁全绿、浏览器 60/60，且我用自己的探针独立验证了最容易被写错的部分——多 operation 的降序应用逐字正确、`expectedText` 能区分"区域被删"与"锚点失效"、revision 只计本地、undo 只撤 local/AI、viewer 的 Accept 既不写文本也不发帧、离线未知角色的写入只是本地分叉。我没有发现任何会写错文档、越权写或破坏契约的缺陷（P1=0），因此**建议接受 round 1**。但**不建议现在关闭 milestone**：`PROJECT.md`/`TASKS.md` 还写着 M3 "not started"，`ARCHITECTURE.md` §3 还保留"远端移动也 stale"的旧语义，A5 提出的三项也还没有 A0 的书面裁定——这些是文档与治理债务，不是代码问题，但一旦带进 CLOSED 就会变成后人无法反驳的"历史事实"。另外有一个真实但保守的小缺陷：undo 不会移动 revision 计数器，导致"打字后撤销再接受"会报 revision stale；它 fail-closed，不危险，但 `revision.ts` 的注释写反了。把 §15 的十条做完，并在发布说明里如实写出"确定性本地 provider 不是大模型、离线分叉、undo 合并"这三件事，M3 就可以由负责人授权收口。

## 20. Git 状态

```text
$ git status --short
?? docs/agent-governance/A7-m3-final-review.md     （本报告尚未写入时的状态；写入后即此一项）
$ git branch --show-current
agent/a7-m3-final
$ git log --oneline -1
990b9be merge(integration): A6 M3 AI evidence - 7 permanent browser scenarios (53 -> 60)
```

工作树除本报告外干净（探针已删除、mutation 已还原并重建）；未 commit、未 merge、未 push、未打 tag、未关闭 milestone。

## 21. Next Handoff

```text
Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
agent/a7-m3-final @ 990b9be   (== main @ 990b9be；本报告未提交)

Why:
M3 round 1 的代码与行为已通过独立终审：四门禁全绿（465 + 181、60/60），A–H 全 PASS，
P1=0；没有代码阻塞项。关闭 milestone 之前需要 A0 处理两条 P2 文档修正、A5 三项裁定、
发布说明措辞与最终门禁重跑，并取得项目负责人对 CLOSED/tag 的授权。

Dependencies satisfied:
- 本报告 §5 是我在 990b9be 上自跑的四门禁真实输出（exit 0；465 + 181；60/60）
- §6 的 21 个对抗性探针 + mutation 证据（3 文件 / 4 测试变红后还原）
- §7/§8 的 revision 与 undo 独立复现（真实 Y.Doc + Y.UndoManager）
- §9 的权限三层与"无新写旁路"代码级复核，m3/10、m3/11 浏览器证据
- 未修改任何生产代码/测试/契约/依赖；工作树只新增本报告

Copy-paste Prompt:
你是 A0（Supervisor）。A7 已完成 M3 round 1 的独立终审，报告在
docs/agent-governance/A7-m3-final-review.md（base 990b9be，分支 agent/a7-m3-final，
未提交）。结论是 GO WITH CONDITIONS（接受 round 1，不关闭 milestone）。请：
1) 先复核报告 §14 的两条 P2：PROJECT.md:40 / TASKS.md:770 的 M3 "not started"
   状态，以及 ARCHITECTURE.md §3 残留的 "locally or remotely" stale 句；连同
   CONTRACTS §11.1 的 "deleted anchor resolves to nothing" 括号一起修正，
   并在 DECISIONS 里留勘误。
2) 对 A5 的三项未决作出书面裁定：applySuggestion 咨询性预检（A5 建议不加）、
   aiAcceptRequiredRole 零消费者、commenter/AI 浏览器场景是否补。
3) 处理 F6（revision 不计数 undo / 注释写反）、F8（listDocuments 与
   aiAcceptRequiredRole 的未使用面）——只记录决定，不要顺手改 captureTimeout。
4) 更新 M3 状态为 "round 1 accepted, not CLOSED"，把报告 §13 的 9 条新增限制写进
   发布说明，并在最终 HEAD 重跑四门禁。
5) 向项目负责人申请 milestone CLOSED 与 tag 的授权——这是负责人决定，不是 A0/A7
   可自行决定的。
不要改任何契约版本或 wire，除非先记录 decision。
```
