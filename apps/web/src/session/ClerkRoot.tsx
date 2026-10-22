/**
 * The Clerk-mode root (M4 B2).
 *
 * Loaded lazily by `App.tsx` only when `VITE_CLERK_PUBLISHABLE_KEY` is present, so the demo build
 * never downloads the Clerk SDK. Composition:
 *
 * ```text
 * ClerkProvider            ← the only provider Clerk needs; publishable key is public (§18.6)
 *   AuthGate               ← signed out → login screen; signed in → the app
 *     ClerkWorkspace       ← GET /api/session (mapped displayName) + the shared AppShell
 * ```
 *
 * `ClerkProvider` owns the authentication session (tokens, rotation, expiry); InsightHub has no
 * second session (§18.2). The only extra read is the server's internal-user mapping, which is what
 * presence and authorization use.
 */
import { ClerkProvider } from '@clerk/clerk-react';

import { AppShell } from '../AppShell.js';
import { presenceUserFor } from '../user.js';
import { AuthGate } from './AuthGate.js';
import { ClerkIdentity } from './ClerkIdentity.js';
import { useClerkServerSession } from './clerkSession.js';

export interface ClerkRootProps {
  /** Public Clerk publishable key (`VITE_CLERK_PUBLISHABLE_KEY`). Never a secret. */
  readonly publishableKey: string;
}

export function ClerkRoot({ publishableKey }: ClerkRootProps) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <AuthGate>
        <ClerkWorkspace />
      </AuthGate>
    </ClerkProvider>
  );
}

/**
 * The authenticated application with its Clerk identity block.
 *
 * The presence user is the **server-mapped** identity once `GET /api/session` answers; while it is
 * in flight (or if it fails) the per-tab placeholder from `presenceUserFor(null)` is used, exactly
 * as the demo path does. The editor therefore opens from local state and never waits for the
 * identity read (`AGENTS.md` R10).
 */
function ClerkWorkspace() {
  const serverSession = useClerkServerSession();
  const identity = serverSession.status === 'ready' ? serverSession.identity : null;

  return (
    <AppShell
      identity={<ClerkIdentity serverSession={serverSession} />}
      user={presenceUserFor(identity)}
    />
  );
}
