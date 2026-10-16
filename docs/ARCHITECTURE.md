# ARCHITECTURE.md

Changing this file requires Supervisor approval (`AGENTS.md` §2).

## 0. The one source of truth

**Document content has exactly one source of truth: the CRDT document — `Y.Doc` /
`Y.Text`.**

Everything else that holds text is a *view* of that document, not a second truth:

| Location | May hold document content? | Notes |
| --- | --- | --- |
| `Y.Doc` / `Y.Text` | **Yes — it is the truth** | The only place a change is real. |
| React component state | Only transiently, for rendering | Never the authoritative copy; never written back as "the document". |
| Redux store | **No** | See the allow-list below. |
| IndexedDB | Yes, but only as a Yjs *persistence replica* | Stores encoded Yjs updates, not a parallel Markdown string. |
| Server room memory | Yes, as a replica for serving other clients | Applies the same updates through Yjs; keeps no competing copy. |
| Server database (M2+) | Yes, as a snapshot | Produced from Yjs state, never a hand-maintained string. |

Forbidden — treat these as defects, not style questions:

- Storing the full document body in React state as a second truth.
- Storing the full document body in Redux as a second truth.
- Letting AI suggestions, Markdown preview, or any other feature own a copy of the
  text and write it back.

Why it matters: a mirrored copy inevitably diverges from the CRDT. Once it
diverges, one of the two wins arbitrarily, remote edits get clobbered, and undo
becomes unsafe because there are two competing histories.

### What Redux (and React state) MAY hold

- `activeDocumentId`
- document metadata (`DocumentMeta`)
- permission / role information
- connection status
- collaborator metadata derived from awareness
- UI state (panels, dialogs, selection mode, dirty flags)

The editor reads text from `session.text`; it must not read it from the store.

## 1. Shape

Single web app + single API server + one shared contract package. No
microservices, no message bus, no orchestration layer.

```
apps/web (browser)                     apps/server (node)
┌───────────────────────────┐          ┌──────────────────────────────┐
│ React view layer          │          │ Express HTTP API             │
│ Redux Toolkit store       │  HTTP    │  GET /health                 │
│ CodeMirror 6 editor       │ ───────► │  Document API (M2+)          │
│                           │          │  Permission checks (M2+)      │
│ Y.Doc ── Y.Text           │          │                              │
│    │            │         │          │ Document Room registry (M1+) │
│    │            │         │  WS      │  ├─ conn lifecycle           │
│    ▼            ▼         │ ◄──────► │  ├─ room membership          │
│ IndexedDB   WebSocket     │          │  └─ fan-out / presence       │
│ (offline)   Provider      │          │ WebSocket server (ws)        │
└───────────────────────────┘          └──────────────────────────────┘
                   ▲                                  ▲
                   └──── packages/shared ─────────────┘
                    types · Zod schemas · WS protocol · API contract
```

## 2. The editor's two independent paths

The collaboration design has exactly two paths out of `Y.Doc`. They are
independent: either can be down while the other keeps working.

**Path 1 — local persistence (offline)**

```
Y.Doc ──► IndexedDB (y-indexeddb)
```

Purpose: durability. Every local change is written to IndexedDB, so a refresh,
a crash or a network outage does not lose work. This path never depends on the
server being reachable.

**Path 2 — network synchronization**

```
Y.Doc ──► WebSocket Provider ──► WebSocket Server ──► Document Room
```

Purpose: convergence. The provider exchanges Yjs updates (and state vectors on
(re)connect) with the server, which relays them to the other members of the
document's room.

Key properties this buys us:

- **Conflict-free:** CRDT merge means concurrent edits converge by construction,
  with no last-write-wins data loss.
- **Reconnect is cheap:** after a disconnect the client sends its state vector
  and receives only the missing delta, instead of a full document.
- **Offline editing is normal operation:** while offline, Path 1 keeps recording
  local updates; on reconnect, Path 2 replays them.

### 2.1 Startup order (frozen by M1-A0)

Local state gates usability; the network never does.

```
open document
  ↓ create Y.Doc
  ↓ attach IndexedDB persistence
  ↓ wait for LOCAL state to load   → session.state = 'active'  ← editing allowed HERE
  ↓ connect WebSocket → join-room → room-joined
  ↓ SyncStep1 (client state vector)
  ↓ SyncStep2 from server (missing delta) + server SyncStep1
  ↓ client SyncStep2
  ↓ converged
```

