import { z } from 'zod';

import { wsErrorCodeSchema, type WsErrorCode } from './errors.js';
import { documentRoleSchema } from './permission.js';

/**
 * WebSocket CONTROL-PLANE protocol for the InsightHub collaboration channel.
 *
 * See `docs/ARCHITECTURE.md` §5 for the two-plane model:
 *
 * - **Control plane (TEXT frames)** — this file. JSON envelope below. Carries
 *   `connected`, `join-room`, `room-joined`, `leave-room`, `error`. (The M1-plan
 *   `presence` message was removed by M1-A0.1 — see `PRESENCE_SOURCE_OF_TRUTH`.)
 * - **Data plane (BINARY frames)** — `binary-frame.ts`. Carries Yjs sync and
 *   awareness as raw binary; never base64-wrapped into this JSON envelope.
 *
 * Transport shape (all control messages, both directions):
 *
 *   { type, payload, requestId?, ts }
 *
 * Rules:
 * - `requestId` is only present on messages that are part of a
 *   request/response pair (echoed back so the caller can match them).
 * - `payload` is always an object; never a bare primitive.
 * - Unknown `type` values are rejected by parsers instead of being ignored
 *   silently, so protocol drift shows up in tests rather than in production.
 */

/**
 * Version of the WebSocket control protocol.
 *
 * Bumped 1 → 2 by M1-A0: the protocol gained the binary data plane (Yjs sync and
 * awareness frames) and grew from a handshake into a real collaboration
 * transport. A peer that does not speak this exact version must be rejected with
 * `PROTOCOL_VERSION_MISMATCH` rather than talking past us.
 */
export const PROTOCOL_VERSION = 2;

/** Discriminator values, in one place so both sides use the same strings. */
export const WS_MESSAGE_TYPES = {
  /** server -> client: handshake accepted. M0 deliverable. */
  connected: 'connected',
  /** client -> server: join a document room. M1. */
  joinRoom: 'join-room',
  /** server -> client: room joined (or atomically replaced). M1. */
  roomJoined: 'room-joined',
  /** client -> server: leave a document room. M1. */
  leaveRoom: 'leave-room',
  /** server -> client: server-side failure. */
  error: 'error',
} as const;

export type WsMessageType = (typeof WS_MESSAGE_TYPES)[keyof typeof WS_MESSAGE_TYPES];

/**
 * Room cardinality rule (frozen by M1-A0.1).
 *
 * **One socket carries at most ONE active document room.**
 *
 * This is forced by the data plane, not a preference: binary Yjs frames carry no
 * `documentId`, so the room is implied by the socket. Allowing two concurrent
 * rooms on one socket would make every binary frame ambiguous.
 *
 * The chosen transition when `join-room(B)` arrives while the socket is already in
 * room A is **atomic replace**: the server leaves A and joins B in one step, then
 * answers with B's `room-joined`. See `docs/CONTRACTS.md` §5.4 for the full rule.
 */
export const ROOM_CARDINALITY = {
  /** At most one active room per socket. */
  maxActiveRoomsPerSocket: 1,
  /** `join-room` for a second document atomically replaces the current room. */
  joinWhileInRoom: 'atomic-replace',
} as const;

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

/** Sent by the server immediately after a socket is accepted. */
export const connectedPayloadSchema = z.object({
  /** Connection id assigned by the server; useful in logs and M1 debugging. */
  connectionId: z.string().min(1),
  /** Protocol version; clients refuse to speak a version they do not know. */
  protocolVersion: z.literal(PROTOCOL_VERSION),
  /** Server time (ISO 8601) so clients can measure clock skew. */
  serverTime: z.string().datetime(),
});

export type ConnectedPayload = z.infer<typeof connectedPayloadSchema>;

