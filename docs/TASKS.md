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

状态：**M1 已收口（CLOSED）。** 已合入 `main`，merge commit `1fa2abe`。

| M1 领域 | 状态 |
| --- | --- |
| 实现（A1 / A2 / A3） | **已完成** |
| 浏览器 / Chaos 门禁（A6） | **已完成** —— 真实 Chromium 27/27，无 shim、无 pin |
| P0 稳定化（A1 / A2 + 集成） | **已完成** —— 基线 `9be0e1a`；C1 经 `f2dfe1a` 集成 |
| 最终复核（A7） | **已完成** —— Final Closing Review = **APPROVE**；C1 = CLOSED、C2 = CLOSED、无 merge blocker；原文见 `docs/agent-governance/A7-m1-p0-review.md` |
| 合入 `main` | **已完成** —— `--no-ff` merge commit `1fa2abe`（父：`47e96e3` + `652b66f`） |
| M1 里程碑 | **CLOSED** |
| M2 | **未开始** |

合并后在 `main` 的最终 HEAD 上重新验证（未引用分支历史结果）：`pnpm typecheck` exit 0、
`pnpm test` exit 0（251 + 58）、`pnpm build` exit 0、`node tests/browser/run.mjs` **27/27**。

两项被接受的风险随本里程碑进入 M2，**并未**被 M1 关闭（`docs/DECISIONS.md` D-039 §3/§4）：presence 的**写**路径不在冻结 seam 内；注入环境的 IndexedDB 工厂没有引用计数。

> **服务端持久化是 M2 backlog，不是 M1 未完成项。** 它是 `M2-P0-1`，在 M1 收口时明确保留为已知限制。
> **发布限制：** 服务端房间一经释放（最后一个成员离开即销毁），新客户端不能依赖服务器恢复历史正文；现阶段唯一持久副本是各客户端的 IndexedDB，用户若丢失全部本地副本，内容无法恢复。

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
| M1-A1 | Yjs 文档 + 离线持久化 + 重连合并 + awareness + undo | A1 | **done** —— P0-1 见 `85a1b7c`，经 `caa5376` 集成 |
| M1-A2 | CodeMirror ⇄ `Y.Text` 绑定 + 编辑器 UI + 协作者 UI | A2 | **done** —— P0-2 `0b79a93`、P0-3 `a679856`、选区 `270cf5e`，经 `0d04161` 集成 |
| M1-A3 | 文档房间、同步中继、presence、连接生命周期 | A3 | **done** —— 经 `47e96e3` 集成；服务端 58 测试通过 |
| M1-A6 | Chaos 测试：重连、重复帧、乱序、幽灵 awareness | A6 | **done** —— 真实浏览器 + chaos 门禁见 `f031063`；发现 P0-1/2/3 |
| M1-P0 | A6 发现缺陷的稳定化（A1、A2）与集成 | A1 / A2 / A0 | **done** —— 基线 `9be0e1a`；见下一节 |
| M1-A7 | 集成门禁：typecheck、测试、构建、wire 格式复核 | A7 | **done** —— Final Closing Review = **APPROVE**；C1、C2 均 CLOSED，无 merge blocker；原文见 `docs/agent-governance/A7-m1-p0-review.md` |
| M1-MERGE | 将 M1 合入 `main` | A0 | **done** —— `--no-ff` merge commit `1fa2abe`（父：`47e96e3` + `652b66f`）；拓扑与 A1/A2/C1 提交历史完整保留 |
| M1-C1 | A7 条件 C1：让 fatal 重连 pin 可被观测 | A1 | **done** —— `dd36169`（基于 `85a1b7c`），经 `f2dfe1a` 集成。**mutation validation 已由 A1 完成**：删除 `active=false`、删除 `active=false`+`closeSocket()`、删除正常自动重连，三组变异均使对应断言 **FAIL**；变异后生产文件已恢复并核对 hash。A0 在最终 merge 阶段未重复执行该实验；A7 Final Closing Review 已独立复核代码敏感性与零残留状态，**C1 = CLOSED，无剩余证据缺口**（详见 `docs/DECISIONS.md` D-039 §6） |
| M1-C2 | A7 条件 C2：决策记录 + 修掉 `defect-pins.mjs` 悬空引用 | A0 | **done** —— `a06b6ff`（D-039、引用修复） |

