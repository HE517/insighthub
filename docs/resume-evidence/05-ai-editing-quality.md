# 05 · AI-Assisted Editing and Engineering Quality

**Evidence commit:** `874f107` · **Report:** 05/05 · **Date:** 2026-10-26 · **Nature:** docs-only

---

## 1. Resume Claim

> 设计 AI 辅助编辑的生成建议 → Diff Preview → Accept / Reject 非破坏式交互；使用 Playwright 覆盖协作、离线、权限及异常网络等核心链路，当前全量浏览器回归 73/73 PASS。

Two corrections are required before this sentence is safe:

1. the 73/73 suite is **not Playwright**; it is a dependency-free CDP harness driving real Chromium.
   `playwright-core` exists only for the opt-in deployed smoke;
2. "73/73" is the **default** suite. The remote group is 78 registered scenarios (73 + 5), and the
   remote run was **not executed** in this evidence round.

The AI interaction half — proposal → diff → Accept/Reject, non-destructive — is well supported.

---

## 2. What It Means

**产品能力.** A user writes an instruction for a passage. The assistant returns a **suggestion**:
a summary plus a unified diff. Nothing changes until the user presses Accept; Reject writes nothing;
Undo after Accept reverts only the AI edit. A viewer can read the proposal but cannot accept it. If
the document moved while the proposal was pending, Accept is refused with a visible reason and the
document stays untouched.

**架构设计.** A proposal is **not state**. In the remote path the server returns a draft with
operations but **no anchors**; anchors are always minted on the client against the live `Y.Text`
(the local provider, which runs in the client, mints them in-process). The client checks the exact
`expectedText`, computes the diff locally, and keeps the result in panel state. Accept validates
revision → anchors → text, then applies all operations in **one** Yjs transaction stamped
`TRANSACTION_ORIGINS.ai`. No provider ever writes `Y.Text`.

**测试证据.** Real-browser scenarios cover: no write before Accept; Accept visible to a peer;
Undo/Redo isolation; Reject; two stale reasons; viewer cannot accept; offline Accept converges once;
the remote chain with a real `POST /api/suggest`. The default suite is 73/73; the remote group is
registered but not run. The browser harness is CDP, not Playwright.

**性能数据.** No AI latency, token, cost or quality metric is measured anywhere in this repository.
Do not attach a model-performance number to this bullet.

---

## 3. How It Is Implemented

### A. The proposal pipeline

```text
instruction + selection snapshot + document text
        │  (read synchronously in one block, AiSuggestPanel.tsx:214-232)
        ▼
provider.suggest(input)                          ← VITE_AI_PROVIDER: default local
        │                                           aiProvider.ts:58-76
        ├─ local (client, in-process)
        │    deterministic intent table → AiOperationDraft[]
        │    → buildSuggestion (client mints anchors + diff)             localProvider.ts:26-37
        │
        └─ remote (client)
             POST /api/ai/suggest
               → server: session → body schema → authorizeDocument(canRead)
                 → provider.suggest → aiSuggestionDraftSchema             route.ts:125-130,263-343
               → response draft (summary + operations, no anchors)
             → buildSuggestion (client mints anchors + diff)              remoteProvider.ts:156-197
        ▼
AiEditSuggestion (proposal) in panel state                                AiSuggestPanel.tsx:160-182
        ▼
Diff Preview                      ── Accept ──► applySuggestion → one Yjs transaction (ai origin)
                                  └─ Reject ──► state only; no Y.Text write
```

The important split is **draft vs suggestion**. `aiSuggestionDraftSchema` contains summary +
operations and deliberately **no anchors** (`ai-suggestion.ts:131-165`). Anchors are only meaningful
against a specific `Y.Doc`, so they are minted on the client (`provider.ts:101-126`): the local
provider does it in-process, the remote provider does it after the HTTP response. That is why the
server cannot "decide" where an edit lands — it proposes operations and text, and the client anchors
them to the live document.

`buildSuggestion` also refuses a stale snapshot: if the `text` the provider saw does not equal the
current `anchorText.toString()`, it throws rather than anchoring into text the operations do not
describe (`provider.ts:195-201`).

### B. Safety properties (each one has a mechanism)

