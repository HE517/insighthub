# 中文工作台与本地启动收口

- 分支：`agent/ui-cn`（`cbe7307`）、`agent/ui-cn-a6`（`52fd9d0`），合并入 main
- 范围：`apps/web/**` 中文文案、`scripts/dev.mjs` 统一启动、`tests/browser/**` 证据
- 不含：Clerk 托管组件语言、remote 模型返回内容、生产部署

---

## 1. 本地启动：地址 / 代理 / 允许来源统一

`pnpm dev` 现在由 `scripts/dev.mjs` 启动：

```powershell
pnpm dev
# 或自定义端口
$env:INSIGHTHUB_WEB_PORT='5180'; $env:PORT='3002'; pnpm dev
```

- 打印**唯一**可打开地址：`http://127.0.0.1:<webPort>`
- Vite 监听同一 `INSIGHTHUB_WEB_PORT`
- Vite 的 `/api` `/ws` 代理目标 = `INSIGHTHUB_SERVER_PORT`（默认 `PORT` / 3001）
- 后端 `CORS_ORIGIN` = 同一 `http://127.0.0.1:<webPort>`

**保留**：Origin 校验（外来来源仍 403 `origin_not_allowed`）、会话验证、生产启动 gate（https origin；demo/stub 拒绝等）。

**证据**（`tests/browser/ui-cn-evidence.mjs`，53/53 checks）：

| 项 | 结果 |
| --- | --- |
| 从 launcher 打印的 5190 打开 | 200 |
| demo 会话 / 目录 ready / `新建文档` POST | 201，无 403 |
| WS | `connected`；断线 `reconnecting`；恢复 `connected`；重连写入 durable |
| `Origin: http://evil.example` 写 | **403 `origin_not_allowed`** |
| evil WS upgrade | 403 同 body |
| 第二个 Vite origin（5191） | 403，UI 显示“请求来源被拒绝” |
| 会话失效 | `DELETE /api/session` → 401，目录显示“服务器会话已失效” |
| 非成员文档 | 404 `not_found`，与未知 id 无差别 |
| 本地未知指令 `zzz` | `data-provider-error=unknown-instruction`，中文下一步 + “请选择预设操作” |

截图：`docs/ui/screenshots/ui-cn/01..13`。

---

## 2. 用户可见文案：简体中文

覆盖：

| 区域 | 示例 |
| --- | --- |
| 文档目录 | 文档、可阅读的文档、新建文档、刷新、没有可阅读的文档 |
| 新建 | 新建文档、正在创建…、创建失败/重试 |
| 会话/权限 | 服务器会话已失效、请求来源被拒绝、无权访问或文档不存在、你的角色为只读、角色：所有者/编辑者/评论者/只读查看者 |
| 连接 | 未连接、连接中、已连接、重连中、离线、连接中断 |
| 协作者 | 协作者、只有你在这里、· 你 |
| AI | 询问 AI、指令、生成/正在重新生成、接受/拒绝、差异预览、建议已就绪、已失效、空态 |
| 预设动作 | 转为大写、去除行尾空格、添加待办、替换选区、删除选区 |

**保留**：所有 `data-testid`、`data-*`、错误码、协议字段、ARIA 角色、wire role 值（`owner/editor/commenter/viewer`）。

**预设动作内部值不变**：`data-intent="uppercase"` 等仍写入原指令 token；中文只是 label。
**本地助手**：输入框旁显示“请选择预设操作”（`data-testid="ai-local-hint"`），remote 模式不渲染。
**未知输入**：`unknown-instruction` + 中文下一步提示，引导点击预设操作。

**错误区分**（客户端映射，无新错误码）：

| 真实故障 | 文案方向 |
| --- | --- |
| 403 origin | 请求来源被拒绝；未创建/未改动 |
| 401 | 服务器会话已失效 |
| 403/404 权限 | 无权访问或文档不存在（非泄露） |
| network/offline | 网络已断开；服务器列表不可用 |
| 本地未知指令 | 无法识别该指令；请点预设操作或调整后生成 |

---

## 3. 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **614 vitest + 598 server** |
| `pnpm build` | exit 0 |
| 默认浏览器套件 | **82/82 PASS**（81 + `ui-cn/copy-contract`） |
| launcher/Origin 证据 | **53/53 checks** |

中间失败（78/82）均为旧英文断言：`editor/local-undo-available`、`f1/2`、`b125/1`、`preview/3-security`；逐条改为中文后绿，未放宽功能/权限语义。

---

## 4. 已知限制

- Clerk `<SignIn/>` 文案由 Clerk 控制台决定，未在代码内中文化。
- 既有文档若标题为 `Untitled document`（历史数据）仍原样显示；**新建默认标题已改为“无标题文档”**。
- remote provider 返回的 summary 可能仍是模型语言，不在客户端翻译。
- 未认证 WS 不会因 request-scoped 会话撤销而立即断开（既有行为）。
- 未验证 remote AI 87 场景、Clerk 登录路径、100k 预览（20k 已过）。
