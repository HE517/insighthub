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

A suggestion is generated against a specific `baseRevision`. A **local** edit since then (the
author typing, or an earlier accepted AI edit) makes it **stale**: the proposal's premise is gone,
reject or regenerate, never apply blindly. A **remote** edit does *not* by itself make it stale —
it is judged below by the anchor and the `expectedText` compare, so a peer editing outside the
anchored region cannot invalidate a proposal that is still valid.

M0 shipped plain UTF-16 offsets plus `baseRevision`, with RelativePosition named as
the M4 upgrade path (`docs/DECISIONS.md` D-004). **M3 upgrades the anchoring**
(`docs/DECISIONS.md` D-075): each operation carries an encoded Yjs `RelativePosition`
plus the `expectedText` it was generated from, and application requires all three
checks — revision, anchor resolution, exact text match (`docs/CONTRACTS.md` §11.1).

Which check catches what matters, because they are not interchangeable:

- `baseRevision` is a **client-local** counter of *this* client's own updates
  (`local` / `ai` origins). It catches "the author changed the document since the
  proposal" — it deliberately does **not** catch a remote peer's edit, because a
  remote edit outside the anchored region must not invalidate a still-valid proposal.
- A resolved anchor can point at **different text**: Yjs keeps a deleted position
  alive and maps it to a neighbouring index. So resolution alone is not enough.
- `expectedText` is what turns "resolved" into "still the text the user reviewed",
  and it is what catches a peer editing *inside* the region. Offsets remain in the
  shape for rendering the diff; they are not the authority for applying.

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

## 7. Durable persistence (M2 — IMPLEMENTED, M2-P0-1)

> **Status: IMPLEMENTED (M2-P0-1) / reviewed by A7.** This section fixed the shape `M2-P0-1` had
> to implement, and §7.13 records the scope decisions taken during integration. M1 shipped none
> of it: a room was a purely in-memory `Y.Doc` that died with its last participant — that is what
> M2 removed. Nothing here changes the wire protocol (§5) or the client seam
> (§8 of `docs/CONTRACTS.md`).

### 7.1 Lifecycle: M1 vs M2

M1 (implemented today):

```text
client join → joinRoom (synchronous) → in-memory Y.Doc → sync
            → last peer leaves → room destroyed → content gone
```

M2 (frozen target):

```text
client join → joinRoom (still synchronous: membership only)
            → room exists, hydration pending
            → lazy hydrate: load snapshot → replay update log → Y.Doc ready
            → room-joined is sent only now          ← the barrier
            → realtime update: apply → persist → broadcast
            → last peer leaves → memory room evicted; durable document retained
            → future join / server restart → hydrate the same state
```

**The two-phase join is the load-bearing decision.** Membership stays synchronous, which is
the invariant §5.1 and M1's atomic-replace tests depend on; only the *acknowledgement* is
deferred behind an asynchronous content-readiness barrier. A naive "make `joinRoom` async"
would reopen exactly the intermediate-state class of bug M1 closed (`docs/DECISIONS.md`
D-043).

### 7.2 Ownership

| Layer | Owns | Never owns |
| --- | --- | --- |
| `RoomRegistry` | membership, room identity, eviction policy, the hydration barrier | file paths, SQL, byte formats |
| `DocumentRoom` | the in-memory `Y.Doc`, awareness, relay decisions | durable bytes |
| `DocumentStore` (new) | durable representation, append ordering, compaction, transactions, open/close | sockets, `Y.Doc` instances, membership |
| `DocumentHydrator` (new) | turning stored bytes into a ready `Y.Doc` | membership, policy |

The rule that keeps this testable: **`DocumentStore` never sees a socket and
`DocumentRoom` never sees a file.** `RoomRegistry` is the only place that knows both exist.

### 7.3 Storage adapter seam

Persistence is reached through one interface, so no business layer depends on a specific
SQLite/file API and the backend stays replaceable:

