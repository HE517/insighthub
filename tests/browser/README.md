# `tests/browser` — real-browser validation and chaos suite (owner: A6)

This directory is the M1-A6 real-browser gate. It drives a **real Chromium** over the
DevTools Protocol, against a **real** backend, a **real** Vite dev server and a
**real** browser IndexedDB. Nothing here is jsdom, and no scenario substitutes a
simulated call for a real one.

## Why there is no Playwright

The repository has no browser-automation dependency, and `AGENTS.md` R3/§2 forbid
adding one without Supervisor approval. Everything this suite needs already exists:

| Need | Provided by |
| --- | --- |
| Browser control | Node 22's global `WebSocket` speaking CDP to a locally installed Chrome/Edge |
| Readiness probes | Node's global `fetch` |
| Yjs peer / codec | the workspace's own `yjs`, `y-protocols` and `@insighthub/shared` |

So the harness adds **zero** dependencies and changes **no** `package.json`.

## Run it

```bash
pnpm build                 # packages/shared must be compiled for the oracle client
node tests/browser/run.mjs
```

Useful switches:

```bash
node tests/browser/run.mjs --list                 # every scenario id
node tests/browser/run.mjs --filter indexeddb     # substring match on id or title
node tests/browser/run.mjs --headed               # watch the browser
node tests/browser/run.mjs --keep-open            # leave the stack and browser up
```

Exit code is `0` only when every scenario passes. A failing scenario is never retried
and is never skipped. Results land in `artifacts/results.md` and
`artifacts/results.json`; screenshots go to `artifacts/`.

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

## Known defects this suite pins

`suite/defect-pins.mjs` and the scenarios tagged `knownDefect` assert the behaviour the
contract requires against the **unmodified** production path. They are expected to be
red, they still fail the run, and they must be deleted (not relaxed) once fixed.

| Id | Summary |
| --- | --- |
| `P0-1` | `collab/internal/persistence.ts` assigns `globalThis.indexedDB`, which is a getter-only accessor in a real browser → no document opens at all |
| `P0-2` | `features/editor/collabTextBinding.ts` only flushes queued local edits at 64 changes → keystrokes never reach `Y.Text` |
| `P0-3` | `features/editor/remoteCursorExtension.ts` dispatches from a `ViewPlugin` constructor → the plugin crashes on mount, so remote cursors never render |

### The P0-1 workaround

Functional scenarios install one shim (`P0_1_WORKAROUND` in `lib/app.mjs`) that makes
`window.indexedDB` a writable own data property holding the browser's own factory. It
changes no application behaviour other than making the assignment `persistence.ts`
already intends succeed, and every result that depends on it is labelled in the report.
`defect-pin/P0-1` runs **without** the shim and is permanently red until A1 fixes the
module.

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
| `defect-pins.mjs` | the unmodified-path regression pins |

## Conventions that keep the results honest

- A scenario records **evidence** (`note`) before it asserts, so a failure explains itself.
- Nothing is retried, nothing is skipped, no assertion is loosened to make the suite green.
- Counts are read from the page (live sockets, live `setInterval` handles, live
  `.cm-editor` nodes) — never assumed.
- Latency is reported as median/p95/max with the method stated, and is labelled when a
  leg of the path is not exercised (for example because `P0-2` is open).
