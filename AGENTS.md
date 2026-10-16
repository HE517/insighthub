# AGENTS.md — InsightHub Multi-Agent Working Agreement

This file is the operating contract for every AI agent (and human) working in this
repository. It is binding: when a task conflicts with this file, stop and ask the
Supervisor instead of guessing.

Read order before doing anything:

1. `AGENTS.md` (this file)
2. `docs/PROJECT.md` — what we are building and what is out of scope
3. `docs/ARCHITECTURE.md` — where code is allowed to live
4. `docs/CONTRACTS.md` — the shared types you must reuse
5. `docs/TASKS.md` — the current milestone and task ownership

---

## 1. Non-negotiable engineering rules

| Rule | Detail                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `packages/shared/**` is the **only** source of truth for types crossing web/server. Never re-declare a shared type inside an app.                                                                                                               |
| R2   | Never edit another agent's owned files. If you need a change there, file a request in your report under `Need Supervisor Decision`.                                                                                                             |
| R3   | Keep the dependency surface small. No new production dependency without Supervisor approval.                                                                                                                                                    |
| R4   | No secrets, tokens, passwords or API keys in code, docs, fixtures or tests.                                                                                                                                                                     |
| R5   | Every acceptance criterion you claim must be backed by a command you actually ran, with its real output. "Should work" is not evidence.                                                                                                         |
| R6   | Never mark a task done while a typecheck, test or build is failing.                                                                                                                                                                             |
| R7   | Do not refactor unrelated code in the same change as a feature. One concern per change.                                                                                                                                                         |
| R8   | AI features are proposals, not state. Accepting an AI edit must go through a Yjs transaction; the AI module must never write final document content into React/Redux state.                                                                     |
| R9   | Every network call takes an `AbortSignal` and must handle the aborted/stale case.                                                                                                                                                               |
| R10  | Offline is a first-class state, not an error path. Editing must not be silently lost.                                                                                                                                                           |
| R11  | **Document content has exactly one source of truth: `Y.Doc` / `Y.Text`.** Never mirror the body into React state or Redux. Redux may hold only `activeDocumentId`, metadata, permission, connection status, collaborator metadata and UI state. |
| R12  | The WebSocket has two planes: **TEXT = JSON control protocol**, **BINARY = Yjs sync + awareness**. Never base64 a Yjs update into JSON, and never invent a second framing scheme — always use `packages/shared/src/binary-frame.ts`.            |
| R13  | A local undo reverts only local/AI-origin edits. Never undo a remote collaborator's change, and never implement undo as a text-snapshot restore. Use `UNDO_TRACKED_ORIGINS`.                                                                    |

## 2. Supervisor Review Required

The following paths change the interface or the foundation every agent depends on.
Changing them **requires explicit Supervisor approval before the edit lands**:

- `packages/shared/**`
- `package.json` (root and any workspace package)
- `pnpm-workspace.yaml`
- `docs/ARCHITECTURE.md`
- `docs/CONTRACTS.md`

Process for a required change:

1. Do **not** edit the file yet.
2. Report the proposed diff shape, the reason, and the blast radius (who breaks).
3. Wait for explicit approval from A0.
4. Apply the change **alone**, in its own change set, with a typecheck + test run.

Everything else (app-local code, app-local tests, `docs/TASKS.md` status updates,
`docs/PROJECT.md` wording that does not change scope) may be edited by the owning
agent within its assigned task.

## 3. Agent roles

### A0 — Supervisor / Architect

Owns architecture, task decomposition, the API contract, decision records and
integration coordination. Sole approver for the paths listed in §2. Does not
implement feature work by default; unblocks and reviews instead.

### A1 — Collaboration Agent

Owns Yjs / CRDT behaviour: `Y.Doc`, `Y.Text`, state vectors, `RelativePosition`,
IndexedDB persistence, offline editing, reconnect/merge, and collaboration undo
(undo must not clobber remote edits).

### A2 — Editor Frontend Agent