```ts
export interface DocumentStore {
  /** Load the durable state, or `null` when this document has never been stored. */
  load(documentId: string): Promise<StoredDocument | null>;
  /** Append one already-applied update. Resolves only once it is durable. */
  /** Append one already-applied update; resolves with its committed sequence. */
  append(documentId: string, update: Uint8Array): Promise<number>;
  /** Replace snapshot + truncate the consumed log, atomically. */
  compact(documentId: string, snapshot: Uint8Array, throughSequence: number): Promise<void>;
  /** Durably remove a document. Semantics frozen even though M2 exposes no UI for it. */
  delete(documentId: string): Promise<void>;
  /** Flush and release the backend. Idempotent; called on graceful shutdown. */
  close(): Promise<void>;
}

interface StoredDocument {
  readonly snapshot: Uint8Array;
  readonly snapshotSequence: number;
  readonly updates: readonly { sequence: number; update: Uint8Array }[];
}
```

`load` returning `null` means "never stored", not "empty": a join for an unknown document
creates a fresh empty document and persists it on the first join or write. (A join alone can
append a 2-byte empty update, because a client's `SyncStep2` goes through the same
`apply → persist → broadcast` path; recorded as an accepted deviation in D-055 §3 rather than
special-cased on the persist hot path.) `delete` is frozen now so
no caller has to guess later whether it is a soft flag or a real removal — it is a real
removal, and callers must treat the document as gone.

### 7.4 Durable representation

**Snapshot + append-only update log, with the Yjs binary state as the authority.**

```text
document        (document_id PK, snapshot BLOB, snapshot_seq INT, updated_at INT)
document_update (document_id, seq, update_bytes BLOB, created_at, PK(document_id, seq))
```

Why not store the rendered Markdown and treat it as the server's source of truth: a
Markdown string loses everything the CRDT needs to merge correctly — client ids, clocks,
deleted-item tombstones, formatting marks. Reconstructing a `Y.Doc` from text on every
join would make two clients that were never offline look like concurrent writers and would
resurrect deleted content. The Markdown rendering is a **projection**, derived when needed,
never stored as the authority (the same one-source-of-truth rule as §0).

### 7.5 Room lifecycle state machine

```text
CREATED ──► HYDRATING ──► READY
   │            │            │
   │            └────────────┴──► UNHEALTHY ──► DESTROYED
   └──────────────────────────────► DESTROYED
```

| State | Behaviour |
| --- | --- |
| `CREATED` | room identity and membership exist; the `Y.Doc` is empty; nothing is sent to the joiner beyond what membership already decided |
| `HYDRATING` | single-flight load + replay in progress. Membership changes are still handled. **No `room-joined`**, no Yjs data-plane processing: inbound BINARY frames go only into the bounded backlog queue (§7.6) |
| `READY` | hydration succeeded. Only now is `room-joined` sent, the queued frames are flushed in order, and normal sync / awareness / mutation-pipeline behaviour begins |
| `UNHEALTHY` | hydration failed, or a persist failed (§7.8). Accepts no document updates, broadcasts nothing, and the transport sends `INTERNAL_ERROR` then closes the participants. The pipeline is stopped permanently for this room |
| `DESTROYED` | terminal; the instance is unusable. **Durable state is not deleted.** The next join creates a *new* room and hydrates again |

Two obligations that are easy to get wrong:

1. **A socket that disconnected while `HYDRATING` must never be re-admitted.** When the
   barrier completes, the transport re-checks `context.activeRoom` and the socket's open
   state; if either changed, the result is discarded — no delayed `room-joined`, no
   re-join, and no queue flush to a dead socket.
2. **`UNHEALTHY` never returns to `READY`.** Recovery is "destroy and hydrate a fresh room",
   so memory can never be half-healed from state the store does not have.

### 7.6 Hydration barrier

```text
room missing from memory
  → create the room (empty Y.Doc) synchronously   ← membership atomicity preserved
  → single-flight hydrate:
        snapshot ← store.load()
        Y.applyUpdate(doc, snapshot, remote)
        for each log row in sequence order: Y.applyUpdate(doc, update, remote)
  → barrier released → room-joined is sent → normal SyncStep handshake
```