export const joinRoomPayloadSchema = z.object({
  documentId: z.string().min(1),
  /**
   * Protocol version the client speaks.
   *
   * Deliberately a **structural** check only (`int >= 0`), not
   * `z.literal(PROTOCOL_VERSION)`. A literal here makes `PROTOCOL_VERSION_MISMATCH`
   * unreachable on the wire: the shared parser would reject an older or newer peer as a
   * *malformed* message, so every version disagreement would collapse into
   * `INVALID_MESSAGE` and hide the one fact the peer needs — "you speak N, I speak 2".
   * The server compares this value against `PROTOCOL_VERSION` and answers with the
   * specific code (`docs/DECISIONS.md` D-028).
   *
   * A non-integer (string, null, missing) is still a structural fault and is rejected
   * here as `INVALID_MESSAGE`: that is a malformed envelope, not an unsupported version.
   */
  protocolVersion: z.number().int().nonnegative(),
  /**
   * How the client intends to open the document. `readonly` is reserved for the
   * M2 permission work; M1 clients always send `readwrite`.
   */
  mode: z.enum(['readonly', 'readwrite']).default('readwrite'),
});

export type JoinRoomPayload = z.infer<typeof joinRoomPayloadSchema>;

export const roomJoinedPayloadSchema = z.object({
  documentId: z.string().min(1),
  /** Server's authoritative connection id for this socket. */
  connectionId: z.string().min(1),
  /**
   * Connection ids of peers already in the room (excluding self).
   *
   * This is the **initial** roster only. Ongoing collaborator presence is NOT
   * carried by control-plane messages — it comes from Yjs awareness, which is the
   * single source of truth for ephemeral presence (`docs/CONTRACTS.md` §9).
   */
  peers: z.array(z.string()),
  /**
   * The caller's own role in this document (`docs/CONTRACTS.md` §5.2, §17.5).
   *
   * Required rather than optional: the server has already resolved a membership before it
   * admits the caller, so a successful `join-room` cannot leave the role unknown.
   *
   * **It carries no authority.** The client uses it to decide which controls to enable —
   * UI gating only. Every enforcement point asks the server again: the join gate, the
   * BINARY `SYNC` mutation gate and the HTTP document routes all resolve the role from the
   * server-side membership. A client that rewrites this field in memory changes only what it
   * shows itself; it gains nothing, because the role is never sent back up and the server
   * never reads a role from the wire (`docs/ARCHITECTURE.md` §8.3).
   */
  role: documentRoleSchema,
});

export type RoomJoinedPayload = z.infer<typeof roomJoinedPayloadSchema>;

export const leaveRoomPayloadSchema = z.object({
  documentId: z.string().min(1),
});

export type LeaveRoomPayload = z.infer<typeof leaveRoomPayloadSchema>;

/**
 * NOTE (M1-A0.1): the M0/M1-plan `presence` control message was **removed**.
 *
 * Ephemeral presence — identity, cursor, selection, who is online — has exactly
 * one source of truth: **Yjs awareness** over the binary data plane. A second
 * control-plane presence channel would be a competing truth for the same fact:
 * the two could disagree (awareness says gone, presence says joined), and the UI
 * would have to pick a winner. The server therefore removes a departing client's
 * awareness entry and broadcast that removal, which is what peers observe.
 *
 * Room membership counts remain server-side room-registry state and need no
 * message. `room-joined.peers` provides the initial roster.
 */
export const PRESENCE_SOURCE_OF_TRUTH = 'yjs-awareness' as const;

export const wsErrorPayloadSchema = z.object({
  /** Frozen vocabulary from `errors.ts`; the code is the contract. */
  code: wsErrorCodeSchema,
  /** Human-facing text. Must never contain a stack trace or internal path. */
  message: z.string().min(1),
  /** Set when the failing message was correlated with a request. */
  requestId: z.string().min(1).optional(),
});

export type WsErrorPayload = z.infer<typeof wsErrorPayloadSchema>;

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

