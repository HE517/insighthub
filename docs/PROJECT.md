# PROJECT.md — InsightHub

## 1. What this is

**InsightHub** is a team knowledge-base document platform with an AI assistant.
Teams write and co-edit Markdown documents in real time, keep working when the
network drops, and let an AI assistant propose edits that a human reviews as a
diff before accepting. The default assistant is a deterministic instruction
table; a real external model (OpenAI or Kimi, selected by `AI_PROVIDER`) is
implemented but has not been live-verified.

One sentence: *a collaborative Markdown knowledge base where AI edits are
proposals you review, not changes that happen to you.*

## 2. Core user flows

1. **Write** — a member opens a document and edits Markdown in a CodeMirror editor.
2. **Co-edit** — two members, in two independent browser profiles with their own
   cookies and storage, edit the same document concurrently; their changes merge
   without a "someone else changed this file" conflict dialog. (Concurrent
   editing by three or more clients is not verified.)
3. **Survive a disconnect** — a member loses the network mid-sentence. They keep
   typing; the editor keeps the changes locally (IndexedDB, so they survive a
   reload), and on reconnect the local edits and whatever happened on the server
   converge. Measured for outages of 1–2 s, and on the AI-accept path without a
   restart; the one scenario that also restarts the server renews the session
   out-of-band and says so.
4. **Ask the assistant** — a member writes an instruction for a passage. The
   assistant returns a **suggestion**: a summary plus a diff. The default
   provider understands a fixed instruction set (`uppercase`,
   `trim-trailing-space`, `add-todo`, `replace-selection:`, `delete-selection`);
   free-form rewrite/expand/shorten needs a configured external model, which is
   not live-verified.
5. **Review the suggestion** — the member sees a Diff Preview and chooses
   Accept, Reject, or Undo after accepting. Nothing lands in the document until
   Accept.
6. **Stay within permissions** — the server decides what a member may read, edit,
   or administer; the UI only reflects that decision. (A `commenter` permission
   tier exists and is enforced server-side; V1 has no comment feature.)
7. **Switch documents safely** — switching documents quickly must never display
   document A's content inside document B.

## 3. MVP

MVP is delivered in milestones. Only the marked milestone is in scope at a time.

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0 Bootstrap** | Monorepo, shared contracts, `/health`, WebSocket `connected` handshake, React shell with CodeMirror, typecheck/test/build green | **done** |
| **M1 Collaboration core** | `Y.Doc`/`Y.Text` 绑定 CodeMirror、WebSocket 文档房间 + 同步、IndexedDB 持久化、离线编辑、重连合并 | **CLOSED（已收口）** —— 已以 `--no-ff` merge commit `1fa2abe` 合入 `main`。实现、A6 浏览器/Chaos 门禁（真实 Chromium 27/27）、P0 稳定化与 A7 终审（**APPROVE**，C1/C2 均 CLOSED）全部完成；合并后在 `main` 上重跑 typecheck / test / build / browser 全绿。**M1 时期的已知限制：没有服务端持久化** —— 它不是 M1 未完成项，而是 M2 backlog 的首项；**该限制已由 `M2-P0-1` 移除**（`m2-p0-gate`，见 `docs/DECISIONS.md` D-060），M1 的"重启即失去文档"不再是系统行为。届时另两项 M2 backlog（presence 写侧 seam `M2-P0-2`、注入式 IndexedDB 工厂引用计数 `M2-P0-3`）亦已实现（D-039、D-055、D-058） |
| **M2 Durable persistence & the two M1 gaps** | 服务端 durable persistence、presence 写侧 seam、注入式 IndexedDB 工厂生命周期；随后 Phase 2：permission & authentication consistency | **CLOSED（已收口）** —— 交付为 annotated tag `m2-closed`。`M2-P0 Exit Gate`（A–K + P0-2 + P0-3 + A6 + A7 P0 review）**PASS**，发布为 `m2-p0-gate`；`M2 Phase 2 / 权限认证` **已实现并合入 `main`**（session authentication + document authorization，HTTP / WS / UI 三层，48/48 真实浏览器场景）；TOOLING-P2（门禁偶发不退出）已修复，失败测试现在会红着退出（D-071）；A7 两轮独立审查（Phase 2 / closure）均 GO 且条件已关闭。**R1–R8 作为具名 residual/backlog 带入 M3**（吊销为请求级、session 进程内、角色变更不推送、6 处诊断字符串 mojibake、commenter/被拒 join 的 null 窗口、openApp 隐式授权默认、bundle 未拆分、heartbeat stale reap timer），**不阻断 M2，但必须出现在 M3 kickoff**。实现见 `apps/server/src/persistence/**`、`apps/server/src/authz/**`、`apps/web/src/collab/internal/persistence.ts`、`packages/shared/src/collab-session.ts`；设计见 `docs/ARCHITECTURE.md` §7/§8、`docs/CONTRACTS.md` §14–§17、`docs/DECISIONS.md` D-040…D-072。**durability 边界见 D-060 §2；发布说明禁令见 D-064 §1（禁令 1 已被 D-069 §3 取代）与 D-066 §5。** |
| **M3 AI suggestions** | AI request pipeline, suggestion + diff, Diff Preview, Accept/Reject/Undo applied via Yjs transaction | **CLOSED（`m3-closed`）。** 交付：客户端 provider seam（local/remote 工厂）+ 确定性本地 provider、服务端 `POST /api/ai/suggest`（**draft-only**，`OPENAI_API_KEY` 只在服务端）、`OpenAiProvider` / `KimiProvider` 适配器（D-085：`AI_PROVIDER=openai|kimi` 可配置、endpoint 代码白名单、生产 fail-fast）、v8 锚定（RelativePosition + `expectedText` 三段校验）、Diff Preview / Accept / Reject、`ai` origin 单事务、undo 隔离、权限门控、AI 只读目录；真实浏览器 **68/68**（默认）+ **73/73**（remote 模式）**（M3 收口时；当前默认 **78**、remote **83（注册未跑）**，见 `tests/browser/README.md`）**。**状态口径（D-081）：12 项 DONE + 真实 provider IMPLEMENTED / NOT LIVE-VERIFIED。** ⚠️ **M3 CLOSED ≠ PRODUCTION READY**：真实外部 provider 尚无成功 live 记录、demo bootstrap 不是真实认证（M4 已改 Clerk）、AI 限额已在 M4 B5 实现。生产启用外部 provider 的硬门前置是 M4 D1/D3/D6（见 D-081 §3），**16 条 residual 见 D-081 §5，不得从发布说明删除**。 |
| **M4 Production Readiness / Launch** | Clerk 认证（Email + Google）、internal user 映射、production config fail-fast、CSRF/CORS 硬化、AI 限额与真实 provider 策略、持久化迁移/完整性、Render 单实例部署、备份与恢复演练、结构化日志、production-like + deployed smoke | **FROZEN（D-082）；分批实施中** —— B1–B11a 已 DONE（含 free staging smoke 19/19；该环境数据 **EPHEMERAL / TEST-ONLY**）；**B11（持久盘 + restart）、B8（deployed backup/restore）、B14（生产终审）仍 BLOCKED BY PAYMENT**；B12 工具就绪，真实外部 provider 尚无成功记录。V1 明确：single instance / single region / no HA / 短暂停机可接受；**不引入** K8s/Redis/Postgres/多区域。**认证不重复造 session**：先验证 Clerk session 是否覆盖 restart/deploy 连续性、logout/revoke、HTTP 与 WS upgrade。Demo bootstrap 仅 dev/test。见 `docs/TASKS.md` M4 的 B1–B14（含 B11a / B12.5）。 |

