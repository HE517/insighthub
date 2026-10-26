# 02 · Multi-user Collaboration and Offline Recovery

**Evidence commit:** `874f107` · **Report:** 02/05 · **Date:** 2026-10-26 · **Nature:** docs-only

---

## 1. Resume Claim

> 基于 CodeMirror 6 + Yjs 实现 Markdown 实时协同编辑，以 Y.Doc / Y.Text 作为正文唯一数据源，通过 WebSocket 同步增量更新，并结合 IndexedDB 支持离线编辑、重开恢复及双用户并发状态收敛。

Every clause has a committed implementation and a real-browser scenario. The one word that must be
kept literal is **双用户** (two users): the evidence is exactly two independent browser contexts,
not a crowd.

---

## 2. What It Means

**产品能力.** Two people, in separate browsers with separate cookies and storage, edit the same
Markdown document at the same time; their edits merge without a conflict dialog. A user can lose the
network mid-sentence, keep typing, close the tab, reopen it still offline, and see their text; on
reconnect the local and server states converge. Undo reverts the local user's edit (including an
accepted AI edit), never a teammate's.

**架构设计.** One `Y.Doc` per open document, one `Y.Text` named `content` for the body, one
WebSocket carrying two planes (JSON control + binary Yjs sync/awareness), one IndexedDB replica per
document, and one `Y.UndoManager` whose tracked origins are local + AI. The editor binds to the
`Y.Text` rather than holding a copy.

**测试证据.** Real Chromium, real server, real SQLite, real IndexedDB. Two independent browser
contexts (own cookie jar, own storage partition, own IndexedDB) converge on one document; offline
typing survives a reload while still offline; duplicate frames are idempotent; local undo leaves
remote text intact. The evidence is committed scenario code with assertions, not a prose claim.

**性能数据.** This bullet makes no latency claim. The 770 ms reconnect figure belongs to report 03
(local production-build baseline), not to the correctness claim here; do not attach it to "离线恢复"
as if it were a guarantee.

---

## 3. How It Is Implemented

### A. CodeMirror 6 ↔ Yjs binding

The editor is a **view of `Y.Text`**, never a second copy (`collabTextBinding.ts:1-63`). The session
is created through the frozen `collab/public.ts` seam; the editor layer never imports
`collab/internal/**` (`public.ts:1-19`). `useCollaborativeDocument` creates a session per
`documentId` and destroys it on unmount or id change (`public.ts:80-118`).

The session owns the document: `new Y.Doc()`, then `doc.getText(DOCUMENT_TEXT_KEY)`
(`document-session.ts:474-475`; the key is `'content'`, `binary-frame.ts:108-109`).

The editor effect does two things in a fixed order (`CollaborativeMarkdownEditor.tsx:146-266`):

1. attach the `Y.Text` observer **before** the view exists (lines 180-192);
2. build the `EditorState` from `session.text.toString()` (line 208), then `new EditorView` (line 235).

One typed character travels this path:

```text
CodeMirror updateListener                 codeMirrorSurface.ts:87
  → onLocalChanges                        CollaborativeMarkdownEditor.tsx:162-168
  → deliverLocalChanges (readOnly guard)  editorEditability.ts:105-120
  → binding.handleLocalChanges            collabTextBinding.ts:199-202
  → writeLocalChanges (one transaction)   collabTextBinding.ts:176-189
  → session.transact → Y.Doc.transact     document-session.ts:268-271
  → Y.Text.insert / delete                collabTextBinding.ts:181-186
  → Y.Doc "update" event                  sync-provider.ts:446-452
  → encodeSyncUpdate → socket.send         sync-provider.ts:489-498
```

