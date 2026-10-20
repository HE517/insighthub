# AGENTS.md — InsightHub Multi-Agent Working Agreement

This file is the operating contract for every AI agent (and human) working in this
repository. It is binding: when a task conflicts with this file, stop and ask the
Supervisor instead of guessing.

**Read order before doing anything:**

1. `AGENTS.md` (this file) — the contract and the Definition of Done
2. `agent-prompts/COMMON.md` — shared behavioural rules for every agent
3. `agent-prompts/A{n}-*.md` — your role's long-term scope (see §3)
4. `docs/PROJECT.md` — what we are building and what is out of scope
5. `docs/ARCHITECTURE.md` — where code is allowed to live
6. `docs/CONTRACTS.md` — the frozen cross-boundary interface you must reuse
7. `docs/TASKS.md` — the current milestone and task ownership

---

## 1. Non-negotiable engineering rules

| Rule | Detail                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `packages/shared/**` is the **only** source of truth for types crossing web/server. Never re-declare a shared type inside an app.                                                                                                                                                           |
| R2   | Never edit another agent's owned files. If you need a change there, raise an `OWNERSHIP BLOCKER` (see `agent-prompts/COMMON.md` §5).                                                                                                                                                        |
| R3   | Keep the dependency surface small. No new production dependency without Supervisor approval.                                                                                                                                                                                                |
| R4   | No secrets, tokens, passwords or API keys in code, docs, fixtures or tests.                                                                                                                                                                                                                 |
| R5   | Every acceptance criterion you claim must be backed by a command you actually ran, with its real output. "Should work" is not evidence.                                                                                                                                                     |
| R6   | Never mark a task done while a typecheck, test or build is failing.                                                                                                                                                                                                                         |
| R7   | Do not refactor unrelated code in the same change as a feature. One concern per change.                                                                                                                                                                                                     |
| R8   | AI features are proposals, not state. Accepting an AI edit must go through a Yjs transaction; the AI module must never write final document content into React/Redux state.                                                                                                                 |
| R9   | Every network call takes an `AbortSignal` and must handle the aborted/stale case.                                                                                                                                                                                                           |
| R10  | Offline is a first-class state, not an error path. Editing must not be silently lost.                                                                                                                                                                                                       |
| R11  | **Document content has exactly one source of truth: `Y.Doc` / `Y.Text`.** Never mirror the body into React state or Redux. Redux may hold only `activeDocumentId`, metadata, permission, connection status, collaborator metadata and UI state.                                             |
| R12  | The WebSocket has two planes: **TEXT = JSON control protocol**, **BINARY = Yjs sync + awareness**. Never base64 a Yjs update into JSON, and never invent a second framing scheme — always use `packages/shared/src/binary-frame.ts`.                                                        |
| R13  | A local undo reverts only local/AI-origin edits. Never undo a remote collaborator's change, and never implement undo as a text-snapshot restore. Use `UNDO_TRACKED_ORIGINS`.                                                                                                                |
| R14  | Collaborator UI data must come from the schema-validated `session.getCollaborators()`, never from `session.awareness.getStates()`. The raw `Awareness` instance is allowed only as input to a Yjs/CodeMirror collaboration binding — never business UI state, never Redux, never persisted. |
| R15  | One socket carries **at most one** active document room. A second `join-room` means atomic replace, not a second concurrent room. Never route a binary frame without an unambiguous room.                                                                                                   |
| R16  | Two files in the same directory must never differ **only by letter case** (`readOnlyNotice.ts` vs `ReadOnlyNotice.tsx`). On a case-insensitive filesystem `tsc` fails with `TS1149` while a Linux CI passes — a break that only shows up on one platform. Name the pair apart (e.g. `…Copy.ts` + `…Notice.tsx`). |

## 2. Supervisor Review Required

The following paths change the interface or the foundation every agent depends on.
Changing them **requires explicit Supervisor approval before the edit lands**:

- `packages/shared/**`
- `package.json` (root and any workspace package)
- `pnpm-workspace.yaml`
- `docs/ARCHITECTURE.md`
- `docs/CONTRACTS.md`
- `AGENTS.md` and `agent-prompts/**` (governance surface)

Process for a required change:

1. Do **not** edit the file yet.
2. Report the proposed diff shape, the reason, and the blast radius (who breaks).
3. Wait for explicit approval from A0.
4. Apply the change **alone**, in its own change set, with a typecheck + test run.

