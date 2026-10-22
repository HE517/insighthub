/**
 * `POST /api/ai/suggest` — the M4 B5 budget, driven through the real Express route.
 *
 * The suite is deliberately end-to-end where it matters: a real app from `createApp`, real
 * request parsing, the real `canRead` decision, and only the **provider** replaced. The budget
 * is injected with a settable clock (`AiLimits({ now })`), so a window can be advanced without
 * sleeping and no test depends on wall-clock timing.
 *
 * What is pinned here (D-082 D3):
 *
 * 1. 20/user/hour — the 21st is `429 {"error":"rate_limited"}` + `Retry-After: 3600`, and the
 *    provider call count does not move.
 * 2. 100/user/day — reachable at the allowed hourly rate; the 101st is a daily 429.
 * 3. 1 generation/user — the second concurrent request is 429; a slot frees on completion.
 * 4. 4 provider requests/server — across five users the fifth is 429; slots free on completion.
 * 5. Provider failure, timeout and client abort all return the slot **and** keep the count
 *    (tokens were spent). Twenty failures still exhaust the hour budget.
 * 6. Refusals above the budget (401/400/404) do not consume the allowance.
 * 7. A 429 body is exactly `{ error }`; it never overlaps a provider failure status.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { AiSuggestionDraft, DocumentMeta } from '@insighthub/shared';

import type { AuthzService } from '../authz/public.js';
import { AI_HOUR_WINDOW_MS, AiLimits } from './limits.js';
import {
  ServerAiProviderError,
  type ServerAiProvider,
  type ServerAiSuggestInput,
} from './provider.js';
import {
  bootstrapSession,
  postSuggest,
  startAiHarness,
  type AiTestHarness,
  type AiTestHarnessOptions,
} from './test-support.js';

const harnesses: AiTestHarness[] = [];

async function newHarness(
  provider: ServerAiProvider | null,
  options: AiTestHarnessOptions = {},
): Promise<AiTestHarness> {
  const harness = await startAiHarness(provider, options);
  harnesses.push(harness);
  return harness;
}

after(async () => {
  for (const harness of harnesses) await harness.close();
});

const SAMPLE_DRAFT: AiSuggestionDraft = {
  summary: 'Add a greeting at the top',
  operations: [{ kind: 'insert', index: 0, text: 'Hello\n' }],
};

const VALID_BODY = {
  documentId: 'demo-document',
  instruction: 'Add a greeting at the very top.',
  baseRevision: 0,
  content: '# Notes\n',
} as const;

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
    async suggest(input: ServerAiSuggestInput, signal: AbortSignal) {
      const call = { input, signal };
      calls.push(call);
      return await handler(call);
    },
  };
}

/** Settable clock shared by the injected `AiLimits`. */
function fakeClock(start = 1_700_000_000_000): {
  readonly now: () => number;
  readonly set: (value: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Assert the frozen 429: status, `{ error: "rate_limited" }`, whole-second Retry-After. */
async function assertRateLimited(response: Response, expectedRetryAfter?: string): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, 429, text);
  assert.deepEqual(JSON.parse(text), { error: 'rate_limited' }, text);
  assert.ok(!text.includes('operations'));
  assert.ok(!text.includes('summary'));

  const retryAfter = response.headers.get('retry-after');
  assert.notEqual(retryAfter, null, 'a 429 must carry Retry-After');
  assert.match(retryAfter ?? '', /^\d+$/, 'Retry-After must be whole seconds');
  assert.ok(Number(retryAfter) >= 1, 'Retry-After must never be zero');
  if (expectedRetryAfter !== undefined) assert.equal(retryAfter, expectedRetryAfter);
}

/** Read one successful response fully so the socket is free for the next request. */
async function expectDraft(response: Response): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.deepEqual(JSON.parse(text), SAMPLE_DRAFT, text);
}

describe('20 per user per hour (through the route)', () => {
  it('returns 200 twenty times, then 429 on the 21st without calling the provider', async () => {
    const clock = fakeClock();
    const provider = fakeProvider(async () => SAMPLE_DRAFT);
    const harness = await newHarness(provider, {
      aiLimits: new AiLimits({ now: clock.now }),
    });
    const cookie = await bootstrapSession(harness, 'demo-ada');

    for (let index = 0; index < 20; index += 1) {
      await expectDraft(await postSuggest(harness, cookie, VALID_BODY));
    }
    assert.equal(provider.calls.length, 20);

    const denied = await postSuggest(harness, cookie, VALID_BODY);
    await assertRateLimited(denied, String(AI_HOUR_WINDOW_MS / 1_000));
    assert.equal(provider.calls.length, 20, 'a denied request must not reach the provider');
    assert.equal(harness.aiLimits.activeServerGenerations, 0, 'a denied request holds no slot');

    // The next hour window admits the same user again.
    clock.set(clock.now() + AI_HOUR_WINDOW_MS);
    await expectDraft(await postSuggest(harness, cookie, VALID_BODY));
    assert.equal(provider.calls.length, 21);
  });

  it('does not consume the hour budget for a request refused before the provider', async () => {
    const clock = fakeClock();
    const provider = fakeProvider(async () => SAMPLE_DRAFT);
    const harness = await newHarness(provider, {
      aiLimits: new AiLimits({ now: clock.now }),
    });
    const ada = await bootstrapSession(harness, 'demo-ada');
    const grace = await bootstrapSession(harness, 'demo-grace');

    // 25 no-session refusals, 25 malformed bodies, 25 non-disclosure refusals.
    for (let index = 0; index < 25; index += 1) {
      assert.equal((await postSuggest(harness, null, VALID_BODY)).status, 401);
      assert.equal((await postSuggest(harness, ada, '{ not json')).status, 400);
      assert.equal(
        (
          await postSuggest(harness, grace, {
            ...VALID_BODY,
            documentId: 'demo-private-notes',
          })
        ).status,
        404,
      );
    }
    assert.equal(provider.calls.length, 0);

    // If any refusal had been counted, at least one of these would already be a 429.
    for (let index = 0; index < 20; index += 1) {
      await expectDraft(await postSuggest(harness, ada, VALID_BODY));
    }
    assert.equal(provider.calls.length, 20);
    await assertRateLimited(await postSuggest(harness, ada, VALID_BODY));
  });
});