Why this design: delivery is **immediate** — no queue, no debounce inside the binding
(`collabTextBinding.ts:72-86`). A queued edit describes a document version a remote update may
already have moved; writing before the call returns keeps the editor and the CRDT in the same
version. A remote update takes the other direction: the observer sees a non-local origin, skips the
re-entrancy cases, and reconciles by comparing authoritative text with what the editor shows
(`collabTextBinding.ts:153-164,238-259`). It does not translate `Y.TextEvent.delta`; it computes one
minimal single-range change, so a one-character remote edit becomes a one-character editor change
(`collabTextBinding.ts:216-236`).

### B. One body source: `Y.Text` owns content, Redux owns presentation

`documentSlice` is explicit: the allowed fields are `activeDocumentId`, `metadata` (server metadata,
for rendering) and `pendingDocumentId`; a `content` / `markdown` / `text` field "must never be added"
(`documentSlice.ts:1-35`). Role is deliberately absent too. `realtimeSlice` keeps at most 20 control
messages for diagnostics (`MAX_LOG = 20`, `realtimeSlice.ts:11-36`) — those are JSON control frames,
not the body.

The mutation sources are narrow: local edits go through `binding.handleLocalChanges`; remote edits
arrive with `TRANSACTION_ORIGINS.remote` and are applied by `Y.applyUpdate` (`room.ts:446` on the
server; the client applies peer updates in `sync-provider.ts:428-444`); an accepted AI suggestion
goes through `applySuggestion` with `TRANSACTION_ORIGINS.ai` (`apply.ts:122-135`). No component
dispatches text.

This is not only a static rule. The benchmark walks the React fiber tree to the Redux store after
300 real inputs and serialises it: a 6.8 MB document yields **241 B** of state with keys
`connection` / `document` / `realtime`, no fixture marker and no `line-99999:`
(`instrument.mjs:94-141`, `PERF-BASELINE-100K-MULTIROUND.md:53-65`). The dynamic assertion is the
counterpart of the static rule in `AGENTS.md` R11.

Why: a large body in Redux would re-render every subscriber per keystroke and create a second truth
to reconcile with the CRDT. Keeping it out is both a correctness decision and the reason the 100k
document remains interactive.

### C. WebSocket: JSON control vs binary Yjs, incremental sync

The transport has two planes and never mixes them: TEXT frames are JSON control messages; BINARY
frames are Yjs sync or awareness, using the shared codec (`ws.ts:580-613`; `binary-frame.ts:29-39`,
frame type `0 = SYNC`, `1 = AWARENESS`). The client is equally strict: `sendControl` stringifies
JSON (`sync-provider.ts:478-482`), `sendBinary` sends a `Uint8Array` (`sync-provider.ts:467-471`),
and inbound messages dispatch on the actual type (`sync-provider.ts:385-411`).

**Client.** After `room-joined`, the client sends `SyncStep1` (its state vector) and its awareness
state (`sync-provider.ts:351-352`). The server answers with only the missing updates; subsequent
local edits are sent as `SyncUpdate` frames (`sync-provider.ts:446-452`). A reply produced while
processing a step is framed with `encodeSyncFrame` before sending (`sync-provider.ts:437-444`), so
the frame-type header is never forgotten.

**Server.** The transport decodes binary only through the registry (`ws.ts:587-609`). The room applies
the sync payload with `Y.applyUpdate(..., TRANSACTION_ORIGINS.remote)` and returns the raw update
(`room.ts:428-446`). The registry owns the three-phase mutation:
`apply → persist → broadcast` (`registry.ts:838-852`): apply inside the per-document queue, await
`store.append`, then broadcast (`room.ts:456-458`). A persist failure stops the room and never
broadcasts a state it cannot recover (`registry.ts:804-813,845-851`).

Control messages (`join-room`, `leave-room`) are JSON; a successful join produces `room-joined` only
after content readiness, and it carries the server-derived role (`ws.ts:402-441`;
`registry.ts:304`). One socket carries at most one room; a `join-room` for another document is an
atomic replace, not a second room (`AGENTS.md` R15, `AppShell.tsx:13-14`).

### D. IndexedDB: local first, network second

