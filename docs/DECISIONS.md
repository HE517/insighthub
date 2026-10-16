# DECISIONS.md

Architecture decision record. One entry per decision, appended, never rewritten.
Changing `docs/ARCHITECTURE.md` or `docs/CONTRACTS.md` requires Supervisor
approval (`AGENTS.md` §2); a decision that changes either must be recorded here.

Format: `D-NNN · date · status · title`, then Context / Decision / Consequences.

---

## D-001 · 2026-02-14 · accepted · pnpm workspace monorepo with a shared contract package

**Context.** Web and server both need the same domain vocabulary (documents,
roles, connection status, WebSocket messages, AI suggestions). Two copies would
drift silently, and drift across a network boundary shows up as a runtime bug,
not a compile error.

**Decision.** One pnpm workspace with `apps/web`, `apps/server` and
`packages/shared`. `packages/shared` is the only place a cross-boundary type may
be declared; both apps depend on it via `workspace:*`.

**Consequences.** One install and one lockfile; `pnpm -r typecheck` covers the
whole repo. Cost: root `package.json` and `pnpm-workspace.yaml` become shared
infrastructure, so they require Supervisor review.

---

## D-002 · 2026-02-14 · accepted · Zod schemas are the source of truth, types are derived

**Context.** Runtime validation of untrusted input (WebSocket frames, HTTP
bodies) plus compile-time types are both needed. Hand-writing an interface next
to a validator lets the two disagree.

**Decision.** Declare Zod schemas in `packages/shared` and derive TypeScript
types with `z.infer`. Parsers (`parseServerMessage`, `parseClientMessage`,
`parseMessageJson`) return a discriminated result and never throw.

**Consequences.** One definition per contract; validation and typing cannot
drift. Cost: `zod` is a dependency of `packages/shared`, which both apps inherit.
Rationale for **Zod 3 over Zod 4**: Zod 3 is the mature line with the widest
ecosystem compatibility; no Zod 4-only feature is needed for MVP, and this
avoids an avoidable upgrade risk in the shared foundation.

---

## D-003 · 2026-02-14 · accepted · Unknown WebSocket message types are rejected, not ignored

**Context.** A permissive parser (ignore what you do not understand) hides
protocol drift: a renamed message type degrades into silence and is only noticed
in production.

**Decision.** Two strict discriminated unions — `wsClientMessageSchema` and
`wsServerMessageSchema`. A message that is valid in the wrong direction, or that
carries an unknown `type`, fails to parse. The server answers a malformed frame
with an explicit `error` message.

**Consequences.** Protocol changes break loudly in tests instead of quietly at
runtime. Cost: adding a message type is a two-sided change and requires a shared
contract update (Supervisor review).

---

## D-004 · 2026-02-14 · accepted · AI suggestions anchor to plain offsets + `baseRevision` (RelativePosition deferred to M4)

**Context.** An AI suggestion is generated from a snapshot of the text, then the
user reviews it while the document may keep changing. Applying it to a moved
document corrupts text. Robust anchoring options: plain UTF-16 offsets,
`baseRevision` guard, or Yjs `RelativePosition` (which survives transformation
through concurrent edits).

**Decision.** For M0/M3 the contract carries plain `index`/`length` offsets plus
`baseRevision`. A suggestion whose `baseRevision` no longer matches the document
revision is **stale**: reject or regenerate, never apply blindly
(`isSuggestionStale`).

**Consequences.** Simple, testable, explainable. Known limitation: a document
that moved on always invalidates the suggestion, even when the edit region is
untouched. Upgrade path: migrate operation anchoring to Yjs `RelativePosition` in
M4, which requires a shared contract change and a version bump.

---

## D-005 · 2026-02-14 · accepted · Pin Ant Design 5.x, Vite 7, zod 3

**Context.** The registry currently offers React 19.3, Vite 8.3, Ant Design 6.6,
Zod 4.6 and TypeScript 5.9. Taking the newest major of every package in a
bootstrap milestone maximizes unrelated risk.

