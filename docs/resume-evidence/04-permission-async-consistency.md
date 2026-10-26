# 04 · Permission Model and Async-Result Consistency

**Evidence commit:** `874f107` · **Report:** 04/05 · **Date:** 2026-10-26 · **Nature:** docs-only

---

## 1. Resume Claim

> 处理文档切换、权限变化及异步结果回写的一致性问题，通过状态归属校验避免过期结果覆盖当前页面，并按 Owner / Editor / Viewer 驱动前端编辑能力。

Two halves, with different evidence strength:

- **permissions** — strongly supported by `p2/*` + `f1/*` browser scenarios and Node matrix tests;
- **async stale-response ownership** — the tested path is the **directory list** request, not
  "document metadata"; the `requestId` guard exists but its race was never stress-tested. The
  sentence needs that qualification before it goes on a resume.

---

## 2. What It Means

**产品能力.** An owner, editor or viewer sees the same document but different allowed actions: an
owner/editor can edit and undo; a viewer is read-only, sees an honest notice, and cannot accept an AI
suggestion. The block happens on the server, not only in the UI. Switching documents must not leave
document A's content or a pending list response on document B's screen.

**架构设计.** Identity → internal user → membership → `DocumentRole` → `documentCapabilities` →
HTTP/WS enforcement. The UI derives its editable/read-only state from the session's role, but the
server re-derives the role for every read and every binary frame. Stale HTTP work is cancelled by
`AbortController`, and a monotonic `requestId` is the secondary guard.

**测试证据.** A role matrix across owner/editor/viewer covering the shared judge, `authz.can`, HTTP,
WS join, WS frame, `room-joined.role` and the browser's own editable state (`p2/4`). A viewer cannot
write even when the UI is bypassed, and a forged role does not make the server accept a write
(`p2/1`, `f1/4`). A real delayed 200 is aborted on document switch and the UI stays on B
(`stale/directory-list`).

**性能数据.** No latency metric belongs to this bullet. The one measured time is the **abort
latency** (69 ms in the main run; 69–78 ms across two recorded runs), which is a correctness signal,
not a performance claim.

---

## 3. How It Is Implemented

### A. Permission: one decision, several layers

```text
Clerk session cookie ──► @clerk/backend authenticateRequest ──► VerifiedIdentity
                               │
                               └─► AppUserStore.upsertByClerkUserId ──► internal userId
demo mode (dev/test) ──► POST /api/session/bootstrap ──► httpOnly session ──► internal userId

internal userId ──► membership row (document_id, user_id, role) ──► DocumentRole
DocumentRole ──► documentCapabilities { canRead, canComment, canEdit, canManageMembers }
       │
       ├─ HTTP:  GET /api/documents/:id  → authorizeDocument → 200 / 401 / 404 / 403
       ├─ WS:    join-room              → roleFor + canRead  → room-joined.role
       │         every binary frame     → canRead (SyncStep1/awareness) or canEdit (SyncStep2/Update)
       └─ UI:    capabilityGate(role)   → editable/read-only + visible notice
```

The mapping chain is the one frozen in `D-082 §1`: Clerk identity → InsightHub internal user →
document membership → `DocumentRole` → capabilities → the existing HTTP/WS authorization
(`DECISIONS.md:3417-3422`). The Clerk verifier returns `null` for a missing/malformed/expired
session, an unauthenticated state, or any SDK throw, and never logs a token
(`clerk-session-verifier.ts:139-160,188-198`). The internal user id is the id used everywhere after
that; a Clerk `sub` is never used as a membership key (`identity.ts:43-50,108-160`;
`sqlite-store.ts:443`).

Membership is a real row: `SELECT role ... WHERE document_id = ? AND user_id = ?`
(`membership-store.ts:96-104`) and `roleFor` returns `null` when there is no row
(`membership-store.ts:149-156`). `documentCapabilities` is the only rule table
(`permission.ts:37-44`); `authz.can` resolves the role and calls that predicate
(`authz.ts:215-224`), and `authorizeDocument` collapses "no membership", "membership without
canRead" into the single `not_found` answer to avoid disclosure (`authz.ts:31,228-249`).