Session creation has a frozen order: attach persistence and wait for `whenSynced`, then create
awareness/undo, then mark `active`, then start the network (`document-session.ts:477-503,550-563`).
`attachDocumentPersistence` dynamically imports `y-indexeddb` and wraps its provider
(`persistence.ts:298,334-356`); the provider stores **encoded Yjs updates**, not a Markdown string
(`persistence.ts:3-21`). One database per document, keyed by `documentId`
(`persistence.ts:76-82`), so two documents can never share a replica.

Because a local edit is written into `Y.Text` before the call returns, it is visible to the
persistence provider immediately — that is why offline typing survives closing and reopening the
page. On reconnect, the socket sends its state vector; Yjs transfers only what the server is
missing. The `Y.Doc`, the IndexedDB replica and the undo history are untouched across
`disconnect()`/socket loss (`document-session.ts:58-63,286-296`); only the network half restarts.
`destroy()` tears down network, awareness, undo and persistence in a fixed order
(`document-session.ts:306-327`), so a document switch cannot leave a second live session.

### E. Undo isolation

The undo manager is built on the `Y.Text` with `trackedOrigins: UNDO_TRACKED_ORIGINS`
(`document-session.ts:534-536`). The shared list contains exactly `local` and `ai`
(`binary-frame.ts:134-138`); `remote` and `persistence` are excluded. Remote updates are applied with
`TRANSACTION_ORIGINS.remote`, so a local undo never touches them.

`Mod-z` is **not** CodeMirror history: the keymap calls `session.undo()` through
`runSessionHistory` (`CollaborativeMarkdownEditor.tsx:216-225`; `editorEditability.ts:66-91`). This is
also why a read-only viewer cannot undo their own text: `session.undo()` is a `Y.Text` write that
CodeMirror's own `state.readOnly` check cannot see, so the wrapper blocks it explicitly
(`editorEditability.ts:69-80`).

One recorded subtlety: `Y.UndoManager`'s default 500 ms capture window can merge "type, then Accept
immediately" into one undo item (`D-081 §5` residual 8). It is a known behaviour, not a hidden one.

---

## 4. Source Code Locations

**Evidence commit:** `874f107`. Permalinks are pinned to that SHA.

| Location | Responsibility | Symbol | Permalink |
| --- | --- | --- | --- |
| `apps/web/src/collab/public.ts:48-52` | the frozen A1→A2 factory; the editor imports only this module | `createCollaborativeSession` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/public.ts#L48-L52 |
| `apps/web/src/collab/public.ts:63-121` | one session per document; destroy on unmount / id change | `useCollaborativeDocument` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/public.ts#L63-L121 |
| `apps/web/src/collab/internal/document-session.ts:474-475` | creates the single `Y.Doc` and `Y.Text('content')` | `new Y.Doc`, `doc.getText` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/internal/document-session.ts#L474-L475 |
| `apps/web/src/collab/internal/document-session.ts:534-536` | undo tracks local + AI origins only | `new Y.UndoManager` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/internal/document-session.ts#L534-L536 |
| `apps/web/src/features/editor/collabTextBinding.ts:176-202` | write a local editor update into `Y.Text` in one transaction | `writeLocalChanges`, `handleLocalChanges` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/collabTextBinding.ts#L176-L202 |
| `apps/web/src/features/editor/collabTextBinding.ts:238-259` | reconcile a remote change from authoritative text | `reconcileFromText` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/collabTextBinding.ts#L238-L259 |
| `apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx:180-235` | observer first, then `EditorState` from `Y.Text`, then `EditorView` | `createCollabTextBinding`, `new EditorView` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx#L180-L235 |
| `apps/web/src/collab/internal/sync-provider.ts:384-412` | inbound binary dispatch: awareness vs sync | `handleBinaryMessage` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/internal/sync-provider.ts#L384-L412 |
| `apps/web/src/collab/internal/sync-provider.ts:446-452` | outgoing local Yjs update → `SyncUpdate` frame | `handleDocumentUpdate` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/internal/sync-provider.ts#L446-L452 |
| `apps/web/src/collab/internal/persistence.ts:334-356` | `y-indexeddb` attach; `whenSynced` gates local readiness | `attachDocumentPersistence` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/internal/persistence.ts#L334-L356 |
| `packages/shared/src/binary-frame.ts:121-138` | origin vocabulary; undo-tracked origins | `TRANSACTION_ORIGINS`, `UNDO_TRACKED_ORIGINS` | https://github.com/HE517/insighthub/blob/874f107/packages/shared/src/binary-frame.ts#L121-L138 |
| `apps/server/src/rooms/room.ts:428-446` | server applies a sync payload as a remote transaction | `applySyncPayload` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/rooms/room.ts#L428-L446 |
| `apps/server/src/rooms/registry.ts:814-852` | `apply → persist → broadcast`, serialized per document | `#submitMutation` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/rooms/registry.ts#L814-L852 |
| `apps/server/src/ws.ts:580-613` | the two-plane transport; binary goes to the registry | `ws.on('message')` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/ws.ts#L580-L613 |
| `apps/web/src/store/documentSlice.ts:1-35` | the no-body rule and the allowed presentation fields | `DocumentState` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/store/documentSlice.ts#L1-L35 |
| `apps/web/src/features/editor/editorEditability.ts:59-61` | read-only is enforced in both CodeMirror facets | `editorEditability` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/editorEditability.ts#L59-L61 |

