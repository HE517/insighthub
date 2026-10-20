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

---

## D-024 · 2026-02-14 · accepted · A room is destroyed the moment its last member leaves (M1-A3)

**Context.** M1 has no document store, so a server room is only a relay: a `Y.Doc`
replica for state-vector deltas plus an in-memory `Awareness` instance. The open
question was what happens when the last client leaves. A grace period would let a
reconnecting client re-sync without the server rebuilding state, but it also means
holding a `Y.Doc` and an awareness timer per document anyone ever opened, with no
eviction policy — an unbounded cache in a milestone that deliberately has no cache.

**Decision.** Destroy the room immediately when its participant set becomes empty:
remove it from the registry, call `awareness.destroy()` (which clears the 3 s timer
`y-protocols` installs) and `doc.destroy()`.

**Why immediate rather than graceful.** The cost is bounded and the benefit is
negative. A returning client's `SyncStep1` carries its state vector, so the server
answers from whatever the room holds *now*; an empty room holds nothing, and a client
returning to an empty room is by definition the only writer, so there is nothing for a
grace period to preserve except server memory. Destroying on empty also means the M1
server holds no state that outlives its connections, which is what makes "restart the
server" a non-event in M1.

**Consequences.** No per-document memory growth in a long-running process, and the
empty-room case needs no eviction logic to review. Cost: a room that empties and
refills immediately re-creates its `Y.Doc` — microseconds, paid only when the last
editor of a document actually leaves. Revisitable in M2, when a persisted document
store makes a snapshot cheaper than a rebuild; the change would be local to
`RoomRegistry.#destroyRoomIfEmpty`.

---

## D-025 · 2026-02-14 · accepted · Server-side operational limits are code constants, not contract (M1-A3)

**Context.** A3 needed three numeric policies the frozen contract does not specify: a
heartbeat interval and timeout, and a send-buffer ceiling for slow-client
backpressure. Putting them in `packages/shared` would make every tuning change a
Supervisor-reviewed contract change; leaving them undocumented would make "why 30
seconds" unanswerable in review.

**Decision.** Keep them in `apps/server/src/rooms/constants.ts`, each with its
rationale recorded beside it, and treat them as operational parameters rather than
protocol: no `PROTOCOL_VERSION` bump applies, and no other agent can be broken by a
value change.

| Constant | Value | Reasoning |
| --- | --- | --- |
| `HEARTBEAT_INTERVAL_MS` | 30 000 | Matches the `outdatedTimeout` that `y-protocols` already uses for awareness, so the server's reaper and the clients' awareness expiry agree on a timescale instead of disagreeing. |
| `HEARTBEAT_TIMEOUT_MS` | 10 000 | Generous for any realistic RTT while staying well under one interval; worst-case reap is 40 s. |
| `SLOW_CLIENT_BUFFER_LIMIT_BYTES` | 4 MiB | Far above a normal Yjs update (kilobytes) and far below `MAX_BINARY_FRAME_BYTES` (16 MiB), so only a genuinely stalled reader reaches it. |

The one contractual number involved, `MAX_AWARENESS_CLIENTS_PER_UPDATE`, is imported
from `@insighthub/shared` and enforced as a frame-level drop rather than a socket
close: awareness is ephemeral, untrusted and bounded, so discarding the frame is the
whole remedy — and the frozen vocabulary has no code for it, which is correct, since
an abusive peer is not owed an explanation for a frame the server never accepted.

**Consequences.** Tuning is a one-line local change and a reviewer can check each value
against its stated reasoning. Cost: the heartbeat window is fixed at build time with no
environment override, because M1 has no operational config surface for it and
`apps/server/src/config.ts` is outside A3's ownership. Adding one later is additive.

---

## D-026 · 2026-02-14 · accepted · A room's awareness is a pure relay with no server entry (M1-A3)

**Context.** `y-protocols`' `Awareness` constructor does two things an unaware server
inherits: it assigns `clientID = doc.clientID` (a random id) and calls
`setLocalState({})` — and installs a 3 s interval that republishes that local state.
Measured during M1-A3: a freshly created room immediately held one awareness entry
whose state was `{}`. That is not valid presence. It has no `user`, so a peer would
count a collaborator it cannot render, and `session.getCollaborators()` (which
validates through `awarenessStateSchema`) would filter it out — leaving a presence
count that never matches the rendered list, plus a phantom cursor for a user who does
not exist. Clearing `clientID` alone is insufficient, because the constructor's entry
survives under the id it just assigned.

**Decision.** Make each room's `Awareness` strictly relay-only, in one documented
helper (`suppressServerAwarenessOwnership`): clear `states` and `meta`, set
`clientID = null`, and clear the constructor's interval so the server can never publish
presence about itself.

**Consequences.** `room.awareness.getStates()` contains exactly the entries peers
published, which is what makes "no ghost cursor" a checkable property rather than a
convention, and the server never claims an awareness id a peer might legitimately use.
Cost: the room relies on two documented internals of `y-protocols` (`states`/`meta`
being plain maps, `_checkInterval` being clearable), both covered by tests so a library
change fails loudly instead of silently.

---

## D-027 · 2026-02-15 · accepted · A3's M1 decisions approved, with durable persistence booked as M2 P0 (M1-A0.2)

**Context.** A3 recorded three decisions during implementation (D-024 room destroyed when
empty, D-025 server limits as local constants, D-026 awareness as a pure relay). Each was
reviewed against the frozen contract rather than accepted on report, because each one
narrows behaviour in a way a later milestone could depend on incorrectly.

**Decision.** **Approve all three as written.** Specifically:

- **D-024 (destroy on empty)** is consistent with `docs/CONTRACTS.md` §10.3 — the server is
  a relay and the contract never promised server-side retention. Confirmed by test: a room
  that empties is gone, and the reconnecting client re-seeds from its own replica.
- **D-025 (local constants)** respects the A0/A3 boundary: these are operational
  parameters, not wire contract, so they must not require a `PROTOCOL_VERSION` bump or a
  Supervisor review to tune.
- **D-026 (relay-only awareness)** is required by R14/§9.2, not merely nice: a server entry
  with state `{}` is presence a peer cannot render, and it would make
  `getCollaborators()` disagree with the raw map.

**The M1 limitation this approval depends on, stated explicitly:** **M1 has no durable
server-side document persistence.** A room's `Y.Doc` lives only as long as the room, and
the room dies with its last member (D-024). Therefore:

- A client that **has** local history (IndexedDB from A1's Path 1) can re-seed the server
  after a room was destroyed: it sends `SyncStep1`, the server answers from an empty
  replica, and the client's `SyncStep2` uploads the document again. Convergence is
  restored with no data loss **as long as at least one client with the full history
  returns**.
- A **fresh** client (empty IndexedDB, no prior session) cannot recover content that
  existed before the room was destroyed. Nothing on the server retains it. From that
  client's point of view the document is empty, and it will happily become the seed of a
  new, empty lineage.

That second bullet is a **data-loss window, not a cosmetic limitation**, and it must not be
papered over in the M1 completion report. It is the direct consequence of combining D-024
with the absence of a store.

**Consequence / booking.** **Durable document persistence is M2 P0** — the highest
priority item of the next milestone, ahead of permissions work, and it is recorded in
`docs/TASKS.md`. Its acceptance criterion is precisely the gap above: a returning client
must be able to open a document whose content survived a period when **no** client was
connected. Until that lands, M1's persistence claim is scoped to "some client's local
replica", never to "the server".

---

## D-028 · 2026-02-15 · accepted · A2's single-range diff reconcile is the M1 editor strategy (M1-A0.2)

**Context.** A binding that mirrors `Y.Text` into CodeMirror has to answer "what do I apply
to the editor when the document changed?". Translating `Y.TextEvent.delta` faithfully is
the textbook answer and is genuinely more precise: it preserves the exact edit shape,
including for text that moved. A2 implemented the simpler alternative — compute the
minimal single-range change between the editor's current text and the authoritative
`Y.Text` (common prefix + common suffix) — and reported the tradeoff.

**Decision.** **Accept A2's design for M1.** The reconciliation contract is:

- `Y.Text` is authoritative; the editor buffer is derived.
- On a remote Yjs transaction, compute **one** minimal single-range replacement
  (`singleRangeChange`, UTF-16 offsets, `null` when equal) and apply **at most one**
  CodeMirror transaction per remote transaction.
- The diff is deliberately **not** a general-purpose or Myers diff; it returns exactly one
  replaced range, which is all an attach-to-non-empty-document or a fallback resync needs.

**Why not the delta translator now.** A correct `Y.TextEvent.delta` translator is real work
with real failure modes (delete/retain/insert ordering, attribute-only changes, nested
deltas), and its benefit over a prefix/suffix diff appears only for edits that move text
across the document. The single-range diff is: provably correct for the cases M1 must
handle (attach, resync, ordinary remote edits), constant-time on the common prefix, one
edit shape to reason about, and already covered by tests. M1's exit criteria do not include
"remote edit preserves local selection across a move", so the precision buys nothing the
milestone is judged on.

**Known cost, accepted and recorded.** A remote change that reorders large blocks can
reconcile as a larger replacement than the true editorial delta, which will reset the local
selection/caret to a less precise position than a delta translator would. That is a UX
regression in a narrow case, not a correctness or data-loss issue: the text itself always
converges to `Y.Text`.

**Where this gets re-evaluated.** **A6** owns a real-browser performance pass, which is what
would show whether the reconcile cost matters at scale (e.g. a 5 000-line document with a
remote edit near the top) and whether caret placement regresses visibly. If it does, the
delta translator becomes an M4 item. Until A6 measures it, no claim about editor
performance in M1 is evidence-backed.

---

## D-029 · 2026-02-15 · accepted · Pre-parallel integration prep (M1-A0.2)

**Context.** A1/A2/A3 ran in parallel against a frozen contract and each reported success.
Reviewing the actual repository — not the reports — surfaced four classes of problem that
no single agent could see, because each was a boundary between two agents or between an
agent and the contract:

1. `joinRoomPayloadSchema.protocolVersion` was `z.literal(PROTOCOL_VERSION)`, which made
   `PROTOCOL_VERSION_MISMATCH` **unreachable on the wire**: A3's own comparison in
   `registry.ts` could never run, because the shared parser rejected a differing version as
   a malformed message first. The code existed and was dead.
2. `apps/server` had grown its own varint reader (`rooms/varint.ts`) to read inside sync
   bodies, because it could not import `lib0` and the shared codec only exposed the body,
   not its contents. That is a second wire parser in production, which R12 exists to
   prevent.
3. The root Vitest gate and a directory-local `apps/web/vitest.config.ts` both existed, so
   "what does `pnpm test` run?" had two answers, and `mergeConfig`'s `include`
   concatenation made an unfiltered local run execute the root's files too.
4. The running app still mounted the M0 `useRealtimeChannel` hook, opening a **second**
   `/ws` socket alongside the session's — against R15 and §5.4.

Also found and fixed while validating: a heartbeat test whose assertion contradicted its own
scenario (it asserted the room was destroyed while a second member was still joined), which
made the suite **hang** rather than fail; and a harness quirk where `?? PROTOCOL_VERSION`
silently converted a `null` version into a valid join, hiding a real case.

**Decision.** Fix all of the above as one A0-owned integration pass **before** releasing
A1/A2/A3 for further work:

- Move the version boundary: the schema accepts any integer, the **server** compares and
  answers `PROTOCOL_VERSION_MISMATCH`; non-integers stay `INVALID_MESSAGE` (D-030).
- Move sync-body reading into `packages/shared` as the single wire authority and delete
  `apps/server/src/rooms/varint.ts` (D-031).
- One Vitest configuration at the root; per-package scripts become thin filters over it.
- Unmount the legacy channel; `CollaborativeSession` is the sole owner of the document
  socket.
- Add the missing integration gate: a real A1 client against a real A3 server (D-032).

**Consequences.** The M1 baseline is now verifiable by one command per concern, with no
dead error path, no duplicate wire parser, no duplicate test authority and no second
socket. Cost: this pass touched `packages/shared`, so every agent must re-read
`docs/CONTRACTS.md` §5.2 and §6.4 before continuing — which is the point of doing it while
the code is still small.

**Process lesson (for A0).** Three parallel reports each said "done" and each was locally
true; every defect above lived in the seam between two of them. A contract freeze reduces
ambiguity but does not remove the need to **audit the assembled system** against the frozen
text. The specific tell to watch for: *a frozen error code that nothing can ever emit*
(`PROTOCOL_VERSION_MISMATCH` here) is a strong sign that a validation layer is upstream of
the check that was supposed to produce it.

---

## D-030 · 2026-02-15 · accepted · Version mismatch is a server answer, not a parser rejection (M1-A0.2)

**Context.** With `protocolVersion: z.literal(PROTOCOL_VERSION)`, every version
disagreement produced `INVALID_MESSAGE`. That is the wrong signal: `INVALID_MESSAGE` means
"your envelope is malformed", while the actual situation is "your envelope is fine, but you
speak version N and I speak 2". A client cannot act on the first message, and a future
version handshake (negotiation, or a bounded compatibility window) has nowhere to live.
Worse, it made a frozen error code dead.

**Decision.** Split the two concerns by layer:

| Layer | Responsibility | Rejects with |
| --- | --- | --- |
| `joinRoomPayloadSchema` (shared) | **Structure**: `documentId` non-empty, `protocolVersion` an integer ≥ 0, `mode` in the enum | `INVALID_MESSAGE` for a string/fraction/null/negative/missing version |
| `RoomRegistry.joinRoom` (server) | **Policy**: compare against `PROTOCOL_VERSION` | `PROTOCOL_VERSION_MISMATCH` for any integer that differs |

`PROTOCOL_VERSION_MISMATCH` is **fatal** for the socket (the peer cannot usefully continue)
and must not create a room. Tested for both directions — an older integer and a newer one —
plus every malformed shape, and a regression test asserts the structural layer still
*accepts* a differing integer, so nobody can make the mismatch unreachable again by
"tightening" the schema.

**Consequences.** A version disagreement is now distinguishable from corruption, both on the
wire and in the logs, and the frozen vocabulary is fully reachable. Cost: the version check
is server code that must be exercised by an integration test (structural mocks cannot prove
it), and client code must handle a fatal error at join time rather than assuming a parse
failure.

---

## D-031 · 2026-02-15 · accepted · All Yjs wire interpretation lives in `packages/shared` (M1-A0.2)

**Context.** Reading inside a sync body — which sync message it is, a `SyncStep1`'s state
vector, a `messageYjsUpdate`'s embedded update — is a handful of varint reads. A3 could not
import `lib0` from `apps/server` (pnpm does not expose a transitive dependency, and
`package.json` is review-gated), so it implemented the minimum locally in
`rooms/varint.ts`, with tests proving agreement with `lib0`'s encoder and a clear comment
about why. The reasoning was sound and the tests were honest; the outcome was still wrong,
because it left **two authorities** for the same bytes.

**Decision.** `packages/shared/src/binary-frame.ts` exposes the sync-body accessors, and the
server's local parser is **deleted** (including its test file):

| Helper | Purpose |
| --- | --- |
| `SYNC_MESSAGE_TYPES` | Named `0/1/2`, asserted equal to `y-protocols`' constants by a test |
| `readSyncMessageType(frame)` | Which sync kind, from an already-decoded `DecodedSyncFrame` |
| `readSyncStep1StateVector(frame)` | The state vector a server computes its delta against |
| `readSyncUpdatePayload(frame)` | The embedded update of a `messageYjsUpdate` — **not** the body |
| `readSyncStep2Payload(frame)` | The embedded envelope of a `SyncStep2`, for tests/tooling |
| `decodeSyncFrame(raw)` | Raw bytes → validated `DecodedSyncFrame` |

Two supporting rules follow from it:

1. **No new `lib0` dependency in `apps/server`.** A3 does not need one: every byte-level
   operation it performs is now a shared helper. The `lib0` dependency stays where the
   encoding lives.
2. **Test-side plumbing is separated from wire interpretation.** A3's `TestDecoder` remains
   because `y-protocols`' `readSyncMessage` requires a decoder *instance* and `lib0` is not
   importable there — but it now implements only lib0's decoder contract, while the harness
   reads frame types, sync kinds and payloads through the shared helpers. The distinction is
   documented in the harness, and its two private length-prefix readers were removed.

**Consequences.** One place to change when the wire format moves, one place to review, and
the server cannot drift from the client. Cost: `packages/shared` grew five small functions,
and the accessors are a reviewed surface — but that surface is already Supervisor-gated,
which is exactly where wire knowledge belongs. A concrete payoff arrived immediately: the
hand-rolled helper read the frame type as `bytes[0]`, which is only correct while frame
types stay below 128; the shared `decodeSyncFrame` reads a varint, and a test now pins a
multi-byte frame type as a non-sync frame.

---

## D-032 · 2026-02-15 · accepted · The M1 integration gate must cross the A1↔A3 boundary (M1-A0.2)

**Context.** A1 tested its client against *its own* in-process test server, built from the
shared codec. A3 tested its server against *its own* `TestClient`, also built from the
shared codec. Both suites were green, and both could be green while the two halves disagreed
— each side was proving that it matched the codec, not that it matched the other agent.
Worse, A1 and A3 independently discovered the same two wire subtleties (a sync payload must
not be re-wrapped as a full frame; a `messageYjsUpdate` body is not a bare update), which is
evidence that the seam was under-tested rather than well understood.

**Decision.** Make a **cross-agent integration test** a required part of the M1 gate: a real
A1 client (`createCollaborativeSession` / the real sync provider) against a real A3 server
(`startTestServer`, real `ws` sockets on an ephemeral port), asserting the whole M1 story
end to end:

1. client1 edits → the server relays → **client2 converges**;
2. client2 edits → the server relays → **client1 converges**;
3. client1 disconnects, both sides keep editing, client1 reconnects → state-vector
   incremental sync → **final text converges byte-for-byte**.

Plus awareness interoperability over the same pair of real implementations: client1's
awareness reaches client2's `getCollaborators()`, and a disconnect or room switch leaves
**no ghost collaborator**.

**Why this and not more unit tests.** The failures this catches are precisely the ones unit
tests cannot: two independently-correct halves disagreeing about framing, a relay that
applies a body instead of the update inside it, or a reconnect that re-sends a document
instead of a delta. It is also the only test that exercises the *contract* as a whole rather
than each implementation against its own reading of the contract.

**Consequences.** One more suite to keep green, and it lives in `apps/server` (the side that
owns real sockets) while importing A1's public seam — so it is the one place that legitimately
imports from both apps. Cost: it is a coarse test, so it will not localise a failure; the
agent-level suites remain the right tool for that. Value: it is the gate that would have
caught the `varint.ts` duplication and the "body is not an update" class of bug by
construction.

---

## D-033 · 2026-02-15 · accepted · Browser-only claims stay unverified until A6 runs them (M1-A0.2)

**Context.** M1's remaining unproven surface is browser-specific: real IndexedDB, a real
CodeMirror `EditorView` DOM, real remote-cursor rendering, and interaction latency on a
large document. A1's README already scopes its IndexedDB claims to an in-memory double and
publishes a runbook; A2's suites are DOM-free by design.

**Decision.** Keep those claims explicitly unverified in M1 and assign them to **A6**, not
to A0.2 and not to the agent that wrote the code. The Node-level gate proves wiring,
protocol, convergence and validation logic; it proves **nothing** about a browser.

**Consequences.** The M1 completion report must state which claims are wiring-only. That is
a deliberate accuracy cost (`AGENTS.md` R5: an unverified claim is not evidence) paid in
exchange for not implying that a green test suite means the browser path works. A6's
runbook is the only path to promoting those claims.

---

## D-034 · 2026-02-15 · accepted · A persistence mode seam belongs on the frozen session options (M1-A0.2)

**Context.** A1 needed an injection seam to test the collaboration core in Node, where there
is no IndexedDB, and declared it as a `declare module '@insighthub/shared'` merge in
`apps/web/src/collab/internal/session-options.ts` — an A1-owned file augmenting a
Supervisor-owned interface. A1 flagged this itself and recommended the long-term fix: a
field on the shared interface. The cross-agent integration test then needed the same
capability from a *third* package, where reaching into A1's private module would have been
worse.

**Decision.** Add `persistence?: 'indexeddb' | 'none'` to `CollaborativeSessionOptions` in
`packages/shared/src/collab-session.ts`, defaulting to `'indexeddb'`. A1's
`createDocumentSession` honours `'none'` by resolving a no-op persistence handle, so
`whenSynced` still resolves without the network and `active` is still reached before any
socket (`docs/CONTRACTS.md` §10.1 is unchanged). The local declaration merge keeps working;
removing it is A1's follow-up, not a blocker.

**Why the contract is the right home.** "Does this session persist locally?" is a property of
the session contract, not of one package's test harness, and it now has consumers of
different kinds. The alternative for the integration test was either a hand-written
IndexedDB double (a second, drifting storage implementation — explicitly worse) or importing
A1's private test support from `apps/server` (a boundary violation).

**Consequences.** Production defaults are unchanged; a caller that passes `'none'` loses
offline durability, which is why the option's own doc comment says so. Cost: one more frozen
field and one more way to silently opt out of Path 1, mitigated by the default being durable.

---

## D-035 · 2026-02-15 · accepted · A joining client must not have its roster wiped, and existing awareness arrives after `room-joined` (M1-A0.2)

**Context.** Two independent defects met at one seam and cancelled the feature:

1. **Client.** `onRoomJoined` cleared every remote awareness entry, to stop entries from a
   previous room leaking into a new one. On the **first** join there is nothing stale, so the
   only thing the clear could remove was the roster the server had just sent.
2. **Server.** The existing-awareness frame was emitted from inside `Registry.joinRoom`, i.e.
   **before** `room-joined` — a data-plane frame ahead of the join acknowledgement, which
   `docs/CONTRACTS.md` §4 forbids.

Observed symptom: the server held both awareness entries while the later joiner's
`getCollaborators()` was empty, so a two-client session showed **no** collaborator until
someone republished (up to the 30 s awareness renewal). Diagnosed by fingerprinting the
joiner's map: `meta.size === 2` but `states.size === 1` — the entry was applied and then
removed, which localised the fault to the clear rather than to the relay.

**Decision.**

- The server sends `room-joined` **first**, then delivers pre-existing awareness. To make
  that order expressible, `joinRoom` performs the state transition and returns the room; the
  transport in `ws.ts` owns the send order.
- The client clears remote awareness **only when it has already joined once**
  (`#hasJoinedOnce`). First join: nothing to clear. Re-join or room switch: clear, as before.

**Consequences.** Presence is visible as soon as a second participant joins, and the
"awareness is room-scoped" rule still holds for every case that can actually have stale
entries. Cost: the client carries one boolean of history, and the server's join path has a
required send order that only `ws.ts` may implement — both asserted by the cross-agent
integration test rather than left to a comment.

---

## D-036 · 2026-02-15 · accepted · A relayed `SyncStep2` must be broadcast, not only applied (M1-A0.2)

**Context.** A client that edits while disconnected delivers those edits in its `SyncStep2`
when it reconnects. `DocumentRoom.handleSync` applied that update to the room's `Y.Doc` and
stopped there, while `handleUpdate` applied **and** broadcast. The result was a permanent
split no single-client test could see:

```
after reconnect   server  = "… | online-2 | offline-1"
                  client1 = "… | online-2 | offline-1"   (the reconnecting peer)
                  client2 = "… | online-2"               (never catches up)
```

`client2` never sends an `Update` carrying `offline-1`, because it never saw it — so nothing
would ever deliver it. The server and the reconnecting peer were converged while a third
participant stayed behind indefinitely.

**Decision.** After applying a `SyncStep2`, relay the same update to the rest of the room,
re-framed with the shared codec's `encodeSyncUpdate`. A receiver then applies it through its
ordinary update path, which is the semantics a relay of already-applied content needs; the
`SyncStep2` envelope is an answer to one client's `SyncStep1` and is not what a peer should
receive.

**Consequences.** Reconnect convergence now holds for **every** participant, which is what
`docs/CONTRACTS.md` §10.3 promised. Cost: a reconnect broadcasts an update sized to the
offline delta (not the document — the state vector still bounds it), and the relay is
redundant for a peer that is also re-syncing, where Yjs merge makes it a no-op anyway.

---

## D-037 · 2026-02-15 · accepted · Vite env types are read through a local structural view, not a widened global (M1-A0.2)

**Context.** `pnpm typecheck` was red while `pnpm build` was green:

```
apps/web/src/collab/internal/document-session.ts: TS2339:
  Property 'env' does not exist on type 'ImportMeta'
```

`import.meta.env` is not ECMAScript — it is declared by `vite/client`, which only
`apps/web`'s tsconfig loads. Since the cross-agent integration test imports the public seam
from `apps/server`, **the server project now compiles that web file too**, and there
`ImportMeta` has no `env` member. `pnpm build` never saw it because it compiles each package
with its own tsconfig, and web's own build includes the declaration.

**Decision.** Read Vite's env through a single, local structural view:

```ts
const viteEnv = import.meta as unknown as { env?: { VITE_WS_URL?: string } };
```

and keep `resolveSocketUrl`'s runtime check (`typeof configured === 'string'`) as the only
consumer. Rejected alternatives: adding `vite/client` to `apps/server`'s `types` (hands Vite
globals to the server), and augmenting the global `ImportMeta` (does so for every package
including `packages/shared`). No `any`, no `@ts-ignore`, no deleted code.

