/**
 * M3 — the **AI proposal loop** as a permanent real-browser scenario (`docs/DECISIONS.md` D-075).
 *
 * The four-node AI chain (A1 anchor helpers → A4 orchestration → A2 Diff Preview → A0 integration)
 * shipped with Node-level tests (`packages/shared/src/ai-anchor.test.ts`,
 * `apps/web/src/features/ai/*.test.ts`, `apps/web/src/features/editor/aiProposal.test.ts`). A Node
 * test can prove `applySuggestion` validates before it writes; it cannot prove that the **real
 * panel**, wired to the **real `Y.Doc`**, over the **real server**, leaves the editor and the
 * durable store untouched until a user clicks Accept — and it cannot observe that an accepted
 * suggestion reaches a second client as an ordinary CRDT update. That is what these scenarios are
 * for (`AGENTS.md` R5; `docs/DECISIONS.md` D-033).
 *
 * | Scenario | D-075 §6 | What is asserted |
 * | --- | --- | --- |
 * | `m3/5-ai-proposal-and-accept` | A, E | proposal first; Accept changes editor + durable + a peer; Undo reverts **only** the AI edit; Redo restores it |
 * | `m3/6-ai-reject-writes-nothing` | B | Reject clears the proposal and changes neither the editor nor the durable store |
 * | `m3/7-ai-local-edit-invalidates` | C (revision) | typing after Generate makes Accept fail with `stale[data-reason="revision"]`; nothing applied |
 * | `m3/8-ai-remote-outside-applies` | C, D | a peer edit **outside** the anchor does not invalidate the proposal; Accept applies both edits |
 * | `m3/9-ai-remote-inside-stale` | C, D | a peer edit **inside** the anchor is rejected as `text-mismatch`, never as `revision` |
 * | `m3/10-ai-viewer-cannot-accept` | F | a viewer sees the proposal and diff, but Accept is disabled, explained, and inert — no text change and **no SYNC frame** |
 * | `m3/11-ai-offline-accept-then-reconnect` | G + A5 P3-a | **phase 1 (owner offline):** reconnect applies the edit **once** and a second device converges. **phase 2 (viewer offline):** the resulting local divergence never leaves the client, is never `FORBIDDEN`, and survives a reload |
 *
 * ## The two subjects of "offline Accept" (m3/11)
 *
 * `m3/11` deliberately contains two phases, because "offline" has two different consequences and
 * they must not be confused:
 *
 * - **phase 1 — owner offline (D-075 G).** The owner's offline AI edit is an ordinary offline
 *   edit: it lives in `Y.Text` and IndexedDB, the durable store stays old until the socket returns,
 *   and the reconnect uploads it exactly once so every client converges.
 * - **phase 2 — viewer offline (A5 P3-a).** A viewer who loses the connection has, by contract,
 *   **no role**: `getRole()` returns `null` while disconnected (`docs/CONTRACTS.md` §17.9 rule 2).
 *   The unknown-role rule (`AGENTS.md` R10) then reports `canEdit: true`, the editor becomes
 *   editable and **Accept becomes clickable**. That is not a failure of the viewer gate — there is
 *   no known role to gate on — and the server still never accepts the resulting update. The
 *   divergence stays local forever (no server `SyncStep1` is sent to a non-editor, so no
 *   `SyncStep2` is requested, so no `FORBIDDEN` is even possible) and IndexedDB replays it after a
 *   reload. **Do not "fix" `capabilityGate(null)` because of this scenario:** the behaviour is the
 *   frozen unknown-role rule, measured and recorded by A5, and the phase fixes the divergence's
 *   persistence in place rather than claiming it is correct product behaviour.
 *
 * ## Why every write claim reads the durable store
 *
 * "The editor shows X" is not evidence that anything was persisted (`tests/browser/README.md`).
 * Each scenario therefore rebuilds the document from `insighthub.db` (`snapshot` + the update log)
 * and compares the **text**, so "the suggestion was not applied" means the bytes on the server are
 * byte-for-byte unchanged, not merely that a React state did not re-render.
 *
 * ## Why a second client is a real peer, not the same tab
 *
 * For `m3/8`/`m3/9` the second editor is a `WireOracle` — a genuine Yjs peer speaking the frozen
 * wire codec over a real authenticated socket (`lib/oracle.mjs`). It is the right instrument here
 * because the scenario must place an edit at an exact offset *inside* or *outside* the anchored
 * range; where the edit lands is the whole variable. For `m3/11` the witness is a **separate
 * browser profile** (`ctx.withFreshBrowser`), because that scenario's claim is about server
 * convergence, and a tab in the same profile would share IndexedDB with the writer and could pass
 * without the reconnect.
 *
 * ## The copy assertions are deliberately literal
 *
 * `APPLY_FAILURE_COPY` (`apps/web/src/features/editor/aiProposalCopy.ts`) freezes one sentence per
 * `ValidationFailureReason`. The browser test cannot import that module (it is bundled), so the
 * sentences are repeated here **on purpose**: a wording change must fail this suite too, because
 * the wording *is* part of what tells the user which of the four failures happened.
 */
import {
  countOutboundSyncFrames,
  countServerErrorCode,
  documentReplica,
  editorState,
  readConnectionStatus,
  readEditorGate,
  readHistoryButtons,
  readIndexedDb,
  readUndoState,
  reloadApp,
  SELECTORS,
  setDocumentId,
  setOffline,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
} from '../lib/app.mjs';
import { DEMO_USERS } from '../lib/authz-fixture.mjs';
import { reconstructDurableDocument, waitForDurableText } from '../lib/durable-store.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';
import { waitForRoleTag } from '../lib/role-gate.mjs';

/* ---------------------------------------------------------------------- *
 * The AI panel's published test ids (A2's deliverable; see the M3 brief)
 * ---------------------------------------------------------------------- */

const AI = {
  openButton: '[data-testid="ai-open"]',
  panel: '[data-testid="ai-panel"]',
  instruction: '[data-testid="ai-instruction"]',
  intentButton: '[data-testid="ai-intent"]',
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
};

/**
 * The frozen sentences (`aiProposalCopy.ts`), duplicated on purpose — see the module doc.
 *
 * `revision` is the *local* failure: this client's own document moved on. `text-mismatch` is the
 * *remote* failure: the anchored text resolved but no longer says what the user reviewed. The two
 * must never be interchangeable, which is exactly what `m3/7` and `m3/9` measure.
 */
const APPLY_FAILURE_COPY = {
  revision: 'The document changed locally since this suggestion was generated.',
  'text-mismatch': 'The text you reviewed has changed.',
};

/** The frozen `ai-status` one-liners this suite asserts (never "saved", never a false claim). */
const STATUS_COPY = {
  proposal: 'Proposal ready — the document is unchanged until you accept.',
  applied: 'Suggestion applied through a Yjs transaction. Use Undo to revert it.',
  stale: 'This suggestion is stale and was not applied. The document is unchanged.',
  rejected: 'Suggestion dismissed — the document is unchanged.',
};

/** A per-run marker, so a left-over replica from an earlier run can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The document text rebuilt from the server's own bytes (never "what the page shows"). */
async function durableText(ctx, documentId) {
  const { text } = await reconstructDurableDocument(ctx.stack.dataPath, documentId);
  return text;
}

/* ---------------------------------------------------------------------- *
 * Reading and driving the panel
 * ---------------------------------------------------------------------- */

