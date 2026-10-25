# A7 · 第二轮 Claim-to-Evidence Review（`docs/PROJECT.md` 逐句裁定）

**Status：** done（review only —— 未改代码、未改产品描述文件本身）
**Branch：** `agent/a7-claim-review`
**Worktree：** `D:\前端\react\项目\面试项目\Insighthub-wt-a7-claim-review`
**Base / HEAD：** `39854d4`（`docs(evidence): record 100k performance current baseline`）
**Date：** 2026-10-25 · **Reviewer：** A7（独立于 A0）
**被引用证据的环境：** Windows 11 10.0.26200（x64）· Chrome **155.0.8059.85**（headless）· Node **v22.14.0** · pnpm 10.34.7

---

## 0. 方法、边界，以及"我没有做什么"

- **只读审查。** 本轮唯一新增文件是本文件；`apps/**`、`packages/**`、`tests/**`、`docs/PROJECT.md`、`docs/DECISIONS.md`、`package.json` 一行未改。未 merge / 未 push / 未打 tag。
- **没有运行测试。** 这是 A0 授权的审查型任务。所有数字来自**已提交文件**：场景源码、`docs/agent-governance/*`、`tests/perf/results/perf-baseline-100k.json`、`B11a-free-staging-smoke.md`。
- **实际读了什么：** `docs/PROJECT.md`（100 行全读）、`docs/DECISIONS.md` D-082…D-086、`CAPABILITY-EVIDENCE-INVENTORY.md`、`A6-evidence-gate-round2.md`、`PERF-BASELINE-100K.md`、`tests/browser/README.md`（662 行全读）、`tests/browser/suite/**` 全部 17 个文件（按 `runner.scenario(` 逐条提取 id 并读断言）、`tests/perf/**`、`docs/TASKS.md` 的 M4 段。
- **场景计数是我数的，不是抄的：** `runner.scenario(` 共 **78** 条；`suite/33-m3-remote.mjs` 的 5 条由 `INSIGHTHUB_E2E_AI_MODE=remote` 控制注册 → 默认 **73**、remote **78**。与 README 的 `78 = 73 + 5` 一致。
- **Provenance（关键，本轮最重要的可复现性事实）：**
  - `git diff 7245ceb..HEAD -- tests/browser apps packages` **为空** → A6 的 `73/73` 那次运行，其测试代码与产品代码与 HEAD **逐字节相同**；
  - `git diff 9f4879f..HEAD -- apps packages` **为空** → `PERF-BASELINE-100K.md` 的测量产品代码与 HEAD **相同**；
  - 但两者都是**继承的证据**，HEAD 上没有重跑过（本 worktree 连 `tests/browser/artifacts/` 都不存在；该目录不入库）。

---

## 1. Executive Summary（一页）

**结论：`docs/PROJECT.md` 的 33 条能力性 claim —— 23 条可直接 `KEEP`，9 条必须 `REWORD`，1 条 `NOT VERIFIED`，0 条需要 `REMOVE`。** 真正的 `REMOVE` 清单（search、Markdown preview、preview incremental/debounce、production PerformanceObserver、sendBeacon telemetry、"优化前/后"对比）**本来就不在 `PROJECT.md` 里**——D-086 §3 的删除令在 `PROJECT.md` 上已经生效；风险在 `PROJECT.md` 之外的简历 / README / 发布说明，本轮把它们作为"外部 claim 候选"单独裁定（6 `REMOVE`、1 `REWORD`、1 `NOT VERIFIED`）。

**可以直接保留（有直接、已提交、可复现证据，措辞没超出证据）：**

| 能力 | 证据（场景 id） |
| --- | --- |
| 两个**独立 browser context/独立 cookie+storage/独立身份**并发 insert+delete+replace，收敛且三方 state-vector digest 相等 | `collab/independent-contexts` |
| Accept 前文档不变；Accept 是单个 `ai` 事务，第二个客户端当普通 CRDT 编辑看到 | `m3/5`、`m3/6`、`m3r/1` |
| Undo 只撤 local/AI，不回滚远端 | `realtime/local-undo-does-not-revert-remote-text`、`m3/1`、`m3/5` |
| 重复帧 / 乱序帧幂等 | `chaos/duplicate-inbound-frames`、`chaos/out-of-order-delivery` |
| IndexedDB 离线编辑 → 关页 → 离线重开仍在 | `indexeddb/B`、`indexeddb/A` |
| RBAC：viewer 在 UI 与服务端都被挡，服务端才是边界 | `p2/1`、`p2/4`、`f1/1`、`f1/4`、`m3/10` |
| 服务端 durable store 扛硬杀进程 / 压缩 / 写失败诚实 | `m2/B`、`m2/E`、`m2/F` |

**必须降级的（能力存在，但原文过强/过宽）：**

1. **"two or more members"** —— 证据是**恰好两个**独立 context；三方并发编辑 `NOT VERIFIED`（`m2/J` 是三个冷加入的**水合**，不是并发编辑）。
2. **"rewrite/expand/shorten"** —— 默认 provider 是一张**确定性指令表**（`uppercase` / `trim-trailing-space` / `add-todo` / `replace-selection:` / `delete-selection`），`localProvider.ts` 自己写明"**not a language model**"；真实外部模型只有 `AI_PROVIDER=openai|kimi` 路径，且**未联网验证**。
3. **M4 行"当前未开始"** —— 与 `docs/TASKS.md` 的 B1–B11a 全 DONE **直接矛盾**。这是唯一一条"事实错误级"的陈述。
4. **M3 行 "68/68 + 73/73"** —— 是 M3 收口时的快照；当前是 **73 / 78**（`tests/browser/README.md`）。数字本身没错，但读起来像现状。
5. **MVP 成功标准 "Killing the network for 30s"** —— **没有任何场景断网 30 s**；实测断网窗口约 1–2 s（`chaos/offline-reconnect` 的 `sleep(1000)`、perf 的 250 ms）。"不丢键"成立，"30 s"不成立。
6. **"comment on"** —— `commenter` 是权限梯级（server 有实现、Node 测试有），但**产品没有评论功能**，浏览器套件里 `commenter` 出现 **0** 次。
7. **"or an AI result for A"**（文档切换那条）—— 没有"AI 响应跨切换"的场景；只有间接证据（面板卸载 + `AbortController` + stale 检测）。
8. **`reconnect duration`** —— 现已**实测**（restore→connected p50 **775 ms**，n=3，250 ms 断网），但只是 current baseline，不得写成通用/SLA。

**必须删除的（功能根本不存在，且 D-086 §3 已命令删除）：** search / cancel stale search、Markdown preview + incremental + debounce、production PerformanceObserver、sendBeacon telemetry、任何"优化前→优化后"的性能对比叙述（inventory B9 已判 `UNAVAILABLE`）。

**性能只有一种合法写法：** "本机 current baseline（Windows 11 / Chrome 155 / commit `9f4879f`）：100k 行、input p50 423.8 ms / p95 535.9 ms（n=300）、Long Task 385 条、bundle 970,271 B raw / 316,847 B gzip"。**不得**写 production p95、不得写"优化"、不得把 Long Task 说成 production telemetry。

**AI live 口径（D-085 + 最新事实）：** OpenAI `429 credit_balance_exhausted` 是**余额 finding，不是实现失败**（保留）；Kimi 最近一次 live 仍是 `400 invalid_request_error`，`d73d6f5` 刚把 `response_format` 去掉（prompt-only），**尚未重试** → **AI live 仍为 `NOT VERIFIED`**。

**M4 持久性：** B11（持久盘 + restart）、B8（deployed backup/restore）、B14（生产终审）= **NOT VERIFIED / BLOCKED BY PAYMENT**；free staging 是 `EPHEMERAL / TEST-ONLY`（B11a 开篇自己写死了这句）。

