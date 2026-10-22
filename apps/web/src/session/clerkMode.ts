/**
 * Which identity mode this build runs in (M4 B2, `docs/CONTRACTS.md` §18).
 *
 * ## The one switch
 *
 * Clerk is enabled by the **presence** of `VITE_CLERK_PUBLISHABLE_KEY`, and by nothing else. A
 * build with no key is the pre-M4 demo application, byte for byte in behaviour: the 68 browser
 * scenarios in `tests/browser/**` depend on it, so "no key" must never be a degraded Clerk mode
 * with a login screen nobody can pass. A key that is present but blank (a common `.env` typo:
 * `VITE_CLERK_PUBLISHABLE_KEY=`) is treated as absent for the same reason — a half-configured
 * deployment fails open to the demo app rather than into a login wall with no working sign-in.
 *
 * ## What this module is not
 *
 * The publishable key is **public by design** (§18.6): it is baked into the browser bundle and
 * only identifies the Clerk application. The **secret** key never appears in the web app. This
 * module therefore never reads, logs or compares any other environment variable, and it is
 * deliberately free of `@clerk/*` imports so the demo path does not even load the Clerk SDK
 * (`App.tsx` lazy-loads the Clerk root only in `clerk` mode).
 */

/** The identity mode this build was compiled for. */
export type AppMode =
  { readonly kind: 'demo' } | { readonly kind: 'clerk'; readonly publishableKey: string };

/**
 * The environment shape the decision needs.
 *
 * Structural (not `ImportMetaEnv`) so tests can pass a literal object; `import.meta.env` is
 * assignable to it.
 */
export interface ClerkModeEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY?: unknown;
}

/**
 * Decide the mode from one environment object.
 *
 * Only a non-blank string enables Clerk; every other value (`undefined`, `null`, `''`, whitespace,
 * a number from a malformed config) is `demo`.
 */
export function resolveAppMode(env: ClerkModeEnv): AppMode {
  const raw = env.VITE_CLERK_PUBLISHABLE_KEY;
  if (typeof raw !== 'string') return { kind: 'demo' };
  const publishableKey = raw.trim();
  if (publishableKey.length === 0) return { kind: 'demo' };
  return { kind: 'clerk', publishableKey };
}

/** The mode of this page, read from Vite's build-time environment. */
export function currentAppMode(): AppMode {
  return resolveAppMode(import.meta.env);
}
