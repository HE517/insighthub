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
| 1 | "UI 权限门控已生效 / viewer 在界面上不能编辑" | **假**（**该条已被 `docs/DECISIONS.md` D-069 §3 取代**：A2+A6 落地后它反向过期）。当时的理由是 `room-joined.role` 已发送并被浏览器收到，但客户端**从未消费**（全仓 0 次 dispatch，A7 F1）；viewer 可以打字、本地看得见、服务端拒绝、他人看不到 |
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

---

## D-067 · 2026-10-18 · accepted · A2 F1 UI 半场：门控生效、ctrl-Z 缺口、以及三场景重新瞄准 (M2 Phase 2 closure)

**背景。** A2 在 `agent/a2-m2-p2-ui-role @ 5afdab9`（base `ddf133d`）实现 UI 门控，12 个 `apps/web/src/**`
文件、+915/−37，未触碰 `docs/**`、`packages/**`、`apps/server/**`、`apps/web/src/collab/**`、
`tests/browser/**`。三门禁全绿（typecheck 0 / test 0：vitest **34 files / 378 tests** + server 180/180 /
build 0）。

### 1. 复核：门控确实只读冻结 seam，且覆盖三条写路径

| 声称 | 复核 |
| --- | --- |
| 角色只来自 `session.getRole()` | `useSessionRole` → `useSessionSnapshot(session, selectRole)` → `selectRole` 仅 `return session.getRole()`；复用既有 `createSessionStore`，**无第二订阅通道** |
| 未知角色不锁死 | `capabilityGate(null).readOnly === false`；`readOnlyNoticeFor` 对 `gate.role === null` 返回 `null`（双保险：既不只读、也不出提示） |
| 不镜像 Redux | `documentSlice.ts` 的 `role` / `documentRoleReceived` 槽位**已删除**，头注释写明理由 |
| 只读覆盖非 UI 写路径 | `editorEditability` 同时设 `EditorState.readOnly` 与 `EditorView.editable`，并对 `session.undo()/redo()` 加闸——见下 |

### 2. 一处真实 bug（A2 在自己的第一版里发现的）

| 字段 | 内容 |
| --- | --- |
| **Problem** | 只读 viewer 按 `Ctrl+Z` 仍能改 `Y.Text` |
| **Root Cause** | `@codemirror/commands` 的命令会读 `state.readOnly` 自我禁用，但**手写 keymap 绑定不继承该检查**；而这里的撤销不是 CodeMirror history，是 `session.undo()`——一个对 `Y.Text` 的**本地写入**（R13） |
| **Impact** | viewer 在"曾为 editor / 角色未知时输入过、随后 rejoin 报更低角色"的状态下按撤销，会删掉已进入 `Y.Text` 的文本；该更新服务端必拒 → 本地分叉（**非安全缺陷**，服务端仍在副作用前拒绝） |
| **Fix** | `runSessionHistory(readOnly, session, 'undo'\|'redo')`：只读时不做任何事但吞掉按键；三个 keymap 绑定改走它 |
| **Regression Test** | `editorRoleGate.test.ts`："refuses to undo while read-only…" 断言 `undo/redo` 未被调用且 `Y.Text` 不变（修复前必红） |

**为什么记这一条**：只读"看起来"是 UI 层的事，但撤销/重做是一条**绕过编辑器的写通道**。凡是"只读"的实现，
都必须把**所有本地写入路径**列一遍，而不是只设 `readOnly` 一个 facet。

### 3. 分支名：以实际检出为准

A0 派发单写 `agent/a2-m2-p2-ui`，实际 worktree 检出 `agent/a2-m2-p2-ui-role`。**以实际为准，不 rename**：
分支名不承载语义，重命名既有提交只会制造一次无收益的历史改写。此后引用一律用 `agent/a2-m2-p2-ui-role`。

### 4. 浏览器 41/44：三个 errored 是门控生效的**证据**，不是回归

`p2/1-viewer-cannot-write`、`p2/2-identity-cannot-be-self-declared`、`p2/4-role-capability-consistency`
全部 timeout 于"the page never received a FORBIDDEN error frame"。原因：viewer 页面现在是
`contenteditable=false` + `state.readOnly`，**UI 不再产生写入** → 没有东西让服务端拒绝。

**决定（A0）：采用 A2 的建议 (a)，不做 (b)。**

| 方案 | 判定 |
| --- | --- |
| **(a) UI 只读断言 + 用非 UI 路径证明服务端仍拒绝**（wire oracle / 页面内对 `EditorView` 直接 dispatch） | **采纳**。这两个断言回答两个不同问题：「UI 是否挡住」与「服务端是否是边界」，缺一不可 |
| (b) 让这些场景改用 editor 身份打字、viewer 只测读 | **否决**。它把"UI 不是安全边界"这条最重要的性质从证据里删掉了 |

**禁止**为了让这三个场景变绿而放宽门控（A2 已按此执行：只报告、不改测试、不放宽）。

### 5. `main` 仍不出现红窗口

与 D-063 §3 同一处理：A2 **不单独合入 `main`**（否则 `main` 的浏览器门禁立刻 41/44）。
A6 的 worktree 由 A0 先 merge `agent/a2-m2-p2-ui-role`，在集成后的树上重新瞄准三个场景并补齐证据；
**A0 再把 A6 整体合入 `main`（A2 + A6 一次性进入）**。

### 6. 新增工程规则 R16（写入 `AGENTS.md` §1）

同一目录下不得存在**仅大小写不同**的两个文件名。理由：Windows 的 TS 编译报 `TS1149`，而 CI/Linux
不会——A2 的 `readOnlyNotice.ts` 与 `ReadOnlyNotice.tsx` 就撞在这一点上，最后以 `readOnlyNoticeCopy.ts`
解决。这类错误只在特定平台上出现，必须写成规则而不是靠踩到的人记住。

### 7. 带入 A6 的未验证项（不得省略）

- 提示文案在**真实浏览器**中可见（本轮只有 SSR markup、state 与交付层断言）；
- 角色变化时 **DOM 不重挂载**（本轮只证明 state 层 `reconfigure`）；
- `getRole() === null` 的**真实浏览器**窗口（首帧 / 离线 / rejoin 前）编辑器确实可输入；
- 角色滞后（D-066 §5）与"UI 不是安全边界"这两条**禁令式**表述。

**后果。** F1 的两半都实现完毕且经 A0 复核；UI 现在真的会挡住 viewer 的本地写入（含一条容易被忽略的
撤销通道），而"服务端才是边界"这件事因为三个场景失效反而获得了更明确的验证计划——只是需要 A6 用
非 UI 路径把它重新证明一遍。

---

## D-068 · 2026-10-18 · accepted · A6 证据闭环：双断言成为标准、F3 修掉、门禁顺序修掉 (M2 Phase 2 closure)

**背景。** A6 在 `agent/a6-m2-p2-ui-evidence`（基座 `387f69d` = main + A2）完成 F1 浏览器证据与 F3，
浏览器场景 **44 → 48**，四门禁全绿。A6 结束时**未提交**，改动只在工作树；A0 核验范围后以其名义提交
（`7ae4974`：5 改 + 2 新，**全部在 `tests/browser/**`**），再 `--no-ff` 合入 `main`（`91bcf77`，
A2 + A6 一次性进入，`main` 未出现红窗口）。

### 1. 双断言成为同类场景的标准（回答 A6 的问题 ①）

**采纳并冻结为模式**：任何"UI 门控 + 服务端仍是边界"的场景，必须写成**两条独立断言**：

1. **UI 侧**：`contenteditable=false`、live `EditorState.readOnly === true`、提示**可见**且文案诚实
   （`[data-testid="read-only-notice"]`，不得含 `saved`/`saving`/`immediately`/`instant`）、
   真实击键后编辑器长度不变、**出站 SYNC 帧计数不变**、本地副本 update 数不变；
2. **服务端侧**：用冻结 codec 构造一个**不经过 UI** 的写入，走页面自己已认证的 socket，
   要求**新**的 `FORBIDDEN`（基线计数 +1），并断言不持久化、不广播、socket 数与 close 数不变。

**为什么必须两条**：旧的单条形式（"打字 → 服务端拒绝"）把两个问题压成一个观察；门控一生效，该观察
就消失——这恰好证明它们相互独立。UI 门控被击败时（伪造 `room-joined(role:"owner")`），第 2 条仍然
成立，这正是"UI 不是安全边界"的**唯一**可信证据。

### 2. 一处测试质量缺陷：`waitForServerErrorCode` 太弱

旧辅助函数只要求"曾经出现过 `FORBIDDEN`"——任何更早的同码帧都能让它通过。对于"由测试自己主动发起的
拒绝"这类断言，这是**假阳性通道**。已改为 `waitForNewServerErrorCode(afterCount)`：发送前记录计数，
要求之后出现**新**帧（实测 `forbiddenFramesBefore: 0 → now: 1`）。

这不是产品 bug，但它污染的是**证据本身**，比产品 bug 更危险——一个只在"某处曾经出现过"意义上成立的
断言，会在回归时继续为绿。

### 3. F3 修掉，并附数据库级证明

两处隐式写 membership 的路径同时关闭：`run.mjs#newAppPage` 在 `role: null` 时既不写也不让
`setDocumentId` 写；`lib/app.mjs#setDocumentId(page, documentId, { arrangeAccess = true })` 新增开关
（默认 `true`，**遗留调用点行为不变**）。

证明（`f1/3` 的真实输出，不是论证）：窗口期 `{"fixtureWritesSoFar":0,"membershipRow":null}` →
页面打开并打字后仍有 `{"fixtureWrites":0,"membershipRow":null}` → 之后才 `{"role":"editor","action":"inserted"}`。
且该场景用 `offlineFirst`（在任何应用脚本之前置离线）保证**从未尝试 join**，因此没有经过任何可隐式
造权限的路径。**这满足了 D-065 §5 的 evidence condition**：不是"证明它不伤害结论"，而是"把可能伤害
结论的路径关掉"。

