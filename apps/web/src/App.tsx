/**
 * App shell (M1).
 *
 * Layout: the collaborative CodeMirror surface in the main column, presence and
 * transport chrome to the side. The document body lives **only** in `Y.Text` —
 * this component holds no text state and dispatches no text.
 *
 * ## Socket ownership (M1-A0.2, R15)
 *
 * The **only** document realtime connection in the running app is the one inside
 * `CollaborativeSession`, reached through `DocumentWorkspace`. The M0 handshake hook
 * (`useRealtimeChannel`) is deliberately **not mounted here**: it opened a second `/ws`
 * socket on the same origin, and one socket carries at most one room
 * (`docs/CONTRACTS.md` §5.4), so a second connection would either be rejected or split
 * the app across two transports. The connection state shown to the user comes from the
 * live session (`ConnectionStatusBadge` in `DocumentWorkspace`), never from a parallel
 * channel.
 *
 * `useServerHealth` remains: it is a plain HTTP `GET /health` poll, opens no socket, and
 * is the backend-liveness indicator.
 */
import { Card, Input, Layout, Space, Tag, Typography } from 'antd';

import { DocumentWorkspace } from './features/editor/DocumentWorkspace.js';
import { StatusPanel } from './features/status/StatusPanel.js';
import { useServerHealth } from './hooks/useServerHealth.js';
import { documentActions } from './store/documentSlice.js';
import { useAppDispatch, useAppSelector } from './store/hooks.js';
import { demoUser } from './user.js';

export function App() {
  // HTTP-only backend liveness probe. No WebSocket: the session owns the document socket.
  const health = useServerHealth();

  const dispatch = useAppDispatch();
  const activeDocumentId = useAppSelector((state) => state.document.activeDocumentId);
  const pendingDocumentId = useAppSelector((state) => state.document.pendingDocumentId);
  const role = useAppSelector((state) => state.document.role);

  return (
    <Layout className="app-shell">
      <Layout.Header className="app-header">
        <Typography.Title level={4} className="app-title">
          InsightHub
        </Typography.Title>
        <Typography.Text className="app-subtitle">
          M1 Collaboration · CodeMirror ⇄ Y.Text
        </Typography.Text>
      </Layout.Header>

      <Layout.Content className="app-content">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div className="document-bar">
            <Space size={8} align="center" wrap>
              <Typography.Text type="secondary">Document</Typography.Text>
              <Input
                size="small"
                style={{ width: 260 }}
                value={pendingDocumentId}
                aria-label="Document id"
                onChange={(event) =>
                  dispatch(documentActions.pendingDocumentIdChanged(event.target.value))
                }
                onPressEnter={() => dispatch(documentActions.documentSelected(pendingDocumentId))}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Enter to switch · the previous room is torn down first
              </Typography.Text>
            </Space>
            <Tag color="blue" data-testid="active-document">
              {activeDocumentId}
            </Tag>
          </div>

          <div className="app-grid">
            {/*
              `key` is load-bearing: a different document must be a different
              component instance, so the previous session is destroyed before the
              next one exists. One socket carries at most one room
              (docs/CONTRACTS.md §5.4).
            */}
            <DocumentWorkspace
              key={activeDocumentId}
              documentId={activeDocumentId}
              user={demoUser}
              role={role}
            />

            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Card size="small" className="app-card">
                <StatusPanel health={health} />
              </Card>
              {/*
                The M0 "Server messages" card is intentionally not rendered: it displayed
                frames from the legacy `useRealtimeChannel` socket, which is no longer
                mounted. The document socket's traffic belongs to the session and surfaces
                as connection status inside `DocumentWorkspace`, not as a raw frame log.
              */}
            </Space>
          </div>
        </Space>
      </Layout.Content>
    </Layout>
  );
}
