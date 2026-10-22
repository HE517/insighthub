/**
 * The read-only document directory inside the AI panel (`docs/DECISIONS.md` D-078 §4 R2-1).
 *
 * ## What it owns
 *
 * A list of the documents the **current identity may read**, read from `GET /api/documents`
 * through the already-implemented `listDocuments(signal)` tool. It is deliberately not a
 * cross-document AI surface: clicking another document dispatches the **existing**
 * `documentSelected` action and nothing else, so the workspace switches exactly as the topbar
 * switcher does. There is no cross-document proposal, no cross-document apply, and no new route.
 *
 * | state | where it lives |
 * | --- | --- |
 * | which documents are readable | `GET /api/documents` (server authority, never guessed) |
 * | the fetched list | this component's React state — **metadata only**, never document text (R11) |
 * | the active document id | `session.documentId`, passed down; Redux stays the owner of the switch |
 *
 * ## Lifecycle and cancellation (R9)
 *
 * Mount = panel open (the panel is only rendered while open), so the first fetch happens on
 * mount. Refresh aborts the previous request and starts a new one. Unmount — closing the panel,
 * switching documents, or the workspace remounting for a new `documentId` — aborts the in-flight
 * request and invalidates its generation, so a late answer can never write state into a component
 * that is gone or overwrite a newer list.
 *
 * The `AbortController` is created here and its `signal` is forwarded to `listDocuments`, which
 * forwards it to `fetch` (`features/ai/tools.ts` → `api.ts`).
 *
 * ## Why a switch closes the panel (intended, not a bug)
 *
 * `App.tsx` keys `DocumentWorkspace` by `documentId`: a different document is a different
 * component instance because one socket carries at most one room (`docs/CONTRACTS.md` §5.4). The
 * panel lives inside that workspace, so selecting a document unmounts the panel. That is the
 * frozen lifecycle, not a regression — `docs/DECISIONS.md` D-078 §4 R2-1 explicitly keeps it. Do
 * not "fix" it by moving the panel above the key or by keeping two sessions alive.
 *
 * ## The three states
 *
 * `loading` / `error` / `empty` are distinct and visible: `data-state` on the section, the
 * `ai-directory-error` block (with a typed `data-directory-error` and readable copy), and the
 * exact `ai-directory-empty` sentence ("No readable documents"). The list itself is never a
 * substitute for an error: a failed request never renders as "no documents" (R9).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DocumentMeta } from '@insighthub/shared';

import { listDocuments } from '../ai/tools.js';
import {
  AI_DIRECTORY_EMPTY_COPY,
  describeDirectoryFailure,
  type DirectoryFailureCopy,
} from './aiDirectoryCopy.js';

/** The directory's state machine. `ready` with zero rows renders as `empty`. */
export type DirectoryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly documents: readonly DocumentMeta[] }
  | { readonly kind: 'error'; readonly failure: DirectoryFailureCopy };

export interface AiDirectoryProps {
  /** The document the workspace is pointed at; marked `aria-current="true"` in the list. */
  activeDocumentId: string;
  /**
   * Switch the workspace to another readable document.
   *
   * The caller wires this to the existing `documentActions.documentSelected` action. This
   * component never talks to the store or the collaboration layer itself.
   */
  onSelectDocument: (documentId: string) => void;
}

