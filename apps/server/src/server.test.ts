/**
 * M0 acceptance test: the server must answer /health with 200 and must send a
 * `connected` handshake to a browser-style WebSocket client.
 *
 * Runs on an ephemeral port so it never collides with a dev server.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import {
  PROTOCOL_VERSION,
  WS_ERROR_CODES,
  parseServerMessage,
  type WsServerMessage,
} from '@insighthub/shared';
import { WebSocket } from 'ws';

import { createApp } from './app.js';
import { type ServerConfig } from './config.js';
import { attachWebSocketServer, type WebSocketHandle } from './ws.js';

const config: ServerConfig = {
  port: 0,
  host: '127.0.0.1',
  corsOrigin: 'http://localhost:5173',
  wsPath: '/ws',
};

const server = createServer(createApp(config));
let socket: WebSocketHandle;
let baseUrl = '';

before(async () => {
  socket = attachWebSocketServer(server, config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await socket.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /health', () => {
  it('returns 200 with { status: "ok" }', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });
});

describe('GET /unknown', () => {
  it('returns 404 instead of hanging', async () => {
    const response = await fetch(`${baseUrl}/nope`);
    assert.equal(response.status, 404);
  });
});

describe('WebSocket /ws', () => {
  it('sends a connected message the shared parser accepts', async () => {
    const wsUrl = baseUrl.replace('http://', 'ws://') + config.wsPath;
    const ws = new WebSocket(wsUrl);

    const message = await new Promise<WsServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for connected')), 5000);
      ws.once('message', (raw) => {
        clearTimeout(timer);
        const parsed = parseServerMessage(JSON.parse(raw.toString()));
        if (!parsed.success || parsed.data === undefined) {
          reject(new Error(`server sent an invalid message: ${parsed.error}`));
          return;
        }
        resolve(parsed.data);
      });
      ws.once('error', reject);
    });

    assert.equal(message.type, 'connected');
    if (message.type === 'connected') {
      assert.equal(message.payload.protocolVersion, PROTOCOL_VERSION);
      assert.ok(message.payload.connectionId.length > 0);
      assert.ok(Number.isFinite(Date.parse(message.payload.serverTime)));
    }

    ws.close();
  });

  it('answers a binary data-plane frame with ROOM_NOT_JOINED before join-room', async () => {
    // M1-A0 froze the two-plane model; the server has no room state yet, so the
    // only correct answer to collaboration data is "you have not joined".
    const wsUrl = baseUrl.replace('http://', 'ws://') + config.wsPath;
    const ws = new WebSocket(wsUrl);

    const error = await new Promise<WsServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for error')), 5000);
      ws.on('message', (raw: Buffer) => {
        // The server answers control-plane violations on the TEXT channel, so the
        // response to a binary frame is itself a text envelope. Select by message
        // type, not by the transport flag.
        const parsed = parseServerMessage(JSON.parse(raw.toString()));
        if (!parsed.success || parsed.data === undefined) {
          reject(new Error(`server sent an invalid message: ${parsed.error}`));
          return;
        }
        if (parsed.data.type !== 'error') return; // skip the `connected` handshake
        clearTimeout(timer);
        resolve(parsed.data);
      });
      ws.once('open', () => {
        // Any binary payload: the frame content is irrelevant before a join.
        ws.send(new Uint8Array([0, 0, 0]));
      });
      ws.once('error', reject);
    });

    assert.equal(error.type, 'error');
    if (error.type === 'error') {
      assert.equal(error.payload.code, WS_ERROR_CODES.ROOM_NOT_JOINED);
    }

    ws.close();
  });

  it('rejects an upgrade on an unexpected path', async () => {
    const badUrl = baseUrl.replace('http://', 'ws://') + '/not-ws';
    const ws = new WebSocket(badUrl);

    const failed = await new Promise<boolean>((resolve) => {
      ws.once('error', () => resolve(true));
      ws.once('open', () => resolve(false));
    });

    assert.equal(failed, true);
    ws.terminate();
  });
});

/** Send one text frame after the handshake and return the first error reply. */
async function errorReplyFor(frame: string): Promise<string> {
  const wsUrl = baseUrl.replace('http://', 'ws://') + config.wsPath;
  const ws = new WebSocket(wsUrl);

  const error = await new Promise<WsServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for error')), 5000);
    ws.on('message', (raw: Buffer) => {
      const parsed = parseServerMessage(JSON.parse(raw.toString()));
      if (!parsed.success || parsed.data === undefined) {
        reject(new Error(`server sent an invalid message: ${parsed.error}`));
        return;
      }
      if (parsed.data.type !== 'error') return; // skip the handshake
      clearTimeout(timer);
      resolve(parsed.data);
    });
    ws.once('open', () => ws.send(frame));
    ws.once('error', reject);
  });

  ws.close();
  assert.equal(error.type, 'error');
  return error.type === 'error' ? error.payload.code : 'unreachable';
}

describe('control-plane error classification (M1-A0.1)', () => {
  it('reports the deleted presence message as UNKNOWN_MESSAGE_TYPE', async () => {
    // M1-A0.1 removed the presence message. A stale client must fail loudly with
    // the accurate code, not be mistaken for random corruption.
    assert.equal(
      await errorReplyFor(
        JSON.stringify({
          type: 'presence',
          payload: { documentId: 'doc-1', connectionId: 'c1', state: 'joined' },
          ts: '2026-01-01T00:00:00.000Z',
        }),
      ),
      WS_ERROR_CODES.UNKNOWN_MESSAGE_TYPE,
    );
  });

  it('reports malformed JSON as INVALID_MESSAGE', async () => {
    assert.equal(await errorReplyFor('{ not json'), WS_ERROR_CODES.INVALID_MESSAGE);
  });

  it('reports a known type with a bad payload as INVALID_MESSAGE', async () => {
    // `join-room` is implemented, so this is a payload fault, not an unknown type.
    assert.equal(
      await errorReplyFor(
        JSON.stringify({ type: 'join-room', payload: {}, ts: '2026-01-01T00:00:00.000Z' }),
      ),
      WS_ERROR_CODES.INVALID_MESSAGE,
    );
  });

  it('reports a JSON frame with no type field as INVALID_MESSAGE', async () => {
    assert.equal(
      await errorReplyFor(JSON.stringify({ payload: {} })),
      WS_ERROR_CODES.INVALID_MESSAGE,
    );
  });
});
