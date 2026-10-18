/**
 * 5 000-line performance and the architectural invariants that must hold at size.
 *
 * The assertions that matter here are **structural**, not a percentage:
 *
 * - typing one character must not construct a second `EditorView`,
 * - a remote one-character update must not replace the document,
 * - a collaborator joining must not remount the editor,
 * - a connection-status change must not remount the editor.
 *
 * Every measurement is reported as raw data with its method stated. No speed-up
 * claim is made, because there is no honest baseline to compare against.
 */
import {
  clearEditorTransactions,
  editorState,
  editorTransactions,
  readConnectionStatus,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
} from '../lib/app.mjs';
import { sleep } from '../lib/cdp.mjs';
import { assert, assertEqual, statistics } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';

const LINE_COUNT = 5_000;

/** A realistic Markdown body of at least `lines` lines. */
function buildDocument(lines) {
  const parts = [];
  for (let index = 0; index < lines; index += 1) {
    if (index % 100 === 0) parts.push(`## Section ${index / 100}`);
    else parts.push(`- item ${index}: the quick brown fox jumps over the lazy dog`);
  }
  return `${parts.join('\n')}\n`;
}

/** The transactions the given view dispatched since the last clear. */
async function transactionsForView(page, viewId) {
  const all = await editorTransactions(page);
  return all.filter((transaction) => transaction.viewId === viewId);
}

