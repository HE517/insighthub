# Harness Agent Setup Guide — 把仓库里的 prompt 接进 DeepSeek Harness

> 本文档只记录**从当前安装中实测确认**的事实，以及可安全执行的操作步骤。
> 凡是无法确认的，明确写"无法确认"，不猜。
>
> 调查报告的取证方式：解析 `app.asar` 头部索引（只读），提取 `@deepseek-ai/dsh-*`
> 包的 `README.md` 与 `lib/index.js`，核对实现。**未修改安装包、未修改凭据、
> 未修改任何 profile 配置文件。**

---

## 1. 结论速览

| 问题 | 结论 | 是否可用于本项目 |
| --- | --- | --- |
| 有 agent profile / preset 机制吗？ | **有**：`@deepseek-ai/dsh-agent-preset` + `-preset-registry`，按 preset 组合 tools / prompt sections / skills | 结构性支持，但配置在 profile YAML，不是仓库文件 |
| 有 system prompt profile 吗？ | **部分有**：`@deepseek-ai/dsh-system-prompt` 支持 profile 级 `personaPrefix` / `personaSuffix` / `includeHarnessIdentity` / `includeRuntimeContext` / `toolOrder` | 是**全局**的，同 profile 内所有会话共用，不适合 A0–A7 分角色 |
| 有 prompt file（提示词文件加载）吗？ | **没有**。system prompt 文本只来自配置/组合；无"从文件加载 system prompt"的开关 | ✗ |
| 有 project instruction file 吗？ | **有**：`@deepseek-ai/dsh-agent-instructions`，`dsh-base` 默认启用，预算 65536 字节 | ✓ **本方案的主通道** |
| 支持文件加载吗？ | instructions **支持**（markdown 文件）；system prompt **不支持** | ✓ |
| 支持不同 Agent 独立 profile 吗？ | **支持**（preset 组合），但需写插件或改 profile YAML，不能靠丢一个文件生效 | 备选，非首选 |
| 我能自动改现有会话的 system prompt 吗？ | **不能**。无终端用户 prompt 编辑 API | ✗ 见 §5 |

---

## 2. 实测确认的事实（含路径与配置格式）

### 2.1 安装与配置位置

| 项 | 实测值 |
| --- | --- |
| 安装根 | `C:\Users\hrm17\AppData\Local\Programs\DeepSeek Harness` |
| 应用包 | `resources\app.asar`（约 115.7 MB，内部根目录 `dsh/`） |
| 仅解包的模块 | `resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\*` |
| `DSH_HOME` | `C:\Users\hrm17\.dsh` |
| 当前 profile | `desktop` → `C:\Users\hrm17\.dsh\profiles\desktop` |
| profile 组成 | `package.json` 的 `dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` |
| profile 配置 | `cordis.yml`（根，空数组，**不要编辑**）+ `cordis.patch.yml`（**用户补丁层，要改就改这里**） |
| 凭据 | `C:\Users\hrm17\.dsh\.credentials.yaml` — **本文档与任何自动化都不得读写** |

