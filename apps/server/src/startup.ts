/**
 * The **production configuration gate** for M4 B3 (`docs/CONTRACTS.md` §18.6,
 * `docs/DECISIONS.md` D-082 D2/D3).
 *
 * ## What this is for
 *
 * A production process must not start with a configuration that can only produce a broken or
 * unsafe server: no demo identity, no unverifiable Clerk session, a development CORS origin, a
 * relative/ephemeral data path, the deterministic AI stub, a model provider without its key, or a
 * development AI proxy endpoint. Each of those failures is a **startup refusal**, not a warning,
 * because the alternative is a server that looks healthy while it serves the wrong identity, loses
 * data on redeploy or bills for a provider it never configured (D-082 §5 B3, D-085 §1,
 * `CONTRACTS.md` §18.6).
 *
 * ## Why a separate pure function
 *
 * `index.ts` runs `main()` at module evaluation, so a test cannot import it without starting a
 * server. Putting the decision in a pure function lets the exact rule the entrypoint enforces be
 * exercised without a process, a port or a data directory — while `index.ts` remains the only
 * thing allowed to act on it.
 *
 * The function returns a **stable code plus a human-readable sentence**. It never returns,
 * logs or interpolates a configuration *value*: the caller prints the code and the sentence, so
 * a secret in the environment (or a malformed value that contains one) cannot reach the log.
 *
 * ## Scope (deliberately narrow)
 *
 * - **`NODE_ENV=production` only.** Unset means development; every non-production environment
 *   keeps the pre-B3 behaviour byte for byte (demo is the default, the temp data path is used).
 * - The B1/B2 guards are preserved: demo auth never runs in production, and clerk mode never
 *   starts without `CLERK_SECRET_KEY` (that second rule applies in every environment, exactly as
 *   it did before B3 — a clerk server that cannot verify anything is misconfigured everywhere).
 * - What this gate does **not** do: reject an insecure-but-https CORS origin, validate the Clerk
 *   publishable key, enforce AI rate limits, or migrate data. Those are B4, B5 and B6.
 *
 * ## B7 static check is a separate step, same vocabulary
 *
 * Whether the built web client exists (`STATIC_DIR` containing `index.html`) cannot be answered
 * without touching the filesystem, so it is not part of this pure function. `static-hosting.ts`
 * owns that check and returns the same `{ code, message }` shape; `index.ts` runs it **after**
 * the store and authz are open and **before** `listen`, and reports `STATIC_DIR_MISSING` through
 * the identical `refusing to start: <CODE>` line. The code is listed in
 * {@link StartupRefusalCode} so there is one vocabulary rather than two.
 *
 * ## Ordering
 *
 * Checks run in the order a reader would debug them: identity first (nothing else matters if the
 * process cannot authenticate), then the browser-facing origin, the durable path, and finally the
 * AI provider. The first refusal wins; a process with two mistakes reports one and exits.
 */
import { isAbsolute } from 'node:path';

import {
  DEFAULT_CORS_ORIGIN,
  DEFAULT_DATA_PATH,
  type AuthMode,
  type ServerConfig,
} from './config.js';

/**
 * Why a startup was refused. Stable strings, so a test asserts the reason and the operator can
 * search for it — the code is the contract, the sentence is only the explanation.
 */
export type StartupRefusalCode =
  | 'DEMO_AUTH_IN_PRODUCTION'
  | 'AUTH_MODE_INVALID'
  | 'CLERK_SECRET_KEY_MISSING'
  | 'CORS_ORIGIN_INVALID'
  | 'DATA_PATH_INVALID'
  | 'AI_PROVIDER_STUB_FORBIDDEN'
  | 'OPENAI_API_KEY_MISSING'
  | 'KIMI_API_KEY_MISSING'
  | 'AI_PROVIDER_INVALID'
  | 'AI_BASE_URL_FORBIDDEN'
  /**
   * M4 B7. Produced by `static-hosting.ts`'s filesystem check rather than by
   * {@link findStartupRefusal}, which stays pure: whether the built web client exists is an I/O
   * question. The entrypoint runs that check as its own step after the store and authz are open
   * and before `listen`, and reports the code with the same `refusing to start: <CODE>` shape
   * asserted for every code above. It is in this vocabulary so operators and tests have exactly
   * one list of startup refusal codes.
   */
  | 'STATIC_DIR_MISSING';

