/**
 * The document workspace: one header, one canvas.
 *
 * ## States
 *
 * `CollaborativeSessionResult` is a discriminated union, so this component
 * narrows on `result.state` and never has to check for a nullable session:
 *
 * | `result.state` | Rendered |
 * | --- | --- |
 * | `initializing` | a loading shell — no editor, because there is no `Y.Text` yet |
 * | `active` | the header + the editor, bound to `result.session.text` |
 * | `failed` | an error shell with the reason, still no editor (never a fake one) |
 *
 * ## Document switching
 *
 * This component is remounted per `documentId` (the caller keys it), and the hook
 * owns session creation/teardown. That matters because of the frozen room
 * cardinality (`docs/CONTRACTS.md` §5.4): one socket carries at most one room, so
 * switching documents must destroy the old session rather than keep two alive.
 * A stale session can therefore never publish events into the new document's UI,
 * because the component that held it no longer exists.
 *
 * ## Permission gating (M2 Phase 2, closes A7 F1)
 *
 * The role is read from the **session**, through `useSessionRole` → `session.getRole()`
 * (`docs/CONTRACTS.md` §17.9). There is no role prop, no Redux field and no second parser of
 * `room-joined`: one source, one gate (`features/permissions/capabilityGate.ts`).
 *
 * | `getRole()` | editor | notice |
 * | --- | --- | --- |
 * | `owner` / `editor` | editable, exactly as before | none |
 * | `viewer` / `commenter` | read-only (`readOnly` compartment) | "Read-only for your role" |
 * | `null` (unknown) | **editable** — never locked out of unsent text (R10) | none |
 *
 * A demotion does not destroy the local document: the editor is reconfigured, not remounted,
 * so text already written to `Y.Text` stays there. The gate is advisory, not a security
 * boundary — the server rejects unauthorised mutations at every enforcement point (§17.5).
 *
 * ## What this file does NOT change (M3 UI redesign)
 *
 * Session lifecycle, role reads, capability gating and the editor binding are untouched. The
 * redesign moved markup and CSS: the former three debug cards (status, collaborators, document)
 * became one header row above a single paper canvas. The undo/redo buttons call the same
 * `runSessionHistory` the `Mod-z` keymap calls, so there is still exactly one undo mechanism
 * (`AGENTS.md` R13).
 *
 * ## AI proposal panel (M3)
 *
 * `DocumentHeader` owns the "Ask AI" trigger and this component owns whether the panel is open
 * (`useState`). The panel itself (`AiSuggestPanel`) owns the proposal, the diff it renders and its
 * generation state; **no document text ever enters React state** (`AGENTS.md` R11). The editor
 * hands over a read-only selection reader (`selectionRef`) so "generate from the selection" reads
 * the live `EditorState` instead of a copy.
 *
 * Closing the panel unmounts it, which disposes its revision tracker and aborts any in-flight
 * generation (R9). A panel that is closed is absent from the DOM, not merely hidden, so
 * `[data-testid="ai-panel"]` always means "open".
 *
 * ## Directory switching (M3 round 2)
 *
 * The panel's read-only directory asks this component to open another document. It does so by
 * dispatching the **existing** `documentSelected` action; `App.tsx` keys this workspace by
 * `documentId`, so the switch destroys the old session and remounts the workspace (one socket,
 * one room — §5.4). The AI panel closes as part of that remount. That is intended: a proposal's
 * anchors belong to one replica and are never carried across documents (D-078 §4 R2-1).
 *
 * ## Edit / preview mode (V1 Markdown preview)
 *
 * The single mode bit is UI state and lives here (`useState<EditorMode>`, default `editor`).
 * The header renders the switch; `DocumentCanvas` applies it:
 *
 * - `editor` mode: CodeMirror only.
 * - `preview` mode: `MarkdownPreview` (read-only, lazy renderer) is shown and the editor pane
 *   is hidden with CSS. The editor is **not** unmounted — same `EditorView`, same binding,
 *   same undo history, same scroll offset when it comes back.
 *
 * The preview reads `session.doc.getText(DOCUMENT_TEXT_KEY)` directly; nothing about the
 * document body enters this component's state (`AGENTS.md` R11). A document switch remounts the
 * workspace, so the mode resets to `editor` and the preview of the old document cannot survive
 * into the new one.
 */
