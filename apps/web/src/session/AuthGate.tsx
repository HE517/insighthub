/**
 * The Clerk login gate (M4 B2, `docs/CONTRACTS.md` §18).
 *
 * ## Rendering rules
 *
 * | Clerk state | Rendered |
 * | --- | --- |
 * | SDK not loaded yet | the gate frame in `loading` state — no sign-in widget, because Clerk cannot accept input yet |
 * | loaded, signed out | the gate + Clerk `<SignIn />` (`data-testid="clerk-sign-in"`); the app is **not** mounted |
 * | loaded, signed in | the application (`children`); no gate in the DOM |
 *
 * The app is gated, not merely overlaid: when signed out, `DocumentWorkspace` and its socket do
 * not exist, so an unauthenticated page cannot open a document room and then be kicked out of it.
 *
 * ## Contract surfaces
 *
 * `data-testid="auth-gate"` is the login screen itself; `data-state` says which of its two states
 * it is in. `data-testid="clerk-sign-in"` wraps Clerk's widget, so a test can tell "the gate is up"
 * apart from "Clerk's form actually rendered". Email + Google are configured in the Clerk
 * dashboard, not in code (§18.1): there is deliberately no method list here that could drift from
 * the dashboard.
 *
 * `AuthGateView` is pure of hooks so the three states can be asserted without a Clerk tenant or a
 * network (`authGate.test.ts` renders it to static markup; `AuthGate` is the hook adapter). The
 * signed-out branch does render Clerk's own `<SignIn />`, which is why the view is only ever
 * mounted under `ClerkProvider`.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { SignIn, SignUp, useAuth } from '@clerk/clerk-react';

import { authSurfaceFor, type AuthSurface } from './authSurface.js';

export type AuthGateStatus = 'loading' | 'signed-out' | 'signed-in';

export interface AuthGateViewProps {
  readonly status: AuthGateStatus;
  /** Which Clerk widget to mount while signed out. Defaults to sign-in. */
  readonly surface?: AuthSurface;
  readonly children?: ReactNode;
}

/** The gate markup. Pure of hooks and network; the signed-out branch renders Clerk's widget. */
export function AuthGateView({ status, surface = 'sign-in', children }: AuthGateViewProps) {
  if (status === 'signed-in') return <>{children}</>;

  return (
    <div className="auth-gate" data-testid="auth-gate" data-state={status}>
      <div className="auth-gate__intro">
        <div className="brand" aria-label="InsightHub">
          <span className="brand__logo" aria-hidden="true" />
          <span className="brand__name">InsightHub</span>
        </div>
        <p className="auth-gate__lead">
          {status === 'loading' ? 'Checking your session…' : 'Sign in to open your team documents.'}
        </p>
      </div>

      {status === 'signed-out' ? (
        <div
          className="auth-gate__card"
          data-testid={surface === 'sign-up' ? 'clerk-sign-up' : 'clerk-sign-in'}
        >
          {/* Hash routing: this app has no router, and path routing would rewrite the URL the
              document switcher refreshes into. Clerk's SignIn links to #/sign-up, so that hash
              must mount SignUp or a new user gets a blank page and cannot create an account. */}
          {surface === 'sign-up' ? <SignUp routing="hash" /> : <SignIn routing="hash" />}
        </div>
      ) : (
        <p className="auth-gate__status" role="status">
          Loading sign-in…
        </p>
      )}
    </div>
  );
}

/** The hook adapter: reads Clerk's load/auth state and delegates the markup to {@link AuthGateView}. */
/** Track the hash Clerk's hash routing navigates to, without adding a router. */
function useHashSurface(): AuthSurface {
  const hash = useSyncExternalStore(
    (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
    () => window.location.hash,
    () => '',
  );
  return authSurfaceFor(hash);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const surface = useHashSurface();
  const status: AuthGateStatus = !isLoaded
    ? 'loading'
    : isSignedIn === true
      ? 'signed-in'
      : 'signed-out';

  return (
    <AuthGateView status={status} surface={surface}>
      {children}
    </AuthGateView>
  );
}
