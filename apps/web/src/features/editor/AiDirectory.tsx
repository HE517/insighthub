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
 * frozen lifecycle, not a regression — `docs/DECISIONS.md` D-078 §4 R2-1 records it (see the
 * errata there: the first wording said "the panel stays open"; the implementation closes it). Do
 * not "fix" it by moving the panel above the key or by keeping two sessions alive.
 *
 * ## The three states
 *
 * `loading` / `error` / `empty` are distinct and visible: `data-state` on the section, the
 * `ai-directory-error` block (with a typed `data-directory-error` and readable copy), and the
 * exact `ai-directory-empty` sentence ("No readable documents"). The list itself is never a
 * substitute for an error: a failed request never renders as "no documents" (R9).
 *
 * ## New document (M4 B12.5, `docs/DECISIONS.md` D-084 acceptance #7)
 *
 * The directory is also the product's only creation entry point: one `New document` button
 * (`data-testid="new-document"`) beside Refresh. Clicking it runs the frozen flow in
 * `newDocumentFlow.ts`:
 *
 * ```text
 * click → POST /api/documents (empty body → server's "Untitled document")
 *   → 201: refresh this list, then switch through the existing `documentSelected` action
 *   → failure: stay on the current document, add nothing to the list, show
 *              `data-testid="new-document-error"`, re-enable the button
 * ```
 *
 * The button is `disabled` while the request is in flight, and the flow's own in-flight guard is
 * the second line of defence against a double click that lands before React re-renders (§D-084
 * #6). Creation does not depend on the list state: a user with **zero** readable documents —
 * exactly the state B12.5 exists for — can still create one, including while the list is in its
 * `error` state. A failure never fabricates a row: the list stays whatever the server last said.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DocumentMeta } from '@insighthub/shared';

import { listDocuments } from '../ai/tools.js';
import {
  AI_DIRECTORY_EMPTY_COPY,
  describeDirectoryFailure,
  type DirectoryFailureCopy,
} from './aiDirectoryCopy.js';
import { createDocument } from './documentCreation.js';
import {
  NEW_DOCUMENT_LABEL,
  NEW_DOCUMENT_PENDING_LABEL,
  describeCreateFailure,
  type NewDocumentFailureCopy,
} from './newDocumentCopy.js';
import { createNewDocumentFlow, type NewDocumentFlow } from './newDocumentFlow.js';

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

/** The stateful half: fetch, abort, retry, create. The view below is pure so it can be tested as markup. */
export function AiDirectory({ activeDocumentId, onSelectDocument }: AiDirectoryProps) {
  const [state, setState] = useState<DirectoryState>({ kind: 'loading' });
  /** `true` between the click and the settled request; drives the button's `disabled`. */
  const [creating, setCreating] = useState(false);
  /** The last creation failure, or `null`. Cleared when a new attempt starts. */
  const [createFailure, setCreateFailure] = useState<NewDocumentFailureCopy | null>(null);
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

  // The create flow is created once per mount, so its in-flight guard cannot be reset by a
  // parent re-render; the callbacks it calls are read through a ref so it always runs the
  // current `load` / `onSelectDocument` (both are stable today, but a ref makes that explicit).
  const handlersRef = useRef({ load, onSelectDocument });
  handlersRef.current = { load, onSelectDocument };
  const flowRef = useRef<NewDocumentFlow | null>(null);
  if (flowRef.current === null) {
    flowRef.current = createNewDocumentFlow({
      create: (signal) => createDocument({ signal }),
      // Order matters: the server's list must contain the new document before the workspace
      // switches to it (D-084 #7: success → refresh, then switch).
      refreshDirectory: () => handlersRef.current.load(),
      selectDocument: (documentId) => handlersRef.current.onSelectDocument(documentId),
      onPendingChange: (pending) => {
        setCreating(pending);
        // A retry starts from a clean slate; the old error must not sit under the new attempt.
        if (pending) setCreateFailure(null);
      },
      onFailure: (error) => setCreateFailure(describeCreateFailure(error)),
    });
  }

  const create = useCallback((): void => {
    // `run()` is idempotent while pending (its own guard), so a double click can never send a
    // second POST even before the disabled attribute has rendered.
    void flowRef.current?.run();
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
      // A creation in flight belongs to this mount: cancel it rather than let it switch a
      // workspace the user has already left. The flow reports an aborted run as `ignored`.
      flowRef.current?.abort();
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
      creating={creating}
      createFailure={createFailure}
      onRefresh={load}
      onSelect={select}
      onCreate={create}
    />
  );
}

export interface AiDirectoryViewProps {
  state: DirectoryState;
  activeDocumentId: string;
  /** `true` while `POST /api/documents` is in flight; disables the New document button. */
  creating: boolean;
  /** The last creation failure, or `null`. Rendered as `new-document-error`. */
  createFailure: NewDocumentFailureCopy | null;
  onRefresh: () => void;
  onSelect: (documentId: string) => void;
  onCreate: () => void;
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
  creating,
  createFailure,
  onRefresh,
  onSelect,
  onCreate,
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
        <div className="ai-directory__actions">
          {/*
            The product's only creation entry point (D-084 #7). It is available in every list
            state on purpose: a new identity with no readable documents is the state B12.5
            exists for. `disabled` is the visible guard; the flow's in-flight guard is the one
            that survives a double click in the same tick.
          */}
          <button
            type="button"
            className="ai-directory__new"
            data-testid="new-document"
            title="Create a new document you own"
            disabled={creating}
            onClick={onCreate}
          >
            {creating ? NEW_DOCUMENT_PENDING_LABEL : NEW_DOCUMENT_LABEL}
          </button>
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
      </div>

      {/*
        Creation failure, reported beside the control that caused it. No list row is added here:
        the directory only ever renders what the server returned. The copy distinguishes
        "nothing was created" from "may have been created" (`newDocumentCopy.ts`).
      */}
      {createFailure === null ? null : (
        <div
          className="ai-directory__error"
          data-testid="new-document-error"
          data-create-error={createFailure.kind}
          role="alert"
        >
          <strong className="ai-directory__error-title">{createFailure.title}</strong>
          <span className="ai-directory__error-detail">{createFailure.detail}</span>
        </div>
      )}

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
