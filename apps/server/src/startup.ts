/**
 * The **startup gate** for M4 B1/B2 (§18.5, §18.6).
 *
 * ## Why a separate pure function
 *
 * `index.ts` runs `main()` at module evaluation, so a test cannot import it without starting
 * a server. Putting the decision in a pure function lets the exact rule the entrypoint
 * enforces be exercised without a process, a port or a data directory — while `index.ts`
 * remains the only thing allowed to act on it.
 *
 * ## The rules this round
 *
 * 1. `NODE_ENV=production` **and** `AUTH_MODE=demo` is a contradiction: the demo bootstrap route
 *    would be the only way to obtain an identity, and it lets the caller name the user (§18.5).
 *    A production process must refuse to start rather than serve a server where every caller
 *    can claim to be anyone.
 * 2. `AUTH_MODE=clerk` **without** `CLERK_SECRET_KEY` cannot verify any session. Starting anyway
 *    would answer `401 session_required` to every caller and look like "nobody is signed in"
 *    instead of "the server is misconfigured", so it is a startup failure
 *    (`AUTH_CONFIG_MISSING`, §18.6). The key's **value** is never printed, stored or returned —
 *    only its presence is inspected.
 *
 * The environment is a parameter rather than `process.env` so the rule is pure and a test states
 * the exact configuration it exercises. `index.ts` passes `process.env`.
 *
 * ## Boundary with B3
 *
 * B3 owns **complete** production configuration fail-fast (missing `VITE_CLERK_PUBLISHABLE_KEY`,
 * `AI_PROVIDER=stub`, …). This function deliberately checks only what B2 needs to make clerk
 * mode runnable, so B3 can extend it (or replace it with a config validator) without B2 having
 * pre-empted any of its decisions.
 */
import type { ServerConfig } from './config.js';

/** Why a startup was refused. Stable strings, so a test can assert the reason not the prose. */
export type StartupRefusalCode = 'DEMO_AUTH_IN_PRODUCTION' | 'AUTH_CONFIG_MISSING';

export interface StartupRefusal {
  readonly code: StartupRefusalCode;
  readonly message: string;
}

/**
 * The slice of the process environment the startup gate reads.
 *
 * Only presence is checked. The secret is never copied into a refusal, a log line or a field a
 * caller could return.
 */
export interface StartupEnvironment {
  readonly CLERK_SECRET_KEY?: string | undefined;
}

/**
 * The refusal for this configuration, or `null` when starting is allowed.
 *
 * Pure: no I/O, no logging, no `process.exit`. `index.ts` prints and exits; a test just reads
 * the answer.
 */
export function findStartupRefusal(
  config: ServerConfig,
  env: StartupEnvironment,
): StartupRefusal | null {
  const authMode = config.authMode ?? 'demo';
  const isProduction = config.nodeEnv === 'production';

  if (isProduction && authMode === 'demo') {
    return {
      code: 'DEMO_AUTH_IN_PRODUCTION',
      message:
        'AUTH_MODE=demo is a development/test fixture and must not run with NODE_ENV=production',
    };
  }

  // B1's transitional `CLERK_VERIFIER_NOT_WIRED` refusal is gone: B2 supplies the real verifier.
  // What remains is the configuration it needs. An empty value counts as missing (a shell line
  // `CLERK_SECRET_KEY=` must not start a clerk server that can never verify anything).
  if (authMode === 'clerk') {
    const secretKey = env.CLERK_SECRET_KEY;
    if (typeof secretKey !== 'string' || secretKey.trim() === '') {
      return {
        code: 'AUTH_CONFIG_MISSING',
        message:
          'AUTH_MODE=clerk requires CLERK_SECRET_KEY (server only); the value is never printed',
      };
    }
  }

  return null;
}
