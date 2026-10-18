/**
 * The document workspace: session lifecycle → editor + presence chrome.
 *
 * ## States
 *
 * `CollaborativeSessionResult` is a discriminated union, so this component
 * narrows on `result.state` and never has to check for a nullable session:
 *
 * | `result.state` | Rendered |
 * | --- | --- |
 * | `initializing` | a loading shell — no editor, because there is no `Y.Text` yet |
 * | `active` | the editor, bound to `result.session.text` |
 * | `failed` | an error shell with the reason, still no editor (never a fake one) |
 *
 * ## Document switching
 *
 * This component is remounted per `documentId` (the caller keys it), and the hook
 * owns session creation/teardown. That matters because of the frozen room
 * cardinality (`docs/CONTRACTS.md` §5.4): one socket carries at most one room, so
 * switching documents must destroy the old session rather than keep two alive.
 * A stale session can therefore never publish events into the new document's UI,
 * because the component that held it no longer exists.
 */
import { Alert, Card, Skeleton, Space, Tag, Typography } from 'antd';
import { useState } from 'react';

import type {
  CollaborativeSession,
  CollaborativeSessionOptions,
  DocumentRole,
} from '@insighthub/shared';

import { useCollaborativeDocument } from '../../collab/public.js';
import { capabilityGate } from '../permissions/capabilityGate.js';
import { CollaboratorList } from '../collaborators/CollaboratorList.js';
import { ConnectionStatusBadge, OfflineNotice } from '../status/ConnectionStatusBadge.js';
import { CollaborativeMarkdownEditor } from './CollaborativeMarkdownEditor.js';
import {
  useSessionCollaborators,
  useSessionConnectionStatus,
  useSessionUndoState,
} from './useCollaborativeSession.js';

export interface DocumentWorkspaceProps {
  documentId: string;
  user: CollaborativeSessionOptions['user'];
  /**
   * Role mirrored from the server for **UI gating only** (M2 owns the decision). `null` means the
   * server has not told us — offline, or no session yet — and the workspace stays fully usable.
   */
  role?: DocumentRole | null;
}

export function DocumentWorkspace({ documentId, user, role = null }: DocumentWorkspaceProps) {
  // The hook is A1's, reached only through the frozen `collab/public.ts` seam.
  const result = useCollaborativeDocument({ documentId, user });

  if (result.state === 'initializing') {
    return <SessionLoading documentId={documentId} />;
  }

  if (result.state === 'failed') {
    return (
      <Card size="small" className="app-card">
        <Alert
          type="error"
          showIcon
          message="This document could not be opened"
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text>{result.error}</Typography.Text>
              <Typography.Text type="secondary">
                Create the collaboration session again to retry. Local data already written by a
                previous session is kept.
              </Typography.Text>
            </Space>
          }
          data-testid="session-failed"
        />
      </Card>
    );
  }

  // `result.state === 'active'` — the only branch where `Y.Text` exists.
  return <ActiveDocument session={result.session} documentId={documentId} role={role} />;
}

function SessionLoading({ documentId }: { documentId: string }) {
  return (
    <Card size="small" className="app-card" data-testid="session-initializing">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Opening <Typography.Text code>{documentId}</Typography.Text> from local storage…
        </Typography.Text>
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      </Space>
    </Card>
  );
}

function ActiveDocument({
  session,
  documentId,
  role,
}: {
  session: CollaborativeSession;
  documentId: string;
  role: DocumentRole | null;
}) {
  const collaborators = useSessionCollaborators(session);
  const status = useSessionConnectionStatus(session);
  const undoState = useSessionUndoState(session);
  const [resyncReason, setResyncReason] = useState<string | null>(null);
  // The only permission input this component uses, and it comes from `documentCapabilities`
  // (`apps/web/src/features/permissions/capabilityGate.ts`). Advisory only: the server decides
  // (`docs/ARCHITECTURE.md` §8.2), and the editor is never made unusable by a UI guess — while the
  // role is unknown the gate reports `readOnly: false`.
  const gate = capabilityGate(role);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        size="small"
        className="app-card"
        title={
          <Space size={10} wrap>
            <Typography.Text strong>{documentId}</Typography.Text>
            <ConnectionStatusBadge status={status} />
            {gate.role === null ? null : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                role: {gate.role}
              </Typography.Text>
            )}
            {gate.readOnly ? (
              <Tag color="orange" data-testid="read-only-notice">
                read-only
              </Tag>
            ) : null}
          </Space>
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <OfflineNotice status={status} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="undo-state">
            undo: {undoState.canUndo ? 'available' : 'none'} · redo:{' '}
            {undoState.canRedo ? 'available' : 'none'}
          </Typography.Text>
          {resyncReason === null ? null : (
            <Alert
              type="warning"
              showIcon
              message="The editor was resynchronised from the document"
              description={`reason: ${resyncReason}`}
              data-testid="editor-resync"
            />
          )}
        </Space>
      </Card>

      <Card title="Collaborators" size="small" className="app-card">
        <CollaboratorList collaborators={collaborators} localClientId={session.localClientId} />
      </Card>

      <Card title="Document" size="small" className="app-card">
        <CollaborativeMarkdownEditor session={session} onResync={setResyncReason} />
      </Card>
    </Space>
  );
}