**Decision.** React 19.3 + Vite 7.3 + `@vitejs/plugin-react` 5.2 + Ant Design
5.29 + zod 3.25 + TypeScript 5.9 + Redux Toolkit 2.13 + react-redux 9.3.
Ant Design 5 is chosen over 6 because v5 is the line with proven React 19
behaviour; Ant Design 6 is a fresh major.

**Consequences.** A conservative, well-tested stack. Deferred upgrades are a
tracked follow-up, not a silent debt; any bump is a `package.json` change and
therefore requires Supervisor review.

---

## D-006 · 2026-02-14 · accepted · One Vite dev server, backend proxied behind it

**Context.** The browser must reach both the HTTP API and the WebSocket without
CORS or mixed-origin complications, and the M0 criterion is "browser connects to
the WebSocket".

**Decision.** Vite proxies `/api`, `/health` and `/ws` (with `ws: true`) to the
backend on `127.0.0.1:3001`. The client derives its WebSocket URL from
`window.location` by default, overridable with `VITE_WS_URL`. Server CORS stays
explicitly configured for the dev origin anyway.

**Consequences.** One origin in development; no client-side host guessing. Cost:
the Vite proxy config is load-bearing for development.

---

## D-007 · 2026-02-14 · accepted · Workspace-wide TypeScript `paths` instead of project references

**Context.** `packages/shared` ships raw TypeScript. The server's runtime is
`tsx` (dev) and `node` (build), so it must resolve `@insighthub/shared` to real
JavaScript in `dist`, while `tsc` should typecheck against source for accurate
errors.

**Decision.** `tsconfig.base.json` maps `@insighthub/shared` to
`./packages/shared/src/index.ts` for typechecking. `packages/shared` has a
`tsconfig.build.json` that emits declarations plus JavaScript to `dist` and is
built before the server. No TypeScript project references / composite builds.

**Consequences.** Fast, understandable typechecking with no build-order coupling
for editors or tests. Cost: the server's `dist` output relies on `shared` having
been built first, which the root `build` script enforces and `docs/TASKS.md`
documents.

---

## D-008 · 2026-02-14 · accepted · Prettier only; ESLint deferred

**Context.** `AGENTS.md` asks for a quality gate, but adding ESLint with
`typescript-eslint` + React plugins in M0 is configuration surface with no
milestone payoff.

**Decision.** Ship Prettier (`format`, `format:check`) and rely on a strict
`tsc` (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
`verbatimModuleSyntax`, `isolatedModules`) as the correctness gate. ESLint is a
tracked follow-up, not silently dropped.

**Consequences.** No lint-caught rule violations in M0; typecheck plus review
covers the acceptance criteria. Adding ESLint later is an additive change.

---

## D-009 · 2026-02-14 · accepted · `packages/shared` resolves to source for types, to `dist` at runtime

**Context.** First validation run failed with `TS6059: File ... is not under
'rootDir'` — the server's emit build was pulling `packages/shared/src/*.ts` into
its program through the workspace `paths` mapping, so `tsc` refused to emit. A
second, subtler failure followed: `packages/shared` pointed its own runtime
entry (`main`/`exports`) at `./src/index.ts`. TypeScript and Vite accept that,
but plain Node does not, so any non-bundled consumer (the built server, a
standalone script) failed with `ERR_MODULE_NOT_FOUND`.

**Decision.**

1. `tsconfig.base.json` maps `@insighthub/shared` to `packages/shared/src/index.ts`
   so `typecheck` and editors read real source and report accurate errors.
2. `apps/server/tsconfig.build.json` overrides that mapping to
   `packages/shared/dist/index.d.ts`, keeping the shared source out of the emit
   program.
3. `packages/shared/package.json` points `types` → `dist/index.d.ts` and
   `import`/`default` → `dist/index.js`, so runtime consumers resolve real
   JavaScript.