**给 Owner 的一句话建议：** 在应用 §3 的 9 处改写后，`PROJECT.md` 可以支撑"面试/项目描述"用途（`GO`）；但如果任何对外文本要写"production ready"，当前证据整体是 **NO-GO**（AI live 未验证 + 部署持久性 blocked + 无 production 性能证据）。

---

## 2. 判定总表（`docs/PROJECT.md` 逐句）

判定规则（A0 给定，本表严格执行）：`KEEP` = 有直接、已提交、可复现证据且措辞未超出；`REWORD` = 能力存在但原文过强/过宽；`REMOVE` = 功能不存在；`NOT VERIFIED` = 实现存在但缺验证。

### 2.1 §1 What this is

| ID | Claim（原文，可截断） | Verdict | Evidence | 建议措辞 | 风险（若保留原文） |
| --- | --- | --- | --- | --- | --- |
| P1 | "a team knowledge-base document platform" | **KEEP** | 多文档 store + 成员关系 + 自助创建：`b125/1`（`POST /api/documents` → 201 → 切到服务端 UUID → `owner`），`p2/3`（非成员的 404 不泄露），`m2/G`（文档隔离）；`/health`、`/ready` 见 B11a #1–#2 | — | 只有"知识库"这个名词偏软：没有 wiki/反向链接/组织层级（§4 已把组织层级列为 non-goal）。写成"platform"可以，写成"enterprise knowledge base"就会被 §4 反驳 |
| P2 | "Teams write and co-edit Markdown documents in real time" | **KEEP** | `collab/independent-contexts`（两个独立 context 并发 insert/delete/replace，文本逐字收敛）；`editor/mounts-on-existing-ytext`、`editor/local-edit-reaches-ytext`；Markdown 编辑器 `@codemirror/lang-markdown` 在 `apps/web/package.json` | — | 无。`realtime/two-tabs-converge` **不是**这条的证据（同 profile），但已有替代证据 |
| P3 | "keep working when the network drops" | **KEEP** | `indexeddb/B`（离线打字→关页→**离线重开**仍在）、`indexeddb/A`（后端停掉仍可编辑，`connection-status` 不谎报 connected）、`chaos/offline-reconnect`（不 reload 自行重连、不重挂载） | — | 只能承诺"离线可继续工作"；**不能**顺手承诺"断多久都行"（见 P26） |
| P4 | "let an AI assistant propose edits that a human reviews as a diff before accepting" | **REWORD** | 建议/diff/Accept 链路：`m3/5`、`m3r/1`；但默认 provider 是确定性指令表（`localProvider.ts:11-24`："**not** a language model"），真实外部 provider 未 live 验证（D-085 §4、`kimi.ts:25-32`） | "…and let an AI assistant propose edits that a human reviews as a diff before accepting. The default assistant is a deterministic instruction table; a real external model (OpenAI or Kimi, selected by `AI_PROVIDER`) is implemented but has not been live-verified." | 面试官问"用哪个模型、prompt 怎么写的、线上跑通了吗"——默认配置下答不出来，且会被"not a language model"这句自己代码里的注释反驳 |
| P5 | "a collaborative Markdown knowledge base where AI edits are proposals you review, not changes that happen to you" | **KEEP** | `m3/5`（Accept 前 editor/durable/peer 三方都不动；Accept 后三方都动）、`m3/6`（Reject 逐字节不变）、`m3/7`/`m3/9`（revision / text-mismatch 两种 stale 被拒）、`m3/10`（viewer 的 Accept 是 disabled 且程序化 click 也不生效） | — | 无。这句是整份文档里证据最强的一句 |

### 2.2 §2 Core user flows

| ID | Claim（原文，可截断） | Verdict | Evidence | 建议措辞 | 风险（若保留原文） |
| --- | --- | --- | --- | --- | --- |
| P6 | "a member opens a document and edits Markdown in a CodeMirror editor" | **KEEP** | `editor/mounts-on-existing-ytext`、`editor/local-edit-reaches-ytext`、`06-lifecycle`（20 次 open/switch/disconnect 循环）；真实 `EditorView` 状态由 harness 从**活模块**读回，非推断 | — | 无 |
| P7 | "two **or more** members edit the same document concurrently" | **REWORD** | `collab/independent-contexts`：**恰好两个** `Target.createBrowserContext`，独立 cookie（token 不同、均 HttpOnly）、独立 `localStorage`（A 写 B 读不到）、两轮编辑窗实测重叠（111 ms / 249 ms）；三方文本与 digest 相等（`bda0ea9c…`，19 B，3 clients） | "two members, in two independent browser profiles with separate cookies and storage, edit the same document concurrently" | "three or more" 没有任何证据：`m2/J` 是三个新设备**同时冷加入并水合**同一内容，不是三方并发编辑。写成 "or more" 是把水合当编辑 |
| P8 | "their changes merge without a 'someone else changed this file' conflict dialog" | **KEEP** | 同一场景：最终文本逐字等于预期 `[A-FRONT-2026]\|middle\|[B-OMEGA-REPLACED-20][B-BACK-2026]`，A/B/server 三方相等；产品中不存在冲突对话框（`App.tsx`/workspace 无该 UI） | — | 无。注意这是"区域不相交"的构造（A 管头部、B 管尾部），结论是"收敛"而不是"任意重叠编辑都无冲突" |
| P9 | "a member loses the network mid-sentence. They keep typing; the editor keeps the changes locally, and on reconnect the edits merge with whatever happened on the server." | **REWORD** | 三个半边各有直接证据，但**没有单一场景串起来**：① 离线打字保留 = `indexeddb/B`；② 离线期间对端的编辑在重连后到达 = `chaos/offline-reconnect`（`oracle.append('WHILE-AWAY\|')`）；③ 离线编辑在重连后进入服务端 = `m2/C`（**但该场景要求 out-of-band 续期 session**，因为它是重启后的场景）与 `m3/11` phase 1（owner 离线 Accept → 重连恰好应用一次 → 第二设备收敛，无重启） | "…the editor keeps the changes locally (IndexedDB), and on reconnect the local edits and whatever happened on the server converge. Measured for short outages (≈1–2 s) and, on the AI-accept path, without a restart; the one scenario that also restarts the server renews the session out-of-band and is reported as such." | 说成"一个场景端到端证明"会被 `m2/C` 注释里的 `ctx.authz.renewBrowserSession` 反驳：那是**手工续期**，`p2/S` 记录了客户端不会自己重建 session。这是已记录的 residual（R2/R5），不是新缺陷，但措辞不能盖过它 |
| P10 | "a member asks the assistant to **rewrite/expand/shorten** a passage" | **REWORD** | `localProvider.ts:26-34` 的意图表只有 `uppercase` / `trim-trailing-space` / `add-todo` / `replace-selection:` / `delete-selection`，未知指令抛 `unknown-instruction`；语义改写只有真实 provider 路径，未 live 验证 | "a member writes an instruction for a passage. The assistant returns a suggestion: a summary plus a diff. The default provider understands a fixed instruction set; free-form rewrite/expand/shorten needs a configured external model, which is not live-verified." | "rewrite/expand/shorten"是唯一会被现场 demo 打穿的一句：默认配置下输入"shorten this"得到的是 `unknown-instruction`，不是缩短后的段落 |
| P11 | "The assistant returns a **suggestion**: a summary plus a diff" | **KEEP** | `m3/5`（`ai-summary` + 非空 `ai-diff`，统一 diff 文案）、`m3r/1`（服务端 stub 的固定 summary）、shared `aiSuggestionDraftSchema` 强校验 | — | 无 |
| P12 | "chooses Accept, Reject, or Undo after accepting" | **KEEP** | `m3/5`（Accept→Undo 只撤 AI 编辑，本地打字保留→Redo 恢复）、`m3/6`（Reject）、`m3/1`/`m3/2`/`m3/3`（Undo/Redo 按钮、viewer inert、unknown role 跟随 `canUndo/canRedo`） | — | 无（注意已知的 500 ms `captureTimeout` 合并行为：同一窗口内"打字+立刻接受"一次 Undo 撤两条，D-076 §4a 已记录） |
| P13 | "Nothing lands in the document until Accept" | **KEEP** | `m3/5`（Accept 前 editor/durable/peer 三方均不变）、`m3/6`、`m3/10`（viewer 程序化 click 也不写）、`m3r/1`（remote 链路同样） | — | 无 |
| P14 | "the server decides what a member may read, **comment on**, edit, or administer; the UI only reflects that decision" | **REWORD** | read/edit/administer：`p2/4`（owner/editor/viewer × `documentCapabilities`/HTTP/WS join/WS frame/`room-joined.role`/浏览器可编辑态 一张表）、`f1/4`（伪造 `room-joined(role:owner)` 后写入仍被 `FORBIDDEN`）、`m3/10`。`commenter`：**只有 Node 证据**（`authz-enforcement.test.ts:404`、`capability-matrix.test.ts:218`、`packages/shared/src/permission.ts:39`），浏览器套件里 **0 次**出现 | "the server decides what a member may read, edit, or administer; the UI only reflects that decision. (A `commenter` permission tier exists and is enforced server-side; V1 has no comment feature.)" | 说"comment on"会引出"评论在哪、怎么 @ 人"——§4 明确把 comments-with-mentions threads 列为 non-goal，产品里没有评论对象 |
| P15 | "switching documents quickly must never display document A's content … inside document B" | **KEEP** | `chaos/document-switch-race`（WS 帧跨文档隔离，`a6-*` 两文档）、`editor/switch-document-isolates-old-editor`、`stale/directory-list`（切换后 `active-document`/编辑器文本/目录全部是 B，陈旧 marker 从未进 DOM） | — | 无。**document metadata 那一半是 `NOT APPLICABLE`**（见 P34），不要在别处补写"metadata stale 防护" |
| P16 | "…(or an AI result for A) inside document B" | **NOT VERIFIED** | **没有**任何场景"延迟 AI 响应 → 切换 → 放行旧响应"。仅有间接证据：`AiSuggestPanel.tsx` 在卸载时 abort（`AbortController` 于 182/207 行）、`m3r/3`（切换后 `ai-panel` 卸载）、stale 三情形（`m3/7`/`m3/9` 在**同一文档**内） | 建议**删除该括号**；若要保留："a pending AI proposal belongs to the document that produced it (its panel is unmounted on switch and its request is aborted); no scenario delays an AI response across a switch." | 被问"你怎么证明 A 的 AI 结果不会落到 B"时，只能答"面板卸载 + abort + 同文档 stale 校验"，答不出"我们测过跨文档的旧 AI 响应" |