### M1 退出条件 —— 逐项状态

| 退出条件 | 是否满足 | 证据 |
| --- | --- | --- |
| 两个浏览器会话收敛 | **是** | `realtime/two-tabs-converge`、`indexeddb/D-two-tabs-share-one-replica`、`indexeddb/C-offline-then-reconnect-converges` |
| 离线不丢键击 | **实质满足** | 真实拒绝连接后重连：`indexeddb/B-offline-edits-survive-reopen`、`chaos/offline-reconnect`。条件字面的 **30 s** **未**用专门计时器断言——场景演练真实断网，但时长未固定 |
| 重连传增量而非整篇文档 | **是** | 服务端 `M1-A3 incremental sync (acceptance criterion 4)`；传输受 state vector 约束 |
| `typecheck` / 测试 / 构建 全绿 | **是** | 在 `f8af8d7`：`pnpm typecheck` exit 0、`pnpm test` exit 0（251 vitest + 58 服务端）、`pnpm build` exit 0 |
| 上述项的浏览器证据 | **是——但仅一种浏览器** | `node tests/browser/run.mjs` → **27 通过 / 0 失败 / 0 错误**。Chrome 155 / Windows / 单机；跨浏览器与跨平台**未验证** |

### M1-P0 —— 稳定化 ✅ 已完成

A6 的真实浏览器门禁发现了三个 Node 套件观测不到的缺陷。A1 与 A2 在各自分支修复，A0 集成两者并让门禁变得可信。决策与审计链见 `docs/DECISIONS.md` D-039。

| ID | 任务 | Owner | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M1-P0-1 | 给只读的 `globalThis.indexedDB` 赋值（浏览器中它是 getter-only）→ 任何文档都打不开 | A1 | **已完成** | `85a1b7c`；`defect-pin/P0-1` 在 pin 删除前已于**未修改**路径通过 |
| M1-P0-2 | 本地编辑只在累计 64 次变更时 flush → 击键从未进入 `Y.Text`（不持久、不共享、undo 失效） | A2 | **已完成** | `0b79a93`；九个 pinned 场景转绿；编辑器长度 == `Y.Text` 长度 |
| M1-P0-3 | `ViewPlugin` 在自己的构造函数里 dispatch → 插件挂载即崩，远端光标从不渲染 | A2 | **已完成** | `a679856`；`cursors/remote-caret-and-selection-render` 通过 |
| M1-P0-4 | 两条 harness 断言在产品**正确**时失败（绝对 `editorMounts === 1`；切进一个有协作者的房间后仍要求 0 光标） | A0 —— A6 域，受委派 | **已完成** | `19587fc`；`mounts 2→2`、`viewId 1→1`，光标归属新房协作者 |
| M1-P0-5 | `sync.test.ts` 的 fatal 断言比较的是**存活** socket 数 → 抖动，且两次读数都为 0 时变成空断言 | A0 —— A1 域，ownership 例外 | **已完成，随后被 C1 取代** | `9be0e1a` 修正了计数语义；A7 随后指出**窗口**仍太短（120 ms vs 1000 ms 退避），`f2dfe1a` 用 C1 重写了整个用例；重复计数器已收敛为 A1 单一的单调 `totalConnections` |
| M1-P0-6 | P0 pin、P0-1 shim 与"缺陷仍存在"的过期注释退场 | A0 —— A6 域，受委派 | **已完成** | `19587fc`、`fc542f8`；27 个场景，无 shim、无 `knownDefect` 标签 |
| M1-P0-7 | **服务端持久化** —— M1 没有 | — | **未完成 → `M2-P0-1`** | 房间随最后一个成员销毁；**全新**客户端无法恢复既有内容。已知 limitation，非合并阻塞 |
| M1-P0-8 | presence 写侧 seam 缺失；注入的 IndexedDB 工厂无引用计数 | — | **已接受风险 → `M2-P0-2` / `M2-P0-3`** | `docs/DECISIONS.md` D-039 §3 / §4；两项均已记录，**均未修复** |
| M1-P0-9 | A7 复核报告原先不在仓库 | A0 | **已闭合** | `docs/agent-governance/A7-m1-p0-review.md`（逐字原文）；D-039 §5 已改为指向它 |

