/**
 * Collaborator presence UI.
 *
 * Every value rendered here comes from `CollaboratorInfo[]` — i.e. from
 * `session.getCollaborators()`, the schema-validated accessor. Nothing in this
 * file touches `session.awareness.getStates()`, so an unvalidated (or hostile)
 * peer payload can never reach the DOM as a name or a colour
 * (`AGENTS.md` R14, `docs/CONTRACTS.md` §9.2).
 */
import { Avatar, Empty, Space, Tooltip, Typography } from 'antd';

import type { CollaboratorInfo } from '@insighthub/shared';

import { cursorLabel, initialsOf } from './collaboratorPresentation.js';
import { colorForClient } from '../editor/remoteCursors.js';

export interface CollaboratorListProps {
  collaborators: readonly CollaboratorInfo[];
  /** The local client id, so "you" is labelled instead of listed anonymously. */
  localClientId: number;
}

export function CollaboratorList({ collaborators, localClientId }: CollaboratorListProps) {
  if (collaborators.length === 0) {
    return (
      <Empty
        description="Only you are here"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        style={{ margin: 0 }}
      />
    );
  }

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }} data-testid="collaborator-list">
      {collaborators.map((collaborator) => {
        const color = collaborator.user.color ?? colorForClient(collaborator.clientId);
        const isSelf = collaborator.clientId === localClientId;
        const label = cursorLabel(collaborator.cursor?.head ?? null);
        return (
          <Space key={collaborator.clientId} size={8} align="center">
            <Avatar
              size={22}
              style={{ backgroundColor: color }}
              // `data-client-id` lets a browser test assert one colour per user
              // without reading computed styles out of the document.
              data-client-id={collaborator.clientId}
            >
              {initialsOf(collaborator.user.name)}
            </Avatar>
            <Typography.Text>
              {collaborator.user.name}
              {isSelf ? ' (you)' : ''}
            </Typography.Text>
            {label === null ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                no cursor
              </Typography.Text>
            ) : (
              <Tooltip title="Cursor position in the document">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {label}
                </Typography.Text>
              </Tooltip>
            )}
          </Space>
        );
      })}
    </Space>
  );
}