### MVP success criteria (end of M3)

- Two browsers edit one document concurrently with no lost updates.
- An outage does not lose a single keystroke: offline typing stays in the local
  replica and survives closing and reopening the page, and an offline edit
  reaches the durable store after reconnect. Measured offline windows are 1–2 s;
  a 30 s outage is not measured.
- An accepted AI suggestion is visible to a second client as a normal CRDT edit.
- A `viewer` cannot mutate a document, and the block happens on the server, not
  only in the UI.

## 4. Non-goals

Explicitly **out of scope for MVP phase 1**. Do not build these, and do not add
dependencies that presume them:

- Enterprise SSO (SAML/OIDC/SCIM)
- Complex organizational hierarchy / departments / nested teams
- Billing, plans, quota metering
- Microservices — this is one web app and one API server
- Kubernetes or any container orchestration
- Redis Cluster / Kafka / distributed message bus
- Multi-region deployment, active-active replication
- Real-time audio/video, comments-with-mentions threads (revisit after M4)
- Rich-text/WYSIWYG editing — the document model is Markdown

## 5. Fixed technology stack

**Frontend** (`apps/web`): React, TypeScript, Vite, Redux Toolkit, Ant Design,
CodeMirror 6.

**Collaboration** (across `apps/web` + `apps/server`): Yjs, IndexedDB, WebSocket.
Supporting libraries, approved by A0 in M1-A0: `y-protocols` (official sync and
awareness wire format — we do not invent a CRDT protocol), `lib0` (the
varint/binary codec that Yjs uses), `y-indexeddb` (local persistence provider,
client only).

**Backend** (`apps/server`): Node.js, Express, TypeScript, `ws`, Zod, CORS, and
`@clerk/backend` for session verification (M4).

**Shared** (`packages/shared`): domain types, Zod schemas, WebSocket protocol,
API contract. The only place a cross-boundary type may be declared.

**Tooling**: pnpm workspace, TypeScript project-wide `typecheck`, Vitest (plus
`node:test` for server integration tests), Prettier, and an opt-in
`playwright-core` + `@clerk/testing` harness under `tests/deployed/` for the
deployed smoke (never imported by the product).

Deliberately **not** adopted: Next.js, NestJS, LangChain, LangGraph, Kafka,
Kubernetes, microservices. Any proposal to add one must go through
`docs/DECISIONS.md` and Supervisor approval (see `AGENTS.md` §2).

## 6. Repository layout

```
InsightHub/
  apps/
    web/        React client: UI, CodeMirror, Redux, AI suggestion UI, permission UI
    server/     Express API, WebSocket transport, authz, document storage
  packages/
    shared/     types, Zod schemas, WS protocol, API contract
  docs/         PROJECT / ARCHITECTURE / CONTRACTS / TASKS / DECISIONS
  AGENTS.md     multi-agent working agreement (binding)
```