describe('100 per user per day (through the route)', () => {
  it('admits the hourly maximum for five hours and answers the 101st with a daily 429', async () => {
    const clock = fakeClock();
    const provider = fakeProvider(async () => SAMPLE_DRAFT);
    const harness = await newHarness(provider, {
      aiLimits: new AiLimits({ now: clock.now }),
    });
    const cookie = await bootstrapSession(harness, 'demo-ada');
    const start = clock.now();

    for (let hour = 0; hour < 5; hour += 1) {
      clock.set(start + hour * AI_HOUR_WINDOW_MS);
      for (let index = 0; index < 20; index += 1) {
        await expectDraft(await postSuggest(harness, cookie, VALID_BODY));
      }
    }
    assert.equal(provider.calls.length, 100);

    clock.set(start + 5 * AI_HOUR_WINDOW_MS);
    // The hour window is fresh (count 0); only the day budget can refuse this one.
    await assertRateLimited(await postSuggest(harness, cookie, VALID_BODY), '68400');
    assert.equal(provider.calls.length, 100, 'the daily refusal must not reach the provider');

    // A different user is unaffected by this user's day budget.
    const graceCookie = await bootstrapSession(harness, 'demo-grace');
    await expectDraft(await postSuggest(harness, graceCookie, VALID_BODY));
  });
});

describe('1 concurrent generation per user (through the route)', () => {
  it('refuses a second in-flight request with 429, then admits the next after completion', async () => {
    const providerGate = deferred<void>();
    const started = deferred<void>();
    let calls = 0;
    const provider: ServerAiProvider = {
      async suggest() {
        calls += 1;
        if (calls === 1) started.resolve();
        await providerGate.promise;
        return SAMPLE_DRAFT;
      },
    };
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const first = postSuggest(harness, cookie, VALID_BODY);
    await started.promise;

    // The same user's second request is rejected while the first holds the per-user slot.
    await assertRateLimited(await postSuggest(harness, cookie, VALID_BODY), '1');
    assert.equal(calls, 1, 'the concurrent refusal never reaches the provider');
    assert.equal(harness.aiLimits.activeServerGenerations, 1);

    providerGate.resolve();
    await expectDraft(await first);
    assert.equal(harness.aiLimits.activeServerGenerations, 0, 'completion releases the slot');

    // The slot is reusable immediately.
    await expectDraft(await postSuggest(harness, cookie, VALID_BODY));
    assert.equal(calls, 2);
  });
});

describe('4 concurrent provider requests per server (through the route)', () => {
  it('admits four users, answers the fifth with 429, and admits it once a slot frees', async () => {
    const providerGate = deferred<void>();
    const fourStarted = deferred<void>();
    let calls = 0;
    const provider: ServerAiProvider = {
      async suggest() {
        calls += 1;
        if (calls === 4) fourStarted.resolve();
        await providerGate.promise;
        return SAMPLE_DRAFT;
      },
    };

    // The demo roster has three users; four simultaneous slots need a fifth. Only identity and
    // the read decision are stubbed — the AI route, session guard and budget code are real.
    const harness = await newHarness(provider, { authz: createFiveUserAuthz() });
    const cookies = ['u1', 'u2', 'u3', 'u4', 'u5'].map((userId) => `user=${userId}`);

    const inFlight = cookies.slice(0, 4).map((cookie) => postSuggest(harness, cookie, VALID_BODY));
    await fourStarted.promise;
    assert.equal(calls, 4);
    assert.equal(harness.aiLimits.activeServerGenerations, 4);

    await assertRateLimited(await postSuggest(harness, cookies[4] as string, VALID_BODY), '1');
    assert.equal(calls, 4, 'the fifth user must not reach the provider');

    providerGate.resolve();
    for (const pending of inFlight) await expectDraft(await pending);
    assert.equal(harness.aiLimits.activeServerGenerations, 0, 'all four slots are released');

    await expectDraft(await postSuggest(harness, cookies[4] as string, VALID_BODY));
    assert.equal(calls, 5);
  });
});

