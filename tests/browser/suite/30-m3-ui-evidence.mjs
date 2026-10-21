/**
 * M3 UI evidence — the **new interaction** A2 added in the redesign, plus the DOM contract the
 * whole browser suite depends on.
 *
 * `docs/TASKS.md` for M3 gives the undo/redo buttons and the redesigned header. The suite had no
 * scenario that touched the buttons at all, and the A6 brief asks for three distinct claims that a
 * screenshot cannot make:
 *
 * | # | Claim | Scenario |
 * | --- | --- | --- |
 * | 1 | a viewer's Undo/Redo are `disabled` **and** a programmatic `.click()` changes nothing — neither the editor text nor the durable text | `m3/2-viewer-undo-redo-are-inert` |
 * | 2 | for an owner/editor the buttons drive the session's `Y.UndoManager`: Undo removes the typed text from the **durable** document, Redo puts it back | `m3/1-undo-redo-buttons-drive-the-session-history` |
 * | 3 | `getRole() === null` never disables Undo by itself; the button follows `canUndo`/`canRedo` only (empty → disabled, after typing → enabled) | `m3/3-unknown-role-undo-follows-canundo` |
 * | 4 | the redesign did not drift the DOM contract this suite relies on | `m3/4-dom-contract-surfaces` |
 * | 5 | the one-time identity remount is waited for by the harness (regression test for the fix in `lib/app.mjs`) | `m3/0-identity-remount-is-waited-for` |
 *
 * ## Why the buttons and not `Mod-z`
 *
 * `editor/local-undo-available`, `f1/2` and the unit suite already prove the **keyboard** path is
 * the session's `Y.UndoManager`. These scenarios prove the new **button** path is the *same*
 * mechanism, which is only observable from the durable store: a snapshot-restore or a
 * `document.execCommand` implementation would also change the painted text, but it would not
 * produce the Yjs update the server persists.
 *
 * ## Why the viewer scenario reads the durable store at all
 *
 * "The button is disabled" is a UI fact; "clicking it does nothing" must be a product fact. A
 * viewer's session holds a real `Y.Doc` and a real socket, so a bug that undid something locally
 * could still reach the server. Comparing the reconstructed durable text before/after is the only
 * assertion that rules that out.
 */
import {
  clickHistoryButtonProgrammatically,
  readConnectionStatus,
  readEditorGate,
  readHistoryButtons,
  readUndoState,
  SELECTORS,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
  waitUntil,
} from '../lib/app.mjs';
import { DEMO_USERS } from '../lib/authz-fixture.mjs';
import { reconstructDurableDocument, waitForDurableText } from '../lib/durable-store.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';
import { assertUiReadOnly, waitForRoleTag } from '../lib/role-gate.mjs';

/** A per-run marker, so a stale replica or an earlier scenario can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The document text rebuilt from the server's own bytes (never "what the page shows"). */
async function durableText(ctx, documentId) {
  return (await reconstructDurableDocument(ctx.stack.dataPath, documentId)).text;
}

