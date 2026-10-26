/**
 * A production-build stack for the perf harness: the **built** server (`apps/server/dist/index.js`)
 * serving the **built** web client (`apps/web/dist`) on one origin.
 *
 * No Vite: the page, its JS and its API calls all come from the Express process, which is the same
 * static-hosting path a deployment uses (`apps/server/src/static-hosting.ts`). `NODE_ENV` stays
 * unset so the demo bootstrap remains available for the fixture; this is a *local production-build*
 * run, not a claim of production semantics (no Clerk, no TLS, no Render).
 *
 * Exposes the same surface `run.mjs` already uses from `DevStack`: `start`, `appUrl`, `wsUrl`,
 * `serverPort`, `dataPath`, `dispose`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HEALTH_TIMEOUT_MS = 60_000;

export class BuildStack {
  #process = null;
  #repoRoot;
  #serverPort;
  #dataPath;
  #appUrl;

  constructor({ repoRoot, serverPort, dataPath }) {
    this.#repoRoot = repoRoot;
    this.#serverPort = serverPort;
    this.#dataPath = dataPath;
    this.#appUrl = `http://127.0.0.1:${serverPort}/`;
  }

  get appUrl() {
    return this.#appUrl;
  }

  get wsUrl() {
    return `ws://127.0.0.1:${this.#serverPort}/ws`;
  }

  get serverPort() {
    return this.#serverPort;
  }

  get dataPath() {
    return this.#dataPath;
  }

  async start() {
    const entry = path.join(this.#repoRoot, 'apps', 'server', 'dist', 'index.js');
    const staticDir = path.join(this.#repoRoot, 'apps', 'web', 'dist');
    if (!existsSync(entry)) throw new Error(`no built server at ${entry}; run pnpm build first`);
    if (!existsSync(path.join(staticDir, 'index.html'))) {
      throw new Error(`no built web client at ${staticDir}; run pnpm build first`);
    }

    this.#process = spawn(process.execPath, [entry], {
      cwd: this.#repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(this.#serverPort),
        HOST: '127.0.0.1',
        INSIGHTHUB_DATA_PATH: this.#dataPath,
        STATIC_DIR: staticDir,
        CORS_ORIGIN: this.#appUrl.replace(/\/$/, ''),
        LOG_LEVEL: 'error',
      },
    });
    let output = '';
    this.#process.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    this.#process.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });

    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      if (this.#process.exitCode !== null) {
        throw new Error(
          `the built server exited with ${this.#process.exitCode} before /health: ${output.slice(-1500)}`,
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.#serverPort}/health`);
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        throw new Error(`the built server did not answer /health: ${output.slice(-1500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async dispose() {
    const child = this.#process;
    this.#process = null;
    if (child === null || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill();
  }
}
