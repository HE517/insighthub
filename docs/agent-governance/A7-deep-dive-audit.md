# A7 · 面试项目深挖报告 — 最终独立审计

| 项 | 值 |
| --- | --- |
| 审计对象 | `docs/interview-project-deep-dive/{README,INTERVIEW-CHEATSHEET,01..06}.md`（8 个文件，审计后 4,541 行） |
| Evidence commit | `57a9bee5f2f8d6ff30f2a8373b61328546475183`（所有行号 / permalink 基准，未移动） |
| Worktree | `Insighthub-wt-a7-deep-audit` · branch `agent/a7-deep-dive-audit` |
| 审计起点 | `a6f7528`（merge: interview project deep-dive pack） |
| 审计性质 | docs-only。未改代码 / 测试 / `package.json`；未跑 vitest / 浏览器套件（按门禁） |
| 审计方法 | 8 文件逐行通读；`git show 57a9bee:<path>` 核 symbol；脚本全量校验 146 个 permalink 与 711 条 `path:Lx-Ly`；随机 30 条引用逐条对 code；与 `tests/perf/results/*.json`、`docs/agent-governance/*`、`docs/PROJECT.md`、`docs/DECISIONS.md`、`tests/browser/README.md`、`docs/TASKS.md` 交叉核数字 |
| 结论 | **GO WITH FIXES**（发现的确凿事实错误已在本分支修正并复验；A0 合并即 GO） |

---

## 1. 八项必查判定

