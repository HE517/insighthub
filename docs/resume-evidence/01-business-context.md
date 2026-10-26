# 01 · Business Context — 团队知识工作台的 V1 边界

**Evidence commit:** `874f107` · **Report:** 01/05 · **Date:** 2026-10-26 · **Nature:** docs-only
**Scope:** positioning / product context. This report creates no test and claims no performance number.

---

## 1. Resume Claim

> 业务场景：面向团队知识共享，构建支持文档协同编辑、阅读与 AI 辅助修改的知识工作台。

This sentence is a **scope statement**, not a capability metric. It is quoted verbatim above; its
weakest word is "知识工作台" (workbench), because V1 is deliberately a document editor with
collaboration and AI review — not a wiki, not a workspace suite, and not a production service.

---

## 2. What It Means

**产品能力.** A team member opens a Markdown document, writes in a real editor, reads what
teammates wrote, and asks an assistant for a suggested edit that is shown as a diff and only lands
after Accept. The product scope is the loop *write → co-edit → survive a disconnect → ask →
review → stay inside permissions → switch safely*, exactly the seven flows in `PROJECT.md:17-41`.

**架构设计.** One same-origin React app talks to one Express + WebSocket server; the document body
lives only in a `Y.Text`; the server owns identity, membership and capabilities; Redux holds only
presentation state. That is a deliberately small architecture: one web app, one API server, one
SQLite store, no microservices (`PROJECT.md:66-79`, `AGENTS.md` R11/R15).

**测试证据.** There is **no dedicated test for the business framing** — a test cannot prove
"面向团队知识共享". What exists is path coverage: a real browser creates a document
(`b125/1`), mounts an editor on existing `Y.Text` (`editor/mounts-on-existing-ytext`), refuses a
non-member with 404 (`p2/3`), and shows a typed error when the remote AI provider is not configured
(`m3r/2`). Those prove the product has these entry points; they do not prove market fit.

**性能数据.** None belongs to this bullet. The 100k numbers in report 03 answer "does a large
document remain usable", not "is this a good knowledge product". Do not attach 241 B / 680 ms to a
business-context sentence.

---

## 3. How It Is Implemented

### 3.1 Runtime map

```text
main.tsx:16-20
  └─ <Provider store>                       (Redux: document / connection / realtime UI state)
      └─ App.tsx:9-17                       identity mode is decided once
          ├─ demo mode  → useServerSession  → POST /api/session/bootstrap → httpOnly cookie
          └─ Clerk mode → ClerkRoot → ClerkProvider → AuthGate → GET /api/session
              └─ AppShell.tsx:32-69         topbar: brand · document-id switcher · identity
                  └─ DocumentWorkspace key={activeDocumentId}   (AppShell.tsx:68)
                      ├─ DocumentHeader      status, role chip, collaborators, undo/redo, AI toggle
                      ├─ AiSuggestPanel      only while open: instruction → proposal → diff → Accept/Reject
                      │    └─ AiDirectory    GET /api/documents (readable list, create)
                      └─ CollaborativeMarkdownEditor
                           └─ Y.Text "content"   ← the only document body
```

The topbar switcher dispatches `documentSelected` (`AppShell.tsx:53-60`); `key={activeDocumentId}`
is load-bearing — a different document is a different workspace instance, and one socket carries at
most one room (`AppShell.tsx:13-14`, `AGENTS.md` R15). The AI panel is UI state in the workspace
(`DocumentWorkspace.tsx:173-175`), while the proposal itself belongs to the panel and the body
belongs to `Y.Text` (`DocumentWorkspace.tsx:232-252`).

### 3.2 Data flow and ownership

| Thing | Owner | Why |
| --- | --- | --- |
| document body | `Y.Doc` / `Y.Text` (`document-session.ts:474-475`) | one source of truth; Redux must not mirror it (`documentSlice.ts:1-23`) |
| active document id / metadata / pending input | Redux `document` slice (`documentSlice.ts:28-35`) | presentation only; switching is a UI decision |
| role | session getter `session.getRole()` (`useCollaborativeSession.ts:99-124`) | server-decided, never copied into Redux |
| connection / collaborator display | session subscriptions (`sessionStore.ts:32-65`) | high-frequency presence must not re-render the whole store |
| AI proposal + phase | `AiSuggestPanel` React state (`AiSuggestPanel.tsx:160-182`) | a proposal is not document state (R8) |
| membership + capability | server (`authz.ts:120-148`) | UI is advisory; the server is the boundary |

