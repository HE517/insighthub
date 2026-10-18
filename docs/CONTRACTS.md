# CONTRACTS.md

The cross-boundary interface. Everything here is implemented in
`packages/shared/src/**` and imported by both apps. Add here **before**
implementing. Changing this file requires Supervisor approval (`AGENTS.md` §2).

| Version | Value |
| --- | --- |
| Shared contract version | `SHARED_CONTRACT_VERSION = 2` |
| WebSocket protocol version | `PROTOCOL_VERSION = 2` |

Sources of truth:

| Area | File |
| --- | --- |
| Errors | `packages/shared/src/errors.ts` |
| Document | `packages/shared/src/document.ts` |
| Permission | `packages/shared/src/permission.ts` |
| Connection | `packages/shared/src/connection.ts` |
| AI suggestion | `packages/shared/src/ai-suggestion.ts` |
| Awareness state | `packages/shared/src/awareness-state.ts` |
| Binary data plane | `packages/shared/src/binary-frame.ts` |
| Control plane (JSON) | `packages/shared/src/protocol.ts` |
| A1↔A2 session seam | `packages/shared/src/collab-session.ts` |

Scope discipline: this file holds the **MVP minimum**. It does not attempt to
pre-design types for features that do not exist yet.

---

## 1. DocumentMeta

```ts
type DocumentMeta = {
  id: string;              // non-empty
  title: string;           // 1..200 chars
  revision: number;        // int >= 0, server-owned, monotonic
  ownerId: string;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
};
```

`revision` is the server's document version and the staleness anchor for AI
suggestions. M2 will back it with stored state. **M1 has no runtime revision at
all**: M1-A0.1 removed `RoomJoinedPayload.revision` because it was a per-room
activity counter with no consumer, and its name collided with this durable field
(`docs/DECISIONS.md` D-021). `DocumentStatus` is `'draft' | 'published' |
'archived'`.

## 2. DocumentRole

```ts
type DocumentRole = 'viewer' | 'commenter' | 'editor' | 'owner'; // least → most privileged
```

Shared helpers (single source of truth for authorization semantics):

- `isDocumentRole(value)` — type guard for untrusted input.
- `roleRank(role)` — numeric rank used for comparisons.
- `hasAtLeastRole(role, required)` — the comparison callers should use instead of
  hardcoding role names.
- `documentCapabilities` — `canRead`, `canComment`, `canEdit`, `canManageMembers`.

Server is authoritative; the client uses these helpers **only** to decide which
controls to enable.

## 3. ConnectionStatus

```ts
type ConnectionStatus =
  | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';
```

Helpers: `isTransitionalStatus(status)`, `canEditWhile(status)`.

Offline is a normal, representable state (see `AGENTS.md` R10), not an error path.

## 4. Two-plane transport

The single WebSocket `/ws` carries two independent planes, distinguished by the
**frame kind**, not by an in-band tag:

| Plane | Frame kind | Content | Encoding |
| --- | --- | --- | --- |
| Control | TEXT | `connected`, `join-room`, `room-joined`, `leave-room`, `error` | JSON envelope (§5) |
| Data | BINARY | Yjs sync, awareness | §6 binary framing |

Rules:

- Yjs updates and awareness updates **must** travel as binary. They must never be
  base64-encoded into the JSON envelope: that inflates every keystroke by ~33% and
  adds a parse per edit for no benefit.
- A client MUST NOT send data-plane frames before a successful `join-room`; the
  server answers `ROOM_NOT_JOINED`.
- Both planes are versioned by the single `PROTOCOL_VERSION`.

## 5. Control plane: WebSocket message envelope

```ts
type Envelope<T extends string, P> = {
  type: T;
  payload: P;              // always an object
  requestId?: string;      // only for request/response pairs
  ts: string;              // ISO 8601
};
```

Rules:

- `payload` is never a bare primitive.
- Unknown `type` values are **rejected** by the parser, not ignored.
- A client-only message type is not valid on the server→client channel, and vice
  versa (enforced by two separate discriminated unions).

### 5.1 Message types

| `type` | Direction | Payload | Milestone |
| --- | --- | --- | --- |
| `connected` | server → client | `ConnectedPayload` | M0 |
| `join-room` | client → server | `JoinRoomPayload` | **M1 (frozen)** |
| `room-joined` | server → client | `RoomJoinedPayload` | **M1 (frozen)** |
| `leave-room` | client → server | `LeaveRoomPayload` | **M1 (frozen)** |
| `error` | server → client | `WsErrorPayload` | M0 |

