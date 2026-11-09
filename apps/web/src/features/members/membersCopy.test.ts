/**
 * Error mapping and role labels for the member dialog.
 *
 * The mapping is asserted as a table so a future edit cannot quietly collapse two facts that the
 * frozen API distinguishes — most importantly `404 user_not_found` (a bad email, actionable) and
 * `404 not_found` (the document is gone or not visible). The `refresh` flag is part of the
 * contract too: every `409` re-reads the list because the conflict means this client's snapshot
 * may be stale.
 */
import { describe, expect, it } from 'vitest';

import {
  INVITE_ROLE_OPTIONS,
  describeMembersFailure,
  memberRoleLabel,
  type MembersFailureKind,
} from './membersCopy.js';
import { MembersApiError } from './membersApi.js';

function http(status: number, code?: string): MembersApiError {
  return new MembersApiError('http', `HTTP ${String(status)}`, status, code);
}

function kindOf(error: unknown): MembersFailureKind | null {
  return describeMembersFailure(error)?.kind ?? null;
}

describe('describeMembersFailure: the frozen (status, code) table', () => {
  it('reads 404 by code first, because the status alone is ambiguous', () => {
    expect(kindOf(http(404, 'user_not_found'))).toBe('user_not_found');
    expect(kindOf(http(404, 'not_found'))).toBe('not_found');
    expect(kindOf(http(404))).toBe('not_found');
  });

  it('maps each frozen 409 code to its own Chinese sentence and requests a refresh', () => {
    const expectations = [
      ['already_owner', 'already_owner'],
      ['owner_role_immutable', 'owner_role_immutable'],
      ['owner_requires_transfer', 'owner_requires_transfer'],
      ['last_owner', 'last_owner'],
    ] as const;

    for (const [code, kind] of expectations) {
      const copy = describeMembersFailure(http(409, code));
      expect(copy).not.toBeNull();
      expect(copy?.kind).toBe(kind);
      expect(copy?.refresh).toBe(true);
    }
  });

  it('treats an unknown 409 code as a generic conflict, still refreshing', () => {
    const copy = describeMembersFailure(http(409, 'something_new'));
    expect(copy?.kind).toBe('conflict');
    expect(copy?.refresh).toBe(true);
  });

  it('maps 401, 400 and every other status without pretending they are the same failure', () => {
    expect(kindOf(http(401))).toBe('session_required');
    expect(kindOf(http(400, 'invalid_request'))).toBe('invalid_request');
    expect(kindOf(http(403, 'forbidden'))).toBe('forbidden');
    expect(kindOf(http(500))).toBe('http');
    expect(kindOf(http(502))).toBe('http');
  });

  it('maps transport failures and never labels them as a server decision', () => {
    expect(kindOf(new MembersApiError('network', 'offline'))).toBe('network');
    expect(kindOf(new MembersApiError('timeout', 'slow'))).toBe('timeout');
    expect(kindOf(new MembersApiError('malformed', 'bad body'))).toBe('malformed');
    expect(kindOf(new MembersApiError('aborted', 'closed'))).toBeNull();
  });

  it('surfaces an unexpected error instead of swallowing it', () => {
    const copy = describeMembersFailure(new Error('unexpected failure'));
    expect(copy?.kind).toBe('unexpected');
    expect(copy?.detail).toContain('unexpected failure');
    expect(kindOf('anything')).toBe('unexpected');
  });

  it('writes every headline and detail in Chinese, with no raw error-code jargon', () => {
    const errors: unknown[] = [
      http(404, 'user_not_found'),
      http(404, 'not_found'),
      http(403, 'forbidden'),
      http(409, 'already_owner'),
      http(409, 'owner_role_immutable'),
      http(409, 'owner_requires_transfer'),
      http(409, 'last_owner'),
      http(409, 'new_code'),
      http(401),
      http(400),
      http(500),
      new MembersApiError('network', 'offline'),
      new MembersApiError('timeout', 'slow'),
      new MembersApiError('malformed', 'bad'),
      new Error('boom'),
    ];

    for (const error of errors) {
      const copy = describeMembersFailure(error);
      expect(copy).not.toBeNull();
      expect(copy?.title).toMatch(/[\u4e00-\u9fff]/u);
      expect(copy?.detail).toMatch(/[\u4e00-\u9fff]/u);
      // The discriminator belongs in `data-members-error`, not in the sentence a person reads.
      expect(copy?.title).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it('tells the owner that last_owner is about transfer, not about a network problem', () => {
    const copy = describeMembersFailure(http(409, 'last_owner'));
    expect(copy?.title).toContain('所有者');
    expect(copy?.detail).toContain('转让');
  });
});

describe('role labels', () => {
  it('offers exactly the three assignable roles, each with its Chinese label', () => {
    expect(INVITE_ROLE_OPTIONS).toEqual([
      { value: 'viewer', label: '只读查看者' },
      { value: 'commenter', label: '评论者' },
      { value: 'editor', label: '编辑者' },
    ]);
  });

  it('labels all four roles, owner included, in Chinese', () => {
    expect(memberRoleLabel('owner')).toBe('所有者');
    expect(memberRoleLabel('editor')).toBe('编辑者');
    expect(memberRoleLabel('commenter')).toBe('评论者');
    expect(memberRoleLabel('viewer')).toBe('只读查看者');
  });
});
