/**
 * Demo identity gate: logout and switch roles through the real UI.
 *
 * The developer workflow this protects: “退出登录” must leave the shell (no editor/socket) and
 * show the demo sign-in card; choosing a roster identity must reload as **that** identity, not
 * silently fall back to `demo-ada` on the next page bootstrap.
 */
import {
  readEditorGate,
  roleChipText,
  waitForConnectionStatus,
  waitForEditorText,
} from '../lib/app.mjs';
import { assert, assertEqual } from '../lib/harness.mjs';

async function identityText(page) {
  return page.evaluate(
    () =>
      document.querySelector('[data-testid="session-identity"] .identity__name')?.textContent ?? '',
  );
}

async function waitForIdentity(page, needle, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const text = await identityText(page);
    if (text.includes(needle)) return text;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`identity never contained ${needle}; last ${JSON.stringify(text)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function register(runner) {
  runner.scenario(
    'demo/logout-then-sign-in-as-viewer',
    '退出登录 leaves the workbench for the demo sign-in card, then choosing Linus reloads as the viewer identity with a read-only editor',
    async (ctx) => {
      const browserContextId = await ctx.newBrowserContext();
      try {
        const page = await ctx.newAppPage({ as: null, browserContextId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        assert((await identityText(page)).includes('Ada Lovelace'), 'default demo identity is Ada');

        await page.click('[data-testid="demo-identity-menu"] summary');
        await page.click('[data-testid="demo-logout"]');
        await page.waitForSelector('[data-testid="demo-signin"]', { timeoutMs: 20_000 });
        assertEqual(
          await page.evaluate(() => document.querySelector('.cm-editor') === null),
          true,
          'logout must unmount the editor',
        );

        await page.click('[data-testid="demo-login-demo-linus"]');
        await waitForIdentity(page, 'Linus Torvalds');
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        const gate = await readEditorGate(page);
        assertEqual(gate.roleTag, roleChipText('viewer'), 'the role chip must say 只读查看者');
        assertEqual(gate.contentEditable, 'false', 'the viewer content element is not editable');
        ctx.note('logout → Linus', { identity: await identityText(page), gate });
      } finally {
        await ctx.closeBrowserContext(browserContextId);
      }
    },
  );

  runner.scenario(
    'demo/switch-to-editor',
    'the demo identity menu switches to Grace without falling back to Ada, and the editor becomes editable',
    async (ctx) => {
      const browserContextId = await ctx.newBrowserContext();
      try {
        const page = await ctx.newAppPage({ as: null, browserContextId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

        await page.click('[data-testid="demo-identity-menu"] summary');
        await page.click('[data-testid="demo-switch-demo-grace"]');
        await waitForIdentity(page, 'Grace Hopper');
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        const gate = await readEditorGate(page);
        assertEqual(gate.roleTag, roleChipText('editor'), 'the role chip must say 编辑者');
        await page.click('.cm-content');
        await page.insertText('x');
        await waitForEditorText(page, (text) => text.includes('x'), { label: 'the editor write' });
        ctx.note('switch → Grace', { identity: await identityText(page), gate });
      } finally {
        await ctx.closeBrowserContext(browserContextId);
      }
    },
  );
}
