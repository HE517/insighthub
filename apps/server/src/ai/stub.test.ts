/**
 * The deterministic stub provider and its `AI_PROVIDER=stub` wiring.
 *
 * No test here touches the internet. The unit tests call a pure provider; the HTTP tests use
 * the same loopback harness as `route.test.ts`, so the real session guard, authorization call,
 * provider seam, draft validation and response mapping all run unchanged.
 *
 * Covered:
 *
 * 1. **Determinism** — the same input produces the same draft, unit-level and across two real
 *    HTTP requests (byte-identical response bodies).
 * 2. **Selection** — only `[from, to)` changes; an impossible selection fails closed with no
 *    draft (502 invalid_provider_output).
 * 3. **Wiring** — `AI_PROVIDER=stub` selects the stub without a key; unset/disabled/openai
 *    without a key still mean "no provider" and answer 503.
 * 4. **Response shape** — exactly the draft fields, no credential or prompt material.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { aiSuggestionDraftSchema, type AiSuggestionDraft } from '@insighthub/shared';

import { createServerAiProviderFromEnv, readServerAiProviderKind } from './openai.js';
import { ServerAiProviderError, type ServerAiProvider } from './provider.js';
import {
  STUB_MODEL,
  STUB_SELECTION_SUMMARY,
  STUB_WHOLE_DOCUMENT_SUMMARY,
  createStubProvider,
} from './stub.js';
import {
  bootstrapSession,
  postSuggest,
  startAiHarness,
  type AiTestHarness,
} from './test-support.js';

const WHOLE_CONTENT = 'Hello, World!\n';
const WHOLE_INPUT = {
  instruction: 'Uppercase the document.',
  content: WHOLE_CONTENT,
} as const;

const EXPECTED_WHOLE: AiSuggestionDraft = {
  summary: STUB_WHOLE_DOCUMENT_SUMMARY,
  operations: [{ kind: 'replace', index: 0, length: 14, text: 'HELLO, WORLD!\n' }],
  model: STUB_MODEL,
};

/** A non-zero range (`World` in `Hello, World!\n`) so ignoring `from`/`to` cannot pass. */
const SELECTION = { from: 7, to: 12 } as const;

const EXPECTED_SELECTION: AiSuggestionDraft = {
  summary: STUB_SELECTION_SUMMARY,
  operations: [{ kind: 'replace', index: 7, length: 5, text: 'WORLD' }],
  model: STUB_MODEL,
};

/** A body every seeded document accepts; offsets refer to `WHOLE_CONTENT`. */
const WHOLE_REQUEST = {
  documentId: 'demo-document',
  instruction: WHOLE_INPUT.instruction,
  baseRevision: 0,
  content: WHOLE_CONTENT,
} as const;

const harnesses: AiTestHarness[] = [];

async function newHarness(provider: ServerAiProvider | null): Promise<AiTestHarness> {
  const harness = await startAiHarness(provider);
  harnesses.push(harness);
  return harness;
}

after(async () => {
  for (const harness of harnesses) await harness.close();
});

/** Rejection predicate for one `ServerAiProviderError` kind. */
function providerError(kind: ServerAiProviderError['kind']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ServerAiProviderError && error.kind === kind;
}

describe('createStubProvider — deterministic uppercase', () => {
  it('pins the literal model and summary vocabulary', () => {
    assert.equal(STUB_MODEL, 'stub');
    assert.equal(STUB_WHOLE_DOCUMENT_SUMMARY, 'Stub provider: uppercased the whole document.');
    assert.equal(STUB_SELECTION_SUMMARY, 'Stub provider: uppercased the selected range.');
  });

  it('uppercases the whole content and returns the same draft for the same input twice', async () => {
    const provider = createStubProvider();
    const signal = new AbortController().signal;

    const first = await provider.suggest(WHOLE_INPUT, signal);
    const second = await provider.suggest(WHOLE_INPUT, signal);

    assert.deepEqual(first, EXPECTED_WHOLE);
    assert.deepEqual(second, EXPECTED_WHOLE);
    // Byte-level determinism: no timestamps, no random ids, no generated summary text.
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });

  it('changes only the selected range when a selection is supplied', async () => {
    const provider = createStubProvider();
    const draft = await provider.suggest(
      { ...WHOLE_INPUT, selection: SELECTION },
      new AbortController().signal,
    );

    assert.deepEqual(draft, EXPECTED_SELECTION);
  });

  it('fails closed for a selection outside the submitted content, returning no draft', async () => {
    const provider = createStubProvider();
    const signal = new AbortController().signal;

    for (const selection of [
      // Past the end.
      { from: 0, to: 15 },
      // Reversed.
      { from: 5, to: 4 },
      // Negative / non-integer inputs, which a direct caller can still supply.
      { from: -1, to: 2 },
      { from: 0, to: 1.5 },
    ]) {
      await assert.rejects(
        provider.suggest({ ...WHOLE_INPUT, selection }, signal),
        providerError('invalid-output'),
        `selection ${JSON.stringify(selection)} should fail closed`,
      );
    }
  });

  it('refuses to produce a draft for an already-aborted request', async () => {
    const provider = createStubProvider();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      provider.suggest(WHOLE_INPUT, controller.signal),
      providerError('timeout'),
    );
  });
});

