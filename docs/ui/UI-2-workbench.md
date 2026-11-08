# UI-2 工作台重组 — 交付与收口（A0）

- **分支**：`agent/ui-2-workbench` → 合并入 main（基线 `62b39d3`）
- **收口修复 SHA**：见本轮最终提交（含创建竞态修复与新增场景）
- **状态**：`IMPLEMENTED`；默认套件 `PASS`（78 原有 + 3 新增 = **81**）
- **不含**：版本历史、成员管理、真实模型 live、移动端重做、429 专门文案

---

## 1. 组件边界与状态所有者（改后）

```text
App
└── AppShell (topbar: brand / document switcher / identity)
    └── DocumentWorkspace   key={activeDocumentId}   ← 切文档销毁旧会话
        ├── DocumentHeader   (title, mode switch, undo/redo, status, collaborators, role, ai-open)
        ├── doc-notices      (offline, read-only, undo-state, resync)
        └── workbench (grid)
            ├── aside.doc-rail        AiDirectory (唯一实例；GET /api/documents)
            ├── div.doc-stage         DocumentCanvas
            │   ├── CollaborativeMarkdownEditor  (始终挂载；预览时 hidden)
            │   └── MarkdownPreview              (仅预览挂载；从 Y.Text 派生)
            └── aside.doc-assistant   AiSuggestPanel (仅 aiOpen 时挂载；关闭即卸载)
```

| 状态 | 所有者 | 进 Redux | 说明 |
| --- | --- | --- | --- |
| 正文 | `Y.Text` | 否 | 唯一事实源，未变 |
| activeDocumentId / pendingDocumentId | Redux `document` | 是 | 切换仍走 `documentSelected` |
| 连接 / role / collaborators | CollaborativeSession → props | 否 | 服务端裁决 |
| mode / aiOpen | DocumentWorkspace state | 否 | 与改造前一致 |
| 目录列表/加载/错误 | AiDirectory state | 否 | **单实例**；不再随面板开关 mount |
| AI 提案/phase/diff/stale | AiSuggestPanel state | 否 | 关闭即丢弃（原语义） |

**生命周期**：`key={activeDocumentId}` 保留；目录与 AI 面板都在 key 内，所以切文档仍销毁旧会话、旧目录请求、旧提案；EditorView 在编辑/预览切换中不卸载。

## 2. 改了什么

1. **三栏布局**：目录左栏、文档中栏、AI 审阅右栏（打开时三栏，关闭时两栏）。
2. **目录搬位**：`AiDirectory` 从 `AiSuggestPanel` 移到 `DocumentWorkspace` 左栏；面板不再挂目录，避免两个实例/两次请求。
3. **目录刷新**：`refreshKey={status}`，会话就绪后重载一次（join 后才创建文档元数据，否则列表不含当前文档）。
4. **AI 面板**：成为右栏；关闭后焦点回到 `ai-open`；`onSelectDocument` 保留但不再使用。
5. **视觉**：纸白 `#fcfcfa`、深绿 `#24543e`、边框 `#daddd4`、衬线标题；旧蓝色 accent 全部替换。
6. **响应式**：≥1180px 三栏；1180px 以下目录+文档、AI 下移；760px 以下单列、目录限高 220px。

## 3. 收口修复：创建竞态（IMPORTANT）

**现象**：`POST /api/documents` 已发出、响应被延迟时，同一文档的 WS 状态变化（connected → reconnecting → connected）会让目录 effect 重跑；旧 cleanup 同时 `flowRef.abort()`，把这次创建当作“已离开”取消。服务端创建成功，客户端却把它报告为 `ignored`，工作区不切换。

**根因**：列表刷新生命周期与创建生命周期绑在同一个 `useEffect` 的 cleanup 上；`refreshKey` 变化 = 一次列表刷新，却误伤了创建。

**修复**：
- 列表 effect（依赖 `[load, refreshKey]`）只取消**列表**请求；
- 创建 flow 的取消移到**仅卸载**的 effect（`[]`），只在文档切换/workspace remount 时中止。

**验证**（`tests/browser/suite/35-ui2-directory-race.mjs`）：
- `ui2/1`：CDP 持有 POST 响应 → 同文档断线/重连 → 释放；**只发一次 POST**、创建成功并切换、目录恰好一行 current、无错误。
- `ui2/2`：POST 持有期间切到文档 B → 释放迟到响应；工作区仍在 B，不跳回。
- 创建失败保留当前文档：复用 `b125/2`（未重复）。
- **修复前失败证据**：同一 `ui2/1` 在旧 effect 下报 `the workspace did not switch away …`（超时）；修复后 PASS。两次运行都已记录在 CI 日志/报告。

## 4. 测试变更（没有删除断言）

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `aiPanelRemote.test.ts` | `toContain(ai-directory)` → `not.toContain` | 目录已移出面板；防止面板再挂目录导致重复请求；浏览器套件覆盖左栏。 |
| `08-evidence-gate.mjs` | `directoryPresent=false` → `ai-panel===null`（两处） | 目录常驻，原断言用目录存在性推断面板关闭；改为直接断言面板。 |
| `32-design-fidelity.mjs` | accent/accentSoft/resting border 常量改为绿系 token | 视觉变更；断言形状不变。 |
| `32b-m4-b125.mjs` | 仅增加 `ids` 证据字段 | 诊断；断言不变。 |
| 新增 `35-ui2-directory-race.mjs` | 3 个场景 | 创建竞态 2 个 + 编辑器表面稳定性 1 个。 |