- **Single-flight per document**: concurrent joins for the same document await one load, not
  one per socket. Otherwise N joiners produce N snapshots of the same reads.
- **No sync before the barrier**: `room-joined` is the gate the contract already defines
  (§4), so a conforming client never asks for sync early. A non-conforming client that sends
  a BINARY frame while hydration is pending has its frames **held in a small bounded queue**
  (not applied, not answered) and flushed after the barrier. A **cumulative backlog overflow** is a server-side
  condition, not an oversized frame, so it must never be reported as
  `FRAME_TOO_LARGE`: the room goes `UNHEALTHY` and the participants receive
  `INTERNAL_ERROR` before the server closes them (§7.8). The internal log may tag the
  event `HYDRATION_BACKLOG_OVERFLOW`, which is a log tag and **not** a wire error code
  (§7.12). Nothing is silently dropped.
- **A socket that disconnects mid-hydration** is detached normally; the barrier result is
  discarded, never sent to a dead socket.
- **Restart recovery needs no old client.** The snapshot plus the log are the whole
  document; recovery is a fresh-server read, not a client replay (D-043).

### 7.7 Per-document mutation serialization (adapter-independent invariant)

Every durable mutation of one document goes through **one FIFO pipeline**. There is no
concurrency inside a document; there is concurrency between documents.

```text
U1: apply ─► persist ─► broadcast ─► complete
                                        │
U2: apply ─► persist ─► broadcast ─► complete   ← only now
```

- `U2`'s `apply` may not begin before `U1` reaches `complete`, and the same holds for
  `persist` and `broadcast`: their lifecycles may never interleave within a document.
- Different documents run independent pipelines and may proceed in parallel.
- This is an invariant of **the seam, not of the backend**. It must hold even though
  `node:sqlite`'s `DatabaseSync` is synchronous today: swapping in an async adapter must not
  change the observable ordering.

**On the first persist failure the pipeline stops permanently:**

1. room → `UNHEALTHY` (§7.5);
2. no further mutation is accepted or processed;
3. the failing update is **not** broadcast;
4. **already-queued** updates are **not** broadcast either — they are never attempted;
5. participants receive `INTERNAL_ERROR`; the server closes them;
6. the in-memory room is destroyed;
7. everything already committed stays valid — the store is never rolled back;
8. the author's client still holds its own Yjs replica and re-sends it after reconnect.

Point 4 is the one usually missed: a queue that keeps draining after a failure publishes
state the server cannot recover.

### 7.8 Write ordering and crash semantics

For every inbound update the room performs, in this order:

```text
1. apply    Y.applyUpdate(doc, update, remote)     — in-memory state advances
2. persist  store.append(documentId, update)       — await durable acknowledgement
3. broadcast encodeSyncUpdate(update) to other peers
```

**Persist before broadcast.** If step 2 fails, no peer was ever told the update landed, so
the server never claims a state it cannot recover.

Failure policy (frozen):

1. The room is marked **unhealthy** and refuses further updates.
2. Every participant receives a typed error and the socket is closed server-side. The code
   is `INTERNAL_ERROR`: it is the existing, non-fatal code for "server-side failure, details
   in the log", and non-fatal is the correct client semantic — a transient storage outage
   must **not** stop the client's reconnect loop the way a fatal code does (§7).
3. The in-memory room is **destroyed**, so memory cannot drift from durable state.
4. The author's client still holds the update locally (its IndexedDB), so on reconnect the
   normal state-vector handshake re-sends it and the append is retried. Recovery is the
   existing reconnect path, not a special case.
5. If no client holds the update (author vanished simultaneously), it is lost — the same
   exposure M1 had, and the reason this is a P0 rather than a nice-to-have.

Nothing here catches an error and continues as if the write succeeded (D-044).

### 7.9 Eviction is not deletion

| Event | Memory | Durable |
| --- | --- | --- |
| Last peer leaves | room destroyed (evicted) | **unchanged — retained** |
| Server shutdown | all rooms destroyed | **unchanged — retained** |
| `store.delete(id)` | room destroyed if present | **removed** |

