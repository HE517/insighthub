/**
 * Right-hand status panel: proves the M0 acceptance criteria in the browser.
 *
 * Shows (a) the WebSocket transport state and the server-assigned connection
 * id from the `connected` handshake, and (b) the result of GET /health.
 */
import { Badge, Descriptions, Space, Tag, Typography } from 'antd';

import { SHARED_CONTRACT_VERSION, type ConnectionStatus } from '@insighthub/shared';

import type { HealthState } from '../../hooks/useServerHealth.js';
import { useAppSelector } from '../../store/hooks.js';

const STATUS_META: Record<
  ConnectionStatus,
  { badge: 'success' | 'processing' | 'default' | 'error' | 'warning'; label: string }
> = {
  idle: { badge: 'default', label: 'Idle' },
  connecting: { badge: 'processing', label: 'Connecting' },
  connected: { badge: 'success', label: 'Connected' },
  reconnecting: { badge: 'warning', label: 'Reconnecting' },
  offline: { badge: 'error', label: 'Offline' },
  error: { badge: 'error', label: 'Error' },
};

interface StatusPanelProps {
  health: HealthState;
}

export function StatusPanel({ health }: StatusPanelProps) {
  const { status, connectionId, attempt, lastError } = useAppSelector((state) => state.connection);
  const receivedCount = useAppSelector((state) => state.realtime.receivedCount);
  const meta = STATUS_META[status];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Descriptions
        size="small"
        column={1}
        title={
          <Space>
            <span>WebSocket</span>
            <Badge status={meta.badge} text={meta.label} />
          </Space>
        }
        items={[
          { key: 'connectionId', label: 'Connection ID', children: connectionId ?? '-' },
          { key: 'attempts', label: 'Attempts', children: attempt },
          { key: 'received', label: 'Messages received', children: receivedCount },
          {
            key: 'contract',
            label: 'Contract version',
            children: <Tag color="blue">v{SHARED_CONTRACT_VERSION}</Tag>,
          },
          { key: 'lastError', label: 'Last error', children: lastError ?? '-' },
        ]}
      />

      <Descriptions
        size="small"
        column={1}
        title={
          <Space>
            <span>GET /health</span>
            {health.status === 'ok' ? (
              <Badge status="success" text="200" />
            ) : health.status === 'loading' ? (
              <Badge status="processing" text="checking" />
            ) : (
              <Badge status="error" text="unreachable" />
            )}
          </Space>
        }
        items={[
          {
            key: 'status',
            label: 'Response',
            children:
              health.status === 'ok' ? (
                <Typography.Text code>{JSON.stringify(health.data)}</Typography.Text>
              ) : health.status === 'error' ? (
                <Typography.Text type="danger">{health.message}</Typography.Text>
              ) : (
                '...'
              ),
          },
        ]}
      />
    </Space>
  );
}
