/**
 * Entry point for the A6 real-browser suite (M1 regression + M2 durable persistence).
 *
 * Runs a **real** Chromium/Edge (driven over the DevTools Protocol), a **real**
 * backend process, a **real** Vite dev server, a **real** IndexedDB and — since
 * M2 — a **real** SQLite store on disk that survives a real process crash.
 *
 * Usage (from the repository root):
 *
 * ```bash
 * pnpm build                       # packages/shared must be compiled for the oracle
 * node tests/browser/run.mjs
 * node tests/browser/run.mjs --filter m2/ --headed
 * node tests/browser/run.mjs --list
 * ```
 *
 * Exit code is 0 only when every scenario passed. Nothing is retried, and no
 * scenario substitutes a simulation for the browser.
 *
 * ## Harness preconditions and cleanup
 *
 * The suite refuses to start when its ports are occupied, and after a run it
 * verifies that the ports are released and that no child process survived. Both are
 * reported, because a suite that leaks a server or a browser is not evidence of
 * anything except its own hygiene.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
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
import { DevStack, isPortClosed } from './lib/stack.mjs';

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
  const directory = path.join(repoRoot, 'tests', 'browser', 'suite');
  const entries = await readdir(directory);
  return entries
    .filter((name) => name.endsWith('.mjs'))
    .sort()
    .map((name) => path.join(directory, name));
}

/** Refuse to start when another process owns a port this suite needs. */
async function assertPortsFree(ports) {
  const busy = [];
  for (const port of ports) {
    if (!(await isPortClosed(port))) busy.push(port);
  }
  if (busy.length > 0) {
    throw new Error(
      `port(s) ${busy.join(', ')} already accept connections; the suite must run serially ` +
        'against its own stack. Stop whatever owns them and re-run.',
    );
  }
}

/** Verify the ports were released after the run. */
async function assertPortsReleased(ports) {
  const stillOpen = [];
  for (const port of ports) {
    if (!(await isPortClosed(port))) stillOpen.push(port);
  }
  return stillOpen;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runner = new Runner();
  await mkdir(artifactsDir, { recursive: true });

  const instrumentSource = await loadInstrumentSource();

  const stack = new DevStack({ repoRoot });
  let browser;
  /** Pages this run opened, closed between scenarios. */
  const openPages = [];
  /** Extra browsers launched for "a brand-new device" checks. */
  const extraBrowsers = new Set();

  /**
   * Open the application in a fresh browser tab.
   *
   * `documentId` switches the workspace the same way a user does (focus the field,
   * replace it, press Enter). `target` selects a specific browser instance, which is
   * how a durability scenario proves the content came from the server: a browser with
   * an empty profile has no client-side replica to read from.
   */
  async function newAppPage({ documentId, target } = {}) {
    const page = await openInstrumentedPage({ target });
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
  async function openInstrumentedPage({ target } = {}) {
    const connection = (target ?? browser).connection;
    const page = await newPage(connection);
    openPages.push(page);
    await page.addInitScript(instrumentSource);
    await page.goto(stack.appUrl);
    return page;
  }

  /**
   * Launch an extra browser with an empty profile, tracked for cleanup.
   *
   * A durability scenario needs several *devices* at once (concurrent cold joins), so
   * this is exposed separately from `withFreshBrowser`.
   */
  async function launchBrowser() {
    const fresh = await Browser.launch({ headed: options.headed });
    extraBrowsers.add(fresh);
    return fresh;
  }

  async function closeBrowser(fresh) {
    if (fresh === undefined || fresh === null) return;
    extraBrowsers.delete(fresh);
    await fresh.close().catch(() => {});
  }

  /**
   * Run `fn` against a **brand-new browser with an empty profile**, then close it.
   *
   * This is the harness's definition of "a new device": no IndexedDB replica, no
   * session storage from the writer. Without it, a reload would be answered by the
   * client's own local replica and the test would silently be measuring IndexedDB
   * instead of server durability.
   */
  async function withFreshBrowser(fn) {
    const fresh = await launchBrowser();
    try {
      return await fn(fresh);
    } finally {
      await closeBrowser(fresh);
    }
  }

  const context = {
    get browser() {
      return browser;
    },
    stack,
    artifactsDir,
    newAppPage,
    openInstrumentedPage,
    withFreshBrowser,
    launchBrowser,
    closeBrowser,
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

  const requiredPorts = [stack.webPort, stack.serverPort];
  const environment = {
    browser: undefined,
    headed: options.headed,
    platform: `${os.platform()} ${os.release()} (${process.arch})`,
    node: process.version,
    appUrl: stack.appUrl,
    backendUrl: `http://127.0.0.1:${stack.serverPort}`,
    durableStore:
      'per-run temporary directory passed as INSIGHTHUB_DATA_PATH; a scenario that needs a ' +
      'clean store restarts the server on a new directory, and a restart scenario reuses the ' +
      'same directory. Removed on exit; the development default is never touched.',
  };

  let exitCode = 0;
  let cleanup = null;
  try {
    console.log('');
    console.log('preflight: ports must be free (the suite runs serially)');
    await assertPortsFree(requiredPorts);
    console.log(`  ${requiredPorts.join(', ')} free`);

    console.log('starting the dev stack…');
    await stack.start();
    console.log(`  web ${stack.appUrl}`);
    console.log(`  backend http://127.0.0.1:${stack.serverPort}`);
    console.log(`  durable store ${stack.dataPath}`);
    environment.dataPath = stack.dataPath;

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
        // A scenario is allowed to crash the backend to prove restart recovery; it must
        // never leave it down for the next scenario.
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
      for (const extra of [...extraBrowsers]) {
        await extra.close().catch(() => {});
      }
      extraBrowsers.clear();
      const removed = await stack.dispose().catch(() => []);
      await browser?.close().catch(() => {});
      // Postflight: the run must not leave the environment behind.
      const stillOpen = await assertPortsReleased(requiredPorts);
      cleanup = { portsStillOpen: stillOpen, removedDataPaths: removed ?? [] };
      console.log('');
      console.log('postflight:');
      console.log(
        `  ports ${requiredPorts.join(', ')}: ${stillOpen.length === 0 ? 'released' : `STILL OPEN ${stillOpen.join(', ')}`}`,
      );
      console.log(`  temporary data directories removed: ${(removed ?? []).length}`);
      if (stillOpen.length > 0 && exitCode === 0) exitCode = 2;
    }
  }

  if (cleanup !== null) {
    // Fold the cleanup record into the machine-readable report when one exists.
    try {
      const reportPath = path.join(artifactsDir, 'results.json');
      const { readFile } = await import('node:fs/promises');
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      report.cleanup = cleanup;
      await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    } catch {
      /* the report may not exist when the run failed before writing it */
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
