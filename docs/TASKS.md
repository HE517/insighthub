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

## M1-A0 — Contract Freeze ✅ done

| ID | Task | Owner | Status |
| --- | --- | --- | --- |
| M1-A0-1 | Binary data-plane framing + codec (SYNC / AWARENESS) | A0 | done |
| M1-A0-2 | Frozen error-code vocabulary | A0 | done |
| M1-A0-3 | Control-plane updates: `join-room` v2 + mode, `room-joined.connectionId`, typed error payload | A0 | done |
| M1-A0-4 | `PROTOCOL_VERSION` 1 → 2, `SHARED_CONTRACT_VERSION` 1 → 2 | A0 | done |
| M1-A0-5 | Awareness state contract + cleanup rules | A0 | done |
| M1-A0-6 | A1 ↔ A2 `CollaborativeSession` seam + `collab/public.ts` placeholder | A0 | done |
| M1-A0-7 | A1 ↔ A3 wire + lifecycle semantics documented | A0 | done |
| M1-A0-8 | Dependencies approved and installed (`yjs`, `y-protocols`, `lib0`, `y-indexeddb`) | A0 | done |
| M1-A0-9 | Codec + contract unit tests, docs updated | A0 | done |

### M1-A0 validation

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | 3/3 packages `Done` |
| Unit tests | `pnpm test:unit` | 63 passed (6 files) |
| Server integration | `pnpm test:server` | 5 passed |
| Build | `pnpm build` | shared + server `tsc`, web `vite build` |
| Runtime | `pnpm --filter @insighthub/server verify:m0` | 7/7 checks |

Codec test coverage (required by the task brief): valid control message, invalid
control message, valid binary frame, unknown binary frame (unknown frame type,
unknown inner sync type, and the `y-websocket` auth/query-awareness types),
malformed binary frame (truncation at every length, trailing bytes, bad length
prefix, non-JSON awareness state, bare awareness update without a header), and
oversize frame (default limit, exact limit boundary, caller-supplied limit).

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

## M1 — Collaboration core

Status: **contract frozen (M1-A0 done)**; A1 / A2 / A3 not started.

### M1-A0.1 — Pre-Parallel Cleanup ✅ done

| ID | Task | Owner | Status |
| --- | --- | --- | --- |
| M1-A0.1-1 | Freeze room cardinality: one socket = one room, atomic replace on re-join | A0 | done |
| M1-A0.1-2 | Delete the duplicate presence channel (TEXT `presence` removed) | A0 | done |
| M1-A0.1-3 | Remove `RoomJoinedPayload.revision` (room counter, no M1 consumer) | A0 | done |
| M1-A0.1-4 | Add `yjs` + `y-protocols` to `apps/server` | A0 | done |
| M1-A0.1-5 | Restate sync handshake as a deliberate M1 choice (client-initiated) | A0 | done |
| M1-A0.1-6 | Awareness consumption boundary (`getCollaborators()` only for UI) | A0 | done |
| M1-A0.1-7 | Regression tests + full validation | A0 | done |

### M1-A0.1 validation

| Check | Command | Result |
| --- | --- | --- |
| Install | `pnpm install` | lockfile up to date |
| Typecheck | `pnpm typecheck` | 3/3 packages `Done` |
| Unit tests | `pnpm test:unit` | 67 passed (6 files) |
| Server integration | `pnpm test:server` | 9 passed |
| Build | `pnpm build` | shared + server `tsc`, web `vite build` |
| Runtime | `pnpm --filter @insighthub/server verify:m0` | 7/7 checks |

Also implemented in this pass (the doc claimed it, the code did not do it): the
server now distinguishes `UNKNOWN_MESSAGE_TYPE` from `INVALID_MESSAGE`, so the
deleted `presence` message fails with the accurate code. Covered by four
integration tests (legacy `presence`, malformed JSON, known type with bad payload,
JSON with no `type`). A3 inherits this classification for its room routing.

### The contract is frozen — do not renegotiate it in code

M1-A0/M1-A0.1 froze everything the three parallel tasks touch. Work from these, not
from memory:

