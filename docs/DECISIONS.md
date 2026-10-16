# DECISIONS.md

Architecture decision record. One entry per decision, appended, never rewritten.
Changing `docs/ARCHITECTURE.md` or `docs/CONTRACTS.md` requires Supervisor
approval (`AGENTS.md` §2); a decision that changes either must be recorded here.

Format: `D-NNN · date · status · title`, then Context / Decision / Consequences.

---

## D-001 · 2026-02-14 · accepted · pnpm workspace monorepo with a shared contract package

**Context.** Web and server both need the same domain vocabulary (documents,
roles, connection status, WebSocket messages, AI suggestions). Two copies would
drift silently, and drift across a network boundary shows up as a runtime bug,
not a compile error.

**Decision.** One pnpm workspace with `apps/web`, `apps/server` and
`packages/shared`. `packages/shared` is the only place a cross-boundary type may
be declared; both apps depend on it via `workspace:*`.

**Consequences.** One install and one lockfile; `pnpm -r typecheck` covers the
whole repo. Cost: root `package.json` and `pnpm-workspace.yaml` become shared
infrastructure, so they require Supervisor review.

---

## D-002 · 2026-02-14 · accepted · Zod schemas are the source of truth, types are derived

**Context.** Runtime validation of untrusted input (WebSocket frames, HTTP
bodies) plus compile-time types are both needed. Hand-writing an interface next
to a validator lets the two disagree.

**Decision.** Declare Zod schemas in `packages/shared` and derive TypeScript
types with `z.infer`. Parsers (`parseServerMessage`, `parseClientMessage`,
`parseMessageJson`) return a discriminated result and never throw.

**Consequences.** One definition per contract; validation and typing cannot
drift. Cost: `zod` is a dependency of `packages/shared`, which both apps inherit.
Rationale for **Zod 3 over Zod 4**: Zod 3 is the mature line with the widest
ecosystem compatibility; no Zod 4-only feature is needed for MVP, and this
avoids an avoidable upgrade risk in the shared foundation.

---

## D-003 · 2026-02-14 · accepted · Unknown WebSocket message types are rejected, not ignored

**Context.** A permissive parser (ignore what you do not understand) hides
protocol drift: a renamed message type degrades into silence and is only noticed
in production.

**Decision.** Two strict discriminated unions — `wsClientMessageSchema` and
`wsServerMessageSchema`. A message that is valid in the wrong direction, or that
carries an unknown `type`, fails to parse. The server answers a malformed frame
with an explicit `error` message.

**Consequences.** Protocol changes break loudly in tests instead of quietly at
runtime. Cost: adding a message type is a two-sided change and requires a shared
contract update (Supervisor review).

---

## D-004 · 2026-02-14 · accepted · AI suggestions anchor to plain offsets + `baseRevision` (RelativePosition deferred to M4)

**Context.** An AI suggestion is generated from a snapshot of the text, then the
user reviews it while the document may keep changing. Applying it to a moved
document corrupts text. Robust anchoring options: plain UTF-16 offsets,
`baseRevision` guard, or Yjs `RelativePosition` (which survives transformation
through concurrent edits).

**Decision.** For M0/M3 the contract carries plain `index`/`length` offsets plus
`baseRevision`. A suggestion whose `baseRevision` no longer matches the document
revision is **stale**: reject or regenerate, never apply blindly
(`isSuggestionStale`).

**Consequences.** Simple, testable, explainable. Known limitation: a document
that moved on always invalidates the suggestion, even when the edit region is
untouched. Upgrade path: migrate operation anchoring to Yjs `RelativePosition` in
M4, which requires a shared contract change and a version bump.

---

## D-005 · 2026-02-14 · accepted · Pin Ant Design 5.x, Vite 7, zod 3

**Context.** The registry currently offers React 19.3, Vite 8.3, Ant Design 6.6,
Zod 4.6 and TypeScript 5.9. Taking the newest major of every package in a
bootstrap milestone maximizes unrelated risk.