| # | 检查项 | 审计判定 | 证据 |
| --- | --- | --- | --- |
| 1 | **对应当前项目 / §1 原句** | **PASS** | B1 与 `docs/resume-evidence/README.md:41` 逐字一致；B2 正文与 `:43` 逐字一致（最终版标题前缀「多人协同与离线恢复：」见任务给定文本）；B3/B4/B5 的标题与主张对齐任务给定的最终版，旧版 B3/B4/B5 见 `resume-evidence/README.md:45-49`（已被本包取代）。**修复前 06 §1 用 `……` 截断了 B5**，不满足“必须逐字”，已修为整句并注明 05/06 分工。仓库内无最终版截图 artifact，故 B3–B5 的逐字一致性需 A0 用截图做最后一次人工比对（见 §6 覆盖边界）。 |
| 2 | **技术选型事实依据** | **PASS** | 01 §6、02 §6、03 §6.2、04 §6、05 §6、06 §6.4 均先声明“无对比实验 / 未做 benchmark”的证据边界；未实现项在每份 §10 全量标 `RELATED KNOWLEDGE / ALTERNATIVE — NOT IMPLEMENTED`（01 §10 共 16 项、02 §10 共 16 项、03 §10 共 10 项、04 §10 共 12 项、05 §10 共 15 项、06 §10 共 18 项）。Monaco/OT/Automerge/SSE/Web Worker/虚拟化均无“已实现”措辞。 |
| 3 | **项目没用却写成用了** | **PASS（修复后）** | 全量 grep `useMemo / useCallback / Web Worker / Service Worker / virtualiz / SSE / streaming / Playwright / React 18`：除 05 §10 一处“手写 memo 只有 `useCallback(markReady)`”外，其余命中均为 NOT USED / ALTERNATIVE / 否定语境。该处与代码不符（`useCallback` 10 处、`useMemo` 1 处），已修。`React 18` 全文 0 命中（统一 React 19）。`Playwright` 仅用于“不是 Playwright / 只在 deployed smoke”，与 `PROJECT.md:98-101` 一致。 |
| 4 | **AI planned path 是否写成上线事实** | **PASS** | 全文 0 处“已上线 / 稳定运行 / 已验证 live / 成功调用”；外部 live 在 01 L3、06 C7/§13、README、cheatsheet 均为 `NOT VERIFIED`，并保留 OpenAI `429 credit_balance_exhausted`、Kimi `400 invalid_request_error`（改 prompt-only 后未重试）记录。06 头部“production integration path 已实现”已改为“生产接入路径已实现、未 live 验证”。 |
| 5 | **permalink 准确性** | **PASS（修复后）** | 146 个 permalink 全部 `blob/57a9bee5f2…`；唯一“异常”是 05 第 5 行的 `Permalink base:`（以 `/` 结尾的基址，不是链接）。138 个唯一 permalink 的 path 在 `57a9bee` 全部存在、行号范围全部合法。711 条 `path:Lx-Ly`：697 条脚本唯一解析、14 条同名文件歧义人工确认、**0 条路径不存在 / 越界**（修复前有 1 条 `route-invariants.test.ts` 不存在）。随机 30 条用 `git show 57a9bee:<path>` 核对 symbol，**30/30 命中**。 |
| 6 | **数字定义** | **PASS** | 241 B=整个 store（03 C3 REWORD、§12.7、README、cheatsheet）；680/654 双口径（03 §12.2、01 §12、README）；770 n=9 restore→connected local build（02 §12、03 C6）；371.3 n=900 病理 fixture（03 §11 T3、§12.8、02 §12）；400 ms 明确为“配置值，不是 P50”（05 §2.3、§12.4、§18）；48.99 kB 为 lazy chunk 且 provenance 指向 `docs/interview/INSIGHTHUB-INTERVIEW-QA.md:192`（05 §12.1）；78/83 为默认/remote 注册（05 §12.5、06 §11.2、04 §12.6）；69–78 ms abort（04 §12.1）。全包无“把配置值写成性能指标”或“把 local build 写成 production P95”的表述。 |
| 7 | **limitation 是否遗漏** | **PASS（补两处口径）** | 必查 8 条全部在包内：two users（01/02/04/05/06/README/cheatsheet）、30 s 断网未测（01/02/README/cheatsheet）、100k Preview 420 s（01/03/05）、无优化前后（01/02/03/README/cheatsheet）、AI live 未验证（01/06/README/cheatsheet）、requestId 未压测（04）、metadata stale NOT APPLICABLE（04/README/cheatsheet）、权限变化→“授权结论过期”（04 C2/§13、README、cheatsheet）。**01 §12 与 02 §12 原先未写“数字测于 c2ad879”**，已补。 |
| 8 | **能否支撑 3–5 层追问** | **PASS（附结构偏差）** | 01–06 每份 §14 均 18 题（≥15），答案逐题绑定本项目文件 / 数字 / 测试名；每份 §16 均有 30 s / 90 s / 3 min 三版；§17 ASCII 与真实链路核对一致（抽查 `main.tsx:16`、`App.tsx:82`、`ws.ts:160/305`、`registry.ts:543/716`、`DocumentCanvas.tsx:35-57`、`MarkdownPreview.tsx:96-111` 均对）。**偏差**：01/02 §18 为 5 条，03–06 §18 为 8 条（要求 3–5），内容无事实错误，未删（见 §4 R1）。 |

---

## 2. permalink / 行号统计

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| permalink 出现次数 | **146** | 01:18 / 02:20 / 03:25 / 04:30 / 05:21 / 06:32 |
| 唯一 permalink | **139** | 其中 1 条是 05 第 5 行的 `Permalink base:` 基址 |
| sha 正确 | **146/146** | 全部 `57a9bee5f2f8d6ff30f2a8373b61328546475183` |
| path 存在 + 行号合法 | **138/138**（唯一实际链接） | 越界 0；`git cat-file`/`git show` 全量校验 |
| `path:Lx-Ly` 引用 | **711** 条 / 546 个唯一（文件,path,range） | 覆盖 105 个文件、6 份报告 |
| 唯一解析成功 | **697** | 脚本按全路径或唯一 basename 解析 |
| 同名歧义 | **14** | `public.ts` / `provider.ts` / `errors.ts`，按上下文人工确认到 `apps/web/src/collab/public.ts`、`apps/server/src/ai/{provider,errors}.ts`、`apps/web/src/features/ai/provider.ts`，行号均合法 |
| 路径不存在 / 越界 | **0** | 修复前 1 条（06 `route-invariants.test.ts`，实际 `route.invariants.test.ts`） |
| 随机 30 条符号核对 | **30/30** | `git show 57a9bee:<path>` 打印的代码首行均与表中 Symbol/职责一致（含 `createLocalRevisionTracker`、`#authorizeFrame`、`applySuggestion`、`validateSuggestionAgainstDocument`、`handleBinaryFrame`、`writeLocalChanges` 等） |
| 表内“文本范围 vs permalink 范围”不一致 | **2**（已修） | 04 第 158 行 `:716-760` 对 `#L695-L760`；第 170 行 `:92-99` 对 `#L92-L100` |