### 3.3 Why this shape

The body is high-frequency and large; putting it in Redux would re-render every subscriber on each
keystroke and create a second truth to reconcile. The role is server-decided; mirroring it would go
stale exactly when the seam says "unknown". The AI proposal is a transient review object; persisting
it would make it look like document state. These three refusals are the architecture: one body
source, one permission authority, proposals that are not state.

### 3.4 Failure path at the entry

`DocumentWorkspace` has three visible states, and never fakes an editor (`DocumentWorkspace.tsx:94-140`):
`initializing` shows "Opening … from local storage", `failed` shows the real reason and keeps local
data, `active` renders the editor only when `Y.Text` exists. Identity can fail independently: in demo
mode the app keeps working with a local placeholder user while the server refuses unauthorized
traffic (`App.tsx:25-31`). The product therefore distinguishes "cannot open this document" from
"cannot authenticate right now" instead of collapsing both into a blank screen.

---

## 4. Source Code Locations

**Evidence commit:** `874f107`. Every permalink below is pinned to that SHA.

| Location | Responsibility | Symbol | Permalink |
| --- | --- | --- | --- |
| `apps/web/src/main.tsx:16-20` | mounts React into `#root` under the Redux `Provider` | `createRoot`, `Provider` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/main.tsx#L16-L20 |
| `apps/web/src/App.tsx:9-17` | selects demo vs Clerk root once; `VITE_CLERK_PUBLISHABLE_KEY` is the only switch | `currentAppMode` (doc), mode roots | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/App.tsx#L9-L17 |
| `apps/web/src/AppShell.tsx:32-69` | topbar + document switcher + the keyed workspace; the only shell both identity modes share | `AppShell` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/AppShell.tsx#L32-L69 |
| `apps/web/src/features/editor/DocumentWorkspace.tsx:94-107` | session result → initializing / failed / active; no fake editor | `DocumentWorkspace` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/DocumentWorkspace.tsx#L94-L107 |
| `apps/web/src/features/editor/DocumentWorkspace.tsx:243-262` | AI panel is mounted only when open; one editor canvas | `AiSuggestPanel`, `CollaborativeMarkdownEditor` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/DocumentWorkspace.tsx#L243-L262 |
| `apps/web/src/store/documentSlice.ts:28-43` | allowed document presentation fields; no body, no role | `DocumentState`, `initialState` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/store/documentSlice.ts#L28-L43 |
| `apps/web/src/collab/internal/document-session.ts:474-475` | creates the one `Y.Doc` and the `Y.Text` named `content` | `new Y.Doc`, `doc.getText` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/collab/internal/document-session.ts#L474-L475 |
| `apps/web/src/features/editor/AiSuggestPanel.tsx:120-160` | the review surface: provider/gate/session inputs, proposal state | `AiSuggestPanelProps`, `AiSuggestPanel` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/AiSuggestPanel.tsx#L120-L160 |
| `apps/server/src/authz/authz.ts:120-148` | the five-member authz service: session, role, capability, read decision, directory | `AuthzService` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/authz/authz.ts#L120-L148 |
| `docs/PROJECT.md:17-41` | the seven user flows and the permission/AI boundaries | — | https://github.com/HE517/insighthub/blob/874f107/docs/PROJECT.md#L17-L41 |

---

## 5. How It Was Tested

**No dedicated business-context test exists, and none was invented.** The honest evidence is that the
entry points in §3.1 are exercised by committed real-browser scenarios:

| Question the context implies | Scenario | File:line | What it actually shows |
| --- | --- | --- | --- |
| can a member create and enter a document? | `b125/1-create-document-switches` | `tests/browser/suite/32b-m4-b125.mjs:511` | one click → real `POST /api/documents` (201) → switch to the server UUID → `owner` room → editable editor |
| can the editor open on an existing body? | `editor/mounts-on-existing-ytext` | `tests/browser/suite/02-editor.mjs:30` | the view mounts on existing `Y.Text`, not an empty buffer |
| is a non-member kept out? | `p2/3-non-disclosure-404` | `tests/browser/suite/20-m2-phase2-authz.mjs:507` | unknown / outside-membership / unauthenticated are distinguishable only by the frozen 404/401 rule |
| does an unconfigured AI provider fail visibly? | `m3r/2-remote-provider-unconfigured` | `tests/browser/suite/33-m3-remote.mjs:714` | Generate → `503`, typed `not-configured` error, no proposal, neither store moves |