**Decision.** React 19.3 + Vite 7.3 + `@vitejs/plugin-react` 5.2 + Ant Design
5.29 + zod 3.25 + TypeScript 5.9 + Redux Toolkit 2.13 + react-redux 9.3.
Ant Design 5 is chosen over 6 because v5 is the line with proven React 19
behaviour; Ant Design 6 is a fresh major.

**Consequences.** A conservative, well-tested stack. Deferred upgrades are a
tracked follow-up, not a silent debt; any bump is a `package.json` change and
therefore requires Supervisor review.

---

## D-006 · 2026-02-14 · accepted · One Vite dev server, backend proxied behind it

**Context.** The browser must reach both the HTTP API and the WebSocket without
CORS or mixed-origin complications, and the M0 criterion is "browser connects to
the WebSocket".

**Decision.** Vite proxies `/api`, `/health` and `/ws` (with `ws: true`) to the
backend on `127.0.0.1:3001`. The client derives its WebSocket URL from
`window.location` by default, overridable with `VITE_WS_URL`. Server CORS stays
explicitly configured for the dev origin anyway.

**Consequences.** One origin in development; no client-side host guessing. Cost:
the Vite proxy config is load-bearing for development.

---

## D-007 · 2026-02-14 · accepted · Workspace-wide TypeScript `paths` instead of project references

**Context.** `packages/shared` ships raw TypeScript. The server's runtime is
`tsx` (dev) and `node` (build), so it must resolve `@insighthub/shared` to real
JavaScript in `dist`, while `tsc` should typecheck against source for accurate
errors.

**Decision.** `tsconfig.base.json` maps `@insighthub/shared` to
`./packages/shared/src/index.ts` for typechecking. `packages/shared` has a
`tsconfig.build.json` that emits declarations plus JavaScript to `dist` and is
built before the server. No TypeScript project references / composite builds.

**Consequences.** Fast, understandable typechecking with no build-order coupling
for editors or tests. Cost: the server's `dist` output relies on `shared` having
been built first, which the root `build` script enforces and `docs/TASKS.md`
documents.

---

## D-008 · 2026-02-14 · accepted · Prettier only; ESLint deferred

**Context.** `AGENTS.md` asks for a quality gate, but adding ESLint with
`typescript-eslint` + React plugins in M0 is configuration surface with no
milestone payoff.

**Decision.** Ship Prettier (`format`, `format:check`) and rely on a strict
`tsc` (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
`verbatimModuleSyntax`, `isolatedModules`) as the correctness gate. ESLint is a
tracked follow-up, not silently dropped.

**Consequences.** No lint-caught rule violations in M0; typecheck plus review
covers the acceptance criteria. Adding ESLint later is an additive change.

---

## D-009 · 2026-02-14 · accepted · `packages/shared` resolves to source for types, to `dist` at runtime

**Context.** First validation run failed with `TS6059: File ... is not under
'rootDir'` — the server's emit build was pulling `packages/shared/src/*.ts` into
its program through the workspace `paths` mapping, so `tsc` refused to emit. A
second, subtler failure followed: `packages/shared` pointed its own runtime
entry (`main`/`exports`) at `./src/index.ts`. TypeScript and Vite accept that,
but plain Node does not, so any non-bundled consumer (the built server, a
standalone script) failed with `ERR_MODULE_NOT_FOUND`.

**Decision.**

1. `tsconfig.base.json` maps `@insighthub/shared` to `packages/shared/src/index.ts`
   so `typecheck` and editors read real source and report accurate errors.
2. `apps/server/tsconfig.build.json` overrides that mapping to
   `packages/shared/dist/index.d.ts`, keeping the shared source out of the emit
   program.
3. `packages/shared/package.json` points `types` → `dist/index.d.ts` and
   `import`/`default` → `dist/index.js`, so runtime consumers resolve real
   JavaScript.
4. `packages/shared` is therefore a **build prerequisite** of the server. This is
   enforced with `apps/server` `prebuild` and a root `predev`, so both
   `pnpm dev` and `pnpm --filter @insighthub/server build` work without a manual
   build step.

