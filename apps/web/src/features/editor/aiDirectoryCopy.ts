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
 */
import { DocumentListError, type DocumentListFailure } from '../ai/tools.js';

/**
 * The exact empty-state sentence.
 *
 * A6 consumes this through `[data-testid="ai-directory-empty"]`; it is a constant (rather than a
 * literal in JSX) so the sentence can be asserted without parsing the component.
 */
export const AI_DIRECTORY_EMPTY_COPY = 'No readable documents';

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
const RETRY_HINT = 'Press Refresh to try again.';

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
          title: 'No valid server session.',
          detail:
            'The server did not accept this browser’s session, so it cannot list the documents you may read. If the page has just loaded, press Refresh; otherwise reload the page to sign in again.',
        };
      case 'network':
        return {
          kind: 'network',
          title: 'The document list is unavailable.',
          detail:
            'The server could not be reached — you may be offline. This list comes from the server and is never cached, so it stays empty until the connection returns. ' +
            RETRY_HINT,
        };
      case 'timeout':
        return {
          kind: 'timeout',
          title: 'The document list timed out.',
          detail: `The server took too long to answer. ${RETRY_HINT}`,
        };
      case 'malformed':
        return {
          kind: 'malformed',
          title: 'The document list could not be read.',
          detail: `The server returned a document list this client does not understand. ${RETRY_HINT}`,
        };
      case 'http':
        return {
          kind: 'http',
          title: 'The server refused to list documents.',
          detail: `The server answered HTTP ${String(error.status ?? 'error')}. ${RETRY_HINT}`,
        };
    }
  }

  // Anything that is not the typed error is still surfaced, never swallowed. The message is shown
  // (it is the only clue the user or an operator has) but without a stack trace.
  const detail =
    error instanceof Error && error.message.trim() !== ''
      ? `${error.message.replace(/[.\s]+$/, '')}.`
      : 'The document list failed without a typed reason.';
  return {
    kind: 'unexpected',
    title: 'The document list could not be loaded.',
    detail: `${detail} ${RETRY_HINT}`,
  };
}