**Consequences.** Typecheck is green from any project that compiles the file, and the
knowledge of *which* env variables the collab layer reads now lives in one annotated place.
Cost: one cast with a comment explaining it, and if a second env variable is needed the view
must be extended — deliberately, in one spot.

---

## D-038 · 2026-02-15 · accepted · The cross-agent gate earned its cost three times over (M1-A0.2)

**Context.** D-032 made a real-A1-client ⇄ real-A3-server test part of the M1 gate. In this
pass it found three production defects that no single-agent suite could observe, each one
strictly *between* two agents:

| # | Defect | Why the agent's own suite missed it |
| --- | --- | --- |
| 1 | `SyncStep2` applied without unwrapping `varint8Array` → yjs threw during the handshake | A1's in-process server and A3's `TestClient` were both built from the shared codec, so neither exercised the other's real handshake |
| 2 | Joining client's roster wiped by its own room-scoped clear, combined with a data-plane frame sent before `room-joined` | Both halves were individually correct; the interaction was not |
| 3 | Relayed `SyncStep2` applied but never broadcast, leaving a third participant permanently behind | Each side's two-party tests converged; no test had a third party |

**Decision.** Keep the cross-agent integration test mandatory for M1 and treat "this test is
awkward to write" as a signal about the seam rather than a reason to skip it. Also record the
diagnostic technique that actually located defect 2, because it is reusable: fingerprint the
observer's internal map (`meta.size` vs `states.size`) to distinguish "the frame never
arrived" from "the frame was applied and then removed" — that one measurement collapsed
several plausible hypotheses.

**Consequences.** The gate is coarse and will not localise a failure, so agent-level suites
stay the first tool; the integration test is the one that decides whether the milestone is
real. Cost: it is the slowest suite in the repo and it has needed two harness fixes (join
ordering, and an assertion that pinned a CRDT merge order) — both harness bugs, both fixed in
the harness rather than by weakening the assertions.

---

## D-039 · 2026-10-18 · accepted · M1-P0 集成审计：代为修改、pin 退场，以及两项带到 M2 的缺口 (M1-P0/C2)

> 本条目以**中文**书写：项目负责人要求"给我看的工程报告要写中文"。D-001…D-038 保持既有英文体例，未做改动。

**背景。** A6 的真实浏览器门禁钉住了三个产品缺陷（`P0-1`、`P0-2`、`P0-3`）。A1 与 A2 在各自分支上修好；A0 把两者集成进 `m1-stabilization`（`caa5376`、`0d04161`），并在"把一片红色的 pin 变成可信的绿色"这个过程中，改动了两个其他 Agent 拥有的文件、并把 pin 本身退场。随后 A7 独立复核，提出四项。其中两项无法在 M1-P0 内闭合而不重新打开冻结契约，因此在此**记录为已接受风险**——不悄悄修掉、不削弱、也不留空。

**本条目的每项状态——记录一个风险不等于修复它：**

| 事项 | 状态 | 落脚点 |
| --- | --- | --- |
| 集成期间 A0 改动了 A6 与 A1 拥有的文件 | **已处置并留痕** | §1；边界成立，提交信息点名例外 |
| P0 pin 与 P0-1 workaround shim | **已修复** | §2；pin 删除、shim 移除、断言未动 |
| 本地 presence 写路径不在冻结 seam 内 | **已接受——风险仍在** | §3；M2 用写侧 seam 收口 |
| 全局 IndexedDB 工厂缺少引用计数 | **已接受——风险仍在且未验证** | §4；M2 加安装栈 + 重叠回归测试 |
| A7 的复核报告未入库 | **已闭合——已归档** | §5；原文存于 `docs/agent-governance/A7-m1-p0-review.md` |

### 1. A0 改动 A6 与 A1 拥有的文件（已处置，已留痕）

集成期间 A0 改动了 `tests/browser/**`（属 A6）与 `apps/web/src/collab/tests/support/test-server.ts`、`sync.test.ts`（属 A1）。当时 A6、A1 均无活跃进程。

**为什么必须改。** 替代方案是交出一份门禁不可信的基线：过期的 pin 什么也没断言；两条断言在产品**正确**时会失败；还有一条把"存活 socket 数"当证据（既抖动，又在两者都为 0 时变成空断言）。建立在那些之上的绿色比红色更糟。

**授权依据，两案分述——因为性质不同。**
- A6 这一侧是**项目负责人明确委派**：M1-P0 指令点名要求移除 P0-1 的 pin 与 workaround，并修正那两条断言。
- A1 这一侧**没有被委派**。它记录为 A0 质量门职责下的 **ownership 例外**（`agent-prompts/A0-supervisor.md` §4：集成者必须验证测试是真的、不得接受抖动的门禁），而**不是**把它写成授权。A7 是对它的独立检查。

**守住的边界。** A0 未触碰 A1/A2/A3 的任何生产代码、未改冻结契约、未改 `package.json`。每处改动要么删掉不再描述现实的标签，要么让断言**更强**（用 `viewId` + 挂载增量替代脆弱的绝对值；用归属校验替代"光标必须为零"；用单调计数替代存活计数）。两处例外在提交信息中点名（`19587fc`、`fc542f8`、`9be0e1a`），不埋在 diff 里。

### 2. P0 pin 与 P0-1 shim 退场（已修复）

**删除依据。** 只有契约要求的行为在**未修改**的生产路径上通过，pin 才可以删。这一点在删除之前就已证明：`defect-pin/P0-1`（按构造不加载 shim）在真实 Chromium 中通过，且删除前那次运行已报告 `pinnedFixed: [P0-1, P0-2, P0-3]`。删除后 27/27、无 shim、无 pin，说明每个修复的证据不再依赖 test-only workaround。

**删除范围。** `suite/defect-pins.mjs`（真删文件，跑者的目录发现机制随之注销）、`P0_1_WORKAROUND` 与整条 `withWorkaround` 管线（含横幅与记录进 environment 的 `testOnlyWorkaround` 字段）、九个已过期的 `knownDefect` 标签。**没有任何断言被删除或放宽**；P0-2/P0-3 的场景变成普通的绿色场景。

**A7 的独立结论（原文归档见 §5）。** A7 在 `9be0e1a` 上完成复核，未要求回滚修复。其结论为 **APPROVE WITH CONDITIONS（有条件放行）**，列两项阻塞：C1（让 fatal 重连不变量**可被观测**）、C2（补齐决策留痕并修掉对已删除 `defect-pins.mjs` 的悬空引用）。**两项均已满足**：C1 由 `dd36169` 提供、经 `f2dfe1a` 以真实 merge 集成；C2 由本条记录与 `a06b6ff` 完成。

### 3. 本地 presence 写路径不在冻结 seam 内（已接受，M2 收口）

