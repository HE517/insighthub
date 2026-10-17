/**
 * Pinned defects.
 *
 * Each scenario here asserts the behaviour the frozen contract **requires**, against
 * the unmodified production path. They are expected to be red while the defect is
 * open, and they stay red on purpose: a pin that passes means the defect is fixed
 * and the pin should be deleted, not that the suite should be relaxed.
 *
 * The scenarios are tagged `knownDefect` so the report can separate them from
 * unexpected regressions. They still fail the run, because the product is still
 * broken.
 */
import { sleep } from '../lib/app.mjs';
import { assert, assertEqual } from '../lib/harness.mjs';

export function register(runner) {
  runner.scenario(
    'defect-pin/P0-1',
    'a browser session must be able to open a document with the UNMODIFIED persistence module',
    async (ctx) => {
      // No workaround here: this runs exactly the code A1 shipped.
      const page = await ctx.openInstrumentedPage({ withWorkaround: false });
      await sleep(2_000);

      // ---- Evidence 1: why the assignment cannot work in a browser ----------
      const descriptor = await page.evaluate(() => {
        let own = Object.getOwnPropertyDescriptor(window, 'indexedDB');
        const fromPrototype = own === undefined;
        if (fromPrototype) {
          let proto = Object.getPrototypeOf(window);
          while (proto !== null && own === undefined) {
            own = Object.getOwnPropertyDescriptor(proto, 'indexedDB');
            proto = Object.getPrototypeOf(proto);
          }
        }
        return {
          ownOnWindow: !fromPrototype,
          configurable: own?.configurable === true,
          hasGetter: typeof own?.get === 'function',
          hasSetter: typeof own?.set === 'function',
          writable: own?.writable === true,
          userAgent: navigator.userAgent,
        };
      });
      ctx.note('window.indexedDB descriptor', descriptor);
      assert(
        descriptor.hasGetter && !descriptor.hasSetter && descriptor.writable !== true,
        'expected window.indexedDB to be a getter-only accessor; the defect analysis must be revisited',
      );

      // ---- Evidence 2: the production factory on the unmodified path --------
      const factory = await page.evaluate(async () => {
        const module = await import('/src/collab/public.ts');
        try {
          const session = await module.createCollaborativeSession({
            documentId: 'defect-pin-document',
            user: { id: 'defect-pin', name: 'Defect Pin' },
          });
          return { ok: true, state: session.state };
        } catch (error) {
          return {
            ok: false,
            name: String(error && error.name),
            message: String(error && error.message),
            stack: String(error && error.stack)
              .split('\n')
              .slice(0, 6)
              .join('\n'),
          };
        }
      });
      ctx.note('createCollaborativeSession', factory);
      if (!factory.ok) {
        ctx.note('thrown', `${factory.name}: ${factory.message}`);
        ctx.note('stack', factory.stack);
      }

      // ---- Evidence 3: what the user actually sees -------------------------
      const ui = await page.evaluate(async () => {
        const databases =
          typeof indexedDB.databases === 'function'
            ? (await indexedDB.databases()).map((entry) => entry.name ?? '')
            : 'unsupported';
        return {
          editorMounted: document.querySelector('.cm-editor') !== null,
          failedBanner:
            document.querySelector('[data-testid="session-failed"]')?.innerText ?? null,
          connectionStatus:
            document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
          indexedDbDatabases: databases,
        };
      });
      ctx.note('rendered UI', ui);

      const sockets = await page.evaluate(() => window.__qa.summary());
      ctx.note('transport reached', { sockets: sockets.sockets, live: sockets.liveSockets });

      // ---- The contract assertions (red until A1 fixes persistence.ts) ------
      assert(
        factory.ok,
        `createCollaborativeSession must resolve in a browser but rejected with ` +
          `${factory.name}: ${factory.message}`,
      );
      assertEqual(ui.editorMounted, true, 'the editor must mount for an active session');
    },
    { knownDefect: 'P0-1' },
  );
}