### 2.3 §3 Milestone 表（记录型 claim）

| ID | Claim（原文，可截断） | Verdict | Evidence | 建议措辞 | 风险（若保留原文） |
| --- | --- | --- | --- | --- | --- |
| P17 | M0 "Monorepo, shared contracts, `/health`, WebSocket `connected` handshake, React shell with CodeMirror, typecheck/test/build green" | **KEEP**（历史记录） | `smoke/harness`；`/health`/`/ready` 见 B11a #1–#2；root scripts `typecheck`/`test`/`build` 存在且被多次记录为 exit 0 | — | 无（历史快照，不描述现状） |
| P18 | M1 "CLOSED（已收口）… A6 浏览器/Chaos 门禁（真实 Chromium **27/27**）… A7 终审 APPROVE" | **KEEP**（历史记录） | 27 是 M1 期场景数；HEAD 已是 73，**无法在 HEAD 复现 27**。里程碑收口记录可保留 | — | 读者可能把 27/27 当"当前覆盖率"。建议在 M1 行加"（M1 期场景数）" |
| P19 | M2 "CLOSED… session authentication + document authorization，HTTP / WS / UI 三层，**48/48**" | **KEEP**（历史记录 + 现有证据支撑） | `p2/1`…`p2/9`、`f1/1`…`f1/4` 在 HEAD 仍全绿（属 73 之内）；48 是 M2 期计数 | — | 同 P18 |
| P20 | M2 "服务端 durable persistence … M1 的'重启即失去文档'不再是系统行为" | **KEEP** | `m2/B`（硬杀进程无 graceful shutdown，新 pid 同目录仍服务）、`m2/E`（压缩后 restart，文本与 `encodeStateAsUpdate` SHA 不变）、`m2/F`（写失败诚实：1011、不广播、不落盘）、`m2/G`（文档隔离） | — | 这是**本地 durable store** 的结论，不是"部署后持久"（P24） |
| P21 | M3 "真实浏览器 **68/68**（默认）+ **73/73**（remote 模式）" | **REWORD** | 当前：默认 **73**、remote **78**（我按 `runner.scenario(` 数出 78，其中 `suite/33` 的 5 条由 `INSIGHTHUB_E2E_AI_MODE=remote` 门控；README 同） | "真实浏览器 **68/68**（默认）+ **73/73**（remote 模式）**（M3 收口时；当前默认 73、remote 78，见 `tests/browser/README.md`）**" | 数字看起来是现状却比现状小 5/5，读者会以为套件退化了；或反过来以为 remote 78 已跑过（**A6 本轮没跑 remote**） |
| P22 | M3 "`OpenAiProvider` 适配器 … `OPENAI_API_KEY` 只在服务端" | **REWORD** | D-085：`AI_PROVIDER=stub\|openai\|kimi\|disabled`，endpoint 代码白名单（`api.openai.com/v1`、`api.moonshot.cn/v1`），生产 fail-fast 四码（`AI_PROVIDER_INVALID` / `OPENAI_API_KEY_MISSING` / `KIMI_API_KEY_MISSING` / `AI_PROVIDER_STUB_FORBIDDEN` / `AI_BASE_URL_FORBIDDEN`）—— 实现见 `apps/server/src/ai/{provider,openai,kimi,env}.ts`，测试见 `startup.test.ts:157-239` | "…`OpenAiProvider` / `KimiProvider` 适配器（D-085：`AI_PROVIDER=openai\|kimi` 可配置、endpoint 代码白名单、生产 fail-fast）；密钥只在服务端" | 只写 OpenAI 会被"那 OpenAI 余额耗尽怎么办"一句话打回；D-085 正是为此而写 |
| P23 | M3 "**12 项 DONE + 真实 provider IMPLEMENTED / NOT LIVE-VERIFIED**" + "M3 CLOSED ≠ PRODUCTION READY" | **KEEP** | 与证据完全一致：`live-smoke.ts` 工具就绪（opt-in、单次、fail-closed exit 2），**无成功记录**；`docs/TASKS.md` B12 仍写"尚未执行真实调用"；Kimi 最近一次 live 为 `400 invalid_request_error`（`kimi.ts:25-32`、`kimi.test.ts:186`），`d73d6f5` 移除 `response_format` 后**未重试** | — | 无。这行是整份文档里口径最准的一行，别动 |
| P24 | M4 "**FROZEN（D-082）；分批实施，当前未开始**" | **REWORD（事实错误）** | `docs/TASKS.md:854`：B1–B11a 全 **DONE**（B1 认证/M 映射、B2 Clerk → WS upgrade、B3 启动 gate、B4 CORS/Origin、B5 AI 限额、B6 迁移/完整性、B7 静态托管+/ready+render.yaml、B8 备份与恢复演练、B9 结构化日志、B10 生产构建 40 PASS/1 SKIP、B11a free staging 19/19）；`B11a-free-staging-smoke.md` 有 19 条真实探测 | "**FROZEN（D-082）；分批实施中** —— B1–B11a 已 DONE（free staging smoke 19/19；该环境数据 EPHEMERAL/TEST-ONLY）；**B11（持久盘 + restart）、B8（deployed backup/restore）、B14（生产终审）仍 BLOCKED BY PAYMENT**；B12 工具就绪、真实外部 provider 尚无成功记录" | "当前未开始"被同一个仓库的 TASKS.md 直接推翻；这是全文档唯一一处**可被单条 grep 证伪**的陈述 |

