# A7 · Resume-Evidence Fact Audit

**Scope:** `docs/resume-evidence/**` only — factual accuracy, permalink validity, symbol locations,
fact boundaries and number provenance.
**Audited at:** branch `agent/a7-resume-audit` @ `d1d8aec` (base `d1d8aec`).
**Evidence commit (line-number basis):** `874f107` (`test(perf): Candidate A - block-structured 100k
fixture comparison`). All `git show` / line checks below read `874f107:<path>`, never the worktree,
because `d1d8aec` contains the later Markdown-preview merge.
**Nature:** docs-only. No product, test, `package.json`, shared contract or frozen document changed.
**Verdict:** **GO WITH FIXES** — every fix listed in §6 is applied in this round; after them the pack
has no invalid permalink, no unsupported number and no false capability claim. Three decisions
remain with A0 (§8).

---

## 1. Method

| Step | What was run | Output |
| --- | --- | --- |
| Permalink sweep | temporary Node script over all six files; regex `blob/874f107/<path>#L<a>-L<b>`; checks SHA, `874f107:<path>` existence, total lines ≥ b, `a ≤ b` | 75 links, 0 illegal (§2) |
| `path:line` sweep | 439 citations parsed; basename/`D-0xx`/`A6`/`A7` shorthands resolved; range checked against `git show 874f107:<path>` | 0 out-of-bounds (§2) |
| Symbol spot-check | 66 table rows originally carried backticked symbols; each symbol searched inside the cited range | 1 wrong identifier, 4 enclosing-symbol-out-of-excerpt, 1 doc-pointer label — all fixed (§3, §6) |
| Scenario-name sweep | all `runner.scenario('…')` ids extracted at `874f107` | 78 registered; every cited id matches exactly |
| Number provenance | each resume number traced to `docs/agent-governance/**` or `tests/perf/results/**` | 8/8 found (§4.3) |
| Fact-boundary grep | Playwright / production P95 / 3+ users / metadata stale / preview-search-telemetry-comment | all correctly bounded (§4) |
| Fixture identity | read `874f107:tests/perf/fixtures/100k-lines.md` as bytes | 6,788,895 B, sha256 `0d12688d…`, 100,000 newlines |

Temporary scripts lived outside the repo; nothing from the audit tooling is committed.

---

## 2. Statistics

### 2.1 Permalinks

| Form | Count | Legal | Illegal |
| --- | ---: | ---: | ---: |
| `#L<a>-L<b>` (the required form) | 72 | 72 | 0 |
| single line `#L<n>` (`sqlite-store.ts#L443`) | 1 | 1 | 0 |
| whole-file (no anchor: `profile.mjs`, `block-benchmark.mjs`) | 2 | 2 | 0 |
| **Total** | **75** | **75** | **0** |

- Every one of the 75 URLs uses SHA `874f107`; zero `blob/main` links.
- Every path exists at `874f107`; every `b` ≤ file line count; every `a ≤ b`.
- The two whole-file links are valid GitHub permalinks; the corresponding §4 rows also omit a line
  range, so they are internally consistent. They are **not** defects, but they are less precise than
  the rest.
- The single-line link resolves to `upsertByClerkUserId` at `sqlite-store.ts:443` (verified).

### 2.2 Inline `path:line` citations

| Metric | Count |
| --- | ---: |
| Total citations | 439 |
| Resolved and in bounds | 438 |
| Out of bounds (`b > total` / `a > b` / `a < 1`) | **0** |
| Regex artifact (`.test.ts` basename split; verified by hand) | 1 |

### 2.3 Scenario names

78 scenarios are registered at `874f107` (73 default + 5 env-gated `m3r/*`). Every scenario id cited
in the pack (`b125/1`, `editor/mounts-on-existing-ytext`, `p2/*`, `f1/1`, `f1/4`, `m3/5`–`m3/11`,
`m3r/1`, `m3r/2`, `stale/directory-list`, `collab/independent-contexts`, `indexeddb/A`–`D`,
`chaos/*`, `realtime/*`, `m2/C`, `m2/J`) exists verbatim. No scenario-name error was found.

