/**
 * **M4 B2** — the real Clerk session verifier (`docs/CONTRACTS.md` §18.1–§18.4, §18.6;
 * `docs/DECISIONS.md` D-082).
 *
 * Layer: **Node only, no network**. The SDK call (`authenticateRequest`) is injected, so the
 * suite exercises the production adapter — request construction, state normalisation, claim
 * reading, fail-closed behaviour and credential hygiene — without a Clerk account. The one
 * test that touches the real `@clerk/backend` package only **constructs** the client; it never
 * issues a network request, and it asserts the factory's startup contract (empty key throws).
 *
 * What is deliberately *not* proven here: a real Clerk instance accepting a real session
 * cookie. That is a staging smoke (B2/A6), not a deterministic unit test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createClerkSessionVerifier,
  type ClerkAuthenticateRequest,
  type ClerkRequestState,
} from './clerk-session-verifier.js';

const COOKIE = '__session=opaque-session-token-value';

/** A signed-in `RequestState`, shaped like the SDK's (only the fields the adapter reads). */
function signedIn(
  auth: { userId?: string | null; sessionClaims?: unknown } = { userId: 'user_clerk_ada' },
): ClerkRequestState {
  return {
    isAuthenticated: true,
    toAuth: () => auth,
  };
}

/** The SDK's signed-out shape: no user, but a `toAuth` that still answers. */
function signedOut(): ClerkRequestState {
  return {
    isAuthenticated: false,
    toAuth: () => ({ userId: null }),
  };
}

/** Build a verifier around a recording fake, returning both halves. */
function recordingVerifier(
  answer: ClerkRequestState | null | (() => Promise<never>) = signedIn(),
): {
  verifier: ReturnType<typeof createClerkSessionVerifier>;
  requests: Request[];
} {
  const requests: Request[] = [];
  const authenticateRequest: ClerkAuthenticateRequest = async (request) => {
    requests.push(request);
    if (typeof answer === 'function') return await answer();
    return answer;
  };
  return {
    verifier: createClerkSessionVerifier({
      secretKey: 'sk_test_not_a_real_key',
      authenticateRequest,
    }),
    requests,
  };
}

/* ------------------------------------------------------------------ *
 * A verified session becomes the frozen VerifiedIdentity
 * ------------------------------------------------------------------ */

describe('createClerkSessionVerifier — verified identity', () => {
  it('returns the Clerk sub and the optional profile claims', async () => {
    const { verifier } = recordingVerifier(
      signedIn({
        userId: 'user_clerk_ada',
        sessionClaims: { email: 'ada@example.com', name: 'Ada Lovelace' },
      }),
    );

    assert.deepEqual(await verifier.verify({ cookie: COOKIE }), {
      clerkUserId: 'user_clerk_ada',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
    });
  });

  it('omits email and displayName when the session token carries no profile', async () => {
    // The default Clerk session token has `sub`/`sid`/`iss` only; §18.1 makes the profile
    // optional, so an absent name must not be an error and must not be invented.
    const { verifier } = recordingVerifier(
      signedIn({ userId: 'user_clerk_ada', sessionClaims: { sub: 'user_clerk_ada' } }),
    );

    assert.deepEqual(await verifier.verify({ cookie: COOKIE }), {
      clerkUserId: 'user_clerk_ada',
    });
  });

  it('ignores non-string and blank profile claims instead of trusting them', async () => {
    const { verifier } = recordingVerifier(
      signedIn({
        userId: 'user_clerk_ada',
        sessionClaims: { email: 42, name: { first: 'Ada' }, full_name: '   ' },
      }),
    );

    assert.deepEqual(await verifier.verify({ cookie: COOKIE }), {
      clerkUserId: 'user_clerk_ada',
    });
  });

  it('trims the sub so a padded identity cannot create a second mapping row', async () => {
    const { verifier } = recordingVerifier(signedIn({ userId: '  user_clerk_ada  ' }));
    assert.deepEqual(await verifier.verify({ cookie: COOKIE }), {
      clerkUserId: 'user_clerk_ada',
    });
  });

  it('accepts the deprecated isSignedIn alias when isAuthenticated is absent', async () => {
    const { verifier } = recordingVerifier({
      isAuthenticated: false,
      isSignedIn: true,
      toAuth: () => ({ userId: 'user_legacy' }),
    });
    assert.deepEqual(await verifier.verify({ cookie: COOKIE }), {
      clerkUserId: 'user_legacy',
    });
  });

  it('hands the raw Cookie header to the SDK and consults no other carrier', async () => {
    const { verifier, requests } = recordingVerifier();
    await verifier.verify({ cookie: COOKIE });

    assert.equal(requests.length, 1);
    const request = requests[0] as Request;
    // The exact header the server read reaches Clerk; no Authorization, body or query identity.
    assert.equal(request.headers.get('cookie'), COOKIE);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.method, 'GET');
  });
});

/* ------------------------------------------------------------------ *
 * Every failure is the same answer: null
 * ------------------------------------------------------------------ */