### 2.4 §3 MVP success criteria（end of M3）

| ID | Claim（原文，可截断） | Verdict | Evidence | 建议措辞 | 风险（若保留原文） |
| --- | --- | --- | --- | --- | --- |
| P25 | "Two browsers edit one document concurrently with no lost updates." | **KEEP** | `collab/independent-contexts`：三方文本逐字相等且等于预期，`sha256(Y.encodeStateVector)` A=B=server | — | 无（"two" 与证据一致；不要加 "or more"，见 P7） |
| P26 | "Killing the network for **30s** does not lose a single keystroke." | **REWORD** | 没有任何场景断网 30 s。实测断网窗口：`chaos/offline-reconnect`（`sleep(1000)` 后恢复）、`indexeddb/B`（离线打字→离线重开）、`indexeddb/C`（无离线打字）、perf baseline 的 **250 ms** × 3 次。键不丢失：`indexeddb/B` 直接证明 | "An outage does not lose a single keystroke: offline typing stays in the local replica and survives closing and reopening the page, and an offline edit reaches the durable store after reconnect. Measured offline windows are 1–2 s; a 30 s outage is not measured." | "30s"是一个从未被执行的判据。面试官追问"你们怎么测 30 秒"时，唯一诚实答案是"没测" |
| P27 | "An accepted AI suggestion is visible to a second client as a normal CRDT edit." | **KEEP** | `m3/5`（Accept 后 peer 看到同一编辑；`apply.test.ts` 断言 origin 只有 `ai`）、`m3r/1`（durable 逐字符等于 `toUpperCase()`） | — | 无 |
| P28 | "A `viewer` cannot mutate a document, and the block happens on the server, not only in the UI." | **KEEP** | `p2/1`（viewer 的编辑器只读 + 真实按键无 SYNC；绕过编辑器发的真实 SYNC 帧被 `FORBIDDEN`，durable 不变、peer 看不到、socket 不断）、`f1/4`（伪造 role 后 UI 变可编辑，写入仍被拒）、`p2/4`（角色矩阵一张表） | — | 无。README 已明确"role 变更不即时反映"（gate 可滞后到下次 join），若被问再引 `f1/1` 的滞后测量 |

### 2.5 §5 Fixed technology stack

| ID | Claim（原文，可截断） | Verdict | Evidence | 建议措辞 | 风险（若保留原文） |
| --- | --- | --- | --- | --- | --- |
| P29 | Frontend：React, TypeScript, Vite, Redux Toolkit, Ant Design, CodeMirror 6 | **KEEP** | `apps/web/package.json`：react 19 / react-dom / `@reduxjs/toolkit` 2.5 / antd 5.22 / `@codemirror/{state,view,commands,lang-markdown}` 6.x / vite 7 / TS 5.7 | — | 无 |
| P30 | Collaboration：Yjs, IndexedDB, WebSocket；`y-protocols`、`lib0`、`y-indexeddb` | **KEEP** | `apps/web/package.json` + `apps/server/package.json` 均含 `yjs`/`y-protocols`；`lib0` 用于二进制编解码；`y-indexeddb` 只在 web；R12 的二进制面由 `packages/shared/src/binary-frame.ts` 统一 | — | 无 |
| P31 | Backend：Node.js, Express, TypeScript, `ws`, Zod | **KEEP**（不完整） | `apps/server/package.json`：express 5.1、ws 8.18、zod 3.25；另有 `@clerk/backend` 与 `cors`（M4 B1/B4 引入，PROJECT.md 未列） | 建议补 "Clerk (`@clerk/backend`) session verification, CORS" | 不列不算错，但"production 认证用 Clerk"是面试必问项，文档里空着 |
| P32 | Shared：the only place a cross-boundary type may be declared | **KEEP** | R1 被遵守；`packages/shared/src` 有 protocol/permission/ai-suggestion/errors/binary-frame；web/server 均以 `@insighthub/shared` 引用 | — | 无 |
| P33 | Tooling：pnpm workspace, `typecheck`, Vitest (plus `node:test` for server integration), Prettier | **KEEP**（不完整） | root `package.json`：`typecheck`/`test`/`test:unit`/`test:server`/`build`/`format`；server 用 `tsx --test`（= node:test）；根 devDeps 另有 `playwright-core` 与 `@clerk/testing`（仅 `tests/deployed/b13.mjs` 使用） | 建议补一句 "plus an opt-in `playwright-core` + `@clerk/testing` harness for the deployed B13 smoke (`tests/deployed/`)" | 文档写"没有浏览器自动化依赖"（README）与 root devDeps 里的 `playwright-core` 冲突，见 §4.F3 |

**小计（PROJECT.md 内）：33 条 → `KEEP` 23 · `REWORD` 9 · `REMOVE` 0 · `NOT VERIFIED` 1。**

### 2.6 `PROJECT.md` 之外：简历 / README / 发布说明的 claim 候选（D-086 §3 的删除令在这里生效）

> 这些**不在** `docs/PROJECT.md` 里（我逐词查过：`preview` 只出现在 AI Diff Preview 语境，`Performance`/`telemetry`/`search`/`debounce`/`bundle`/`p95`/`100` 均无能力性陈述）。若任何对外文本写了它们，按下表处置。

| ID | Claim 候选 | Verdict | Evidence | 建议措辞 | 风险 |
| --- | --- | --- | --- | --- | --- |
| X1 | "Search / cancel stale search / 搜索结果竞态防护" | **REMOVE** | 无 search 功能：`apps/web/src` 全量 grep `search` 只在测试 harness 的 URL 解析里出现；`AiDirectory` 是只读目录，不是搜索 | 删除整句 | 功能不存在；一旦被要求演示就穿帮 |
| X2 | "Markdown preview" | **REMOVE** | 无 preview：只有 AI **Diff Preview**（语义不同，`AiSuggestPanel.tsx` 的 `aria-label="Unified diff preview"`）；inventory B5/B7 同结论 | 删除；若要保留概念，写 "AI Diff Preview（非 Markdown 预览）" | 把 Diff Preview 说成 Markdown 预览 = 两个功能混为一谈 |
| X3 | "preview incremental update / preview debounce" | **REMOVE** | 无 preview，故无 incremental/debounce；inventory B7 `NOT IMPLEMENTED` | 删除 | 同上 |
| X4 | "production PerformanceObserver / 生产端性能观测" | **REMOVE（作为生产声明）** | `apps/**` + `packages/**` grep `PerformanceObserver` / `performance.mark` / `sendBeacon` = **0**；唯一存在的是 `tests/perf/instrument.mjs` 与 `tests/perf/run.mjs`，且 JSON 里 `longTasks.instrumentation` 与 `caution` 都写明 "test instrumentation, not production telemetry" | 删除生产声明；**允许**写 "benchmark harness 内注入 `PerformanceObserver`（test instrumentation）" | 声称生产端有观测 = 声称不存在的东西；D-086 §2 明确要求标注 |
| X5 | "sendBeacon telemetry（hidden/unload 上报）" | **REMOVE** | 全仓 `sendBeacon` = 0，无 telemetry endpoint；inventory B4 `NOT IMPLEMENTED` | 删除 | 同上 |
| X6 | "代码分割 / 按路由拆分（优化）" | **REWORD** | 真实数字：`index-Dm35hFbk.js` **970,271 B raw / 316,847 B gzip**；`ClerkRoot-BPVoNiVC.js` 85,786 / 22,693；`y-indexeddb-DnwhTXDZ.js` 2,913 / 1,271；合计 1,058,970 / 340,811。只有 Clerk 与 y-indexeddb 两个 chunk；editor/preview/highlight **没有**拆分（inventory B8 `PARTIAL`；M2 residual 明确写"bundle 未拆分"） | "主包 970 KB raw / 317 KB gzip；只有 Clerk 与 IndexedDB 两个懒加载 chunk；editor 未做路由级拆分（已列为 residual）" | "按路由拆分/优化"与 dist 里的三个文件直接矛盾 |
| X7 | "100k 行 / p95 / Long Task（作为生产性能）" | **NOT VERIFIED（仅可写 current baseline）** | `PERF-BASELINE-100K.md` + `perf-baseline-100k.json`（我逐项核对了 md 与 json，**全部一致**）：ready 3246 ms；input n=300 p50 **423.8** / p95 **535.9** / max 715（model），next-frame p50 424.8 / p95 537.3 / max 716.3；Long Task **385** / total 163,356 ms / max 715；reconnect restore→connected n=3 p50 **775** / max 812；offline→connected p50 1047 / max 1084；memory 49,159,347 B。全部为**本机、单次、headless、Vite dev server** | 只写："本机 current baseline（Windows 11 / Chrome 155 / commit `9f4879f`）：100k 行 …；production performance **NOT VERIFIED**" | 写成 production p95 会被三件事同时反驳：dev server 而非构建产物、单机单次、Long Task 是 harness 注入 |
| X8 | "优化前 → 优化后 / 性能提升 X%" | **REMOVE** | inventory B9 `UNAVAILABLE`：`git log --grep=perf` 无任何真实性能基线 commit；perf 文档第一句就是 "**Scope: current baseline only.** … not a before/after optimization comparison" | 删除；只保留 current baseline | 没有"优化前"这个数，任何对比都是编造 |

