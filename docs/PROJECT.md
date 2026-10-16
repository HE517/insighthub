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
| **M1 Collaboration core** | `Y.Doc`/`Y.Text` bound to CodeMirror, WebSocket document rooms + sync, IndexedDB persistence, offline editing, reconnect merge | not started |
| **M2 Permissions & state** | Auth, document RBAC (server authority), request cancellation, stale-response and document-switch race protection | not started |
| **M3 AI suggestions** | AI request pipeline, suggestion + diff, Diff Preview, Accept/Reject/Undo applied via Yjs transaction | not started |
| **M4 Hardening** | Markdown preview and editor performance, virtualized document/tree lists, chaos tests (concurrency, duplicate events, reconnect) | not started |

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
