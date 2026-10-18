/**
 * Entry point for the M1-A6 real-browser suite.
 *
 * Runs a **real** Chromium/Edge (driven over the DevTools Protocol), a **real**
 * backend, a **real** Vite dev server and a **real** IndexedDB, and asserts the M1
 * collaboration contract against them.
 *
 * Usage (from the repository root):
 *
 * ```bash
 * pnpm build                       # packages/shared must be compiled for the oracle
 * node tests/browser/run.mjs
 * node tests/browser/run.mjs --filter indexeddb
 * node tests/browser/run.mjs --headed
 * node tests/browser/run.mjs --list
 * ```
 *
 * Exit code is 0 only when every scenario passed. Nothing is retried, and no
 * scenario substitutes a simulation for the browser.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  clearEditorTransactions,
  installEditorProbe,
  loadInstrumentSource,
  waitForSessionActive,
} from './lib/app.mjs';
import { newPage } from './lib/cdp.mjs';
import { Browser } from './lib/chrome.mjs';
import { artifactsDir, repoRoot } from './lib/deps.mjs';
import { renderMarkdown, Runner } from './lib/harness.mjs';
import { DevStack } from './lib/stack.mjs';

/** Parse `--flag`, `--key value` and `--key=value`. */
function parseArgs(argv) {
  const options = { filter: undefined, headed: false, list: false, keepOpen: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--headed') options.headed = true;
    else if (argument === '--list') options.list = true;
    else if (argument === '--keep-open') options.keepOpen = true;
    else if (argument === '--filter') options.filter = argv[++index];
    else if (argument.startsWith('--filter=')) options.filter = argument.slice('--filter='.length);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

/**
 * The suite modules, discovered from `suite/` and run in filename order.
 *
 * Discovered rather than hard-coded so adding a scenario file needs no edit here,
 * and so a missing file is impossible (an import that throws would otherwise be
 * mistaken for an environment failure).
 */
async function suiteModules() {
  const { readdir } = await import('node:fs/promises');
  const directory = path.join(repoRoot, 'tests', 'browser', 'suite');
  const entries = await readdir(directory);
  return entries
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => path.join(directory, name));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runner = new Runner();
  await mkdir(artifactsDir, { recursive: true });

  const instrumentSource = await loadInstrumentSource();

  const stack = new DevStack({ repoRoot });
  let browser;
  const openPages = [];

  /**
   * Open the application in a fresh browser tab.
   *
   * `documentId` switches the workspace the same way a user does (focus the field,
   * replace it, press Enter).
   */
  async function newAppPage({ documentId } = {}) {
    const page = await openInstrumentedPage();
    await waitForSessionActive(page);
    await installEditorProbe(page);
    await clearEditorTransactions(page);
    if (documentId !== undefined) {
      const { setDocumentId } = await import('./lib/app.mjs');
      await setDocumentId(page, documentId);
    }
    return page;
  }

  /** Instrumented page on the app URL, without waiting for a usable session. */
  async function openInstrumentedPage() {
    const page = await newPage(browser.connection);
    openPages.push(page);
    await page.addInitScript(instrumentSource);
    await page.goto(stack.appUrl);
    return page;
  }

  const context = {
    get browser() {
      return browser;
    },
    stack,
    artifactsDir,
    newAppPage,
    openInstrumentedPage,
    runner,
  };

  // Import every suite so its scenarios register before the run starts.
  for (const modulePath of await suiteModules()) {
    const module = await import(pathToFileURL(modulePath).href);
    module.register(runner);
  }

  if (options.list) {
    console.log(`scenarios (${runner.scenarioCount}):`);
    for (const line of runner.scenarioIds) console.log(`  ${line}`);
    return 0;
  }

  const environment = {
    browser: undefined,
    headed: options.headed,
    platform: `${os.platform()} ${os.release()} (${process.arch})`,
    node: process.version,
    appUrl: stack.appUrl,
    backendUrl: `http://127.0.0.1:${stack.serverPort}`,
  };

  let exitCode = 0;
  try {
    console.log('');

    console.log('starting the dev stack…');
    await stack.start();
    console.log(`  web ${stack.appUrl}`);
    console.log(`  backend http://127.0.0.1:${stack.serverPort}`);

    console.log('launching the browser…');
    browser = await Browser.launch({ headed: options.headed });
    environment.browser = browser.version.product;
    environment.browserRevision = browser.version.revision;
    environment.userAgent = browser.version.userAgent;
    environment.browserBinary = browser.executablePath;
    console.log(`  ${browser.version.product} (${browser.executablePath})`);

    const results = await runner.run({
      context,
      filter: options.filter,
      onResult: (result) => {
        const icon = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'ERROR';
        const pin = result.knownDefect === null ? '' : ` [pinned ${result.knownDefect}]`;
        console.log(
          `[${icon}]${pin} ${result.id} — ${result.title} (${result.durationMs} ms)` +
            (result.error === null ? '' : `\n         ${result.error.message}`),
        );
      },
      afterEach: async () => {
        // Close every page between scenarios so one scenario's sockets, timers and
        // IndexedDB connections cannot leak into the next.
        for (const page of openPages.splice(0, openPages.length)) {
          await page.close().catch(() => {});
        }
        // A scenario is allowed to stop the backend to create a real outage; it must
        // never leave it stopped for the next scenario.
        await stack.startServer().catch(() => {});
      },
    });

    const summary = runner.summary();
    const markdown = renderMarkdown({ results, environment, summary });
    await writeFile(path.join(artifactsDir, 'results.md'), markdown, 'utf8');
    await writeFile(
      path.join(artifactsDir, 'results.json'),
      JSON.stringify({ environment, summary, results }, null, 2),
      'utf8',
    );

    console.log('');
    console.log(
      `scenarios: ${summary.total} · passed ${summary.pass} · failed ${summary.fail} · errored ${summary.error}`,
    );
    console.log(`report: ${path.join(artifactsDir, 'results.md')}`);
    exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error('');
    console.error('the browser suite could not complete:');
    console.error(error?.stack ?? String(error));
    console.error('');
    console.error('--- backend log (tail) ---');
    console.error(stack.serverLog().split('\n').slice(-40).join('\n'));
    console.error('--- vite log (tail) ---');
    console.error(stack.webLog().split('\n').slice(-40).join('\n'));
    exitCode = 2;
  } finally {
    if (!options.keepOpen) {
      await stack.dispose().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
