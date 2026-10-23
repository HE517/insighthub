/**
 * Which Clerk surface to mount when signed out.
 *
 * Clerk's `<SignIn routing="hash" />` renders its own "Sign up" link and navigates to
 * `#/sign-up`. An app that mounts only `<SignIn />` therefore leaves that hash with **nothing to
 * render** — a blank page, and no way for a new user to create an account. That is a launch
 * blocker for a self-service product, so the gate mounts `<SignUp routing="hash" />` for that hash.
 *
 * Pure and dependency-free: the mapping is the contract, not Clerk's internals.
 */

export type AuthSurface = 'sign-in' | 'sign-up';

/** Map the current hash to the surface the gate must render. */
export function authSurfaceFor(hash: string): AuthSurface {
  // `#/sign-up`, `#/signUp`, `#sign-up` all count; anything else is the sign-in surface.
  return /^#\/?sign-?up\b/i.test(hash) ? 'sign-up' : 'sign-in';
}
