/**
 * App shell (M1/M2; M3 visual redesign; M4 B2 auth mode split).
 *
 * Layout: one light topbar (brand · document switcher · identity) above a single document
 * workspace (`DocumentWorkspace` renders the document header and the one editor canvas).
 * The document body lives **only** in `Y.Text` — no component here holds text state and
 * nothing here dispatches text.
 *
 * ## Two identity modes, one shell (M4 B2, `docs/CONTRACTS.md` §18)
 *
 * `currentAppMode()` reads exactly one switch: `VITE_CLERK_PUBLISHABLE_KEY`. That decision is
 * made once, at the top of this file, and it changes which **root** is rendered — not the shell:
 *
 * ```text
 * no key   → DemoApp   → useServerSession() (POST /api/session/bootstrap) → AppShell + SessionIdentity
 * key      → ClerkRoot → ClerkProvider → AuthGate → AppShell + ClerkIdentity
 * ```
 *
 * The demo branch is the pre-M4 application, unchanged in behaviour and DOM (the browser suite's
 * 68 scenarios run here). The Clerk branch is **lazy-loaded**: a demo build never downloads or
 * executes the Clerk SDK, so adding the dependency cannot perturb the demo path.
 *
 * ## Identity (M2 Phase 2, moved to the mode roots in M4 B2)
 *
 * In demo mode the identity comes from the server: `POST /api/session/bootstrap` → an `httpOnly`
 * session cookie → `userId` + `displayName` (`session/useServerSession.ts`). The editor never waits
 * for it (`AGENTS.md` R10, `docs/ARCHITECTURE.md` §2.1): the shell renders while the bootstrap is
 * in flight and the collaboration session opens from local state. When the bootstrap fails —
 * offline, dead server — the app keeps working with a local placeholder identity and the server
 * refuses any unauthorized traffic it later receives.
 *
 * In Clerk mode the same "never block the editor" rule applies to `GET /api/session`
 * (`session/clerkSession.ts`): the identity block renders immediately from Clerk's `useUser()`,
 * and the server-mapped `displayName` joins it when it arrives.
 *
 * No token is part of this component's state in either mode. The demo token lives in an `httpOnly`
 * cookie the browser holds and JS cannot read (`docs/CONTRACTS.md` §17.2, P2-9); Clerk's session is
 * Clerk's cookie. Neither is mirrored into React, Redux or web storage.
 *
 * ## Socket ownership (M1-A0.2, R15)
 *
 * The **only** document realtime connection in the running app is the one inside
 * `CollaborativeSession`, reached through `DocumentWorkspace` (now via `AppShell`). The M0
 * handshake hook (`useRealtimeChannel`) is deliberately **not mounted here**: it opened a second
 * `/ws` socket on the same origin, and one socket carries at most one room
 * (`docs/CONTRACTS.md` §5.4). The connection state shown to the user comes from the live session
 * (`ConnectionStatusBadge` in `DocumentWorkspace`), never from a parallel channel.
 *
 * ## Role (M2 Phase 2)
 *
 * This component does **not** hold or pass the document role. The role is read from the
 * collaboration session inside `DocumentWorkspace` (`session.getRole()`, §17.9), and
 * `docs/DECISIONS.md` D-065 §3 forbids mirroring it into Redux or React state here.
 *
 * ## What the M3 redesign removed from the shell
 *
 * The right-hand diagnostics column (`StatusPanel` + its 5 s `GET /health` poll) is no longer
 * rendered. `StatusPanel.tsx`, `MessageLog.tsx` and the Redux slices are deliberately **kept**.
 * The topbar no longer renders Live/Offline (the status lives in the document header, D1) and has
 * no theme switcher (single Cloud theme, D2).
 */
import { lazy, Suspense, useState } from 'react';

import { AppShell } from './AppShell.js';
import { initialsOf } from './features/collaborators/collaboratorPresentation.js';
import { currentAppMode } from './session/clerkMode.js';
import {
  DEMO_IDENTITY_CHOICES,
  isDemoSignedOut,
  selectedDemoIdentity,
  signInDemo,
  signOutDemo,
} from './session/demoAuth.js';
import { useServerSession } from './session/useServerSession.js';
import { presenceUserFor } from './user.js';

/**
 * Clerk root, loaded only when a publishable key is configured.
 *
 * `lazy` is what keeps the demo bundle free of `@clerk/clerk-react`: with no key the dynamic
 * import is never evaluated, so the 68 demo scenarios execute exactly the code they did before.
 */
const ClerkRoot = lazy(async () => {
  const module = await import('./session/ClerkRoot.js');
  return { default: module.ClerkRoot };
});