| Property | Mechanism | Where |
| --- | --- | --- |
| provider never mutates `Y.Text` | the provider returns a proposal (`AiEditSuggestion`), not a committed edit. `anchorText` is passed in **read-only in practice**: both providers only read it to mint anchors; neither calls `insert`/`delete`. | `provider.ts:74-75`, `localProvider.ts:23-24`, `remoteProvider.ts:206-220` |
| boundary schema validation | the server validates the provider output before it crosses to the client; the client validates the HTTP body again before turning it into a proposal | `route.ts:327-343`, `remoteProvider.ts:194-197` |
| anchors survive concurrent edits | `RelativePosition` start/end + exact `expectedText`; the anchor is the application authority, not the index | `ai-anchor.ts:19-36,131-185,231-325` |
| stale is refused, not applied | `applySuggestion` checks in order: `documentId` → `revision` → anchor resolution → `expectedText` → overlapping ranges; every failure returns `{ok:false}` **before** any write | `apply.ts:92-136`, `ai-anchor.ts:199-229` |
| permission is re-checked | generation requires `canRead`; Accept requires the live `canEdit` gate; the resulting Yjs update is still subject to the server's per-frame `canEdit` check | `route.ts:274-298`, `AiSuggestPanel.tsx:248-251`, `registry.ts:752-759` |
| Accept is atomic | all operations execute inside **one** `port.transact(..., TRANSACTION_ORIGINS.ai)` | `apply.ts:122-135` |
| Reject is a no-op on the document | it clears panel state and never touches `Y.Text` or awareness | `AiSuggestPanel.tsx:281-287` |
| AI undo is isolated | `UNDO_TRACKED_ORIGINS = [local, ai]`; remote updates use `remote` | `binary-frame.ts:134-138`, `document-session.ts:534-536` |

Two design choices deserve a sentence each:

- **Why the client anchors, not the server.** A `RelativePosition` is tied to a `Y.Doc`; the server
  has its own `Y.Doc` instance, but the browser may have unsynced local edits. Minting anchors
  client-side against the live text is the only place where "the text the user reviewed" and "the
  text that will be written" are the same object.
- **Why Accept is one transaction.** A multi-operation suggestion must land all-or-nothing. Yjs
  rolls the transaction back on a throw; splitting operations would leave a partially applied
  suggestion and a diff that no longer matches the document (`apply.ts:122-135`).

### C. Diff Preview and the panel state machine

The panel's phase is a discriminated union: `idle | generating | proposal | applied | stale |
rejected | error` (`AiSuggestPanel.tsx:105-109`). The proposal (summary + diff + operations) is
separate React state (`AiSuggestPanel.tsx:160`). The diff is rendered **verbatim** from the proposal
— it was computed by `unifiedDiff` inside `buildSuggestion` and is not recomputed in the view, so a
second diff implementation cannot disagree with the preview (`AiSuggestPanel.tsx:422-432`;
`diff.ts:64-100`).

The visible states are all distinct: `ai-status` text, `ai-empty`, `ai-stale`, `data-phase`, and
`data-provider-error` for provider failures (`AiSuggestPanel.tsx:494-530`). Accept is disabled when
`!canEdit` or when the phase is not `proposal`, with a title explaining why
(`AiSuggestPanel.tsx:301-306`). A stale Accept keeps the proposal visible and records the reason
instead of silently discarding it (`AiSuggestPanel.tsx:274-278`). Reject sets `rejected` and leaves
both the editor and the durable store byte-for-byte unchanged (`AiSuggestPanel.tsx:281-287`,
`m3/6`).

This is **not** "Markdown preview": the DOM label is `aria-label="Unified diff preview"`
(`AiSuggestPanel.tsx:429`). There is no rendered Markdown view anywhere in the product.

### D. External provider: implemented, but live is NOT VERIFIED

`AI_PROVIDER` is configurable as `stub | openai | kimi | disabled`; the endpoint allowlist is
`https://api.openai.com/v1` and `https://api.moonshot.cn/v1`; production startup fails closed on an
unknown provider, a missing key, `stub`, or `AI_BASE_URL` (`D-085:3650-3663`). The keys are
server-only and never reach the client.

The live record is a finding, not a success:

- **OpenAI**: the staging call returned **`429 credit_balance_exhausted`**. It proves reachability
  and that the request arrived; it is a billing finding, not an implementation failure
  (`D-085:3644-3648,3684`).
- **Kimi**: the CN endpoint answered the live request with **`400 invalid_request_error`** while the
  request carried `response_format`. The adapter now sends **prompt-only** and still validates the
  response through `JSON.parse` + the strict schema. It has **not been retried** since that change
  (`kimi.ts:25-32`).
