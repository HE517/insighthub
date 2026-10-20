/**
 * M2-P0-1 — durable server persistence, proven in a real browser.
 *
 * Every scenario here runs against a **real** Chrome, a **real** backend process and a
 * **real** SQLite store on disk. Two things make the claims meaningful:
 *
 * 1. **A real process restart.** `stack.crashServer()` kills the process tree without a
 *    graceful shutdown (`store.close()` never runs), then `startServer()` launches a new
 *    pid on the *same* data directory. Reconnect and page reload are explicitly not
 *    accepted substitutes — the assertion records both pids.
 * 2. **A brand-new device.** Every "the content is still there" check opens a browser
 *    with an **empty profile**. A page in the writer's own browser would be answered by
 *    its IndexedDB replica, which would silently prove client persistence instead of
 *    server durability.
 *
 * The durable bytes are also read directly from `insighthub.db` (see
 * `lib/durable-store.mjs`): the stored state is reconstructed into a fresh `Y.Doc`
 * exactly as `DocumentHydrator` would, so "the server has it" is measured, not inferred
 * from a page looking right.
 *
 * Storage isolation: each scenario restarts onto its own temporary directory, and the
 * stack removes every directory it created on exit (`lib/stack.mjs`).
 */
import {
  editorState,
  qaSummary,
  readConnectionStatus,
  setOffline,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
  waitUntil,
} from '../lib/app.mjs';
import {
  acquireWriteLock,
  inspectDocument,
  inspectDurableStore,
  reconstructDurableDocument,
  waitForDurableDocument,
} from '../lib/durable-store.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { describeDivergence, WireOracle } from '../lib/oracle.mjs';

/** A per-run marker, so a stale store can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Restart the server onto a fresh, empty data directory. */
async function freshStore(ctx, label) {
  const result = await ctx.stack.restartServerOnFreshDataPath(label);
  ctx.note('fresh data directory', result.dataPath);
  return result.dataPath;
}

/** Open the application, wait until its room is joined, and type `text`. */
async function connectAndType(ctx, page, text) {
  await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
  await typeInEditor(page, text);
  await waitForEditorText(page, (value) => value.includes(text), {
    timeoutMs: 30_000,
    label: `the editor to show ${text}`,
  });
}

/** The server-side text, reconstructed from the durable bytes. */
async function durableText(dataPath, documentId) {
  const reconstructed = await reconstructDurableDocument(dataPath, documentId);
  return reconstructed;
}

