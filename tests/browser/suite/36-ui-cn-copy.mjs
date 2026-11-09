/**
 * A6 — the Simplified-Chinese copy contract (A2 UI-copy unification).
 *
 * ## Why a dedicated scenario
 *
 * The rest of the suite already proves **behaviour** (concurrency, durability, permissions,
 * undo, AI transactions) against the shipped path. This scenario proves the other half of the
 * same release: that the human-readable surface is Simplified Chinese, while every
 * machine-readable contract the suite relies on is unchanged.
 *
 * That distinction is the whole point, so both halves are asserted together:
 *
 * | Machine contract (must not change) | Human copy (must be Chinese) |
 * | --- | --- |
 * | `data-testid` names, `data-status`, `data-phase`, `data-intent`, `data-*` error kinds | visible labels, `aria-label`, `title`, status lines, empty/failure sentences |
 * | the wire role (`owner`/`editor`/`viewer`) from `room-joined` / `getRole()` | the header chip's `角色：…` label |
 * | the instruction token the local provider parses (`uppercase`, `add-todo`, …) | the preset chip's visible label (`转为大写`, `添加待办`, …) |
 *
 * A test that only matched Chinese text could pass with `data-intent` renamed; a test that only
 * matched `data-intent` could pass with English chips. Both are required here.
 *
 * ## Scope discipline
 *
 * No product file is touched and no test-only hook is used. Every value is read from the live
 * DOM of the real application, after real clicks and real keystrokes; the AI proposal is
 * generated through the deterministic local provider and accepted through the real Yjs
 * transaction path (the durable/peer half is `31-m3-ai.mjs`'s job, not repeated here).
 */
import {
  readConnectionStatus,
  readEditorGate,
  readHistoryButtons,
  readUndoState,
  roleChipText,
  ROLE_LABELS,
  SELECTORS,
  sleep,
  typeInEditor,
  undoStateText,
  waitForConnectionStatus,
  waitForEditorText,
  waitUntil,
} from '../lib/app.mjs';
import { DEMO_USERS } from '../lib/authz-fixture.mjs';
import { assert, assertDeepEqual, assertEqual, assertIncludes } from '../lib/harness.mjs';

const AI = {
  open: '[data-testid="ai-open"]',
  panel: '[data-testid="ai-panel"]',
  instruction: '[data-testid="ai-instruction"]',
  intent: '[data-testid="ai-intent"]',
  generate: '[data-testid="ai-generate"]',
  status: '[data-testid="ai-status"]',
  empty: '[data-testid="ai-empty"]',
  proposal: '[data-testid="ai-proposal"]',
  summary: '[data-testid="ai-summary"]',
  diff: '[data-testid="ai-diff"]',
  stale: '[data-testid="ai-stale"]',
  accept: '[data-testid="ai-accept"]',
  reject: '[data-testid="ai-reject"]',
  close: '[data-testid="ai-close"]',
  directory: '[data-testid="ai-directory"]',
  directoryTitle: '.ai-directory__title',
  directoryNote: '.ai-directory__note',
  directoryRefresh: '[data-testid="ai-directory-refresh"]',
  newDocument: '[data-testid="new-document"]',
  directoryCurrent: '.ai-directory__current',
};

