/**
 * The application shell shared by the demo and Clerk modes (M4 B2).
 *
 * It owns the layout only — topbar (brand · document switcher · identity slot) and the keyed
 * `DocumentWorkspace` — so the two identity modes cannot drift apart in DOM structure. The
 * identity block itself is injected: the demo mode passes `SessionIdentity` (server demo session),
 * Clerk mode passes `ClerkIdentity` (Clerk user + mapped server display name).
 *
 * Everything below is unchanged M1–M3 behaviour, moved out of `App.tsx` in B2:
 *
 * - the document switcher is still a real text input with `aria-label="Document id"`; Enter
 *   dispatches `documentSelected` (the browser suite's `setDocumentId` depends on it);
 * - `key={activeDocumentId}` is load-bearing: one socket carries at most one room
 *   (`docs/CONTRACTS.md` §5.4), so a document switch destroys the previous session before the
 *   next exists;
 * - the body lives only in `Y.Text` (R11); this component holds no text state.
 */
import type { ReactNode } from 'react';
import type { CollaborativeSessionOptions } from '@insighthub/shared';

import { DocumentWorkspace } from './features/editor/DocumentWorkspace.js';
import { documentActions } from './store/documentSlice.js';
import { useAppDispatch, useAppSelector } from './store/hooks.js';

export interface AppShellProps {
  /** The identity block for the current mode. */
  readonly identity: ReactNode;
  /** The presence identity published through Yjs awareness. */
  readonly user: CollaborativeSessionOptions['user'];
}

export function AppShell({ identity, user }: AppShellProps) {
  const dispatch = useAppDispatch();
  const activeDocumentId = useAppSelector((state) => state.document.activeDocumentId);
  const pendingDocumentId = useAppSelector((state) => state.document.pendingDocumentId);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="InsightHub">
          <span className="brand__logo" aria-hidden="true" />
          <span className="brand__name">InsightHub</span>
        </div>

        <label className="switcher" title="Switch document by id">
          <span className="switcher__glyph" aria-hidden="true" />
          <input
            className="switcher__input"
            aria-label="Document id"
            autoComplete="off"
            spellCheck={false}
            value={pendingDocumentId}
            onChange={(event) =>
              dispatch(documentActions.pendingDocumentIdChanged(event.target.value))
            }
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              dispatch(documentActions.documentSelected(pendingDocumentId));
            }}
          />
        </label>

        {identity}
      </header>

      <main className="app-content">
        <DocumentWorkspace key={activeDocumentId} documentId={activeDocumentId} user={user} />
      </main>
    </div>
  );
}
