import { z } from 'zod';

/**
 * WebSocket protocol for the InsightHub collaboration channel.
 *
 * Transport shape (all messages, both directions):
 *
 *   { type, payload, requestId?, ts }
 *
 * Rules:
 * - `requestId` is only present on messages that are part of a
 *   request/response pair (echoed back so the caller can match them).
 * - `payload` is always an object; never a bare primitive.
 * - Unknown `type` values are rejected by parsers instead of being ignored
 *   silently, so protocol drift shows up in tests rather than in production.
 *
 * M0 only defines the handshake (`connected`) plus the room-join/lifecycle
 * messages M1 needs. Binary Yjs sync frames are a separate transport concern
 * and are deliberately NOT part of this JSON envelope.
 */

/** Discriminator values, in one place so both sides use the same strings. */
export const WS_MESSAGE_TYPES = {
  /** server -> client: handshake accepted. M0 deliverable. */
  connected: 'connected',
  /** client -> server: join a document room. M1. */
  joinRoom: 'join-room',
  /** server -> client: room joined, carries current revision. M1. */
  roomJoined: 'room-joined',
  /** client -> server: leave a document room. M1. */
  leaveRoom: 'leave-room',
  /** server -> client: peer presence changed. M1. */
  presence: 'presence',
  /** server -> client: server-side failure. */
  error: 'error',
} as const;

export type WsMessageType = (typeof WS_MESSAGE_TYPES)[keyof typeof WS_MESSAGE_TYPES];

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

/** Sent by the server immediately after a socket is accepted. */
export const connectedPayloadSchema = z.object({
  /** Connection id assigned by the server; useful in logs and M1 debugging. */
  connectionId: z.string().min(1),
  /** Protocol version; clients refuse to speak a version they do not know. */
  protocolVersion: z.literal(1),
  /** Server time (ISO 8601) so clients can measure clock skew. */
  serverTime: z.string().datetime(),
});

export type ConnectedPayload = z.infer<typeof connectedPayloadSchema>;

export const joinRoomPayloadSchema = z.object({
  documentId: z.string().min(1),
  /** Last revision the client already has; lets the server compute a delta. M1. */
  lastKnownRevision: z.number().int().nonnegative().optional(),
});

export type JoinRoomPayload = z.infer<typeof joinRoomPayloadSchema>;

export const roomJoinedPayloadSchema = z.object({
  documentId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  /** Connection ids of peers already in the room (excluding self). */
  peers: z.array(z.string()),
});

export type RoomJoinedPayload = z.infer<typeof roomJoinedPayloadSchema>;

export const leaveRoomPayloadSchema = z.object({
  documentId: z.string().min(1),
});

export type LeaveRoomPayload = z.infer<typeof leaveRoomPayloadSchema>;

export const presencePayloadSchema = z.object({
  documentId: z.string().min(1),
  connectionId: z.string().min(1),
  state: z.enum(['joined', 'left']),
});

export type PresencePayload = z.infer<typeof presencePayloadSchema>;

export const wsErrorPayloadSchema = z.object({
  code: z.string().min(1),
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
    type: z.literal(WS_MESSAGE_TYPES.presence),
    payload: presencePayloadSchema,
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
      protocolVersion: 1 as const,
      serverTime: options.ts ?? new Date().toISOString(),
    },
    options,
  );
}
