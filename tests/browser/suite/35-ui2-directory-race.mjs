/**
 * UI-2 closeout — `AiDirectory` creation race.
 *
 * The directory is a permanent rail, so its list refresh is keyed on the session status. A
 * refresh must abort only the **list** request; a `POST /api/documents` already in flight must
 * survive a same-document reconnect. Otherwise the flow's own abort turns a server success into
 * `ignored`, and the workspace never switches to the document the server created.
 *
 * Both scenarios delay the real POST response at CDP `Fetch` (response stage), change state while
 * it is in flight, then release it:
 *
 * - `ui2/1`: a same-document WS reconnect. Creation must succeed exactly once and switch.
 * - `ui2/2`: the user switches to another document. The late response must not navigate back.
 *
 * The third acceptance (creation failure keeps the current document) is already covered by
 * `b125/2-create-failure-does-not-switch`; it is referenced, not duplicated.
 */
import {
  activeDocumentId,
  editorState,
  readHistoryButtons,
  readUndoState,
  setDocumentId,
  setOffline,
  waitForConnectionStatus,
  waitForSessionActive,
} from '../lib/app.mjs';
import { sleep } from '../lib/cdp.mjs';
import { assert, assertEqual } from '../lib/harness.mjs';

function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function directoryFacts(page) {
  return page.evaluate(() => {
    const directory = document.querySelector('[data-testid="ai-directory"]');
    const items = [...document.querySelectorAll('[data-testid="ai-directory-item"]')];
    return {
      state: directory?.getAttribute('data-state') ?? null,
      ids: items.map((item) => item.getAttribute('data-document-id')),
      currentIds: items
        .filter((item) => item.getAttribute('aria-current') === 'true')
        .map((item) => item.getAttribute('data-document-id')),
      error: document.querySelector('[data-testid="new-document-error"]')?.textContent ?? null,
    };
  });
}

/** Hold the next POST /api/documents response at CDP; return a release function. */
async function holdNextCreation(page) {
  let pausedId = null;
  const off = page.on('Fetch.requestPaused', (event) => {
    if (event.request.method === 'POST' && event.request.url.endsWith('/api/documents')) {
      pausedId = event.requestId;
      return;
    }
    void page.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  });
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/documents', requestStage: 'Response' }],
  });
  const release = async () => {
    for (let attempt = 0; attempt < 200 && pausedId === null; attempt += 1) await sleep(25);
    if (pausedId === null) throw new Error('the POST /api/documents response was never paused');
    try {
      await page.send('Fetch.continueRequest', { requestId: pausedId });
    } catch (error) {
      // The flow aborted the fetch (the user left); the interception is already gone.
      if (!String(error).includes('Invalid InterceptionId')) throw error;
    }
  };
  return { release, stop: async () => { off(); await page.send('Fetch.disable'); } };
}

async function countPost(page, counter) {
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent', (event) => {
    if (event.request.method === 'POST' && event.request.url.endsWith('/api/documents')) {
      counter.count += 1;
    }
  });
}

async function waitForNewDocument(page, previousId, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const current = await activeDocumentId(page);
    if (current !== null && current !== previousId) return current;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`the workspace did not switch away from ${previousId}; current ${String(current)}`);
    }
    await sleep(50);
  }
}