---

## 3. 发现并修复的问题

修复原则：只改事实 / 口径 / 链接 / 索引，保持 18 节结构；不重写正文，不改代码。

| # | 文件:行（修复前） | 问题 | 证据 | 修法 | 严重度 |
| --- | --- | --- | --- | --- | --- |
| F1 | `INTERVIEW-CHEATSHEET.md:78` | 写“默认 model `kimi-k3.1-pro`”，与代码相反；06 §6.4.2 专门警告过这个误传 | `apps/server/src/ai/kimi.ts:73` `DEFAULT_KIMI_MODEL = 'kimi-k3'`；06 §6.4.2/§18 | 改为 `kimi-k3`，并注明 `kimi-k3.1-pro` 是升级档 | **高**（cheatsheet 是背诵面） |
| F2 | `05-lazy-preview-rendering.md:465` | “手写 memo 只有 `useCallback(markReady)`”与代码不符 | `git grep useCallback` 10 处、`useMemo` 1 处（`useCollaborativeSession.ts:46`） | 改为“少量 useCallback（如 MarkdownPreview.tsx:93）+ 一个 useMemo” | 中 |
| F3 | `06-ai-editing-llm-design.md:17` | §1 引用用 `……` 截断 B5，不满足“逐字” | 任务要求 B5 逐字；05 §1 已给整句 | 补全整句并注明 05/06 分工 | 中 |
| F4 | `06-ai-editing-llm-design.md:210` | `route-invariants.test.ts` 不存在 | `git ls-tree 57a9bee` 中实际为 `apps/server/src/ai/route.invariants.test.ts` | 改文件名 | 中 |
| F5 | `01-business-and-architecture.md:214` | 状态表把 `metadata` 写成“渲染用元数据”，暗示已接线 | `git grep documentMetadataReceived` 只有定义无 dispatcher；03 §5、04 §3 开头均写运行时恒 `null` | 改为“字段预留、运行时恒 null，换文档仍清空” | 中 |
| F6 | `04-async-state-rbac.md:158` | 文本 `:716-760` 与 permalink `#L695-L760` 不一致（695 是注释起点） | `git show 57a9bee:...registry.ts`：`#authorizeFrame` 从 716 开始 | permalink 改 `#L716-L760` | 低（链接本身可用） |
| F7 | `04-async-state-rbac.md:170` | 文本 `:92-99` 与 `#L92-L100` 差一行 | `apply.ts` 92 为函数签名，99 为 docId 校验 | permalink 改 `#L92-L99` | 低 |
| F8 | `README.md:45` | 用字面 `\n` 当换行，整段渲染成一条巨长 bullet | 原始字节含字面 `\n`（0x5C 0x6E） | 改成真实换行（5 条） | 低（可读性） |
| F9 | `INTERVIEW-CHEATSHEET.md:91` | 同上，两条 limitation 粘在一行 | 同上 | 拆成 3 条 | 低 |
| F10 | `README.md:10/11/13/15` | “主源码”列有 4 类路径错误 | `apps/server/src/runtime.ts`、`apps/server/src/routes/authz.ts` 在 `57a9bee` 不存在；`collabTextBinding.ts` 不在 `collab/internal/`；`ai-anchor.ts`/`apply.ts` 不在同一目录 | 分别改为真实路径（`AppShell.tsx`/`authz/authz.ts`/`features/editor/collabTextBinding.ts`/分目录列出 06 文件） | 中 |
| F11 | `05-lazy-preview-rendering.md:41-42` | 交叉引用两个不存在的文件名 | 实际为 `02-collaboration-yjs-offline.md`、`03-performance-redux-codemirror.md` | 改文件名 | 低 |
| F12 | `05-lazy-preview-rendering.md:64` | “依赖树会给首屏增加约 49 kB gzip”与 lazy 结论自相矛盾 | 05 §2.1-§2.2 本身说明首屏不加载；§12.1 定义为 chunk | 改为“静态 import 才会给首屏增加；lazy 后只落在预览 chunk” | 中 |
| F13 | `01-business-and-architecture.md:402`、`02-...md:459` | 引用 perf 数字但未写“测于 `c2ad879`” | JSON `git.commit=c2ad879`；03 §12.9 已写 | 各补一条“测量 commit / HEAD 已变” | 中 |
| F14 | `INTERVIEW-CHEATSHEET.md:21-22` | bundle（Preview 前）与 preview chunk（Preview 后）并列，像同一次构建 | bundle 来自 `c2ad879` 的 `aggregate`；chunk 来自 Preview 合并后清单 | 两行分别标注构建时点，并写“不是同一次构建” | 中 |
| F15 | `README.md:24-40` | 知识点索引 9 处指向错误章节（如 schema→06 §15、RelativePosition→06 §16、State Vector→02 §10、p95→03 §10） | 对应内容实际在 06 §7.1/§7.5/§9、02 §7/§9、03 §11–§12、05 §6.6/§7.4、06 §6.4 | 改为实际章节 | 低 |
| F16 | `06-...md:8` | “production integration path 已实现”易读成生产已验证 | 06 自身写 live 0 次成功 | 改为“生产接入路径已实现、未 live 验证” | 低 |
| F17 | `06-...md:663` | 73/73 写成“`874f107` 之前”，指代不准 | 73/73 证据轮是 `1807ea1`（02 §4、04 头部） | 改为 `1807ea1` | 低 |
| F18 | `06-...md:692` | “AI 默认套件场景 7+1”把 stale 场景算进 AI | `31-m3-ai` 是 7 个，`stale/directory-list` 不属于 AI | 标注“7 + 1 条 stale（非 AI）” | 低 |
| F19 | `06-...md:25/488` | 两处把“流式怎么做”指向 §14 Q14，实为 Q6 | 06 §14 Q6 才是流式 planned 方案 | 改 Q6 | 低 |
| F20 | `01-...md:292` | `registry.ts` 写“1100 行”，实际 1,138 | `(git show 57a9bee:apps/server/src/rooms/registry.ts).Count = 1138` | 改“约 1,100 行” | 低 |

