/**
 * The words the `New document` control shows (M4 B12.5, `docs/DECISIONS.md` D-084 #7).
 *
 * Same split as `aiDirectoryCopy.ts`: the component renders, this module owns the copy and the
 * mapping from a typed failure to something a person can act on, so both are testable in the Node
 * gate where the panel's effects cannot run.
 *
 * Three product rules are encoded here:
 *
 * 1. **No false success.** Nothing in this file may say a document was created, saved or stored
 *    unless the server's `201` was actually read — the component only shows success by switching
 *    to the document the server named (and that switch is the visible confirmation).
 * 2. **No false failure either.** A timeout or unreadable `2xx` cannot prove the server did not
 *    commit, so those two say "may have been created" and send the user to Refresh. The failures
 *    that are provably before the commit (401, 403 origin refusal, other HTTP error, unreachable)
 *    say "nothing was created".
 * 3. **Aborted is not an error.** A cancelled request is the normal result of closing the panel or
 *    switching documents; returning `null` keeps it out of the UI (R9, A5 stale-response rules).
 *
 * The wording is Simplified Chinese (A2 UI-copy unification). The typed `kind` discriminators and
 * the `data-create-error` attribute stay exactly as they were.
 */
import { DocumentCreateError, type DocumentCreateFailure } from './documentCreation.js';

/** The control's idle label. */
export const NEW_DOCUMENT_LABEL = '新建文档';

/** The control's label while the request is in flight (the button is also `disabled`). */
export const NEW_DOCUMENT_PENDING_LABEL = '正在创建…';

/** Stable discriminators, rendered as `data-create-error` for machine-readable assertions. */
export type NewDocumentFailureKind = Exclude<DocumentCreateFailure, 'aborted'> | 'unexpected';

/** A creation failure flattened into what the directory renders. */
export interface NewDocumentFailureCopy {
  /** The typed kind (`network`, `http`, …), or `unexpected` for anything else. */
  readonly kind: NewDocumentFailureKind;
  /** One-line headline: what happened. */
  readonly title: string;
  /** The actionable detail: what is known, and how to retry. */
  readonly detail: string;
}

/** Retry through the same control that failed; no second entry point. */
const RETRY_HINT = '请点击“新建文档”重试。';

/** A failure that happened before the commit: the directory is safe to keep using. */
const NOT_CREATED = '未创建任何文档。';

/**
 * Turn whatever `createDocument` threw into readable copy.
 *
 * Returns `null` only for `aborted`: the caller ignores it, because a request cancelled on purpose
 * must not report a failure or overwrite a newer state.
 */
export function describeCreateFailure(error: unknown): NewDocumentFailureCopy | null {
  if (error instanceof DocumentCreateError) {
    switch (error.kind) {
      case 'aborted':
        return null;
      case 'unauthorized':
        return {
          kind: 'unauthorized',
          title: '服务器会话已失效。',
          detail:
            '服务器没有接受此浏览器的会话，因此未创建任何文档。' +
            '若页面刚加载，请重新加载页面并登录，然后再试一次。',
        };
      case 'network':
        return {
          kind: 'network',
          title: '网络已断开，请求未完成。',
          detail:
            '无法连接到服务器——你可能已离线。客户端无法确认是否已创建文档，' +
            '因此请先点击“刷新”查看列表，再决定是否重试。',
        };
      case 'timeout':
        return {
          kind: 'timeout',
          title: '服务器未及时响应。',
          detail:
            '没有收到服务器的回答，客户端无法判断文档是否已创建。' +
            '请先点击“刷新”查看列表，再决定是否重试。',
        };
      case 'malformed':
        return {
          kind: 'malformed',
          title: '无法读取服务器的响应。',
          detail:
            '文档可能已创建，但此客户端无法读取服务器的确认信息。' +
            '请先点击“刷新”查看列表，再决定是否重试。',
        };
      case 'http':
        if (error.status === 403) {
          // `403 origin_not_allowed`: the request was refused before the creation handler ran, so
          // it is safe to say nothing was created. A different 403 (forbidden) is also before the
          // commit; neither code is added here — only the status/body the server already sends.
          return {
            kind: 'http',
            title: '请求来源被拒绝。',
            detail: `服务器以 HTTP 403 拒绝了该请求：请求来源不被允许。${NOT_CREATED} ${RETRY_HINT}`,
          };
        }
        return {
          kind: 'http',
          title: '文档未创建。',
          detail: `服务器返回 HTTP ${String(error.status ?? 'error')}。${NOT_CREATED} ${RETRY_HINT}`,
        };
    }
  }

  // Anything that is not the typed error is still surfaced, never swallowed. The message is shown
  // (it is the only clue the user or an operator has) but without a stack trace — and it makes no
  // claim about what the server did.
  const detail =
    error instanceof Error && error.message.trim() !== ''
      ? `${error.message.replace(/[.\s]+$/, '')}。`
      : '请求失败，且没有给出可识别的原因。';
  return {
    kind: 'unexpected',
    title: '文档无法创建。',
    detail: `${detail} 请先点击“刷新”查看列表，再决定是否重试。`,
  };
}
