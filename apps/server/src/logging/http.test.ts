/**
 * Request logging over real HTTP (M4 B9).
 *
 * The server under test is a real Express app on a real ephemeral port (the same harness the
 * authorization suites use), and the logger writes to a capturing sink — so these are assertions
 * about the bytes the production logger would emit, not about a mock.
 *
 * The negative assertions (cookie/authorization/body/query/instruction/content) are the point of
 * the feature: a request log that leaks its input is worse than no request log.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiSuggestionDraft } from '@insighthub/shared';

import { bootstrap, startHarness, type Harness } from '../authz/test-support.js';
import { bootstrapSession, startAiHarness } from '../ai/test-support.js';
import { AiLimits } from '../ai/limits.js';
import { ServerAiProviderError, type ServerAiProvider } from '../ai/provider.js';
import { createStubProvider } from '../ai/stub.js';
import { createLogger, readLogLevel } from './logger.js';
import { readConfiguredAiModel } from './startup.js';
import { captureLogs, type LogCapture } from './test-support.js';

/** Boot a harness whose app logs into `capture`. */
async function harnessWithLogs(
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<{ harness: Harness; capture: LogCapture }> {
  const capture = captureLogs();
  const harness = await startHarness({ logger: createLogger({ level, sink: capture.sink }) });
  return { harness, capture };
}

describe('http.request logging', () => {
  it('emits one JSON line per completed request with requestId, status and duration', async () => {
    const { harness, capture } = await harnessWithLogs();
    try {
      const first = await harness.request('/health');
      await first.text();
      const second = await harness.request('/health');
      await second.text();

      const requests = capture.events('http.request');
      assert.equal(requests.length, 2, `expected two request lines, got ${capture.text}`);

      const ids = new Set<string>();
      for (const record of requests) {
        assert.equal(record['method'], 'GET');
        assert.equal(record['path'], '/health');
        assert.equal(record['status'], 200);
        assert.equal(record['level'], 'info');
        assert.equal(typeof record['durationMs'], 'number');
        assert.ok(
          (record['durationMs'] as number) >= 0,
          `durationMs must be non-negative: ${String(record['durationMs'])}`,
        );
        assert.match(
          String(record['requestId']),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          'requestId must be a UUID, not a client-supplied header',
        );
        ids.add(String(record['requestId']));
      }
      assert.equal(ids.size, 2, 'two requests must have two different requestIds');
    } finally {
      await harness.close();
    }
  });

  it('records a failed request at error level with the frozen code, not a message', async () => {
    const { harness, capture } = await harnessWithLogs();
    try {
      const response = await harness.request('/api/no-such-endpoint');
      await response.text();
      assert.equal(response.status, 404);

      const request = capture.events('http.request')[0];
      assert.ok(request !== undefined, `no http.request line: ${capture.text}`);
      assert.equal(request['status'], 404);
      assert.equal(request['level'], 'error');
      assert.equal(request['errorCode'], 'not_found');
      // A status mapping or a message is not the contract; the frozen body's code is.
      assert.equal('message' in request, false);
      assert.equal('error' in request, false);
    } finally {
      await harness.close();
    }
  });

  it('correlates an authenticated request with the internal user id', async () => {
    const { harness, capture } = await harnessWithLogs();
    try {
      const session = await bootstrap(harness, 'demo-ada');
      const response = await harness.request('/api/session', {
        headers: { cookie: session.cookie },
      });
      await response.text();
      assert.equal(response.status, 200);

      const request = capture
        .events('http.request')
        .find((record) => record['path'] === '/api/session' && record['status'] === 200);
      assert.ok(request !== undefined, `no /api/session request line: ${capture.text}`);
      assert.equal(request['userId'], session.userId);

      // Document correlation: the id the request was about, bound by the access handler.
      const documentResponse = await harness.request('/api/documents/demo-document', {
        headers: { cookie: session.cookie },
      });
      await documentResponse.text();
      const documentRequest = capture
        .events('http.request')
        .find((record) => record['path'] === '/api/documents/demo-document');
      assert.ok(documentRequest !== undefined, `no document request line: ${capture.text}`);
      assert.equal(documentRequest['userId'], session.userId);
      assert.equal(documentRequest['documentId'], 'demo-document');
    } finally {
      await harness.close();
    }
  });

  it('never logs cookie, authorization, body, query or document content', async () => {
    const { harness, capture } = await harnessWithLogs();
    try {
      const session = await bootstrap(harness, 'demo-ada');

      const authenticated = await harness.request('/api/session', {
        headers: {
          cookie: session.cookie,
          authorization: 'Bearer LEAK_AUTHORIZATION_VALUE',
        },
      });
      await authenticated.text();

      const withBody = await harness.request('/api/session/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ demoUserId: 'demo-ada', note: 'LEAK_BODY_VALUE' }),
      });
      await withBody.text();

      const withQuery = await harness.request(
        '/api/documents?access_token=LEAK_QUERY_VALUE&search=LEAK_SEARCH_VALUE',
        { headers: { cookie: session.cookie } },
      );
      await withQuery.text();

      // `LOG_LEVEL=error` is exercised separately; this one is about values.
      for (const leak of [
        'LEAK_AUTHORIZATION_VALUE',
        'LEAK_BODY_VALUE',
        'LEAK_QUERY_VALUE',
        'LEAK_SEARCH_VALUE',
        // The session token itself: the cookie value must not appear in any line.
        session.token,
      ]) {
        assert.equal(capture.text.includes(leak), false, `the log leaked ${JSON.stringify(leak)}`);
      }
      // Not even the query key names: a key can carry a secret too.
      assert.equal(capture.text.includes('access_token'), false);
      assert.equal(capture.text.includes('Authorization'), false);
    } finally {
      await harness.close();
    }
  });

  it('filters info when LOG_LEVEL=error', async () => {
    const { harness, capture } = await harnessWithLogs(readLogLevel('error'));
    try {
      const response = await harness.request('/health');
      await response.text();
      assert.equal(response.status, 200);
      assert.equal(
        capture.events('http.request').length,
        0,
        `an info request must be filtered: ${capture.text}`,
      );
    } finally {
      await harness.close();
    }
  });
});

