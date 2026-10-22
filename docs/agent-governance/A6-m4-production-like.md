# A6 · M4 B10 — production-like Gate（真实生产构建 + 真实进程）

**Status：** done（1 项平台限制 SKIP，其余全 PASS；无 FAIL）
**Branch：** `agent/a6-b10-production-like`
**Worktree：** `D:\前端\react\项目\面试项目\Insighthub-wt-a6-b10-production`
**Base：** `07e0590`（`docs(m4): B9 done`）
**Commit：** 未提交（只新增测试与报告，未 merge / 未 push / 未打 tag）
**日期：** 2026-10-22

**结论先说。** `node tests/production/run.mjs` 用 `apps/server/dist/index.js` + `apps/web/dist` 启动真实进程，**41 项检查：40 PASS、0 FAIL、1 SKIP**，退出码 0；临时目录已清理，13 个被跟踪子进程全部退出、13 个端口全部关闭。生产模式下的静态托管、健康/就绪、API 404、demo bootstrap 禁用、Origin 403、source map 不发布、7 个启动拒绝场景（6 个 distinct code）全部通过；开发模式下真实 WS hydration、进程重启持久性、`backup.completed`、`backup-cli.ts restore` 恢复演练、损坏库 `DATA_INTEGRITY_FAILED` 全部通过。唯一 SKIP 是 **Windows 无法投递 POSIX `SIGTERM`**（`child.kill('SIGTERM')` 走 `TerminateProcess`，`code=null/signal=SIGTERM`，handler 不执行）；同一真实构建进程的 `SIGTERM` handler 路径由 `process.emit('SIGTERM')` 预加载探针证明退出 0。**没有发现 M4 B10 范围内的真实产品缺陷**；没有修改任何生产源码。

---

## A. 功能结果（每条检查）

运行命令：`node tests/production/run.mjs`（除既有 `yjs` / `ws` / `@insighthub/shared` 外无新依赖）。

### A.1 Production 模式：真实编译进程 + 真实 web build

环境：`NODE_ENV=production`、`AUTH_MODE=clerk`、假 `CLERK_SECRET_KEY`（53 字符，**不是真实 secret**，且不在任何输出中打印）、`CORS_ORIGIN=https://example.test`、绝对 `INSIGHTHUB_DATA_PATH`、`AI_PROVIDER=disabled`、`STATIC_DIR` **未设置**（按 `render.yaml`，验证 `config.ts` 默认解析到 `apps/web/dist`）、`HOST=127.0.0.1`、显式空闲 `PORT`。

| # | Check | 结果 | 关键输出（真实观测） |
| --- | --- | --- | --- |
| 1 | `prod/startup-config` | **PASS** | `nodeEnv=production`、`authMode=clerk`、`dataPath` 绝对、`STATIC_DIR` 未设置但 `server.config.staticDir` 与 `server.static_ready.directory` 都解析为真实 `apps/web/dist`；`server.secret` 报告 `CLERK_SECRET_KEY present=true`、`OPENAI_API_KEY present=false` |
| 2 | `prod/health` | **PASS** | `GET /health -> 200 {"status":"ok"}`，`application/json; charset=utf-8` |
| 3 | `prod/ready` | **PASS** | `GET /ready -> 200 {"status":"ready"}` |
| 4 | `prod/static-shell` | **PASS** | `GET / -> 200`，522 bytes，**逐字节等于** `apps/web/dist/index.html`，含 `<div id="root"></div>` |
| 5 | `prod/static-asset` | **PASS** | `GET /assets/index-I29WxINg.js -> 200`，965995 bytes，`text/javascript; charset=utf-8`；响应头无 sourcemap 字段 |
| 6 | `prod/spa-client-route` | **PASS** | `GET /documents/abc`（`Accept: text/html`）`-> 200`，与构建的 shell 逐字节相同 |
| 7 | `prod/spa-prefix-boundary` | **PASS** | `GET /apiary -> 200`，仍是 SPA shell（`/api` 按路径段保留，不误吞客户端路由） |
| 8 | `prod/api-unknown-json` | **PASS** | `GET /api/unknown`（即使 `Accept: text/html`）`-> 404 {"error":"not_found"}`，`application/json`，不是 shell |
| 9 | `prod/bootstrap-disabled` | **PASS** | `POST /api/session/bootstrap`（允许 Origin）`-> 404 {"error":"not_found"}`，无 `set-cookie` |
| 10 | `prod/bootstrap-bad-origin` | **PASS** | 同一请求带 `Origin: https://evil.example` `-> 403 {"error":"origin_not_allowed"}`，无 CORS 头、无 cookie |
| 11 | `prod/sourcemap-not-served` | **PASS** | `GET /assets/ClerkRoot-Boz-CVvj.js.map -> 404 {"error":"not_found"}`（21 bytes）；body 不含 `sourcesContent` / `sources` / `mappings` |
| 12 | `prod/sourcemap-html-no-leak` | **PASS** | 同一 `.js.map` 带 `Accept: text/html` `-> 200`，body 是已知 shell，不含 map 内容 |
| 13 | `prod/ws-bad-origin` | **PASS** | `/ws` upgrade（`Origin: https://evil.example`）`-> HTTP 403 {"error":"origin_not_allowed"}`，未建立 socket |
| 14 | `prod/ws-no-session` | **PASS** | `/ws` upgrade（允许 Origin、无 cookie）`-> HTTP 401 {"error":"session_required"}`，未建立 socket |
| 15 | `prod/api-session-no-cookie` | **PASS** | `GET /api/session -> 401 {"error":"session_required"}` |
| 16 | `prod/log-no-secret` | **PASS** | 扫描该进程全部 stdout/stderr（26 行），假 secret 与 `CLERK_SECRET_KEY=` 均未出现 |