**小计（外部候选）：8 条 → `REMOVE` 6 · `REWORD` 1 · `NOT VERIFIED` 1。**

---

## 3. 给 Owner 的最小改写清单（原文 → 建议文本，可直接粘贴）

> 只改这 9 处（+ 1 处建议删除的括号）。`PROJECT.md` 的中文 milestone 行给中文替换文本，英文段落给英文替换文本。

### R1 · `§1` 第 5–8 行（P4）—— 加一句限定，不动前半句

```diff
- Teams write and co-edit Markdown documents in real time, keep working when the
- network drops, and let an AI assistant propose edits that a human reviews as a
- diff before accepting.
+ Teams write and co-edit Markdown documents in real time, keep working when the
+ network drops, and let an AI assistant propose edits that a human reviews as a
+ diff before accepting. The default assistant is a deterministic instruction
+ table; a real external model (OpenAI or Kimi, selected by `AI_PROVIDER`) is
+ implemented but has not been live-verified.
```

### R2 · `§2` 第 2 条（P7）—— "two or more" → "two … in two independent profiles"

```diff
- 2. **Co-edit** — two or more members edit the same document concurrently; their
-    changes merge without a "someone else changed this file" conflict dialog.
+ 2. **Co-edit** — two members, in two independent browser profiles with their own
+    cookies and storage, edit the same document concurrently; their changes merge
+    without a "someone else changed this file" conflict dialog. (Concurrent
+    editing by three or more clients is not verified.)
```

### R3 · `§2` 第 3 条（P9）—— 说清"哪一半由哪个场景证明"

```diff
- 3. **Survive a disconnect** — a member loses the network mid-sentence. They keep
-    typing; the editor keeps the changes locally, and on reconnect the edits merge
-    with whatever happened on the server.
+ 3. **Survive a disconnect** — a member loses the network mid-sentence. They keep
+    typing; the editor keeps the changes locally (IndexedDB, so they survive a
+    reload), and on reconnect the local edits and whatever happened on the server
+    converge. Measured for outages of 1–2 s, and on the AI-accept path without a
+    restart; the one scenario that also restarts the server renews the session
+    out-of-band and says so.
```

### R4 · `§2` 第 4 条（P10）—— 删掉"rewrite/expand/shorten"的默认承诺

```diff
- 4. **Ask the assistant** — a member asks the assistant to rewrite/expand/shorten a
-    passage. The assistant returns a **suggestion**: a summary plus a diff.
+ 4. **Ask the assistant** — a member writes an instruction for a passage. The
+    assistant returns a **suggestion**: a summary plus a diff. The default
+    provider understands a fixed instruction set (`uppercase`,
+    `trim-trailing-space`, `add-todo`, `replace-selection:`, `delete-selection`);
+    free-form rewrite/expand/shorten needs a configured external model, which is
+    not live-verified.
```

### R5 · `§2` 第 6 条（P14）—— 去掉"comment on"

```diff
- 6. **Stay within permissions** — the server decides what a member may read,
-    comment on, edit, or administer; the UI only reflects that decision.
+ 6. **Stay within permissions** — the server decides what a member may read, edit,
+    or administer; the UI only reflects that decision. (A `commenter` permission
+    tier exists and is enforced server-side; V1 has no comment feature.)
```

### R6 · `§2` 第 7 条（P16）—— 删除未验证的括号

```diff
- 7. **Switch documents safely** — switching documents quickly must never display
-    document A's content (or an AI result for A) inside document B.
+ 7. **Switch documents safely** — switching documents quickly must never display
+    document A's content inside document B.
```

### R7 · M3 行（P21 + P22）—— 数字加时点、provider 按 D-085 补全

```diff
- 真实浏览器 **68/68**（默认）+ **73/73**（remote 模式）。**状态口径（D-081）：
+ 真实浏览器 **68/68**（默认）+ **73/73**（remote 模式）**（M3 收口时；当前默认 73、remote 78，见 `tests/browser/README.md`）**。**状态口径（D-081）：
...
- `OpenAiProvider` 适配器、v8 锚定
+ `OpenAiProvider` / `KimiProvider` 适配器（D-085：`AI_PROVIDER=openai|kimi` 可配置、endpoint 代码白名单、生产 fail-fast）、v8 锚定
```

### R8 · M4 行（P24）—— 唯一的事实错误

```diff
- **FROZEN（D-082）；分批实施，当前未开始**。
+ **FROZEN（D-082）；分批实施中** —— B1–B11a 已 DONE（含 free staging smoke 19/19；该环境数据
+ **EPHEMERAL / TEST-ONLY**）；**B11（持久盘 + restart）、B8（deployed backup/restore）、B14（生产终审）
+ 仍 BLOCKED BY PAYMENT**；B12 工具就绪，真实外部 provider 尚无成功记录。
```

### R9 · MVP 成功标准（P26）—— "30s" 改成实测窗口

```diff
-- Killing the network for 30s does not lose a single keystroke.
+- An outage does not lose a single keystroke: offline typing stays in the local
+  replica and survives closing and reopening the page, and an offline edit
+  reaches the durable store after reconnect. Measured offline windows are 1–2 s;
+  a 30 s outage is not measured.
```

### R10（可选）· `§5`（P31/P33）—— 把 M4 引入的依赖列全

```diff
- **Backend** (`apps/server`): Node.js, Express, TypeScript, `ws`, Zod.
+ **Backend** (`apps/server`): Node.js, Express, TypeScript, `ws`, Zod, CORS, and
+  `@clerk/backend` for session verification (M4).
- **Tooling**: pnpm workspace, TypeScript project-wide `typecheck`, Vitest (plus
- `node:test` for server integration tests), Prettier.
+ **Tooling**: pnpm workspace, TypeScript project-wide `typecheck`, Vitest (plus
+ `node:test` for server integration tests), Prettier, and an opt-in
+ `playwright-core` + `@clerk/testing` harness for the deployed B13 smoke
+ (`tests/deployed/`).
```

---

## 4. 证据强度与 flake 评估

### 4.1 证据强度分级（按"能不能被第三方复跑"排）

