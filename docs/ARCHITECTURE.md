# ARCHITECTURE.md

Changing this file requires Supervisor approval (`AGENTS.md` §2).

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

M0 status: neither path is implemented. What exists is the transport skeleton
(socket lifecycle, `connected` handshake, room message vocabulary in
`packages/shared`) that M1 builds on.

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
(`Y.Doc.transact` / `Y.Text` mutation inside a transaction).

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

## 4. Package boundaries and responsibilities

### `apps/web` — the client

Owns: view layer, editor integration, Redux store, AI suggestion UI, permission
UI, Markdown rendering and frontend performance.

Must not: re-declare shared types; decide authorization on its own (the UI only
*reflects* server decisions); hold document truth outside the CRDT document.

### `apps/server` — the API and realtime authority

Owns: Express HTTP API, WebSocket transport, document rooms, connection
lifecycle, authentication, authorization (the authoritative decision),
persistence of document snapshots.

Must not: depend on anything in `apps/web`; invent message shapes that are not in
`packages/shared`.

### `packages/shared` — the contract

Owns: domain types, Zod schemas, WebSocket protocol, API contract, shared
permission vocabulary.

**Duplication rule:** if both web and server need a type, it lives here and both
import it. Two copies of the same type is a defect, because the copies drift and
the drift shows up as a production bug rather than a compile error. Shared
schemas are Zod schemas and TypeScript types are derived via `z.infer`, so
runtime validation and compile-time types cannot disagree.

## 5. Transport contract

The WebSocket envelope is fixed:

```
{ type: string, payload: object, requestId?: string, ts: ISO8601 }
```

- `payload` is always an object, never a bare primitive.
- `requestId` correlates a response with its request (request/response pairs).
- Unknown `type` values are **rejected**, not ignored, so protocol drift fails
  loudly. See `packages/shared/src/protocol.ts` and `docs/CONTRACTS.md`.

Binary Yjs sync frames are a separate transport concern and deliberately are not
part of this JSON envelope.

## 6. State ownership summary

| State | Owner | Notes |
| --- | --- | --- |
| Document content (truth) | CRDT document (`Y.Doc`) | never React/Redux |
| Document metadata | Server API | cached in Redux for rendering |
| Connection status | Redux `connection` slice | vocabulary from `shared` |
| Permission decisions | Server | client mirrors for UI gating only |
| AI suggestions | Server-issued, client-held | ephemeral until accepted/rejected |
| Auth session | Server-issued token | never persisted in a shared doc |
