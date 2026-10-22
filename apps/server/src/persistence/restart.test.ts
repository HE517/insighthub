/**
 * M2-P0-1 acceptance scenarios **B and C**: recovery across a real process death.
 *
 * ## Why a spawned process, and not a reopened store
 *
 * B and C are about durability, and the only honest test of "this survives the server dying"
 * is to kill the server. Reopening a store inside one process would prove far less: it would
 * share the same module instance, the same OS file cache and the same event loop, and it
 * would leave the original process's handles alive. So each scenario:
 *
 * 1. spawns `apps/server/src/index.ts` as a **separate OS process**;
 * 2. writes through a real WebSocket;
 * 3. kills it abruptly (`child.kill()`, i.e. `TerminateProcess` — no SIGTERM handler, no
 *    graceful `store.close()`, which is the harsher and more interesting failure);
 * 4. reads the database **from this process**, with nothing else holding it open;
 * 5. spawns a second server process on the same data directory and port;
 * 6. asserts through a real client that the document is intact.
 *
 * ## What this depends on
 *
 * A fixed port chosen by the parent, because scenario C reconnects the *same* local replica
 * to the *same* URL: a new port would force a new session and prove nothing about recovery.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import {
  SYNC_MESSAGE_TYPES,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  decodeSyncFrame,
  readSyncMessageType,
  readSyncStep1StateVector,
} from '@insighthub/shared';
import { readSyncMessage } from 'y-protocols/sync';
import * as Y from 'yjs';

import { DEFAULT_DEMO_USER_ID } from '../authz/public.js';
import { bootstrapSessionCookie, TestClient, TestDecoder } from '../rooms/test-harness.js';
import { applyStoredDocument } from './hydrator.js';
import { openDocumentStore } from './open-store.js';

/**
 * Launch arguments for a real server process.
 *
 * `node --import tsx src/index.ts` rather than the `tsx` CLI on purpose: the CLI runs the
 * script in a **grandchild** process, so `child.kill()` would terminate only the wrapper and
 * leave the actual server — port bound, database open — alive. That would make the "process
 * died" half of these scenarios a lie, and would leave stray servers behind.
 */
const SERVER_ARGS = ['--import', 'tsx', 'src/index.ts'];
/**
 * The server package root, used as the child's working directory.
 *
 * Derived from this file's own URL (`apps/server/src/persistence/` — `apps/server`) rather than
 * from where pnpm placed `tsx`: that is a content-addressed store path, and walking up from it
 * lands in `.pnpm`, not in the package.
 */
const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The one demo document the seeded membership fixture grants every role on
 * (apps/server/src/authz/demo-fixture.ts, §17.3). The restart scenarios need a document the
 * authenticated socket is actually allowed to join, and its id is a fixture constant rather than
 * something exported from authz/public.ts.
 */
const DEMO_DOCUMENT_ID = 'demo-document';

/** How long a terminated child may take to be reaped before that is a test failure. */
const TERMINATION_TIMEOUT_MS = 10_000;

const children = new Set<ChildServer>();
const tempRoots: string[] = [];

/**
 * Cleanup that is allowed to **fail**, but never allowed to hang.
 *
 * `pnpm --filter @insighthub/server test` is a Definition-of-Done gate (`AGENTS.md` §5), and a
 * gate that never returns cannot distinguish "passed" from "stuck" (`docs/TASKS.md`
 * TOOLING-P2). So every step here is bounded, every failure is collected, and the hook ends by
 * failing loudly with the diagnostics instead of awaiting a process that may never die.
 */
