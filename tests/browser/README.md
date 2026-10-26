# `tests/browser` — real-browser validation and chaos suite (owner: A6)

This directory is the A6 real-browser gate. It drives a **real Chromium** over the
DevTools Protocol, against a **real** backend process, a **real** Vite dev server, a
**real** browser IndexedDB and — since M2 — a **real** SQLite store on disk that
survives a real process crash. Nothing here is jsdom, and no scenario substitutes a
simulated call for a real one.

It covers two milestones:

| Area | Suite | What it proves |
| --- | --- | --- |
| M1 collaboration | `suite/00…07` | editor, IndexedDB, realtime, presence, offline/reconnect, chaos, performance, lifecycle, wire robustness |
| **A6 Evidence Gate round 2** (D-086) | `suite/08-evidence-gate.mjs` | **A:** two *independent browser contexts* (own cookies/storage/IndexedDB) editing one document concurrently — insert/delete/replace, A = B = server text **and** equal state-vector digests; **C:** a delayed HTTP response cannot override the document the user switched to, and the measured answer is that the client has **no** document-metadata request (the cancellable `GET /api/documents` list is the path that is tested) |
| M2 durable persistence | `suite/10-m2-durability.mjs` | the server's document survives room eviction, a hard process kill, compaction, and is never faked on a failed write |
| M2 Phase 2 authorization | `suite/20-m2-phase2-authz.mjs` | viewer/editor/owner enforcement, identity cannot be self-declared, non-disclosure, session revocation, token never reachable by JS |
| M2 Phase 2 **UI gate (F1)** | `suite/21-m2-f1-role-ui.mjs` | `room-joined.role → session.getRole() → capabilityGate → editor` in a real browser: read-only viewer + visible notice, no remount on a role change, `null` never locks the editor, and **the UI is not the security boundary** |
| M3 redesign (UI evidence) | `suite/30-m3-ui-evidence.mjs` | the new Undo/Redo buttons (owner/editor reversible through the **durable** store, viewer inert, unknown role follows `canUndo`/`canRedo` only), the DOM contract the suite depends on, and the regression test for the one-time identity-remount wait |
| M3 AI proposal loop | `suite/31-m3-ai.mjs` | proposal → Diff Preview → Accept/Reject in the real panel: nothing changes before Accept, Accept is one Yjs transaction a peer sees, Undo reverts only the AI edit, Reject writes nothing, `revision` vs `text-mismatch` staleness, a viewer can review but not accept, an owner’s offline Accept reconnects **once**, and a viewer’s offline Accept stays a local-only divergence |
| M4 B12.5 document creation | `suite/32b-m4-b125.mjs` | the shipped `New document` entry in a real browser: one click POSTs `/api/documents` (201), switches to the server-generated UUID, closes the panel, joins the new room as `owner` with an editable editor and marks exactly that row `aria-current`; an offline click shows the typed failure and changes nothing, and the same button succeeds after recovery; two clicks in one task still create **one** document |

## Why this suite does not use Playwright

The suite controls the browser over CDP; adding Playwright to it would be an unapproved dependency
for no capability. `playwright-core` **is** a root devDependency, but only for the opt-in deployed
smoke (`tests/deployed/b13.mjs`, with `@clerk/testing` for the Clerk testing token), and the product
never imports it. Everything this suite needs already exists:

| Need | Provided by |
| --- | --- |
| Browser control | Node 22's global `WebSocket` speaking CDP to a locally installed Chrome/Edge |
| Readiness probes | Node's global `fetch` |
| Yjs peer / codec | the workspace's own `yjs`, `y-protocols` and `@insighthub/shared` |
| Durable-store inspection | Node 22's built-in `node:sqlite` |

So the harness adds **zero** dependencies and changes **no** `package.json`.

## Run it

```bash
pnpm build                 # packages/shared must be compiled for the oracle client
node tests/browser/run.mjs
```

Useful switches:

```bash
node tests/browser/run.mjs --list                 # every scenario id
node tests/browser/run.mjs --filter m2/           # only the durability scenarios
node tests/browser/run.mjs --filter indexeddb     # substring match on id or title
node tests/browser/run.mjs --headed               # watch the browser
node tests/browser/run.mjs --keep-open            # leave the stack and browser up
```

Running two worktrees at once: the stack binds 3101/5173 by default, which means one
suite at a time. Override both ports instead of queueing:

```bash
INSIGHTHUB_E2E_SERVER_PORT=3401 INSIGHTHUB_E2E_WEB_PORT=5473 node tests/browser/run.mjs
```

The Vite listen port is forwarded as `INSIGHTHUB_WEB_PORT` (see
`apps/web/vite.config.ts`); the backend port is `PORT`. Use distinct pairs per worktree
and both suites release their own ports on exit.

Exit code is `0` only when every scenario passes. A failing scenario is never retried
and is never skipped. Results land in `artifacts/results.md` and
`artifacts/results.json`; screenshots go to `artifacts/`.

The suite runs **serially** and owns ports `5173`/`3101`: it refuses to start when
either is occupied, and its postflight prints whether both were released again.

### Remote AI mode (M3 Round 2)

The default run measures the **frozen default configuration**: `AI_PROVIDER` is not set, so
`POST /api/ai/suggest` answers `503`, and `VITE_AI_PROVIDER` is not set, so the client uses the
deterministic local provider. That is what the 78 default scenarios assert, so a globally remote
Vite would invalidate them.

The remote evidence is a separate group that exists only when asked for:

```bash
INSIGHTHUB_E2E_AI_MODE=remote node tests/browser/run.mjs    # 83 = 78 + 5
```

The suite always runs the **demo** web path: DevStack sets VITE_CLERK_PUBLISHABLE_KEY='' (process env wins over .env.local in Vite), so a real Clerk key in pps/web/.env.local cannot put the browser into the sign-in gate and break every scenario. Clerk-mode browser evidence belongs to the staging smoke.

`INSIGHTHUB_E2E_AI_MODE` gates **registration** of `suite/33-m3-remote.mjs`; the default run is
still exactly 78 scenarios and none of their assertions change. At the group boundary (the file
sorts last) the first `m3r/*` scenario stops Vite, restarts the backend on a fresh durable store
with `AI_PROVIDER=stub`, and starts Vite with `VITE_AI_PROVIDER=remote`; every scenario in the
group calls the same idempotent switch, so a filtered run (`--filter m3r/3`) works too.
`lib/stack.mjs` owns the mechanism (`serverEnv` / `webEnv` options plus `setServerEnv` /
`setWebEnv`; an `undefined` value deletes the key), and with no mode env the two children receive
exactly the same environment as before.