**HTTP guard.** `createDocumentAccessHandler` resolves identity, binds the requested document id
for logging, calls `authz.authorizeDocument(documentId, user.userId, capability)`, and maps the
decision to the frozen 401/404/403/200 bodies (`app.ts:661-679,704-724`). It is the production
handler; the capability matrix mounts the same factory for capabilities no production route needs
yet (`capability-matrix.test.ts:15-22`).

**WS guard.** On join, the room asks `roleFor` and then `canRead`; no role means no room
(`registry.ts:455-458`). Every binary frame is checked **per frame, never cached**: `SyncStep1` and
awareness need `canRead`; `SyncStep2`/`Update` need `canEdit`; a refusal is `FORBIDDEN`, non-fatal,
and happens before apply/persist/broadcast (`registry.ts:700-760`). This per-frame check is why a
demotion on a live socket starts refusing writes immediately, even before the UI learns about it.

**UI.** `capabilityGate` maps the role to four booleans and `readOnly = !canEdit`; an **unknown**
role (`null`) maps to editable, deliberately, so a missing role can never lock a user out of their
own text (`capabilityGate.ts:23-80`). The editor enforces read-only in both CodeMirror facets
(`EditorState.readOnly` and `EditorView.editable`, `editorEditability.ts:49-61`) and re-reads the
role through `useSessionRole` → `session.getRole()` (`useCollaborativeSession.ts:74-124`);
`DocumentWorkspace.tsx:152-161` is the only place that builds the gate.

The UI gate is **advisory**. That is not a slogan: `f1/4` forges a schema-valid
`room-joined(role:'owner')`, the UI becomes editable, and the write is still `FORBIDDEN` because the
server re-derives the role from the membership row (`tests/browser/README.md:347`).

### B. Async ownership: what is actually protected

**Document selection and session ownership.** `AppShell` keys `DocumentWorkspace` by
`activeDocumentId` (`AppShell.tsx:67-69`); a different document is a new workspace, a new session,
a new editor. `useCollaborativeDocument` creates the session in an effect keyed on
`documentId`/`persistenceKey`/`wsUrl`/identity and destroys the previous session in cleanup
(`public.ts:80-118`). `destroy()` tears down network, awareness, undo and IndexedDB in a fixed order
(`document-session.ts:306-327`); one socket carries at most one room, and a second `join-room`
atomically replaces the first (`AGENTS.md` R15).

**Request identity.** The AI directory owns an `AbortController` and a monotonic `requestId`; a
resolution is accepted only if the signal is live **and** the id is still current
(`AiDirectory.tsx:109-139`). The AI proposal request has the same discipline: every Generate aborts
the previous controller, closing/unmounting aborts the in-flight request, and a late resolution is
ignored twice — the provider checks the signal and the panel re-checks `signal.aborted` before
touching state (`AiSuggestPanel.tsx:181-189,201-245,289-292`; `remoteProvider.ts:164-174`). On the
server, the AI route aborts the provider when the response closes (`route.ts:321-323`), and a late
answer for a hung-up client is discarded, not written (`route.ts:337-343`).

**Document identity at apply time.** `applySuggestion` refuses a proposal whose `documentId` differs
from the live session (`apply.ts:97-99`); the AI panel is additionally keyed by
`session.localClientId`, so a new replica remounts it and drops an old proposal
(`DocumentWorkspace.tsx:237-252`).

**What the stale test actually covers.** Opening or switching a document sends **no
document-metadata HTTP request**: the page's own `/api/**` log contains only
`POST /api/session/bootstrap`, and `GET /api/documents/:id` count is asserted to be `0`
(`A6-evidence-gate-round2.md:69-76`). Therefore "document metadata stale response" is
`NOT APPLICABLE`, not "tested and passed". The real cancellable path is `AiDirectory`'s
`GET /api/documents`; the scenario holds a real 200 at the CDP **response** stage, switches A→B,
and observes `AbortError` **69 ms** after the request started (before the internal 5 s timeout); a
forced `Fetch.fulfillRequest` is rejected by Chrome with `Invalid InterceptionId`
(`A6-evidence-gate-round2.md:79-89`). The UI, editor and directory remain on B; the stale marker never
enters the DOM (`tests/browser/README.md:420`).

