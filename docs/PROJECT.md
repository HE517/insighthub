# PROJECT.md — InsightHub

## 1. What this is

**InsightHub** is a team knowledge-base document platform with an AI assistant.
Teams write and co-edit Markdown documents in real time, keep working when the
network drops, and let an AI assistant propose edits that a human reviews as a
diff before accepting.

One sentence: *a collaborative Markdown knowledge base where AI edits are
proposals you review, not changes that happen to you.*

## 2. Core user flows

1. **Write** — a member opens a document and edits Markdown in a CodeMirror editor.
2. **Co-edit** — two or more members edit the same document concurrently; their
   changes merge without a "someone else changed this file" conflict dialog.
3. **Survive a disconnect** — a member loses the network mid-sentence. They keep
   typing; the editor keeps the changes locally, and on reconnect the edits merge
   with whatever happened on the server.
4. **Ask the assistant** — a member asks the assistant to rewrite/expand/shorten a
   passage. The assistant returns a **suggestion**: a summary plus a diff.
5. **Review the suggestion** — the member sees a Diff Preview and chooses
   Accept, Reject, or Undo after accepting. Nothing lands in the document until
   Accept.
6. **Stay within permissions** — the server decides what a member may read,
   comment on, edit, or administer; the UI only reflects that decision.
7. **Switch documents safely** — switching documents quickly must never display
   document A's content (or an AI result for A) inside document B.

## 3. MVP

MVP is delivered in milestones. Only the marked milestone is in scope at a time.

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0 Bootstrap** | Monorepo, shared contracts, `/health`, WebSocket `connected` handshake, React shell with CodeMirror, typecheck/test/build green | **done** |
| **M1 Collaboration core** | `Y.Doc`/`Y.Text` 绑定 CodeMirror、WebSocket 文档房间 + 同步、IndexedDB 持久化、离线编辑、重连合并 | **CLOSED（已收口）** —— 已以 `--no-ff` merge commit `1fa2abe` 合入 `main`。实现、A6 浏览器/Chaos 门禁（真实 Chromium 27/27）、P0 稳定化与 A7 终审（**APPROVE**，C1/C2 均 CLOSED）全部完成；合并后在 `main` 上重跑 typecheck / test / build / browser 全绿。**M1 时期的已知限制：没有服务端持久化** —— 它不是 M1 未完成项，而是 M2 backlog 的首项；**该限制已由 `M2-P0-1` 移除**（`m2-p0-gate`，见 `docs/DECISIONS.md` D-060），M1 的"重启即失去文档"不再是系统行为。届时另两项 M2 backlog（presence 写侧 seam `M2-P0-2`、注入式 IndexedDB 工厂引用计数 `M2-P0-3`）亦已实现（D-039、D-055、D-058） |
| **M2 Durable persistence & the two M1 gaps** | 服务端 durable persistence、presence 写侧 seam、注入式 IndexedDB 工厂生命周期；随后 Phase 2：permission & authentication consistency | **Phase 2 已实现并有真实浏览器证据；A7 closure review 已完成，当前仅等负责人对 `m2-closed` 的一次明确授权** —— `M2-P0 Exit Gate`（A–K + P0-2 + P0-3 + A6 + A7 P0 review）**已通过**并发布为 annotated tag `m2-p0-gate`；`M2 Phase 2 / 权限认证` **已实现并合入 `main`**（session authentication + document authorization，HTTP / WS / UI 三层，48/48 真实浏览器场景）；TOOLING-P2（门禁偶发不退出）已修复（D-071）。**M2 仍未 CLOSED。** 实现见 `apps/server/src/persistence/**`、`apps/server/src/authz/**`、`apps/web/src/collab/internal/persistence.ts`、`packages/shared/src/collab-session.ts`；设计见 `docs/ARCHITECTURE.md` §7/§8、`docs/CONTRACTS.md` §14–§17、`docs/DECISIONS.md` D-040…D-071。**durability 边界见 D-060 §2；发布说明禁令见 D-064 §1（禁令 1 已被 D-069 §3 取代）与 D-066 §5。** |
| **M3 AI suggestions** | AI request pipeline, suggestion + diff, Diff Preview, Accept/Reject/Undo applied via Yjs transaction | not started |
| **M4 Hardening** | Markdown preview and editor performance, virtualized document/tree lists, chaos hardening beyond the M1-A6 gate (which already covers reconnect, duplicate and out-of-order frames) | not started |

### MVP success criteria (end of M3)

- Two browsers edit one document concurrently with no lost updates.
- Killing the network for 30s does not lose a single keystroke.
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

**Backend** (`apps/server`): Node.js, Express, TypeScript, `ws`, Zod.

**Shared** (`packages/shared`): domain types, Zod schemas, WebSocket protocol,
API contract. The only place a cross-boundary type may be declared.

**Tooling**: pnpm workspace, TypeScript project-wide `typecheck`, Vitest (plus
`node:test` for server integration tests), Prettier.

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