/** The frozen copy this scenario asserts. Duplicated on purpose: a wording change must fail. */
const COPY = {
  connection: {
    connected: '已连接',
    description: '已连接到文档房间；断线恢复后会自动追平，并继续把编辑同步给协作者。',
  },
  collaborators: { label: '协作者', empty: '只有你在这里' },
  documentInput: '文档 ID',
  directory: {
    label: '可阅读的文档',
    title: '文档',
    note: '你的身份可阅读的文档。选择其中一个即可打开；建议仍针对当前活动的文档。',
    refresh: '刷新',
    newDocument: '新建文档',
    newDocumentTitle: '创建一个归你所有的新文档',
    current: '当前',
  },
  panel: {
    label: 'AI 建议',
    title: '询问 AI',
    openAria: '询问 AI',
    closeAria: '关闭 AI 面板',
    close: '关闭',
    fieldLabel: '指令',
    instructionAria: 'AI 指令',
    instructionPlaceholder: '例如：uppercase（转为大写）',
    localHint: '请选择预设操作',
    generate: '生成',
    generateTitle: '根据当前文档和选区生成建议',
    actionsHint: '目标：当前选区；未选中时作用于整篇文档。',
    idleStatus: '尚无建议。',
    idleEmpty: '尚无建议——请点击上方预设操作（或输入指令），然后点击生成。',
    proposalStatus: '建议已就绪——在你点击接受之前，文档不会改变。',
    appliedStatus: '建议已通过 Yjs 事务应用。可使用撤销回退。',
    appliedEmpty: '已应用。可继续生成新的建议。',
    rejectedStatus: '建议已放弃——文档没有改变。',
    rejectedEmpty: '已放弃。没有向文档写入任何内容。',
    staleStatus: '该建议已失效，未应用。文档没有改变。',
    accept: '接受',
    acceptTitle: '将此建议应用到文档',
    acceptViewerTitle: '你的角色为只读',
    acceptStaleTitle: '此建议已失效——请生成新的建议',
    reject: '拒绝',
    rejectTitle: '放弃此建议，不改变文档',
    diffLabel: '统一差异预览',
  },
  notice: {
    title: '你的角色为只读',
    detail: '你在本文档中的角色是“只读查看者”，不包含编辑权限。此编辑器已禁用输入，不会向文档写入任何更改。',
  },
};

/** Visible label for every local intent; the provider token is the `data-intent` value. */
const CHIP_LABELS = {
  uppercase: '转为大写',
  'trim-trailing-space': '去除行尾空格',
  'add-todo': '添加待办',
  'replace-selection': '替换选区',
  'delete-selection': '删除选区',
};