export interface StartupRefusal {
  readonly code: StartupRefusalCode;
  readonly message: string;
}

/**
 * The slice of the process environment the startup gate reads.
 *
 * `CORS_ORIGIN` and `INSIGHTHUB_DATA_PATH` are deliberately absent: `loadConfig` already resolved
 * them onto {@link ServerConfig} (applying the development defaults), so the gate inspects the
 * same resolved values the server would actually use rather than a second parse that could
 * disagree. `AUTH_MODE` is read raw because an *unknown* value is otherwise mapped to `demo`
 * before the gate can see it.
 *
 * Only presence is checked for secrets. A value is never copied into a refusal, a log line or a
 * field a caller could return.
 */
export interface StartupEnvironment {
  readonly AUTH_MODE?: string | undefined;
  readonly CLERK_SECRET_KEY?: string | undefined;
  readonly AI_PROVIDER?: string | undefined;
  readonly OPENAI_API_KEY?: string | undefined;
  readonly KIMI_API_KEY?: string | undefined;
  /**
   * Development-only AI endpoint override (D-085 §1). Production refuses any non-empty value, so
   * it is the one setting here whose *presence* is the problem rather than its content.
   */
  readonly AI_BASE_URL?: string | undefined;
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
  const isProduction = config.nodeEnv === 'production';
  const authMode = readEffectiveAuthMode(config, env);

  // --- Identity ---------------------------------------------------------
  // An explicitly unknown AUTH_MODE is a configuration mistake, not a request to run demo: say
  // so instead of reporting the demo contradiction that the value was silently mapped to.
  if (authMode === 'invalid') {
    if (isProduction) {
      return {
        code: 'AUTH_MODE_INVALID',
        message:
          'AUTH_MODE must be "clerk" in production; an unsupported value is never treated as demo (the value is never printed)',
      };
    }
  } else if (isProduction && authMode === 'demo') {
    return {
      code: 'DEMO_AUTH_IN_PRODUCTION',
      message:
        'AUTH_MODE=demo is a development/test fixture and must not run with NODE_ENV=production',
    };
  }

  // B2's guard, preserved: clerk mode cannot verify a session without its server-only secret.
  // An empty value counts as missing (a shell line `CLERK_SECRET_KEY=` must not start a clerk
  // server that can never verify anything). This applies in every environment: a clerk server
  // without the key answers 401 forever, which looks like "nobody is signed in" rather than
  // "the server is misconfigured".
  if (authMode === 'clerk' && !isPresent(env.CLERK_SECRET_KEY)) {
    return {
      code: 'CLERK_SECRET_KEY_MISSING',
      message:
        'AUTH_MODE=clerk requires CLERK_SECRET_KEY (server only); the value is never printed',
    };
  }

  // Everything below is a **production-only** rule. Development and test keep their defaults.
  if (!isProduction) return null;

  // --- Browser-facing origin -------------------------------------------
  // The development default is a plain-http localhost origin. A production server that keeps it
  // answers no real browser and invites a misconfigured proxy; an http origin would carry the
  // session cookie in clear text.
  const corsOrigin = config.corsOrigin.trim();
  if (corsOrigin === '' || corsOrigin === DEFAULT_CORS_ORIGIN || !isHttpsOrigin(corsOrigin)) {
    return {
      code: 'CORS_ORIGIN_INVALID',
      message:
        'CORS_ORIGIN must be an explicit https:// origin in production (the development default is not allowed; the value is never printed)',
    };
  }

  // --- Durable data -----------------------------------------------------
  // A relative path resolves against the process working directory, which on a PaaS is
  // ephemeral: every deploy/restart would silently start with an empty store (D-082 D2). The
  // development default is exactly that path, so it is refused by name.
  const dataPath = config.dataPath?.trim() ?? '';
  if (dataPath === '' || dataPath === DEFAULT_DATA_PATH || !isAbsolute(dataPath)) {
    return {
      code: 'DATA_PATH_INVALID',
      message:
        'INSIGHTHUB_DATA_PATH must be an absolute path to the durable store in production (the development default and relative paths are not allowed; the value is never printed)',
    };
  }

