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
  idle: { badge: 'default', label: '未连接' },
  connecting: { badge: 'processing', label: '连接中' },
  connected: { badge: 'success', label: '已连接' },
  reconnecting: { badge: 'warning', label: '重连中' },
  offline: { badge: 'error', label: '离线' },
  error: { badge: 'error', label: '错误' },
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
          { key: 'connectionId', label: '连接 ID', children: connectionId ?? '-' },
          { key: 'attempts', label: '尝试次数', children: attempt },
          { key: 'received', label: '已接收消息', children: receivedCount },
          {
            key: 'contract',
            label: '合同版本',
            children: <Tag color="blue">v{SHARED_CONTRACT_VERSION}</Tag>,
          },
          { key: 'lastError', label: '最近错误', children: lastError ?? '-' },
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
              <Badge status="processing" text="检查中" />
            ) : (
              <Badge status="error" text="不可达" />
            )}
          </Space>
        }
        items={[
          {
            key: 'status',
            label: '响应',
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
