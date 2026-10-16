import { describe, expect, it } from 'vitest';

import { WS_ERROR_CODES } from './errors.js';
import {
  PROTOCOL_VERSION,
  WS_MESSAGE_TYPES,
  createConnectedMessage,
  createEnvelope,
  createErrorMessage,
  createPresenceMessage,
  createRoomJoinedMessage,
  parseClientMessage,
  parseMessageJson,
  parseServerMessage,
} from './protocol.js';

const TS = '2026-01-01T00:00:00.000Z';

describe('websocket protocol envelope', () => {
  it('builds a connected handshake the client side accepts', () => {
    const message = createConnectedMessage('conn-1', { ts: TS });

    // Server-side type contract: envelopes always carry the same keys.
    expect(message.type).toBe(WS_MESSAGE_TYPES.connected);
    expect(Object.keys(message).sort()).toEqual(['payload', 'ts', 'type'].sort());

    const parsed = parseServerMessage(JSON.parse(JSON.stringify(message)));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.type).toBe('connected');
    if (parsed.data?.type === 'connected') {
      expect(parsed.data.payload.connectionId).toBe('conn-1');
      expect(parsed.data.payload.protocolVersion).toBe(PROTOCOL_VERSION);
    }
  });

  it('rejects an unknown message type instead of ignoring it', () => {
    const result = parseServerMessage({ type: 'not-a-real-type', payload: {}, ts: TS });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a known type with a malformed payload', () => {
    const result = parseClientMessage(
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, { documentId: '' }, { ts: TS }),
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
    const withoutRequest = createEnvelope(
      WS_MESSAGE_TYPES.leaveRoom,
      { documentId: 'doc-1' },
      { ts: TS },
    );
    expect('requestId' in withoutRequest).toBe(false);

    const withRequest = createEnvelope(
      WS_MESSAGE_TYPES.leaveRoom,
      { documentId: 'doc-1' },
      { requestId: 'req-9', ts: TS },
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
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, { documentId: 'doc-1' }, { ts: TS }),
    );
    expect(result.success).toBe(false);
  });
});

describe('join-room contract (frozen by M1-A0)', () => {
  const validJoin = {
    documentId: 'doc-1',
    protocolVersion: PROTOCOL_VERSION,
    mode: 'readwrite' as const,
    ts: TS,
  };

  it('accepts a join-room that declares the current protocol version', () => {
    const parsed = parseClientMessage(
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, validJoin, { ts: TS }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a join-room from a peer speaking an older protocol version', () => {
    // This is how PROTOCOL_VERSION_MISMATCH becomes detectable: the version is
    // part of the payload, not an afterthought, so it fails at the boundary.
    const parsed = parseClientMessage(
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, { ...validJoin, protocolVersion: 1 }, { ts: TS }),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('protocolVersion');
  });

  it('rejects a join-room without a protocol version', () => {
    const parsed = parseClientMessage(
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, { documentId: 'doc-1' }, { ts: TS }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown join mode', () => {
    const parsed = parseClientMessage(
      createEnvelope(WS_MESSAGE_TYPES.joinRoom, { ...validJoin, mode: 'admin' }, { ts: TS }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('error message contract', () => {
  it('builds an error from the frozen vocabulary', () => {
    const message = createErrorMessage(WS_ERROR_CODES.ROOM_NOT_JOINED, 'join first', { ts: TS });
    expect(message.type).toBe('error');
    expect(message.payload.code).toBe('ROOM_NOT_JOINED');

    const parsed = parseServerMessage(message);
    expect(parsed.success).toBe(true);
    if (parsed.data?.type === 'error') {
      expect(parsed.data.payload.code).toBe(WS_ERROR_CODES.ROOM_NOT_JOINED);
    }
  });

  it('rejects an error message carrying an uncatalogued code', () => {
    const parsed = parseServerMessage({
      type: 'error',
      payload: { code: 'something_went_wrong', message: 'oops' },
      ts: TS,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an error message without a message body', () => {
    const parsed = parseServerMessage({
      type: 'error',
      payload: { code: WS_ERROR_CODES.INTERNAL_ERROR, message: '' },
      ts: TS,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('room-joined and presence contracts', () => {
  it('builds a room-joined acknowledgement', () => {
    const parsed = parseServerMessage(
      createRoomJoinedMessage(
        {
          documentId: 'doc-1',
          connectionId: 'conn-1',
          revision: 3,
          peers: ['conn-0'],
        },
        { ts: TS },
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.data?.type === 'room-joined') {
      expect(parsed.data.payload.revision).toBe(3);
      expect(parsed.data.payload.peers).toEqual(['conn-0']);
    }
  });

  it('rejects a room-joined without connectionId', () => {
    const parsed = parseServerMessage({
      type: 'room-joined',
      payload: { documentId: 'doc-1', revision: 0, peers: [] },
      ts: TS,
    });
    expect(parsed.success).toBe(false);
  });

  it('builds a presence notification', () => {
    const parsed = parseServerMessage(
      createPresenceMessage(
        { documentId: 'doc-1', connectionId: 'conn-2', state: 'joined' },
        { ts: TS },
      ),
    );
    expect(parsed.success).toBe(true);
    if (parsed.data?.type === 'presence') {
      expect(parsed.data.payload.state).toBe('joined');
    }
  });

  it('rejects an unknown presence state', () => {
    const parsed = parseServerMessage({
      type: 'presence',
      payload: { documentId: 'doc-1', connectionId: 'conn-2', state: 'idle' },
      ts: TS,
    });
    expect(parsed.success).toBe(false);
  });
});