### 4. 门禁顺序：修掉，而不是写进文档（回答 A6 的问题 ②）

A6 踩到：干净树上直接 `pnpm test` 必红（21/34 文件 `Failed to resolve entry for package
"@insighthub/shared"`，vitest 需要 `packages/shared/dist`），先 `build` 才绿。

**决定**：在根 `package.json` 增加 `"pretest": "pnpm --filter @insighthub/shared build"`。
理由：把"先 build 再 test"写成文档，等于把门禁的可用性交给读者记忆；而 `pretest` 让
`pnpm test` **单独就是完整的**。一个需要先执行另一条命令才算数的门禁，本身就是缺陷。

### 5. 提交如何落（回答 A6 的问题 ③）

计划不变：**A2 + A6 一次性进入 `main`**（`91bcf77`）。A6 未提交是流程缺口，不是内容问题；A0 以 A6 名义
提交并在 commit message 里写明，范围经核验（只有 `tests/browser/**`）。**规则补记**：Agent 交付前必须
把自己的改动提交到分支；未提交的工作树不算交付物，A0 代提交只在"内容已核验且范围单一"时进行。

### 6. 带入 A7 的未验证清单（A6 自述，A0 未扩大其可信度）

- `getRole()` 是模块级对象，harness 不能直接调用；`null` 的证据是"两个消费者 + 页面从未收到
  `room-joined`"的**合成**证据（场景内已如此标注）；
- `null` 只覆盖"首帧之前（offline-first）"与"reconnecting"两种，§17.9 列的"被拒 join 之后"未单独覆盖；
- `commenter` 没有浏览器行（门控对任何非 `canEdit` 角色一致，但未在浏览器跑过）；
- 未测"被篡改的客户端构建"整体，只测其关键等价物；
- `react StrictMode` 使启动期 mount/unmount 为 4/3，**"不重挂载"必须读增量**，看绝对值会误判。

### 7. 一条要正确引用的实测

`f1/1` 记录：把 linus 降级为 viewer 后 **3 秒**，UI 仍是 `role: editor / contentEditable: true`，
直到下一次成功 join 才变 viewer。**这是 D-066 §5（角色滞后）的实证，不是缺陷报告**；
它同时是"不得声称角色变更即时反映到 UI"这条禁令的**正面证据**。

**后果。** F1 从"实现完成"变成"实现 + 可复核的真实浏览器证据"，并且这份证据是在**夹具不再能给自己
发权限**的前提下取得的；同类场景从此有统一的双断言模板，`pnpm test` 也不再依赖执行顺序。

---

## D-069 · 2026-10-18 · accepted · A7 终审的文档条件：取代 D-064 禁令 1、修掉四处"功能不存在"记载 (M2 final)

**背景。** A7 在 `06ecf14` 上独立重跑四门禁（typecheck 0 / vitest 34 files·378 tests + server 180/180
自行退出 / build 0 / 浏览器 **48/48**）并给出 **GO WITH CONDITIONS**：**没有代码级阻塞**，条件全部
是**文档事实错误与内部矛盾**。A7 把这一类定为 P1——理由与 D-059 同：milestone 一旦关闭，这批文档就是
该 milestone 的说明，让它们断言"功能不存在"比留一段没写更糟。

### 1. 四处"Phase 2 不存在"的记载（P1，已修）

| 位置 | 原状 | 修正 |
| --- | --- | --- |
| `CONTRACTS.md` 版本表 | `SHARED_CONTRACT_VERSION = 2`（实际 **7**） | 改为 **7** |
| `CONTRACTS.md` §17 标题与首段 | `FROZEN, NOT implemented` / "Nothing in this section is implemented yet" | **IMPLEMENTED** + 指向实现位置与浏览器证据 |
| `ARCHITECTURE.md` §8 标题 | `FROZEN, NOT implemented` | **IMPLEMENTED, enforced at HTTP and WS** |
| `PROJECT.md` M2 行 | `M2 Phase 2 / 权限认证（NOT STARTED）` | **已实现并合入 `main`**（HTTP/WS/UI 三层、48/48），仍 **未 CLOSED**，等 A7 终审与负责人授权 |

这与 D-059 修的 P1 是**同一类**：功能做完了，权威文档还在说它没做。**它不是笔误，是会让下一位读者
（尤其 M3 的 AI 工作）误判 seam 可用性的错误。**

### 2. `ARCHITECTURE` §8.2 仍在教一条已被撤回的规则（P2，已修）

§8.2 的框架表写着 "BINARY `SYNC` requires `canEdit`"，而 §17.5 早已勘误为
`SyncStep1`→`canRead`、`SyncStep2/Update`→`canEdit`。**按 §8.2 实现会让每个 viewer 看到空编辑器**——
这正是 D-063 §2c 记下的那个缺陷，在另一份权威文档里活着。已改。

同一错误还在 `rooms/registry.ts` 的模块头摘要（L188）里：那里说 `SYNC`→`canEdit`，而同文件 L700 的
逐帧表是正确的。**同一个文件里两处规则相反**，读者会信摘要。已改（注释级，A0 具名例外，无代码变更）。

### 3. D-064 §1 的禁令 1 已被事实推翻，必须显式取代（P2）

D-064 §1 禁令 1 是"**不得**声称 UI 权限门控已生效"。在 A2+A6 落地之后，这句话**从"保护诚实"变成了
"与事实相反"**：UI 门控现在真的生效，并有 `f1/1…f1/4` 与重瞄后的 `p2/1·p2/2·p2/4` 证据。

**取代规则**：禁令 1 **作废**；以下三条**继续有效**，任何人不得违反：

| # | 仍有效的禁令 |
| --- | --- |
| 2 | 不得声称"吊销立即生效 / 登出即断开"——吊销是**请求级**的，已建 socket 保留准入身份 |
| 3 | 不得声称"服务端重启后客户端自愈 / 会话自动恢复"——session 是进程内的 |
| 4 | 不得声称"角色变更即时反映到 UI"——服务端每帧重判，客户端只在 `room-joined` 时更新（`f1/1` 实测降级后 3 秒仍是 editor） |

**可以说、且有证据的**：viewer 在真实浏览器里无法从 UI 写入（DOM 不可编辑 + 只读 facet + 可见诚实文案
+ 无出站 SYNC 帧），且绕过 UI 的写入仍被服务端以 `FORBIDDEN` 拒绝、不持久化、不广播；未知角色不锁死
编辑器。

### 4. P3：记录但不阻塞（A6 的 latent 项）

| 项 | 处置 |
| --- | --- |
| `tests/browser/lib/app.mjs#openApp` 仍以隐式 `arrangeAccess` 打开文档（当前未被使用） | **记录**为 latent F3 入口，A6 下次动该文件时关掉 |
| `p2/5-role-change` 仍用较弱的 `waitForServerErrorCode`（"曾经出现过"） | **记录**：该场景测的是服务端拒绝，不涉及"自己主动发起的拒绝"，风险低于已修的三处；改用 `waitForNewServerErrorCode` 是 A6 的清理项 |
| `pnpm test:unit` 在无 `packages/shared/dist` 的树上失败 | **已修**：新增 `pretest:unit`（D-068 §4 已为 `pnpm test` 加过 `pretest`，这里是同一缺陷的第二个入口） |

**后果。** M2 的"代码可关闭"与"文档可关闭"重新对齐：权威文档不再描述一个不存在的 Phase 2，不再教一条
会让 viewer 看空白的规则，也不再禁止一句现在为真的事实。剩下的都是记录在案的 latent 清理项，不足以
阻断关闭。

---

## D-070 · 2026-10-21 · accepted · 项目负责人裁定：先修 TOOLING-P2 再关闭 M2（Option B） (M2 closure)

**背景。** A7 终审给出 GO WITH CONDITIONS（实现可关闭，仓库记录不可关闭），A0 关闭了 C-1…C-4/C-6 并在
`74da34c` 上跑通四门禁。但 A0 在收口过程中**重复观测到** `pnpm test` 偶发"全部测试 PASS 后进程不退出"
（两次连续卡住 >10 分钟；随后一次 34 s 正常退出；server 套件单独 2/2 通过 29 s/27 s）。项目负责人据此裁定
**不关闭 M2**。

### 1. 裁定：Option B —— 先修 TOOLING-P2，再关闭

**理由（负责人原话的要点）**：本项目的验收标准一直包含"测试通过 **+ 进程自行退出** + 无 orphan/残留
句柄"。在 milestone 最后一刻把它降级成"只要有一次 exit 0 就算完成"，等于**改判据来适配观测**，
而这正是整个流程一直在防的事。

因此：

- **不创建** `m2-closed`；**M2 保持 NOT CLOSED**；
- **不进入 M3 正式 kickoff**；
- 先开一个**非常窄**的 TOOLING-P2 closure task（见 §3）。

### 2. 当前状态口径（统一表述，任何报告/发布说明都用这套词）

| 项 | 状态 |
| --- | --- |
| M2 Phase 2 **feature** | **COMPLETE** |
| M2 Phase 2 **evidence** | **COMPLETE** |
| A7 **functional / security review** | **COMPLETE** |
| **M2 milestone** | **NOT CLOSED** |
| 唯一 blocker | **TOOLING-P2 test-runner liveness**（普通工程 blocker，不需要负责人再选方案） |

### 3. TOOLING-P2 closure task（唯一目标，不得扩张）

**只解决一件事**：`pnpm test` / `pnpm --filter @insighthub/server test` 为什么在**所有测试 PASS 后**
仍会偶发不退出。

