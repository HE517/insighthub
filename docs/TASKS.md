# TASKS.md

Milestone plan and task ownership. Owner roles are defined in `AGENTS.md` §3.
Status legend: `todo` · `doing` · `review` · `done` · `blocked`.

---

## M0 — Bootstrap ✅ done

| ID   | Task                                                    | Owner | Status |
| ---- | ------------------------------------------------------- | ----- | ------ |
| M0-1 | pnpm workspace skeleton (`apps/*`, `packages/*`)        | A0    | done   |
| M0-2 | Shared contracts + Zod schemas + WS protocol            | A0    | done   |
| M0-3 | Express server: `GET /health`, `GET /api/meta`          | A0    | done   |
| M0-4 | WebSocket server on `/ws` sending `connected`           | A0    | done   |
| M0-5 | React shell + Redux + Ant Design + CodeMirror mount     | A0    | done   |
| M0-6 | Client channel hook: validate frames, reconnect backoff | A0    | done   |
| M0-7 | Tests: shared contract + server integration             | A0    | done   |
| M0-8 | Docs + `AGENTS.md` working agreement                    | A0    | done   |

## M1-A0 — Contract Freeze ✅ done

| ID      | Task                                                                                          | Owner | Status |
| ------- | --------------------------------------------------------------------------------------------- | ----- | ------ |
| M1-A0-1 | Binary data-plane framing + codec (SYNC / AWARENESS)                                          | A0    | done   |
| M1-A0-2 | Frozen error-code vocabulary                                                                  | A0    | done   |
| M1-A0-3 | Control-plane updates: `join-room` v2 + mode, `room-joined.connectionId`, typed error payload | A0    | done   |
| M1-A0-4 | `PROTOCOL_VERSION` 1 → 2, `SHARED_CONTRACT_VERSION` 1 → 2                                     | A0    | done   |
| M1-A0-5 | Awareness state contract + cleanup rules                                                      | A0    | done   |
| M1-A0-6 | A1 ↔ A2 `CollaborativeSession` seam + `collab/public.ts` placeholder                          | A0    | done   |
| M1-A0-7 | A1 ↔ A3 wire + lifecycle semantics documented                                                 | A0    | done   |
| M1-A0-8 | Dependencies approved and installed (`yjs`, `y-protocols`, `lib0`, `y-indexeddb`)             | A0    | done   |
| M1-A0-9 | Codec + contract unit tests, docs updated                                                     | A0    | done   |

### M1-A0 validation

| Check              | Command                                      | Result                                  |
| ------------------ | -------------------------------------------- | --------------------------------------- |
| Typecheck          | `pnpm typecheck`                             | 3/3 packages `Done`                     |
| Unit tests         | `pnpm test:unit`                             | 63 passed (6 files)                     |
| Server integration | `pnpm test:server`                           | 5 passed                                |
| Build              | `pnpm build`                                 | shared + server `tsc`, web `vite build` |
| Runtime            | `pnpm --filter @insighthub/server verify:m0` | 7/7 checks                              |

Codec test coverage (required by the task brief): valid control message, invalid
control message, valid binary frame, unknown binary frame (unknown frame type,
unknown inner sync type, and the `y-websocket` auth/query-awareness types),
malformed binary frame (truncation at every length, trailing bytes, bad length
prefix, non-JSON awareness state, bare awareness update without a header), and
oversize frame (default limit, exact limit boundary, caller-supplied limit).

### M0 acceptance criteria and evidence

| #   | Criterion                             | How it was verified                                         | Result                                                                                                          |
| --- | ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm install` succeeds               | `pnpm install`                                              | `Done in 22.5s`, 283 packages                                                                                   |
| 2   | React frontend starts                 | `pnpm --filter @insighthub/web dev` (inside `verify:m0`)    | `VITE v7.3.7 ready in 367 ms`, serves app shell (200, 663 bytes)                                                |
| 3   | Express backend starts                | `pnpm --filter @insighthub/server dev` (inside `verify:m0`) | `http ready http://127.0.0.1:3101`, `ws ready .../ws`                                                           |
| 4   | `GET /health` returns 200             | `verify:m0`                                                 | `200 {"status":"ok"}`                                                                                           |
| 5   | Browser can connect to WebSocket      | `verify:m0`                                                 | upgrade accepted on `/ws`; non-`/ws` path rejected                                                              |
| 6   | Server sends `connected`              | `verify:m0`                                                 | `{"type":"connected","payload":{"connectionId":"687d...","protocolVersion":1,...}}` parsed by the shared parser |
| 7   | `shared` referenced by web and server | `workspace:*` deps + real imports in both apps              | resolves in `tsc` and in `vite build` (1494 modules)                                                            |
| 8   | `pnpm typecheck` succeeds             | `pnpm typecheck`                                            | 3/3 packages `Done`, no errors                                                                                  |
| 9   | `pnpm build` succeeds                 | `pnpm build`                                                | shared `tsc` + server `tsc` + web `vite build` → `built in 21.11s`                                              |

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

| M1 领域                     | 状态                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 实现（A1 / A2 / A3）        | **已完成**                                                                                                                                      |
| 浏览器 / Chaos 门禁（A6）   | **已完成** —— 真实 Chromium 27/27，无 shim、无 pin                                                                                              |
| P0 稳定化（A1 / A2 + 集成） | **已完成** —— 基线 `9be0e1a`；C1 经 `f2dfe1a` 集成                                                                                              |
| 最终复核（A7）              | **已完成** —— Final Closing Review = **APPROVE**；C1 = CLOSED、C2 = CLOSED、无 merge blocker；原文见 `docs/agent-governance/A7-m1-p0-review.md` |
| 合入 `main`                 | **已完成** —— `--no-ff` merge commit `1fa2abe`（父：`47e96e3` + `652b66f`）                                                                     |
| M1 里程碑                   | **CLOSED**                                                                                                                                      |
| M2                          | **未开始**                                                                                                                                      |

合并后在 `main` 的最终 HEAD 上重新验证（未引用分支历史结果）：`pnpm typecheck` exit 0、
`pnpm test` exit 0（251 + 58）、`pnpm build` exit 0、`node tests/browser/run.mjs` **27/27**。

两项被接受的风险随本里程碑进入 M2，**并未**被 M1 关闭（`docs/DECISIONS.md` D-039 §3/§4）：presence 的**写**路径不在冻结 seam 内；注入环境的 IndexedDB 工厂没有引用计数。

> **服务端持久化是 M2 backlog，不是 M1 未完成项。** 它是 `M2-P0-1`，在 M1 收口时明确保留为已知限制。
> **发布限制：** 服务端房间一经释放（最后一个成员离开即销毁），新客户端不能依赖服务器恢复历史正文；现阶段唯一持久副本是各客户端的 IndexedDB，用户若丢失全部本地副本，内容无法恢复。

### M1-A0.1 — Pre-Parallel Cleanup ✅ done

| ID        | Task                                                                      | Owner | Status |
| --------- | ------------------------------------------------------------------------- | ----- | ------ |
| M1-A0.1-1 | Freeze room cardinality: one socket = one room, atomic replace on re-join | A0    | done   |
| M1-A0.1-2 | Delete the duplicate presence channel (TEXT `presence` removed)           | A0    | done   |
| M1-A0.1-3 | Remove `RoomJoinedPayload.revision` (room counter, no M1 consumer)        | A0    | done   |
| M1-A0.1-4 | Add `yjs` + `y-protocols` to `apps/server`                                | A0    | done   |
| M1-A0.1-5 | Restate sync handshake as a deliberate M1 choice (client-initiated)       | A0    | done   |
| M1-A0.1-6 | Awareness consumption boundary (`getCollaborators()` only for UI)         | A0    | done   |
| M1-A0.1-7 | Regression tests + full validation                                        | A0    | done   |