export function register(runner) {
  runner.scenario(
    'ui2/1-create-survives-same-document-reconnect',
    'a POST /api/documents held at CDP while the same document reconnects still creates exactly one document and switches to it; the directory refresh must not abort the creation',
    async (ctx) => {
      const documentId = `a6-ui2-race-${marker('doc')}`;
      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await page.click('[data-testid="ai-open"]');
      await page.waitForSelector('[data-testid="ai-directory"][data-state="ready"]', {
        timeoutMs: 20_000,
      });

      const posts = { count: 0 };
      await countPost(page, posts);
      const hold = await holdNextCreation(page);
      try {
        await page.click('[data-testid="new-document"]');

        // Same document, connection state changes while the POST response is held.
        await setOffline(page, true);
        await sleep(400);
        await setOffline(page, false);
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

        await hold.release();

        const created = await waitForNewDocument(page, documentId);
        await sleep(300);
        const facts = await directoryFacts(page);
        assertEqual(posts.count, 1, 'the reconnect must not send a second POST');
        assertEqual(facts.error, null, 'the creation must not render a failure');
        assert(
          facts.ids.includes(created),
          `the directory must list the created document (${created}); got ${JSON.stringify(facts.ids)}`,
        );
        assertEqual(
          facts.currentIds.length,
          1,
          'exactly one row must be current after the switch',
        );
        assertEqual(facts.currentIds[0], created, 'the current row must be the created document');
        assertEqual(
          await page.evaluate(() => document.querySelectorAll('.cm-editor').length),
          1,
          'the switch must leave exactly one editor',
        );
        ctx.note('creation after same-document reconnect', { documentId, created, posts, facts });
      } finally {
        await hold.stop();
      }
    },
  );

  runner.scenario(
    'ui2/2-late-create-cannot-steal-workspace',
    'if the user switches to another document while POST /api/documents is held, releasing the late success must not navigate back to the created document',
    async (ctx) => {
      const documentA = `a6-ui2-race-a-${marker('doc')}`;
      const documentB = `a6-ui2-race-b-${marker('doc')}`;
      await ctx.authz.grant(documentA, 'demo-ada', 'owner');
      await ctx.authz.grant(documentB, 'demo-ada', 'owner');

      const page = await ctx.newAppPage({ documentId: documentA });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await page.click('[data-testid="ai-open"]');
      await page.waitForSelector('[data-testid="ai-directory"][data-state="ready"]', {
        timeoutMs: 20_000,
      });

      const posts = { count: 0 };
      await countPost(page, posts);
      const hold = await holdNextCreation(page);
      try {
        await page.click('[data-testid="new-document"]');
        await sleep(200);

        // The user leaves A before the creation answer arrives. This unmounts the directory and
        // must abort the flow, so the late answer is `ignored`, not a navigation.
        await setDocumentId(page, documentB);
        await waitForSessionActive(page);
        assertEqual(await activeDocumentId(page), documentB, 'the user must be on B');

        await hold.release();
        await sleep(1_200);
        assertEqual(
          await activeDocumentId(page),
          documentB,
          'the late creation answer must not switch the workspace back',
        );
        assertEqual(posts.count, 1, 'the aborted creation still sent exactly one POST');
        ctx.note('late creation after switching away', { documentA, documentB, posts });
      } finally {
        await hold.stop();
      }
    },
  );

  runner.scenario(
    'ui2/3-editor-surface-survives-assistant-and-resize',
    'opening/closing the AI rail and changing the window width keep one EditorView, the same selection, the same undo availability, and return focus to the assistant opener',
    async (ctx) => {
      const documentId = `a6-ui2-surface-${marker('doc')}`;
      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

      await page.click('.cm-content');
      await page.pressKey('Home', { modifiers: 2 });
      for (let index = 0; index < 5; index += 1) {
        await page.pressKey('ArrowRight', { modifiers: 8 });
      }
      // Collapse the selection so the typed character is a single insert the Undo can remove.
      await page.pressKey('ArrowRight');
      await page.insertText('x');
      await sleep(200);

      const before = await editorState(page);
      const undoBefore = await readUndoState(page);
      const buttonsBefore = await readHistoryButtons(page);

      const viewport = (width, height) =>
        page.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });

      await page.click('[data-testid="ai-open"]');
      await page.waitFor(() => document.querySelector('[data-testid="ai-panel"]') !== null, {
        timeoutMs: 10_000,
        label: 'the AI panel',
      });
      const withAssistant = await editorState(page);
      assertEqual(
        withAssistant.viewId,
        before.viewId,
        'opening the assistant must not remount the editor',
      );
      assertEqual(withAssistant.anchor, before.anchor, 'opening the assistant must keep the anchor');
      assertEqual(withAssistant.head, before.head, 'opening the assistant must keep the head');

      await page.click('[data-testid="ai-close"]');
      await page.waitFor(() => document.querySelector('[data-testid="ai-panel"]') === null, {
        timeoutMs: 10_000,
        label: 'the AI panel to close',
      });
      await sleep(200);
      const focused = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? null,
      );
      assertEqual(focused, 'ai-open', 'closing the assistant must return focus to its opener');

      await viewport(1024, 768);
      await sleep(250);
      await viewport(1440, 900);
      await sleep(250);

      const after = await editorState(page);
      assertEqual(after.viewId, before.viewId, 'resizing must not remount the editor');
      assertEqual(after.anchor, before.anchor, 'resizing must keep the anchor');
      assertEqual(after.head, before.head, 'resizing must keep the head');
      assertEqual(
        await page.evaluate(() => document.querySelectorAll('.cm-editor').length),
        1,
        'there must be exactly one editor after the round trip',
      );
      assertEqual(
        await readUndoState(page),
        undoBefore,
        'resizing must not change undo availability',
      );
      assertEqual(
        (await readHistoryButtons(page)).undo.disabled,
        buttonsBefore.undo.disabled,
        'the undo button state must survive the round trip',
      );

      await page.click('[aria-label="撤销"]');
      const undone = await editorState(page);
      assertEqual(
        undone.text,
        `${before.text.slice(0, before.anchor - 1)}${before.text.slice(before.anchor)}`,
        'Undo must revert the typed character after the round trip',
      );
      ctx.note('surface after assistant + resize', {
        viewId: before.viewId,
        selection: { anchor: before.anchor, head: before.head },
        focused,
      });
    },
  );
}
