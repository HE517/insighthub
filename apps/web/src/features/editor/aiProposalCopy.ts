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
 *    `no-change`); matching on `error.message` would be string coupling, and the local provider is
 *    explicitly *not* a language model, so "what did I say wrong" is a real user-facing question.
 *
 * No document text, no suggestion content and no React state lives here — only copy.
 */
import type { ValidationFailureReason } from '@insighthub/shared';

import { LocalProviderError, type LocalProviderFailure } from '../ai/localProvider.js';

/**
 * One sentence per apply failure, in the exact vocabulary the M3 brief froze.
 *
 * The distinction matters to the user: `revision` means *you* moved the document, `anchor-unresolved`
 * means the reviewed text was deleted, `text-mismatch` means it is still there but says something
 * else, and `malformed` means the proposal itself is unusable. The panel never says "stale" alone,
 * because that word does not tell the user which of the four happened.
 */
export const APPLY_FAILURE_COPY: Readonly<Record<ValidationFailureReason, string>> = {
  revision: 'The document changed locally since this suggestion was generated.',
  'anchor-unresolved': 'The text this suggestion was anchored to no longer exists.',
  'text-mismatch': 'The text you reviewed has changed.',
  malformed: 'This suggestion cannot be applied as-is.',
};

/** Title for each typed provider failure. `kind` itself is rendered as a machine-readable attribute. */
const PROVIDER_FAILURE_TITLES: Readonly<Record<LocalProviderFailure, string>> = {
  'unknown-instruction': 'The local provider does not recognise that instruction.',
  'invalid-instruction': 'That instruction is incomplete.',
  'selection-required': 'That instruction needs a text selection.',
  'invalid-selection': 'The editor selection could not be used.',
  'no-change': 'That instruction would not change the document.',
};

/** A provider failure, flattened into what the panel renders. */
export interface ProviderFailureCopy {
  /** `LocalProviderError.kind`, or `'unexpected'` for anything else the provider threw. */
  readonly kind: string;
  /** One-line headline. */
  readonly title: string;
  /** The provider's own message, when it has one (never a stack trace). */
  readonly detail: string;
}

const UNEXPECTED_PROVIDER_FAILURE: ProviderFailureCopy = {
  kind: 'unexpected',
  title: 'The suggestion could not be generated.',
  detail: 'The provider failed without a typed reason.',
};

/**
 * Turn anything `provider.suggest()` threw into readable copy.
 *
 * A `LocalProviderError` keeps its `kind` (the UI renders it as `data-provider-error`, so a test can
 * assert `unknown-instruction` without matching English); its `message` already names the offending
 * instruction and the supported list, so it is shown verbatim rather than rewritten.
 */
export function describeProviderFailure(error: unknown): ProviderFailureCopy {
  if (error instanceof LocalProviderError) {
    return {
      kind: error.kind,
      title: PROVIDER_FAILURE_TITLES[error.kind],
      detail: error.message,
    };
  }
  if (error instanceof Error && error.message.trim() !== '') {
    return { ...UNEXPECTED_PROVIDER_FAILURE, detail: error.message };
  }
  return UNEXPECTED_PROVIDER_FAILURE;
}
