/**
 * The shared OpenAI-compatible **transport** — unit tests with a fake `fetch`, so no test
 * touches the network (`docs/DECISIONS.md` D-085 §2).
 *
 * What this file owns, and why it is separate from the two adapter suites:
 *
 * - the wire request (endpoint path, method, auth header, JSON body, `stream: false`);
 * - the two per-provider knobs the transport must not assume: `maxTokensField` and
 *   `responseFormat` (and "omitted also means absent from the body");
 * - the failure vocabulary: one `fetch` per failure (D-082 D3: retry 0), the internal deadline,
 *   a caller abort, and `upstreamStatus`/`providerCode` on a non-2xx answer;
 * - output parsing, shared by both adapters: bare JSON, exactly one ` ```json ` fence, and
 *   unparseable/oversized/out-of-bounds JSON.
 *
 * Adapter-specific semantics (which endpoint, which default model, which credential) are asserted
 * in `openai.test.ts` and `kimi.test.ts`, because "the wire is the same" is not a claim that the
 * providers behave the same.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiSuggestionDraft } from '@insighthub/shared';

import { ServerAiProviderError, type ServerAiProviderErrorKind } from './errors.js';
import {
  AI_SYSTEM_PROMPT,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_AI_TIMEOUT_MS,
  createOpenAICompatibleProvider,
} from './openai-compatible.js';
import type { ServerAiSuggestInput } from './provider.js';

const API_KEY = 'sk-test-SENTINEL-do-not-leak-0123456789';
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

function providerReturning(response: Response): ReturnType<typeof createOpenAICompatibleProvider> {
  return createOpenAICompatibleProvider({
    provider: 'openai',
    endpoint: 'https://api.example.test/v1',
    apiKey: API_KEY,
    model: 'model-test',
    fetchImpl: fakeFetch(() => response).fetchImpl,
  });
}

async function expectKind(
  promise: Promise<unknown>,
  kind: ServerAiProviderErrorKind,
): Promise<ServerAiProviderError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof ServerAiProviderError,
      `expected ServerAiProviderError, got ${String(error)}`,
    );
    assert.equal(error.kind, kind, error.message);
    return error;
  }
  assert.fail(`expected a ${kind} failure, but the call resolved`);
}

/** A promise that never resolves until its signal aborts. */
function hangUntilAborted(call: FetchCall): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = call.init.signal;
    if (signal === null || signal === undefined) {
      reject(new Error('the transport called fetch without an AbortSignal'));
      return;
    }
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

/**
 * Hold the test event loop open while a deadline is the only pending work (`AbortSignal.timeout`
 * uses an unref'd timer, so a real server's listening socket is what normally keeps the loop
 * alive).
 */
function keepEventLoopAlive(): () => void {
  const timer = setTimeout(() => undefined, 60_000);
  return () => clearTimeout(timer);
}

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  stream: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: { type: string };
}

function bodyOf(call: FetchCall | undefined): RequestBody {
  assert.ok(call !== undefined, 'fetch was not called');
  return JSON.parse(String(call.init.body)) as RequestBody;
}