### A.2 Production 启动拒绝：7 个真实子进程

每个场景都是独立进程；断言 **exit 1 + 稳定码 + 无 `server.listening` + 端口关闭**。

| # | Check | 注入配置 | 期望码 | 实际结果 |
| --- | --- | --- | --- | --- |
| 17 | `prod/refuse-demo-auth` | `NODE_ENV=production` + `AUTH_MODE=demo` | `DEMO_AUTH_IN_PRODUCTION` | **PASS**：exit 1，code，no listener（port 26990 closed） |
| 18 | `prod/refuse-clerk-secret` | `AUTH_MODE=clerk`，删除 `CLERK_SECRET_KEY` | `CLERK_SECRET_KEY_MISSING` | **PASS**：exit 1，code，no listener（26992） |
| 19 | `prod/refuse-cors-origin` | `CORS_ORIGIN=http://localhost:5173` | `CORS_ORIGIN_INVALID` | **PASS**：exit 1，code，no listener（26994） |
| 20 | `prod/refuse-relative-data` | `INSIGHTHUB_DATA_PATH=a6-b10-relative-data` | `DATA_PATH_INVALID` | **PASS**：exit 1，code，no listener（26996） |
| 21 | `prod/refuse-ai-stub` | `AI_PROVIDER=stub` | `AI_PROVIDER_STUB_FORBIDDEN` | **PASS**：exit 1，code，no listener（26998） |
| 22 | `prod/refuse-static-missing` | `STATIC_DIR` 不存在 | `STATIC_DIR_MISSING` | **PASS**：exit 1，code，no listener（27000）；日志先有 `server.store_ready`/`server.authz_ready`，符合“store/authz 后、listen 前” |
| 23 | `prod/refuse-static-no-index` | `STATIC_DIR` 存在但无 `index.html` | `STATIC_DIR_MISSING` | **PASS**：exit 1，code，no listener（27002） |

### A.3 DEV 模式：持久性 / 备份 / 恢复（**不是 production 证据**）

环境：`NODE_ENV=test`、`AUTH_MODE=demo`、绝对 `INSIGHTHUB_DATA_PATH`、`BACKUP_ENABLED=true`、`BACKUP_DIR` 绝对路径、`BACKUP_RETENTION_DAYS=7`、`AI_PROVIDER=disabled`。

