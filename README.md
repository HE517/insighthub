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

**当前状态：M1（Collaboration core）已收口并合入 `main`。** 协作文档核心完整交付并验证：
`Y.Doc`/`Y.Text` 绑定 CodeMirror、WebSocket 文档房间与增量同步、IndexedDB 离线持久化、
重连合并与协作安全撤销、远端光标/选区、协作感知（awareness）。

终审：A7 Final Closing Review = **APPROVE**（C1、C2 均 CLOSED，无 merge blocker）。
验证基线（`main`）：`pnpm typecheck` / `pnpm test` / `pnpm build` 全部 exit 0；
真实 Chromium 浏览器套件 **27/27** 通过（无 shim、无 pin）。

> **发布限制（务必知悉）：当前 M1 没有服务端 durable persistence。** 服务端房间一经释放
> （最后一个成员离开即销毁），新客户端**不能**依赖服务器恢复历史正文；现阶段唯一的持久副本
> 是各客户端的 IndexedDB。用户若丢失全部本地副本，内容即无法恢复。该能力立项为
> **M2-P0-1**（见 [`docs/TASKS.md`](docs/TASKS.md)）。
>
> 另有两项风险已记录并带入 M2，**均未修复**：presence 写侧 seam 缺失（M2-P0-2）、
> 注入式 IndexedDB 工厂缺少引用计数（M2-P0-3）。详见
> [`docs/DECISIONS.md`](docs/DECISIONS.md) D-039。

## Transport in one paragraph

One WebSocket at `/ws` carries two planes. **TEXT frames** are the JSON control
protocol (`connected`, `join-room`, `room-joined`, `leave-room`, `presence`,
`error`). **BINARY frames** carry Yjs sync and awareness as raw bytes — never
base64 inside JSON. The framing codec lives in `packages/shared/src/binary-frame.ts`
and is the only place either app may parse frames. Details:
[`docs/CONTRACTS.md`](docs/CONTRACTS.md) §4–§10.

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
