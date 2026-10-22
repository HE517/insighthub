# CONTRACTS.md

The cross-boundary interface. Everything here is implemented in
`packages/shared/src/**` and imported by both apps. Add here **before**
implementing. Changing this file requires Supervisor approval (`AGENTS.md` §2).

| Version | Value |
| --- | --- |
| Shared contract version | `SHARED_CONTRACT_VERSION = 8` |
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
| `room-joined` | server → client | `RoomJoinedPayload` | **M1 (frozen)**; `role` added in M2 Phase 2 |
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
  mode: 'readonly' | 'readwrite'; // defaults to 'readwrite'; ADVISORY ONLY since §17.5
};

type RoomJoinedPayload = {
  documentId: string;
  connectionId: string;      // the server's id for THIS socket
  peers: string[];           // INITIAL roster of other connection ids in the room
  role: DocumentRole;        // the caller's role in this document (§17.5, added in M2 Phase 2)
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

**`RoomJoinedPayload.role`** is the **only** channel through which the client learns its own
role, and it exists for UI gating alone (§17.5). It is required, not optional: the server has
already resolved a membership before it admits the caller, so there is no case where a successful
`join-room` leaves the role unknown. It carries **no** authority — a client that rewrites it in
memory only changes which controls it shows itself; every enforcement point asks the server.
Adding it is additive to the payload (no field removed or retyped), and it bumps
`SHARED_CONTRACT_VERSION` **5 → 6**; `PROTOCOL_VERSION` stays **2**.

Why here rather than in an HTTP response: `GET /api/documents/:id` returns `DocumentMeta`
(§1) and has no membership field, and the document switch is a WS transition. Putting the role
where membership is established avoids a second round trip and a second place for the two
answers to disagree.

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

### 11.1 M3 anchoring: RelativePosition + original-text validation (supersedes D-004's M4 deferral)

Frozen for M3 by `docs/DECISIONS.md` **D-075**. Every operation **must** carry an anchor; `index` /
`length` stay in the shape (the Diff Preview renders from them, and they are the readable form of
the range).

```ts
type AiOperationAnchor = {
  /** Encoded Yjs RelativePosition: the JSON produced by `relativePositionToJSON` (see below). */
  start: string;
  /** Encoded RelativePosition for the end of the replaced range. Present iff `kind === 'replace'`. */
  end?: string;
  /** The exact text the operation expects to find at the anchored range when it is applied. */
  expectedText: string;
};

type AiEditOperation =
  | { kind: 'replace'; index: number; length: number; text: string; anchor: AiOperationAnchor }
  | { kind: 'insert';  index: number; text: string; anchor: AiOperationAnchor };
```

**Encoding (normative).** The canonical pair is Yjs's
`relativePositionToJSON(position)` → `string` and `createRelativePositionFromJSON(string)` →
`RelativePosition`. There is **no** instance `toJSON()` on `RelativePosition` in yjs 13.6.33;
decoding must never throw (a malformed anchor is a validation failure, not an exception).

**Boundary association (measured, yjs 13.6.33).** `start` is created with `assoc = 0` and the
`replace` `end` with `assoc = -1`, so a peer insertion **exactly at either boundary stays outside
the range**. With `assoc >= 0` at the end, a trailing insertion is absorbed into the range and an
otherwise-applicable suggestion becomes falsely stale — which would violate the acceptance
criterion "edits outside the region must still apply". The anchor module records the measurement
table next to the constants; do not "fix" it back to `>= 0` without re-measuring.

**Revision semantics (normative, and the reason check #1 may pass after a remote edit).** The
`baseRevision` / `currentRevision` pair is a **client-local** counter: it counts *this client's own*
document updates (origins `local` and `ai`), not every update the replica merges. Two consequences
follow, and both are required by the acceptance criteria:

- A remote edit — even one inside the suggested region — does **not** fail check #1. It is caught
  by check #2/#3 instead, which is the only way "a peer edited elsewhere, the suggestion still
  applies" and "a peer edited the region, the suggestion is stale" can coexist.
- A **local** edit (the user typing, or an earlier accepted AI edit) does fail check #1. The
  user's own document has moved on since the proposal, so the proposal's premise is gone.

Because the counter is local, a suggestion must not be shared across clients as if its
`baseRevision` meant the same thing for everyone; M3 round 1 generates and applies proposals on
one client (see D-075 §4). Anything that changes this — a server-side provider, a shared proposal
queue — needs its own revision definition and a contract change.

**Validation order (normative).** A suggestion is applicable only if all three hold; the first
failure wins and the suggestion is `stale`, never partially applied:

| # | Check | Failure means |
| --- | --- | --- |
| 1 | `baseRevision === currentRevision` (existing `isSuggestionStale`) | the document moved on |
| 2 | each anchor resolves against the **current** `Y.Text` | the anchored region can no longer be located (wrong document, or a different `Y.Text`). Note: a **deleted** region still *resolves* — Yjs keeps the position alive and maps it to a neighbouring index — so deletion is caught by check 3, not here |
| 3 | the text at the resolved range equals `expectedText` (exact string compare) | the region moved **and** changed — the proposal's premise is gone |

Checks 2 and 3 are why RelativePosition is not enough on its own: Yjs keeps a deleted position
alive (it maps to a neighbouring index), so an anchor can resolve successfully onto **different
text**. `expectedText` is the guard that turns "resolved" into "still the text you reviewed".

**Why additive rather than a rewrite.** `index`/`length` are kept, so the diff rendering and any
existing reader keep working; the anchor is what application uses. This is a *closed-shape growth*
(a required field on an operation), so `SHARED_CONTRACT_VERSION` goes **7 → 8**. `PROTOCOL_VERSION`
is unchanged: suggestions travel over the HTTP layer, not the WebSocket wire.

**Non-goal in M3 round 1:** no server AI endpoint and no external AI provider (see D-075 §4).
Generation is client-side behind an `AiProvider` seam; applying still goes through the existing
`CollaborativeSession.transact` with `TRANSACTION_ORIGINS.ai`.

### 11.2 M3 Round 2: server-side provider (frozen by D-080)

Round 2 adds a **server-side** provider so a real model can be used without ever putting a
credential in the browser. The endpoint returns a **draft**, not a suggestion:

```ts
type AiOperationDraft =
  | { kind: 'replace'; index: number; length: number; text: string }
  | { kind: 'insert';  index: number; text: string };

type AiSuggestionDraft = {
  summary: string;                 // 1..500
  operations: AiOperationDraft[];  // 1..32, plain offsets into the submitted `content`
  model?: string;                  // which model produced it (never a key)
};
```

`POST /api/ai/suggest` — request `AiSuggestRequest` plus an optional
`selection: { from: number; to: number }` (UTF-16, same space as `index`). Response `200` is an
`AiSuggestionDraft`.

**Why a draft and not an `AiEditSuggestion`:** anchors are `RelativePosition`s, which are
**replica-specific** — only the client that minted them can resolve them against its own
`Y.Text`. A server minting anchors would produce positions that resolve on the server and
misresolve (or fail) on the client. So:

1. the server returns plain offsets against the `content` it was given;
2. the **client** re-reads its live `Y.Text`, confirms the snapshot still matches, mints the
   anchors with `createOperationAnchor`, computes the diff, stamps `baseRevision` from its local
   revision counter, and only then produces the `AiEditSuggestion` (§11 / §11.1);
3. Accept still goes through the three checks and one `ai`-origin transaction.

**Authorization:** the session cookie is required (`401`), and the caller must be able to read
the document; unknown document / no membership behave exactly like §17.4's non-disclosure rule
(`404`, never a hint that the document exists).

**Fail closed (normative).** Every failure returns an error and **no draft**; a partial or
repaired-by-guess output is forbidden:

| Situation | Response |
| --- | --- |
| missing/expired session | `401 session_required` |
| no read access | `404 not_found` (non-disclosure) |
| provider not configured | `503 ai_provider_not_configured` |
| provider timeout / aborted | `504 provider_timeout` |
| provider 5xx / network | `502 provider_error` |
| model output not parseable | `502 invalid_provider_output` |
| model output fails the draft schema (unknown op, too many ops, summary too long, negative index, …) | `502 invalid_provider_output` |
| rate limited | `429 rate_limited` (reserved; enforcement is M4 D6) |

**Configuration (server only).** `OPENAI_API_KEY` (required when `AI_PROVIDER=openai`),
`OPENAI_MODEL` (optional, default documented in the adapter), `AI_PROVIDER` (`openai` |
`disabled` | `stub`). No key in the browser bundle, no `VITE_OPENAI_API_KEY`, no browser→OpenAI call.

`AI_PROVIDER=stub` is a **development/evidence-only** value: a deterministic, network-free
provider (uppercases the submitted content or the selected range) that lets the real HTTP chain —
browser → endpoint → draft → client-minted anchors → preview → Accept — be evidenced without a key.
It is never the default, never a fallback for a missing/invalid OpenAI configuration, and the
startup log says so. **Production configuration validation (M4 D3) must reject `stub`.**

**Test determinism.** Repository gates never call a real model: unit/integration tests inject a
fake server provider, the browser suite keeps using the deterministic client provider, and a
`live` smoke test runs only when `OPENAI_API_KEY` is set. A live smoke never replaces
deterministic evidence.

**Version impact.** The draft shape is an **additive** export set (`AiOperationDraft`,
`AiSuggestionDraft`, `aiSuggestHttpRequestSchema`, `AI_MAX_DRAFT_OPERATIONS`): no existing type
changed and the WebSocket wire is untouched, so `SHARED_CONTRACT_VERSION` stays **8** and
`PROTOCOL_VERSION` stays **2**.

**Upstream 429.** A 429 from the model provider is mapped to `provider` → `502` until M4 D6
implements our own limits. The `429 rate_limited` row above is *our* budget, not the model's.

**Production gate (not optional).** Enabling `AI_PROVIDER=openai` in production requires M4 D1
(real authentication), M4 D3 (config validation that **rejects `stub`** and fails fast) and M4 D6
(rate/concurrency/cost limits). See `docs/DECISIONS.md` D-081.

## 12. HTTP API

| Method | Path | Response | Milestone |
| --- | --- | --- | --- |
| `GET` | `/health` | `200 { "status": "ok" }` | M0 |
| `GET` | `/api/meta` | `200 { name, wsPath, protocolVersion: 2 }` | M0 |
| `POST` | `/api/session/bootstrap` | `200 { userId, displayName, expiresAt }` + `Set-Cookie` — §17.4 | M2 Phase 2 |
| `GET` | `/api/session` | `200 { userId, displayName, expiresAt }` / `401` — §17.4 | M2 Phase 2 |
| `DELETE` | `/api/session` | `204` + cleared cookie / `401` — §17.4 | M2 Phase 2 |
| `GET` | `/api/documents` | `200 { documents: DocumentMeta[] }` / `401` — §17.4 | M2 Phase 2 |
| `GET` | `/api/documents/:id` | `200 DocumentMeta` / `401` / `403` / `404` — §17.4 | M2 Phase 2 |
| `POST` | `/api/ai/suggest` | `200 AiSuggestionDraft` / `401` / `403` / `404` / `503` / `502` / `504` — §11.2 | M3 Round 2 |

Unknown paths return `404 { "error": "not_found" }`. The non-disclosure rule for
`/api/documents/:id` (§17.4) governs which of `403` and `404` a caller may see.

**Unhandled failures.** Any route may answer `500 { "error": "internal_error" }` when its handler
throws. That shape is part of the contract rather than an implementation detail, because the
alternative is Express's default error handler putting a **stack trace on the wire**, which §7
forbids. The body carries no detail — no message, no path, no SQL — and the detail goes to the
server log only. `internal_error` is the HTTP counterpart of the WebSocket `INTERNAL_ERROR` code.

WebSocket endpoint: `ws://<host>:<port>/ws` (configurable via `WS_PATH`).
An upgrade request on any other path is rejected.

## 13. Change process

1. Propose the addition here first (or in the PR description for solo work).
2. Get Supervisor approval; edit `packages/shared` in isolation.
3. Add or update a test in `packages/shared/src/*.test.ts`.
4. Run `pnpm typecheck && pnpm test`.
5. If the change is breaking, bump `SHARED_CONTRACT_VERSION` **and**
   `PROTOCOL_VERSION` as appropriate, and record it in `docs/DECISIONS.md`.

## 14. Durable persistence seam (M2 — IMPLEMENTED, M2-P0-1)

> **Status: IMPLEMENTED (M2-P0-1, reviewed by A7 — see `docs/TASKS.md` M2-P0 Exit Gate).**
> `apps/server/src/persistence/**` implements this seam (`SqliteDocumentStore`, the hydrator, the
> capability check) and the room lifecycle around it. `packages/shared` and the wire protocol are
> unchanged by it. This section stays normative: the store must not be invented differently by
> each caller.

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

## 15. Presence write seam (M2-P0-2 — steps 1–3 IMPLEMENTED)

> **Status: IMPLEMENTED (all three steps).** `CollaborativeSession.publishPresence`,
> `PresencePatch`, `parsePresencePatch`, `PresencePatchError` and `AwarenessBinding` ship today.
> The A2 editor publishes exclusively through the seam (no raw `Awareness` write and no
> `updatedAt` bookkeeping remain in `apps/web/src/features/**` production code), and
> `readonly awareness` is narrowed so a raw write **does not compile** (§15.2 rule 4, §15.6).
> `SHARED_CONTRACT_VERSION` is **4** and `PROTOCOL_VERSION` is unchanged (§15.5).

### 15.1 The gap (historical — this section records what M2-P0-2 fixed)

Today A2 publishes presence by writing the raw instance
(`apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx` called
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
   it; it exists so a caller never has to. **As implemented, the exposure is the narrowed
   `AwarenessBinding` (§15.6): the write members are not on the type, so a raw write is a
   compile error rather than a documented prohibition.**
5. **Partial patches are legal**: publishing only `cursor` must not clear `selection`.

### 15.3 Migration order (frozen, now complete)

The order matters because the two packages ship in one workspace but are reviewed as
separate changes:

1. **A1** adds `publishPresence` to the seam and implements it (additive, no callers yet).
   — **DONE** (`6714ca2`, plus the A0 ownership exception `054d87e` for A2's test double).
2. **A2** migrates the editor to call it and deletes its own `updatedAt` bookkeeping.
   — **DONE** (`1a8c887`).
3. **A1** narrows `readonly awareness` to a binding-input-only type (or keeps it with an
   explicit write prohibition), now that no production caller writes through it.
   — **DONE** (`9f8cfa2`); the narrowing is `AwarenessBinding` (§15.6).

Doing step 3 before step 2 would break the editor; doing step 2 before step 1 is impossible.
Both statements held in practice: step 1 alone turned 21 `tsc` errors on in A2's test double,
and step 3 needed step 2's callers gone before the write members could be removed.

### 15.6 The narrowed exposure: `AwarenessBinding`

```ts
export interface AwarenessBinding
  extends Pick<awarenessProtocol.Awareness, 'clientID' | 'on' | 'off'> {
  /** Live peer entries as they came off the wire — unvalidated, read-only. */
  getStates(): ReadonlyMap<number, unknown>;
}
```

| Member | Why it is in the binding face |
| --- | --- |
| `clientID` | the editor's remote-cursor view needs this client's id; made **required** because A2's `AwarenessView` declares it required and `session.awareness` is passed into that parameter |
| `on` / `off` | the remote-cursor subscription and its teardown; taken from `Awareness` via `Pick` so the signature can never drift from `y-protocols` |
| `getStates()` | peer entries; declared as `ReadonlyMap` **not** `Pick<Awareness, 'getStates'>`, because the upstream signature returns a live `Map` — that would leave a write channel wearing a read interface's clothes |

`setLocalState`, `setLocalStateField`, `states`, `meta` and `destroy` are deliberately **absent**:
presence is written only through `publishPresence`, and the awareness channel is torn down by the
session, not by a binding consumer. The runtime object is still the same `Awareness` instance —
this is a type-level window, not a wrapper, so identity, listener counts and `y-protocols`
semantics are unchanged.

Negative type tests pin this: 17 `@ts-expect-error` directives across
`packages/shared/src/collab-session.test.ts` and `apps/web/src/collab/tests/presence-narrowing.test.ts`.
**If the narrowing is reverted, those directives become unused and `tsc` fails with `TS2578`** —
so the prohibition is enforced, not documented.

### 15.4 Scope restraint

Only cursor and selection are covered. Collaborator identity (`user`) is already established
by the session at construction and is not a per-keystroke write; adding it to the patch would
invite callers to change identity mid-session, which nothing in M2 needs.

### 15.5 Version impact

| Constant | Change | Why |
| --- | --- | --- |
| `SHARED_CONTRACT_VERSION` | 2 → **3** (step 1) | additive but interface-level change to a frozen seam |
| `SHARED_CONTRACT_VERSION` | 3 → **4** (step 3) | **breaking**: removing the write members from `readonly awareness` means code that compiled against v3 no longer compiles. Recorded in `docs/DECISIONS.md` D-058 |
| `PROTOCOL_VERSION` | **unchanged (2)** | the wire does not change: awareness fields already exist |

## 16. Client-internal lifecycle fixes are not contract matters

`M2-P0-3` (the injected IndexedDB factory lifecycle) is a client-internal implementation
concern. It changes no seam, no message and no schema, so it is specified in
`docs/DECISIONS.md` D-046 and `docs/ARCHITECTURE.md` §7.2 rather than here. Recording that
explicitly keeps this document about the cross-boundary contract only.

## 17. Identity, session authentication and authorization (M2 Phase 2 — IMPLEMENTED)

Frozen by `docs/DECISIONS.md` **D-061** (Project Owner decision) and **implemented**: the HTTP surface
in `apps/server/src/authz/**` + `app.ts`, the WS enforcement points in `ws.ts` / `rooms/**`, and the
client seam in `packages/shared/src/collab-session.ts` (§17.9). A6's real-browser suite exercises it
(`tests/browser/suite/20-m2-phase2-authz.mjs`, `21-m2-f1-role-ui.mjs`) and A7 reviewed it.

**What is verified vs. what is only promised** is not decided here — see `docs/DECISIONS.md` D-064 §1
and D-068 for the release-note bans (UI gating *is* in effect since A2+A6; "revocation is immediate"
and "the client heals after a restart" are still false).

### 17.0 Three terms that must not be collapsed

| Term | What it is | What it guarantees | What it does **not** guarantee |
| --- | --- | --- | --- |
| **Demo Identity Bootstrap** | `POST /api/session/bootstrap` with a `demoUserId` picked from a **server-side** roster; **no credential is presented** | which demo identity the caller claims | that the caller owns that identity |
| **Session Authentication** | an opaque token in an `httpOnly` cookie; the server maps token → `userId` | later API/WS requests **cannot** self-declare identity; authorization has one trusted source | credential-level identity proof; real-world identity |
| **Authorization** | `userId` → document membership → `DocumentRole` → `documentCapabilities` → HTTP/WS enforcement | who may read / comment / edit / manage | anything about who the user really is |

**Normative wording for release notes, UI labels and reports:**

> 服务端签发的 session 可以防止客户端在后续 API/WS 请求中直接伪造身份；
> demo bootstrap 本身不提供 credential-level identity proof。

**Forbidden phrasings** (must not appear in docs, UI copy or release notes):

- "无密码用户名登录可以防止跨用户冒用" / "passwordless login prevents impersonation";
- unqualified "已实现认证" / "authenticated users" without naming it *session* authentication;
- any sentence implying a demo identity proves a real identity.

If a sentence about authentication is true only of password authentication, it may not be
written about this system. This is a **security-claim** constraint, not a style preference.

### 17.1 Why a server-issued session rather than a client-declared `userId`

Today the client generates its own identity (`apps/web/src/user.ts`) and the server never
sees it. Any design that keeps taking `userId` from a payload, header or query parameter
leaves authorization advisory: the caller chooses whose permissions to borrow. Putting the
mapping in a server-side session is the smallest change that removes exactly that hole — and
no more than that. It is deliberately **not** claimed to fix the bootstrap step, where
identity is still merely claimed.

### 17.2 Session (normative)

| Aspect | Rule |
| --- | --- |
| Cookie | `insighthub_session`; `HttpOnly`; `SameSite=Lax`; `Path=/`; `Secure` added when the request is served over TLS |
| Token | ≥ 128 bits from a CSPRNG, base64url-encoded; opaque (no signed claims, no user data) |
| Token exposure | **never** in a JSON body, **never** in logs, **never** in Yjs/awareness/Redux/localStorage |
| Server state | `token → { userId, createdAt, expiresAt }`, lifetime 12 h |
| Durability | **process-scoped** (in memory). A restart invalidates every session and clients must re-bootstrap. This is a stated Phase 2 limitation, **not** a security property |
| Rotation | each successful bootstrap issues a new token and invalidates the previous one for that client |
| Carrier | the cookie is the only carrier. Phase 2 has **no** `Authorization` header path — one mechanism, not two |
| Revocation | `DELETE /api/session` destroys the session server-side and clears the cookie; a destroyed or expired token yields `401` on every **subsequent request or upgrade** |
| Revocation scope (Phase 2 limitation) | Revocation and expiry are **request-scoped, not retroactive**: an **already-established WebSocket keeps the identity it was admitted with** and is not closed by the logout of its session. Authorization is still re-derived per frame from membership, so a *role* change does take effect on the next frame — but a *revoked session* does not by itself stop a live socket. Measured (`writeApplied: true`); recorded in `docs/DECISIONS.md` D-064. Release notes must **not** claim "revocation is immediate" |

### 17.3 Demo roster and seeded membership (server-side constants)

- The roster is a **server-side constant list** of demo identities (fixed `userId` +
  `displayName`), not user input. An unknown `demoUserId` is `400`, never a new user.
- Demo document memberships (`documentId`, `userId`, `role`) are a **seeded fixture** owned by
  A5 and clearly labelled as demo data. Seeding exists so the roles can be exercised; it is
  not a membership-management feature.
- Explicit non-goals: user creation / signup, profile editing, invitation flows, and any
  membership-mutation endpoint beyond what §17.4 lists.
- **`DocumentMeta.ownerId` is display attribution, not authority.** Phase 2 has no create or
  rename API (§17.7), so `ownerId` names the account whose first authorised join caused the
  document to be persisted. It can therefore differ from the `owner`-role membership row in the
  seeded fixture. Every authorization decision goes through membership (§17.0), never through
  `ownerId`; nothing may derive a capability from it.

### 17.4 HTTP surface (additions to §12)

Every endpoint below requires a session **except** `POST /api/session/bootstrap`.

| Method | Path | Success | Failures |
| --- | --- | --- | --- |
| `POST` | `/api/session/bootstrap` | `200 { userId, displayName, expiresAt }` + `Set-Cookie` | `400 { error: "invalid_demo_identity" }` |
| `GET` | `/api/session` | `200 { userId, displayName, expiresAt }` | `401 { error: "unauthenticated" }` |
| `DELETE` | `/api/session` | `204`, cookie cleared | `401 { error: "unauthenticated" }` |
| `GET` | `/api/documents` | `200 { documents: DocumentMeta[] }` — only documents where the caller has ≥ `viewer` | `401` |
| `GET` | `/api/documents/:id` | `200 DocumentMeta` | `401` / `403` / `404` — see the rule below |

**Non-disclosure rule (normative).** For `GET /api/documents/:id`:

| Caller state | Response |
| --- | --- |
| no session | `401 { error: "unauthenticated" }` |
| session, document unknown **or** caller has no membership **or** no `canRead` | `404 { error: "not_found" }` — **one response for all three**, byte-identical |
| session, `canRead` holds, but the action needs more than `canRead` | `403 { error: "forbidden" }` |

Consequence: a caller can never learn whether a document exists outside their membership.
`404` must not carry a different message for "unknown" versus "not yours", and must not differ
in status, body shape or headers.

Cross-origin note (normative for the dev stack): the API is served on a different port than
the Vite dev server, so `cors` must be configured with `credentials: true` and an explicit
origin (never `*`), and the web client must send `credentials: 'include'`.

### 17.5 WebSocket (normative)

| Point | Rule |
| --- | --- |
| Upgrade | a valid session cookie is required. Missing or expired session → the upgrade is refused with **HTTP `401`**; no WebSocket is established |
| Identity | the server resolves `userId` from the session. Any identity supplied by the client (payload field, header, query) is **ignored** |
| `mode` | `join-room.mode` stays in the schema for compatibility but is **advisory only**. A client claiming `readwrite` never gains write permission; the server derives the effective capability from membership |
| Join denial | unknown document and read-denied document both answer **`ROOM_NOT_FOUND`** (non-disclosure, same rule as §17.4). A denied join **must not** evict or replace a room the socket already holds (atomic replace applies only to a successful join) |
| BINARY `SYNC` — `SyncStep1` | requires **`canRead`** only. It is a *read request*: the server answers with `SyncStep2` and changes nothing. Gating it on `canEdit` would leave a `viewer` permanently unable to receive the document (the sync handshake is client-initiated; the server never pushes state unprompted), which shows an empty editor instead of a denial — worse than refusing |
| BINARY `SYNC` — `SyncStep2` / `Update` | requires `canEdit`. Otherwise: reply `FORBIDDEN`, **do not apply, do not persist, do not broadcast**, and keep the socket open (a reader stays a reader) |
| BINARY `AWARENESS` | requires `canRead` only; a viewer may publish its cursor |
| Join reply | `room-joined` carries the caller's `role` (§5.2). It is the **only** channel that tells the client its own role, it is for UI gating only, and it carries no authority |
| Framing | unchanged. No new frame type; the only payload addition is `room-joined.role`; `PROTOCOL_VERSION` stays **2** |
| Live socket + revocation | A socket that was admitted before its session was revoked **keeps working until it closes** (§17.2's request-scoped revocation). Role changes are re-derived per frame, so a demotion *does* take effect immediately; a logout does not disconnect peers. Do not describe a logout as disconnecting anyone |

> **Correction (M2 Phase 2, A3 finding — this section was wrong).** The first version of this
> table said "BINARY `SYNC` requires `canEdit`". That treated the sync plane as one operation
> when it actually mixes a **read request** (`SyncStep1`) with **write payloads**
> (`SyncStep2` / `Update`). Implemented literally, every `viewer` would be admitted to the room
> and then refused the document: the editor would render empty rather than show an error, and
> the `viewer` role would have no meaning. Split as above. The wire and `packages/shared` are
> unaffected — this is the contract describing the plane it always meant to describe.

### 17.6 Error vocabulary addition

| Item | Change |
| --- | --- |
| `WS_ERROR_CODES.FORBIDDEN` | **new** code, non-fatal, for "you are in this room but may not perform this mutation". `FATAL_CODES` unchanged |
| `PROTOCOL_VERSION` | **unchanged (2)** — additive within the existing `error` message; the workspace ships a single client build, so there is no older client to confuse |
| `SHARED_CONTRACT_VERSION` | 4 → **5** (A5 implemented the bump together with `errors.ts`; recorded here because a closed vocabulary grew) |

`ROOM_NOT_FOUND` is reused rather than adding a second "denied" code, because one code for
both cases is exactly what the non-disclosure rule needs.

### 17.7 What this section does not authorise

Password hashing/storage, signup, password reset, OAuth/SSO, MFA, durable sessions, session
analytics, rate limiting, multi-tenant isolation, **and any `space` entity, space membership
or space role**. Space authorization is deferred until a real space domain exists
(`docs/DECISIONS.md` D-061 决定 2); the four-layer table in `docs/TASKS.md` records space as
*not introduced* rather than inventing an entity so a table looks complete.

### 17.8 Version impact

| Constant | Change | Why |
| --- | --- | --- |
| `SHARED_CONTRACT_VERSION` | 4 → **5** | `WS_ERROR_CODES` gained `FORBIDDEN` (a closed vocabulary grew) — implemented by A5 |
| `SHARED_CONTRACT_VERSION` | 5 → **6** | `RoomJoinedPayload` gained the required `role` field (§5.2) — implemented by A3 |
| `SHARED_CONTRACT_VERSION` | 6 → **7** | `CollaborativeSession` gained `getRole()` (§17.9) — implemented by A1 |
| `PROTOCOL_VERSION` | **unchanged (2)** | framing, message types and every other payload shape are untouched |

### 17.9 Client role exposure: `getRole()` (A1 implements, A2 consumes — closes A7's F1)

The role reaches the client in `room-joined.role` (§5.2) but, as of the Phase 2 gate, **nothing consumed
it** (A7 F1): `capabilityGate` exists and no code dispatches a role into it. Without a frozen seam the fix
would be invented in whichever file the next agent happens to open, so the seam is fixed here first.

`CollaborativeSession` gains exactly one new member:

```ts
/**
 * This client's role in the current document, taken from the most recent
 * successful `room-joined.role`. `null` means UNKNOWN — never a guess.
 */
getRole(): DocumentRole | null;
```

Normative rules:

| # | Rule |
| --- | --- |
| 1 | Source is `room-joined.role` of the most recent **successful** join, validated with `isDocumentRole`. An unparseable value yields `null`; a missing one never defaults to `editor`/`viewer` |
| 2 | `null` means unknown, and covers: before the first successful join, while `state` is not `active`, while offline or reconnecting, after a failed/denied join, and after `destroy()` |
| 3 | It is a **getter**, in the same shape as `getCollaborators()` (R14): not a Redux field, not mirrored into React state, not persisted, not written into awareness |
| 4 | Changes are announced through the **existing** session subscription. Phase 2 adds no second subscription mechanism |
| 5 | It carries **no authority**: the server re-derives the role from membership at every enforcement point (§17.5). A client that lies to itself only changes which controls it shows |
| 6 | Consumers: **A2 only**, for UI gating via `documentCapabilities`. A1 must not import editor code (`AGENTS.md` §6.1) |

Gating consequence for A2: when `getRole()` is `null` the editor stays **fully usable** — an unknown role must
never lock a local user out of their own unsent text (R10). When it is a known role, the editor may be
read-only for a role without `canEdit`, and the copy must say so ("read-only for your role"), never imply the
save happened.

| Constant | Change |
| --- | --- |
| `SHARED_CONTRACT_VERSION` | 6 → **7** (a frozen seam grew a member) |
| `PROTOCOL_VERSION` | **unchanged (2)** — the wire already carries the field |

## 18. Authentication with Clerk (M4 — frozen; implementation B1–B2)

Frozen by `docs/DECISIONS.md` **D-082** (owner decision). This section is the contract the implementation
must satisfy; it does **not** authorize a second session system.

### 18.1 Identity source

Clerk is the **only** production identity source. Sign-in methods for V1: **Email** and **Google**.
Clerk holds credentials, password reset, MFA and session lifecycle; InsightHub must not store passwords
or implement password reset.

The server verifies the Clerk session on every protected request (Clerk backend SDK, server-side secret
only). A verified Clerk user (`sub`) maps to exactly one internal user:

```
Clerk verified identity (sub, email, name)
  → app_user (internal id, clerk_user_id UNIQUE, email, display_name, status)
  → document membership
  → DocumentRole
  → documentCapabilities
  → existing HTTP / WS authorization (§17.5)
```

`app_user` is **mapping only**: it is not a session store, it carries no token, and it is not a second
authentication system. Mapping is created lazily on the first authenticated request and is idempotent.

### 18.2 No second session

InsightHub must **not** create a durable login-session table to duplicate Clerk's session. Clerk's session
is the authentication session; its lifetime, rotation, revocation and (where applicable) restart
continuity are Clerk's responsibility. B1/B2 must first *verify* that this covers: restart continuity,
deploy continuity, logout/revocation, HTTP authentication and WebSocket upgrade authentication. Only a
demonstrated gap may justify local session state, and that gap must be recorded as a decision before it
is implemented.

### 18.3 HTTP

Every non-public endpoint (`/api/session`, `/api/documents*`, `/api/ai/suggest`, bootstrap when enabled)
requires a verified Clerk session and returns `401 session_required` otherwise. The session token is
never returned in a response body, never logged, and never placed where page JavaScript can read it.

### 18.4 WebSocket upgrade

The upgrade is authenticated **before** `handleUpgrade` succeeds: an unauthenticated or expired session
is rejected with `401` and no socket is established. No anonymous socket may join a room. An
already-open socket keeps its admission until it is closed (the same request-scoped revocation
limitation as §17.2; a periodic revalidation policy, if any, is a B2 decision).

### 18.5 Demo bootstrap

`POST /api/session/bootstrap` exists **only** as a development/test fixture. It is enabled only when
`AUTH_MODE=demo` **and** `NODE_ENV !== 'production'`; in production the route is absent (404) and startup
must fail if demo auth is enabled. No production deployment may accept a caller-supplied user id.

### 18.6 Configuration

| Variable | Visibility | Purpose |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | **public** (browser) | Clerk frontend SDK |
| `CLERK_SECRET_KEY` | **server only** | session verification / user lookup |
| `AUTH_MODE` | server | `clerk` (production) or `demo` (development/test only) |

Missing required configuration in production is a **startup failure**, not a warning (§D-082 D2, M4 B3).
**Production refusal codes (M4 B3, frozen).** With `NODE_ENV=production` the server refuses to start
(exit code 1, stable code on stderr, no value ever printed) when:

| Code | Condition |
| --- | --- |
| `DEMO_AUTH_IN_PRODUCTION` | `AUTH_MODE` unset/demo |
| `AUTH_MODE_INVALID` | `AUTH_MODE` is not `clerk`/`demo` |
| `CLERK_SECRET_KEY_MISSING` | `AUTH_MODE=clerk` and the secret is absent/blank |
| `CORS_ORIGIN_INVALID` | missing, still `http://localhost:5173`, not `https://`, or malformed |
| `DATA_PATH_INVALID` | data path missing, relative, or the development default |
| `AI_PROVIDER_STUB_FORBIDDEN` | `AI_PROVIDER=stub` |
| `OPENAI_API_KEY_MISSING` | `AI_PROVIDER=openai` and the key is absent/blank |
| `AI_PROVIDER_INVALID` | any value other than `openai`/`disabled`/unset |

Only the first refusal is reported; the gate runs before the store is opened and before `listen`.
`AUTH_MODE` is matched case-sensitively.
### 18.7 Origin / CSRF hardening (M4 B4 — frozen)

**Allow-list.** Exactly one browser origin: `config.corsOrigin`. A development convenience accepts
the loopback aliases of the same scheme+port (`localhost` ↔ `127.0.0.1` ↔ `[::1]`); production
requires an explicit `https://` origin (B3) and never enters that branch.

| Request | Behaviour |
| --- | --- |
| Allowed `Origin` | `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true`, `Vary: Origin`; `OPTIONS` preflight → `204` with `Allow-Methods`/`Allow-Headers` |
| Disallowed `Origin`, state-changing method (`POST`/`PUT`/`PATCH`/`DELETE`) | **`403 {"error":"origin_not_allowed"}`** before routing, body parsing and identity resolution (even for unknown paths) |
| Disallowed `Origin`, `GET`/`HEAD` | executes, but no CORS headers (a browser cannot read the response) |
| **No** `Origin` | allowed: a non-browser client has no ambient cookie. This is a deliberate policy, not an oversight; the second layer is the `SameSite=Lax` session cookie |
| WebSocket upgrade with a disallowed `Origin` | raw `403 {"error":"origin_not_allowed"}` then `socket.destroy()`; no socket is established (path 404 → Origin → identity) |

Origin is **not** authentication: a non-browser client can forge it. Authentication stays §17/§18.

**Bootstrap rate limit.** `POST /api/session/bootstrap` is limited per client address to
`BOOTSTRAP_RATE_LIMIT_PER_MINUTE` (default **10**) in a fixed 60 s window; the next attempt is
`429 {"error":"rate_limited"}` with `Retry-After`. It is in-process and bounded (expired buckets are
swept, `maxKeys` cap), it does not trust `X-Forwarded-For`, and it runs before body parsing. The
browser suite raises the value through that same configuration variable; the limiter code is not
bypassed.