| # | Check | 结果 | 关键输出 |
| --- | --- | --- | --- |
| 24 | `dev/seed-store` | **PASS** | 用编译后的 `openDocumentStore` 写入 `demo-document`：`append seq=1`，71-byte Yjs update；读回 1 条 update |
| 25 | `dev/bootstrap-demo` | **PASS** | `POST /api/session/bootstrap -> 200 {"userId":"demo-ada",...}`；`Set-Cookie` 含 `HttpOnly; SameSite=Lax; Max-Age=43200` |
| 26 | `dev/http-document-list` | **PASS** | `GET /api/documents -> 200`，`{"id":"demo-document","revision":1,"ownerId":"demo-ada",...}` |
| 27 | `dev/http-document-get` | **PASS** | `GET /api/documents/demo-document -> 200`，同一 metadata |
| 28 | `dev/ws-hydration` | **PASS** | 真实 WS `join-room` + 客户端 `SyncStep1`：`room-joined role=owner`，收到 1 个 binary frame、apply 1 update，文本逐字等于 seed |
| 29 | `dev/backup-completed` | **PASS** | `backup.completed insighthub-2026-10-22T15-18-23.175Z-1.db bytes=40960`；文件存在且 `stat.size == event.bytes > 0` |
| 30 | `dev/sigterm-exit0` | **SKIP（平台限制）** | Windows：`child.kill('SIGTERM')` 实测 `code=null, signal=SIGTERM`，未执行 handler；POSIX 上此检查断言 exit 0 |
| 31 | `dev/port-closed` | **PASS** | 停止后端口 closed |
| 32 | `dev/restart-http` | **PASS** | 同一 data dir 第二个真实进程：`GET /api/documents -> 200`，revision 仍为 1 |
| 33 | `dev/restart-hydration` | **PASS** | 重启后 WS hydration 文本与 seed 逐字相同（1 update applied） |
| 34 | `dev/restore-cli` | **PASS** | `node --import tsx src/persistence/backup-cli.ts restore ...` `-> exit 0`；`restored=...\restored-data\insighthub.db bytes=40960` |
| 35 | `dev/restore-store-read` | **PASS** | 新目录上用 `openDocumentStore` 读回：snapshot 0 bytes + 1 update，文本逐字相同 |
| 36 | `dev/restore-server-http` | **PASS** | 恢复目录再启真实进程：bootstrap 200，`GET /api/documents` 返回同一 document |
| 37 | `dev/restore-server-hydration` | **PASS** | 恢复目录进程的 WS hydration 文本逐字相同 |

### A.4 损坏库 / 优雅关闭 / 泄漏

| # | Check | 结果 | 关键输出 |
| --- | --- | --- | --- |
| 38 | `dev/corrupt-fixture` | **PASS** | 先建合法 store，再向 `insighthub.db` 写入 57 bytes 垃圾 |
| 39 | `dev/corrupt-db-refused` | **PASS** | `exit 1`、stderr `refusing to start: DATA_INTEGRITY_FAILED`、无 `server.listening`、端口关闭、损坏文件字节未被改写 |
| 40 | `dev/graceful-handler-exit0` | **PASS** | 真实编译进程经 `process.emit('SIGTERM')` 调用自身 handler：`exit 0`，`server.shutdown signal=SIGTERM`，端口关闭。**这是 handler 证据，不是 OS signal 证据** |
| 41 | `cleanup/no-leaked-process` | **PASS** | 13 个被跟踪子进程全部退出；13 个端口全部 closed；最终 `temp cleaned: D:\dev-temp\insighthub-a6-b10-EjS5eo` |

> 说明：`dev/sigterm-exit0` 的 SKIP 已在概要中计数；脚本在 `win32` 上仍真实发送 `SIGTERM` 并用随后的重启证明“进程被终止后数据仍在”，只是不把 `TerminateProcess` 说成“graceful exit 0”。

---

## B. Files

只新增两个测试文件和本报告；**未修改** `apps/server/**`、`apps/web/**`、`packages/shared/**`、`docs/CONTRACTS.md`、`docs/DECISIONS.md`、`package.json`。

| 文件 | 职责 |
| --- | --- |
| `tests/production/run.mjs` | B10 Gate 本体：preflight（构建产物/端口/临时目录）、真实进程管理器（stdout/stderr 解析、SIGTERM/force-kill、退出码）、HTTP/WS 客户端、41 项检查、PASS/FAIL/SKIP 汇总、非零退出与 finally 清理 |
| `tests/production/lib/emit-sigterm-after-ready.mjs` | 仅测试用 preload：在真实 `dist/index.js` 进程内轮询 `/ready`，再 `process.emit('SIGTERM')`，用于 Windows 下证明产品自身 shutdown handler 退出 0；不修改产品代码 |
| `docs/agent-governance/A6-m4-production-like.md` | 本报告 |