export function register(runner) {
  runner.scenario(
    'performance/5000-lines-invariants',
    'a 5 000-line document keeps one EditorView across remote edits, typing, presence and status changes',
    async (ctx) => {
      const documentId = 'a6-perf-5000';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        const body = buildDocument(LINE_COUNT);
        const lineCount = body.split('\n').length - 1;
        ctx.note('document built', {
          characters: body.length,
          lines: lineCount,
          requestedLines: LINE_COUNT,
        });
        assert(lineCount >= LINE_COUNT, `the document must have at least ${LINE_COUNT} lines`);

        oracle.replaceAll(body);
        const loaded = await waitForEditorText(page, (text) => text.length === body.length, {
          timeoutMs: 90_000,
          label: 'the 5 000-line document to reach the editor',
        });
        const baselineMounts = await page.evaluate(() => window.__qa.summary().editorMounts);
        ctx.note('editor loaded', {
          length: loaded.length,
          viewId: loaded.viewId,
          mountsSoFar: baselineMounts,
        });

        /* ---- 1. Remote single-character update (editor still agrees with Y.Text) */
        await clearEditorTransactions(page);
        const beforeRemote = await editorState(page);
        const remoteStart = Date.now();
        oracle.insertAt(0, 'R');
        const afterRemote = await waitForEditorText(page, (text) => text === oracle.text, {
          timeoutMs: 30_000,
          label: 'the remote single-character update',
        });
        const remoteLatency = Date.now() - remoteStart;
        const remoteTransactions = await transactionsForView(page, afterRemote.viewId);
        const applied = remoteTransactions[remoteTransactions.length - 1];
        ctx.note('remote single-character update on a 5 000-line document', {
          latencyMs: remoteLatency,
          transactions: remoteTransactions,
        });
        assert(applied !== undefined, 'the remote character produced no editor transaction');
        assertEqual(applied.inserted, 1, 'a remote character must insert exactly one character');
        assertEqual(applied.deleted, 0, 'a remote character must delete nothing');
        assertEqual(applied.count, 1, 'a remote character must be one range, not a document replace');
        assertEqual(
          applied.docAfter,
          beforeRemote.length + 1,
          'a remote character must not rewrite the 5 000-line document',
        );
        assertEqual(
          afterRemote.viewId,
          loaded.viewId,
          'a remote character must not remount the editor',
        );

        /* ---- 2. Local single-character input ------------------------------- */
        // Ten separate real keystrokes, so the latency report has a sample rather
        // than a single data point.
        await page.click('.cm-content');
        await page.pressKey('End', { modifiers: 2 });
        await page.evaluate(() => {
          window.__qa.inputEvents.length = 0;
        });
        for (let index = 0; index < 10; index += 1) await page.insertText('x');
        await sleep(1_500);
        const afterTyping = await editorState(page);
        const inputSamples = await page.evaluate(() => window.__qa.inputEvents.slice());
        const afterTypingMounts = await page.evaluate(() => window.__qa.summary().editorMounts);
        ctx.note('after ten local characters on a 5 000-line document', {
          viewId: afterTyping.viewId,
          sameView: afterTyping.viewId === loaded.viewId,
          mounts: afterTypingMounts,
        });
        // Honest labelling: this measures the browser's own input → paint cost. The
        // CRDT leg is not included because of DEFECT P0-2 (the keystroke never reaches
        // Y.Text, so no transaction, persistence write or frame happens for it).
        ctx.note('local input latency (ms, measured inside the page)', {
          sync: statistics(inputSamples.map((sample) => sample.sync)),
          toPaint: statistics(
            inputSamples.map((sample) => sample.toPaint).filter((value) => typeof value === 'number'),
          ),
          samples: inputSamples.length,
          includesCrdtLeg: false,
        });
        assertEqual(afterTyping.viewId, loaded.viewId, 'typing must not rebuild the EditorView');
        assertEqual(
          afterTypingMounts,
          baselineMounts,
          'typing must not mount a new .cm-editor on a 5 000-line document',
        );
        ctx.note('editor vs Y.Text after local typing', {
          editorLength: afterTyping.length,
          yTextLength: oracle.documentLength,
          diverged: afterTyping.length !== oracle.documentLength,
        });

        /* ---- 3. Collaborator list changes ---------------------------------- */
        const mountsBeforePeer = await page.evaluate(() => window.__qa.summary().editorMounts);
        oracle.enablePresence(
          { id: 'perf-peer', name: 'Perf Peer' },
          { cursor: { anchor: 0, head: 0 } },
        );
        await page.waitFor(() => document.body.innerText.includes('Perf Peer'), {
          timeoutMs: 30_000,
          label: 'the collaborator to appear',
        });
        oracle.setCursor({ anchor: 10, head: 20 });
        await sleep(1_500);
        const mountsAfterPeer = await page.evaluate(() => window.__qa.summary().editorMounts);
        ctx.note('after a collaborator joined and moved', { mountsBeforePeer, mountsAfterPeer });
        assertEqual(
          mountsAfterPeer,
          mountsBeforePeer,
          'a collaborator or cursor change must not remount the editor',
        );

        /* ---- 4. Connection status change ----------------------------------- */
        const lengthBeforeOutage = (await editorState(page)).length;
        await ctx.stack.stopServer();
        const degraded = await waitForConnectionStatus(page, ['reconnecting', 'offline', 'error'], {
          timeoutMs: 30_000,
        });
        const mountsAfterStatus = await page.evaluate(() => window.__qa.summary().editorMounts);
        const lengthDuringOutage = (await editorState(page)).length;
        ctx.note('after the connection degraded', {
          status: degraded,
          mountsBeforeStatus: mountsAfterPeer,
          mountsAfterStatus,
          editorLength: lengthDuringOutage,
        });
        assertEqual(
          mountsAfterStatus,
          mountsAfterPeer,
          'a connection-status change must not remount the editor',
        );
        assertEqual(
          lengthDuringOutage,
          lengthBeforeOutage,
          'the document must survive an outage untouched',
        );

        await ctx.stack.startServer();
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 60_000 });
        ctx.note('reconnected after the outage', await readConnectionStatus(page));

        const summary = await page.evaluate(() => window.__qa.summary());
        ctx.note('final instrumentation summary', summary);
        assertEqual(summary.editorLive, 1, 'exactly one .cm-editor must be alive at the end');
      } finally {
        oracle.close();
      }
    },
  );

  /*
   * The invariant the task brief names explicitly: "a remote character must not
   * replace the whole editor document". With DEFECT P0-2 open, the editor holds text
   * that Y.Text does not, so the next remote update reconciles by replacing the whole
   * document. Pinned, not skipped.
   */
  runner.scenario(
    'performance/remote-char-does-not-replace-document',
    'after local typing, a remote character must still be applied as a one-character edit',
    async (ctx) => {
      const documentId = 'a6-perf-minimal';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        const body = buildDocument(LINE_COUNT);
        oracle.replaceAll(body);
        const loaded = await waitForEditorText(page, (text) => text.length === body.length, {
          timeoutMs: 90_000,
          label: 'the 5 000-line document',
        });

        // A real local keystroke: with P0-2 this stays in the editor only.
        await typeInEditor(page, 'x');
        await sleep(1_000);
        const diverged = await editorState(page);
        ctx.note('after local typing', {
          editorLength: diverged.length,
          yTextLength: oracle.documentLength,
        });

        await clearEditorTransactions(page);
        oracle.insertAt(0, 'R');
        const afterRemote = await waitForEditorText(page, (text) => text === oracle.text, {
          timeoutMs: 30_000,
          label: 'the remote character after local typing',
        }).catch(async (error) => {
          // With P0-2 the editor ends up longer than Y.Text (it keeps the unsent 'x'),
          // so an exact match may never happen. Report what we have.
          ctx.note('editor never matched Y.Text', error.message);
          return editorState(page);
        });

        const transactions = await transactionsForView(page, afterRemote.viewId);
        const applied = transactions[transactions.length - 1];
        ctx.note('transactions for the remote character', transactions);
        assert(applied !== undefined, 'the remote character produced no editor transaction');
        assertEqual(
          applied.inserted,
          1,
          `a remote character must insert one character, not replace the document ` +
            `(observed inserted=${applied.inserted} deleted=${applied.deleted} ` +
            `docBefore=${applied.docBefore}) [DEFECT P0-2]`,
        );
        assertEqual(applied.deleted, 0, 'a remote character must delete nothing [DEFECT P0-2]');
        assertEqual(afterRemote.viewId, loaded.viewId, 'the editor must not be remounted');
      } finally {
        oracle.close();
      }
    },
  );
}
