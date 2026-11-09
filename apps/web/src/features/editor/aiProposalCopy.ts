/**
 * The words the AI proposal panel shows, in one place.
 *
 * Two reasons this is a module instead of literals inside the component:
 *
 * 1. **The four apply failures are contract text.** `docs/CONTRACTS.md` §11.1 and the M3 brief fix
 *    one readable sentence per `ValidationFailureReason`; a reader (and A6's browser assertions)
 *    must be able to find them without digging through JSX. Keeping the map exported also makes it
 *    testable in the Node gate, where the panel itself cannot run.
 * 2. **Provider errors are typed.** `LocalProviderError.kind` is the stable discriminator
 *    (`unknown-instruction`, `invalid-instruction`, `selection-required`, `invalid-selection`,
 *    `no-change`), and `RemoteProviderError.kind` is the same idea for the endpoint
 *    (`unauthorized`, `not-found`, `not-configured`, `timeout`, `provider`, `invalid-output`,
 *    `aborted`); matching on `error.message` would be string coupling, and the local provider is
 *    explicitly *not* a language model, so "what did I say wrong" is a real user-facing question.
 *
 * The wording is Simplified Chinese (A2 UI-copy unification). The typed discriminators stay as
 * they are and are still rendered as `data-provider-error` / `data-reason`; only the text changed.
 *
 * No document text, no suggestion content and no React state lives here — only copy.
 */
import type { ValidationFailureReason } from '@insighthub/shared';

import type { AiProviderMode } from '../ai/aiProvider.js';
import { LocalProviderError, type LocalProviderFailure } from '../ai/localProvider.js';
import { RemoteProviderError, type RemoteProviderFailure } from '../ai/remoteProvider.js';

/**
 * One sentence per apply failure, in the exact vocabulary the M3 brief froze.
 *
 * The distinction matters to the user: `revision` means *you* moved the document, `anchor-unresolved`
 * means the reviewed text was deleted, `text-mismatch` means it is still there but says something
 * else, and `malformed` means the proposal itself is unusable. The panel never says only "stale",
 * because that word does not tell the user which of the four happened.
 */
export const APPLY_FAILURE_COPY: Readonly<Record<ValidationFailureReason, string>> = {
  revision: '生成此建议后，文档已在本地被修改。',
  'anchor-unresolved': '该建议所锚定的文本已不存在。',
  'text-mismatch': '你审阅过的文本已经改变。',
  malformed: '该建议无法直接应用。',
};

/** Title for each typed provider failure. `kind` itself is rendered as a machine-readable attribute. */
const PROVIDER_FAILURE_TITLES: Readonly<Record<LocalProviderFailure, string>> = {
  'unknown-instruction': '本地提供器无法识别该指令。',
  'invalid-instruction': '该指令不完整。',
  'selection-required': '该指令需要先选中文本。',
  'invalid-selection': '编辑器选区无法使用。',
  'no-change': '该指令不会改变文档。',
};

/**
 * The actionable detail for each local failure kind.
 *
 * The provider's own `Error.message` is deliberately **not** shown: it is an English diagnostic
 * (it names the supported instructions for a developer/log), while the panel teaches the user what
 * to click next. The typed `kind` is unchanged, so a test can still assert `unknown-instruction`
 * without matching any sentence.
 */
const LOCAL_PROVIDER_FAILURE_DETAILS: Readonly<Record<LocalProviderFailure, string>> = {
  'unknown-instruction': '无法识别该指令，请点击上方预设操作，或输入更明确的指令后点击生成。',
  'invalid-instruction':
    '该指令不完整。请检查后重试；替换选区时请使用“replace-selection: 新文本”的格式。',
  'selection-required': '请先在文档中选中一段文本，再点击生成。',
  'invalid-selection': '当前选区无效，请重新选择文本后再生成。',
  'no-change': '该指令不会改变文档，因此没有可审阅的建议。',
};

/**
 * Title per remote failure kind (`docs/CONTRACTS.md` §11.2, `RemoteProviderError`).
 *
 * The local entries above are untouched: this is an additive vocabulary, not a rewrite of the
 * deterministic provider's copy. `kind` is still rendered as `data-provider-error`.
 */
const REMOTE_PROVIDER_FAILURE_TITLES: Readonly<Record<RemoteProviderFailure, string>> = {
  unauthorized: '会话已失效，请重新登录。',
  'not-found': '无权访问该文档，或该文档不存在。',
  'not-configured': '服务器未配置 AI 提供器。',
  timeout: 'AI 提供器响应超时。',
  provider: 'AI 提供器未能生成建议。',
  'invalid-output': 'AI 提供器返回了无法使用的建议。',
  aborted: 'AI 请求已取消。',
};