**优先诊断，不得先改 production semantics。** 必须先给出机制解释，再谈修复。诊断面至少覆盖：
open handles、`child_process` / `tsx` 生命周期、`server.close()`、`WebSocketServer.close()`、
timers、SQLite 句柄、worker/subprocess、test teardown 竞态。

**Acceptance（八条，缺一不可）**：

1. 找到**可解释的 root cause**（机制级，不是"重跑就好了"）；
2. 修复后不得依赖 timeout / force kill / `--test-force-exit` 制造 false success；
3. **server suite 与 root `pnpm test` 都能稳定自行退出**；
4. **重复运行验证**，不能只跑 1 次（必须给出连续 N 次的记录）；
5. 修复后在**最终 integrated HEAD** 上重跑 `pnpm typecheck` / `pnpm test` / `pnpm build` /
   `node tests/browser/run.mjs`；
6. working tree clean；
7. 再交 **A7** 做 M2 closure review；
8. A7 通过后，A0 再向项目负责人**请求一次 `m2-closed` tag 授权**（本裁定不授权）。

**为什么这是一条独立任务而不是"顺手修一下"**：它要交付的是**判据的可信度**。一个偶尔永不返回的门禁，
无法区分"通过"与"卡住"——这种不确定性不能靠"多数时候是绿的"来消化。

### 4. Q2（已确认）：D-069 §3 的取代有效

负责人确认废止旧禁令 1（"不得声称 UI 门控已生效"），因为它已与代码事实冲突。以下四条**继续冻结**，
不得放宽：

1. **UI gate 不是 security boundary**；
2. authorization 仍由 **server enforcement** 保证；
3. revocation **不是** existing socket 的即时身份撤销；
4. role change **没有**实时 push 到已有客户端。

定性：属**事实更正**，不属安全承诺降级。

### 5. Q3（已确认）：不放宽 B3 的 diff 规则

6 处 `B3-residual` 保持为 **R4**（M3 kickoff 的具名风险），**不**为清 residual 反向修改已冻结的 B3
acceptance。若将来要处理，单独开一个 scope 明确的 task。

**后果。** M2 的关闭权从"实现完成"重新交回到"门禁可信"；代价是一轮诊断与复验，收益是 milestone 关闭时
"门禁绿"这句话重新具备可验证的含义，而不是一次侥幸的 exit 0。

---

## D-071 · 2026-10-21 · accepted · TOOLING-P2 关闭：那不是"卡住"，是一次被吞掉的红色运行 (M2 closure)

**背景。** D-070 把 M2 关闭卡在 TOOLING-P2 上。A3 交付 `agent/a3-tooling-p2 @ 3fe6a54`（6 个文件，
**全部在 `apps/server/src/rooms/**`，0 生产代码**），A0 复核后以 `--no-ff` 合入（`d8a2a99`）。

### 1. root cause（机制级，已接受）

**"全绿后挂起"从来不是绿色。** 心跳集成测试在机器有负载时偶发失败（`not ok 51 - M1-A3 heartbeat`，
`waitUntil` 4 s 超时）；失败路径**跳过了** `awareness.destroy()`（它写在测试体成功路径末端），
`y-protocols` 的 `Awareness` 构造函数留下的 **ref'd** 3 s `setInterval` 因此无人清理 →
测试文件子进程事件循环永不 drain → `node:test` 协调进程永远等待 → **聚合汇总（`1..` / `# tests` /
`# pass` / `# fail`）永不打印** → 外部看到"结果都打完了，然后不退出"。

关键事实：挂起日志里**一直有 `not ok`**，只是唯一会给出失败计数的那几行从未打印。
因此**所有挂起运行都不得被引用为"测试通过"**——包括 A0 之前据其报告过的那些。

心跳测试自身的缺陷是：它注入了 **40 ms / 60 ms** 窗口（`intervalMs < timeoutMs`，与生产相反），
把活性测试变成了调度延迟测试——`sweep()` 每轮先把存活标记置 false，下一轮若仍未置 true 就 terminate，
于是活着的 peer 只要 pong 晚于 40 ms 就被误杀。生产是 `interval 30 s > timeout 10 s`
（`rooms/constants.ts`），不存在该窗口，故**生产语义无需修改**。

### 2. 修复（测试层，两件事）

| 改动 | 作用 |
| --- | --- |
| `createTestAwareness(doc)` 统一创建客户端 `Awareness` 并 `unref()` 续期定时器（**7** 处调用点全迁：`protocol-robustness` ×2、`sync-isolation` ×3、`authz-enforcement` ×1、`room-lifecycle` ×1） | 测试结束后即使忘记 `destroy()`，也只能浪费少量 CPU，**不能阻塞进程退出** |
| 心跳测试窗口 40/60 → 5 s/15 s，reap 改由 `markPeerUnresponsive()` 同步驱动 | 去掉与调度延迟的赛跑；`markPeerUnresponsive` 内部调用的是**同一个** `heartbeat.sweep()`，断言逐字未改 |

A0 复核确认：无生产文件改动（`heartbeat.ts` / `ws.ts` / `registry.ts` 均未动）；`protocol-robustness.test.ts`
的 diff 只有 import、helper 调用、窗口值与注释；心跳测试的四条断言（死 peer 被 terminate、活 peer 不被
reap、awareness 移除被广播、无控制面 presence 消息、最后一人离开后房间销毁）**原文保留**。

### 3. A0 的复核证据

| 项 | 结果 |
| --- | --- |
| 集成 HEAD `d8a2a99` 上 `pnpm test` ×2 | 均 **exit 0**，**聚合汇总 4 行全部打印**，`1..64` / `# tests 181` / `# pass 181` / `# fail 0`，95 s（dev server 并行占用机器） |
| `pnpm typecheck` / `pnpm build` | **exit 0** |
| `git status` | clean |
| 失败注入 A/B（A3 交付的证据） | base **挂起**（90 s 上限，无聚合汇总）vs 修复后 **exit 1 + `# fail 1`**，37.9 s |
| 修复后重复运行（A3 交付的证据） | server 10/10、root 5/5、4 个 CPU 占用进程下 5/5，全部自行退出且打印汇总 |

**红先变绿的可观测性**：故障注入证明"一个失败的测试现在会 exit 1 并打印 `# fail`"。这正是 D-070 要恢复的
性质——红色重新可见，而不是被挂起吞掉。

### 4. 未改 `package.json`（一个重要结论）

本轮**不需要** `--test-force-exit`，也不需要改门禁命令。D-063 §2b 加 `--test-concurrency=1` 是**基于错误
归因**（以为并发就是原因）；真实原因是失败测试泄漏 ref'd 定时器。该 flag 保留不动（已证明可用），
**但不再宣称它修好了 TOOLING-P2**；是否回退到并行以省时间，留作 M3 的性能清理项，不在关闭前动它。

### 5. 新发现的具名风险 R8（未修，进 backlog）

`apps/server/src/rooms/heartbeat.ts:185-192`：每轮 `sweep()` 都 `setTimeout(...)` 并覆盖
`#reapTimers` 里的旧 timer，**没有 `clearTimeout` 旧的**。只有当 `timeoutMs > intervalMs` 时旧 timer
才会在下一轮之后触发——生产参数（30 s / 10 s）**不可达**，因此不阻塞 M2。建议修复：设置新 timer 前
clear 旧的，并在回调里校验"自己仍是最新 timer"；配一个 `timeoutMs > intervalMs` 的回归测试
（`FakeSocket` 可确定性复现）。**这解释并吞掉了 M1 期 `TOOLING-P1` 的"间歇挂起"猜测**：同一个泄漏类别。

### 6. 对"引用绿色"的约束（本条的真正产出）

从现在起，任何声称 `pnpm test` 通过的陈述，必须能给出 **exit code** 与**聚合汇总行**
（`# tests` / `# pass` / `# fail`）。只贴"测试都打完了"不算通过——TOOLING-P2 就是这样被误读的。

**后果。** M2 关闭的唯一 blocker 从"门禁会不可预测地卡住"变成"门禁可解释、可复现地退出，且红的那样会
红得看得见"。代价是一轮诊断与一批测试 helper 的收口；收益是 milestone 关闭时"门禁绿"重新有定义。

---

## D-072 · 2026-10-21 · accepted · M2 CLOSED：closure commit、tag 顺序与 R1–R8 的移交 (M2 closure)

**背景。** 项目负责人在收到 A7 closure review（GO WITH CONDITIONS，唯一 P2 条件 `C-A7-M2-1` 已由 A0
关闭）与 `344b83a` 上的四门禁结果后，**明确授权关闭 M2**，并调整了动作顺序：**先做一个 docs-only
closure commit 标 CLOSED，确认 diff 严格 docs-only，在该最终 HEAD 上重跑四门禁，然后才创建
annotated tag**。本条记录这次关闭本身。

### 1. 关闭依据（技术 closure，已由负责人接受）

| 项 | 结果 |
| --- | --- |
| 技术证据基线 | `344b83a`：`pnpm typecheck` 0、`pnpm test` 0（vitest **378** + server **181/181**，聚合汇总打印）、`pnpm build` 0、`node tests/browser/run.mjs` **48/48**（端口释放、无遗留句柄） |
| TOOLING-P2 | **闭环**：A7 独立复现"失败测试 → exit 1 + `# fail 1`"，对照组（旧写法）60 s 仍不退出；重复运行 server 5/5、root 3/3 无挂起 |
| A7 审查 | Phase 2 final review（`A7-m2-final-review.md`）与 M2 closure review（`A7-m2-closure-review.md`）均 GO WITH CONDITIONS，**条件均已关闭** |
| 仓库事实 | `m1-closed` / `m1-p0-baseline` / `m2-p0-gate` 未动；remote 仍为 none |

### 2. tag 顺序（本条的实际约束）