---

## 3. Symbol table (16 checks)

Each row was read from `git show 874f107:<path>`. "PASS" means the named symbol (or its enclosing
declaration) is in the cited range and does what the report says; "FAIL" means it was not.

| # | Report location | Path:line | Expected symbol | Actual line(s) at `874f107` | Verdict |
| ---: | --- | --- | --- | --- | --- |
| 1 | 02 §4 | `apps/web/src/collab/internal/document-session.ts:460` | `createDocumentSession` | `export async function createDocumentSession(` | **PASS** |
| 2 | 02 §4 | `apps/web/src/collab/public.ts:48-52` | `createCollaborativeSession` | `export function createCollaborativeSession(` … `return createDocumentSession(options);` | **PASS** |
| 3 | 02 §4 | `apps/web/src/collab/internal/document-session.ts:99` | `CollaborativeSession` | `export class DocumentSession implements CollaborativeSession {` | **PASS** |
| 4 | 02/03 §4 | `apps/web/src/features/editor/collabTextBinding.ts:176-202` | `writeLocalChanges`, `handleLocalChanges` | `function writeLocalChanges(changes: readonly TextChange[]): void {` … `target.transact((target_) => {` | **PASS** |
| 5 | 02 §4; 05 §3.B | `document-session.ts:534-536` | `new Y.UndoManager`, `UNDO_TRACKED_ORIGINS` | `const undoManager = new Y.UndoManager(text, {` / `trackedOrigins: new Set<TransactionOrigin>(UNDO_TRACKED_ORIGINS),` | **PASS** |
| 6 | 02 §4 | `sync-provider.ts:384-412` | `handleBinaryMessage` (doc said `handleMessage` — **fixed**) | `private handleBinaryMessage(data: unknown): void {` … awareness vs sync dispatch … `this.readSyncPayload(decoded.frame.bytes);` | **PASS after fix** |
| 7 | 02 §4 | `persistence.ts:298`, `:334-356` | `y-indexeddb`, `attachDocumentPersistence` | `const module = (await import('y-indexeddb'))` / `export async function attachDocumentPersistence(` … `whenSynced` | **PASS** |
| 8 | 02 §4 | `apps/server/src/rooms/room.ts:428-446` | `applySyncPayload` | comment: “This is phase 1 of `apply → persist → broadcast`” … function named `applySyncPayload` in range | **PASS** |
| 9 | 02/04 §4 | `registry.ts:437-458` | `#resolveJoinRole` (join) | `#resolveJoinRole(context: SocketContext, documentId: string): DocumentRole \| null {` … `roleFor` / `canRead` | **PASS** |
| 10 | 04 §4 | `registry.ts:716-760` | `#authorizeFrame` (write/authz) | `#authorizeFrame` inside range; `canEdit` / `canRead` / `FORBIDDEN` before mutation | **PASS** |
| 11 | 02 §4 | `registry.ts:814-852` | `#submitMutation` (persist/broadcast) | `#submitMutation(` … `room.applySyncPayload` → `await store.append` → `room.broadcastUpdate` | **PASS after fix** |
| 12 | 04 §4 | `packages/shared/src/permission.ts:37-44` | `documentCapabilities` | `canRead` / `canComment` / `canEdit` / `canManageMembers` | **PASS** |
| 13 | 03 §4 | `apps/web/src/store/documentSlice.ts:28-35` | `DocumentState` | `activeDocumentId`, `metadata: DocumentMeta \| null`, `pendingDocumentId` | **PASS** |
| 14 | 04/05 §4 | `apps/web/src/features/ai/apply.ts:92-99` (+ `122-135`) | `applySuggestion`, one `ai` transaction | `export function applySuggestion(` … `if (suggestion.documentId !== port.documentId) return { ok: false, reason: 'malformed' };` … `port.transact(..., TRANSACTION_ORIGINS.ai)` | **PASS** |
| 15 | 05 §4 | `packages/shared/src/ai-anchor.ts:231-325` | `validateSuggestionAgainstDocument`, `expectedText` | `export function validateSuggestionAgainstDocument(` … revision → anchor → `expectedText` checks in range | **PASS** |
| 16 | 04 §4 | `apps/web/src/features/editor/AiDirectory.tsx:109-139` | `abortRef`, `requestRef`, `AbortController` | `const abortRef = useRef<AbortController \| null>(null);` / `const requestRef = useRef(0);` / `if (controller.signal.aborted \|\| requestId !== requestRef.current) return;` | **PASS** |