Everything else (app-local code, app-local tests, `docs/TASKS.md` status updates,
`docs/PROJECT.md` wording that does not change scope) may be edited by the owning
agent within its assigned task.

## 3. Agent roles

The **authoritative, maintenance-grade role definitions live in `agent-prompts/`**
(one file per agent). This section is the index; the prompt files own the detail.

| Agent | Role                                      | Prompt file                              |
| ----- | ----------------------------------------- | ---------------------------------------- |
| A0    | Supervisor / Architect / Integration Lead | `agent-prompts/A0-supervisor.md`         |
| A1    | Collaboration / Yjs                       | `agent-prompts/A1-collaboration.md`      |
| A2    | Editor Frontend                           | `agent-prompts/A2-editor-frontend.md`    |
| A3    | Realtime Backend                          | `agent-prompts/A3-realtime-backend.md`   |
| A4    | AI Document Editing                       | `agent-prompts/A4-ai-document.md`        |
| A5    | Permission & State Consistency            | `agent-prompts/A5-permission-state.md`   |
| A6    | QA / Chaos Engineering                    | `agent-prompts/A6-qa-chaos.md`           |
| A7    | Integration / Architecture Review         | `agent-prompts/A7-integration-review.md` |

Short form (the table in `agent-prompts/` is authoritative):

- **A0** owns architecture, contracts, task decomposition, assignment, dependency
  approval, shared files, git/worktree coordination, integration, quality gate and
  milestone planning. A0 is not the default feature developer; it dispatches,
  reviews, decides and integrates.
- **A1** owns `Y.Doc`/`Y.Text`, the Yjs sync client, IndexedDB, offline/reconnect,
  awareness lifecycle, `UndoManager`, and `CollaborativeSession`.
- **A2** owns React, CodeMirror 6, the `Y.Text` ↔ editor binding, remote cursors and
  selections, collaborator UI, editor lifecycle and editor performance.
- **A3** owns Express + WebSocket, the room registry, the server-side `Y.Doc` room,
  the Yjs sync server, awareness relay, heartbeat, backpressure and connection cleanup.
- **A4** owns AI suggestions: document read tools, selection/location, suggestion
  generation, diff preview, accept/reject, stale detection, `RelativePosition`
  anchoring, the `ai` transaction origin and AI undo isolation.
- **A5** owns RBAC, space/document permissions, API and WebSocket authorization,
  request cancellation, `AbortController` discipline, stale-response ownership and
  document-switch/search races.
- **A6** owns proof: real-browser regression, chaos (offline/duplicate/out-of-order/
  race), lifecycle audits, performance invariants and the Release Gate.
- **A7** owns the final independent gate: code/architecture review, contract
  compliance, cross-agent integration and release recommendation. A7 is
  deliberately independent of A0 so the Supervisor is never the only reviewer.

## 4. Task Completion Report (Definition of Done)

**A task is not DONE until its Task Completion Report is delivered.** A report with
a missing required item is not accepted, even if the code is perfect.

Every formal task ends with a **Chinese** report containing all 14 sections below.
Report conclusions first, then evidence, then risk.

### 4.1 Required sections

**1. 任务状态 (Status)**

- `Status`: `done` / `partial` / `blocked`
- `Branch`, `Worktree`, `Commit` (short SHA; `未提交` if not committed)

**2. 本轮目标**
One paragraph: what state was supposed to exist after this round.

**3. 完成了什么**
Bullet list of delivered outcomes — not activities. "X now works" beats "did X".

**4. 技术实现**

- 数据流：数据从哪来到哪去，谁是权威
- 生命周期：创建/更新/销毁的触发点，什么被释放
- 设计选择：选了什么方案
- 为什么这样设计：被否掉的替代方案，以及否定理由

**5. 发现并修复的问题**
For **each real bug**, all five fields:

| 字段              | 要求                                   |
| ----------------- | -------------------------------------- |
| `Problem`         | 现象，可观测                           |
| `Root Cause`      | 机制级原因，不是"某处写错了"           |
| `Impact`          | 谁受影响、多严重、是否数据丢失         |
| `Fix`             | 改了什么，为什么这样改                 |
| `Regression Test` | 哪个测试能防止复发，修复前它是否真的红 |

If nothing was found, say so explicitly — a round with no findings is a claim too.

**6. Files Changed**
List files, and for key files explain **职责** (what it owns), not just the path.

