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
 *    that are provably before the commit (401, HTTP error, unreachable) say "nothing was created".
 * 3. **Aborted is not an error.** A cancelled request is the normal result of closing the panel or
 *    switching documents; returning `null` keeps it out of the UI (R9, A5 stale-response rules).
 */
import { DocumentCreateError, type DocumentCreateFailure } from './documentCreation.js';

/** The control's idle label. */
export const NEW_DOCUMENT_LABEL = 'New document';

/** The control's label while the request is in flight (the button is also `disabled`). */
export const NEW_DOCUMENT_PENDING_LABEL = 'Creating…';

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
const RETRY_HINT = 'Press New document to try again.';

/** A failure that happened before the commit: the directory is safe to keep using. */
const NOT_CREATED = 'Nothing was created.';

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
          title: 'No valid server session.',
          detail:
            'The server did not accept this browser’s session, so nothing was created. ' +
            'If the page has just loaded, reload it to sign in again, then try once more.',
        };
      case 'network':
        return {
          kind: 'network',
          title: 'The request did not complete.',
          detail:
            'The server could not be reached — you may be offline. The client cannot confirm ' +
            'whether a document was created, so press Refresh to check the list before trying ' +
            'again.',
        };
      case 'timeout':
        return {
          kind: 'timeout',
          title: 'The server did not answer in time.',
          detail:
            'The client cannot tell whether the document was created, because no answer arrived. ' +
            'Press Refresh to check the list before trying again.',
        };
      case 'malformed':
        return {
          kind: 'malformed',
          title: 'The server’s answer could not be read.',
          detail:
            'A document may have been created, but this client could not read the server’s ' +
            'confirmation. Press Refresh to check the list before trying again.',
        };
      case 'http':
        return {
          kind: 'http',
          title: 'The document was not created.',
          detail: `The server answered HTTP ${String(error.status ?? 'error')}. ${NOT_CREATED} ${RETRY_HINT}`,
        };
    }
  }

  // Anything that is not the typed error is still surfaced, never swallowed. The message is shown
  // (it is the only clue the user or an operator has) but without a stack trace — and it makes no
  // claim about what the server did.
  const detail =
    error instanceof Error && error.message.trim() !== ''
      ? `${error.message.replace(/[.\s]+$/, '')}.`
      : 'The request failed without a typed reason.';
  return {
    kind: 'unexpected',
    title: 'The document could not be created.',
    detail: `${detail} Press Refresh to check the list before trying again.`,
  };
}
