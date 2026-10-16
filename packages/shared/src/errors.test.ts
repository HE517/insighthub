import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import {
  WS_ERROR_CODES,
  WS_ERROR_CODE_VALUES,
  isFatalErrorCode,
  isWsErrorCode,
  wsErrorCodeSchema,
} from './errors.js';

describe('error code vocabulary', () => {
  it('exposes exactly the frozen M1-A0 codes', () => {
    // `ROOM_CARDINALITY_VIOLATION` was added by M1-A0.1 alongside the frozen
    // one-room-per-socket rule.
    assert.deepEqual([...WS_ERROR_CODE_VALUES].sort(), [
      'FRAME_TOO_LARGE',
      'INTERNAL_ERROR',
      'INVALID_BINARY_FRAME',
      'INVALID_MESSAGE',
      'PROTOCOL_VERSION_MISMATCH',
      'ROOM_CARDINALITY_VIOLATION',
      'ROOM_NOT_FOUND',
      'ROOM_NOT_JOINED',
      'UNKNOWN_MESSAGE_TYPE',
    ]);
  });

  it('validates known codes and rejects invented ones', () => {
    for (const code of WS_ERROR_CODE_VALUES) {
      expect(isWsErrorCode(code)).toBe(true);
      expect(wsErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(isWsErrorCode('invalid_message')).toBe(false); // M0's lowercase string
    expect(isWsErrorCode('random_failure')).toBe(false);
    expect(isWsErrorCode(42)).toBe(false);
  });

  it('classifies fatal vs recoverable codes', () => {
    // Fatal: the peer cannot continue on this socket.
    expect(isFatalErrorCode(WS_ERROR_CODES.PROTOCOL_VERSION_MISMATCH)).toBe(true);
    expect(isFatalErrorCode(WS_ERROR_CODES.INVALID_BINARY_FRAME)).toBe(true);
    expect(isFatalErrorCode(WS_ERROR_CODES.FRAME_TOO_LARGE)).toBe(true);

    // Recoverable: the connection stays usable.
    expect(isFatalErrorCode(WS_ERROR_CODES.ROOM_NOT_JOINED)).toBe(false);
    expect(isFatalErrorCode(WS_ERROR_CODES.ROOM_NOT_FOUND)).toBe(false);
    expect(isFatalErrorCode(WS_ERROR_CODES.ROOM_CARDINALITY_VIOLATION)).toBe(false);
    expect(isFatalErrorCode(WS_ERROR_CODES.INTERNAL_ERROR)).toBe(false);
  });

  it('keeps codes stable and distinct from their messages', () => {
    for (const [key, value] of Object.entries(WS_ERROR_CODES)) {
      assert.equal(key, value);
      assert.match(value, /^[A-Z][A-Z_]*$/);
    }
  });
});
