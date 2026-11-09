/**
 * The dialog's confirmation policy and row helpers (pure, no DOM).
 *
 * The requirement is that remove / transfer / leave go through a second step. That rule lives in
 * `membersDialog.ts` rather than in JSX so it is testable here: every destructive action must say
 * `requiresConfirmation === true`, a transfer must have a target before it can be confirmed, and
 * the owner's row must be the one that offers the transfer entry.
 */
import { describe, expect, it } from 'vitest';

import type { DocumentMember } from './membersApi.js';
import {
  canConfirm,
  canSubmitInvite,
  confirmationCopy,
  displayNameOf,
  isOwnerRow,
  requiresConfirmation,
  transferCandidates,
  type Confirmation,
} from './membersDialog.js';

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
const MEMBERS = [ADA, GRACE, LINUS] as const;

describe('confirmation policy', () => {
  it('requires a second step for remove, transfer and leave', () => {
    expect(requiresConfirmation('remove')).toBe(true);
    expect(requiresConfirmation('transfer')).toBe(true);
    expect(requiresConfirmation('leave')).toBe(true);
  });

  it('names the member being removed, so the confirmation is about a real person', () => {
    const copy = confirmationCopy({ kind: 'remove', member: GRACE });
    expect(copy.title).toContain('移除');
    expect(copy.detail).toContain('Grace Hopper');
    expect(copy.detail).toContain('grace@insighthub.test');
    expect(copy.confirmLabel).toBe('确认移除');
  });

  it('warns that a transfer demotes the current owner and cannot be undone', () => {
    const copy = confirmationCopy({ kind: 'transfer', targetId: null });
    expect(copy.title).toContain('转让');
    expect(copy.detail).toContain('降级为编辑者');
    expect(copy.detail).toContain('无法撤销');
    expect(copy.confirmLabel).toBe('确认转让');
  });

  it('explains the owner rule before leaving', () => {
    const copy = confirmationCopy({ kind: 'leave' });
    expect(copy.title).toContain('离开');
    expect(copy.detail).toContain('所有者必须先转让');
    expect(copy.confirmLabel).toBe('确认离开');
  });

  it('cannot confirm a transfer without a target, and can once one is chosen', () => {
    const bare: Confirmation = { kind: 'transfer', targetId: null };
    const ready: Confirmation = { kind: 'transfer', targetId: GRACE.userId };

    expect(canConfirm(bare)).toBe(false);
    expect(canConfirm(ready)).toBe(true);
    expect(canConfirm({ kind: 'remove', member: GRACE })).toBe(true);
    expect(canConfirm({ kind: 'leave' })).toBe(true);
  });
});

describe('row helpers', () => {
  it('identifies the owner by role or by the server ownerId', () => {
    expect(isOwnerRow(ADA, 'demo-ada')).toBe(true);
    // A row whose role says owner is the owner even if the two fields disagree.
    expect(isOwnerRow(ADA, 'someone-else')).toBe(true);
    expect(isOwnerRow(GRACE, 'demo-ada')).toBe(false);
    // The ownerId alone is enough when the role list is inconsistent.
    expect(isOwnerRow({ ...GRACE, role: 'editor' }, 'demo-grace')).toBe(true);
  });

  it('never offers the current owner as a transfer target', () => {
    expect(transferCandidates(MEMBERS, 'demo-ada').map((member) => member.userId)).toEqual([
      'demo-grace',
      'demo-linus',
    ]);
  });

  it('falls back to the email when a name is empty', () => {
    expect(displayNameOf({ ...GRACE, name: '   ' })).toBe('grace@insighthub.test');
    expect(displayNameOf(GRACE)).toBe('Grace Hopper');
  });

  it('disables the invite button only for a blank address', () => {
    expect(canSubmitInvite('')).toBe(false);
    expect(canSubmitInvite('   ')).toBe(false);
    expect(canSubmitInvite('grace@insighthub.test')).toBe(true);
    // Format is the server's decision (`400 invalid_request` has its own copy).
    expect(canSubmitInvite('not-an-email')).toBe(true);
  });
});