## 5. 证据

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **608 passed**；server **500 passed** |
| `pnpm build` | exit 0 |
| 默认浏览器套件 | **81/81 PASS**（78 原有 + `ui2/1`、`ui2/2`、`ui2/3`） |
| 截图 | `docs/ui/screenshots/before/`、`after/`（desktop-editor / desktop-ai / desktop-preview / narrow） |

### 5.1 输入延迟（原始记录核对）

门禁口径为页面内“输入到下一帧”的 **P50**；三次运行都是 `results.input.nextFrame.p50`，不是 `model.p50`。

| 记录 | commit | Chrome | 模式 | n | next-frame P50 | next-frame Max | ready |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `.git/ui2-before-perf.json` | `62b39d3` | 157.0.8103.38 | build（Express static） | 300 | **373.4 ms** | 750.0 ms | 993 ms |
| `.git/ui2-perf.json` | `abc4b00` | 157.0.8103.38 | build | 300 | **396.4 ms** | 887.0 ms | 1053 ms |
| `.git/ui2-after-perf2.json` | `abc4b00` | 157.0.8103.38 | build | 300 | **327.4 ms** | 599.0 ms | 857 ms |

- 两次改后运行相对改前的 P50 变化：**+6.2%** 与 **−12.3%**；门禁“恶化 ≤10%” **PASS**。
- 只报告测得值，不对差异做“机器负载/噪声范围”归因（无证据支持）。
- `abc4b00` 是 UI-2 分支提交；合并后的代码相同（`c53323c`）。本轮收口修复只改目录 effect 与测试，不触及输入路径；未重跑计时，标记 `NOT VERIFIED`（收口 SHA 的输入延迟）。

## 6. 429 / 限额与服务故障能否区分？

**当前 UI 不能区分。** 证据：

- 服务端：限额拒绝是 `429 {"error":"rate_limited"}` + `Retry-After`，与 `502/503/504` 分开（`apps/server/src/ai/route.ts:313-319`）。
- 客户端：`remoteProvider.ts` 的 `RemoteProviderFailure` **没有 429/rate-limited 类型**；`provider` 覆盖“502、其他 HTTP 失败或端点不可达”。因此 `describeProviderFailure` 把 429 显示为通用的 “The AI provider failed to generate a suggestion.”，与真正的服务故障同一文案。

**结论**：`NOT IMPLEMENTED`（UI 不能区分）。这是已知缺口，不在 UI-2 收口内新增行为；列入路线图 P1/P2 候选。

## 7. 视觉采纳核对（以截图为准）

| 项 | 改前（before 截图） | 改后（after 截图） | 说明 |
| --- | --- | --- | --- |
| 主色 | 蓝 `#3977e9` | 深绿 `#24543e` | 已替换全部硬编码蓝值 |
| 布局 | 单列居中 1040px；目录在 AI 面板内 | 236px 目录 + 文档 + 340px AI（打开时） | 三栏 |
| 目录 | 打开 AI 才出现 | 常驻左栏，含 New document / Refresh / 当前项 | 单实例 |
| 标题 | 主标题较小、无衬线 | 衬线、绿系 | 视觉 |
| 窄屏 | 基础窄屏 | 1180/760 两级堆叠；390px 单列 | 可用性，不是原型抽屉 |

**未采纳**：原型的三篇样本文档、固定姓名“林舟”、所有者文案、保存承诺、模拟邀请、规则化假 AI、textarea、localStorage 历史栈。

**注意**：after 截图里文档标题/目录行显示的是文档 id（`ui-capture-doc` / `demo-document`），因为客户端未读 `document_meta.title`；这是数据限制，不是设计目标。

## 8. 键盘焦点与编辑器表面

- **关闭助手后的焦点**：`ui2/3` 断言 `document.activeElement` 为 `ai-open`（PASS）。
- **助手开关期间的 EditorView / 选区**：`ui2/3` 断言同一 `viewId`、anchor/head 不变（PASS）。
- **窗口宽度变化**：1024×768 → 1440×900 后同一 `viewId`、anchor/head、Undo 可用性不变，且恰好一个 `.cm-editor`（PASS）。
- **Undo**：上述往返后点击 Undo 能撤销输入的字符（PASS）。
- **滚动**：本次场景未制造可滚动编辑器（内容短，页面滚动）；沿用 `preview/1` 已注入 `max-height` 后验证的 600→600 证据，不重复。

## 9. 已知限制 / 残余风险

- 没有成员管理 UI（无服务端接口）；标题仍显示 id；目录外部变更需手动 Refresh。
- 429 与 provider 故障在前端不可区分（§6）。
- 100k Preview 仍为 420s 未 ready 的已知限制。
- 窄屏仅堆叠，未做原型的目录抽屉/助手底部面板。
- Clerk 生产模式未验证；收口 SHA 的输入延迟未重测（`NOT VERIFIED`）。
- 创建竞态修复只覆盖“同文档刷新”与“切走”两种时序；更长的网络暂停/多次状态抖动未单独压测。
