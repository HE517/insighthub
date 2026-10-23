/**
 * B12 — opt-in **live** OpenAI smoke test.
 *
 * This is the only place in the repository that is allowed to make a real, billable model call.
 * It runs one fixed suggestion through the *same* adapter the server uses, validates the result
 * with the frozen draft schema, and prints a small JSON summary. It never prints the key, the
 * request body or the full proposal.
 *
 * It fails closed when `AI_PROVIDER` is not `openai` or `OPENAI_API_KEY` is absent, so a routine
 * `pnpm test` (which never sets either) can never reach the network.
 *
 * Usage:
 *
 *   AI_PROVIDER=openai OPENAI_API_KEY=... OPENAI_MODEL=gpt-5.6-luna \
 *     pnpm --filter @insighthub/server exec tsx src/ai/live-smoke.ts
 *
 * Exit codes: 0 = a valid draft came back; 1 = the provider failed; 2 = not configured.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { aiSuggestionDraftSchema } from '@insighthub/shared';

import { createServerAiProviderFromEnv } from './openai.js';
import { isServerAiProviderError } from './provider.js';

const INSTRUCTION = 'Replace the word "draft" with "final".';
const CONTENT = 'This is a draft sentence.';

/**
 * Optional local credential file, so an operator can put the key on disk instead of in a chat or
 * shell history. `apps/server/.env.local` is gitignored. Process env wins over the file.
 *
 * Only the four variables this smoke understands are read, and no value is ever printed.
 */
function readLocalEnv(): Record<string, string> {
  const file = resolve(process.cwd(), '.env.local');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const allowed = new Set(['AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL']);
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
  const provider = createServerAiProviderFromEnv(env);
  if (provider === null) {
    console.error(
      '[live-smoke] not configured: set AI_PROVIDER=openai and OPENAI_API_KEY in the environment or in apps/server/.env.local. Nothing was sent.',
    );
    return 2;
  }

  const started = Date.now();
  try {
    const draft = await provider.suggest(
      { instruction: INSTRUCTION, content: CONTENT },
      AbortSignal.timeout(30_000),
    );
    const parsed = aiSuggestionDraftSchema.safeParse(draft);

    console.log(
      JSON.stringify({
        ok: parsed.success,
        model: env.OPENAI_MODEL ?? 'default',
        latencyMs: Date.now() - started,
        operations: parsed.success ? parsed.data.operations.length : 0,
        summaryChars: parsed.success ? parsed.data.summary.length : 0,
        schemaErrors: parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')),
      }),
    );
    return parsed.success ? 0 : 1;
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        ok: false,
        latencyMs: Date.now() - started,
        kind: isServerAiProviderError(error) ? error.kind : 'unknown',
        message: error instanceof Error ? error.message : 'unknown error',
      }),
    );
    return 1;
  }
}

process.exitCode = await main();