after(async () => {
  const problems: string[] = [];

  for (const child of [...children]) {
    try {
      await child.stop();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const root of tempRoots) {
    // A surviving child still holds its database open, and Windows refuses to remove a locked
    // file — so a failed cleanup here is evidence of a leaked process, not just of a dirty
    // temp directory.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      problems.push(
        `could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  assert.deepEqual(
    problems,
    [],
    `server processes could not be cleaned up:\n${problems.join('\n')}`,
  );
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'insighthub-restart-'));
  tempRoots.push(root);
  return root;
}

/** Reserve a free TCP port, then release it so the child can bind the same number. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not reserve a port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** A spawned server process, with its readiness and its exit observed. */
class ChildServer {
  readonly port: number;
  readonly url: string;
  /** Base HTTP URL, for the session bootstrap this process's sockets need. */
  readonly httpUrl: string;
  readonly #child: ChildProcessByStdio<null, Readable, Readable>;
  readonly #exitPromise: Promise<void>;
  #exited = false;
  #exitCode: number | null = null;
  /** Released on exit so a later `kill()` cannot destroy pipes a test is still reading. */
  #released = false;
  readonly stdout = '';
  readonly stderr = '';

  private constructor(child: ChildProcessByStdio<null, Readable, Readable>, port: number) {
    this.#child = child;
    this.port = port;
    this.url = `ws://127.0.0.1:${port}/ws`;
    this.httpUrl = `http://127.0.0.1:${port}`;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      (this as { stdout: string }).stdout = stdout;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      (this as { stderr: string }).stderr = stderr;
    });
    this.#exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code) => {
        this.#exited = true;
        this.#exitCode = code;
        resolve();
      });
    });
    // A child handle counts as a live handle for this process. Without `unref`, a child that
    // somehow survives teardown keeps the test *process* alive, and `node:test` waits for the
    // event loop to drain before exiting — which is exactly the "gate never returns" shape this
    // file must not have. Output streaming is unaffected: `unref` only changes the ref count.
    child.unref();
  }

  static async start(port: number, dataPath: string): Promise<ChildServer> {
    const child = spawn(process.execPath, SERVER_ARGS, {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        INSIGHTHUB_DATA_PATH: dataPath,
        // Keep the child's output parseable: no colour, no npm noise.
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const server = new ChildServer(child, port);
    children.add(server);
    await server.#waitForReady();
    return server;
  }

  /** Spawn helper for the negative case: expect the process to refuse to start. */
  static spawnExpectingFailure(port: number, dataPath: string): ChildServer {
    const child = spawn(process.execPath, SERVER_ARGS, {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        INSIGHTHUB_DATA_PATH: dataPath,
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const server = new ChildServer(child, port);
    children.add(server);
    return server;
  }

  /** Everything an operator needs to see when this child misbehaved. */
  #diagnostics(): string {
    return `\npid: ${String(this.#child.pid)}\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`;
  }

  async #waitForReady(timeoutMs = 30_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`server process did not become ready in ${timeoutMs}ms${this.#diagnostics()}`),
        );
      }, timeoutMs);

      const check = (): void => {
        // M4 B9 startup logs are structured; the listener event is the readiness signal.
        if (this.stdout.includes('"event":"server.listening"')) {
          clearTimeout(timer);
          resolve();
        }
      };
      this.#child.stdout.on('data', check);
      void this.#exitPromise.then(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `server process exited with code ${String(this.#exitCode)} before becoming ready${this.#diagnostics()}`,
          ),
        );
      });
      check();
    });
  }

  /**
   * Terminate the child and **everything it spawned**, then confirm it is gone.
   *
   * ## Why a single-PID kill is not enough on Windows
   *
   * The child is `node --import tsx src/index.ts`. `child.kill()` on Windows ends up in
   * `TerminateProcess` for **that PID only**: if anything in the tree outlives it (a helper
   * process, a re-spawned wrapper), the server keeps its port and its SQLite handle, and this
   * file's `after` hook would wait for an exit that never comes. `taskkill /T` walks the tree and
   * `/F` forces it, which is the difference between "flaky" and "deterministic" here.
   */
  async #terminateTree(): Promise<void> {
    const pid = this.#child.pid;
    if (pid === undefined) return;

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('exit', () => resolve());
        // `taskkill` missing is not fatal: the direct kill below is the fallback.
        killer.once('error', () => resolve());
        // Deliberately **not** unref'd: this await is the only thing keeping the loop alive while
        // `taskkill` runs, and an unref'd handle would let the loop drain mid-await — which
        // `node:test` reports as "promise resolution is still pending but the event loop has
        // already resolved".
      });
    }

    try {
      this.#child.kill('SIGKILL');
    } catch {
      // Already gone; `#awaitExit` is what decides whether it really is.
    }
  }

  /** Resolve `true` when the child has exited, `false` when the bounded wait ran out. */
  async #awaitExit(timeoutMs: number): Promise<boolean> {
    if (this.#exited) return true;
    return await new Promise<boolean>((resolve) => {
      // This timer is ref'd on purpose. The child handle is unref'd (see the constructor), so
      // without a ref'd timer a bounded wait would be cancelled the moment the loop had nothing
      // else to do — turning "wait up to 10 s for the exit" into "give up immediately".
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.#exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Release our ends of the stdio pipes and forget the child.
   *
   * Destroying the pipes matters on the failure path: they are handles this process owns, and
   * leaving them open would keep the event loop non-empty even after the test has already
   * failed — trading a loud failure for a silent hang.
   */
  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    this.#child.removeAllListeners();
    children.delete(this);
  }

  /** Kill the process without any chance to shut down gracefully — a real crash. */
  async kill(): Promise<void> {
    if (this.#exited) {
      this.#release();
      return;
    }

    await this.#terminateTree();
    const exited = await this.#awaitExit(TERMINATION_TIMEOUT_MS);
    this.#release();

    if (!exited) {
      // Never continue silently: a child that outlived termination keeps a port bound and a
      // database locked, so the next scenario would fail for a reason that has nothing to do
      // with the code under test.
      throw new Error(
        `server process did not exit within ${TERMINATION_TIMEOUT_MS}ms of termination${this.#diagnostics()}`,
      );
    }
  }

  /** Wait for the process to exit on its own, returning its code. */
  async waitForExit(timeoutMs = 30_000): Promise<number | null> {
    const exited = await this.#awaitExit(timeoutMs);
    if (!exited) {
      // The caller asserts an *exit*, so failing to get one must be that assertion failing with
      // the child's own output attached — not a hang, and not a silent `null`.
      await this.#terminateTree();
      await this.#awaitExit(TERMINATION_TIMEOUT_MS);
      this.#release();
      throw new Error(
        `server process did not exit within ${timeoutMs}ms (it was still running, so it was terminated)${this.#diagnostics()}`,
      );
    }
    const code = this.#exitCode;
    this.#release();
    return code;
  }

  async stop(): Promise<void> {
    await this.kill();
  }
}

/* ------------------------------------------------------------------ *
 * Client helpers (shared shape with acceptance.test.ts)
 * ------------------------------------------------------------------ */

async function pumpFrames(client: TestClient, doc: Y.Doc, fromIndex: number): Promise<number> {
  const frames = client.binaryFrames();
  for (let index = fromIndex; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) continue;
    const decoded = decodeSyncFrame(frame);
    if (decoded === null) continue;

    if (readSyncMessageType(decoded) === SYNC_MESSAGE_TYPES.step1) {
      const serverStateVector = readSyncStep1StateVector(decoded);
      if (serverStateVector !== null) client.sendBinary(encodeSyncStep2(doc, serverStateVector));
      continue;
    }
    readSyncMessage(
      new TestDecoder(decoded.bytes) as unknown as never,
      TestDecoder.scratchEncoder() as unknown as never,
      doc,
      'insighthub:remote',
    );
  }
  return frames.length;
}

