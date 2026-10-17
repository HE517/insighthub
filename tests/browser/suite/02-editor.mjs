/**
 * Real `EditorView` — the DOM/editor-state/Y.Text triangle.
 *
 * Everything here reads the **real** CodeMirror instance the application built (see
 * `lib/app.mjs` for how the harness reaches it), so "the editor did not remount" is
 * an object-identity assertion and "a remote character did not rewrite the document"
 * is read off the `ChangeSet` the editor actually dispatched.
 */
import {
  clearEditorTransactions,
  editorState,
  editorTransactions,
  pressInEditor,
  readUndoState,
  renderedText,
  setDocumentId,
  typeInEditor,
  waitForEditorText,
} from '../lib/app.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';

const DOC_A = 'demo-document';

export function register(runner) {
  /* ------------------------------------------------------------------ *
   * Initial Y.Text is displayed, and typing does not rebuild the editor
   * ------------------------------------------------------------------ */
  runner.scenario(
    'editor/mounts-on-existing-ytext',
    'the editor mounts on the existing Y.Text and keeps the same EditorView across input',
    async (ctx) => {
      // A document of its own, seeded by an independent peer that stays connected —
      // M1 has no durable server persistence, so an empty room is destroyed and its
      // content with it (documented M1 limitation, docs/TASKS.md §12).
      const documentId = 'a6-editor-mount';
      const seed = `# Seeded\n\n${'line\n'.repeat(20)}`;
      const seeder = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'seeder',
      });
      let page;
      try {
        const seededText = seeder.replaceAll(seed);
        ctx.note('seeded server document', `${seededText.length} chars`);

        page = await ctx.newAppPage({ documentId });
        const initial = await waitForEditorText(page, (text) => text === seededText, {
          label: 'seeded content in the editor',
        });
        ctx.note('initial editor state', {
          length: initial.length,
          viewId: initial.viewId,
        });
        assertEqual(initial.text, seededText, 'the editor must open on the authoritative Y.Text');

        const painted = await renderedText(page);
        ctx.note('painted DOM text (first 80 chars)', JSON.stringify((painted ?? '').slice(0, 80)));
        assertIncludes(painted ?? '', '# Seeded', 'the painted DOM must show the Y.Text content');

        // A real keystroke must not construct a second EditorView.
        const mountsBefore = await page.evaluate(() => window.__qa.summary().editorMounts);
        await typeInEditor(page, 'Q');
        const after = await editorState(page);
        const mountsAfter = await page.evaluate(() => window.__qa.summary().editorMounts);
        ctx.note('after one keystroke', {
          viewId: after.viewId,
          mountsBefore,
          mountsAfter,
          sameView: after.viewId === initial.viewId,
        });
        assertEqual(after.viewId, initial.viewId, 'a keystroke must not create a new EditorView');
        assertEqual(mountsAfter, mountsBefore, 'a keystroke must not mount a new .cm-editor');
      } finally {
        seeder.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * A remote change is applied as a minimal edit, not a document replace
   * ------------------------------------------------------------------ */
  runner.scenario(
    'editor/remote-change-is-minimal',
    'a one-character remote update is applied as a one-character editor transaction',
    async (ctx) => {
      const documentId = 'a6-editor-minimal';
      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'oracle',
      });
      const body = `# Remote\n\n${'alpha bravo charlie\n'.repeat(40)}`;
      oracle.replaceAll(body);

      const page = await ctx.newAppPage({ documentId });
      try {
        const before = await waitForEditorText(page, (text) => text === body, {
          label: 'full remote body',
        });
        ctx.note('document before the single-character update', {
          length: before.length,
          viewId: before.viewId,
        });

        await clearEditorTransactions(page);
        const marker = 'Z';
        oracle.insertAt(0, marker);
        const expected = oracle.text;
        const after = await waitForEditorText(page, (text) => text === expected, {
          label: 'one-character remote update',
        });

        const transactions = await editorTransactions(page);
        // Only transactions belonging to the live view are relevant: the prototype
        // patch records every EditorView, including any that a document switch
        // created earlier in the same page.
        const ownTransactions = transactions.filter(
          (transaction) => transaction.viewId === after.viewId,
        );
        ctx.note('editor transactions dispatched for the remote update', ownTransactions);
        assert(ownTransactions.length >= 1, 'the remote update produced no editor transaction');

        // The decisive assertion: the editor must not have replaced the document.
        const applied = ownTransactions[ownTransactions.length - 1];
        assertEqual(applied.inserted, 1, 'the remote update must insert exactly one character');
        assertEqual(applied.deleted, 0, 'the remote update must not delete any characters');
        assertEqual(applied.count, 1, 'the remote update must be a single range change');
        assertEqual(
          applied.docAfter,
          before.length + 1,
          'the document may only grow by the inserted character',
        );
        ctx.note('final editor state', { length: after.length, viewId: after.viewId });
        assertEqual(after.viewId, before.viewId, 'a remote update must not remount the editor');
      } finally {
        oracle.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * A local edit must reach Y.Text — pinned defect
   * ------------------------------------------------------------------ */
  runner.scenario(
    'editor/local-edit-reaches-ytext',
    'a single local keystroke must be written into Y.Text (and therefore reach the server)',
    async (ctx) => {
      const page = await ctx.newAppPage();
      await page.waitFor(
        () => document.querySelector('[data-testid="connection-status"]')?.dataset.status === 'connected',
        { timeoutMs: 20_000, label: 'a connected session' },
      );

      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId: DOC_A,
        label: 'oracle',
      });
      try {
        ctx.note('server document before typing', JSON.stringify(oracle.text));

        const typed = 'LOCAL-KEYSTROKES';
        await typeInEditor(page, typed);
        const inEditor = await waitForEditorText(page, (text) => text.includes(typed), {
          label: 'the typed text in the editor',
        });
        ctx.note('editor state after typing', {
          length: inEditor.length,
          containsTyped: inEditor.text.includes(typed),
        });

        // Give the whole pipeline a generous window: Y.Text write, persistence
        // debounce (1 s), and the network round trip.
        await new Promise((resolve) => setTimeout(resolve, 4_000));

        const frames = await page.evaluate((id) => window.__qa.countInboundBinary(id), DOC_A);
        const outbound = await page.evaluate(() => {
          const binary = window.__qa.frames.filter(
            (frame) => frame.direction === 'out' && frame.kind === 'binary',
          );
          return { total: binary.length, syncFrames: binary.filter((f) => f.frameType === 0).length };
        });
        ctx.note('frames', { inboundBinary: frames, ...outbound });
        ctx.note('server document after typing', JSON.stringify(oracle.text));

        assertIncludes(
          oracle.text,
          typed,
          'a local keystroke must reach Y.Text and therefore the server (DEFECT P0-2)',
        );
      } finally {
        oracle.close();
      }
    },
    { knownDefect: 'P0-2' },
  );

  /* ------------------------------------------------------------------ *
   * A remote edit must not erase unsent local text — the visible symptom
   * ------------------------------------------------------------------ */
  runner.scenario(
    'editor/remote-edit-preserves-unsent-local-text',
    'an incoming remote edit must not erase text the user just typed',
    async (ctx) => {
      const page = await ctx.newAppPage();
      await page.waitFor(
        () => document.querySelector('[data-testid="connection-status"]')?.dataset.status === 'connected',
        { timeoutMs: 20_000, label: 'a connected session' },
      );

      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId: DOC_A,
        label: 'oracle',
      });
      try {
        const typed = 'USER-TYPED-TEXT';
        await typeInEditor(page, typed);
        await waitForEditorText(page, (text) => text.includes(typed), {
          label: 'the typed text in the editor',
        });
        ctx.note('editor after typing', JSON.stringify((await editorState(page)).text));

        oracle.append('REMOTE-EDIT');
        await new Promise((resolve) => setTimeout(resolve, 3_000));

        const after = await editorState(page);
        ctx.note('editor after the remote edit', JSON.stringify(after.text));
        ctx.note('server document', JSON.stringify(oracle.text));

        assertIncludes(
          after.text,
          typed,
          'text the user typed must still be present after a remote edit arrives (DEFECT P0-2)',
        );
      } finally {
        oracle.close();
      }
    },
    { knownDefect: 'P0-2' },
  );

  /* ------------------------------------------------------------------ *
   * Undo is CRDT-scoped — requires local edits to be in the CRDT at all
   * ------------------------------------------------------------------ */
  runner.scenario(
    'editor/local-undo-available',
    'a local edit is undoable through the session (Y.UndoManager), not a snapshot',
    async (ctx) => {
      const page = await ctx.newAppPage();
      const before = await readUndoState(page);
      ctx.note('undo state on open', before);

      await typeInEditor(page, 'undo-me');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const afterTyping = await readUndoState(page);
      ctx.note('undo state after typing', afterTyping);

      await pressInEditor(page, 'z', { modifiers: 2 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const text = (await editorState(page)).text;
      ctx.note('editor after Mod-z', JSON.stringify(text));

      assert(
        afterTyping !== null && afterTyping.includes('available'),
        'a local edit must become undoable (DEFECT P0-2: the edit never enters Y.Text)',
      );
    },
    { knownDefect: 'P0-2' },
  );

  /* ------------------------------------------------------------------ *
   * Unmount and document switch drop the old editor
   * ------------------------------------------------------------------ */
  runner.scenario(
    'editor/switch-document-isolates-old-editor',
    'after switching documents the old editor receives nothing and the new one shows only its own content',
    async (ctx) => {
      const docA = 'a6-switch-source';
      const docB = 'a6-switch-target';

      // Both peers stay connected for the whole scenario: an empty room is destroyed
      // in M1, so a closed peer would take its document with it.
      const oracleA = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId: docA,
        label: 'oracleA',
      });
      const oracleB = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId: docB,
        label: 'oracleB',
      });
      const textA = `# Document A\n${'alpha\n'.repeat(10)}`;
      const textB = `# Document B\n${'beta\n'.repeat(10)}`;
      oracleA.replaceAll(textA);
      oracleB.replaceAll(textB);

      const page = await ctx.newAppPage({ documentId: docA });
      try {
        const seenA = await waitForEditorText(page, (text) => text === textA, {
          label: 'document A content',
        });
        ctx.note('document A', { length: seenA.length, viewId: seenA.viewId });

        await setDocumentId(page, docB);
        const seenB = await waitForEditorText(page, (text) => text === textB, {
          label: 'document B content',
        });
        ctx.note('document B', { length: seenB.length, viewId: seenB.viewId });
        assert(seenB.viewId !== seenA.viewId, 'switching documents must create a new EditorView');
        assert(
          !seenB.text.includes('# Document A'),
          "document B must not contain document A's body",
        );

        // Editing A now must not touch B's editor.
        oracleA.append('\nLATE-A-EDIT');
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const stillB = await editorState(page);
        ctx.note('document B after a late edit on A', JSON.stringify(stillB.text.slice(0, 40)));
        assertEqual(
          stillB.text,
          textB,
          "a late edit on document A must never enter document B's editor",
        );

        const socketsA = await page.evaluate((id) => window.__qa.socketsFor(id), docA);
        const socketsB = await page.evaluate((id) => window.__qa.socketsFor(id), docB);
        ctx.note('sockets per document', { A: socketsA, B: socketsB });
        assert(
          socketsA.every((socket) => socket.closedAt !== null),
          "document A's socket must be closed after the switch",
        );
        assert(
          socketsB.some((socket) => socket.closedAt === null),
          "document B's socket must be open",
        );
      } finally {
        oracleA.close();
        oracleB.close();
      }
    },
  );
}