**The `requestId` guard is not stress-tested.** The product aborts on every ownership change, and
Chrome refuses to deliver an aborted response, so the "old response actually arrives and is dropped
by the id check" case cannot be constructed without changing the product. What is proven is the
transport layer (request cancelled, browser refuses delivery) and the UI layer (B is not
overwritten); the guard itself is accepted as a residual (`A6-evidence-gate-round2.md:151,200-202`;
`DECISIONS.md:3735`).

**Search does not exist.** There is no search feature, so there is no search-race protection to
claim (`A7-claim-evidence-review.md:134`; `CAPABILITY-EVIDENCE-INVENTORY.md:55`).

---

## 4. Source Code Locations

**Evidence commit:** `874f107`. Permalinks pinned to that SHA.

| Location | Responsibility | Symbol | Permalink |
| --- | --- | --- | --- |
| `packages/shared/src/permission.ts:10-44` | the four roles and the single capability table | `DOCUMENT_ROLES`, `documentCapabilities` | https://github.com/HE517/insighthub/blob/874f107/packages/shared/src/permission.ts#L10-L44 |
| `apps/server/src/authz/clerk-session-verifier.ts:139-160` | Clerk cookie → verified identity; `null` on any failure | `verify` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/authz/clerk-session-verifier.ts#L139-L160 |
| `apps/server/src/authz/identity.ts:108-160` | verified identity → internal `userId`; mode-independent result | `resolveAuthenticatedUser` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/authz/identity.ts#L108-L160 |
| `apps/server/src/persistence/sqlite-store.ts:443` | durable Clerk-user → internal-user mapping | `upsertByClerkUserId` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/persistence/sqlite-store.ts#L443 |
| `apps/server/src/authz/membership-store.ts:96-104` | membership row by document + user; insert | SQL statements | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/authz/membership-store.ts#L96-L104 |
| `apps/server/src/authz/membership-store.ts:149-156` | role lookup; unreadable row fails closed | `roleFor` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/authz/membership-store.ts#L149-L156 |
| `apps/server/src/authz/authz.ts:215-249` | role → capability → read decision; non-disclosure | `can`, `authorizeDocument` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/authz/authz.ts#L215-L249 |
| `apps/server/src/app.ts:661-679` | the production HTTP access handler | `createDocumentAccessHandler` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/app.ts#L661-L679 |
| `apps/server/src/app.ts:704-724` | maps a decision to 401/404/403/200 | `respondToDocumentAccess` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/app.ts#L704-L724 |
| `apps/server/src/rooms/registry.ts:437-458` | join: role + canRead, or no room | `#resolveJoinRole` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/rooms/registry.ts#L437-L458 |
| `apps/server/src/rooms/registry.ts:716-760` | per-frame WS authorization; refusals before mutation | `#authorizeFrame` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/rooms/registry.ts#L716-L760 |
| `apps/web/src/features/permissions/capabilityGate.ts:53-80` | role → UI flags; unknown role is editable | `capabilityGate` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/permissions/capabilityGate.ts#L53-L80 |
| `apps/web/src/features/editor/editorEditability.ts:59-61` | read-only in both CodeMirror facets | `editorEditability` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/editorEditability.ts#L59-L61 |
| `apps/web/src/features/editor/useCollaborativeSession.ts:99-124` | the only role read path; no Redux mirror | `useSessionRole` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/useCollaborativeSession.ts#L99-L124 |
| `apps/web/src/features/editor/AiDirectory.tsx:109-139` | abort + monotonic request id; stale result cannot set state | `abortRef`, `requestRef`, `load` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/AiDirectory.tsx#L109-L139 |
| `apps/web/src/features/editor/AiSuggestPanel.tsx:181-245` | per-request abort; late AI result cannot resurrect a proposal | `abortRef`, `generate` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/AiSuggestPanel.tsx#L181-L245 |
| `apps/web/src/features/ai/apply.ts:92-99` | proposal must belong to the live document | `applySuggestion` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/ai/apply.ts#L92-L99 |
| `apps/web/src/AppShell.tsx:67-69` | document switch = workspace remount (one room per socket) | `key={activeDocumentId}` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/AppShell.tsx#L67-L69 |