---

## 5. How It Was Tested (F)

All scenarios below are committed, run serially in real Chromium over CDP, and fail the process on
any assertion; there is no retry and no skip (`tests/browser/README.md:66-71`).

| Scenario | File:line | Topology / fault injection | Key assertions | What it proves |
| --- | --- | --- | --- | --- |
| `collab/independent-contexts` | `tests/browser/suite/08-evidence-gate.mjs:251-538` | two `Target.createBrowserContext` contexts, two identities (`demo-ada` editor, `demo-grace` owner), one real `WireOracle` as server witness; real insert / tail insert / 20× Backspace / select+type replace, started together with `Promise.all` | edit windows overlap (111 ms / 249 ms); A text = B text = witness text = 56 chars, exactly the expected string; `sha256(Y.encodeStateVector)` equal for all three (`bda0ea9c…`, 19 B, 3 clients); editors not remounted; contexts disposed | two independent users converge, including delete and replace, not just "two tabs" |
| `indexeddb/B-offline-edits-survive-reopen` | `tests/browser/suite/01-persistence.mjs:131-187` | real socket cut (`setOffline`), type, then **reload while still offline** with the offline flag re-armed before scripts run | both online and offline markers are in the editor after reopen; stored `updates` records counted before reopen | offline typing persists in IndexedDB and survives a close/reopen without the server |
| `indexeddb/C-offline-then-reconnect-converges` | `tests/browser/suite/01-persistence.mjs:192-280` | offline edit, then restore network without reload | editor converges to include both sides; no reload | reconnect transfers what was missing; offline edits are not replaced |
| `indexeddb/A-reload-without-backend` | `tests/browser/suite/01-persistence.mjs:40-130` | server stopped, page reloaded | editor text is restored from the local replica; connection status is not falsely "connected" | local-first open path; the UI does not lie about the network |
| `chaos/offline-reconnect` | `tests/browser/suite/04-chaos.mjs:36-107` | existing socket dropped, new connections rewritten to an unreachable port; a peer appends while the client is away | status goes to reconnecting/offline/error; after restore the client reconnects on its own, converges, and `editorMounts` is unchanged | automatic reconnect without a reload or editor remount |
| `chaos/duplicate-inbound-frames` | `tests/browser/suite/04-chaos.mjs:108-161` | the same inbound Yjs update injected three times | the text contains the change exactly once; no duplicated characters | Yjs update idempotency on the real client path |
| `chaos/out-of-order-delivery` | `tests/browser/suite/04-chaos.mjs:162-214` | inbound binary frames held and released out of order | final text equals the expected text; no divergence | ordering is recovered by CRDT sync, not by socket order |
| `realtime/local-undo-does-not-revert-remote-text` | `tests/browser/suite/03-realtime.mjs:329-368` | local typing, a remote peer appends, then `Mod-z` | after undo the text still contains `REMOTE-TAIL` and `REMOTE-BASE` | remote edits are outside the local undo stack |
| `realtime/two-tabs-converge` | `tests/browser/suite/03-realtime.mjs:64-108` | **same profile**, two tabs | tabs converge | **not** multi-user evidence; explicitly excluded by `D-086 §4` |

