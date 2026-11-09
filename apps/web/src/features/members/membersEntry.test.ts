/**
 * The "共享" entry in the document header (P0-2).
 *
 * The acceptance rule is one line: **only the owner renders it**. The role comes from
 * `session.getRole()` through `capabilityGate`, never from a prop or a Redux field, so this test
 * renders the header for every role value the session can report — including `null` (unknown) and
 * asserts the owner-only surface is absent for all of them.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { DocumentRole } from '@insighthub/shared';
import { describe, expect, it } from 'vitest';

import { DocumentHeader } from '../editor/DocumentHeader.js';
import { capabilityGate } from '../permissions/capabilityGate.js';

const noop = (): void => undefined;

function headerMarkup(role: DocumentRole | null, membersOpen = false): string {
  return renderToStaticMarkup(
    createElement(DocumentHeader, {
      documentId: 'demo-document',
      status: 'connected',
      gate: capabilityGate(role),
      collaborators: [],
      localClientId: 1,
      undoState: { canUndo: false, canRedo: false },
      onUndo: noop,
      onRedo: noop,
      aiOpen: false,
      onToggleAi: noop,
      membersOpen,
      onToggleMembers: noop,
      mode: 'editor',
      onModeChange: noop,
    }),
  );
}

describe('owner-only 共享 entry', () => {
  it('renders for the owner with the shared testid and closed state', () => {
    const html = headerMarkup('owner');

    expect(html).toContain('data-testid="members-open"');
    expect(html).toContain('aria-controls="members-panel"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('共享');
  });

  it('reflects the open state in aria-expanded', () => {
    const html = headerMarkup('owner', true);
    expect(html).toContain('aria-expanded="true"');
  });

  it.each<DocumentRole | null>(['editor', 'commenter', 'viewer', null])(
    'does not render for role %s',
    (role) => {
      const html = headerMarkup(role);
      expect(html).not.toContain('data-testid="members-open"');
      expect(html).not.toContain('aria-controls="members-panel"');
      // The rest of the header is unchanged: the AI trigger and the role chip still follow their
      // own rules (this change added one owner-only button, not a new header mode).
      expect(html).toContain('data-testid="ai-open"');
    },
  );

  it('still shows the role chip for every known role', () => {
    expect(headerMarkup('owner')).toContain('角色：所有者');
    expect(headerMarkup('editor')).toContain('角色：编辑者');
    expect(headerMarkup('commenter')).toContain('角色：评论者');
    expect(headerMarkup('viewer')).toContain('角色：只读查看者');
    // Unknown stays unknown: no chip at all (§17.9).
    expect(headerMarkup(null)).not.toContain('角色：');
  });
});