There are exactly **five** control-plane message types. The M1-plan `presence`
message was **removed** by M1-A0.1: ephemeral presence has one source of truth,
Yjs awareness, and a second control-plane channel for the same fact could only
disagree with it (`docs/DECISIONS.md` D-020, §9 below).

### 5.2 Payloads

```ts
type ConnectedPayload = {
  connectionId: string;      // server-assigned
  protocolVersion: 2;        // literal PROTOCOL_VERSION; peers must match exactly
  serverTime: string;        // ISO 8601
};

type JoinRoomPayload = {
  documentId: string;
  protocolVersion: 2;        // literal; a mismatch is PROTOCOL_VERSION_MISMATCH
  mode: 'readonly' | 'readwrite'; // defaults to 'readwrite'; readonly reserved for M2
};

type RoomJoinedPayload = {
  documentId: string;
  connectionId: string;      // the server's id for THIS socket
  peers: string[];           // INITIAL roster of other connection ids in the room
};

type LeaveRoomPayload = { documentId: string };

type WsErrorPayload = {
  code: WsErrorCode;         // §7 frozen vocabulary (Zod enum)
  message: string;           // human-facing; never a stack trace
  requestId?: string;        // echoed when correlated with a request
};
```

`RoomJoinedPayload.peers` is a one-shot roster delivered at join time. Ongoing
collaborator presence is **not** a control-plane concern — see §9.

### 5.3 Helpers

- `createEnvelope(type, payload, { requestId?, ts? })` — build a valid envelope.
- `createConnectedMessage(connectionId, opts?)` — the handshake.
- `createErrorMessage(code, message, opts?)` — typed error builder; use this so an
  invented code is a compile error.
- `createRoomJoinedMessage(payload, opts?)`.
- `parseServerMessage(raw)` / `parseClientMessage(raw)` — validate; never throw.
- `parseMessageJson(rawString)` — JSON decode + validate; never throw.
- `isWsMessageOfType(message, type)` — narrow a parsed message.

Parsers return `{ success: true, data }` or `{ success: false, error }`.

### 5.4 Room cardinality (frozen by M1-A0.1)

**One WebSocket connection carries at most ONE active document room.**

Why this is forced rather than chosen: binary Yjs frames carry **no
`documentId`** (see §6), so a frame's room is implied by the socket. Two
concurrent rooms on one socket would make every data-plane frame ambiguous, and
the server would have to guess which document an update belonged to.

| Situation | Required server behaviour |
| --- | --- |
| `join-room(A)`, not yet in a room | Create/attach room A, reply `room-joined(A)`. |
| Any binary frame while **not** in a room | `ROOM_NOT_JOINED`, socket stays open. |
| Any binary frame while in room A | The frame belongs to A. There is no ambiguity to resolve. |
| `join-room(A)` while already in room A | Idempotent re-join: reply `room-joined(A)`. |
| `join-room(B)` while in room A | **Atomic replace**: leave A and join B as a single transition, then reply `room-joined(B)`. A's peers see A lose a member; B's peers see B gain one. No intermediate state where the socket is in both or in neither. |
| `leave-room(A)` while in room A | Leave A, no further data-plane frames belong to A. |
| `leave-room(B)` while in room A (`B !== A`) | Ignore (no-op); A stays active. Do not treat it as leaving A. |

`ROOM_CARDINALITY` in `protocol.ts` encodes this (`maxActiveRoomsPerSocket: 1`,
`joinWhileInRoom: 'atomic-replace'`).

**Why atomic replace rather than "error, leave first":** switching documents is a
normal user action. A two-round-trip protocol (`leave-room` → wait → `join-room`)
adds a state window in which the client has no room, which is exactly when a race
or a dropped reply leaves the UI stuck. Atomic replace has no such window and
needs no client-side sequencing. The alternative refusal path remains expressible
via `ROOM_CARDINALITY_VIOLATION` (a non-fatal code) for an implementation that
deliberately chooses it, but it is **not** the frozen default.

Both transitions must be observable on the wire, so a client that switches
documents can treat the `room-joined(B)` reply as the signal to tear down A's
local view; it must not rely on an intervening `leave-room` acknowledgement,
because none is sent.

