/**
 * Browser IndexedDB — Path 1 of `docs/ARCHITECTURE.md` §2, tested in a real browser.
 *
 * The A1 README states plainly that the Node suite proves "wiring only" against an
 * in-memory IndexedDB double, and that the browser runbook was "not yet executed".
 * These scenarios execute it, and they check the actual database — name, object
 * store, record encoding and document isolation — rather than inferring durability
 * from the fact that the text is on screen afterwards.
 *
 * Every scenario here uses the default document, because a page reload resets the
 * Redux store to `DEFAULT_DOCUMENT_ID`; a switched document would not be reopened by
 * the reload under test.
 */
import {
  describeIndexedDb,
  documentDatabaseName,
  documentReplica,
  editorState,
  readIndexedDb,
  reloadApp,
  setOffline,
  typeInEditor,
  waitForEditorText,
  waitForPersisted,
} from '../lib/app.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { describeDivergence, WireOracle } from '../lib/oracle.mjs';

const DOC = 'demo-document';

/** A per-run marker, so a stale replica from an earlier run cannot satisfy a test. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function register(runner) {
  /* ------------------------------------------------------------------ *
   * Scenario A — reload with the backend stopped
   * ------------------------------------------------------------------ */
  runner.scenario(
    'indexeddb/A-reload-without-backend',
    'typing survives a reload with the backend stopped, restored from real IndexedDB',
    async (ctx) => {
      const page = await ctx.newAppPage();
      const text = marker('persisted');

      // Baseline before typing, so "nothing was written" is measurable rather than
      // inferred from the assertion that finally fails.
      const baseline = await readIndexedDb(page, { includeSample: false });
      const baselineUpdates =
        documentReplica(baseline, DOC)?.stores.find((store) => store.name === 'updates')?.count ?? 0;
      ctx.note('stored updates before typing', baselineUpdates);

      await typeInEditor(page, text);
      await waitForEditorText(page, (value) => value.includes(text), { label: 'typed text' });
      const beforeReload = await editorState(page);
      ctx.note('editor before reload', {
        length: beforeReload.length,
        includesMarker: beforeReload.text.includes(text),
      });

      // Durability, not "it is on screen": read the real database.
      const persisted = await waitForPersisted(page, { documentId: DOC });
      const report = await readIndexedDb(page);
      ctx.note('IndexedDB databases', describeIndexedDb(report));

      const replica = documentReplica(report, DOC);
      assert(replica !== null, `expected a replica database named ${documentDatabaseName(DOC)}`);
      const updates = replica.stores.find((store) => store.name === 'updates');
      assert(updates !== undefined, 'the replica has no `updates` object store');
      assert(updates.count >= 1, 'the `updates` store holds no records');
      // §0: the replica stores encoded Yjs updates, never a parallel Markdown string.
      assertEqual(
        updates.sample.firstRecordType,
        'binary',
        'the replica must store encoded Yjs updates (binary), not a string body',
      );
      ctx.note('updates store', {
        count: updates.count,
        firstRecordType: updates.sample.firstRecordType,
        firstRecordByteLength: updates.sample.firstRecordByteLength,
        totalBytes: updates.sample.totalBytes,
        settledCount: persisted.count,
        grewBecauseOfTyping: updates.count > baselineUpdates,
      });

      // Now make the backend genuinely unreachable and reload.
      await ctx.stack.stopServer();
      ctx.note('backend stopped', `port ${ctx.stack.serverPort} no longer accepting connections`);

      await reloadApp(page);

      const afterReload = await waitForEditorText(page, (value) => value.includes(text), {
        label: 'restored text after reload',
      });
      ctx.note('editor after reload', {
        length: afterReload.length,
        includesMarker: afterReload.text.includes(text),
      });
      assertIncludes(afterReload.text, text, 'text restored from IndexedDB with no backend');

      // The badge must not lie about the transport while local durability worked.
      const status = await page.evaluate(
        () => document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
      );
      ctx.note('connection status with backend down', status);
      assert(
        status !== 'connected',
        `the badge reported "connected" while the backend was stopped (got ${status})`,
      );

      // Editing must still be possible offline (R10): one more real keystroke.
      const offlineText = marker('offline-typing');
      await typeInEditor(page, offlineText);
      const offlineState = await waitForEditorText(
        page,
        (value) => value.includes(offlineText),
        { label: 'offline keystroke' },
      );
      ctx.note('editing works offline', offlineState.text.includes(offlineText));

      await ctx.stack.startServer();
      ctx.note('backend restarted', `port ${ctx.stack.serverPort} ready`);
    },
    // "Typing survives a reload" requires the keystroke to reach Y.Text at all.
  );

  /* ------------------------------------------------------------------ *
   * Scenario B — offline edits survive closing and reopening the page
   * ------------------------------------------------------------------ */
  runner.scenario(
    'indexeddb/B-offline-edits-survive-reopen',
    'edits made while offline are still there after closing and reopening the page',
    async (ctx) => {
      const page = await ctx.newAppPage();
      const online = marker('online');
      const offline = marker('offline');

      await typeInEditor(page, online);
      await waitForEditorText(page, (value) => value.includes(online), { label: 'online text' });
      await waitForPersisted(page, { documentId: DOC });
      ctx.note('online text persisted', online);

      // Cut this client off for real (new sockets go to an unreachable port).
      await setOffline(page, true);
      ctx.note('client taken offline', true);

      await typeInEditor(page, offline);
      const whileOffline = await waitForEditorText(page, (value) => value.includes(offline), {
        label: 'offline text in the editor',
      });
      ctx.note('offline keystrokes reached the editor', whileOffline.text.includes(offline));

      await waitForPersisted(page, { documentId: DOC });
      const beforeReopen = await readIndexedDb(page);
      const heldBefore = documentReplica(beforeReopen, DOC)?.stores.find(
        (store) => store.name === 'updates',
      );
      ctx.note('stored updates before reopening', heldBefore?.count ?? 0);

      // Reopen the page while still offline: the offline flag has to be re-armed
      // before the application scripts run.
      await page.addInitScript('window.__qa && window.__qa.setOffline(true);');
      await reloadApp(page);

      const afterReopen = await waitForEditorText(
        page,
        (value) => value.includes(online) && value.includes(offline),
        { label: 'both online and offline text after reopening' },
      );
      ctx.note('restored after reopening', {
        length: afterReopen.length,
        hasOnline: afterReopen.text.includes(online),
        hasOffline: afterReopen.text.includes(offline),
      });
      assertIncludes(afterReopen.text, online, 'online text after reopening offline');
      assertIncludes(afterReopen.text, offline, 'offline text after reopening offline');

      const summary = await page.evaluate(() => window.__qa.summary());
      ctx.note('transport while offline', {
        sockets: summary.sockets,
        live: summary.liveSockets,
        collaborationSockets: summary.liveDocumentSockets,
      });
    },
    // Offline edits are durable because they reach Y.Text immediately (P0-2 fix).
  );

  /* ------------------------------------------------------------------ *
   * Scenario C — reconnect converges (state-vector sync)
   * ------------------------------------------------------------------ */
  runner.scenario(
    'indexeddb/C-offline-then-reconnect-converges',
    'a client that comes back online converges with the server without a reload',
    async (ctx) => {
      const page = await ctx.newAppPage();
      const beforeDrop = marker('before-drop');

      await typeInEditor(page, beforeDrop);
      await waitForEditorText(page, (value) => value.includes(beforeDrop), {
        label: 'text before the drop',
      });
      await waitForPersisted(page, { documentId: DOC });

      // Baseline for the remount invariant. The assertion has to be "reconnecting adds
      // no mount", not "the page mounts exactly one editor": dev React StrictMode
      // double-invokes mount effects, so the absolute count is already 2 before any
      // outage. `chaos/offline-reconnect` asserts the same invariant the same way.
      const beforeOutage = await editorState(page);
      const mountsBeforeOutage = await page.evaluate(() => window.__qa.summary().editorMounts);
      ctx.note('baseline before the outage', {
        viewId: beforeOutage.viewId,
        mounts: mountsBeforeOutage,
      });

      // A real, client-side outage: the socket dies and cannot be re-established
      // until the client is put back online.
      await setOffline(page, true);
      await page.waitFor(
        () =>
          ['reconnecting', 'offline', 'error'].includes(
            document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? '',
          ),
        { timeoutMs: 20_000, label: 'the offline status' },
      );
      const framesWhileOffline = await page.evaluate(
        (id) => window.__qa.countInboundBinary(id),
        DOC,
      );
      ctx.note('inbound frames while offline', framesWhileOffline);

      await setOffline(page, false);
      ctx.note('client back online', true);

      const started = Date.now();
      let status = null;
      while (Date.now() - started < 40_000) {
        status = await page.evaluate(
          () => document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
        );
        if (status === 'connected') break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      ctx.note('connection status after coming back online', status);
      assertEqual(status, 'connected', 'the client must reconnect without a reload');

      // An independent Yjs peer on the real server must see the same document.
      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId: DOC,
        label: 'oracle/C',
      });
      try {
        const expected = (await editorState(page)).text;
        await oracle.waitForText(expected, { timeoutMs: 30_000 });
        ctx.note('converged', {
          editorChars: expected.length,
          oracleChars: oracle.documentLength,
        });
        assertIncludes(oracle.text, beforeDrop, 'the server must have received the edit');
        ctx.note('oracle frame statistics', oracle.statistics);
      } finally {
        oracle.close();
      }

      const after = await editorState(page);
      const mountsAfter = await page.evaluate(() => window.__qa.summary().editorMounts);
      ctx.note('after reconnecting', { viewId: after.viewId, mounts: mountsAfter });
      assertEqual(after.viewId, beforeOutage.viewId, 'a reconnect must keep the same EditorView');
      assertEqual(
        mountsAfter,
        mountsBeforeOutage,
        'a reconnect must not mount a second .cm-editor',
      );
    },
  );

  /* ------------------------------------------------------------------ *
   * Scenario D — two tabs, same document, same IndexedDB
   * ------------------------------------------------------------------ */
  runner.scenario(
    'indexeddb/D-two-tabs-share-one-replica',
    'two tabs on the same document share one replica without duplication or an update loop',
    async (ctx) => {
      const pageA = await ctx.newAppPage();
      const pageB = await ctx.newAppPage();

      const textA = marker('tabA');
      const textB = marker('tabB');

      await typeInEditor(pageA, textA);
      await typeInEditor(pageB, textB);

      const deadline = Date.now() + 30_000;
      let stateA = await editorState(pageA);
      let stateB = await editorState(pageB);
      while (Date.now() < deadline) {
        stateA = await editorState(pageA);
        stateB = await editorState(pageB);
        if (
          stateA.text === stateB.text &&
          stateA.text.includes(textA) &&
          stateA.text.includes(textB)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      ctx.note('tab A', { length: stateA.text.length, viewId: stateA.viewId });
      ctx.note('tab B', { length: stateB.text.length, viewId: stateB.viewId });

      // Convergence between two tabs requires P0-2 to be fixed: a keystroke never
      // reaches Y.Text, so neither tab can see the other's typing.
      assertEqual(
        stateA.text,
        stateB.text,
        `the two tabs must converge (${describeDivergence(stateA.text, stateB.text)}) [DEFECT P0-2]`,
      );
      const countOf = (haystack, needle) => haystack.split(needle).length - 1;
      assertEqual(countOf(stateA.text, textA), 1, 'tab A text must appear exactly once');
      assertEqual(countOf(stateA.text, textB), 1, 'tab B text must appear exactly once');

      const idb = await readIndexedDb(pageA);
      ctx.note('IndexedDB databases', describeIndexedDb(idb));
      const replicas = idb.databases.filter(
        (database) => database.name === documentDatabaseName(DOC),
      );
      assertEqual(replicas.length, 1, 'both tabs must use exactly one replica database');
      const updates = replicas[0].stores.find((store) => store.name === 'updates');
      assert(
        updates !== undefined && updates.count >= 1,
        'the shared replica has no stored updates',
      );
      assertEqual(
        updates.sample.firstRecordType,
        'binary',
        'the shared replica must hold encoded updates',
      );

      // No infinite update loop: after quiescence nothing may still be moving.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const quietA = await editorState(pageA);
      const framesA = await pageA.evaluate(() => window.__qa.summary().frames);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const laterA = await editorState(pageA);
      const framesA2 = await pageA.evaluate(() => window.__qa.summary().frames);
      ctx.note('quiescence', {
        textStable: quietA.text === laterA.text,
        frameDelta: framesA2 - framesA,
      });
      assertEqual(quietA.text, laterA.text, 'tab A text must stop changing (no update loop)');
      assert(
        framesA2 - framesA < 20,
        `tab A emitted ${framesA2 - framesA} frames while idle — suspected update loop`,
      );
    },
  );
}
