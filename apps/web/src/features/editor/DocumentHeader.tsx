/**
 * The document header: title · connection · role · presence · history.
 *
 * Display only. Every value arrives from `DocumentWorkspace`, which reads it from the
 * collaboration session through the frozen seam (`session.getRole()`,
 * `session.getCollaborators()`, `session.connectionStatus`, `session.getUndoState()`).
 * This file owns no state, subscribes to nothing and never touches `Y.Text` — moving the
 * chrome here is a layout change, not a new read path
 * (`docs/DECISIONS.md` D-065 §3: no second role subscription, no Redux mirror).
 *
 * ## What the browser contract requires of this markup
 *
 * - `[data-testid="active-document"]` is a **text element** whose trimmed text is exactly the
 *   document id. It is the header title, so the visual hierarchy and the contract agree. (`tests/browser/lib/app.mjs` `setDocumentId`)
 * - The role chip is a `<span>` whose text is exactly `role: <role>`, and it is **not rendered**
 *   when the role is unknown (`null`). `readEditorGate` identifies the chip by that exact shape,
 *   and §17.9 forbids presenting an unknown role as anything.
 * - `[data-testid="collaborator-list"]` is rendered even when empty, because the empty state
 *   ("Only you are here") is part of the acceptance surface.
 * - Collaborator names stay **real DOM text** inside the avatar row, not a `title=` attribute or
 *   CSS `content`; `readCollaborators` reads `innerText` from the avatar's ancestors.
 *
 * The undo/redo buttons run the **session's** `Y.UndoManager` through `runSessionHistory`, never
 * `document.execCommand` and never a text snapshot (`AGENTS.md` R13). Disabled logic lives here so
 * a viewer can never trigger the local `Y.Text` write an undo would be.
 *
 * ## The "Ask AI" trigger (M3)
 *
 * The one new control. It toggles the proposal panel in `DocumentWorkspace`; it is a pure UI
 * affordance and reads nothing itself. It is deliberately **not** disabled for a viewer: generating
 * a proposal only needs `canRead` (`docs/DECISIONS.md` D-075 §3.7), and the Accept button inside
 * the panel is what `canEdit` gates. `aria-expanded`/`aria-controls` describe the panel it owns,
 * and no existing selector (`active-document`, `connection-status`, `role: …`,
 * `collaborator-list`, `undo-state`, `markdown-editor`) changes shape or meaning.
 */
import type { ConnectionStatus, CollaboratorInfo, UndoState } from '@insighthub/shared';

import type { CapabilityGate } from '../permissions/capabilityGate.js';
import { CollaboratorList } from '../collaborators/CollaboratorList.js';
import { ConnectionStatusBadge } from '../status/ConnectionStatusBadge.js';

export interface DocumentHeaderProps {
  /** The active document id; also the title and the `active-document` contract text. */
  documentId: string;
  status: ConnectionStatus;
  /** The one permission decision, from `capabilityGate(session.getRole())`. */
  gate: CapabilityGate;
  collaborators: readonly CollaboratorInfo[];
  localClientId: number;
  undoState: UndoState;
  /** `runSessionHistory(readOnly, session, 'undo')` — supplied by the workspace. */
  onUndo: () => void;
  onRedo: () => void;
  /** Whether the AI proposal panel is currently open (drives `aria-expanded`). */
  aiOpen: boolean;
  /** Toggle the AI proposal panel — supplied by the workspace, which owns the panel's state. */
  onToggleAi: () => void;
}

export function DocumentHeader({
  documentId,
  status,
  gate,
  collaborators,
  localClientId,
  undoState,
  onUndo,
  onRedo,
  aiOpen,
  onToggleAi,
}: DocumentHeaderProps) {
  const readOnly = gate.readOnly;
  const undoDisabled = readOnly || !undoState.canUndo;
  const redoDisabled = readOnly || !undoState.canRedo;

  return (
    <header className="doc-head">
      <h1 className="doc-head__title" data-testid="active-document" title={documentId}>
        {documentId}
      </h1>

      <ConnectionStatusBadge status={status} />

      {/* Unknown role → no chip at all (never "role: null", never a guess). */}
      {gate.role === null ? null : (
        <span className="role-chip" title="Your role on this document">
          {`role: ${gate.role}`}
        </span>
      )}

      <div className="doc-head__right">
        {/*
          Open/close the AI proposal panel. Labelled "Ask AI" for the human and for the browser
          contract; enabled for every reader because generating needs only `canRead` (D-075 §3.7).
        */}
        <button
          type="button"
          className="doc-ai"
          data-testid="ai-open"
          aria-label="Ask AI"
          aria-expanded={aiOpen}
          aria-controls="ai-panel"
          title={aiOpen ? 'Close the AI proposal panel' : 'Ask the local AI provider for an edit'}
          onClick={onToggleAi}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M12 4l1.9 4.6L18.5 10.5l-4.6 1.9L12 17l-1.9-4.6L5.5 10.5l4.6-1.9z" />
            <path d="M18 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
          </svg>
          <span className="doc-ai__label">Ask AI</span>
        </button>

        <CollaboratorList collaborators={collaborators} localClientId={localClientId} />

        <div className="doc-actions" role="group" aria-label="Edit history">
          <button
            type="button"
            className="doc-action"
            aria-label="Undo"
            title={readOnly ? 'Read-only for your role' : 'Undo'}
            disabled={undoDisabled}
            onClick={onUndo}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M9 7 5 11l4 4" />
              <path d="M5 11h8a6 6 0 0 1 6 6" />
            </svg>
          </button>
          <button
            type="button"
            className="doc-action"
            aria-label="Redo"
            title={readOnly ? 'Read-only for your role' : 'Redo'}
            disabled={redoDisabled}
            onClick={onRedo}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m15 7 4 4-4 4" />
              <path d="M19 11h-8a6 6 0 0 0-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