Why not start the whole run remote: the 78 scenarios measure the default configuration (intent
chips, local copy), and one Vite process has one `VITE_AI_PROVIDER`. Why not a second stack: two
servers on `127.0.0.1` share one browser cookie jar while sessions are process-scoped, and the
ports would double.

### The runner must be able to exit (and now proves it)

A suite that prints a summary and then never returns is not evidence of anything. The
postflight therefore reports **live handles after teardown** and the process exits with a
failure (code `2`) if any remain, instead of hanging:

```text
postflight:
  ports 5173, 3101: released
  temporary data directories removed: 1
  live handles after teardown: none (the process exits on its own)
```

The one real leak found this way was the browser child's `stdout`/`stderr` **pipes**: a
`stdio: 'pipe'` child keeps a readable handle in this process for as long as Chromium's
inherited copies exist, so `Browser.close()` ended the browser and Node still could not
exit. `lib/chrome.mjs` now hands the child a log **file descriptor** instead (no handle
here), and `Browser.close()` returns a record of whether the process exited cleanly or had
to be killed with its tree. `run.mjs` reports that record, so "no leftover browser" is
measured rather than assumed.

Note that `process.getActiveHandles()` alone is the wrong check: this process's own
`stdout`/`stderr` are always present and never keep it alive, so `run.mjs` asks
`hasRef()` and ignores `fd 1`/`fd 2`.

## Durable-storage isolation (M2)

Server persistence outlives the process, so a test that reused a data directory would
be measuring the previous scenario. The stack therefore:

- creates a **new temporary directory** for every scenario that needs a clean store and
  passes it to the server as `INSIGHTHUB_DATA_PATH` (`stack.restartServerOnFreshDataPath`);
- **reuses** the current directory for a restart scenario — that is what makes
  "restart and the content is still there" meaningful (`stack.restartServer`);
- removes every directory it created on exit (`stack.dispose`), and never touches the
  development default `.insighthub-data`.

`stack.crashServer()` kills the process tree **without** a graceful shutdown, so
`store.close()` never runs and the WAL is left exactly as the last committed
transaction wrote it. A "reload the page" or "reconnect the socket" is never accepted
as a substitute for that, and the scenarios record both pids.

## Why a "brand-new device" is a separate browser

A durability claim is about the **server**. A new tab in the writer's own browser
would be answered by that browser's IndexedDB replica, so the test would silently
prove client persistence instead. Every "the content survived" check therefore opens a
browser with an empty profile (`context.withFreshBrowser` / `context.launchBrowser`):
no replica, no storage, nothing to fall back on.

Set `INSIGHTHUB_BROWSER` to an executable path to choose the browser explicitly.

## Independent browser contexts (Evidence Gate A, `docs/DECISIONS.md` D-086)

A second **tab** is not a second **person**: tabs in one profile share the cookie jar, one
`localStorage` and one IndexedDB replica, so a "two tabs converge" test can be answered by
mechanisms that do not exist between two users. `collab/independent-contexts` therefore opens each
page inside its own context:

```js
const contextA = await ctx.newBrowserContext();   // Target.createBrowserContext
const contextB = await ctx.newBrowserContext();
const pageA = await ctx.newAppPage({ documentId, as: 'demo-ada', role: null, browserContextId: contextA });
const pageB = await ctx.newAppPage({ documentId, as: 'demo-grace', role: null, browserContextId: contextB });
```

`lib/cdp.mjs` owns the two primitives (`createBrowserContext` / `disposeBrowserContext`) and
`newPage(connection, { browserContextId })`; `run.mjs` tracks every context it created, disposes
the ones a scenario forgot after each scenario, and the scenario disposes its own two so "no
leaked storage partition" is measured rather than assumed. Every other scenario passes no
`browserContextId` and keeps the default context, so nothing else changed.

The isolation is **observed**, not just constructed — a scenario that merely called
`createBrowserContext` would still be asserting its own setup:

| Observation | How |
| --- | --- |
| two cookie jars | `Network.getCookies` per page: one `insighthub_session` each, `HttpOnly`, **different token values** (only the comparison is recorded, never a token) |
| two storage partitions | a `localStorage` key written in A is `null` in B |
| per-context replica | `readIndexedDb` per page lists the replica that page itself opened. The **name** is the same in both contexts, so it proves nothing on its own — the partition itself is what the `localStorage` row above measures |
| two identities | `__qa.demoIdentity` + `[data-testid="session-identity"]` + the `role: …` chip (`editor` for A, `owner` for B, both from fixture membership rows) |

### State-vector digests

Equal text is necessary but not sufficient: two replicas can show the same string while one still
holds structs the other has not integrated. The page instrumentation exposes

```js
window.__qa.docStateVector()
// → { ok, hash, stateVectorBytes, clients, documentId, textLength, source }
```

where `hash = sha256(Y.encodeStateVector(session.doc))` (hex). `Y.encodeStateVector` maps every
client to the highest clock the replica has integrated and yjs writes the entries **sorted**, so
the bytes — and therefore the digest — are order-independent and comparable across replicas. The
scenario requires A, B **and** the Node-side `WireOracle` (`WireOracle.stateVectorHash()`, the same
bytes hashed with `node:crypto`) to report the same digest. **Only the digest and lengths are
recorded; the document body never leaves the page.**

The digest is a deterministic function of the CRDT state, not a constant across runs: every
`Y.Doc` mints a random `clientID`, and the state vector encodes those ids, so the same document
edited by fresh clients yields a different digest next run. The assertion is therefore
`A = B = server`, never "the hash equals this literal".

How the page reaches its own `Y.Doc` without any product hook: `Y.Doc` is module-scoped, but the
editor host is a React-rendered node, and walking its attached fiber's `return` chain reaches
`CollaborativeMarkdownEditor`'s `memoizedProps.session` — the session the live editor is bound to.
The `yjs` module itself is re-imported by the **same URL** the application loaded (resource
timing), exactly like the `@codemirror/view` probe. `docStateVector()` is read-only: it starts no
transaction, mutates nothing, and returns a descriptive `{ ok: false, reason }` if either step
fails (so a React-internals change shows up as a red scenario, not a silent pass).

### What the scenario asserts, in order

1. the fixture seeds exactly two members of the same document — A `editor`, B `owner`;
2. a real `WireOracle` writes the baseline (front token + middle + tail token) and stays connected
   as the independent witness;
