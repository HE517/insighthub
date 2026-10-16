# InsightHub

Team knowledge-base document platform with an AI assistant. Collaborative
Markdown editing (Yjs CRDT), offline-first persistence, and AI edit suggestions
that a human reviews as a diff before accepting.

Full context: [`docs/PROJECT.md`](docs/PROJECT.md) ·
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
Contracts: [`docs/CONTRACTS.md`](docs/CONTRACTS.md) ·
Tasks: [`docs/TASKS.md`](docs/TASKS.md) ·
Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md) ·
Multi-agent rules: [`AGENTS.md`](AGENTS.md).

**Current status: M0 Bootstrap complete.** No collaboration, AI or auth yet —
only a running skeleton and the shared contract they build on.

## Layout

```
apps/web        React + Vite + Redux Toolkit + Ant Design + CodeMirror 6
apps/server     Express + ws + Zod
packages/shared types, Zod schemas, WebSocket protocol, API contract
docs/           PROJECT / ARCHITECTURE / CONTRACTS / TASKS / DECISIONS
```

## Requirements

- Node.js >= 20.19 (developed on 22.14)
- pnpm 10 (`npm i -g pnpm@10`; `corepack enable pnpm` also works if your Node
  installation directory is writable)

## Quickstart

```bash
pnpm install
pnpm dev          # server on :3001, web on :5173
```

Open <http://127.0.0.1:5173> (or <http://localhost:5173>). Both work: the whole
dev stack binds IPv4 `127.0.0.1` deliberately, so there are no address-family
surprises. The right-hand panel shows the live WebSocket state and the result of
`GET /health`; the "Server messages" card shows the raw `connected` handshake
frame.

Run the two processes separately if you prefer:

```bash
pnpm dev:server   # tsx watch, http://127.0.0.1:3001
pnpm dev:web      # vite,    http://127.0.0.1:5173
```

## Verification

```bash
pnpm typecheck    # tsc across every workspace package
pnpm test         # vitest (shared contracts) + node:test (server integration)
pnpm build        # shared -> server (tsc) -> web (vite)
pnpm --filter @insighthub/server verify:m0   # runtime end-to-end check
```

`verify:m0` starts a real backend plus the Vite dev server and asserts:
process start, `GET /health` → 200, `GET /api/meta` → 200, unknown path → 404, a
valid `connected` WebSocket handshake, the app shell served, and `/health`
proxied through Vite.

## Ports

| Service          | Default | Override                                  |
| ---------------- | ------- | ----------------------------------------- |
| HTTP + WebSocket | 3001    | `PORT`                                    |
| Vite dev server  | 5173    | `--port`, and `PORT` for its proxy target |
| WebSocket path   | `/ws`   | `WS_PATH`                                 |

The Vite dev server proxies `/api`, `/health` and `/ws` (with `ws: true`) to the
backend, so the browser only ever talks to one origin in development.

Both services bind `127.0.0.1` (IPv4) by default. Vite's own default resolves to
`::1` on Windows, which would make `http://127.0.0.1:5173` unreachable, so the
host is pinned deliberately.

## Environment variables

| Variable        | Used by           | Purpose                                                 |
| --------------- | ----------------- | ------------------------------------------------------- |
| `PORT`          | server, web proxy | Backend port                                            |
| `HOST`          | server            | Bind host (default `127.0.0.1`)                         |
| `CORS_ORIGIN`   | server            | Allowed HTTP origin                                     |
| `WS_PATH`       | server            | WebSocket upgrade path                                  |
| `VITE_WS_URL`   | web               | Absolute WS URL; default derives from `window.location` |
| `VITE_API_BASE` | web               | Absolute API base; default uses the dev proxy           |

No secrets belong in this repository (see `AGENTS.md` R4).

## Contributing under the multi-agent agreement

Read [`AGENTS.md`](AGENTS.md) first. It is binding: it defines the agent roles,
which paths require Supervisor review (`packages/shared/**`, any `package.json`,
`pnpm-workspace.yaml`, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`), the mandatory
completion report, and the Definition of Done.