Topology: real Chromium over CDP against a real Express/WS server and real SQLite; the AI panel
scenario runs only in `INSIGHTHUB_E2E_AI_MODE=remote`. These scenarios prove **the paths exist and
fail honestly**; they do not validate a market claim or a workflow study. There is no user
research, no analytics, and no adoption metric anywhere in the repository.

---

## 6. Measured Evidence

**This claim has no performance or scale metric, and none is asserted here.**

The only relevant recorded status is the gate itself: the default real-browser suite is **73
scenarios** and the evidence run reports **73/73 PASS, exit 0**, ports released, 11 temporary data
directories removed, no live handles (`A6-evidence-gate-round2.md:12,40-43,171-172`). The suite count
and the 78 registration total are in `tests/browser/README.md:83,407-409`. Those numbers say the
product paths are testable; they say nothing about business value.

Environment of that run: Windows 11 10.0.26200 x64, Chrome 155.0.8059.85 headless, Node v22.14.0
(`A6-evidence-gate-round2.md:9`).

---

## 7. Failure / Edge Cases

**AI provider not configured (a real product boundary).** In remote mode with `AI_PROVIDER` unset,
the server answers `503` with a typed body and the panel renders
`ai-status[data-provider-error="not-configured"]`; there is no `ai-proposal`, no Accept, and neither
the editor nor the durable store changes (`tests/browser/README.md:370`, scenario `m3r/2`). The
system handles this by **refusing to invent a proposal**, which is the correct behaviour for a review
surface: an empty or fabricated draft would be worse than a visible error.

**A second boundary: document creation while offline.** The click is a real failed `fetch`
(`status: null`, `TypeError`), the UI shows `data-create-error="network"`, the workspace does **not**
switch, the directory does not grow a fabricated row, and the same button succeeds after recovery
(`tests/browser/README.md:388`, scenario `b125/2`). This is what "not silently losing the user's
intent" means at the entry point.

---

## 8. Limitations

- **`VERIFIED`（scope）** — the app has an entry chain, a document editor, a readable document
  directory, server-authoritative permissions, and an AI review panel. The seven flows in
  `PROJECT.md` exist and are reachable.
- **`NOT VERIFIED`（AI 的真实模型能力）** — the default assistant is a deterministic instruction
  table, not a language model (`localProvider.ts:11-37`); an external provider is implemented but
  has no successful live call (`D-085:3646`, `A7-claim-evidence-review.md:56`). "AI 辅助修改" is
  accurate as a *pipeline*; "接入大模型并可在线改写" is not.
- **`NOT IMPLEMENTED`** — Markdown preview, search, comments/@mentions, sendBeacon telemetry,
  production `PerformanceObserver`. The `commenter` role is a server-side permission tier, not a
  comment feature (`PROJECT.md:39`, `permission.ts:10-44`).
- **Scope limitation** — no wiki/backlinks/org hierarchy, no billing, no multi-region, no
  microservices (`PROJECT.md:66-79`). "知识工作台" must not be expanded into "enterprise knowledge
  platform".
- **Scope limitation** — the collaboration evidence is two independent users, not a team; 3+
  concurrent editors are `NOT VERIFIED` (`PROJECT.md:21`).
- **Production readiness** — `NOT VERIFIED`. M3 CLOSED is not production ready; M4's persistent
  disk/restart, deployed backup/restore and final review are blocked by payment
  (`PROJECT.md:52-53`, `A7-claim-evidence-review.md:58`).

---

## 9. Interview Explanation (60–90 seconds)

“InsightHub 是一个团队 Markdown 文档工作台。用户打开一篇文档，在 CodeMirror 里写；两个成员可以实时协同；断网时还能继续写，重连后收敛；也可以让 AI 给出修改建议，但建议只以 diff 形式出现，Accept 之前文档不会变。

架构上我刻意做小：一个 React 前端、一个 Express + WebSocket 服务、一个 SQLite；正文只在 Y.Text 里，Redux 只放 activeDocumentId、metadata 和 UI 状态，角色由服务端算、UI 只反映。这样避免了正文双份状态和权限双份判断。

V1 的边界我也能说清：没有 Markdown 预览、没有搜索、没有评论功能；`commenter` 只是权限梯级。协同证据是‘两个独立浏览器上下文、两个身份’，不是三个以上；AI 的外部 provider 实现了但 live 还没跑通，默认是确定性指令表。所以它是一个可演示、可审计的 V1，不是一个 production-ready 产品。”