## 6. Data plane: binary frame framing (frozen by M1-A0)

### 6.1 Layout

```
byte 0       : frameType (lib0 varUint)   0 = SYNC, 1 = AWARENESS
bytes 1..n   : payload, shape depends on frameType
```

**SYNC payload** is written entirely by `y-protocols/sync`. It begins with that
package's own message type (varUint `0` = SyncStep1, `1` = SyncStep2, `2` =
Update) followed by a single length-prefixed byte array. The codec does **not**
re-implement this encoding; `encodeSyncStep1/2/Update` delegate to
`syncProtocol.writeSyncStep1/2/Update`, and the decoded payload is handed to
`syncProtocol.readSyncMessage`.

**AWARENESS payload** is exactly the output of
`awarenessProtocol.encodeAwarenessUpdate(awareness, clients)`: a varUint entry
count followed by `(clientID, clock, JSON state)` per entry. It has **no inner
message type** — a common bug is to treat its first byte as a type tag when it is
actually the entry count.

Frame types match the `y-websocket` convention so the wire format is not a private
invention. Types `2` (`auth`) and `3` (`query-awareness`) from that convention are
**reserved and rejected** in M1 (`UNAUTHENTICATED_FRAME_TYPES`).

### 6.2 Limits

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_BINARY_FRAME_BYTES` | 16 MiB | Same ceiling `y-websocket` uses. Enforced against `byteLength` **before** any decode work, so a hostile frame costs one error, not an OOM. |
| `MIN_BINARY_FRAME_BYTES` | 2 | Frame type + at least one payload byte. |

Callers may pass a smaller `maxFrameBytes` to `decodeBinaryFrame`.

### 6.3 Malformed / unknown behaviour

`decodeBinaryFrame(input, options)` **never throws** and returns
`{ success: true, frame }` or `{ success: false, error, detail }`.

| Condition | `error` | Rationale |
| --- | --- | --- |
| 0 bytes | `INVALID_BINARY_FRAME` | Nothing to decode. |
| `< MIN_BINARY_FRAME_BYTES` | `INVALID_BINARY_FRAME` | A 1-byte frame can never be a valid message; rejecting it keeps the trailing-byte check unambiguous. |
| `byteLength > maxFrameBytes` | `FRAME_TOO_LARGE` | Checked first, before decoding. |
| `frameType` not `0`/`1` | `INVALID_BINARY_FRAME` | Unknown types are rejected, not ignored (same policy as the control plane). |
| SYNC inner type not `0`/`1`/`2` | `INVALID_BINARY_FRAME` | `y-protocols` would throw `Unknown message type`; the codec reports it as a typed outcome instead. |
| SYNC/AWARENESS length prefix missing or truncated | `INVALID_BINARY_FRAME` | Detected explicitly, because `readSyncMessage` returns a message type even on a truncated payload and would otherwise accept it as "no data". |
| Trailing bytes after the declared payload | `INVALID_BINARY_FRAME` | The frame boundary is a contract; extra bytes mean a corrupt or hostile sender. |
| AWARENESS payload not decodable, or state not JSON | `INVALID_BINARY_FRAME` | Full structural pass over the entries. |

Routing behaviour on top of the codec:

- A data-plane frame arriving **before** a successful `join-room` is answered with
  `ROOM_NOT_JOINED` and does not close the socket.
- A frame that fails to decode is answered with the codec's error; because
  `INVALID_BINARY_FRAME` and `FRAME_TOO_LARGE` are **fatal**, the server closes the
  connection after reporting it.
- The response to a data-plane violation travels on the **control plane as a text
  frame** (`error`). Clients must therefore never assume that a text frame implies
  a text-frame cause.

### 6.4 Helpers

`encodeSyncStep1(doc)`, `encodeSyncStep2(doc, remoteStateVector?)`,
`encodeSyncUpdate(update)`, `encodeAwarenessFrame(update)`,
`decodeBinaryFrame(input, opts?)`, `isBinaryFrame(input)`,
`frameByteLength(frame)`, `varUintByteLength(value)`.

Constants: `FRAME_TYPES`, `UNAUTHENTICATED_FRAME_TYPES`, `DOCUMENT_TEXT_KEY`.

### 6.5 Transaction origins

```ts
type TransactionOrigin =
  | 'insighthub:local' | 'insighthub:remote'
  | 'insighthub:persistence' | 'insighthub:ai';