Resolving the local-vs-server ordering question: **local first, then server.**
The client's `Y.Doc` already contains every offline edit, so the subsequent
`SyncStep1` advertises them and the exchange is a normal merge. The UI must never
gate editing on `connectionStatus`; "offline" is a normal editing mode, not an
error path (`AGENTS.md` R10). The exact sequence and transport semantics are in
`docs/CONTRACTS.md` §10.

**InsightHub M1 chooses a client-initiated sync handshake.** `y-protocols` does not
force this direction — we pick it because a browser client knows when it is ready
(local persistence loaded) and can ask, whereas a server-initiated push would need
per-client readiness tracking and would speculatively send document data to clients
that may never render it. The server therefore replies to a sync exchange rather
than starting one. Stated as our rule, not as a law about Yjs.

## 3. AI edit path

```
Document
   ▼
AI Request
   ▼
Suggestion            (a proposal object: summary + operations + diff)
   ▼
Diff Preview          (human review; nothing has changed yet)
   ▼
Accept / Reject
   ▼ (Accept only)
Yjs Transaction  ──►  Y.Doc  ──►  Path 1 / Path 2
```

### Hard rule

**Accepting a suggestion applies it through a Yjs transaction**
(`Y.Doc.transact` / `Y.Text` mutation inside a transaction), stamped with
`TRANSACTION_ORIGINS.ai`.

**The AI module must never write the final document content directly into React
state or the Redux store.** React state and Redux are *views* of the document for
rendering and UI concerns; the CRDT document is the source of truth. Writing
final content into React state would:

1. bypass CRDT merge, so the change fights with concurrent remote edits;
2. be invisible to the other clients;
3. not be persisted by IndexedDB;
4. make Undo unsafe, because there would be two competing truths.

Reject and Undo are likewise document operations in the CRDT sense, not state
rollbacks.

### Staleness

A suggestion is generated against a specific `baseRevision`. If the document has
moved on (locally or remotely) by the time the user clicks Accept, the suggestion
is **stale**: it must be rejected or regenerated, never applied blindly. M0
anchors suggestions with plain UTF-16 offsets plus `baseRevision`
(`docs/DECISIONS.md` D-004); RelativePosition anchoring is the M4 upgrade path.

## 3.1 Collaborative undo rule (frozen by M1-A0)

Undo is **local-scoped**, enforced by origin rather than by convention:

- `Y.UndoManager` is constructed with `trackedOrigins: UNDO_TRACKED_ORIGINS`
  (`insighthub:local`, `insighthub:ai`).
- Updates arriving from the network carry `TRANSACTION_ORIGINS.remote` and are
  therefore **never** undone by a local undo, even when interleaved with local
  edits.
- A local undo removes only operations this client authored. If a remote peer
  edited the surrounding text, the merge keeps their edit intact.
- Accepted AI edits are tracked too, so a user can take back an AI change they
  approved; those are still local in origin.
- Nothing may implement "undo" by restoring a snapshot of document text — that
  would rewrite remote history.

## 3.2 Awareness rule (frozen by M1-A0; read path tightened by M1-A0.1)

Awareness carries **ephemeral presence only**: user identity, cursor, selection
and transient status — and it is the **single** source of truth for all of them.
There is no control-plane `presence` message; a second channel for the same fact
could only disagree with awareness, leaving the UI to pick a winner.