---

## 5. How It Was Tested

| Scenario | File:line | Setup / fault injection | Assertions | What it proves |
| --- | --- | --- | --- | --- |
| `p2/1-viewer-cannot-write` | `tests/browser/suite/20-m2-phase2-authz.mjs:149-306` | real viewer page; then a genuine SYNC update sent on the page's own socket | DOM + `EditorState.readOnly`; real keystroke emits no SYNC; bypassed SYNC gets `FORBIDDEN`; durable bytes unchanged; peer sees nothing; socket stays open; the owner's later edit still arrives | the server is the boundary; refusal has no side effect |
| `p2/2-identity-cannot-be-self-declared` | `20-m2-phase2-authz.mjs:307-506` | client claims `mode:'readwrite'` and injects a `userId` into the join payload; oracle also tries query/header/payload claims | `room-joined.role` stays viewer; UI stays read-only; a write on that socket is refused | identity is server-resolved, not client-declared |
| `p2/3-non-disclosure-404` | `20-m2-phase2-authz.mjs:507-640` | unknown id, outside membership, own document, no session | bodies and headers compared byte-for-byte; 404 for both "unknown" and "not a member"; 401 without a session | no existence leak |
| `p2/4-role-capability-consistency` | `20-m2-phase2-authz.mjs:641-853` | one table over owner/editor/viewer, plus a real browser per role | shared judge = `authz.can` = HTTP = WS join = WS frame = `room-joined.role` = browser editable state; viewer refused, owner/editor durable | one permission decision across every layer |
| `p2/5-role-change-is-re-evaluated` | `20-m2-phase2-authz.mjs:854-982` | demotion then promotion on live oracle sockets | demoted write refused without reconnect; promoted write accepted on the same socket | the per-frame check is live, not cached at join |
| `p2/5-session-revocation-is-everywhere` | `20-m2-phase2-authz.mjs:983-1138` | `DELETE /api/session`; HTTP and WS upgrade, via proxy and direct | 401 on both planes; the already-open socket measured | revocation is request-level |
| `p2/9-token-not-exposed-to-js` | `20-m2-phase2-authz.mjs:1139-1289` | inspect cookies, storages, API bodies, server log | session cookie is `HttpOnly`; token absent from JS-readable surfaces | token not exposed to the page |
| `f1/1-viewer-is-read-only-and-not-remounted` | `tests/browser/suite/21-m2-f1-role-ui.mjs:120-348` | editor→viewer demotion on a live page, reconnect to receive the new role | `contenteditable=false`, `EditorState.readOnly`, honest notice; real keystroke writes nothing; same `.cm-editor` element / same `EditorView` across the transition | UI gate is real and does not remount the editor |
| `f1/4-ui-gate-is-not-a-security-boundary` | `21-m2-f1-role-ui.mjs:620-795` | forged schema-valid `room-joined(role:'owner')` | UI becomes editable, then keystroke and explicit SYNC are both `FORBIDDEN`; nothing applied/persisted/broadcast; socket still receives | defeating the UI does not defeat the server |
| `m3/10-ai-viewer-cannot-accept` | `tests/browser/suite/31-m3-ai.mjs:983-1129` | viewer opens the AI panel, generates, then programmatically clicks Accept | proposal and diff render; Accept is `disabled` with a title; `.click()` changes neither store and emits no SYNC | AI writes are permission-gated too |
| `stale/directory-list` | `tests/browser/suite/08-evidence-gate.mjs:544-854` | real `GET /api/documents` 200 held at CDP response stage; switch A→B inside the window; then force delivery | `AbortError` 69 ms after request start; `Fetch.fulfillRequest` → `Invalid InterceptionId`; active document/editor/directory remain B; re-opened list = 28 rows, only B `aria-current`; stale marker absent | the tested stale path cannot overwrite the current page |