**事实。** `CollaborativeSession`（`packages/shared/src/collab-session.ts:89`）只暴露 presence 的**读**——`getCollaborators()`、`getLocalAwarenessState()`——以及原始 `readonly awareness` 实例，**没有写方法**。因此 A2 经裸实例发布 presence：`apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx:200-202` 调用 `session.awareness.setLocalStateField('cursor' | 'selection' | 'updatedAt', …)`。

**为什么是问题。** 读侧经 `awarenessStateSchema` 校验，写侧没有。**客户端发布什么形状不由契约拥有**：A2 的一个 bug 就能发出"所有对端都必须拒绝"的状态，契约拦不住。R14 的"原始 `Awareness` 仅作绑定输入"在读侧成立、在写侧被拉伸——单通道不变量未被破坏，但写形状无人治理。

**M1 为何接受。**（a）A2 写入的每个字段都在 `awarenessStateSchema` 内（含 `updatedAt`），今天的载荷合规，缺的是**护栏**而非已存在的缺陷；（b）真实浏览器已覆盖可观测行为（渲染、离开清除、切房不串台）；（c）增加写方法是**冻结契约变更**（版本号 + `docs/CONTRACTS.md` 修订）且 M1 无功能驱动，而 M1-P0 的职责是稳定基线，不是扩展契约。

**M2 方向。** seam 增加 `publishPresence(patch: Pick<AwarenessState, 'cursor' | 'selection'>)`，写入前校验，并把 `readonly awareness` 收窄为"仅绑定输入"类型，使 A2 无法经它写入；提升 `SHARED_CONTRACT_VERSION` 并更新 `docs/CONTRACTS.md` §5/§9。

### 4. 注入环境的全局 IndexedDB 工厂缺少引用计数（已接受，M2 处理，未验证）

**事实（M1 当时的实现）。** `installGlobalIndexedDb`（`apps/web/src/collab/internal/persistence.ts:127`）快照 `Object.getOwnPropertyDescriptor(host, 'indexedDB')`，销毁时还原该 descriptor；当解析出的工厂**就是**全局时短路不改写。`attachDocumentPersistence` 用 `destroyPromise` 只保证**单个 handle** 幂等。**不存在跨 handle 的安装栈或引用计数。**

> M2-P0-3 已实现该缺口：符号改名为 `acquireIndexedDbLease`，并改为 module-level 租约栈 + 每工厂引用计数（D-046、D-054）。本条保留 M1 当时的命名，因为它是历史记录。

**重叠场景的失败链。** A 安装 `FA`（存下 ambient descriptor），B 安装 `FB`（存下 A 的 descriptor）。`A.destroy()` 还原 **ambient**，而 B 仍在运行 → B 的 provider 静默读到 ambient 工厂，**写进错误的数据库且不报错**；`B.destroy()` 再还原 `FA` → **一个假工厂永久留在全局上**。

**影响范围。** 仅当两个及以上**注入**工厂的会话在同一 realm 内重叠。生产不受影响：未传 `options.indexedDB` 时解析出的就是 `globalThis.indexedDB`，身份检查命中，安装根本不发生。所以这是测试支撑与"未来非浏览器宿主"的风险，不是用户可见风险。

**M1-P0 为何不修。** 没有任何测试演练重叠注入，修了也是未验证；正确的修法会改变 P0-1 测试所钉住的 teardown 语义；且它不在 M1 退出条件内。**在集成收尾阶段写未验证的生命周期代码，正是本里程碑要消除的模式。**

**M2 方向。** 以模块级安装栈 + 每工厂引用计数替掉单次快照；只在当前值仍是自己时才还原（身份保护的 pop）；新增"两个重叠注入会话"的回归测试，断言第二个会话仍用自己的工厂、且全局最终与初始完全一致。

### 5. 审计链：A7 报告已逐字归档（已闭合）

A7 的复核现已是仓库产物：`docs/agent-governance/A7-m1-p0-review.md`，即交付时的原文，未编辑。本条目不复述它，其判定措辞按 A7 所写为准。

**为什么这一点在此重要。** 本文 §1–§4 写于报告归档之前，是**独立**得出的（重读代码与提交历史），因此它们是可独立核验的事实，而不是对 A7 叙述的摘要。两者重叠处——非引用计数的全局工厂、presence 写路径、代改范围、缺失的集成报告——结论一致。

**归档不改变的一件事：** 报告内的相对 markdown 链接（如 `apps/web/src/collab/internal/persistence.ts#L127-L161`）是按仓库根书写的，从 `docs/agent-governance/` 下不能解析。它们**按原样保留**，未做改写；请以仓库根为基准解析。

**状态。** A7 列出的两项阻塞均已满足：**C1** 由 `dd36169`（经 `f2dfe1a` 集成，把 120 ms 窗口换成接线的 20 ms / 60 ms 退避与 300 ms 观测窗口，并补上显式恢复与正向对照断言）；**C2** 由本条记录与 `a06b6ff` 中的引用修复完成。

### 6. C1 mutation validation（erratum）

> **更正记录。** M1 收口报告曾把"C1 的变异验证"写成"尚未执行、是 C1 证据链上唯一仍空的一环"。该表述**不成立**：它描述的是 A7 只读审查当时的执行边界（A7 不改产品代码，故未做变异），却被误写成了 C1 的完成状态。正确事实如下。

**C1 mutation validation 已由 A1 完成；A0 在最终 main merge 阶段未重复执行该实验。A7 已独立复核其代码敏感性及零残留状态，因此该项 CLOSED，不存在剩余证据缺口。**

A1 执行的三组变异（临时修改生产代码 → 观察目标用例 → 恢复并核对 hash）：

| 组 | 变异内容 | 被观察的断言 | 结果 |
| --- | --- | --- | --- |
| M1 | 删除 `active = false` | fatal 后不得自动重连（目标测试） | **FAIL（如期转红）** |
| M2 | 删除 `active = false` 与 `closeSocket()` | fatal 后的自动重连断言 | **FAIL（如期转红）** |
| M3 | 删除正常自动重连逻辑 | 正向对照：普通 socket 掉线必须自动重连 | **FAIL（如期转红）** |

三组变异后**生产文件全部恢复，并逐一核对 hash 确认零残留**。A7 Final Closing Review 独立复核了该证据的代码敏感性与零残留状态，确认 **C1 = CLOSED**。

**为什么这条更正必须写进决策记录。** "测试存在"与"测试能抓住它声称守护的回归"是两件事，后者只能靠变异证明。此前把"我没做这个实验"说成"证据链有空缺"，会让读者以为 C1 的证据强度不足；事实相反——实验做了，只是执行者是 A1 与 A7 的独立复核，而不是 A0 在合并阶段重做。

**后果。** M1-P0 基线现在可审计：每处代改都有陈述清楚的依据与应当复核它的具名 owner；pin 退场绑定在不依赖 shim 的证据上；两项剩余缺口有 owner、有里程碑、有具体方向，而不是一句含糊的"已知问题"。代价是两项被接受的风险带入 M2——这才是诚实的当前状态。这里没有为了让套件变绿而削弱任何断言，也没有为了让风险消失而改动任何冻结契约。

---

## D-040 · 2026-10-18 · accepted · M2 范围与状态词：只冻结 P0 三项 (M2-Kickoff)

**背景。** M1 已 CLOSED（`main` = `f3c353e`，tag `m1-closed`）。M2 不能一开工就发散到
权限重设计、AI 编辑器或 UI 改版；它要先把 M1 遗留的三项 P0 收掉。

**决策：M2 只做三项 P0。**

| ID | 内容 | 归属本轮 |
| --- | --- | --- |
| `M2-P0-1` | 服务端 durable persistence | 架构冻结（本轮）/ 实现（下一轮） |
| `M2-P0-2` | presence 写侧 seam | 设计冻结（本轮）/ 实现（下一轮） |
| `M2-P0-3` | 注入式 IndexedDB 工厂生命周期 | 设计冻结（本轮）/ 实现（下一轮） |

明确**不属于** M2：AI 编辑器（M3）、权限模型重设计、UI 重设计、wire framing 变更。
触发重新讨论的条件是出现与持久化正确性直接冲突的证据，而不是"顺手做"。

**Exit Criteria（M2 完成的判据）** —— 只有 `M2-P0-1` 的 A–G 七个验收场景全部通过，
**且** `M2-P0-2`/`M2-P0-3` 已实现并有其回归测试，**且** A6 的 restart/corruption 浏览器门禁
全绿，**且** A7 终审 APPROVE。否则 M2 不关闭。

**Backlog（不在 Exit Criteria 内）**：键击通知扇出优化（D-039 L2）、主 bundle 分块、
`void persistence.destroy()` 的未处理拒绝（L5）、跨浏览器验证。

**状态词，本里程碑强制使用**（此前 M1 多次出现"设计被读成已实现"）：

| 词 | 含义 |
| --- | --- |
| `PROPOSED` | 有价值但未定，可能被否 |
| `FROZEN` | 设计已定，实现方不得自行更改；代码可能还不存在 |
| `IMPLEMENTED` | 代码已合入，测试通过 |
| `VERIFIED` | 有真实运行证据（含浏览器/重启等），可对外声称 |

**后果。** 本轮所有交付一律标注 `FROZEN (design) / NOT IMPLEMENTED`；任何文档不得把
尚未存在的实现写成已具备。代价是文档里出现大量"设计已定但没代码"的段落，这是刻意的：
M2 的第一风险不是设计错，而是设计与实现悄悄分叉。

---

## D-041 · 2026-10-18 · accepted · 服务端持久化后端选用 `node:sqlite` (M2-P0-1)

**背景。** 需要一个能在本仓库既有条件下可靠工作的持久化后端：Windows、Node 22.14.0、
pnpm workspace、无 CI 配置、`AGENTS.md` R3 要求新增生产依赖需 A0 批准。

**决策：使用 Node 内置 `node:sqlite`（`DatabaseSync`），不新增任何依赖。**

**实测证据**（本轮在本机实际执行，非查文档）：

| 能力 | 实测结果 |
| --- | --- |
| 无需 flag 即可 `require('node:sqlite')` | 成功（仅一条 `ExperimentalWarning`） |
| WAL 模式 | `PRAGMA journal_mode` → `wal` |
| BLOB 往返（含 NUL 字节） | 逐字节一致 |
| BEGIN / ROLLBACK | 回滚后行确实消失 |
| 快照替换 + 日志截断同一事务 | `snapshot_seq=3`、`remaining_updates=0`（原子压缩可行） |
| 关闭后重开 | 数据仍在（`snapshot_seq=3`，7 字节） |
| 文件损坏 | 抛 `ERR_SQLITE_ERROR: file is not a database` |
| 目录不存在 | 抛 `ERR_SQLITE_ERROR: unable to open database file` |

**一个必须记住的细节**：损坏的文件在 `new DatabaseSync(path)` 时**不一定抛**，要执行第一条
语句才抛。所以"打开成功"不是健康检查，健康检查必须是 `PRAGMA schema_version` 之类的实际查询。

**被否决的方案与理由：**

| 方案 | 否决理由 |
| --- | --- |
| `better-sqlite3` | 原生模块，Windows 需要 MSVC 构建工具链；新增生产依赖；CI 可移植性下降 |
| `sqlite3` (node-sqlite3) | 原生、需构建、维护性差；异步 API 的收益抵不过部署成本 |
| 手写文件（每文档一个目录 + append-only 文件） | 零依赖，但崩溃一致性、快照原子切换、截断检测都要自己实现；SQLite 免费给出事务 |
| LevelDB / RocksDB | 原生依赖，M2 规模不需要 LSM |
| 内存 + 定期落盘 | 正是 M1 的问题，直接否决 |

**已知代价（写入 D-046 相邻风险清单）：**

1. `node:sqlite` 在 Node 22 标记为 experimental，API 可能变化 → 由 `DocumentStore` 适配器隔离，
   并在升级 Node 时按实测清单复验（见上表）。
2. `DatabaseSync` 是**同步** API，会阻塞事件循环 → 单条 Yjs update 是几十到几百字节，
   可以接受；**snapshot 压缩**可能写整篇文档，必须移出热路径（空闲或驱逐时执行），且要用
   测量而不是猜测定阈值（见 D-042）。

**后果。** M2-P0-1 可以在不新增依赖、不改 CI 的前提下实现，且后端仍可替换（适配器 seam）。
代价是接受一个 experimental API 与同步 I/O 的约束，两者都写进了风险清单而不是被忽略。

---

## D-042 · 2026-10-18 · accepted · 持久化表示：snapshot + update log，Yjs 二进制为权威 (M2-P0-1)

**决策。** 每个文档存 **一份 snapshot + 一条 append-only 的 Yjs update 日志**：

```text
document        (document_id PK, snapshot BLOB, snapshot_seq INT, updated_at INT)
document_update (document_id, seq INT, update_bytes BLOB, created_at, PK(document_id, seq))
```

恢复 = `applyUpdate(snapshot)` → 按 `seq` 升序逐条 `applyUpdate(update)`。

**为什么不用 Markdown 作为服务端 Source of Truth。** 渲染后的 Markdown 丢掉了 CRDT 合并
所需的一切：client id、时钟、删除墓碑、格式标记。用它恢复会把"两个从未离线过的客户端"
变成并发写者，并让已删除内容复活。Markdown 是**投影**，需要时生成，永不作为权威——
与 §0 的单一真相一致。

**去重与幂等（明确决定，不过度设计）。**

- **允许重复 update**：Yjs update 本身是幂等的，重复 apply 不改变状态。
- **不做内容 hash 去重**：为了省几行日志而引入哈希表与碰撞语义，收益不抵复杂度；重复
  写入的代价只是日志里多几行，重放时被 Yjs 吸收。
- **`seq` 的用途只有一个**：给日志一个确定的全序，使重放顺序稳定、压缩时能表达
  "已消费到哪一条"（`snapshot_seq`）。它不是业务语义的版本号。
- **重放最终一致**：因为只做 `applyUpdate`，且 update 之间可交换，重放顺序不影响收敛结果；
  `seq` 只是让行为可重复、可测试。

**压缩（compaction）。**

| 项 | 决定 |
| --- | --- |
| 触发条件 | `document_update` 行数 > 200 **或** 日志字节 > 1 MB，先到者触发；两个阈值都是确定性常量 |
| snapshot 生成 | `Y.encodeStateAsUpdate(doc)`（整个 state），`snapshot_seq` = 被消费的最大 seq |
| 原子性 | 快照替换与日志删除在**同一事务**内完成（已实测可行） |
| 失败恢复 | 事务未提交则快照与日志都保持旧状态，下次重放仍从旧快照开始，不会丢数据 |
| 何时执行 | 不在 update 热路径上；在房间驱逐（最后成员离开）或空闲时执行，避免同步 API 阻塞打字路径 |

阈值是 `FROZEN` 的，但**必须由测试证明**：M2-P0-1 的验收场景 E 要求在超过阈值后压缩、
重启，文档与压缩前逐字节一致（对渲染文本与 `Y.Doc` 内容长度双重断言）。

---

## D-043 · 2026-10-18 · accepted · Hydration barrier：成员关系仍同步，只推迟确认 (M2-P0-1)

**背景。** `joinRoom` 目前在 `RoomRegistry` 里是**同步**的，且 M1 把"单个同步状态转换"写成
了显式不变量并有测试（原子替换、无中间态）。durable hydration 需要异步 I/O。

**被否决的方案：把 `joinRoom` 改成 async。** 它会重新打开 M1 刚关闭的那一类 bug：在 await
期间，socket 可能已经"离开 A 但还没进入 B"，而 `room-joined` 的语义、原子替换的测试和
"一个 socket 最多一个房间"的推理都建立在"这一步不会中途让出"之上。

**决策：两阶段 join。**

```text
阶段 1（同步，保持不变）
  joinRoom 完成成员关系变更：原子替换、peers 计算、旧房驱逐
阶段 2（异步，新增屏障）
  room 需要 hydrate 时，room-joined 推迟到 hydrate 完成之后再发送
```

由此：

