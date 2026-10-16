import { z } from 'zod';

/**
 * Transport-level connection state for the collaboration channel.
 *
 * Shared on purpose: the server reports it, the client renders it, and M1 will
 * drive reconnect/offline UX from exactly these values.
 */
export const CONNECTION_STATUSES = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'offline',
  'error',
] as const;

export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

/** True while the client is neither live nor deliberately closed. */
export function isTransitionalStatus(status: ConnectionStatus): boolean {
  return status === 'connecting' || status === 'reconnecting';
}

/** True when local edits may exist that the server has not acknowledged yet. */
export function canEditWhile(status: ConnectionStatus): boolean {
  return status !== 'offline' && status !== 'error';
}