/** Every fact this scenario asserts, read from the live DOM in one round trip. */
async function readUiCopy(page) {
  return page.evaluate((selectors) => {
    const one = (selector) => document.querySelector(selector);
    const text = (selector) => (one(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const attr = (selector, name) => one(selector)?.getAttribute(name) ?? null;
    const chip = [...document.querySelectorAll(selectors.roleChipSpans)].find((node) =>
      /^角色：\S+$/.test((node.textContent ?? '').trim()),
    );
    return {
      connection: {
        status: one(selectors.connectionStatus)?.getAttribute('data-status') ?? null,
        label: text(`${selectors.connectionStatus} .conn-pill__label`),
        description: attr(selectors.connectionStatus, 'title'),
      },
      collaborators: {
        label: attr(selectors.collaboratorList, 'aria-label'),
        empty: text(`${selectors.collaboratorList} .collab-group__empty`),
      },
      roleChip: chip === undefined ? null : (chip.textContent ?? '').trim(),
      documentInput: {
        label: attr(selectors.documentInput, 'aria-label'),
        value: one(selectors.documentInput)?.value ?? null,
      },
      undo: {
        aria: attr(selectors.undoButton, 'aria-label'),
        title: attr(selectors.undoButton, 'title'),
        redoAria: attr(selectors.redoButton, 'aria-label'),
        redoTitle: attr(selectors.redoButton, 'title'),
        state: text(selectors.undoState),
      },
      directory: {
        label: attr(selectors.directory, 'aria-label'),
        title: text('.ai-directory__title'),
        note: text('.ai-directory__note'),
        refresh: text('[data-testid="ai-directory-refresh"]'),
        newDocument: text('[data-testid="new-document"]'),
        newDocumentTitle: attr('[data-testid="new-document"]', 'title'),
        current: text('.ai-directory__current'),
      },
      panel: {
        openAria: attr('[data-testid="ai-open"]', 'aria-label'),
        present: one('[data-testid="ai-panel"]') !== null,
        label: attr('[data-testid="ai-panel"]', 'aria-label'),
        title: text('.ai-panel__title'),
        closeAria: attr('[data-testid="ai-close"]', 'aria-label'),
        close: text('[data-testid="ai-close"]'),
        fieldLabel: text('.ai-field__label'),
        instructionAria: attr('[data-testid="ai-instruction"]', 'aria-label'),
        instructionPlaceholder: attr('[data-testid="ai-instruction"]', 'placeholder'),
        instruction: one('[data-testid="ai-instruction"]')?.value ?? null,
        localHint: text('[data-testid="ai-local-hint"]'),
        generate: text('[data-testid="ai-generate"]'),
        generateTitle: attr('[data-testid="ai-generate"]', 'title'),
        actionsHint: text('.ai-actions__hint'),
        chips: [...document.querySelectorAll('[data-testid="ai-intent"]')].map((node) => ({
          label: (node.textContent ?? '').trim(),
          intent: node.getAttribute('data-intent'),
          title: node.getAttribute('title'),
        })),
        phase: one('[data-testid="ai-panel"]')?.getAttribute('data-phase') ?? null,
        status: text('[data-testid="ai-status"]'),
        providerError: attr('[data-testid="ai-status"]', 'data-provider-error'),
        empty: text('[data-testid="ai-empty"]'),
        proposalStatus: attr('[data-testid="ai-proposal"]', 'data-status'),
        summary: text('[data-testid="ai-summary"]'),
        diffLabel: attr('[data-testid="ai-diff"]', 'aria-label'),
        staleReason: attr('[data-testid="ai-stale"]', 'data-reason'),
        staleText: text('[data-testid="ai-stale"]'),
        accept: text('[data-testid="ai-accept"]'),
        acceptTitle: attr('[data-testid="ai-accept"]', 'title'),
        acceptDisabled: one('[data-testid="ai-accept"]')?.disabled ?? null,
        reject: text('[data-testid="ai-reject"]'),
        rejectTitle: attr('[data-testid="ai-reject"]', 'title'),
      },
      notice: {
        present: one(selectors.readOnlyNotice) !== null,
        title: text(`${selectors.readOnlyNotice} .read-only-notice__title`),
        detail: text(`${selectors.readOnlyNotice} .read-only-notice__detail`),
      },
    };
  }, {
    ...SELECTORS,
    connectionStatus: '[data-testid="connection-status"]',
    directory: '[data-testid="ai-directory"]',
    roleChipSpans: 'span',
  });
}

async function openPanel(page) {
  await page.click(AI.open);
  await waitUntil(
    async () =>
      (await page.evaluate(
        () => document.querySelector('[data-testid="ai-panel"]')?.getAttribute('data-phase'),
      )) === 'idle',
    { label: 'the AI panel to open in its idle phase', timeoutMs: 20_000 },
  );
}

async function waitForPhase(page, phase) {
  await waitUntil(
    async () =>
      (await page.evaluate(
        () => document.querySelector('[data-testid="ai-panel"]')?.getAttribute('data-phase'),
      )) === phase,
    { label: `the AI panel to reach data-phase="${phase}"`, timeoutMs: 25_000 },
  );
}

export function register(runner) {
  runner.scenario(
    'ui-cn/copy-contract',
    'the live workbench is Simplified Chinese — connection, collaborators, role chip, undo/redo, directory, new-document, AI instructions/presets/generate/accept/reject/stale/empty and the read-only notice — while data-testid, data-intent, data-phase and the wire role stay unchanged',
    async (ctx) => {
      const documentId = `a6-ui-cn-${Math.random().toString(36).slice(2, 8)}`;
      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await typeInEditor(page, 'Hello Chinese copy contract');
      await waitForEditorText(page, (text) => text.includes('Hello Chinese copy contract'), {
        label: 'the seeded text',
      });

      /* ---------- workbench chrome ---------- */
      const chrome = await readUiCopy(page);
      ctx.note('workbench copy (owner)', chrome);
      assertEqual(chrome.connection.status, 'connected', 'the badge still carries data-status');
      assertEqual(chrome.connection.label, COPY.connection.connected, 'the connection label is Chinese');
      assertEqual(
        chrome.connection.description,
        COPY.connection.description,
        'the connection description is the Chinese sentence',
      );
      assertEqual(chrome.collaborators.label, COPY.collaborators.label, 'the list aria-label is Chinese');
      assertEqual(
        chrome.collaborators.empty,
        COPY.collaborators.empty,
        'the collaborator empty state is “只有你在这里”',
      );
      assertEqual(chrome.roleChip, roleChipText('owner'), 'the role chip is 角色：所有者');
      assertEqual(chrome.documentInput.label, COPY.documentInput, 'the document input is 文档 ID');
      assertEqual(chrome.documentInput.value, documentId, 'the input still holds the active id');
      assertEqual(chrome.undo.aria, '撤销', 'the Undo accessible name is 撤销');
      assertEqual(chrome.undo.redoAria, '重做', 'the Redo accessible name is 重做');
      assertEqual(chrome.undo.title, '撤销', 'the Undo title is 撤销');
      assertEqual(chrome.undo.redoTitle, '重做', 'the Redo title is 重做');
      assertEqual(
        chrome.undo.state,
        undoStateText({ canUndo: true, canRedo: false }),
        'the undo-state vocabulary is Chinese (the seed keystroke is undoable)',
      );

      /* ---------- directory + new document ---------- */
      await openPanel(page);
      // The directory is server truth and the join's metadata write can trail the panel opening,
      // so wait for the product's own `data-state="ready"` and its aria-current marker.
      await waitUntil(
        async () =>
          await page.evaluate(
            () =>
              document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ===
                'ready' &&
              document.querySelector('[data-testid="ai-directory-item"][aria-current="true"]') !==
                null,
          ),
        { label: 'the directory to list the active document', timeoutMs: 25_000 },
      );
      const panelIdle = await readUiCopy(page);
      ctx.note('AI panel + directory copy (idle, local provider)', panelIdle);
      assertEqual(panelIdle.directory.label, COPY.directory.label, 'the directory aria-label is Chinese');
      assertEqual(panelIdle.directory.title, COPY.directory.title, 'the directory heading is 文档');
      assertEqual(panelIdle.directory.note, COPY.directory.note, 'the directory note is Chinese');
      assertEqual(panelIdle.directory.refresh, COPY.directory.refresh, 'Refresh is 刷新');
      assertEqual(
        panelIdle.directory.newDocument,
        COPY.directory.newDocument,
        'New document is 新建文档',
      );
      assertEqual(
        panelIdle.directory.newDocumentTitle,
        COPY.directory.newDocumentTitle,
        'the creation control title is Chinese',
      );
      assertEqual(
        panelIdle.directory.current,
        COPY.directory.current,
        'the aria-current marker renders 当前',
      );

      /* ---------- AI panel chrome ---------- */
      assertEqual(panelIdle.panel.openAria, COPY.panel.openAria, 'the AI trigger is 询问 AI');
      assertEqual(panelIdle.panel.label, COPY.panel.label, 'the panel aria-label is AI 建议');
      assertEqual(panelIdle.panel.title, COPY.panel.title, 'the panel heading is 询问 AI');
      assertEqual(panelIdle.panel.closeAria, COPY.panel.closeAria, 'the close aria-label is 关闭 AI 面板');
      assertEqual(panelIdle.panel.close, COPY.panel.close, 'the close label is 关闭');
      assertEqual(panelIdle.panel.fieldLabel, COPY.panel.fieldLabel, 'the field label is 指令');
      assertEqual(panelIdle.panel.instructionAria, COPY.panel.instructionAria, 'the textarea is AI 指令');
      assertEqual(
        panelIdle.panel.instructionPlaceholder,
        COPY.panel.instructionPlaceholder,
        'the local placeholder is Chinese',
      );
      assertEqual(panelIdle.panel.localHint, COPY.panel.localHint, 'the local hint is 请选择预设操作');
      assertEqual(panelIdle.panel.generate, COPY.panel.generate, 'Generate is 生成');
      assertEqual(panelIdle.panel.generateTitle, COPY.panel.generateTitle, 'the Generate title is Chinese');
      assertEqual(panelIdle.panel.actionsHint, COPY.panel.actionsHint, 'the target hint is Chinese');
      assertEqual(panelIdle.panel.status, COPY.panel.idleStatus, 'the idle status is 尚无建议。');
      assertEqual(panelIdle.panel.empty, COPY.panel.idleEmpty, 'the idle empty copy is Chinese');

      /* ---------- preset chips: Chinese label, frozen English intent ---------- */
      assertDeepEqual(
        panelIdle.panel.chips.map((chip) => chip.label),
        Object.values(CHIP_LABELS),
        'every preset chip renders its Chinese label, in the product order',
      );
      assertDeepEqual(
        panelIdle.panel.chips.map((chip) => chip.intent),
        Object.keys(CHIP_LABELS),
        'data-intent still carries the frozen provider tokens (uppercase, add-todo, …)',
      );
      for (const chip of panelIdle.panel.chips) {
        assert(
          typeof chip.title === 'string' && /[\u4e00-\u9fff]/.test(chip.title),
          `the "${chip.intent}" chip tooltip must be Chinese, got ${JSON.stringify(chip.title)}`,
        );
      }

      /* ---------- a real proposal, then accept ---------- */
      await page.click(`${AI.intent}[data-intent="uppercase"]`);
      const seeded = await readUiCopy(page);
      assertEqual(
        seeded.panel.instruction,
        'uppercase',
        'clicking the Chinese chip still seeds the English instruction the provider parses',
      );
      await page.click(AI.generate);
      await waitForPhase(page, 'proposal');
      const proposal = await readUiCopy(page);
      ctx.note('AI proposal copy', proposal.panel);
      assertEqual(proposal.panel.status, COPY.panel.proposalStatus, 'the proposal status is Chinese');
      assertEqual(proposal.panel.proposalStatus, 'pending', 'data-status still marks the proposal pending');
      assertEqual(proposal.panel.summary, '将整篇文档转为大写', 'the local summary is Chinese');
      assertEqual(proposal.panel.diffLabel, COPY.panel.diffLabel, 'the diff aria-label is Chinese');
      assertEqual(proposal.panel.accept, COPY.panel.accept, 'Accept is 接受');
      assertEqual(proposal.panel.acceptTitle, COPY.panel.acceptTitle, 'the Accept title is Chinese');
      assertEqual(proposal.panel.reject, COPY.panel.reject, 'Reject is 拒绝');
      assertEqual(proposal.panel.rejectTitle, COPY.panel.rejectTitle, 'the Reject title is Chinese');

      await page.click(AI.accept);
      await waitForPhase(page, 'applied');
      const applied = await readUiCopy(page);
      ctx.note('AI applied copy', applied.panel);
      assertEqual(applied.panel.status, COPY.panel.appliedStatus, 'the applied status is Chinese');
      assertEqual(applied.panel.empty, COPY.panel.appliedEmpty, 'the applied empty copy is Chinese');

      /* ---------- reject ---------- */
      // The document is already uppercase (the accepted edit), so a second `uppercase` would be a
      // real `no-change` failure rather than a proposal. `add-todo` changes the text deterministically.
      await page.click(`${AI.intent}[data-intent="add-todo"]`);
      await page.click(AI.generate);
      await waitForPhase(page, 'proposal');
      await page.click(AI.reject);
      await waitForPhase(page, 'rejected');
      const rejected = await readUiCopy(page);
      ctx.note('AI rejected copy', rejected.panel);
      assertEqual(rejected.panel.status, COPY.panel.rejectedStatus, 'the rejected status is Chinese');
      assertEqual(rejected.panel.empty, COPY.panel.rejectedEmpty, 'the rejected empty copy is Chinese');

      /* ---------- stale (expired) proposal ---------- */
      await page.click(`${AI.intent}[data-intent="add-todo"]`);
      await page.click(AI.generate);
      await waitForPhase(page, 'proposal');
      await typeInEditor(page, ' +local');
      await sleep(400);
      await page.click(AI.accept);
      await waitForPhase(page, 'stale');
      const stale = await readUiCopy(page);
      ctx.note('AI stale copy', stale.panel);
      assertEqual(stale.panel.staleReason, 'revision', 'data-reason still carries the typed reason');
      assertEqual(
        stale.panel.staleText,
        '生成此建议后，文档已在本地被修改。',
        'the stale sentence is the Chinese `revision` copy',
      );
      assertEqual(stale.panel.status, COPY.panel.staleStatus, 'the stale status is Chinese');
      assertEqual(stale.panel.acceptDisabled, true, 'a stale proposal cannot be accepted');
      assertEqual(stale.panel.acceptTitle, COPY.panel.acceptStaleTitle, 'the stale Accept title is Chinese');
      await page.click(AI.close);

      /* ---------- the read-only notice, in the same Chinese vocabulary ---------- */
      const viewerDocumentId = `a6-ui-cn-viewer-${Math.random().toString(36).slice(2, 8)}`;
      const viewer = await ctx.newAppPage({
        documentId: viewerDocumentId,
        as: DEMO_USERS.linus,
        role: 'viewer',
      });
      await waitForConnectionStatus(viewer, 'connected', { timeoutMs: 30_000 });
      await waitUntil(
        async () => (await readEditorGate(viewer)).roleTag === roleChipText('viewer'),
        { label: 'the viewer role chip', timeoutMs: 30_000 },
      );
      const viewerGate = await readEditorGate(viewer);
      const viewerCopy = await readUiCopy(viewer);
      ctx.note('viewer copy', { roleTag: viewerGate.roleTag, notice: viewerGate.notice, copy: viewerCopy });
      assertEqual(viewerGate.roleTag, roleChipText('viewer'), 'the viewer chip is 角色：只读查看者');
      assertEqual(viewerGate.contentEditable, 'false', 'the viewer editor is still read-only');
      assertEqual(viewerGate.viewReadOnly, true, 'the live EditorState is still read-only');
      assertEqual(viewerCopy.notice.present, true, 'the notice is rendered for the viewer');
      assertEqual(viewerCopy.notice.title, COPY.notice.title, 'the notice headline is 你的角色为只读');
      assertEqual(viewerCopy.notice.detail, COPY.notice.detail, 'the notice detail is the Chinese model');
      assertIncludes(
        viewerCopy.notice.detail,
        ROLE_LABELS.viewer,
        'the notice detail names the same role label the chip shows',
      );
      assertEqual(viewerCopy.connection.label, COPY.connection.connected, 'the viewer badge is 已连接');
      assertEqual(viewerCopy.undo.aria, '撤销', 'the viewer Undo keeps its Chinese accessible name');

      await openPanel(viewer);
      const viewerPanel = await readUiCopy(viewer);
      ctx.note('viewer AI panel copy', viewerPanel.panel);
      assertEqual(viewerPanel.panel.label, COPY.panel.label, 'the viewer panel aria-label is Chinese');
      assertEqual(viewerPanel.panel.generate, COPY.panel.generate, 'the viewer can still 生成');
      assertDeepEqual(
        viewerPanel.panel.chips.map((chip) => chip.label),
        Object.values(CHIP_LABELS),
        'the viewer sees the same Chinese preset labels',
      );
    },
  );
}