1. **成员关系的不变量原样保留**，M1 的原子替换测试继续有效。
2. `room-joined` 本来就是契约里"数据面之前"的那道门（CONTRACTS §4），把延迟放在这里
   不需要改协议。
3. **single-flight**：同一文档的并发 join 共享一次 hydration（一个 Promise），否则 N 个
   加入者会触发 N 次读盘。
4. **hydration 期间到达的 BINARY 帧**进入有界队列（不应用、不回复），屏障放行后按序冲刷；
   **累计 backlog 溢出**是服务端内部条件，房间转 `UNHEALTHY`、参与者收 `INTERNAL_ERROR` 并由
   服务端关闭——**不是** `FRAME_TOO_LARGE`（该码只表示单个 frame 超过帧大小契约）。
   更正理由见 D-050；日志标签 `HYDRATION_BACKLOG_OVERFLOW` 不进入 wire 词表。
5. **中途断开的 socket**：屏障完成后发现 `context.activeRoom` 已变或已断，结果直接丢弃，
   绝不给死 socket 发 `room-joined`。
6. **hydration 失败**（snapshot 损坏/重放抛错）：房间标记 unhealthy，参与者收到
   `INTERNAL_ERROR` 并被断开，房间从内存移除；**不降级为空文档**——把"读不出来"变成
   "看起来是空文档"是数据丢失的最坏形式。

**Registry 与 persistence 的 ownership。** `RoomRegistry` 拥有 eviction 与屏障；
`DocumentStore` 拥有字节与事务；`DocumentRoom` 拥有 `Y.Doc` 与 awareness。三者互不越界
（ARCHITECTURE §7.2）。

---

## D-044 · 2026-10-18 · accepted · 写入顺序 `apply → persist → broadcast` 与 fail-closed 语义 (M2-P0-1)

**决策。** 每条入站 update 固定三步，且 **persist 必须在 broadcast 之前完成**。

**为什么不是 broadcast 优先。** 若先广播再落盘：落盘失败时对端已经应用了它，服务端却永远
无法恢复——这正是"向 peer 宣称一个无法持久恢复的成功状态"。顺序反过来，失败时对端什么
也没看到。

**失败策略（冻结）：**

1. 房间标记 **unhealthy**，拒绝后续 update。
2. 向房内每个参与者发送 `INTERNAL_ERROR`，并由服务端**关闭连接**。
   - 选择 `INTERNAL_ERROR` 而不是新增错误码：它已存在、语义就是"服务端内部故障，细节在日志"，
     且按契约是 **non-fatal**——这正是我们要的客户端语义（临时存储故障不该像 fatal 那样
     永久停掉重连循环）。
   - **不新增错误码，wire 词表不变**（M1 已把 `ROOM_NOT_FOUND` 预留给 M2 的房间语义）。
3. **销毁内存房间**，使内存不能与磁盘分叉：否则下一个加入者会拿到"磁盘上没有"的状态。
4. 作者客户端本地仍持有该 update（它的 IndexedDB），重连后走**既有** state-vector 握手把它
   重新发上来，append 重试。恢复复用既有路径，不写特例。
5. 若同时没有任何客户端持有该 update（作者同时掉线且不再回来），它丢失——这与 M1 的暴露面
   相同，也是这项必须是 P0 的原因。
6. 日志记录错误（含 documentId 与 seq），**不发送**栈、路径或 SQL 给客户端（CONTRACTS §7）。

**后果。** 代价是一次落盘失败会打断房内所有连接（比"只断一个"更重）。这是刻意的：
持久化坏了就意味着整个房间的状态不可信，让所有人重连并从磁盘重新 hydrate，比让一部分人
继续在一个不可恢复的状态上编辑更安全。

---

## D-045 · 2026-10-18 · accepted · presence 写侧 seam 设计冻结，实施需版本 +1 (M2-P0-2)

**决策。** 冻结 `CollaborativeSession.publishPresence(patch)` 设计（正文见
`docs/CONTRACTS.md` §15）：`updatedAt` 由协作层拥有、写入前校验、awareness 仍是唯一
presence 通道、裸 `Awareness` 仅作 binding 输入、部分 patch 合法。

**迁移顺序冻结为**：A1 加 seam（附加，无调用者）→ A2 迁移编辑器并删除自己的 `updatedAt`
记账 → A1 收窄裸 `Awareness`。顺序颠倒会产生一个编辑器无法编译或无法写 presence 的窗口。

**版本影响。** 实施时 `SHARED_CONTRACT_VERSION` 2 → 3；`PROTOCOL_VERSION` **不变**，因为
awareness 字段早已存在，wire 无变化。

**本轮不做的事。** **不改 `packages/shared`**，不实现 seam。理由：这是 breaking interface
变更，必须单独一次改动 + 版本号 + 决策记录（CONTRACTS §13），而不是夹在架构冻结里。

**后果。** M2 的契约变更被精确限定为"一次附加 + 一次收窄"，且客户端与协议各自的影响面
写在文档里，实现方不需要再猜。

---

## D-046 · 2026-10-18 · accepted · IndexedDB 工厂改为 module-level 租约栈，而非单次快照 (M2-P0-3)

**背景。** M1 的 `acquireIndexedDbLease` 只做"保存 descriptor → 还原 descriptor"，只有单个
handle 的幂等（`destroyPromise`），没有跨 handle 的栈或引用计数。两个重叠会话注入不同工厂时：
A 存 ambient、B 存 A 的 descriptor；`A.destroy()` 把全局还原成 ambient（B 仍活着，静默读到
错的库）；`B.destroy()` 再还原成 A 的假工厂，**永久留在全局**。

**决策：module-level 租约栈 + 每工厂引用计数。**

```text
install(factory) → 若 factory === 当前全局：返回 noop（生产浏览器路径，零改动）
                 → 否则 push { factory, previousDescriptor, refCount }
release()        → refCount-- ；归零时：仅当"当前全局仍是我们装的"才 pop 并还原 descriptor
```

必须回答的六个问题（设计冻结，逐条给结论）：

| 问题 | 结论 |
| --- | --- |
| 嵌套工厂（nested） | 栈结构天然支持；只有栈顶租约释放时才回退到上一层 |
| 同一工厂多引用 | 同 factory 的 install 递增 `refCount`，不重复 push |
| 非 LIFO 销毁 | 归零的租约若不在栈顶，只标记失效、不立即还原；等它成为栈顶再回退，避免打乱其它层 |
| destroy 幂等 | 每租约一个 `released` 标志；重复 release 是 no-op（不是抛错） |
| 构造失败回滚 | `createProviderConstructor()` 抛错时立即 release 本次租约，恢复原状 |
| ambient 浏览器工厂 | `factory === globalThis.indexedDB` 时**完全不动**全局，返回 noop——生产路径零退化 |

**必须新增的回归测试**（M2-P0-3 的验收）：

1. 两个重叠会话注入**不同**工厂 → 第二个会话在其生命周期内始终读到自己的工厂；
2. 非 LIFO 销毁（先销毁先装的）→ 全局最终与初始完全一致（descriptor 比较，不比值）；
3. 同一工厂两次 install → 一次 release **不**还原（refCount 仍为 1）；
4. 构造失败 → 全局与初始一致；
5. 生产路径（未注入）→ 全程不写全局，`window.indexedDB` 的 getter 身份不变。

**不是契约问题。** 这条不改 seam、不改消息、不改 schema（CONTRACTS §16 已注明），因此不需要
`SHARED_CONTRACT_VERSION` 变更。

**后果。** 修好的是一个"生产不受影响、注入环境会静默读错库"的缺陷；代价是引入一个模块级单例
状态，必须靠上述 5 个测试守住，而不是靠注释。
---

## D-047 · 2026-10-18 · accepted · Project Owner decisions on the M2 freeze (M2-Patch)

**背景。** M2 Kickoff / Architecture Freeze 提交后，项目负责人对五处开放项给出决定，并要求
把"P0 收口"与"里程碑关闭"分开。本条记录这些决定本身；技术不变量见 D-048…D-052。

| # | 决定 | 落地位置 |
| --- | --- | --- |
| 1 | **权限/认证 = Option A**：三项 P0 收口后进入 **M2 Phase 2 / P1（permission & authentication consistency）**。**M2-P0 Gate ≠ M2 Milestone Closed**。里程碑顺序冻结为 `M2-P0 → permission/auth Phase 2 → M2 final gate → M3 AI`，**AI（M3）不得先于权限上下文** | `docs/TASKS.md` M2、`docs/PROJECT.md` |
| 2 | **durability = Option C**：`synchronous` 可配置。dev/test 默认 `NORMAL`；**production 允许配置 `FULL`**。发布说明必须说明两种 durability guarantee 的差别 | `docs/ARCHITECTURE.md` §7.10、`docs/CONTRACTS.md` §14.2 |
| 3 | **持久化失败继续复用 `INTERNAL_ERROR`**，不新增 wire error code，**`PROTOCOL_VERSION` 不变** | `docs/CONTRACTS.md` §14.4 |
| 4 | **压缩阈值先冻结 200 updates OR 1 MB log（先到者触发）**；A6 用真实负载校准，**若校准后修改阈值必须记录 decision** | `docs/ARCHITECTURE.md` §7.4、`docs/TASKS.md` M2 |
| 5 | **Agent worktree 按派发时创建**，不提前批量创建 | `docs/TASKS.md` M2 |

**为什么把 Gate 与 Milestone 分开（决定 1 的实质）。** 三项 P0 是"把 M1 的数据丢失窗口补上"，
权限/认证是"谁能写这个文档"。二者混在一个 Gate 里会导致两种坏结果：要么持久化被权限工作
拖住（继续丢数据），要么里程碑在没有任何授权的情况下被宣布完成（把 `viewer` 能改文档的
状态当成已交付）。分开之后，每个 Gate 的判据单一、可独立验证。

**后果。** M2 的完成路径变成两段，且 M3（AI）被显式排在权限之后。代价是 M2 看起来"更长"；
收益是不会有任何一个阶段以"其他部分还没做"为由宣布完成。

---

## D-048 · 2026-10-18 · accepted · 每个文档的 durable mutation 必须经过单一 FIFO pipeline (M2-P0-1)

**决策。** 同一 document 的 durable mutation 串行化，`apply → persist → broadcast` 三个阶段的
生命周期**不得交错**；不同 document 可以并行。

**为什么这不是"实现细节"。** 如果允许 U1 的 persist 与 U2 的 broadcast 交错，就存在这样的
窗口：服务端已经把 U2 广播给对端，而自己的持久化顺序尚未确定（甚至 U1 落盘失败）。此时
"对端看到的状态"与"服务端能恢复的状态"出现分叉，而分叉一旦产生就无法通过重连自动修复——
重连只会把两边的差异当成并发编辑合并。

**为什么明确写成 adapter-independent。** 当前 `node:sqlite` 的 `DatabaseSync` 天然同步，串行
是"碰巧成立"的；一旦换成异步 adapter（或有人在 persist 里加 `await`），交错就会悄悄出现。
把不变量写在 seam 上，任何后端都必须满足；写上"不得依赖当前后端恰好同步"这条，是为了防止
未来有人用"现在是同步的"来反驳。

**失败即停（point 4 是最容易漏的）。** 首个 persist 失败后：房间 `UNHEALTHY`、不再接受
mutation、失败的那条**不广播**、**已排队但未执行的后续 mutation 也不广播**（不是"继续排空
队列"）、参与者收 `INTERNAL_ERROR` 并被关闭、内存房间销毁、**已提交的历史不回滚**、作者
客户端靠自己的 Yjs 副本在重连时重新补齐。如果继续排空队列，就等于对外发布服务端无法恢复
的状态。

---

## D-049 · 2026-10-18 · accepted · Room 状态机 CREATED → HYDRATING → READY → UNHEALTHY → DESTROYED (M2-P0-1)

**决策。** 房间生命周期显式建模为五个状态（正文见 `docs/ARCHITECTURE.md` §7.5），并冻结
每个状态的行为边界：

| 状态 | 关键约束 |
| --- | --- |
| `CREATED` | 只有身份与成员关系；`Y.Doc` 为空 |
| `HYDRATING` | single-flight 加载；**不发 `room-joined`**；**不执行** Yjs 数据面；BINARY 帧只进有界队列 |
| `READY` | 只有此时才发 `room-joined`、冲刷队列、开始正常握手机制 |
| `UNHEALTHY` | hydration 或 persist 失败；不再接受 update；不广播；`INTERNAL_ERROR` + 关闭 |
| `DESTROYED` | 终态；**不删除 durable state**；下次 join 新建房间并重新 hydrate |

**两条容易写漏的义务：**

1. **hydrate 期间断开的 socket 不得被重新接纳**——屏障完成后必须重新校验 `activeRoom` 与
   socket 存活状态，否则会出现"迟到的 `room-joined`"发给一个已经离开的连接。
2. **`UNHEALTHY` 不得回到 `READY`**——恢复只能靠销毁重建，否则内存会被"半修复"成 store 里
   并不存在的状态。

**为什么用状态机而不是注释。** 这些约束跨越 registry、room、transport 三层，靠注释守不住；
写成状态机之后，每个转换点都必须回答"现在是哪个状态、允许做什么"，也就自然产生了 D-048 与
D-050 的判据。

---

## D-050 · 2026-10-18 · accepted · hydration backlog overflow 是 `INTERNAL_ERROR`，不是 `FRAME_TOO_LARGE` (M2-P0-1)

**背景。** Architecture Freeze 初版写的是"队列溢出 → `FRAME_TOO_LARGE` 关闭"。那是错的。

**决策。** `FRAME_TOO_LARGE` 的语义**只**表示"单个 frame 超过 frame-size contract"。
hydration 期间**累计 backlog** 溢出是服务端内部条件，因此：房间 `UNHEALTHY` → 参与者收
`INTERNAL_ERROR` → 服务端关闭连接。内部日志可以打 `HYDRATION_BACKLOG_OVERFLOW` 标签，但
**该标签不进入 wire error-code vocabulary**，也不改 `PROTOCOL_VERSION`。

**为什么这个区分重要。** `FRAME_TOO_LARGE` 会让客户端得出"我发的东西太大"的结论，从而
（合理的）去拆分或减小帧——但真正的问题是服务端还没准备好接收任何数据帧。用错错误码会把
排查方向引向协议层，而问题在生命周期层。

---

## D-051 · 2026-10-18 · accepted · Server 启动时必须 capability-check `node:sqlite`，禁止 memory-only fallback (M2-P0-1)

**决策。** 服务端在开始监听前，必须实际验证当前 Node runtime 提供被测试过的 `node:sqlite`
API（`DatabaseSync`、`exec`、`prepare`、`StatementSync#run/#get/#all`、BLOB 参数与结果、
`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`、`PRAGMA journal_mode`）。验证方式是在数据目录开一个
一次性库、**执行一条语句**、往返一个 BLOB。

- 不支持 → **启动失败**，给出指名运行时要求的清晰诊断，**不启动 realtime server**。
- **禁止**降级为 memory-only：静默降级正是 M1 的数据丢失模式。
- **不新增第三方 SQLite 依赖**；缺 API 的答案是升级 Node，不是加包。
- 最小运行时要求记录在 `docs/TASKS.md`。

**为什么必须执行一条语句而不是只 `new DatabaseSync()`。** 实测（D-041）：损坏或不可读的
文件在构造时**不一定抛**，要到第一条语句才抛。只构造不查询的"健康检查"证明不了任何事。

---

## D-052 · 2026-10-18 · accepted · `append` 的 sequence 分配与写入必须原子 (M2-P0-1)

**决策（store 不变量，不规定具体 SQL 写法）。**

1. `append(documentId, update)` 必须**原子地**：为该 document 分配**严格递增**的 sequence →
   写入 update bytes → 返回 committed sequence。
2. **两个并发 caller 不得得到相同 sequence**。
3. `snapshot_seq` **只能**指向已经 durable committed 的 sequence。
4. `compact()` 的"新 snapshot + `snapshot_seq` 前进 + 删除已消费日志行"必须在**同一 SQLite
   事务**内完成（D-042 已实测可行）。

