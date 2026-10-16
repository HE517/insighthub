# `apps/web/src/collab` — collaboration core (owner: A1)

The Yjs/CRDT layer: one `Y.Doc` per document, `y-indexeddb` durability, state-vector
sync over the frozen binary codec, schema-validated awareness and collaborative-safe
undo.

`docs/ARCHITECTURE.md` §0 is the rule this directory exists to uphold: **document
content has exactly one source of truth, `Y.Doc` / `Y.Text`.** Nothing here keeps a
string copy of the body, and nothing here writes body text into React or Redux.

## Entry points

| Module | Who may import it | What it is |
| --- | --- | --- |
| `public.ts` | **A2 (editor)** and A1 | The frozen seam: `createCollaborativeSession` and `useCollaborativeDocument`. |
| `internal/**` | **A1 only** | Private. A2 must not import it (`docs/CONTRACTS.md` §8). |
| `tests/**` | A1 | Node-level tests plus the in-memory doubles they need. |

`public.ts` is a thin facade, so the private layout can change without touching A2's
call sites.

## Internal layout

| File | Responsibility |
| --- | --- |
| `document-session.ts` | `CollaborativeSession`: the frozen lifecycle order, the `Y.Text` seam, undo/redo, teardown. |
| `persistence.ts` | `y-indexeddb` attachment and `whenSynced` gating; installs the injected IndexedDB factory as the global `lib0` reads, and restores it on teardown. |
| `sync-provider.ts` | The network half: `join-room` → `room-joined` → client-initiated `SyncStep1`/`SyncStep2`, incremental updates, reconnect backoff, frame statistics. |
| `awareness.ts` | Presence: publish local state, validate inbound entries, coalesce outbound frames, release the `y-protocols` interval. |
| `origins.ts` | The frozen transaction origins, re-exported so no call site invents a string. |
| `session-options.ts` | Additive option seams (`wsUrl`, `indexedDB`, `wsSocketFactory`) — see "Contract note" below. |

## Frozen behaviour implemented here

| Rule | Where |
| --- | --- |
| Local state gates `active`; the network never does (§10.1, R10) | `document-session.ts` `createDocumentSession`: persistence first, `startNetwork` after. |
| Client-initiated sync: client `SyncStep1` → server `SyncStep2` + `SyncStep1` → client `SyncStep2` (§10.2) | `sync-provider.ts` `handleControlMessage` / `readSyncPayload`. |
| Two planes, one socket; both use the shared codec, never a private frame format (R12, §6) | `sync-provider.ts` — `decodeBinaryFrame`, `encodeSyncStep1/2/Update`, `encodeAwarenessFrame`. |
| No data-plane frame before a successful `join-room` (§4) | `sync-provider.ts` `sendSyncFrame` (dropped and counted, `framesBeforeJoin`). |
| One socket, one room (R15, §5.4) | The provider is bound to one `documentId` for its lifetime and has no API that could route a frame elsewhere. |
| Reconnect reuses the same `Y.Doc` and replica (§10.3) | `sync-provider.ts` `scheduleReconnect`: only the socket and its timers are rebuilt. |
| Undo reverts only `local`/`ai` origins (R13, §3.1 of ARCHITECTURE) | `document-session.ts` `new Y.UndoManager(text, { trackedOrigins: UNDO_TRACKED_ORIGINS })`. |
| Awareness is ephemeral, never persisted, never document content (§9) | `awareness.ts`; `persistence.ts` only ever sees Yjs updates. |
| UI presence must come from `getCollaborators()` (R14, §9.2) | `awareness.ts` runs `collectValidAwarenessStates` over the raw wire map. |
| Teardown releases listeners, timers, the provider and the socket | `document-session.ts` `destroy()`; asserted by `tests/run-listeners.test.ts`. |

### Awareness clocks (easy to get wrong)

`y-protocols` ignores an awareness update whose clock is not strictly greater than the
last clock it recorded for that client, and it never forgets a client's clock. Two
consequences drove the design of `awareness.ts`:

- **A removal must bump the clock.** `destroy()` publishes this client's departure;
  without a bump the removal would carry exactly the clock peers already hold and be
  silently dropped, leaving a ghost cursor everywhere.