```text
344b83a（技术证据基线，四门禁已绿）
  → docs-only closure commit（本记录 + PROJECT/TASKS 标 CLOSED）
  → 确认 diff 严格 docs-only（只允许 docs/**）
  → 在该 closure HEAD 上重跑四门禁
  → 全绿后才创建 annotated tag m2-closed（指向 closure HEAD）
```

**为什么先文档后 tag**：tag 一旦打出，它指向的那棵树就是 M2 的最终说明。如果文档仍写 "NOT CLOSED"，
tag 就在自我否定（D-059 P1 / D-069 已两次踩过同类）。而如果先打 tag 再改文档，tag 指向的就不再是
最终状态。所以顺序是"文档先闭合 → 门禁在最终树复跑 → tag 最后"。

### 3. M2 CLOSED 意味着什么

- M1 的"没有服务端持久化"限制已移除（`M2-P0-1`，D-060）；
- "没有任何权限"的状态已移除：session authentication + document authorization 在 HTTP / WebSocket /
  UI 三层执行，服务端是唯一权威（§17、§8）；
- 门禁重新可信：失败的测试现在**红着退出并打印 `# fail`**，不再以挂起掩盖红色（D-071）。

### 4. M2 CLOSED **不**意味着什么（R1–R8 必须带进 M3 kickoff）

| # | 残留 | 归属建议 |
| --- | --- | --- |
| R1 | 吊销/过期是**请求级**的：已建 socket 不会因登出断开 | A3 |
| R2 | session 进程内；服务端重启后客户端**不会**自动重新 bootstrap | A1 + A2 |
| R3 | 角色变更**不推送**：UI 门控可能滞后到下次 join（需新控制面消息 + `PROTOCOL_VERSION` bump） | A0 → A1/A2 |
| R4 | 6 处诊断字符串仍含 mojibake（注释与标题已清零，全文件不是 0） | A3 |
| R5 | `commenter` 无浏览器行；"被拒 join 之后"的 null 窗口未单独覆盖 | A6 |
| R6 | `openApp` 仍带隐式 `arrangeAccess` 默认（当前无调用方） | A6 |
| R7 | 主 bundle 1.41 MB 未拆分 | A2 |
| R8 | `heartbeat.ts` 的 stale reap timer（生产参数不可达） | A3 |

发布说明禁令继续有效：D-064 §1 的禁令 2/3/4 与 D-066 §5（禁令 1 已由 D-069 §3 取代）。

### 5. 本次关闭**没有**做什么

- 没有修改任何代码、测试、契约或 `packages/shared/**`（closure commit 严格 docs-only，见 §2 的 diff 检查）；
- 没有移动、删除或重建既有 tag；
- 没有 push、没有创建 remote；
- 没有进入 M3：R1–R8 只被**移交**，不被解决。

**后果。** M2 从"技术已完成、记录未闭合"变为一个**可引用、可复现、文档与代码一致**的基线（`m2-closed`）。
代价是关闭前多了一轮文档修正与重跑；收益是下一个里程碑接手时，"M2 已经做完什么、明确没做什么"这两件事
都在仓库里，而不是在对话里。

---

## D-073 · 2026-10-21 · accepted · AUTOPILOT_MODE：A0 的常驻调度授权与边界 (project governance)

**背景。** 项目负责人离席，启用 `AUTOPILOT_MODE`，授权 A0 在不经产品负责人参与的情况下持续推进仓库，
并把"什么可以自行裁定 / 什么必须停下"写成封闭清单。本条把它落盘——**这类授权如果只存在于聊天里，
下一次 context rotation 后就不存在了**。

### 1. A0 可自行裁定（不再询问负责人）

按 Gate / Acceptance 推进，而不是按时间。典型包括：typecheck / test / build / browser 失败、fixture 漂移、
shared 契约升级导致的 fake 编译失败、ownership support exception（最小 + 具名 + 留痕 + Why Required）、
文档与代码状态不一致、stale verifier、flaky test 诊断、async/concurrency/race 修复、integration 冲突、
测试覆盖缺口、failure injection、browser harness 问题、小范围 API wiring、已冻结 contract 的**实现细节**、
已冻结 architecture 内的代码设计选择、CSS/UI presentation engineering choice、依赖的内部使用方式
（不引入重大新 runtime dependency）、docs/TASKS/DECISIONS 同步、非破坏性 Git 操作。

### 2. 只有以下情形才 `OWNER_DECISION_REQUIRED`

产品 scope 变化 / milestone 边界变化 / 用户可感知的核心 workflow 变化 / permission·security semantics 变化 /
durability 承诺变化 / 必须推翻 frozen architecture 或 frozen contract / 非预期 wire protocol 改动 /
新的重大 runtime·framework·database 依赖 / destructive Git（reset 公共历史、rebase 已集成历史、force push、
删除或移动 milestone tag）/ 两个合理方案造成不同产品行为 / 需要真实 credential·secret·付费服务 /
数据删除或不可逆 migration。**出现时必须给 A/B/C + 推荐 + 影响；若其它 DAG 能继续，先继续其它工作。**

### 3. Gate 与"不许降标准"

- **Agent 分支绿 ≠ milestone 绿**：最终 Gate 必须在 **integrated HEAD** 上重跑。
- 默认 Gate：`pnpm typecheck` / `pnpm test` / `pnpm build` / `node tests/browser/run.mjs`；
  命令真实 exit 0、**test runner 必须自行退出**（D-071 的 `# pass/# fail` 汇总必须打印）、
  browser 必须真 Chrome + 真 backend、restart 证据必须真进程重启、working tree clean。
- **禁止**：注释失败测试、放宽 assertion、把必需契约成员改可选、为 fake 改生产语义、timeout 当 PASS、
  catch 后 false success、用 mock 代替应有的 browser evidence、绕过真实 server、为 UI 绕过权限、
  为 AI 绕过 Yjs、因为"只剩一点"把 blocker 降级成 backlog。

### 4. Git 与 tag

- 允许：新建 branch / worktree、commit、`--no-ff` merge、删除已完成且确认不再需要的临时 worktree、
  只读 Git 查询、integration-only 的 support 修复。
- 禁止：push（当前无 remote）、改写共享历史、移动/删除既有 milestone tag。
- **新增 milestone tag**：本仓库的 governance（D-053 §5）仍要求负责人明确授权。因此 autopilot 下 A0 只
  **准备** closure（条件全绿时），在打 tag 这一步**只请求 tag 授权**，并继续其它不依赖 tag 的工作。

### 5. 报告与 context rotation

- 关键决策必须留在仓库（commit / TASKS / DECISIONS / review 报告 / gate 输出），**不能只留在聊天**。
- 负责人回来后期望看到一份 `AUTOPILOT PROGRESS REPORT`：离开时 SHA / 当前 SHA / 完成阶段 / 各 Agent 产出 /
  commits 与 merges / 每道 Gate 的数字 / 发现并修掉的 regression / 未解决项 / owner decisions /
  当前 DAG 位置 / working tree·tags·remote / 下一步是否已在跑。
- A0 上下文过长、出现"依赖记忆"或 chat 与仓库冲突时，**允许自行 context rotation**：不 reset 仓库、
  不改 branch/history，新 A0 从 docs + git reconstruction 重建。

### 6. 项目完成定义（不得由某个 Agent 的 "done" 代替）

M1 CLOSED + M2 CLOSED + UI redesign integrated 且有回归证据 + M3 完成 + M3 final A7 review + 全仓四门禁绿 +
browser 套件绿 + docs 与代码一致 + residuals 具名 + main clean + 无 unresolved P1/P2。只剩 P3/backlog 时
可关闭项目阶段，但必须诚实列出 residual risk。

**后果。** A0 的调度权与停止条件从"每轮询问"变成"封闭清单 + 自动推进"，代价是 A0 必须自己承担
更多判断；收益是负责人离席期间仓库仍按 Gate 前进，且回来后能从事务记录而不是聊天记录里恢复状态。

---

## D-074 · 2026-10-22 · accepted · UI Redesign 集成：53/53、身份重挂载竞态、两个后续项 (post-M2 UI phase)

**背景。** 项目负责人在 M2 关闭后要求按冻结 prompt 做一轮低风险 UI redesign（Topbar → Document Header →
单一画布），条件是不得改变协作/权限/协议/持久化实现。A2 交付 `b7dc286`，A0 复核后合入（`49e3f47`）。

### 1. 结果

| 项 | 值 |
| --- | --- |
| A2 | `b7dc286`：6 个白名单文件（5 改 + 新增 `DocumentHeader.tsx`），`collab/**`、`packages/shared/**`、`apps/server/**`、`tests/**`、`docs/**`、`package.json` **零改动** |
| A0 复核 | 14 条 DOM 契约逐条在代码里确认；唯一 `connection-status`；`role: <role>` chip 仅已知角色渲染；`undo-state` 保留；按钮 `aria-label` + `readOnly \|\| !canUndo` + `runSessionHistory` |
| A6 | `38c41b5`：只改 `tests/browser/**`，场景 **48 → 53**（新增 `m3/0…m3/4`） |
| 集成 | `49e3f47`（A2）、`9800612`（A6） |
| 最终门禁（`9800612`） | typecheck 0 / test 0（vitest **378** + server **181/181**）/ build 0 / browser **53/53**、0 failed、0 errored、端口释放、无遗留句柄 |

### 2. 集成时抓到的竞态（既有潜在缺陷，不是 A2 引入）

全量套件首次跑出 `indexeddb/B-offline-edits-survive-reopen` → `no element matches .cm-content`，但该场景
单独跑 3/3 通过。机制（A6 用页面 instrumentation 实测，不是推测）：