3. the two contexts hold different sessions and do not share storage;
4. round 1, started together: A inserts at the front, B inserts at the tail;
5. round 2, started together: A deletes a known token with twenty real **Delete** presses, B
   selects another known token with **one** `Ctrl+Shift+ArrowLeft` (CodeMirror's
   `selectGroupLeft`) and types a replacement character by character — real key events
   (`caretToStart` / `caretToEnd`, `moveCaret`, `Input.insertText`) throughout. Typing
   character-by-character is deliberate: each character is one Yjs transaction, so a
   participant's edit *stream* lasts tens of milliseconds and remote updates arrive **inside** it;
6. the two edit windows (page-relative transaction times made absolute against `qa.startedAt`,
   which both renderers share) must **overlap** in each round — "concurrent" is measured, not
   narrated;
7. conditional polling until A, B and the witness all hold the exact expected text, then until the
   two digests match; on timeout the failure lists all three lengths and the first divergence.

The regions are disjoint (A owns the front, B the tail), so the final text is a constant of the
edits and not of the interleaving: an operation never has to win a race for the assertion to be
exact. `realtime/two-tabs-converge` is unchanged and still proves the same-profile case; it must
not be read as the multi-person evidence.

## How it observes the application

Everything is injected with `Page.addScriptToEvaluateOnNewDocument`, i.e. it runs
**before** any application script. **No production file is instrumented and no
test-only hook was added to A1/A2/A3 code.**

| File | Role |
| --- | --- |
| `lib/chrome.mjs` | launches a throwaway-profile browser and reports its real version |
| `lib/cdp.mjs` | minimal CDP client, real input (`Input.insertText`, key events, mouse), the browser's cookie store (`Network.getCookie`/`setCookie`), and **independent browser contexts** (`Target.createBrowserContext` / `Target.disposeBrowserContext`) |
| `lib/stack.mjs` | starts/stops the real backend and Vite; `stopServer()` is a verified process death |
| `instrument/page-instrument.js` | transport recording, fault injection, mount/timer/IDB counting, control-frame capture |
| `lib/app.mjs` | drives the real UI and reads real state back |
| `lib/oracle.mjs` | an independent Yjs peer on the real server (the convergence witness) |
| `lib/authz-fixture.mjs` | session bootstrap + membership fixture for M2 Phase 2 (see below) |
| `lib/wire-socket.mjs` | a browser-shaped `ws` client, so a Node socket can carry a `Cookie` header and observe an upgrade refusal |
| `lib/durable-store.mjs` | reads/interferes with `insighthub.db` directly |
| `lib/harness.mjs` | scenario registry, assertions, reporting |

### Real `EditorView` state

`EditorView` is module-scoped, not a global, so the harness re-imports the **same**
module URL from `performance.getEntriesByType('resource')`. The page's module registry
is keyed by URL, so this returns the very class the application used. That yields:

- `EditorView.findFromDOM()` → the live view and its real `EditorState`;
- a prototype-level wrapper on `dispatch` → the actual `ChangeSet` each update had, so
  "a remote character was applied as a one-character edit" is read off the editor's own
  transaction instead of being inferred from the text.

Both `ChangeSpec[]` and `ChangeSet` shapes are handled: `applyDelta` passes a
`ChangeSpec[]`, and treating only `ChangeSet` as valid silently recorded nothing.

### Chaos controls (`window.__qa`)

| Control | What it does |
| --- | --- |
| `setOffline(true)` | drops the **collaboration** socket and rewrites new ones to an unreachable port, so the client's real reconnect/backoff path runs against a real connection refusal |
| `policy(documentId, {...})` | per-document `holdIncoming`, `duplicateIncoming`, `delayIncomingMs`, `dropIncoming`, `delayCloseMs` |
| `releaseHeld(documentId, {reverse})` | delivers buffered frames, and reports how many were delivered vs dropped because the handler was detached |
| `injectInbound(documentId, base64, times)` | replays captured bytes verbatim (duplicate-frame test) |
| `summary()` | sockets, live collaboration sockets, frames, mounts, live intervals, IndexedDB opens |
| `inboundControl(documentId)` / `outboundControl(documentId)` | the TEXT control frames the page received/sent, including `error.code` and `room-joined.role` — the browser's own view of the authorization answers |
| `sendControl(documentId, text)` | send a raw control frame on the page's newest socket (used to inject a `userId` into a `join-room` payload from the real connection) |
| `bootstrapCalls` / `demoIdentity` | every `POST /api/session/bootstrap` the page performed and the identity it claimed |
| `docStateVector()` | **read-only** digest of the live document's CRDT state: `sha256(Y.encodeStateVector(session.doc))`, plus the state-vector byte length, the client count and the document length. Never the text (see "State-vector digests") |
| `bootstrapDelayMs = N` | delay the bootstrap request by N ms — the identity-window chaos control (see "The one-time identity remount"); no application change |
| `identity` / `editor.mountLog` / `bootstrap` | when the identity decision rendered, whether each editor mount happened after it, and the bootstrap's outcome — the evidence the settle wait is built on |

Vite's HMR socket is deliberately **excluded** from the offline simulation: closing it
makes Vite reload the page, which resets the instrumentation and would silently make an
offline test meaningless.

## Defect pins: none outstanding

Earlier revisions of this suite pinned three product defects (`P0-1`, `P0-2`, `P0-3`) by
asserting the contract's required behaviour against the unmodified production path and
letting the scenario stay red. All three are now **fixed**, so the pins are gone: those
scenarios are ordinary green ones, every `knownDefect` tag was deleted (never the
assertion), and the `P0-1` test-only shim was removed so every scenario runs the real
path. No assertion was weakened to reach this state.

| Id | Was | Now |
| --- | --- | --- |
| `P0-1` | `collab/internal/persistence.ts` assigned `globalThis.indexedDB`, a getter-only accessor in a real browser → no document opened at all | Installs by descriptor, skips the write when the factory already *is* the global, and restores the original descriptor on teardown |
| `P0-2` | `features/editor/collabTextBinding.ts` flushed only at 64 queued changes → keystrokes never reached `Y.Text` | Every editor update is written in one transaction before the call returns |
| `P0-3` | `features/editor/remoteCursorExtension.ts` dispatched from a `ViewPlugin` constructor → the plugin crashed on mount | Rebuild scheduling moved to `remoteCursorPresence.ts`; the constructor dispatches nothing |

To pin a *future* defect: add a scenario that asserts the behaviour the contract
requires against the unmodified path, tag it `knownDefect: 'P0-n'`, and delete the tag
(never the assertion) once the owner fixes it.

## Scenario map