/** The stateful half: fetch, abort, retry. The view below is pure so it can be tested as markup. */
export function AiDirectory({ activeDocumentId, onSelectDocument }: AiDirectoryProps) {
  const [state, setState] = useState<DirectoryState>({ kind: 'loading' });
  /** The in-flight request, so Refresh, a switch and unmount can all cancel it (R9). */
  const abortRef = useRef<AbortController | null>(null);
  /**
   * A monotonic request id. Aborting the signal is the primary guard; the id is the second one,
   * so a rejection that resolves after a newer `load()` was started cannot overwrite it.
   */
  const requestRef = useRef(0);

  const load = useCallback((): void => {
    // Refresh: cancel the previous list request before starting a new one, so exactly one answer
    // can win (the same discipline the proposal Generate button uses).
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    setState({ kind: 'loading' });

    void listDocuments(controller.signal).then(
      (documents) => {
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        abortRef.current = null;
        setState({ kind: 'ready', documents });
      },
      (error: unknown) => {
        if (controller.signal.aborted || requestId !== requestRef.current) return;
        abortRef.current = null;
        const failure = describeDirectoryFailure(error);
        // `aborted` is the normal outcome of a close/switch; it is not a user-visible failure.
        if (failure === null) return;
        setState({ kind: 'error', failure });
      },
    );
  }, []);

  // Fetch on open (this component is mounted only while the panel is open), and abort on close /
  // document switch / workspace remount. The request id is bumped here too, so a resolution after
  // unmount is ignored even if the signal has already fired (R9).
  useEffect(() => {
    load();
    return () => {
      requestRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  const select = useCallback(
    (documentId: string): void => {
      // The current document is already open; dispatching it would clear its metadata for no
      // reason. Every other id goes through the one existing switch action.
      if (documentId === activeDocumentId) return;
      onSelectDocument(documentId);
    },
    [activeDocumentId, onSelectDocument],
  );

  return (
    <AiDirectoryView
      state={state}
      activeDocumentId={activeDocumentId}
      onRefresh={load}
      onSelect={select}
    />
  );
}

export interface AiDirectoryViewProps {
  state: DirectoryState;
  activeDocumentId: string;
  onRefresh: () => void;
  onSelect: (documentId: string) => void;
}

/**
 * The pure view.
 *
 * Exported for the Node test, which renders it with `renderToStaticMarkup`: that is how the
 * testids, the `aria-current` marker and the three-state copy stay asserted without a DOM.
 */
export function AiDirectoryView({
  state,
  activeDocumentId,
  onRefresh,
  onSelect,
}: AiDirectoryViewProps) {
  const status =
    state.kind === 'loading'
      ? 'loading'
      : state.kind === 'error'
        ? 'error'
        : state.documents.length === 0
          ? 'empty'
          : 'ready';

  return (
    <section
      className="ai-directory"
      data-testid="ai-directory"
      data-state={status}
      aria-label="Readable documents"
      aria-busy={state.kind === 'loading'}
    >
      <div className="ai-directory__head">
        <div className="ai-directory__heading">
          <h3 className="ai-directory__title">Documents</h3>
          <p className="ai-directory__note">
            Readable by your identity. Selecting one opens it; the proposal stays on the active
            document.
          </p>
        </div>
        <button
          type="button"
          className="ai-directory__refresh"
          data-testid="ai-directory-refresh"
          title="Reload the list of documents you may read"
          disabled={state.kind === 'loading'}
          onClick={onRefresh}
        >
          Refresh
        </button>
      </div>

      {state.kind === 'loading' ? (
        <p className="ai-directory__loading" role="status">
          Loading readable documents…
        </p>
      ) : null}

      {state.kind === 'error' ? (
        <div
          className="ai-directory__error"
          data-testid="ai-directory-error"
          data-directory-error={state.failure.kind}
          role="alert"
        >
          <strong className="ai-directory__error-title">{state.failure.title}</strong>
          <span className="ai-directory__error-detail">{state.failure.detail}</span>
        </div>
      ) : null}

      {state.kind === 'ready' && state.documents.length === 0 ? (
        <p className="ai-directory__empty" data-testid="ai-directory-empty">
          {AI_DIRECTORY_EMPTY_COPY}
        </p>
      ) : null}

      {state.kind === 'ready' && state.documents.length > 0 ? (
        <ul className="ai-directory__list">
          {state.documents.map((document) => {
            const current = document.id === activeDocumentId;
            return (
              <li key={document.id} className="ai-directory__row">
                <button
                  type="button"
                  className="ai-directory__item"
                  data-testid="ai-directory-item"
                  data-document-id={document.id}
                  aria-current={current ? 'true' : undefined}
                  title={
                    current ? `${document.id} — open in this workspace` : `Open ${document.id}`
                  }
                  onClick={() => onSelect(document.id)}
                >
                  <span className="ai-directory__doc-title">{document.title}</span>
                  <code className="ai-directory__doc-id">{document.id}</code>
                  {current ? (
                    <span className="ai-directory__current" aria-hidden="true">
                      current
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
