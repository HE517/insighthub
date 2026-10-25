/**
 * Environment parsing shared by the AI provider adapters and the factory.
 *
 * ## Why the parsing is one module
 *
 * Three readers need the same three answers — which provider is selected, which numbers bound a
 * request, and whether development is proxying the endpoint. Duplicating those rules per adapter
 * would let "what `AI_PROVIDER=kimi` means" drift between the adapter that runs and the startup
 * log that claims what is running (`docs/DECISIONS.md` D-085 §1).
 *
 * This module is a **leaf**: it imports nothing, so every adapter and the factory may depend on
 * it without adding an edge to the module graph.
 *
 * ## The rules
 *
 * - `AI_PROVIDER` is matched case/whitespace-insensitively and only by its literal text. An
 *   unset value is `''` (which every caller treats as "no provider"), never a default.
 * - Numeric bounds are permissive exactly like `config.ts`: an unset, blank, non-integer or
 *   non-positive value falls back to the frozen default. Fail-fast for an *invalid* value is the
 *   production gate's decision (`startup.ts`), not a runtime reader's.
 * - `AI_BASE_URL` is a **development** seam (a local proxy). It is honoured only when it parses
 *   as an `http(s)` URL; anything else degrades to `undefined` so the code allowlist applies.
 *   Production forbids the variable entirely (`AI_BASE_URL_FORBIDDEN`), so this reader is never
 *   reachable with it set on a running production process.
 */

/** `AI_PROVIDER`, trimmed and lower-cased. `''` when unset, so "no provider" is never a guess. */
export function readAiProviderSelector(env: NodeJS.ProcessEnv): string {
  return (env['AI_PROVIDER'] ?? '').trim().toLowerCase();
}

/** `undefined`/blank/non-positive/non-integer ⇒ `fallback`, so a typo cannot disable a bound. */
export function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The output-token ceiling, provider-independent.
 *
 * `AI_MAX_OUTPUT_TOKENS` is the unified name (D-085); `OPENAI_MAX_OUTPUT_TOKENS` remains a
 * deprecated alias so an existing deployment keeps its configured value across the rename.
 */
export function readMaxOutputTokens(
  env: Record<string, string | undefined>,
  fallback: number,
): number {
  return readPositiveIntegerEnv(
    env['AI_MAX_OUTPUT_TOKENS'] ?? env['OPENAI_MAX_OUTPUT_TOKENS'],
    fallback,
  );
}

/**
 * The development endpoint override, without a trailing slash, or `undefined`.
 *
 * `undefined` for a blank value (an empty shell variable means "unset") and for anything that is
 * not an absolute `http(s)` URL. The adapters then fall back to their code-allowlisted endpoint,
 * so a typo never becomes a request to an unintended host.
 */
export function readAiBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env['AI_BASE_URL'] ?? '').trim();
  if (raw === '') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.host === '') return undefined;
  } catch {
    return undefined;
  }
  return raw.replace(/\/+$/, '');
}