```text
占位身份 session 建立 → editor mount（此时 topbar 还没有 session-identity）
POST /api/session/bootstrap 返回 → presence user 的 id/name 变化
useCollaborativeDocument 的 effect 依赖 userId/userName → 销毁并重建 session
→ editor unmount → remount（这一次 mount 在 identity 之后）
旧的 waitForSessionActive 只要求 .cm-editor + connection-status → 可在窗口内返回
→ typeInEditor 点击 .cm-content 时元素已不存在
```

相关代码行在 A2 之前的**基线上完全相同**，所以这是被"更快首屏"放大的既有竞态。A6 的修复是**更严格的
终态等待**（identity 已渲染 + bootstrap 结果已知 + 有 server identity 时必须等到 post-identity mount），
**没有** retry、没有加大超时、没有 skip、没有放宽断言；并新增 `m3/0` 作为确定性回归（注入慢 bootstrap）。
`tests/browser/README.md` 记录了"编辑器会因身份落地 remount 一次"这一**产品事实**。

### 3. 三项裁定

| # | 问题 | 裁定 |
| --- | --- | --- |
| 1 | Undo/Redo 按钮的测试选择器 | **用 `button[aria-label="Undo"]` / `"Redo"]`**，不新增 `data-testid`（避免把视觉改动扩散成测试契约）。A6 已按此实现 |
| 2 | 是否接受 53/53 作为 UI 与后续 M3 的浏览器门 | **接受**：既有 48 场景断言零改动、新增 5 场景、A6 连续两次 53/53、A0 在 integrated HEAD 再跑一次 53/53 |
| 3 | pre-existing 的 remote cursor label 定位缺陷 | **修**（不再只记录）。它是真实协作可用性缺陷，且可见；作为 A2 的小范围后续项，必须保留现有 `cursors/*` 场景并通过 |

### 4. 一个**未验证**的产品说法（不得当成事实）

A6 报告里有一句"bootstrap 慢时，用户在身份落地前输入的文字会随占位 session 销毁而丢失"。这是**推断，
尚未测量**：占位 session 与新 session 共享同一个 `persistenceKey`（documentId），IndexedDB 里已有本地副本，
文本很可能在新 session 加载时被重放回来；真正的风险窗口只是"teardown 前未 flush 的那几个 update"。
因此：**在测量之前，不得把"会丢失"写进文档或发布说明**。已作为 A2 的测量项（用 A6 新增的
`bootstrapDelayMs` 注入慢 bootstrap，在窗口内输入，再检查 durable 文本与新 session 的文本）。

**【2026-10-22 勘误·测量结果：该推断被否定】** A2 用真实浏览器 + 真实 IndexedDB + 真实 SQLite
在 `bootstrapDelayMs = 1200` 与 `2500` 下测量：窗口内输入的两段唯一标记，在 identity 落地、编辑器
remount 之后**同时存在于编辑器与 durable store**；窗口内 `liveDocumentSockets = 0`（文本没有走网络）。
机制：占位 session 的每次 `Y.Text` update 由 `y-indexeddb` **立即**写入同一个
`insighthub-doc:<documentId>`（日志写入不 debounce），session 销毁时 `destroy()` 的 `db.close()`
等待已建事务完成，新 session 以同一 `persistenceKey` 在 `markActive` 前重放本地副本。**没有产品级丢失，
不需要修复**；此后不得再以"bootstrap 窗口会丢字"作为已知缺陷引用。

### 5. UI redesign 的定性

这是 **presentation 阶段**，不是新 milestone：没有改任何 frozen architecture / contract / permission /
persistence；`SHARED_CONTRACT_VERSION` 与 `PROTOCOL_VERSION` 未动。因此不新增 milestone 边界，也不关闭
任何 milestone——M2 已 CLOSED（`m2-closed`），M3 尚未开始。

**后果。** 页面从"M1/M2 诊断布局"变成三层低噪音编辑器，且这次变更**可被现有 53 个真实浏览器场景
证伪**；代价是集成时暴露并修掉了一个既有的身份重挂载竞态，以及两个被如实记录的后续项
（remote cursor label、bootstrap 窗口输入的去向）。

---

## D-075 · 2026-10-22 · accepted · M3 冻结：RelativePosition 锚定、本地 provider、A–H 验收 (M3 kickoff)

**背景。** UI redesign 已集成（D-074，`9800612`，53/53）。项目负责人在 autopilot 指令中把 M3 的
核心目标固定为：AI 工具（directory / read / selection / edit）→ proposal → Diff Preview →
Accept/Reject；stale 保护用 **Yjs RelativePosition + original text validation**；accepted change
必须走 Yjs transaction；AI origin 的 undo 语义必须与 local/remote 隔离。本条是 M3 的 scope 冻结。

### 1. 仓库现状（只读重建，不是记忆）

| 项 | 事实 |
| --- | --- |
| 契约 | `packages/shared/src/ai-suggestion.ts` 已冻结 `AiEditSuggestion` / `AiSuggestRequest` / `isSuggestionStale` / `aiAcceptRequiredRole`（accept 需 ≥ editor） |
| origin | `TRANSACTION_ORIGINS` 已含 `ai`；`UNDO_TRACKED_ORIGINS = [local, ai]`，且有测试钉住 `remote`/`persistence` 不在其中 |
| 应用路径 | `CollaborativeSession.transact(fn, origin)` 已接受 `TransactionOrigin` → **AI 应用不需要改 seam** |
| 实现 | `apps/server` 与 `apps/web` 中 **0 处** AI 实现；M3 是在冻结契约上新建 |
| 前置 | M2 CLOSED（`m2-closed`）；R1–R9 已具名登记 |

### 2. 锚定：加性升级，取代 D-004 的"M4 升级路径"

D-004 写"M3 用 plain offset + `baseRevision`，RelativePosition 留到 M4"。负责人本轮明确要求
RelativePosition + original text validation，故**按加性演进**冻结（`docs/CONTRACTS.md` §11.1）：

- 每个 operation **必须**带 `anchor: { start, end?, expectedText }`（Yjs `RelativePosition` 的 JSON 编码）；
- `index`/`length` 保留（用于 Diff Preview 渲染与可读性），但**不是**应用时的权威；
- 应用前按顺序校验：① `baseRevision` → ② anchor 能在当前 `Y.Text` 上解析 → ③ 解析出的文本**逐字**等于 `expectedText`；
- 任一失败 → `stale`，**绝不部分应用**；
- `SHARED_CONTRACT_VERSION` **7 → 8**；`PROTOCOL_VERSION` 不变（建议走 HTTP/内存，不上 WS wire）。

**为什么 RelativePosition 不够、必须加 `expectedText`**：Yjs 会保留被删除位置的"墓碑"，删除后的
RelativePosition 仍能解析到一个相邻位置。只靠 anchor，"解析成功"可能对应**完全不同的文本**。
`expectedText` 是把"解析成功"升级成"仍然是你审阅过的那段文字"的唯一判据。

### 3. M3 范围（冻结）

1. **AI tools（客户端）**：document directory（列出可读文档）、read（读当前 `Y.Text`）、selection（当前选区/位置）、edit（构造 `AiEditOperation[]`）。
2. **Proposal**：`AiEditSuggestion`（summary + operations + unified diff），**永远不是文档状态**。
3. **Diff Preview**：渲染 proposal 的 diff 与 summary；未 Accept 前 `Y.Text` 一字节不变。
4. **Accept / Reject**：Accept → 重新跑 §2 的三段校验 → 在 `session.transact(..., TRANSACTION_ORIGINS.ai)` 内应用；Reject → 只改 proposal 状态，不碰 `Y.Text`。
5. **Stale 保护**：Accept 时校验；失败即拒（UI 显示 stale，要求重新生成）。
6. **Undo 隔离**：AI 编辑被 `UNDO_TRACKED_ORIGINS` 跟踪（本地 undo 可以撤回自己的 AI 编辑），但**绝不**回滚 remote；不实现快照式 undo。
7. **权限**：生成要求 `canRead`（内容本就可读）；**Accept 要求 `canEdit`**，UI 用 `capabilityGate` 门控，服务端仍在 WS 写路径拒绝越权；viewer/commenter **不得**通过 AI 绕过。
8. **离线**：离线可生成（基于本地 `Y.Text`）；Accept 后的写入本地即生效，重连后按 CRDT 合并；**不得**产生重复 apply。

### 4. M3 round 1 的边界：**不接入外部 AI 服务**

autopilot 规则把"需要真实 credential / 外部付费服务"列为 owner decision。为避免用一个未授权的
外部依赖驱动整个里程碑，M3 round 1 冻结为：

- 一个 **`AiProvider` seam**（A4 定义，客户端）；
- 默认实现是**确定性本地 provider**（基于指令做可预测的改写/扩写/缩短，产出真实 diff 与锚点）；
- **不新增运行时依赖、不新增 HTTP 端点、AI 生成本身不发网络请求**（provider 是纯函数式的本地变换）；
- `features/ai/tools.ts` 里的 `listDocuments` 会调用**既有**的 `GET /api/documents`（M2 Phase 2 端点），
  但 M3 round 1 的 UI **没有**接它——它是"directory 工具"的落点，等 round 2 接线或删除（F8）；
- 换成真实模型（含服务端代理、API key、计费）属**单独 owner decision**，不在本轮。

这不是"AI 功能缩水"的借口：M3 要验证的是**提案 → 审阅 → 应用 → 撤销**这条闭环与它的安全语义；
provider 是可替换的输入源。报告与发布说明**不得**把本地 provider 说成"接入大模型"。

### 5. DAG 与 ownership

