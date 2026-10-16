import { describe, expect, it } from 'vitest';

import {
  WS_MESSAGE_TYPES,
  createConnectedMessage,
  createEnvelope,
  parseClientMessage,
  parseMessageJson,
  parseServerMessage,
} from './protocol.js';

describe('websocket protocol envelope', () => {
  it('builds a connected handshake the client side accepts', () => {
    const message = createConnectedMessage('conn-1', { ts: '2026-01-01T00:00:00.000Z' });

    // Server-side type contract: envelopes always carry the same four keys.
    expect(message.type).toBe(WS_MESSAGE_TYPES.connected);
    expect(Object.keys(message).sort()).toEqual(['payload', 'ts', 'type'].sort());

    const parsed = parseServerMessage(JSON.parse(JSON.stringify(message)));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.type).toBe('connected');
    if (parsed.data?.type === 'connected') {
      expect(parsed.data.payload.connectionId).toBe('conn-1');
      expect(parsed.data.payload.protocolVersion).toBe(1);
    }
  });

  it('rejects an unknown message type instead of ignoring it', () => {
    const result = parseServerMessage({ type: 'not-a-real-type', payload: {}, ts: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a known type with a malformed payload', () => {
    const result = parseClientMessage(
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, { documentId: '' }, { ts: 'x' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('documentId');
  });

  it('reports invalid JSON without throwing', () => {
    const result = parseMessageJson('{ not json');
    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid JSON payload');
  });

  it('keeps requestId optional and only present when supplied', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const withoutRequest = createEnvelope(
      WS_MESSAGE_TYPES.leaveRoom,
      { documentId: 'doc-1' },
      { ts },
    );
    expect('requestId' in withoutRequest).toBe(false);

    const withRequest = createEnvelope(
      WS_MESSAGE_TYPES.leaveRoom,
      { documentId: 'doc-1' },
      { requestId: 'req-9', ts },
    );
    expect(withRequest.requestId).toBe('req-9');
    expect(parseClientMessage(withRequest).success).toBe(true);
  });

  it('rejects a non-ISO8601 timestamp', () => {
    const result = parseClientMessage(
      createEnvelope(WS_MESSAGE_TYPES.leaveRoom, { documentId: 'doc-1' }, { ts: 'x' }),
    );
    expect(result.success).toBe(false);
  });

  it('does not accept a client-only message on the server-to-client channel', () => {
    const result = parseServerMessage(
      createEnvelope(
        WS_MESSAGE_TYPES.joinRoom,
        { documentId: 'doc-1' },
        { ts: '2026-01-01T00:00:00.000Z' },
      ),
    );
    expect(result.success).toBe(false);
  });
});