**为什么把它写成不变量而不是实现方案。** 用 `MAX(seq)+1`、用独立计数表、还是用 SQLite 的
`AUTOINCREMENT`，都属于实现选择；但"编号不重复、不复用、快照指针不越界、压缩原子"是正确性
条件。写成不变量后，A3 可以自选写法，A6 也能据此设计并发测试（验收 H）。

**与 D-048 的关系。** D-048 保证同一文档内不会有两个 mutation 同时进入 store，因此正常路径
下并发分配根本不会发生；D-052 仍然要求 store 自身具备该性质，因为**不变量不应依赖调用方的
良好行为**，否则一旦 pipeline 被重构，corruption 会以"偶发重复 seq"的形式出现。

---

## D-053 · 2026-10-18 · accepted · Gate-driven autonomous handoff：A0 成为正式 Dispatcher (M2)

**背景。** 在此之前，每一轮结束后项目负责人都要回答"下一步让谁做什么"。这不是监督，而是把调度
工作外包给了他：他必须重新建立上下文、重新推断依赖、再口述一遍任务。M1 的实践证明这套流程能跑，
但成本错位——最贵的人力在做最机械的编排。

**决策：项目采用 Gate-driven autonomous handoff。**

1. **A0 是正式 Dispatcher / Supervisor。** 每个 Gate 结束后由 A0 判定状态并直接派发。
2. **`AUTO_CONTINUE`**（七条同时成立才可）：当前 Acceptance 全 PASS；下一步已在冻结的
   TASKS / ARCHITECTURE / Agent Plan 中；不改 scope；不推翻 frozen decision；不产生新的产品级
   语义；不需破坏性 Git；无 unresolved blocker。此时 A0 **必须**直接产出 Gate 判定、DAG、
   可启动的 Agent、**每 Agent 一份完整可复制 prompt**、worktree/branch 创建指令、并行关系与
   集成顺序——**不得**以"请项目负责人决定下一步"结束。
3. **`OWNER_DECISION_REQUIRED`** 只在九类情形触发：产品 scope 变化；milestone 边界变化；
   安全 / 权限 / 数据耐久性承诺变化；需推翻冻结架构或契约；wire protocol 需非预期变更；
   引入重大新依赖或运行时约束；两个方案都合理但影响产品行为或发布承诺；需要破坏性 Git 或改写
   共享历史；需求互相矛盾且工程判断无法解决。提问必须给 Option A/B/C + 影响 + 推荐，
   **不让负责人从零设计**。
4. **A1–A7 的报告必须追加 `## Next Handoff`**：状态、建议下一棒、base（branch + SHA）、为什么、
   已满足的依赖、可直接复制的 prompt。**建议权属于 Specialist，调度权属于 A0。**
5. **即使门禁全绿也不得由 Specialist 自行跨越**：merge main、milestone CLOSED、删除 milestone
   tag、push / 建 remote、改 milestone scope、推翻冻结架构。merge main 与 milestone close 由 A0
   在 A7 APPROVE 后生成操作计划并向负责人报告"已达到 release gate，准备执行"，**执行前仍需一次
   明确授权**。

**为什么这条要写进仓库而不是只停在对话里。** A1–A7 的会话读取的是 `AGENTS.md` 与
`agent-prompts/**`；策略不落盘，Specialist 就不会输出 `Next Handoff`，A0 也就拿不到它需要的
输入。所以本条同时改了 `AGENTS.md` §4.1（第 14 项）、`agent-prompts/COMMON.md` §8、
`agent-prompts/A0-supervisor.md` §8。

**后果。** 负责人从"每轮派活"退到"只在 Gate 与决策点出现"。代价是 A0 每轮要写更长的派发文本
（每个 Agent 一份完整 prompt，而不是一句话）；收益是上下文与依赖的推断只做一次，且写在可审计的
地方。风险是 A0 可能滥用 `AUTO_CONTINUE` 绕过本该询问的决策——因此七条被写成**同时成立**，
且第 3 条把触发条件列成封闭清单：任何一条成立就必须停。

---

## D-054 · 2026-10-18 · accepted · M2-P0-1 / M2-P0-3 集成期的 Supervisor engineering decisions (M2)

**背景。** A3（`5094ffd`）与 A1（`97f4a32`）分别交付 M2-P0-1 与 M2-P0-3，集成时出现若干需要定性的
工程选择。它们都不改变产品语义、不改 frozen architecture 的实质、不改 wire，因此属于 Supervisor
权限内，不上升为 Project Owner Decision。

**1. A1 的 test seam：保留 `PersistenceAttachOptions.loadProviderConstructor`（批准）。**

| 维度 | 判定 |
| --- | --- |
| 可见性 | **internal-only**：类型在 `collab/internal/persistence.ts`，不在 `CollaborativeSession`、不在 `collab/public.ts` |
| 必需性 | **optional**，production caller 一律不传；不传时等价于 `createProviderConstructor` |
| 用途 | 验证"provider constructor 抛错 → 租约回滚 → 全局复原"这条路径 |
| 被否替代 | `vi.resetModules` 会重新加载模块，等于在测试里制造**第二个 module singleton**，而本任务要测的正是 module-level 租约栈；用它测出来的不是同一份状态 |
| 边界 | 不扩大 public seam、不扩大 `CollaborativeSession`、不需要版本号变更 |

**2. A3 的五项工程决定。**

| # | 决定 | 理由 |
| --- | --- | --- |
| 1 | `DocumentStore.append` 返回 **`Promise<number>`**（committed sequence） | 与 `CONTRACTS.md` §14.7 一致：调用方需要知道自己拿到的序号，才能表达"已提交到哪一条"。`ARCHITECTURE` §7.3 的 `Promise<void>` 是冻结文本里的笔误，已修正 |
| 2 | runtime capability check 必须验证**真实 data path**；删除"路径不可写时可退回 `:memory:`" | 生产启动若在不可写的目录上静默改用内存库，就是把 M1 的数据丢失模式换个地方重演。真实目录不可用 → **启动失败** |
| 3 | compaction：M2-P0 只接受 **eviction-time compaction** | 空闲压缩属于性能优化，纳入 backlog；不在本 P0 扩大范围 |
| 4 | 持久化内部故障的 WebSocket close code 保留 **1011** | 1011 = "服务端内部错误"，如实描述原因；1008 = policy violation，会误导客户端与运维。1008 仍用于协议/策略类错误 |
| 5 | `attachWebSocketServer` 的 **no-store 兼容路径**接受为 internal/test seam | 见下三条义务 |

**no-store seam 的三条义务（A7 后续检查）：**

1. **production `index.ts` 必须始终打开 durable store**（`await openDocumentStore(config.dataPath)`）；
2. **production durable 初始化失败必须拒绝启动**（`exitCode = 1` + 清晰诊断），不得降级；
3. isolated tests 可以显式走 no-store 兼容路径，但该路径在 production 不可达。

A3 还加了一条**反向**防线：`attachWebSocketServer` 在 `config.dataPath` 已配置却未收到 store 时
**直接抛错**，让"忘了打开 store"变成启动失败而不是静默无持久化。这条比注释可靠，予以保留。

**3. 符号重命名：`installGlobalIndexedDb` → `acquireIndexedDbLease`。**

M2-P0-3 把"保存快照再还原"改为租约栈，"install"一词已不能描述行为。当前实现与设计文档统一改为
`acquireIndexedDbLease`；`docs/agent-governance/A7-m1-p0-review.md` 与 D-039 的 M1 事实描述**保持
原样**（它们记录的是当时的代码），D-039 §4 只加一句注解指向新名。

**4. Tooling：本轮 root test runner 未复现挂起。**

`pnpm test` 在 integrated HEAD 上 **42.7s 完成**（vitest 257 + server 105）。M1 期记录过的
`TOOLING-P1` 间歇挂起本轮未复现，因此本轮不创建 tooling backlog，也不再把它与任何 Agent 的
交付物关联。

**后果。** 集成期没有出现需要项目负责人裁决的架构冲突；四项文本不一致（`append` 返回类型、
`:memory:` 回退、compaction 范围、close code）被就地修正，两项（test seam、no-store seam）被
明确追认并附上 A7 可核查的义务。

---

## D-055 · 2026-10-18 · accepted · M2-P0-2 seam 合入：A0 ownership 例外与 A6 交付追认 (M2)

**背景。** A1（`6714ca2`）交付 presence 写侧 seam，A6（`231253a`）交付 durable persistence 的浏览器
门禁。A1 的报告标 `partial`：**给冻结 seam 加必需成员会把 A2 的测试替身打断**，而那个文件属 A2。
A6 的报告提出四项需要定性的问题。本条记录本轮的处置。

### 1. A1 的卡点成立，A0 以具名 ownership 例外补齐（已解决）

**被复现的事实**：`FakeCollaborativeSession` 用 `implements CollaborativeSession` 声明自己是
**编译期实现者**；给接口加必需成员后 `apps/web/src/features/**` 出现 **21 个 tsc 错误**，A1 的代码
**0 个**。`docs/CONTRACTS.md` §15.3 写的 "additive, no callers yet" 只描述了**调用方**，漏掉了
**实现者** —— 这是冻结文本的措辞缺陷，不是 A1 的实现缺陷。

**处置**：A0 在 `agent/a1-m2-presence` 上加一个提交（`054d87e`），只改
`apps/web/src/features/editor/testing/fakeCollaborativeSession.ts` 一个文件（+23 行），提交信息
点名例外。先例：D-039 §1。

**比 A1 建议的写法更保守的地方**：替身**复用** `@insighthub/shared` 的 `parsePresencePatch`，
而不是手抄一份合并/校验逻辑。理由与 A1 选择把校验放在 shared 的理由相同——替身若自带第二套规则，
测试就会在"生产会拒绝的 patch"上通过，等于把 seam 要消除的漂移搬到测试里。

**为什么不让 A2 先做**（否决选项 B）：A2 的分支此刻还没有 `parsePresencePatch`，只能先手抄一份，
之后又要改一次；那是在引入该 seam 正要消除的重复规则。

**为什么不允许把成员改成可选**（否决选项 C）：偏离 §15 冻结形状，且替身不实现时 A2 的测试会
静默通过（presence 永不发布）。

**结果**：本分支 typecheck 21 → **0**，`pnpm test` **284 + 105** 全绿，`pnpm build` exit 0；
随后合入 `m2-stabilization`（`b40ba3c`）。

### 2. A6 的交付追认

| 项 | 处置 |
| --- | --- |
| harness 缺陷（`DevToolsActivePort` 读取竞态导致 `EBUSY` 假失败） | **接受修复**：假失败会污染证据，比产品缺陷更危险。属 A6 域（`tests/browser/lib/chrome.mjs`） |
| `tests/browser/lib/durable-store.mjs` 绕开服务端直读 `insighthub.db` | **保留为常驻工具**。代价是与生产 schema 和 `Y.Text` 键名 `'content'` 耦合；schema 变更时必须同步，否则它会"找不到"（不会静默通过）。已列入 schema 变更 checklist |
| F 的失败注入依赖 `SQLITE_BUSY_TIMEOUT_MS = 5000` | **接受**：调大该常量会让 F 超时变红，不会假绿 |
| K / D / H / I 的覆盖率 | **不在本条决定**，作为 Gate 判据问题上报项目负责人（见报告 Need Owner Decision 第 1 条） |

### 3. 无编辑 join 仍写 2 字节 update：记录为已接受偏差

A6 观察到打开文档但不输入时，durable 日志每次 join 仍增加 1 行（2 字节）。原因：客户端回复的
`SyncStep2` 会走 `apply → persist → broadcast`，空文档的 `encodeStateAsUpdate` 是 2 字节。

**处置：接受为已记录的偏差，不修，进 backlog。** 理由：无内容污染、无数据丢失；修法是"不改变
struct 时跳过 persist"，那要改持久化热路径并判断"空 update"，风险大于收益，且扩出 P0 范围。
`ARCHITECTURE` §7.3 的 "persists it on first write" 已按实际行为改为 "on first join or write"，
避免文档与实现继续分叉。

**后果。** 本轮没有出现需要项目负责人裁决的技术冲突：一处集成顺序缺陷被复现并用最小补丁闭合，
四处 A6 的建议被追认或记录，一项文档措辞与实现对齐。A1 报告的 `partial` 因此转为**已合入且全绿**。

---

## D-056 · 2026-10-18 · accepted · Persistence Acceptance Evidence 分层（M2-P0 Gate 判据） (M2)

**背景。** `M2-P0 Exit Gate` 第 1 条原文是"A–K 全部通过"，且默认每项都要浏览器证据。A6 在真实
Chrome + 真实进程 + 真实磁盘上交付后发现：其中 4 项在当前 production 实现下要么不需要浏览器证据
（D/H/I 的确定性在 Node 层更精确），要么**结构上无法从 wire 形成**（K）。若维持字面要求，Gate 将
永远无法通过；若直接删掉 K，则是**降低验收标准**——两者都不能接受。

**决策（Project Owner，Option A）：分层而非删除。全部十一项仍必须 PASS，变化的只是每项所要求的
evidence layer。**

| 证据层 | 场景 | 要求 |
| --- | --- | --- |
| **Browser required** | **A / B / C / E / F / G / J** | 真实 Chrome + 真实后端进程（含 pid 变化）+ 真实磁盘；"内容还在"必须由**空 profile 的新浏览器**验证 |
| **Node deterministic evidence sufficient** | **D / H / I** | 可复现的确定性用例（`apps/server/src/persistence/*.test.ts`），不要求浏览器 |
| **K** | K | 见下 |

**K 的正确表述（必须原样保留其限定条件，不得简化为"K 永久不可达"）：**

> Node 级可控 hydration 测试 + room-state-machine / error-code 机制证明；
> 在当前 production `SqliteDocumentStore` 的**同步 hydration** 实现下，wire/browser 无法稳定形成
> hydration backlog，因此该项的 browser evidence 目前 **N/A**。
> **若未来 store 变为真实 async I/O，或 hydration timing 改变，必须重新评估 K，并在可达时恢复
> browser-level validation。**

**机制根据（由 A6 实测，非推测）**：`SqliteDocumentStore.load` 虽为 `async`，内部 SQLite 工作同步，
`await` 之后的续体在同一轮微任务内完成重放并释放屏障。因此**在 production 的同步 store 加常规浏览器
客户端下，backlog 不可稳定构造**：客户端通常每帧一次 flush，微任务队列会在下一个宏任务前清空。
实测：6001 行日志 + 400 帧突发，`room-joined` 27 ms 到达，无 `FRAME_TOO_LARGE`，服务端正常应答 553 帧。

> **措辞更正（A7 · P3，2026-10-18）。** 本节原写"每个 WebSocket 帧是独立宏任务，因此 BINARY 帧抵达时
> 房间**必然**已是 `READY`"——那说得过强。同一 TCP 读内的多帧会被 `ws` 在**同一宏任务**里同步 emit，
> 而 `handleBinaryFrame` 的生命周期门在任何 `await` 之前同步判定，所以一次性写入 `join-room` + 大量
> BINARY 帧的客户端**可以**进入 `HYDRATING`。这正是 K 的 Node 用例（用可控 store 阻塞 hydration）
> 能稳定触发该分支的原因。**结论不变**：该分支是**正确且被 Node 覆盖**的，只是"浏览器层不可稳定构造"，
> 不是"不可达"。不要因为它难构造就把它当成死代码删除。

**明确不做的事：不为 K 添加 production delay seam。** 把一个不可达路径变成可注入延迟，会增加攻击面
与热路径分支，只为让一个测试可见；代价与收益不成比例。若将来 store 真变为异步 I/O，K 自然可达，
届时补浏览器证据即可。

**后果。** Gate 判据与可获得的证据一致，且没有一项被豁免：K 仍有 Node 级用例与机制证明，只是承认
它在当前实现下的浏览器层 N/A，并写明了**重新评估的触发条件**。代价是判据表达从"一句话"变成"分层
表格"——但一句永远无法满足的话不是判据。

---

## D-057 · 2026-10-18 · accepted · M2-P0-2 是三步迁移；A7 不得在 step 3 前启动 (M2)