```text
A0  冻结契约/架构（本条 + CONTRACTS §11.1 + ARCHITECTURE §3）   ← 本轮
 ├─ A1 锚定与校验助手（shared 实现 + 版本 8）+ transact(origin) 接线
 ├─ A4 AI tools + provider seam + proposal 生成（客户端编排）
 ├─ A2 Diff Preview / Accept-Reject UI（只消费 proposal + gate）
 ├─ A5 AI 操作的权限一致性复核（canEdit for accept；viewer 不可绕过）
 ├─ A3 仅当需要服务端端点时（本轮不需要）
 ├─ A6 真实浏览器 + 并发/离线/stale 负向证据
 └─ A7 M3 final review
```

顺序：**A1 → A4 ∥ A2（A2 依赖 A4 的 proposal 类型，可先按冻结类型并行）→ A5 复核 → A0 集成 → A6 → A7**。

### 6. M3 Acceptance（A–H，冻结）

| # | 判据 | 证据层 |
| --- | --- | --- |
| A | Accept 后修改走 **Yjs transaction**（`ai` origin），第二个客户端看到的是普通 CRDT 编辑 | 浏览器 |
| B | Reject **不修改** `Y.Text`（文本与 durable 均不变） | 浏览器 |
| C | stale 建议**不得**被应用：revision 变化 / anchor 失效 / `expectedText` 不匹配三种情形各自被拒 | Node（确定性）+ 浏览器 |
| D | RelativePosition 在**并发编辑**后行为正确：另一客户端在建议区域外编辑 → 仍可应用；区域内变更 → `expectedText` 拒绝 | 浏览器 + Node |
| E | undo 隔离：本地 undo 能撤回自己的 AI 接受；**不**回滚 remote；AI 编辑不被 `remote` undo 影响 | 浏览器 |
| F | 权限：viewer/commenter 不能通过 AI 绕过写权限（UI 不提供 + 服务端拒绝）；accept 需 `editor` | 浏览器 + Node |
| G | 离线：离线生成可用；重连后**不重复 apply**；多客户端收敛 | 浏览器 |
| H | 既有 53 场景**零回归**；四门禁在 integrated HEAD 全绿 | 全部 |

R1–R9 继续作为具名残留带入本 milestone 的实现与最终 review；**不因 M3 开工而删除任何一条**。

**后果。** M3 从"A4 直接写 AI 功能"变成"先冻结锚定与 provider 边界，再由 A1/A4/A2/A5 分头实现、
A6 用真实浏览器证伪、A7 终审"。代价是多一轮契约与实现分离；收益是"stale 建议不会被错误应用"
这件事有**可执行的判据**（三段校验），而不是一句承诺。

---

## D-076 · 2026-10-22 · accepted · M3 实现集成：revision 归属、UI 集成与四条裁定 (M3 round 1)

**背景。** 按 D-075 的 DAG，M3 round 1 依次落地：A1 锚定（`df16a73`）、A4 编排（`5826cc2`）、
A2 Diff Preview（`5db7db1`）。本条记录集成期间由 A0 做出的裁定，以及两处"看起来像缺陷、实际不是"的
行为，避免它们被后续 agent 当成 bug 重新"修"一遍。

### 1. 集成与门禁

| 项 | 值 |
| --- | --- |
| 合入 | `0bb8af4`（A1）→ `987495c`（A4）→ `20c3470`（A2） |
| 最终门禁（`20c3470`） | typecheck 0 / test 0（vitest **465** + server **181**）/ build 0 / browser **53/53** |
| 禁区 | 三棒均未触碰 `packages/shared/**`（A1 除外，且是经批准的契约实现）、`apps/server/**`、`collab/**`、`tests/**`、`docs/**`、`package.json` |

### 2. `revision.ts` 的归属：A2 具名例外（Why Required）

`applySuggestion` 的 check #1 需要 `baseRevision` / `currentRevision`，而全仓没有任何计数器：A4 的
provider 是纯函数、不拥有状态与时间；seam 也不暴露 revision。因此：

- 由 A2 在 `apps/web/src/features/ai/revision.ts` 实现 `createLocalRevisionTracker(doc)`（只计
  `local` / `ai` origin），作为**具名 ownership 例外**（最小、留痕、写明理由）；
- 语义已冻结在 `docs/CONTRACTS.md` §11.1，**不是**实现细节：若按"任意 update"计数，远端编辑会让
  check #1 失败，直接违反验收 D；
- **下一次 A4 触碰 `features/ai/` 时，该文件转回 A4 ownership**；在那之前它是例外而不是新规则。

### 3. 四条裁定

| # | 问题 | 裁定 |
| --- | --- | --- |
| 1 | `AiSuggestInput.anchorText: Y.Text`（A4 的 seam 增补） | **接受**。锚点必须从**活的** `Y.Text` 铸出；用临时 `Y.Doc` 重放同一字符串会因 client id 不同而必然 `anchor-unresolved`（A4 有测试钉住）。这是机制必需，不是接口膨胀 |
| 2 | 同 index 的 `insert` + `replace` | **判 `malformed`，拒绝应用**（A4 实现）。两种顺序产生不同文档，不能"尽力应用"；静默错位是 AI 写入里最严重的一类 |
| 3 | UI 是否显示 base/current revision 数字 | **不显示**（只在 `ai-proposal` 的 data 属性里）。它是内部分析量，对用户没有意义；显示出来反而暗示"可以手动对齐" |
| 4 | `revision.ts` 之外的 `features/ai/` 文件 | A4 的 5 个模块**零改动**；A2 只新增 `revision.ts` |

### 4. 两处"不是缺陷"的行为（防止被误修）

**（a）`Y.UndoManager.captureTimeout = 500 ms` 的合并。** 若用户"打字 → 立刻接受 AI 建议"发生在
500 ms 内，两次事务会被合并成一个 undo item，一次 Undo 会同时撤回两者（A2 的探针第一次正是这样测到
文本变空的；加 1.2 s 间隔后测得"一次 Undo 只撤回 AI 编辑"）。这是 Yjs 的既定合并语义，**不涉及
remote**，也不违反 R13（仍然只撤回本地/AI origin）。**不要**为了这个改 `captureTimeout` 或改 undo
实现；若将来确实需要更细的粒度，那是一次独立的、有证据的变更。

**（b）服务端拒绝后的本地副本。** `applySuggestion` **不做**权限判定（A2 在 UI 上按
`capabilityGate.canEdit` 门控 Accept，服务端在 WS 写路径仍是唯一权威）。

**勘误（A5/A7 实测纠正）。** 这里原先写"已知角色为 `viewer` 但离线时点 Accept"——**那个状态不存在**：
离线时 `getRole()` 恒为 `null`（`document-session.ts`），所以离线能点 Accept 是"未知角色按可编辑处理"
（R10 / §17.9），不是门控失效。真实行为（A5 实测、A6 的 `m3/11` phase 2 永久钉住）：未知角色离线点
Accept → 本地写入 + IndexedDB 持久化 → **不出站**（非 editor 时服务端不发 `SyncStep1`，客户端永不被
要求发 `SyncStep2`）→ 重连 **0 FORBIDDEN**、durable 不变 → reload 后本地分叉仍在（客户端持久化）。
它与"离线打字"是**同一类**既有本地分叉，不是 AI 新增的旁路；**本地分叉不会自愈**。若该用户之后被提升为
`editor` 并重新 join，这段分叉会作为普通 CRDT 更新补交落库（A5 已验证）。是否加咨询性预检见 D-077。

**后果。** M3 的"提案 → 审阅 → 应用"闭环在 `20c3470` 上真实可运行，且三条最容易被写错的语义
（锚点边界、revision 是本地量、undo 合并）都已在仓库里有据可查，而不是等着下一个人重新踩一遍。

---

## D-077 · 2026-10-22 · accepted · M3 round 1 终审：A7 GO WITH CONDITIONS、条件关闭、P3 处置 (M3 acceptance)

**背景。** A7 对 M3 round 1 做了独立终审（`docs/agent-governance/A7-m3-final-review.md`，基线 `990b9be`）：
**GO WITH CONDITIONS**，P1 = 0、P2 = 2、P3 = 10。它自己跑了四门禁（60/60）、21 个对抗性探针、
以及"把 `expectedText` 比较改成恒真"的 mutation（3 文件 4 测试红、还原后绿）。本条记录条件的关闭与
所有 P3 的处置。

### 1. 两个 P2（已修，本轮 commit）

| # | 问题 | 处理 |
| --- | --- | --- |
| F1 | `PROJECT.md` / `TASKS.md` 仍写 M3 "not started" | 改为"round 1 已实现并通过 A7 终审；milestone 尚未 CLOSED"，与 A6 的 60 场景一致 |
| F2 | `ARCHITECTURE.md` §3 仍写"远端移动也 stale"，与 §11.1 及验收 D 冲突 | 改写为三段校验各自负责什么：revision 只抓**本地**改动、anchor 解决"位置"、`expectedText` 抓"区域内被改" |

### 2. P3 逐条处置

