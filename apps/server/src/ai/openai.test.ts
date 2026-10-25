/**
 * The OpenAI adapter — unit tests with a fake `fetch`, so no test touches the network.
 *
 * Covered:
 *
 * - request shape (endpoint, method, auth header, JSON-only system prompt, model, selection);
 * - output parsing: bare JSON and a strictly stripped single ` ```json ` fence;
 * - every invalid-output class §11.2 names (unparseable JSON, >32 operations, unknown kind,
 *   negative index, oversized summary, offsets outside the snapshot);
 * - 401/429/5xx/network → `provider`; internal deadline and caller abort → `timeout`;
 * - credential hygiene: no error message ever contains the key, the instruction or the
 *   snapshot, even when the underlying failure did.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiSuggestionDraft } from '@insighthub/shared';

import {
  DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_TIMEOUT_MS,
  OPENAI_SYSTEM_PROMPT,
  createOpenAiProvider,
  createServerAiProviderFromEnv,
  readOpenAiProviderConfig,
} from './openai.js';
import {
  ServerAiProviderError,
  type ServerAiProviderErrorKind,
  type ServerAiSuggestInput,
} from './provider.js';

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

function providerReturning(
  response: Response,
  options: { readonly timeoutMs?: number } = {},
): ReturnType<typeof createOpenAiProvider> {
  const fake = fakeFetch(() => response);
  return createOpenAiProvider({
    apiKey: API_KEY,
    model: 'gpt-test',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    fetchImpl: fake.fetchImpl,
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
      reject(new Error('the adapter called fetch without an AbortSignal'));
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
 * Hold the test event loop open while a deadline is the only pending work.
 *
 * `AbortSignal.timeout` uses an unref'd timer, so a test whose *only* outstanding work is
 * that deadline would let Node decide the event loop is empty and cancel the test
 * (`Promise resolution is still pending but the event loop has already resolved`). A real
 * server always has a listening socket holding the loop; this helper restores that condition
 * without changing the adapter.
 */
function keepEventLoopAlive(): () => void {
  const timer = setTimeout(() => undefined, 60_000);
  return () => clearTimeout(timer);
}