Node-level tests also exercise the binding and session in isolation, e.g.
`apps/web/src/collab/tests/convergence.test.ts`, `undo-redo.test.ts`, `persistence.test.ts`; they
complement — not replace — the real-browser evidence.

**What this proves, and what it does not.** It proves the two-context path, offline reopen,
idempotency, ordering recovery and undo isolation. It does **not** prove three or more concurrent
editors, a 30-second outage, cross-browser behaviour, or a reconnect SLO.

---

## 6. Measured Evidence

From the committed evidence run (`A6-evidence-gate-round2.md:46-65,95-97,171-172`):

| Metric | Value | How measured |
| --- | --- | --- |
| full suite | **73/73 PASS, exit 0** | `node tests/browser/run.mjs`; ports released; 11 temp data dirs removed; no live handles |
| independent contexts | 2 distinct context ids; localStorage probe A→B is `null`; each context has one `insighthub_session` cookie, both `HttpOnly`, different tokens | `Target.createBrowserContext`, `Network.getCookies`, a storage probe |
| concurrent edit windows | round 1: 117 ms (A) / 125 ms (B), overlap 111 ms; round 2: 388 ms / 252 ms, overlap 249 ms | page-side monotonic timestamps around the real key events |
| convergence | **56 characters**; A = B = server witness, exactly the expected string | text equality assertions |
| state-vector digest | `bda0ea9ca9b212d932a55fcce6c83881cb3f95406879da7e2333c81fe803fdef`; 19 bytes; 3 clients; text length 56 | `sha256(Y.encodeStateVector(doc))` computed on A, B and the server witness |
| offline reopen | both online/offline markers present; stored update count recorded before reopen | `indexeddb/B` assertions |

The digest is a deterministic function of one CRDT state, but **not a cross-run constant**: each
`Y.Doc` gets a random `clientID`, so the next run has a different digest. The assertion is
`A = B = server`, not the literal hash (`A6-evidence-gate-round2.md:64-65`).

Environment: Windows 11 10.0.26200 x64, Chrome 155.0.8059.85 headless, Node v22.14.0, pnpm 10.34.7
(`A6-evidence-gate-round2.md:9`).

---

## 7. Failure / Edge Cases

**Duplicate delivery is expected, not exceptional.** `chaos/duplicate-inbound-frames` injects the
same Yjs update three times (`04-chaos.mjs:108-161`). The client does not count deliveries; Yjs
identifies the update by its CRDT metadata, so the second and third applications are no-ops. The
assertion is textual: the marker appears exactly once. This is why a flaky network does not corrupt
the document — the protocol is idempotent by construction.

**Offline reload is the harder offline case.** `indexeddb/B` closes and reopens the page while the
network is still cut; the offline flag is re-armed before application scripts run
(`01-persistence.mjs:161-164`). The editor is reconstructed from IndexedDB, not from a server
response, and both the pre-outage and offline markers are present. The scenario also counts the
stored `updates` records before reopening, so "it came from the replica" is measured rather than
assumed.

