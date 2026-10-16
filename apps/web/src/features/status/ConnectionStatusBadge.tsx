/**
 * Connection / offline affordances.
 *
 * Two rules from the frozen contract shape this file:
 *
 * - **Offline is a normal state, not an error path** (`AGENTS.md` R10). The
 *   notice says so, and the editor stays editable; nothing here disables input.
 * - **The network never gates the editor** (`docs/CONTRACTS.md` §10.1). Local
 *   state makes a session `active`, so a session is fully usable with the socket
 *   down. Everything rendered here is informational.
 *
 * All policy lives in `connectionPresentation.ts`; this file only renders it.
 */
import { Badge, Space, Tooltip, Typography } from 'antd';

import { isTransitionalStatus, type ConnectionStatus } from '@insighthub/shared';

import { CONNECTION_PRESENTATION, offlineNoticeText } from './connectionPresentation.js';

export interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  /** Replaces the default description in the tooltip when supplied. */
  detail?: string;
}

export function ConnectionStatusBadge({ status, detail }: ConnectionStatusBadgeProps) {
  const presentation = CONNECTION_PRESENTATION[status];
  const label = (
    <Space size={6} align="center" data-testid="connection-status" data-status={status}>
      <Badge status={presentation.badge} />
      <Typography.Text strong={status === 'connected'}>{presentation.label}</Typography.Text>
      {presentation.localOnlyEdits && isTransitionalStatus(status) ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          editing locally
        </Typography.Text>
      ) : null}
    </Space>
  );

  return <Tooltip title={detail ?? presentation.description}>{label}</Tooltip>;
}

/**
 * The standalone offline notice.
 *
 * Rendered only for statuses where the user's edits exist locally but are not yet
 * shared, so the message is never a lie about durability.
 */
export function OfflineNotice({ status }: { status: ConnectionStatus }) {
  const text = offlineNoticeText(status);
  if (text === null) return null;

  return (
    <div className="offline-notice" data-testid="offline-notice" role="status">
      <Typography.Text>{text}</Typography.Text>
    </div>
  );
}
