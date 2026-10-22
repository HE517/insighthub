/**
 * WebSocket logging (M4 B9): `ws.upgrade` and `ws.join`.
 *
 * A real `ws` client against a real server with the real `AuthzService` (`authorization:
 * 'enforced'`), so the identity in the log is the one the upgrade resolved from the session —
 * not a value a test handed the transport. The logger is a capturing sink.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bootstrapSessionCookie, startTestServer, TestClient } from '../rooms/test-harness.js';
import { createLogger } from './logger.js';
import { captureLogs } from './test-support.js';

describe('ws logging', () => {
  it('records upgrade outcomes and joins with request/session/document correlation', async () => {
    const capture = captureLogs();
    const server = await startTestServer({
      authorization: 'enforced',
      log: createLogger({ sink: capture.sink }),
    });
    const clients: TestClient[] = [];
    try {
      // 1. A foreign Origin is refused before identity, and still logged.
      const forbidden = await TestClient.expectRefused(
        server.url,
        undefined,
        'https://evil.example',
      );
      assert.equal(forbidden, 403);

      // 2. No session: 401, no socket, `unauthenticated` outcome.
      const unauthenticated = await TestClient.expectRefused(server.url);
      assert.equal(unauthenticated, 401);

      // 3. A real admitted upgrade + room join.
      const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
      const client = await TestClient.connect(server.url, { cookie });
      clients.push(client);
      const joined = await client.joinAndWait('demo-document');
      assert.equal(joined.role, 'owner');

      const upgrades = capture.events('ws.upgrade');
      assert.deepEqual(
        upgrades.map((record) => record['outcome']),
        ['rejected_origin', 'unauthenticated', 'ok'],
        `unexpected upgrade outcomes: ${capture.text}`,
      );

      const admitted = upgrades[2] as Record<string, unknown>;
      assert.equal(admitted['userId'], 'demo-ada');
      assert.match(String(admitted['requestId']), /^[0-9a-f-]{36}$/);
      assert.equal(upgrades[0]?.['userId'], undefined);
      assert.equal(upgrades[1]?.['userId'], undefined);

      const joins = capture.events('ws.join');
      assert.equal(joins.length, 1, `expected one ws.join line: ${capture.text}`);
      const join = joins[0] as Record<string, unknown>;
      assert.equal(join['userId'], 'demo-ada');
      assert.equal(join['documentId'], 'demo-document');
      assert.equal(join['role'], 'owner');
      // The connection's request id is inherited from the upgrade that admitted it.
      assert.equal(join['requestId'], admitted['requestId']);
      assert.equal(typeof join['connectionId'], 'string');

      // The session cookie/token is never part of a WS log line.
      const token = cookie.slice(cookie.indexOf('=') + 1);
      assert.equal(capture.text.includes(token), false, 'the WS log leaked the session token');
      assert.equal(capture.text.includes('cookie'), false);
    } finally {
      for (const client of clients) client.destroy();
      await server.close();
    }
  });
});
