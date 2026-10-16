import { z } from 'zod';

/**
 * WebSocket / collaboration error vocabulary.
 *
 * Frozen by M1-A0 so that A1 (client), A3 (server) and A2 (editor UI) all react
 * to the same codes instead of each inventing their own strings.
 *
 * Rules:
 * - Codes are SCREAMING_SNAKE_CASE and stable; the code is the contract, the
 *   `message` is human-facing text that may change freely.
 * - Never send a stack trace, file path, SQL fragment or internal identifier to
 *   a client. Log the detail server-side; send a code plus a short message.
 */

export const WS_ERROR_CODES = {
  /** Frame/payload was not parseable as the declared message type. */
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  /** Well-formed payload with a `type` this build does not implement. */
  UNKNOWN_MESSAGE_TYPE: 'UNKNOWN_MESSAGE_TYPE',
  /** A binary frame could not be decoded, or was truncated/trailing garbage. */
  INVALID_BINARY_FRAME: 'INVALID_BINARY_FRAME',
  /** Binary frame exceeded the negotiated maximum size. */
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  /** Binary collaboration data arrived before a successful `join-room`. */
  ROOM_NOT_JOINED: 'ROOM_NOT_JOINED',
  /**
   * The requested document room does not exist.
   * M1 has no persisted document store, so in M1 this code means "the server
   * refused to open a room for this documentId" (e.g. unknown id after M2 adds a
   * store). It is reserved now so M2 does not need a new vocabulary.
   */
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  /** Client and server disagree on `PROTOCOL_VERSION`. */
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  /** Any unexpected server-side failure. Details go to the server log only. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type WsErrorCode = (typeof WS_ERROR_CODES)[keyof typeof WS_ERROR_CODES];

export const WS_ERROR_CODE_VALUES = Object.values(WS_ERROR_CODES) as [
  WsErrorCode,
  ...WsErrorCode[],
];

export const wsErrorCodeSchema = z.enum(WS_ERROR_CODE_VALUES);

/** True when `value` is one of the frozen error codes. */
export function isWsErrorCode(value: unknown): value is WsErrorCode {
  return wsErrorCodeSchema.safeParse(value).success;
}

/**
 * Codes a client should treat as fatal for the current socket: the peer cannot
 * continue on this connection, so reconnecting (or surfacing the failure) is the
 * only sensible reaction.
 */
const FATAL_CODES: ReadonlySet<WsErrorCode> = new Set<WsErrorCode>([
  WS_ERROR_CODES.PROTOCOL_VERSION_MISMATCH,
  WS_ERROR_CODES.INVALID_MESSAGE,
  WS_ERROR_CODES.INVALID_BINARY_FRAME,
  WS_ERROR_CODES.FRAME_TOO_LARGE,
  WS_ERROR_CODES.UNKNOWN_MESSAGE_TYPE,
]);

export function isFatalErrorCode(code: WsErrorCode): boolean {
  return FATAL_CODES.has(code);
}