> 另确认（非缺陷）：78/83 与“remote 未跑”在 README、04 §12.6、05 §12.5、06 §11.2/§12.2/§12.3、cheatsheet 多处口径一致；73/73 与 1807ea1 的对应关系在 02/04/06 一致。

---

## 4. 仍存在的风险 / 未修复项

| # | 风险 | 影响 | 建议 |
| --- | --- | --- | --- |
| R1 | **03–06 §18 记忆点为 8 条**，超出“3–5”体例 | 纯结构偏差，不影响事实；面试前可只背前 5 条 | 若 A0 要求严格对齐，由 A0 决定是否把第 6–8 条降为“附：速记”；本次不删内容 |
| R2 | **最终版简历截图不在仓库** | B3–B5 只能与任务给定文本、05/06 互证；若截图另有措辞差异，需人工比对 | 交付时以截图为准做最后一次逐字 diff；本审计只能证明“包内 8 份文件彼此一致且与给定最终版标题一致” |
| R3 | `docs/PROJECT.md:52` 仍写“当前默认 73、remote 78” | 与本包 78/83 口径不一致（PROJECT.md 陈旧，非本包错误） | 不属本次 docs 范围；建议 A0 另开 docs 修正 |
| R4 | `docs/resume-evidence/README.md:171` 仍写“never 78/78” | 历史证据包口径（该包 pin `874f107`）；与本包 78/78 记录冲突但各有 commit 语境 | 面试引用时说明“73/73 是 874f107 证据轮；78/78 是 7585263 合并后记录” |
| R5 | 100k Preview 420 s、30 s 断网、3+ 用户、AI live、requestId 压测仍是未验证 | 已如实写入 limitation；不可在面试中升级为已证 | 保留 §5 清单，任何对外材料不得删 |
| R6 | 性能数字与 bundle 来自 `c2ad879`（Preview 前），HEAD 未重跑 | 引用包体/ready 时必须带测量 commit；48.99 kB 是 Preview 后另一构建 | 已补 01/02/README/cheatsheet 口径；若要把数字写进新版简历，先重跑 |
| R7 | 04 的 69 ms/78 ms 是两次单次观测，不是分布 | 不可写成 P50/P95 | 04 §12 已写“取消延迟、不是 SLO”；保留 |
| R8 | §10 的 `ALTERNATIVE — NOT IMPLEMENTED` 标签集中在各报告 §10，§8“为什么不用 X”正文未逐个加标签 | 不影响结论，但快速浏览 §8 的读者可能漏看标签 | 低优先；若要统一，后续一次性给 §8 表头加标签，勿逐条重写 |