describe('wire request', () => {
  it('posts one non-streaming chat completion to {endpoint}/chat/completions', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'model-test',
      fetchImpl: fake.fetchImpl,
    });

    const draft = await provider.suggest(INPUT, new AbortController().signal);

    // `model` is stamped by the transport, never taken from the model's own JSON.
    assert.deepEqual(draft, { ...VALID_OUTPUT, model: 'model-test' });
    assert.equal(fake.calls.length, 1);

    const call = fake.calls[0] as FetchCall;
    assert.equal(call.url, 'https://api.example.test/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${API_KEY}`);
    assert.equal(headers['content-type'], 'application/json');

    const body = bodyOf(call);
    assert.equal(body.model, 'model-test');
    assert.equal(body.temperature, 0);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, DEFAULT_AI_MAX_OUTPUT_TOKENS);
    // "Not configured" must mean "absent from the body", not `undefined` serialised away twice:
    // a provider without JSON mode must never receive the field.
    assert.equal('response_format' in body, false);
    assert.equal(body.messages[0]?.role, 'system');
    assert.equal(body.messages[0]?.content, AI_SYSTEM_PROMPT);
    assert.equal(body.messages[1]?.role, 'user');
    assert.ok(body.messages[1]?.content.includes(INPUT.instruction));
    assert.ok(body.messages[1]?.content.includes(CONTENT));
    assert.ok(body.messages[1]?.content.includes('Selection (UTF-16 offsets): 0..5'));
  });

  it('sends 30 s / 4096 when no bound is supplied, and normalises a trailing endpoint slash', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAICompatibleProvider({
      provider: 'kimi',
      endpoint: 'https://api.example.test/v1/',
      apiKey: API_KEY,
      model: 'm',
      fetchImpl: fake.fetchImpl,
    });

    await provider.suggest({ instruction: 'i', content: 'abcde' }, new AbortController().signal);

    assert.equal(DEFAULT_AI_TIMEOUT_MS, 30_000);
    assert.equal(DEFAULT_AI_MAX_OUTPUT_TOKENS, 4096);
    assert.equal((fake.calls[0] as FetchCall).url, 'https://api.example.test/v1/chat/completions');
    const body = bodyOf(fake.calls[0]);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.messages[1]?.content.includes('Selection: none'), true);
  });

  it('uses max_completion_tokens when that is the configured field, and never max_tokens too', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
      maxTokensField: 'max_completion_tokens',
      maxOutputTokens: 512,
      fetchImpl: fake.fetchImpl,
    });

    await provider.suggest(INPUT, new AbortController().signal);

    const body = bodyOf(fake.calls[0]);
    assert.equal(body.max_completion_tokens, 512);
    assert.equal('max_tokens' in body, false);
  });

  it('sends response_format only when the adapter configures it', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAICompatibleProvider({
      provider: 'kimi',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
      responseFormat: { type: 'json_object' },
      fetchImpl: fake.fetchImpl,
    });

    await provider.suggest(INPUT, new AbortController().signal);

    assert.deepEqual(bodyOf(fake.calls[0]).response_format, { type: 'json_object' });
  });

  it('never puts the credential in the request body', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
      fetchImpl: fake.fetchImpl,
    });

    await provider.suggest(INPUT, new AbortController().signal);

    assert.equal(String((fake.calls[0] as FetchCall).init.body).includes(API_KEY), false);
  });
});

describe('failure mapping (retry = 0)', () => {
  it('maps every non-2xx class to provider, one fetch, with status and code carried', async () => {
    for (const status of [401, 429, 500]) {
      const fake = fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              error: { code: 'rate_limit_exceeded', message: `ECHO ${API_KEY} ${CONTENT}` },
            }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
      );
      const provider = createOpenAICompatibleProvider({
        provider: 'kimi',
        endpoint: 'https://api.example.test/v1',
        apiKey: API_KEY,
        model: 'm',
        fetchImpl: fake.fetchImpl,
      });

      const error = await expectKind(
        provider.suggest(INPUT, new AbortController().signal),
        'provider',
      );
      assert.equal(fake.calls.length, 1, `HTTP ${status} must not be retried`);
      assert.equal(error.upstreamStatus, status);
      assert.equal(error.providerCode, 'rate_limit_exceeded');
      // Diagnostics only: never the body, the key, the instruction or the snapshot.
      assert.ok(!error.message.includes(API_KEY));
      assert.ok(!error.message.includes(CONTENT));
      assert.ok(!error.message.includes('ECHO'));
    }
  });

  it('carries the offending parameter when the provider names one, without the body', async () => {
    const fake = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              param: 'response_format',
              message: `bad parameter for ${CONTENT}`,
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    const provider = createOpenAICompatibleProvider({
      provider: 'kimi',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
      fetchImpl: fake.fetchImpl,
    });

    const error = await expectKind(
      provider.suggest(INPUT, new AbortController().signal),
      'provider',
    );
    assert.equal(error.upstreamStatus, 400);
    assert.equal(error.providerCode, 'invalid_request_error');
    assert.equal(error.providerParam, 'response_format');
    assert.ok(!error.message.includes(CONTENT));
    assert.ok(!error.message.includes('bad parameter'));
  });
  it('maps a network error to provider without retrying', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError(`connect failed while sending ${API_KEY}`);
    });
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
      fetchImpl: fake.fetchImpl,
    });

    const error = await expectKind(
      provider.suggest(INPUT, new AbortController().signal),
      'provider',
    );
    assert.equal(fake.calls.length, 1, 'a network failure must not be retried');
    assert.ok(!error.message.includes(API_KEY));
  });

  it('maps its own deadline to timeout without retrying', async () => {
    const fake = fakeFetch(hangUntilAborted);
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
      timeoutMs: 15,
      fetchImpl: fake.fetchImpl,
    });

    const release = keepEventLoopAlive();
    try {
      await expectKind(provider.suggest(INPUT, new AbortController().signal), 'timeout');
      assert.equal(fake.calls.length, 1, 'a deadline must not be retried');
    } finally {
      release();
    }
  });

  it('maps a caller abort to timeout (the contract maps "timeout / aborted" to 504)', async () => {
    const fake = fakeFetch(hangUntilAborted);
    const provider = createOpenAICompatibleProvider({
      provider: 'openai',
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
      timeoutMs: 5000,
      fetchImpl: fake.fetchImpl,
    });
    const controller = new AbortController();
    const pending = provider.suggest(INPUT, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expectKind(pending, 'timeout');
    assert.equal(fake.calls.length, 1, 'an abort must not be retried');
  });
});

