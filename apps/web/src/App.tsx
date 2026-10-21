/**
 * App shell (M1/M2; M3 visual redesign).
 *
 * Layout: one light topbar (brand · document switcher · identity) above a single document
 * workspace (`DocumentWorkspace` renders the document header and the one editor canvas).
 * The document body lives **only** in `Y.Text` — this component holds no text state and
 * dispatches no text.
 *
 * ## Identity (M2 Phase 2)
 *
 * Who this client is now comes from the server: `POST /api/session/bootstrap` → a session cookie →
 * `userId` + `displayName`. The editor is **not** made to wait for it (`AGENTS.md` R10,
 * `docs/ARCHITECTURE.md` §2.1): the shell renders while the bootstrap is still in flight and the
 * collaboration session opens from local state, i.e. bootstrap and editor run in parallel. When the
 * bootstrap fails — offline, dead server — the app keeps working with a local placeholder identity
 * and the server refuses any unauthorized traffic it later receives.
 *
 * The token is never part of this component's state. It lives in an `httpOnly` cookie the browser
 * holds and JS cannot read (`docs/CONTRACTS.md` §17.2, P2-9).
 *
 * ## Socket ownership (M1-A0.2, R15)
 *
 * The **only** document realtime connection in the running app is the one inside
 * `CollaborativeSession`, reached through `DocumentWorkspace`. The M0 handshake hook
 * (`useRealtimeChannel`) is deliberately **not mounted here**: it opened a second `/ws`
 * socket on the same origin, and one socket carries at most one room
 * (`docs/CONTRACTS.md` §5.4), so a second connection would either be rejected or split
 * the app across two transports. The connection state shown to the user comes from the
 * live session (`ConnectionStatusBadge` in `DocumentWorkspace`), never from a parallel
 * channel.
 *
 * ## Role (M2 Phase 2)
 *
 * This component does **not** hold or pass the document role. The role is read from the
 * collaboration session inside `DocumentWorkspace` (`session.getRole()`, §17.9), and
 * `docs/DECISIONS.md` D-065 §3 forbids mirroring it into Redux or React state here: a copy in
 * the shell would be a second source that can disagree with the seam.
 *
 * ## What the M3 redesign removed from the shell
 *
 * The right-hand diagnostics column (`StatusPanel` + its 5 s `GET /health` poll) is no longer
 * rendered: the connection state the user needs is already the document header's badge, read from
 * the live session. `StatusPanel.tsx`, `MessageLog.tsx` and the Redux slices are deliberately
 * **kept** (no dead-code cleanup in the same change). The topbar no longer renders Live/Offline
 * (the status lives in the document header, D1) and has no theme switcher (single Cloud theme,
 * D2) — both are visual decisions, not protocol changes.
 */
import { DocumentWorkspace } from './features/editor/DocumentWorkspace.js';
import { useServerSession } from './session/useServerSession.js';
import { documentActions } from './store/documentSlice.js';
import { useAppDispatch, useAppSelector } from './store/hooks.js';
import { presenceUserFor } from './user.js';
import { initialsOf } from './features/collaborators/collaboratorPresentation.js';

export function App() {
  // Identity, in parallel with everything else. `pending` behaves like `unavailable`: the editor
  // must never wait for the network.
  const serverSession = useServerSession();
  const identity = serverSession.status === 'ready' ? serverSession.identity : null;

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

        {/*
          The document switcher keeps the exact M1/M2 semantics: it is a real text input with
          `aria-label="Document id"`; Enter dispatches `documentSelected`, which rebuilds the
          session for the new room. No dropdown, no recent-document list, no route: switching a
          document is still "type the id and press Enter" (`tests/browser/lib/app.mjs`
          `setDocumentId` depends on this).
        */}
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

        <SessionIdentity state={serverSession} />
      </header>

      <main className="app-content">
        {/*
          `key` is load-bearing: a different document must be a different
          component instance, so the previous session is destroyed before the
          next one exists. One socket carries at most one room
          (docs/CONTRACTS.md §5.4).
        */}
        <DocumentWorkspace
          key={activeDocumentId}
          documentId={activeDocumentId}
          user={presenceUserFor(identity)}
        />
      </main>
    </div>
  );
}

/**
 * Shows which session identity the shell is running as.
 *
 * Deliberately *not* phrased as "signed in" or "authenticated": §17.0 forbids claiming more for a
 * demo bootstrap than it delivers. It claims an identity from a server-side roster; the session is
 * what later requests cannot forge.
 *
 * `data-testid="session-identity"` is a contract surface: the text must contain the current
 * identity's display name (`tests/browser/suite/20-m2-phase2-authz.mjs` reads it to prove the page
 * holds the session it claims). The avatar glyph is decorative and `aria-hidden`, so the name and
 * the "demo session" line are the only text this block contributes.
 */
function SessionIdentity({ state }: { state: ReturnType<typeof useServerSession> }) {
  if (state.status === 'ready') {
    return (
      <div
        className="identity"
        data-testid="session-identity"
        title="Server-issued session identity"
      >
        <span className="identity__avatar" aria-hidden="true">
          {initialsOf(state.identity.displayName)}
        </span>
        <span className="identity__copy">
          <strong className="identity__name">{state.identity.displayName}</strong>
          <small className="identity__meta">demo session</small>
        </span>
      </div>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <div
        className="identity identity--offline"
        data-testid="session-identity"
        title="No server session; local placeholder"
      >
        <span className="identity__avatar" aria-hidden="true">
          ?
        </span>
        <span className="identity__copy">
          <strong className="identity__name">local identity (offline)</strong>
        </span>
      </div>
    );
  }
  return null;
}
