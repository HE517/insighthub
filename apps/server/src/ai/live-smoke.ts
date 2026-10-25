/**
 * B12 — opt-in **live external-LLM** smoke test (D-085 §4).
 *
 * This is the only place in the repository that is allowed to make a real, billable model call.
 * It runs one fixed suggestion through the *same* factory and adapter the server uses, validates
 * the result with the frozen draft schema, and prints a small JSON summary. It never prints the
 * key, the request body or the full proposal.
 *
 * It fails closed unless the environment selects a **real** provider with its own credential
 * (`AI_PROVIDER=openai` + `OPENAI_API_KEY`, or `AI_PROVIDER=kimi` + `KIMI_API_KEY`), so a routine
 * `pnpm test` (which never sets either) can never reach the network. `stub` is rejected on
 * purpose: a stub draft is not evidence that an external LLM is reachable.
 *
 * Usage:
 *
 *   AI_PROVIDER=kimi KIMI_API_KEY=... AI_MODEL=kimi-k3 \
 *     pnpm --filter @insighthub/server exec tsx src/ai/live-smoke.ts
 *
 *   AI_PROVIDER=openai OPENAI_API_KEY=... AI_MODEL=gpt-5.6-luna \
 *     pnpm --filter @insighthub/server exec tsx src/ai/live-smoke.ts
 *
 * Exit codes: 0 = a valid draft came back; 1 = the provider failed; 2 = not configured.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { aiSuggestionDraftSchema } from '@insighthub/shared';

import { isServerAiProviderError } from './errors.js';
import { createServerAiProviderFromEnv } from './provider.js';

const INSTRUCTION = 'Replace the word "draft" with "final".';
const CONTENT = 'This is a draft sentence.';

/**
 * Optional local credential file, so an operator can put the key on disk instead of in a chat or
 * shell history. `apps/server/.env.local` is gitignored. Process env wins over the file.
 *
 * Only the variables this smoke understands are read, and no value is ever printed.
 */
function readLocalEnv(): Record<string, string> {
  const file = resolve(process.cwd(), '.env.local');
  const fallback = resolve(process.cwd(), '../../tests/deployed/.env.local');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    try {
      text = readFileSync(fallback, 'utf8');
    } catch {
      return {};
    }
  }
  const allowed = new Set([
    'AI_PROVIDER',
    'AI_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'KIMI_API_KEY',
    'AI_BASE_URL',
  ]);
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key, raw] = match;
    if (!allowed.has(key)) continue;
    values[key] = raw.replace(/^['"]|['"]$/g, '');
  }
  return values;
}

async function main(): Promise<number> {
  const local = readLocalEnv();
  const env = { ...local, ...process.env } as NodeJS.ProcessEnv;
  const configured = createServerAiProviderFromEnv(env);
  if (configured === null || configured.kind === 'stub') {
    console.error(
      '[live-smoke] not configured: set AI_PROVIDER=openai + OPENAI_API_KEY, or AI_PROVIDER=kimi + KIMI_API_KEY, in the environment or in apps/server/.env.local. Nothing was sent.',
    );
    return 2;
  }

  const started = Date.now();
  try {
    const draft = await configured.provider.suggest(
      { instruction: INSTRUCTION, content: CONTENT },
      AbortSignal.timeout(30_000),
    );
    const parsed = aiSuggestionDraftSchema.safeParse(draft);

    console.log(
      JSON.stringify({
        ok: parsed.success,
        provider: configured.kind,
        model: configured.model,
        latencyMs: Date.now() - started,
        operations: parsed.success ? parsed.data.operations.length : 0,
        summaryChars: parsed.success ? parsed.data.summary.length : 0,
        schemaErrors: parsed.success
          ? []
          : parsed.error.issues.map((issue) => issue.path.join('.')),
      }),
    );
    return parsed.success ? 0 : 1;
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        ok: false,
        provider: configured.kind,
        latencyMs: Date.now() - started,
        kind: isServerAiProviderError(error) ? error.kind : 'unknown',
        message: error instanceof Error ? error.message : 'unknown error',
      }),
    );
    return 1;
  }
}

process.exitCode = await main();
