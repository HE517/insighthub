/**
 * Lifecycle and leak checks.
 *
 * The unit under test is the whole page: real sessions, real IndexedDB providers,
 * real sockets, real `y-protocols` intervals. The measurements are counts the page
 * exposes through the injected instrumentation — a live-socket count, the live
 * `setInterval` handles, the live `.cm-editor` nodes — not a guess about what the
 * application ought to be doing.
 *
 * `y-protocols`' `Awareness` installs a **3 000 ms** interval, so
 * `liveAwarenessIntervals` is a direct indicator of a leaked awareness instance.
 */
import { editorState, qaSummary, setDocumentId, waitForEditorText } from '../lib/app.mjs';
import { sleep } from '../lib/cdp.mjs';
import { assert, assertEqual } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';

const CYCLES = 20;

export function register(runner) {
  runner.scenario(
    'lifecycle/repeated-open-switch-cycles',
    `${CYCLES} open/switch/disconnect cycles must not grow sockets, timers or editor instances linearly`,
    async (ctx) => {
      const documents = ['a6-cycle-alpha', 'a6-cycle-beta', 'a6-cycle-gamma'];

      // Keep each room alive with a peer, so the switch has real traffic to tear down
      // (an empty room is destroyed in M1, which would hide a socket leak).
      const peers = [];
      for (const documentId of documents) {
        peers.push(await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: documentId }));
      }

      const page = await ctx.newAppPage({ documentId: documents[0] });
      try {
        await waitForEditorText(page, () => true);
        const samples = [];
        const record = async (cycle) => {
          const summary = await qaSummary(page);
          const state = await editorState(page);
          samples.push({ cycle, ...summary, viewId: state.viewId });
          return summary;
        };

        await record(0);
        for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
          const target = documents[cycle % documents.length];
          await setDocumentId(page, target);
          await waitForEditorText(page, () => true);
          // A deliberate disconnect/reconnect in the middle of the loop.
          await page.evaluate(() => window.__qa.setOffline(true));
          await sleep(150);
          await page.evaluate(() => window.__qa.setOffline(false));
          await sleep(250);
          await record(cycle);
        }

        const first = samples[0];
        const mid = samples[Math.floor(CYCLES / 2)];
        const last = samples[samples.length - 1];
        ctx.note(
          'cycle samples',
          samples.map(
            ({
              cycle,
              liveDocumentSockets,
              liveIntervals,
              liveAwarenessIntervals,
              editorLive,
              sockets,
              editorMounts,
            }) => ({
              cycle,
              liveDocumentSockets,
              liveIntervals,
              liveAwarenessIntervals,
              editorLive,
              totalSockets: sockets,
              editorMounts,
            }),
          ),
        );

        // Live resources are what leaks; cumulative totals legitimately grow.
        ctx.note('live resources at cycle 0 / mid / last', {
          liveDocumentSockets: [
            first.liveDocumentSockets,
            mid.liveDocumentSockets,
            last.liveDocumentSockets,
          ],
          liveIntervals: [first.liveIntervals, mid.liveIntervals, last.liveIntervals],
          liveAwarenessIntervals: [
            first.liveAwarenessIntervals,
            mid.liveAwarenessIntervals,
            last.liveAwarenessIntervals,
          ],
          editorLive: [first.editorLive, mid.editorLive, last.editorLive],
        });

        assertEqual(last.editorLive, 1, 'exactly one editor must be alive after the cycles');
        assert(
          last.liveDocumentSockets <= 1,
          `live collaboration sockets grew to ${last.liveDocumentSockets} after ${CYCLES} cycles ` +
            `(cycle 0: ${first.liveDocumentSockets}) — suspect a leaked session`,
        );
        assert(
          last.liveAwarenessIntervals <= 2,
          `live 3 s awareness intervals grew to ${last.liveAwarenessIntervals} after ${CYCLES} cycles ` +
            `— suspect a leaked y-protocols Awareness instance`,
        );
        assert(
          last.liveIntervals <= first.liveIntervals + 2,
          `live interval handles grew from ${first.liveIntervals} to ${last.liveIntervals}`,
        );
      } finally {
        for (const peer of peers) peer.close();
      }
    },
  );

  runner.scenario(
    'lifecycle/page-navigation-destroys-session',
    'navigating away and back leaves no live socket, timer or editor behind',
    async (ctx) => {
      const documentId = 'a6-navigation';
      const peer = await WireOracle.connect({ url: ctx.stack.wsUrl, documentId, label: 'peer' });
      const page = await ctx.newAppPage({ documentId });
      try {
        await waitForEditorText(page, () => true);
        const before = await qaSummary(page);
        ctx.note('before navigation', before);

        // A real full navigation: the old document is torn down by the browser.
        await page.goto('about:blank');
        await sleep(500);

        await page.goto(ctx.stack.appUrl);
        await page.waitForSelector('.cm-editor', { timeoutMs: 30_000 });
        await sleep(1_500);
        const after = await qaSummary(page);
        ctx.note('after returning', after);

        // The instrumentation is per-document, so counters restart — that is exactly
        // what makes "one socket, one editor, one awareness interval" checkable.
        assertEqual(after.editorLive, 1, 'exactly one editor after returning');
        assert(
          after.liveDocumentSockets <= 1,
          `the fresh page holds ${after.liveDocumentSockets} live collaboration sockets, expected 1`,
        );
        assert(
          after.liveAwarenessIntervals <= 1,
          `the fresh page holds ${after.liveAwarenessIntervals} live awareness intervals, expected at most 1`,
        );
      } finally {
        peer.close();
      }
    },
  );
}