> 以上浏览器结论**仅描述 M1 的协作面**。它们与 M2 权限、M3 AI、M4 硬化无关，不得当作那些里程碑的证据引用。

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

## M2 — Durable persistence & the two M1 gaps (KICKOFF: architecture FROZEN, implementation NOT started)

状态：**`FROZEN (design)` / `NOT IMPLEMENTED`。** 架构、契约、ownership 与验收面已冻结；
没有任何 M2 生产代码。基线：从 immutable tag `m1-closed`（`f3c353e`）分出的
决策：`docs/DECISIONS.md` **D-040…D-052**。

### M2 范围

| ID | 内容 | 本轮状态 | 代码状态 |
| --- | --- | --- | --- |
| `M2-P0-1` | 服务端 durable persistence | **FROZEN** | NOT IMPLEMENTED |
| `M2-P0-2` | presence 写侧 seam | **步骤 1 IMPLEMENTED**（seam + `SHARED_CONTRACT_VERSION` 3） | 编辑器迁移（A2）与收窄裸 `Awareness` 待做 |
| `M2-P0-3` | 注入式 IndexedDB 工厂生命周期 | **FROZEN** | NOT IMPLEMENTED |

**不在 M2 范围**：AI 编辑器（M3）、UI 重设计、wire framing 变更。

> **范围位移，需要项目负责人确认。** `docs/PROJECT.md` 里 M2 的原蓝图是"Permissions & state
> （认证 / RBAC / 请求取消 / 竞态）"，而现在 M2 被定义为三项 P0 收口。两者不能同时是 M2。
> 本冻结按当前指令执行（M2 = 三项 P0），权限/认证**尚未排入任何里程碑**。
> 选项见报告「Need Project Owner Decision」第 1 条。

### M2-P0 Exit Gate vs M2 Milestone

**这两个不是同一个东西**（`docs/DECISIONS.md` D-047 决定 1）。

**M2-P0 Exit Gate（本 Gate 的判据）**

1. `M2-P0-1` 验收场景 **A–K** 全部通过；B/C 必须包含**真实进程重启**，H/I/J/K 必须包含并发
   与状态机验证（见下）。
2. `M2-P0-2` 已实现：A2 不再生成 `updatedAt`，写入前有 schema 校验。
3. `M2-P0-3` 已实现：D-046 的 **5 个回归测试**存在并通过。
4. A6 的 restart / persistence / corruption / chaos 浏览器门禁全绿。
5. A7 的 **P0 review** APPROVE，无 merge blocker。
6. `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿，浏览器套件在**合并后的最终 HEAD** 上重跑全绿。

**通过 Gate ≠ M2 关闭。** 顺序冻结为：

```text
M2-P0（本 Gate）
  → M2 Phase 2 / P1：permission & authentication consistency
  → M2 final gate
  → M3 AI（不得先于权限上下文）
