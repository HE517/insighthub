# CONTRACTS.md

The cross-boundary interface. Everything here is implemented in
`packages/shared/src/**` and imported by both apps. Add here **before**
implementing. Changing this file requires Supervisor approval (`AGENTS.md` §2).

Contract version: `SHARED_CONTRACT_VERSION = 1`

Sources of truth:

| Area | File |
| --- | --- |
| Document | `packages/shared/src/document.ts` |
| Permission | `packages/shared/src/permission.ts` |
| Connection | `packages/shared/src/connection.ts` |
| AI suggestion | `packages/shared/src/ai-suggestion.ts` |
| WebSocket protocol | `packages/shared/src/protocol.ts` |

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

`revision` is the server's document version. It is the staleness anchor for AI
suggestions today, and will be backed by the Yjs state vector in M1 without
changing the field's meaning. `DocumentStatus` is `'draft' | 'published' |
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

## 4. WebSocket message envelope

Every message, both directions:

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
- Binary Yjs sync frames are a separate transport concern, not part of this
  envelope.

### 4.1 Message types

| `type` | Direction | Payload | Milestone |
| --- | --- | --- | --- |
| `connected` | server → client | `ConnectedPayload` | **M0** |
| `join-room` | client → server | `JoinRoomPayload` | M1 |
| `room-joined` | server → client | `RoomJoinedPayload` | M1 |
| `leave-room` | client → server | `LeaveRoomPayload` | M1 |
| `presence` | server → client | `PresencePayload` | M1 |
| `error` | server → client | `WsErrorPayload` | M0 |

### 4.2 Payloads

```ts
type ConnectedPayload = {
  connectionId: string;      // server-assigned
  protocolVersion: 1;        // literal; clients reject unknown versions
  serverTime: string;        // ISO 8601, for clock-skew measurement
};

type JoinRoomPayload = {
  documentId: string;
  lastKnownRevision?: number; // lets the server compute a delta (M1)
};

type RoomJoinedPayload = {
  documentId: string;
  revision: number;
  peers: string[];           // connection ids, excluding self
};

type LeaveRoomPayload = { documentId: string };

type PresencePayload = {
  documentId: string;
  connectionId: string;
  state: 'joined' | 'left';
};

type WsErrorPayload = {
  code: string;
  message: string;
  requestId?: string;        // echoed when correlated with a request
};
```

### 4.3 Helpers

- `createEnvelope(type, payload, { requestId?, ts? })` — build a valid envelope.
- `createConnectedMessage(connectionId, opts?)` — build the M0 handshake.
- `parseServerMessage(raw)` / `parseClientMessage(raw)` — validate; never throw.
- `parseMessageJson(rawString)` — JSON decode + validate; never throw.
- `isWsMessageOfType(message, type)` — narrow a parsed message.

Parsers return `{ success: true, data }` or `{ success: false, error }`.

## 5. AiEditSuggestion

```ts
type AiEditOperation =
  | { kind: 'replace'; index: number; length: number; text: string }
  | { kind: 'insert';  index: number; text: string };

type AiEditSuggestion = {
  id: string;
  documentId: string;
  baseRevision: number;         // revision it was generated against
  summary: string;              // 1..500 chars, shown in Diff Preview header
  operations: AiEditOperation[]; // at least one
  diff: string;                 // unified diff text for the preview
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  createdAt: string;            // ISO 8601
};
```

Request shape (`AiSuggestRequest`): `{ documentId, instruction, baseRevision,
content }` with `content` capped at 200 000 chars.

Helpers: `isSuggestionStale(suggestion, currentRevision)`,
`aiAcceptRequiredRole` (accepting an edit requires at least `editor`).

**Behavioural contract, not just a type:** an accepted suggestion is applied
through a Yjs transaction. `AiEditSuggestion` is a proposal object and must never
be treated as document state (`docs/ARCHITECTURE.md` §3).

## 6. HTTP API

| Method | Path | Response | Milestone |
| --- | --- | --- | --- |
| `GET` | `/health` | `200 { "status": "ok" }` | **M0** |
| `GET` | `/api/meta` | `200 { name, wsPath, protocolVersion }` | **M0** |
| `GET` | `/api/documents` | not designed yet | M2 |
| `GET` | `/api/documents/:id` | not designed yet | M2 |

Unknown paths return `404 { "error": "not_found" }`.

WebSocket endpoint: `ws://<host>:<port>/ws` (configurable via `WS_PATH`).
An upgrade request on any other path is rejected.

## 7. Change process

1. Propose the addition here first (or in the PR description for solo work).
2. Get Supervisor approval; edit `packages/shared` in isolation.
3. Add or update a test in `packages/shared/src/*.test.ts`.
4. Run `pnpm typecheck && pnpm test`.
5. If the change is breaking, bump `SHARED_CONTRACT_VERSION` and record it in
   `docs/DECISIONS.md`.