**不存在需要标 `REMOVE` 的新 claim**：B5 的“AI 流式”已在 05/06 标 `NOT IMPLEMENTED / PLANNED`，“权限模块 lazy”已改为“Clerk 认证壳 lazy”，“远端协作更新批量合并”已改为“文本逐条、仅 awareness 50 ms”，均属 REWORD，不是新发现的“无证据上线事实”。

---

## 5. 必须保留的 limitation 清单（对外材料逐条保留）

1. 协同证据 = **two independent users**；3+ 未验证。
2. 断网窗口 **1–2 s**；**30 s 未测**；“不丢键”的证据是 `indexeddb/B`（重开仍在），不是长断网。
3. 100k 是**病理单段落 fixture**；input p95 371.3 ms（n=900）、Long Task ~397–400/轮；块结构对照 p95 3.0–3.9 ms，是 fixture 结构效应，不是产品优化。
4. 100k 进入 Markdown Preview 在浏览器 **420 s 内未 ready**；node ~719 ms 只是解析，不是浏览器证据。
5. 性能数字测于 **`c2ad879`**（Preview 合入前）；HEAD bundle 已变大（`react-markdown`/`remark-gfm`），引用包体必须重跑。
6. P95 是 **local production build**（built server + built web，无 TLS/Clerk/Render），不是 production P95；ready n=3、reconnect n=9，p95 接近 max。
7. ready 双口径：`run.mjs` floor = 654，`aggregate.mjs` ceil = **680（= max）**；说 680 必须说明聚合口径。
8. 241 B 是**整个 store** 的 `JSON.stringify` 长度（connection/document/realtime），不是“仅元数据”；36 字符 UUID 会到 ~280 B。
9. debounce **400 ms 是配置值**，不是可见延迟 P50；359/63 ms 是单次观测；49 kB 是 lazy chunk 的 gzip，不是主包增量。
10. 默认套件 **78/78**（73+5 preview）；**remote 83 注册、未跑**；73/73 是 `1807ea1` 的历史轮。
11. AI 外部 provider **live 0 次成功**（OpenAI 429 余额；Kimi 400 后改 prompt-only 未重试）；remote 组 `m3r/*` 未跑；无质量/延迟/token 成本数字；**流式 = PLANNED，不存在**。
12. `document metadata stale` = **NOT APPLICABLE**（客户端不发该请求）；`requestId` guard **未压测**；“权限变化导致请求竞态”应说**授权结论过期**（服务端逐帧重查，UI 滞后约 3 s）。
13. 单实例 / 单区域 / 无 HA；session 与房间在进程内；Clerk 与 production **未 live 验证**；只有 Chromium 155 headless。
14. 无优化前后对比（无可信 pre-opt baseline），不得写“提升 X%”。