`RoomRegistry` owns eviction; `DocumentStore` owns deletion. M2 exposes no deletion UI, but
the store semantics are frozen so eviction can never be mistaken for deletion.

### 7.10 Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSIGHTHUB_DATA_PATH` | `./.insighthub-data` (dev) | directory holding the durable store; **absolute path required in production** (D-082) |
| `DATA_MIN_FREE_BYTES` | `104857600` (100 MiB) | free-space floor checked at startup; below it the server refuses to start (`DATA_DISK_LOW`); `0` disables the check |

The store is **schema-versioned** (`PRAGMA user_version`, currently **1**): a new directory is
created at version 1, a version-0 directory is migrated in one transaction (its data is preserved,
and missing tables are created with `IF NOT EXISTS`), and a *newer* version is refused
(`DATA_SCHEMA_TOO_NEW`) rather than opened on a best-effort basis. On open the store runs
`PRAGMA quick_check`; a corrupt file is `DATA_INTEGRITY_FAILED` and the process exits **before
listening** — it never silently starts on an empty database. Runtime write failures
(`SQLITE_FULL`, a read-only database) surface as errors from `append`; they are never swallowed.

**Backups (M4 B8, D-082 D2).** `apps/server/src/persistence/backup.ts` takes a consistent online
snapshot with `VACUUM INTO`, names it `insighthub-<UTC ISO>-<n>.db`, keeps seven days (never deleting
the newest file) and restores by writing a temporary file next to the target and renaming it, so a
restore is atomic. A **real restore drill** is part of the test suite: write a document, back up,
delete the data directory, restore, reopen the store, read the same text back. The CLI
(`backup` / `restore <file> [--force]`) is the operator interface; `restore` refuses to overwrite a
live database without `--force`.