- `live-smoke.ts` is opt-in and fails closed: exit `0` = a valid draft came back, `1` = provider
  failed, `2` = not configured (`live-smoke.ts:9-22`). No successful run is recorded in the repo.

So the correct status is **IMPLEMENTED / NOT LIVE-VERIFIED** (`D-081:3384`;
`A7-claim-evidence-review.md:56,302`; `PROJECT.md:52`). The resume must not say "真实大模型已跑通".

---

## 4. Source Code Locations

**Evidence commit:** `874f107`. Permalinks pinned to that SHA.

| Location | Responsibility | Symbol | Permalink |
| --- | --- | --- | --- |
| `apps/web/src/features/editor/AiSuggestPanel.tsx:201-246` | one Generate = one provider call; read text + selection synchronously; abort previous | `generate` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/AiSuggestPanel.tsx#L201-L246 |
| `apps/web/src/features/editor/AiSuggestPanel.tsx:248-279` | Accept: guard `canEdit`, call `applySuggestion`, surface stale | `accept` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/AiSuggestPanel.tsx#L248-L279 |
| `apps/web/src/features/editor/AiSuggestPanel.tsx:281-287` | Reject touches only panel state | `reject` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/AiSuggestPanel.tsx#L281-L287 |
| `apps/web/src/features/editor/AiSuggestPanel.tsx:422-432` | the diff is rendered verbatim, with the `Unified diff preview` label | diff block | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/editor/AiSuggestPanel.tsx#L422-L432 |
| `apps/web/src/features/ai/apply.ts:92-136` | validate then apply all operations in one AI-origin transaction | `applySuggestion` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/ai/apply.ts#L92-L136 |
| `apps/web/src/features/ai/provider.ts:74-75` | the provider port; no write access to the document | `AiProvider` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/ai/provider.ts#L74-L75 |
| `apps/web/src/features/ai/provider.ts:185-218` | draft → anchors + diff + `baseRevision`; refuse stale snapshot | `buildSuggestion` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/ai/provider.ts#L185-L218 |
| `apps/web/src/features/ai/remoteProvider.ts:145-197` | `POST /api/ai/suggest`; forward the abort signal; schema-check the body | `suggest` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/ai/remoteProvider.ts#L145-L197 |
| `apps/web/src/features/ai/localProvider.ts:26-37` | the deterministic five-intent table; unknown instruction throws | intent table | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/ai/localProvider.ts#L26-L37 |
| `apps/web/src/features/ai/aiProvider.ts:58-76` | default local; only the literal `remote` opts into the network | `readAiProviderMode`, `createAiProvider` | https://github.com/HE517/insighthub/blob/874f107/apps/web/src/features/ai/aiProvider.ts#L58-L76 |
| `packages/shared/src/ai-suggestion.ts:99-108` | the on-screen suggestion shape (anchors + diff + baseRevision) | `aiEditSuggestionSchema` | https://github.com/HE517/insighthub/blob/874f107/packages/shared/src/ai-suggestion.ts#L99-L108 |
| `packages/shared/src/ai-suggestion.ts:158-165` | the provider draft shape: summary + operations, no anchors | `aiSuggestionDraftSchema` | https://github.com/HE517/insighthub/blob/874f107/packages/shared/src/ai-suggestion.ts#L158-L165 |
| `packages/shared/src/ai-anchor.ts:231-325` | revision → anchor → `expectedText` validation | `validateSuggestionAgainstDocument` | https://github.com/HE517/insighthub/blob/874f107/packages/shared/src/ai-anchor.ts#L231-L325 |
| `apps/server/src/ai/route.ts:206-343` | body schema → `canRead` → provider → draft schema → 200 | `createSuggestHandler` | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/ai/route.ts#L206-L343 |
| `apps/server/src/ai/kimi.ts:25-32` | the recorded Kimi 400 → prompt-only decision | module doc | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/ai/kimi.ts#L25-L32 |
| `apps/server/src/ai/live-smoke.ts:9-22` | opt-in live smoke; fail-closed exit codes | exit-code doc (function body at :73) | https://github.com/HE517/insighthub/blob/874f107/apps/server/src/ai/live-smoke.ts#L9-L22 |
| `packages/shared/src/binary-frame.ts:134-138` | undo tracks local + AI only | `UNDO_TRACKED_ORIGINS` | https://github.com/HE517/insighthub/blob/874f107/packages/shared/src/binary-frame.ts#L134-L138 |