依赖复用：`tests/browser/lib/deps.mjs`（只读 import，用来按 ESM `import` 条件解析既有 `yjs` / `ws` / `@insighthub/shared`）；没有新增 package 或依赖。脚本可用 `node tests/production/run.mjs` 直接运行，`--keep-temp` 可保留临时目录排障。

---

## C. Acceptance Criteria

| 任务要求 | 结果 | 证据 |
| --- | --- | --- |
| 可重复脚本，无新依赖，直接 `node tests/production/run.mjs` | **PASS** | 最终运行 exit 0；`--keep-temp` 可选；只 import 既有包 |
| 使用真实 `pnpm build` 产物（`dist/index.js` + `apps/web/dist`）启真实进程 | **PASS** | `preflight` 强制检查 `apps/server/dist/index.js`、`apps/web/dist/index.html`、真实 JS/Map；所有服务进程均为 `node apps/server/dist/index.js`；主生产进程不设 `STATIC_DIR`，验证默认路径 |
| 预检端口/临时目录；结束清理（含 SIGTERM），失败也清理 | **PASS** | preflight 分配并验证 6 个主端口；7 个拒绝场景各自再分配/验证空闲端口，共 13 个；run1/run2 失败时也打印 `temp cleaned`；最终 `cleanup/no-leaked-process` 13/13 端口 closed、13/13 进程退出 |
| 每个 check 输出 PASS/FAIL，非零退出表示失败 | **PASS** | 最终 `SUMMARY checks=41 pass=40 fail=0 skip=1`，exit 0；脚本 `failed>0 || fatal` → exit 1 |
| Production：`/health` 200；`/ready` 200 `{"status":"ready"}` | **PASS** | `prod/health`、`prod/ready` |
| `GET /` 返回构建 index.html（含 `<div id="root">`） | **PASS** | 522 bytes，逐字节等于 dist index |
| `GET /assets/*.js` content-type javascript | **PASS** | `text/javascript; charset=utf-8` |
| `GET /documents/abc` 返回同样 shell | **PASS** | 逐字节相同 |
| `GET /api/unknown` → 404 JSON（非 shell） | **PASS** | `{"error":"not_found"}` |
| `POST /api/session/bootstrap` → 404（生产禁用 demo） | **PASS** | 404，无 cookie |
| 非法 Origin 的 bootstrap → 403 `origin_not_allowed` | **PASS** | 403，无 CORS 头/cookie |
| 无 `.map`/源码泄漏（存在 `.js.map` 请求为 404 或 shell，不含 `sourcesContent`） | **PASS** | 404 JSON 21 bytes；`sourcesContent present: false`；HTML 请求得 shell |
| 启动拒绝：demo/缺 secret/CORS localhost/相对 data/stub/缺 STATIC_DIR/无 index | **PASS（7/7）** | 见 A.2；全部 exit 1 + 稳定码 + 无 listener |
| Dev：demo bootstrap 200 + cookie；写入种子文档 | **PASS** | A.3 #24/#25；`HttpOnly; SameSite=Lax` |
| 重启持久性：HTTP + WS hydration 读到相同内容 | **PASS** | A.3 #26/#28/#32/#33 |
| SIGTERM 断言 exit 0 | **SKIP（仅 win32 平台限制）** | 实测 `code=null, signal=SIGTERM`；handler 路径另由 `dev/graceful-handler-exit0` exit 0 证明；POSIX 上脚本断 exit 0 |
| 备份：30s 内 `backup.completed`、文件 >0 | **PASS** | 40960 bytes，`stat.size == event.bytes` |
| 恢复演练：`backup-cli.ts restore` 到新目录，`openDocumentStore` 读到同一内容 | **PASS** | restore exit 0；store 与重启后的真实进程都读出同一文本 |
| 损坏库：exit 1 + `DATA_INTEGRITY_FAILED` | **PASS** | A.4 #39 |
| 非法 Origin WS upgrade → 403 无 socket | **PASS** | A.1 #13（production）；dev 同样受 origin guard，本 Gate 选用 production 证明 |
| 门禁 `pnpm typecheck && pnpm test && pnpm build` 绿 | **PASS** | 见 E；typecheck 0、test 0（542 + 453）、build 0 |
| `node tests/production/run.mjs` 全 PASS | **PASS（40 PASS / 0 FAIL / 1 SKIP）** | SKIP 是 Windows POSIX signal 限制，不是产品失败；详见 F/G |
| 不改生产源码/契约/package.json | **PASS** | `git status` 仅 `?? tests/production/` 与本报告 |