| Frozen artefact | Where |
| --- | --- |
| Binary frame framing, limits, malformed behaviour | `packages/shared/src/binary-frame.ts`, `docs/CONTRACTS.md` §6 |
| Control-plane messages (`join-room`, `room-joined`, `leave-room`) — **no `presence`** | `packages/shared/src/protocol.ts`, `docs/CONTRACTS.md` §5 |
| Room cardinality (one socket = one room, atomic replace) | `docs/CONTRACTS.md` §5.4, `protocol.ts` `ROOM_CARDINALITY` |
| Error code vocabulary (9 codes) | `packages/shared/src/errors.ts`, `docs/CONTRACTS.md` §7 |
| A1 ↔ A2 session interface | `packages/shared/src/collab-session.ts`, `docs/CONTRACTS.md` §8 |
| A1 ↔ A3 wire semantics + lifecycle | `docs/CONTRACTS.md` §6, §10 |
| Awareness contract, cleanup rules, **consumption boundary** | `awareness-state.ts`, `docs/CONTRACTS.md` §9, §9.1, §9.2 |
| Source-of-truth rule | `docs/ARCHITECTURE.md` §0 |

If a task needs something here changed: **stop and request Supervisor approval**
(`AGENTS.md` §2). A silent local change to a frozen seam breaks the other two
agents.

### Entry / exit criteria

- **Entry:** M0 green; M1-A0 contract frozen and committed.
- **Exit:** two browser sessions converge; 30 s offline loses no keystroke;
  reconnect transfers a delta rather than the document; typecheck, tests and build
  green.

| ID | Task | Owner | Status |
| --- | --- | --- | --- |
| M1-A0 | Contract freeze: binary framing, error codes, session seam, wire semantics | A0 | **done** |
| M1-A1 | Yjs document + offline persistence + reconnect merge + awareness + undo | A1 | todo |
| M1-A2 | CodeMirror ⇄ `Y.Text` binding + editor UI + collaborator UI | A2 | **review** |
| M1-A3 | Document rooms, sync relay, presence, connection lifecycle | A3 | **review** |
| M1-A6 | Chaos tests: reconnect, duplicate frames, out-of-order, ghost awareness | A6 | todo |
| M1-A7 | Integration gate: typecheck, tests, build, wire-format review | A7 | todo |

### M1-A2 implementation notes (A2)

Design decisions that matter for review:

| Concern | Decision |
| --- | --- |
| Truth | `Y.Text` only. No document content in React state or Redux; the editor reads content solely from the session. |
| Binding | One `CollabTextBinding` per session, created before the view and destroyed with it, so a collaborator or connection update cannot remount the editor or duplicate the observer. |
| Echo suppression | Three independent mechanisms: transaction-origin check, re-entrancy guard, and a derived-change marker (`REMOTE_SYNC_ORIGIN`) that stops an undo or a remote update from being re-recorded as a local edit. |
| Remote application | `Y.TextEvent.delta` is deliberately **not** translated by hand; the authoritative content is diffed against the editor and the minimal single-range change is applied (one editor transaction per update). |
| Undo | No CodeMirror `history()`; `Mod-z` routes to `session.undo()` so undo stays CRDT-scoped by origin. |
| Presence | Cursor offsets come from awareness; every rendered string comes from `session.getCollaborators()`. |
| Document switch | The editor remounts per session and the old binding is destroyed before the next session exists. |

Evidence: `pnpm test:unit` 169 passed (14 files), `pnpm test:server` 61 passed,
A2-scope `tsc --noEmit` clean, `vite build` built. A browser/E2E pass is still
required for the assertions that need a DOM; they are listed as the A6 hand-off in
the M1-A2 completion report.

---

### M1-A1 — Collaboration core (A1)

- **Goal:** a `Y.Doc`-backed session that survives disconnect and refresh, merges
  on reconnect, and whose undo never touches a remote edit.
- **Scope:** `Y.Doc`/`Y.Text` lifecycle per document, `y-indexeddb` persistence,
  offline update queueing, state-vector reconnect merge, binary sync over the
  frozen codec, awareness publish/ingest + cleanup, `Y.UndoManager` with
  `trackedOrigins: UNDO_TRACKED_ORIGINS`, and the `CollaborativeSession`
  implementation behind `collab/public.ts`.