describe('output parsing', () => {
  it('accepts bare JSON and stamps the configured model', async () => {
    const provider = providerReturning(completion(JSON.stringify(VALID_OUTPUT)));
    assert.deepEqual(await provider.suggest(INPUT, new AbortController().signal), {
      ...VALID_OUTPUT,
      model: 'model-test',
    });
  });

  it('strictly strips exactly one json code fence', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```';
    const provider = providerReturning(completion(fenced));
    assert.deepEqual(await provider.suggest(INPUT, new AbortController().signal), {
      ...VALID_OUTPUT,
      model: 'model-test',
    });
  });

  it('rejects prose around a fence, a non-json fence and a bad JSON body', async () => {
    const json = JSON.stringify(VALID_OUTPUT);
    for (const content of [
      `Here is the answer:\n\`\`\`json\n${json}\n\`\`\``,
      '```javascript\n' + json + '\n```',
      '{ not json',
      '',
    ]) {
      const provider = providerReturning(completion(content));
      await expectKind(provider.suggest(INPUT, new AbortController().signal), 'invalid-output');
    }
  });

  it('rejects a response body that is not JSON at all', async () => {
    const provider = providerReturning(
      new Response('not json', { headers: { 'content-type': 'application/json' } }),
    );
    await expectKind(provider.suggest(INPUT, new AbortController().signal), 'invalid-output');
  });

  it('rejects a draft that points outside the submitted snapshot', async () => {
    const provider = providerReturning(
      completion(
        JSON.stringify({
          summary: 'past the end',
          operations: [{ kind: 'replace', index: 5, length: 10, text: 'x' }],
        }),
      ),
    );
    await expectKind(provider.suggest(INPUT, new AbortController().signal), 'invalid-output');
  });
});

describe('construction', () => {
  it('refuses an empty key, an empty endpoint/model and non-positive bounds', () => {
    const base = {
      provider: 'openai' as const,
      endpoint: 'https://api.example.test/v1',
      apiKey: API_KEY,
      model: 'm',
    };

    assert.throws(
      () => createOpenAICompatibleProvider({ ...base, apiKey: '   ' }),
      (error: unknown) => error instanceof ServerAiProviderError && error.kind === 'not-configured',
    );
    assert.throws(() => createOpenAICompatibleProvider({ ...base, endpoint: '  ' }), RangeError);
    assert.throws(() => createOpenAICompatibleProvider({ ...base, model: ' ' }), RangeError);
    assert.throws(() => createOpenAICompatibleProvider({ ...base, timeoutMs: 0 }), RangeError);
    for (const maxOutputTokens of [0, -1, 1.5]) {
      assert.throws(
        () => createOpenAICompatibleProvider({ ...base, maxOutputTokens }),
        RangeError,
        `maxOutputTokens=${maxOutputTokens}`,
      );
    }
  });
});