`cordis.patch.yml` 的格式是 YAML 数组，每条是 plugin 行的 config 覆盖 / 禁用 / insert；
支持 `!!js` 表达式。当前内容示例（实测）：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
```

### 2.2 `@deepseek-ai/dsh-system-prompt`

- 提供 `ctx.systemPrompt` 注册表；贡献（section / variable / tool schema）可带作用域，
  **agent 作用域会遮蔽同名全局项**。
- 用户可配字段（实测自 README）：`includeHarnessIdentity`（默认 true）、
  `includeRuntimeContext`（默认 true）、`personaPrefix`（order 0）、
  `personaSuffix`（order 10200）、`toolOrder`。
- 关键限制（原文）：「**部署方编写的提示词文本只来自配置／组合**……
  **不存在终端用户提示词编辑 API。**」
- 结论：`personaPrefix` 可以在 **profile 级别**塞入一段 prompt 文本，但它属于整个
  profile（同一桌面 App 的所有会话），**无法按 A0/A1/A2 分角色**。

### 2.3 `@deepseek-ai/dsh-agent-instructions`（本方案主通道）

- `dsh-base` 已默认启用，`maxBytes: 65536`。
- 加载顺序：`$DSH_HOME/AGENTS.md`（用户全局）→ **项目链**：从项目根到会话 cwd
  逐级的 `AGENTS.md` / `CLAUDE.md`，broad → specific。
- 附加候选（更高优先级的本地覆盖层）：`AGENTS.local.md` / `CLAUDE.local.md`。
- 同级内容完全相同者只渲染一次（去重）。
- **项目根判定**：从 cwd 向上找第一个含 `.git` 的目录。
  实测 `findProjectRoot` → `existsAsMarker` 使用 `stat()` 判定**存在性**，
  **不要求是目录** → **git worktree 的 `.git` 文件同样被识别为项目根**。
  这让"每个 worktree 自带角色指令"成为官方支持路径。
- 嵌套目录：成功 `read`/`write`/`edit` 到更深目录后，下一次请求会补上该目录的
  `AGENTS.md`（按目录发现，不靠 shell `cd`）。
- 无文件监听：外部编辑在下一次文件操作或 resume 时生效。
- 运行时行为已被本会话验证：每次会话都出现
  `Instructions from: AGENTS.md` 的 system-reminder。

### 2.4 `@deepseek-ai/dsh-agent-preset` + `-preset-registry`（备选通道）

- preset = 一条 Cordis plugin 行，`config: { id, plugins: [...] }`；
  一个进程可跑多套组合；会话选择其中一个 preset。
- 可以组合出「不同 prompt section + 不同 skills + 不同 tools」的**真正独立 agent profile**。
- 限制：registry **不扫描目录**，定义来自 bundle / profile 配置；
  用户覆盖会**整体替换** child 列表；preset 不是安全沙箱（YAML 与插件可执行 Host 代码）。
- 结论：想给 A0–A7 各自一个独立 preset，需要写插件或在 profile YAML 里维护组合，
  属于"开发级"配置，不是"丢个 md 文件"。

---

## 3. 推荐方案：用 instructions 通道承载 prompt

因为 system prompt 无法按角色配置、也没有 prompt 文件机制，而 **instructions 通道
天生按目录生效**，所以把角色层放在 worktree 里，是最省事且官方支持的组合。

```
$DSH_HOME/AGENTS.md                     （可选）跨项目通用的个人习惯
        ↓
<repo>/AGENTS.md                        项目契约 + DoD（已提交，所有 worktree 都有）
        ↓
<worktree>/AGENTS.local.md              角色层 + 本次任务（未提交，一次性创建）
        ↓
agent-prompts/COMMON.md                共享行为底座（已提交）
agent-prompts/A{n}-*.md                角色长期职责（已提交）
```

`AGENTS.local.md` 只是一层**薄指针**，内容形如：

```markdown
# 你的角色：A1 — Collaboration / Yjs Agent

工作前必须阅读（按顺序）：
1. agent-prompts/COMMON.md
2. agent-prompts/A1-collaboration.md
3. AGENTS.md（项目契约与 DoD）