UNDO_TRACKED_ORIGINS = ['insighthub:local', 'insighthub:ai'];
```

Every local document mutation must be stamped with one of these origins, because
(a) undo tracks only `local` and `ai` — never `remote`, so a local undo can never
revert a collaborator's edit — and (b) an update must not be echoed back to the
connection it arrived from.

## 7. Error codes (frozen by M1-A0; extended by M1-A0.1)

```ts
type WsErrorCode =
  | 'INVALID_MESSAGE' | 'UNKNOWN_MESSAGE_TYPE' | 'INVALID_BINARY_FRAME'
  | 'FRAME_TOO_LARGE' | 'ROOM_NOT_JOINED' | 'ROOM_NOT_FOUND'
  | 'ROOM_CARDINALITY_VIOLATION' | 'PROTOCOL_VERSION_MISMATCH' | 'INTERNAL_ERROR';
```

| Code | Meaning | Fatal for the socket |
| --- | --- | --- |
| `INVALID_MESSAGE` | Payload not parseable as its declared type. | yes |
| `UNKNOWN_MESSAGE_TYPE` | Well-formed payload with an unimplemented `type`. | yes |
| `INVALID_BINARY_FRAME` | Binary frame undecodable / truncated / trailing bytes. | yes |
| `FRAME_TOO_LARGE` | Binary frame over the limit. | yes |
| `ROOM_NOT_JOINED` | Data-plane frame before a successful join. | no |
| `ROOM_NOT_FOUND` | Server refused to open the room. In M1 there is no persisted store, so this means "no room for this documentId"; reserved so M2 needs no new vocabulary. | no |
| `ROOM_CARDINALITY_VIOLATION` | A `join-room` tried to create a second concurrent room on a socket. Added by M1-A0.1 with the one-room-per-socket rule (§5.4); the frozen default is atomic replace, so a conforming server rarely emits it — it exists for an implementation that deliberately refuses instead of replacing. | no |
| `PROTOCOL_VERSION_MISMATCH` | Peer and server disagree on `PROTOCOL_VERSION`. | yes |
| `INTERNAL_ERROR` | Unexpected server failure. Details go to the server log only. | no |

Rules:

- The **code** is the contract; the `message` is human-facing and may change.
- Never send a stack trace, file path, SQL fragment or internal identifier to a
  client.
- `isFatalErrorCode(code)` answers whether the socket should be closed;
  `isWsErrorCode(value)` guards untrusted input; `wsErrorCodeSchema` is the Zod
  enum used by `WsErrorPayload`.

## 8. A1 ↔ A2 seam: `CollaborativeSession` (frozen by M1-A0)

Declared in `packages/shared/src/collab-session.ts`. This is the **only**
collaboration surface A2 may depend on. It exists to remove the M1 circular
dependency: A1 implements it, A2 consumes it, and neither imports the other's
implementation.

```ts
type SessionState = 'initializing' | 'active' | 'destroyed';

interface CollaborativeSession {
  readonly documentId: string;
  readonly text: Y.Text;                 // document content truth
  readonly doc: Y.Doc;
  readonly awareness: Awareness;         // ephemeral presence only
  readonly state: SessionState;
  readonly connectionStatus: ConnectionStatus;
  readonly localClientId: number;

  getCollaborators(): readonly CollaboratorInfo[];
  getLocalAwarenessState(): AwarenessState | null;

  transact(fn: (text: Y.Text) => void, origin?: TransactionOrigin): void;
  undo(): void;
  redo(): void;
  getUndoState(): UndoState;

  connect(): void;      // open the network path
  disconnect(): void;   // close it; document and persistence stay alive
  subscribe(listener: () => void): () => void;
  destroy(): void;      // idempotent full teardown
}

type CollaborativeSessionResult =
  | { state: 'initializing' }
  | { state: 'active'; session: CollaborativeSession }
  | { state: 'failed'; error: string };