### M1-A0.1 validation

| Check              | Command                                      | Result                                  |
| ------------------ | -------------------------------------------- | --------------------------------------- |
| Install            | `pnpm install`                               | lockfile up to date                     |
| Typecheck          | `pnpm typecheck`                             | 3/3 packages `Done`                     |
| Unit tests         | `pnpm test:unit`                             | 67 passed (6 files)                     |
| Server integration | `pnpm test:server`                           | 9 passed                                |
| Build              | `pnpm build`                                 | shared + server `tsc`, web `vite build` |
| Runtime            | `pnpm --filter @insighthub/server verify:m0` | 7/7 checks                              |

Also implemented in this pass (the doc claimed it, the code did not do it): the
server now distinguishes `UNKNOWN_MESSAGE_TYPE` from `INVALID_MESSAGE`, so the
deleted `presence` message fails with the accurate code. Covered by four
integration tests (legacy `presence`, malformed JSON, known type with bad payload,
JSON with no `type`). A3 inherits this classification for its room routing.

### The contract is frozen — do not renegotiate it in code

M1-A0/M1-A0.1 froze everything the three parallel tasks touch. Work from these, not
from memory:

| Frozen artefact                                                                       | Where                                                           |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Binary frame framing, limits, malformed behaviour                                     | `packages/shared/src/binary-frame.ts`, `docs/CONTRACTS.md` §6   |
| Control-plane messages (`join-room`, `room-joined`, `leave-room`) — **no `presence`** | `packages/shared/src/protocol.ts`, `docs/CONTRACTS.md` §5       |
| Room cardinality (one socket = one room, atomic replace)                              | `docs/CONTRACTS.md` §5.4, `protocol.ts` `ROOM_CARDINALITY`      |
| Error code vocabulary (9 codes)                                                       | `packages/shared/src/errors.ts`, `docs/CONTRACTS.md` §7         |
| A1 ↔ A2 session interface                                                             | `packages/shared/src/collab-session.ts`, `docs/CONTRACTS.md` §8 |
| A1 ↔ A3 wire semantics + lifecycle                                                    | `docs/CONTRACTS.md` §6, §10                                     |
| Awareness contract, cleanup rules, **consumption boundary**                           | `awareness-state.ts`, `docs/CONTRACTS.md` §9, §9.1, §9.2        |
| Source-of-truth rule                                                                  | `docs/ARCHITECTURE.md` §0                                       |

If a task needs something here changed: **stop and request Supervisor approval**
(`AGENTS.md` §2). A silent local change to a frozen seam breaks the other two
agents.

### Entry / exit criteria

- **Entry:** M0 green; M1-A0 contract frozen and committed.
- **Exit:** two browser sessions converge; 30 s offline loses no keystroke;
  reconnect transfers a delta rather than the document; typecheck, tests and build
  green.

| ID       | Task                                                                       | Owner        | Status                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1-A0    | Contract freeze: binary framing, error codes, session seam, wire semantics | A0           | **done**                                                                                                                                                                                                                                                                                                                                                                                                           |
| M1-A1    | Yjs 文档 + 离线持久化 + 重连合并 + awareness + undo                        | A1           | **done** —— P0-1 见 `85a1b7c`，经 `caa5376` 集成                                                                                                                                                                                                                                                                                                                                                                   |
| M1-A2    | CodeMirror ⇄ `Y.Text` 绑定 + 编辑器 UI + 协作者 UI                         | A2           | **done** —— P0-2 `0b79a93`、P0-3 `a679856`、选区 `270cf5e`，经 `0d04161` 集成                                                                                                                                                                                                                                                                                                                                      |
| M1-A3    | 文档房间、同步中继、presence、连接生命周期                                 | A3           | **done** —— 经 `47e96e3` 集成；服务端 58 测试通过                                                                                                                                                                                                                                                                                                                                                                  |
| M1-A6    | Chaos 测试：重连、重复帧、乱序、幽灵 awareness                             | A6           | **done** —— 真实浏览器 + chaos 门禁见 `f031063`；发现 P0-1/2/3                                                                                                                                                                                                                                                                                                                                                     |
| M1-P0    | A6 发现缺陷的稳定化（A1、A2）与集成                                        | A1 / A2 / A0 | **done** —— 基线 `9be0e1a`；见下一节                                                                                                                                                                                                                                                                                                                                                                               |
| M1-A7    | 集成门禁：typecheck、测试、构建、wire 格式复核                             | A7           | **done** —— Final Closing Review = **APPROVE**；C1、C2 均 CLOSED，无 merge blocker；原文见 `docs/agent-governance/A7-m1-p0-review.md`                                                                                                                                                                                                                                                                              |
| M1-MERGE | 将 M1 合入 `main`                                                          | A0           | **done** —— `--no-ff` merge commit `1fa2abe`（父：`47e96e3` + `652b66f`）；拓扑与 A1/A2/C1 提交历史完整保留                                                                                                                                                                                                                                                                                                        |
| M1-C1    | A7 条件 C1：让 fatal 重连 pin 可被观测                                     | A1           | **done** —— `dd36169`（基于 `85a1b7c`），经 `f2dfe1a` 集成。**mutation validation 已由 A1 完成**：删除 `active=false`、删除 `active=false`+`closeSocket()`、删除正常自动重连，三组变异均使对应断言 **FAIL**；变异后生产文件已恢复并核对 hash。A0 在最终 merge 阶段未重复执行该实验；A7 Final Closing Review 已独立复核代码敏感性与零残留状态，**C1 = CLOSED，无剩余证据缺口**（详见 `docs/DECISIONS.md` D-039 §6） |
| M1-C2    | A7 条件 C2：决策记录 + 修掉 `defect-pins.mjs` 悬空引用                     | A0           | **done** —— `a06b6ff`（D-039、引用修复）                                                                                                                                                                                                                                                                                                                                                                           |

### M1 退出条件 —— 逐项状态

| 退出条件                       | 是否满足               | 证据                                                                                                                                                                  |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两个浏览器会话收敛             | **是**                 | `realtime/two-tabs-converge`、`indexeddb/D-two-tabs-share-one-replica`、`indexeddb/C-offline-then-reconnect-converges`                                                |
| 离线不丢键击                   | **实质满足**           | 真实拒绝连接后重连：`indexeddb/B-offline-edits-survive-reopen`、`chaos/offline-reconnect`。条件字面的 **30 s** **未**用专门计时器断言——场景演练真实断网，但时长未固定 |
| 重连传增量而非整篇文档         | **是**                 | 服务端 `M1-A3 incremental sync (acceptance criterion 4)`；传输受 state vector 约束                                                                                    |
| `typecheck` / 测试 / 构建 全绿 | **是**                 | 在 `f8af8d7`：`pnpm typecheck` exit 0、`pnpm test` exit 0（251 vitest + 58 服务端）、`pnpm build` exit 0                                                              |
| 上述项的浏览器证据             | **是——但仅一种浏览器** | `node tests/browser/run.mjs` → **27 通过 / 0 失败 / 0 错误**。Chrome 155 / Windows / 单机；跨浏览器与跨平台**未验证**                                                 |

### M1-P0 —— 稳定化 ✅ 已完成

A6 的真实浏览器门禁发现了三个 Node 套件观测不到的缺陷。A1 与 A2 在各自分支修复，A0 集成两者并让门禁变得可信。决策与审计链见 `docs/DECISIONS.md` D-039。