- Never persisted to IndexedDB, never merged into `Y.Text`, never document content.
- It is untrusted input from peers (rendered as another user's name and cursor),
  so it is validated against the shared schema before use.
- On disconnect the entry is removed and the departure broadcast; peers must not
  keep a ghost cursor. Full cleanup table: `docs/CONTRACTS.md` §9.1.

**Read-path rule (see also `AGENTS.md` R14):** UI code must not read
`session.awareness.getStates()` directly — that map holds raw, unvalidated peer
payloads. Collaborator UI data comes from `session.getCollaborators()`, which
returns schema-validated `CollaboratorInfo[]`. The raw `Awareness` instance may be
handed to a Yjs/CodeMirror collaboration binding (an editor extension needs the
live object), but even then it is a *binding* input, never business UI state,
never copied into Redux, never persisted. Contract:
`docs/CONTRACTS.md` §9.2.

## 4. Package boundaries and responsibilities

### `apps/web` — the client

Owns: view layer, editor integration, Redux store, AI suggestion UI, permission
UI, Markdown rendering and frontend performance.

Must not: re-declare shared types; decide authorization on its own (the UI only
*reflects* server decisions); hold document truth outside the CRDT document.

**Internal split inside `apps/web` (M1):**

| Area | Owner | Rule |
| --- | --- | --- |
| `src/collab/**` | A1 | CRDT, persistence, reconnect, undo, awareness. `src/collab/internal/**` is private. |
| `src/features/**`, editor UI | A2 | Consumes `apps/web/src/collab/public.ts` only. |
| `src/collab/public.ts` | A1 implements, A2 imports | Frozen seam; names and signatures may not change without A0. |

The seam's interface is declared in `packages/shared/src/collab-session.ts`
(`CollaborativeSession`). That is what lets A1 and A2 work in parallel without
either waiting on the other's implementation.

### `apps/server` — the API and realtime authority

Owns: Express HTTP API, WebSocket transport, document rooms, connection
lifecycle, authentication, authorization (the authoritative decision),
persistence of document snapshots.

Must not: depend on anything in `apps/web`; invent message shapes that are not in
`packages/shared`.

### `packages/shared` — the contract

Owns: domain types, Zod schemas, the WebSocket control protocol, the binary
framing codec, the error vocabulary, the collaboration seam interface, the API
contract, and the shared permission vocabulary.

**Duplication rule:** if both web and server need a type, it lives here and both
import it. Two copies of the same type is a defect, because the copies drift and
the drift shows up as a production bug rather than a compile error. Shared
schemas are Zod schemas and TypeScript types are derived via `z.infer`, so
runtime validation and compile-time types cannot disagree.

**Framing rule:** neither app may implement its own binary frame parsing. The
codec lives here so A1's browser client and A3's server cannot interpret the wire
format differently.

## 5. Transport contract: control plane + data plane

The single WebSocket `/ws` carries two planes, separated by the **WebSocket frame
kind** (text vs binary) rather than by an in-band tag.

**Control plane — TEXT frames.** JSON envelope:

```
{ type: string, payload: object, requestId?: string, ts: ISO8601 }
```

Carries `connected`, `join-room`, `room-joined`, `leave-room`, `error`.

- `payload` is always an object, never a bare primitive.
- `requestId` correlates a response with its request.
- Unknown `type` values are **rejected**, not ignored, so protocol drift fails
  loudly.
- **Ephemeral presence is deliberately absent from this plane.** There is no
  `presence` message: collaborator identity, cursor, selection and online state
  come from Yjs awareness on the data plane, and the server broadcasts awareness
  removal when a client leaves. One fact, one channel
  (`docs/DECISIONS.md` D-020, `docs/CONTRACTS.md` §9).

**Data plane — BINARY frames.** Yjs sync and awareness, carried as raw bytes:

```
byte 0     : frameType (varUint)   0 = SYNC, 1 = AWARENESS
bytes 1..n : payload
```

- Yjs updates are never base64-wrapped into JSON: that would inflate every edit
  and add a parse per keystroke.
- The SYNC payload is written by `y-protocols/sync` itself; the codec only adds and
  strips the frame-type header, so the official protocol is preserved rather than
  reimplemented.
- Both planes share one `PROTOCOL_VERSION`.

### 5.1 Room cardinality: one socket, one document room

**One WebSocket connection carries at most one active document room.** This is a
direct consequence of the data plane: a binary Yjs frame has no `documentId`, so
the room must be implied by the socket. Allowing two simultaneous rooms would make
every collaboration frame ambiguous.

A `join-room(B)` received while the socket is already in room A is resolved by
**atomic replace** — leave A and join B in a single transition, then acknowledge B.
Switching documents is routine, and a two-round-trip "leave, then join" would
introduce a window in which the client belongs to no room, which is where races and
dropped replies strand the UI. The refusal alternative exists as
`ROOM_CARDINALITY_VIOLATION` but is not the frozen default.

Consequences worth stating explicitly:

- A violation on the data plane is reported on the **control plane** (a text
  `error` frame), so a text frame does not imply a text-frame cause.
- Data-plane frames before a successful `join-room` get `ROOM_NOT_JOINED`.
- Framing, limits, malformed/unknown behaviour and the error vocabulary are frozen
  in `docs/CONTRACTS.md` §6–§7; the cardinality table is §5.4.

## 6. State ownership summary

| State | Owner | Notes |
| --- | --- | --- |
| Document content (truth) | CRDT document (`Y.Doc`) | never React/Redux |
| Document metadata | Server API | cached in Redux for rendering |
| Connection status | Redux `connection` slice | vocabulary from `shared` |
| Collaborator presence | Awareness (ephemeral) | never persisted, never content |
| Permission decisions | Server | client mirrors for UI gating only |
| AI suggestions | Server-issued, client-held | applied via Yjs transaction on accept |
| Auth session | Server-issued token | never persisted in a shared doc |
| Undo history | `Y.UndoManager`, local/AI origins | never a text snapshot |
