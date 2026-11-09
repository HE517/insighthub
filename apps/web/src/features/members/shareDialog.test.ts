/**
 * The member dialog's markup (Node `renderToStaticMarkup`; this workspace has no DOM).
 *
 * What is asserted here is the **contract surface** A6's browser suite will click, plus the three
 * visual facts a screenshot alone would not pin:
 *
 * 1. the owner row offers transfer and does **not** offer the two controls the frozen API refuses
 *    for an owner (role select, remove);
 * 2. a destructive action renders its confirmation step, and a transfer cannot be submitted
 *    before a target is chosen;
 * 3. loading / unreadable / failed states are distinct and no failure is ever rendered as an empty
 *    member list.
 *
 * The interactive half (fetch → click → PATCH → refresh) is the component's effect code, not this
 * view; real-browser coverage of that flow belongs to A6.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import type { DocumentMember } from './membersApi.js';
import {
  ShareDialogView,
  type MembersLoadState,
  type ShareDialogViewProps,
} from './ShareDialog.js';

const ADA: DocumentMember = {
  userId: 'demo-ada',
  email: 'ada@insighthub.test',
  name: 'Ada Lovelace',
  role: 'owner',
};
const GRACE: DocumentMember = {
  userId: 'demo-grace',
  email: 'grace@insighthub.test',
  name: 'Grace Hopper',
  role: 'editor',
};
const LINUS: DocumentMember = {
  userId: 'demo-linus',
  email: 'linus@insighthub.test',
  name: 'Linus Torvalds',
  role: 'viewer',
};

const READY: MembersLoadState = {
  kind: 'ready',
  members: [ADA, GRACE, LINUS],
  ownerId: 'demo-ada',
};

const BASE_PROPS: ShareDialogViewProps = {
  documentId: 'demo-document',
  currentUserId: 'demo-ada',
  state: READY,
  inviteEmail: '',
  inviteRole: 'viewer',
  pending: false,
  failure: null,
  confirmation: null,
  onInviteEmailChange: () => undefined,
  onInviteRoleChange: () => undefined,
  onInvite: () => undefined,
  onChangeRole: () => undefined,
  onRequestRemove: () => undefined,
  onRequestTransfer: () => undefined,
  onRequestLeave: () => undefined,
  onConfirm: () => undefined,
  onCancelConfirm: () => undefined,
  onTransferTargetChange: () => undefined,
  onRefresh: () => undefined,
  onClose: () => undefined,
};

function markup(overrides: Partial<ShareDialogViewProps> = {}): string {
  return renderToStaticMarkup(createElement(ShareDialogView, { ...BASE_PROPS, ...overrides }));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The opening tag for one testid, so a `disabled` assertion cannot match a different element. */
function tagFor(html: string, testid: string): string {
  const match = new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  return match?.[0] ?? '';
}

describe('member list', () => {
  it('renders the panel as a labelled dialog with one row per member', () => {
    const html = markup();

    expect(html).toContain('data-testid="members-panel"');
    expect(html).toContain('data-state="ready"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="members-title"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-testid="members-list"');
    expect(occurrences(html, 'data-testid="members-row"')).toBe(3);
    expect(occurrences(html, 'data-testid="members-name"')).toBe(3);
    expect(occurrences(html, 'data-testid="members-email"')).toBe(3);
  });

  it('shows name, email and the Chinese role label for every member', () => {
    const html = markup();

    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@insighthub.test');
    expect(html).toContain('Grace Hopper');
    expect(html).toContain('grace@insighthub.test');
    expect(html).toContain('Linus Torvalds');
    expect(html).toContain('linus@insighthub.test');
    expect(html).toContain('所有者');
    expect(html).toContain('编辑者');
    expect(html).toContain('只读查看者');
    expect(html).toContain('data-user-id="demo-grace" data-role="editor"');
  });

  it('marks the current session as (你) and leaves other rows unmarked', () => {
    const html = markup();
    const adaRow = html.slice(html.indexOf('data-user-id="demo-ada"'));
    expect(adaRow).toContain('（你）');
    expect(html).toContain('data-user-id="demo-grace"');
    const graceRowStart = html.indexOf('data-user-id="demo-grace"');
    const graceRow = html.slice(graceRowStart, html.indexOf('data-user-id="demo-linus"'));
    expect(graceRow).not.toContain('（你）');
  });

  it('gives the owner transfer, and only the non-owner rows role select + remove', () => {
    const html = markup();

    expect(occurrences(html, 'data-testid="members-transfer"')).toBe(1);
    expect(occurrences(html, 'data-testid="members-role-select"')).toBe(2);
    expect(occurrences(html, 'data-testid="members-remove"')).toBe(2);
    expect(html).toContain('转让 Owner');
    expect(html).toContain('data-owner="true"');
    // The owner row carries the transfer button, not the refused controls.
    const ownerStart = html.indexOf('data-owner="true"');
    const ownerRow = html.slice(ownerStart, html.indexOf('data-user-id="demo-grace"'));
    expect(ownerRow).toContain('data-testid="members-transfer"');
    expect(ownerRow).not.toContain('data-testid="members-remove"');
    expect(ownerRow).not.toContain('data-testid="members-role-select"');
  });

  it('keeps the invite form and the leave entry in the panel', () => {
    const html = markup();

    expect(html).toContain('data-testid="members-invite-email"');
    expect(html).toContain('data-testid="members-invite-role"');
    expect(html).toContain('data-testid="members-invite-submit"');
    expect(html).toContain('data-testid="members-leave"');
    expect(html).toContain('data-testid="members-refresh"');
    expect(html).toContain('data-testid="members-close"');
    expect(html).toContain('data-testid="members-panel"');
  });

  it('disables the invite button for a blank address and enables it for a non-empty one', () => {
    expect(tagFor(markup(), 'members-invite-submit')).toContain('disabled');
    const filled = markup({ inviteEmail: 'grace@insighthub.test' });
    expect(tagFor(filled, 'members-invite-submit')).not.toContain('disabled');
  });
});

