/**
 * `POST /api/ai/suggest` — the §11.2 failure matrix, driven through the real Express app.
 *
 * Every test injects a fake provider, so no test can reach OpenAI. The assertions cover the
 * three properties the contract cares about:
 *
 * 1. **Status mapping** — 200 / 401 / 400 / 404 / 503 / 504 / 502, one test per row of the
 *    §11.2 table.
 * 2. **Non-disclosure** — unknown document and "no read access" produce the same status,
 *    body and headers as §17.4; the provider is never called for a denied document.
 * 3. **Fail closed** — every failure body is exactly `{ error: "…" }`; no `operations`, no
 *    `summary`, no partial draft (asserted by `assertFailure`, used by every failure test).
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { aiSuggestionDraftSchema, type AiSuggestionDraft } from '@insighthub/shared';

import {
  ServerAiProviderError,
  type ServerAiProvider,
  type ServerAiSuggestInput,
} from './provider.js';
import {
  bootstrapSession,
  comparableHeaders,
  postSuggest,
  startAiHarness,
  type AiTestHarness,
} from './test-support.js';

const harnesses: AiTestHarness[] = [];

async function newHarness(provider: ServerAiProvider | null): Promise<AiTestHarness> {
  const harness = await startAiHarness(provider);
  harnesses.push(harness);
  return harness;
}

after(async () => {
  for (const harness of harnesses) await harness.close();
});

interface RecordedCall {
  readonly input: ServerAiSuggestInput;
  readonly signal: AbortSignal;
}

interface FakeProvider extends ServerAiProvider {
  readonly calls: RecordedCall[];
}

function fakeProvider(
  handler: (call: RecordedCall) => AiSuggestionDraft | Promise<AiSuggestionDraft>,
): FakeProvider {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async suggest(input: ServerAiSuggestInput, signal: AbortSignal): Promise<AiSuggestionDraft> {
      const call = { input, signal };
      calls.push(call);
      return handler(call);
    },
  };
}

/** A provider that always fails with the given error. */
function failingProvider(error: unknown): FakeProvider {
  return fakeProvider(() => {
    throw error;
  });
}

const SAMPLE_DRAFT: AiSuggestionDraft = {
  summary: 'Add a greeting at the top',
  operations: [{ kind: 'insert', index: 0, text: 'Hello\n' }],
  model: 'fake-model',
};

/** A request every seeded document can accept; `content` is the snapshot offsets refer to. */
const VALID_BODY = {
  documentId: 'demo-document',
  instruction: 'Add a greeting at the very top.',
  baseRevision: 0,
  content: '# Notes\n',
} as const;

/**
 * Assert a failure response is one of the frozen error bodies.
 *
 * This is the fail-closed check: the body must deep-equal `{ error }`, and the raw text must
 * mention neither `operations` nor `summary`. A future handler that "helpfully" returns the
 * partial draft alongside an error fails here.
 */
async function assertFailure(response: Response, status: number, error: string): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  assert.deepEqual(JSON.parse(text), { error }, text);
  assert.ok(!text.includes('operations'), `a failure body leaked "operations": ${text}`);
  assert.ok(!text.includes('summary'), `a failure body leaked "summary": ${text}`);
}

describe('POST /api/ai/suggest — 200', () => {
  it('returns the provider draft, schema-valid and without anchors', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, {
      ...VALID_BODY,
      selection: { from: 0, to: 5 },
    });

    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    // The draft is returned as-is: no server-invented anchors, no extra fields.
    assert.deepEqual(body, SAMPLE_DRAFT);
    assert.ok(aiSuggestionDraftSchema.safeParse(body).success);

    const operation = (body as AiSuggestionDraft).operations[0];
    assert.ok(operation !== undefined);
    assert.deepEqual(Object.keys(operation).sort(), ['index', 'kind', 'text']);
    assert.equal('anchor' in operation, false);

    assert.equal(provider.calls.length, 1);
    const call = provider.calls[0] as RecordedCall;
    assert.deepEqual(call.input, {
      instruction: VALID_BODY.instruction,
      content: VALID_BODY.content,
      selection: { from: 0, to: 5 },
    });
    assert.ok(call.signal instanceof AbortSignal, 'the provider must receive an AbortSignal');
  });

  it('forwards only instruction/content/selection and omits an absent selection', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, VALID_BODY);
    assert.equal(response.status, 200);

    const call = provider.calls[0] as RecordedCall;
    assert.deepEqual(Object.keys(call.input).sort(), ['content', 'instruction']);
    // `documentId` and `baseRevision` are server-side authorization/staleness inputs; they
    // are not part of the provider seam and must not be shipped to a model.
    assert.equal('documentId' in call.input, false);
    assert.equal('baseRevision' in call.input, false);
  });

  it('allows a viewer to request a draft: canRead is the only requirement', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);
    // `demo-linus` is a viewer on `demo-document` (docs/CONTRACTS.md §17.3 fixture).
    const cookie = await bootstrapSession(harness, 'demo-linus');

    const response = await postSuggest(harness, cookie, VALID_BODY);
    assert.equal(response.status, 200);
    assert.equal(provider.calls.length, 1);
  });
});