4. `packages/shared` is therefore a **build prerequisite** of the server. This is
   enforced with `apps/server` `prebuild` and a root `predev`, so both
   `pnpm dev` and `pnpm --filter @insighthub/server build` work without a manual
   build step.

**Consequences.** Typecheck accuracy and Node-runnable artefacts are both
satisfied. Cost: `shared` must be built before the server runs — handled by the
scripts above, and worth remembering when adding a new consumer.
**Rejected alternative:** TypeScript project references / composite builds, which
solve this more formally but add build graph configuration that M0 does not need.

Related: an early validation run executed `tsc` against the then-broken config and
emitted compiled `*.js`/`*.js.map` **beside** the shared sources. Those artefacts
were deleted, verified not to be reproducible from a clean state, and guarded by
`packages/shared/src/.gitignore` so this class of mistake cannot be committed.

---

## D-010 · 2026-02-14 · accepted · Two test runners: Vitest for contracts, `node:test` for server integration

**Context.** The server acceptance test must boot a real HTTP + WebSocket server.
That test was written with `node:test` (Node's built-in runner) but the root
Vitest config still globbed it, producing "No test suite found in file".

**Decision.** Vitest owns `packages/**` (pure contract/schema tests) and excludes
`apps/**`. `apps/server` keeps `node:test` via `tsx --test` for integration tests
against real sockets and ephemeral ports. The root `test` script runs both
(`vitest run && pnpm --filter @insighthub/server test`), with `test:unit` and
`test:server` available for focused runs.

**Consequences.** No test-framework compatibility shims, and integration tests
exercise the real transport rather than a mock. Cost: two runners to be aware of;
the root script is the single entry point that covers both.

---

## D-011 · 2026-02-14 · accepted · The Vite proxy target is configurable

**Context.** Runtime verification failed on "vite proxies /health to the backend"
with `ECONNREFUSED 127.0.0.1:3001`: the proxy target was hardcoded while the
backend under test ran on another port. A hardcoded proxy is also a collision
hazard in development.

**Decision.** `apps/web/vite.config.ts` derives the proxy target from
`INSIGHTHUB_SERVER_HOST` (default `127.0.0.1`) and `PORT` (default `3001`), and
exposes them to tooling that runs the stack on non-default ports.

**Consequences.** The stack can be started on any port without editing config,
and the M0 proxy check is reproducible. Cost: one more environment variable to
document (`README.md`).

---

## D-012 · 2026-02-14 · accepted · Shared contracts are validated with Zod 3 semantics

**Context.** `docs/CONTRACTS.md` specifies ISO 8601 timestamps on envelopes and
positive-only offsets. An early test fixture used `ts: 'x'` and failed — correctly,
because `z.string().datetime()` rejected it.

**Decision.** Keep strict validation (`z.string().datetime()`, non-negative
integers, non-empty payload objects) and fix the fixture, rather than loosening
the schema to accommodate a bad test. Rejection behaviour is itself asserted by
tests: unknown `type`, wrong-direction messages, non-ISO timestamps, empty insert
text and negative offsets are all covered.

**Consequences.** Malformed frames fail loudly at the boundary instead of
corrupting document state later. Cost: producers must emit well-formed ISO
timestamps — the `createEnvelope`/`createConnectedMessage` helpers guarantee this
for anything built through the shared API.

---

## D-013 · 2026-02-14 · accepted · The dev stack binds IPv4 explicitly

**Context.** Verifying the documented quickstart on default ports, the backend
answered on `127.0.0.1:3001` but the web server did not: `Get-NetTCPConnection`
showed Vite listening on `::1` only, so `http://127.0.0.1:5173` failed while
`http://localhost:5173` worked. Vite's default `localhost` binds a single address
family chosen by the OS resolver, which on Windows is IPv6. The README, the
browser instructions and the backend all use `127.0.0.1`, so this was a real
documentation/behaviour mismatch, not a cosmetic one.

**Decision.** Set `server.host = '127.0.0.1'` in `apps/web/vite.config.ts` so the
whole dev stack listens on IPv4. CORS on the server explicitly allows
`http://localhost:5173` as well, so either spelling keeps working.

**Consequences.** `http://127.0.0.1:5173` and `http://localhost:5173` both reach
the app, and every component uses one address family. Cost: binding to loopback
only, which is the intended development default (expose with `--host` if you
deliberately want LAN access).

---

## D-014 · 2026-02-14 · accepted · Two-plane WebSocket: TEXT for control, BINARY for collaboration data

**Context.** M1 adds Yjs sync and awareness on top of the M0 handshake. The
obvious shortcut is to wrap a Yjs update as a base64 string inside the existing
JSON envelope. That costs ~33% size inflation on every keystroke, adds a base64
encode/decode and a JSON parse per edit, and destroys the ability to stream or
inspect the payload efficiently.

**Decision.** One WebSocket at `/ws`, two planes distinguished by the **frame
kind**:

- **Control plane (TEXT):** the existing JSON envelope — `connected`,
  `join-room`, `room-joined`, `leave-room`, `presence`, `error`.
- **Data plane (BINARY):** Yjs sync and awareness, carried as raw bytes.

`ws` already exposes the distinction (`string` vs `Buffer`), so no in-band
discriminator is needed. Yjs updates are never base64-encoded. Both planes share
one `PROTOCOL_VERSION`.

**Consequences.** No size/CPU tax on the hot path, and the control plane stays
human-readable in DevTools. Cost worth documenting: a data-plane violation is
reported on the **control plane** as a text `error` frame, so a client must not
assume a text frame implies a text-frame cause. This is stated in
`docs/CONTRACTS.md` §6.3 and `docs/ARCHITECTURE.md` §5.

---

## D-015 · 2026-02-14 · accepted · Reuse `y-protocols` framing rather than inventing one

**Context.** The receiver must distinguish SYNC from AWARENESS, and within SYNC
distinguish SyncStep1/SyncStep2/Update. Writing a bespoke framing was tempting but
would mean inventing a wire format that other editors cannot speak and that we
alone must maintain.

**Decision.** Copy the `y-websocket` convention, verified against the installed
`y-protocols@1.0.7` source rather than assumed:

- Frame layout: `frameType (varUint)` then payload. `0 = SYNC`, `1 = AWARENESS`.
- The SYNC payload is written by `y-protocols/sync` itself
  (`writeSyncStep1/2/Update`) and read by `readSyncMessage`; our codec only adds
  and strips the frame-type header, so the official encoding is preserved byte for
  byte. This is asserted by a test comparing the frame payload against lib0's own
  encoder output.
- The AWARENESS payload is exactly `awarenessProtocol.encodeAwarenessUpdate(...)`
  output, which has **no inner message type**.
- That convention's types `2` (`auth`) and `3` (`query-awareness`) are reserved and
  rejected in M1 rather than silently ignored.

**Verified facts that shaped the codec** (established by probing the installed
packages, not from docs):

1. `readSyncMessage` reads the message type itself, so the payload handed to it
   must start at that type, not after it.
2. `readSyncMessage` returns a message type even for a truncated payload, so the
   codec must validate the length-prefixed array itself; otherwise an incomplete
   frame is silently accepted as "no data".
3. `reading.readAny` is a tagged lookup-table decoder and **throws on ordinary
   JSON**; awareness state is written with `writeVarString`, so `readVarString` is
   the correct reader.
4. `decoder.arr` is the whole buffer (not the remainder) and `decoder.pos` is the
   cursor, so offsets must be derived from cursor positions. `Decoder.arr` is the
   same object instance that was passed to `createDecoder`.
5. An `Awareness` installs a 3 s heartbeat interval and **must** be `destroy()`ed
   or the process never exits — this is why the session contract mandates it.

**Consequences.** Interoperable framing, no private CRDT algorithm, and the whole
wire format lives in one reviewed place (`packages/shared/src/binary-frame.ts`)
that A1 and A3 both import. Cost: the codec must be updated if `y-protocols` ever
changes its framing — mitigated by the byte-faithfulness test.

---

## D-016 · 2026-02-14 · accepted · One frozen session interface to break the A1 ↔ A2 circular dependency

**Context.** The M1 plan as written deadlocked: A1 was to wait for "the editor
binding from A2" while A2 waited for "`useDocument()` from A1". Neither could
start, and whichever went first would have dictated the other's shape by accident.

**Decision.** Declare the seam in `packages/shared/src/collab-session.ts`
(`CollaborativeSession`, `CollaborativeSessionResult`, `CollaboratorInfo`,
`UndoState`, `CollaborativeSessionOptions`) and freeze the access path to
`apps/web/src/collab/public.ts`:

- **A1 implements** `createCollaborativeSession(options)` and
  `useCollaborativeDocument(options)` behind that module.
- **A2 consumes only** the shared interface, and may develop immediately against
  its own in-memory test double typed as `CollaborativeSession`.
- The interface deliberately omits IndexedDB, the reconnect queue, state vectors
  and socket framing, so A2 cannot accidentally couple to them.
- `collab/internal/**` is private to A1 and A2 must not import it.

**Consequences.** A1 and A2 start in parallel with no waiting and no accidental
coupling. Cost: the interface is now a review-gated contract, and the placeholder
in `public.ts` returns `{ state: 'initializing' }` / rejects until A1 lands, which
is intentionally visible rather than silently wrong.

---

## D-017 · 2026-02-14 · accepted · `PROTOCOL_VERSION` and `SHARED_CONTRACT_VERSION` bumped to 2

**Context.** M1-A0 changed the wire protocol in ways that break a v1 peer:
`connected.payload.protocolVersion` became a literal `2`, `join-room` now
**requires** `protocolVersion` and gained a `mode`, `room-joined` gained
`connectionId` and dropped `lastKnownRevision`, and `error.payload.code` became a
closed enum instead of a free string. A v1 client would be rejected by the new
schema, which is the correct outcome but only if the version actually moved.

**Decision.** Bump `PROTOCOL_VERSION` and `SHARED_CONTRACT_VERSION` to `2` in the
same change, make `protocolVersion` a `z.literal(PROTOCOL_VERSION)` in both
`connected` and `join-room` so a mismatch fails at the boundary, and reserve
`PROTOCOL_VERSION_MISMATCH` for the server to report it explicitly.

**Consequences.** Peers cannot silently talk past each other, and the version is
part of the payload rather than an afterthought. Cost: any stored or hard-coded
`protocolVersion: 1` (including tests and the `/api/meta` response) had to be
updated together — done in this change and covered by tests.

---

## D-018 · 2026-02-14 · accepted · Error codes are a closed, typed vocabulary

**Context.** M0 used a free-form string code (`'invalid_message'`). With three
agents reacting to server errors, free strings drift: one side checks
`invalid_message`, the other emits `INVALID_MESSAGE`, and the mismatch is silent.

**Decision.** A frozen `WS_ERROR_CODES` object (`INVALID_MESSAGE`,
`UNKNOWN_MESSAGE_TYPE`, `INVALID_BINARY_FRAME`, `FRAME_TOO_LARGE`,
`ROOM_NOT_JOINED`, `ROOM_NOT_FOUND`, `PROTOCOL_VERSION_MISMATCH`,
`INTERNAL_ERROR`) exposed as a Zod enum on the wire and as a TypeScript union in
code, plus:

- `createErrorMessage(code, message)` so an invented code is a compile error;
- `isWsErrorCode(value)` to guard untrusted input;
- `isFatalErrorCode(code)` to answer "does this socket die?" in one place;
- a rule that a `message` never carries a stack trace, path or internal id.

`ROOM_NOT_FOUND` is reserved now (M1 has no persisted store) so M2 does not need a
new vocabulary for the same concept.

**Consequences.** Error handling is exhaustive and two agents cannot disagree about
a code. Cost: adding a code is a shared-contract change requiring Supervisor
review, which is intended.

---

## D-019 · 2026-02-14 · accepted · Document content is never mirrored into Redux or React state

**Context.** The natural React instinct is to put the editor's text in the store.
In a CRDT system that creates a second source of truth, which diverges, clobbers
remote edits, breaks undo, and is invisible to other clients.

**Decision.** Write the rule down as binding architecture
(`docs/ARCHITECTURE.md` §0, `docs/CONTRACTS.md` §8) and as a review gate
(`AGENTS.md` R11):

- `Y.Doc`/`Y.Text` is the **only** source of truth for document content.
- Redux may hold `activeDocumentId`, metadata, permission, connection status,
  collaborator metadata and UI state — **not** the document body.
- React state may hold text only transiently for rendering.
- IndexedDB stores encoded Yjs updates, never a parallel Markdown string.
- A1's task explicitly must **not** create a `documentSlice` mirroring `Y.Text`;
  such a slice may only carry metadata/UI state.

**Consequences.** One history, safe merge, trustworthy undo, and an AI path that
cannot bypass the CRDT. Cost: editor code reads text from `session.text` and must
subscribe to changes rather than reading a store field — slightly more wiring,
verified by A2's acceptance criteria and A7's review.

---

## D-020 · 2026-02-14 · accepted · One socket carries one document room; re-join atomically replaces it

**Context.** The M1-A0 contract left the re-join transition undefined: what happens
if a socket already in room A sends `join-room(B)`? Left unstated, A1 and A3 would
each assume something different, and the failure mode is silent — binary Yjs frames
carry **no `documentId`**, so if a socket could be in two rooms at once, every
collaboration frame would be ambiguous and the server would have to guess which
document an update belonged to. That is not a bug you find in a test; it is data
landing in the wrong document.

**Decision.**

1. **Freeze the cardinality: one socket = at most one active document room.**
   `ROOM_CARDINALITY` in `protocol.ts` encodes
   `maxActiveRoomsPerSocket: 1`.
2. **The re-join transition is atomic replace.** A `join-room(B)` while in A leaves
   A and joins B in a single server-side transition, then acknowledges
   `room-joined(B)`. No acknowledgement is sent for the implicit leave, so the
   `room-joined(B)` reply is the client's signal that A is gone.
3. `join-room(A)` while already in A is an idempotent re-join.
4. `leave-room(B)` while in A (`B !== A`) is a no-op and must not drop A.
5. A binary frame while in a room belongs to that room, unambiguously.
6. The refusing alternative stays expressible as `ROOM_CARDINALITY_VIOLATION` (a
   non-fatal code) but is **not** the default, so an implementation that chooses it
   does not need to invent an error string.

**Why replace rather than "error: leave first".** Switching documents is a routine
user action. A two-round-trip protocol (`leave-room` → wait → `join-room`) creates a
window in which the client belongs to no room; that window is precisely where a
dropped reply or a race strands the UI with nothing joined, and it forces the client
to sequence state transitions that the server can do atomically in one step. The
cost of replace is that the server must tear down the old room membership before
acknowledging, which is a few lines and has one clear order.

**Consequences.** No ambiguous frame routing and no client-side join/leave
sequencing. Cost: A3 must implement replace as genuinely atomic (remove-from-A and
add-to-B must not be observable as two states), and A1 must treat
`room-joined(B)` as the trigger to tear down A's local view rather than waiting for
a leave acknowledgement. Awareness cleanup on replace is covered in D-021.

---

## D-021 · 2026-02-14 · accepted · Yjs awareness is the only presence channel; the TEXT `presence` message is deleted

**Context.** The M1 plan carried both a control-plane `presence` message
(`{documentId, connectionId, state: 'joined'|'left'}`) and Yjs awareness, which also
expresses who is present along with identity, cursor and selection. Two channels
describing the same fact is a **two-source-of-truth** problem: the server could
broadcast `presence left` while awareness had not yet expired the entry (or vice
versa), and the UI would have to decide which one to believe. Worse, the two would
usually agree in testing and disagree only under load or partial failure — exactly
where presence bugs are hardest to diagnose.

**Decision.** Delete the `presence` message from the M1 protocol entirely (not
deprecate it):

- Awareness is the **single** source of truth for identity, cursor, selection and
  online ephemeral presence.
- The server removes a departing client's awareness entry and broadcasts that
  removal; peers observe presence changes through awareness, not through a control
  message.
- `room-joined.peers` remains as a one-shot **initial roster** at join time, which
  is a snapshot, not an ongoing channel.
- Room membership counts stay in the server's room registry and need no wire
  message.
- A legacy `presence` envelope is now an unknown type and is **rejected** loudly, so
  a stale client is caught rather than half-working.
- `PRESENCE_SOURCE_OF_TRUTH = 'yjs-awareness'` records the decision in code.

Atomic room replace (D-020) must additionally remove and broadcast the client's
awareness entry for room A before joining B, so A never retains a stale cursor — a
rule that only exists because presence now has exactly one channel.

**Consequences.** One truth, no reconciliation logic, and no ghost cursors from two
channels disagreeing. Cost: clients cannot learn about presence from the control
plane, so a client that only speaks JSON cannot render collaborators at all — an
acceptable M1 trade, recorded here rather than discovered later.

---

## D-022 · 2026-02-14 · accepted · `RoomJoinedPayload.revision` removed rather than renamed

**Context.** `RoomJoinedPayload.revision` was documented as a "room activity
counter", while `DocumentMeta.revision` is the durable, server-owned document
version and the AI staleness anchor. Two different things sharing one name across
one contract is a trap: a reader (or an agent) will use the room counter as a
document revision, and because both are non-negative integers nothing will fail to
compile.

**Decision.** **Remove the field.** It had no M1 consumer: the sync handshake is
state-vector driven, so no counter is needed to sequence sync, and the only stated
justification was observability in logs and tests — which A3 can do with server-side
logging instead of a protocol field.

`RoomJoinedPayload` is now `{ documentId, connectionId, peers }`. Document
revision remains a durable concept that arrives with M2 storage, at which point it
gets a contract of its own with a name that cannot be confused (`DocumentMeta.revision`
and, if a wire field is needed, something like `documentRevision`).

**Consequences.** No ambiguous `revision` in the M1 wire protocol, and the name
collision is gone before two agents built against it. Cost: M2 must add the
revision field deliberately; that is cheaper than debugging a staleness check that
compared against a room counter. A regression test asserts the payload shape has
exactly three keys, so re-adding a `revision` field cannot happen silently.

---

## D-023 · 2026-02-14 · accepted · Presence/wire cleanup verified as a pre-parallel gate (M1-A0.1)

**Context.** After M1-A0 froze the contract, an adversarial read of the frozen
surface found three ambiguities that would each have produced divergent
implementations in A1/A3 rather than a compile error: the undefined re-join
transition (D-020), two presence channels (D-021), and the `revision` name collision
(D-022). Also, `apps/server` did not yet declare `yjs`/`y-protocols`, which A3 would
have needed and could not add under R3.

**Decision.** Treat these as one final pre-parallel cleanup pass (M1-A0.1) and fix
them before releasing A1/A2/A3, because the cost of changing them rises sharply once
three agents code against them. In the same pass: add the approved server
dependencies, and restate the sync handshake as a **deliberate M1 choice**
(client-initiated) rather than as a `y-protocols` requirement — the previous wording
presented a project decision as a library law, which would mislead anyone reasoning
about whether the direction could change.

**Consequences.** The frozen surface has no known ambiguity left. Cost: one more
contract revision before parallel work, which is the cheapest place to pay it.
Lesson recorded for A0's process: read the frozen contract adversarially *before*
declaring it frozen, not after.