- **An announcement must bump the clock too.** A client learns for the first time that
  it was dropped when it rejoins: its state never changed, so a change-driven publish
  would re-send the same clock and be ignored. `announceLocalState()` therefore bumps
  the clock and refreshes `updatedAt` on every successful join — which is what makes a
  client visible again after a reconnect, and visible at all if a session is destroyed
  and recreated for the same document.

Because removed entries keep their `meta` (the last clock seen), a pending broadcast
for a client whose state was already dropped encodes as `null` and is received as a
departure — the correct outcome, not a leak.

### Contract note: the option seams

`CollaborativeSessionOptions` is frozen in `packages/shared` (Supervisor-owned), but a
session that talks to IndexedDB and WebSockets is untestable in Node without injection
points. `internal/session-options.ts` therefore **augments** the shared interface with
three **optional** fields (`wsUrl`, `indexedDB`, `wsSocketFactory`). This is additive:
nothing was removed, renamed or retyped, so an A2 call site written against the frozen
type keeps compiling. See the module comment for the recommended long-term fix (an
A0-owned optional field on the shared interface).

## Testing strategy — what is and is not verified

The suite runs in the **node** environment, configured once at the repository root
(`vitest.config.ts`), because the collaboration core is deliberately DOM-free: IndexedDB
and the WebSocket arrive through the option seams above.

| Area | How it is exercised | Confidence |
| --- | --- | --- |
| `Y.Doc`/`Y.Text` lifecycle, undo origins, CRDT convergence | Real `yjs` | Direct |
| Sync handshake, framing, reconnect, duplicate/out-of-order delivery | Real client against an in-process TCP server that speaks the **shared codec** (`tests/support/test-server.ts`) | Direct for A1's half of the wire |
| IndexedDB persistence | The **real** `y-indexeddb` provider against an in-memory IndexedDB double (`tests/support/fake-indexeddb.ts`) | Wiring only — see below |
| Awareness lifecycle and validation | Real `y-protocols` `Awareness` | Direct |
| Presence survives a reconnect / leaves no ghost | Real client + real `y-protocols` clocks over the in-process transport | Direct for the clock semantics |

**What the IndexedDB tests do not prove.** The double implements the slice of the
IndexedDB surface that `lib0/indexeddb` calls (open/upgrade, transactions,
auto-increment keys, key ranges, cursors). It commits synchronously, has no quota, no
structured clone and no crash durability. So the tests prove the *wiring* — a
document-scoped replica is created, updates land in the `updates` store, a second
`Y.Doc` replays them, and `destroy()` detaches the provider — but they are **not**
evidence about browser IndexedDB. Claiming otherwise from a Node test would violate
`AGENTS.md` R5.

### Browser IndexedDB runbook (not yet executed)

The browser path must be confirmed by hand, by whoever has a browser and the dev stack:

1. `pnpm dev`, then open `http://127.0.0.1:5173`.
2. Create/edit a document until the text is non-empty, and wait ~1s for
   `y-indexeddb`'s debounce (`_storeTimeout = 1000`) plus the write.
3. **Reload with the backend stopped.** The text must come back with no server
   involved. This is acceptance criterion 1 and the whole point of Path 1
   (`docs/ARCHITECTURE.md` §2).
4. Open DevTools → Application → IndexedDB → `insighthub-doc:<documentId>` and check
   that the `updates` store holds encoded Yjs updates, not a Markdown string. A stored
   parallel string would be a §0 violation.
5. Stop the backend, keep typing, restart it: the edits must reach a second browser
   session with no page reload.

Until that runbook is executed, the persistence claims in the completion report are
scoped to the double.

## Verifying this suite

The collaboration suite runs as part of the **single** root gate:

```bash
pnpm test          # vitest (packages/** + apps/web/**) then apps/server's node:test suite
```

To iterate on this suite alone, filter the root configuration:

```bash
pnpm test:web -- src/collab
```

There is exactly one Vitest configuration (`vitest.config.ts` at the repository root).
M1-A0.2 removed a second, directory-local config that extended the root one: `mergeConfig`
concatenates `include` arrays, so an unfiltered run under it would execute the root's files
as well, and two configuration files meant two possible answers to "what does the gate
run?". Everything runs in the `node` environment, so one configuration is sufficient.

> Dependency note (for A0, not fixed here): this directory's `package.json` has no `test`
> script, so `pnpm test:web` is provided by `apps/web` as a thin filter over the root
> Vitest. See `docs/TASKS.md` M1-A0.2 for the open decision on per-package test scripts.
