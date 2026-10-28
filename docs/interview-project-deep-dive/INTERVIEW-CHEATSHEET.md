# InsightHub — 面试速查（2–3 页）

> 所有源码锚点：`57a9bee`。数据口径见 [README](README.md) 与各报告 §12。

## 1. 一句话项目

团队 Markdown 知识工作台：**CodeMirror 6 + Yjs 实时协同**，`Y.Text` 是正文唯一真源，WebSocket
同步增量，IndexedDB 离线恢复，权限 Owner/Editor/Viewer，AI 只产出**建议 draft**，Accept 才进 Yjs
事务。

## 2. 必背数据（口径！）

| 数据 | 值 | 口径 |
| --- | --- | --- |
| fixture | 100,000 行 / 6,788,895 chars / sha256 `0d12688d…` | 确定性生成 |
| Redux 100k | **整个 store 序列化 241 B**（非“仅元数据”），正文 marker absent | 动态 fiber 取 store，n=3；36 字符 UUID 约 280 B |
| editor ready | p50/p95/max = **654 / 680 / 680 ms**（aggregate ceil；run.mjs p95=654） | n=3，local production build；测于 c2ad879（Preview 前） |
| reconnect | **763 / 770 / 770 ms** | n=9，restore→connected，local build |
| input | **268.8 / 371.3 / 511.4 ms** | n=900，病理单段落 |
| Long Task | **397–400 / run**（~300 inputs） | test instrumentation |
| bundle（Preview 前，c2ad879） | 1,058,970 raw / **340,811 gzip** | production build；HEAD 已更大 |
| preview chunk（Preview 合入后） | **160.46 kB raw / 48.99 kB gzip**；主包 +0.99 kB | lazy；与上一行不是同一次构建 |
| debounce | **400 ms（配置值）** | 不是可见延迟 P50 |
| 浏览器套件 | 默认 **78/78**；remote **83 未跑** | 73 + 5 preview |
| abort（目录 stale） | **69–78 ms** | CDP hold 200 后切换 |
| profile | Markdown inline **89.6% JS**；block 对照 p95 ~3.5 ms | 20 inputs trace |

## 3. 关键链路（背下来）

**协同**：`EditorView.dispatch → collabTextBinding → Y.Text → Y.Doc update → encodeSyncUpdate →
WS binary → room.applySyncPayload → store.append(seq) → broadcast → 远端 applyUpdate → EditorView`

**离线**：编辑先落本地 `Y.Doc` + `y-indexeddb`；重连 `SyncStep1`（state vector）→ `SyncStep2`
（缺失 update）；不存 Markdown string。

**权限**：`Clerk → internal user → membership → role → capabilities(canRead/canEdit/canComment/
canManageMembers) → HTTP guard / WS join+write / UI`；**server 才是边界**，前端只读是 UX。

**异步竞态**：`AbortController` 取消在途请求 + `requestId` 丢弃已到达的旧响应；**abort 本身不够**。

**AI**：`instruction → provider(stub|openai|kimi) → AiSuggestionDraft → Zod → anchor(RelativePosition
+ expectedText) → Diff → Accept(ai origin transaction) / Reject(no mutation)`。**LLM 永不直接写 Y.Text**。

**Preview**：`Y.Text → observe → 400ms debounce → React.lazy renderer → DOM`；编辑器始终挂载。

## 4. 选型一句话

| 选择 | 一句话理由 | 代价 |
| --- | --- | --- |
| CodeMirror 6（vs Monaco） | 文档编辑、transaction/扩展模型、轻 | Markdown parser 病理输入慢 |
| Yjs CRDT（vs OT） | 幂等/乱序/断线收敛，无需中心 transform | 元数据膨胀 |
| WebSocket（vs SSE/polling） | 双向、高频、两端都能主动发 | 连接管理/重连 |
| IndexedDB（vs localStorage） | 结构化、异步、容量；Yjs state | 生命周期复杂 |
| Redux 只控制状态（vs body 入 Redux） | 正文高频 + 单一真源，避免不可变拷贝 | 需要 discipline（R11） |
| React.lazy（vs static import） | 非首屏不下载 | 首进延迟、失败无 retry |
| debounce（vs throttle） | 连续编辑结束再渲染 | 峰值期延迟 |
| Clerk（vs 自建密码） | 不自己存密码/session | 第三方依赖 |
| SQLite（vs Postgres） | 单实例、零运维、事务够用 | 扩展受限 |
| 单实例 Render（vs K8s） | V1 预算/复杂度 | 无 HA、短暂停机 |