/** The remote detail, with the status-specific split the client can already observe. */
function remoteProviderDetail(error: RemoteProviderError): string {
  switch (error.kind) {
    case 'unauthorized':
      return '服务器未接受当前会话，因此无法生成建议。请重新登录后再试。';
    case 'not-found':
      // Non-disclosure: the server deliberately does not say which of the two it is.
      return '服务器不会说明是文档不存在，还是当前身份没有访问权限。';
    case 'not-configured':
      return '服务器没有可用的 AI 配置，因此无法生成建议。请联系管理员或稍后重试。';
    case 'timeout':
      return '服务器在规定时间内没有返回结果，请稍后重试。';
    case 'provider':
      if (error.status === 403) {
        // `403 origin_not_allowed` (the AI route's `forbidden` is unreachable by construction:
        // `canRead` is the only requirement, so a caller without it leaves through 404).
        return '服务器以 HTTP 403 拒绝了该请求：请求来源不被允许。';
      }
      if (error.status === undefined) {
        // A fetch that never produced a response: DNS, refused connection, TLS.
        return '无法连接到 AI 服务，请检查网络后重试。';
      }
      return `AI 服务返回错误（HTTP ${error.status}），请稍后重试。`;
    case 'invalid-output':
      return '服务器返回的建议无法通过校验，因此没有生成提案。';
    case 'aborted':
      return '请求已取消，没有生成建议。';
  }
}

/**
 * Panel copy that changes with the provider mode.
 *
 * The remote note must never repeat the local-only claims ("deterministic", "no model", "local")
 * and the idle hint must not point at the local intent chips, because remote mode hides them.
 * Keeping both variants here (rather than branching inside JSX) lets the Node gate assert that
 * the remote wording makes no local/offline promise.
 */
export interface AiPanelProviderCopy {
  /** One-line explanation under the panel title. */
  readonly note: string;
  /** Placeholder of the instruction box. */
  readonly instructionPlaceholder: string;
  /** `ai-empty` text in the idle phase. */
  readonly idleEmpty: string;
}

export const AI_PANEL_PROVIDER_COPY: Readonly<Record<AiProviderMode, AiPanelProviderCopy>> = {
  local: {
    note: '确定性建议提供器——不使用语言模型。文档列表从服务器读取。在你点击接受之前，文档不会改变。',
    instructionPlaceholder: '例如：uppercase（转为大写）',
    idleEmpty: '尚无建议——请点击上方预设操作（或输入指令），然后点击生成。',
  },
  remote: {
    note: '建议由服务器上配置的 AI 模型生成。文档列表从服务器读取。在你点击接受之前，文档不会改变。',
    instructionPlaceholder: '例如：把第二段写得更简洁',
    idleEmpty: '尚无建议——描述你想要的修改，然后点击生成。',
  },
};

/** A provider failure, flattened into what the panel renders. */
export interface ProviderFailureCopy {
  /** `LocalProviderError.kind` / `RemoteProviderError.kind`, or `'unexpected'` for anything else. */
  readonly kind: string;
  /** One-line headline. */
  readonly title: string;
  /** The provider's own message, when it has one (never a stack trace). */
  readonly detail: string;
}

const UNEXPECTED_PROVIDER_FAILURE: ProviderFailureCopy = {
  kind: 'unexpected',
  title: '无法生成建议。',
  detail: '提供器失败，且没有给出可识别的原因。',
};

/**
 * Turn anything `provider.suggest()` threw into readable copy.
 *
 * A `LocalProviderError` keeps its `kind` (the UI renders it as `data-provider-error`, so a test can
 * assert `unknown-instruction` without matching any sentence); its message is replaced by the
 * actionable Chinese detail above.
 */
export function describeProviderFailure(error: unknown): ProviderFailureCopy {
  if (error instanceof LocalProviderError) {
    return {
      kind: error.kind,
      title: PROVIDER_FAILURE_TITLES[error.kind],
      detail: LOCAL_PROVIDER_FAILURE_DETAILS[error.kind],
    };
  }
  // Remote failures carry no response body and no prompt: the detail is derived only from the
  // typed kind and (for `provider`) the HTTP status, never from a response body.
  if (error instanceof RemoteProviderError) {
    return {
      kind: error.kind,
      title: REMOTE_PROVIDER_FAILURE_TITLES[error.kind],
      detail: remoteProviderDetail(error),
    };
  }
  // An untyped failure still gets a visible, honest sentence. The original message is deliberately
  // not rendered: it may be an internal English diagnostic, and this surface is Chinese only.
  return UNEXPECTED_PROVIDER_FAILURE;
}
