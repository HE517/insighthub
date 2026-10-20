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
 *
 * ## Permission gating (M2 Phase 2, closes A7 F1)
 *
 * The role is read from the **session**, through `useSessionRole` → `session.getRole()`
 * (`docs/CONTRACTS.md` §17.9). There is no role prop, no Redux field and no second parser of
 * `room-joined`: one source, one gate (`features/permissions/capabilityGate.ts`).
 *
 * | `getRole()` | editor | notice |
 * | --- | --- | --- |
 * | `owner` / `editor` | editable, exactly as before | none |
 * | `viewer` / `commenter` | read-only (`readOnly` compartment) | "Read-only for your role" |
 * | `null` (unknown) | **editable** — never locked out of unsent text (R10) | none |
 *
 * A demotion does not destroy the local document: the editor is reconfigured, not remounted,
 * so text already written to `Y.Text` stays there. The gate is advisory, not a security
 * boundary — the server rejects unauthorised mutations at every enforcement point (§17.5).
 */
import { Alert, Card, Skeleton, Space, Typography } from 'antd';
import { useState } from 'react';

import type { CollaborativeSession, CollaborativeSessionOptions } from '@insighthub/shared';

import { useCollaborativeDocument } from '../../collab/public.js';
import { capabilityGate } from '../permissions/capabilityGate.js';
import { ReadOnlyNotice } from '../permissions/ReadOnlyNotice.js';
import { CollaboratorList } from '../collaborators/CollaboratorList.js';
import { ConnectionStatusBadge, OfflineNotice } from '../status/ConnectionStatusBadge.js';
import { CollaborativeMarkdownEditor } from './CollaborativeMarkdownEditor.js';
import {
  useSessionCollaborators,
  useSessionConnectionStatus,
  useSessionRole,
  useSessionUndoState,
} from './useCollaborativeSession.js';

export interface DocumentWorkspaceProps {
  documentId: string;
  user: CollaborativeSessionOptions['user'];
}

export function DocumentWorkspace({ documentId, user }: DocumentWorkspaceProps) {
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
  return <ActiveDocument session={result.session} documentId={documentId} />;
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
}: {
  session: CollaborativeSession;
  documentId: string;
}) {
  const collaborators = useSessionCollaborators(session);
  const status = useSessionConnectionStatus(session);
  const undoState = useSessionUndoState(session);
  // The one and only permission input: the session's own answer, re-read on every session
  // notification (`useSessionRole` → `session.getRole()`). `null` = unknown, which the gate
  // treats as "keep editing" so an unknown role can never lock a user out (R10, §17.9).
  const role = useSessionRole(session);
  const [resyncReason, setResyncReason] = useState<string | null>(null);
  // The only permission *decision* this component makes, and it comes from `documentCapabilities`
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
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {/*
            The read-only explanation sits next to the surface it describes. It renders
            nothing unless a **known** role may not edit (`readOnlyNoticeCopy.ts` owns both
            the decision and the wording), and it never claims that anything was saved.
          */}
          <ReadOnlyNotice gate={gate} />
          <CollaborativeMarkdownEditor
            session={session}
            readOnly={gate.readOnly}
            onResync={setResyncReason}
          />
        </Space>
      </Card>
    </Space>
  );
}