## 5. 高频追问速答

1. **正文为什么不放 Redux？** 高频事务 + 单一真源；100k 动态测得**整个 store** 241 B、无 body marker（241 B 不是“元数据”，是序列化总长）。
2. **Yjs 和 OT 区别？** CRDT update 幂等/可交换；OT 需中心 transform。**OT 未实现**。
3. **State Vector 是什么？** 每个 client 的最大 clock；`SyncStep1` 交换它，只补缺失 update。
4. **重复/乱序帧？** Yjs 幂等；测试重放二进制帧仍收敛。
5. **Undo 为什么不动别人？** `UndoManager` 只跟踪本地/AI origin，remote 不在 tracked 集合。
6. **为什么一 socket 一房间？** 二进制帧无 doc id，必须靠连接绑定房间（R15）。
7. **AbortController 够吗？** 不够；响应可能已返回，必须 `requestId` + document identity。
8. **Viewer 只读能绕过吗？** 能改前端，但服务端 join/write 会拒绝（p2/1、m3/10）。
9. **React.lazy 和 dynamic import？** lazy 包一层返回 Promise 的 loader；bundler 切 chunk。
10. **lazy 和 useMemo？** lazy 管“何时加载代码”，useMemo 管“是否复用计算”，不互相替代。
11. **debounce vs throttle？** 结束点 vs 固定窗口；预览选 debounce。
12. **400ms 是延迟吗？** 不是，是 debounce 配置；没有测可见延迟。
13. **100k Preview 为什么卡？** 单段落 → inline parser 全量扫描；浏览器 420 s 未 ready（limitation）。
14. **AI 为什么不直接写 Y.Text？** 输出不可信、可能 stale、需用户确认、必须 CRDT 事务。
15. **Accept 怎么防覆盖？** `baseRevision` + RelativePosition + `expectedText` 三校验，不匹配→stale。
16. **为什么选 Kimi？** 国内 endpoint、成本、中文、OpenAI-compatible；默认 model `kimi-k3`（`kimi-k3.1-pro` 是 Owner 决策的升级档，不是默认）；架构仍可换 OpenAI（`AI_PROVIDER/AI_MODEL` + adapter）。
17. **外部模型验证过吗？** **NOT VERIFIED**：OpenAI 429 余额；Kimi 400 后改 prompt-only 未重试。
18. **为什么 SQLite 不是 Postgres？** 单实例 V1；事务保证 document+owner membership 原子；扩展受限。
19. **为什么不用 K8s/Redis？** V1 单实例允许短暂停机；不引入运维面。
20. **有优化前后对比吗？** 没有；无可信 pre-opt baseline，不能写提升 X%。

## 6. 不能说错的 limitation

- P95 是 **local production build**，不是 production P95。
- 只验证 **two users**；3+ 未验证；30 s 断网未测。
- 100k 是**病理 fixture**；正常 block 文档 ~3.5 ms，不代表产品整体慢。
- 100k Preview 浏览器 **420 s 未 ready**。
- AI 外部 live **无成功记录**；模型质量/成本/延迟未评估。
- `document metadata stale` = **NOT APPLICABLE**；`requestId` guard 未压测。
- “权限变化导致请求竞态”是错的说法：权限变化不发 HTTP，真实机制是**授权结论过期**（服务端逐帧重查，UI 滞后约 3 s）。
- 性能数字测于 `c2ad879`（Preview 合入前）；HEAD 的 bundle 已更大，引用包体必须重新 build。
- remote 组（**83 个注册场景 = 78 + 5**）**没有跑**；历史 flake 仍在 `FLAKE-LOG`。
