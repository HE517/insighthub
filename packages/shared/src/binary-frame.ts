import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

import { WS_ERROR_CODES } from './errors.js';

/**
 * Binary data-plane framing (frozen by M1-A0).
 *
 * ## Why two planes
 *
 * The WebSocket carries two unrelated kinds of traffic:
 *
 * - **Control plane (TEXT frames)** — the JSON envelope in `protocol.ts`:
 *   `connected`, `join-room`, `room-joined`, `leave-room`, `presence`, `error`.
 *   Fits JSON, benefits from being human-readable in DevTools.
 * - **Data plane (BINARY frames)** — Yjs sync and awareness. These are already
 *   compact binary formats; base64-ing them into JSON would inflate every edit
 *   by ~33% and add a JSON parse per keystroke for no benefit.
 *
 * `ws` exposes the distinction for free: text frames arrive as `string`, binary
 * frames as `Buffer`/`ArrayBuffer`. So the two planes never need an in-band
 * discriminator between them.
 *
 * ## Frame layout
 *
 * ```
 * byte 0            : frameType   (varUint)  0 = SYNC, 1 = AWARENESS
 * bytes 1..n        : frame payload, whose shape depends on frameType
 * ```
 *
 * - **SYNC** payload is written entirely by `y-protocols/sync`. It begins with
 *   the y-protocols message type (varUint: 0 = SyncStep1, 1 = SyncStep2,
 *   2 = Update) and the rest is defined by that package. We deliberately do NOT
 *   re-implement that encoding — see `writeSyncStep1` / `writeSyncStep2` /
 *   `writeSyncUpdate` below, which delegate.
 * - **AWARENESS** payload is exactly the output of
 *   `awarenessProtocol.encodeAwarenessUpdate(awareness, clients)`, which has NO
 *   inner message-type prefix of its own (it starts with a varUint client count).
 *
 * Frame type values match the widely used `y-websocket` convention so the wire
 * format is not a private invention. Types 2 and 3 exist in that convention for
 * auth / query-awareness; they are rejected here because M1 has no auth and no
 * need for a separate awareness query.
 *
 * ## Validation
 *
 * Decoding never throws. Every failure maps to a frozen `WS_ERROR_CODES` value so
 * A1 and A3 report identical reasons:
 *
 * | Condition                                            | Outcome                       |
 * | ---                                                   | ---                           |
 * | no bytes                                              | `INVALID_BINARY_FRAME`        |
 * | frameType not in {0,1}                                | `INVALID_BINARY_FRAME`        |
 * | byteLength > `maxFrameBytes`                          | `FRAME_TOO_LARGE`             |
 * | SYNC inner message type not in {0,1,2}                | `INVALID_BINARY_FRAME`        |
 * | SYNC step1/step2/update with a truncated payload       | `INVALID_BINARY_FRAME`        |
 * | trailing bytes after the declared payload              | `INVALID_BINARY_FRAME`        |
 * | AWARENESS payload not decodable                        | `INVALID_BINARY_FRAME`        |
 *
 * Note the SYNC truncation check: `y-protocols`' `readSyncMessage` happily
 * returns a message type even when the payload is cut short, so an incomplete
 * frame would otherwise be silently accepted and applied as "no data".
 */

export const FRAME_TYPES = {
  /** Yjs document sync (state vector exchange + updates). */
  sync: 0,
  /** Ephemeral awareness (identity, cursor, selection). */
  awareness: 1,
} as const;

export type FrameType = (typeof FRAME_TYPES)[keyof typeof FRAME_TYPES];

/**
 * Frame types present in the `y-websocket` convention that InsightHub does NOT
 * implement in M1. They are named so a rejection is self-explanatory in logs and
 * tests rather than looking like an off-by-one.
 */
export const UNAUTHENTICATED_FRAME_TYPES = {
  auth: 2,
  queryAwareness: 3,
} as const;

/**
 * Maximum accepted binary frame size, in bytes (16 MiB — the same ceiling
 * `y-websocket` uses).
 *
 * Rationale: a Yjs update is proportional to how much was typed, so a
 * legitimate frame is normally kilobytes. 16 MiB will not reject a real document
 * snapshot but does bound memory per socket and turns a hostile frame into one
 * `FRAME_TOO_LARGE` error instead of an OOM. Callers may pass a smaller
 * `maxFrameBytes`; the limit is enforced against `byteLength`, i.e. before any
 * decode work happens.
 */
export const MAX_BINARY_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Minimum meaningful binary frame: one frame-type byte plus one payload byte.
 *
 * A 1-byte frame carries a frame type and nothing else, which is never a valid
 * SYNC or AWARENESS message. Rejecting it here keeps the "trailing bytes" check
 * unambiguous and stops a truncated frame from being read as an empty payload.
 */
export const MIN_BINARY_FRAME_BYTES = 2;

/** The name of the single `Y.Text` holding document content. Frozen: A1 and A2 share it. */
export const DOCUMENT_TEXT_KEY = 'content';