```

Frozen access paths:

| Symbol | Module | Owner |
| --- | --- | --- |
| `CollaborativeSession`, `CollaborativeSessionResult`, `CollaboratorInfo`, `UndoState`, `CollaborativeSessionOptions` | `@insighthub/shared` | A0 |
| `createCollaborativeSession(options): Promise<CollaborativeSession>` | `apps/web/src/collab/public.ts` | A1 implements |
| `useCollaborativeDocument(options): CollaborativeSessionResult` | `apps/web/src/collab/public.ts` | A1 implements |
| anything under `apps/web/src/collab/internal/**` | — | A1 private; **A2 must not import** |

Boundary rules:

- **A2 must not depend on** IndexedDB, the reconnect queue, state vectors, or
  socket framing. None of them appear in the interface.
- **A1 must not depend on** React/CodeMirror UI. `collab/**` imports no editor code.
- `createCollaborativeSession` resolves once **local** state is available and MUST
  NOT wait for the network (§10). It rejects only on unrecoverable local failure.
- The caller owns teardown and must call `destroy()`.
- One session per `documentId` per client in M1
  (`COLLAB_SESSION_CONSTRAINTS.oneSessionPerDocument`).

## 9. Awareness contract

```ts
type AwarenessState = {
  user: { id: string; name: string; color?: string /* #rrggbb */ };
  cursor: { anchor: number; head: number } | null;
  selection: { from: number; to: number } | null;   // from <= to
  updatedAt: number;                                 // epoch ms
};
```

Awareness is **ephemeral presence**:

- It is NEVER written to IndexedDB as document data.
- It is NEVER merged into `Y.Text` or any `Y.Doc` shared type.
- It is NEVER a source of truth for document content.
- It arrives as untrusted JSON from peers, so validate with `isAwarenessState` /
  `awarenessStateSchema` (or filter a whole map with `collectValidAwarenessStates`)
  rather than casting — it is rendered directly as another user's name and cursor.
- `MAX_AWARENESS_CLIENTS_PER_UPDATE = 512` bounds one update's fan-out.

### 9.1 Cleanup rules (frozen)

| Event | Required behaviour |
| --- | --- |
| Client disconnects (clean or abrupt) | Server removes its awareness state and broadcasts that departure to the room; peers drop the entry immediately. No ghost cursors. |
| Socket closes without a `leave-room` | Same as above — the server must not wait for a polite message. |
| Client calls `session.destroy()` | Its local entry is removed and that removal is broadcast before the socket closes. |
| No update for `outdatedTimeout` (30 s, y-protocols) | Peers expire the entry locally. Independent safety net for a server that never announced the departure. |
| Document closed / session ends | Awareness for that document is discarded entirely; it is never persisted. |
| Atomic room replace (`join-room(B)` while in A) | A's awareness entry for this client is removed and broadcast to A before B is joined, so A never keeps a stale cursor for a client that has left. |

### 9.2 Awareness consumption boundary (frozen by M1-A0.1)

Awareness is the single source of truth for ephemeral presence (§9), which makes
the *read path* part of the contract:

- **`session.awareness.getStates()` MUST NOT be used as a UI data source.**
  Its values are `Map<number, unknown>` straight off the wire: unvalidated,
  possibly missing required fields, possibly hostile. Rendering it directly means
  rendering unvalidated peer input (another user's name and cursor position).
- **A2 must read collaborator data through `session.getCollaborators()`** (or an
  equivalent validated public accessor). That accessor returns `CollaboratorInfo[]`
  already filtered through `awarenessStateSchema` via `collectValidAwarenessStates`.
- **Exception, narrowly scoped:** the raw `Awareness` instance may be handed to a
  Yjs/CodeMirror collaboration binding (e.g. an editor extension that renders
  remote cursors), because such a binding needs the live `Awareness` object itself.
  Even then it is used for **collaboration binding only** — never as business UI
  state, never copied into Redux, never persisted.
- Anything that renders a collaborator must therefore go through the validated
  accessor; anything that merely *binds* to Yjs may hold the raw instance.

Enforced by `AGENTS.md` R14 and reviewed by A7.

## 10. Lifecycle semantics (frozen)

### 10.1 Document open sequence

The ordering is the contract. Local state gates `active`; the network never does.

```
open document
  ↓ create Y.Doc
  ↓ attach IndexedDB persistence (y-indexeddb)
  ↓ wait for local state to load      → session.state = 'active'   ← editor usable HERE
  ↓ connect WebSocket
  ↓ join-room
  ↓ room-joined
  ↓ binary SyncStep1 (client state vector)
  ↓ server replies SyncStep2 (missing delta) + SyncStep1
  ↓ client replies SyncStep2
  ↓ converged