export function App() {
  const mode = currentAppMode();

  if (mode.kind === 'demo') return <DemoApp />;

  return (
    <Suspense
      fallback={
        <div className="auth-boot" data-testid="auth-boot" role="status">
          正在加载登录…
        </div>
      }
    >
      <ClerkRoot publishableKey={mode.publishableKey} />
    </Suspense>
  );
}

/**
 * The pre-M4 application: demo session identity, exactly as it shipped.
 *
 * `pending` behaves like `unavailable`: the editor must never wait for the network.
 *
 * A developer who used “退出登录” sees {@link DemoSignIn} instead of the shell. The flag is local
 * UI state only; the server session itself was already revoked with `DELETE /api/session`.
 */
function DemoApp() {
  return isDemoSignedOut() ? <DemoSignIn /> : <DemoWorkspace />;
}

function DemoWorkspace() {
  const serverSession = useServerSession(selectedDemoIdentity());
  const identity = serverSession.status === 'ready' ? serverSession.identity : null;

  return (
    <AppShell
      identity={
        <SessionIdentity state={serverSession} onLogout={() => void signOutDemo()} />
      }
      user={presenceUserFor(identity)}
    />
  );
}

/** The demo identity gate: pick a roster identity to test its permissions. */
function DemoSignIn() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (demoUserId: string): Promise<void> => {
    setPending(demoUserId);
    setError(null);
    if (!(await signInDemo(demoUserId))) {
      setPending(null);
      setError('登录失败：服务器没有接受该演示身份，请确认服务仍在运行。');
    }
  };

  return (
    <div className="demo-signin" data-testid="demo-signin">
      <div className="demo-signin__card">
        <h1 className="demo-signin__title">InsightHub 演示登录</h1>
        <p className="demo-signin__lead">选择一个演示身份，用对应角色检查权限与协作效果。</p>
        <div className="demo-signin__choices">
          {DEMO_IDENTITY_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="demo-signin__choice"
              data-testid={`demo-login-${choice.id}`}
              disabled={pending !== null}
              onClick={() => void choose(choice.id)}
            >
              <strong>{choice.name}</strong>
              <span>{choice.roleLabel}</span>
            </button>
          ))}
        </div>
        {error !== null && (
          <p className="demo-signin__error" role="alert">
            {error}
          </p>
        )}
      </div>
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
 * holds the session it claims, and `tests/browser/lib/app.mjs#waitForSessionActive` uses it as the
 * "identity decision settled" marker). The avatar glyph is decorative and `aria-hidden`, so the
 * name and the "演示会话" line are the only text this block contributes.
 */
function SessionIdentity({
  state,
  onLogout,
}: {
  state: ReturnType<typeof useServerSession>;
  onLogout: () => void;
}) {
  if (state.status === 'ready') {
    return (
      <div className="identity" data-testid="session-identity" title="服务器签发的会话身份">
        <span className="identity__avatar" aria-hidden="true">
          {initialsOf(state.identity.displayName)}
        </span>
        <span className="identity__copy">
          <strong className="identity__name">{state.identity.displayName}</strong>
          <DemoIdentityMenu onLogout={onLogout} />
        </span>
      </div>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <div
        className="identity identity--offline"
        data-testid="session-identity"
        title="没有服务器会话；使用本地占位身份"
      >
        <span className="identity__avatar" aria-hidden="true">
          ?
        </span>
        <span className="identity__copy">
          <strong className="identity__name">本地身份（离线）</strong>
        </span>
      </div>
    );
  }
  return null;
}

/** “演示会话” dropdown: switch roster identity or leave the demo. */
function DemoIdentityMenu({ onLogout }: { onLogout: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (demoUserId: string): Promise<void> => {
    setPending(demoUserId);
    setError(null);
    if (!(await signInDemo(demoUserId))) {
      setPending(null);
      setError('切换失败，请重试');
    }
  };

  return (
    <details className="identity__menu" data-testid="demo-identity-menu">
      <summary className="identity__menu-trigger">演示会话</summary>
      <div className="identity__menu-panel">
        {DEMO_IDENTITY_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="identity__menu-item"
            data-testid={`demo-switch-${choice.id}`}
            disabled={pending !== null}
            onClick={() => void choose(choice.id)}
          >
            {choice.name} · {choice.roleLabel}
          </button>
        ))}
        <button
          type="button"
          className="identity__menu-item identity__menu-item--danger"
          data-testid="demo-logout"
          onClick={onLogout}
        >
          退出登录
        </button>
        {error !== null && (
          <span className="identity__menu-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </details>
  );
}
