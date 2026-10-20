/**
 * Document *presentation* state.
 *
 * This slice deliberately holds **no document body**. `docs/ARCHITECTURE.md` §0
 * and `AGENTS.md` R11 make `Y.Doc`/`Y.Text` the only source of truth for content,
 * so what is allowed here is exactly:
 *
 * - `activeDocumentId` — which room the UI is pointed at;
 * - metadata mirrored from the server for rendering (M2 fills `metadata`);
 * - UI state (the "switch document" input, panel visibility).
 *
 * A `content` field, a `markdown` field or a `text` field must never be added to
 * this file. If a component needs the body it reads `session.text`.
 *
 * ## Why there is no `role` field (M2 Phase 2, closes A7 F1)
 *
 * The role is exposed by the frozen collaboration seam — `session.getRole()`
 * (`docs/CONTRACTS.md` §17.9) — and read by the editor through `useSessionRole`. It is
 * deliberately **not** mirrored here (`docs/DECISIONS.md` D-065 §3 constraint 4): a second
 * copy in the store would need a writer, would go stale exactly when the seam says "unknown",
 * and would turn a UI gate into something that can be dispatched. Do not add
 * `role` / `documentRoleReceived` back.
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { DocumentMeta } from '@insighthub/shared';

export interface DocumentState {
  /** The document the workspace is currently pointed at. */
  activeDocumentId: string;
  /** Server-provided metadata for the active document (M2 populates this). */
  metadata: DocumentMeta | null;
  /** Free-text target used by the document switcher in the UI. */
  pendingDocumentId: string;
}

export const DEFAULT_DOCUMENT_ID = 'demo-document';

const initialState: DocumentState = {
  activeDocumentId: DEFAULT_DOCUMENT_ID,
  metadata: null,
  pendingDocumentId: DEFAULT_DOCUMENT_ID,
};

const documentSlice = createSlice({
  name: 'document',
  initialState,
  reducers: {
    /**
     * Point the workspace at another document.
     *
     * This is a *presentation* action. The actual room switch (and the teardown
     * of the previous session) happens in the collaboration layer when the editor
     * remounts for the new id — one socket carries at most one room
     * (`docs/CONTRACTS.md` §5.4), so there is nothing to sequence here.
     */
    documentSelected(state, action: PayloadAction<string>) {
      const next = action.payload.trim();
      if (next.length === 0) return;
      state.activeDocumentId = next;
      state.pendingDocumentId = next;
      // Metadata belongs to the previous document; stale metadata is worse than
      // none, so it is cleared rather than carried over.
      state.metadata = null;
    },
    pendingDocumentIdChanged(state, action: PayloadAction<string>) {
      state.pendingDocumentId = action.payload;
    },
    documentMetadataReceived(state, action: PayloadAction<DocumentMeta>) {
      state.metadata = action.payload;
    },
  },
});

export const documentActions = documentSlice.actions;
export const documentReducer = documentSlice.reducer;