/**
 * Every fact about the panel in one round trip.
 *
 * `phase` is `data-phase` on the section — the panel's own state machine, not something inferred
 * from button labels. `proposalStatus`, `baseRevision` and `staleReason` are the `data-*`
 * attributes the M3 brief publishes as the UI contract, so an assertion never matches English
 * where a machine-readable attribute exists.
 */
async function readAiPanel(page) {
  return page.evaluate((selectors) => {
    const one = (selector) => document.querySelector(selector);
    const textOf = (selector) => one(selector)?.textContent?.trim() ?? null;
    const panel = one(selectors.panel);
    const proposal = one(selectors.proposal);
    const accept = one(selectors.accept);
    const stale = one(selectors.stale);
    const diff = one(selectors.diff);
    const instruction = one(selectors.instruction);
    const trigger = one(selectors.openButton);
    return {
      open: panel !== null,
      phase: panel === null ? null : panel.getAttribute('data-phase'),
      status: textOf(selectors.status),
      providerError: one(selectors.status)?.getAttribute('data-provider-error') ?? null,
      empty: textOf(selectors.empty),
      proposalPresent: proposal !== null,
      proposalStatus: proposal === null ? null : proposal.getAttribute('data-status'),
      baseRevision: proposal === null ? null : proposal.getAttribute('data-base-revision'),
      summary: textOf(selectors.summary),
      diff: diff === null ? null : diff.textContent,
      diffLength: diff === null ? 0 : (diff.textContent ?? '').length,
      stalePresent: stale !== null,
      staleReason: stale === null ? null : stale.getAttribute('data-reason'),
      staleText: textOf(selectors.stale),
      acceptPresent: accept !== null,
      acceptDisabled: accept === null ? null : accept.disabled === true,
      acceptTitle: accept === null ? null : accept.getAttribute('title'),
      rejectPresent: one(selectors.reject) !== null,
      instruction: instruction === null ? null : instruction.value,
      intentCount: document.querySelectorAll(selectors.intentButton).length,
      triggerExpanded: trigger === null ? null : trigger.getAttribute('aria-expanded'),
      triggerDisabled: trigger === null ? null : trigger.disabled === true,
    };
  }, AI);
}

/** Poll the panel until `predicate` holds; a timeout reports the whole last state. */
async function waitForAiPanel(
  page,
  predicate,
  { timeoutMs = 25_000, label = 'the AI panel state' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readAiPanel(page);
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${label}; last AI panel state: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/** Open the panel with the real "Ask AI" trigger and wait for its idle state. */
async function openAiPanel(page) {
  await page.click(AI.openButton);
  const panel = await waitForAiPanel(page, (state) => state.open && state.phase === 'idle', {
    label: 'the AI proposal panel to open',
  });
  assertEqual(
    panel.triggerExpanded,
    'true',
    'the Ask AI trigger must report aria-expanded="true" while its panel is open',
  );
  return panel;
}

/**
 * Pick an intent chip (the literal instructions the deterministic provider accepts) and generate.
 *
 * The chip is clicked rather than the textarea typed into: it is the affordance the product offers,
 * and it writes the exact literal into the instruction box, which is asserted before Generate so a
 * broken chip cannot turn into a mysterious "unknown-instruction".
 */
async function generateFromChip(page, intent) {
  await page.click(`${AI.intentButton}[data-intent="${intent}"]`);
  const seeded = await readAiPanel(page);
  assertEqual(
    seeded.instruction,
    intent,
    `the "${intent}" chip must fill the instruction box with the literal instruction`,
  );

  await page.click(AI.generate);
  const panel = await waitForAiPanel(
    page,
    (state) => state.phase === 'proposal' || state.phase === 'error',
    { label: `a proposal for "${intent}"` },
  );
  assertEqual(
    panel.phase,
    'proposal',
    `the local provider must accept "${intent}" (data-provider-error: ${panel.providerError})`,
  );
  assertEqual(panel.proposalPresent, true, 'the proposal phase must render a proposal');
  return panel;
}

/**
 * The content every pending proposal must have: a readable summary, a unified diff, and the
 * revision it was generated against.
 */
function assertProposalContent(panel, { baseRevision, summary }) {
  assertEqual(panel.proposalStatus, 'pending', 'a fresh proposal must be marked pending');
  assert(
    typeof panel.summary === 'string' && panel.summary.trim().length > 0,
    'ai-summary must be non-empty — the proposal has to say what it would do',
  );
  assert(
    typeof panel.diff === 'string' && panel.diff.trim().length > 0,
    'ai-diff must be non-empty — the Diff Preview has to show the change',
  );
  assertIncludes(panel.diff, '+++ ', 'the preview must be a unified diff (+++ header)');
  assertIncludes(panel.diff, '@@ ', 'the preview must carry at least one hunk header (@@)');
  assertEqual(
    panel.baseRevision,
    String(baseRevision),
    'data-base-revision must be the client-local revision the proposal was generated at',
  );
  assertEqual(panel.stalePresent, false, 'a fresh proposal must not be marked stale');
  if (summary !== undefined)
    assertEqual(panel.summary, summary, 'the summary must describe the intent');
}

/** Click the Accept button programmatically (used to prove a disabled control is inert). */
async function clickAcceptProgrammatically(page) {
  return page.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (button === null) return { clicked: false, wasDisabled: null, title: null };
    const wasDisabled = button.disabled === true;
    button.click();
    return { clicked: true, wasDisabled, title: button.getAttribute('title') };
  }, AI.accept);
}

/**
 * Select `length` UTF-16 units starting at `from` with **real keyboard input**.
 *
 * The AI panel reads `EditorState.selection.main` through the editor's `selectionRef`, so a
 * scenario that wants a region-scoped suggestion must produce a genuine selection. The resulting
 * anchor/head are asserted before Generate: if Ctrl+Home or Shift+ArrowRight stopped working, the
 * scenario fails here instead of silently generating a whole-document proposal (which would make
 * `m3/8`/`m3/9` vacuous).
 */
async function selectRange(page, from, length) {
  await page.click(SELECTORS.editorContent);
  await page.pressKey('Home', { modifiers: 2 }); // Ctrl+Home → `cursorDocStart` (defaultKeymap).
  for (let index = 0; index < from; index += 1) await page.pressKey('ArrowRight');
  for (let index = 0; index < length; index += 1) {
    await page.pressKey('ArrowRight', { modifiers: 8 }); // CDP modifier bit 8 = Shift.
  }
  const state = await editorState(page);
  assertEqual(state.anchor, from, 'the real keyboard selection must start at the intended offset');
  assertEqual(
    state.head,
    from + length,
    'the real keyboard selection must cover the intended range',
  );
  return state;
}

/**
 * Wait until the UI has fully applied the **unknown-role** state: the role chip is gone *and* the
 * live editor is editable again.
 *
 * A disconnection makes `session.getRole()` return `null` (§17.9 rule 2). That is not a lost
 * permission decision — it is the state in which R10 says editing must stay usable — and it is
 * exactly the window in which a viewer can click Accept. Both facts are read from the live DOM and
 * the live `EditorState`, so "the gate re-rendered" and "the editor was reconfigured" must both be
 * observed before the scenario acts.
 */
