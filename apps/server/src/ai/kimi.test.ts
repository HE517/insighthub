/**
 * The Moonshot **Kimi** adapter (M4 B12, `docs/DECISIONS.md` D-085 §3).
 *
 * The transport's own suite (`openai-compatible.test.ts`) proves the wire format is implemented
 * once. This suite proves the *Kimi-specific* configuration, which D-085 §2 says must be
 * configured and tested per provider rather than inherited:
 *
 * - the endpoint is the Moonshot allowlisted host, never OpenAI's;
 * - the credential is `KIMI_API_KEY` — an `OPENAI_API_KEY` must not enable this provider;
 * - the default model is `kimi-k3` and `AI_MODEL` overrides it;
 * - `response_format: {type:"json_object"}` is sent (K3 JSON mode), unlike a provider that does
 *   not support it;
 * - 401/429/500 all map to the §11.2 `provider` class with the upstream status carried, and a
 *   missing key fails closed as `not-configured` instead of calling the network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiSuggestionDraft } from '@insighthub/shared';

import { ServerAiProviderError } from './errors.js';
import {
  DEFAULT_KIMI_MAX_OUTPUT_TOKENS,
  DEFAULT_KIMI_MODEL,
  DEFAULT_KIMI_TIMEOUT_MS,
  KIMI_API_BASE_URL,
  createKimiProvider,
  readKimiProviderConfig,
} from './kimi.js';
import { AI_SYSTEM_PROMPT } from './openai-compatible.js';
import type { ServerAiSuggestInput } from './provider.js';
import { createServerAiProviderFromEnv, readServerAiProviderKind } from './provider.js';

const KIMI_KEY = 'kimi-test-SENTINEL-do-not-leak-0123456789';
const OPENAI_KEY = 'sk-test-SENTINEL-do-not-leak-9876543210';
const CONTENT = 'Hello world';
const INPUT: ServerAiSuggestInput = {
  instruction: 'Replace the greeting.',
  content: CONTENT,
  selection: { from: 0, to: 5 },
};

const VALID_OUTPUT: AiSuggestionDraft = {
  summary: 'Shorten the greeting',
  operations: [{ kind: 'replace', index: 0, length: 5, text: 'Hi' }],
};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface FakeFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: FetchCall[];
}

function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>): FakeFetch {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function completion(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('configuration', () => {
  it('is selected only by AI_PROVIDER=kimi with its own KIMI_API_KEY', () => {
    assert.equal(readKimiProviderConfig({}), null);
    assert.equal(readKimiProviderConfig({ AI_PROVIDER: 'openai', KIMI_API_KEY: KIMI_KEY }), null);
    assert.equal(readKimiProviderConfig({ AI_PROVIDER: 'kimi' }), null);
    assert.equal(readKimiProviderConfig({ AI_PROVIDER: 'kimi', KIMI_API_KEY: '   ' }), null);

    // The OpenAI credential must never enable Kimi: selecting a provider means *that* provider's
    // key (D-085 §1).
    assert.equal(readKimiProviderConfig({ AI_PROVIDER: 'kimi', OPENAI_API_KEY: OPENAI_KEY }), null);
    assert.equal(
      createServerAiProviderFromEnv({ AI_PROVIDER: 'kimi', OPENAI_API_KEY: OPENAI_KEY }),
      null,
    );

    // Case/whitespace-insensitive selector; the key is trimmed but never echoed.
    assert.deepEqual(
      readKimiProviderConfig({ AI_PROVIDER: '  Kimi  ', KIMI_API_KEY: ` ${KIMI_KEY} ` }),
      {
        apiKey: KIMI_KEY,
        model: DEFAULT_KIMI_MODEL,
        maxOutputTokens: DEFAULT_KIMI_MAX_OUTPUT_TOKENS,
        timeoutMs: DEFAULT_KIMI_TIMEOUT_MS,
      },
    );
  });

  it('defaults to the K3 tier and lets AI_MODEL override it', () => {
    assert.equal(DEFAULT_KIMI_MODEL, 'kimi-k3');
    assert.equal(KIMI_API_BASE_URL, 'https://api.moonshot.cn/v1');
    assert.equal(DEFAULT_KIMI_TIMEOUT_MS, 30_000);
    assert.equal(DEFAULT_KIMI_MAX_OUTPUT_TOKENS, 4096);

    const base = { AI_PROVIDER: 'kimi', KIMI_API_KEY: KIMI_KEY };
    assert.equal(readKimiProviderConfig(base)?.model, 'kimi-k3');
    assert.equal(
      readKimiProviderConfig({ ...base, AI_MODEL: 'kimi-k3.1-pro' })?.model,
      'kimi-k3.1-pro',
    );
    // The deprecated OpenAI alias is not a Kimi model selector.
    assert.equal(
      readKimiProviderConfig({ ...base, OPENAI_MODEL: 'gpt-5.6-luna' })?.model,
      'kimi-k3',
    );
    // The same development proxy seam the OpenAI adapter uses; production forbids the variable.
    assert.equal(
      readKimiProviderConfig({ ...base, AI_BASE_URL: 'http://localhost:8787/v1' })?.endpoint,
      'http://localhost:8787/v1',
    );
  });

  it('reports the kind and model the factory built', () => {
    assert.equal(readServerAiProviderKind({ AI_PROVIDER: 'kimi' }), 'disabled');
    assert.equal(readServerAiProviderKind({ AI_PROVIDER: 'kimi', KIMI_API_KEY: KIMI_KEY }), 'kimi');

    const configured = createServerAiProviderFromEnv({
      AI_PROVIDER: 'kimi',
      KIMI_API_KEY: KIMI_KEY,
    });
    assert.ok(configured !== null);
    assert.equal(configured.kind, 'kimi');
    assert.equal(configured.model, 'kimi-k3');
    assert.equal(typeof configured.provider.suggest, 'function');
  });

  it('refuses to construct without a key (not-configured), without touching the network', () => {
    for (const apiKey of ['', '   ']) {
      assert.throws(
        () => createKimiProvider({ apiKey }),
        (error: unknown) =>
          error instanceof ServerAiProviderError && error.kind === 'not-configured',
      );
    }
  });
});

describe('request shape', () => {
  it('posts to the Moonshot endpoint with the Kimi key, kimi-k3 and JSON mode', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createKimiProvider({
      apiKey: KIMI_KEY,
      fetchImpl: fake.fetchImpl,
    });

    const draft = await provider.suggest(INPUT, new AbortController().signal);

    assert.equal(draft.model, 'kimi-k3');
    assert.equal(fake.calls.length, 1);

    const call = fake.calls[0] as FetchCall;
    const url = new URL(call.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'api.moonshot.cn');
    assert.equal(url.pathname, '/v1/chat/completions');
    assert.equal(call.init.method, 'POST');

    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${KIMI_KEY}`);
    assert.equal(headers['content-type'], 'application/json');

    const body = JSON.parse(String(call.init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      max_tokens: number;
      response_format?: { type: string };
    };
    assert.equal(body.model, 'kimi-k3');
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, DEFAULT_KIMI_MAX_OUTPUT_TOKENS);
    // Kimi's documented JSON mode (D-085 §3); the fallback if a live smoke disproves it is
    // prompt-only, so this assertion is the one that must change with that decision.
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0]?.role, 'system');
    assert.equal(body.messages[0]?.content, AI_SYSTEM_PROMPT);
    assert.ok(body.messages[1]?.content.includes(CONTENT));

    // Credential hygiene: the key is a header, never a body field.
    assert.equal(String(call.init.body).includes(KIMI_KEY), false);
  });

  it('trims the key before it becomes a bearer header, and never leaks it in errors', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createKimiProvider({ apiKey: `  ${KIMI_KEY}  `, fetchImpl: fake.fetchImpl });

    await provider.suggest(INPUT, new AbortController().signal);
    const call = fake.calls[0] as FetchCall;
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${KIMI_KEY}`);

    // A 401 must not echo the credential anywhere an operator could read it.
    const failing = fakeFetch(
      () => new Response(JSON.stringify({ error: { code: 'invalid_authentication_error' } }), { status: 401 }),
    );
    const failingProvider = createKimiProvider({
      apiKey: `  ${KIMI_KEY}  `,
      fetchImpl: failing.fetchImpl,
    });
    try {
      await failingProvider.suggest(INPUT, new AbortController().signal);
      assert.fail('a 401 must fail');
    } catch (error) {
      assert.ok(error instanceof ServerAiProviderError);
      assert.equal(error.upstreamStatus, 401);
      assert.equal(error.providerCode, 'invalid_authentication_error');
      assert.equal(error.message.includes(KIMI_KEY), false);
    }
  });
  it('honours an explicit model and output bound', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createKimiProvider({
      apiKey: KIMI_KEY,
      model: 'kimi-k3.1-pro',
      maxOutputTokens: 768,
      fetchImpl: fake.fetchImpl,
    });

    await provider.suggest(INPUT, new AbortController().signal);

    const body = JSON.parse(String((fake.calls[0] as FetchCall).init.body)) as {
      model: string;
      max_tokens: number;
    };
    assert.equal(body.model, 'kimi-k3.1-pro');
    assert.equal(body.max_tokens, 768);
  });
});

describe('failure mapping', () => {
  it('maps 401 / 429 / 500 to provider with the upstream status, one fetch each', async () => {
    for (const status of [401, 429, 500]) {
      const fake = fakeFetch(
        () =>
          new Response(
            JSON.stringify({ error: { code: 'unsupported_model', message: `ECHO ${KIMI_KEY}` } }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
      );
      const provider = createKimiProvider({ apiKey: KIMI_KEY, fetchImpl: fake.fetchImpl });

      try {
        await provider.suggest(INPUT, new AbortController().signal);
        assert.fail(`HTTP ${status} must fail`);
      } catch (error) {
        assert.ok(error instanceof ServerAiProviderError, String(error));
        assert.equal(error.kind, 'provider');
        assert.equal(error.upstreamStatus, status);
        assert.equal(error.providerCode, 'unsupported_model');
        assert.ok(!error.message.includes(KIMI_KEY));
        assert.ok(!error.message.includes('ECHO'));
      }
      assert.equal(fake.calls.length, 1, `HTTP ${status} must not be retried`);
    }
  });
});
