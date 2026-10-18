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
| M2 durable persistence | `suite/10-m2-durability.mjs` | the server's document survives room eviction, a hard process kill, compaction, and is never faked on a failed write |

## Why there is no Playwright

The repository has no browser-automation dependency, and `AGENTS.md` R3/§2 forbid
adding one without Supervisor approval. Everything this suite needs already exists:

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

Exit code is `0` only when every scenario passes. A failing scenario is never retried
and is never skipped. Results land in `artifacts/results.md` and
`artifacts/results.json`; screenshots go to `artifacts/`.

The suite runs **serially** and owns ports `5173`/`3101`: it refuses to start when
either is occupied, and its postflight prints whether both were released again.

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

## How it observes the application

Everything is injected with `Page.addScriptToEvaluateOnNewDocument`, i.e. it runs
**before** any application script. **No production file is instrumented and no
test-only hook was added to A1/A2/A3 code.**

| File | Role |
| --- | --- |
| `lib/chrome.mjs` | launches a throwaway-profile browser and reports its real version |
| `lib/cdp.mjs` | minimal CDP client, real input (`Input.insertText`, key events, mouse) |
| `lib/stack.mjs` | starts/stops the real backend and Vite; `stopServer()` is a verified process death |
| `instrument/page-instrument.js` | transport recording, fault injection, mount/timer/IDB counting |
| `lib/app.mjs` | drives the real UI and reads real state back |
| `lib/oracle.mjs` | an independent Yjs peer on the real server (the convergence witness) |
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
| `01-persistence.mjs` | browser IndexedDB: reload without backend, offline edits, reopen, two tabs, replica inspection |
| `02-editor.mjs` | real `EditorView`: mount on existing `Y.Text`, minimal remote apply, undo, document switch |
| `03-realtime.mjs` | live remote edits, two-tab convergence, validated presence, remote caret/selection, presence lifecycle |
| `04-chaos.mjs` | offline/reconnect, duplicate frames, out-of-order delivery, document-switch race, awareness churn |
| `05-performance.mjs` | 5 000-line invariants and latency measurements |
| `06-lifecycle.mjs` | 20 open/switch/disconnect cycles; navigation teardown |
| `07-robustness.mjs` | frozen error codes for malformed/oversized/unsigned traffic, and browser survival |
| `10-m2-durability.mjs` | M2-P0-1: room emptied, real process restart, offline client + restart, compaction, persist failure, document isolation, concurrent cold joins, backlog-overflow constructibility |

### M2 durability scenarios and the acceptance IDs they map to

| Scenario id | M2-P0-1 | What is asserted |
| --- | --- | --- |
| `m2/A-room-emptied-then-recovered` | A | after every peer leaves, a brand-new device hydrates the stored document; the durable row still exists |
| `m2/B-real-process-restart` | B | a hard kill (no graceful shutdown, no `store.close()`) followed by a new pid on the same directory still serves the document |
| `m2/C-offline-client-survives-restart` | C | offline edit + restart + reconnect reconciles through the state-vector handshake; store, client and a new device all converge |
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
| a durable-append failure | `acquireWriteLock(dataPath)` holds SQLite's write lock from a second process, so the server's `BEGIN IMMEDIATE` fails after its 5 s `busy_timeout` |
| duplicate / reordered / malformed frames | frame-level hold, replay and injection in the page transport |
| durable-state assertions | `reconstructDurableDocument(dataPath, id)` rebuilds a `Y.Doc` from `snapshot` + `document_update`, the same replay `DocumentHydrator` does |

## Conventions that keep the results honest

- A scenario records **evidence** (`note`) before it asserts, so a failure explains itself.
- Nothing is retried, nothing is skipped, no assertion is loosened to make the suite green.
- Counts are read from the page (live sockets, live `setInterval` handles, live
  `.cm-editor` nodes) — never assumed.
- Latency is reported as median/p95/max with the method stated, and is labelled when a
  leg of the path is not exercised.
- Persistence claims are backed by the bytes on disk, never by "the page still shows it".