**背景。** 上一轮派发 A2 后，A0 的 Next Handoff 写成了"A2 完成后 → A7 M2-P0 Exit Review"。这是
**调度错误**：`M2-P0-2` 是三步迁移，A2 只做第 2 步。

**正确的三步（顺序冻结，源自 D-045 §15.3）：**

| 步骤 | 内容 | Owner |
| --- | --- | --- |
| 1 | `publishPresence` 附加 seam + `updatedAt` 归协作层 + 写入前校验 + `SHARED_CONTRACT_VERSION` 2→3 | A1 |
| 2 | 编辑器迁移：不再写裸 `Awareness`、不再自维护 `updatedAt` | A2 |
| 3 | 收窄裸 `Awareness` 暴露（仅作 binding input） | A1 |

**决策：**

1. **`M2-P0-2` 只有 step 1/2/3 全部完成并合入后，才可标记 COMPLETE。** step 2 完成不等于
   presence seam 完成——此时调用方已迁移，但**类型层面仍允许**任何人写裸实例。
2. **A7 的 M2-P0 Exit Review 必须在 step 3 合入之后启动。** 修正后的 DAG：

```text
A2 step 2  →  A0 integrate  →  A1 step 3  →  A0 integrate
           →  integrated full gates + A6 regression（必要时）
           →  A7 M2-P0 Exit Review
```

3. **step 3 的 base 必须是 step 2 合入后的 `m2-stabilization` HEAD**，否则收窄会先打断编辑器
   （step 2 之前编辑器仍是裸实例的写者）。

**为什么这个顺序不能压缩。** step 3 是"把写入口撤掉"：在 step 2 之前做，编辑器会编译失败或无法
发布 presence；在 step 2 之后跳过它，`D-045` 承诺的"裸 `Awareness` 只作 binding input"就只是注释，
而 `D-039 §3` 记录的缺口（写侧无治理）只修了一半——调用方守规矩了，类型并没有拦人。

**后果。** M2-P0 的完成路径多了一个往返（A1 回来做 step 3），换到的是"契约承诺真的被类型执行"而
不是"大家记得别乱写"。同时这条修正记录在案，避免下一次把三步当成一步。

---

## D-058 · 2026-10-18 · accepted · presence seam 收窄为 `AwarenessBinding`，`SHARED_CONTRACT_VERSION` 3 → 4 (M2-P0-2 step 3)

**背景。** `M2-P0-2` 的三步里，前两步（seam、编辑器迁移）让**调用方**只走一条写路径，但
`readonly awareness` 的类型仍是裸 `Awareness`：任何调用方可以重新 `setLocalState*`，绕过
`parsePresencePatch` 校验与 `updatedAt` 归属，编译器不会拦。也就是说 §15.2 规则 4 当时只是**注释**。

**决策。**

1. **新增 `AwarenessBinding` 并把它作为 seam 上 `awareness` 的类型：**

```ts
export interface AwarenessBinding
  extends Pick<awarenessProtocol.Awareness, 'clientID' | 'on' | 'off'> {
  getStates(): ReadonlyMap<number, unknown>;
}
```

2. **`SHARED_CONTRACT_VERSION` 3 → 4。** 这是**移除成员**，v3 下能编译的
   `session.awareness.setLocalStateField(...)` 在 v4 下是 `TS2339`。机械证据：把 seam 改回宽类型后，
   `@ts-expect-error` 立即变成 `TS2578`（未使用的指令）——同一份代码在两种类型下一个能编译、一个不能，
   这就是 breaking 的定义。留在 3 等于向后续依赖版本号判断兼容性的 Agent 发错误信号。
3. **`PROTOCOL_VERSION` 保持 2。** wire 未变：awareness 帧本来就带 cursor/selection，本轮只改 TS 面。
4. **`getStates()` 声明为 `ReadonlyMap` 而不是 `Pick<Awareness,'getStates'>`。** 上游签名返回**活 Map**，
   直接 `Pick` 会留下 `getStates().set(...)` 这条披着读接口的写通道。
5. **`clientID` 保留为必需成员**（与我派发单里写的"可选"不一致）。依据是消费方实测：A2 的
   `remoteCursors.ts` 中 `AwarenessView` 把 `clientID` 声明为必需，而 `session.awareness` 正是被传进那个
   参数位置的。**下限由消费方实测决定，不由派发单的措辞决定**——这是本轮派发单的一处偏差，以实测为准。
6. **`DocumentSession` 的类成员也收窄，不只是接口。** 先用实测确认：只改接口时 `typecheck` 是 0 错误，
   但 `session.awareness.setLocalState(...)` 在 A1 自己的测试里**仍然可编译**（结构化协变允许宽类满足
   窄接口）。验收要求"在 `apps/web/src/collab/**` 中不可编译"，所以必须连具体类一起收窄。

**验收由负向类型断言承担，而非注释**：17 条 `@ts-expect-error`（shared 11 + collab 6），撤销收窄即
`TS2578` 变红。A0 另用一次性探针在 `features/**` 中独立验证：`setLocalStateField` →
`TS2339: Property 'setLocalStateField' does not exist on type 'AwarenessBinding'`，
`getStates().set()` → `TS2339`（探针已删除）。

**已知边界（不做的事）：** 只读是**类型级**的，运行时仍返回真实 `Map` 实例（不包装，以免破坏
`collectValidAwarenessStates` 与 `y-protocols` 语义）。因此 `getStates() as Map<...>` 这类**显式**下行
转换仍可写——那是一次代码评审能看见的逃逸，不是类型漏洞。要做成运行时不可写需要返回包装对象，
代价是引入假的 `ReadonlyMap` 与身份不等，收益不抵成本。

**后果。** `M2-P0-2` 三步齐备，"裸 `Awareness` 只作 binding input"从注释变成类型约束；代价是版本号
跳到 4（workspace 内已被 `tsc` 全量覆盖，无隐藏破坏），以及 `getStates()` 的只读只是类型级这一条
已记录的边界。

---

## D-059 · 2026-10-18 · accepted · M2-P0 Exit Review 后的四项修正与留痕补记 (M2)

**背景。** A7 在 `be6955e` 上完成 M2-P0 Exit Review，结论 **APPROVE**，同时 pin 住 4 项缺陷
（P1 文档状态、P2 跨域留痕、P3 措辞、P4 evidence note）。四项均非 Gate 阻断项，但 A7 判定 P1
必须在 release commit 内修正后再打 tag。本条记录修正内容与 A0 的流程失误。

### P1（文档事实错误，已修正）

契约与架构的 **section 头**在 P0-1/P0-3 合入后仍写着 "NOT implemented" / "No code exists yet"，
TASKS 的 M2 章节头与范围表也还写着"没有任何 M2 生产代码"。这是**与实现相反的事实陈述**：下一位读者
（尤其 M3 的 AI 工作）会据此误判 store seam 是否可用。

| 位置 | 修正 |
| --- | --- |
| `CONTRACTS` §14 标题与状态行 | `FROZEN design, NOT implemented` → **`IMPLEMENTED (M2-P0-1)`**，指向 `apps/server/src/persistence/**` |
| `ARCHITECTURE` §7 标题与状态行 | 同上；并指向 §7.13 的集成期 scope 决定 |
| `TASKS` M2 章节头 | `KICKOFF: architecture FROZEN, implementation NOT started` → **`M2-P0 Gate: PASS — reviewed by A7`** |
| `TASKS` M2 范围表 | `M2-P0-1` / `M2-P0-3` 从 `FROZEN / NOT IMPLEMENTED` → **`COMPLETE` / `IMPLEMENTED`** |
| `TASKS` 决策范围 | `D-040…D-052` → **`D-040…D-058`**（现已到 D-059） |
| `TASKS` Gate 章节 | 新增**判定结果表**（六条判据逐项 PASS + 证据） |

**为什么这属于 Gate 工作而不是"顺手改文案"**：里程碑 tag 一旦打出，这批文档就是该 tag 的说明。
让 tag 里的权威文档断言"功能未实现"，比留一段没写的文档更糟。

### P2（A0 的流程失误，已补记）

A7 指出 A1 的 step 1/step 3 修改了未在 Owned Files 里枚举的文件：`packages/shared/src/index.ts`
（版本常量）、`packages/shared/src/collab-session.test.ts`（负向类型测试），以及 step 3 删除了 A2
测试替身里的 `as unknown as`（后者我在派发时已明确授权）。前两者是**我派发单的问题**，不是 A1 的：

> 我的派发单写的是 `packages/shared/src/collab-session.ts`（仅 A0 预批准的那一处附加），
> 但一次契约级变更必然要动版本常量与其契约测试。**枚举 Owned Files 时应按"这次变更最小完整面"
> 写，而不是按"最不想被碰的那个文件"写。**

留痕规则（本条之后生效）：契约级任务的 Owned Files 必须列全 `packages/shared/src/index.ts` 与
对应 `*.test.ts`；跨域改动一律在决策记录里点名，不只在 commit message 里。

### P3（措辞过强，已修正）

D-056 原写"每个 WebSocket 帧是独立宏任务，因此 BINARY 帧抵达时房间**必然**已是 `READY`"。A7 指出
这说过强：同一 TCP 读内的多帧会被 `ws` 在**同一宏任务**里同步 emit，而生命周期门在任何 `await`
之前同步判定，因此一次性写入 `join-room` + 大量 BINARY 帧的客户端**可以**进入 `HYDRATING`——
这也正是 K 的 Node 用例能稳定触发该分支的原因。

**已改为"在 production 的同步 store 加常规浏览器客户端下，backlog 不可稳定构造"**，并明确：
该分支**正确且被 Node 覆盖**，只是浏览器层难以稳定构造，**不是不可达**；不要因为难构造就当死代码删掉。
**D-056 的结论与重评触发条件不变。**

### P4（evidence note 过期，已修正）

`tests/browser/suite/10-m2-durability.mjs` 的 no-edit-join 观察项 note 仍引用 §7.3 的旧措辞
"on first write"，已改为指向 D-055 §3 与现行措辞 "the first join or write"。只改 evidence 文案，
**未改任何断言**。

**这条改动的 ownership 说明**：`tests/browser/**` 属 A6。为免为一个字符串再走一轮派发，A0 在 release
commit 内直接修正，并在 commit message 点名（沿用 D-055 §1 的具名例外做法）。

**后果。** 四项修正都不改变任何 Gate 判据，但让 release commit 里的文档与代码一致、审计链完整、
且不会把"这个分支不可达"的错误印象留给后续里程碑。A7 的 P3 是一次**技术上正确**的纠错——它保护的是
一个被 Node 用例覆盖、但观察者容易误判为死代码的分支。

---

## D-060 · 2026-10-18 · accepted · M2-P0 release：合入 `main` 并打 `m2-p0-gate`；耐久性与里程碑边界 (M2-P0 release)

**背景。** A7 在 `be6955e` 完成 M2-P0 Exit Review，结论 **APPROVE**；四项 pinned 缺陷已由 release
commit `ec762ef` 修正（D-059）。项目负责人在 M2-P0 Release / Phase 2 Handoff 指令中给出**一次性明确
授权**：仅当 repository reconstruction 与预期基线一致时，允许把 `m2-stabilization` 以 `--no-ff` 合入
`main`，在合并后的最终 HEAD 上重跑完整门禁，全绿后创建 annotated tag `m2-p0-gate`。本条记录该次 release
的边界与结论；门禁的具体数字见该 tag 的 tag message 与 A0 的 Release Closure Report，
Gate 判据本身**不变**（`docs/TASKS.md`「M2-P0 Exit Gate vs M2 Milestone」六条）。

### 1. 里程碑边界（项目负责人确认，不再作为待决问题）

- M2 = **M2-P0**（durable persistence + presence seam + IndexedDB lease 生命周期，**已 PASS**）
  + **M2 Phase 2 permission / authentication**（NOT STARTED）+ M2 final gate。
- `m2-p0-gate` **不等于** M2 关闭。**M2 状态：NOT CLOSED。**
- `m2-closed` **不得创建**；permission/auth 未处理前不得把 M2 标 CLOSED。
- M2 Phase 2 的**契约尚未冻结**。本次 release 只锁定顺序与 ownership 方向（`docs/TASKS.md`
  「M2 Phase 2」），其架构/scope 冻结是 release 之后的下一步工作。

### 2. durability 边界（发布说明原文；任何面向用户的表述不得越过此边界）

1. **durable across process restart** —— `append` resolve 即意味着该 update 存活**进程死亡**
   （`docs/CONTRACTS.md` §14.2）。
2. **not a replication guarantee** —— 无复制、无多副本。
3. **NORMAL 与 FULL 的 durability guarantee 不同** —— 实现为 `journal_mode = WAL` +
   `synchronous = NORMAL`：提交存活进程崩溃，但**不是**"每次写都 fsync"的掉电承诺。`FULL` 会为每次
   键击级 append 增加 fsync，而本栈其他部分也不提供该保证，因此不采用（`sqlite-store.ts` 头注释）。
4. **单节点无复制** —— 不宣称高可用、不宣称故障切换。
5. **Firefox / Safari 未验证** —— 浏览器证据只在真实 Chromium 上取得；Firefox/Safari 属**未验证**，
   不得当作已支持。
6. **K 的浏览器证据当前 N/A，不代表分支不可达** —— K 由 Node 级可控 hydration 用例 + 机制证明覆盖
   （D-056）。若 store 变为真实异步 I/O 或 hydration timing 改变，**必须重新评估**并恢复浏览器级验证；
   不要因为难以构造就把该分支当死代码删除。
7. **no-edit join 的 2 字节 append 是已知 backlog** —— 打开文档但不输入仍追加 1 行 2 字节 update
   （D-055 §3）；无内容污染、无数据丢失，本轮不修。
8. **`getStates()` 的只读约束含类型层边界** —— `ReadonlyMap` 是**类型级**约束；运行时仍返回真实 `Map`
   实例，显式 `as Map<...>` 下行转换仍可写（D-058 已知边界）。它不是运行时防护。

> **勘误（2026-10-18，A0 只读核验）。** 上面第 3 条初稿写成"不采用 `FULL`"，与 **D-047 决定 2**
> （durability = Option C：`synchronous` 可配置，production 允许 `FULL`）冲突。实际状态是：
> 实现**硬编码** `PRAGMA synchronous = NORMAL`（`apps/server/src/persistence/sqlite-store.ts`），
> 代码注释给出的理由是该栈其他地方也不提供每写 fsync 的保证；`config.ts` 与 `ARCHITECTURE` §7.10
> **没有** `synchronous` 开关。因此准确表述是：**NORMAL 与 FULL 的 durability guarantee 不同，
> 当前实现固定在 NORMAL，D-047 决定 2 的"production 可配置 FULL"尚未实现**，作为已知 gap 进 backlog
> （`docs/TASKS.md` M2 backlog），不是"已决定不要 FULL"。
> 面向用户的耐久性表述仍以本节八条为准，**不得**因为存在这个 gap 就宣称任一更强的保证。

### 3. 本次 release 做了什么 / 没做什么

| 项 | 状态 |
| --- | --- |
| merge | `m2-stabilization`（`ec762ef`）→ `main`，`git merge --no-ff`；merge commit 见 `git log --merges -1` |
| squash / rebase / cherry-pick 整体 feature | **未使用**（会销毁 Agent 历史） |
| tag | `m2-p0-gate`，annotated，指向门禁全绿的最终 `main` HEAD |
| `m2-closed` | **未创建**（禁止） |
| `m1-closed` | **未删除、未移动**（仍在 `f3c353e`） |
| push / 创建 remote | **未执行**；本轮 remote 保持 none |

### 4. 文档事实修正（D-059 P1 的同类错误延伸到 PROJECT.md）

`docs/PROJECT.md` 的 M1 行原把"没有服务端持久化"写成**当前**限制，M2 行仍写着"实现 NOT STARTED /
没有任何 M2 生产代码"。P0 合入后这两句都是**与实现相反的事实陈述**。已改为"M1 时期的限制，已由
`M2-P0-1` 移除"与"M2-P0 Gate: PASS，已合入 `main` 并打 tag，**M2 尚未 CLOSED**"。理由与 D-059 P1
相同：tag 一旦打出，这批文档就是该 tag 的说明。

