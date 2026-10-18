/**
 * Smoke: the harness itself is honest.
 *
 * Before a single contract assertion is worth anything, these must be true:
 * a real browser is running, the real backend is up, the app opened a session, a
 * real `EditorView` exists and can be reached through the page's own module
 * registry, and a keyboard input reaches `Y.Text`. If this scenario fails, every
 * other result is meaningless — which is why it runs first.
 */
import {
  editorState,
  readCollaborators,
  readConnectionStatus,
  readIndexedDb,
  setPolicy,
  qaSummary,
  waitForConnectionStatus,
} from '../lib/app.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';

export function register(runner) {
  runner.scenario(
    'smoke/harness',
    'real browser + real backend + real EditorView are reachable, and typing reaches Y.Text',
    async (ctx) => {
      const page = await ctx.newAppPage();

      const product = ctx.browser.version.product;
      ctx.note('browser', `${product} (${ctx.browser.version.userAgent})`);
      ctx.note('headed', ctx.browser.headed);
      ctx.note('app url', ctx.stack.appUrl);
      ctx.note('backend', `http://127.0.0.1:${ctx.stack.serverPort}`);

      assert(product.length > 0, 'the browser did not report a product string');

      const status = await readConnectionStatus(page);
      // The badge starts at `connecting` and reaches `connected` when `room-joined`
      // arrives; `newAppPage` only guarantees a usable session, not a finished
      // handshake, so wait for the handshake rather than racing it.
      assert(
        status !== null,
        'the connection badge must be rendered for an active session',
      );
      const connected = await waitForConnectionStatus(page, 'connected', { timeoutMs: 25_000 });
      ctx.note('connection status', connected);

      const before = await editorState(page);
      assert(before.viewId > 0, 'the editor probe could not resolve a real EditorView');
      ctx.note('EditorView id', before.viewId);
      ctx.note('Y.Text length on open', before.length);

      // A real keystroke, through the real input stack, must land in Y.Text.
      const marker = 'smoke-ok';
      await page.click('.cm-content');
      await page.insertText(marker);

      const deadline = Date.now() + 10_000;
      let after = before;
      while (Date.now() < deadline) {
        after = await editorState(page);
        if (after.text.includes(marker)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertIncludes(after.text, marker, 'editor text after typing');
      ctx.note('Y.Text length after typing', after.length);
      ctx.note('EditorView id after typing', after.viewId);
      assertEqual(
        after.viewId,
        before.viewId,
        'typing must not construct a second EditorView (object identity)',
      );

      const identity = await page.evaluate(() => ({
        userAgentPlatform: navigator.userAgent,
        hasIndexedDb: typeof indexedDB !== 'undefined',
        hasWebSocket: typeof WebSocket !== 'undefined',
        editorProbeModule: window.__qa?.probe?.moduleUrl ?? null,
      }));
      ctx.note('page capabilities', identity);
      assert(identity.hasIndexedDb, 'the page has no IndexedDB');
      assert(identity.hasWebSocket, 'the page has no WebSocket');
      assertIncludes(
        identity.editorProbeModule ?? '',
        'codemirror',
        'editor probe resolved module URL',
      );

      // The instrumentation must be observing the real replica.
      const idb = await readIndexedDb(page);
      ctx.note(
        'IndexedDB databases',
        idb.databases.map((database) => ({
          name: database.name,
          version: database.version,
          stores: database.stores.map((store) => ({ name: store.name, count: store.count })),
        })),
      );

      const collaborators = await readCollaborators(page);
      ctx.note('collaborators', collaborators);

      const summary = await qaSummary(page);
      ctx.note('instrumentation summary', summary);
      assert(summary.sockets >= 1, 'the instrumentation saw no WebSocket at all');
      assert(summary.editorMounts >= 1, 'the editor mount counter saw no .cm-editor node');

      // Prove the chaos layer can be armed (it is used by later scenarios).
      const policy = await setPolicy(page, 'demo-document', { duplicateIncoming: 0 });
      ctx.note('policy armed', policy);
    },
  );
}