describe('createClerkSessionVerifier — fails closed', () => {
  it('answers null without calling Clerk when there is no cookie', async () => {
    for (const cookie of [undefined, '', '   ']) {
      const { verifier, requests } = recordingVerifier();
      assert.equal(await verifier.verify({ cookie }), null);
      assert.equal(requests.length, 0, `cookie=${JSON.stringify(cookie)} must not reach Clerk`);
    }
  });

  it('answers null for an unauthenticated RequestState', async () => {
    const { verifier } = recordingVerifier(signedOut());
    assert.equal(await verifier.verify({ cookie: COOKIE }), null);
  });

  it('answers null for a nullish state', async () => {
    const explicitNull = recordingVerifier(null);
    assert.equal(await explicitNull.verifier.verify({ cookie: COOKIE }), null);

    // `undefined` is built directly: the recording helper's default parameter is a signed-in
    // state, so passing `undefined` there would mean "use the default" rather than "no answer".
    const explicitUndefined = createClerkSessionVerifier({
      secretKey: 'sk_test_not_a_real_key',
      authenticateRequest: async () => undefined,
    });
    assert.equal(await explicitUndefined.verify({ cookie: COOKIE }), null);
  });

  it('answers null when the auth object is missing or has no user', async () => {
    const states: ClerkRequestState[] = [
      { isAuthenticated: true, toAuth: () => null },
      { isAuthenticated: true, toAuth: () => ({}) },
      { isAuthenticated: true, toAuth: () => ({ userId: '' }) },
      { isAuthenticated: true, toAuth: () => ({ userId: '   ' }) },
      { isAuthenticated: true, toAuth: () => ({ userId: 42 as unknown as string }) },
    ];

    for (const state of states) {
      const { verifier } = recordingVerifier(state);
      assert.equal(await verifier.verify({ cookie: COOKIE }), null);
    }
  });

  it('answers null when the SDK call rejects, and never throws', async () => {
    const { verifier } = recordingVerifier(async () => {
      throw new Error('clerk backend unavailable');
    });
    assert.equal(await verifier.verify({ cookie: COOKIE }), null);
  });

  it('answers null when normalisation itself throws', async () => {
    const { verifier } = recordingVerifier({
      isAuthenticated: true,
      toAuth: () => {
        throw new Error('malformed auth object');
      },
    });
    assert.equal(await verifier.verify({ cookie: COOKIE }), null);
  });

  it('answers null for a malformed cookie without calling Clerk', async () => {
    const { verifier, requests } = recordingVerifier();
    // A header value containing a line break is rejected by `Headers`/`Request`; a hostile
    // cookie must not become a 500 or reach the SDK as a second header.
    for (const cookie of ['__session=abc\r\nX-Injected: 1', '__session=abc\nX-Injected: 1']) {
      assert.equal(await verifier.verify({ cookie }), null);
      assert.equal(requests.length, 0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Credential hygiene (§18.3)
 * ------------------------------------------------------------------ */

describe('createClerkSessionVerifier — no token, cookie or secret is logged', () => {
  it('leaves the console untouched when Clerk rejects a token', async () => {
    const token = 'sk_like-session-token-that-must-never-be-logged';
    const cookie = `__session=${token}`;
    const { verifier } = recordingVerifier(async () => {
      // The realistic worst case: the SDK error message embeds the token it rejected.
      throw new Error(`Invalid session token: ${token}`);
    });

    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = new Map<(typeof methods)[number], (...args: unknown[]) => void>();
    const calls: string[] = [];
    for (const method of methods) {
      originals.set(method, console[method]);
      console[method] = (...args: unknown[]) => {
        calls.push(`${method}: ${args.map((arg) => String(arg)).join(' ')}`);
      };
    }

    try {
      assert.equal(await verifier.verify({ cookie }), null);
      const logged = calls.join('\n');
      assert.equal(calls.length, 0, `the verifier must not log anything: ${logged}`);
      assert.ok(!logged.includes(token), 'a session token reached a log line');
      assert.ok(!logged.includes(cookie), 'a raw cookie reached a log line');
    } finally {
      for (const method of methods) console[method] = originals.get(method) as never;
    }
  });

  it('refuses to construct without a secret key, and does not echo the value', () => {
    for (const secretKey of ['', '   ']) {
      assert.throws(
        () => createClerkSessionVerifier({ secretKey }),
        (error: unknown) =>
          error instanceof Error &&
          /CLERK_SECRET_KEY/.test(error.message) &&
          !error.message.includes('   '),
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * Real SDK construction (no request is made)
 * ------------------------------------------------------------------ */

describe('createClerkSessionVerifier — production SDK wiring', () => {
  it('constructs the real @clerk/backend client from a secret key without a network call', () => {
    // A fake but well-shaped key: `createClerkClient` does not contact Clerk at construction,
    // and `verify` is never called here. The test pins that the factory itself never throws for
    // a configured secret (the startup path) and that the object satisfies `SessionVerifier`.
    const verifier = createClerkSessionVerifier({
      secretKey: 'sk_test_fakefakefakefakefakefakefakefake',
    });
    assert.equal(typeof verifier.verify, 'function');
  });
});
