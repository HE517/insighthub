/**
 * The Clerk identity block (M4 B2 acceptance 2/3): Clerk name + email, the server-mapped
 * `displayName`, and a `data-testid="sign-out"` control — with no id or credential rendered.
 *
 * The pure mapping and the presentational view are tested directly; the container is rendered with
 * a fake `useUser`/`useClerk`, because the repository's Vitest environment has no DOM and no
 * Clerk tenant.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({
  user: null as unknown,
  signOut: vi.fn(async () => undefined),
}));

vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: true, user: clerk.user }),
  useClerk: () => ({ signOut: clerk.signOut }),
}));

import { ClerkIdentity, ClerkIdentityView, serverIdentityLabel } from './ClerkIdentity.js';
import { clerkIdentityFor } from './clerkIdentityPresentation.js';
import type { ClerkServerIdentity, ClerkServerSessionState } from './clerkSession.js';

const SERVER_IDENTITY: ClerkServerIdentity = {
  userId: 'internal-ada',
  displayName: 'Ada Lovelace (server)',
};

const READY: ClerkServerSessionState = { status: 'ready', identity: SERVER_IDENTITY };

function renderView(overrides: Partial<Parameters<typeof ClerkIdentityView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ClerkIdentityView, {
      user: { name: 'Ada Lovelace', email: 'ada@example.com' },
      serverSession: READY,
      onSignOut: () => undefined,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  clerk.user = null;
  clerk.signOut.mockClear();
});

describe('clerkIdentityFor', () => {
  it('prefers fullName and the primary email', () => {
    expect(
      clerkIdentityFor({
        fullName: 'Ada Lovelace',
        primaryEmailAddress: { emailAddress: 'ada@example.com' },
        emailAddresses: [{ emailAddress: 'other@example.com' }],
      }),
    ).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });

  it('composes first + last name when fullName is absent', () => {
    expect(clerkIdentityFor({ firstName: 'Grace', lastName: 'Hopper' })).toEqual({
      name: 'Grace Hopper',
      email: null,
    });
  });

  it('falls back to username, then the email local part, then a generic label', () => {
    expect(clerkIdentityFor({ username: 'ada' })).toEqual({ name: 'ada', email: null });
    expect(clerkIdentityFor({ emailAddresses: [{ emailAddress: 'grace@example.com' }] })).toEqual({
      name: 'grace',
      email: 'grace@example.com',
    });
    expect(clerkIdentityFor({})).toEqual({ name: 'Signed-in user', email: null });
    expect(clerkIdentityFor(null)).toEqual({ name: 'Signed-in user', email: null });
  });

  it('ignores blank strings instead of rendering an empty name', () => {
    expect(
      clerkIdentityFor({
        fullName: '   ',
        firstName: '  ',
        lastName: '',
        username: '  ',
        primaryEmailAddress: { emailAddress: '  ' },
      }),
    ).toEqual({ name: 'Signed-in user', email: null });
  });
});

describe('serverIdentityLabel', () => {
  it('reports all three server-session states truthfully', () => {
    expect(serverIdentityLabel(READY)).toBe('server: Ada Lovelace (server)');
    expect(serverIdentityLabel({ status: 'pending' })).toBe('server identity pending');
    expect(serverIdentityLabel({ status: 'unavailable' })).toBe('server identity unavailable');
  });
});

describe('ClerkIdentityView', () => {
  it('renders the Clerk name, email, server displayName and sign-out control', () => {
    const markup = renderView();

    expect(markup).toContain('data-testid="clerk-identity"');
    expect(markup).toContain('data-testid="clerk-user-name"');
    expect(markup).toContain('>Ada Lovelace<');
    expect(markup).toContain('data-testid="clerk-user-email"');
    expect(markup).toContain('ada@example.com');
    expect(markup).toContain('data-testid="clerk-server-identity"');
    expect(markup).toContain('server: Ada Lovelace (server)');
    expect(markup).toContain('data-testid="sign-out"');
    // The Clerk block must not impersonate the demo identity contract.
    expect(markup).not.toContain('data-testid="session-identity"');
    expect(markup).not.toContain('demo session');
  });

  it('omits the email line when Clerk has no email, and states the server session honestly', () => {
    const markup = renderView({
      user: { name: 'Ada', email: null },
      serverSession: { status: 'pending' },
    });
    expect(markup).not.toContain('data-testid="clerk-user-email"');
    expect(markup).toContain('server identity pending');
  });

  it('never renders an id or a token-like value', () => {
    const markup = renderView();
    // The identity itself is fine; the internal user id must not be published in the identity block.
    expect(markup).not.toContain('internal-ada');
  });
});

describe('ClerkIdentity container', () => {
  it('reads the signed-in Clerk user through useUser', () => {
    clerk.user = {
      fullName: 'Grace Hopper',
      primaryEmailAddress: { emailAddress: 'grace@example.com' },
      emailAddresses: [{ emailAddress: 'grace@example.com' }],
    };

    const markup = renderToStaticMarkup(createElement(ClerkIdentity, { serverSession: READY }));

    expect(markup).toContain('Grace Hopper');
    expect(markup).toContain('grace@example.com');
    expect(markup).toContain('data-testid="sign-out"');
    expect(clerk.signOut).not.toHaveBeenCalled();
  });
});