| 级别 | 是什么 | 涉及 claim | 评价 |
| --- | --- | --- | --- |
| **E1 已提交 + 真浏览器 + 断言在源码里** | 场景代码入库，断言可读，失败即红，无 retry/skip | P2/P5/P7/P8/P12/P13/P15/P20/P25/P27/P28、P3/P26（行为半边） | **最强**。每个场景先 `ctx.note(...)` 再 `assert`，失败自解释；`run.mjs` 对残留句柄/端口/context 都做 postflight |
| **E2 已提交 + 真浏览器，但数字只在报告叙述里** | 场景只断言不等式（如 `elapsed < 5000`），具体毫秒数写在 md 里 | `stale/directory-list` 的 abort 时延（A6 报告 **69 ms** vs README **78 ms** —— 同一场景两处写了不同数字，两次都远小于 5 s，**判定不变**） | 强，但**数字不可逐字复核**；`artifacts/` 不入库（本轮 `tests/browser/artifacts/` 不存在），要复核只能重跑 |
| **E3 已提交 + 单机单次测量** | `tests/perf/**` + JSON | X7、`reconnect duration` | 可复跑（fixture 确定性、sha256 双次一致），但**样本极小**（reconnect n=3）且是 dev server |
| **E4 只有叙述/未执行** | B12 live smoke 工具就绪但无成功记录 | AI live（P4/P10/P23） | **最弱**：Kimi `400` 后刚改代码未重试，OpenAI 是 429 余额 |
| **E5 外部环境不可访问** | Render free、Clerk 真实登录 | M4 持久性（P24） | `NOT VERIFIED / BLOCKED BY PAYMENT`，B11a 自己写死 EPHEMERAL |

### 4.2 已记录的 flake 与它们的可信度影响

A0 交办的 flake 记录是三条：**`m3/5` 一次状态泄漏**、**`f1/1` 一次探针超时**、**`origin-http` 一次 `fetch failed`**。我做了全文检索：`docs/**` 里 `flake` / `复跑` / `重跑` / `origin-http` / `状态泄漏` / `探针超时` / `fetch failed` **均无命中** —— 也就是说，**这三条 flake 目前只存在于对话/交办里，没有任何已提交文件记录**。这本身是一个治理缺口（见 §5.F2），但不改变下面的逐条判断。

| Flake | 影响哪些 claim | 我的判断 | 是否必须复跑 |
| --- | --- | --- | --- |
| `m3/5` 一次状态泄漏 | P5（Accept 前不落地）、P12（Undo）、P27（peer 看到），以及 §5.F1 的"AI 面板不串文档" | **仍需复跑，但不能据此否证**。理由：`m3/5` 的断言是**记录后断言**（Accept 前 editor/durable/peer 三方都比对），一旦泄漏到"Accept 前文本变了"它必然红；它 PASS 过说明那一次运行时状态是干净的。"状态泄漏"更像**场景间状态隔离**问题（`run.mjs` 每场景关页 + 每场景独立 `INSIGHTHUB_DATA_PATH`，但 AI 面板/Redux store 在同一页面内是进程内状态），不是"证明 Accept 前不落地"这条断言失效 | **是**。建议在最终 HEAD 上**连续两次**全量 `node tests/browser/run.mjs` 全绿，再引用 73/73 |
| `f1/1` 一次探针超时 | P14（viewer 只读 + 不重挂载）、P28（server 是边界） | **不影响结论**。`f1/1` 的核心断言（`contenteditable=false`、`EditorState.readOnly`、notice 文案、同 `.cm-editor` 元素身份）都是同步 DOM/状态读取；"探针超时"发生在等待阶段（`waitFor`），是 harness 时序而非产品行为。且 `p2/1` 从**另一个角度**独立证明了 viewer 写不进（绕过编辑器发真实 SYNC 帧拿 `FORBIDDEN`）—— 两条独立证据互为备份 | 建议复跑一次；不复跑也可用 `p2/1` + `f1/4` 兜底 |
| `origin-http` 一次 `fetch failed` | M4/B11a 的 "Foreign Origin rejected (403)"（PROJECT.md 里没有这条 claim） | **不影响 PROJECT.md 的任何裁决**。B11a 的 Origin 检查在 B4 有 Node 层证据（`http-session.test.ts:355`）与同报告 403 记录；一次 `fetch failed` 是**网络探测失败**，不是"Origin 被放行" | 若要对外引用 "19/19"，需重跑一次 deployed 探测；只引用 PROJECT.md 则不必 |

### 4.3 哪些 PASS 仍然可靠、哪些需要复跑

**可靠（本轮不需要复跑即可引用）：**

- `collab/independent-contexts`（A1）、`stale/directory-list`（C）—— 断言是"三方逐字相等 / digest 相等 / `AbortError` / 陈旧 marker 未进 DOM"，都属于"错就必红"的形态，且**测试代码与 HEAD 逐字节相同**。
- `p2/1`、`p2/4`、`p2/5-*`、`p2/9`、`f1/2`–`f1/4`、`30-m3-ui-evidence`（m3/0–m3/4）、`10-m2-durability`（m2/A–K）、`04-chaos`、`01-persistence`、`02-editor`、`32b-m4-b125` —— 无 flake 记录，断言形态均为"状态 + durable 字节比对"。
- `PERF-BASELINE-100K.md` 的**每一个数字**—— 我把 md 与 `perf-baseline-100k.json` 逐项核对：ready 3246、input p50/p95/max、Long Task 385/163356/715、reconnect 775/812、bundle 970271/316847、memory 49159347 **全部一致**。可复跑命令 `node tests/perf/run.mjs` 在树里。

**需要复跑（或只能降级引用）：**

1. **`73/73` 这个数字本身**：最后一次全量运行在 `7245ceb`（A6），HEAD `39854d4` 上**没有重跑**（本 worktree 无 `artifacts/`）。产品与测试代码相同 → 结论应成立，但"在最终 HEAD 上全绿"是一个**尚未执行**的动作。
2. **`m3/5`**（状态泄漏 flake）：见上表，建议两次连跑。
3. **remote 模式 `78`**：A6 明确写"本轮没有执行远程模式"（其 §F.7）。**78 是注册数（我数出来的），不是通过数**。任何"78/78 全绿"的表述都是错的；只能写"78 = 73 + 5（remote 组未在本轮执行）"。
4. **`f1/1`**（探针超时）：建议一次。
5. **AI live**：`live-smoke.ts` 从未成功过；`d73d6f5` 之后**未重试**。**必须**在有人提供 key 后跑一次，才可能从 `NOT VERIFIED` 变成 `PASS`。
6. **M4 持久性（B11/B8/B14）**：不是"复跑"问题，是"没有环境"，`BLOCKED BY PAYMENT`。

---

## 5. 压缩报告（A–G）

### A. 结论摘要

- `PROJECT.md` 的 **33 条能力性 claim：23 `KEEP` / 9 `REWORD` / 0 `REMOVE` / 1 `NOT VERIFIED`**；外部描述候选 **8 条：6 `REMOVE` / 1 `REWORD` / 1 `NOT VERIFIED`**。
- **必须改的 2 条硬错误**：M4 行"当前未开始"（与 TASKS.md B1–B11a DONE 矛盾）、M3 行 68/73（当前 73/78，且 remote 78 未执行）。
- **必须收紧的 5 条措辞**：AI（默认不是模型）、rewrite/expand/shorten（默认不支持）、two or more（只有两个独立 context）、30s 断网（没测）、comment on（没有评论功能）。
- **必须删的 6 条外部 claim**：search / Markdown preview / preview incremental+debounce / production PerformanceObserver / sendBeacon / 优化前后对比。
- **性能唯一合法写法**：本机 current baseline 数字 + `production performance = NOT VERIFIED`。
- **AI live 仍 `NOT VERIFIED`**：OpenAI `429 credit_balance_exhausted` 是 finding 不是实现失败（保留）；Kimi `400 invalid_request_error` 后刚移除 `response_format`，**未重试**。
- **M4 持久性 `NOT VERIFIED / BLOCKED BY PAYMENT`**：B11 持久盘+restart、B8 deployed backup/restore、B14 终审；free staging 数据 EPHEMERAL/TEST-ONLY（B11a）。
- **推荐**：应用 §3 的 R1–R9 之后，`PROJECT.md` 可用于面试/项目描述（`GO`）；任何 "production ready" 对外表述 → **NO-GO**。