### 3.1 Vocabulary note on the probe list

The task probe named `permission.ts (canEdit/canView/canUndo)`. At `874f107`:

- `documentCapabilities` is exactly `canRead` / `canComment` / `canEdit` / `canManageMembers`
  (`packages/shared/src/permission.ts:37-44`); **`canView` does not exist anywhere** in `apps/**` or
  `packages/**`.
- `canUndo` exists only as **undo state**, not a permission: `session.getUndoState()` returns
  `{ canUndo, canRedo }` (`document-session.ts:283`, `packages/shared/src/collab-session.ts:53`).

The reports already use the real names and never claim `canView`/`canUndo` as capabilities, so this
is a **PASS**, not a defect. It is recorded here so a future reader does not “fix” the docs toward
the probe vocabulary.

### 3.2 Two rows that are doc pointers, not symbol locations

`BuildStack` (`build-stack.mjs:19`) and `main` (`live-smoke.ts:73`) sit outside their cited doc
windows. Both rows pointed at documentation, not code, so their ranges are legitimate; the rows were
tightened (§6) so they no longer imply the identifier is inside the window.

---

## 4. Fact-boundary check

### 4.1 Required boundaries

| Boundary | Required state | Observed | Verdict |
| --- | --- | --- | --- |
| B5 wording | still contains “Playwright”, with README §7 errata saying replace by CDP | README §1 B5 and 05 §1 quote it verbatim; 05 §1/§5.E.1 correct it; README §7 row B5 says replace with “真实 Chromium（CDP）” | **PASS** |
| B3 wording | never bare “production P95”; must say local production build | every `production P95` occurrence is a prohibition or `NOT VERIFIED` (03:330-332, README:81,136,172); B3 itself says “本地 production build” | **PASS** |
| B4 metadata stale | must be `NOT APPLICABLE`, not verified | 04 §1/§3/§8 say `NOT APPLICABLE`; README §3 #13 says `NOT APPLICABLE`; only the directory list is `PASS` | **PASS** |
| B2 user count | must not claim 3+ verified | every `3+`/“three or more” occurrence is a prohibition or `NOT VERIFIED` (README:83, 01:182, 02:213/274, 05:245) | **PASS** |
| Preview / search / telemetry / comments | must not appear as implemented | only as `NOT IMPLEMENTED` / must-not-claim; the only “preview” is the AI diff (`aria-label="Unified diff preview"`, `AiSuggestPanel.tsx:429`). README §7 additionally records that a Markdown preview was added **after** `874f107` | **PASS** |
| §8 vs README status | consistent | B1–B5 are all `SUPPORTED WITH LIMITATION` in README, and each report’s §8 carries exactly the matching limitation set (B3 `NOT VERIFIED` production; B4 `NOT APPLICABLE` metadata; B5 external-AI `NOT VERIFIED`) | **PASS** |
| Numbers have a source | 241 B / 680 / 770 / 371.3 / 89.6 % / 73 / 78 in `docs/agent-governance/**` or `tests/perf/results/**` | 8/8 found (§4.3) | **PASS** |

### 4.2 Point-in-time facts that changed after `874f107`