| # | 问题 | 处置 |
| --- | --- | --- |
| F3 | §11.1 第 2 行括号写"删除的 anchor 解析不到"（与机制相反） | **已修**：改为"删除的 anchor 仍会解析到相邻位置，由 check 3 抓" |
| F4 | D-076 §4b 的"已知 viewer 但离线"状态不存在 | **已修**：离线 `getRole()` 为 `null`，走未知角色路径；补 A5 实测链条 |
| F5 | D-075 §4 "不发网络请求"与 `listDocuments` 的 GET 不符 | **已修**：区分"AI 生成本身不发请求"与"directory 工具用既有端点、但 round 1 未接线" |
| F6 | `revision.ts` 注释称 undo 会移动计数器（实测不会） | **已修注释**：undo 的 origin 是 UndoManager、不计数；后果是 fail-closed（由 anchor/expectedText 报 `text-mismatch`）。**不改行为** |
| F7 | `ai-suggestion.ts` 注释仍提 `RelativePosition.toJSON()` | **已修**：明确该实例方法在 yjs 13.6.33 不存在，用 `relativePositionToJSON` 一对 |
| F8 | `listDocuments` / `aiAcceptRequiredRole` 零消费者 | **记录**：前者是"directory 工具"的落点，round 2 要么接到面板、要么删除；后者是共享词表，等第一个服务端 AI 检查时使用。两者都**不得**在文档里说成"已启用" |
| F9 | 面板未捕获 provider **同步**抛出 | **记录，不修**：唯一 provider 是 `async`，当前不可达；引入第二个 provider 时必须把 seam 收紧（`AiProvider.suggest` 实现必须是 async 或面板加 try） |
| F10 | `applySuggestion` 在 `transact` 中途抛错无法回滚 | **记录**：Yjs `transact` 不抛业务错误；可达性为零，不在本轮加补偿逻辑 |
| F11 | 大文本时 diff fallback 预览行数膨胀 | **记录**：只影响展示，apply 不读 diff（D-076 §4）；round 2 可加折叠 |
| F12 | `anchor-unresolved` 与 `commenter` 无浏览器证据 | **记录**：前者有 Node 证据（A1），后者与 `viewer` 同走 `canEdit=false`（A5 代码级 + `p2` 服务端证据）。**不冒充浏览器证据** |

### 3. A5 三项的书面裁定（A7 要求）

| # | 问题 | 裁定 | 理由 |
| --- | --- | --- | --- |
| 1 | `applySuggestion` 加 `reason:'forbidden'` 咨询性预检？ | **不加** | 对离线窗口无效（`getRole()` 为 null，正是"未知角色可编辑"的语义）；在线窗口冗余（UI 已 disabled，服务端仍拒绝）；会增加第五种 reason 与文案，且**不能**声称它修复本地分叉。若将来加，必须同时写明"冗余护栏、不修复分叉"，且 `forbidden` 不得进 shared 的 `ValidationFailureReason` |
| 2 | `aiAcceptRequiredRole` 零消费者 | **保留** | 它是共享 RBAC 词表的一部分；当前 `canEdit` 与它语义等价；删掉会让"accept 需 ≥ editor"这条契约失去可复用表达 |
| 3 | commenter 的专用浏览器场景 | **本轮不加** | `capabilityGate` 对 commenter 与 viewer 走同一条 `canEdit=false` 路径；已有 viewer 场景 + 服务端 `p2` 证据。若 M3 round 2 引入按角色差异化的 AI 行为，再单独加 |

### 4. M3 round 1 的 9 条已知限制（必须进发布说明，不得包装为"已完成"）

1. provider 是**确定性本地 provider**，不是大模型；不接外部服务、无凭据、无网络生成。
2. `anchor-unresolved` 只有 Node 证据（浏览器场景覆盖 `revision` 与 `text-mismatch`）。
3. `commenter` 无专用浏览器场景（与 `viewer` 同路径）。
4. 离线**未知角色**的 Accept 会产生本地分叉：不出站、不自愈、reload 后仍在；被提升为 editor 后才会补交。
5. `Y.UndoManager.captureTimeout = 500 ms`：打字后立刻接受，可能与 AI 编辑合并成一个 undo item。
6. `revision` 是**客户端本地**量；提案不可跨客户端共享其 `baseRevision` 语义。
7. `listDocuments`（directory 工具）与 `aiAcceptRequiredRole` 目前无运行时消费者。
8. diff 是行级近似（CRLF 归一、无 `\ No newline` 标记、大段有整体替换回退）；apply 不读 diff。
9. 主 bundle 955 kB 未拆分（R7 继续）；Firefox/Safari 与跨平台未验证。

### 5. 状态

M3 **round 1 被接受**（A7 GO WITH CONDITIONS，条件已关闭）；**milestone 仍未 CLOSED**。
按 D-053 §5 / D-073 §4，`m3-closed` 属新的 milestone tag，**必须由项目负责人明确授权**。
R1–R10 与本节 9 条限制一并带入 round 2 / 发布说明，**不得因收口而删除**。

**后果。** M3 的"AI 提案"从一句承诺变成一条有独立终审、有对抗性探针、有 mutation 证明、有 7 个永久浏览器
场景的可证伪链路；代价是把"哪些事**没有**被验证"写成了 9 条具名限制，而不是留一句"基本完成"。

---

## D-078 · 2026-10-22 · accepted · M3 original-scope reconciliation：directory 是 PARTIAL、deterministic provider 不是原始 scope (M3 reconciliation)

**背景。** 项目负责人要求：M3 不得因 A7 round-1 GO 就假定完成；必须从**最早的仓库事实**重建 M3
Acceptance，逐项标 DONE / PARTIAL / NOT IMPLEMENTED / EXPLICITLY DEFERRED BY OWNER，并特别确认两件事：
directory 是否原本是 required capability；deterministic local provider 究竟是"当前实现"还是"原始
milestone 明确允许只做到这里"。

### 1. 重建所用的仓库事实（不是记忆）

以 `m2-closed`（`435c869`）为基线读取的原文：

| 来源 | 原文 |
| --- | --- |
| `docs/PROJECT.md` M3 行 | "AI request pipeline, suggestion + diff, Diff Preview, Accept/Reject/Undo applied via Yjs transaction" |
| `docs/TASKS.md` M3 sketch | "AI request pipeline, suggestion + diff generation, Diff Preview, Accept / Reject / Undo applied through a Yjs transaction. Owner: A4." |
| `docs/ARCHITECTURE.md` §3 | Document → AI Request → Suggestion（proposal：summary + operations + diff）→ Diff Preview → Accept/Reject → Yjs Transaction |
| `docs/CONTRACTS.md` §11 | `AiSuggestRequest { documentId, instruction, baseRevision, content }`，`content` ≤ 200 000 chars |

**结论一：原始仓库口径里没有 "directory" 工具，也没有指定任何外部模型/供应商。**
"directory / read / selection / edit" 这组 AI tools 来自负责人在 autopilot 指令中给出的 M3 任务描述
（比仓库 sketch 更新、且属 owner-level scope），因此它**是 M3 现行 scope 的一部分**，但不属于最初的
PROJECT/TASKS/ARCHITECTURE 文字。

### 2. 逐项状态（以 `881dd0e` 为代码事实）

| 能力 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| directory | **PARTIAL** | `features/ai/tools.ts#listDocuments` 已实现（`GET /api/documents`，带 AbortSignal），但**没有任何 UI 消费者**（A7 F8）。不算 DONE |
| read | **DONE** | `readDocumentText(session)` 实时读 `Y.Text`；`AiSuggestRequest.content` 即读取结果 |
| selection | **DONE** | `selectionRef` → `AiSuggestInput.selection`；`m3/8` 用真实键盘选区（6..11）验证 |
| edit | **DONE** | `replace` / `insert` 两类 operation，anchor 只经 `createOperationAnchor` 生成 |
| Diff Preview | **DONE** | `ai-summary` / `ai-diff`；`m3/5` 断言 diff 非空且 Accept 前文本不变 |
| Accept | **DONE** | `applySuggestion` 三段校验 → 单次 `ai` 事务；`m3/5` |
| Reject | **DONE** | 只清提案、不碰 `Y.Text`；`m3/6` |
| RelativePosition | **DONE** | `anchor{start,end?,expectedText}`，v8；A1 的 16 个测试 |
| expectedText / original-text validation | **DONE** | 三段校验第 3 步；`m3/9` 的 `text-mismatch` |
| Yjs transaction | **DONE** | `session.transact(fn, TRANSACTION_ORIGINS.ai)`；A7 用 `afterTransaction` 断言 |
| AI-origin undo isolation | **DONE** | `UNDO_TRACKED_ORIGINS = [local, ai]`；`m3/5` + 既有 remote 不撤销场景 |
| permission enforcement | **DONE** | UI `canEdit` 门控 + `accept()` 第二守卫 + 服务端 frame gate；`m3/10`、A5 复核 |
| **真实 LLM provider** | **NOT IMPLEMENTED** | 只有确定性本地 provider |

### 3. 结论二：deterministic provider 是**A0 的 round-1 边界**，不是原始 milestone 的允许范围

必须把这句话写清楚，不能让"round 1 已 GO"被读成"原始 scope 本来就只要求本地 provider"：

- 原始 PROJECT/TASKS/ARCHITECTURE **没有**对 provider 作任何规定（既没要求外部模型，也没说只能是本地实现）；
- `D-075 §4` 把"确定性本地 provider、不接外部 AI 服务"冻结为 **round 1 的边界**，理由是 autopilot 期间
  不能引入需要凭据/付费的外部依赖。这是 **A0 的约束**，**不是**原始 milestone 的终点；
- 负责人随后明确"项目要真实上线、必须支持真实 production AI provider"（Part C）。因此
  **真实 provider 属于 M3 未完成的部分**，不是"未来增强"。

### 4. 处置（对应负责人 Part F 的顺序）

| # | 事项 | 处置 |
| --- | --- | --- |
| 1 | directory（PARTIAL） | **最小 Round 2**：把 `listDocuments` 接进 AI 面板，作为**只读目录**（列出当前身份可读的文档、标出当前文档）；选中另一文档时复用既有 **文档切换** 语义（`documentSelected`），面板保持打开，随后生成/审阅/应用仍只针对当前文档。**不新增**跨文档提案或跨文档应用语义 |
| 2 | 真实 provider | 按 Part C 实现 `OpenAIProvider`（**服务端**持有 `OPENAI_API_KEY`，browser 不接触 key）；`DeterministicProvider` 保留，Gate 与 CI 仍只用它；live smoke 仅在存在 key 时 opt-in |
| 3 | `m3-closed` | **暂不请求**。先完成 1+2 → M3 integrated Gate → A7 复审 → 再按 D-053 §5 请求一次 tag 授权 |
| 4 | 原始 scope 的边界 | **不改写**：M3 仍是"提案 → 审阅 → 应用 + stale + 权限 + undo 隔离"；真实 provider 是**补齐**，不是新 scope |