async function waitForUnknownRole(
  page,
  { timeoutMs = 15_000, label = 'the role chip to disappear' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readEditorGate(page);
    if (last.roleTag === null && last.viewReadOnly === false) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${label}; last role tag: ${JSON.stringify(last.roleTag)}, ` +
          `readOnly: ${JSON.stringify(last.viewReadOnly)}`,
      );
    }
    await sleep(100);
  }
}

export function register(runner) {
  /* ================================================================== *
   * 5 — proposal, accept, undo, redo (D-075 A + E)
   * ================================================================== */
  runner.scenario(
    'm3/5-ai-proposal-and-accept',
    'a generated proposal changes nothing until Accept; accepting writes one Yjs transaction that a peer sees, Undo reverts only that AI edit, Redo restores it',
    async (ctx) => {
      const documentId = `a6-m3-ai-accept-${marker('doc')}`;
      // Lower-case on purpose: `uppercase` must really transform it.
      const localText = `local base ${marker('text')}`;

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

      /* ---------- a local edit first, so Undo has something it must NOT revert ---------- */
      await typeInEditor(page, localText);
      const typed = await waitForEditorText(page, (text) => text === localText, {
        label: 'the locally typed baseline',
      });
      const durableTyped = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text === localText,
        { label: 'the locally typed baseline to be persisted' },
      );
      ctx.note('baseline written through the local origin', {
        documentId,
        editorText: JSON.stringify(typed.text),
        durableText: JSON.stringify(durableTyped),
      });

      const panelIdle = await openAiPanel(page);
      ctx.note('panel opened', {
        phase: panelIdle.phase,
        status: panelIdle.status,
        intentCount: panelIdle.intentCount,
      });
      assert(
        panelIdle.intentCount >= 5,
        'the panel must offer the literal local-provider instructions as chips',
      );

      /* ---------- generate: a proposal, not a document change ---------- */
      const proposal = await generateFromChip(page, 'uppercase');
      assertProposalContent(proposal, { baseRevision: 0 });
      assertEqual(
        proposal.summary,
        'Uppercase the document',
        'the summary must name the target the proposal would change',
      );
      assertEqual(proposal.acceptDisabled, false, 'Accept must be enabled for a pending proposal');
      ctx.note('proposal generated', {
        summary: proposal.summary,
        diffLength: proposal.diffLength,
        baseRevision: proposal.baseRevision,
        status: proposal.status,
        diffPreview: proposal.diff.slice(0, 400),
      });
      assertEqual(
        proposal.status,
        STATUS_COPY.proposal,
        'the status line must say nothing changed yet',
      );

      // Give a wrongly-writing implementation every chance to show it: the durable text and the
      // editor must still be exactly the locally typed baseline.
      await sleep(1_500);
      const beforeAccept = await editorState(page);
      const durableBeforeAccept = await durableText(ctx, documentId);
      ctx.note('before Accept', {
        editorText: JSON.stringify(beforeAccept.text),
        durableText: JSON.stringify(durableBeforeAccept),
      });
      assertEqual(beforeAccept.text, localText, 'generating a proposal must not change the editor');
      assertEqual(
        durableBeforeAccept,
        localText,
        'generating a proposal must not change the durable document',
      );

      // An independent peer: the accepted edit must arrive as an ordinary CRDT update.
      const witness = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'accept-witness',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        await witness.waitForText(localText, { label: 'the witness to hydrate the baseline' });

        /* ---------- Accept ---------- */
        await page.click(AI.accept);
        const expected = localText.toUpperCase();
        const applied = await waitForEditorText(page, (text) => text === expected, {
          label: 'the accepted suggestion in the editor',
        });
        const durableApplied = await waitForDurableText(
          ctx.stack.dataPath,
          documentId,
          (text) => text === expected,
          { label: 'the accepted suggestion in the durable document' },
        );
        const afterAccept = await waitForAiPanel(
          page,
          (state) => state.phase === 'applied' && state.proposalPresent === false,
          { label: 'the applied phase' },
        );
        await witness.waitForText(expected, { label: 'the witness to receive the AI edit' });
        ctx.note('after Accept', {
          editorText: JSON.stringify(applied.text),
          durableText: JSON.stringify(durableApplied),
          phase: afterAccept.phase,
          status: afterAccept.status,
          witnessText: JSON.stringify(witness.text),
        });
        assertEqual(applied.text, expected, 'Accept must apply the proposal to the editor');
        assertEqual(
          durableApplied,
          expected,
          'Accept must apply the proposal through a Yjs transaction the server persists',
        );
        assertEqual(
          afterAccept.status,
          STATUS_COPY.applied,
          'the status must report the real apply',
        );
        assertEqual(afterAccept.proposalPresent, false, 'an applied proposal must be cleared');

        /* ---------- Undo reverts the AI edit and only the AI edit ---------- */
        const buttonsAfterAccept = await readHistoryButtons(page);
        ctx.note('history buttons after Accept', buttonsAfterAccept);
        assertEqual(
          buttonsAfterAccept.undo.disabled,
          false,
          'an accepted AI edit must be undoable (UNDO_TRACKED_ORIGINS contains `ai`)',
        );

        await page.click(SELECTORS.undoButton);
        const undone = await waitForEditorText(page, (text) => text === localText, {
          label: 'Undo to revert the AI edit',
        });
        const durableUndone = await waitForDurableText(
          ctx.stack.dataPath,
          documentId,
          (text) => text === localText,
          { label: 'Undo to revert the AI edit in the durable document' },
        );
        await witness.waitForText(localText, { label: 'the witness to see the undo' });
        ctx.note('after Undo', {
          editorText: JSON.stringify(undone.text),
          durableText: JSON.stringify(durableUndone),
          undoState: await readUndoState(page),
        });
        assertEqual(
          undone.text,
          localText,
          'Undo must revert the AI edit and must keep the locally typed text',
        );
        assertEqual(
          durableUndone,
          localText,
          'Undo must revert the AI transaction in the durable document, not restore a snapshot',
        );
        assertIncludes(
          (await readUndoState(page)) ?? '',
          'redo: available',
          'the undone AI edit must be redoable',
        );

        /* ---------- Redo brings the AI edit back ---------- */
        await page.click(SELECTORS.redoButton);
        const redone = await waitForEditorText(page, (text) => text === expected, {
          label: 'Redo to restore the AI edit',
        });
        const durableRedone = await waitForDurableText(
          ctx.stack.dataPath,
          documentId,
          (text) => text === expected,
          { label: 'Redo to restore the AI edit in the durable document' },
        );
        await witness.waitForText(expected, { label: 'the witness to see the redo' });
        ctx.note('after Redo', {
          editorText: JSON.stringify(redone.text),
          durableText: JSON.stringify(durableRedone),
        });
        assertEqual(redone.text, expected, 'Redo must restore the AI edit');
        assertEqual(
          durableRedone,
          expected,
          'Redo must restore the AI edit in the durable document',
        );
      } finally {
        witness.close();
      }
    },
  );

  /* ================================================================== *
   * 6 — Reject writes nothing (D-075 B)
   * ================================================================== */
  runner.scenario(
    'm3/6-ai-reject-writes-nothing',
    'Rejecting a proposal clears it and changes neither the editor text nor the durable document',
    async (ctx) => {
      const documentId = `a6-m3-ai-reject-${marker('doc')}`;
      const baseText = `reject base ${marker('text')}`;

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await typeInEditor(page, baseText);
      await waitForEditorText(page, (text) => text === baseText, {
        label: 'the baseline text',
      });
      await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === baseText, {
        label: 'the baseline text to be persisted',
      });

      await openAiPanel(page);
      const proposal = await generateFromChip(page, 'uppercase');
      assertProposalContent(proposal, { baseRevision: 0 });
      ctx.note('proposal before Reject', {
        summary: proposal.summary,
        diffLength: proposal.diffLength,
        status: proposal.status,
      });

      // Let a wrongly-writing implementation show up before the Reject.
      await sleep(1_000);
      const beforeEditor = await editorState(page);
      const beforeDurable = await durableText(ctx, documentId);
      assertEqual(beforeEditor.text, baseText, 'the pending proposal must not have been applied');
      assertEqual(beforeDurable, baseText, 'the pending proposal must not be in the durable store');

      await page.click(AI.reject);
      const rejected = await waitForAiPanel(
        page,
        (state) => state.phase === 'rejected' && state.proposalPresent === false,
        { label: 'the rejected phase' },
      );
      ctx.note('after Reject', {
        phase: rejected.phase,
        status: rejected.status,
        empty: rejected.empty,
        acceptPresent: rejected.acceptPresent,
        rejectPresent: rejected.rejectPresent,
      });
      assertEqual(
        rejected.status,
        STATUS_COPY.rejected,
        'the status must say the document is unchanged',
      );
      assertEqual(
        rejected.empty,
        'Dismissed. Nothing was written to the document.',
        'the empty-preview copy must be the dismissed message',
      );
      assertEqual(rejected.acceptPresent, false, 'a rejected proposal must be cleared');

      // A rejected proposal is a UI-state change only; give the (wrong) write path a full window.
      await sleep(1_500);
      const afterEditor = await editorState(page);
      const afterDurable = await durableText(ctx, documentId);
      ctx.note('editor and durable after Reject', {
        editorText: JSON.stringify(afterEditor.text),
        durableText: JSON.stringify(afterDurable),
      });
      assertEqual(afterEditor.text, baseText, 'Reject must not change the editor text');
      assertEqual(afterDurable, baseText, 'Reject must not change the durable document');
      assert(
        !afterEditor.text.includes(baseText.toUpperCase()),
        'Reject must not apply the proposal',
      );
    },
  );

  /* ================================================================== *
   * 7 — a local edit makes the proposal stale (D-075 C, revision branch)
   * ================================================================== */
  runner.scenario(
    'm3/7-ai-local-edit-invalidates',
    'typing after Generate makes Accept fail with stale[data-reason="revision"] and leaves both the editor and the durable document unchanged',
    async (ctx) => {
      const documentId = `a6-m3-ai-local-${marker('doc')}`;
      const baseText = `state check ${marker('base')}`;
      const localAdd = ` +local ${marker('add')}`;

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await typeInEditor(page, baseText);
      await waitForEditorText(page, (text) => text === baseText, { label: 'the baseline text' });
      await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === baseText, {
        label: 'the baseline text to be persisted',
      });

      await openAiPanel(page);
      const proposal = await generateFromChip(page, 'uppercase');
      assertProposalContent(proposal, { baseRevision: 0 });
      assertEqual(proposal.acceptDisabled, false, 'Accept starts enabled for a pending proposal');

      /* ---------- the user keeps typing: this client's own revision moves ---------- */
      await typeInEditor(page, localAdd);
      const localText = `${baseText}${localAdd}`;
      await waitForEditorText(page, (text) => text === localText, {
        label: 'the local edit after the proposal',
      });
      await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === localText, {
        label: 'the local edit to be persisted',
      });
      const beforeAccept = await readAiPanel(page);
      ctx.note('proposal after a local edit', {
        phase: beforeAccept.phase,
        baseRevision: beforeAccept.baseRevision,
        acceptDisabled: beforeAccept.acceptDisabled,
        staleReason: beforeAccept.staleReason,
      });
      assertEqual(
        beforeAccept.phase,
        'proposal',
        'a local edit must not silently discard the proposal before Accept is pressed',
      );
      assertEqual(
        beforeAccept.acceptDisabled,
        false,
        'Accept must stay clickable — the rejection has to come from validation, not from a disabled button',
      );

      /* ---------- Accept must now refuse with the *local* reason ---------- */
      await page.click(AI.accept);
      const stale = await waitForAiPanel(
        page,
        (state) => state.phase === 'stale' && state.stalePresent,
        { label: 'the stale phase after a local edit' },
      );
      ctx.note('after Accept on a locally moved document', {
        phase: stale.phase,
        proposalStatus: stale.proposalStatus,
        staleReason: stale.staleReason,
        staleText: stale.staleText,
        status: stale.status,
        acceptDisabled: stale.acceptDisabled,
        acceptTitle: stale.acceptTitle,
      });
      assertEqual(
        stale.staleReason,
        'revision',
        'a local edit must be reported as the revision failure',
      );
      assertEqual(
        stale.staleText,
        APPLY_FAILURE_COPY.revision,
        'the stale copy must be the exact frozen sentence for `revision`',
      );
      assertEqual(stale.proposalStatus, 'stale', 'the proposal must be marked stale, not pending');
      assertEqual(stale.status, STATUS_COPY.stale, 'the status must say nothing was applied');
      assertEqual(stale.acceptDisabled, true, 'a stale proposal must not be acceptable again');
      assertEqual(
        stale.acceptTitle,
        'This suggestion is stale — generate a new one',
        'the disabled Accept must explain that a new suggestion is needed',
      );

      // "Not applied" is a claim about the bytes, not only about the panel.
      await sleep(1_500);
      const afterEditor = await editorState(page);
      const afterDurable = await durableText(ctx, documentId);
      ctx.note('document after the stale Accept', {
        editorText: JSON.stringify(afterEditor.text),
        durableText: JSON.stringify(afterDurable),
      });
      assertEqual(afterEditor.text, localText, 'a stale Accept must not change the editor');
      assertEqual(afterDurable, localText, 'a stale Accept must not change the durable document');
      assert(
        !afterEditor.text.includes(baseText.toUpperCase()),
        'a stale Accept must not partially apply the proposal',
      );
    },
  );

  /* ================================================================== *
   * 8 — a peer editing outside the anchor does not invalidate (D-075 C + D)
   * ================================================================== */
  runner.scenario(
    'm3/8-ai-remote-outside-applies',
    'a peer edit outside the anchored region does not invalidate the proposal: Accept applies the AI edit and the durable document contains both changes',
    async (ctx) => {
      const documentId = `a6-m3-ai-outside-${marker('doc')}`;
      const seed = 'alpha bravo charlie\n';
      const regionStart = 6; // "bravo"
      const regionLength = 5;
      const remoteTail = `|outside-${marker('remote')}`;
      const remoteText = `${seed}${remoteTail}`;
      const expected = `alpha BRAVO charlie\n${remoteTail}`;

      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'remote-outside',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        oracle.replaceAll(seed);
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === seed, {
          label: 'the baseline text to be persisted',
        });

        const page = await ctx.newAppPage({ documentId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        await waitForEditorText(page, (text) => text === seed, { label: 'the baseline text' });

        // The proposal must be anchored to "bravo", so the selection is produced for real.
        const selection = await selectRange(page, regionStart, regionLength);
        ctx.note('selection for the proposal', {
          anchor: selection.anchor,
          head: selection.head,
          selectedText: selection.text.slice(regionStart, regionStart + regionLength),
        });

        await openAiPanel(page);
        const proposal = await generateFromChip(page, 'uppercase');
        assertProposalContent(proposal, { baseRevision: 0 });
        assertEqual(
          proposal.summary,
          'Uppercase the selection',
          'a proposal generated from a selection must say so',
        );
        assertIncludes(
          proposal.diff,
          '+alpha BRAVO charlie',
          'the preview must show the exact replacement the user is reviewing',
        );
        ctx.note('selection-scoped proposal', {
          summary: proposal.summary,
          diffPreview: proposal.diff.slice(0, 400),
        });

        /* ---------- the second client edits *outside* the anchored range ---------- */
        oracle.append(remoteTail);
        await waitForEditorText(page, (text) => text === remoteText, {
          label: 'the remote edit outside the region',
        });
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === remoteText, {
          label: 'the remote edit outside the region to be persisted',
        });
        const afterRemoteEdit = await readAiPanel(page);
        ctx.note('proposal after the remote edit outside the region', {
          phase: afterRemoteEdit.phase,
          baseRevision: afterRemoteEdit.baseRevision,
          staleReason: afterRemoteEdit.staleReason,
        });
        assertEqual(
          afterRemoteEdit.phase,
          'proposal',
          'a peer edit outside the anchor must not invalidate the proposal (D-075 D)',
        );
        assertEqual(
          afterRemoteEdit.baseRevision,
          '0',
          'a remote edit must not move the client-local revision counter (CONTRACTS §11.1)',
        );
        assertEqual(afterRemoteEdit.staleReason, null, 'nothing about the proposal is stale yet');

        /* ---------- Accept applies the AI edit on top of the peer's edit ---------- */
        await page.click(AI.accept);
        const applied = await waitForEditorText(page, (text) => text === expected, {
          label: 'the accepted AI edit on top of the remote edit',
        });
        const durableApplied = await waitForDurableText(
          ctx.stack.dataPath,
          documentId,
          (text) => text === expected,
          { label: 'both edits in the durable document' },
        );
        const afterAccept = await waitForAiPanel(
          page,
          (state) => state.phase === 'applied' && state.proposalPresent === false,
          { label: 'the applied phase' },
        );
        await oracle.waitForText(expected, { label: 'the second client to see the AI edit' });
        ctx.note('after Accept', {
          editorText: JSON.stringify(applied.text),
          durableText: JSON.stringify(durableApplied),
          phase: afterAccept.phase,
          remoteClientText: JSON.stringify(oracle.text),
        });
        assertEqual(applied.text, expected, 'Accept must apply the AI edit in the moved document');
        assertEqual(
          durableApplied,
          expected,
          'the durable document must hold the peer edit and the AI edit',
        );
        assertIncludes(
          durableApplied,
          remoteTail,
          'the peer’s edit must survive the AI apply — Accept is not a snapshot restore',
        );
        assertIncludes(durableApplied, 'BRAVO', 'the AI edit must have been applied');
      } finally {
        oracle.close();
      }
    },
  );

  /* ================================================================== *
   * 9 — a peer editing inside the anchor is text-mismatch (D-075 C + D)
   * ================================================================== */
  runner.scenario(
    'm3/9-ai-remote-inside-stale',
    'a peer edit inside the anchored region makes Accept stale with data-reason="text-mismatch" (never "revision"), and the document is unchanged',
    async (ctx) => {
      const documentId = `a6-m3-ai-inside-${marker('doc')}`;
      const seed = 'alpha bravo charlie\n';
      const regionStart = 6;
      const regionLength = 5;
      const remoteText = 'alpha  charlie\n'; // "bravo" deleted by the peer

      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'remote-inside',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        oracle.replaceAll(seed);
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === seed, {
          label: 'the baseline text to be persisted',
        });

        const page = await ctx.newAppPage({ documentId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        await waitForEditorText(page, (text) => text === seed, { label: 'the baseline text' });

        const selection = await selectRange(page, regionStart, regionLength);
        ctx.note('selection for the proposal', {
          anchor: selection.anchor,
          head: selection.head,
          selectedText: selection.text.slice(regionStart, regionStart + regionLength),
        });

        await openAiPanel(page);
        const proposal = await generateFromChip(page, 'uppercase');
        assertProposalContent(proposal, { baseRevision: 0 });

        /* ---------- the second client changes exactly the anchored text ---------- */
        oracle.deleteAt(regionStart, regionLength);
        await waitForEditorText(page, (text) => text === remoteText, {
          label: 'the remote edit inside the anchored region',
        });
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === remoteText, {
          label: 'the remote edit inside the anchored region to be persisted',
        });
        const afterRemoteEdit = await readAiPanel(page);
        ctx.note('proposal after the remote edit inside the region', {
          phase: afterRemoteEdit.phase,
          baseRevision: afterRemoteEdit.baseRevision,
          staleReason: afterRemoteEdit.staleReason,
        });
        assertEqual(
          afterRemoteEdit.baseRevision,
          '0',
          'a remote edit must not move the client-local revision — otherwise the failure would be misreported',
        );
        assertEqual(
          afterRemoteEdit.staleReason,
          null,
          'the panel cannot know the proposal is unusable until Accept validates it',
        );

        /* ---------- Accept must refuse, and must refuse for the right reason ---------- */
        await page.click(AI.accept);
        const stale = await waitForAiPanel(
          page,
          (state) => state.phase === 'stale' && state.stalePresent,
          { label: 'the text-mismatch stale phase' },
        );
        ctx.note('after Accept on a peer-changed region', {
          phase: stale.phase,
          proposalStatus: stale.proposalStatus,
          staleReason: stale.staleReason,
          staleText: stale.staleText,
          status: stale.status,
        });
        assertEqual(
          stale.staleReason,
          'text-mismatch',
          'an edit inside the anchor changed the reviewed text — the reason must be text-mismatch',
        );
        assert(
          stale.staleReason !== 'revision',
          'a remote edit must never be reported as the local `revision` failure (CONTRACTS §11.1)',
        );
        assertEqual(
          stale.staleText,
          APPLY_FAILURE_COPY['text-mismatch'],
          'the stale copy must be the exact frozen sentence for `text-mismatch`',
        );
        assertEqual(
          stale.proposalStatus,
          'stale',
          'the proposal must be marked stale, not pending',
        );
        assertEqual(stale.acceptDisabled, true, 'a stale proposal must not be acceptable again');

        await sleep(1_500);
        const afterEditor = await editorState(page);
        const afterDurable = await durableText(ctx, documentId);
        ctx.note('document after the stale Accept', {
          editorText: JSON.stringify(afterEditor.text),
          durableText: JSON.stringify(afterDurable),
        });
        assertEqual(afterEditor.text, remoteText, 'a stale Accept must not change the editor');
        assertEqual(
          afterDurable,
          remoteText,
          'a stale Accept must not change the durable document',
        );
        assert(
          !afterEditor.text.includes('BRAVO'),
          'the rejected suggestion must not have been partially applied',
        );
      } finally {
        oracle.close();
      }
    },
  );

  /* ================================================================== *
   * 10 — a viewer can review but cannot accept (D-075 F)
   * ================================================================== */
  runner.scenario(
    'm3/10-ai-viewer-cannot-accept',
    'a viewer sees the proposal and its diff, but Accept is disabled with an explanation, and a programmatic click changes neither the editor nor the durable document',
    async (ctx) => {
      const documentId = `a6-m3-ai-viewer-${marker('doc')}`;
      const baseText = `viewer seed ${marker('text')}`;

      const owner = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'viewer-seed',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        owner.replaceAll(baseText);
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === baseText, {
          label: 'the owner’s seed to be persisted',
        });

        // The role is stated, not arranged by the harness's `ifAbsent` default.
        await ctx.authz.grant(documentId, DEMO_USERS.linus, 'viewer');
        const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus });
        await waitForEditorText(page, (text) => text === baseText, {
          label: 'the viewer to hydrate the seeded content',
        });
        const gate = await waitForRoleTag(ctx, page, 'viewer', { label: 'the viewer role' });
        ctx.note('viewer gate', {
          roleTag: gate.roleTag,
          contentEditable: gate.contentEditable,
          viewReadOnly: gate.viewReadOnly,
        });
        assertEqual(gate.viewReadOnly, true, 'a viewer’s live EditorState must be read-only');

        const panelIdle = await openAiPanel(page);
        ctx.note('viewer panel', {
          phase: panelIdle.phase,
          triggerDisabled: panelIdle.triggerDisabled,
          intentCount: panelIdle.intentCount,
        });
        assertEqual(
          panelIdle.triggerDisabled,
          false,
          'a viewer may open the panel and generate: generation needs canRead only (D-075 §3.7)',
        );

        const proposal = await generateFromChip(page, 'uppercase');
        assertProposalContent(proposal, { baseRevision: 0 });
        ctx.note('viewer proposal', {
          summary: proposal.summary,
          diffLength: proposal.diffLength,
          acceptDisabled: proposal.acceptDisabled,
          acceptTitle: proposal.acceptTitle,
        });

        // Read-only review is the point: the viewer must still be able to see what was proposed.
        assertEqual(proposal.proposalPresent, true, 'a viewer must see the proposal');
        assert(proposal.diffLength > 0, 'a viewer must see the diff preview');
        assertIncludes(proposal.diff, '+++ ', 'the viewer’s preview must be the unified diff');

        // ... but not to apply it.
        assertEqual(proposal.acceptDisabled, true, 'a viewer’s Accept must be disabled (D-075 F)');
        assert(
          typeof proposal.acceptTitle === 'string' && proposal.acceptTitle.length > 0,
          'the disabled Accept must carry a title explaining why',
        );
        assertIncludes(
          proposal.acceptTitle,
          'Read-only',
          'the explanation must name the read-only role, not be a generic tooltip',
        );

        const beforeEditor = await editorState(page);
        const beforeDurable = await durableText(ctx, documentId);
        const syncFramesBefore = await countOutboundSyncFrames(page, documentId);
        const click = await clickAcceptProgrammatically(page);
        ctx.note('programmatic click on the disabled Accept', click);
        assertEqual(click.clicked, true, 'the Accept button must exist to receive the click');
        assertEqual(click.wasDisabled, true, 'the Accept button must be disabled for a viewer');

        // A disabled control swallows the click. Give a wrongly-enabled handler a window anyway.
        await sleep(2_500);
        const afterEditor = await editorState(page);
        const afterDurable = await durableText(ctx, documentId);
        const afterPanel = await readAiPanel(page);
        const syncFramesAfter = await countOutboundSyncFrames(page, documentId);
        ctx.note('after the programmatic click', {
          editorText: JSON.stringify(afterEditor.text),
          durableText: JSON.stringify(afterDurable),
          phase: afterPanel.phase,
          syncFramesBefore,
          syncFramesAfter,
        });
        assertEqual(
          afterEditor.text,
          baseText,
          'a viewer’s Accept click must not change the editor',
        );
        assertEqual(
          afterDurable,
          baseText,
          'a viewer’s Accept click must not change the durable document',
        );
        assertEqual(
          syncFramesAfter,
          syncFramesBefore,
          'a viewer’s Accept click must not emit a SYNC write frame either (A5 review)',
        );
        assertEqual(
          afterEditor.text,
          beforeEditor.text,
          'the editor must be byte-for-byte unchanged',
        );
        assertEqual(
          afterDurable,
          beforeDurable,
          'the durable document must be byte-for-byte unchanged',
        );
        assertEqual(
          afterPanel.phase,
          'proposal',
          'a viewer’s proposal must remain a proposal — nothing was applied',
        );
      } finally {
        owner.close();
      }
    },
  );

  /* ================================================================== *
   * 11 — offline Accept, then reconnect (D-075 G + A5 P3-a)
   *
   * Two phases, deliberately in one scenario because they answer the same
   * question — "what does an AI Accept that happens while `getRole()` is `null`
   * do?" — with the two different subjects it has:
   *
   * 1. **phase 1 — owner offline (D-075 G):** the offline edit is a genuine
   *    offline edit, so the reconnect must apply it exactly once and every
   *    client must converge;
   * 2. **phase 2 — viewer offline (A5 P3-a):** `getRole()` is `null`, so
   *    `capabilityGate(null).canEdit` is `true` and Accept is clickable
   *    (**R10/§17.9 — an unknown role is treated as editable, not a gate
   *    failure**). The edit stays a **local replica divergence**: the server
   *    never receives it, never rejects it (0 `FORBIDDEN`), and it survives a
   *    reload because IndexedDB replays it. This is A5's measured P3-a
   *    (`docs/agent-governance/A5-m3-ai-permission-review.md` §7) and is pinned
   *    here so a future change to either half shows up as a red scenario.
   * ================================================================== */
  runner.scenario(
    'm3/11-ai-offline-accept-then-reconnect',
    'an offline Accept changes only the local Y.Text: an owner reconnects and converges exactly once, while a viewer who was offline keeps a local-only divergence that the server never receives and a reload replays',
    async (ctx) => {
      /* ================================================================ *
       * Phase 1 — owner offline (D-075 G)
       * ================================================================ */
      const documentId = `a6-m3-ai-offline-${marker('doc')}`;
      const tag = marker('offline');
      const baseText = `# ${tag}\nsecond line\n`;
      // `add-todo` is deliberately **not idempotent-looking** here: applying it twice would prefix
      // each line twice, so "no duplicate apply" is observable in the text, not just assumed.
      const expected = `- [ ] # ${tag}\n- [ ] second line\n`;
      const taskPrefix = '- [ ] ';

      // Seed through a real peer, then disconnect it: the writer and the second device both
      // hydrate from the server's durable document, so neither has a local head start.
      const seeder = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'offline-seed',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        seeder.replaceAll(baseText);
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === baseText, {
          label: 'the offline baseline to be persisted',
        });
      } finally {
        seeder.close();
      }

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await waitForEditorText(page, (text) => text === baseText, {
        label: 'the writer to hydrate the baseline',
      });

      // A separate browser profile: its IndexedDB is not the writer's, so what it sees after the
      // reconnect can only have come through the server.
      await ctx.withFreshBrowser(async (fresh) => {
        const reader = await ctx.newAppPage({ documentId, target: fresh });
        await waitForConnectionStatus(reader, 'connected', { timeoutMs: 30_000 });
        await waitForEditorText(reader, (text) => text === baseText, {
          timeoutMs: 40_000,
          label: 'the second device to hydrate the baseline',
        });
        const readerBaseline = await readConnectionStatus(reader);
        ctx.note('second device hydrated', {
          status: readerBaseline,
          text: JSON.stringify(baseText),
        });

        /* ---------- go offline (the real reconnect path, not a stub) ---------- */
        await setOffline(page, true);
        await waitForConnectionStatus(page, ['reconnecting', 'offline', 'error'], {
          timeoutMs: 20_000,
        });
        const offlineStatus = await readConnectionStatus(page);
        const offlineGate = await waitForUnknownRole(page, {
          label: 'the owner’s role chip to disappear while offline',
        });
        ctx.note('writer offline', {
          status: offlineStatus,
          roleTag: offlineGate.roleTag,
          contentEditable: offlineGate.contentEditable,
          viewReadOnly: offlineGate.viewReadOnly,
        });
        // `getRole()` is null while disconnected (§17.9 rule 2) — the chip disappears and the
        // unknown-role rule (R10) keeps the editor editable. It is not a lost permission decision.
        assertEqual(
          offlineGate.roleTag,
          null,
          'while offline getRole() is null, so the role chip must disappear (§17.9)',
        );

        /* ---------- generate while offline: local provider, no network ---------- */
        const panel = await openAiPanel(page);
        assertEqual(panel.open, true, 'the AI panel must open while offline');
        const proposal = await generateFromChip(page, 'add-todo');
        assertProposalContent(proposal, { baseRevision: 0 });
        assertEqual(
          proposal.summary,
          'Prefix 2 lines with a task checkbox',
          'the offline proposal must describe the real change',
        );
        ctx.note('offline proposal', {
          summary: proposal.summary,
          diffLength: proposal.diffLength,
          status: proposal.status,
        });

        const beforeAccept = await editorState(page);
        const durableWhileProposal = await durableText(ctx, documentId);
        ctx.note('before the offline Accept', {
          editorText: JSON.stringify(beforeAccept.text),
          durableText: JSON.stringify(durableWhileProposal),
        });
        assertEqual(beforeAccept.text, baseText, 'a proposal must not change the offline editor');
        assertEqual(durableWhileProposal, baseText, 'a proposal must not reach the durable store');

        /* ---------- Accept offline: local Y.Text changes, the server cannot ---------- */
        const offlineSyncFramesBefore = await countOutboundSyncFrames(page, documentId);
        await page.click(AI.accept);
        const applied = await waitForEditorText(page, (text) => text === expected, {
          label: 'the offline Accept to change the local text',
        });
        const durableAfterOfflineAccept = await durableText(ctx, documentId);
        const offlineSyncFramesAfter = await countOutboundSyncFrames(page, documentId);
        const afterOfflinePanel = await waitForAiPanel(page, (state) => state.phase === 'applied', {
          label: 'the applied phase while offline',
        });
        const readerWhileOffline = await editorState(reader);
        ctx.note('after the offline Accept', {
          editorText: JSON.stringify(applied.text),
          durableText: JSON.stringify(durableAfterOfflineAccept),
          phase: afterOfflinePanel.phase,
          writerStatus: await readConnectionStatus(page),
          secondDeviceText: JSON.stringify(readerWhileOffline.text),
          syncFramesBefore: offlineSyncFramesBefore,
          syncFramesAfter: offlineSyncFramesAfter,
        });
        assertEqual(
          applied.text,
          expected,
          'the accepted AI edit must land in the local Y.Text while offline',
        );
        assertEqual(
          durableAfterOfflineAccept,
          baseText,
          'while offline the server cannot have received the edit — the durable text must not move',
        );
        assertEqual(
          offlineSyncFramesAfter,
          offlineSyncFramesBefore,
          'an offline Accept must not emit a SYNC frame (the socket is gone)',
        );
        assertEqual(
          readerWhileOffline.text,
          baseText,
          'the second device cannot see an edit that was never sent',
        );

        /* ---------- come back ---------- */
        await setOffline(page, false);
        const reconnected = await waitForConnectionStatus(page, 'connected', { timeoutMs: 45_000 });
        ctx.note('writer reconnected', { status: reconnected });

        const durableConverged = await waitForDurableText(
          ctx.stack.dataPath,
          documentId,
          (text) => text === expected,
          { timeoutMs: 45_000, label: 'the reconnected AI edit in the durable document' },
        );
        const writerConverged = await waitForEditorText(page, (text) => text === expected, {
          timeoutMs: 45_000,
          label: 'the writer after reconnect',
        });
        const readerConverged = await waitForEditorText(reader, (text) => text === expected, {
          timeoutMs: 45_000,
          label: 'the second device after the reconnect',
        });
        ctx.note('after reconnect', {
          writerText: JSON.stringify(writerConverged.text),
          secondDeviceText: JSON.stringify(readerConverged.text),
          durableText: JSON.stringify(durableConverged),
        });

        // The exact-equality assertions are the "no duplicate apply" proof: a second application
        // would produce `- [ ] - [ ] …`, which is neither equal nor one prefix per line.
        assertEqual(
          writerConverged.text,
          expected,
          'the writer must converge to exactly one apply',
        );
        assertEqual(readerConverged.text, expected, 'the second device must see the same result');
        assertEqual(durableConverged, expected, 'the durable document must hold exactly one apply');

        const forbiddenAfterReconnect = await countServerErrorCode(page, 'FORBIDDEN', documentId);
        ctx.note('FORBIDDEN frames received by the writer', { count: forbiddenAfterReconnect });
        assertEqual(
          forbiddenAfterReconnect,
          0,
          'an owner’s offline edit must be accepted after reconnect, never FORBIDDEN',
        );

        for (const [label, text] of [
          ['the writer', writerConverged.text],
          ['the second device', readerConverged.text],
          ['the durable document', durableConverged],
        ]) {
          assert(
            !text.includes(`${taskPrefix}${taskPrefix}`),
            `${label} must not contain a double-applied task prefix`,
          );
          assertEqual(
            text.split(taskPrefix).length - 1,
            2,
            `${label} must contain exactly two task prefixes (one per line, applied once)`,
          );
        }
      });

      /* ================================================================ *
       * Phase 2 — A5 P3-a: a viewer who goes offline is an **unknown role**.
       *
       * A5 measured this chain with a one-off probe (`docs/agent-governance/
       * A5-m3-ai-permission-review.md` §7). It is pinned here so a change in
       * `capabilityGate(null)`, the revision tracker, the sync handshake or the
       * IndexedDB replay shows up as a red scenario instead of as an unverified
       * claim. It is deliberately a **different subject** from phase 1: the
       * owner's offline edit is a real offline edit that must converge; the
       * viewer's offline Accept is a local-only divergence that never leaves the
       * client (no server `SyncStep1` is sent to a non-editor, so no `SyncStep2`
       * is requested and no `FORBIDDEN` is possible).
       * ================================================================ */
      const viewerDocumentId = `a6-m3-ai-offline-viewer-${marker('doc')}`;
      const viewerBase = 'alpha beta';
      const viewerExpected = 'ALPHA BETA';

      const viewerSeed = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId: viewerDocumentId,
        label: 'offline-viewer-seed',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        viewerSeed.replaceAll(viewerBase);
        await waitForDurableText(
          ctx.stack.dataPath,
          viewerDocumentId,
          (text) => text === viewerBase,
          { label: 'the viewer baseline to be persisted' },
        );
        await ctx.authz.grant(viewerDocumentId, DEMO_USERS.linus, 'viewer');

        const viewerPage = await ctx.newAppPage({
          documentId: viewerDocumentId,
          as: DEMO_USERS.linus,
        });
        await waitForConnectionStatus(viewerPage, 'connected', { timeoutMs: 30_000 });
        await waitForEditorText(viewerPage, (text) => text === viewerBase, {
          label: 'the viewer to hydrate the baseline',
        });
        const onlineGate = await waitForRoleTag(ctx, viewerPage, 'viewer', {
          label: 'the viewer role while online',
        });
        assertEqual(onlineGate.viewReadOnly, true, 'a known viewer is read-only while online');

        await openAiPanel(viewerPage);
        const onlineProposal = await generateFromChip(viewerPage, 'uppercase');
        assertProposalContent(onlineProposal, { baseRevision: 0 });
        assertEqual(
          onlineProposal.acceptDisabled,
          true,
          'a known viewer cannot accept — the online half of D-075 F',
        );
        ctx.note('viewer proposal while online', {
          summary: onlineProposal.summary,
          acceptDisabled: onlineProposal.acceptDisabled,
          acceptTitle: onlineProposal.acceptTitle,
        });

        /* ---------- offline: the role is *unknown*, not a remembered viewer ---------- */
        await setOffline(viewerPage, true);
        await waitForConnectionStatus(viewerPage, ['reconnecting', 'offline', 'error'], {
          timeoutMs: 20_000,
        });
        const unknownGate = await waitForUnknownRole(viewerPage, {
          label: 'the viewer’s role chip to disappear while offline',
        });
        const unknownPanel = await readAiPanel(viewerPage);
        ctx.note('viewer offline: role is unknown, not a known viewer', {
          status: await readConnectionStatus(viewerPage),
          roleTag: unknownGate.roleTag,
          contentEditable: unknownGate.contentEditable,
          viewReadOnly: unknownGate.viewReadOnly,
          phase: unknownPanel.phase,
          acceptDisabled: unknownPanel.acceptDisabled,
          acceptTitle: unknownPanel.acceptTitle,
        });
        // Offline ⇒ `getRole()` returns null ⇒ the unknown-role rule treats the document as
        // editable (R10 / §17.9). This is NOT the viewer gate failing — there is no known role to
        // gate on. Do not "fix" `capabilityGate(null)` because of this assertion: that would lock
        // offline editing for every role and contradict R10/§17.9.
        assertEqual(
          unknownGate.roleTag,
          null,
          'offline getRole() is null — there is no "known viewer while offline" state (§17.9)',
        );
        assertEqual(
          unknownGate.viewReadOnly,
          false,
          'an unknown role must not lock the editor (R10), which is why the panel can accept',
        );
        assertEqual(
          unknownGate.contentEditable,
          'true',
          'the editor must stay editable while the role is unknown',
        );
        assertEqual(
          unknownPanel.acceptDisabled,
          false,
          'capabilityGate(null).canEdit is true, so Accept becomes clickable while offline',
        );
        assertEqual(
          unknownPanel.acceptTitle,
          'Apply this suggestion to the document',
          'the enabled Accept must carry the normal title, not the read-only one',
        );

        const durableBeforeUnknownAccept = await durableText(ctx, viewerDocumentId);
        const framesBeforeUnknownAccept = await countOutboundSyncFrames(
          viewerPage,
          viewerDocumentId,
        );
        const forbiddenBeforeUnknownAccept = await countServerErrorCode(
          viewerPage,
          'FORBIDDEN',
          viewerDocumentId,
        );

        await viewerPage.click(AI.accept);
        const unknownApplied = await waitForEditorText(
          viewerPage,
          (text) => text === viewerExpected,
          { label: 'the unknown-role offline Accept in the editor' },
        );
        const durableAfterUnknownAccept = await durableText(ctx, viewerDocumentId);
        const framesAfterUnknownAccept = await countOutboundSyncFrames(
          viewerPage,
          viewerDocumentId,
        );
        ctx.note('unknown-role offline Accept', {
          editorText: JSON.stringify(unknownApplied.text),
          durableText: JSON.stringify(durableAfterUnknownAccept),
          syncFramesBefore: framesBeforeUnknownAccept,
          syncFramesAfter: framesAfterUnknownAccept,
        });
        assertEqual(
          unknownApplied.text,
          viewerExpected,
          'the unknown-role Accept must change the local Y.Text',
        );
        assertEqual(
          durableAfterUnknownAccept,
          viewerBase,
          'the server cannot receive it while offline — the durable text must not move',
        );
        assertEqual(
          framesAfterUnknownAccept,
          framesBeforeUnknownAccept,
          'an offline Accept must not emit a SYNC frame',
        );

        /* ---------- reconnect: the divergence stays local and is never rejected ---------- */
        await setOffline(viewerPage, false);
        await waitForConnectionStatus(viewerPage, 'connected', { timeoutMs: 45_000 });
        const reconnectedGate = await waitForRoleTag(ctx, viewerPage, 'viewer', {
          timeoutMs: 45_000,
          label: 'the viewer role to return with the reconnection',
        });
        // Let the client-initiated SyncStep1/SyncStep2 handshake finish before reading the replica.
        await sleep(2_000);
        const afterReconnectEditor = await editorState(viewerPage);
        const afterReconnectDurable = await durableText(ctx, viewerDocumentId);
        const forbiddenAfterReconnect = await countServerErrorCode(
          viewerPage,
          'FORBIDDEN',
          viewerDocumentId,
        );
        ctx.note('unknown-role divergence after reconnect', {
          roleTag: reconnectedGate.roleTag,
          viewReadOnly: reconnectedGate.viewReadOnly,
          editorText: JSON.stringify(afterReconnectEditor.text),
          durableText: JSON.stringify(afterReconnectDurable),
          forbiddenFramesBefore: forbiddenBeforeUnknownAccept,
          forbiddenFramesAfter: forbiddenAfterReconnect,
          syncFrames: await countOutboundSyncFrames(viewerPage, viewerDocumentId),
        });
        assertEqual(reconnectedGate.roleTag, 'role: viewer', 'the known role returns on reconnect');
        assertEqual(
          afterReconnectEditor.text,
          viewerExpected,
          'reconnecting must not delete the local replica’s divergent edit',
        );
        assertEqual(
          afterReconnectDurable,
          viewerBase,
          'the server still holds the old text — the divergence was never submitted',
        );
        assertEqual(
          forbiddenAfterReconnect,
          forbiddenBeforeUnknownAccept,
          'reconnecting must not produce a FORBIDDEN — the divergence never leaves the client',
        );
        assertEqual(forbiddenAfterReconnect, 0, 'zero FORBIDDEN frames for this document');

        /* ---------- reload in the same profile: the replica replays the divergence ---------- */
        await reloadApp(viewerPage);
        await setDocumentId(viewerPage, viewerDocumentId, { arrangeAccess: false });
        await waitForRoleTag(ctx, viewerPage, 'viewer', {
          timeoutMs: 45_000,
          label: 'the viewer role after the reload',
        });
        const reloadedEditor = await waitForEditorText(
          viewerPage,
          (text) => text === viewerExpected,
          { timeoutMs: 40_000, label: 'the persisted divergence after a reload' },
        );
        await sleep(1_500);
        const durableAfterReload = await durableText(ctx, viewerDocumentId);
        const replica = documentReplica(await readIndexedDb(viewerPage), viewerDocumentId);
        const updatesStore = replica?.stores.find((store) => store.name === 'updates') ?? null;
        ctx.note('divergence after reload', {
          editorText: JSON.stringify(reloadedEditor.text),
          durableText: JSON.stringify(durableAfterReload),
          replicaPresent: replica !== null,
          replicaUpdateRecords: updatesStore?.count ?? 0,
          replicaFirstRecordType: updatesStore?.sample?.firstRecordType ?? null,
        });
        assertEqual(
          reloadedEditor.text,
          viewerExpected,
          'the divergent edit must survive a reload — IndexedDB is the only place it exists',
        );
        assertEqual(
          durableAfterReload,
          viewerBase,
          'a reload must not push the divergence to the server either',
        );
        assertEqual(
          replica !== null,
          true,
          'the viewer’s local replica must exist after the reload',
        );
        assert(
          (updatesStore?.count ?? 0) > 0,
          'the local replica must hold the divergent Yjs updates',
        );
        assertEqual(
          updatesStore?.sample?.firstRecordType,
          'binary',
          'the replica must persist encoded Yjs updates, never a parallel text mirror (R11)',
        );
      } finally {
        viewerSeed.close();
      }
    },
  );
}