### 5. 为什么耐久性边界要写成八条而不是一句"已持久化"

一句 "durable" 在读者心里会自动扩展成"不会丢、还能容灾"。八条里每一条都对应一个真实失败模型或一个
**未验证**面。把 NORMAL/FULL 的差别、K 的 N/A、Firefox/Safari 未验证写进决策记录，是为了让后来的 Agent
在写发布说明时**无法合法地**把它简化成更强的承诺——这属于 D-053 §3 的「安全 / 耐久性承诺变化」，
只能由项目负责人决定，不能由某轮实现顺手收窄或放宽。

**后果。** M2-P0 成为 `main` 上一个可引用、可复现的基线点（`m2-p0-gate`）；M1 的"重启即丢"从系统行为
降级为"M2 之前的历史限制"；同时 M2 保持 open，Phase 2 的权限/认证不会被误当作已完成。

---

## D-061 · 2026-10-18 · accepted · M2 Phase 2 冻结：server-issued session + demo bootstrap；space 不引入 (M2 Phase 2)

**背景。** A0 在 D-060 之后完成 Phase 2 现状重建并提出两个产品级选择（身份机制、space 层）。
项目负责人作出决定，并**同时纠正了 A0 草案里的安全承诺措辞**。本条记录决定本身、被纠正的措辞，
以及由此冻结的契约（`docs/CONTRACTS.md` §17、`docs/ARCHITECTURE.md` §8）。

### 1. 身份/认证 = 服务端签发 session（A0 草案的 Option B），但安全承诺收窄

采用：**server-issued opaque session token + `httpOnly` cookie + server-side session → userId
resolution**，配合 **Demo Identity Bootstrap**（本阶段不实现密码凭据认证）。

**它保证什么：**

1. 客户端**不能**在后续 WS / API 请求里自行声明 `userId` 来绕过授权；
2. session token 对应的 `userId` 由服务端解析；
3. authorization 只信任 server-side session identity；
4. token 走 `httpOnly` cookie，不暴露给前端 JS。

**它不保证什么：**

1. 登录者真实拥有该用户名；
2. demo bootstrap 是 credential authentication；
3. 现实身份得到验证。

**术语三分（必须区分，不得合并）：** `Demo Identity Bootstrap` / `Session Authentication` /
`Authorization`。

### 2. 被纠正的措辞（A0 草案错误，已作废）

A0 在 Phase 2 草案里把 Option B 写成"身份由服务端签发，**可防跨用户冒用**"。
项目负责人指出这是**把 session 的能力说成了 credential authentication 的能力**，要求作废。

| 作废表述 | 现行表述 |
| --- | --- |
| 无密码用户名登录可防跨用户冒用 | 服务端签发的 session 可以防止客户端在后续 API/WS 请求中直接伪造身份；demo bootstrap 本身不提供 credential-level identity proof |
| 已实现认证（无限定） | 已实现 **Session Authentication**；Demo Identity Bootstrap 不验证身份归属 |

写进契约的是后者，并且列为 **forbidden phrasing**（`docs/CONTRACTS.md` §17.0）：
任何"只有密码认证才成立"的句子都不得用于本系统。这不是文案偏好，是**安全承诺**边界（D-053 §3）。

### 3. M2 Phase 2 不实现（非目标，冻结）

password hash / storage、signup、password reset、OAuth / SSO、MFA。
登录 UI 在需要时只允许是**明确标注 demo** 的 identity selector / bootstrap，由服务端创建
opaque session。

### 4. Space = space-A

本 Phase **不引入** space entity / space membership / space role。闭环固定为：

```text
User → Session → Document Membership → DocumentRole
     → documentCapabilities → HTTP + WebSocket enforcement
```

space authorization 延后到真实 space domain 出现时设计。**不得为了让四层表格看起来完整而制造一个
当前不存在的领域实体**——表格里"space：本 Phase 不引入"是正确答案，不是缺口。

### 5. 契约后果

| 项 | 决定 |
| --- | --- |
| 新端点 | `POST /api/session/bootstrap`、`GET /api/session`、`DELETE /api/session`、`GET /api/documents`、`GET /api/documents/:id`（`CONTRACTS` §12 + §17.4） |
| 非泄露规则 | 未知文档 / 无成员关系 / 无 `canRead` **统一** `404 not_found`；不足 capability 才 `403`（§17.4） |
| 新错误码 | `WS_ERROR_CODES.FORBIDDEN`（非致命）；`ROOM_NOT_FOUND` 复用于"未知或无权"，因为**同一个回答正是非泄露规则需要的** |
| `SHARED_CONTRACT_VERSION` | 4 → **5**（封闭词表增长），由 A5 与 `errors.ts` 一起实现 |
| `PROTOCOL_VERSION` | **不变（2）**：framing、消息类型、payload 形状均未变 |
| session 持久性 | **process-scoped**（内存）。重启即失效、需重新 bootstrap —— 记为 limitation，**不得**写成安全属性 |
| membership 持久性 | 持久化（A5 自有表），重启后仍在 |

### 6. 实施顺序（冻结，A0 调度）

```text
A5 authz/session/permission seam（含 shared 判据、session store、HTTP 中间件与端点）
  → A0 integrate
  → A3 HTTP/WS enforcement（join 拒绝、BINARY 闸门、documents 元数据源接线）
  → A6 security / negative-path evidence
  → A7 M2 Phase 2 final review
```

先 A5 后 A3 的理由与 D-057 同构：两者都改 `apps/server`。**先冻结判定核心，再由 A3 接线**，
否则 A3 会在没有判据的情况下自己发明授权规则，且两人同时改 `ws.ts` / `registry.ts`。

**后果。** Phase 2 从"待决"变成"已冻结、可派发"：安全承诺被限定在 session authentication 能兑现的
范围内，demo bootstrap 的真实弱点写在契约里而不是藏在措辞里；space 明确不做，避免用假实体换表格完整性。
代价是 `SHARED_CONTRACT_VERSION` 再到 5，以及 session 非持久这一条 limitation 需要一路带到 M2 关闭。

---

## D-062 · 2026-10-18 · accepted · A5 Phase 2 seam 合入：四处集成决定、跨域留痕与 A3 交接 (M2 Phase 2)

**背景。** A5 在 `agent/a5-m2-phase2-authz` 交付 session/授权判定核心（3 个提交：`035d911` shared、
`b894282` server、`d30a634` web），并在报告里点名四处需要 A0 定性或处理的事项。A0 复核代码后
以 `--no-ff` merge commit `e718568` 合入 `main`，然后做了一次集成硬化提交 `cd18eb1`。

### 1. 四处决定

| # | A5 提出 | A0 决定 |
| --- | --- | --- |
| 1 | 客户端没有角色传输通道，UI 门控代码就位但不生效 | **由 A3 在 `room-joined` 里带 `role`**，不在 HTTP 上加字段。契约先由 A0 写进 `CONTRACTS` §5.2 / §17.5（`room-joined.role` 必需、仅 UI 门控、无权威），再由 A3 实现；`SHARED_CONTRACT_VERSION` **5 → 6**，`PROTOCOL_VERSION` 仍为 2 |
| 2 | HTTP `500 {error:"internal_error"}` 不在 §12 列表内 | **补进契约**（§12）。它存在的原因不是风格，而是**阻止 Express 默认错误处理把栈发到 wire**（§7 禁止）；body 不含任何细节，细节只进服务端日志 |
| 3 | `vitest.config.ts` 加了一行 `apps/web/src/session/**` | **批准**。"gate 不跑的测试不是测试"；同时要求该行带注释说明归属与理由（已做到） |
| 4 | `createApp(config, authz?)` 是可选参数 | **改为必选**（`cd18eb1`）。可选参数意味着生产接线漏了会**静默卸载所有 session/document 路由**，服务器对一切回答 `404` —— 看起来像数据问题的故障。必选把同一个错误变成编译错误 |

### 2. 具名 ownership 例外（A3 的文件由 A0 改）

决定 4 需要改 `apps/server/src/rooms/test-harness.ts`（A3 所有）。沿用 D-055 §1 的做法：A0 在集成
提交内直接改，并在 commit message 点名。改动是：harness 构造一个真实 `createAuthz`（store 被注入时
用自己的临时目录），关闭时释放，并清理自己拥有的目录；同时 A5 的 wildcard-CORS 测试改为 `await`
一个 harness 并传入真实 `authz`（守卫在 `authz` 被使用之前抛出，所以测试强度不变）。

**为什么不在 A5 的分支上改**：agent 分支只属于 agent。集成期的跨域修补属于 A0，且必须能在
`git log` 上被单独看见——这正是本条记录存在的原因。

### 3. A5 触碰了未在 Owned Files 里枚举的文件（再次，按 D-059 §P2 处理）

| 文件 | 为什么必须动 | 定性 |
| --- | --- | --- |
| `apps/web/src/api.ts` | 只有 `getJson`；bootstrap 需要 `POST` + `credentials: 'include'` | **必要且最小**：新增 `requestJson`，`getJson` 保留为包装，未把 `include` 铺到所有请求 |
| `apps/web/src/features/editor/DocumentWorkspace.tsx` | 用 `role` prop 显示只读提示 | 落在"`features/**` 仅权限门控"的**已声明范围内**，但该文件属 A2，**在此点名** |
| `apps/server/src/server.test.ts` | `createApp` 签名变化 | 测试跟随签名，无需单独授权 |

**教训（补进 D-059 §P2 的规则）**：枚举 Owned Files 时，契约级任务必须列全 `packages/shared/src/index.ts`
与对应 `*.test.ts`（D-059 已定），**再加两条**：web 侧 API 客户端与任何要被传参的既有组件，
都属于"改动的最小完整面"，应在派发单里写明，而不是靠 agent 自觉。

### 4. A5 留下的 seam 与 A3 的交接面

- `authz/public.ts` 是唯一可被其他模块 import 的入口，文件头用表格写清 A3 的三次调用与语义。
- `authz/documents.ts` 的 `DocumentCatalog` 是**注入 seam**：Phase 2 目前挂 `DemoDocumentCatalog`。
  真实来源（A3 的持久化 documents 只读源）由 A3 实现并在 `index.ts` 一处接线替换——这是 A3 范围，
  不是 A5 的遗留缺陷。
- `authz.db`（A5 自有文件）与 `insighthub.db`（A3 的 store）**物理分离**，理由写在
  `membership-store.ts` 头注释：不耦合 schema、不与热路径写竞争、删掉文档库不会静默孤立授权决定。

### 5. 已知限制（带入 A6/A7，不得在报告里省略）

- `authz.db` **不随文档删除级联**（Phase 2 没有文档删除 API，因此当前不可观测）。
- session **process-scoped**：重启后必须重新 bootstrap。
- WS 执行点在本条合入时**尚未接线**，因此 P2-1 / P2-5 仍无证据；P2-8 待 A6/A7 复核。

**后果。** A5 的判定核心成为 `main` 上可依赖的基线，A3 可以只按 `authz/public.ts` 接线而无需读内部实现；
代价是 `SHARED_CONTRACT_VERSION` 将在 A3 手里再到 6，且 `createApp` 的签名变化扩散到 harness 与一个测试。

---

## D-063 · 2026-10-18 · accepted · A3 WS 执行点：五项决定、一处契约纠错、以及 main 保持绿的前置 (M2 Phase 2)

**背景。** A3 在 `agent/a3-m2-phase2-ws-authz`（`9cd4563` → `a4a20ba` → `6332174` → `0d23af9`）交付 WS
执行点、`room-joined.role`（版本 5→6）与持久化元数据源，报告状态 `partial`，并列出五项需要 A0 定性的事。
本条记录复核结论与决定。

### 1. 复核结论：代码可信，五项均有解，无需项目负责人裁决

A0 逐处读了执行点，不是只读报告：

| 声称 | 复核结果 |
| --- | --- |
| 无 session ⇒ HTTP 401 且不建 socket | `ws.ts` 在 `server.on('upgrade')` 里先判路径再 `resolveSession`，`null` 时写 401 + `socket.destroy()`，**`handleUpgrade` 从未被调用** |
| 忘记接线不会静默失效 | `config.dataPath` 存在而 `options.authz` 缺失 ⇒ **启动抛错**（与 store 同款 fail-closed） |
| 身份只来自 session | 解析结果存 `WeakMap<IncomingMessage,string>`，不进入任何帧读取路径；payload/header/query 不参与 |
| join 拒绝不驱逐既有房间 | 判定在 membership 变更之前；`ROOM_NOT_FOUND` 与"文档不存在"**同码同文案** |
| 写被拒发生在副作用之前 | `SYNC SyncStep2/Update` → `canEdit`，拒绝回 `FORBIDDEN` 且不 apply / persist / broadcast |

### 2. 五项决定

| # | A3 提出 | 决定 |
| --- | --- | --- |
| a | 浏览器套件需要 session + membership fixture | **只改 A6 的 harness，不开新 seed 端点**。零成本部分（oracle socket 先 `POST /api/session/bootstrap` 拿 cookie）属 A6；per-scenario 文档（`a6-*`）的 membership 由 A6 以**测试夹具**方式写入 `authz.db`——沿用 D-055 §2 已接受的做法（`durable-store.mjs` 直读 SQLite 作常驻工具）。为测试方便在生产契约里挖一个 seed 口子（等于改 §17.3）**否决** |
| b | 建议 `--test-concurrency=1` | **采纳**，A0 改 `apps/server/package.json`。关键论证：串行**不会掩盖**真正的句柄泄漏——真泄漏在串行下同样会挂住；它去掉的是文件级并发下的 teardown **竞态**。因此这不是把问题藏起来，而是把门禁从"17s 但约 1/4 概率卡死"变成"27s 必定退出"，同时保留"真泄漏必须被抓住"的性质 |
| c | §17.5 的 SYNC 措辞会让 viewer 读不到内容 | **A3 是对的，契约写错了**。§17.5 已改为 `SyncStep1`→`canRead`、`SyncStep2/Update`→`canEdit`，并加勘误块说明原表述为何会造出"静默空白而非拒绝"。这是本轮**最有价值的发现** |
| d | `ownerId` 的来源 | **接受"创建者归因"**：`ownerId` 是**显示元数据**，不是权限；授权一律走 membership。已写进 §17.3，禁止任何地方从 `ownerId` 推导 capability |
| e | 重启后客户端是否重新 bootstrap | **A6 先观测，再决定归属**。这是 A1（provider 的 401 重连路径）与 A2（`App.tsx` 接线）之间的真实缺口，现在既无证据也无归属，不凭猜测派活 |

### 3. `main` 保持绿：A3 不在本轮直接合入

A3 的分支使浏览器门禁从 36/36 变成 **5 通过 / 0 失败 / 31 error**。31 个 error 全部是
"oracle/seeder did not join room X within 20000ms"，**没有一条断言失败**：原因是 harness 的裸 socket
没有 session（401）与 `a6-*` 文档没有 membership（`ROOM_NOT_FOUND`）。这是**证据链断裂**，不是行为缺陷。

即便如此，**不把 A3 直接合进 `main`**：AGENTS R6 要求 main 上不得有红的门禁，而 M2-P0 期 `main` 一直
是绿的。因此改为：

```text
main (green)
  └ A6 的 worktree 由 A0 先 merge agent/a3-m2-phase2-ws-authz（--no-ff）
      → A6 只改 tests/browser/**，把门禁恢复到 36/36 并补 P2 浏览器证据
      → A0 再把 A6 的分支整体合入 main（A3 + A6 一次性进入，main 不会出现红窗口）
```

代价是 `main` 上暂时没有 WS 执行点；收益是"`main` 永远可发布"这条性质不被这一轮破坏。

### 4. A3 触碰的越界文件（已批准并点名）

`apps/web/src/collab/tests/support/test-server.ts`（A1 所有）：`room-joined.role` 变成必需字段后，A1 的
测试替身 `rosterPayload()` / `roomJoinedPayloadShape()` 构造的 payload 编译失败。A3 事先申请、A0 批准，
只补两处 `role`（`'owner'` / `'viewer'`），并已在 commit message 点名。这是**契约级必需字段的必然扩散**，
与 D-059 §P2、D-062 §3 记的是同一类教训。