| Claim | State at `874f107` | State at `d1d8aec` | Handling |
| --- | --- | --- | --- |
| Markdown preview does not exist | true | false (D-087, `dc20ecb`/`0f4c6aa`) | README §7 post-evidence paragraph already says so |
| Aggregate `caution` says “Vite dev server” for the build aggregate | true | false (`d1d8aec` regenerated it) | 03 §6 + README §7 note added (§6) |
| `73/73` re-run after the preview merge | n/a | claimed, but no committed artifact | left to A0 (§8) |
| Line numbers in `CollaborativeMarkdownEditor.tsx` / `DocumentWorkspace.tsx` | valid | drifted (`dc20ecb` touched them) | README §7 line-drift note added; permalinks stay pinned to `874f107` |

### 4.3 Number provenance

| Number | Where it is used | Source found | Verdict |
| --- | --- | --- | --- |
| **241 B** Redux state | 03 §2/§3/§6, 02 §3.B, README B3 | `PERF-BASELINE-100K-PROD.md:56-59`; `perf-production-multiround.json` `bytes: 241` ×3; `perf-prod-run-1..3.json` | **PASS** |
| **680 ms** ready p95 | 03 §2/§6, README B3 | `PERF-BASELINE-100K-PROD.md:24`; `perf-production-multiround.json` `readyMs.p95: 680` | **PASS** |
| **770 ms** reconnect p95 | 03 §2/§6, README B3 | `PERF-BASELINE-100K-PROD.md:28`; aggregate `reconnectRestoreMs.p95: 770` (n=9) | **PASS** |
| **371.3 ms** input p95 | 03 §2/§6/§8 | `PERF-BASELINE-100K-PROD.md:25`; aggregate `inputMs.p95: 371.3`; `perf-prod-run-2.json:436` | **PASS** |
| **89.6 %** Markdown inline | 03 §3.E/§7, README §3 #2 | `PROFILE-100K.md:19` (5,368.3 / 5,987.7 ms) | **PASS** |
| **73** default suite | README §2/§3, 04 §6, 05 §6 | `A6-evidence-gate-round2.md:12,171-172`; `tests/browser/README.md:83,407-409`; re-counted 78 registrations | **PASS** |
| **78** registered | README §2/§3, 05 §6 | `A6-evidence-gate-round2.md:211-212`; `tests/browser/README.md:83` | **PASS** |
| fixture 6,788,895 B / `0d12688d…` | 03 §3.B/§6 | read from `874f107:tests/perf/fixtures/100k-lines.md`: 6,788,895 B, sha256 `0d12688d13d4e956b5b5ddfa4dcd085e97cda184a0112c80d6a09cd0a3a5c46c`, 100,000 newlines | **PASS** |

`git diff 1807ea1..874f107 -- tests/browser apps packages` and
`git diff 01d3963..874f107 -- tests/browser apps packages` both return empty, exactly as README §0
claims. The fixture/provenance story holds.

---

## 5. Findings

All findings are documentation-only. Severity is about how a reader would be misled, not about
product risk.

