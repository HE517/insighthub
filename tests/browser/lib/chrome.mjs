/**
 * Launch and stop a **real** browser (Chrome or Edge) for the A6 suite.
 *
 * Recorded browser facts for the report come from `CdpConnection.send(
 * 'Browser.getVersion')`, so the version string in the report is read from the
 * browser itself rather than hard-coded here.
 *
 * ## Why the child's output goes to a file descriptor, not a pipe
 *
 * A `stdio: 'pipe'` child keeps a libuv handle open in this process for as long as the write
 * end exists, and Chromium's own children inherit it. `Browser.close` ends the browser process,
 * but the pipe stayed readable until every inherited copy was gone — which is how the runner
 * printed its summary and postflight and then never exited (measured: two live `PipeWrap`
 * handles after every browser had been closed). Opening one log file in the throwaway profile
 * and passing its descriptor keeps the launch diagnostics while holding **no** handle here: an
 * orphaned browser process can no longer keep the suite alive.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
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
  #logPath;
  #logFd = null;

  constructor({ process, connection, userDataDir, version, executablePath, headed, logPath }) {
    this.#process = process;
    this.#connection = connection;
    this.#userDataDir = userDataDir;
    this.#version = version;
    this.executablePath = executablePath;
    this.headed = headed;
    this.#logPath = logPath;
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

    /**
     * One log file inside the throwaway profile, shared by the child's stdout and stderr.
     *
     * A file descriptor cannot keep this process's event loop alive; a pipe can (see the file
     * header). The profile directory is removed on `close()`, so the log is thrown away with it.
     */
    const logPath = path.join(userDataDir, 'chrome-output.log');
    const logFd = openSync(logPath, 'a');
    const child = spawn(binary, args, { stdio: ['ignore', logFd, logFd] });
    closeSync(logFd);
    /** Chromium's own output, kept for the "it did not start" diagnostic. */
    const browserLog = () => {
      try {
        return readFileSync(logPath, 'utf8').slice(-8_000);
      } catch {
        return '';
      }
    };

    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    let port;
    while (Date.now() < deadline) {
      // Chrome writes `DevToolsActivePort` with an exclusive-ish share mode, so a read
      // that races the write fails with EBUSY/EPERM on Windows. That is "not ready
      // yet", not a failure: retry instead of propagating a transient OS error out of
      // the launch (which would fail a scenario for a harness reason).
      if (existsSync(portFile)) {
        try {
          const contents = readFileSync(portFile, 'utf8').split('\n');
          const parsed = Number.parseInt(contents[0] ?? '', 10);
          if (Number.isInteger(parsed) && parsed > 0) {
            port = parsed;
            break;
          }
        } catch {
          /* the browser is mid-write; try again on the next tick */
        }
      }
      if (child.exitCode !== null) {
        throw new Error(`the browser exited immediately (code ${child.exitCode}): ${browserLog()}`);
      }
      await sleep(150);
    }
    if (port === undefined) {
      child.kill();
      throw new Error(`the browser did not open a debugging port within ${timeoutMs}ms: ${browserLog()}`);
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
      logPath,
    });
  }

  /**
   * Stop the browser and prove the process is gone.
   *
   * `Browser.close` is the graceful path and is what actually ends Chromium's helper
   * processes; the `taskkill /T /F` fallback (Windows) is only for the case where that did not
   * happen in time, because a survivor is a real leak. The returned record is reported by
   * `run.mjs`'s postflight.
   */
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
    let killed = false;
    if (timedOut) {
      killed = true;
      // Windows has no process-group signal from Node, so the whole tree has to be named.
      if (process.platform === 'win32' && this.#process.pid !== undefined) {
        await new Promise((resolve) => {
          const killer = spawn(
            'taskkill',
            ['/PID', String(this.#process.pid), '/T', '/F'],
            { stdio: 'ignore' },
          );
          killer.once('exit', resolve);
          killer.once('error', resolve);
        });
      }
      try {
        this.#process.kill();
      } catch {
        /* already gone */
      }
    }

    let profileRemoved = false;
    if (removeProfile) {
      try {
        await rm(this.#userDataDir, { recursive: true, force: true });
        profileRemoved = true;
      } catch {
        /* a leaked temp dir must not fail the run; the postflight counts what was removed */
      }
    }
    return {
      pid: this.#process.pid ?? null,
      exitedCleanly: !killed,
      killed,
      profileRemoved,
    };
  }
}
