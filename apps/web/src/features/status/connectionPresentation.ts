/**
 * Presentation vocabulary for the collaboration transport.
 *
 * Kept separate from the JSX (and therefore testable without a DOM) because the
 * *policy* in here is contractual, not cosmetic:
 *
 * - Offline is a normal state, not an error path (`AGENTS.md` R10).
 * - A session is editable regardless of `connectionStatus`; local state gates
 *   usability and the network never does (`docs/CONTRACTS.md` §10.1).
 *
 * The status keys are the shared `ConnectionStatus` union, so a new wire value
 * cannot appear without this table failing to compile — an exhaustive `Record`
 * is deliberate.
 */
import { isTransitionalStatus, type ConnectionStatus } from '@insighthub/shared';

export type BadgeStatus = 'success' | 'processing' | 'default' | 'error' | 'warning';

export interface ConnectionPresentation {
  badge: BadgeStatus;
  label: string;
  /**
   * `true` when the user's edits exist locally but are not yet shared with
   * collaborators. This is what the offline notice keys off, so the message can
   * never claim more durability than the layer actually provides.
   */
  localOnlyEdits: boolean;
  description: string;
}

export const CONNECTION_PRESENTATION: Record<ConnectionStatus, ConnectionPresentation> = {
  idle: {
    badge: 'default',
    label: 'Idle',
    localOnlyEdits: false,
    description: 'No connection attempt has been made yet.',
  },
  connecting: {
    badge: 'processing',
    label: 'Connecting',
    localOnlyEdits: false,
    description: 'Opening the collaboration channel. Editing is already available.',
  },
  connected: {
    badge: 'success',
    label: 'Live',
    localOnlyEdits: false,
    description: 'Connected to the document room; edits are syncing to collaborators.',
  },
  reconnecting: {
    badge: 'warning',
    label: 'Reconnecting',
    localOnlyEdits: true,
    description: 'Syncing paused. Edits are saved locally and merge on reconnect.',
  },
  offline: {
    badge: 'error',
    label: 'Offline',
    localOnlyEdits: true,
    description: 'Working offline. Edits are stored locally and merge when the network returns.',
  },
  error: {
    badge: 'error',
    label: 'Connection error',
    localOnlyEdits: true,
    description: 'The channel reported an error. Editing continues and edits stay local.',
  },
};

/** The notice text, or `null` when there is nothing the user needs to know. */
export function offlineNoticeText(status: ConnectionStatus): string | null {
  const presentation = CONNECTION_PRESENTATION[status];
  if (!presentation.localOnlyEdits) return null;
  return `${presentation.label} — editing continues; changes are stored locally and merge on reconnect.`;
}

/** Whether the peer list is still meaningful (i.e. presence may be stale). */
export function presenceMayBeStale(status: ConnectionStatus): boolean {
  return status === 'offline' || status === 'reconnecting' || status === 'error';
}

/** Re-exported so a component never needs to import the shared helper directly. */
export { isTransitionalStatus };
