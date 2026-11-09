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
    label: '未连接',
    localOnlyEdits: false,
    description: '尚未发起连接。',
  },
  connecting: {
    badge: 'processing',
    label: '连接中',
    localOnlyEdits: false,
    description: '正在打开协作通道。编辑功能已经可用。',
  },
  connected: {
    badge: 'success',
    label: '已连接',
    localOnlyEdits: false,
    description: '已连接到文档房间；断线恢复后会自动追平，并继续把编辑同步给协作者。',
  },
  reconnecting: {
    badge: 'warning',
    label: '重连中',
    localOnlyEdits: true,
    description: '同步已暂停。编辑内容保存在本地，重连后会合并。',
  },
  offline: {
    badge: 'error',
    label: '离线',
    localOnlyEdits: true,
    description: '正在离线工作。编辑内容保存在本地，网络恢复后会合并。',
  },
  error: {
    badge: 'error',
    label: '连接中断',
    localOnlyEdits: true,
    description: '连接报告了错误。编辑会继续，更改暂存在本地。',
  },
};

/** The notice text, or `null` when there is nothing the user needs to know. */
export function offlineNoticeText(status: ConnectionStatus): string | null {
  const presentation = CONNECTION_PRESENTATION[status];
  if (!presentation.localOnlyEdits) return null;
  return `${presentation.label} — 编辑继续可用；更改保存在本地，重连后会合并。`;
}

/** Whether the peer list is still meaningful (i.e. presence may be stale). */
export function presenceMayBeStale(status: ConnectionStatus): boolean {
  return status === 'offline' || status === 'reconnecting' || status === 'error';
}

/** Re-exported so a component never needs to import the shared helper directly. */
export { isTransitionalStatus };