---

## D. Evidence

### D.1 最终命令与退出码

```text
$ pnpm typecheck
... apps/server typecheck: Done / apps/web typecheck: Done
EXIT=0

$ pnpm test
Test Files  50 passed (50)
Tests       542 passed (542)

# tests 453
# suites 140
# pass 453
# fail 0
# duration_ms 61136.072
TEST_EXIT=0

$ pnpm build
dist/assets/index-I29WxINg.js 966.07 kB ... ✓ built in 4.02s
BUILD_EXIT=0

$ node tests/production/run.mjs
SUMMARY checks=41 pass=40 fail=0 skip=1
RESULT: PASS (with platform-limited skips — see above)
RUN_EXIT=0
```

### D.2 Production HTTP（真实进程、真实端口）

```text
GET /health                         -> 200 {"status":"ok"}                 application/json
GET /ready                          -> 200 {"status":"ready"}             application/json
GET /                               -> 200 522 bytes, identical to dist  text/html
GET /assets/index-I29WxINg.js       -> 200 965995 bytes                  text/javascript
GET /documents/abc                  -> 200 same shell bytes               text/html
GET /apiary                         -> 200 same shell bytes               text/html
GET /api/unknown                    -> 404 {"error":"not_found"}          application/json
POST /api/session/bootstrap         -> 404 {"error":"not_found"}          no set-cookie
POST /api/session/bootstrap (evil)  -> 403 {"error":"origin_not_allowed"} no CORS/cookie
GET /assets/ClerkRoot-...js.map     -> 404 {"error":"not_found"}          body 21 bytes
GET /assets/ClerkRoot-...js.map     -> 200 shell bytes (Accept: text/html)
GET /ws (evil Origin)               -> 403 {"error":"origin_not_allowed"} no socket
GET /ws (allowed, no cookie)        -> 401 {"error":"session_required"}   no socket
GET /api/session                    -> 401 {"error":"session_required"}
```

### D.3 启动拒绝（真实子进程）

```text
prod/refuse-demo-auth:
  exit 1, stable code DEMO_AUTH_IN_PRODUCTION, no listener on 26990
  {"event":"server.refused","code":"DEMO_AUTH_IN_PRODUCTION","message":"refusing to start: DEMO_AUTH_IN_PRODUCTION"}
prod/refuse-clerk-secret:
  exit 1, stable code CLERK_SECRET_KEY_MISSING, no listener on 26992
prod/refuse-cors-origin:
  exit 1, stable code CORS_ORIGIN_INVALID, no listener on 26994
prod/refuse-relative-data:
  exit 1, stable code DATA_PATH_INVALID, no listener on 26996
prod/refuse-ai-stub:
  exit 1, stable code AI_PROVIDER_STUB_FORBIDDEN, no listener on 26998
prod/refuse-static-missing:
  exit 1, stable code STATIC_DIR_MISSING, no listener on 27000
prod/refuse-static-no-index:
  exit 1, stable code STATIC_DIR_MISSING, no listener on 27002
```

所有拒绝进程 `process.exit={"code":1,"signal":null}`，且日志中无 `server.listening`。

### D.4 DEV 持久性 / 备份 / 恢复（再次强调：不是 production 证据）

```text
append seq=1, 71 bytes; read back 1 update(s)
POST /api/session/bootstrap -> 200 {"userId":"demo-ada",...}
GET /api/documents -> 200 {"id":"demo-document","revision":1,"ownerId":"demo-ada",...}
room-joined role=owner; 1 binary frame(s), 1 applied
hydrated text: "# M4 B10 durable document\n\nA6-B10-DURABLE-mvjor9hv\n"

backup.completed insighthub-2026-10-22T15-18-23.175Z-1.db bytes=40960
file exists and is non-empty (40960 bytes)

restart: GET /api/documents -> 200 revision=1
restart: room-joined role=owner; hydrated 1 update(s) after restart
restart text: "# M4 B10 durable document\n\nA6-B10-DURABLE-mvjor9hv\n"

backup-cli.ts restore -> exit 0:
  restored=D:\dev-temp\insighthub-a6-b10-EjS5eo\restored-data\insighthub.db bytes=40960
restored store: snapshot=0 bytes, updates=1, text matches
restored process GET /api/documents -> 200 (same document)
restored room-joined role=owner; 1 update(s) applied
restored text: "# M4 B10 durable document\n\nA6-B10-DURABLE-mvjor9hv\n"
```

