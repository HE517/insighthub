/**
 * Two participants, real time, and remote presence.
 *
 * The receive path (Yjs update in → editor updated) and the presence read path
 * (`getCollaborators()` → collaborator list) are exercised against an independent
 * Yjs peer on the real server. The send path and the remote-cursor *renderer* are
 * ordinary green scenarios (the `P0-2` / `P0-3` pins were deleted once the defects were
 * fixed).
 */
import {
  editorState,
  pressInEditor,
  readCollaborators,
  readConnectionStatus,
  readPageDiagnostics,
  readRemoteCursorDom,
  setDocumentId,
  typeInEditor,
  waitForEditorText,
} from '../lib/app.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { describeDivergence, WireOracle } from '../lib/oracle.mjs';
import { sleep } from '../lib/cdp.mjs';

export function register(runner) {
  /* ------------------------------------------------------------------ *
   * The receive path works: a remote edit lands in the editor live
   * ------------------------------------------------------------------ */
  runner.scenario(
    'realtime/remote-edit-arrives-live',
    'an edit made by another client appears in this editor without a reload',
    async (ctx) => {
      const documentId = 'a6-realtime-receive';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        const first = 'from-the-other-client-ONE';
        oracle.replaceAll(first);
        const seen = await waitForEditorText(page, (text) => text === first, {
          label: 'the first remote edit',
        });
        ctx.note('first remote edit applied', { length: seen.length, viewId: seen.viewId });

        const second = `${first} + TWO`;
        oracle.append(' + TWO');
        const seenSecond = await waitForEditorText(page, (text) => text === second, {
          label: 'the second remote edit',
        });
        ctx.note('second remote edit applied', {
          length: seenSecond.length,
          sameView: seenSecond.viewId === seen.viewId,
        });
        assertEqual(seenSecond.viewId, seen.viewId, 'a remote edit must not remount the editor');
        ctx.note('page diagnostics', await readPageDiagnostics(page));
      } finally {
        oracle.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Two browser tabs must converge — pinned defect
   * ------------------------------------------------------------------ */
  runner.scenario(
    'realtime/two-tabs-converge',
    'two browser tabs on one document see each other edits',
    async (ctx) => {
      const documentId = 'a6-two-tabs';
      const pageA = await ctx.newAppPage({ documentId });
      const pageB = await ctx.newAppPage({ documentId });
      for (const page of [pageA, pageB]) {
        await page.waitFor(
          () =>
            document.querySelector('[data-testid="connection-status"]')?.dataset.status ===
            'connected',
          { timeoutMs: 25_000, label: 'a connected session' },
        );
      }
      ctx.note('statuses', {
        A: await readConnectionStatus(pageA),
        B: await readConnectionStatus(pageB),
      });

      const fromA = 'TAB-A-TYPING';
      const fromB = 'TAB-B-TYPING';
      await typeInEditor(pageA, fromA);
      await typeInEditor(pageB, fromB);

      // A and B can only converge if each tab's keystrokes reached Y.Text.
      await sleep(5_000);
      const stateA = await editorState(pageA);
      const stateB = await editorState(pageB);
      ctx.note('tab A editor', JSON.stringify(stateA.text.slice(0, 120)));
      ctx.note('tab B editor', JSON.stringify(stateB.text.slice(0, 120)));

      assertIncludes(stateB.text, fromA, 'tab B must see what tab A typed (DEFECT P0-2)');
      assertIncludes(stateA.text, fromB, 'tab A must see what tab B typed (DEFECT P0-2)');
      assertEqual(
        stateA.text,
        stateB.text,
        `the two tabs must converge (${describeDivergence(stateA.text, stateB.text)})`,
      );
    },
  );

  /* ------------------------------------------------------------------ *
   * Collaborator list (the validated read path, R14)
   * ------------------------------------------------------------------ */
  runner.scenario(
    'cursors/collaborator-list-uses-validated-presence',
    'a second participant appears in the collaborator list, and a malformed entry does not',
    async (ctx) => {
      const documentId = 'a6-presence-list';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      // A second peer that publishes a structurally invalid awareness state. A peer
      // cannot hijack its own valid entry, so a separate client is required to test
      // "the invalid payload is filtered but the valid one survives".
      const attacker = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'attacker',
      });
      const page = await ctx.newAppPage({ documentId });
      try {
        oracle.enablePresence({ id: 'presence-peer', name: 'Presence Peer' }, { cursor: { anchor: 0, head: 0 } });
        await page.waitFor(
          () => document.body.innerText.includes('Presence Peer'),
          { timeoutMs: 25_000, label: 'the peer in the collaborator list' },
        );
        const withPeer = await readCollaborators(page);
        ctx.note('collaborators with one valid peer', withPeer);
        assertEqual(withPeer.count, 1, 'exactly one other collaborator must be listed');
        assertIncludes(withPeer.rows[0].text, 'Presence Peer', 'the validated name must be rendered');

        // A structurally invalid presence payload: the wire codec accepts it (the
        // state is JSON), so the server relays it, and the client must filter it.
        attacker.enablePresence({ id: 'attacker', name: 'Attacker' }, { cursor: { anchor: 0, head: 0 } });
        await sleep(1_500);
        attacker.publishMalformedPresence({ user: {} });
        await sleep(2_000);

        const afterMalformed = await readCollaborators(page);
        ctx.note('collaborators after a malformed presence payload', afterMalformed);
        assert(
          !afterMalformed.rows.some((row) => row.text.includes('Attacker')),
          'a peer whose state fails the awareness schema must not be rendered (R14 / §9.2)',
        );
        assert(
          !afterMalformed.rows.some((row) => row.text.replace(/\s+/g, '') === ''),
          'a nameless collaborator must never be rendered',
        );
        assert(
          afterMalformed.rows.some((row) => row.text.includes('Presence Peer')),
          'the valid collaborator must survive another peer sending junk',
        );

        const diagnostics = await readPageDiagnostics(page);
        ctx.note('page diagnostics', diagnostics);
        assertEqual(diagnostics.pageErrors.length, 0, 'a malformed presence payload must not throw');
      } finally {
        oracle.close();
        attacker.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Remote caret / selection rendering — pinned defect
   * ------------------------------------------------------------------ */
  runner.scenario(
    'cursors/remote-caret-and-selection-render',
    'a remote cursor and selection render in the editor with a name label',
    async (ctx) => {
      const documentId = 'a6-presence-cursor';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        const body = 'abcdefghij\nklmnopqrst\n';
        oracle.replaceAll(body);
        await waitForEditorText(page, (text) => text === body, { label: 'the shared body' });

        const clientId = oracle.enablePresence(
          { id: 'cursor-peer', name: 'Cursor Peer' },
          { cursor: { anchor: 3, head: 3 } },
        );
        ctx.note('oracle awareness client id', clientId);

        // Give the extension every chance: it also repaints on awareness updates.
        await sleep(3_000);
        oracle.setCursor({ anchor: 5, head: 5 });
        await sleep(2_000);
        oracle.setSelection({ from: 2, to: 8 });
        await sleep(2_500);

        const cursors = await readRemoteCursorDom(page);
        ctx.note('remote cursor DOM', cursors);
        const diagnostics = await readPageDiagnostics(page);
        ctx.note('page diagnostics', diagnostics);

        assertEqual(
          cursors.caretCount,
          1,
          'exactly one remote caret must be rendered for one remote peer (DEFECT P0-3)',
        );
        assertEqual(cursors.labelCount, 1, 'the remote caret must carry a name label (DEFECT P0-3)');
        assertIncludes(
          cursors.labels.join(','),
          'Cursor Peer',
          'the label must show the validated collaborator name',
        );
        assertEqual(
          cursors.selectionCount,
          1,
          'a remote selection must be highlighted (DEFECT P0-3)',
        );
        assertEqual(
          cursors.selectionClientIds[0],
          String(clientId),
          "the selection must be attributed to the remote peer's client id",
        );
        // The local caret belongs to the editor, never to the remote overlay.
        assert(
          !cursors.labels.includes('You'),
          'the local cursor must never be rendered as a remote one',
        );
      } finally {
        oracle.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Presence lifecycle — cleared on disconnect and on room switch
   * ------------------------------------------------------------------ */
  runner.scenario(
    'cursors/presence-lifecycle-clears',
    'a departing peer leaves no ghost cursor, and switching documents clears presence',
    async (ctx) => {
      const documentId = 'a6-presence-lifecycle';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        oracle.enablePresence({ id: 'ghost-peer', name: 'Ghost Peer' }, { cursor: { anchor: 0, head: 0 } });
        await page.waitFor(() => document.body.innerText.includes('Ghost Peer'), {
          timeoutMs: 25_000,
          label: 'the peer to appear',
        });
        const before = await readRemoteCursorDom(page);
        ctx.note('before departure', { collaborators: (await readCollaborators(page)).count, cursors: before });

        // Depart without a leave-room: just drop the socket, as a closed tab would.
        oracle.close();
        await page.waitFor(() => !document.body.innerText.includes('Ghost Peer'), {
          timeoutMs: 25_000,
          label: 'the departed peer to be removed from the collaborator list',
        });
        const afterDisconnect = await readRemoteCursorDom(page);
        ctx.note('after departure', afterDisconnect);
        // P0-3 is fixed, so this caret count is real evidence: no caret may survive
        // the departure. The collaborator-list wait above and this assertion now both
        // prove the cleanup.
        assertEqual(afterDisconnect.caretCount, 0, 'a departed peer must leave no ghost caret (§9.1)');

        // A second peer in a different room must never appear here.
        const otherDocument = 'a6-presence-elsewhere';
        const otherOracle = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId: otherDocument,
          label: 'other',
        });
        try {
          otherOracle.enablePresence({ id: 'other-peer', name: 'Other Room Peer' }, { cursor: { anchor: 1, head: 1 } });
          await sleep(2_000);
          const acrossRooms = await readCollaborators(page);
          ctx.note('collaborators across rooms', acrossRooms);
          assert(
            !acrossRooms.rows.some((row) => row.text.includes('Other Room Peer')),
            'a peer in another document room must never appear in this room (isolation)',
          );

          // A room switch must not carry the *previous* room's presence into the new
          // one. The new room legitimately has its own participant - `other-peer`
          // lives here - so the invariant is attribution, not an empty cursor set:
          //   * nothing from the old room may survive the switch;
          //   * every rendered caret must belong to a collaborator this room has.
          // Asserting `caretCount === 0` was wrong: it failed exactly when the new
          // room rendered its own peer, i.e. when the product was behaving correctly.
          await setDocumentId(page, otherDocument);
          const afterSwitch = await readCollaborators(page);
          const cursorsAfterSwitch = await readRemoteCursorDom(page);
          ctx.note('after switching rooms', {
            collaborators: afterSwitch,
            cursors: cursorsAfterSwitch,
          });

          assert(
            !cursorsAfterSwitch.labels.includes('Ghost Peer'),
            "a room switch must not leave the previous room's caret in the new editor",
          );
          // Attribution: a caret may only be rendered for a peer this room has.
          const newRoomRows = afterSwitch.rows;
          for (const label of cursorsAfterSwitch.labels) {
            assert(
              newRoomRows.some((row) => row.text.includes(label)),
              `every rendered caret must belong to a collaborator of this room: "${label}" is not in [${newRoomRows
                .map((row) => row.text)
                .join(' | ')}]`,
            );
          }
          // Positive half: this room publishes a cursor, so a caret must be rendered.
          // Without it, "correctly scoped" and "never renders" (the P0-3 symptom) would
          // be indistinguishable.
          assert(
            cursorsAfterSwitch.caretCount >= 1,
            'the new room must render the caret of the peer that is actually in it',
          );
        } finally {
          otherOracle.close();
        }
      } finally {
        oracle.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Undo must not be clobbered by a remote edit (R13)
   * ------------------------------------------------------------------ */
  runner.scenario(
    'realtime/local-undo-does-not-revert-remote-text',
    'a local undo never removes a collaborator edit',
    async (ctx) => {
      const documentId = 'a6-undo-remote';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        oracle.replaceAll('REMOTE-BASE|');
        await waitForEditorText(page, (text) => text === 'REMOTE-BASE|', {
          label: 'the remote base text',
        });

        await typeInEditor(page, 'LOCAL');
        await sleep(1_500);
        oracle.append('REMOTE-TAIL');
        await sleep(2_500);
        const beforeUndo = await editorState(page);
        ctx.note('before undo', JSON.stringify(beforeUndo.text));

        await pressInEditor(page, 'z', { modifiers: 2 });
        await sleep(2_000);
        const afterUndo = await editorState(page);
        ctx.note('after local undo', JSON.stringify(afterUndo.text));

        assertIncludes(
          afterUndo.text,
          'REMOTE-TAIL',
          'a local undo must never revert a collaborator edit (R13 / CONTRACTS §3.1)',
        );
        assertIncludes(
          afterUndo.text,
          'REMOTE-BASE',
          'a local undo must not delete the collaborator base text',
        );
      } finally {
        oracle.close();
      }
    },
  );
}