describe('request shape', () => {
  it('posts one chat completion with the server-side key and returns the draft', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAiProvider({
      apiKey: API_KEY,
      model: 'gpt-test',
      timeoutMs: 1000,
      fetchImpl: fake.fetchImpl,
    });

    const draft = await provider.suggest(INPUT, new AbortController().signal);

    // `model` is stamped by the adapter, never taken from the model's own JSON.
    assert.deepEqual(draft, { ...VALID_OUTPUT, model: 'gpt-test' });
    assert.equal(fake.calls.length, 1);

    const call = fake.calls[0] as FetchCall;
    assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${API_KEY}`);
    assert.equal(headers['content-type'], 'application/json');

    const payload = JSON.parse(String(call.init.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens: number;
      response_format: { type: string };
    };
    assert.equal(payload.model, 'gpt-test');
    assert.equal(payload.temperature, 0);
    assert.equal(payload.max_tokens, DEFAULT_OPENAI_MAX_OUTPUT_TOKENS);
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.equal(payload.messages[0]?.role, 'system');
    assert.equal(payload.messages[0]?.content, OPENAI_SYSTEM_PROMPT);
    assert.equal(payload.messages[1]?.role, 'user');
    assert.ok(payload.messages[1]?.content.includes(INPUT.instruction));
    assert.ok(payload.messages[1]?.content.includes(CONTENT));
    assert.ok(payload.messages[1]?.content.includes('Selection (UTF-16 offsets): 0..5'));
  });

  it('sends the D-082 D3 default model and a 4096 max_tokens when nothing is configured', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAiProvider({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });

    const draft = await provider.suggest(INPUT, new AbortController().signal);
    assert.equal(draft.model, DEFAULT_OPENAI_MODEL);

    // The two hard numbers D-082 D3 fixes, captured from the actual request body.
    assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-5.6-luna');
    assert.equal(DEFAULT_OPENAI_MAX_OUTPUT_TOKENS, 4096);
    const payload = JSON.parse(String((fake.calls[0] as FetchCall).init.body)) as {
      model: string;
      max_tokens: number;
    };
    assert.equal(payload.model, 'gpt-5.6-luna');
    assert.equal(payload.max_tokens, 4096);
  });

  it('honours an explicit maxOutputTokens instead of the default', async () => {
    const fake = fakeFetch(() => completion(JSON.stringify(VALID_OUTPUT)));
    const provider = createOpenAiProvider({
      apiKey: API_KEY,
      maxOutputTokens: 512,
      fetchImpl: fake.fetchImpl,
    });

    await provider.suggest(INPUT, new AbortController().signal);
    const payload = JSON.parse(String((fake.calls[0] as FetchCall).init.body)) as {
      max_tokens: number;
    };
    assert.equal(payload.max_tokens, 512);
  });
});

describe('output parsing', () => {
  it('accepts bare JSON', async () => {
    const provider = providerReturning(completion(JSON.stringify(VALID_OUTPUT)));
    assert.deepEqual(await provider.suggest(INPUT, new AbortController().signal), {
      ...VALID_OUTPUT,
      model: 'gpt-test',
    });
  });

  it('strictly strips exactly one json code fence', async () => {
    const fenced = '```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```';
    const provider = providerReturning(completion(fenced));
    assert.deepEqual(await provider.suggest(INPUT, new AbortController().signal), {
      ...VALID_OUTPUT,
      model: 'gpt-test',
    });
  });

  it('rejects prose around a fence, a non-json fence, a second fence and an empty fence', async () => {
    const json = JSON.stringify(VALID_OUTPUT);
    const rejected = [
      `Here is the answer:\n\`\`\`json\n${json}\n\`\`\``,
      '```javascript\n' + json + '\n```',
      '```json\n' + json + '\n```\nThanks!',
      '```json\n```',
      '```json\n' + json + '\n```\n```json\n' + json + '\n```',
    ];

    for (const content of rejected) {
      const provider = providerReturning(completion(content));
      await expectKind(provider.suggest(INPUT, new AbortController().signal), 'invalid-output');
    }
  });

  it('rejects unparseable JSON and non-object JSON', async () => {
    for (const content of ['{ not json', '', '[]', 'null', '"a string"', '42']) {
      const provider = providerReturning(completion(content));
      await expectKind(provider.suggest(INPUT, new AbortController().signal), 'invalid-output');
    }
  });

  it('carries the upstream status and provider code on a non-2xx response', async () => {
    // Diagnostics only: the status and the machine code are safe to log, the message is not.
    const fake = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'model_not_found', message: 'SECRET-PROMPT-ECHO' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );
    const provider = createOpenAiProvider({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });

    try {
      await provider.suggest(INPUT, new AbortController().signal);
      assert.fail('a 404 must fail');
    } catch (error) {
      assert.ok(error instanceof ServerAiProviderError);
      assert.equal(error.kind, 'provider');
      assert.equal(error.upstreamStatus, 404);
      assert.equal(error.providerCode, 'model_not_found');
      assert.equal(error.message.includes('SECRET-PROMPT-ECHO'), false);
    }
  });
  it('rejects a response with no assistant message', async () => {
    for (const body of [
      {},
      { choices: [] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: 42 } }] },
      { choices: 'nope' },
    ]) {
      const fake = fakeFetch(
        () =>
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      );
      const provider = createOpenAiProvider({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });
      await expectKind(provider.suggest(INPUT, new AbortController().signal), 'invalid-output');
    }
  });

  it('rejects every schema violation the fail-closed matrix names', async () => {
    const tooManyOperations = Array.from({ length: 33 }, (_unused, index) => ({
      kind: 'insert' as const,
      index: 0,
      text: `x${index}`,
    }));
    const cases: unknown[] = [
      // 0 operations (min 1)
      { summary: 'empty', operations: [] },
      // more than AI_MAX_DRAFT_OPERATIONS (32)
      { summary: 'many', operations: tooManyOperations },
      // negative index
      { summary: 'negative', operations: [{ kind: 'insert', index: -1, text: 'x' }] },
      // unknown operation kind
      { summary: 'kind', operations: [{ kind: 'delete', index: 0 }] },
      // summary over 500 characters
      { summary: 'x'.repeat(501), operations: [{ kind: 'insert', index: 0, text: 'x' }] },
      // text missing / not a string
      { summary: 'text', operations: [{ kind: 'insert', index: 0 }] },
      // replace that runs past the submitted snapshot
      { summary: 'bounds', operations: [{ kind: 'replace', index: 5, length: 10, text: 'x' }] },
      // insert one code unit past the snapshot
      { summary: 'bounds', operations: [{ kind: 'insert', index: CONTENT.length + 1, text: 'x' }] },
      // missing summary / operations
      { operations: [{ kind: 'insert', index: 0, text: 'x' }] },
      { summary: 'missing operations' },
    ];

    for (const candidate of cases) {
      const provider = providerReturning(completion(JSON.stringify(candidate)));
      await expectKind(provider.suggest(INPUT, new AbortController().signal), 'invalid-output');
    }
  });

  it('accepts an insert exactly at the end of the snapshot', async () => {
    const atEnd: AiSuggestionDraft = {
      summary: 'append',
      operations: [{ kind: 'insert', index: CONTENT.length, text: '!' }],
    };
    const provider = providerReturning(completion(JSON.stringify(atEnd)));
    const draft = await provider.suggest(INPUT, new AbortController().signal);
    assert.deepEqual(draft.operations, atEnd.operations);
  });
});