- **Owned Files:**
  - `apps/web/src/collab/**` (new; `internal/**` is private to A1)
  - `apps/web/src/collab/public.ts` (implement the two frozen functions)
  - `apps/web/src/collab/*.test.ts`
- **Do Not Touch:** `packages/shared/**`, `apps/web/src/features/**`,
  `apps/web/src/App.tsx`, `apps/web/src/store/**`,
  `apps/web/src/hooks/useRealtimeChannel.ts`, `apps/server/**`, any `package.json`.
- **Dependencies:** M1-A0 frozen. Deps are **already installed** by A0
  (`yjs`, `y-protocols`, `lib0`, `y-indexeddb` in `apps/web`) — request additions
  through A0, do not self-serve `package.json` edits.
- **Acceptance Criteria:**
  1. Edit → refresh → content persists with the backend stopped.
  2. 30 s with the socket severed loses no keystroke; reconnect converges.
  3. `encodeStateAsUpdate` after two divergent clients is byte-identical.
  4. Undo after a remote insert does not remove the remote text.
  5. Awareness entry is removed and broadcast on `destroy()`; peers show no ghost.
  6. `session.state` becomes `active` with the socket down (network never gates).
  7. Unit tests cover offline queue flush, duplicate-update idempotency, and the
     `active`-before-network ordering.
  8. `pnpm typecheck && pnpm test` pass.

### M1-A2 — Editor integration (A2)

- **Goal:** CodeMirror 6 edits the CRDT document, with collaborator presence
  rendered, without re-render storms and without owning a copy of the text.
- **Scope:** bind the editor to `session.text`, remote cursors/selection from
  `session.getCollaborators()`, connection/offline affordances, editor performance.
- **Owned Files:**
  - `apps/web/src/features/editor/**`
  - `apps/web/src/features/status/**`
  - `apps/web/src/features/collaborators/**` (new)
  - `apps/web/src/App.tsx`, `apps/web/src/styles.css`