Node-level tests: `apps/server/src/authz/capability-matrix.test.ts:1-23` documents the
shared-judge / `authz.can` / HTTP three-way agreement; `apps/server/src/rooms/authz-enforcement.test.ts:11-15`
covers the WS join and frame gates, including `viewer` and `commenter` refusals.

**What this proves.** The permission matrix is one decision repeated at every layer, and the UI is
not the security boundary. The stale test proves transport-level cancellation and UI-level ownership
for the **directory list**. It does not prove the `requestId` guard's race, and it does not test a
document-metadata request (which does not exist).

---

## 6. Measured Evidence

| Measurement | Value | Source |
| --- | --- | --- |
| delayed real 200 held | `GET /api/documents`, status 200, body **4,640 B**, **28** document ids | `A6-evidence-gate-round2.md:81` |
| request → switch → abort timeline (page clock) | request 725; switch starts 764; switch completes 907; abort **794** → **69 ms** after request start | `A6-evidence-gate-round2.md:83-84` |
| abort latency across runs | **69–78 ms** (two recorded runs), far below the internal 5 s timeout | `A6-evidence-gate-round2.md:84`; `A7-claim-evidence-review.md:372` (records the 69 vs 78 discrepancy); `tests/browser/README.md:420` |
| forced delivery of the stale response | `Invalid InterceptionId` (`delivered:false`) | `A6-evidence-gate-round2.md:85` |
| post-switch state | active document = B, editor text = B's 13 chars, directory closed, no error UI, stale marker absent | `A6-evidence-gate-round2.md:86` |
| re-opened directory | 28 rows, server order, only B `aria-current` | `A6-evidence-gate-round2.md:88` |
| role-change UI lag | UI still shows `role: editor` and stays editable **3 s** after the membership changed to viewer (until the next `room-joined`) — explicitly not a defect | `21-m2-f1-role-ui.mjs:186-212` |
| suite status | **73/73 PASS, exit 0** (default suite) | `A6-evidence-gate-round2.md:12,171-172`; `FLAKE-LOG.md:9-11` |

The abort latency is a **cancellation** measurement, not a latency SLO for the product. The suite's
assertion is an inequality (abort well before the 5 s timeout), so the exact millisecond value is
recorded as evidence, not guaranteed.

Environment: Windows 11 10.0.26200 x64, Chrome 155.0.8059.85 headless, Node v22.14.0, pnpm 10.34.7
(`A6-evidence-gate-round2.md:9`).

---

## 7. Failure / Edge Cases

**The stale 200 that must not win.** The strongest real case is `stale/directory-list`. Chrome holds
a genuine 200 at the response stage; the user switches from A to B; React unmounts the directory
(panel closes) and its cleanup aborts the request. The page's own request log flips to
`AbortError` 69 ms after the request began — not after the 5 s timeout — and an attempt to release
the held response is rejected by the browser (`Invalid InterceptionId`). Even after that, the
assertions check the **UI**, not just the transport: `activeDocument` is B, the editor holds B's body,
the directory is gone, and the stale marker never enters the DOM. Re-opening the directory produces
28 rows in server order with only B marked current. This is why the claim is about **ownership**, not
only about cancelling a fetch.

**Role change: the UI is allowed to lag; the server is not.** `f1/1` demotes a member from editor to
viewer and then waits 3 s without a new join. The UI still shows `role: editor` and remains
editable — and the scenario asserts that this is the expected state, because the client learns its
role only from `room-joined` and there is no pushed role-change message
(`21-m2-f1-role-ui.mjs:186-212`). The security property is preserved by the server, which refuses
writes on the live socket (`p2/5`). The product boundary is therefore: **eventual UI update, immediate
server enforcement**. Do not say "role changes reflect instantly".