### B. Files

只新增一个文件（`git status` 证明：`apps/**`、`packages/**`、`tests/**`、`docs/PROJECT.md`、`docs/DECISIONS.md`、`package.json` 零改动）：

| 文件 | 职责 |
| --- | --- |
| `docs/agent-governance/A7-claim-evidence-review.md` | 本文件：第二轮 claim-to-evidence 裁定 + 最小改写清单 + flake 评估 |

### C. 判定表（计数）

| 来源 | 条数 | `KEEP` | `REWORD` | `REMOVE` | `NOT VERIFIED` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `docs/PROJECT.md` §1（P1–P5） | 5 | 4 | 1 | 0 | 0 |
| §2 Core user flows（P6–P16） | 11 | 6 | 4 | 0 | 1 |
| §3 Milestone 表（P17–P24） | 8 | 5 | 3 | 0 | 0 |
| §3 MVP success criteria（P25–P28） | 4 | 3 | 1 | 0 | 0 |
| §5 技术栈（P29–P33） | 5 | 5 | 0 | 0 | 0 |
| **PROJECT.md 小计** | **33** | **23** | **9** | **0** | **1** |
| 外部 claim 候选（X1–X8） | 8 | 0 | 1 | 6 | 1 |
| **合计** | **41** | **23** | **10** | **6** | **2** |

**D-086 的 14 个必判点 → 落点：**

| # | 判定点 | 落点 | Verdict |
| ---: | --- | --- | --- |
| 1 | 实时协作 / 多人并发 / 独立用户（A1 限定） | P7（+P2/P8/P25） | `REWORD`（两个独立 context，非 "or more"） |
| 2 | 离线编辑 / 重连收敛 / reconnect duration | P9、P26、P3 | `REWORD`；duration 已实测（p50 775 ms，n=3）但只算 baseline |
| 3 | 重复/乱序帧幂等 | 不在 PROJECT.md；可写 | 若写 → `KEEP`（`chaos/duplicate-inbound-frames`、`chaos/out-of-order-delivery`） |
| 4 | Undo 隔离 | P12（+P5） | `KEEP`（`realtime/local-undo-does-not-revert-remote-text`、`m3/1`、`m3/5`） |
| 5 | IndexedDB 离线恢复 | P3、P9 | `KEEP`（`indexeddb/A`、`indexeddb/B`） |
| 6 | RBAC（owner/editor/viewer，HTTP/WS 一致） | P14、P28 | `REWORD`（删 comment；矩阵一致 `KEEP`） |
| 7 | Document switch stale | P15 / P16 + 本节 D-1 | 内容 `KEEP`；**metadata = `NOT APPLICABLE`**；directory list = `PASS`（69 ms abort，浏览器拒投递） |
| 8 | Search / cancel stale search | X1 | **`REMOVE`**（功能不存在） |
| 9 | Markdown preview / incremental / debounce | X2、X3 | **`REMOVE`** |
| 10 | PerformanceObserver / sendBeacon telemetry | X4、X5 | **`REMOVE`（生产声明）**；harness 内注入可保留，但必须标 "test instrumentation" |
| 11 | 100k / p95 / Long Task | X7 | **`NOT VERIFIED`（作 production）**；只可写本机 current baseline 数字 |
| 12 | bundle / 代码分割 | X6 | `REWORD`：970,271 B / 316,847 B gzip；只有 Clerk + y-indexeddb chunk |
| 13 | AI provider（D-085） | P4、P10、P22、P23 | `REWORD`；**live = `NOT VERIFIED`**（OpenAI 429 是 finding；Kimi 400 → 已改 prompt-only、未重试） |
| 14 | M4 持久性（B11 / B8 / B14） | P24 | `REWORD`（M4 行事实错误）+ **`NOT VERIFIED / BLOCKED BY PAYMENT`** |

### D. Evidence（引用的场景 / 文件 / 数字）

**场景 id（全部在 `tests/browser/suite/**`，已提交）：**

- 协作：`collab/independent-contexts`（A=B=server 文本一致 + `bda0ea9c…` digest 19 B/3 clients；编辑窗重叠 111 ms / 249 ms）、`realtime/two-tabs-converge`（**同 profile，明确不作为多人证据**）
- 离线/chaos：`chaos/offline-reconnect`、`chaos/duplicate-inbound-frames`、`chaos/out-of-order-delivery`、`chaos/document-switch-race`、`indexeddb/A`、`indexeddb/B`、`indexeddb/C`、`indexeddb/D`
- 编辑器：`editor/mounts-on-existing-ytext`、`editor/local-edit-reaches-ytext`、`editor/switch-document-isolates-old-editor`、`editor/remote-change-is-minimal`、`editor/local-undo-available`
- 持久化：`m2/A`、`m2/B`、`m2/C`、`m2/E`、`m2/F`、`m2/G`、`m2/J`、`m2/K`
- 权限：`p2/1`、`p2/2`、`p2/3`、`p2/4`、`p2/5-role-change-is-re-evaluated`、`p2/5-session-revocation-is-everywhere`、`p2/9`、`p2/S`、`f1/1`、`f1/2`、`f1/3`、`f1/4`
- AI：`m3/0`…`m3/11`（默认 7 条 + UI 5 条）、`m3r/1`…`m3r/5`（**remote 模式才有**）
- 创建：`b125/1`、`b125/2`、`b125/3`
- 设计：`ui/1`…`ui/8`（`32-design-fidelity.mjs`）
- stale：`stale/directory-list`（`GET /api/documents` 真实 200 被 CDP 在 response 阶段扣住，body 4,640 B / 28 个 id；切换后 **69 ms** 出现 `AbortError`（A6 报告口径；README 写 78 ms）；`Fetch.fulfillRequest` → `Invalid InterceptionId`；`active-document`/编辑器/目录仍是 B；`aria-current` 只有 B；陈旧 marker 未进 DOM）

**文件与数字：**

| 证据 | 数字/事实 |
| --- | --- |
| `tests/perf/results/perf-baseline-100k.json` + `PERF-BASELINE-100K.md` | fixture 100,000 行 / 6,788,895 chars / `sha256 0d12688d…`（两次生成一致）；ready **3246 ms**；首个 WS **2395 ms**；input n=300 → p50 **423.8** / p95 **535.9** / max **715.0**（model），next-frame p50 **424.8** / p95 **537.3** / max **716.3**；Long Task **385** / total **163,356 ms** / max **715**（test instrumentation）；reconnect restore→connected p50 **775** / max **812**、offline→connected p50 **1047** / max **1084**（n=3，250 ms outage）；bundle `index-Dm35hFbk.js` **970,271 / 316,847**、`ClerkRoot` 85,786 / 22,693、`y-indexeddb` 2,913 / 1,271，合计 **1,058,970 / 340,811**；memory 49,159,347 B |
| `apps/server/src/ai/{kimi,openai,provider,env}.ts`、`startup.test.ts:157-239` | `AI_PROVIDER=stub\|openai\|kimi\|disabled`；endpoint 白名单；5 个生产拒绝码；Kimi `kimi-k3`、**prompt-only**（`kimi.test.ts:188` 断言 `response_format === undefined`） |
| `apps/web/src/features/ai/localProvider.ts:11-66` | 默认 provider 是确定性指令表，注释自述 "**not** a language model"；未知指令抛 `unknown-instruction` |
| `B11a-free-staging-smoke.md` | free staging **19/19 PASS**；EPHEMERAL / TEST-ONLY；B11/B8 `OPEN — BLOCKED BY PAYMENT`；B14 BLOCKED |
| `docs/TASKS.md:854` | B1–B11a **DONE**；B12 工具就绪、尚未真实调用 |
| 场景注册计数（我数的） | `runner.scenario(` = **78**；`suite/33` 的 5 条受 `INSIGHTHUB_E2E_AI_MODE=remote` 门控 → 默认 **73** |
| `git diff 7245ceb..HEAD -- tests/browser apps packages` | **空**（A6 的 73/73 与 HEAD 的代码等价） |
| `git diff 9f4879f..HEAD -- apps packages` | **空**（perf 测量与 HEAD 的产品代码等价） |
| `apps/**` + `packages/**` grep | `PerformanceObserver` / `sendBeacon` / `performance.mark` = **0**；`search` 功能 = **0** |

