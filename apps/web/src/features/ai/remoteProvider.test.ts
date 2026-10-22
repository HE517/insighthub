import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  aiEditSuggestionSchema,
  aiSuggestHttpRequestSchema,
  createOperationAnchor,
  DOCUMENT_TEXT_KEY,
  validateSuggestionAgainstDocument,
  type AiEditSuggestion,
} from '@insighthub/shared';

import type { AiSuggestInput } from './provider.js';
import {
  createRemoteProvider,
  RemoteProviderError,
  type RemoteProviderFailure,
} from './remoteProvider.js';
import { createDocument, docText } from './testSupport.js';

const FIXED_NOW = new Date('2026-10-22T10:00:00.000Z');
const REVISION = 7;
const ENDPOINT = '/api/ai/suggest';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** A `fetch` double: records every call and answers with the supplied response. */
function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function inputFor(
  doc: Y.Doc,
  instruction = 'Make this clearer',
  selection?: { from: number; to: number },
  signal?: AbortSignal,
): AiSuggestInput {
  return {
    documentId: 'demo-document',
    instruction,
    text: docText(doc),
    ...(selection === undefined ? {} : { selection }),
    baseRevision: REVISION,
    ...(signal === undefined ? {} : { signal }),
    anchorText: doc.getText(DOCUMENT_TEXT_KEY),
  };
}

/** A draft that means "replace `quick` with `QUICK`" against "The quick brown fox". */
const UPPERCASE_DRAFT = {
  summary: 'Uppercase the selection',
  operations: [{ kind: 'replace', index: 4, length: 5, text: 'QUICK' }],
  model: 'fake-model',
};

function providerWith(draft: unknown = UPPERCASE_DRAFT): {
  provider: ReturnType<typeof createRemoteProvider>;
  calls: FetchCall[];
} {
  const fake = fakeFetch(() => jsonResponse(draft));
  return {
    provider: createRemoteProvider({
      endpoint: ENDPOINT,
      fetchImpl: fake.fetchImpl,
      now: () => FIXED_NOW,
    }),
    calls: fake.calls,
  };
}

describe('remote provider: a 200 draft becomes a locally anchored suggestion', () => {
  it('validates against the live Y.Text and passes the frozen suggestion schema', async () => {
    const doc = createDocument('The quick brown fox');
    const { provider, calls } = providerWith();

    const suggestion = await provider.suggest(
      inputFor(doc, 'uppercase the selection', { from: 4, to: 9 }),
    );

    // 1. The returned object is a real `AiEditSuggestion`, not the draft.
    expect(aiEditSuggestionSchema.safeParse(suggestion).success).toBe(true);
    expect(suggestion).toMatchObject({
      documentId: 'demo-document',
      baseRevision: REVISION,
      summary: UPPERCASE_DRAFT.summary,
      status: 'pending',
      createdAt: FIXED_NOW.toISOString(),
    });
    expect(suggestion.id).toMatch(/^remote-/);
    expect(suggestion.diff).toContain('-The quick brown fox');
    expect(suggestion.diff).toContain('+The QUICK brown fox');

    // 2. The three-stage validation succeeds against the **live** document.
    expect(validateSuggestionAgainstDocument(suggestion, doc, REVISION)).toEqual({
      ok: true,
      ranges: [{ index: 4, length: 5 }],
    });

    // 3. The anchor was minted by the shared helper against `session.text`, not invented from the
    //    draft's offsets: byte-identical output is the observable proof.
    const operation = suggestion.operations[0];
    if (operation.kind !== 'replace') throw new Error('the draft was a replace');
    expect(operation.anchor).toEqual(
      createOperationAnchor(doc.getText(DOCUMENT_TEXT_KEY), { index: 4, length: 5 }),
    );

    // 4. A proposal is not document state.
    expect(docText(doc)).toBe('The quick brown fox');
    expect(calls).toHaveLength(1);
  });

  it('keeps the caller revision, not a server-supplied one', async () => {
    const doc = createDocument('alpha beta');
    const { provider } = providerWith({
      summary: 'Uppercase the first word',
      operations: [{ kind: 'replace', index: 0, length: 5, text: 'ALPHA' }],
    });

    const suggestion: AiEditSuggestion = await provider.suggest(inputFor(doc));
    expect(suggestion.baseRevision).toBe(REVISION);
  });
});

