/**
 * Raw protocol traffic log.
 *
 * The M0 acceptance criterion is "the server can send a `connected` message",
 * so the UI shows the exact frames that arrived - not a friendly paraphrase.
 */
import { Empty, List, Tag, Typography } from 'antd';

import { WS_MESSAGE_TYPES } from '@insighthub/shared';

import { useAppSelector } from '../../store/hooks.js';

export function MessageLog() {
  const messages = useAppSelector((state) => state.realtime.messages);

  if (messages.length === 0) {
    return <Empty description="No server message yet" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <List
      size="small"
      dataSource={messages}
      renderItem={(message) => (
        <List.Item>
          <div style={{ width: '100%' }}>
            <Typography.Text strong>{message.type}</Typography.Text>{' '}
            {message.type === WS_MESSAGE_TYPES.connected ? (
              <Tag color="green">handshake</Tag>
            ) : null}
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              {message.ts}
            </Typography.Text>
            <pre className="message-json">{JSON.stringify(message, null, 2)}</pre>
          </div>
        </List.Item>
      )}
    />
  );
}