import { useCallback, useRef, useState } from 'react';

import type { CollaborativeSession, CollaborativeSessionOptions } from '@insighthub/shared';

import { useCollaborativeDocument } from '../../collab/public.js';
import { documentActions } from '../../store/documentSlice.js';
import { useAppDispatch } from '../../store/hooks.js';
import { capabilityGate } from '../permissions/capabilityGate.js';
import { ReadOnlyNotice } from '../permissions/ReadOnlyNotice.js';
import { OfflineNotice } from '../status/ConnectionStatusBadge.js';
import { AiSuggestPanel } from './AiSuggestPanel.js';
import { CollaborativeMarkdownEditor } from './CollaborativeMarkdownEditor.js';
import { DocumentCanvas } from './DocumentCanvas.js';
import { DocumentHeader } from './DocumentHeader.js';
import { DEFAULT_EDITOR_MODE, type EditorMode } from './editorMode.js';
import { runSessionHistory } from './editorEditability.js';
import { MarkdownPreview } from './MarkdownPreview.js';
import {
  useSessionCollaborators,
  useSessionConnectionStatus,
  useSessionRole,
  useSessionUndoState,
} from './useCollaborativeSession.js';

export interface DocumentWorkspaceProps {
  documentId: string;
  user: CollaborativeSessionOptions['user'];
}

export function DocumentWorkspace({ documentId, user }: DocumentWorkspaceProps) {
  // The hook is A1's, reached only through the frozen `collab/public.ts` seam.
  const result = useCollaborativeDocument({ documentId, user });

  if (result.state === 'initializing') {
    return <SessionLoading documentId={documentId} />;
  }

  if (result.state === 'failed') {
    return <SessionFailed error={result.error} />;
  }

  // `result.state === 'active'` — the only branch where `Y.Text` exists.
  return <ActiveDocument session={result.session} documentId={documentId} />;
}

/** The loading shell. Still no editor: a fake one would be a lie about `Y.Text`. */
function SessionLoading({ documentId }: { documentId: string }) {
  return (
    <div className="workspace">
      <div className="canvas canvas--status" data-testid="session-initializing" role="status">
        <span className="canvas-status__pulse" aria-hidden="true" />
        <p className="canvas-status__text">
          Opening <code>{documentId}</code> from local storage…
        </p>
      </div>
    </div>
  );
}

/** The failure shell. The reason is shown; the editor is never faked. */
function SessionFailed({ error }: { error: string }) {
  return (
    <div className="workspace">
      <div className="canvas canvas--status">
        <div className="notice notice--error" data-testid="session-failed" role="alert">
          <strong className="notice__title">This document could not be opened</strong>
          <span className="notice__detail">{error}</span>
          <span className="notice__hint">
            Create the collaboration session again to retry. Local data already written by a
            previous session is kept.
          </span>
        </div>
      </div>
    </div>
  );
}