```

Because `active` precedes the socket, **the UI must never wait for the network
before allowing edits**, and must not treat `connectionStatus !== 'connected'` as
read-only.

### 10.2 Sync semantics

**InsightHub M1 chooses a client-initiated sync handshake:**

```
Client SyncStep1 (own state vector)
  → Server SyncStep2 (the delta the client is missing) + Server SyncStep1
  → Client SyncStep2
  → converged
```

This is a **choice made here**, not a constraint imposed by `y-protocols`. That
library can express the opposite direction perfectly well; we pick
client-initiated because it degrades better in a browser: a client knows when it
is ready (local IndexedDB loaded) and can then ask, whereas a server-initiated
push would need the server to track per-client readiness and would speculatively
send data to clients that may never render the document. It also means the
handshake starts from the client's own reconnection logic, which is where the
"am I behind?" question actually arises.

Consequences of that choice, which the implementation must respect:

- `SyncStep1` carries a state vector; `SyncStep2` carries only the missing structs
  plus the delete set, so reconnect transfers a delta, not the document.
- The server never initiates a sync exchange; it replies to one. (Stated as our
  rule, not as a general law about Yjs.)
- Sync is scoped to a room. Yjs messages carry no room name, so the room is bound
  by the socket's `join-room`, never by the frame.

### 10.3 Reconnect, duplicates, ordering

| Case | Semantics |
| --- | --- |
| Reconnect | Re-run the open sequence from the IndexedDB load onward. Local edits made while offline are already in the local `Y.Doc`, so they are captured by the new `SyncStep1`. Reconnection must not require a page reload. |
| Duplicate update | Harmless and expected. Yjs updates are idempotent: applying the same update twice is a no-op because structs are identified by `(clientID, clock)`. No business-layer dedup, no OT. |
| Out-of-order delivery | Safe. CRDT merge is order-independent; a causally-earlier update arriving later still merges. Nothing may assume arrival order equals edit order. |
| Missed update while disconnected | Recovered by the next `SyncStep1`/`SyncStep2` exchange; that is exactly why sync is state-vector driven rather than a raw update stream. |
| `leave-room` | Client stops sending/receiving data-plane frames for that document; the server removes it from the room and **removes + broadcasts its awareness entry** (the only presence channel — §9). The `Y.Doc` and IndexedDB stay alive. |
| Socket close | Equivalent to an implicit leave for every room the socket was in: awareness cleanup + broadcast, room membership dropped. No separate presence notification exists or is needed. |
| `join-room(B)` while in A | Atomic replace (§5.4): A's awareness entry is removed and broadcast before B is joined. |
| Send to a room never joined | `ROOM_NOT_JOINED`, socket stays open. |

Explicit non-goal: there is **no** business-layer OT, no sequence numbers and no
ack layer for document edits. Adding one would duplicate what the CRDT already
guarantees.

## 11. AiEditSuggestion

```ts
type AiEditOperation =
  | { kind: 'replace'; index: number; length: number; text: string }
  | { kind: 'insert';  index: number; text: string };

type AiEditSuggestion = {
  id: string;
  documentId: string;
  baseRevision: number;          // revision it was generated against
  summary: string;               // 1..500 chars, shown in Diff Preview header
  operations: AiEditOperation[];  // at least one
  diff: string;                  // unified diff text for the preview
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  createdAt: string;             // ISO 8601
};
```

Request shape (`AiSuggestRequest`): `{ documentId, instruction, baseRevision,
content }` with `content` capped at 200 000 chars.

Helpers: `isSuggestionStale(suggestion, currentRevision)`,
`aiAcceptRequiredRole` (accepting an edit requires at least `editor`).

**Behavioural contract, not just a type:** an accepted suggestion is applied
through a Yjs transaction stamped `TRANSACTION_ORIGINS.ai`. `AiEditSuggestion` is
a proposal object and must never be treated as document state
(`docs/ARCHITECTURE.md` §3).

## 12. HTTP API

| Method | Path | Response | Milestone |
| --- | --- | --- | --- |
| `GET` | `/health` | `200 { "status": "ok" }` | M0 |
| `GET` | `/api/meta` | `200 { name, wsPath, protocolVersion: 2 }` | M0 |
| `GET` | `/api/documents` | not designed yet | M2 |
| `GET` | `/api/documents/:id` | not designed yet | M2 |

Unknown paths return `404 { "error": "not_found" }`.

WebSocket endpoint: `ws://<host>:<port>/ws` (configurable via `WS_PATH`).
An upgrade request on any other path is rejected.