**7. Tests / Validation**
Real results only. Must include the project gate:

```bash
pnpm typecheck
pnpm test
pnpm build
```

plus the agent-specific verification (e.g. real-browser suite, chaos suite,
integration suite). Report the command, the observed result, and the exit code.

**8. Acceptance Criteria**
Item by item: `PASS` / `FAIL` / `未验证` + the concrete evidence.

**9. 与其它 Agent 的集成关系**
What you depend on, what depends on you, which public surface you touched,
whether any contract changed.

**10. Known Risks / 未验证内容**
Honest list. Distinguish "verified at layer X" from "not verified at all".
Node-only evidence must never be presented as browser evidence.

**11. Need Supervisor Decision**
Open questions and approvals required, with the options and your recommendation.

**12. 给项目负责人的总结**
**3–8 sentences**, answering: what the state was before this round, what it is now,
and what it actually means for InsightHub.

**13. Git 状态**
`git status` summary, branch, commit, and whether the tree is clean or dirty.
**14. Next Handoff**

Every A1–A7 report ends with a machine-readable handoff block:

```text
## Next Handoff

Handoff Status:
AUTO_CONTINUE / OWNER_DECISION_REQUIRED / STOP

Recommended Next Agent:
<agent id, or "none">

Base:
<branch> @ <sha>      ← the commit the next agent must branch from

Why:
<one or two sentences: what is now unblocked>

Dependencies satisfied:
<what the next agent may rely on: frozen contract, merged seam, green gate, …>

Copy-paste Prompt:
<the full task prompt that can be handed to the next agent verbatim>
```

- A specialist may **recommend** the next agent; **cross-agent dispatch authority belongs to A0**.
  A recommendation is input to A0, not an instruction that starts work.
- `AUTO_CONTINUE` may only be claimed when all seven conditions in
  `agent-prompts/A0-supervisor.md` §8.1 hold. If unsure, write `OWNER_DECISION_REQUIRED` and
  **name the specific decision point** — never a vague "needs review".
- No specialist may cross these gates on its own, even with everything green: merge to `main`,
  milestone CLOSED, deleting a milestone tag, push / creating a remote, changing milestone
  scope, overturning frozen architecture.

### 4.2 Report integrity

- Do not fabricate command output, and do not reuse an earlier run's output as if
  it were current.
- `FAIL` and `未验证` are legitimate; presenting red as green is the only
  disqualifying outcome.
- Do not paste internal reasoning or scratch work — report conclusions and evidence.
- Do not skip a section because it is "obvious"; write `none` instead.

## 5. Definition of Done (checklist form)

A task is done only when all of the following hold **and** §4 has been delivered:

1. `pnpm typecheck` passes (exit 0).
2. `pnpm test` passes (exit 0), including tests for new shared contracts and a
   regression test for every bug fixed.
3. `pnpm build` passes (exit 0) if you touched a build input.
4. New behaviour is exercised by a test, or by a documented command with real output.
5. Agent-specific verification has been run (browser/chaos/integration as applicable).
6. Files you did not own are untouched (`git status` proves it).
7. No frozen contract was changed without A0 approval and a decision record.
8. Known risks and unverified areas are stated explicitly in the report.

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
- **Presence read path (R14):** render collaborators from
  `session.getCollaborators()` (schema-validated). Do not read
  `session.awareness.getStates()` for UI — it is `Map<number, unknown>` straight
  off the wire. Passing the raw `Awareness` to an editor binding is the single
  allowed exception, and it is a binding input only.
- **Presence has exactly one channel** (Yjs awareness). Do not add a control-plane
  presence message: the M1-plan `presence` type was deleted deliberately
  (`docs/DECISIONS.md` D-021).
- **Room cardinality (R15):** one socket, one room. `join-room` for a different
  document atomically replaces the current room. Never design a flow needing two
  concurrent rooms on one socket, and never route a binary frame without an
  unambiguous room.

## 7. Scope discipline

- `docs/PROJECT.md` Non-goals are binding. Do not add Next.js, NestJS, LangChain,
  LangGraph, Kafka, Kubernetes, microservices, Redis Cluster, or multi-region
  deployment.
- Do not start a later milestone's work inside an earlier one. M0 ships a
  skeleton that runs; M1-A0 ships a frozen contract. Neither ships collaboration,
  AI or auth.
- Prefer the smallest change that satisfies the acceptance criteria. No
  speculative abstraction.