### 5. 带入 A6/A7 的已知限制（不得省略）

- session **process-scoped**：重启后必须重新 bootstrap；A6 的 `m2/B`、`m2/C` 场景会暴露这一点。
- `document_meta` 只在"房间首次创建"时写入：pre-Phase-2 的旧库若有内容无元数据，在有人重新 join 前
  不会出现在 `GET /api/documents`。
- `title` 恒为文档 id（Phase 2 无重命名 API）。
- `SyncStep1` / `AWARENESS` 的 `canRead` 否定分支在正常流程下**不可达**（进不了房就发不了帧），
  仅为防御性代码，未单独验证。
- 浏览器层 P2-1 / P2-2 / P2-4 / P2-5 **全部未验证**，Node 证据不得当作浏览器证据。

**后果。** WS 侧从"文档承诺"变成"可执行、可测、且拒绝发生在副作用之前"；契约里一处会制造静默空白的
措辞被 A3 抓住并修正。代价是 `main` 暂时落后于 A3 分支、`SHARED_CONTRACT_VERSION` 到 6，且浏览器证据
链要在 A6 手里重新接上之后，M2 Phase 2 才可能通过 final review。

---

## D-064 · 2026-10-18 · accepted · M2 Phase 2 Gate：A7 GO、发布说明禁令，以及 M2 仍未关闭 (M2 Phase 2)

**背景。** A7 在 `agent/a7-m2-p2-review @ 7754198` 完成 M2 Phase 2 final review，结论 **GO**，附三条放行
条件（B1/B2/B3）与五条新发现（F1…F5），并给出五处待决点的裁定。A0 复核后把 A6 + A7 以 `--no-ff`
合入 `main`（`87c971b`），并关闭 B1、B2，把 B3/F1/F2 立项。本条是**这个 Gate 的发布记录**——它的主要
作用不是宣布成功，而是**锁死不允许出现的表述**。

### 1. 发布说明禁令（B1；违反即退回）

以下三句话**不得**出现在 `main` 的 release notes、README、UI 文案或任何报告中：

| # | 禁止表述 | 事实 |
| --- | --- | --- |
| 1 | "UI 权限门控已生效 / viewer 在界面上不能编辑" | **假**。`room-joined.role` 已发送并被浏览器收到，但客户端**从未消费**（全仓 0 次 dispatch，A7 F1）。viewer 可以打字、本地看得见、服务端拒绝、他人看不到 |
| 2 | "吊销立即生效 / 登出即断开" | **假**。吊销与过期是**请求级**的：已建立的 socket 保留准入时的身份继续工作（实测 `writeApplied: true`，§17.2 已写明） |
| 3 | "服务端重启后客户端自愈 / 会话自动恢复" | **假**。session 是进程内的；实测 `reBootstrapped=false`，页面停在 `reconnecting`。续签是 harness 行为，不是客户端能力 |

**可以说、且有证据的**：HTTP 与 WebSocket 的**授权判定**由服务端权威执行；viewer 的写入在
**apply / persist / broadcast 之前**被拒绝；未知文档与无权访问在 HTTP 上返回**同一个** `404 not_found`
（状态码/body/headers 全同）、在 WS 上返回**同一个** `ROOM_NOT_FOUND`；`room-joined.role` 携带的是
服务端解析的真实角色；错误不得泄露文档存在性。

### 2. A7 五处待决点的裁定（A0 确认）

| # | 裁定 |
| --- | --- |
| 1 重启后续签 | **接受为已知缺口**，归属 A1 + A2；禁令 3 随之生效 |
| 2 吊销不追溯 | **契约澄清**（已写入 §17.2 与 §17.5），**实现进 backlog**（A3：断连或每帧重解会话活性） |
| 3 viewer 本地分叉 | **接受为已知缺陷，非安全缺陷**（服务端拒写在副作用之前）；归属 A2 + A1 |
| 4 `role` 未接 UI | **接受为未完成项**，归属 A1 + A2；已进 TASKS「A7 GO 的收口缺口」 |
| 5 `authz.db` 不级联 | **接受**（无删除 API，不可观测）；引入删除能力时必须同时处理 |

### 3. 三条放行条件的处置

| # | 归属 | 处置 |
| --- | --- | --- |
| **B1** | A0 | **已关闭**：本条 §1 即禁令；`TASKS` 的"客户端权限门控"行改为"通道已通、消费侧未接、**门控当前不生效**" |
| **B2** | A0 | **已关闭**：`TASKS` Phase 2 ownership 表 A3 行的 Do-Not-Touch 不再与 D-062 §1 矛盾，改为具名例外 |
| **B3** | A3 | **未关闭**：`authz-enforcement.test.ts`（640 行，全文注释 + 部分 `it` 标题）与 `restart.test.ts`（10 处）是 UTF-8→GBK→UTF-8 的**有损转码**，`§` 后的数字被吃掉、部分换行被吞；另有 `index.ts` 与 L321 两处过期注释。A0 **不做**这次批量重写：有损字节不可逆，机械替换会在 Gate 后留下错误引用，交给语义重写更安全 |

### 4. 这个 Gate 是什么 / 不是什么

- **是**：M2 Phase 2 的**授权闭环**通过独立终审（A7 GO），且四门禁在真实环境全绿（44/44 浏览器）。
- **不是**：M2 关闭。M2 的关闭条件仍差 **B3**（M2 发布记录的前置）与 **F1**（UI 门控真正生效）。
  `m2-closed` **不存在，且不得创建**。

### 5. 本轮未做的事（以免被误读）

- **未创建任何 tag**。`m2-p0-gate` 未移动、未删除。若需要 `m2-p2-gate` 作为可引用基线，按 D-053 §5
  需项目负责人一次明确授权；A0 不自行打里程碑 tag。
- **未 push、未创建 remote**。
- **未做 F1/F2 的实现**（归属 A1+A2 / A3），也未做 B3。

**后果。** Phase 2 的授权闭环成为 `main` 上可引用的基线，同时"UI 门控未生效""吊销不追溯""重启不自愈"
三句话被写进决策记录，后续任何发布说明都无法合法地把它们说成已完成。代价是 M2 仍需一轮
A1+A2（F1）与 A3（B3）才能关闭，而 `SHARED_CONTRACT_VERSION` 停在 6。

---

## D-065 · 2026-10-18 · accepted · M2 收口规则修正（项目负责人）：交接权、non-functional proof、A6 重新进入 DAG (M2 Phase 2 closure)

**背景。** 项目负责人在 A3(B3)/A1(getRole) 两棒运行期间修正了调度与验收规则。本条是这些规则本身，
它**覆盖** D-064 §4 的收口顺序。已运行中的两棒不做实现返工，只在最终报告的 `Next Handoff` 按 §1 修正。

### 1. Specialist 的 `Next Handoff` 只能是 A0

A0 在派发 A3(B3)/A1(getRole) 时把末项写成了"A2"，这是**调度越界**——而且与 `agent-prompts/COMMON.md`
§8 早已写明的规则冲突（"正式跨 Agent 调度权属于 A0"）。规则：

- A1–A7 报告末项一律 `Recommended Next Agent: A0`；
- 可以写 **downstream consumer** 是谁、它必须/不得做什么，但**不得**写成"下一棒是 X"；
- 由 A0 在复核、集成、门禁之后决定并派发下一棒。

### 2. B3 的 non-functional proof（`tests PASS` 不能替代）

A0 集成 B3 之前**必须**检查 `git diff --unified=0`。允许变化的行**只有**：

1. 注释（`//`、`/* */`、`/** */`）；
2. `describe` / `it` 的**标题字符串**；
3. `apps/server/src/index.ts` 指定的过期头注释。

**不允许**任何 assertion、fixture、setup/teardown、expression、import/export 或 production
executable token 发生变化。理由：B3 的全部价值在于"这是一次纯注释修复"。`pnpm test` 180/180 只能
证明**行为**没坏，不能证明 diff 里没有顺手改掉别的东西——**绿的门禁不是 diff 审查的替代品**。

### 3. A2 只能消费冻结 seam，语义不得漂移

A2 只允许消费 `session.getRole(): DocumentRole | null`（`docs/CONTRACTS.md` §17.9），并且：

| # | 约束 |
| --- | --- |
| 1 | `owner` / `editor`：按冻结的 `documentCapabilities` 做 UI gate |
| 2 | `viewer`：UI **不提供**本地编辑能力 |
| 3 | `null`：**不得**锁死编辑器，必须保持可用；server authorization 仍是唯一的 security boundary |
| 4 | **不**把 role 镜像进 Redux |
| 5 | **不**写 awareness |
| 6 | **不**新增第二套 role subscription |
| 7 | **不**宣称 role revocation 会即时更新既有客户端 UI |

### 4. A6 重新进入 closure DAG（A2 集成后不得直接交 A7）

A2 合入后，A6 必须在**集成后的 HEAD**上验证 F1，至少覆盖六点：

1. viewer 在真实浏览器里的 UI gate；
2. owner / editor 正常编辑无 regression；
3. `getRole() === null` 时编辑器**不会**被错误锁死；
4. UI gate **不构成**安全边界：绕过 / 构造客户端操作时，server enforcement 仍拒绝未授权 mutation；
5. **不得**把请求级吊销语义误证明成"existing socket 的即时 identity revocation"；
6. 真实 Chrome + 真实 backend。

### 5. F3 升级为 evidence condition（不是 backlog 备注）

已知 A6 的 fixture 在 `role: null` 时仍可能补写 membership。在 F1 的 browser evidence 中，**不得**
让这个行为制造 false success。A6 必须**二选一**：

- 修掉 F3；**或**
- 在报告中**证明** F1/null 场景没有经过该污染路径，并使用**不会隐式创建 membership** 的 setup。

**无法证明 ⇒ F1 browser evidence 判 FAIL。** 这一条把"已知小瑕疵"变成了"证据可信度"的前置条件：
一个会悄悄给自己发权限的夹具，产出的绿色证据不算证据。

### 6. 最终 DAG（替换 D-064 §4 的收口顺序）

```text
A3(B3) ∥ A1(getRole)
  → A0 integrate（integrated HEAD 上跑 typecheck / test / build）
  → A2(F1 UI)
  → A0 integrate
  → A6 integrated evidence（六点 + F3 evidence condition）
  → A0 integrate A6 的 tests/docs 提交 + 在最终 integrated HEAD 上重跑四门禁
  → A7 M2 final review
  → 项目负责人一次性授权 milestone closure / tag
```

**A6 若产生 tests/docs 提交，必须由 A0 合入后在最终 integrated HEAD 上重跑四门禁**，不得直接引用
A6 feature branch 上的结果——分支上的绿不等于合入后的绿。

### 7. Tag / 里程碑

- **不创建** `m2-p2-gate`；
- `m2-closed` **不存在**，且不得创建；
- 既有 milestone tags（`m1-closed`、`m1-p0-baseline`、`m2-p0-gate`）**不动**；
- no push / no remote mutation；
- A7 最终 review 之后，由项目负责人对 milestone closure / tag 做**一次明确授权**。

**后果。** 收口路径从"两棒之后就可能关闭"变成"两棒 → A2 → A6 → A7 → 授权"，多了 A6 这一环；
代价是一轮时间，收益是"UI 门控生效"这句话会有一条**不依赖夹具自证**的浏览器证据，且 B3 这类
"看起来只是注释"的改动必须交出 diff 级证明。

---

## D-066 · 2026-10-18 · accepted · A3(B3) 与 A1(getRole) 集成：一次审计、一次例外、一条新禁令 (M2 Phase 2 closure)

**背景。** 两棒以 `a3ff4a9` 为 base 并行完成，A0 分别 `--no-ff` 合入（`709da9c`、`0f63fdc`）。
集成 HEAD `0f63fdc` 上的门禁：`pnpm typecheck` 0、`pnpm test` 0（vitest **32 files / 360 tests**、
server **180/180** 且自行退出）、`pnpm build` 0。

### 1. B3：A0 独立审计通过（不只是采信 A3 的自审）

A0 重跑 `git diff --unified=0 a3ff4a9..57b9b5b` 并逐行机器分类：**115 行变更 = 注释 43 +
`describe`/`it` 标题 15 + 其他 0**；15 对标题的 `+`/`-` 两侧代码后缀（`async () => {`、`() => {`）
逐字节相同；`describe`/`it` 计数不变。因为 `-U0` 只输出变更行，"可执行 token 未变"是分类结果，
不是 A3 的自我声明。**B3 按"注释与标题 0 残留"结案。**

**附带发现（值得记住）**：`restart.test.ts` 里有两处**非 CJK** 损伤——路径开头的 `a` 被 U+0007（BEL）
吞掉（`pps/server/…`、`uthz/public.ts`）。纯 CJK 的乱码 grep **抓不到**这类损伤。教训：检测转码损伤
不能只扫"是不是汉字"，还要扫控制字符与 `U+FFFD`。

### 2. B3-residual：不修，作用域化记录

6 处落在诊断字符串实参内（4 处 `waitFor` 描述、2 处 `assert.*` 第 3 实参），应为 `’`/`—`。**不修**：
B3 的验收是 diff 形状规则，一旦提交里出现 `assert(...)` 行，审查就必须区分"assert 内的消息串"与
"assert 被改了"，而这正是规则要消除的歧义。**任何人不得声称"mojibake 已全库清零"**：注释与标题为 0，
全文件不是。关闭它需要项目负责人一次性放宽该规则。

### 3. A1：seam 实现符合 §17.9，且**派生门**是本轮最关键的实现选择

`getRole()` 不是简单返回一个字段，而是 `state === 'active' && connectionStatus === 'connected' ?
roomRole : null`。原因：存储的 `roomRole` 可能比房间活得久（fatal-error 路径不经过 `onRoomLeft`），
只靠"清值"会有一个报出过期角色的窗口。**派生门 + 清值**双保险，才使得"角色只在房间活着且连得上时
才存在"这条语义成立。`parseRoomJoinedRole` 用 `isDocumentRole` 校验，坏值一律 `null`，不回退
`editor`/`viewer`——猜 `editor` 会给用户服务端必拒的控件，猜 `viewer` 会锁死用户未发送的文本。

### 4. 具名 ownership 例外（`9e997c5`）

给冻结 seam 加必需成员会打断**实现者**：A2 的 `FakeCollaborativeSession`（`implements`）令 web
`tsc` 出现 **21 个错误，全在 `apps/web/src/features/**`，A1 自己 0 个**——与 D-055 §1 完全同类。
处置：A0 预授权，A1 在自己分支上以独立提交修补，**只改 `fakeCollaborativeSession.ts`**（默认 `null`，
`setRole()` 走既有 `emit()`），其余三个文件未动并自行变绿（21 → 0），证明例外没有外溢。
机制先例：D-055 §1 / D-062 §3。

### 5. 新禁令（加入 D-064 §1 的禁令清单，编号 4）

> **不得**声称"角色变更即时反映到 UI" / "UI 权限变更即时生效"。

事实：服务端**每帧重新判定**，降级立即在服务端生效；但客户端 `getRole()` 只在 `room-joined` 时更新
（Phase 2 没有 server→client 的角色变更消息），因此 **UI 门控可能滞后到下一次 rejoin**。
要让它即时，需要一条新的控制面消息 + `PROTOCOL_VERSION` bump——属契约扩张，**不在 M2 范围**，
由 A0 立项而非某位 Agent 顺手加。

### 6. 逐提交绿性

`36028b8`（契约 v7）与 `727e647`（实现）**单独不是 typecheck 绿**：契约先于实现者落地是必然，
实现者修复在 `9e997c5`。A1 已在 commit 1 正文写明。**门禁结论只对集成 HEAD 成立**；用 `git bisect`
时不要指望每个提交都绿。

**后果。** F1 的输入端闭合（A2 有了唯一、不能猜的角色来源），B3 以可审计的方式结案并留下具名残留；
代价是禁令清单多一条、契约到 v7，且"UI 能否即时反映权限变更"被明确划到 M2 之外。