---

## 6. 审查覆盖边界

- **读过**：8 份文件全文；`tests/perf/results/perf-production-multiround.json`、`perf-baseline-100k-multiround.json`、`perf-block-run-1.json`、`profile-100k.json`；`docs/PROJECT.md`、`docs/DECISIONS.md`（D-086/D-087 相关段）、`docs/TASKS.md:883`、`tests/browser/README.md`、`docs/agent-governance/{A6-evidence-gate-round2,PROFILE-100K}.md`、`docs/resume-evidence/README.md`。
- **跑过**：`git show 57a9bee:<path>`（行号/符号）、`git cat-file`、`git diff 1807ea1..57a9bee`（04 的“测试文件未改”）、全量 permalink/引用脚本、30 条随机抽样。**未跑** vitest / 浏览器套件（门禁要求 docs-only）。
- **没看**：最终版简历截图原件（仓库内不存在）；生产环境；Render 部署。
- 因此本审计能证明“文档与 `57a9bee` 代码/证据一致、数字口径正确、链接可解析”，**不能**替代 A0 对“简历最终截图逐字一致”的人工确认。

---

## 7. Release Recommendation / 给 A0 的决定

**结论：GO WITH FIXES（修复已落地，合并即 GO）。阻塞项：无。** 非阻塞观察见 §4（R1–R8）。

1. **合并建议**：批准本 docs 分支合并。修复均为文档级（词语、口径、链接、索引），无代码/测试/依赖变更；`git status` 仅 `docs/`。
2. **需 A0 决定的唯一体例问题**：§18 在 03–06 为 8 条（要求 3–5）。建议保持 8 条（内容有用，且不影响面试），或由 A0 统一降为“前 5 条必背 + 3 条附注”。
3. **不在本包修**：`docs/PROJECT.md:52`（默认 73/remote 78）与 `docs/resume-evidence/README.md:171`（never 78/78）是历史口径，建议另开 docs 修正并在面试话术里带 commit 语境。
4. **对外引用纪律**：合并后仍以本报告 §5 的 14 条 limitation 为发布口径；任何“production P95 / 3+ 用户 / AI live / 30 s 断网 / 流式 / 优化提升 X%”的表述都不允许出现。

---

## Next Handoff

Handoff Status: OWNER_DECISION_REQUIRED
Recommended Next Agent: A0
Base: agent/a7-deep-dive-audit @ HEAD（本报告所在 commit；SHA 见 `git log -1 --format=%H`；evidence 仍为 57a9bee）
Why: 8 份深挖报告已通过 A7 独立审计；确凿事实错误（Kimi 默认模型、截断引用、错误文件名、metadata 误述、缺失的 c2ad879 口径等）已在本分支修正并复验，等待 A0 决定合并与 §18 体例。
Dependencies satisfied: evidence commit `57a9bee` 不变；146/146 permalink 合法、711 条行号引用 0 失效、30/30 抽样命中；docs-only，无代码/测试/package 改动。
Copy-paste Prompt: 请 A0 复核 `docs/agent-governance/A7-deep-dive-audit.md` 与 `docs/interview-project-deep-dive/**` 的修复 diff，确认是否合并到 main；若合并，唯一待决项是 03–06 §18 保持 8 条还是收敛为 3–5 条。合并前请再确认最终版简历截图与 05/06 的 B5 引用逐字一致。