**D-1 · document metadata 那半边的准确结论（D-086 §4 裁决，复核一致）：** 打开/切换文档时，页面自己的 `__qa.apiCalls` 只有 `POST /api/session/bootstrap`，`GET /api/documents/:id` 计数断言为 **0** → **`NOT APPLICABLE`**（服务端路由存在，客户端在此路径上从不调用）。可写进描述的是**目录列表请求**的 stale 防护 + `AbortController`，**不能**写成 "document metadata stale 防护"。

### E. 证据强度与 flake

- 见 §4。一句话：**E1 级证据（已提交、真浏览器、断言在源码、无 retry）覆盖了 P2/P5/P7/P8/P12/P13/P15/P20/P25/P27/P28 的全部结论**；`73/73` 的**数字**是继承的（`7245ceb`），HEAD 未重跑；`78` 是注册数不是通过数；AI live 是 E4；M4 持久性是 E5。
- flake 三条（`m3/5` 状态泄漏、`f1/1` 探针超时、`origin-http` `fetch failed`）**在 `docs/**` 中零记录**（我全文检索 `flake`/`复跑`/`重跑`/`origin-http`/`状态泄漏`/`探针超时`/`fetch failed`）。判断：三条都**不推翻**已下的 `KEEP`，但 `m3/5` 建议两次连跑、`f1/1` 建议一次、`origin-http` 若要引用 "19/19" 需重跑 deployed 探测。
- 两处**数字不一致**（不影响判定，但影响"逐字可复核"）：`stale/directory-list` 的 abort 时延 **69 ms**（A6 报告）vs **78 ms**（README）；`suite/33` 的错误文案写 "68 default"、注释写 "71"，当前实为 **73**。

### F. Residual（本轮发现、不由我修）

1. **F1（措辞）**：`PROJECT.md` M4 行"当前未开始"是事实错误 —— Owner 改（R8）。
2. **F2（治理）**：**flake 历史没有入库**。三条 flake 只在对话里，任何第三方审查都无法审计"这个 PASS 是不是跑了几次才绿"。建议：任何 flake 必须在 `docs/agent-governance/` 留一行（场景 id / 现象 / 次数 / 是否复跑 / 复跑结果）。
3. **F3（文档一致性）**：`tests/browser/README.md` 的 "Why there is no Playwright" 仍写 "The repository has no browser-automation dependency"，但 root `devDependencies` 已有 `playwright-core` + `@clerk/testing`（仅 `tests/deployed/b13.mjs` 使用）。句子本身说的是 `tests/browser` 的实现选择（仍成立），但**整句在仓库级别已经不成立**。建议改为 "`tests/browser` adds no dependency; the opt-in deployed harness (`tests/deployed/`) uses playwright-core + @clerk/testing."。**我没有改**（不是我的文件）。
4. **F4（可审计性）**：`32-design-fidelity.mjs` 的 **8 条** `ui/*` 场景是 73 的组成部分，但 README 的 "Scenario map" **完全没有列出**这个文件 → 读者无法从 README 把 73 加出来。建议 A6 补一行。
5. **F5（残余数字）**：`suite/33-m3-remote.mjs` 的错误文案/注释还写着 68/71；`m3` 行 68/73 已由 R7 处理。
6. **F6（既有 residual，来自 M2/M3，本轮未变）**：session 进程内、吊销是请求级、角色变更不推送、`openApp` 隐式授权默认、heartbeat stale reap timer、若干诊断字符串 mojibake（我在 `32-design-fidelity.mjs` 头、`04-chaos.mjs`、`31-m3-ai.mjs` 里都看到 `鈥?`）。这些**不影响**本轮任何 `KEEP`，但会影响"代码整洁度"的观感。
7. **F7（未验证，非缺陷）**：`m2/C` 依赖 `ctx.authz.renewBrowserSession`（hand-renewed session）才成立；`requestId` ownership guard 从未被压测（D-086 §4 已接受为 residual）；`commenter` 无浏览器证据；三客户端并发编辑无证据。
8. **F8（性能口径）**：perf baseline 走的是 **Vite dev server**（on-demand transform），bundle 数字来自 `pnpm build` 产物 —— 两者不是同一条运行时路径，`PERF-BASELINE-100K.md` 的 Limitations 已如实写；引用时不要混为一谈。

### G. Next Handoff: A0

```text
Handoff Status: OWNER_DECISION_REQUIRED
Recommended Next Agent: A0

Base: agent/a7-claim-review @ 39854d4（本文件为紧随其后的提交）
Why: 第二轮 claim-to-evidence 复核完成。PROJECT.md 的 33 条能力性 claim 已逐句裁定
     （23 KEEP / 9 REWORD / 0 REMOVE / 1 NOT VERIFIED），并给出可直接粘贴的
     最小改写清单（R1–R9 + 可选 R10）。需要 A0 决定：是否按 R1–R9 落笔改 PROJECT.md
     （尤其是 M4 行的"当前未开始"事实错误与 M3 行的 68/73 数字），
     以及是否要求 A6 在最终 HEAD 上复跑（m3/5 两次连跑、f1/1 一次、
     remote 78 组一次），再对外引用 "73/73"。

Dependencies satisfied:
- HEAD 上 docs/PROJECT.md、DECISIONS D-085/D-086、inventory、A6 round-2 报告、
  PERF-BASELINE-100K + 其 JSON、tests/browser/suite 全部 17 个文件、
  tests/perf/** 均已实际读取（非推断）。
- 场景计数独立核对：runner.scenario( = 78；default 73 / remote 78（5 条 env-gated）。
- Provenance 已核实：7245ceb..HEAD 与 9f4879f..HEAD 对 apps/tests 均为空 diff。
- 本轮零产品改动、零测试改动、未 merge/push/tag。

Copy-paste Prompt:
A0 复核 A7 第二轮 claim-to-evidence review（branch agent/a7-claim-review @ 39854d4）：
- 只读审查，只新增 docs/agent-governance/A7-claim-evidence-review.md，无产品/测试改动。
- 请裁决 4 件事：
  1) 是否按 §3 的 R1–R9 直接改 docs/PROJECT.md（R8 = M4 行"当前未开始"是事实错误；
     R7 = M3 行 68/73 → 当前 73/78 且 remote 78 未执行；R9 = "30s 断网"改为实测窗口）；
  2) 是否接受"A 只有两个独立 context 的多人证据"（不补第三客户端）；
  3) 是否接受 AI live 维持 NOT VERIFIED（Kimi prompt-only 改动未重试）；
  4) 是否要求 A6 在 HEAD 复跑（m3/5 两次连跑、f1/1 一次、remote 78 组一次），
     并把三条 flake 补记进 docs/agent-governance/（当前 zero 记录）。
- 不要为让描述成立而实现 preview/search/telemetry；D-086 §3 的删除令已生效。
```

---

**本文件不改变代码、测试或产品描述。** 上述改写是**建议文本**，由 Owner / A0 决定是否落笔到 `docs/PROJECT.md`。
