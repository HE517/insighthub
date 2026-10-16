# TASKS.md

Milestone plan and task ownership. Owner roles are defined in `AGENTS.md` §3.
Status legend: `todo` · `doing` · `review` · `done` · `blocked`.

---

## M0 — Bootstrap ✅ done

| ID | Task | Owner | Status |
| --- | --- | --- | --- |
| M0-1 | pnpm workspace skeleton (`apps/*`, `packages/*`) | A0 | done |
| M0-2 | Shared contracts + Zod schemas + WS protocol | A0 | done |
| M0-3 | Express server: `GET /health`, `GET /api/meta` | A0 | done |
| M0-4 | WebSocket server on `/ws` sending `connected` | A0 | done |
| M0-5 | React shell + Redux + Ant Design + CodeMirror mount | A0 | done |
| M0-6 | Client channel hook: validate frames, reconnect backoff | A0 | done |
| M0-7 | Tests: shared contract + server integration | A0 | done |
| M0-8 | Docs + `AGENTS.md` working agreement | A0 | done |

### M0 acceptance criteria and evidence

| # | Criterion | How it was verified | Result |
| --- | --- | --- | --- |
| 1 | `pnpm install` succeeds | `pnpm install` | `Done in 22.5s`, 283 packages |
| 2 | React frontend starts | `pnpm --filter @insighthub/web dev` (inside `verify:m0`) | `VITE v7.3.7 ready in 367 ms`, serves app shell (200, 663 bytes) |
| 3 | Express backend starts | `pnpm --filter @insighthub/server dev` (inside `verify:m0`) | `http ready http://127.0.0.1:3101`, `ws ready .../ws` |
| 4 | `GET /health` returns 200 | `verify:m0` | `200 {"status":"ok"}` |
| 5 | Browser can connect to WebSocket | `verify:m0` | upgrade accepted on `/ws`; non-`/ws` path rejected |
| 6 | Server sends `connected` | `verify:m0` | `{"type":"connected","payload":{"connectionId":"687d...","protocolVersion":1,...}}` parsed by the shared parser |
| 7 | `shared` referenced by web and server | `workspace:*` deps + real imports in both apps | resolves in `tsc` and in `vite build` (1494 modules) |
| 8 | `pnpm typecheck` succeeds | `pnpm typecheck` | 3/3 packages `Done`, no errors |
| 9 | `pnpm build` succeeds | `pnpm build` | shared `tsc` + server `tsc` + web `vite build` → `built in 21.11s` |

Test suites run during M0:

- `packages/shared`: 16 Vitest assertions across 3 files over the contract and
  protocol (envelope shape, unknown-type rejection, wrong-direction rejection,
  invalid JSON, requestId optionality, ISO-timestamp requirement, AI suggestion
  staleness and operation validation, RBAC capability matrix).
- `apps/server`: 4 `node:test` integration assertions on an ephemeral port
  (`/health` 200, unknown path 404, valid `connected` handshake, foreign-path
  upgrade rejected).

Reproduce everything with:

```bash
pnpm install && pnpm typecheck && pnpm test && pnpm build
pnpm --filter @insighthub/server verify:m0
```

---

## M1 — Collaboration core (proposed, awaiting approval)

Split so A1, A2 and A3 can work in parallel. Interface rule: agree the *shared*
surface first (A0), then each agent owns its own files. Nothing in this milestone
may edit another agent's owned files — see the full task briefs in the M1 plan
delivered with the M0 report.

| ID | Task | Owner | Coarse scope |
| --- | --- | --- | --- |
| M1-A1 | Yjs document + offline persistence + reconnect merge | A1 | client CRDT layer |
| M1-A2 | CodeMirror ⇄ Y.Text binding + editor Redux shape | A2 | editor integration |
| M1-A3 | Document rooms, sync relay, presence, lifecycle | A3 | server realtime |
| M1-A0 | Contract additions (`sync`/`awareness` vocabulary) | A0 | `packages/shared` |
| M1-A6 | Chaos tests for M1 (reconnect, duplicate frames) | A6 | tests |

**Entry criteria:** M0 green; supervisor approves the M1 contract additions.
**Exit criteria:** two browser sessions converge; 30s offline produces no data
loss; reconnect transfers only a delta.

---

## M2 — Permissions & state (sketch)

Auth, document RBAC enforced server-side, request cancellation, stale-response
guards and document-switch race protection. Owner: A5.

## M3 — AI suggestions (sketch)

AI request pipeline, suggestion + diff generation, Diff Preview, Accept / Reject
/ Undo applied through a Yjs transaction. Owner: A4.

## M4 — Hardening (sketch)

Markdown preview performance, virtualized lists, chaos/regression suite.
Owners: A2 (performance), A6 (chaos), A7 (integration gate).

---

## Working rules for task files

- One task per agent at a time; a task lists explicit **Owned Files** and
  **Do Not Touch** paths.
- A task is only `done` when its acceptance criteria have been run and the
  completion report from `AGENTS.md` §4 is included.
- Any change touching `packages/shared/**`, any `package.json`,
  `pnpm-workspace.yaml`, `docs/ARCHITECTURE.md` or `docs/CONTRACTS.md` goes
  through Supervisor review first (`AGENTS.md` §2).
