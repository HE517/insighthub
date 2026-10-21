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
 */
import { useState } from 'react';

import type { CollaborativeSession, CollaborativeSessionOptions } from '@insighthub/shared';

import { useCollaborativeDocument } from '../../collab/public.js';
import { capabilityGate } from '../permissions/capabilityGate.js';
import { ReadOnlyNotice } from '../permissions/ReadOnlyNotice.js';
import { OfflineNotice } from '../status/ConnectionStatusBadge.js';
import { CollaborativeMarkdownEditor } from './CollaborativeMarkdownEditor.js';
import { DocumentHeader } from './DocumentHeader.js';
import { runSessionHistory } from './editorEditability.js';
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
            <strong className="notice__title">The editor was resynchronised from the document</strong>
            <span className="notice__detail">{`reason: ${resyncReason}`}</span>
          </div>
        )}
      </div>

      <div className="canvas">
        <CollaborativeMarkdownEditor
          session={session}
          readOnly={gate.readOnly}
          onResync={setResyncReason}
        />
      </div>
    </div>
  );
}