describe('failure mapping', () => {
  it('maps HTTP 401 / 429 / 5xx to provider without reading or forwarding the body', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const fake = fakeFetch(
        () =>
          new Response(`upstream says ${API_KEY} and ${CONTENT}`, {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const provider = createOpenAiProvider({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });
      const error = await expectKind(
        provider.suggest(INPUT, new AbortController().signal),
        'provider',
      );
      // D-082 D3: automatic retry = 0. A 5xx is one attempt, never a background retry.
      assert.equal(fake.calls.length, 1, `HTTP ${status} must not be retried`);
      // The adapter reports the status class, never the body.
      assert.ok(!error.message.includes(API_KEY));
      assert.ok(!error.message.includes(CONTENT));
      assert.ok(!error.message.includes(INPUT.instruction));
    }
  });

  it('maps a network error to provider without retrying', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError(`connect failed while sending ${API_KEY}`);
    });
    const provider = createOpenAiProvider({ apiKey: API_KEY, fetchImpl: fake.fetchImpl });

    const error = await expectKind(
      provider.suggest(INPUT, new AbortController().signal),
      'provider',
    );
    assert.equal(fake.calls.length, 1, 'a network failure must not be retried');
    assert.ok(!error.message.includes(API_KEY));
  });

  it('maps its own deadline to timeout', async () => {
    const fake = fakeFetch(hangUntilAborted);
    const provider = createOpenAiProvider({
      apiKey: API_KEY,
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
    const provider = createOpenAiProvider({
      apiKey: API_KEY,
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

describe('credential hygiene', () => {
  it('never puts the key, instruction or snapshot into any error message', async () => {
    const failures: Array<() => Promise<unknown>> = [
      () =>
        createOpenAiProvider({
          apiKey: API_KEY,
          fetchImpl: fakeFetch(() => new Response(`upstream ${API_KEY}`, { status: 500 }))
            .fetchImpl,
        }).suggest(INPUT, new AbortController().signal),
      () =>
        createOpenAiProvider({
          apiKey: API_KEY,
          fetchImpl: fakeFetch(() => completion('{ not json')).fetchImpl,
        }).suggest(INPUT, new AbortController().signal),
      () =>
        createOpenAiProvider({
          apiKey: API_KEY,
          fetchImpl: fakeFetch(() => completion(JSON.stringify({ summary: 'x', operations: [] })))
            .fetchImpl,
        }).suggest(INPUT, new AbortController().signal),
      () =>
        createOpenAiProvider({
          apiKey: API_KEY,
          fetchImpl: fakeFetch(() => {
            throw new TypeError(`network failed for ${API_KEY}`);
          }).fetchImpl,
        }).suggest(INPUT, new AbortController().signal),
      () =>
        createOpenAiProvider({
          apiKey: API_KEY,
          timeoutMs: 10,
          fetchImpl: fakeFetch(hangUntilAborted).fetchImpl,
        }).suggest(INPUT, new AbortController().signal),
    ];

    for (const run of failures) {
      // The timeout case relies on an unref'd deadline; hold the loop open for it.
      const release = keepEventLoopAlive();
      try {
        const error = await (async (): Promise<ServerAiProviderError> => {
          try {
            await run();
          } catch (caught) {
            assert.ok(caught instanceof ServerAiProviderError, `unexpected ${String(caught)}`);
            return caught;
          }
          assert.fail('expected the call to fail');
        })();

        for (const forbidden of [API_KEY, INPUT.instruction, CONTENT, 'authorization', 'Bearer']) {
          assert.ok(
            !error.message.includes(forbidden),
            `the error message leaked ${forbidden}: ${error.message}`,
          );
        }
      } finally {
        release();
      }
    }
  });

  it('refuses to construct with an empty key or a non-positive timeout', () => {
    assert.throws(
      () => createOpenAiProvider({ apiKey: '   ' }),
      (error: unknown) => error instanceof ServerAiProviderError && error.kind === 'not-configured',
    );
    assert.throws(() => createOpenAiProvider({ apiKey: API_KEY, timeoutMs: 0 }), RangeError);
    for (const maxOutputTokens of [0, -1, 1.5]) {
      assert.throws(
        () => createOpenAiProvider({ apiKey: API_KEY, maxOutputTokens }),
        RangeError,
        `maxOutputTokens=${maxOutputTokens}`,
      );
    }
  });
});

describe('configuration', () => {
  it('reads only the documented server-side variables', () => {
    // Unset / disabled / no key → no provider configuration (route answers 503).
    assert.equal(readOpenAiProviderConfig({}), null);
    assert.equal(readOpenAiProviderConfig({ AI_PROVIDER: 'disabled' }), null);
    assert.equal(
      readOpenAiProviderConfig({ AI_PROVIDER: 'disabled', OPENAI_API_KEY: API_KEY }),
      null,
    );
    assert.equal(readOpenAiProviderConfig({ AI_PROVIDER: 'openai' }), null);
    assert.equal(readOpenAiProviderConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: '   ' }), null);
    assert.equal(
      readOpenAiProviderConfig({ AI_PROVIDER: 'something-else', OPENAI_API_KEY: API_KEY }),
      null,
    );

    assert.deepEqual(
      readOpenAiProviderConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: ` ${API_KEY} ` }),
      {
        apiKey: API_KEY,
        model: DEFAULT_OPENAI_MODEL,
        maxOutputTokens: DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
        timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
      },
    );
    // Case/whitespace-insensitive selector; explicit model wins over the default.
    assert.deepEqual(
      readOpenAiProviderConfig({
        AI_PROVIDER: ' OpenAI ',
        OPENAI_API_KEY: API_KEY,
        OPENAI_MODEL: 'gpt-explicit',
      }),
      {
        apiKey: API_KEY,
        model: 'gpt-explicit',
        maxOutputTokens: DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
        timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
      },
    );
  });

  it('reads the output-token and timeout bounds, falling back on invalid values', () => {
    const base = { AI_PROVIDER: 'openai', OPENAI_API_KEY: API_KEY };

    assert.deepEqual(
      readOpenAiProviderConfig({
        ...base,
        OPENAI_MAX_OUTPUT_TOKENS: '2048',
        AI_PROVIDER_TIMEOUT_MS: '15000',
      }),
      {
        apiKey: API_KEY,
        model: DEFAULT_OPENAI_MODEL,
        maxOutputTokens: 2048,
        timeoutMs: 15_000,
      },
    );

    for (const bad of ['', '   ', '0', '-1', '1.5', 'many']) {
      const config = readOpenAiProviderConfig({
        ...base,
        OPENAI_MAX_OUTPUT_TOKENS: bad,
        AI_PROVIDER_TIMEOUT_MS: bad,
      });
      assert.equal(config?.maxOutputTokens, DEFAULT_OPENAI_MAX_OUTPUT_TOKENS, bad);
      assert.equal(config?.timeoutMs, DEFAULT_OPENAI_TIMEOUT_MS, bad);
    }
  });

  it('builds a provider only when configured, and never throws on missing configuration', () => {
    assert.equal(createServerAiProviderFromEnv({}), null);
    assert.equal(createServerAiProviderFromEnv({ AI_PROVIDER: 'openai' }), null);

    // Constructing a provider performs no I/O, so this is safe without a fake fetch.
    const provider = createServerAiProviderFromEnv({
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: API_KEY,
    });
    assert.ok(provider !== null);
    assert.equal(typeof provider.suggest, 'function');
    assert.equal(DEFAULT_OPENAI_TIMEOUT_MS, 30_000);
  });
});