describe('configuration selection', () => {
  it('selects the stub only on an explicit AI_PROVIDER=stub', async () => {
    // Unset and the documented non-provider selector stay disabled. A key on its own is not
    // a selector — it must not silently enable a provider.
    assert.equal(readServerAiProviderKind({}), 'disabled');
    assert.equal(readServerAiProviderKind({ AI_PROVIDER: 'disabled' }), 'disabled');
    assert.equal(
      readServerAiProviderKind({ OPENAI_API_KEY: 'sk-test-not-a-real-key' }),
      'disabled',
    );
    // `openai` without a key builds nothing, so the effective state is disabled.
    assert.equal(readServerAiProviderKind({ AI_PROVIDER: 'openai' }), 'disabled');
    assert.equal(
      readServerAiProviderKind({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-a-real-key' }),
      'openai',
    );

    // Case/whitespace-insensitive, but only the literal value.
    assert.equal(readServerAiProviderKind({ AI_PROVIDER: 'stub' }), 'stub');
    assert.equal(readServerAiProviderKind({ AI_PROVIDER: '  STUB  ' }), 'stub');
    assert.equal(readServerAiProviderKind({ AI_PROVIDER: 'stubbed' }), 'disabled');

    // The stub wins over a key: selecting it must never silently fall back to OpenAI.
    assert.equal(
      readServerAiProviderKind({ AI_PROVIDER: 'stub', OPENAI_API_KEY: 'sk-test-not-a-real-key' }),
      'stub',
    );

    assert.equal(createServerAiProviderFromEnv({}), null);
    assert.equal(createServerAiProviderFromEnv({ AI_PROVIDER: 'disabled' }), null);
    assert.equal(createServerAiProviderFromEnv({ OPENAI_API_KEY: 'sk-test-not-a-real-key' }), null);

    // No OPENAI_API_KEY is required to build the stub.
    const provider = createServerAiProviderFromEnv({ AI_PROVIDER: 'stub' });
    assert.ok(provider !== null);
    assert.deepEqual(
      await provider.suggest(WHOLE_INPUT, new AbortController().signal),
      EXPECTED_WHOLE,
    );
  });
});

describe('POST /api/ai/suggest with AI_PROVIDER=stub', () => {
  it('returns 200 with the exact uppercase draft, and repeats byte-identically', async () => {
    const provider = createServerAiProviderFromEnv({ AI_PROVIDER: 'stub' });
    assert.ok(provider !== null);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const first = await postSuggest(harness, cookie, WHOLE_REQUEST);
    assert.equal(first.status, 200);
    const firstText = await first.text();

    const parsed: unknown = JSON.parse(firstText);
    assert.deepEqual(parsed, EXPECTED_WHOLE);
    assert.ok(aiSuggestionDraftSchema.safeParse(parsed).success);

    const second = await postSuggest(harness, cookie, WHOLE_REQUEST);
    assert.equal(second.status, 200);
    assert.equal(await second.text(), firstText);
  });

  it('applies the selection through the real route', async () => {
    const provider = createServerAiProviderFromEnv({ AI_PROVIDER: 'stub' });
    assert.ok(provider !== null);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, {
      ...WHOLE_REQUEST,
      selection: SELECTION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), EXPECTED_SELECTION);
  });

  it('answers 502 invalid_provider_output for an out-of-bounds selection, with no draft', async () => {
    const provider = createServerAiProviderFromEnv({ AI_PROVIDER: 'stub' });
    assert.ok(provider !== null);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    for (const selection of [
      { from: 0, to: 15 },
      { from: 5, to: 4 },
    ]) {
      const response = await postSuggest(harness, cookie, { ...WHOLE_REQUEST, selection });
      const text = await response.text();

      assert.equal(response.status, 502, text);
      assert.equal(text, '{"error":"invalid_provider_output"}');
      assert.ok(!text.includes('operations'), `a failure body leaked a draft: ${text}`);
      assert.ok(!text.includes('summary'), `a failure body leaked a draft: ${text}`);
    }
  });

  it('answers 503 when AI_PROVIDER is unset', async () => {
    const provider = createServerAiProviderFromEnv({});
    assert.equal(provider, null);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, WHOLE_REQUEST);
    const text = await response.text();

    assert.equal(response.status, 503);
    assert.equal(text, '{"error":"ai_provider_not_configured"}');
  });

  it('returns only the draft shape: no credential, key, prompt or instruction', async () => {
    const provider = createServerAiProviderFromEnv({ AI_PROVIDER: 'stub' });
    assert.ok(provider !== null);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, WHOLE_REQUEST);
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);

    assert.equal(response.status, 200);
    assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
    assert.deepEqual(Object.keys(parsed).sort(), ['model', 'operations', 'summary']);

    for (const forbidden of [
      'authorization',
      'bearer',
      'OPENAI_API_KEY',
      'sk-',
      WHOLE_REQUEST.instruction,
    ]) {
      assert.ok(
        !text.toLowerCase().includes(forbidden.toLowerCase()),
        `the response leaked ${forbidden}: ${text}`,
      );
    }
  });
});
