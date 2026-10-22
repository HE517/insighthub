/**
 * The identity block in Clerk mode (M4 B2, `docs/CONTRACTS.md` §18).
 *
 * ## What it shows
 *
 * | line | source | why |
 * | --- | --- | --- |
 * | name | Clerk `user` (`useUser`) | the identity Clerk verified |
 * | email | Clerk `user` primary email | the contract's second sign-in identifier (§18.1) |
 * | server label | `GET /api/session` → `displayName` | the **internal** user the Clerk identity maps to (§18.1); this is what presence and authorization see |
 * | sign-out | `data-testid="sign-out"` | ends the Clerk session, then clears a stale demo cookie |
 *
 * No id, session id or token is rendered or held: the only state in this file is what Clerk and
 * the server session already expose for display. The token stays in Clerk's own cookie and the
 * demo token is `httpOnly` — this component has no way to read either.
 *
 * ## Why the view is split from the container
 *
 * `ClerkIdentityView` is a pure function of props, so the DOM contract (`data-testid`s and the
 * three pieces of text) is asserted with `renderToStaticMarkup` in the node test environment.
 * `ClerkIdentity` is the thin adapter that reads Clerk hooks and owns the click handler.
 */
import { useCallback } from 'react';
import { useClerk, useUser } from '@clerk/clerk-react';

import { initialsOf } from '../features/collaborators/collaboratorPresentation.js';
import type { ClerkServerSessionState } from './clerkSession.js';
import { clerkIdentityFor, type ClerkIdentityPresentation } from './clerkIdentityPresentation.js';
import { performSignOut } from './signOut.js';

/** The server-mapped display name, or a truthful placeholder while it is unknown. */
export function serverIdentityLabel(state: ClerkServerSessionState): string {
  switch (state.status) {
    case 'ready':
      return `server: ${state.identity.displayName}`;
    case 'pending':
      return 'server identity pending';
    case 'unavailable':
      return 'server identity unavailable';
    default: {
      const never: never = state;
      return never;
    }
  }
}

export interface ClerkIdentityViewProps {
  readonly user: ClerkIdentityPresentation;
  readonly serverSession: ClerkServerSessionState;
  readonly onSignOut: () => void;
}

/** Presentational identity block. Rendered in the topbar in place of the demo `session-identity`. */
export function ClerkIdentityView({ user, serverSession, onSignOut }: ClerkIdentityViewProps) {
  return (
    <div
      className="identity identity--clerk"
      data-testid="clerk-identity"
      title="Signed in with Clerk"
    >
      <span className="identity__avatar" aria-hidden="true">
        {initialsOf(user.name)}
      </span>
      <span className="identity__copy">
        <strong className="identity__name" data-testid="clerk-user-name">
          {user.name}
        </strong>
        {user.email === null ? null : (
          <small className="identity__meta" data-testid="clerk-user-email">
            {user.email}
          </small>
        )}
        <small className="identity__meta" data-testid="clerk-server-identity">
          {serverIdentityLabel(serverSession)}
        </small>
      </span>
      <button
        type="button"
        className="identity__signout"
        data-testid="sign-out"
        onClick={onSignOut}
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * The Clerk-backed identity block.
 *
 * Rendered only inside the authenticated gate, so `useUser` and `useClerk` always run under a
 * `ClerkProvider` and only for a signed-in user.
 */
export function ClerkIdentity({ serverSession }: { serverSession: ClerkServerSessionState }) {
  const { user } = useUser();
  const { signOut } = useClerk();

  const onSignOut = useCallback(() => {
    // The gate re-renders on Clerk's own state change; nothing here navigates. The cleanup
    // request is intentionally fire-and-forget from React's perspective (`performSignOut` never
    // rejects), because the component that started it is about to unmount.
    void performSignOut({ signOut: () => signOut() });
  }, [signOut]);

  const presentation = clerkIdentityFor(user);

  return (
    <ClerkIdentityView user={presentation} serverSession={serverSession} onSignOut={onSignOut} />
  );
}