| ID | Location | Evidence | Impact | Fix | Sev |
| --- | --- | --- | --- | --- | --- |
| F1 | `03-large-document-performance.md:231` | Location cell says `instrument.mjs:144-168`, href says `#L144-L190`; the Long Task block ends at 168 and 169-190 is connection-status code | clicking shows 22 lines of unrelated code | href → `#L144-L168` | LOW |
| F2 | `02-collaboration-offline.md:179` | the method is `handleBinaryMessage` (`sync-provider.ts:384`); `handleMessage` is the socket dispatcher at `:290` | wrong symbol for the cited range | symbol → `handleBinaryMessage`, range `384-412` | LOW |
| F3 | `02-collaboration-offline.md:184` | `#submitMutation` is declared at `registry.ts:814`; the cited `838-852` is its phase body | named symbol not in the excerpt | range → `814-852` | LOW |
| F4 | `05-ai-editing-quality.md:165` | `suggest` is declared at `remoteProvider.ts:145`; cited `156-197` is its body | same | range → `145-197` | LOW |
| F5 | `05-ai-editing-quality.md:171` | `createSuggestHandler` is declared at `route.ts:206`; cited `263-343` is its body | same | range → `206-343` | LOW |
| F6 | `03-large-document-performance.md:235` | `BuildStack` is declared at `build-stack.mjs:19`; cited `1-12` is only the module doc | same | range → `1-19`, drop “(doc)” | LOW |
| F7 | `05-ai-editing-quality.md:173` | `main` is at `live-smoke.ts:73`, not in `9-22` (the exit-code doc) | symbol implies location | label → “exit-code doc (function body at :73)” | INFO |
| F8 | `03-large-document-performance.md:289-294` + README §7 | report says the aggregate `caution` is stale and “no code change made”; `d1d8aec` fixed `aggregate.mjs` and regenerated both aggregate JSONs | a reader on the current tree would find the claim false | added a post-evidence paragraph (03 §6) and a README §7 bullet; the `874f107` finding is preserved | LOW |
| F9 | `README.md:60` | B1 row lists `m3r/2` as “exercised” but the remote group was **not run** (README/05 §8 themselves say so) | overstates the evidence round | added “remote-gated (not part of the 73)” | LOW |
| F10 | `README.md` §4/§7 | preview merge changed `CollaborativeMarkdownEditor.tsx` and `DocumentWorkspace.tsx` (+89/+57 lines), so worktree `:line` refs drift | a reader following §4’s “repeat with the paths” on HEAD gets wrong lines | README §7 line-drift note; permalinks were already pinned | INFO |
| F11 | `README.md:179` | “The 73-scenario suite was re-run after that merge and stayed 73/73” has no committed artifact (`tests/browser/artifacts/` is generated) | unverifiable claim, not provably false | **not edited**; A0 decision (§8) | INFO |

### 5.1 Non-findings (checked and cleared)

- The two whole-file permalinks and the one single-line permalink are valid, not broken.
- `ws.on('message')` in `02 §4` is a descriptive expression; the code is `ws.on('message', …)` at
  `ws.ts:580`.
- The `m3r/*` scenarios are correctly marked registered-but-not-run; no “78/78 PASS” appears.
- `commenter` appears only as a server-side permission tier, never as a comment feature.
- `A7-claim-evidence-review.md:372` really does record the 69 ms vs 78 ms discrepancy that 04 §6
  cites.

---

## 6. Fixes applied

| File | Change |
| --- | --- |
| `docs/resume-evidence/02-collaboration-offline.md` | F2 (`handleBinaryMessage`, `384-412`); F3 (`#submitMutation`, `814-852`) |
| `docs/resume-evidence/03-large-document-performance.md` | F1 (`#L144-L168`); F6 (`BuildStack`, `1-19`); F8 post-evidence paragraph |
| `docs/resume-evidence/05-ai-editing-quality.md` | F4 (`suggest`, `145-197`); F5 (`createSuggestHandler`, `206-343`); F7 label |
| `docs/resume-evidence/README.md` | F9 (`m3r/2` remote-gated); F8 + F10 post-evidence bullets |

No section was rewritten, no limitation removed, no evidence invented. Re-running the sweep after
the edits gives: **75/75 permalinks legal, 0 illegal; 0 out-of-bounds citations; 0 Location↔href
mismatches; all scenario names still exact.** The only “absent symbol” left is the descriptive
`ws.on('message')` (§5.1).

---

## 7. Limitations that must stay

These are load-bearing. Do not delete them while tightening the wording:

1. **Two users, not a crowd** — exactly two independent browser contexts/identities; 3+ concurrent
   editors `NOT VERIFIED`; `m2/J` is three cold joins, not concurrent editing.
2. **Offline windows are 1–2 s** — no 30 s outage was measured; “no keystroke lost” is supported by
   `indexeddb/B`, not by a 30 s test.
3. **Local production build ≠ production** — `680/770 ms` are built-server + built-web on one
   laptop; no TLS/Clerk/Render; `production performance = NOT VERIFIED`; never “production P95”.