describe('POST /api/ai/suggest — 401 session_required', () => {
  it('refuses a request without a session and never calls the provider', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);

    const response = await postSuggest(harness, null, VALID_BODY);
    await assertFailure(response, 401, 'session_required');
    assert.equal(provider.calls.length, 0);
  });

  it('checks the session before it parses the body', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);

    for (const body of ['{ not json', {}, null]) {
      const response = await postSuggest(harness, null, body);
      await assertFailure(response, 401, 'session_required');
    }
    assert.equal(provider.calls.length, 0);
  });

  it('does not distinguish an unknown document from an existing one without a session', async () => {
    const harness = await newHarness(fakeProvider(() => SAMPLE_DRAFT));
    for (const documentId of ['demo-document', 'no-such-document']) {
      const response = await postSuggest(harness, null, { ...VALID_BODY, documentId });
      await assertFailure(response, 401, 'session_required');
    }
  });
});

describe('POST /api/ai/suggest — 400 invalid_request', () => {
  it('rejects every malformed body with the fixed error and no provider call', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const malformed: unknown[] = [
      // Not JSON at all (the route-scoped parser answers 400, not a stack trace).
      '{ not json',
      // Not an object.
      null,
      [],
      // Missing fields / empty strings / out of range numbers.
      {},
      { ...VALID_BODY, documentId: '' },
      { ...VALID_BODY, instruction: '' },
      { ...VALID_BODY, baseRevision: -1 },
      { ...VALID_BODY, content: 'x'.repeat(200_001) },
      { ...VALID_BODY, selection: { from: -1, to: 2 } },
      { ...VALID_BODY, selection: { from: 0 } },
    ];

    for (const body of malformed) {
      const response = await postSuggest(harness, cookie, body);
      await assertFailure(response, 400, 'invalid_request');
    }
    assert.equal(provider.calls.length, 0);
  });
});

describe('POST /api/ai/suggest — 404 non-disclosure', () => {
  it('answers unknown document and no membership with byte-identical 404s', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);
    const ada = await bootstrapSession(harness, 'demo-ada');
    const grace = await bootstrapSession(harness, 'demo-grace');

    // Three caller states that must be indistinguishable:
    //   1. the document does not exist;
    //   2. the document exists and the caller has no membership row.
    // "no canRead" is not constructible over HTTP: `viewer` already holds canRead, so the
    // least role cannot lack it (the same note as `authz/http-session.test.ts`).
    const unknown = await postSuggest(harness, ada, {
      ...VALID_BODY,
      documentId: 'no-such-document',
    });
    const notMember = await postSuggest(harness, grace, {
      ...VALID_BODY,
      documentId: 'demo-private-notes',
    });

    const snapshots = [
      {
        status: unknown.status,
        headers: comparableHeaders(unknown),
        body: await unknown.text(),
      },
      {
        status: notMember.status,
        headers: comparableHeaders(notMember),
        body: await notMember.text(),
      },
    ];

    for (const snapshot of snapshots) {
      assert.equal(snapshot.status, 404);
      assert.equal(snapshot.body, '{"error":"not_found"}');
      assert.equal(snapshot.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(snapshot.headers['set-cookie'], undefined, 'a refusal must not set a cookie');
      assert.ok(!snapshot.body.includes('operations'));
      assert.ok(!snapshot.body.includes('summary'));
    }
    // Body-derived headers (content-length, etag) and every other header except `date` must
    // match, so a caller cannot tell the two cases apart.
    assert.deepEqual(snapshots[1]?.headers, snapshots[0]?.headers);
    assert.equal(provider.calls.length, 0, 'a denied document must not reach the provider');
  });

  it('never calls the provider for a document the caller cannot read', async () => {
    const provider = fakeProvider(() => SAMPLE_DRAFT);
    const harness = await newHarness(provider);
    const grace = await bootstrapSession(harness, 'demo-grace');

    // `demo-grace` may read `demo-document` (editor) but not `demo-private-notes`.
    assert.equal((await postSuggest(harness, grace, VALID_BODY)).status, 200);
    assert.equal(provider.calls.length, 1);
    assert.equal(
      (
        await postSuggest(harness, grace, {
          ...VALID_BODY,
          documentId: 'demo-private-notes',
        })
      ).status,
      404,
    );
    assert.equal(provider.calls.length, 1, 'the denied request must not add a provider call');
  });
});

