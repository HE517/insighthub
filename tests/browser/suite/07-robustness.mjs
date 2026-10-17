/**
 * Robustness smoke: hostile and malformed input on the wire.
 *
 * A raw client (no A1/A2 code) hammers the real server with the violations the
 * frozen contract names, and the assertions are twofold:
 *
 * 1. the server answers with the **frozen** error code, and closes exactly when
 *    `isFatalErrorCode` says it should;
 * 2. the **browser** in the same room is unaffected — it does not crash, does not
 *    enter a reconnect storm, and does not get stuck on a loading state.
 *
 * This is a smoke test, not a security audit.
 */
import {
  editorState,
  readConnectionStatus,
  readPageDiagnostics,
  waitForEditorText,
} from '../lib/app.mjs';
import { sleep } from '../lib/cdp.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { importDependency, loadShared, loadYjs } from '../lib/deps.mjs';

/** Open a raw WebSocket that records what the server says. */
async function openRawSocket(url) {
  const shared = await loadShared();
  const text = [];
  const binary = [];
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let closed = false;

  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        text.push(JSON.parse(event.data));
      } catch {
        text.push({ unparseable: event.data });
      }
      return;
    }
    const bytes =
      event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    binary.push(bytes);
  });
  socket.addEventListener('close', () => {
    closed = true;
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('raw socket did not open')), 10_000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('raw socket failed to open'));
      },
      { once: true },
    );
  });

  return {
    socket,
    text,
    binary,
    shared,
    get closed() {
      return closed;
    },
    /** Wait for a server control message of the given type, or throw. */
    async waitFor(type, { timeoutMs = 10_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = text.find((message) => message?.type === type);
        if (found !== undefined) return found;
        await sleep(50);
      }
      throw new Error(
        `raw socket never received a "${type}" message ` +
          `(saw: ${text.map((message) => message?.type ?? '?').join(', ') || 'nothing'})`,
      );
    },
    joinRoom(documentId) {
      socket.send(
        JSON.stringify(
          shared.createEnvelope(shared.WS_MESSAGE_TYPES.joinRoom, {
            documentId,
            protocolVersion: shared.PROTOCOL_VERSION,
            mode: 'readwrite',
          }),
        ),
      );
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export function register(runner) {
  runner.scenario(
    'robustness/frozen-error-codes-and-browser-survival',
    'every malformed frame produces its frozen error code and leaves the browser unaffected',
    async (ctx) => {
      const documentId = 'a6-robustness';
      // A real browser client in the same room, so "the browser is unaffected" has
      // something to be affected.
      const page = await ctx.newAppPage({ documentId });
      await waitForEditorText(page, () => true);
      const baselineLength = (await editorState(page)).length;
      const statusBefore = await readConnectionStatus(page);
      ctx.note('browser baseline', { length: baselineLength, status: statusBefore });

      const Y = await loadYjs();
      const shared = await loadShared();
      const outcomes = [];

      /* 1. Malformed TEXT ------------------------------------------------- */
      {
        const raw = await openRawSocket(ctx.stack.wsUrl);
        await raw.waitFor('connected');
        raw.socket.send('{ this is not json');
        const error = await raw.waitFor('error');
        outcomes.push({ case: 'malformed TEXT', code: error.payload.code });
        await sleep(300);
        assertEqual(error.payload.code, 'INVALID_MESSAGE', 'malformed TEXT must be INVALID_MESSAGE');
        assert(raw.closed, 'INVALID_MESSAGE is fatal and must close the socket');
        raw.close();
      }

      /* 2. Unknown message type ------------------------------------------- */
      {
        const raw = await openRawSocket(ctx.stack.wsUrl);
        await raw.waitFor('connected');
        raw.socket.send(
          JSON.stringify({
            type: 'presence',
            payload: { documentId },
            ts: new Date().toISOString(),
          }),
        );
        const error = await raw.waitFor('error');
        outcomes.push({ case: 'deleted presence message', code: error.payload.code });
        assertEqual(
          error.payload.code,
          'UNKNOWN_MESSAGE_TYPE',
          'the deleted `presence` message must be UNKNOWN_MESSAGE_TYPE (D-021)',
        );
        assert(raw.closed, 'UNKNOWN_MESSAGE_TYPE is fatal and must close the socket');
        raw.close();
      }

      /* 3. Binary frame before join-room ---------------------------------- */
      {
        const raw = await openRawSocket(ctx.stack.wsUrl);
        await raw.waitFor('connected');
        const doc = new Y.Doc();
        raw.socket.send(shared.encodeSyncStep1(doc));
        const error = await raw.waitFor('error');
        outcomes.push({ case: 'binary before join-room', code: error.payload.code });
        assertEqual(
          error.payload.code,
          'ROOM_NOT_JOINED',
          'a data-plane frame before join must be ROOM_NOT_JOINED',
        );
        await sleep(200);
        assert(!raw.closed, 'ROOM_NOT_JOINED is non-fatal: the socket must stay open');
        raw.close();
      }

      /* 4. Malformed BINARY ----------------------------------------------- */
      {
        const raw = await openRawSocket(ctx.stack.wsUrl);
        await raw.waitFor('connected');
        raw.joinRoom(documentId);
        await raw.waitFor('room-joined');
        raw.socket.send(new Uint8Array([0xff, 0x01]));
        const error = await raw.waitFor('error');
        outcomes.push({ case: 'malformed binary', code: error.payload.code });
        assertEqual(
          error.payload.code,
          'INVALID_BINARY_FRAME',
          'an undecodable binary frame must be INVALID_BINARY_FRAME',
        );
        await sleep(300);
        assert(raw.closed, 'INVALID_BINARY_FRAME is fatal and must close the socket');
        raw.close();
      }

      /* 5. Oversized BINARY ------------------------------------------------ */
      {
        const raw = await openRawSocket(ctx.stack.wsUrl);
        await raw.waitFor('connected');
        raw.joinRoom(documentId);
        await raw.waitFor('room-joined');
        const oversized = new Uint8Array(shared.MAX_BINARY_FRAME_BYTES + 1);
        oversized[0] = 0;
        raw.socket.send(oversized);
        const error = await raw.waitFor('error', { timeoutMs: 20_000 });
        outcomes.push({ case: 'oversized binary', code: error.payload.code });
        assertEqual(
          error.payload.code,
          'FRAME_TOO_LARGE',
          'a frame over MAX_BINARY_FRAME_BYTES must be FRAME_TOO_LARGE',
        );
        await sleep(300);
        assert(raw.closed, 'FRAME_TOO_LARGE is fatal and must close the socket');
        raw.close();
      }

      /* 6. Wrong protocol version ------------------------------------------ */
      {
        const raw = await openRawSocket(ctx.stack.wsUrl);
        await raw.waitFor('connected');
        raw.socket.send(
          JSON.stringify(
            raw.shared.createEnvelope(raw.shared.WS_MESSAGE_TYPES.joinRoom, {
              documentId,
              protocolVersion: 99,
              mode: 'readwrite',
            }),
          ),
        );
        const error = await raw.waitFor('error');
        outcomes.push({ case: 'protocolVersion 99', code: error.payload.code });
        assertEqual(
          error.payload.code,
          'PROTOCOL_VERSION_MISMATCH',
          'a peer speaking another protocol version must be told so specifically',
        );
        await sleep(300);
        assert(raw.closed, 'PROTOCOL_VERSION_MISMATCH is fatal and must close the socket');
        raw.close();
      }

      /* 7. Unknown binary frame type --------------------------------------- */
      {
        const raw = await openRawSocket(ctx.stack.wsUrl);
        await raw.waitFor('connected');
        raw.joinRoom(documentId);
        await raw.waitFor('room-joined');
        raw.socket.send(new Uint8Array([0x09, 0x01, 0x02]));
        const error = await raw.waitFor('error');
        outcomes.push({ case: 'unknown binary frame type', code: error.payload.code });
        assertEqual(
          error.payload.code,
          'INVALID_BINARY_FRAME',
          'an unknown binary frame type must be rejected, not ignored',
        );
        raw.close();
      }

      ctx.note('server outcomes', outcomes);

      /* The browser must be untouched by all of that. ---------------------- */
      await sleep(2_000);
      const status = await readConnectionStatus(page);
      const state = await editorState(page);
      const diagnostics = await readPageDiagnostics(page);
      const summary = await page.evaluate(() => window.__qa.summary());
      ctx.note('browser after the attack', {
        status,
        length: state.length,
        viewId: state.viewId,
        diagnostics,
        sockets: summary.sockets,
        liveSockets: summary.liveSockets,
        errors: summary.errors,
      });

      assertEqual(status, 'connected', 'the browser must stay connected through a peer abuse storm');
      assertEqual(state.length, baselineLength, "the browser's document must be untouched");
      assertEqual(diagnostics.pageErrors.length, 0, 'the page must not throw');
      assert(
        summary.liveSockets <= 2,
        `the browser must not start extra sockets under abuse (saw ${summary.liveSockets})`,
      );

      // And the room still relays: a well-formed client must still work.
      const healthy = await openRawSocket(ctx.stack.wsUrl);
      try {
        await healthy.waitFor('connected');
        healthy.joinRoom(documentId);
        const joined = await healthy.waitFor('room-joined');
        ctx.note('a well-formed client still joins', joined.payload);
        assertIncludes(joined.payload.documentId, documentId, 'the room must still accept members');
      } finally {
        healthy.close();
      }
    },
  );
}
