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

import { parseServerMessage, type WsServerMessage } from '@insighthub/shared';
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
      assert.equal(message.payload.protocolVersion, 1);
      assert.ok(message.payload.connectionId.length > 0);
      assert.ok(Number.isFinite(Date.parse(message.payload.serverTime)));
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