| ID      | 任务                                                                                                      | Owner                       | 状态                                   | 证据                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1-P0-1 | 给只读的 `globalThis.indexedDB` 赋值（浏览器中它是 getter-only）→ 任何文档都打不开                        | A1                          | **已完成**                             | `85a1b7c`；`defect-pin/P0-1` 在 pin 删除前已于**未修改**路径通过                                                                                                   |
| M1-P0-2 | 本地编辑只在累计 64 次变更时 flush → 击键从未进入 `Y.Text`（不持久、不共享、undo 失效）                   | A2                          | **已完成**                             | `0b79a93`；九个 pinned 场景转绿；编辑器长度 == `Y.Text` 长度                                                                                                       |
| M1-P0-3 | `ViewPlugin` 在自己的构造函数里 dispatch → 插件挂载即崩，远端光标从不渲染                                 | A2                          | **已完成**                             | `a679856`；`cursors/remote-caret-and-selection-render` 通过                                                                                                        |
| M1-P0-4 | 两条 harness 断言在产品**正确**时失败（绝对 `editorMounts === 1`；切进一个有协作者的房间后仍要求 0 光标） | A0 —— A6 域，受委派         | **已完成**                             | `19587fc`；`mounts 2→2`、`viewId 1→1`，光标归属新房协作者                                                                                                          |
| M1-P0-5 | `sync.test.ts` 的 fatal 断言比较的是**存活** socket 数 → 抖动，且两次读数都为 0 时变成空断言              | A0 —— A1 域，ownership 例外 | **已完成，随后被 C1 取代**             | `9be0e1a` 修正了计数语义；A7 随后指出**窗口**仍太短（120 ms vs 1000 ms 退避），`f2dfe1a` 用 C1 重写了整个用例；重复计数器已收敛为 A1 单一的单调 `totalConnections` |
| M1-P0-6 | P0 pin、P0-1 shim 与"缺陷仍存在"的过期注释退场                                                            | A0 —— A6 域，受委派         | **已完成**                             | `19587fc`、`fc542f8`；27 个场景，无 shim、无 `knownDefect` 标签                                                                                                    |
| M1-P0-7 | **服务端持久化** —— M1 没有                                                                               | —                           | **未完成 → `M2-P0-1`**                 | 房间随最后一个成员销毁；**全新**客户端无法恢复既有内容。已知 limitation，非合并阻塞                                                                                |
| M1-P0-8 | presence 写侧 seam 缺失；注入的 IndexedDB 工厂无引用计数                                                  | —                           | **已接受风险 → `M2-P0-2` / `M2-P0-3`** | `docs/DECISIONS.md` D-039 §3 / §4；两项均已记录，**均未修复**                                                                                                      |
| M1-P0-9 | A7 复核报告原先不在仓库                                                                                   | A0                          | **已闭合**                             | `docs/agent-governance/A7-m1-p0-review.md`（逐字原文）；D-039 §5 已改为指向它                                                                                      |

> 以上浏览器结论**仅描述 M1 的协作面**。它们与 M2 权限、M3 AI、M4 硬化无关，不得当作那些里程碑的证据引用。

### M1-A2 implementation notes (A2)

Design decisions that matter for review:

| Concern            | Decision                                                                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Truth              | `Y.Text` only. No document content in React state or Redux; the editor reads content solely from the session.                                                                                               |
| Binding            | One `CollabTextBinding` per session, created before the view and destroyed with it, so a collaborator or connection update cannot remount the editor or duplicate the observer.                             |
| Echo suppression   | Three independent mechanisms: transaction-origin check, re-entrancy guard, and a derived-change marker (`REMOTE_SYNC_ORIGIN`) that stops an undo or a remote update from being re-recorded as a local edit. |
| Remote application | `Y.TextEvent.delta` is deliberately **not** translated by hand; the authoritative content is diffed against the editor and the minimal single-range change is applied (one editor transaction per update).  |
| Undo               | No CodeMirror `history()`; `Mod-z` routes to `session.undo()` so undo stays CRDT-scoped by origin.                                                                                                          |
| Presence           | Cursor offsets come from awareness; every rendered string comes from `session.getCollaborators()`.                                                                                                          |
| Document switch    | The editor remounts per session and the old binding is destroyed before the next session exists.                                                                                                            |

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
is no `await` between "leave A" and "join B", and every refusal is decided _before_ the
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

## M2 — Durable persistence & the two M1 gaps (M2-P0 Gate: PASS — reviewed by A7)

状态：**三项 P0 全部 IMPLEMENTED；M2-P0 Gate 已发布到 `main`。** M2-P0 Exit Gate 由 A7 独立评审判为
**APPROVE**（判据与证据见下「M2-P0 Exit Gate vs M2 Milestone」）。基线：从 immutable tag
`m1-closed`（`f3c353e`）分出，经 `m2-stabilization`（`ec762ef`）以 `--no-ff` merge 合入 `main`，
annotated tag **`m2-p0-gate`**；tag 指向的最终 `main` HEAD 上 typecheck / test / build / browser 全绿
（记录见 `docs/DECISIONS.md` D-060）。
**注意：Gate 通过 ≠ M2 关闭** —— M2 Phase 2（权限/认证）尚未开始，M2 不得标 CLOSED；
`m2-closed` **不存在，也不得创建**。
决策：`docs/DECISIONS.md` **D-040…D-060**。

### M2 范围

| ID        | 内容                          | 本轮状态                                                           | 代码状态                                                           |
| --------- | ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `M2-P0-1` | 服务端 durable persistence    | **COMPLETE**（A–K 全部有证据；证据层按 D-056）                     | **IMPLEMENTED** —— `apps/server/src/persistence/**` + 房间生命周期 |
| `M2-P0-2` | presence 写侧 seam            | **COMPLETE**（三步齐备；`SHARED_CONTRACT_VERSION` = 4，wire 不变） | 见下「M2-P0-2 — presence 写侧 seam（3 步迁移）」                   |
| `M2-P0-3` | 注入式 IndexedDB 工厂生命周期 | **COMPLETE**（D-046 的 5 过）                                      | **IMPLEMENTED** —— `collab/internal/persistence.ts` 租约栈         |

**不在 M2 范围**：AI 编辑器（M3）、UI 重设计、wire framing 变更。

> **范围位移，已由项目负责人确认（M2-P0 release 指令）。** `docs/PROJECT.md` 里 M2 的原蓝图是
> "Permissions & state（认证 / RBAC / 请求取消 / 竞态）"，而 M2 实际被定义为"三项 P0 + Phase 2 权限/认证"。
> 负责人已确认 M2 的边界为：**M2-P0（已 PASS，tag `m2-p0-gate`）→ M2 Phase 2 permission/auth
> （NOT STARTED）→ M2 final gate**。因此权限/认证**已归入 M2 Phase 2，不再是"未排入任何里程碑"的状态**
> （见 `docs/DECISIONS.md` D-060 §1）。本节仅保留位移记录，**不再作为待决问题**。

### M2-P0 Exit Gate vs M2 Milestone

**这两个不是同一个东西**（`docs/DECISIONS.md` D-047 决定 1）。

**M2-P0 Exit Gate（本 Gate 的判据）**

1. `M2-P0-1` 的 **A–K 全部 PASS**，但每项要求的**证据层**按 D-056 分层：

   | 证据层                                                           | 场景                          |
   | ---------------------------------------------------------------- | ----------------------------- |
   | **浏览器级必需**（真实 Chrome + 真实后端进程 + 真实磁盘）        | **A / B / C / E / F / G / J** |
   | **Node 级确定性证据足够**（可复现的确定性用例）                  | **D / H / I**                 |
   | **Node + 机制证明；browser evidence 目前 N/A**（附重评触发条件） | **K**                         |

   **K 的正确表述**：Node 级可控 hydration 测试 + room-state-machine / error-code 机制证明；
   在当前 production `SqliteDocumentStore` 的**同步 hydration** 实现下，wire/browser 无法稳定形成
   hydration backlog，因此该项的 browser evidence 目前 **N/A**。
   **不要把它写成"K 永久不可达"**：若未来 store 变为真实 async I/O、或 hydration timing 改变，
   必须重新评估 K，并在可达时恢复 browser-level validation。

   > **这不是降低 A–K 验收标准。** 全部十一项仍必须 PASS，变化的只是每项所要求的 evidence layer。