async function syncClient(client: TestClient, doc: Y.Doc, settleMs = 200): Promise<void> {
  let index = client.binaryFrames().length;
  client.sendBinary(encodeSyncStep1(doc));

  let quietSince = Date.now();
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (client.binaryFrames().length > index) {
      index = await pumpFrames(client, doc, index);
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince > settleMs) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the sync exchange to settle');
    await sleep(15);
  }
}

async function joinAndSync(client: TestClient, doc: Y.Doc, documentId: string): Promise<void> {
  await client.joinAndWait(documentId);
  await syncClient(client, doc);
}

function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText('content');
  const before = Y.encodeStateVector(doc);
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${description}`);
    await sleep(15);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Read the durable document from this process, with no server running.
 *
 * This is the "on disk, not in memory" evidence: the child is dead, so nothing caches the
 * bytes for us.
 */
async function readDurableDocument(dataPath: string, documentId: string): Promise<Y.Doc | null> {
  const opened = await openDocumentStore(dataPath);
  try {
    const stored = await opened.store.load(documentId);
    if (stored === null) return null;
    const doc = new Y.Doc();
    applyStoredDocument(stored, doc);
    return doc;
  } finally {
    await opened.store.close();
  }
}

/* ------------------------------------------------------------------ *
 * Scenario B — process restart recovery
 * ------------------------------------------------------------------ */

describe('Scenario B — the document survives the server process being killed', () => {
  it('a new process and a brand-new client see the full content', async () => {
    const dataPath = tempRoot();
    const port = await freePort();
    const documentId = DEMO_DOCUMENT_ID;
    const expected = 'written by the first process';

    // ---- 1. First process: write. ----
    const first = await ChildServer.start(port, dataPath);
    const cookie = await bootstrapSessionCookie(first.httpUrl, DEFAULT_DEMO_USER_ID);
    const writer = await TestClient.connect(first.url, { cookie });
    const observer = await TestClient.connect(first.url, { cookie });
    const writerDoc = new Y.Doc();
    const observerDoc = new Y.Doc();

    try {
      await joinAndSync(writer, writerDoc, documentId);
      await joinAndSync(observer, observerDoc, documentId);
      observer.clear();

      writer.sendBinary(encodeSyncUpdate(appendText(writerDoc, expected)));

      // Broadcast happens only after the append commits (D-044), so observing it here is what
      // makes the kill below a fair test rather than a race.
      await observer.waitForFrame(
        (frame) => frame.kind === 'binary',
        'the edit to be committed and broadcast',
      );
    } finally {
      writer.destroy();
      observer.destroy();
    }

    // ---- 2. Kill the process outright: no graceful close, no flush on shutdown. ----
    await first.kill();

    // ---- 3. Read the database from this process, with the server gone. ----
    const onDisk = await readDurableDocument(dataPath, documentId);
    assert.ok(onDisk !== null, 'the document must exist on disk after the process was killed');
    if (onDisk === null) return;
    assert.equal(
      onDisk.getText('content').toString(),
      expected,
      'the committed edit must have survived the process death',
    );
    onDisk.destroy();

    // ---- 4. A second process on the same data directory. ----
    const second = await ChildServer.start(port, dataPath);
    const reader = await TestClient.connect(second.url, {
      cookie: await bootstrapSessionCookie(second.httpUrl, DEFAULT_DEMO_USER_ID),
    });
    const readerDoc = new Y.Doc();
    try {
      await joinAndSync(reader, readerDoc, documentId);
      assert.equal(
        readerDoc.getText('content').toString(),
        expected,
        'a brand-new client must hydrate the content through the restarted server',
      );
    } finally {
      reader.destroy();
      await second.kill();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario C — offline edits across a restart
 * ------------------------------------------------------------------ */

describe('Scenario C — an offline client reconciles with a restarted server', () => {
  it('merges the offline edit by state vector and a fresh client sees the whole document', async () => {
    const dataPath = tempRoot();
    const port = await freePort();
    const documentId = DEMO_DOCUMENT_ID;

    const first = await ChildServer.start(port, dataPath);
    const cookie = await bootstrapSessionCookie(first.httpUrl, DEFAULT_DEMO_USER_ID);
    const client = await TestClient.connect(first.url, { cookie });
    // One local replica for the whole scenario: same client id, so the offline edits are
    // *its* structs and reconciliation is a genuine state-vector merge, not a text merge.
    const doc = new Y.Doc();

    try {
      await joinAndSync(client, doc, documentId);
      client.sendBinary(encodeSyncUpdate(appendText(doc, 'base')));

      // Wait until the base edit is durable. A second client observing the broadcast is the
      // evidence that the append committed first (D-044).
      const witness = await TestClient.connect(first.url, { cookie });
      const witnessDoc = new Y.Doc();
      try {
        await joinAndSync(witness, witnessDoc, documentId);
        await waitFor(
          () => witnessDoc.getText('content').toString() === 'base',
          'the base edit to be committed and broadcast',
        );
      } finally {
        witness.destroy();
      }
    } finally {
      // ---- Go offline, keeping the replica and the local edit. ----
      client.destroy();
    }

    appendText(doc, ' | offline');
    assert.equal(doc.getText('content').toString(), 'base | offline');

    // ---- The server dies while the client is away. ----
    await first.kill();

    const beforeReconnect = await readDurableDocument(dataPath, documentId);
    assert.ok(beforeReconnect !== null);
    if (beforeReconnect !== null) {
      assert.equal(
        beforeReconnect.getText('content').toString(),
        'base',
        'the offline edit must not be on disk yet',
      );
      beforeReconnect.destroy();
    }

    // ---- A new process, same port, so the same replica can reconnect to the same URL. ----
    const second = await ChildServer.start(port, dataPath);
    const resumed = await TestClient.connect(second.url, {
      // Sessions are process-scoped (docs/CONTRACTS.md §17.2), so the restarted process
      // knows nothing about the cookie the dead one issued: re-bootstrap, as a real client must.
      cookie: await bootstrapSessionCookie(second.httpUrl, DEFAULT_DEMO_USER_ID),
    });
    try {
      // Reconnect and run the ordinary state-vector handshake. The client holds an edit the
      // server has never seen; the server's `SyncStep1` is what asks for it, and the client's
      // `SyncStep2` is what delivers it. No special recovery path (D-044 point 4).
      await joinAndSync(resumed, doc, documentId);
      assert.equal(doc.getText('content').toString(), 'base | offline');

      await waitFor(async () => {
        const durable = await readDurableDocument(dataPath, documentId);
        if (durable === null) return false;
        const text = durable.getText('content').toString();
        durable.destroy();
        return text === 'base | offline';
      }, 'the offline edit to reach durable storage after reconnecting');

      // ---- A client that was never involved sees the complete document. ----
      const fresh = await TestClient.connect(second.url, {
        cookie: await bootstrapSessionCookie(second.httpUrl, DEFAULT_DEMO_USER_ID),
      });
      const freshDoc = new Y.Doc();
      try {
        await joinAndSync(fresh, freshDoc, documentId);
        assert.equal(
          freshDoc.getText('content').toString(),
          'base | offline',
          'a brand-new client must see both the pre-restart and the offline content',
        );
      } finally {
        fresh.destroy();
      }
    } finally {
      resumed.destroy();
      doc.destroy();
      await second.kill();
    }
  });
});

/* ------------------------------------------------------------------ *
 * D-051 at the process level: refuse to start, with a diagnostic
 * ------------------------------------------------------------------ */

describe('Startup refuses to run without durable storage (D-051)', () => {
  it('exits non-zero with a diagnostic instead of starting a memory-only server', async () => {
    const root = tempRoot();
    const port = await freePort();

    // A file where the data *directory* would be: SQLite cannot open anything under it.
    const blocked = join(root, 'data-is-a-file');
    writeFileSync(blocked, 'not a directory');

    const failing = ChildServer.spawnExpectingFailure(port, join(blocked, 'nested'));
    const code = await failing.waitForExit();

    assert.notEqual(code, 0, 'the server must not start successfully without durable storage');
    assert.match(
      failing.stdout + failing.stderr,
      /refusing to start/,
      `expected a clear refusal, got stdout=${failing.stdout} stderr=${failing.stderr}`,
    );
    assert.match(
      failing.stdout + failing.stderr,
      /DATA_PATH_UNAVAILABLE|INSIGHTHUB_DATA_PATH|hint:/,
      'the diagnostic must name the unmet requirement or the setting to fix',
    );

    // And it must not be listening: a refused startup that still served traffic would be the
    // silent memory-only mode the decision forbids.
    await assert.rejects(
      () => TestClient.connect(`ws://127.0.0.1:${port}/ws`),
      /ECONNREFUSED|connect|timed out/i,
      'a refused server must not accept connections',
    );
  });
});