**后果。** "M3 已完成"这句话被拆成了可核对的 13 行状态表：11 项 DONE、1 项 PARTIAL（directory）、
1 项 NOT IMPLEMENTED（真实 provider）。代价是 M3 的关闭被推迟；收益是不会把"当前实现"说成"原始要求"，
也不会让一个 required 能力从 milestone 里悄悄消失。

---

## D-079 · 2026-10-22 · accepted · UI Visual Fidelity CLOSED：两个 Gate 与可执行的保真度检查 (UI closure)

**背景。** 项目负责人实际运行生产 UI 后判定：上一轮 UI redesign 的**结构**完成、**视觉保真度**未完成
（hover / focus / pressed / tooltip / subtle motion 不完整），并要求把
**Engineering Gate 与 Design Fidelity Gate 分开**：60/60 只证明没有功能回归，不证明视觉完成。

### 1. 交付

| 项 | 内容 |
| --- | --- |
| A2 | `4078669`（**只改** `apps/web/src/styles.css`，+106/−4）：logo hover、switcher `focus-within`、头像 hover + tooltip（hover/键盘 focus）、Undo/Redo 四态、connection pill hover-only pulse、editor `focus-within`、notice reveal、`prefers-reduced-motion` |
| A6 轮次 | 该轮**在提交前失败**（无报告）；它写好的 `32-design-fidelity.mjs`（8 个场景）完整且为绿，由 A0 接管完成 |
| A0 接管修正 | `page-instrument.js` 的 `summary.editorLive` 改为**已挂载 `.cm-editor` 的 DOM 真值**。旧实现是 MutationObserver 加/减记账，删除时只匹配"被移除节点自身是否 `.cm-editor`"；React 在一次性身份重挂载中移除的是**祖先包装节点**，减记漏掉 → 计数永久偏高 1，导致 `lifecycle/repeated-open-switch-cycles` 在全套件里偶发红、单独跑却绿。DOM 计数是**更强**的断言，记账值保留为 `editorLiveTally` 供诊断 |
| 最终门禁（`a2586c0`） | typecheck 0 / test 0（vitest **465** + server **181**）/ build 0 / browser **68/68** |

### 2. 两个 Gate 的正式定义（此后按此判定）

```text
Engineering Gate:      typecheck / test / build / browser suite（功能与契约不回归）
Design Fidelity Gate:  ui/1…ui/8（计算样式断言：hover / focus / pressed / disabled /
                       tooltip / pulse / reduced-motion / notice 文案）
```

`ui/*` 场景断言的是**可计算的视觉属性**，例如 logo hover 的 `transform` 矩阵（`rotate(-4deg) scale(1.04)`）、
switcher focus 的 accent 边框 + 3px ring + `translateY(-1px)`、头像 hover 的 `translateY(-4px) scale(1.08)` + `z-index: 4`、
Undo pressed 的 `scale(.93)`、disabled 的 `opacity .38` + `not-allowed` + 无 hover transform、
pill 仅 `connected`+hover 时的 `ih-pulse`、reduced-motion 下 `transition-duration: 0s` 而 tooltip/notice 仍可见。

**mutation 证明**：把 `.brand:hover .brand__logo` 的 transform 中和后，`ui/1-logo-hover-transforms` 立刻失败
（`last computed value "none"`），随后还原。连续两次全套件 **68/68**，集成后再跑一次 **68/68**。

### 3. 明确 deferred（不静默漏掉）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 编辑器逐行 hover / active-line 视觉 | **INTENTIONALLY DEFERRED** | 需要新增 CodeMirror extension（`highlightActiveLine*` 或自定义 hover）；负责人本轮明确"不要为了视觉新增编辑器行为 extension" |
| 本地用户 `you` 头像 | **NOT OBSERVABLE** | `getCollaborators()` 不返回本地 client；不合成第二套 presence（R14）。`isSelf` 分支保留，能力不丢 |
| 文档 id 提交后的 title flash | **INTENTIONALLY DEFERRED** | 需要额外 UI state；原型反馈项，未列入本轮验收 |

**观察（记为 R11，不阻断）**：远端光标姓名标签目前是**贴着 caret 的彩色块**，在空行/行尾时视觉上接近
"选中文字"；prototype 用深色胶囊浮在 caret 上方。属 presence 渲染的视觉打磨，需单独验收（会动 `remoteCursorExtension`）。

### 4. 状态

UI redesign **CLOSED**（Engineering Gate PASS + Design Fidelity Gate PASS）。这**不改变** M3 的状态：
M3 仍未 CLOSED，Round 2（directory 接线 + 真实 provider，D-078）是下一步。
R1–R11 继续作为具名残留，不得因 UI 收口而删除。

**后果。** "看起来像不像一个完成品"第一次进入**可执行门禁**：以后任何人改 CSS 破坏 hover/focus/pressed/
tooltip/reduced-motion，`ui/*` 会红，而不是等负责人再手动发现一遍。代价是多 8 个场景与一份需要维护的
视觉断言；收益是设计保真度不再依赖"看截图的人当天有没有注意到"。

---

## D-080 · 2026-10-22 · accepted · M3 Round 2：服务端真实 provider 的契约（draft，不是 suggestion）(M3 round 2)

**背景。** 项目负责人要求"最终必须支持真实 production AI provider"，且 credential **只能**在服务端
（`OPENAI_API_KEY`），browser 不得接触 key、不得直连 OpenAI。同时 D-078 已确认真实 provider 属于 M3
未完成部分，不是新 scope。

### 1. 核心设计选择：服务端返回 **draft**，不是 `AiEditSuggestion`

锚点是 Yjs `RelativePosition`，**replica 特定**：只有铸造它的那个客户端才能在**自己的** `Y.Text` 上正确
解析。服务端若替客户端铸锚，得到的锚在客户端会解析错或解析不到。因此冻结为两段：

```text
客户端 ──(instruction, content 快照, baseRevision, selection)──► POST /api/ai/suggest
服务端 ──► model ──► AiSuggestionDraft { summary, operations: plain offsets, model? }
客户端 ──► 用活的 Y.Text 铸 anchor（createOperationAnchor）→ 本地算 diff → AiEditSuggestion
       ──► Diff Preview → Accept → 三段校验 → 一次 ai 事务
```

契约见 `docs/CONTRACTS.md` §11.2 / §12。**模型只能产 proposal 的原料，永远不能直接写 `Y.Text`**——
这条在 round 1 由客户端 provider 保证，round 2 由"服务端只返回 draft、写入永远在客户端走三段校验"保证。

### 2. 失败一律 fail closed

`401 session_required` / `404 not_found`（非披露） / `503 ai_provider_not_configured` /
`504 provider_timeout` / `502 provider_error` / `502 invalid_provider_output` / `429 rate_limited`（预留）。
**禁止**：把畸形/部分输出修补成"看起来能 Accept"的 draft；把 provider 错误吞成空建议。

### 3. 配置

`OPENAI_API_KEY`（仅服务端，`AI_PROVIDER=openai` 时必需）、`OPENAI_MODEL`（可选）、
`AI_PROVIDER=openai|disabled|stub`。**禁止** `VITE_OPENAI_API_KEY`、禁止 key 进 bundle / 日志 / 文档 / fixture。
缺 required config 时生产启动 fail fast（M4 D3 会把这一条扩展成完整 config contract）。

`stub` 是 **development/evidence only** 的确定性 provider（零网络，把提交内容或选区做大写）：它让
"浏览器 → 端点 → draft → 客户端铸锚 → 预览 → Accept"这条真实 HTTP 链路在没有 key 时也能被证据化。
它**不是默认值**，也**不是** OpenAI 配置失败时的回退；启动日志会明确标注。**M4 D3 的生产配置校验必须
拒绝 `stub`**，并保留一条启动警告直到那时。

### 4. 测试与门禁的确定性

仓库 Gate **永不**调用真实模型：server 测试注入 fake provider；browser 套件继续用客户端确定性 provider；
`live` smoke 仅在 `OPENAI_API_KEY` 存在时 opt-in，且**不替代**确定性证据。这样 CI 不会因为公网、延迟、
rate limit 变红或烧 token。

### 5. 不做（本轮）

流式输出、function calling / agent tools、多轮对话、成本记账与配额 UI（M4 D6）、真实认证（M4 D1）。
本轮仍用现有 session 认证；`/api/ai/suggest` 与其它端点共享 §17.4 的非披露与 §17.5 的授权语义。

### 6. 分工

| Agent | 交付 |
| --- | --- |
| A3 | `POST /api/ai/suggest` 处理器（session 鉴权 + canRead + 非披露）、server `AiProvider` seam、`OpenAiProvider`（**fetch**，不加 SDK 依赖）、注入式 fake、失败矩阵测试 |
| A4 | 客户端 `RemoteProvider`（调该端点）+ 把 draft 转成 `AiEditSuggestion`（铸锚、本地 diff） |
| A2 | directory 接线（R2-1，见 D-078 §4） |
| A5 | AI 生成/接受路径的权限一致性复核（新端点不得成为新的读旁路） |
| A6 | 真实浏览器：draft→preview→accept 闭环、provider 失败时无半合法提案 |
| A7 | M3 round 2 终审 |

**后果。** 真实模型被放进产品，但**没有**把 key、锚定或写入权下放给 browser 或模型：模型只产出
"针对某段快照的纯偏移操作"，锚定、预览、校验、写入仍全部在客户端与既有 `ai` 事务里。代价是多一个
HTTP 端点与一次序列化；收益是"模型不能直接改文档"这条架构约束在真实 provider 下依然成立。