4. **73/73 is the default suite** — 78 is the registration count (73 + 5 env-gated `m3r/*`); the
   remote group was not run; never “78/78 PASS”.
5. **External AI live is `NOT VERIFIED`** — 0 successful calls; OpenAI 429 balance, Kimi 400 then
   prompt-only and not retried; the default provider is a deterministic five-instruction table.
6. **Document metadata stale = `NOT APPLICABLE`** — the client sends no metadata HTTP request on
   open/switch; the tested stale path is `GET /api/documents`; the `requestId` guard itself is
   `NOT VERIFIED`.
7. **No search / comment / production telemetry** — `commenter` is a permission tier only. Preview
   did not exist at `874f107`; it was added after, and none of the bullets claim it.
8. **No optimisation / no before-after** — there is no trustworthy pre-optimisation baseline; the
   dev-vs-build difference is a serving-path effect.
9. **Chromium 155 headless only** — no Firefox/Safari, `--headed` not re-run.
10. **AI result across a document switch is `NOT VERIFIED`** — only panel unmount + abort +
    `documentId` check; no scenario delays an AI response across a switch.
11. **Role changes are not pushed** — the UI may lag until the next join (3 s measured); the server
    enforces per frame.
12. **The 100k fixture is one pathological paragraph** — the block-structured variant shows the cost
    is largely structural; do not generalise 371 ms to “any 100k Markdown”.
13. **Raw artifacts are not committed** — 73/73 is recorded at `1807ea1`, not re-run at `874f107`;
    `tests/browser/artifacts/` is generated.
14. **Production readiness is `NOT VERIFIED`** — M3 CLOSED ≠ production ready; M4 B8/B11/B14 are
    blocked by payment.

---

## 8. Needs A0 decision

1. **README §7 “re-run after the merge stayed 73/73” (F11).** There is no committed artifact for a
   post-`dc20ecb` run. Options: (a) cite the run/commit that produced it, (b) soften to “the
   registered scenario count is unchanged (78 = 73 + 5)”, (c) leave as-is because the product/test
   tree did not change. A7 recommends (b) unless A0 has the run record.
2. **Where the B5 “Playwright” verbatim quote may live.** The pack deliberately quotes the resume
   sentence unchanged and corrects it in §7. That is correct for an audit trail, but the sentence
   itself must not be submitted. A0 should confirm the submission text is the corrected “真实
   Chromium（CDP）” version, not the quoted one.
3. **Re-pin or not.** The pack is pinned to `874f107`. Re-pinning to `d1d8aec` would move every
   editor permalink and require re-deriving the preview statements; A7 recommends keeping
   `874f107` and the explicit post-evidence notes.

---

## 9. Reproduction

```powershell
# evidence commit and provenance
git rev-parse 874f107
git diff 1807ea1..874f107 -- tests/browser apps packages   # empty
git diff 01d3963..874f107 -- tests/browser apps packages   # empty

# any symbol row
git show 874f107:apps/web/src/collab/internal/document-session.ts | Select-Object -Skip 533 -First 3

# fixture identity
git cat-file -s 874f107:tests/perf/fixtures/100k-lines.md    # 6788895
```

## Next Handoff

Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0 (Supervisor)

Base:
agent/a7-resume-audit @ d1d8aec

Why:
The docs are factually clean after §6; the only open items are the three decisions in §8 (post-merge
73/73 citation, final B5 submission text, and whether to re-pin).

Dependencies satisfied:
All permalinks valid at `874f107`; all numbers sourced; all scenario names match; fixes applied under
`docs/` only.

Copy-paste Prompt:
Decide §8 of `docs/agent-governance/A7-resume-evidence-audit.md`: (1) cite or soften the “73/73
re-run after the preview merge” sentence in `docs/resume-evidence/README.md` §7, and (2) confirm the
submitted B5 text is the corrected CDP version. Do not re-pin the pack unless you also re-derive the
editor line numbers.