/** A bare WebSocket that records what the server says (used by the K probe). */
async function openRawSocket(url) {
  const { loadShared, loadYjs } = await import('../lib/deps.mjs');
  const { authzFixture } = await import('../lib/authz-fixture.mjs');
  const { openWireSocket, waitForOpen } = await import('../lib/wire-socket.mjs');
  const shared = await loadShared();
  const Y = await loadYjs();
  const text = [];
  let binaryCount = 0;
  let closed = false;
  // The upgrade is authenticated (`docs/CONTRACTS.md` §17.5), so the probe presents a real
  // session cookie exactly as a browser would.
  const { cookie } = await authzFixture().session();
  const socket = await openWireSocket(url, { cookie });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      binaryCount += 1;
      return;
    }
    try {
      text.push(JSON.parse(event.data));
    } catch {
      text.push({ type: 'unparseable' });
    }
  });
  socket.addEventListener('close', () => {
    closed = true;
  });
  await waitForOpen(socket, { label: 'the K probe socket' });

  return {
    socket,
    shared,
    get closed() {
      return closed;
    },
    get text() {
      return [...text];
    },
    /** How many BINARY frames the server sent back (evidence that frames were accepted). */
    get binaryCount() {
      return binaryCount;
    },
    sendJoin(documentId) {
      socket.send(
        JSON.stringify(
          shared.createEnvelope(shared.WS_MESSAGE_TYPES.joinRoom, {
            documentId,
            protocolVersion: shared.PROTOCOL_VERSION,
            mode: 'readwrite',
          }),
        ),
      );
    },
    /** Encode one small, valid SYNC frame (a `SyncStep1` for an empty document). */
    encodeSyncStep1() {
      const empty = new Y.Doc();
      return shared.encodeSyncStep1(empty);
    },
    sendFrame(frame) {
      socket.send(frame);
    },
    async waitFor(type, { timeoutMs = 15_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = text.find((message) => message?.type === type);
        if (found !== undefined) return found;
        await sleep(25);
      }
      throw new Error(
        `raw socket never received "${type}" (saw: ${text.map((m) => m?.type ?? '?').join(', ') || 'nothing'})`,
      );
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export function register(runner) {
  /* ================================================================== *
   * A — the room is emptied, then a brand-new device recovers the document
   * ================================================================== */
  runner.scenario(
    'm2/A-room-emptied-then-recovered',
    'a document survives its room being emptied, and a brand-new device recovers it',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-a');
      const documentId = 'a6-m2-room-emptied';
      const text = marker('ROOM-EMPTIED');

      const writer = await ctx.newAppPage({ documentId });
      await connectAndType(ctx, writer, text);

      // The writer's editor showing the text is NOT persistence evidence. The durable
      // row is.
      const row = await waitForDurableDocument(
        dataPath,
        documentId,
        (candidate) => candidate !== null && candidate.updateRows >= 1,
        { label: 'the first append for the document' },
      );
      ctx.note('durable row after writing', row);

      const before = await durableText(dataPath, documentId);
      ctx.note('server-side text reconstructed from the store', JSON.stringify(before.text));
      assertIncludes(before.text, text, 'the written text must be in the durable store');

      // The writer leaves. No peer remains, so the in-memory room is released; the
      // durable document must not be.
      await writer.close();
      ctx.note('writer page closed', true);
      await sleep(500);

      const afterLeaving = await inspectDurableStore(dataPath);
      ctx.note('durable store after the room emptied', afterLeaving);
      assert(
        afterLeaving.documents.some((document) => document.documentId === documentId),
        'eviction must not delete the durable document (docs/ARCHITECTURE.md §7.9)',
      );

      // A device that has never seen this document: no IndexedDB replica to fall back on.
      await ctx.withFreshBrowser(async (fresh) => {
        const reader = await ctx.newAppPage({ documentId, target: fresh });
        const seen = await waitForEditorText(reader, (value) => value.includes(text), {
          timeoutMs: 40_000,
          label: 'a brand-new device to hydrate the stored document',
        });
        ctx.note('brand-new device text', JSON.stringify(seen.text));
        assertIncludes(seen.text, text, 'a brand-new device must recover the stored content');
        const summary = await qaSummary(reader);
        ctx.note('brand-new device transport', {
          sockets: summary.sockets,
          collaborationSockets: summary.liveDocumentSockets,
        });
      });
    },
  );

  /* ================================================================== *
   * B — a real process restart
   * ================================================================== */
  runner.scenario(
    'm2/B-real-process-restart',
    'a document survives a hard process kill and a new server process on the same data directory',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-b');
      const documentId = 'a6-m2-restart';
      const text = marker('SURVIVES-RESTART');

      const writer = await ctx.newAppPage({ documentId });
      await connectAndType(ctx, writer, text);
      await waitForDurableDocument(
        dataPath,
        documentId,
        (candidate) => candidate !== null && candidate.updateRows >= 1,
        { label: 'the append to be committed before the kill' },
      );

      const pidBefore = ctx.stack.serverPid;
      await ctx.stack.crashServer();
      ctx.note('server killed', { pidBefore, running: ctx.stack.serverRunning });
      assertEqual(ctx.stack.serverRunning, false, 'the server process must be gone before restarting');

      // Authoritative post-crash read: no server involved, only the bytes on disk.
      const postCrash = await durableText(dataPath, documentId);
      ctx.note('post-crash durable text', JSON.stringify(postCrash.text));
      assertIncludes(
        postCrash.text,
        text,
        'a committed update must survive a hard process kill (CONTRACTS §14.2)',
      );

      await ctx.stack.startServer();
      const pidAfter = ctx.stack.serverPid;
      ctx.note('new server process', { pidAfter });
      assert(pidAfter !== null && pidAfter !== pidBefore, 'this must be a different process, not a reconnect');

      const afterRestart = await inspectDocument(dataPath, documentId);
      ctx.note('durable row after restart', afterRestart);
      assert(afterRestart !== null, 'the new process must see the stored document');

      await ctx.withFreshBrowser(async (fresh) => {
        const reader = await ctx.newAppPage({ documentId, target: fresh });
        const seen = await waitForEditorText(reader, (value) => value.includes(text), {
          timeoutMs: 40_000,
          label: 'a brand-new device to read the restarted store',
        });
        ctx.note('brand-new device text after restart', JSON.stringify(seen.text));
        assertIncludes(seen.text, text, 'a new device must read the document after a process restart');
      });
    },
  );

  /* ================================================================== *
   * C — offline client + real restart + reconnect reconciliation
   * ================================================================== */
  runner.scenario(
    'm2/C-offline-client-survives-restart',
    'an offline client reconnects after a server restart and both sides converge',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-c');
      const documentId = 'a6-m2-offline-restart';
      const online = marker('ONLINE-C');
      const offline = marker('OFFLINE-C');

      const writer = await ctx.newAppPage({ documentId });
      await connectAndType(ctx, writer, online);
      await waitForDurableDocument(
        dataPath,
        documentId,
        (candidate) => candidate !== null && candidate.updateRows >= 1,
        { label: 'the online edit to be committed' },
      );

      // The client loses the network but keeps editing (R10).
      await setOffline(writer, true);
      await waitForConnectionStatus(writer, ['reconnecting', 'offline', 'error'], {
        timeoutMs: 20_000,
      });
      ctx.note('client offline', await readConnectionStatus(writer));
      await typeInEditor(writer, offline);
      await waitForEditorText(writer, (value) => value.includes(offline), {
        timeoutMs: 20_000,
        label: 'the offline edit in the editor',
      });

      const beforeRestart = await durableText(dataPath, documentId);
      ctx.note('durable text while the client is offline', JSON.stringify(beforeRestart.text));
      assertIncludes(beforeRestart.text, online, 'the pre-outage edit must be durable');
      assert(
        !beforeRestart.text.includes(offline),
        'an offline edit must NOT be in the store before the client reconnects',
      );

      const { before: pidBefore, after: pidAfter } = await ctx.stack.restartServer();
      ctx.note('restart', { pidBefore, pidAfter });
      assert(pidAfter !== pidBefore, 'this must be a real process restart');

      // ## M2 Phase 2: the session has to be renewed, and that is a documented limitation
      //
      // Sessions are **process-scoped** (`docs/CONTRACTS.md` §17.2), so the restart above
      // destroyed this page's cookie, and the client has no 401-driven re-bootstrap. Without a
      // valid session the reconnect can never be admitted, so this scenario would end up
      // measuring session recovery instead of durability.
      //
      // The harness therefore puts a freshly bootstrapped session into the browser's own cookie
      // store. Everything the scenario claims is still the real path: the real reconnect, the
      // real state-vector handshake and the real durable store. The client-side gap is recorded
      // by `p2/S-session-scope-after-restart` (page never returns to `connected`, zero bootstrap
      // calls) and `p2/5-session-revocation-is-everywhere`; it is reported for A1/A2, and this
      // line becomes unnecessary the day the client re-bootstraps on its own.
      ctx.note(
        'connection status with the invalidated session (before renewal)',
        await readConnectionStatus(writer),
      );
      await ctx.authz.renewBrowserSession(writer);
      ctx.note(
        'session renewed out-of-band',
        'sessions are process-scoped and the client does not re-bootstrap (see p2/S)',
      );

      // Back online: reconnect must reconcile the client's offline state with the
      // server's durable state (state-vector handshake, no special case).
      await setOffline(writer, false);
      const status = await waitForConnectionStatus(writer, 'connected', { timeoutMs: 60_000 });
      ctx.note('client reconnected', status);

      await waitUntil(
        async () => {
          const current = await durableText(dataPath, documentId);
          return current.text.includes(offline) && current.text.includes(online);
        },
        { timeoutMs: 45_000, label: 'the offline edit to be appended after reconnect' },
      );
      const converged = await durableText(dataPath, documentId);
      ctx.note('durable text after reconnect', JSON.stringify(converged.text));
      assertIncludes(converged.text, online, 'the pre-outage edit must still be there');
      assertIncludes(converged.text, offline, 'the offline edit must reach the server after reconnect');

      const editorText = (await editorState(writer)).text;
      assertEqual(
        editorText,
        converged.text,
        `the client and the durable state must converge (${describeDivergence(editorText, converged.text)})`,
      );
      ctx.note('client and server converged', { length: editorText.length });

      await ctx.withFreshBrowser(async (fresh) => {
        const reader = await ctx.newAppPage({ documentId, target: fresh });
        const seen = await waitForEditorText(
          reader,
          (value) => value.includes(online) && value.includes(offline),
          { timeoutMs: 40_000, label: 'a brand-new device to see both edits' },
        );
        ctx.note('brand-new device text', JSON.stringify(seen.text));
        assertIncludes(seen.text, online, 'a new device must see the pre-outage edit');
        assertIncludes(seen.text, offline, 'a new device must see the offline edit');
      });
    },
  );

  /* ================================================================== *
   * E — eviction-time compaction survives a restart
   * ================================================================== */
  runner.scenario(
    'm2/E-compaction-survives-restart',
    'compaction at eviction keeps the rendered text and the CRDT state identical across a restart',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-e');
      const documentId = 'a6-m2-compaction';

      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'oracle/E',
      });
      let beforeCompaction;
      try {
        // Cross the frozen update-count threshold (COMPACTION_UPDATE_THRESHOLD = 200)
        // while a peer stays connected, so the log is NOT folded yet.
        const appends = 260;
        for (let index = 0; index < appends; index += 1) {
          oracle.append(`#${index}\n`);
        }
        const big = await waitForDurableDocument(
          dataPath,
          documentId,
          (candidate) => candidate !== null && candidate.updateRows >= 210,
          { timeoutMs: 60_000, label: 'the update log to cross the compaction threshold' },
        );
        ctx.note('log before eviction', big);

        beforeCompaction = await durableText(dataPath, documentId);
        ctx.note('text before compaction', {
          length: beforeCompaction.text.length,
          updateRows: beforeCompaction.updateRows,
          snapshotSequence: beforeCompaction.snapshotSequence,
          stateUpdateSha: beforeCompaction.stateUpdateSha,
        });
        assertEqual(beforeCompaction.updateRows >= 210, true, 'the log must be un-compacted here');
      } finally {
        // The last peer leaving is what triggers eviction and therefore compaction.
        oracle.close();
      }

      const compacted = await waitUntil(
        async () => {
          const row = await inspectDocument(dataPath, documentId);
          return row !== null && row.updateRows === 0 && row.snapshotSequence > 0 ? row : null;
        },
        { timeoutMs: 45_000, label: 'eviction-time compaction to fold the log into the snapshot' },
      );
      ctx.note('log after eviction-time compaction', compacted);
      assertEqual(compacted.updateRows, 0, 'the consumed log rows must be truncated');
      assert(compacted.snapshotSequence >= 210, 'the snapshot must cover the folded updates');

      const afterCompaction = await durableText(dataPath, documentId);
      ctx.note('text after compaction', {
        length: afterCompaction.text.length,
        snapshotSequence: afterCompaction.snapshotSequence,
        stateUpdateSha: afterCompaction.stateUpdateSha,
      });
      assertEqual(
        afterCompaction.text,
        beforeCompaction.text,
        'compaction must not change the rendered text',
      );

      // Restart, then re-read: the persisted snapshot must reconstruct byte-identical
      // CRDT state (the "Y.Doc double assertion" M2-P0-1 E asks for).
      const { before: pidBefore, after: pidAfter } = await ctx.stack.restartServer();
      ctx.note('restart after compaction', { pidBefore, pidAfter });
      const afterRestart = await durableText(dataPath, documentId);
      ctx.note('text after restart', {
        length: afterRestart.text.length,
        stateUpdateSha: afterRestart.stateUpdateSha,
      });
      assertEqual(
        afterRestart.text,
        beforeCompaction.text,
        'the document must be identical after compaction plus a restart',
      );
      assertEqual(
        afterRestart.stateUpdateSha,
        beforeCompaction.stateUpdateSha,
        'the reconstructed Y.Doc state must be byte-identical across compaction',
      );

      await ctx.withFreshBrowser(async (fresh) => {
        const reader = await ctx.newAppPage({ documentId, target: fresh });
        const seen = await waitForEditorText(
          reader,
          (value) => value.length === beforeCompaction.text.length,
          { timeoutMs: 40_000, label: 'a brand-new device to see the compacted document' },
        );
        ctx.note('brand-new device length', seen.text.length);
        assertEqual(seen.text, beforeCompaction.text, 'a new device must read the compacted document');
      });
    },
  );

  /* ================================================================== *
   * F — persistence failure must be visible and must not claim success
   * ================================================================== */
  runner.scenario(
    'm2/F-persist-failure-is-honest',
    'a failed durable append never looks saved, is never broadcast, and closes with 1011',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-f');
      const documentId = 'a6-m2-persist-fail';
      const committed = marker('COMMITTED-F');
      const doomed = marker('DOOMED-F');

      // A second peer in the room: it must never receive the update that failed to persist.
      const watcher = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'oracle/F',
      });
      const writer = await ctx.newAppPage({ documentId });
      try {
        await connectAndType(ctx, writer, committed);
        await waitForDurableDocument(
          dataPath,
          documentId,
          (candidate) => candidate !== null && candidate.updateRows >= 1,
          { label: 'the baseline edit to be committed' },
        );
        ctx.note('baseline durable text', (await durableText(dataPath, documentId)).text);

        // Real failure injection: hold SQLite's write lock. The server's append blocks
        // for its 5 s busy_timeout and then fails (D-044 path).
        const lock = await acquireWriteLock(dataPath);
        ctx.note('store write lock held', true);
        let closedWith1011 = false;
        try {
          await typeInEditor(writer, doomed);

          const closeCodes = await waitUntil(
            async () => {
              const codes = await writer.evaluate(() => window.__qa.closeCodes());
              const hit = codes.find((entry) => entry.code === 1011);
              return hit ?? null;
            },
            { timeoutMs: 40_000, label: 'the server to close the socket with 1011' },
          );
          closedWith1011 = true;
          ctx.note('close code observed', closeCodes);

          const status = await readConnectionStatus(writer);
          ctx.note('writer connection status at failure', status);
          assert(
            status !== 'connected',
            'a failed persist must not leave the UI claiming a healthy connection',
          );

          const watcherText = watcher.text;
          ctx.note('watcher text at failure', JSON.stringify(watcherText));
          assert(
            !watcherText.includes(doomed),
            'the failed update must not be broadcast to other peers (persist before broadcast)',
          );

          const durableAtFailure = await durableText(dataPath, documentId);
          ctx.note('durable text at failure', JSON.stringify(durableAtFailure.text));
          assert(
            !durableAtFailure.text.includes(doomed),
            'the failed update must not be in the durable store',
          );
          assertIncludes(
            durableAtFailure.text,
            committed,
            'the already-committed update must remain valid (no rollback)',
          );
        } finally {
          // Freeze the state before the client can retry: crash while the lock is held,
          // then release. Otherwise the designed reconnect-retry (D-044 point 4) would
          // legitimately persist the update and make the assertion above unrepeatable.
          await ctx.stack.crashServer();
          lock.release();
        }

        assert(closedWith1011, 'the persistence failure must close the socket with 1011, not 1008');

        // The writer page must go away before the restart: it still holds the update
        // locally and would legitimately re-send it.
        await writer.close();

        const postCrash = await durableText(dataPath, documentId);
        ctx.note('durable text after the crash', JSON.stringify(postCrash.text));
        assert(!postCrash.text.includes(doomed), 'the failed update must never become durable');
        assertIncludes(postCrash.text, committed, 'committed data must survive the failure');

        await ctx.stack.startServer();
        await ctx.withFreshBrowser(async (fresh) => {
          const reader = await ctx.newAppPage({ documentId, target: fresh });
          const seen = await waitForEditorText(reader, (value) => value.includes(committed), {
            timeoutMs: 40_000,
            label: 'a brand-new device to read the committed baseline',
          });
          ctx.note('brand-new device text', JSON.stringify(seen.text));
          assert(!seen.text.includes(doomed), 'a new device must not see the failed update');
          assertIncludes(seen.text, committed, 'a new device must see the committed baseline');
        });
      } finally {
        watcher.close();
      }
    },
  );

  /* ================================================================== *
   * G — document isolation across a restart
   * ================================================================== */
  runner.scenario(
    'm2/G-document-isolation',
    'two documents keep separate durable state that survives a restart and never cross',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-g');
      const docA = 'a6-m2-isolation-a';
      const docB = 'a6-m2-isolation-b';
      const markerA = marker('DOC-A');
      const markerB = marker('DOC-B');

      const pageA = await ctx.newAppPage({ documentId: docA });
      await connectAndType(ctx, pageA, markerA);
      const pageB = await ctx.newAppPage({ documentId: docB });
      await connectAndType(ctx, pageB, markerB);

      await waitForDurableDocument(
        dataPath,
        docA,
        (candidate) => candidate !== null && candidate.updateRows >= 1,
        { label: 'document A to be stored' },
      );
      await waitForDurableDocument(
        dataPath,
        docB,
        (candidate) => candidate !== null && candidate.updateRows >= 1,
        { label: 'document B to be stored' },
      );

      const store = await inspectDurableStore(dataPath);
      ctx.note('durable store contents', store);
      const storedIds = store.documents.map((document) => document.documentId).sort();
      assert(storedIds.includes(docA), 'document A must have its own row');
      assert(storedIds.includes(docB), 'document B must have its own row');

      const textA = (await durableText(dataPath, docA)).text;
      const textB = (await durableText(dataPath, docB)).text;
      ctx.note('durable text A', JSON.stringify(textA));
      ctx.note('durable text B', JSON.stringify(textB));
      assertIncludes(textA, markerA, 'document A must contain its own marker');
      assertIncludes(textB, markerB, 'document B must contain its own marker');
      assert(!textA.includes(markerB), "document A must not contain document B's marker");
      assert(!textB.includes(markerA), "document B must not contain document A's marker");

      const { before: pidBefore, after: pidAfter } = await ctx.stack.restartServer();
      ctx.note('restart', { pidBefore, pidAfter });

      const afterA = (await durableText(dataPath, docA)).text;
      const afterB = (await durableText(dataPath, docB)).text;
      assertEqual(afterA, textA, 'document A must be unchanged by a restart');
      assertEqual(afterB, textB, 'document B must be unchanged by a restart');

      await ctx.withFreshBrowser(async (fresh) => {
        const readerA = await ctx.newAppPage({ documentId: docA, target: fresh });
        const seenA = await waitForEditorText(readerA, (value) => value.includes(markerA), {
          timeoutMs: 40_000,
          label: 'document A in a brand-new device',
        });
        ctx.note('brand-new device, document A', JSON.stringify(seenA.text));
        assertIncludes(seenA.text, markerA, 'document A must be recoverable');
        assert(!seenA.text.includes(markerB), 'document A must not show document B content');
      });

      await ctx.withFreshBrowser(async (fresh) => {
        const readerB = await ctx.newAppPage({ documentId: docB, target: fresh });
        const seenB = await waitForEditorText(readerB, (value) => value.includes(markerB), {
          timeoutMs: 40_000,
          label: 'document B in a brand-new device',
        });
        ctx.note('brand-new device, document B', JSON.stringify(seenB.text));
        assertIncludes(seenB.text, markerB, 'document B must be recoverable');
        assert(!seenB.text.includes(markerA), 'document B must not show document A content');
      });
    },
  );

  /* ================================================================== *
   * J — concurrent cold joins (hydration barrier)
   * ================================================================== */
  runner.scenario(
    'm2/J-concurrent-cold-joins',
    'several brand-new devices joining a cold document at once all see the same hydrated content',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-j');
      const documentId = 'a6-m2-cold-join';
      const text = marker('COLD-JOIN');

      // Seed the document, then leave: the room is released, the durable state remains.
      const seeder = await ctx.newAppPage({ documentId });
      await connectAndType(ctx, seeder, text);
      await waitForDurableDocument(
        dataPath,
        documentId,
        (candidate) => candidate !== null && candidate.updateRows >= 1,
        { label: 'the seed content to be durable' },
      );
      await seeder.close();

      // Make the next joins genuinely cold: no in-memory room exists after a restart.
      const { before: pidBefore, after: pidAfter } = await ctx.stack.restartServer();
      ctx.note('cold restart', { pidBefore, pidAfter });

      const devices = await Promise.all([0, 1, 2].map(() => ctx.launchBrowser()));
      try {
        // Join simultaneously from three different devices, each with an empty profile.
        const pages = await Promise.all(
          devices.map((device) => ctx.newAppPage({ documentId, target: device })),
        );
        const states = await Promise.all(
          pages.map((page) =>
            waitForEditorText(page, (value) => value.includes(text), {
              timeoutMs: 45_000,
              label: 'a concurrent cold join to hydrate',
            }),
          ),
        );
        ctx.note(
          'concurrent joiner texts',
          states.map((state) => ({ length: state.text.length, viewId: state.viewId })),
        );
        for (const [index, state] of states.entries()) {
          assertIncludes(state.text, text, `device ${index} must see the stored content`);
        }
        const distinct = new Set(states.map((state) => state.text));
        assertEqual(
          distinct.size,
          1,
          `every joiner must see identical content (saw ${distinct.size} distinct documents)`,
        );
        assert(
          ![...distinct][0].includes('undefined'),
          'a hydration failure must never be rendered as an empty document',
        );

        // No competing room may have written an empty document over the good one.
        const durableAfter = await durableText(dataPath, documentId);
        ctx.note('durable text after the concurrent joins', JSON.stringify(durableAfter.text));
        assertIncludes(durableAfter.text, text, 'the durable content must be intact');

        const store = await inspectDurableStore(dataPath);
        ctx.note('durable store after the concurrent joins', store);
        const matching = store.documents.filter((document) => document.documentId === documentId);
        assertEqual(matching.length, 1, 'one document row per documentId, never two competing rooms');
      } finally {
        await Promise.all(devices.map((device) => ctx.closeBrowser(device)));
      }
    },
  );

  /* ================================================================== *
   * Observation — a join with no edit writes to the store
   * ================================================================== *
   * Not an acceptance scenario. It asserts only what the contract clearly requires
   * (a join must not manufacture document *content*) and records a deviation it does
   * not bless: the durable log grows by one row per join even when nothing was
   * edited, while `docs/ARCHITECTURE.md` §7.3 says a document is persisted "on first
   * write". Reported as a P3 observation with owner A3, not hidden by a relaxed
   * assertion.
   */
  runner.scenario(
    'm2/observation-join-without-edit',
    'joining a document without editing produces no content, and its durable writes are recorded',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-observe');
      const documentId = 'a6-m2-open-only';

      const first = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(first, 'connected', { timeoutMs: 30_000 });
      await sleep(1_500);
      const afterFirstJoin = await inspectDocument(dataPath, documentId);
      ctx.note('durable row after one join with no typing', afterFirstJoin);

      const firstText = await durableText(dataPath, documentId);
      ctx.note('reconstructed text after one join', JSON.stringify(firstText.text ?? null));
      assert(
        firstText.found === false || firstText.text === '',
        'a join without editing must not create document content',
      );

      const second = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(second, 'connected', { timeoutMs: 30_000 });
      await sleep(1_500);
      const afterSecondJoin = await inspectDocument(dataPath, documentId);
      ctx.note('durable row after a second join with no typing', afterSecondJoin);

      const secondText = await durableText(dataPath, documentId);
      assertEqual(secondText.text, '', 'repeated joins must still produce no content');

      const grew =
        (afterSecondJoin?.updateRows ?? 0) > (afterFirstJoin?.updateRows ?? 0);
      ctx.note(
        'P3 observation',
        grew
          ? 'the durable update log grows by one row per join even with no edit; ' +
            'accepted deviation — see DECISIONS D-055 §3 (ARCHITECTURE §7.3 now says ' +
            '"the first join or write"). Owner: A3.'
          : 'the durable update log did NOT grow on a no-edit join (behaviour changed — revisit this note)',
      );
    },
  );

  /* ================================================================== *
   * K — hydration backlog overflow: constructibility probe
   * ================================================================== *
   * The acceptance criterion allows "未验证 + reason" when the condition cannot be
   * constructed stably. This scenario therefore *tries* to overflow the bounded
   * backlog from the wire and records what actually happens, instead of simulating it.
   */
  runner.scenario(
    'm2/K-backlog-overflow-constructibility',
    'attempt to overflow the hydration backlog from the wire and record whether it is reachable',
    async (ctx) => {
      const dataPath = await freshStore(ctx, 'm2-k');
      const documentId = 'a6-m2-backlog';

      // A large update log makes hydration expensive, widening the only window in which a
      // BINARY frame could land while the room is HYDRATING.
      const oracle = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'oracle/K',
      });
      try {
        const appends = 6_000;
        for (let index = 0; index < appends; index += 1) oracle.append(`line ${index}\n`);
        const row = await waitForDurableDocument(
          dataPath,
          documentId,
          (candidate) => candidate !== null && candidate.updateRows >= appends,
          { timeoutMs: 120_000, label: `a ${appends}-row update log` },
        );
        ctx.note('log built for the probe', row);
      } finally {
        oracle.close();
      }

      // Crash (no eviction, no compaction) and restart so the next join must hydrate the
      // whole log.
      const { before: pidBefore, after: pidAfter } = await ctx.stack.restartServer();
      ctx.note('restart to force a cold hydrate of the whole log', { pidBefore, pidAfter });

      const raw = await openRawSocket(ctx.stack.wsUrl);
      try {
        const startedAt = Date.now();
        raw.sendJoin(documentId);
        // One small, individually valid SYNC frame, sent many times in a single
        // synchronous burst — before any reply can be processed. If the room is still
        // HYDRATING, these are the frames the bounded backlog would have to hold.
        const frame = raw.encodeSyncStep1();
        const burst = 400;
        for (let index = 0; index < burst; index += 1) raw.sendFrame(frame);
        ctx.note('frames sent before any reply', burst);

        // Whatever the outcome, record it. `room-joined` means hydration finished before
        // the frames could be queued; `error` means the backlog path was reached.
        const outcome = await Promise.race([
          raw.waitFor('room-joined', { timeoutMs: 20_000 }).then((message) => ({
            kind: 'room-joined',
            elapsedMs: Date.now() - startedAt,
            message,
          })),
          raw.waitFor('error', { timeoutMs: 20_000 }).then((message) => ({
            kind: 'error',
            elapsedMs: Date.now() - startedAt,
            message,
          })),
        ]);
        ctx.note('first control reply to the burst', outcome);

        const allText = raw.text.map((message) => message?.type).join(',');
        ctx.note('every control message received', allText);
        // Give the replies a bounded chance to arrive so the count is meaningful,
        // rather than closing the probe socket mid-flight.
        await waitUntil(() => raw.binaryCount >= burst, {
          timeoutMs: 5_000,
          label: 'all burst frames to be answered',
        }).catch(() => {});
        ctx.note('binary frames the server answered', raw.binaryCount);
        assert(
          !JSON.stringify(raw.text).includes('FRAME_TOO_LARGE'),
          'a backlog overflow must never be reported as FRAME_TOO_LARGE (D-050)',
        );
        assert(
          outcome.kind === 'room-joined' || outcome.kind === 'error',
          'the burst must produce a defined outcome',
        );

        // The server must still be alive and serving.
        const health = await fetch(`http://127.0.0.1:${ctx.stack.serverPort}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        ctx.note('server health after the burst', health.status);
        assertEqual(health.status, 200, 'the server must not crash on a frame burst');
        assertEqual(ctx.stack.serverRunning, true, 'the server process must still be running');

        // Whether the overflow path was reached is recorded, not asserted: reaching it
        // depends on whether a BINARY frame can arrive before the hydration barrier
        // releases, which the synchronous SQLite store makes a microtask-wide window.
        ctx.note(
          'backlog overflow reached',
          outcome.kind === 'error' ? 'yes (see the error code above)' : 'no — hydration completed first',
        );
      } finally {
        raw.close();
      }
    },
  );
}