**Undo after a remote edit.** The local user types, a peer appends, then the local user presses
`Mod-z`. The undo removes only the local edit; `REMOTE-TAIL` and `REMOTE-BASE` survive
(`03-realtime.mjs:342-363`). Without origin tracking, the undo would either do nothing or revert the
peer's text — both are product-visible failures.

**Reconnect after a server restart is a separate case.** `m2/C` renews the browser session
out-of-band before it can write again; the client does not automatically re-bootstrap after a server
restart (`A7-claim-evidence-review.md:85,404`). That is a recorded residual, not a property of this
bullet's 1–2 s network-drop scenarios.

---

## 8. Limitations

- **`VERIFIED`** — two independent browser contexts / two identities converge after concurrent
  insert, delete and replace; A = B = server text and state-vector digest.
- **`VERIFIED`** — offline edit survives a real page reload while still offline; reconnect converges
  without a reload; duplicate and out-of-order frames do not corrupt the text; local undo does not
  revert remote text.
- **`NOT VERIFIED`（scope）** — **three or more concurrent users**. `m2/J` is three cold joins and
  hydration, not three concurrent editors (`A7-claim-evidence-review.md:83`). Keep the bullet's
  "双用户" literal.
- **`NOT VERIFIED`（window）** — measured outages are ~1–2 s (`chaos/offline-reconnect` sleeps 1 s;
  perf uses 250 ms). A 30 s outage was never measured (`PROJECT.md:60-61`,
  `A7-claim-evidence-review.md:112`).
- **`NOT VERIFIED`（restart）** — the one scenario that restarts the server renews the session
  out-of-band; the client does not rebuild its own session after a restart
  (`m2/C`, `A7-claim-evidence-review.md:85`).
- **`NOT VERIFIED`（environment）** — Chromium 155 headless on Windows 11 only; `--headed` was not
  re-run, and no Firefox/Safari run exists (`A6-evidence-gate-round2.md:210`).
- **Known behaviour** — `Y.UndoManager.captureTimeout` is 500 ms, so typing immediately before an
  Accept can produce one merged undo item (`D-081 §5` residual 8). It does not cross the remote/local
  boundary, but it is not "one undo per action" either.
- **`NOT IMPLEMENTED`（scope）** — no Markdown preview, no search, no comments, no production
  telemetry. None of these is needed for this bullet; none may be claimed alongside it.
- **Provenance limitation** — the 73/73 run is recorded at `1807ea1`; `tests/browser/artifacts/` is
  not committed, so the raw result file cannot be re-read from the repo. The test/product trees at
  `1807ea1` and `874f107` are identical (`git diff 1807ea1..874f107 -- tests/browser apps packages`
  is empty), and the command to reproduce is committed.
- **Remote mode** — the 5 `m3r/*` scenarios are env-gated; remote 78 was not run. The 73/73 number is
  the default suite (`tests/browser/README.md:83,407-409`).

---

## 9. Interview Explanation (60–90 seconds)

“协同这部分的核心是：正文只有一个源，就是 Y.Text。CodeMirror 只是它的视图。用户敲一个字符，CodeMirror 的 updateListener 立刻把变更交给 binding，binding 在一次 Yjs transaction 里写进 Y.Text；随后 Y.Doc 的 update 事件把增量编码成二进制帧，走 WebSocket 发到服务端。服务端不是收到就广播，而是按 apply → persist → broadcast：先应用、再写 SQLite、最后才广播，所以不会出现‘客户端看到了但服务端恢复不了’的状态。

离线时顺序反过来：打开文档先等 IndexedDB 的 whenSynced，本地副本就绪后编辑器立即可用，然后才连网。断网期间的输入已经进了 Y.Text，也就进了 IndexedDB，所以关页、离线重开都还在；重连时用 state vector 只补差量。

证据是两个完全独立的 browser context、两个身份，做并发 insert/delete/replace，最终 A、B、服务端三方文本逐字相等，state-vector 的 sha256 也相等。边界我也明确：只有两个用户，三个以上没验证；断网窗口是 1–2 秒，30 秒没测。”
