/**
 * The deterministic stub provider — end-to-end AI evidence without a credential.
 *
 * ## What it is
 *
 * One predictable intent: **uppercase**. The whole `content` is uppercased, or — when a
 * `selection` is present — only the UTF-16 range `[from, to)` is uppercased. The result is one
 * `replace` operation with plain offsets into the submitted snapshot, exactly the shape
 * `docs/CONTRACTS.md` §11.2 calls a draft. It performs **no network I/O**, constructs no
 * client, reads no environment variable and holds no credential. The same input always
 * produces the same output byte for byte.
 *
 * This is what lets the real chain
 *
 * ```text
 * browser → POST /api/ai/suggest → draft → client mints anchors → preview → Accept
 * ```
 *
 * be exercised as evidence without `OPENAI_API_KEY`. It is not a model: it ignores the
 * `instruction` on purpose, so nothing about its behaviour can be mistaken for a real
 * provider's quality.
 *
 * ## Development/evidence only — never a production default
 *
 * The stub is reachable **only** through an explicit `AI_PROVIDER=stub`; an unset variable
 * still means "no provider" and the route answers `503 ai_provider_not_configured`. It must
 * never become a default, and it must never run in production: production configuration
 * validation (M4 D3) **must reject** `AI_PROVIDER=stub`. `index.ts` also prints a
 * development/evidence-only warning next to `ai ready stub` for the same reason. Adding a
 * silent fallback to the stub would turn a misconfigured production server into one that
 * returns fabricated successful edits; this file therefore contains no such fallback.
 *
 * ## Fail closed
 *
 * A selection that is negative, non-integer, reversed (`from > to`) or past the end of
 * `content` cannot produce a draft that a client could anchor. It rejects with the seam's
 * `invalid-output` kind (mapped by `route.ts` to `502 invalid_provider_output`) rather than
 * clamping the range or returning a half-valid operation. There is no partial draft.
 */
import type { AiOperationDraft, AiSuggestionDraft } from '@insighthub/shared';

import {
  ServerAiProviderError,
  type ServerAiProvider,
  type ServerAiSuggestInput,
} from './provider.js';

/** The `model` value every stub draft reports. Never a model name, never a secret. */
export const STUB_MODEL = 'stub';

/** Fixed summary for a whole-document uppercase draft. */
export const STUB_WHOLE_DOCUMENT_SUMMARY = 'Stub provider: uppercased the whole document.';

/** Fixed summary for a selection-scoped uppercase draft. */
export const STUB_SELECTION_SUMMARY = 'Stub provider: uppercased the selected range.';

/** A selection as it appears on the provider seam. */
type StubSelection = NonNullable<ServerAiSuggestInput['selection']>;

/**
 * Build the deterministic provider.
 *
 * Construction is pure and infallible: there is no key to check, no timeout to configure and
 * no connection to open. The caller (the environment factory) decides whether this provider
 * is selected at all.
 */
export function createStubProvider(): ServerAiProvider {
  return {
    async suggest(input, signal): Promise<AiSuggestionDraft> {
      // No network call means no socket to abort, but the seam's cancellation contract still
      // applies (AGENTS.md R9): a caller that already gave up must not receive a draft.
      if (signal.aborted) {
        throw new ServerAiProviderError('timeout', 'the stub provider request was aborted');
      }

      const operation = buildUppercaseOperation(input);
      return {
        summary:
          input.selection === undefined ? STUB_WHOLE_DOCUMENT_SUMMARY : STUB_SELECTION_SUMMARY,
        operations: [operation],
        model: STUB_MODEL,
      };
    },
  };
}

/**
 * The one deterministic transformation: uppercase the whole snapshot, or exactly the selected
 * range. A selection is never repaired or clamped; an impossible range is a typed failure.
 */
function buildUppercaseOperation(input: ServerAiSuggestInput): AiOperationDraft {
  const { content, selection } = input;

  if (selection === undefined) {
    return {
      kind: 'replace',
      index: 0,
      length: content.length,
      text: content.toUpperCase(),
    };
  }

  if (!isSelectionInsideContent(selection, content.length)) {
    throw new ServerAiProviderError(
      'invalid-output',
      'the stub provider cannot produce a draft for a selection outside the submitted content',
    );
  }

  return {
    kind: 'replace',
    index: selection.from,
    length: selection.to - selection.from,
    text: content.slice(selection.from, selection.to).toUpperCase(),
  };
}

/**
 * A selection is usable only when it is an ordered, integer, in-bounds UTF-16 range.
 *
 * The values are re-checked here rather than trusted from the request schema: the provider is
 * a seam tests and future callers may use directly, and "the schema already rejected that" is
 * not a property this module can rely on.
 */
function isSelectionInsideContent(selection: StubSelection, contentLength: number): boolean {
  return (
    Number.isInteger(selection.from) &&
    Number.isInteger(selection.to) &&
    selection.from >= 0 &&
    selection.to >= 0 &&
    selection.from <= selection.to &&
    selection.to <= contentLength
  );
}