/**
 * Transaction origin tags.
 *
 * Yjs stamps each transaction with an `origin`. The distinction matters for two
 * reasons that M1 must get right:
 *
 * 1. `Y.UndoManager` must be constructed with `trackedOrigins: [local]` so a local
 *    undo never reverts a remote collaborator's edit.
 * 2. An update must not be echoed back to the connection it arrived from.
 */
export const TRANSACTION_ORIGINS = {
  /** A change made by this client's own editor. */
  local: 'insighthub:local',
  /** An update received over the network from a peer/server. */
  remote: 'insighthub:remote',
  /** A change replayed by the local IndexedDB provider during startup. */
  persistence: 'insighthub:persistence',
  /** A change applied by an accepted AI suggestion. */
  ai: 'insighthub:ai',
} as const;

export type TransactionOrigin = (typeof TRANSACTION_ORIGINS)[keyof typeof TRANSACTION_ORIGINS];

/** Origins a local undo is allowed to revert. Remote edits are never undone locally. */
export const UNDO_TRACKED_ORIGINS: readonly TransactionOrigin[] = [
  TRANSACTION_ORIGINS.local,
  TRANSACTION_ORIGINS.ai,
];

export type BinaryFrameDecodeOutcome =
  'ok' | typeof WS_ERROR_CODES.INVALID_BINARY_FRAME | typeof WS_ERROR_CODES.FRAME_TOO_LARGE;

export type DecodeBinaryFrameResult =
  | { success: true; frame: DecodedBinaryFrame; error?: undefined }
  | { success: false; frame?: undefined; error: BinaryFrameDecodeOutcome; detail?: string };

/** A validated SYNC frame, still in its original y-protocols wire encoding. */
export interface DecodedSyncFrame {
  kind: 'sync';
  /** Original bytes minus the frame-type header; pass to `readSyncMessage`. */
  bytes: Uint8Array;
}

/** A validated AWARENESS frame, still in its original wire encoding. */
export interface DecodedAwarenessFrame {
  kind: 'awareness';
  /** Original bytes minus the frame-type header; pass to `applyAwarenessUpdate`. */
  bytes: Uint8Array;
  /** Client ids mentioned by this update. */
  clients: number[];
}

export type DecodedBinaryFrame = DecodedSyncFrame | DecodedAwarenessFrame;

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

/**
 * Wrap an already-encoded y-protocols SYNC message in a frame.
 *
 * `writeSyncMessage` receives a fresh encoder positioned after the frame header,
 * so callers can use `syncProtocol.writeSyncStep1/2/Update` directly and stay on
 * the official encoding.
 */
export function encodeSyncFrame(writeSyncMessage: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, FRAME_TYPES.sync);
  writeSyncMessage(encoder);
  return encoding.toUint8Array(encoder);
}

/** SyncStep1: "here is my state vector, send me what I am missing". */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  return encodeSyncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, doc));
}

/**
 * SyncStep2: "here are the structs you are missing", computed either against a
 * peer's state vector or as a full snapshot when none is supplied.
 */
export function encodeSyncStep2(doc: Y.Doc, remoteStateVector?: Uint8Array): Uint8Array {
  return encodeSyncFrame((encoder) => syncProtocol.writeSyncStep2(encoder, doc, remoteStateVector));
}

/** A single incremental document update. */
export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  return encodeSyncFrame((encoder) => syncProtocol.writeUpdate(encoder, update));
}

/** Wrap an awareness update produced by `encodeAwarenessUpdate`. */
export function encodeAwarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, FRAME_TYPES.awareness);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

/** Byte length of a value encoded as a lib0 varUint (used for size estimation). */
export function varUintByteLength(value: number): number {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, value);
  return encoding.length(encoder);
}

/** Exact wire size of an encoded frame, including the frame-type header. */
export function frameByteLength(frame: Uint8Array): number {
  return frame.byteLength;
}

function fail(error: BinaryFrameDecodeOutcome, detail?: string): DecodeBinaryFrameResult {
  return detail === undefined ? { success: false, error } : { success: false, error, detail };
}

/**
 * Validate a raw binary frame. Never throws; never inspects more than
 * `maxFrameBytes` worth of input.
 */
export function decodeBinaryFrame(
  input: Uint8Array,
  options: { maxFrameBytes?: number } = {},
): DecodeBinaryFrameResult {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_BINARY_FRAME_BYTES;

  if (input.byteLength === 0) {
    return fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, 'empty frame');
  }
  if (input.byteLength < MIN_BINARY_FRAME_BYTES) {
    return fail(
      WS_ERROR_CODES.INVALID_BINARY_FRAME,
      `frame is ${input.byteLength} bytes, minimum is ${MIN_BINARY_FRAME_BYTES}`,
    );
  }
  if (input.byteLength > maxFrameBytes) {
    return fail(
      WS_ERROR_CODES.FRAME_TOO_LARGE,
      `frame is ${input.byteLength} bytes, limit is ${maxFrameBytes}`,
    );
  }

  const decoder = decoding.createDecoder(input);
  const frameType = decoding.readVarUint(decoder);

  if (frameType === FRAME_TYPES.sync) {
    return decodeSyncPayload(decoder, input);
  }
  if (frameType === FRAME_TYPES.awareness) {
    return decodeAwarenessPayload(input);
  }
  return fail(
    WS_ERROR_CODES.INVALID_BINARY_FRAME,
    `unsupported frame type ${frameType} (this build implements sync=0, awareness=1)`,
  );
}