const envelopeBase = {
  requestId: z.string().min(1).optional(),
  ts: z.string().datetime(),
};

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(WS_MESSAGE_TYPES.joinRoom),
    payload: joinRoomPayloadSchema,
    ...envelopeBase,
  }),
  z.object({
    type: z.literal(WS_MESSAGE_TYPES.leaveRoom),
    payload: leaveRoomPayloadSchema,
    ...envelopeBase,
  }),
]);

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(WS_MESSAGE_TYPES.connected),
    payload: connectedPayloadSchema,
    ...envelopeBase,
  }),
  z.object({
    type: z.literal(WS_MESSAGE_TYPES.roomJoined),
    payload: roomJoinedPayloadSchema,
    ...envelopeBase,
  }),
  z.object({
    type: z.literal(WS_MESSAGE_TYPES.error),
    payload: wsErrorPayloadSchema,
    ...envelopeBase,
  }),
]);

export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

/** Either direction, for tests and generic helpers. */
export const wsMessageSchema = z.union([wsServerMessageSchema, wsClientMessageSchema]);
export type WsMessage = z.infer<typeof wsMessageSchema>;

/** Narrow a parsed client message to a specific `type`. */
export function isWsMessageOfType<T extends WsMessageType>(
  message: WsMessage,
  type: T,
): message is Extract<WsMessage, { type: T }> {
  return message.type === type;
}

/* ------------------------------------------------------------------ *
 * Builders / parsers
 * ------------------------------------------------------------------ */

export interface CreateEnvelopeOptions {
  requestId?: string;
  ts?: string;
}

/** Wrap a payload in the standard envelope. `ts` defaults to now. */
export function createEnvelope<const T extends WsMessageType, P>(
  type: T,
  payload: P,
  options: CreateEnvelopeOptions = {},
): { type: T; payload: P; requestId?: string; ts: string } {
  return {
    type,
    payload,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ts: options.ts ?? new Date().toISOString(),
  };
}

export interface ParseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function parseWith<S extends z.ZodTypeAny>(schema: S, raw: unknown): ParseResult<z.infer<S>> {
  const result = schema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; '),
  };
}

/** Parse an inbound server message. Never throws. */
export function parseServerMessage(raw: unknown): ParseResult<WsServerMessage> {
  return parseWith(wsServerMessageSchema, raw);
}

/** Parse an inbound client message on the server. Never throws. */
export function parseClientMessage(raw: unknown): ParseResult<WsClientMessage> {
  return parseWith(wsClientMessageSchema, raw);
}

/** Parse a JSON string then validate it. Never throws. */
export function parseMessageJson(raw: string): ParseResult<WsMessage> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { success: false, error: 'invalid JSON payload' };
  }
  return parseWith(wsMessageSchema, decoded);
}

/** Convenience builder for the M0 handshake message. */
export function createConnectedMessage(
  connectionId: string,
  options: CreateEnvelopeOptions = {},
): Extract<WsServerMessage, { type: 'connected' }> {
  return createEnvelope(
    WS_MESSAGE_TYPES.connected,
    {
      connectionId,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: options.ts ?? new Date().toISOString(),
    },
    options,
  );
}

/**
 * Build an error message from the frozen vocabulary.
 *
 * Always use this instead of hand-writing `{ type: 'error', payload: {...} }`: it
 * keeps the code typed, so an invented error string is a compile error.
 */
export function createErrorMessage(
  code: WsErrorCode,
  message: string,
  options: CreateEnvelopeOptions = {},
): Extract<WsServerMessage, { type: 'error' }> {
  return createEnvelope(WS_MESSAGE_TYPES.error, { code, message }, options);
}

/** Build the `room-joined` acknowledgement for a client's successful join. */
export function createRoomJoinedMessage(
  payload: RoomJoinedPayload,
  options: CreateEnvelopeOptions = {},
): Extract<WsServerMessage, { type: 'room-joined' }> {
  return createEnvelope(WS_MESSAGE_TYPES.roomJoined, payload, options);
}