---

## 5. How It Was Tested (E)

### E.1 First, the harness correction

`tests/browser` **does not use Playwright**. It drives Chrome over CDP with Node 22's global
`WebSocket`; it adds zero dependencies and changes no `package.json`
(`tests/browser/README.md:22-36`). `playwright-core` is a root devDependency used only by the
opt-in deployed smoke `tests/deployed/b13.mjs` (`package.json:28-30`; `b13.mjs:12,28-29,131`).

Therefore the resume sentence must read **"真实 Chromium（CDP）覆盖…"**, not "使用 Playwright". If the
word Playwright must stay, it belongs to the deployed B13 smoke, not to the 73/73.

### E.2 What 73/73 contains

Counted at `874f107` from `runner.scenario(` registrations across `tests/browser/suite/**`:

| Primary group | Suites | Count |
| --- | --- | ---: |
| collaboration | `02-editor` (6), `03-realtime` (6), `08` collab (1) | 13 |
| offline / protocol & network failure | `01-persistence` (4), `04-chaos` (5), `07-robustness` (1) | 10 |
| permissions | `20-m2-phase2-authz` (8), `21-m2-f1-role-ui` (4) | 12 |
| lifecycle / UI / benchmark | `00-smoke` (1), `05-performance` (2), `06-lifecycle` (2), `30-m3-ui-evidence` (5), `32-design-fidelity` (8) | 18 |
| AI proposal | `31-m3-ai` (7) | 7 |
| stale / async | `08` stale (1) | 1 |
| durable persistence | `10-m2-durability` (9) | 9 |
| document creation | `32b-m4-b125` (3) | 3 |
| **default total** | | **73** |
| remote group | `33-m3-remote` (5, env-gated) | +5 = **78 registered** |

The categories overlap in subject matter (a chaos scenario is also a collaboration scenario); the
table is a **primary grouping** that adds up to the default count. The count itself is stated in
`tests/browser/README.md:83,407-409`; the per-file numbers were re-counted at `874f107` with
`Select-String -Pattern 'runner\\.scenario\\('`.

### E.3 The AI scenarios

| Scenario | File:line | What it actually proves |
| --- | --- | --- |
| `m3/5-ai-proposal-and-accept` | `tests/browser/suite/31-m3-ai.mjs:355-551` | proposal renders summary + unified diff while editor, durable store and a real peer stay unchanged; Accept changes editor + durable + peer; Undo reverts only the AI edit (locally typed text survives); Redo restores it |
| `m3/6-ai-reject-writes-nothing` | `31-m3-ai.mjs:553-629` | Reject reaches `data-phase="rejected"`, clears the proposal, editor and durable text byte-identical |
| `m3/7-ai-local-edit-invalidates` | `31-m3-ai.mjs:631-732` | typing after Generate makes Accept fail with `ai-stale[data-reason="revision"]`; neither store moves; nothing partially applied |
| `m3/9-ai-remote-inside-stale` | `31-m3-ai.mjs:859-981` | a peer edit **inside** the anchor produces `data-reason="text-mismatch"` (not `revision`), exact frozen sentence, both stores unchanged |
| `m3/10-ai-viewer-cannot-accept` | `31-m3-ai.mjs:983-1129` | viewer sees proposal + diff; Accept is `disabled` with a title; a programmatic `.click()` changes neither store and emits no SYNC frame |
| `m3/11-ai-offline-accept-then-reconnect` | `31-m3-ai.mjs:1131-1582` | owner: offline Accept updates local `Y.Text` and durable store; after reconnect all three (editor, durable, second device) hold the expected text exactly once. Offline viewer: role unknown → Accept clickable, edit stays local, no SYNC, no forbidden, survives reload |
| `m3r/1-remote-draft-preview-accept` | `tests/browser/suite/33-m3-remote.mjs:459-713` | no local intent chips; real `POST /api/ai/suggest` → 200; server stub summary; diff non-empty; editor/durable unchanged before Accept; Accept persists `toUpperCase()`; Undo/Redo step over one transaction |
| `m3r/2-remote-provider-unconfigured` | `33-m3-remote.mjs:714-841` | backend default (`AI_PROVIDER` unset) → 503; typed `not-configured` error; no proposal, no Accept, neither store moves |