  // --- AI provider ------------------------------------------------------
  // `AI_PROVIDER` names a provider, never a URL or a model (D-085 §1). Three rules, in the order
  // an operator would debug them: the selector itself, that provider's credential, then the
  // endpoint. All three are production-only, so development keeps its stub and its dev proxy.
  const aiProvider = (env.AI_PROVIDER ?? '').trim().toLowerCase();

  // `stub` is deterministic, network-free and uppercases the content: it is evidence tooling,
  // never a production model, and it must never let a production endpoint answer as if a model
  // had responded (D-080 §3, D-082 D3).
  if (aiProvider === 'stub') {
    return {
      code: 'AI_PROVIDER_STUB_FORBIDDEN',
      message:
        'AI_PROVIDER=stub is a development/evidence-only provider and must not run in production',
    };
  }

  if (aiProvider === 'openai') {
    // Absent, empty or whitespace-only: same fail-closed answer as the runtime 503, but before
    // the process listens. The key itself is never read beyond a presence check.
    if (!isPresent(env.OPENAI_API_KEY)) {
      return {
        code: 'OPENAI_API_KEY_MISSING',
        message:
          'AI_PROVIDER=openai requires OPENAI_API_KEY (server only); the value is never printed',
      };
    }
  } else if (aiProvider === 'kimi') {
    // Same rule, separate credential: selecting Kimi must never borrow the OpenAI key (D-085 §1).
    if (!isPresent(env.KIMI_API_KEY)) {
      return {
        code: 'KIMI_API_KEY_MISSING',
        message: 'AI_PROVIDER=kimi requires KIMI_API_KEY (server only); the value is never printed',
      };
    }
  } else if (aiProvider !== '' && aiProvider !== 'disabled') {
    // The documented vocabulary is `openai | kimi | disabled | stub`, or unset (= disabled).
    // Anything else is a typo that would otherwise silently disable AI and look like a provider
    // outage.
    return {
      code: 'AI_PROVIDER_INVALID',
      message:
        'AI_PROVIDER must be "openai", "kimi", "disabled" or unset in production (the value is never printed)',
    };
  }

  // Endpoint selection is not configuration in production: the endpoint comes from the code
  // allowlist (`openai.ts` / `kimi.ts`). `AI_BASE_URL` exists only so a developer can point the
  // server at a local proxy, so **any** non-empty value is refused — a perfectly valid https URL
  // is exactly as forbidden as a typo, because the property being protected is "model traffic
  // never goes to a host chosen by the environment" (D-085 §1).
  if ((env.AI_BASE_URL ?? '').trim() !== '') {
    return {
      code: 'AI_BASE_URL_FORBIDDEN',
      message:
        'AI_BASE_URL is a development-only AI endpoint override and must be unset in production (the value is never printed)',
    };
  }

  return null;
}

/**
 * The mode the process would actually run in.
 *
 * The raw `AUTH_MODE` wins when it is set: `loadConfig` maps an unknown value to `demo` for
 * safety, so the gate has to see the original text to report `AUTH_MODE_INVALID` instead of the
 * demo contradiction. When the variable is absent (a test passing a hand-built config), the
 * resolved `config.authMode` is the answer, defaulting to demo as before.
 */
function readEffectiveAuthMode(
  config: ServerConfig,
  env: StartupEnvironment,
): AuthMode | 'invalid' {
  const rawAuthMode = env.AUTH_MODE?.trim();
  if (rawAuthMode === undefined || rawAuthMode === '') return config.authMode ?? 'demo';
  if (rawAuthMode === 'clerk') return 'clerk';
  if (rawAuthMode === 'demo') return 'demo';
  return 'invalid';
}

/** True for a defined, non-blank environment value (an empty shell variable means "unset"). */
function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** True for an absolute `https://` origin (a path, query or fragment is allowed but not needed). */
function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host !== '';
  } catch {
    return false;
  }
}
