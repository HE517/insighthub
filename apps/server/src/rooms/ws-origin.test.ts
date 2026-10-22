/**
 * **M4 B4** — WebSocket upgrade origin hardening (`docs/CONTRACTS.md` §18.3/§18.4).
 *
 * Every claim is proven against a real HTTP+WS server on an ephemeral port, exactly like the B2
 * upgrade-auth suite:
 *
 * | # | Claim | Observable |
 * | --- | --- | --- |
 * | 1 | a foreign `Origin` is refused with raw `403 origin_not_allowed` and **no socket** | bytes on the wire; connection counters stay 0 |
 * | 2 | Origin is checked **before** identity | a foreign origin with no session is 403, not 401 |
 * | 3 | the configured origin may open a socket | `connected` handshake completes |
 * | 4 | the loopback alias the browser suite uses may open a socket | `connected` handshake completes |
 * | 5 | an upgrade with **no** `Origin` is allowed (non-browser client) | `connected` handshake completes |
 * | 6 | a missing session is still refused with 401 when the origin is allowed | raw 401, no socket |
 */
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { after, describe, it } from 'node:test';

import {
  bootstrapSessionCookie,
  startTestServer,
  TestClient,
  type TestServer,
} from './test-harness.js';

const ALLOWED_ORIGIN = 'http://localhost:5173';
const ALIAS_ORIGIN = 'http://127.0.0.1:5173';
const FOREIGN_ORIGIN = 'https://evil.example';

const servers: TestServer[] = [];
const clients: TestClient[] = [];

after(async () => {
  for (const client of clients) client.destroy();
  for (const server of servers) await server.close();
});

/** A server whose upgrade is authenticated and whose origin allow-list is the dev default. */
async function enforcedServer(): Promise<TestServer> {
  const server = await startTestServer({ authorization: 'enforced' });
  servers.push(server);
  return server;
}

/**
 * Send a raw HTTP upgrade and read the refusal.
 *
 * `ws` hides the response body of a refused upgrade, but the contract is about the HTTP response
 * (status **and** body), so the bytes are read from the socket directly.
 */
async function rawUpgrade(
  port: number,
  options: { cookie?: string; origin?: string; path?: string } = {},
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (statusMatch === null) {
        reject(new Error(`upgrade answered with no HTTP status: ${JSON.stringify(received)}`));
        return;
      }
      const separator = received.indexOf('\r\n\r\n');
      resolve({
        status: Number(statusMatch[1]),
        body: separator === -1 ? '' : received.slice(separator + 4),
      });
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('timed out waiting for the upgrade response'));
    }, 5_000);

    socket.on('data', (chunk: Buffer | string) => {
      received += chunk.toString('latin1');
    });
    socket.on('close', finish);
    socket.on('error', () => {
      if (received.length > 0) finish();
      else {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('the upgrade connection failed'));
        }
      }
    });
    socket.on('connect', () => {
      const lines = [
        `GET ${options.path ?? '/ws'} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ];
      if (options.cookie !== undefined) lines.push(`Cookie: ${options.cookie}`);
      if (options.origin !== undefined) lines.push(`Origin: ${options.origin}`);
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    });
  });
}

/** True when a refusal left no socket, no room participant and no connection. */
function assertNoSocket(server: TestServer): void {
  assert.equal(server.handle.clientCount(), 0, 'a refused upgrade must not register a connection');
  assert.equal(server.handle.wss.clients.size, 0, 'no WebSocket may exist after a refusal');
}

describe('WebSocket upgrade — foreign origin (§18.3/§18.4)', () => {
  it('refuses a foreign Origin with 403 origin_not_allowed and no socket', async () => {
    const server = await enforcedServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    // A valid session is deliberately present: the origin decision must reject the upgrade even
    // though the caller could otherwise authenticate.
    const refused = await rawUpgrade(server.port, { cookie, origin: FOREIGN_ORIGIN });
    assert.equal(refused.status, 403);
    assert.deepEqual(JSON.parse(refused.body), { error: 'origin_not_allowed' });
    assertNoSocket(server);
  });

  it('checks Origin before identity (403, never 401, for a foreign origin)', async () => {
    const server = await enforcedServer();

    const refused = await rawUpgrade(server.port, { origin: FOREIGN_ORIGIN });
    assert.equal(refused.status, 403, 'origin must be decided before the session is looked at');
    assert.deepEqual(JSON.parse(refused.body), { error: 'origin_not_allowed' });
    assertNoSocket(server);
  });
});

describe('WebSocket upgrade — allowed and absent origins', () => {
  it('opens a socket for the configured origin', async () => {
    const server = await enforcedServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    const client = await TestClient.connect(server.url, { cookie, origin: ALLOWED_ORIGIN });
    clients.push(client);

    assert.equal(client.closed, false);
    assert.equal(server.handle.clientCount(), 1);
  });

  it('opens a socket for the loopback alias the real-browser suite uses', async () => {
    const server = await enforcedServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    const client = await TestClient.connect(server.url, { cookie, origin: ALIAS_ORIGIN });
    clients.push(client);

    assert.equal(client.closed, false);
    assert.equal(server.handle.clientCount(), 1);
  });

  it('opens a socket when no Origin is sent (non-browser client)', async () => {
    const server = await enforcedServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    // No `origin` option: exactly what the M0 verify script and a Node client send.
    const client = await TestClient.connect(server.url, { cookie });
    clients.push(client);

    assert.equal(client.closed, false);
    assert.equal(server.handle.clientCount(), 1);
  });

  it('still refuses a missing session with 401 once the origin is allowed', async () => {
    const server = await enforcedServer();

    const refused = await rawUpgrade(server.port, { origin: ALLOWED_ORIGIN });
    assert.equal(refused.status, 401);
    assert.deepEqual(JSON.parse(refused.body), { error: 'unauthenticated' });
    assertNoSocket(server);
  });
});