`m3r/*` runs only with `INSIGHTHUB_E2E_AI_MODE=remote`; the default 73 does not include it
(`tests/browser/README.md:73-100`). The remote group was **not run** in the evidence round
(`A6-evidence-gate-round2.md:211-212`).

### E.4 Historical flake

The three recorded flakes must stay visible; deleting them because the suite is now green would
overstate the evidence (`FLAKE-LOG.md:1-20`):

| Scenario | Symptom | Rerun | Classification |
| --- | --- | --- | --- |
| `f1/1` | editor probe not attached after 9.4 s | full suite 73/73 (`1807ea1`); filtered 1/1 | closed at the observed rate; cause not isolated |
| `m3/5` | editor text contained markers from earlier scenarios before Generate | full suite 73/73; filtered 1/1 twice | **open (not reproduced)**; leak path never identified |
| `origin-http.test.ts` (server) | one transient `fetch failed` in bootstrap | 500/500 rerun | harness/network transient, **open** |

**What this proves.** The proposal path is non-destructive, stale-safe, permission-gated, and its
Accept is visible to a peer as a normal CRDT edit; the default suite is green and the three known
flakes are recorded rather than hidden.

**What it does not prove.** Remote mode 78/78; a successful external-model call; model quality,
latency, token usage or cost; Playwright coverage; three-plus-user collaboration; production
readiness.

---

## 6. Measured Evidence

| Measurement | Value | Source |
| --- | --- | --- |
| default real-browser regression | **73/73 PASS, exit 0** (ports released, 11 temp dirs, no live handles) | `A6-evidence-gate-round2.md:12,40-43,171-172` |
| suite registration | **78** total = 73 default + 5 env-gated `m3r/*` | `tests/browser/README.md:83,407-409`; re-counted at `874f107` |
| remote run | **not executed** (78 is a registration count, not a pass count) | `A6-evidence-gate-round2.md:211-212`; `A7-claim-evidence-review.md:300` |
| external AI live | **0 successful calls** recorded; OpenAI 429 `credit_balance_exhausted`; Kimi 400 `invalid_request_error` | `D-085:3644-3648`; `kimi.ts:25-32`; `A7:56,104` |
| AI scenarios in default | 7 (`31-m3-ai`) + 1 stale = 8 | counted from `runner.scenario(` at `874f107` |
| AI latency / tokens / cost / quality | **not measured** | no such metric exists in `tests/**` or `docs/**` |

Environment: Windows 11 10.0.26200 x64, Chrome 155.0.8059.85 headless, Node v22.14.0, pnpm 10.34.7
(`A6-evidence-gate-round2.md:9`).

There is no "73/73 PASS" artifact committed (`tests/browser/artifacts/` is generated). The number is
recorded in the committed reports and flake log; the command is committed; the test/product code at
`1807ea1` (when the full-suite rerun was recorded) is identical to `874f107` by
`git diff 1807ea1..874f107 -- tests/browser apps packages` (empty).

---

## 7. Failure / Edge Cases

**A remote edit inside the proposal's anchor.** A peer changes text inside the range the proposal was
built for. On Accept, `revision` may still match (the revision counter can be unchanged), but the
resolved anchor text is no longer the reviewed `expectedText`, so `applySuggestion` returns
`text-mismatch` **before writing anything**; the panel keeps the proposal visible and shows
`ai-stale[data-reason="text-mismatch"]` with the frozen sentence; editor and durable store are
unchanged (`m3/9`; `tests/browser/README.md:361`). The distinction matters: it is not reported as
"the document moved" (revision) but as "the text you reviewed is gone" (`text-mismatch`). The same
code path also rejects a fully deleted range, which a naive anchor-only implementation would happily
apply.

**A remote edit outside the anchor.** The peer edit outside the range leaves the proposal pending and
`data-base-revision` unchanged; Accept applies and the durable text holds both edits (`m3/8`;
`tests/browser/README.md:360`). This is the useful case: concurrent work does not always invalidate a
proposal.

**A viewer tries to accept programmatically.** The button is disabled, and a synthetic `.click()`
still writes nothing and emits no SYNC frame (`m3/10`; `tests/browser/README.md:362`). Even if a
client bypassed the UI entirely, the server's per-frame `canEdit` check would refuse the resulting
update (`registry.ts:752-759`).

