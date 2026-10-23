/**
 * The Clerk login gate (M4 B2 acceptance 2): signed-out shows `<SignIn />`, signed-in renders the
 * application, not-loaded shows neither.
 *
 * No Clerk tenant and no network: the `@clerk/clerk-react` module is replaced by a fake hook and a
 * fake `SignIn`, and the markup is rendered with `react-dom/server` (the repository's Vitest
 * environment is `node`, so there is no DOM).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({
  auth: { isLoaded: false, isSignedIn: undefined as boolean | undefined },
  signInRenders: 0,
  signInRouting: [] as Array<string | undefined>,
  signUpRenders: 0,
  signUpRouting: [] as Array<string | undefined>,
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => clerk.auth,
  SignIn: (props: { routing?: string }) => {
    clerk.signInRenders += 1;
    clerk.signInRouting.push(props.routing);
    // Rendering the real widget needs a Clerk tenant; the gate's own contract is the wrapper
    // `data-testid="clerk-sign-in"`, which the assertions below check.
    return null;
  },
  SignUp: (props: { routing?: string }) => {
    clerk.signUpRenders += 1;
    clerk.signUpRouting.push(props.routing);
    return null;
  },
}));

import { AuthGate, AuthGateView } from './AuthGate.js';

const child = createElement('main', { 'data-testid': 'app-workspace' }, 'workspace');

function renderGate(): string {
  return renderToStaticMarkup(createElement(AuthGate, null, child));
}

beforeEach(() => {
  clerk.auth = { isLoaded: false, isSignedIn: undefined };
  clerk.signInRenders = 0;
  clerk.signInRouting = [];
  clerk.signUpRenders = 0;
  clerk.signUpRouting = [];
});

describe('AuthGate', () => {
  it('shows the gate in loading state before Clerk loads — no sign-in widget yet', () => {
    const markup = renderGate();

    expect(markup).toContain('data-testid="auth-gate"');
    expect(markup).toContain('data-state="loading"');
    expect(markup).not.toContain('clerk-sign-in');
    expect(markup).not.toContain('app-workspace');
    expect(clerk.signInRenders).toBe(0);
  });

  it('shows the sign-in screen when signed out, and does not mount the app', () => {
    clerk.auth = { isLoaded: true, isSignedIn: false };

    const markup = renderGate();

    expect(markup).toContain('data-testid="auth-gate"');
    expect(markup).toContain('data-state="signed-out"');
    expect(markup).toContain('data-testid="clerk-sign-in"');
    expect(markup).not.toContain('app-workspace');
    expect(clerk.signInRenders).toBe(1);
    // No router in this app: path routing would rewrite the document-switcher URL.
    expect(clerk.signInRouting).toEqual(['hash']);
  });

  it('treats `isSignedIn: undefined` as signed out', () => {
    clerk.auth = { isLoaded: true, isSignedIn: undefined };
    expect(renderGate()).toContain('data-testid="clerk-sign-in"');
  });

  it('renders the application once signed in, with no gate in the DOM', () => {
    clerk.auth = { isLoaded: true, isSignedIn: true };

    const markup = renderGate();

    expect(markup).toContain('data-testid="app-workspace"');
    expect(markup).not.toContain('data-testid="auth-gate"');
    expect(markup).not.toContain('clerk-sign-in');
    expect(clerk.signInRenders).toBe(0);
  });
});

describe('AuthGateView sign-up surface', () => {
  it('renders Clerk SignUp for #/sign-up instead of leaving the hash blank', () => {
    const markup = renderToStaticMarkup(
      createElement(AuthGateView, { status: 'signed-out', surface: 'sign-up' }, child),
    );
    expect(markup).toContain('data-testid="clerk-sign-up"');
    expect(markup).not.toContain('data-testid="clerk-sign-in"');
    expect(clerk.signUpRenders).toBe(1);
    expect(clerk.signUpRouting).toEqual(['hash']);
    expect(clerk.signInRenders).toBe(0);
  });
});

describe('AuthGateView', () => {
  it('is the same markup without Clerk context, so the contract can be reviewed in one place', () => {
    const markup = renderToStaticMarkup(
      createElement(AuthGateView, { status: 'signed-out' }, child),
    );
    expect(markup).toContain('data-testid="auth-gate"');
    expect(markup).toContain('data-testid="clerk-sign-in"');
    expect(markup).not.toContain('app-workspace');
  });
});