Owns React, CodeMirror 6 integration, Redux state shape for the editor, Ant Design
UI, Markdown rendering and frontend performance (memoization, virtualized lists,
avoiding re-render storms on every keystroke).

### A3 — Realtime Backend Agent

Owns Express + `ws`: document rooms, connection lifecycle, join/leave, presence,
fan-out, heartbeat/termination, and backpressure on slow sockets.

### A4 — AI Document Agent

Owns AI edit suggestions: request pipeline, suggestion schema usage, diff
generation and Diff Preview, Accept / Reject / Undo, and staleness detection
against `baseRevision`.

### A5 — Permission & State Agent

Owns auth, RBAC enforcement (server-side authority, client-side UI gating),
`AbortController` discipline, stale-response protection and document-switching
race conditions.

### A6 — QA / Chaos Agent

Owns adversarial verification: concurrency, offline/reconnect, duplicate or
out-of-order events, race conditions, permission switching mid-session. Writes
the failing test first, then reports.

### A7 — Integration / Review Agent

Owns integration health: reviews diffs against this file and `docs/CONTRACTS.md`,
runs `pnpm typecheck`, `pnpm test`, `pnpm build`, hunts regressions, and is the
last gate before a milestone is declared complete.

## 4. Mandatory completion report

Every agent finishes a task with exactly this block. Missing fields = task not
accepted.

```text
Status: <done | partial | blocked>
Files Changed: <paths, one per line; "none" if none>
API Changes: <shared contract / protocol / endpoint changes; "none" if none>
Tests: <command run + observed result; "none" if none written>
Dependencies: <added/removed deps; "none" if none>
Known Risks: <honest list; "none" if none>
Need Supervisor Decision: <questions or approval requests; "none" if none>
```

## 5. Definition of Done (every task)

1. Code compiles: `pnpm typecheck` passes.
2. Tests pass: `pnpm test` (add tests for new shared contracts and for any bug you fix).
3. `pnpm build` passes if you touched a build input.
4. New behaviour is exercised by at least one test or a documented manual command
   with real output.
5. Files you did not own are untouched (`git status` proves it).
6. The §4 report is included in your final message.

## 6. Interface discipline

- Add to `docs/CONTRACTS.md` **before** implementing anything that crosses the
  web/server boundary.
- The WebSocket envelope shape is fixed: `{ type, payload, requestId?, ts }`.
  `payload` is always an object. Unknown `type` values are rejected, not ignored.
- The binary data plane is fixed too: frame type `0 = SYNC`, `1 = AWARENESS`, with
  the payload written by `y-protocols`. Use the shared codec; do not parse frames
  locally.
- Use the frozen error codes from `packages/shared/src/errors.ts`; never invent an
  error string.
- Shared schemas are Zod schemas and the TypeScript types are derived from them
  (`z.infer`). Do not hand-write a parallel interface that can drift.
- Breaking a shared contract requires a version bump (`SHARED_CONTRACT_VERSION`
  and/or `PROTOCOL_VERSION`) and a note in `docs/DECISIONS.md`.

## 6.1 Collaboration seam discipline (M1)

- `apps/web/src/collab/public.ts` is the **only** collaboration entry point for the
  editor layer. `apps/web/src/collab/internal/**` is private to A1.
- A2 consumes `CollaborativeSession` from `@insighthub/shared` and must not import
  IndexedDB, reconnect, state-vector or socket-framing modules.
- A1 must not import editor/CodeMirror code into `collab/**`.
- A session becomes `active` from **local** state; it must never wait on the
  network before the editor is usable.

## 7. Scope discipline

- `docs/PROJECT.md` Non-goals are binding. Do not add Next.js, NestJS, LangChain,
  LangGraph, Kafka, Kubernetes, microservices, Redis Cluster, or multi-region
  deployment.
- Do not start a later milestone's work inside an earlier one. M0 ships a
  skeleton that runs; M1-A0 ships a frozen contract. Neither ships collaboration,
  AI or auth.
- Prefer the smallest change that satisfies the acceptance criteria. No
  speculative abstraction.
