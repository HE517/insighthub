/**
 * The words the read-only document directory shows, in one place (`docs/DECISIONS.md` D-078 §4
 * R2-1).
 *
 * Same split as `aiProposalCopy.ts`: the component renders, this module owns the copy and the
 * mapping from a typed failure to something a person can act on. Keeping it out of JSX makes it
 * testable in the Node gate, where the panel's effects cannot run.
 *
 * Three product rules are encoded here:
 *
 * 1. **No silent empty list.** `listDocuments` (`features/ai/tools.ts`) rejects with a typed
 *    `DocumentListError` instead of resolving `[]`, so "the request failed" and "there is nothing
 *    you may read" are different states with different words (R9).
 * 2. **Aborted is not an error.** A cancelled request is the normal result of closing the panel or
 *    switching documents; returning `null` keeps it out of the UI entirely (R9, A5 stale-response
 *    ownership).
 * 3. **Offline is a state, not a lie.** The list is server truth and is never cached, so the
 *    network copy says the list is unavailable rather than pretending there are no documents
 *    (R10).
 *
 * The wording is Simplified Chinese (A2 UI-copy unification). The typed `kind` discriminators
 * (`unauthorized`, `network`, `timeout`, `malformed`, `http`, `unexpected`) and the
 * `data-directory-error` attribute stay exactly as they were — only the human-readable text and
 * the HTTP-status split inside `http` changed.
 */
import { DocumentListError, type DocumentListFailure } from '../ai/tools.js';

/**
 * The exact empty-state sentence.
 *
 * A6 consumes this through `[data-testid="ai-directory-empty"]`; it is a constant (rather than a
 * literal in JSX) so the sentence can be asserted without parsing the component.
 */
export const AI_DIRECTORY_EMPTY_COPY = '没有可阅读的文档';

/** Stable discriminators, rendered as `data-directory-error` for machine-readable assertions. */
export type DirectoryFailureKind = Exclude<DocumentListFailure, 'aborted'> | 'unexpected';

/** A directory failure flattened into what the panel renders. */
export interface DirectoryFailureCopy {
  /** The typed kind (`network`, `malformed`, …), or `unexpected` for anything else. */
  readonly kind: DirectoryFailureKind;
  /** One-line headline: what happened. */
  readonly title: string;
  /** The actionable detail: why, and how to retry. */
  readonly detail: string;
}

/** The one way to retry: the directory's own Refresh control (the panel re-fetches on mount too). */
const RETRY_HINT = '请点击“刷新”重试。';

/**
 * Turn whatever `listDocuments` threw into readable copy.
 *
 * Returns `null` only for `aborted`: the caller ignores it, because a request that was cancelled
 * on purpose must not overwrite a newer state or report a failure to the user.
 */
export function describeDirectoryFailure(error: unknown): DirectoryFailureCopy | null {
  if (error instanceof DocumentListError) {
    switch (error.kind) {
      case 'aborted':
        return null;
      case 'unauthorized':
        return {
          kind: 'unauthorized',
          title: '服务器会话已失效。',
          detail:
            '服务器没有接受此浏览器的会话，因此无法列出你有权阅读的文档。若页面刚加载，请点击“刷新”；否则请重新加载页面并登录。',
        };
      case 'network':
        return {
          kind: 'network',
          title: '文档列表不可用：网络已断开。',
          detail:
            '无法连接到服务器——你可能已离线。该列表来自服务器且从不缓存，因此在连接恢复前会保持为空。' +
            RETRY_HINT,
        };
      case 'timeout':
        return {
          kind: 'timeout',
          title: '文档列表请求超时。',
          detail: `服务器在规定时间内没有返回结果。${RETRY_HINT}`,
        };
      case 'malformed':
        return {
          kind: 'malformed',
          title: '无法读取文档列表。',
          detail: `服务器返回了此客户端无法识别的文档列表。${RETRY_HINT}`,
        };
      case 'http':
        if (error.status === 403) {
          // `403 origin_not_allowed`: the server refused the request source before routing. This is
          // a different failure from a timeout or a missing session, so it gets its own sentence.
          return {
            kind: 'http',
            title: '请求来源被拒绝。',
            detail: `服务器以 HTTP 403 拒绝了该请求：请求来源不被允许。${RETRY_HINT}`,
          };
        }
        return {
          kind: 'http',
          title: '服务器拒绝列出文档。',
          detail: `服务器返回 HTTP ${String(error.status ?? 'error')}。${RETRY_HINT}`,
        };
    }
  }

  // Anything that is not the typed error is still surfaced, never swallowed. The message is shown
  // (it is the only clue the user or an operator has) but without a stack trace.
  const detail =
    error instanceof Error && error.message.trim() !== ''
      ? `${error.message.replace(/[.\s]+$/, '')}。`
      : '文档列表失败，且没有给出可识别的原因。';
  return {
    kind: 'unexpected',
    title: '文档列表无法加载。',
    detail: `${detail} ${RETRY_HINT}`,
  };
}