## 13. Change process

1. Propose the addition here first (or in the PR description for solo work).
2. Get Supervisor approval; edit `packages/shared` in isolation.
3. Add or update a test in `packages/shared/src/*.test.ts`.
4. Run `pnpm typecheck && pnpm test`.
5. If the change is breaking, bump `SHARED_CONTRACT_VERSION` **and**
   `PROTOCOL_VERSION` as appropriate, and record it in `docs/DECISIONS.md`.

## 14. Durable persistence seam (M2 — FROZEN design, NOT implemented)

> **Status: FROZEN (design).** No code exists yet; `packages/shared` is unchanged and the
> wire protocol is unchanged. This section is normative for `M2-P0-1`, so the store cannot
> be invented differently by each caller.

### 14.1 The seam

The server reaches durable state only through `DocumentStore`. Its shape is specified in
`docs/ARCHITECTURE.md` §7.3. The normative parts:

| Member | Meaning | Guarantee |
| --- | --- | --- |
| `load(documentId)` | read snapshot + log | `null` means *never stored*, never "empty document" |
| `append(documentId, update)` | append one already-applied update | resolves **with the committed sequence, only after the bytes are durable**; rejects on failure |
| `compact(documentId, snapshot, throughSequence)` | replace snapshot, drop consumed log | atomic: a crash mid-compaction leaves either the old state or the new one |
| `delete(documentId)` | durable removal | idempotent; removal, not a flag |
| `close()` | flush and release | idempotent; safe on a store that failed to open |

### 14.2 Durability claim, stated precisely

`append` resolving means the update survives **process death**. It is not an fsync-per-write
promise about power loss, and it is not a replication promise. Stating the weaker guarantee
is deliberate: claiming "durable" without naming the failure model is how persistence
claims become marketing.

### 14.3 Ordering (normative)

`apply → persist → broadcast`. Persist must be awaited before the update is relayed to any
other peer. Consequence: a persist failure is never visible to peers as an accepted update.

### 14.4 Failure signalling on the wire

No new error code. On a persist failure the server sends `INTERNAL_ERROR` (§7), closes
the socket, and permanently stops that document's mutation pipeline (§14.6, §14.8). `INTERNAL_ERROR` is non-fatal by contract, which is what we want: the client
keeps its reconnect loop and re-sends through the normal state-vector handshake. Making it
fatal would permanently stop a client over a transient storage outage.

### 14.5 What this section does **not** authorise

- It does not change binary framing, message types, payload shapes or the error vocabulary.
- It does not make Markdown the server's source of truth.
- It does not permit a memory-only fallback: if the store cannot be opened, the server
  refuses to start (an explicit refusal, not a silent degradation).

### 14.6 Per-document mutation serialization (normative)

A document's durable mutations form one FIFO pipeline: `apply → persist → broadcast` for
`U(n+1)` may not begin before `U(n)` completes. Independent documents may run in parallel.
Adapters must preserve this ordering regardless of their own concurrency model — including an
async adapter that could otherwise overlap two appends. See `docs/ARCHITECTURE.md` §7.7.

### 14.7 `append` / sequence atomicity (normative)

`append(documentId, update)` must, atomically: allocate a **strictly increasing** sequence for
that document, write the update bytes, and return the committed sequence. Two concurrent
callers must never receive the same sequence. `snapshot_seq` may only ever name a sequence
that is durably committed. `compact()` must perform snapshot replacement, `snapshot_seq`
advance and deletion of the consumed log rows inside **one transaction**.

### 14.8 Pipeline stop on failure (normative)

On any persist failure: the room becomes unhealthy; no further mutation is accepted; the
failing update **and every already-queued update** are not broadcast; participants receive
`INTERNAL_ERROR` and the server closes them; the in-memory room is destroyed; previously
committed durable state stays valid and is never rolled back.

### 14.9 Hydration backlog overflow is not a frame-size violation

