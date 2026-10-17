/**
 * Launch and stop a **real** browser (Chrome or Edge) for the A6 suite.
 *
 * Recorded browser facts for the report come from `CdpConnection.send(
 * 'Browser.getVersion')`, so the version string in the report is read from the
 * browser itself rather than hard-coded here.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CdpConnection, sleep } from './cdp.mjs';

/** Candidate browser executables, in preference order. */
const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

export function findBrowser(explicit) {
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) throw new Error(`no browser at ${explicit}`);
    return explicit;
  }
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate !== '' && existsSync(candidate)) return candidate;
  }
  throw new Error(
    'no Chrome or Edge found; set INSIGHTHUB_BROWSER to the executable path to run the browser suite',
  );
}

/**
 * A running browser with a throwaway profile.
 *
 * `headless` defaults to true; pass `--headed` to `run.mjs` to watch it.
 */
export class Browser {
  #process;
  #connection;
  #userDataDir;
  #version;

  constructor({ process, connection, userDataDir, version, executablePath, headed }) {
    this.#process = process;
    this.#connection = connection;
    this.#userDataDir = userDataDir;
    this.#version = version;
    this.executablePath = executablePath;
    this.headed = headed;
  }

  get connection() {
    return this.#connection;
  }

  /** `{ browser, protocolVersion, userAgent, jsVersion, v8Version }` from the browser. */
  get version() {
    return this.#version;
  }

  static async launch({ executablePath, headed = false, timeoutMs = 30_000 } = {}) {
    const binary = findBrowser(executablePath);
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'insighthub-a6-chrome-'));

    const args = [
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-default-apps',
      '--metrics-recording-only',
      // Deterministic window so screenshot geometry and hit-testing are stable.
      '--window-size=1440,900',
      '--hide-scrollbars',
      'about:blank',
    ];
    if (headed) {
      args.unshift('--new-window');
    } else {
      args.unshift('--headless=new');
    }

    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    let port;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        const contents = readFileSync(portFile, 'utf8').split('\n');
        const parsed = Number.parseInt(contents[0] ?? '', 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          port = parsed;
          break;
        }
      }
      if (child.exitCode !== null) {
        throw new Error(`the browser exited immediately (code ${child.exitCode}): ${stderr}`);
      }
      await sleep(150);
    }
    if (port === undefined) {
      child.kill();
      throw new Error(`the browser did not open a debugging port within ${timeoutMs}ms: ${stderr}`);
    }

    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    const info = await response.json();
    const connection = await CdpConnection.connect(info.webSocketDebuggerUrl);
    const version = await connection.send('Browser.getVersion');

    return new Browser({
      process: child,
      connection,
      userDataDir,
      version,
      executablePath: binary,
      headed,
    });
  }

  async close({ removeProfile = true } = {}) {
    try {
      await this.#connection.send('Browser.close');
    } catch {
      /* the browser may already be shutting down */
    }
    this.#connection.close();

    const exited = new Promise((resolve) => {
      if (this.#process.exitCode !== null) return resolve();
      this.#process.once('exit', resolve);
      return undefined;
    });
    const timedOut = await Promise.race([
      exited.then(() => false),
      sleep(3_000).then(() => true),
    ]);
    if (timedOut) this.#process.kill();
    if (removeProfile) {
      await rm(this.#userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