describe('POST /api/ai/suggest — provider failure matrix', () => {
  it('answers 503 when no provider is configured', async () => {
    const harness = await newHarness(null);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, VALID_BODY);
    await assertFailure(response, 503, 'ai_provider_not_configured');
  });

  it('answers 504 for a provider timeout / abort', async () => {
    const harness = await newHarness(
      failingProvider(new ServerAiProviderError('timeout', 'the AI provider request timed out')),
    );
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, VALID_BODY);
    await assertFailure(response, 504, 'provider_timeout');
  });

  it('answers 502 provider_error for a provider failure or an unknown throw', async () => {
    for (const error of [
      new ServerAiProviderError('provider', 'the AI provider responded with HTTP 500'),
      new Error('boom'),
      'not even an error object',
    ]) {
      const harness = await newHarness(failingProvider(error));
      const cookie = await bootstrapSession(harness, 'demo-ada');

      const response = await postSuggest(harness, cookie, VALID_BODY);
      await assertFailure(response, 502, 'provider_error');
    }
  });

  it('answers 503 for a provider that reports itself not configured', async () => {
    const harness = await newHarness(
      failingProvider(new ServerAiProviderError('not-configured', 'no key')),
    );
    const cookie = await bootstrapSession(harness, 'demo-ada');

    await assertFailure(
      await postSuggest(harness, cookie, VALID_BODY),
      503,
      'ai_provider_not_configured',
    );
  });

  it('answers 502 invalid_provider_output for a typed invalid-output failure', async () => {
    const harness = await newHarness(
      failingProvider(new ServerAiProviderError('invalid-output', 'not JSON')),
    );
    const cookie = await bootstrapSession(harness, 'demo-ada');

    await assertFailure(
      await postSuggest(harness, cookie, VALID_BODY),
      502,
      'invalid_provider_output',
    );
  });

  it('validates the provider result at the boundary, so a broken provider cannot emit a bad draft', async () => {
    const brokenDrafts: AiSuggestionDraft[] = [
      // Zero operations: schema forbids it (min 1).
      { summary: 'empty', operations: [] },
      // Unknown operation kind.
      {
        summary: 'unknown kind',
        operations: [{ kind: 'delete', index: 0 } as unknown as AiSuggestionDraft['operations'][0]],
      },
      // Summary over the 500-char ceiling.
      { summary: 'x'.repeat(501), operations: [{ kind: 'insert', index: 0, text: 'x' }] },
    ];

    for (const draft of brokenDrafts) {
      const harness = await newHarness(fakeProvider(() => draft));
      const cookie = await bootstrapSession(harness, 'demo-ada');
      await assertFailure(
        await postSuggest(harness, cookie, VALID_BODY),
        502,
        'invalid_provider_output',
      );
    }
  });
});

describe('credential hygiene on the wire', () => {
  it('never echoes a provider message, key or prompt — only the fixed error body', async () => {
    const secret = 'sk-route-SENTINEL-do-not-leak';
    const harness = await newHarness(
      failingProvider(
        new ServerAiProviderError(
          'provider',
          `HTTP 500 while sending Bearer ${secret} for prompt ${VALID_BODY.instruction}`,
        ),
      ),
    );
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const response = await postSuggest(harness, cookie, VALID_BODY);
    const text = await response.text();

    assert.equal(response.status, 502);
    assert.equal(text, '{"error":"provider_error"}');
    for (const forbidden of [secret, 'Bearer', 'authorization', VALID_BODY.instruction]) {
      assert.ok(!text.includes(forbidden), `the response leaked ${forbidden}`);
    }
  });
});