The cadence is **in-process**: `BACKUP_ENABLED=true` starts a daily scheduler (unref'd timer) that
catches up on start when the newest snapshot is stale and prunes beyond `BACKUP_RETENTION_DAYS`.
A Render cron job cannot mount the web service's disk, so scheduling from inside the process is the
simplest thing that satisfies D2. Backups live on the same persistent disk as the database: that is
independent of a disk snapshot, but **not** an off-site copy — an operator task, not a code claim.
Tests must pass a per-test temporary directory and must never touch a development database;
the test harness creates and removes its own path per suite (D-041). The store refuses to
start when the directory cannot be opened, rather than degrading to memory-only, because a
silent memory-only fallback is exactly the data-loss mode M1 had.

### 7.11 Node runtime prerequisite (server)

The server requires a Node runtime whose `node:sqlite` provides the API surface this design
was verified against: `DatabaseSync`, `exec`, `prepare`, `StatementSync#run/#get/#all`, BLOB
parameters and results, `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, and `PRAGMA journal_mode`.

- **Startup capability check**: before listening, the server opens a throwaway database in
  the configured data directory, executes
  a statement, and round-trips one BLOB. A failure is a **startup failure** with a clear
  diagnostic naming the runtime requirement.
- **No fallback**: the server must not start in a memory-only mode. Refusing to start is the
  correct behaviour — a silent memory-only server is exactly the M1 data-loss mode.
- **No third-party SQLite dependency**: if the runtime lacks the API, the answer is a Node
  upgrade, not a new package. Minimum runtime is recorded in `docs/TASKS.md`.

Why a real statement and not just `new DatabaseSync(...)`: opening a corrupt or unreadable
file does not necessarily throw at construction — the failure surfaces on the first statement
(measured; `docs/DECISIONS.md` D-041). A capability check that only constructs proves nothing.

### 7.12 What does not change

- **Wire protocol**: no new frame type, no new message type, no base64 anywhere (§5).
- **Error vocabulary**: unchanged. Persistence failure reuses `INTERNAL_ERROR` (§7 of
  `docs/CONTRACTS.md`), and `ROOM_NOT_FOUND` keeps its reserved meaning.
- **Client seam**: `CollaborativeSession` is untouched by `M2-P0-1`.
- **Awareness**: still never persisted (§9 of `docs/CONTRACTS.md`).

### 7.13 Integration notes (M2-P0 scope decisions)

These were settled during the P0-1 / P0-3 integration gate (`docs/DECISIONS.md` D-054). They do
not change the contract; they pin what the first implementation is allowed to be.

| Item | Decision |
| --- | --- |
| `append` return | `Promise<number>` — the committed sequence, not `void` (§7.3); this is what `CONTRACTS.md` §14.7 requires |
| Runtime capability check | validates the **real** data path (§7.11). "Not writable → fall back to `:memory:`" is forbidden: it re-creates the M1 data-loss mode inside the fix |
| Compaction timing | **eviction-time only** in M2-P0. Idle/background compaction is a performance backlog item, deliberately outside this P0 |
| WebSocket close code | persistence-internal failure closes with **1011** (internal error), not 1008 (policy violation). 1008 stays for protocol/policy errors |
| No-store server path | accepted as an internal/test compatibility seam, bounded by three obligations: production `index.ts` always opens the durable store; a durable-init failure refuses to start; isolated tests may run the no-store path but production cannot reach it |
| Fail-closed wiring | `attachWebSocketServer` throws when `config.dataPath` is set but no store was supplied, so "forgot to open the store" is a startup failure rather than a silent memory-only server |

## 8. Identity, session and authorization (M2 Phase 2 — IMPLEMENTED, enforced at HTTP and WS)

Frozen by `docs/DECISIONS.md` **D-061**. The normative interface (endpoints, cookie rules,
status codes, WS behaviour, version impact) lives in `docs/CONTRACTS.md` **§17**; this section
records only where the decisions are allowed to live.

### 8.1 The permission chain

```text
User (server-side roster, demo bootstrap)
  → Session (opaque token in an httpOnly cookie; server resolves token → userId)
    → Document Membership (durable per-document row: documentId, userId, role)
      → DocumentRole (viewer < commenter < editor < owner — already frozen in shared)
        → documentCapabilities (canRead / canComment / canEdit / canManageMembers)
          → enforcement: HTTP middleware + WebSocket join/frame gate
```

The chain has exactly one decision point per layer and the **server** owns every one of them.
The client consumes `documentCapabilities` only to decide which controls to enable; it is
never the authority.

### 8.2 Where authorization decisions may live

| Layer | Authority lives in | Must not appear in |
| --- | --- | --- |
| HTTP | `apps/server/src/authz/**` middleware + route handlers | the web app |
| WebSocket join | the room registry's join path, using a resolver supplied by the authz module | frame parsing, the client |
| WebSocket frame | the room's per-frame gate: `SYNC` `SyncStep1` requires **`canRead`** (it is a read request), `SYNC` `SyncStep2`/`Update` require **`canEdit`** | awareness relay path (presence only needs `canRead`); treating the whole SYNC plane as one write operation |
| Document | `documentCapabilities` + the durable membership row | UI-only checks, duplicated rule tables |
| Space | **does not exist in Phase 2** | a new entity invented to complete a table |

### 8.3 Why the client's `mode` is not an input to authorization

`join-room.mode` exists in the schema from M1 and is retained for compatibility. If the server
believed it, every client could declare itself `readwrite`; authorization would then be
advisory, which is the exact defect Phase 2 removes. It is therefore **advisory, never
authoritative** (`docs/CONTRACTS.md` §17.5).

### 8.4 Deliberate limitations, stated as limitations

| Limitation | Why it is acceptable now | What it must never be called |
| --- | --- | --- |
| Sessions are process-scoped (in memory) | a restart re-bootstraps a demo identity cheaply | "durable sessions" |
| Demo bootstrap proves no ownership of an identity | password/OAuth are explicit non-goals for MVP | "authentication that prevents impersonation" |
| Membership is a seeded fixture | it exists to exercise roles, not to model an admin product | "membership management" |
| No `space` layer | no space domain exists in code or contract | "space-level permissions implemented" |