2. `M2-P0-2` **三步全部完成**（D-057）：step 1 seam（已 DONE）、step 2 编辑器迁移（A2）、
   step 3 收窄裸 `Awareness`（A1）；只有三步都合入后才可标 COMPLETE。
3. `M2-P0-3` 已实现：D-046 的 **5 个回归测试**存在并通过。
4. A6 的 restart / persistence / corruption / chaos 浏览器门禁全绿。
5. A7 的 **P0 review** APPROVE，无 merge blocker。
6. `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿，浏览器套件在**合并后的最终 HEAD** 上重跑全绿。

**判定结果：PASS（A7 · M2-P0 Exit Review）**

| 判据                                  | 判定     | 证据                                                                                      |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| 1 · A–K 全部 PASS（证据分层）         | **PASS** | 11/11；A/B/C/E/F/G/J 浏览器级，D/H/I Node 级，K 为 Node + 机制证明（D-056）               |
| 2 · M2-P0-2 三步                      | **PASS** | step1 `6714ca2`+`054d87e`→`b40ba3c`；step2 `1a8c887`→`271fb4c`；step3 `9f8cfa2`→`a278ee8` |
| 3 · M2-P0-3                           | **PASS** | D-046 的 5 个回归测试在 318 内通过                                                        |
| 4 · A6 浏览器门禁                     | **PASS** | A7 独立重跑 **36/36**（M1 27 + M2 9），exit 0，含 pid 变化 / SHA 一致 / 1011 / 未广播     |
| 5 · A7 P0 review                      | **PASS** | **APPROVE**；4 项 pinned 均为文档/流程级，无 Gate 阻断项                                  |
| 6 · 三项门禁 + 浏览器在最终 HEAD 重跑 | **PASS** | `typecheck` 0 / `test` **318 + 105** / `build` 0；浏览器 36/36                            |

**A7 pinned 缺陷的处理**：P1（契约/架构/TASKS 仍称 P0-1、P0-3 "未实现"）、P2（A1 step 3 跨域留痕）、
P3（D-056 措辞过强）、P4（A6 evidence note 过期）均已在 release commit 内修正（`docs/DECISIONS.md` D-059）。

**通过 Gate ≠ M2 关闭。** 顺序冻结为：

```text
M2-P0（本 Gate）
  → M2 Phase 2 / P1：permission & authentication consistency
  → M2 final gate
  → M3 AI（不得先于权限上下文）
