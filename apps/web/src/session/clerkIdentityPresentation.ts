/**
 * Pure mapping from Clerk's user resource to what the identity block shows (M4 B2).
 *
 * Kept out of the component so the fallback rules are unit-testable in the node environment
 * (`vitest.config.ts` has no DOM). The component only renders this result.
 *
 * ## What is displayed, and what is not
 *
 * The block shows the Clerk user's **name** and **email** — the identity Clerk verified — plus the
 * `displayName` the server mapped that user onto (`GET /api/session`, §18.1). It never shows an
 * id, a token, a session id or any other credential: nothing here reads a session object.
 */

/**
 * The subset of Clerk's `UserResource` this module needs.
 *
 * Structural on purpose: importing `UserResource` from `@clerk/shared` would add a transitive
 * package to the web app's type surface, and the only fields used are these three. A real
 * `UserResource` is assignable to it.
 */
export interface ClerkUserLike {
  readonly fullName?: string | null;
  readonly username?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly primaryEmailAddress?: { readonly emailAddress?: string | null } | null;
  readonly emailAddresses?: ReadonlyArray<{ readonly emailAddress?: string | null }>;
}

export interface ClerkIdentityPresentation {
  readonly name: string;
  readonly email: string | null;
}

/** The first non-blank string, or `null`. */
function firstNonBlank(values: ReadonlyArray<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Resolve the display values for one Clerk user.
 *
 * Name preference: `fullName` → `firstName lastName` → `username` → the email's local part →
 * `"Signed-in user"`. The final fallback exists because the block is the only place the app says
 * "you are signed in"; rendering an empty name there would look like a failed sign-in.
 */
export function clerkIdentityFor(
  user: ClerkUserLike | null | undefined,
): ClerkIdentityPresentation {
  const email = firstNonBlank([
    user?.primaryEmailAddress?.emailAddress,
    ...(user?.emailAddresses ?? []).map((address) => address.emailAddress),
  ]);

  const firstName = user?.firstName?.trim() ?? '';
  const lastName = user?.lastName?.trim() ?? '';
  const joinedName = `${firstName} ${lastName}`.trim();

  const name = firstNonBlank([
    user?.fullName,
    joinedName,
    user?.username,
    email === null ? null : email.split('@')[0],
  ]);

  return { name: name ?? 'Signed-in user', email };
}
