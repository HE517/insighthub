/**
 * App shell for M0.
 *
 * Layout only: a CodeMirror markdown surface on the left, live transport
 * status on the right. No business features (AI, RBAC, collaboration) yet.
 */
import { Card, Layout, Space, Typography } from 'antd';

import { MarkdownEditor } from './features/editor/MarkdownEditor.js';
import { MessageLog } from './features/status/MessageLog.js';
import { StatusPanel } from './features/status/StatusPanel.js';
import { useRealtimeChannel } from './hooks/useRealtimeChannel.js';
import { useServerHealth } from './hooks/useServerHealth.js';

export function App() {
  useRealtimeChannel();
  const health = useServerHealth();

  return (
    <Layout className="app-shell">
      <Layout.Header className="app-header">
        <Typography.Title level={4} className="app-title">
          InsightHub
        </Typography.Title>
        <Typography.Text className="app-subtitle">
          M0 Bootstrap · knowledge base & AI assistant platform
        </Typography.Text>
      </Layout.Header>

      <Layout.Content className="app-content">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            左侧为 CodeMirror 6 Markdown 编辑器占位实现，右侧为 WebSocket 与 /health 的实时状态。
            Yjs 协作、AI 建议与权限控制将在 M1 及之后接入。
          </Typography.Paragraph>

          <div className="app-grid">
            <Card title="Document" size="small" className="app-card">
              <MarkdownEditor />
            </Card>

            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Card size="small" className="app-card">
                <StatusPanel health={health} />
              </Card>
              <Card title="Server messages" size="small" className="app-card">
                <MessageLog />
              </Card>
            </Space>
          </div>
        </Space>
      </Layout.Content>
    </Layout>
  );
}