**Consequences.** Typecheck accuracy and Node-runnable artefacts are both
satisfied. Cost: `shared` must be built before the server runs — handled by the
scripts above, and worth remembering when adding a new consumer.
**Rejected alternative:** TypeScript project references / composite builds, which
solve this more formally but add build graph configuration that M0 does not need.

Related: an early validation run executed `tsc` against the then-broken config and
emitted compiled `*.js`/`*.js.map` **beside** the shared sources. Those artefacts
were deleted, verified not to be reproducible from a clean state, and guarded by
`packages/shared/src/.gitignore` so this class of mistake cannot be committed.

---

## D-010 · 2026-02-14 · accepted · Two test runners: Vitest for contracts, `node:test` for server integration

**Context.** The server acceptance test must boot a real HTTP + WebSocket server.
That test was written with `node:test` (Node's built-in runner) but the root
Vitest config still globbed it, producing "No test suite found in file".

**Decision.** Vitest owns `packages/**` (pure contract/schema tests) and excludes
`apps/**`. `apps/server` keeps `node:test` via `tsx --test` for integration tests
against real sockets and ephemeral ports. The root `test` script runs both
(`vitest run && pnpm --filter @insighthub/server test`), with `test:unit` and
`test:server` available for focused runs.

**Consequences.** No test-framework compatibility shims, and integration tests
exercise the real transport rather than a mock. Cost: two runners to be aware of;
the root script is the single entry point that covers both.

---

## D-011 · 2026-02-14 · accepted · The Vite proxy target is configurable

**Context.** Runtime verification failed on "vite proxies /health to the backend"
with `ECONNREFUSED 127.0.0.1:3001`: the proxy target was hardcoded while the
backend under test ran on another port. A hardcoded proxy is also a collision
hazard in development.

**Decision.** `apps/web/vite.config.ts` derives the proxy target from
`INSIGHTHUB_SERVER_HOST` (default `127.0.0.1`) and `PORT` (default `3001`), and
exposes them to tooling that runs the stack on non-default ports.

**Consequences.** The stack can be started on any port without editing config,
and the M0 proxy check is reproducible. Cost: one more environment variable to
document (`README.md`).

---

## D-012 · 2026-02-14 · accepted · Shared contracts are validated with Zod 3 semantics

**Context.** `docs/CONTRACTS.md` specifies ISO 8601 timestamps on envelopes and
positive-only offsets. An early test fixture used `ts: 'x'` and failed — correctly,
because `z.string().datetime()` rejected it.

**Decision.** Keep strict validation (`z.string().datetime()`, non-negative
integers, non-empty payload objects) and fix the fixture, rather than loosening
the schema to accommodate a bad test. Rejection behaviour is itself asserted by
tests: unknown `type`, wrong-direction messages, non-ISO timestamps, empty insert
text and negative offsets are all covered.

**Consequences.** Malformed frames fail loudly at the boundary instead of
corrupting document state later. Cost: producers must emit well-formed ISO
timestamps — the `createEnvelope`/`createConnectedMessage` helpers guarantee this
for anything built through the shared API.

---

## D-013 · 2026-02-14 · accepted · The dev stack binds IPv4 explicitly

**Context.** Verifying the documented quickstart on default ports, the backend
answered on `127.0.0.1:3001` but the web server did not: `Get-NetTCPConnection`
showed Vite listening on `::1` only, so `http://127.0.0.1:5173` failed while
`http://localhost:5173` worked. Vite's default `localhost` binds a single address
family chosen by the OS resolver, which on Windows is IPv6. The README, the
browser instructions and the backend all use `127.0.0.1`, so this was a real
documentation/behaviour mismatch, not a cosmetic one.

**Decision.** Set `server.host = '127.0.0.1'` in `apps/web/vite.config.ts` so the
whole dev stack listens on IPv4. CORS on the server explicitly allows
`http://localhost:5173` as well, so either spelling keeps working.

**Consequences.** `http://127.0.0.1:5173` and `http://localhost:5173` both reach
the app, and every component uses one address family. Cost: binding to loopback
only, which is the intended development default (expose with `--host` if you
deliberately want LAN access).