```

**M2 Milestone 关闭条件（在本 Gate 之外）**：Phase 2 的权限/认证一致性完成并通过 A7 的
final gate。**在 permission/auth 尚未处理时，M2 不得标 CLOSED。**

### M2 Phase 2 / P1 — permission & authentication consistency（NOT STARTED）

| 项 | 内容 |
| --- | --- |
| 目的 | 服务端权威的文档级权限与认证一致性；客户端只做 UI 门控 |
| 触发条件 | M2-P0 Exit Gate 通过之后 |
| Owner（预计） | A5（权限/认证）+ A3（服务端权威判定点） |
| 状态 | **NOT STARTED**；本次冻结只锁定顺序，不确定其契约 |

**Backlog（不属于任何 Gate）**：**无编辑 join 仍 append 2 字节空 update**（D-055 §3，无内容影响）、
**idle/background compaction**（M2-P0 只做 eviction-time，D-054）、
键击通知扇出优化（D-039 L2）、主 bundle 分块、
`void persistence.destroy()` 的未处理拒绝（D-039 L5）、跨浏览器（Firefox/Safari）验证、
真实多机弱网浸泡。

### M2-P0-1 — 服务端 durable persistence

| 项 | 内容 |
| --- | --- |
| Owner | **A3** |
| Branch / Worktree | `agent/a3-m2-persistence` / `Insighthub-wt-a3-m2` |
| Owned Files | `apps/server/src/persistence/**`（新建，含 store + hydrator + 测试）<br>`apps/server/src/rooms/room.ts`（仅 update 路径与 unhealthy 状态）<br>`apps/server/src/rooms/registry.ts`（hydration barrier、eviction 语义）<br>`apps/server/src/ws.ts`（`room-joined` 推迟到屏障之后）<br>`apps/server/src/config.ts`（`INSIGHTHUB_DATA_PATH`）<br>`apps/server/src/index.ts`（shutdown 时 `store.close()`）<br>`apps/server/src/rooms/test-harness.ts`（每测试独立临时库） |
| Do Not Touch | `packages/shared/**`、`apps/web/**`、`tests/browser/**`、任何 `package.json`（本轮不新增依赖）、`docs/CONTRACTS.md` |
| Dependencies | 无外部依赖：设计已冻结（ARCHITECTURE §7、CONTRACTS §14、D-041…D-044） |
| 必须遵守 | 每文档**单一 FIFO pipeline** 且失败即停（D-048）；`apply → persist → broadcast`（D-044）；房间状态机（D-049）；hydration 溢出用 `INTERNAL_ERROR` 而非 `FRAME_TOO_LARGE`（D-050）；启动 capability-check（D-051）；append/sequence 原子（D-052）；hydration barrier 不改 wire（D-043）；Markdown 不得成为服务端权威（D-042） |
| Acceptance | 见下 **A–K**，全部需要真实执行 |

**M2-P0-1 验收场景（冻结）**

| # | 场景 | 判据 |
| --- | --- | --- |
| A | 房间清空后恢复 | tab A 写文本 → A 离开 → 房间被驱逐 → **全新** tab B 打开 → 内容仍在 |
| B | 进程重启恢复 | 写文本 → **终止 server 进程** → 启动新进程 → 新浏览器打开同一文档 → 内容完整 |
| C | 离线客户端 + 重启 | 客户端离线编辑 → 服务端重启 → 客户端重连 → state-vector 对账 → 双方收敛 → 再开**全新**客户端 → 看到完整内容 |
| D | 重复 update 重放 | 同一 update 重复进入持久化路径 → 重启 → 状态不重复、不损坏 |
| E | 压缩 | 超过阈值产生日志 → compaction（**eviction-time**）→ 重启 → 文档与压缩前一致（渲染文本 + `Y.Doc` 双断言） |
| F | 持久化失败 | 模拟写入失败 → 不得向其它 peer 宣称成功的状态 → 行为符合 D-044（error + 断开 + 房间移除） |
| G | 文档隔离 | doc A 与 doc B 的持久状态完全隔离，互不可见、互不覆盖 |
| H | 并发上送 | 两个 peer 几乎同时提交 update → durable append 顺序明确 → broadcast 只发生在各自 commit 之后 → 重启后完全收敛 |
| I | 失败停止 pipeline | 强制第 N 次 append 失败 → N **不广播** → N+1 排队 mutation **不得继续成功** → room unhealthy/destroyed → 重启后 durable 只含 N 之前已提交数据 → 原作者重连后能补齐 |
| J | hydration single-flight | 多个客户端同时 join 同一 cold document → `store.load` **只发生一次** → 所有人看到同一 hydrated `Y.Doc` → 不得出现两个竞争的 room document |
| K | hydration backlog 溢出 | 故意阻塞 hydrate → 制造有界队列溢出 → 收 `INTERNAL_ERROR` + 关闭 → **不得误报 `FRAME_TOO_LARGE`** → server 不崩溃 |

**运行时前置条件（D-051）**：server 需要 Node 运行时提供被验证过的 `node:sqlite` API
（本轮实测于 Node **v22.14.0**，无需 flag，仅一条 experimental 警告）；启动时做 capability
check，不满足则**启动失败**并给出清晰诊断，**禁止** memory-only fallback，**不新增**第三方
SQLite 依赖。

### M2-P0-2 — presence 写侧 seam

| 项 | 内容 |
| --- | --- |
| Owner | **A1**（seam 实现）→ **A2**（编辑器迁移） |
| Branch / Worktree | A1: `agent/a1-m2-presence` / `Insighthub-wt-a1-m2-presence`<br>A2: `agent/a2-m2-presence-ui` / `Insighthub-wt-a2-m2-presence`（**在 A1 分支集成之后**再分叉） |
| A1 Owned Files | `packages/shared/src/collab-session.ts`（**仅 A0 预批准的那一处附加**）、`apps/web/src/collab/internal/{document-session,awareness,public}.ts`、`apps/web/src/collab/tests/**` |
| A2 Owned Files | `apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx`、`apps/web/src/features/editor/**/*.test.ts` |
| Do Not Touch（双方） | `apps/server/**`、`tests/browser/**`、wire framing、错误码词表 |
| Dependencies | A2 依赖 A1 的 seam 先合入；A1 依赖 A0 对 `SHARED_CONTRACT_VERSION` 2→3 的批准 |
| Acceptance | A2 不再写 `updatedAt`；非法 patch 在写入前抛错；裸 `Awareness` 不再有生产写入点；版本号提升并记录；`pnpm typecheck/test/build` 全绿 |

### M2-P0-3 — 注入式 IndexedDB 工厂生命周期

| 项 | 内容 |
| --- | --- |
| Owner | **A1** |
| Branch / Worktree | `agent/a1-m2-idb-lifecycle` / `Insighthub-wt-a1-m2-idb` |
| Owned Files | `apps/web/src/collab/internal/persistence.ts`、`apps/web/src/collab/tests/persistence.test.ts`、`apps/web/src/collab/tests/public-seam.test.ts` |
| Do Not Touch | `packages/shared/**`、`apps/server/**`、`apps/web/src/features/**`、`tests/browser/**` |
| Dependencies | 无（与 M2-P0-2 可并行，但两者都改 `collab/`，集成顺序由 A0 决定） |
| Acceptance | D-046 的 5 个回归测试存在且通过；生产路径（未注入）全局零写入、getter 身份不变 |

### 其他 Agent

| Agent | M2 角色 | 说明 |
| --- | --- | --- |
| **A6** | restart / persistence / corruption / chaos 浏览器门禁 | Owned：`tests/browser/**`。需要能**真实重启 server 进程**、构造损坏库、注入写失败；M2-P0-1 的 A–G 必须在真实浏览器层再验一遍 |
| **A7** | 最终架构 + 发布终审 | 只读；按 **M2-P0 Exit Gate**（D-047 的 Gate/Milestone 分层）逐项判定；独立于 A0 |
| **A5** | **本轮不分配** | 文档隔离（场景 G）是存储层职责（A3 实现 + A6 验证）；M2 不新增 HTTP 端点，授权面未变。若 M2 后续开放文档删除 API，再引入 A5 审授权 |
| **A4** | **idle** | M3 才启动 |

### Branch / worktree plan

```text
m1-closed (tag, f3c353e, immutable)
  └ m2-stabilization            ← 本 worktree：Insighthub-wt-m2
      └ [Architecture Freeze commit]  ← 只有文档
          ├ agent/a3-m2-persistence   → Insighthub-wt-a3-m2
          ├ agent/a1-m2-idb-lifecycle → Insighthub-wt-a1-m2-idb
          ├ agent/a1-m2-presence      → Insighthub-wt-a1-m2-presence
          │    └ (集成后) agent/a2-m2-presence-ui → Insighthub-wt-a2-m2-presence
          └ agent/a6-m2-chaos         → Insighthub-wt-a6-m2
```

规则：

1. **所有 Agent worktree 都从 Architecture Freeze commit 分叉**，不从 `main`、不从 tag 直接分叉。
2. `m2-stabilization` 只由 A0 写入（集成 + 文档），Agent 一律在自己的 worktree 里改。
3. **presence seam 的顺序是硬约束**：A1 先合入 seam，A2 再从新的 `m2-stabilization` 分叉；
   否则 A2 会基于一个不存在的 API 编码。
4. `m1-closed` tag 保持不动；M2 不动 `main`。

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