function ActiveDocument({
  session,
  documentId,
}: {
  session: CollaborativeSession;
  documentId: string;
}) {
  const collaborators = useSessionCollaborators(session);
  const status = useSessionConnectionStatus(session);
  const undoState = useSessionUndoState(session);
  // The one and only permission input: the session's own answer, re-read on every session
  // notification (`useSessionRole` → `session.getRole()`). `null` = unknown, which the gate
  // treats as "keep editing" so an unknown role can never lock a user out (R10, §17.9).
  const role = useSessionRole(session);
  const [resyncReason, setResyncReason] = useState<string | null>(null);
  // The only permission *decision* this component makes, and it comes from `documentCapabilities`
  // (`apps/web/src/features/permissions/capabilityGate.ts`). Advisory only: the server decides
  // (`docs/ARCHITECTURE.md` §8.2), and the editor is never made unusable by a UI guess — while the
  // role is unknown the gate reports `readOnly: false`.
  const gate = capabilityGate(role);

  // The directory's only write path: the same action the topbar switcher dispatches. No routing,
  // no second switch mechanism, no cross-document AI state.
  const dispatch = useAppDispatch();
  const selectDocument = useCallback(
    (nextDocumentId: string): void => {
      dispatch(documentActions.documentSelected(nextDocumentId));
    },
    [dispatch],
  );

  // The AI panel is a UI state, so it lives here: open/closed only, never the proposal (the panel
  // owns that) and never the document (the `Y.Text` owns that).
  const [aiOpen, setAiOpen] = useState(false);
  /**
   * The one mode bit. UI state only — never persisted, never dispatched, and it carries no
   * document content. Defaulting to `editor` is the pre-preview behaviour.
   */
  const [mode, setMode] = useState<EditorMode>(DEFAULT_EDITOR_MODE);
  /**
   * The editor's read-only selection reader. Held in a ref because it must be the *current* editor
   * instance: the editor replaces it on every (re)mount and clears it on teardown, so a stale
   * reader can never answer for a document that is no longer on screen.
   */
  const selectionReader = useRef<(() => { anchor: number; head: number } | null) | null>(null);

  return (
    <div className="workspace">
      <DocumentHeader
        documentId={documentId}
        status={status}
        gate={gate}
        collaborators={collaborators}
        localClientId={session.localClientId}
        undoState={undoState}
        onUndo={() => runSessionHistory(gate.readOnly, session, 'undo')}
        onRedo={() => runSessionHistory(gate.readOnly, session, 'redo')}
        aiOpen={aiOpen}
        onToggleAi={() => setAiOpen((open) => !open)}
        mode={mode}
        onModeChange={setMode}
      />

      {/*
        Fixed notice order: offline state first (it explains that edits are local), then the
        permission explanation, then the screen-reader undo state, then a resync alert. Each
        component decides whether it renders; only the canonical test ids remain in the DOM.
      */}
      <div className="doc-notices">
        <OfflineNotice status={status} />
        {/*
          The read-only explanation sits above the surface it describes. It renders nothing
          unless a **known** role may not edit (`readOnlyNoticeCopy.ts` owns both the decision
          and the wording), and it never claims that anything was saved.
        */}
        <ReadOnlyNotice gate={gate} />
        {/*
          Contract surface (`tests/browser/lib/app.mjs` `readUndoState`): the text mirrors
          `getUndoState()` with the same `undo: … · redo: …` vocabulary. Visually hidden — the
          icon buttons are the visible affordance — but present for assistive technology and for
          the browser suite.
        */}
        <span className="sr-only" aria-live="polite" data-testid="undo-state">
          {`undo: ${undoState.canUndo ? 'available' : 'none'} · redo: ${
            undoState.canRedo ? 'available' : 'none'
          }`}
        </span>
        {resyncReason === null ? null : (
          <div className="notice notice--warning" data-testid="editor-resync" role="alert">
            <strong className="notice__title">
              The editor was resynchronised from the document
            </strong>
            <span className="notice__detail">{`reason: ${resyncReason}`}</span>
          </div>
        )}
      </div>

      {/*
        The AI proposal panel. Mounted only while open: closing it disposes the revision tracker
        and aborts any generation in flight (the panel's own unmount effect). It renders between
        the notices and the canvas because it is a review surface *of* the document below it.
      */}
      {/*
        A proposal's anchors were minted against one `Y.Doc`. If the session is replaced (the
        one-time identity remount does exactly that), the old proposal belongs to a replica that
        no longer exists, so the panel is keyed on the session's `Y.Doc` client id: a new replica
        remounts it and drops the proposal instead of applying it to a different document instance.
      */}
      {aiOpen ? (
        <AiSuggestPanel
          key={session.localClientId}
          session={session}
          gate={gate}
          readSelection={() => selectionReader.current?.() ?? null}
          onClose={() => setAiOpen(false)}
          onSelectDocument={selectDocument}
        />
      ) : null}

      <DocumentCanvas
        mode={mode}
        editor={
          <CollaborativeMarkdownEditor
            session={session}
            readOnly={gate.readOnly}
            hidden={mode === 'preview'}
            onResync={setResyncReason}
            selectionRef={(read) => {
              selectionReader.current = read;
            }}
          />
        }
        preview={
          /*
            Keyed by the replica: a new `Y.Doc` is a new preview instance, so a snapshot from
            the previous document can never be shown for this one. Mounted only in preview mode
            by `DocumentCanvas`, which is what ties the `Y.Text` subscription to visibility.
          */
          <MarkdownPreview key={session.localClientId} session={session} />
        }
      />
    </div>
  );
}
