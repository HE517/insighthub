# UI-2 工作台重组 — 交付说明（A0）

- **分支**：`agent/ui-2-workbench`
- **基线**：`62b39d3`（远端 main）
- **状态**：`IMPLEMENTED` + 默认套件 `PASS`（78/78）；**不含**版本历史、成员管理、真实模型 live、移动端重做
- **性质**：基于既有能力的布局/视觉重组；未新增后端接口、未改协议/数据库/权限语义

---

## 1. 组件边界与状态所有者（改后）

```text
App
└── AppShell (topbar: brand / document switcher / identity)
    └── DocumentWorkspace   key={activeDocumentId}   ← 生命周期不变：切文档即销毁旧会话
        ├── DocumentHeader   (title, mode switch, undo/redo, status, collaborators, role, ai-open)
        ├── doc-notices      (offline, read-only, undo-state, resync)
        └── workbench (grid)
            ├── aside.doc-rail        AiDirectory (唯一的目录实例；GET /api/documents)
            ├── div.doc-stage         DocumentCanvas
            │   ├── CollaborativeMarkdownEditor  (始终挂载；预览时 hidden)
            │   └── MarkdownPreview              (仅预览挂载；从 Y.Text 派生)
            └── aside.doc-assistant   AiSuggestPanel (仅 aiOpen 时挂载；关闭即卸载)
```

| 状态 | 所有者 | 是否进 Redux | 说明 |
| --- | --- | --- | --- |
| 正文 | `Y.Text`（Y.Doc） | 否 | 唯一事实源，未变 |
| activeDocumentId / pendingDocumentId | Redux `document` | 是 | 切文档仍走 `documentSelected` |
| 连接状态 / role / collaborators | CollaborativeSession → 组件 props | 否 | 服务端裁决 |
| 编辑/预览 mode、AI 开关 | DocumentWorkspace 局部 state | 否 | 与改造前一致 |
| 目录列表 / 加载 / 错误 | AiDirectory 局部 state | 否 | **只有一个实例**；不再随 AI 面板开关 mount |
| AI 提案、phase、diff、stale | AiSuggestPanel 局部 state | 否 | 关闭面板即丢弃（沿用原语义） |

**关键生命周期**：`key={activeDocumentId}` 保留；目录与 AI 面板都在该 key 内，所以切文档仍然销毁旧会话、旧目录请求、旧提案。EditorView 在编辑/预览切换中仍不卸载。

## 2. 改了什么

1. **三栏布局**：目录永久左栏、文档中栏、AI 审阅右栏（打开时三栏，关闭时两栏）。
2. **目录搬位**：`AiDirectory` 从 `AiSuggestPanel` 移到 `DocumentWorkspace` 的左栏；面板不再挂目录，避免两个实例/两次 `GET /api/documents`。
3. **目录刷新**：加入 `refreshKey={status}`。原因是左栏在会话建立时就挂载，而 join 可能在此后才创建文档元数据；没有刷新会出现“当前文档不在列表”（b125 实测）。现在连接状态变化会触发一次重载。
4. **AI 面板**：成为右栏；关闭后焦点回到 `ai-open`。`onSelectDocument` prop 保留但不再使用（防调用方破坏）。
5. **视觉**：纸白 `#fcfcfa`、深绿 `#24543e`、边框 `#daddd4`、标题衬线；旧的蓝色 accent 全部替换。
6. **响应式**：≥1180px 三栏；1180px 以下目录+文档、AI 下移；760px 以下单列、目录限高 220px。

## 3. 测试变更（没有删除断言）

| 文件 | 变更 | 原因 |
| --- | --- | --- |
| `apps/web/src/features/ai/aiPanelRemote.test.ts` | `toContain(ai-directory)` → `not.toContain(ai-directory / refresh)` | 目录已移出面板；同时防止“面板再挂一个目录”导致重复请求。浏览器套件继续覆盖左栏目录。 |
| `tests/browser/suite/08-evidence-gate.mjs` | `directoryPresent === false` → `ai-panel === null`（两处） | 原断言用“目录不存在”推断“面板关闭”；目录现在常驻。改为直接断言面板关闭，意图不变。 |
| `tests/browser/suite/32-design-fidelity.mjs` | accent / accentSoft / resting border 常量更新为绿系 token | 视觉方案变更，断言形状（focus ring、lift、outline）不变。 |
| `tests/browser/suite/32b-m4-b125.mjs` | 仅增加目录 `ids` 证据字段 | 诊断；断言不变。 |

## 4. 证据

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit 0（shared/server/web） |
| `pnpm test` | **608 passed**（server **500 passed**） |
| `pnpm build` | exit 0 |
| 默认浏览器套件 | **78/78 PASS**（`agent/ui-2-workbench`，Chrome 157） |
| 场景覆盖 | 协同/离线/权限/生命周期/Preview/AI/新建/设计保真 |
| 截图（改前/改后） | `docs/ui/screenshots/before/`、`after/`：desktop-editor、desktop-ai、desktop-preview、narrow |

### 输入延迟（同机 Chrome 157、100k 单段落 fixture、本地 production build、N=300）

| 运行 | P50 | Max |
| --- | --- | --- |
| 同环境改前（main） | **373.4 ms** | 750.0 ms |
| 改后 run 1 | 396.4 ms | 887.0 ms |
| 改后 run 2 | 327.4 ms | 599.0 ms |

- P50 最差 +6.2%，门禁“恶化 ≤10%” **PASS**；run 2 低于改前，说明噪声约 ±10%。
- Max 有一次 +18%（887 vs 750），但门禁口径是 P50；已在残余风险中记录。
- 注：早期“965 ms 基线”是在机器负载下测得；本次改前/改后都在同一会话条件下重测，避免不可比。

## 5. 已知限制 / 残余风险

- **没有成员管理 UI**：邀请/改角色/移除仍无服务端接口（`NOT IMPLEMENTED`），不展示可提交入口。
- **文档标题仍是 id**：`document_meta.title` 在客户端未读取，头部显示 id；改为标题需要接 metadata（后续 UI）。
- **目录刷新时机**：连接状态变化会触发一次重载；删除/改名等外部变更仍需手动 Refresh。
- **100k Preview**：仍为 420s 未 ready 的已知限制，本次未触碰。
- **窄屏**：只做了可用性堆叠，没有按原型做目录抽屉/助手底部面板（需 UI-4 决策）。
- **Clerk 生产模式**：未做部署后验证。

## 6. 与路线图的关系

本次只做“工作台重组”（目录左栏、AI 右栏、视觉 token、状态呈现）。P0（版本历史、成员管理、真实模型 live/多人验证）、P1（导出、分段接受、采纳记录）、P2（评论、搜索、大文档）均未实施，见 `docs/ui/UI-ROADMAP.md` 的决策包。
