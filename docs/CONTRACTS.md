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
suggestions. M2 will back it with stored state; until then the M1 room counter
`RoomJoinedPayload.revision` is the only runtime revision, and it is per-room
activity, not a durable document version. `DocumentStatus` is `'draft' |
'published' | 'archived'`.

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
| Control | TEXT | `connected`, `join-room`, `room-joined`, `leave-room`, `presence`, `error` | JSON envelope (§5) |
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
| `presence` | server → client | `PresencePayload` | **M1 (frozen)** |
| `error` | server → client | `WsErrorPayload` | M0 |

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
  revision: number;          // room activity counter (see §1)
  peers: string[];           // other connection ids already in the room
};

type LeaveRoomPayload = { documentId: string };

type PresencePayload = {
  documentId: string;
  connectionId: string;
  state: 'joined' | 'left';
};

type WsErrorPayload = {
  code: WsErrorCode;         // §7 frozen vocabulary (Zod enum)
  message: string;           // human-facing; never a stack trace
  requestId?: string;        // echoed when correlated with a request
};
```

### 5.3 Helpers

- `createEnvelope(type, payload, { requestId?, ts? })` — build a valid envelope.
- `createConnectedMessage(connectionId, opts?)` — the handshake.
- `createErrorMessage(code, message, opts?)` — typed error builder; use this so an
  invented code is a compile error.
- `createRoomJoinedMessage(payload, opts?)` / `createPresenceMessage(payload, opts?)`.
- `parseServerMessage(raw)` / `parseClientMessage(raw)` — validate; never throw.
- `parseMessageJson(rawString)` — JSON decode + validate; never throw.
- `isWsMessageOfType(message, type)` — narrow a parsed message.

Parsers return `{ success: true, data }` or `{ success: false, error }`.

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

## 7. Error codes (frozen by M1-A0)

```ts
type WsErrorCode =
  | 'INVALID_MESSAGE' | 'UNKNOWN_MESSAGE_TYPE' | 'INVALID_BINARY_FRAME'
  | 'FRAME_TOO_LARGE' | 'ROOM_NOT_JOINED' | 'ROOM_NOT_FOUND'
  | 'PROTOCOL_VERSION_MISMATCH' | 'INTERNAL_ERROR';
```

| Code | Meaning | Fatal for the socket |
| --- | --- | --- |
| `INVALID_MESSAGE` | Payload not parseable as its declared type. | yes |
| `UNKNOWN_MESSAGE_TYPE` | Well-formed payload with an unimplemented `type`. | yes |
| `INVALID_BINARY_FRAME` | Binary frame undecodable / truncated / trailing bytes. | yes |
| `FRAME_TOO_LARGE` | Binary frame over the limit. | yes |
| `ROOM_NOT_JOINED` | Data-plane frame before a successful join. | no |
| `ROOM_NOT_FOUND` | Server refused to open the room. In M1 there is no persisted store, so this means "no room for this documentId"; reserved so M2 needs no new vocabulary. | no |
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

- The **client initiates** sync. The server only replies to requests and does not
  initiate conversations (this is the documented `y-protocols` client-server
  model and it is deliberate, not an omission).
- `SyncStep1` carries a state vector; `SyncStep2` carries only the missing
  structs plus the delete set, so reconnect transfers a delta, not the document.
- Sync is scoped to a room. Yjs messages carry no room name, so the room is bound
  by the socket's `join-room`, never by the frame.

### 10.3 Reconnect, duplicates, ordering

| Case | Semantics |
| --- | --- |
| Reconnect | Re-run the open sequence from the IndexedDB load onward. Local edits made while offline are already in the local `Y.Doc`, so they are captured by the new `SyncStep1`. Reconnection must not require a page reload. |
| Duplicate update | Harmless and expected. Yjs updates are idempotent: applying the same update twice is a no-op because structs are identified by `(clientID, clock)`. No business-layer dedup, no OT. |
| Out-of-order delivery | Safe. CRDT merge is order-independent; a causally-earlier update arriving later still merges. Nothing may assume arrival order equals edit order. |
| Missed update while disconnected | Recovered by the next `SyncStep1`/`SyncStep2` exchange; that is exactly why sync is state-vector driven rather than a raw update stream. |
| `leave-room` | Client stops sending/receiving data-plane frames for that document; the server removes it from the room and broadcasts presence. The `Y.Doc` and IndexedDB stay alive. |
| Socket close | Equivalent to an implicit leave for every room the socket was in: presence broadcast, awareness cleaned up, room membership dropped. |
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