**The provider fails or is not configured.** `503 provider_not_configured` with a typed error and no
proposal (`m3r/2`); a provider that returns malformed output is mapped to `invalid-output` and never
becomes a proposal (`remoteProvider.ts:194-197`; `route.ts:327-343`). The product shows an error, not
an empty diff the user could accept for no effect.

---

## 8. Limitations

- **`NOT VERIFIED`（external AI live）** — no successful call. OpenAI `429 credit_balance_exhausted`
  is a billing finding; Kimi `400 invalid_request_error` led to a prompt-only change that has **not
  been retried** (`D-085:3644-3648`; `kimi.ts:25-32`; `A7:56,302`). Do not write "真实大模型已跑通".
- **`NOT IMPLEMENTED`（default model behaviour）** — the default provider is a deterministic
  five-instruction table, not a language model (`localProvider.ts:11-37`). Free-form
  rewrite/expand/shorten requires a configured external provider, which is not live-verified. Do not
  claim "AI 自动改写".
- **Tooling claim correction** — the 73/73 is **CDP**, not Playwright
  (`tests/browser/README.md:22-36`). Playwright appears only in the opt-in deployed B13 smoke
  (`package.json:28-30`; `tests/deployed/b13.mjs:12,29,131`).
- **`NOT VERIFIED`（remote 78）** — 78 is the registration count; the remote group was not run
  (`A6:211-212`). Never write "78/78 PASS".
- **Provenance** — the 73/73 run is recorded at `1807ea1`, not re-run at `874f107`; the
  test/product trees are identical, but `tests/browser/artifacts/` is not committed. A reviewer can
  re-run the command, not re-read the original JSON from the repo.
- **Historical flake** — `m3/5` is open (state leak never reproduced), `f1/1` is closed only at the
  observed rate, `origin-http.test.ts` is open (`FLAKE-LOG.md:9-11`). They do not overturn the
  current green run, but they qualify it.
- **`NOT VERIFIED`（AI across a document switch）** — no scenario delays an AI response, switches
  documents and releases it. The indirect evidence is panel unmount + abort + the `documentId`
  check (`A7:92`). Do not claim a direct test.
- **Scope** — `anchor-unresolved` has Node evidence only; browser coverage is `revision` and
  `text-mismatch` (`D-081 §5` residual 6). `revision` is a client-local counter, so a proposal is not
  shareable across clients (`D-081 §5` residual 9). A 500 ms `UndoManager.captureTimeout` can merge
  "type + Accept" into one undo item (`D-081 §5` residual 8).
- **Environment** — Chromium 155 headless on Windows 11 only (`A6:210`); no Firefox/Safari, no
  mobile.
- **Product scope** — no Markdown preview, no search, no comment feature; `commenter` is a
  permission tier only (`PROJECT.md:39`). Do not attach any of these to the AI bullet.
- **Production readiness** — `NOT VERIFIED`. M3 CLOSED ≠ production ready; M4 persistence/deploy
  gates are blocked by payment (`PROJECT.md:52-53`; `A7:58`).

---

## 9. Interview Explanation (60–90 seconds)

“AI 编辑我把它当成‘提案’，不是状态。用户在面板里写指令，provider 只返回 summary 和 operations，**不带锚点**；客户端拿当前 Y.Text 现场生成 RelativePosition 锚点、校验 expectedText、算 unified diff，然后把提案放在面板状态里。Accept 之前正文一个字节都不变。

Accept 的校验顺序是 documentId、revision、锚点能不能解析、锚点处的文本是否等于用户看过的 expectedText、以及多个 operation 是否重叠；任何一项失败都直接返回，不写。通过之后所有操作在**一个** Yjs transaction 里、以 ai origin 写入，所以 peer 看到的是普通 CRDT 编辑，Undo 只撤 AI 这一笔，不会撤远端。Reject 只清面板状态，不碰 Y.Text。viewer 的 Accept 是 disabled，程序化点击也不写；就算绕过 UI，服务端每帧还会查 canEdit。

测试是真实 Chromium，走 CDP，不是 Playwright——Playwright 只在可选的 deployed B13 smoke 里。默认套件 73/73；remote 模式是 78 个注册场景，5 个 m3r 被环境变量门控，这一轮**没有跑**。外部 provider 的 live 也还没成功：OpenAI 是 429 余额，Kimi 是 400 后改成 prompt-only 但没重试，所以我只能说 IMPLEMENTED / NOT LIVE-VERIFIED。”