本次任务：<一句话目标>
Owned Files：<允许改的文件>
Do Not Touch：<禁止改的文件>
验收标准：<可执行判定>
```

### 为什么不用别的方式

| 备选 | 否决原因 |
| --- | --- |
| 把角色 prompt 写进 `personaPrefix` | profile 级，会同时作用于所有会话，A1/A2 无法区分 |
| 每个分支提交不同的 `AGENTS.md` | 分支合并时必然冲突；契约文件被角色内容污染 |
| 每个 worktree 提交自己的 `AGENTS.md` | 同上；且会与 main 的契约分叉 |
| 用 preset 给每个 Agent 建 profile | 需要写插件/维护 YAML 组合，成本高于收益；且 preset 不是沙箱 |
| 每次粘贴长 prompt | 这正是本轮要消除的重复劳动 |

### ⚠️ 一个必须处理的前提

`AGENTS.local.md` 是**未跟踪文件**，容易被误提交。建议在 `.gitignore` 增加一条：

```gitignore
AGENTS.local.md
```

本轮**没有**修改 `.gitignore`（本轮改动范围限定为 `AGENTS.md`、`agent-prompts/**`、
`docs/agent-governance/**`），是否添加请你决定。

---

## 4. 具体操作步骤（由项目负责人或 A0 执行）

### 4.1 让项目契约自动生效（已完成，无需操作）

`AGENTS.md` 已在仓库根并已提交历史中。**任何**在该目录或其 worktree 中启动的会话
都会自动获得它。已验证：本会话的 system context 中出现
`Instructions from: AGENTS.md`。

### 4.2 为某个 worktree 绑定角色（一次性）

在 worktree 根创建 `AGENTS.local.md`（内容模板见 §3）。例如 A1 的 P0-1 修复：

```bash
# 在 worktree 根执行（Windows Git Bash / WSL 均可）
cat > AGENTS.local.md <<'EOF'
# 你的角色：A1 — Collaboration / Yjs Agent

工作前必须阅读：agent-prompts/COMMON.md → agent-prompts/A1-collaboration.md → AGENTS.md

本次任务：修复 P0-1（浏览器中 window.indexedDB 只读，导致文档打不开）
Owned Files：apps/web/src/collab/internal/persistence.ts（及其单测）
Do Not Touch：tests/browser/**、packages/shared/**、其它 Agent 的 Owned Files
验收：node tests/browser/run.mjs --filter defect-pin 必须 exit 0（该用例不走 shim）
完成后按 AGENTS.md Task Completion Report 输出中文报告。
EOF
```

之后在该 worktree 启动的会话会自动带上角色层，**无需粘贴**。

### 4.3 可选：让规则跨项目生效

若希望 `COMMON.md` 的通用纪律（不得伪造测试、阻塞用语等）在所有项目中生效，
可把它的稳定部分复制到 `C:\Users\hrm17\.dsh\AGENTS.md`（用户全局层，当前**不存在**）。
本轮**没有创建**该文件：它在仓库之外，超出本轮允许范围，且是否要"跨项目生效"属于你的偏好。

### 4.4 可选（高级）：为每个角色建独立 preset

适合将来角色数量多、且希望每个角色有独立 tools/skills 时使用。属于开发级改动：
在 profile 的 `cordis.patch.yml` 里声明 `dsh-agent-preset` 行并用插件注册
各自 `ctx.systemPrompt.section(...)`。**本轮不做**，因为它需要写并维护插件代码。

---

## 5. 必须明确说清的一件事

> **仓库内 Prompt Source 已完成，但现有 Harness 会话的 System Prompt 需要项目负责人
> 在 UI/Profile 中应用一次。**

原因是实测确认的硬约束：`dsh-system-prompt` 明确声明**不存在终端用户提示词编辑 API**，
会话的 system prompt 也不是仓库文件；我没有任何受支持的途径去改写一个**已存在会话**
的 system prompt。

我能做到的是：让**新会话**（或 resume 后的会话）通过 instructions 通道自动获得
`AGENTS.md` + `AGENTS.local.md`，从而实现"无需粘贴长提示词"。

**我没有声称已修改任何现有会话的 system prompt。**

### 现有会话怎么办

见 [`existing-agents.md`](./existing-agents.md)：那里逐条说明每个现有会话应该使用哪份
prompt，以及切换方式（推荐直接新建会话，最省事且不易残留旧上下文）。

---

## 6. 安全的自动化边界（本轮的自我约束）

| 操作 | 是否执行 | 说明 |
| --- | --- | --- |
| 读取 `app.asar` 索引与包文档 | 已执行 | 只读 |
| 解析 asar 提取 README / lib 到 `D:\dev-temp` | 已执行 | 只读安装包；产物在临时目录 |
| 修改 `app.asar` / 安装目录 | **未执行** | 会破坏签名与升级 |
| 修改 `cordis.patch.yml` / `cordis.yml` | **未执行** | 属于 profile 配置，按 §5 由你决定 |
| 读写 `.credentials.yaml` | **未执行** | 凭据不碰 |
| 创建/修改 `$DSH_HOME/AGENTS.md` | **未执行** | 仓库外，超出允许范围 |
| 创建 `AGENTS.local.md` | **未执行** | 待你确认（模板已给） |

---

## 7. 复现本文档的调查方法

```bash
# 1) 定位真实安装（系统提示里的 app.asar\dsh 路径可能过时，实际是 app.asar.unpacked）
echo $env:DSH_HOME; echo $env:DSH_PROFILE_DIR

# 2) 解析 asar 头部索引（只读，纯 Node，无依赖）
#    16 字节前缀 → JSON 目录树 → 文件数据从 8 + headerSize 开始
node D:\dev-temp\inspect-asar.mjs

# 3) 提取感兴趣包的文档
node D:\dev-temp\extract-asar.mjs \
  "dsh/node_modules/@deepseek-ai/dsh-system-prompt/README.zh.md" \
  "dsh/node_modules/@deepseek-ai/dsh-agent-instructions/README.md" \
  "dsh/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js"
```

关键验证点（用于判断本文档是否仍然成立）：

1. `dsh-agent-instructions` 的 `existsAsMarker` 是否仍用 `stat()`（worktree 支持的前提）
2. `instructionFileCandidates` 是否仍包含 `AGENTS.md`，`localInstructionFileCandidates`
   是否仍包含 `AGENTS.local.md`
3. `dsh-base` 的 `agent-instructions` 行 `maxBytes` 是否仍为 65536
4. `dsh-system-prompt` 是否仍未提供 prompt 编辑 API

Harness 升级后请重跑上述三步再信任本文档。