- **Do Not Touch:** `apps/web/src/collab/**` (A1's — import `public.ts` only),
  `packages/shared/**`, `apps/server/**`,
  `apps/web/src/hooks/useRealtimeChannel.ts` (A3's transport seam).
- **Dependencies:** the frozen `CollaborativeSession` interface. **A2 is NOT
  blocked on A1's implementation:** develop against a local in-memory test double
  typed as `CollaborativeSession` and swap to the real `useCollaborativeDocument`
  when A1 lands it. The names and signatures are already frozen.
- **Acceptance Criteria:**
  1. Two browsers show each other's edits live.
  2. Remote cursors render with a distinct, per-user colour.
  3. Typing latency stays flat on a 5 000-line document (no full remount per
     keystroke).
  4. **No** `dispatch` of document content: the editor reads text from
     `session.text`; Redux holds only `activeDocumentId`, metadata, permission,
     connection status, collaborator metadata and UI state.
  5. Offline state is visible and editing stays enabled while offline.
  6. `pnpm build` passes.

### M1-A3 — Realtime backend (A3)

- **Goal:** the server relays Yjs updates per document room with a correct
  connection lifecycle and no cross-room leakage.
- **Scope:** room registry keyed by `documentId`; `join-room`/`leave-room` routing
  with **atomic replace** on re-join (§5.4); per-room `Y.Doc`;
  `SyncStep1`→`SyncStep2`+`SyncStep1` handling via the frozen codec; awareness
  fan-out and departure cleanup; heartbeat + dead-socket termination; slow-socket
  backpressure; typed errors from the frozen vocabulary.
- **Owned Files:**
  - `apps/server/src/rooms/**` (new)
  - `apps/server/src/ws.ts`
  - `apps/server/src/rooms/*.test.ts`, `apps/server/src/ws.rooms.test.ts` (new)
- **Do Not Touch:** `packages/shared/**`, `apps/server/src/{app,config,index}.ts`,
  `apps/web/**`, any `package.json`.
- **Dependencies:** M1-A0 frozen. `yjs` + `y-protocols` are **already installed** in
  `apps/server` by M1-A0.1 — do not edit `package.json`.
- **Acceptance Criteria:**
  1. Two sockets in one room converge after concurrent edits.
  2. Sockets in different rooms never receive each other's updates.
  3. A socket that dies without a close frame is reaped within the heartbeat
     window and its peers see its **awareness entry removed**, not a presence
     message (there is none).
  4. Reconnect sends only the missing delta, not the full document (assert byte
     size shrinks).
  5. Malformed / oversized binary frames produce `INVALID_BINARY_FRAME` /
     `FRAME_TOO_LARGE` and close the socket; a binary frame before `join-room`
     produces `ROOM_NOT_JOINED` **without** closing.
  6. A peer joining with the wrong `protocolVersion` gets
     `PROTOCOL_VERSION_MISMATCH`.
  7. `join-room(B)` while in A performs an atomic replace: A's awareness entry is
     removed and broadcast, B is joined, and no state exists where the socket is in
     both or neither. `leave-room(B)` while in A is a no-op.
  8. Integration tests in `node:test` on ephemeral ports.

### Serialization points

- A1's `useDocument`-style factory and A3's wire handling **must both use the
  shared codec**; neither may parse frames by hand. A7 reviews this.
- If any agent believes a frozen contract is wrong, that is a Supervisor decision,
  not a local edit.

---

### M1-A3 implementation notes (A3)

Files: `apps/server/src/rooms/**` (new), `apps/server/src/ws.ts`. Constants, decisions
and the contract note live in `docs/DECISIONS.md` D-024–D-026.

**Module map** — `constants.ts` (operational tuning) · `peer.ts` (the single outbound
write path, and therefore the single backpressure enforcement point) · `context.ts`
(per-connection state holding at most one `activeRoom`) · `room.ts` (one document's
`Y.Doc`, sync and awareness fan-out) · `registry.ts` (membership, `join-room` /
`leave-room`, atomic replace, teardown) · `heartbeat.ts` (liveness sweep) · `varint.ts`
(the two sync-body reads; see the contract note below).

**Why the replace is genuinely atomic.** `RoomRegistry.joinRoom` is fully synchronous,
so JavaScript runs it to completion before any other socket event can be handled: there
is no `await` between "leave A" and "join B", and every refusal is decided *before* the
first mutation. Combined with `SocketContext.activeRoom` being a single field, there is
no representable state in which a socket holds two rooms or neither while the server has
already replied. One transition function (`#detach`) serves leave, disconnect and
replace, so the awareness cleanup cannot be forgotten in one of the three paths.

**Frozen behaviour implemented as specified.** The client-initiated handshake
(`SyncStep1` → `SyncStep2` + `SyncStep1` → `SyncStep2`); inbound updates relayed to
peers but never echoed to the sender; departure presence expressed only as a Yjs
awareness removal (no control-plane presence message exists); `ROOM_NOT_JOINED` non-fatal
for a frame before `join-room`; `INVALID_BINARY_FRAME` / `FRAME_TOO_LARGE` fatal;
`leave-room(B)` while in A a no-op.

**Two things A7/A0 should look at:**

1. **`PROTOCOL_VERSION_MISMATCH` is unreachable through the wire.** In
   `joinRoomPayloadSchema`, `protocolVersion` is `z.literal(PROTOCOL_VERSION)`, so the
   shared parser rejects a mismatched version first and the server answers
   `INVALID_MESSAGE` (or `UNKNOWN_MESSAGE_TYPE`) instead of the dedicated code. The
   registry still checks the version defensively. Recorded under `Contract Issues` in the
   M1-A3 report; it needs an A0 decision, not a local edit.
2. **`apps/server` cannot import `lib0`.** pnpm's strict linking exposes it only to the
   packages that declare it (`packages/shared`, `y-protocols`), and A3 may not edit
   `package.json`. `rooms/varint.ts` therefore implements the two varint reads the sync
   handshake needs, with `rooms/varint.test.ts` proving they agree with the encoders
   `y-protocols`/`yjs` actually produce. Adding `lib0` to `apps/server` would let that
   file be deleted.

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
