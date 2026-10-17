/**
 * Chaos: real outages, duplicated and reordered frames, and the document-switch
 * race.
 *
 * The faults are injected in the page's own transport (see
 * `instrument/page-instrument.js`), so the client's real reconnect, real merge and
 * real teardown paths run — nothing here calls a state function and asserts that it
 * was called.
 */
import {
  captureBinaryFrames,
  countInboundBinary,
  editorState,
  holdCount,
  injectInbound,
  lastInboundBinary,
  qaSummary,
  readCollaborators,
  readConnectionStatus,
  readRemoteCursorDom,
  releaseHeld,
  setDocumentId,
  setOffline,
  setPolicy,
  waitForConnectionStatus,
  waitForEditorText,
} from '../lib/app.mjs';
import { sleep } from '../lib/cdp.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { describeDivergence, WireOracle } from '../lib/oracle.mjs';

export function register(runner) {
  /* ------------------------------------------------------------------ *
   * Offline → online: reconnect without a reload
   * ------------------------------------------------------------------ */
  runner.scenario(
    'chaos/offline-reconnect',
    'a client that loses the network reconnects on its own and catches up, without remounting the editor',
    async (ctx) => {
      const documentId = 'a6-chaos-reconnect';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        oracle.replaceAll('BASE|');
        const base = await waitForEditorText(page, (text) => text === 'BASE|', {
          label: 'the base text',
        });
        await waitForConnectionStatus(page, 'connected');
        const mounts = await page.evaluate(() => window.__qa.summary().editorMounts);
        ctx.note('baseline', { length: base.length, viewId: base.viewId, mounts });

        // Cut this client off for real: existing socket dropped, new connections
        // rewritten to an unreachable port.
        await setOffline(page, true);
        await waitForConnectionStatus(page, ['reconnecting', 'offline', 'error'], {
          timeoutMs: 20_000,
        });
        const offlineStatus = await readConnectionStatus(page);
        ctx.note('status while offline', offlineStatus);

        // Editing must stay possible (R10). Only the editor's own buffer is
        // observable here because DEFECT P0-2 keeps keystrokes out of Y.Text.
        const typedOffline = await page.evaluate(() => {
          const content = document.querySelector('.cm-content');
          return content !== null && content.getAttribute('contenteditable') === 'true';
        });
        ctx.note('editor still contenteditable while offline', typedOffline);
        assert(typedOffline, 'the editor must stay editable while offline (R10)');

        // A collaborator edits while this client is away.
        oracle.append('WHILE-AWAY|');
        await sleep(1_000);

        // Come back. The provider must reconnect by itself.
        await setOffline(page, false);
        const recovered = await waitForConnectionStatus(page, 'connected', { timeoutMs: 40_000 });
        ctx.note('status after coming back', recovered);
        assertEqual(recovered, 'connected', 'the client must reconnect without a reload');

        const after = await waitForEditorText(page, (text) => text.includes('WHILE-AWAY|'), {
          label: 'the edit made while offline',
        });
        ctx.note('editor caught up', { length: after.length, viewId: after.viewId });
        assertIncludes(after.text, 'WHILE-AWAY|', 'the missed edit must arrive after reconnect');
        assertEqual(after.viewId, base.viewId, 'a reconnect must not remount the editor');

        const afterMounts = await page.evaluate(() => window.__qa.summary().editorMounts);
        assertEqual(afterMounts, mounts, 'a reconnect must not mount a second .cm-editor');

        // No ghost collaborators after the round trip.
        await sleep(2_000);
        const collaborators = await readCollaborators(page);
        ctx.note('collaborators after reconnect', collaborators);
        assert(
          collaborators.count <= 1,
          `a reconnect must not duplicate collaborators (saw ${collaborators.count})`,
        );
      } finally {
        oracle.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Duplicate frames are harmless (CRDT idempotency)
   * ------------------------------------------------------------------ */
  runner.scenario(
    'chaos/duplicate-inbound-frames',
    'replaying the same Yjs update three times changes nothing and does not loop',
    async (ctx) => {
      const documentId = 'a6-chaos-duplicate';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        await captureBinaryFrames(page, true);
        oracle.replaceAll('duplicate-baseline|');
        const applied = await waitForEditorText(page, (text) => text === 'duplicate-baseline|', {
          label: 'the baseline text',
        });
        ctx.note('baseline', { length: applied.length, viewId: applied.viewId });

        // The exact bytes the server sent for that update.
        const captured = await lastInboundBinary(page, documentId);
        assert(captured !== null, 'no inbound binary frame was captured to replay');
        ctx.note('captured frame', {
          byteLength: captured.byteLength,
          frameType: captured.frameType,
        });

        const before = await countInboundBinary(page, documentId);
        const injected = await injectInbound(page, documentId, captured.base64, 3);
        assert(injected.ok, `frame injection failed: ${injected.reason ?? 'unknown'}`);
        await sleep(2_500);

        const after = await editorState(page);
        ctx.note('editor after three duplicated frames', {
          length: after.length,
          sameView: after.viewId === applied.viewId,
        });
        assertEqual(
          after.text,
          'duplicate-baseline|',
          'a duplicated Yjs update must be a no-op (CONTRACTS §10.3)',
        );
        assertEqual(after.viewId, applied.viewId, 'a duplicated frame must not remount the editor');

        const summary = await qaSummary(page);
        ctx.note('transport summary', summary);
        ctx.note('inbound binary frames', { before, after: await countInboundBinary(page, documentId) });
        // No echo storm: injecting frames must not make the client send traffic.
        assert(summary.errors === 0, `the client recorded ${summary.errors} transport errors`);
      } finally {
        oracle.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Out-of-order delivery still converges
   * ------------------------------------------------------------------ */
  runner.scenario(
    'chaos/out-of-order-delivery',
    'frames released in reverse order still converge to the collaborator state',
    async (ctx) => {
      const documentId = 'a6-chaos-order';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        oracle.replaceAll('order-base|');
        await waitForEditorText(page, (text) => text === 'order-base|', { label: 'the base text' });

        // Buffer everything the server sends for this room.
        await setPolicy(page, documentId, { holdIncoming: true });

        oracle.append('FIRST|');
        await sleep(300);
        oracle.append('SECOND|');
        await sleep(1_500);
        const expected = oracle.text;
        const heldCount = await holdCount(page, documentId);
        ctx.note('held inbound frames', heldCount);
        ctx.note('server text', expected);
        assert(heldCount > 0, 'the hold policy caught no frames — the test would be vacuous');

        const before = await editorState(page);
        ctx.note('editor while frames are held', JSON.stringify(before.text));

        // Deliver them newest-first.
        const released = await releaseHeld(page, documentId, { reverse: true });
        ctx.note('release result', released);
        await setPolicy(page, documentId, { holdIncoming: false });

        const converged = await waitForEditorText(page, (text) => text === expected, {
          label: 'convergence after reversed delivery',
        });
        ctx.note('editor after reversed delivery', {
          length: converged.length,
          sameView: converged.viewId === before.viewId,
        });
        assertEqual(
          converged.text,
          expected,
          `out-of-order delivery must still converge (${describeDivergence(expected, converged.text)})`,
        );
      } finally {
        oracle.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Document-switch race (P0)
   * ------------------------------------------------------------------ */
  runner.scenario(
    'chaos/document-switch-race',
    'traffic belonging to document A can never enter document B after a switch',
    async (ctx) => {
      const docA = 'a6-race-source';
      const docB = 'a6-race-target';

      const oracleA = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId: docA, label: 'oracleA' });
      const oracleB = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId: docB, label: 'oracleB' });
      const page = await ctx.newAppPage({ documentId: docA });
      try {
        oracleA.replaceAll('# A content\n');
        oracleB.replaceAll('# B content\n');
        const seenA = await waitForEditorText(page, (text) => text === '# A content\n', {
          label: 'document A content',
        });
        await waitForConnectionStatus(page, 'connected');

        // 1. Buffer everything A sends while the session is still live.
        await setPolicy(page, docA, { holdIncoming: true });
        oracleA.append('LATE-A-1|');
        await sleep(300);
        oracleA.append('LATE-A-2|');
        await sleep(1_500);
        const held = await holdCount(page, docA);
        ctx.note('frames held for document A', held);
        assert(held > 0, 'no frames were held for A — the race would not be exercised');

        // 2. Switch to B while A's traffic is still undelivered.
        await setDocumentId(page, docB);
        const seenB = await waitForEditorText(page, (text) => text === '# B content\n', {
          label: 'document B content',
        });
        ctx.note('document B after the switch', {
          length: seenB.length,
          viewId: seenB.viewId,
          newView: seenB.viewId !== seenA.viewId,
        });

        // 3. Now let A's late frames go.
        const released = await releaseHeld(page, docA, {});
        ctx.note('release result for the old document', released);
        await sleep(2_000);

        const after = await editorState(page);
        const collaborators = await readCollaborators(page);
        const cursors = await readRemoteCursorDom(page);
        const status = await readConnectionStatus(page);
        ctx.note('after releasing the old room traffic', {
          editor: JSON.stringify(after.text),
          collaborators,
          cursors,
          status,
        });

        // The decisive assertion: the old document's data reached no handler.
        assertEqual(
          released.delivered,
          0,
          "document A's late frames must not be delivered to any live handler",
        );
        assert(released.dropped > 0, 'the held frames must have been dropped after teardown');
        assertEqual(after.text, '# B content\n', "document B's editor must be untouched");
        assert(!after.text.includes('LATE-A'), "document A's late edit must never appear in B");
        assertEqual(status, 'connected', "document B's connection must stay healthy");
        assertEqual(collaborators.count, 0, 'no collaborator from A may leak into B');

        const socketsA = await page.evaluate((id) => window.__qa.socketsFor(id), docA);
        ctx.note('document A sockets', socketsA);
        assert(
          socketsA.every((socket) => socket.closedAt !== null && !socket.handlerAttached),
          "document A's socket must be closed and detached after the switch",
        );
      } finally {
        oracleA.close();
        oracleB.close();
      }
    },
  );

  /* ------------------------------------------------------------------ *
   * Repeated awareness does not duplicate collaborators
   * ------------------------------------------------------------------ */
  runner.scenario(
    'chaos/repeated-awareness-no-duplicates',
    'repeated presence updates keep exactly one collaborator entry',
    async (ctx) => {
      const documentId = 'a6-chaos-awareness';
      const oracle = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'oracle' });
      const page = await ctx.newAppPage({ documentId });
      try {
        oracle.enablePresence({ id: 'repeat-peer', name: 'Repeat Peer' }, { cursor: { anchor: 0, head: 0 } });
        await page.waitFor(() => document.body.innerText.includes('Repeat Peer'), {
          timeoutMs: 25_000,
          label: 'the peer to appear',
        });

        for (let index = 0; index < 20; index += 1) {
          oracle.setCursor({ anchor: index, head: index });
          await sleep(100);
        }
        await sleep(2_000);

        const collaborators = await readCollaborators(page);
        ctx.note('collaborators after 20 presence updates', collaborators);
        assertEqual(collaborators.count, 1, 'repeated presence updates must not duplicate a collaborator');

        const summary = await qaSummary(page);
        ctx.note('transport summary', summary);
        assert(summary.errors === 0, 'presence churn must not produce transport errors');
      } finally {
        oracle.close();
      }
    },
  );
}