While a room is hydrating, inbound BINARY frames are held in a bounded queue. A **cumulative
backlog** overflow is a server-side condition, not an oversized frame, so it must never be
reported as `FRAME_TOO_LARGE` (reserved for a single frame exceeding the frame-size contract,
§6.2). The room goes unhealthy, participants receive `INTERNAL_ERROR`, and the server closes
them. The server log may tag the event `HYDRATION_BACKLOG_OVERFLOW`; that tag is **not** part
of the wire error vocabulary (§7) and does not change `PROTOCOL_VERSION`.

## 15. Presence write seam (M2-P0-2 — IMPLEMENTED 2026-10-18; editor migration pending)

> **Status: IMPLEMENTED (step 1 of 3).** `CollaborativeSession.publishPresence`, `PresencePatch`,
> `parsePresencePatch` and `PresencePatchError` ship today; `SHARED_CONTRACT_VERSION` is **3**
> (§15.5) and `PROTOCOL_VERSION` is unchanged. Steps 2 (A2 editor migration) and 3 (narrowing the
> raw `Awareness`) are still open — see §15.3 and `docs/TASKS.md` M2-P0-2.

### 15.1 The gap

Today A2 publishes presence by writing the raw instance
(`apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx` calls
`session.awareness.setLocalStateField('cursor' | 'selection' | 'updatedAt', …)`), while
`CollaborativeSession` (§8) exposes presence **reads** only. Two consequences:

1. the shape a client publishes is not owned by the contract — only the read side is
   validated against `awarenessStateSchema`;
2. `updatedAt` is maintained by A2, duplicating bookkeeping A1 already implements
   (`document-session.ts` `setCursor`/`setSelection` are not on the seam, so A2 cannot call
   them through the type).

### 15.2 Frozen design

```ts
export interface CollaborativeSession {
  // ... existing members unchanged ...

  /**
   * Publish this client's presence. Validated before it is written; `updatedAt` is set by
   * the collaboration layer, never by the caller.
   */
  publishPresence(patch: PresencePatch): void;
}

export interface PresencePatch {
  readonly cursor?: { anchor: number; head: number } | null;
  readonly selection?: { from: number; to: number } | null;
}
```

Rules:

1. **`updatedAt` is owned by the collab layer.** A2 stops computing it. This removes the
   duplicate bookkeeping rather than documenting it away.
2. **Validation happens before the write**, against the same schema the read side uses
   (`awarenessStateSchema` and its cursor/selection sub-schemas). An invalid patch is a
   programming error and throws; it must never reach the wire.
3. **Awareness remains the only presence channel.** No control-plane presence message is
   added; `docs/DECISIONS.md` D-021 still stands.
4. **The raw `Awareness` instance may remain exposed only as a binding input.** It is not a
   write path and not UI state (R14). The seam addition does not legitimise writing through
   it; it exists so a caller never has to.
5. **Partial patches are legal**: publishing only `cursor` must not clear `selection`.

### 15.3 Migration order (frozen)

The order matters because the two packages ship in one workspace but are reviewed as
separate changes:

1. **A1** adds `publishPresence` to the seam and implements it (additive, no callers yet).
2. **A2** migrates the editor to call it and deletes its own `updatedAt` bookkeeping.
3. **A1** narrows `readonly awareness` to a binding-input-only type (or keeps it with an
   explicit write prohibition), now that no production caller writes through it.

Doing step 3 before step 2 would break the editor; doing step 2 before step 1 is impossible.

### 15.4 Scope restraint

Only cursor and selection are covered. Collaborator identity (`user`) is already established
by the session at construction and is not a per-keystroke write; adding it to the patch would
invite callers to change identity mid-session, which nothing in M2 needs.

### 15.5 Version impact

| Constant | Change | Why |
| --- | --- | --- |
| `SHARED_CONTRACT_VERSION` | 2 → **3** when implemented | additive but interface-level change to a frozen seam |
| `PROTOCOL_VERSION` | **unchanged** | the wire does not change: awareness fields already exist |

## 16. Client-internal lifecycle fixes are not contract matters

`M2-P0-3` (the injected IndexedDB factory lifecycle) is a client-internal implementation
concern. It changes no seam, no message and no schema, so it is specified in
`docs/DECISIONS.md` D-046 and `docs/ARCHITECTURE.md` §7.2 rather than here. Recording that
explicitly keeps this document about the cross-boundary contract only.