**AI result across a document switch is not directly tested.** There is no scenario that delays an AI
response, switches documents, and then releases it. The evidence is indirect: the panel unmounts on
switch, its request is aborted, and `applySuggestion` refuses a proposal whose `documentId` differs
(`A7-claim-evidence-review.md:92`). That is a `NOT VERIFIED` case, not a pass — the resume sentence
should not contain "(or an AI result for A)" unless this is reworded as "a pending proposal belongs
to its document and is dropped on switch".

---

## 8. Limitations

- **`VERIFIED`** — owner/editor/viewer capabilities agree across the shared judge, `authz.can`,
  HTTP, WS join, WS frame, `room-joined.role` and the browser's editable state; viewer writes are
  refused on the server with no durable/peer side effect; a forged role still fails.
- **`VERIFIED`（directory-list stale path）** — a real delayed 200 is cancelled on switch; the
  browser refuses delivery; the UI/session/directory stay on B.
- **`NOT APPLICABLE`** — "document metadata stale response": opening/switching sends no metadata
  HTTP request (`GET /api/documents/:id` count = 0). Do not write that claim into a resume. If you
  need a stale-response sentence, say "目录列表请求被取消，且 UI 不被旧响应覆盖".
- **`NOT VERIFIED`** — the monotonic `requestId` guard itself. It exists
  (`AiDirectory.tsx:110-139`), but the race where an old response actually arrives is not
  constructible without a product change; transport + UI are verified, the guard is a residual
  (`A6-evidence-gate-round2.md:151,200-202`; `DECISIONS.md:3735`).
- **`NOT VERIFIED`（role push）** — role changes are not pushed; the UI can lag until the next
  successful join (3 s measured). The server enforces per frame, but "UI 即时变化" is false.
- **`NOT VERIFIED`（AI across switch）** — no scenario delays an AI response across a document
  switch. Only panel unmount + abort + `documentId` check (`A7-claim-evidence-review.md:92`).
- **`NOT IMPLEMENTED`** — no search feature, so no search-race protection (`A7:134`); no comment
  feature — `commenter` is a server-side permission tier with no browser scenario (`PROJECT.md:39`,
  `A7:90`); no Markdown preview, no production telemetry.
- **Scope** — the concurrent-editing evidence is two users; the permission scenarios use demo users
  and test-fixture memberships, and production Clerk login is not live-verified
  (`PROJECT.md:52-53`). Chromium 155 headless only (`A6:210`).
- **Provenance** — the 73/73 run is recorded at `1807ea1`; raw artifacts are not committed. The
  test/product trees at `1807ea1` and `874f107` are identical
  (`git diff 1807ea1..874f107 -- tests/browser apps packages` empty). Remote 78 was not run.

---

## 9. Interview Explanation (60–90 seconds)

“权限这块我坚持一个原则：UI 只是显示，服务端才是边界。链路是 Clerk（或 dev 的 demo session）解析出内部 userId，再查 document membership 得到 role，然后用唯一的 documentCapabilities 表算出 canRead / canEdit 等能力。HTTP 用同一个 authorizeDocument，WebSocket 在 join 时查一次 canRead，之后每一帧都重新查：SyncStep1 只要读权限，SyncStep2/Update 要 canEdit。UI 只通过 session.getRole() 建 capabilityGate；viewer 的编辑器是 read-only，而且我测过即使伪造 role 让 UI 变成可编辑，写入仍然被服务端 FORBIDDEN。

异步这块我做了 abort + requestId：目录请求在切换文档时会被取消，真实 200 被 CDP 扣住、切换后 69 毫秒出现 AbortError，浏览器拒绝投递旧响应，UI 留在 B。这里有个边界必须说清：所谓 document metadata 请求实际上不存在，所以那半边是 NOT APPLICABLE；requestId 的第二道保护没有被压测，因为没有产品改动就构造不出旧响应真正到达的竞态。”