describe('loading and failure states', () => {
  it('renders loading with no list, never an empty list standing in for a pending read', () => {
    const html = markup({ state: { kind: 'loading' } });

    expect(html).toContain('data-state="loading"');
    expect(html).toContain('data-testid="members-loading"');
    expect(html).not.toContain('data-testid="members-list"');
    expect(tagFor(html, 'members-invite-submit')).toContain('disabled');
    expect(tagFor(html, 'members-leave')).toContain('disabled');
  });

  it('renders a load failure as an error, not as an empty member list', () => {
    const html = markup({
      state: {
        kind: 'error',
        failure: {
          kind: 'forbidden',
          title: '只有文档所有者可以管理成员。',
          detail: '服务器拒绝了此操作。',
          refresh: false,
        },
      },
    });

    expect(html).toContain('data-testid="members-load-error"');
    expect(html).toContain('data-members-error="forbidden"');
    expect(html).not.toContain('data-testid="members-list"');
    expect(html).toContain('只有文档所有者可以管理成员。');
  });

  it('renders an operation failure above the list, with the real discriminator', () => {
    const html = markup({
      failure: {
        kind: 'owner_requires_transfer',
        title: '所有者必须先转让所有权。',
        detail: '文档必须保留一位所有者。',
        refresh: true,
      },
    });

    expect(html).toContain('data-testid="members-error"');
    expect(html).toContain('data-members-error="owner_requires_transfer"');
    expect(html).toContain('所有者必须先转让所有权。');
    // The list stays readable while the error explains what the server refused.
    expect(html).toContain('data-testid="members-list"');
  });
});

describe('confirmation step', () => {
  it('is absent until a destructive action is requested', () => {
    expect(markup()).not.toContain('data-testid="members-confirm"');
  });

  it('renders the remove confirmation with cancel and a typed confirm', () => {
    const html = markup({ confirmation: { kind: 'remove', member: GRACE } });

    expect(html).toContain('data-testid="members-confirm"');
    expect(html).toContain('data-confirm-action="remove"');
    expect(html).toContain('Grace Hopper');
    expect(html).toContain('data-testid="members-confirm-cancel"');
    expect(html).toContain('data-testid="members-confirm-submit"');
    expect(html).toContain('确认移除');
    expect(html).not.toContain('data-testid="members-transfer-target"');
  });

  it('renders the leave confirmation', () => {
    const html = markup({ confirmation: { kind: 'leave' } });

    expect(html).toContain('data-confirm-action="leave"');
    expect(html).toContain('确认离开');
    expect(html).toContain('所有者必须先转让');
  });

  it('adds a target picker for a transfer and cannot submit before a target is chosen', () => {
    const html = markup({ confirmation: { kind: 'transfer', targetId: null } });

    expect(html).toContain('data-confirm-action="transfer"');
    expect(html).toContain('data-testid="members-transfer-target"');
    // Candidates are the non-owner members; the owner cannot be transferred to themselves.
    expect(html).toContain(
      '<option value="demo-grace">Grace Hopper（grace@insighthub.test）</option>',
    );
    expect(html).toContain(
      '<option value="demo-linus">Linus Torvalds（linus@insighthub.test）</option>',
    );
    expect(html).not.toContain('<option value="demo-ada">');
    expect(tagFor(html, 'members-confirm-submit')).toContain('disabled');

    const ready = markup({ confirmation: { kind: 'transfer', targetId: 'demo-grace' } });
    expect(tagFor(ready, 'members-confirm-submit')).not.toContain('disabled');
  });
});

describe('pending state', () => {
  it('disables every mutating control while a request is in flight', () => {
    const html = markup({
      pending: true,
      inviteEmail: 'grace@insighthub.test',
      confirmation: { kind: 'remove', member: GRACE },
    });

    expect(html).toContain('aria-busy="true"');
    expect(tagFor(html, 'members-invite-submit')).toContain('disabled');
    expect(tagFor(html, 'members-remove')).toContain('disabled');
    expect(tagFor(html, 'members-transfer')).toContain('disabled');
    expect(tagFor(html, 'members-leave')).toContain('disabled');
    expect(tagFor(html, 'members-refresh')).toContain('disabled');
    expect(tagFor(html, 'members-confirm-submit')).toContain('disabled');
    expect(tagFor(html, 'members-confirm-cancel')).toContain('disabled');
  });
});
