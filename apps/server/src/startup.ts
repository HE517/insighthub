/**
 * The **minimum startup gate** for M4 B1 (§18.5, §18.6).
 *
 * ## Why a separate pure function
 *
 * `index.ts` runs `main()` at module evaluation, so a test cannot import it without starting
 * a server. Putting the decision in a pure function lets the exact rule the entrypoint
 * enforces be exercised without a process, a port or a data directory — while `index.ts`
 * remains the only thing allowed to act on it.
 *
 * ## The one rule this round
 *
 * `NODE_ENV=production` **and** `AUTH_MODE=demo` is a contradiction: the demo bootstrap route
 * would be the only way to obtain an identity, and it lets the caller name the user
 * (`docs/CONTRACTS.md` §18.5). A production process must refuse to start rather than serve a
 * server where every caller can claim to be anyone.
 *
 * ## Boundary with B3
 *
 * B3 owns **complete** production configuration fail-fast (missing `CLERK_SECRET_KEY`,
 * missing `VITE_CLERK_PUBLISHABLE_KEY`, `AI_PROVIDER=stub`, …). This function deliberately
 * checks only the contradiction B1 introduces, so B3 can extend it (or replace it with a
 * config validator) without B1 having pre-empted any of its decisions. The `clerk` refusal is
 * B1-transitional: B2 supplies `createClerkSessionVerifier`, and the refusal disappears.
 */
import type { ServerConfig } from './config.js';

/** Why a startup was refused. Stable strings, so a test can assert the reason not the prose. */
export type StartupRefusalCode = 'DEMO_AUTH_IN_PRODUCTION' | 'CLERK_VERIFIER_NOT_WIRED';

export interface StartupRefusal {
  readonly code: StartupRefusalCode;
  readonly message: string;
}

/**
 * The refusal for this configuration, or `null` when starting is allowed.
 *
 * Pure: no I/O, no logging, no `process.exit`. `index.ts` prints and exits; a test just reads
 * the answer.
 */
export function findStartupRefusal(config: ServerConfig): StartupRefusal | null {
  const authMode = config.authMode ?? 'demo';
  const isProduction = config.nodeEnv === 'production';

  if (isProduction && authMode === 'demo') {
    return {
      code: 'DEMO_AUTH_IN_PRODUCTION',
      message:
        'AUTH_MODE=demo is a development/test fixture and must not run with NODE_ENV=production',
    };
  }

  // B1 transition: the real Clerk verifier is B2's deliverable. Starting in clerk mode now
  // would mean every request is served by a missing verifier — fail closed at startup instead
  // of answering 401 forever. B2 removes this branch when it wires `createClerkSessionVerifier`.
  if (authMode === 'clerk') {
    return {
      code: 'CLERK_VERIFIER_NOT_WIRED',
      message:
        'AUTH_MODE=clerk has no SessionVerifier in this build; the real Clerk verifier is M4 B2',
    };
  }

  return null;
}
