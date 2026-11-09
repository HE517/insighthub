/**
 * Chinese copy for the member-management dialog — and one mapping table.
 *
 * Same split as `newDocumentCopy.ts` / `aiDirectoryCopy.ts`: the component renders, this module
 * owns the words and the translation from the **server's real response** into them. The dialog
 * never prints a raw HTTP status or an error-code string at the user; the code is preserved in the
 * DOM as `data-members-error` for assertions.
 *
 * The mapping is by `(status, code)`, in that order of authority:
 *
 * | response | kind | why it needs its own sentence |
 * | --- | --- | --- |
 * | `404 user_not_found` | `user_not_found` | the email is not a registered user — actionable: check the address |
 * | `404 not_found` | `not_found` | the document is gone or not visible — **not** an email problem |
 * | `403 forbidden` | `forbidden` | only an owner may manage; the UI already hides the entry |
 * | `409 already_owner` | `already_owner` | inviting yourself is a no-op, not a network error |
 * | `409 owner_role_immutable` | `owner_role_immutable` | ownership moves only by transfer |
 * | `409 owner_requires_transfer` | `owner_requires_transfer` | the owner cannot be removed |
 * | `409 last_owner` | `last_owner` | a document always keeps exactly one owner |
 *
 * `404` deliberately reads the code before falling back to the document sentence: the frozen
 * contract uses the same status for two different facts, and collapsing them into "文档不存在"
 * would tell an owner their document vanished when they only mistyped an email.
 *
 * Every `409` sets `refresh: true`: the dialog re-reads the list, because the conflict means the
 * client's copy of the membership state may be stale (the task's "409 后刷新列表"). The copy still
 * explains what the server refused.
 */
import type { DocumentRole } from '@insighthub/shared';

import { roleLabel } from '../permissions/roleLabels.js';
import type { InviteRole } from './membersApi.js';
import { MembersApiError } from './membersApi.js';

/** The stable discriminators rendered as `data-members-error`. */
export type MembersFailureKind =
  | 'user_not_found'
  | 'not_found'
  | 'forbidden'
  | 'already_owner'
  | 'owner_role_immutable'
  | 'owner_requires_transfer'
  | 'last_owner'
  | 'session_required'
  | 'invalid_request'
  | 'conflict'
  | 'http'
  | 'network'
  | 'timeout'
  | 'malformed'
  | 'unexpected';

/** A failure flattened into what the dialog renders. */
export interface MembersFailureCopy {
  readonly kind: MembersFailureKind;
  /** One-line headline: what the server said, in Chinese. */
  readonly title: string;
  /** What is known and what to do next. Never claims an operation succeeded. */
  readonly detail: string;
  /** `true` for a `409`: the membership state may be stale, so re-read it. */
  readonly refresh: boolean;
}

/** The three assignable roles, in the order the selects render them. */
export const INVITE_ROLE_OPTIONS: readonly {
  readonly value: InviteRole;
  readonly label: string;
}[] = [
  { value: 'viewer', label: roleLabel('viewer') },
  { value: 'commenter', label: roleLabel('commenter') },
  { value: 'editor', label: roleLabel('editor') },
];

/** Every role's Chinese label, owner included. Exported so the dialog and tests share one table. */
export function memberRoleLabel(role: DocumentRole): string {
  return roleLabel(role);
}

const REFRESH_HINT = '成员列表会自动刷新，请根据最新成员状态重试。';

/**
 * Turn whatever a members call threw into readable copy.
 *
 * `null` only for `aborted`: a cancelled request is the normal result of closing the dialog or
 * switching documents, and must not surface as a failure (R9, A5 stale-response rules).
 */