/** Wait until `readUndoState` satisfies `predicate`, returning the last observation. */
async function waitForUndoState(page, predicate, { timeoutMs = 15_000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readUndoState(page);
    if (last !== null && predicate(last)) return last;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}; last undo state: ${JSON.stringify(last)}`);
    await sleep(100);
  }
}

export function register(runner) {
  /* ================================================================== *
   * 0 — the harness itself: the identity remount must be crossed, not raced
   * ================================================================== */
  runner.scenario(
    'm3/0-identity-remount-is-waited-for',
    'with a deliberately slow bootstrap the editor mounts on the placeholder identity first, and the harness waits until the post-identity remount before a scenario may type',
    async (ctx) => {
      // The normal bootstrap round trip on localhost is faster than the IndexedDB load, so the
      // editor usually mounts *after* the identity already landed and the race stays invisible.
      // Delaying the request through the page instrumentation (no application change) forces the
      // ordering that the full-suite failure hit by accident: mount first, identity later.
      const page = await ctx.newAppPage({ bootstrapDelayMs: 700 });
      const summary = await page.evaluate(() => window.__qa.summary());
      ctx.note('identity transition as the page observed it', {
        bootstrap: summary.bootstrap,
        identity: summary.identity,
        editorMounts: summary.editorMounts,
        editorUnmounts: summary.editorUnmounts,
        editorMountLog: summary.editorMountLog,
      });

      assertEqual(summary.bootstrap.calls >= 1, true, 'the page must have bootstrapped');
      assertEqual(
        summary.bootstrap.hasServerIdentity,
        true,
        'the delayed bootstrap must still return a server identity — otherwise no remount is due',
      );
      assertEqual(
        summary.identity.present,
        true,
        'the identity decision must be rendered before waitForSessionActive returns',
      );
      // The scenario is only meaningful if the forced delay really produced a pre-identity mount.
      const preIdentity = summary.editorMountLog.filter((mount) => mount.sawIdentity === false);
      assert(
        preIdentity.length >= 1,
        'the artificial delay did not produce a placeholder-identity mount; the race was not constructed',
      );
      // ... and the live editor must be the one mounted *after* it.
      assert(
        typeof summary.identity.firstSeenAt === 'number',
        'the identity decision must have a timestamp for "mounted after it" to be measurable',
      );
      const last = summary.editorMountLog[summary.editorMountLog.length - 1];
      assertEqual(last.sawIdentity, true, 'the live .cm-editor must be the post-identity mount');
      assert(
        last.t >= summary.identity.firstSeenAt,
        `the live mount (t=${last.t}) must be newer than the identity decision (t=${summary.identity.firstSeenAt})`,
      );

      // And the session the harness is now typing into is the settled one: a keystroke must
      // reach Y.Text and the server's durable document, which the doomed session would lose.
      const typed = marker('AFTER-IDENTITY');
      await typeInEditor(page, typed);
      await waitForEditorText(page, (text) => text.includes(typed), {
        label: 'the text typed after the identity remount',
      });
      await waitForDurableText(ctx.stack.dataPath, 'demo-document', (text) => text.includes(typed), {
        label: 'the post-remount keystroke to be persisted',
      });
      ctx.note('typed into the settled session', { typed, persisted: true });
    },
  );

  /* ================================================================== *
   * 1 — owner/editor: the buttons are the session's Y.UndoManager
   * ================================================================== */
  runner.scenario(
    'm3/1-undo-redo-buttons-drive-the-session-history',
    'Undo removes a local edit from the durable document and Redo restores it — through the session’s Y.UndoManager, not a text snapshot',
    async (ctx) => {
      const documentId = `a6-m3-undo-${marker('doc')}`;
      const typed = marker('UNDO-TYPED');

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      ctx.note('document opened', { documentId, status: await readConnectionStatus(page) });

      const buttonsAtStart = await readHistoryButtons(page);
      ctx.note('history buttons on an empty document', buttonsAtStart);
      assertEqual(buttonsAtStart.undo.present, true, 'the Undo button must be rendered');
      assertEqual(buttonsAtStart.redo.present, true, 'the Redo button must be rendered');
      assertEqual(
        buttonsAtStart.undo.ariaLabel,
        'Undo',
        'the accessible name is the contract (no data-testid was added)',
      );
      assertEqual(buttonsAtStart.redo.ariaLabel, 'Redo', 'the accessible name is the contract');
      assertEqual(
        buttonsAtStart.undo.disabled,
        true,
        'with no local edit canUndo is false, so Undo must start disabled',
      );

      const durableBefore = (await durableText(ctx, documentId)) ?? '';
      ctx.note('durable text before typing', {
        length: durableBefore.length,
        containsMarker: durableBefore.includes(typed),
      });

      await typeInEditor(page, typed);
      const editorAfterTyping = await waitForEditorText(page, (text) => text.includes(typed), {
        label: 'the typed text in the editor',
      });
      const durableAfterTyping = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text.includes(typed),
        { label: 'the typed text to reach the durable document' },
      );
      const undoStateAfterTyping = await waitForUndoState(
        page,
        (state) => state.includes('undo: available'),
        { label: 'canUndo to become true' },
      );
      const buttonsAfterTyping = await readHistoryButtons(page);
      ctx.note('after typing', {
        editorLength: editorAfterTyping.length,
        durableLength: durableAfterTyping.length,
        durableHasMarker: durableAfterTyping.includes(typed),
        undoState: undoStateAfterTyping,
        buttons: buttonsAfterTyping,
      });
      assertIncludes(undoStateAfterTyping, 'undo: available', 'a local edit must be undoable');
      assertEqual(buttonsAfterTyping.undo.disabled, false, 'Undo must be enabled after a local edit');

      /* ---------- Undo: a real click, then the durable truth ---------- */
      await page.click(SELECTORS.undoButton);
      const editorAfterUndo = await waitForEditorText(page, (text) => !text.includes(typed), {
        label: 'the Undo to revert the insert in the editor',
      });
      const durableAfterUndo = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => !text.includes(typed),
        { label: 'the Undo to revert the insert in the durable document' },
      );
      const undoStateAfterUndo = await waitForUndoState(
        page,
        (state) => state.includes('redo: available'),
        { label: 'canRedo to become true' },
      );
      const buttonsAfterUndo = await readHistoryButtons(page);
      ctx.note('after the Undo click', {
        editorLength: editorAfterUndo.length,
        editorHasMarker: editorAfterUndo.text.includes(typed),
        durableLength: durableAfterUndo.length,
        durableHasMarker: durableAfterUndo.includes(typed),
        undoState: undoStateAfterUndo,
        buttons: buttonsAfterUndo,
      });
      assert(
        !durableAfterUndo.includes(typed),
        'the durable document must no longer contain the undone insert — the button went through ' +
          'the session\'s Y.UndoManager (a snapshot restore could not produce this update)',
      );
      assertEqual(buttonsAfterUndo.redo.disabled, false, 'Redo must be enabled after an undo');

      /* ---------- Redo: the same edit comes back ---------- */
      await page.click(SELECTORS.redoButton);
      const editorAfterRedo = await waitForEditorText(page, (text) => text.includes(typed), {
        label: 'the Redo to restore the insert in the editor',
      });
      const durableAfterRedo = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text.includes(typed),
        { label: 'the Redo to restore the insert in the durable document' },
      );
      const buttonsAfterRedo = await readHistoryButtons(page);
      ctx.note('after the Redo click', {
        editorLength: editorAfterRedo.length,
        editorHasMarker: editorAfterRedo.text.includes(typed),
        durableLength: durableAfterRedo.length,
        durableHasMarker: durableAfterRedo.includes(typed),
        buttons: buttonsAfterRedo,
      });
      assertIncludes(
        durableAfterRedo,
        typed,
        'the redone insert must be in the durable document again',
      );
      ctx.note('history evidence summary', {
        typedMarker: typed,
        durableBefore: { length: durableBefore.length, hasMarker: false },
        durableAfterTyping: { length: durableAfterTyping.length, hasMarker: true },
        durableAfterUndo: { length: durableAfterUndo.length, hasMarker: false },
        durableAfterRedo: { length: durableAfterRedo.length, hasMarker: true },
      });
    },
  );

  /* ================================================================== *
   * 2 — viewer: the buttons exist, are disabled, and are inert
   * ================================================================== */
  runner.scenario(
    'm3/2-viewer-undo-redo-are-inert',
    'a viewer’s Undo and Redo are disabled, and a programmatic .click() changes neither the editor text nor the durable text',
    async (ctx) => {
      const documentId = `a6-m3-viewer-${marker('doc')}`;
      const seed = marker('VIEWER-SEED');

      await ctx.authz.grant(documentId, DEMO_USERS.ada, 'owner');
      await ctx.authz.grant(documentId, DEMO_USERS.linus, 'viewer');

      const owner = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'owner',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        owner.append(`${seed}\n`);
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text.includes(seed), {
          label: 'the owner’s seed write to be persisted',
        });

        const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus });
        await waitForEditorText(page, (text) => text.includes(seed), {
          label: 'the viewer to hydrate the seeded content',
        });
        await waitForRoleTag(ctx, page, 'viewer', { label: 'the viewer role' });
        await assertUiReadOnly(ctx, page, { role: 'viewer' });

        const buttons = await readHistoryButtons(page);
        ctx.note('a viewer’s history buttons', buttons);
        assertEqual(buttons.undo.present, true, 'the Undo button must be rendered for a viewer');
        assertEqual(buttons.redo.present, true, 'the Redo button must be rendered for a viewer');
        assertEqual(buttons.undo.disabled, true, 'a viewer’s Undo must be disabled');
        assertEqual(buttons.redo.disabled, true, 'a viewer’s Redo must be disabled');

        // Both reasons are recorded: the gate is read-only (the role), and there is no local
        // history to undo. The assertion above must not be satisfied by "no history" alone.
        const gateBefore = await readEditorGate(page);
        const undoStateBefore = await readUndoState(page);
        const durableBefore = await durableText(ctx, documentId);
        ctx.note('before the programmatic clicks', {
          contentEditable: gateBefore.contentEditable,
          viewReadOnly: gateBefore.viewReadOnly,
          editorTextLength: gateBefore.viewText?.length ?? null,
          undoState: undoStateBefore,
          durableLength: durableBefore?.length ?? null,
          durableHasSeed: durableBefore?.includes(seed) ?? null,
        });
        assertEqual(gateBefore.viewReadOnly, true, 'a viewer’s live EditorState must be read-only');
        assertIncludes(undoStateBefore ?? '', 'undo: none', 'a viewer has no local undo history');

        /* ---------- a hostile/incorrect caller clicks anyway ---------- */
        const undoClick = await clickHistoryButtonProgrammatically(page, 'undo');
        const redoClick = await clickHistoryButtonProgrammatically(page, 'redo');
        ctx.note('programmatic .click() on the disabled buttons', { undoClick, redoClick });
        assertEqual(undoClick.clicked, true, 'the Undo button must exist to receive the click');
        assertEqual(
          undoClick.wasDisabled,
          true,
          'the Undo button must be disabled — a disabled control swallows the click',
        );
        assertEqual(redoClick.wasDisabled, true, 'the Redo button must be disabled');

        // Give a wrongly-enabled handler a real window: a local undo would change the editor at
        // once, and the resulting Yjs update would need time to reach the server and be stored.
        await sleep(2_500);
        const gateAfter = await readEditorGate(page);
        const undoStateAfter = await readUndoState(page);
        const durableAfter = await durableText(ctx, documentId);
        ctx.note('after the programmatic clicks', {
          editorTextLength: gateAfter.viewText?.length ?? null,
          editorTextIdentical: gateAfter.viewText === gateBefore.viewText,
          undoState: undoStateAfter,
          durableLength: durableAfter?.length ?? null,
          durableTextIdentical: durableAfter === durableBefore,
        });

        assertEqual(
          gateAfter.viewText,
          gateBefore.viewText,
          'a viewer’s Undo/Redo click must not change the editor document',
        );
        assertEqual(
          durableAfter,
          durableBefore,
          'a viewer’s Undo/Redo click must not change the durable document',
        );
        assertEqual(
          undoStateAfter,
          undoStateBefore,
          'a viewer’s Undo/Redo click must not move the undo/redo state',
        );
      } finally {
        owner.close();
      }
    },
  );

  /* ================================================================== *
   * 3 — role unknown: the buttons follow canUndo/canRedo only
   * ================================================================== */
  runner.scenario(
    'm3/3-unknown-role-undo-follows-canundo',
    'with getRole() === null the Undo button is disabled only while canUndo is false, becomes enabled after a local edit, and really undoes it',
    async (ctx) => {
      const documentId = `a6-m3-null-${marker('doc')}`;
      const typed = marker('UNKNOWN-ROLE-UNDO');

      // `role: null` writes no membership row and `offlineFirst` prevents the first join, so
      // `getRole()` is genuinely null — the same window as `f1/3`, not a simulated prop.
      const page = await ctx.newAppPage({
        documentId,
        as: DEMO_USERS.ada,
        role: null,
        offlineFirst: true,
      });
      await waitForEditorText(page, () => true, { label: 'the editor to mount offline' });

      const gate = await readEditorGate(page);
      ctx.note('the unknown-role window', {
        roleTag: gate.roleTag,
        contentEditable: gate.contentEditable,
        viewReadOnly: gate.viewReadOnly,
        editorText: JSON.stringify(gate.viewText),
        connectionStatus: await readConnectionStatus(page),
      });
      assertEqual(gate.roleTag, null, 'the role must be unknown (no chip) for this scenario');
      assertEqual(gate.contentEditable, 'true', 'an unknown role must not lock the editor');
      assertEqual(gate.viewReadOnly, false, 'an unknown role must not set EditorState.readOnly');

      const emptyState = await readUndoState(page);
      const emptyButtons = await readHistoryButtons(page);
      ctx.note('empty document, role unknown', { undoState: emptyState, buttons: emptyButtons });
      assertEqual(emptyState, 'undo: none · redo: none', 'an empty document has no local history');
      assertEqual(
        emptyButtons.undo.disabled,
        true,
        'Undo must be disabled because canUndo is false — not because the role is unknown',
      );
      assertEqual(emptyButtons.redo.disabled, true, 'Redo must be disabled while canRedo is false');

      await typeInEditor(page, typed);
      await waitForEditorText(page, (text) => text.includes(typed), {
        label: 'typing to be accepted while the role is unknown',
      });
      const typedState = await waitForUndoState(page, (state) => state.includes('undo: available'), {
        label: 'canUndo to become true after typing',
      });
      const typedButtons = await readHistoryButtons(page);
      ctx.note('after typing with an unknown role', {
        undoState: typedState,
        buttons: typedButtons,
        roleTag: (await readEditorGate(page)).roleTag,
      });
      assertIncludes(typedState, 'undo: available', 'the local edit must be undoable');
      assertEqual(
        typedButtons.undo.disabled,
        false,
        'an unknown role must NOT disable Undo: the button follows canUndo only',
      );
      assertEqual(
        typedButtons.redo.disabled,
        true,
        'Redo must stay disabled while canRedo is false (it follows canRedo only)',
      );

      /* ---------- and the enabled button really works (not merely painted enabled) ---------- */
      await page.click(SELECTORS.undoButton);
      const afterUndo = await waitForEditorText(page, (text) => !text.includes(typed), {
        label: 'the Undo click to revert the local insert',
      });
      const afterUndoState = await waitForUndoState(
        page,
        (state) => state.includes('redo: available'),
        { label: 'canRedo after the undo' },
      );
      const undoClickButtons = await readHistoryButtons(page);
      ctx.note('after the Undo click with an unknown role', {
        editorHasMarker: afterUndo.text.includes(typed),
        undoState: afterUndoState,
        buttons: undoClickButtons,
      });
      assert(!afterUndo.text.includes(typed), 'the Undo click must revert the local insert');
      assertIncludes(afterUndoState, 'redo: available', 'the undo must be redoable');

      await page.click(SELECTORS.redoButton);
      const afterRedo = await waitForEditorText(page, (text) => text.includes(typed), {
        label: 'the Redo click to restore the local insert',
      });
      ctx.note('after the Redo click with an unknown role', {
        editorHasMarker: afterRedo.text.includes(typed),
      });
      assert(afterRedo.text.includes(typed), 'the Redo click must restore the local insert');
    },
  );

  /* ================================================================== *
   * 4 — the DOM contract the suite depends on survived the redesign
   * ================================================================== */
  runner.scenario(
    'm3/4-dom-contract-surfaces',
    'the redesigned header still exposes every selector the browser suite depends on: document input, active id, one status badge, collaborator names as text, undo-state, the read-only notice and the editor host',
    async (ctx) => {
      const documentId = `a6-m3-contract-${marker('doc')}`;
      const peerName = `Qa Contract Peer ${marker('name')}`;
      const seed = marker('CONTRACT-SEED');

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

      const peer = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'presence-peer',
        userId: DEMO_USERS.grace,
        role: 'editor',
      });
      try {
        peer.enablePresence(
          { id: 'qa-contract-peer', name: peerName, color: '#3366cc' },
          { cursor: { anchor: 0, head: 0 } },
        );
        peer.append(`# contract ${seed}\n`);
        await waitForEditorText(page, (text) => text.includes(seed), {
          label: 'the seed content in the editor',
        });
        // The collaborator name is rendered from `session.getCollaborators()`; wait until the
        // presence frame has been applied rather than assuming it.
        await waitUntil(
          async () =>
            await page.evaluate(
              (name) =>
                (document.querySelector('[data-testid="collaborator-list"]')?.innerText ?? '').includes(
                  name,
                ),
              peerName,
            ),
          { label: `the collaborator ${peerName}`, timeoutMs: 20_000 },
        );

        const ownerDom = await page.evaluate(() => {
          const input = document.querySelector('input[aria-label="Document id"]');
          const active = document.querySelector('[data-testid="active-document"]');
          const statuses = [...document.querySelectorAll('[data-testid="connection-status"]')];
          const list = document.querySelector('[data-testid="collaborator-list"]');
          const undo = document.querySelector('[data-testid="undo-state"]');
          const host = document.querySelector('[data-testid="markdown-editor"]');
          return {
            documentInput: input === null ? null : { tag: input.tagName, value: input.value },
            activeDocumentText: active === null ? null : active.textContent?.trim() ?? '',
            statusCount: statuses.length,
            statusValues: statuses.map((node) => node.dataset.status ?? null),
            collaboratorListPresent: list !== null,
            collaboratorText: list?.innerText ?? null,
            undoStateText: undo === null ? null : undo.textContent?.trim() ?? '',
            editorHostPresent: host !== null,
            cmEditorCount: document.querySelectorAll('.cm-editor').length,
            cmContentCount: document.querySelectorAll('.cm-content').length,
            identityPresent: document.querySelector('[data-testid="session-identity"]') !== null,
          };
        });
        ctx.note('owner page DOM contract', ownerDom);

        assertEqual(ownerDom.documentInput?.tag, 'INPUT', 'the document switcher must be an input');
        assertEqual(
          ownerDom.documentInput?.value,
          documentId,
          'input[aria-label="Document id"] must hold the active document id',
        );
        assertEqual(
          ownerDom.activeDocumentText,
          documentId,
          '[data-testid="active-document"] text must be exactly the document id',
        );
        assertEqual(
          ownerDom.statusCount,
          1,
          'exactly one [data-testid="connection-status"] may exist (the document header)',
        );
        assert(
          typeof ownerDom.statusValues[0] === 'string' && ownerDom.statusValues[0].length > 0,
          'the connection badge must carry data-status',
        );
        assertEqual(
          ownerDom.collaboratorListPresent,
          true,
          '[data-testid="collaborator-list"] must be rendered',
        );
        assertIncludes(
          ownerDom.collaboratorText ?? '',
          peerName,
          'a collaborator name must be real DOM text (innerText), not a title attribute or CSS content',
        );
        assert(
          /^undo: (available|none) · redo: (available|none)$/.test(ownerDom.undoStateText ?? ''),
          `[data-testid="undo-state"] must keep its "undo: … · redo: …" vocabulary, got ${JSON.stringify(ownerDom.undoStateText)}`,
        );
        assertEqual(ownerDom.editorHostPresent, true, '[data-testid="markdown-editor"] must exist');
        assertEqual(ownerDom.cmEditorCount, 1, 'exactly one .cm-editor may be mounted');
        assertEqual(ownerDom.cmContentCount, 1, 'exactly one .cm-content may exist');
        assertEqual(ownerDom.identityPresent, true, '[data-testid="session-identity"] must exist');

        /* ---------- the read-only notice, on a viewer page ---------- */
        await ctx.authz.grant(documentId, DEMO_USERS.linus, 'viewer');
        const viewer = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus });
        await waitForRoleTag(ctx, viewer, 'viewer', { label: 'the viewer role' });
        const viewerGate = await readEditorGate(viewer);
        ctx.note('viewer page DOM contract', {
          roleTag: viewerGate.roleTag,
          contentEditable: viewerGate.contentEditable,
          notice: viewerGate.notice,
          cmEditorCount: await viewer.evaluate(() => document.querySelectorAll('.cm-editor').length),
          cmContentCount: await viewer.evaluate(
            () => document.querySelectorAll('.cm-content').length,
          ),
          statusCount: await viewer.evaluate(
            () => document.querySelectorAll('[data-testid="connection-status"]').length,
          ),
          activeDocumentText: await viewer.evaluate(
            () => document.querySelector('[data-testid="active-document"]')?.textContent?.trim() ?? null,
          ),
        });
        assertEqual(viewerGate.notice.present, true, '[data-testid="read-only-notice"] must exist');
        assertEqual(viewerGate.notice.visible, true, 'the read-only notice must be visible');
        assert(
          typeof viewerGate.notice.title === 'string' &&
            viewerGate.notice.title.length > 0 &&
            typeof viewerGate.notice.detail === 'string' &&
            viewerGate.notice.detail.length > 0,
          'the notice must keep its .read-only-notice__title and .read-only-notice__detail classes',
        );
        const viewerClasses = await viewer.evaluate(() => {
          const notice = document.querySelector('[data-testid="read-only-notice"]');
          return {
            title: notice?.querySelector('.read-only-notice__title') !== null,
            detail: notice?.querySelector('.read-only-notice__detail') !== null,
            host: document.querySelector('[data-testid="markdown-editor"]') !== null,
            cmEditor: document.querySelectorAll('.cm-editor').length,
            cmContent: document.querySelectorAll('.cm-content').length,
          };
        });
        assertEqual(viewerClasses.title, true, 'the notice must carry .read-only-notice__title');
        assertEqual(viewerClasses.detail, true, 'the notice must carry .read-only-notice__detail');
        assertEqual(viewerClasses.host, true, 'the viewer page must mount [data-testid="markdown-editor"]');
        assertEqual(viewerClasses.cmEditor, 1, 'exactly one .cm-editor on the viewer page');
        assertEqual(viewerClasses.cmContent, 1, 'exactly one .cm-content on the viewer page');
      } finally {
        peer.close();
      }
    },
  );
}