```

**M2 Milestone 关闭条件（在本 Gate 之外）**：Phase 2 的权限/认证一致性完成并通过 A7 的
final gate。**在 permission/auth 尚未处理时，M2 不得标 CLOSED。**

### M2 Phase 2 / P1 — permission & authentication consistency

| 项       | 内容                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| 目的     | 服务端权威的文档级权限与认证一致性；客户端只做 UI 门控                                                            |
| 触发条件 | **已满足**：M2-P0 Exit Gate PASS 并发布为 `m2-p0-gate`（D-060）                                                   |
| Owner    | **A5**（身份/会话/成员关系/授权判定核心 + HTTP 层）+ **A3**（WS 判定点接线 + 文档元数据源）；A6 出证据            |
| 状态     | **M2 Phase 2 feature / evidence / A7 review 均 COMPLETE；M2 milestone NOT CLOSED**（负责人裁定 Option B，D-070）。**唯一 blocker：TOOLING-P2 test-runner liveness** —— `pnpm test` 偶发"全部 PASS 后进程不退出"。关闭顺序：TOOLING-P2 closure → A0 集成 → A7 M2 closure review → 负责人授权 `m2-closed`。**不创建 `m2-closed`、不进入 M3 kickoff** |

#### Phase 2 — 已决策（`docs/DECISIONS.md` D-061，项目负责人）

| 决定             | 内容                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份机制         | **server-issued opaque session token + `httpOnly` cookie + server-side session → `userId`**；本阶段用 **Demo Identity Bootstrap**，不实现密码凭据认证            |
| 安全承诺（原文） | 服务端签发的 session 可以防止客户端在后续 API/WS 请求中直接伪造身份；**demo bootstrap 本身不提供 credential-level identity proof**。**禁止**写成"防止跨用户冒用" |
| 术语三分         | `Demo Identity Bootstrap` / `Session Authentication` / `Authorization` —— 不得合并、不得互相替代                                                                 |
| 非目标           | password hash/storage、signup、password reset、OAuth/SSO、MFA                                                                                                    |
| space            | **space-A**：不引入 space entity / membership / role；授权链止于 Document Membership                                                                             |
| 版本             | `SHARED_CONTRACT_VERSION` 4 → **5**（新增 `FORBIDDEN`）；`PROTOCOL_VERSION` 保持 **2**                                                                           |

#### Phase 2 — 现状重建（A0 只读核验，2026-10-18）

| 层             | 现状                                                                                                        | 证据                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| HTTP API       | 只有 `/health` 与 `/api/meta`；**没有**文档端点、**没有**认证端点                                           | `apps/server/src/app.ts`；`CONTRACTS` §12                              |
| WebSocket      | `join-room` 的 `mode: 'readonly' \| 'readwrite'` 已冻结在契约里，**服务端从不读取该字段**                   | `packages/shared/src/protocol.ts` §5.2；`rooms/registry.ts` `joinRoom` |
| 授权           | `RoomRegistry` 有 `authorizeJoin?(documentId) => boolean` 钩子，**生产未接线**，默认 `() => true`（全放行） | `registry.ts` L174/L201/L306；`ws.ts` 不传该选项                       |
| 角色语义       | `DocumentRole` 词表与 `documentCapabilities` 已在 shared 冻结；**除 `aiAcceptRequiredRole` 外无消费者**     | `packages/shared/src/permission.ts`                                    |
| 身份           | 客户端每 tab 生成随机 demo 身份；**服务端不接收、不验证**                                                   | `apps/web/src/user.ts`                                                 |
| 成员关系持久化 | store 只有文档 snapshot + update log；**没有 user / membership 表**                                         | `apps/server/src/persistence/types.ts`                                 |
| space          | **代码与契约中都不存在**（仅 `AGENTS.md` 的 A5 角色描述提到 "space/document permissions"）                  | 全仓检索                                                               |

#### Phase 2 — 四层授权边界（冻结）

| 层           | 权威判定点                                                                                          | 允许                                                                                                                                                                                                  | 禁止                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **API**      | `apps/server/src/authz/**` 中间件 + 路由处理：session → `userId` → 成员角色 → capability            | 无 session = `401`；未知文档 / 无成员关系 / 无 `canRead` **统一** `404 not_found`；`canRead` 但 capability 不足 = `403`（`CONTRACTS` §17.4）                                                          | 把授权决定下放给 web；用 UI 门控代替服务端判定；让 403/404 区分出文档是否存在                         |
| **WS**       | `join-room` 与每个 BINARY 帧的入口（`RoomRegistry` / `DocumentRoom`），使用 A5 提供的 resolver      | 升级即要求有效 session（否则 HTTP `401`，不建立 WS）；无 `canRead` → `ROOM_NOT_FOUND`（与未知文档同码，非泄露）；无 `canEdit` → `FORBIDDEN` 且**不 apply、不 persist、不 broadcast**，socket 保持打开 | 采信客户端声明的 `mode`；让失败的 join 驱逐已有房间；对 AWARENESS 帧施加写权限（viewer 也要能发光标） |
| **document** | `documentCapabilities`（`canRead` / `canComment` / `canEdit` / `canManageMembers`）+ 持久化成员关系 | 这四问是唯一判据                                                                                                                                                                                      | 在 UI 或服务端各写一套"更细"的规则                                                                    |
| **space**    | **本 Phase 不引入**（D-061 决定 4：不制造当前不存在的领域实体）                                     | —                                                                                                                                                                                                     | 以 space 名义新增持久化实体、角色或端点                                                               |

#### Phase 2 — 依赖顺序（硬约束）

```text
A5 authz seam（纯新增模块 + shared 判据 + 表驱动测试）   ← DONE（e718568 / cd18eb1）
   → A0 integrate                                       ← DONE（D-062）
   → A3 接线（ws.ts / registry.ts：升级 401、join 拒绝、BINARY 闸门、`room-joined.role`、documents 源）
     ← DONE（0d23af9），随 A6 一起合入 main
   → A6 浏览器 / 负向路径证据                            ← DONE（fee4f64，44/44）
   → A0 integrate（87c971b）→ A7 Phase 2 final review    ← DONE，GO（D-064）
```

**Phase 2 之后的收口顺序（D-065 §6，覆盖 D-064 §4 的顺序）**：

```text
A3(B3 注释) ∥ A1(getRole)          ← 本轮并行，base a3ff4a9
  → A0 integrate（integrated HEAD 上 typecheck / test / build）
  → A2(F1 UI，只消费 session.getRole())
  → A0 integrate
  → A6 integrated evidence（六点覆盖 + F3 evidence condition）
  → A0 integrate A6 提交 + 最终 integrated HEAD 重跑四门禁
  → A7 M2 final review
  → 项目负责人授权 milestone closure / tag
```

理由与 D-057 同构：A5 与 A3 都改 `apps/server`。**先冻结 seam，再由 A3 接线**，否则两人同时改
`registry.ts` / `ws.ts`，且 A3 会在没有判据的情况下自己发明授权规则。

> **Specialist 交接规则（D-065 §1）**：A1–A7 的 `Next Handoff` 一律写 `A0`；可以说明 downstream
> consumer 是谁及其约束，但**不得**自行调度下一棒。

#### Phase 2 — Acceptance Criteria（冻结）

| #    | 场景                  | 判据                                                                                                                                                                                                                                          | 证据层           |
| ---- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| P2-1 | viewer 不能改文档     | viewer 发送 SYNC update：服务端**不 apply / 不 persist / 不 broadcast**；发送方收到 `FORBIDDEN`；第二个 peer 看不到该文本；socket 仍可接收他人更新                                                                                            | browser          |
| P2-2 | 身份不可自称          | 客户端在 join payload / API body / header / query 里塞 `userId` **全部无效**；把 `mode` 改成 `readwrite` **无效**；答案只由 session + 成员关系给出                                                                                            | Node + browser   |
| P2-3 | 非泄露                | 无 session = `401`；未知文档、无成员关系、无 `canRead` **三者响应完全相同**（`404 not_found`，状态码/body/headers 一致）；capability 不足才 `403`                                                                                             | Node             |
| P2-4 | 多层一致              | 同一角色在 API / WS join / WS frame / `documentCapabilities` 四处得到同一答案（表驱动，角色 × capability × 入口）                                                                                                                             | Node             |
| P2-5 | 权限不因重启/吊销失真 | 角色变更后重新判定为新角色；进程重启后成员关系仍在；`DELETE /api/session` 后同一 token 处处 `401`                                                                                                                                             | browser + Node   |
| P2-6 | 越权管理              | `canManageMembers` 仅 owner；editor 调成员相关能力 = `403`                                                                                                                                                                                    | Node             |
| P2-7 | 既有门禁不回归        | typecheck / test / build / browser 全绿；M1 + M2-P0 的既有场景**一个都不能减少**                                                                                                                                                              | 全部             |
| P2-8 | 术语与安全承诺        | 仓库文档 / UI 文案 / 报告里**不出现**被禁措辞（"无密码用户名登录可防跨用户冒用"等）；bootstrap 不得被描述为 password authentication（`CONTRACTS` §17.0）。检索时排除 D-061 的「作废表述」对照表与本条目自身——它们引用被禁措辞是为了**禁止**它 | `grep` + A6 复核 |
| P2-9 | token 不暴露给 JS     | `document.cookie` 读不到 `insighthub_session`；token 不出现在任何 JSON body、日志、Redux、localStorage、awareness；`POST /api/session/bootstrap` 的响应 body 不含 token                                                                       | browser + Node   |

#### Phase 2 — Ownership

| Agent        | 范围                                                                                                    | Owned Files                                                                                                                                                                                                                                                                                                                   | Do Not Touch                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **A5**       | session/store/角色解析/授权判定核心、HTTP 中间件与 §17.4 端点、`FORBIDDEN` 码、版本 4→5、web 侧权限门控 | `apps/server/src/authz/**`（新建）<br>`apps/server/src/app.ts`<br>`apps/server/src/index.ts`（构造 authz 并注入 HTTP 层）<br>`packages/shared/src/errors.ts`、`packages/shared/src/index.ts`（版本常量）、`packages/shared/src/permission*.ts`（如需新判据）、对应 `*.test.ts`<br>`apps/web/src/features/**`（仅权限门控 UI） | `apps/server/src/ws.ts`、`apps/server/src/rooms/**`、`apps/server/src/persistence/**`、wire framing、`PROTOCOL_VERSION` |
| **A3**       | WS 侧执行点：升级认证、join 拒绝、BINARY 闸门、`documents` 元数据源                                     | `apps/server/src/ws.ts`、`apps/server/src/rooms/**`、`apps/server/src/persistence/**`（仅新增 documents / membership 只读数据源）                                                                                                                                                                                             | `packages/shared/**` —— **例外（D-062 §1 已授权，A7 F5 指出本行与之处矛盾）**：`protocol.ts` 的 `room-joined.role`、`index.ts` 的版本 5→6 及其 `*.test.ts`；`apps/web/**`；`apps/server/src/authz/**`；错误码词表 |
| **A6**       | security / negative-path 证据（P2-1…P2-9）                                                              | `tests/browser/**`                                                                                                                                                                                                                                                                                                            | 生产代码                                                                                                                |
| **A0**       | 契约定稿、集成、`index.ts` 的一行接线（若 A5/A3 都不该写）、Phase 2 final gate 调度                     | `docs/**`、`AGENTS.md`                                                                                                                                                                                                                                                                                                        | —                                                                                                                       |
| **A1/A2/A4** | idle                                                                                                    | —                                                                                                                                                                                                                                                                                                                             | —                                                                                                                       |

> **已知的跨域点（按 D-055 §1 / D-059 P2 的具名例外处理）**：`attachWebSocketServer` 需要收到
> authz resolver。A5 不写 `ws.ts`，A3 不改 `authz/**`，因此**这一行接线由 A0 在集成时写入**
> 并在 commit message 点名。

#### Phase 2 — 实现现状（A7 GO，已合入 `main`；M2 仍未 CLOSED）

| 层                         | 现状                                                                                                                                         | 位置                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| HTTP（session + 文档端点） | **已实现**：§17.4 五个端点、非泄露 404、`credentials: true` 的显式 origin CORS                                                               | `apps/server/src/authz/**`、`apps/server/src/app.ts`      |
| 判定核心                   | **已实现**：`roleFor` / `can` 一律复用 `documentCapabilities`；无第二套规则                                                                  | `apps/server/src/authz/authz.ts`                          |
| session                    | **已实现**：CSPRNG 256-bit opaque token、`httpOnly`/`SameSite=Lax`/`Path=/`、12 h、吊销/轮换；**process-scoped**（limitation，不是安全属性） | `apps/server/src/authz/{tokens,session-store,cookies}.ts` |
| 成员关系                   | **已实现**：A5 自有表 `authz.db`（`documentId/userId/role`），demo fixture 种子，重启后仍在                                                  | `apps/server/src/authz/membership-store.ts`               |
| WS 执行点                  | **已实现**：升级期 401 且**不建立 socket**、join 拒绝（与"文档不存在"同码）且不驱逐既有房间、BINARY 逐帧闸门、backlog 回放重新授权           | `ws.ts`、`rooms/{registry,room,context}.ts`               |
| 客户端身份                 | **已接线**：bootstrap 取 `userId/displayName`；token 只存在于 httpOnly cookie，JS 不可达                                                     | `apps/web/src/session/**`、`user.ts`、`App.tsx`           |
| 客户端权限门控             | **已生效**（A2 + A6）：`room-joined.role` → `session.getRole()` → `capabilityGate` → `EditorState.readOnly` + `EditorView.editable=false` + 可见诚实文案；三条本地写路径（facet / 交付 / `session.undo()`）全部挡住；**未知角色仍完全可编辑**。浏览器证据 `f1/1…f1/4` 与重瞄后的 `p2/1`、`p2/2`、`p2/4` | `apps/web/src/features/permissions/**`、`apps/web/src/features/editor/**` |
| `FORBIDDEN` / 版本         | **已实现**：`FORBIDDEN` 非致命；`SHARED_CONTRACT_VERSION` **7**（`getRole()` 加入 seam）；`PROTOCOL_VERSION` 保持 2                                                   | `packages/shared/src/{errors,protocol,index,collab-session}.ts` |

#### Phase 2 — A7 GO 的收口缺口（不阻断合入 `main`，阻断 **M2 关闭与发布说明**）

| # | 项 | 归属 | 状态 |
| --- | --- | --- | --- |
| **B3 / F4** | `rooms/authz-enforcement.test.ts`（640 行，全文注释与部分 `it` 标题乱码）与 `persistence/restart.test.ts`（10 处）：是 **UTF-8→GBK→UTF-8 的有损转码**；`§` 后的数字被吃掉（如 `鎼?7.5` 应为 `§17.5`），部分换行被吞。另有两处过期注释：`index.ts` 头仍写"WS 未接线"、`authz-enforcement.test.ts` L321 仍写"§17.5 表格要求 canEdit" | **A3** | **CLOSED（A0 审计 PASS，已合入 `709da9c`）**。独立复核 `git diff --unified=0`：**115 行 = 注释 43 + `describe`/`it` 标题 15 + 其他 0**；15 对标题两侧代码后缀逐字节相同；`describe`/`it` 计数不变。附带修好两处**非 CJK** 损伤（前导 `a` 被 U+0007 BEL 吞掉）与两行被吞换行——**教训：乱码检测不能只扫汉字，还要扫控制字符与 U+FFFD** |
| **B3-residual** | 6 处 mojibake 落在**诊断字符串实参**内（`waitFor` 描述 4 处、`assert.equal`/`assert.deepEqual` 第 3 实参 2 处），应为 `’`/`—` | **待项目负责人一次性放宽 diff 规则** → 之后 A3 以**仅字符串字面量**的独立提交关闭 | **不修**（A0 决定）。理由：B3 的验收是 **diff 形状**规则；一旦 diff 里出现 `assert(...)` 行，审查就必须区分"assert 内的消息串"与"assert 被改了"，而这正是规则要消除的歧义。**B3 的 grep 验收因此是作用域的**：注释与标题 = 0，全文件 ≠ 0。**任何人不得声称"mojibake 已全库清零"** |
| **F1** | `room-joined.role` 无消费者：viewer 可在 UI 里打字、本地看得见、服务端拒绝、他人看不到。**不得**表述为"viewer 能改文档" | **A1 → A2 → A6 → A0** | **CLOSED**：A1 半边（`0f63fdc`，v7）+ A2 半边（`5afdab9`，三条写路径全挡）+ A6 浏览器证据（`7ae4974`，**48/48**，含 `f1/1…f1/4`），A2+A6 一起进 `main`（`91bcf77`，D-068）。双断言模式（UI 只读 + 非 UI 路径仍 `FORBIDDEN` 且要求**新**帧）已成为同类场景标准。**禁令仍有效**：不得声称"角色变更即时反映到 UI"——`f1/1` 实测降级后 3 秒 UI 仍是 editor |
| **F2** | 吊销/过期**不追溯已建 socket**（`writeApplied:true`）。契约已澄清为"请求级"（§17.2/§17.5、D-064），实现（断连或每帧重解）进 backlog | **A0**（契约，已完成）→ **A3**（实现，backlog） | 契约 **已澄清**；实现 **未做**。发布说明不得声称"吊销立即生效" |
| **F3** | 夹具在 `role: null` 时仍会补写 membership（意图被 `setDocumentId` 覆盖） | **A6** | **CLOSED**（D-068 §3）：两处写入点同时关闭（`newAppPage` 的 `role: null` 分支 + `setDocumentId(..., { arrangeAccess: false })`，默认 `true` 使遗留调用点行为不变），并有数据库级证明（窗口期 `membershipRow: null` → 之后才 `inserted`）。**残留风险**：`lib/app.mjs#openApp` 仍会以隐式 `arrangeAccess` 打开文档（当前未被使用），属 A6 的 latent 项 |
| **F5 / B2** | TASKS 的 A3 ownership 行与 D-062 §1 矛盾 | **A0** | **已修**（本行上方 ownership 表） |
| A3 的 public surface       | **已冻结**：`apps/server/src/authz/public.ts`（cookie→userId、documentId+userId→role、capability 判定）                                      | 同上                                                      |

#### Phase 2 — Branch / worktree plan

```text
main @ <freeze commit>
  ├ agent/a5-m2-phase2-authz      → Insighthub-wt-a5-m2-authz
  │     └ (合入后) agent/a3-m2-phase2-ws-authz → Insighthub-wt-a3-m2-ws-authz
  └ (A6 在 A3 合入后才启动) agent/a6-m2-phase2-security → Insighthub-wt-a6-m2-security
```

规则与 M2-P0 相同：worktree 一律从**派发时的** `main` HEAD 分叉；A0 独占集成；A5 → A3 顺序不可颠倒（D-061 §6）。

**Backlog（不属于任何 Gate）**：**无编辑 join 仍 append 2 字节空 update**（D-055 §3，无内容影响）、
**idle/background compaction**（M2-P0 只做 eviction-time，D-054）、
**`synchronous = FULL` 的可配置性**（D-047 决定 2 要求 production 可配置，当前硬编码 `NORMAL`，
见 D-060 §2 勘误）、
键击通知扇出优化（D-039 L2）、主 bundle 分块、
`void persistence.destroy()` 的未处理拒绝（D-039 L5）、跨浏览器（Firefox/Safari）验证、
真实多机弱网浸泡。

### TOOLING-P2 — test-runner liveness（M2 关闭的唯一 blocker；D-070）

**状态：OPEN，已派发 A3。** 这是 M2 关闭前的最后一件事，**scope 只有一条**：让
`pnpm test` 与 `pnpm --filter @insighthub/server test` 在**所有测试 PASS 之后**稳定自行退出。

| 项 | 内容 |
| --- | --- |
| Owner | **A3**（`ws.ts` / `rooms/**` / 测试 harness）+ **A0**（`package.json` 脚本、若需改门禁命令） |
| Branch / Worktree | `agent/a3-tooling-p2` / `Insighthub-wt-a3-tooling-p2` |
| Do Not Touch | 产品语义、断言、`docs/**`、`tests/browser/**`、`packages/shared/**`；**不得**用 `--test-force-exit`、timeout 或 force kill 制造 false success |
| 现象（重复观测） | 全测试 PASS 已打印，进程不退出（两次 >10 分钟）；随后同命令 34 s 正常；server 套件单独 2/2 通过（29 s / 27 s） |
| 必须覆盖的诊断面 | open handles、`child_process` / `tsx` 生命周期、`server.close()`、`WebSocketServer.close()`、timers、SQLite 句柄、worker/subprocess、teardown 竞态 |
| Acceptance | 见 D-070 §3 八条：可解释 root cause；不靠 timeout/force kill；两个命令都稳定退出；**重复运行**（连续 N 次记录）；最终 integrated HEAD 上四门禁；clean tree；A7 复核；之后才请求 `m2-closed` 授权 |

历史证据（上一轮，`--test-concurrency=1` 已加入但**未能**消除）：

| 运行方式                                 | 结果                             |
| ---------------------------------------- | -------------------------------- |
| 串行 `--test-concurrency=1`（15 文件）   | **163/163 pass，55 s，exit 0**   |
| 并行但排除 `persistence/restart.test.ts` | **160/160 pass，8 s，exit 0**    |
| 并行 + `--test-force-exit`（15 文件）    | **163/163 pass，9 s，exit 0**    |
| 并行，默认（15 文件）                    | **不退出**（测试结果已全部打印） |
| 之后：`pnpm test`（`692a420`）           | **卡住 >10 min**（`# pass` 已打印） |
| 之后：`pnpm test`（`74da34c`）           | **卡住 >10 min**（同形态）       |
| 之后：server 套件单独 ×2                 | **180/180，29 s / 27 s，均退出** |
| 之后：`pnpm test` 再一次                 | **378 + 180，34 s，exit 0**      |

**结论**：测试内容全绿，**退出的可靠性不稳**（约 1/3 观测到卡住）。先前"串行即解决"的结论
（D-063 §2b）**已被证伪**，必须重查机制。


### M2-P0-1 — 服务端 durable persistence

| 项                | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner             | **A3**                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Branch / Worktree | `agent/a3-m2-persistence` / `Insighthub-wt-a3-m2`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Owned Files       | `apps/server/src/persistence/**`（新建，含 store + hydrator + 测试）<br>`apps/server/src/rooms/room.ts`（仅 update 路径与 unhealthy 状态）<br>`apps/server/src/rooms/registry.ts`（hydration barrier、eviction 语义）<br>`apps/server/src/ws.ts`（`room-joined` 推迟到屏障之后）<br>`apps/server/src/config.ts`（`INSIGHTHUB_DATA_PATH`）<br>`apps/server/src/index.ts`（shutdown 时 `store.close()`）<br>`apps/server/src/rooms/test-harness.ts`（每测试独立临时库） |
| Do Not Touch      | `packages/shared/**`、`apps/web/**`、`tests/browser/**`、任何 `package.json`（本轮不新增依赖）、`docs/CONTRACTS.md`                                                                                                                                                                                                                                                                                                                                                   |
| Dependencies      | 无外部依赖：设计已冻结（ARCHITECTURE §7、CONTRACTS §14、D-041…D-044）                                                                                                                                                                                                                                                                                                                                                                                                 |
| 必须遵守          | 每文档**单一 FIFO pipeline** 且失败即停（D-048）；`apply → persist → broadcast`（D-044）；房间状态机（D-049）；hydration 溢出用 `INTERNAL_ERROR` 而非 `FRAME_TOO_LARGE`（D-050）；启动 capability-check（D-051）；append/sequence 原子（D-052）；hydration barrier 不改 wire（D-043）；Markdown 不得成为服务端权威（D-042）                                                                                                                                           |
| Acceptance        | 见下 **A–K**，全部需要真实执行                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**M2-P0-1 验收场景（冻结）**

| #   | 场景                    | 判据                                                                                                                                                               |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | 房间清空后恢复          | tab A 写文本 → A 离开 → 房间被驱逐 → **全新** tab B 打开 → 内容仍在                                                                                                |
| B   | 进程重启恢复            | 写文本 → **终止 server 进程** → 启动新进程 → 新浏览器打开同一文档 → 内容完整                                                                                       |
| C   | 离线客户端 + 重启       | 客户端离线编辑 → 服务端重启 → 客户端重连 → state-vector 对账 → 双方收敛 → 再开**全新**客户端 → 看到完整内容                                                        |
| D   | 重复 update 重放        | 同一 update 重复进入持久化路径 → 重启 → 状态不重复、不损坏                                                                                                         |
| E   | 压缩                    | 超过阈值产生日志 → compaction（**eviction-time**）→ 重启 → 文档与压缩前一致（渲染文本 + `Y.Doc` 双断言）                                                           |
| F   | 持久化失败              | 模拟写入失败 → 不得向其它 peer 宣称成功的状态 → 行为符合 D-044（error + 断开 + 房间移除）                                                                          |
| G   | 文档隔离                | doc A 与 doc B 的持久状态完全隔离，互不可见、互不覆盖                                                                                                              |
| H   | 并发上送                | 两个 peer 几乎同时提交 update → durable append 顺序明确 → broadcast 只发生在各自 commit 之后 → 重启后完全收敛                                                      |
| I   | 失败停止 pipeline       | 强制第 N 次 append 失败 → N **不广播** → N+1 排队 mutation **不得继续成功** → room unhealthy/destroyed → 重启后 durable 只含 N 之前已提交数据 → 原作者重连后能补齐 |
| J   | hydration single-flight | 多个客户端同时 join 同一 cold document → `store.load` **只发生一次** → 所有人看到同一 hydrated `Y.Doc` → 不得出现两个竞争的 room document                          |
| K   | hydration backlog 溢出  | 故意阻塞 hydrate → 制造有界队列溢出 → 收 `INTERNAL_ERROR` + 关闭 → **不得误报 `FRAME_TOO_LARGE`** → server 不崩溃                                                  |

**运行时前置条件（D-051）**：server 需要 Node 运行时提供被验证过的 `node:sqlite` API
（本轮实测于 Node **v22.14.0**，无需 flag，仅一条 experimental 警告）；启动时做 capability
check，不满足则**启动失败**并给出清晰诊断，**禁止** memory-only fallback，**不新增**第三方
SQLite 依赖。

### M2-P0-2 — presence 写侧 seam（3 步迁移）

**这是三步迁移，不是一步。** 顺序冻结（D-045 设计、D-057 调度修正）：只有三步全部完成并合入，
`M2-P0-2` 才可标 **COMPLETE**。

| 步骤  | 内容                                                                                         | Owner | Branch / Worktree                                                            | 状态                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | `publishPresence` 附加 seam、`updatedAt` 归协作层、写入前校验、`SHARED_CONTRACT_VERSION` 2→3 | A1    | `agent/a1-m2-presence` / `Insighthub-wt-a1-m2-presence`                      | **DONE** —— `6714ca2` + A0 ownership 例外 `054d87e`，合入 `b40ba3c`                                                                         |
| **2** | 编辑器迁移：不再写裸 `Awareness`、不再自维护 `updatedAt`                                     | A2    | `agent/a2-m2-presence-ui` / `Insighthub-wt-a2-m2-presence`（base `0075aae`） | **DONE** —— `1a8c887`，合入 `271fb4c`；生产代码裸写入 0、`updatedAt` 0、`session.awareness` 仅 1 处 binding input                           |
| **3** | 收窄裸 `Awareness` 暴露（仅作 binding input）                                                | A1    | `agent/a1-m2-presence-narrow` / `Insighthub-wt-a1-m2-narrow`                 | **DONE** —— `9f8cfa2`，合入 `a278ee8`；`AwarenessBinding`（`clientID`/`getStates`/`on`/`off`），17 条 `@ts-expect-error`，版本 3→4（D-058） |

| 项                   | 内容                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                | **A1**（step 1、step 3）→ **A2**（step 2）→ **A1**（step 3 收口）                                                                                                                                                                                                     |
| A1 Owned Files       | `packages/shared/src/collab-session.ts`（**仅 A0 预批准的那一处附加** + step 3 的类型收窄）、`apps/web/src/collab/internal/{document-session,awareness,public}.ts`、`apps/web/src/collab/tests/**`                                                                    |
| A2 Owned Files       | `apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx`、`apps/web/src/features/editor/**/*.test.ts`、`apps/web/src/features/editor/testing/fakeCollaborativeSession.ts`                                                                                       |
| Do Not Touch（双方） | `apps/server/**`、`tests/browser/**`、wire framing、错误码词表                                                                                                                                                                                                        |
| Dependencies         | step 2 依赖 step 1 已合入；step 3 依赖 step 1+2 都已合入（否则收窄会先打断编辑器）                                                                                                                                                                                    |
| Acceptance           | step 1：seam 存在且校验先于写入、版本 3、wire 不变。step 2：`features/**` 内 `setLocalStateField` 与 `'updatedAt'` 写入均为 0；每次光标变化只有 1 次 awareness 写入。step 3：裸 `Awareness` 不再有生产写入口，类型上不可写。三者都需 `pnpm typecheck/test/build` 全绿 |

### M2-P0-3 — 注入式 IndexedDB 工厂生命周期

| 项                | 内容                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner             | **A1**                                                                                                                                          |
| Branch / Worktree | `agent/a1-m2-idb-lifecycle` / `Insighthub-wt-a1-m2-idb`                                                                                         |
| Owned Files       | `apps/web/src/collab/internal/persistence.ts`、`apps/web/src/collab/tests/persistence.test.ts`、`apps/web/src/collab/tests/public-seam.test.ts` |
| Do Not Touch      | `packages/shared/**`、`apps/server/**`、`apps/web/src/features/**`、`tests/browser/**`                                                          |
| Dependencies      | 无（与 M2-P0-2 可并行，但两者都改 `collab/`，集成顺序由 A0 决定）                                                                               |
| Acceptance        | D-046 的 5 个回归测试存在且通过；生产路径（未注入）全局零写入、getter 身份不变                                                                  |

### 其他 Agent

| Agent  | M2 角色                                               | 说明                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A6** | restart / persistence / corruption / chaos 浏览器门禁 | Owned：`tests/browser/**`。能**真实重启 server 进程**、构造损坏库、注入写失败。**已交付**（`231253a`，36/36）。证据层分工见 D-056：A/B/C/E/F/G/J 必须有浏览器证据；D/H/I 允许 Node 级；K 在同步 store 下 browser N/A            |
| **A7** | 最终架构 + 发布终审                                   | 只读；按 **M2-P0 Exit Gate**（D-047 的 Gate/Milestone 分层 + D-056 的证据层分层）逐项判定。**启动条件：P0-1 + P0-2（step 1/2/3 全部）+ P0-3 都已合入，且 A6 门禁在集成后的 HEAD 上绿。** 在 P0-2 step 3 完成前不得启动（D-057） |
| **A5** | M2-P0 **不分配**；**M2 Phase 2 起成为 Owner**         | M2-P0 期间文档隔离（场景 G）是存储层职责（A3 实现 + A6 验证），授权面未变。**Phase 2 起 A5 负责身份/成员关系/授权判定核心**（见上「M2 Phase 2 — 依赖顺序」），但**在身份机制由项目负责人选定之前不启动编码**                    |
| **A4** | **idle**                                              | M3 才启动                                                                                                                                                                                                                       |

### Branch / worktree plan

```text
m1-closed (tag, f3c353e, immutable)
  └ m2-stabilization            ← 本 worktree：Insighthub-wt-m2
      └ [Architecture Freeze commit]  ← 只有文档
          ├ agent/a3-m2-persistence   → Insighthub-wt-a3-m2          ← 已合入
          ├ agent/a1-m2-idb-lifecycle → Insighthub-wt-a1-m2-idb      ← 已合入
          ├ agent/a1-m2-presence      → Insighthub-wt-a1-m2-presence ← 已合入（step 1）
          │    └ agent/a2-m2-presence-ui → Insighthub-wt-a2-m2-presence   ← step 2
          │         └ (step 2 合入后) agent/a1-m2-presence-narrow
          │              → Insighthub-wt-a1-m2-narrow                ← step 3
          └ agent/a6-m2-chaos         → Insighthub-wt-a6-m2          ← 已合入
```

规则：

1. **Agent worktree 一律从当时的 `m2-stabilization` HEAD 分叉**（不是从 `main`、不是从 tag）。
   Freeze commit 之后每次派发都以当前 HEAD 为 base，并在派发单里写明 SHA。
2. `m2-stabilization` 只由 A0 写入（集成 + 文档），Agent 一律在自己的 worktree 里改。
3. **presence seam 的三步顺序是硬约束**（D-057）：step 1 seam → step 2 编辑器迁移 → step 3 收窄裸
   `Awareness`。任一步跳过或颠倒都会留下"编辑器无法编译"或"调用方仍在写裸实例"的窗口。
4. `m1-closed` tag 保持不动；M2 不动 `main`。

## M3 — AI suggestions (sketch)

AI request pipeline, suggestion + diff generation, Diff Preview, Accept / Reject
/ Undo applied through a Yjs transaction. Owner: A4.

### M3 前置：从 M2 移交的具名风险（A7 final review，必须写进 M3 kickoff）

这七条**不是**"以后有空再说"，而是 A7 在 M2 终审中逐条确认、且 M3 会真实撞上的东西。
M3 kickoff 时必须逐条决定：在 M3 内解决、或明确接受并写进该 milestone 的发布说明。

| # | 风险 | 为什么 M3 会撞上 | 归属建议 |
| --- | --- | --- | --- |
| **R1** | 吊销/过期**不追溯已建 socket**（`writeApplied: true`） | AI 建议会以某个用户的身份被接受；若该用户已登出，服务端仍会接受来自其既有 socket 的写入 | A3（实现） |
| **R2** | session 是**进程内**的，客户端**不**会在 401 后重新 bootstrap（页面停在 `reconnecting`） | M3 的建议链路会跨多次请求；一次服务端重启就让整条链路失效且没有自愈 | A1 + A2 |
| **R3** | 角色变更**不推送**给客户端（UI 门控滞后到下次 join；需要新控制面消息 + `PROTOCOL_VERSION` bump） | AI 接受权限与角色强相关；滞后会让"能点接受"和"服务端会接受"错位 | A0（契约）→ A1/A2 |
| **R4** | `B3-residual`：6 处诊断字符串仍含 mojibake（注释与标题已清零，**全文件不是 0**） | M3 的报告若引用"mojibake 已清零"会与仓库事实不符 | A3 |
| **R5** | `commenter` 无浏览器证据；§17.9 的"被拒 join 之后"的 null 窗口未覆盖 | M3 会引入新的角色相关 UI，缺这两块会让"角色相关行为已验证"过度泛化 | A6 |
| **R6** | `tests/browser/lib/app.mjs#openApp` 仍以隐式 `arrangeAccess` 打开文档（latent F3 入口，当前未被使用） | M3 的新场景一旦用它，就会重新获得"夹具发权限"的假成功通道 | A6 |
| **R7** | 主 bundle **1.41 MB 未拆分** | M3 会显著增大前端体积，首屏会更差 | A2（性能） |

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