describe('no slot or count leak on provider failure', () => {
  it('releases the slot after 502 and 504 so the user can retry immediately', async () => {
    let calls = 0;
    const provider: ServerAiProvider = {
      async suggest() {
        calls += 1;
        if (calls === 1) {
          throw new ServerAiProviderError('provider', 'upstream HTTP 500');
        }
        if (calls === 2) {
          throw new ServerAiProviderError('timeout', 'deadline exceeded');
        }
        return SAMPLE_DRAFT;
      },
    };
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');

    const first = await postSuggest(harness, cookie, VALID_BODY);
    assert.equal(first.status, 502);
    assert.deepEqual(await first.json(), { error: 'provider_error' });
    assert.equal(harness.aiLimits.activeServerGenerations, 0);

    const second = await postSuggest(harness, cookie, VALID_BODY);
    assert.equal(second.status, 504);
    assert.deepEqual(await second.json(), { error: 'provider_timeout' });
    assert.equal(harness.aiLimits.activeServerGenerations, 0);

    // The slot is free, and the two failures were counted (they cost tokens), not reset.
    await expectDraft(await postSuggest(harness, cookie, VALID_BODY));
    assert.equal(calls, 3);
  });

  it('counts failed generations against 20/h: twenty 502s exhaust the hour budget', async () => {
    const clock = fakeClock();
    const provider = fakeProvider(() => {
      throw new ServerAiProviderError('provider', 'upstream HTTP 500');
    });
    const harness = await newHarness(provider, {
      aiLimits: new AiLimits({ now: clock.now }),
    });
    const cookie = await bootstrapSession(harness, 'demo-ada');

    // Sequential failures must not deadlock on a leaked slot; every one reaches the provider.
    for (let index = 0; index < 20; index += 1) {
      const response = await postSuggest(harness, cookie, VALID_BODY);
      assert.equal(response.status, 502);
      await response.text();
    }
    assert.equal(provider.calls.length, 20);
    assert.equal(harness.aiLimits.activeServerGenerations, 0, 'no slot leaked after 20 failures');

    await assertRateLimited(
      await postSuggest(harness, cookie, VALID_BODY),
      String(AI_HOUR_WINDOW_MS / 1_000),
    );
    assert.equal(provider.calls.length, 20);
  });

  it('releases the slot when the client aborts mid-generation', async () => {
    const started = deferred<void>();
    let calls = 0;
    const provider: ServerAiProvider = {
      async suggest(_input, signal) {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new ServerAiProviderError('timeout', 'client went away')),
              { once: true },
            );
          });
        }
        return SAMPLE_DRAFT;
      },
    };
    const harness = await newHarness(provider);
    const cookie = await bootstrapSession(harness, 'demo-ada');
    const controller = new AbortController();

    const pending = harness
      .request('/api/ai/suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(VALID_BODY),
        signal: controller.signal,
      })
      .catch(() => undefined);
    await started.promise;
    assert.equal(harness.aiLimits.activeServerGenerations, 1);

    controller.abort();
    await pending;
    await waitFor(
      () => harness.aiLimits.activeServerGenerations === 0,
      'the aborted generation to release its slot',
    );

    // The aborted request still counted (tokens were spent); a fresh one is admitted.
    await expectDraft(await postSuggest(harness, cookie, VALID_BODY));
    assert.equal(calls, 2);
  });
});

/* ------------------------------------------------------------------ *
 * A five-user identity stub — the demo roster is frozen at three
 * ------------------------------------------------------------------ */

const STUB_DOCUMENT: DocumentMeta = {
  id: 'demo-document',
  title: 'Demo document',
  revision: 0,
  ownerId: 'demo-ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Identity from a `user=<id>` cookie, every document readable.
 *
 * Only the server-concurrency test uses this. The point of that test is the **server-wide**
 * slot count, which the three-identity demo roster cannot exercise; the alternative would be
 * reaching into another agent's membership store, which the authz public surface forbids.
 */
function createFiveUserAuthz(): AuthzService {
  return {
    cookieName: 'insighthub_session',
    membershipCount: 0,
    resolveSession(cookieHeader) {
      const userId = /(?:^|;\s*)user=([^;]+)/.exec(cookieHeader ?? '')?.[1];
      if (userId === undefined) return null;
      return { userId, displayName: userId, expiresAt: '2099-01-01T00:00:00.000Z' };
    },
    bootstrap() {
      return { kind: 'invalid_demo_identity' };
    },
    destroySession() {
      return false;
    },
    roleFor() {
      return 'viewer';
    },
    can() {
      return true;
    },
    async authorizeDocument(documentId, userId) {
      if (userId === '') return { kind: 'unauthenticated' };
      return {
        kind: 'granted',
        document: { ...STUB_DOCUMENT, id: documentId },
        role: 'viewer',
        userId,
      };
    },
    async listReadableDocuments(userId) {
      return { kind: 'listed', userId, documents: [STUB_DOCUMENT] };
    },
    close() {
      // No store was opened.
    },
  };
}
