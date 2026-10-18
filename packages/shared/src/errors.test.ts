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
    // one-room-per-socket rule. `FORBIDDEN` was added by M2 Phase 2 (`CONTRACTS` §17.6)
    // and is what bumped `SHARED_CONTRACT_VERSION` to 5.
    assert.deepEqual([...WS_ERROR_CODE_VALUES].sort(), [
      'FORBIDDEN',
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
    // `FORBIDDEN` (M2 Phase 2) is deliberately non-fatal: a reader whose write was
    // refused must keep the socket (CONTRACTS §17.5 — "keep the socket open").
    expect(isFatalErrorCode(WS_ERROR_CODES.FORBIDDEN)).toBe(false);
  });

  it('keeps FATAL_CODES exactly as frozen when FORBIDDEN was added', () => {
    // The vocabulary grew in M2 Phase 2 but the fatal set must not have. Pinned as a set
    // so "someone added a code and it silently became fatal" fails here instead of
    // disconnecting readers in production.
    const fatal = WS_ERROR_CODE_VALUES.filter((code) => isFatalErrorCode(code)).sort();
    assert.deepEqual(fatal, [
      'FRAME_TOO_LARGE',
      'INVALID_BINARY_FRAME',
      'INVALID_MESSAGE',
      'PROTOCOL_VERSION_MISMATCH',
      'UNKNOWN_MESSAGE_TYPE',
    ]);
  });

  it('accepts FORBIDDEN in an error payload, and still rejects near-misses', () => {
    // `WsErrorPayload.code` is the Zod enum over this vocabulary, so the new code must be
    // schema-valid or a server could never legally send it.
    expect(wsErrorCodeSchema.safeParse(WS_ERROR_CODES.FORBIDDEN).success).toBe(true);
    expect(isWsErrorCode('FORBIDDEN')).toBe(true);
    // A near-miss is a *different* code, not a synonym: `ROOM_NOT_FOUND` is the
    // non-disclosure answer (§17.5) and must not be aliased to this one.
    expect(isWsErrorCode('forbidden')).toBe(false);
    expect(isWsErrorCode('NOT_AUTHORIZED')).toBe(false);
    expect(WS_ERROR_CODES.FORBIDDEN).not.toBe(WS_ERROR_CODES.ROOM_NOT_FOUND);
  });

  it('keeps codes stable and distinct from their messages', () => {
    for (const [key, value] of Object.entries(WS_ERROR_CODES)) {
      assert.equal(key, value);
      assert.match(value, /^[A-Z][A-Z_]*$/);
    }
  });
});