### D.5 损坏库 / 优雅关闭 / 清理

```text
wrote 57 garbage bytes over insighthub.db
exit 1, DATA_INTEGRITY_FAILED, no listener, file unchanged
{"event":"server.refused","code":"DATA_INTEGRITY_FAILED","message":"refusing to start: DATA_INTEGRITY_FAILED"}

exit 0 after process.emit("SIGTERM"); server.shutdown signal=SIGTERM; port closed
stdout events: server.config, server.secret, server.secret, server.store_ready,
               server.authz_ready, server.static_ready, server.auth_ready,
               server.ai_ready, server.listening, server.shutdown

13 child process(es) tracked; all exited; 13 port(s) closed
temp cleaned: D:\dev-temp\insighthub-a6-b10-EjS5eo
```

### D.6 Windows SIGTERM 实测

```text
[SKIP] dev/sigterm-exit0
  Windows cannot deliver POSIX signals: the child was terminated by
  TerminateProcess (code=null, signal=SIGTERM); the handler path is covered by
  dev/graceful-handler-exit0

实测：child.kill('SIGTERM') => signal SIGTERM, exit code null, handler 未执行
```

这是 host 平台事实，不是产品行为失败。生产线上（Linux/Render）脚本会自动走 `assert code === 0` 分支。

---

## E. Regression

| 命令 | 退出码 | 真实结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 303 packages，lockfile up to date |
| `pnpm typecheck` | 0 | shared / server / web 全部 Done |
| `pnpm test` | 0 | vitest **50 files / 542 tests passed**；server **453 tests / 140 suites passed, fail 0** |
| `pnpm build` | 0 | shared + server tsc + web vite 成功；仅有既有 >500 kB chunk 警告（非本 Gate 引入） |
| `node tests/production/run.mjs` | 0 | 41 checks：40 PASS、0 FAIL、1 SKIP；临时目录清理 |

回归面：本任务只新增 `tests/production/**` 与本报告，没有改任何生产文件；因此 542/453 的既有测试基线和构建产物路径未受影响。Browser suite（CDP/IndexedDB/真实 UI）**未在本轮运行**，因为它不在 B10 的最小 gate 内，且 B10 目标是 Node 侧真实进程；该证据留给 B11/B13 的 deployed smoke。

---

## F. Residual（未覆盖 / 只能在后续批次验证）

1. **POSIX `SIGTERM` graceful exit 0 未在 Windows 验证。** 真实 OS 信号在 win32 不可投递；handler 路径已用 `process.emit` 探针证明 exit 0，但这不等同于 Linux 的 `kill -TERM`。B11/Render 或 Linux CI 上重跑同一脚本即可自动断言 `exit 0`。
2. **真实 Clerk 登录/会话验证未覆盖。** 本 Gate 只使用假 secret 且不带真实 Clerk cookie；证明的是“clerk 模式配置可启动 + 无 cookie 时 401 fail closed”。真实 sign-in、Cookie 轮换、JWKS/网络失败、logout/revocation 需要 B11/B13。
3. **真实 OpenAI 未覆盖。** `AI_PROVIDER=disabled`；B12 才做 opt-in live smoke，且不得替代确定性 gate。
4. **Render 部署未覆盖。** TLS 终止 / `trust proxy=1` 的真实 `X-Forwarded-Proto`、持久盘挂载、绝对路径 `/var/data`、Render health check、custom domain 属于 B11。
5. **24h nightly cadence / 7 天 retention 未按真实时间验证。** 本轮证明的是启动 catch-up tick 立即产生 `backup.completed`、文件非空、restore drill 可恢复；没有等待 24h，也没有跨 7 天验证 prune（B8 的单元/集成测试覆盖 prune 规则）。
6. **磁盘满 / `DATA_DISK_LOW` / `DATA_SCHEMA_TOO_NEW`** 不在 B10 的必需清单内；由 B6 的 server tests 覆盖，未在本真实进程 Gate 中重复。
7. **浏览器 UI / IndexedDB / 真实 CodeMirror 绑定** 未在 Node Gate 中覆盖；B11/B13 的 browser/deployed smoke 负责。
8. **CDN/反向代理层** 是否额外暴露 `.map` 未验证；本 Gate 只证明 Express 同源进程不发布 `.map`。
9. **单实例假设**：所有证据来自单进程 + 单 SQLite；V1 明确不覆盖 HA/多实例（D-082 D2）。
10. **临时目录在失败路径的清理** 已由 run1/run2 的失败输出证明（`temp cleaned`），但 Windows 文件句柄偶尔会延迟释放；脚本用重试 + 最后告警处理，最坏情况会保留一个临时目录而不掩盖检查结果。