describe('remote provider: request shape', () => {
  it('POSTs the frozen body, includes the session cookie and forwards the signal', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() =>
      jsonResponse({
        summary: 'Uppercase the first word',
        operations: [{ kind: 'replace', index: 0, length: 5, text: 'ALPHA' }],
      }),
    );
    const provider = createRemoteProvider({
      endpoint: '/custom/ai',
      fetchImpl: fake.fetchImpl,
      now: () => FIXED_NOW,
    });
    const controller = new AbortController();

    await provider.suggest(
      inputFor(doc, 'uppercase "alpha"', { from: 0, to: 5 }, controller.signal),
    );

    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0];
    expect(url).toBe('/custom/ai');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    // Identity, not merely "some signal": the caller's controller must be forwarded unchanged.
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      documentId: 'demo-document',
      instruction: 'uppercase "alpha"',
      baseRevision: REVISION,
      content: 'alpha beta',
      selection: { from: 0, to: 5 },
    });
    // The body is exactly the contract's request shape — no extra field can carry a credential.
    expect(aiSuggestHttpRequestSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual([
      'baseRevision',
      'content',
      'documentId',
      'instruction',
      'selection',
    ]);
  });

  it('omits selection when there is none, and defaults to the contract endpoint', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() =>
      jsonResponse({
        summary: 'Uppercase the first word',
        operations: [{ kind: 'replace', index: 0, length: 5, text: 'ALPHA' }],
      }),
    );
    const provider = createRemoteProvider({ fetchImpl: fake.fetchImpl, now: () => FIXED_NOW });

    await provider.suggest(inputFor(doc));

    expect(fake.calls[0].url.endsWith('/api/ai/suggest')).toBe(true);
    const body = JSON.parse(String(fake.calls[0].init.body)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'selection')).toBe(false);
  });

  it('treats a collapsed caret as "no selection" instead of an empty range', async () => {
    // A6's round-2 probe: sending `{from:to}` with `from === to` let the stub "uppercase" an empty
    // range and produced an Accept-able proposal with an empty diff. A caret is not a selection.
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() =>
      jsonResponse({
        summary: 'Uppercase the first word',
        operations: [{ kind: 'replace', index: 0, length: 5, text: 'ALPHA' }],
      }),
    );
    const provider = createRemoteProvider({ fetchImpl: fake.fetchImpl, now: () => FIXED_NOW });

    await provider.suggest(inputFor(doc, 'Uppercase', { from: 3, to: 3 }));

    const body = JSON.parse(String(fake.calls[0].init.body)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'selection')).toBe(false);
  });

  it('refuses a schema-valid draft that changes nothing', async () => {
    // Schema validity is not usefulness: a no-op draft must never become an Accept-able proposal.
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() =>
      jsonResponse({
        summary: 'No change',
        operations: [{ kind: 'replace', index: 0, length: 0, text: '' }],
      }),
    );
    const provider = createRemoteProvider({ fetchImpl: fake.fetchImpl, now: () => FIXED_NOW });

    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({
      kind: 'invalid-output',
    });
  });
});