describe('ai.suggest logging', () => {
  it('records outcome/model/ids and never the instruction or content', async () => {
    const capture = captureLogs();
    const harness = await startAiHarness(createStubProvider(), {
      logger: createLogger({ sink: capture.sink }),
    });
    try {
      const cookie = await bootstrapSession(harness, 'demo-ada');
      const response = await harness.request('/api/ai/suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          documentId: 'demo-document',
          instruction: 'LEAK_INSTRUCTION_VALUE',
          baseRevision: 0,
          content: 'LEAK_CONTENT_VALUE',
        }),
      });
      assert.equal(response.status, 200, await response.text());

      const events = capture.events('ai.suggest');
      assert.equal(events.length, 1, `expected one ai.suggest line: ${capture.text}`);
      const event = events[0] as Record<string, unknown>;
      assert.equal(event['userId'], 'demo-ada');
      assert.equal(event['documentId'], 'demo-document');
      assert.equal(event['outcome'], 'ok');
      assert.equal(event['model'], 'stub', 'the draft model is what produced the outcome');
      assert.match(String(event['requestId']), /^[0-9a-f-]{36}$/);

      assert.equal(capture.text.includes('LEAK_INSTRUCTION_VALUE'), false);
      assert.equal(capture.text.includes('LEAK_CONTENT_VALUE'), false);
      assert.equal(capture.text.includes('UPPERCASED'), false, 'no proposal text may be logged');

      // The same correlation id ties the route event and the request line together.
      const request = capture
        .events('http.request')
        .find((record) => record['path'] === '/api/ai/suggest');
      assert.ok(request !== undefined);
      assert.equal(request['requestId'], event['requestId']);
      assert.equal(request['documentId'], 'demo-document');
    } finally {
      await harness.close();
    }
  });

  it('records a refusal as refused with the frozen error code on the request line', async () => {
    const capture = captureLogs();
    const harness = await startAiHarness(createStubProvider(), {
      logger: createLogger({ sink: capture.sink }),
    });
    try {
      const cookie = await bootstrapSession(harness, 'demo-ada');
      const response = await harness.request('/api/ai/suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          documentId: 'no-such-document',
          instruction: 'LEAK_INSTRUCTION_VALUE',
          baseRevision: 0,
          content: 'LEAK_CONTENT_VALUE',
        }),
      });
      assert.equal(response.status, 404);

      const event = capture.events('ai.suggest')[0] as Record<string, unknown> | undefined;
      assert.ok(event !== undefined, `no ai.suggest line: ${capture.text}`);
      assert.equal(event['outcome'], 'refused');
      assert.equal(event['userId'], 'demo-ada');
      assert.equal(event['documentId'], 'no-such-document');
      assert.equal(event['model'], readConfiguredAiModel(process.env));

      const request = capture
        .events('http.request')
        .find((record) => record['path'] === '/api/ai/suggest');
      assert.ok(request !== undefined);
      assert.equal(request['status'], 404);
      assert.equal(request['errorCode'], 'not_found');

      assert.equal(capture.text.includes('LEAK_INSTRUCTION_VALUE'), false);
      assert.equal(capture.text.includes('LEAK_CONTENT_VALUE'), false);
    } finally {
      await harness.close();
    }
  });

  it('records a budget refusal as rate_limited, with a 429 request line', async () => {
    const capture = captureLogs();
    const harness = await startAiHarness(createStubProvider(), {
      logger: createLogger({ sink: capture.sink }),
      aiLimits: new AiLimits({ perHour: 1 }),
    });
    try {
      const cookie = await bootstrapSession(harness, 'demo-ada');
      const body = JSON.stringify({
        documentId: 'demo-document',
        instruction: 'Shorten it.',
        baseRevision: 0,
        content: 'hello',
      });
      const send = async (): Promise<Response> =>
        await harness.request('/api/ai/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body,
        });

      const first = await send();
      assert.equal(first.status, 200);
      await first.text();
      const second = await send();
      assert.equal(second.status, 429);
      await second.text();

      assert.deepEqual(
        capture.events('ai.suggest').map((record) => record['outcome']),
        ['ok', 'rate_limited'],
      );
      const requests = capture
        .events('http.request')
        .filter((record) => record['path'] === '/api/ai/suggest');
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.['status'], 429);
      assert.equal(requests[1]?.['errorCode'], 'rate_limited');
    } finally {
      await harness.close();
    }
  });

  it('maps provider timeout and invalid output to their outcomes', async () => {
    const cases: {
      readonly label: string;
      readonly provider: ServerAiProvider;
      readonly status: number;
      readonly outcome: string;
      readonly level: string;
      readonly errorCode: string;
    }[] = [
      {
        label: 'timeout',
        provider: {
          suggest: async () => {
            throw new ServerAiProviderError('timeout', 'the provider timed out');
          },
        },
        status: 504,
        outcome: 'timeout',
        level: 'warn',
        errorCode: 'provider_timeout',
      },
      {
        label: 'invalid_output',
        provider: {
          // The route's boundary schema rejects this: no summary/operations.
          suggest: async () => ({}) as unknown as AiSuggestionDraft,
        },
        status: 502,
        outcome: 'invalid_output',
        level: 'warn',
        errorCode: 'invalid_provider_output',
      },
    ];

    for (const testCase of cases) {
      const capture = captureLogs();
      const harness = await startAiHarness(testCase.provider, {
        logger: createLogger({ sink: capture.sink }),
      });
      try {
        const cookie = await bootstrapSession(harness, 'demo-ada');
        const response = await harness.request('/api/ai/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({
            documentId: 'demo-document',
            instruction: 'LEAK_INSTRUCTION_VALUE',
            baseRevision: 0,
            content: 'LEAK_CONTENT_VALUE',
          }),
        });
        assert.equal(response.status, testCase.status, testCase.label);
        await response.text();

        const event = capture.events('ai.suggest')[0] as Record<string, unknown> | undefined;
        assert.ok(event !== undefined, `no ai.suggest line for ${testCase.label}`);
        assert.equal(event['outcome'], testCase.outcome);
        assert.equal(event['level'], testCase.level);

        const request = capture
          .events('http.request')
          .find((record) => record['path'] === '/api/ai/suggest');
        assert.ok(request !== undefined);
        assert.equal(request['errorCode'], testCase.errorCode);
        assert.equal(capture.text.includes('LEAK_INSTRUCTION_VALUE'), false);
        assert.equal(capture.text.includes('LEAK_CONTENT_VALUE'), false);
      } finally {
        await harness.close();
      }
    }
  });
});