---

## G. Next Handoff: A0

**需要 A0 决策的具体点：** 是否接受“B10 在 Windows 上 40 PASS + 1 SKIP（POSIX SIGTERM）”并进入 B11；还是要求先在 Linux/WSL/CI 上重跑 `node tests/production/run.mjs` 把 `dev/sigterm-exit0` 变成真实 PASS。A6 推荐：**接受当前证据并进入 B11**，同时在 B11 staging/Linux 环境重跑同一脚本作为 SIGTERM 的补证——因为 B11 本身就需要 Linux/Render，重复成本最低，且 handler 路径已在真实编译进程中证明。

```text
Handoff Status:
OWNER_DECISION_REQUIRED

Recommended Next Agent:
A0

Base:
agent/a6-b10-production-like @ 07e0590   ← 未提交；只新增 tests/production/** 与本报告

Why:
B10 的 production-mode 静态托管/健康/Origin/拒绝码与 dev-mode 重启/备份/恢复/损坏库
已在真实构建 + 真实进程上通过；唯一 SKIP 是 Windows 无法投递 POSIX SIGTERM，
需要 A0 决定是否接受并在 B11 Linux/Render 补跑。

Dependencies satisfied:
- 真实 `pnpm build` 产物（apps/server/dist/index.js + apps/web/dist）
- `pnpm typecheck` / `pnpm test`（542 + 453）/ `pnpm build` 全绿
- `node tests/production/run.mjs` exit 0（40 PASS / 0 FAIL / 1 platform SKIP）
- 未修改任何生产源码、契约、package.json
- 临时目录与全部子进程已清理

Copy-paste Prompt:
A0：请裁决 B10 的 Windows SIGTERM SKIP。若接受，派 B11（Render staging）并在
Linux/Render 上重跑 `node tests/production/run.mjs`，要求 `dev/sigterm-exit0` 由
SKIP 变为 PASS；若不接受，先安排 Linux/WSL/CI 环境由 A6 重跑同一脚本并提交证据。
不要修改生产源码来“修复”平台差异。
```

### Supervisor Decision（选项与推荐）

| 选项 | 影响 | 推荐 |
| --- | --- | --- |
| A. 接受 Windows 40 PASS + 1 SKIP，进入 B11，并在 Linux/Render 重跑 Gate 补 POSIX SIGTERM | 不阻塞 staging；把平台差异放到真实部署环境关闭 | **推荐** |
| B. 要求先有 Linux/WSL/CI 的 SIGTERM PASS 再进 B11 | 更严格，但当前 Windows worktree 无法自证，可能额外等待环境 | 备选 |

### 给项目负责人的总结

B10 之前，M4 的 production 行为主要靠单元/集成测试与代码审查支撑，缺少“用真实生产构建启动真实进程”的证据。现在 `tests/production/run.mjs` 把这条证据链补上了：生产模式真的从 `dist/index.js` 启动、真的提供 SPA 与 API、真的拒绝 demo/config/非法 Origin；开发模式真的写库、真的重启、真的做备份恢复与损坏库拒绝。最终 41 项检查 40 PASS / 0 FAIL / 1 SKIP，唯一 SKIP 是 Windows 没有 POSIX SIGTERM，而不是产品行为失败；同一进程的 shutdown handler 已证明 exit 0。结论是 B10 可以收口，但“生产就绪”仍需 B11 的真实 Render 部署与 B12/B13 的 live smoke 来关闭剩余 residual。
