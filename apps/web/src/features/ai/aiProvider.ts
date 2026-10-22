import { createLocalProvider } from './localProvider.js';
import type { AiProvider } from './provider.js';
import { createRemoteProvider } from './remoteProvider.js';

/**
 * The one place the browser chooses an AI provider (M3 Round 2).
 *
 * ```text
 * VITE_AI_PROVIDER unset / "local" ──► createLocalProvider()   deterministic, no network
 * VITE_AI_PROVIDER === "remote"    ──► createRemoteProvider()  POST /api/ai/suggest
 * ```
 *
 * ## Why the switch lives in the browser at all
 *
 * The **provider implementation** runs on the server; this flag only decides whether the client
 * is allowed to call that endpoint. It is build-time configuration, not a credential: the server
 * still requires a session cookie and still owns the model credential (`docs/DECISIONS.md` D-080
 * §3).
 *
 * Reading a credential-bearing environment variable here would put provider credentials in the
 * bundle, which §11.2 forbids. This module therefore reads exactly one variable —
 * `VITE_AI_PROVIDER` — and only compares it to the literal `"remote"`.
 *
 * ## Default: local
 *
 * The repository's test suites rely on deterministic proposals (`docs/DECISIONS.md` D-080 §4);
 * a missing variable therefore means the local provider, never "remote with a guessed endpoint".
 * Any value other than `"remote"` is also local: a typo must not silently start calling the
 * network in a test or a demo.
 */
export type AiProviderMode = 'local' | 'remote';

/** The environment shape this module reads. Structurally satisfied by `import.meta.env`. */
export interface AiProviderEnv {
  readonly VITE_AI_PROVIDER?: string;
}

export interface AiProviderFactoryOptions {
  /**
   * Environment override. Defaults to `import.meta.env`.
   *
   * Injected in tests so a case can assert the mapping without mutating process-wide state.
   */
  env?: AiProviderEnv;
  /** Explicit mode. When present it wins over `env` (test seam / future runtime setting). */
  mode?: AiProviderMode;
  /** Remote provider only: endpoint override. */
  endpoint?: string;
  /** Remote provider only: `fetch` override (fake in tests, platform `fetch` in production). */
  fetchImpl?: typeof fetch;
  /** Clock for `createdAt`; both providers accept it so a test can pin the suggestion. */
  now?: () => Date;
}

/**
 * Resolve the configured mode.
 *
 * Only the exact literal `"remote"` opts into the network. The comparison is deliberately not
 * case-insensitive: the value is documentation, not user input.
 */
export function readAiProviderMode(env: AiProviderEnv = import.meta.env): AiProviderMode {
  return env.VITE_AI_PROVIDER === 'remote' ? 'remote' : 'local';
}

/**
 * Create the configured provider.
 *
 * The returned object is a plain `AiProvider`; callers that need the mode for UI copy call
 * {@link readAiProviderMode} separately (the panel does exactly that, so the local-only intent
 * chips can be hidden in remote mode).
 */
export function createAiProvider(options: AiProviderFactoryOptions = {}): AiProvider {
  const mode = options.mode ?? readAiProviderMode(options.env ?? import.meta.env);

  if (mode === 'remote') {
    return createRemoteProvider({
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  return createLocalProvider(options.now === undefined ? {} : { now: options.now });
}