describe('remote provider: the failure matrix never returns a suggestion', () => {
  const STATUS_CASES: ReadonlyArray<readonly [number, RemoteProviderFailure]> = [
    [401, 'unauthorized'],
    [404, 'not-found'],
    [503, 'not-configured'],
    [504, 'timeout'],
    [502, 'provider'],
  ];

  for (const [status, kind] of STATUS_CASES) {
    it(`maps HTTP ${status} to kind "${kind}" and leaks no response body`, async () => {
      const doc = createDocument('secret document text');
      const fake = fakeFetch(() =>
        jsonResponse(
          {
            error: 'provider_failed',
            detail: 'SECRET-RESPONSE-BODY instruction=secret document text',
          },
          status,
        ),
      );
      const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });

      const caught: unknown = await provider
        .suggest(inputFor(doc, 'SECRET-PROMPT please rewrite'))
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(RemoteProviderError);
      const error = caught as RemoteProviderError;
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain('SECRET-RESPONSE-BODY');
      expect(error.message).not.toContain('SECRET-PROMPT');
      expect(error.message).not.toContain('secret document text');
      expect(docText(doc)).toBe('secret document text');
    });
  }

  it('never reads the body of an error response', async () => {
    const doc = createDocument('alpha beta');
    let bodyReads = 0;
    const fake = fakeFetch(
      () =>
        ({
          ok: false,
          status: 503,
          json: async (): Promise<unknown> => {
            bodyReads += 1;
            return { error: 'a body that must never be parsed' };
          },
        }) as unknown as Response,
    );
    const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });

    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({
      kind: 'not-configured',
    });
    expect(bodyReads).toBe(0);
  });

  it('maps malformed JSON on 200 to "invalid-output"', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() => new Response('{"summary": "truncated"', { status: 200 }));
    const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });

    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({
      name: 'RemoteProviderError',
      kind: 'invalid-output',
    });
    expect(docText(doc)).toBe('alpha beta');
  });

  it('maps a draft that fails the shared schema to "invalid-output"', async () => {
    const doc = createDocument('alpha beta');
    const { provider } = providerWith({ summary: '', operations: [] });

    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({
      kind: 'invalid-output',
    });
    expect(docText(doc)).toBe('alpha beta');
  });

  it('maps a schema-valid draft whose offsets leave the document to "invalid-output"', async () => {
    const doc = createDocument('short');
    const { provider } = providerWith({
      summary: 'Replace far past the end',
      operations: [{ kind: 'replace', index: 0, length: 999, text: 'x' }],
    });

    // The schema accepts it (index/length are non-negative integers); `createOperationAnchor`
    // refuses it against the live Y.Text, so there is no half-valid suggestion.
    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({
      kind: 'invalid-output',
    });
    expect(docText(doc)).toBe('short');
  });

  it('refuses a snapshot that went stale while the request was in flight', async () => {
    const doc = createDocument('live text');
    const { provider } = providerWith();

    await expect(
      provider.suggest({ ...inputFor(doc), text: 'a stale snapshot' }),
    ).rejects.toMatchObject({ kind: 'invalid-output' });
    expect(docText(doc)).toBe('live text');
  });

  it('never reaches the network for an already-aborted signal', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() => jsonResponse(UPPERCASE_DRAFT));
    const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.suggest(inputFor(doc, 'uppercase', undefined, controller.signal)),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a caller abort during the request to "aborted"', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The caller aborted.', 'AbortError'));
          });
        }),
    );
    const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });
    const controller = new AbortController();

    const attempt = provider.suggest(inputFor(doc, 'uppercase', undefined, controller.signal));
    controller.abort();

    await expect(attempt).rejects.toMatchObject({ kind: 'aborted' });
    expect(docText(doc)).toBe('alpha beta');
  });

  it('maps an abort the caller did not request to "timeout"', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() => Promise.reject(new DOMException('deadline', 'TimeoutError')));
    const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });

    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps an unreachable endpoint to "provider"', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });

    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({ kind: 'provider' });
  });

  it('maps any other HTTP status to "provider" without inventing a kind', async () => {
    const doc = createDocument('alpha beta');
    const fake = fakeFetch(() => jsonResponse({ error: 'internal_error' }, 500));
    const provider = createRemoteProvider({ endpoint: ENDPOINT, fetchImpl: fake.fetchImpl });

    await expect(provider.suggest(inputFor(doc))).rejects.toMatchObject({
      name: 'RemoteProviderError',
      kind: 'provider',
      status: 500,
    });
  });
});