| Suite | Covers |
| --- | --- |
| `00-smoke.mjs` | the harness itself: real browser, real backend, real `EditorView`, real IndexedDB |
| `08-evidence-gate.mjs` | A6 Evidence Gate round 2 (D-086): two independent browser contexts converging on one document (with state-vector digests), and HTTP stale-response ownership on the only cancellable request the client makes |
| `01-persistence.mjs` | browser IndexedDB: reload without backend, offline edits, reopen, two tabs, replica inspection |
| `02-editor.mjs` | real `EditorView`: mount on existing `Y.Text`, minimal remote apply, undo, document switch |
| `03-realtime.mjs` | live remote edits, two-tab convergence, validated presence, remote caret/selection, presence lifecycle |
| `04-chaos.mjs` | offline/reconnect, duplicate frames, out-of-order delivery, document-switch race, awareness churn |
| `05-performance.mjs` | 5 000-line invariants and latency measurements |
| `06-lifecycle.mjs` | 20 open/switch/disconnect cycles; navigation teardown |
| `07-robustness.mjs` | frozen error codes for malformed/oversized/unsigned traffic, and browser survival |
| `10-m2-durability.mjs` | M2-P0-1: room emptied, real process restart, offline client + restart, compaction, persist failure, document isolation, concurrent cold joins, backlog-overflow constructibility |
| `20-m2-phase2-authz.mjs` | M2 Phase 2: viewer cannot write (P2-1), identity cannot be self-declared (P2-2), non-disclosure 404 (P2-3), role/capability consistency (P2-4), role change + session revocation (P2-5), token invisible to JS (P2-9), what a restart really does to a session |
| `21-m2-f1-role-ui.mjs` | M2 Phase 2 closure, F1: the UI role gate in a real browser — read-only viewer + honest visible notice, no remount across a role change, unknown role never locks the editor, and a client that forges its own role is still refused by the server |
| `30-m3-ui-evidence.mjs` | M3: the new Undo/Redo buttons (owner/editor reversible through the durable store, viewer inert, unknown role follows `canUndo`/`canRedo` only), the DOM contract the suite depends on, and the regression test for the one-time identity remount wait |
| `31-m3-ai.mjs` | M3: the AI proposal loop end to end — Diff Preview without a write, `ai`-origin Accept (editor + durable + a peer), Undo/Redo isolation, Reject, both stale reasons, the viewer read-only gate, and both offline-Accept branches (owner convergence, viewer local-only divergence) |
| `32-design-fidelity.mjs` | M4 UI fidelity (`ui/1..8`): logo hover transform, switcher focus ring, avatar hover/tooltip/Tab focus, undo button states (including the disabled viewer state), connection pill pulse, editor focus-within, reduced-motion (0 s transitions, pulse off), and notice copy that never claims a false "saved" |
| `32b-m4-b125.mjs` | M4 B12.5 `New document` (D-084 #2/#6/#7) in the **default** configuration: one click → real `POST /api/documents` (201) → switch to the server UUID → panel closed → `owner` room + editable editor → exactly one `aria-current` row; an offline click shows `new-document-error[data-create-error="network"]` with nothing changed and succeeds after recovery; two clicks in one task create one document. It sorts before `33` because that group changes the stack's configuration and must stay last |
| `34-markdown-preview.mjs` | Markdown Preview V1 (D-087): switching `编辑`/`预览` keeps exactly one live `EditorView` (same DOM node, mount counters, text and keyboard selection); a rich document renders semantic DOM; a remote edit made **while preview is visible** appears only after the 400 ms debounce; `<script>`/`<img onerror>`/`<iframe>`/`javascript:` never become nodes/attributes and safe links keep `rel="noopener noreferrer"`; a 20k-line document seeded through the production store shows identical `Y.Text`/state-vector/durable digests after previewing, and preview adds no Redux slice or body mirror. The 100k-line browser attempt is **not** claimed: it did not reach `data-state="ready"` within the 420 s scenario budget (2026-10-26). |
| 33-m3-remote.mjs | M3 Round 2, only with `INSIGHTHUB_E2E_AI_MODE=remote`: the **remote** chain in a real browser — no local chips, a real `POST /api/ai/suggest` (200 with the stub, 503 without a provider), client-minted anchors, a preview that writes nothing, the uppercase Accept through Yjs with Undo/Redo — plus the read-only AI directory online, offline (CDP network) and back |

### The M2 Phase 2 scenarios and the acceptance IDs they map to

| Scenario id | P2 | Where the assertion comes from |
| --- | --- | --- |
| `p2/1-viewer-cannot-write` | P2-1 | **re-aimed** (see below): the viewer page's editor is read-only in the DOM *and* in `EditorState`, a real keystroke changes nothing and emits no SYNC frame — then a genuine SYNC update on the page's own socket is answered `FORBIDDEN`, the durable bytes are unchanged, no peer sees it, the socket stays open, and the owner's later edit arrives on it |
| `p2/2-identity-cannot-be-self-declared` | P2-2 | `mode: 'readwrite'` claimed by the client itself; `userId` injected into the join payload from the page's socket, plus query/header/in-payload claims from an oracle; `room-joined.role` stays `viewer`; the UI stays read-only; a write sent on that same socket is still refused |
| `p2/3-non-disclosure-404` | P2-3 | the page's own `fetch` for an unknown id, a document outside the membership, and its own document; bodies and headers compared byte-for-byte; `401` without a session |
| `p2/4-role-capability-consistency` | P2-4 | one table over owner/editor/viewer: `documentCapabilities`, HTTP, WS join, WS frame, `room-joined.role` **and the browser's own editable/read-only state**, with the browser performing the keystroke (or the bypassed write) |
| `p2/5-role-change-is-re-evaluated` | P2-5 | demotion refused in the browser on the live socket; promotion accepted on one live oracle socket, without reconnecting |
| `p2/5-session-revocation-is-everywhere` | P2-5 | `DELETE /api/session` → `401` on HTTP and on the WS upgrade, through the proxy and directly; the page's own revocation; the already-open socket measured |
| `p2/9-token-not-exposed-to-js` | P2-9 | `Network.getCookies` (what the browser holds, `HttpOnly`) against `document.cookie`, `localStorage`, `sessionStorage`, `/api/session`, the bootstrap body and the server log |
| `p2/S-session-scope-after-restart` | limitation | records that a restarted server invalidates the session **and** that the page does not re-bootstrap; then proves a renewed session restores writing |
| `f1/1-viewer-is-read-only-and-not-remounted` | F1 (1) | a viewer page: `contenteditable="false"`, `EditorState.readOnly`, a visible `read-only-notice` whose copy says "read-only for your role" and contains none of `saved` / `saving` / `immediately` / `instant`, a real keystroke that changes nothing and emits no SYNC frame — and the same `.cm-editor` element (marker + `EditorView` identity + mount counters) before and after the demotion, through the reconnect |
| `f1/2-owner-and-editor-have-no-regression` | F1 (2) | owner/editor: editable UI, typing persists, `Mod-z` still reverts through the session's `Y.UndoManager`, a remote edit merges, and a document switch still works (and stays isolated) |
| `f1/3-unknown-role-does-not-lock-the-editor` | F1 (3) | `getRole() === null` in a real browser: offline from before the first frame, no `room-joined`, no membership row — the editor is editable, a real keystroke is accepted, a Yjs update appears in the local replica, and after an explicitly granted membership the server durably holds that text |
| `f1/4-ui-gate-is-not-a-security-boundary` | F1 (4) | the page is fed a schema-valid forged `room-joined(role: 'owner')`: the UI becomes editable and the notice disappears — and the write it then produces (keystroke **and** an explicit SYNC frame) is answered `FORBIDDEN`, with nothing applied, persisted or broadcast, no reconnect, and the socket still receiving |

### The M3 AI scenarios and the acceptance IDs they map to

`docs/DECISIONS.md` D-075 §6 froze A–H for M3. The AI half is covered here and in the Node suites;
this table says which browser scenario carries which claim, so a green run can never be read as
covering more than it does.

| Scenario id | D-075 | What the browser + durable store actually prove |
| --- | --- | --- |
| `m3/5-ai-proposal-and-accept` | A, E | the proposal renders a summary + unified diff while editor text, durable text and a real peer stay unchanged; Accept changes editor **and** durable **and** the peer; Undo reverts only the AI edit (the locally typed text survives); Redo restores it |
| `m3/6-ai-reject-writes-nothing` | B | Reject reaches `data-phase="rejected"`, clears the proposal, and leaves editor text and durable text byte-for-byte identical |
| `m3/7-ai-local-edit-invalidates` | C (revision) | Accept is still clickable after typing, and the click produces `ai-stale[data-reason="revision"]` with the exact frozen sentence; neither store moves and nothing is partially applied |
| `m3/8-ai-remote-outside-applies` | C, D | a peer edit **outside** the selection-derived anchor leaves the proposal pending and `data-base-revision` at `0`; Accept applies and the durable text holds both the peer edit and the AI edit |
| `m3/9-ai-remote-inside-stale` | C, D | a peer edit **inside** the anchor produces `data-reason="text-mismatch"` (explicitly not `revision`) with the exact frozen sentence; both stores are unchanged |
| `m3/10-ai-viewer-cannot-accept` | F | a viewer opens the panel and generates (generation needs `canRead`), sees the proposal and diff, gets a `disabled` Accept with a title, and a programmatic `.click()` changes neither store **and emits no SYNC frame** |
| `m3/11-ai-offline-accept-then-reconnect` | G (+ A5 P3-a) | **owner:** offline Accept changes local `Y.Text`, the durable store and a second browser profile still hold the old text, and after reconnect all three hold the expected text exactly once. **viewer who was offline:** `getRole()` is `null`, so the role chip disappears and Accept becomes clickable (R10/§17.9); the edit changes the local replica only, emits no SYNC frame, survives reconnect as a local divergence with **0 FORBIDDEN**, and is replayed by IndexedDB after a reload while the durable text never changes |

#### The remote chain and the directory (`m3r/*`, only in `INSIGHTHUB_E2E_AI_MODE=remote`)

| Scenario id | What the browser + durable store actually prove |
| --- | --- |
| `m3r/1-remote-draft-preview-accept` | the panel has **no** `ai-intent` chips; Generate POSTs `/api/ai/suggest` and the page records `200`; the proposal's summary is the **server stub's** fixed sentence and its diff is non-empty; editor and durable text are unchanged before Accept; Accept persists the exact `toUpperCase()` result; Undo/Redo step over that one transaction |
| `m3r/2-remote-provider-unconfigured` | with the backend on its default configuration (`AI_PROVIDER` unset) and the client still remote, Generate is answered `503`; `ai-status[data-provider-error="not-configured"]` is shown; there is no `ai-proposal`, no Accept, and neither editor nor durable text moves |
| `m3r/3-ai-directory` | `ai-directory[data-state="ready"]` lists the server's readable documents; exactly one row carries `aria-current="true"` and it is the active document; selecting another readable row switches `active-document` and unmounts `ai-panel`; reopening marks the new document |
| `m3r/4-ai-directory-offline` | CDP `Network.emulateNetworkConditions { offline: true }` + Refresh → `ai-directory[data-state="error"]`, `ai-directory-error[data-directory-error="network"]`, **zero** `ai-directory-item` elements; restoring the network + Refresh → `data-state="ready"` with rows, and the page recorded a real `200` |
| `m3r/5-collapsed-caret-is-not-an-empty-proposal` | typing leaves a **collapsed** caret (no selection); Generate still sends no `selection`, so the stub sees the whole document and the proposal's diff is non-empty; Accept writes the uppercase text. Regression for A6's round-2 finding (an empty diff the user could Accept for no effect) |

### M4 B12.5 — `New document` (`b125/*`, in the **default** suite)

`docs/DECISIONS.md` D-084 froze self-service creation as the product's first usable entry point:
the id/title are server facts (#2), the creator becomes `owner` through the existing membership
path (#5), the UI switches on success and changes nothing on failure (#7), and the pending-button
plus in-flight guard means there is no double-click path (#6). B12.5 shipped Node-level proofs
for the server transaction, the flow state machine and the panel markup; these three scenarios
are the browser proof that the **shipped** path works end to end. Creation is part of the
product, not a mode, so they carry no environment variable and count toward the default 73.

| Scenario id | D-084 | What the real browser + real server actually prove |
| --- | --- | --- |
| `b125/1-create-document-switches` | #2, #5, #7 | the panel's directory is `data-state="ready"`; one click on `new-document` produces **one** `POST /api/documents` that the browser's network stack answers `201` with `{ documentId: <uuid>, title: "Untitled document" }`; `active-document` becomes **that** id (≠ the previous document); `ai-panel` unmounts; the page's own `room-joined` says `owner`, the header chip renders `role: owner`, `EditorState.readOnly` is `false` and `.cm-content` is `contenteditable="true"`; reopening the panel marks exactly that one row `aria-current="true"`, titled `Untitled document`, and the created document appears exactly once |
| `b125/2-create-failure-does-not-switch` | #7 | with the browser's **network stack** offline (CDP `Network.emulateNetworkConditions`), the click is a real failed fetch (`status: null`, `error: TypeError`): `new-document-error` is **visible** with `data-create-error="network"`, `active-document` does not move, the directory's entries are the same ordered list of ids (no fabricated row), the panel stays open, and the button is enabled again with its idle label; restoring the network and clicking the same control yields a real `201`, a switch to that document, and exactly one new entry |
| `b125/3-double-click-creates-one-document` | #6 | two genuine `click` events dispatched **in one task** (so React has not rendered `disabled` yet — a disabled control dispatches no click at all, and both were observed) still produce exactly **one** `POST /api/documents` at both observers (page `fetch` log **and** CDP): the server list grows by **one** row, not two, and the workspace switches to that one document |

Three details a reader should not have to infer:

- **`setOffline` is not enough for this failure.** The page-side control rewrites the
  **collaboration socket**; it never touches `fetch`, so it cannot make `POST /api/documents`
  fail. Scenario 2 therefore uses the browser's own network stack
  (`Network.emulateNetworkConditions { offline: true }`), the same mechanism `m3r/4` uses for the
  directory. It asserts the typed `network` failure, not merely "no switch".
- **The POST is observed twice, independently.** `window.__qa.apiCalls` records the status the
  application's own `fetch` received; CDP `Network.responseReceived` records what the browser
  sent and the server answered, and `Network.getResponseBody` yields the frozen 201 body. "The
  workspace switched to the id the server returned" is therefore a string comparison.
- **The double click is the same-tick one.** D-084 #6 names both lines of defence: the `disabled`
  attribute (after a re-render) and the flow's synchronous in-flight guard (before it). The
  scenario exercises the harder one, and counts the click events that actually reached the
  control so the suite cannot pass by never dispatching the second click.

Acceptance **H** is the gate itself: the scenario count is now 73 (78 with
`INSIGHTHUB_E2E_AI_MODE=remote`), and the four commands in
`docs/TASKS.md` must all pass on the integrated HEAD.

### A6 Evidence Gate round 2 (`docs/DECISIONS.md` D-086) — `collab/*`, `stale/*`

The phase-1 inventory (`docs/agent-governance/CAPABILITY-EVIDENCE-INVENTORY.md`) left exactly two
collaboration/consistency claims `NOT VERIFIED`. These two scenarios are the real-browser answer;
the report (`docs/agent-governance/A6-evidence-gate-round2.md`) carries the measured values.

| Scenario id | Inventory item | What the browser + server actually prove |
| --- | --- | --- |
| `collab/independent-contexts` | **A1** | two `Target.createBrowserContext` contexts with different session tokens and separate `localStorage` edit one document concurrently (front insert + tail insert, then a Backspace delete and a typed replace, each round started together); the two edit windows overlap; A's editor text = B's = the `WireOracle`'s; `sha256(Y.encodeStateVector)` is identical for all three (3 clients, 19-byte state vector). `realtime/two-tabs-converge` is same-profile and is **not** this claim |
| `stale/directory-list` | **C2** | the client has **no** document-metadata request on open/switch, so that half is `NOT APPLICABLE`; on the real cancellable path (`AiDirectory` `GET /api/documents`), a real 200 held at the CDP response stage is aborted by the document switch ~69–78 ms after it started (two recorded runs) (not the 5 s timeout), Chrome refuses to deliver it afterwards (`Invalid InterceptionId`), and the UI/session/directory stay on the document the user switched to |

### Re-aimed by D-067 §4: the UI gate removed the write, not the assertion

A2's gate (D-067) makes a viewer's editor `EditorState.readOnly` + `EditorView.editable = false`
and refuses the local write in the delivery layer as well, so the three scenarios that used to
**type into a viewer's editor and wait for the `FORBIDDEN`** had nothing left to send, and timed
out. A0's decision was to keep both questions:

| Question | How it is answered |
| --- | --- |
| Does the **UI** stop a viewer from editing? | `assertUiReadOnly` + `assertKeystrokeProducesNoWrite` (`lib/role-gate.mjs`): DOM, `EditorState`, a visible notice, and a real keystroke that changes nothing and emits no SYNC frame |
| Is the **server** still the boundary? | `sendBypassWrite`: a genuine SYNC update built with `packages/shared`'s codec, sent over the **page's own authenticated socket** (`window.__qa.sendBinary`), so the `FORBIDDEN` is still received by the real browser — and it must be a **new** frame (`waitForBypassDenial`), not one that arrived earlier |

Neither assertion was weakened and no scenario was deleted. What did change: a viewer's keystroke
is now *expected* to produce nothing, and the `FORBIDDEN` is provoked by a write that bypasses the
editor on purpose.

### Two things a green run must not be read as claiming

- **Role changes are not reflected in the UI immediately.** The client learns its role only from
  `room-joined` (§17.9 rule 1) and Phase 2 has no server→client role-change message, so the gate
  can lag until the next successful join. `f1/1` measures that lag instead of hiding it.
- **Revocation is request-scoped, not retroactive.** An already-established socket keeps the
  identity it was admitted with; a *role* change is re-derived per frame, a *revoked session* is
  not. `p2/5-session-revocation-is-everywhere` records `writeApplied: true` for that socket.
  Do not read "the upgrade is refused" as "existing connections are terminated".

## Sessions and membership in the suite (M2 Phase 2)

Since `docs/CONTRACTS.md` §17 the collaboration socket is authenticated and authorized, so
the harness has two obligations it did not have before:

1. **Every upgrade carries a session cookie.** Without one the server answers HTTP `401`
   and no socket exists. `lib/authz-fixture.mjs` bootstraps a real session with
   `POST /api/session/bootstrap { demoUserId }` and keeps the cookie; the `Cookie` header is
   then passed **explicitly** on every request (`fetch`, and the `ws` handshake in
   `lib/wire-socket.mjs`). Node's global `WebSocket` cannot send headers at all, which is
   why `ws` — already a dependency of `apps/server` — is used for the Node-side peers.
2. **Every `join-room` needs a membership row.** Each scenario keeps its own `a6-*` /
   `p2-*` document for isolation, so the fixture writes the row the scenario needs into the
   run's own `authz.db` before anything joins.

### Identity of a browser page

The application bootstraps as `demo-ada` and there is no identity selector. A scenario that
needs a `viewer` page says so: `ctx.newAppPage({ documentId, as: 'demo-linus' })`. The page
instrumentation rewrites **only** the `demoUserId` field of the bootstrap request body, so the
session is still issued by the real server, still arrives as a real `HttpOnly` cookie, and the
role still comes from the seeded or fixture membership. Nothing about the resulting session is
simulated.

### ⚠ The membership fixture is coupled to `authz.db`'s schema

`lib/authz-fixture.mjs` writes `authz_document_membership(document_id, user_id, role)`
(`apps/server/src/authz/membership-store.ts`). **A change to that table or those column names
must update the fixture in the same change** — the same rule `docs/DECISIONS.md` D-055 §2
applies to `lib/durable-store.mjs` and the `insighthub.db` schema.

The coupling is asserted rather than assumed: every write first reads the real table and
column list and **fails loudly** when the file, the table or a column is missing. A fixture
that created `authz.db` itself, or that skipped a missing table, would present a broken
authorization store as a passing test.

`grant()` has two modes, and the difference matters:

- the harness's own arranging of access uses `ifAbsent: true` — it must **not** overwrite a
  seeded or scenario-chosen role (asking for `owner` on `demo-document` for `demo-linus`
  would otherwise silently promote the seeded `viewer` that a denial scenario depends on);
- a scenario stating a role calls `ctx.authz.grant(documentId, userId, role)` and *replaces*
  an existing row, which the evidence records as `replaced`.

Every write appears in the scenario's evidence as an `authz fixture: …` line, so no scenario
silently grants itself access.

### The fixture must never create access implicitly (F3 — an evidence condition, not a note)

`docs/DECISIONS.md` D-065 §5 turned the old F3 remark into an **evidence condition**: a fixture that
quietly writes an `owner` row can turn a denial scenario green, and can make a `getRole() === null`
window look like a permission decision. Two call sites used to do exactly that for *every* page that
opened a document:

| Site | Before | Now |
| --- | --- | --- |
| `run.mjs#newAppPage` | always wrote `owner` with `ifAbsent` | `role: null` writes **nothing** |
| `lib/app.mjs#setDocumentId` | always wrote `owner` with `ifAbsent` | `arrangeAccess: false` writes **nothing** |

`role: null` silences **both**, so a scenario that needs "this identity has no role at all" cannot
be helped by the harness. `f1/3-unknown-role-does-not-lock-the-editor` proves it rather than
asserting it: the fixture's own log is empty and `ctx.authz.membership(...)` is `null` while the
unknown-role window is observed, and the row it later relies on is recorded as `inserted` at that
moment. A scenario that *states* a role still calls `ctx.authz.grant(...)`, which is logged.

### The unknown-role window is constructed, not assumed

`ctx.newAppPage({ role: null, offlineFirst: true })` injects `window.__qa.setOffline(true)` **after
the instrumentation and before any application script**, so the client's very first collaboration
socket is rewritten to an unreachable port. It never completes a `join-room` — which is the honest
instance of `getRole() === null` (§17.9 rule 2) and is the state every page is in before its first
join. `setOffline(page, false)` restores the real socket afterwards, so the same scenario can then
prove that the text typed while the role was unknown reaches `Y.Text` and the server.

### The one place a scenario renews a session by hand

`m2/C-offline-client-survives-restart` renews the writer's cookie after its restart
(`ctx.authz.renewBrowserSession`). Sessions are **process-scoped** (§17.2), so the restart
invalidated the page's session, and the client has no 401-driven re-bootstrap
(`p2/S-session-scope-after-restart` records that: the page never returns to `connected` and
performs no further bootstrap). Without the renewal that scenario could only measure session
recovery. Everything it asserts is still the real path — real reconnect, real state-vector
handshake, real durable store — and the line disappears the day the client re-bootstraps on
its own. It is called out here, in the scenario's evidence and in the A6 report so it cannot
be mistaken for a green result about session recovery.

### M2 durability scenarios and the acceptance IDs they map to

| Scenario id | M2-P0-1 | What is asserted |
| --- | --- | --- |
| `m2/A-room-emptied-then-recovered` | A | after every peer leaves, a brand-new device hydrates the stored document; the durable row still exists |
| `m2/B-real-process-restart` | B | a hard kill (no graceful shutdown, no `store.close()`) followed by a new pid on the same directory still serves the document |
| `m2/C-offline-client-survives-restart` | C | offline edit + restart + reconnect reconciles through the state-vector handshake; store, client and a new device all converge. **The session cookie is renewed after the restart** — see "Sessions and membership" below for why that is required and what it does not claim |
| `m2/E-compaction-survives-restart` | E | crossing the update threshold then evicting folds the log into the snapshot; text **and** `encodeStateAsUpdate` SHA are unchanged after restart |
| `m2/F-persist-failure-is-honest` | F | holding SQLite's write lock makes an append fail: 1011 close, no "connected" claim, no broadcast to peers, nothing durable, committed data intact |
| `m2/G-document-isolation` | G | two documents keep separate rows and never cross, before and after a restart |
| `m2/J-concurrent-cold-joins` | J | three brand-new devices joining a cold document simultaneously all hydrate the same content; one row per document |
| `m2/K-backlog-overflow-constructibility` | K | attempts a 400-frame burst during hydration and records whether the bounded backlog is reachable (see the report for the measured answer) |

`docs/TASKS.md` acceptance **D / H / I** are *not* browser-covered by this suite; they
have Node-level coverage in `apps/server/src/persistence/acceptance.test.ts`. Do not read
a green browser run as covering them.

## Failure injection, without touching production code

| Need | Mechanism |
| --- | --- |
| a genuinely offline client | page-side `WebSocket` rewrite to an unreachable port (`window.__qa.setOffline`) |
| a genuinely offline **`fetch`** (the socket shim does not touch it) | CDP `Network.emulateNetworkConditions { offline: true }` — used by `m3r/4` for the directory and `b125/2` for `POST /api/documents` |
| a durable-append failure | `acquireWriteLock(dataPath)` holds SQLite's write lock from a second process, so the server's `BEGIN IMMEDIATE` fails after its 5 s `busy_timeout` |
| duplicate / reordered / malformed frames | frame-level hold, replay and injection in the page transport |
| a **delayed HTTP response** (the request runs, the answer is held) | CDP `Fetch.enable` with `requestStage: 'Response'`, then `Fetch.fulfillRequest` / `Fetch.continueResponse`; the held response's real body is read with `Fetch.getResponseBody` |
| durable-state assertions | `reconstructDurableDocument(dataPath, id)` rebuilds a `Y.Doc` from `snapshot` + `document_update`, the same replay `DocumentHydrator` does |

## HTTP stale-response ownership (Evidence Gate C, `docs/DECISIONS.md` D-086)

The gate's wording is "document metadata request delayed → switch to B → B answers first → A
answers late → the UI stays on B". **The first half of that is not true of this client, and the
scenario records that instead of inventing a request.** Opening or switching a document performs
**no** HTTP request for the document's metadata: the only `/api/**` call a page makes while
opening and switching is `POST /api/session/bootstrap`, and the switch itself is a WebSocket
`join-room` answered by `room-joined` (`stale/directory-list` asserts the page's own `__qa.apiCalls`
contains no `GET /api/documents/:id`). The server route exists; the client never calls it on this
path.

So the scenario is named for the request it actually delays — `stale/directory-list` — and it
tests the closest **real** cancellable HTTP path: `AiDirectory`'s `GET /api/documents`, the one
request in the client that carries an `AbortController` and a monotonic request id
(`apps/web/src/features/editor/AiDirectory.tsx`, R9).

```text
panel open (list ready)
  → CDP holds the next GET /api/documents at the response stage   (real 200, body read, page fetch pending)
  → the user switches A → B through the header input              (the panel unmounts, so it aborts)
  → the page's own request log turns that request into AbortError (~69–78 ms after it started, not the 5 s timeout)
  → the response is released anyway: Fetch.fulfillRequest → "Invalid InterceptionId"
  → active-document, editor text and the (absent) panel are still B's
  → reopening the panel shows the server's list, with B marked aria-current
```

What this proves, and what it does not:

| Claim | Evidence |
| --- | --- |
| the delayed answer was a **real** server response | `Fetch.requestPaused` reports `responseStatusCode: 200`; `Fetch.getResponseBody` returns the real body and its document ids |
| the answer was genuinely **late** | while held, exactly one `/api/documents` entry is `{status: null, error: null}` in the page's own log — the application's `fetch` had not settled when the switch happened |
| the switch **cancelled** it | the same entry becomes `error: 'AbortError'`; the elapsed time is recorded and asserted to be under the request's internal 5 s timeout, so this is the switch's abort and not a timeout |
| a late answer cannot **arrive** | Chrome refuses to deliver a response whose page-side request was aborted (`Invalid InterceptionId`); if a future browser accepted it, the assertions check the entry is *still* `AbortError` (a delivered 200 would set `status`) and that the active document, the editor text and the DOM are untouched |
| the directory is **not polluted** | the reopened panel's rows are compared one-for-one, in order, with `GET /api/documents` for the same session; exactly B is `aria-current`; the stale marker never appears |
| an abort is **not a failure** | no `ai-directory-error`, no `session-failed`, no uncaught page error |

The honest limit: the product aborts on every ownership change, so a "stale response is delivered
and then ignored by an ownership guard" instance **cannot be constructed without modifying the
product**. What is proven is the stronger transport-level fact (the request is cancelled and the
browser will not deliver it), plus the UI-level fact (nothing about the new document moved). The
request-id guard inside `AiDirectory` is therefore a second line of defence that this run could
not put under load; do not read this scenario as evidence that the guard itself was exercised.

## The one-time identity remount — a real residual, waited for

`POST /api/session/bootstrap` is deliberately **not** on the editor's critical path
(`AGENTS.md` R10): while it is in flight the shell renders and the collaboration session opens
on a per-tab **placeholder** identity (`apps/web/src/user.ts`). But the session is keyed on
`userId` / `userName` (`apps/web/src/collab/public.ts` `useCollaborativeDocument`), and
`App.tsx` passes `user={presenceUserFor(identity)}`. So when the server identity lands, the
product really does this, exactly once:

```text
editor mounts on the placeholder session
  → bootstrap resolves, [data-testid="session-identity"] renders
  → the hook's dependencies change
  → the placeholder session is destroyed and its editor unmounted
  → a new session is created for the server identity and the editor is remounted
```

This is **not** something the suite pretends does not happen. It is a pre-existing product-level
residual (the same lines exist before the M3 redesign; the redesign's faster first paint only
made the race likely enough to surface). What the harness owns is not racing it:

- `waitForSessionActive` (used by `newAppPage`, `openApp` and now `reloadApp`) is terminal only
  when **all** of these hold: `session-identity` is rendered (the bootstrap decision landed),
  the bootstrap outcome is observable, and `.cm-editor` + `.cm-content` are mounted **after**
  that decision when the decision changed the presence user (`bootstrap.hasServerIdentity`).
  A bootstrap that produced **no** server identity leaves the placeholder user unchanged, so no
  remount is due and a preceding mount is already final — that is the offline branch, measured
  with the backend stopped.
- `setDocumentId` uses the same idea for a document switch: it waits for a `.cm-editor` mounted
  **after** Enter was pressed, not merely for the header text and *some* editor (the old editor
  is still mounted in the commit that shows the new id).
- `typeInEditor` / `pressInEditor` additionally wait (5 s, bounded) for `.cm-content` to exist
  before the real click. This cannot mask a regression: it is a precondition, not a retry —
  it never repeats the click, never swallows its result, and a missing editor still fails the
  scenario, now with a named selector instead of `no element matches .cm-content`.
- `m3/0-identity-remount-is-waited-for` forces the ordering with the `bootstrapDelayMs` chaos
  control (the page instrumentation delays `POST /api/session/bootstrap`; **no application
  change**) and asserts that the page really mounted on the placeholder identity first, that
  the live editor is the post-identity mount, and that a keystroke then reaches the durable
  document. With the old wait it returned in the placeholder window and typed into the doomed
  session.

The instrumentation behind all of this, in `instrument/page-instrument.js`:

| Field | Meaning |
| --- | --- |
| `identity.present` / `identity.firstSeenAt` / `identity.changes` | when `[data-testid="session-identity"]` was rendered — the bootstrap decision, both `ready` and `unavailable` |
| `editor.mountLog[]` / `editor.lastMount` | every `.cm-editor` mount with its timestamp and `sawIdentity` (was the decision already rendered?) |
| `bootstrap.calls` / `bootstrap.settledAt` / `bootstrap.status` / `bootstrap.hasServerIdentity` | the one bootstrap request's outcome, read from a clone so the application still reads the body |
| `bootstrapDelayMs` | chaos control: delay the bootstrap by N ms, to make the placeholder window deterministic (used only by `m3/0`) |

## Conventions that keep the results honest

- A scenario records **evidence** (`note`) before it asserts, so a failure explains itself.
- Nothing is retried, nothing is skipped, no assertion is loosened to make the suite green.
- Counts are read from the page (live sockets, live `setInterval` handles, live
  `.cm-editor` nodes) — never assumed.
- Latency is reported as median/p95/max with the method stated, and is labelled when a
  leg of the path is not exercised.
- Persistence claims are backed by the bytes on disk, never by "the page still shows it".