/**
 * Read a lib0 length-prefixed byte array (`varUint` length + raw bytes).
 *
 * The decoder is advanced past the payload so the caller can detect trailing
 * bytes, and the payload is copied out so the frame buffer is not retained by
 * reference. Offsets are derived from cursor positions taken *before* each read —
 * `decoder.arr` is the buffer (not the remainder), so `arr.byteLength` is a total,
 * not a count of what is left.
 */
function readLengthPrefixedBytes(
  decoder: decoding.Decoder,
  label: string,
): { ok: true; bytes: Uint8Array } | { ok: false; result: DecodeBinaryFrameResult } {
  const beforeLengthPrefix = decoder.pos;
  let length: number;
  try {
    length = decoding.readVarUint(decoder);
  } catch {
    return {
      ok: false,
      result: fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, `${label} has no length prefix`),
    };
  }

  const payloadStart = decoder.pos;
  const available = decoder.arr.byteLength - payloadStart;
  if (length > available) {
    return {
      ok: false,
      result: fail(
        WS_ERROR_CODES.INVALID_BINARY_FRAME,
        `${label} payload is truncated (declared ${length}, ${available} available)`,
      ),
    };
  }

  const bytes = decoder.arr.slice(payloadStart, payloadStart + length);
  for (let index = 0; index < length; index += 1) {
    decoding.readUint8(decoder);
  }

  // The length prefix must have consumed at least one byte; a zero-length prefix
  // read would mean `readVarUint` silently returned without advancing.
  if (payloadStart <= beforeLengthPrefix) {
    return {
      ok: false,
      result: fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, `${label} length prefix is invalid`),
    };
  }

  return { ok: true, bytes };
}

function decodeSyncPayload(decoder: decoding.Decoder, input: Uint8Array): DecodeBinaryFrameResult {
  // Offset of the sync message type, captured before consuming it.
  const messageTypeOffset = decoder.pos;

  let messageType: number;
  try {
    messageType = decoding.readVarUint(decoder);
  } catch {
    return fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, 'sync frame has no message type');
  }

  const step1 = syncProtocol.messageYjsSyncStep1;
  const step2 = syncProtocol.messageYjsSyncStep2;
  const update = syncProtocol.messageYjsUpdate;

  if (messageType !== step1 && messageType !== step2 && messageType !== update) {
    return fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, `unknown sync message type ${messageType}`);
  }

  const read = readLengthPrefixedBytes(decoder, 'sync frame');
  if (!read.ok) return read.result;

  if (decoding.hasContent(decoder)) {
    return fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, 'sync frame has trailing bytes');
  }

  // Hand y-protocols exactly what `readSyncMessage` expects: a decoder positioned
  // at the sync message type.
  return { success: true, frame: { kind: 'sync', bytes: input.subarray(messageTypeOffset) } };
}

function decodeAwarenessPayload(input: Uint8Array): DecodeBinaryFrameResult {
  const decoder = decoding.createDecoder(input);
  decoding.readVarUint(decoder); // frame type, already known

  const read = readLengthPrefixedBytes(decoder, 'awareness frame');
  if (!read.ok) return read.result;

  if (decoding.hasContent(decoder)) {
    return fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, 'awareness frame has trailing bytes');
  }

  const payload = read.bytes;

  // `encodeAwarenessUpdate` has no inner message type, so structural validation
  // is a full decode pass: count, then (clientID, clock, JSON state) per entry.
  //
  // The state is written with lib0's `writeVarString` (a varUint length plus that
  // many bytes) — NOT with `writeAny`. `decoding.readAny` is a lookup-table tagged
  // format and throws on ordinary JSON, so `readVarString` is the correct reader.
  const clients: number[] = [];
  try {
    const inner = decoding.createDecoder(payload);
    const count = decoding.readVarUint(inner);
    for (let index = 0; index < count; index += 1) {
      clients.push(decoding.readVarUint(inner));
      decoding.readVarUint(inner);
      const json = decoding.readVarString(inner);
      JSON.parse(json); // the state is JSON text; reject a payload that is not
    }
    if (decoding.hasContent(inner)) {
      return fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, 'awareness update has trailing bytes');
    }
  } catch {
    return fail(WS_ERROR_CODES.INVALID_BINARY_FRAME, 'awareness update is malformed');
  }

  return { success: true, frame: { kind: 'awareness', bytes: payload, clients } };
}

/** True when `input` looks like a binary collaboration frame (not a text frame). */
export function isBinaryFrame(input: unknown): input is Uint8Array {
  return input instanceof Uint8Array;
}