export function describeMembersFailure(error: unknown): MembersFailureCopy | null {
  if (error instanceof MembersApiError) {
    switch (error.kind) {
      case 'aborted':
        return null;
      case 'network':
        return {
          kind: 'network',
          title: '网络已断开。',
          detail: '无法连接到服务器——你可能已离线。请恢复网络后重试；此操作可能没有生效。',
          refresh: false,
        };
      case 'timeout':
        return {
          kind: 'timeout',
          title: '服务器未及时响应。',
          detail:
            '没有收到服务器的回答，无法确认操作是否已生效。请点击“刷新”查看最新成员后再重试。',
          refresh: false,
        };
      case 'malformed':
        return {
          kind: 'malformed',
          title: '无法读取服务器的响应。',
          detail: '服务器返回了无法识别的成员数据。请点击“刷新”后重试。',
          refresh: false,
        };
      case 'http':
        return describeHttpFailure(error.status, error.code);
    }
  }

  // Anything that is not the typed error is still surfaced, never swallowed. The message (when it
  // is an Error) is the only clue the user or an operator has; no stack trace is rendered.
  const detail =
    error instanceof Error && error.message.trim() !== ''
      ? `${error.message.replace(/[.\s]+$/, '')}。`
      : '请求失败，且没有给出可识别的原因。';
  return {
    kind: 'unexpected',
    title: '操作未完成。',
    detail: `${detail} 请点击“刷新”查看最新成员，再决定是否重试。`,
    refresh: false,
  };
}

function describeHttpFailure(
  status: number | undefined,
  code: string | undefined,
): MembersFailureCopy {
  if (status === 401) {
    return {
      kind: 'session_required',
      title: '服务器会话已失效。',
      detail: '服务器没有接受此浏览器的会话。请重新加载页面并登录，然后再管理成员。',
      refresh: false,
    };
  }

  if (status === 403) {
    return {
      kind: 'forbidden',
      title: '只有文档所有者可以管理成员。',
      detail: '服务器拒绝了此操作。你的角色可能已被变更；请重新加载页面确认当前权限。',
      refresh: false,
    };
  }

  if (status === 404) {
    if (code === 'user_not_found') {
      return {
        kind: 'user_not_found',
        title: '找不到该邮箱对应的用户。',
        detail:
          '对方必须先在 InsightHub 注册，才能被邀请（演示环境为 @insighthub.test 账号）。' +
          '请确认邮箱拼写后重试。',
        refresh: false,
      };
    }
    return {
      kind: 'not_found',
      title: '文档不存在，或你无权管理。',
      detail: '服务器没有返回该文档的成员信息。它可能已被删除，或你的权限已变更。',
      refresh: false,
    };
  }

  if (status === 409) {
    switch (code) {
      case 'already_owner':
        return {
          kind: 'already_owner',
          title: '你已经是本文档的所有者。',
          detail: '不能邀请自己；无需再添加。若想调整自己的角色，请使用“转让 Owner”。',
          refresh: true,
        };
      case 'owner_role_immutable':
        return {
          kind: 'owner_role_immutable',
          title: '所有者的角色不能直接修改。',
          detail: '请使用“转让 Owner”把所有权交给其他成员；文档始终恰好有一位所有者。',
          refresh: true,
        };
      case 'owner_requires_transfer':
        return {
          kind: 'owner_requires_transfer',
          title: '所有者必须先转让所有权。',
          detail: `文档必须保留一位所有者，因此不能直接移除或离开。请先转让所有权。${REFRESH_HINT}`,
          refresh: true,
        };
      case 'last_owner':
        return {
          kind: 'last_owner',
          title: '文档必须保留一位所有者。',
          detail: `你是当前所有者，无法直接离开。请先把所有权转让给其他成员，再离开文档。${REFRESH_HINT}`,
          refresh: true,
        };
      default:
        return {
          kind: 'conflict',
          title: '操作与当前成员状态冲突。',
          detail: `服务器返回 HTTP 409。${REFRESH_HINT}`,
          refresh: true,
        };
    }
  }

  if (status === 400) {
    return {
      kind: 'invalid_request',
      title: '请求无效。',
      detail: '请检查邮箱格式与所选角色，然后重试。',
      refresh: false,
    };
  }

  return {
    kind: 'http',
    title: '操作未完成。',
    detail: `服务器返回 HTTP ${String(status ?? 'error')}。请点击“刷新”查看最新成员后再重试。`,
    refresh: false,
  };
}
