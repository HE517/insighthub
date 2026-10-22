/**
 * Express HTTP application.
 *
 * ## Division of labour (why there are no `if (role === ...)` here)
 *
 * This file maps **decisions** to HTTP responses. It does not make them. Every authorization
 * question is answered by `apps/server/src/authz/**` (`docs/ARCHITECTURE.md` §8.2), and the
 * mapping is mechanical:
 *
 * | Decision (`authz/**`) | Response |
 * | --- | --- |
 * | `unauthenticated` | `401 { error: "unauthenticated" }` |
 * | `not_found` | `404 { error: "not_found" }` |
 * | `forbidden` | `403 { error: "forbidden" }` |
 * | `granted` | `200` + `DocumentMeta` |
 *
 * That is the whole of the §17.4 status table. Keeping the non-disclosure rule in one branch in
 * `authz.ts` — instead of three `if`s here — is what makes "the three 404s are byte-identical" a
 * structural property rather than a promise.
 *
 * ## M2 Phase 2 surface
 *
 * `POST /api/session/bootstrap`, `GET /api/session`, `DELETE /api/session`, `GET /api/documents`,
 * `GET /api/documents/:id` (`docs/CONTRACTS.md` §12 + §17.4). `GET /health` and `GET /api/meta`
 * are unchanged from M0.
 *
 * ## M3 Round 2 surface
 *
 * `POST /api/ai/suggest` (`docs/CONTRACTS.md` §11.2) is mounted by `mountAiRoutes` with the
 * injected provider. The route owns no authorization logic and no provider construction; both
 * are passed in, which is what makes the failure matrix testable without a real model.
 *
 * ## CORS and CSRF (M4 B4)
 *
 * The API is served on a different port than the Vite dev server, so the browser needs
 * `credentials: true` and an **explicit** origin — `Access-Control-Allow-Origin: *` is illegal
 * together with credentials, and would also mean "any site may call the API with the user's
 * cookie". A `*` configuration is therefore refused at construction rather than quietly weakened.
 *
 * `security/origin.ts` owns the allow-list, the preflight answer and the `403 origin_not_allowed`
 * refusal for state-changing requests. It runs before any route, so a request from a foreign
 * origin is refused before its body is parsed and before identity is resolved.
 *
 * ## Bootstrap rate limit (M4 B4)
 *
 * `POST /api/session/bootstrap` mints a session for a caller-supplied demo identity, so it is the
 * one endpoint where guessing is cheap. It is limited per client address to
 * {@link BOOTSTRAP_RATE_LIMIT} requests per {@link BOOTSTRAP_RATE_WINDOW_MS}, in process, with a
 * bounded bucket map (`security/rate-limit.ts`). The route only exists in development/test
 * (§18.5), so this protects the fixture rather than a production surface.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { PROTOCOL_VERSION, type DocumentCapability } from '@insighthub/shared';

import { createServerAiProviderFromEnv } from './ai/openai.js';
import { type ServerAiProvider } from './ai/provider.js';
import { mountAiRoutes } from './ai/route.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createIdentityDeps,
  resolveAuthenticatedUser,
  type AuthzService,
  type AuthenticatedUser,
  type DocumentAccessDecision,
  type IdentityDeps,
  type IdentityOptions,
} from './authz/public.js';
import { type AuthMode, type ServerConfig } from './config.js';
import { createOriginGuard } from './security/origin.js';
import { FixedWindowRateLimiter } from './security/rate-limit.js';

/**
 * Bootstrap limit: requests per client address per window (M4 B4). Fixed-window, in process —
 * V1 is a single instance (D-082 D2), so a shared store would be infrastructure the deployment
 * does not have.
 */
export const BOOTSTRAP_RATE_LIMIT = 10;

/** Bootstrap rate-limit window: one minute, matching the requirement's "10 次/分钟". */
export const BOOTSTRAP_RATE_WINDOW_MS = 60_000;

/**
 * The frozen response bodies.
 *
 * Declared once, and reused for every call site, so "the same body" is not a coincidence of two
 * template literals agreeing. `not_found` in particular must be identical for an unknown
 * document, a caller with no membership and a caller without `canRead` (§17.4).
 */
const RESPONSE_BODIES = {
  unauthenticated: { error: 'unauthenticated' },
  /**
   * §18.3's body for an unverified Clerk session. The demo path keeps `unauthenticated`
   * (§17.4), so existing clients and the M2 tests are unchanged; the mode decides the body
   * because the two contracts name the same refusal differently.
   */
  sessionRequired: { error: 'session_required' },
  notFound: { error: 'not_found' },
  forbidden: { error: 'forbidden' },
  invalidDemoIdentity: { error: 'invalid_demo_identity' },
  /**
   * §B4's refusal for a cross-origin state-changing request (and for a preflight from a
   * non-allowed origin). One body for both, so a caller cannot use the response to probe
   * whether the endpoint exists before the origin decision.
   */
  originNotAllowed: { error: 'origin_not_allowed' },
  /**
   * §B4's refusal when the per-address bootstrap window is exhausted. Distinct from a 401/403:
   * the caller is allowed to use the endpoint, just not this often.
   */
  rateLimited: { error: 'rate_limited' },
  /**
   * HTTP counterpart of `WS_ERROR_CODES.INTERNAL_ERROR`.
   *
   * §12 lists no 500 shape. This body exists for one reason: without an error handler Express's
   * default responds with a **stack trace** in development, and §7 forbids sending a stack, a
   * path or a SQL fragment to a client. Nothing here is a contract addition a client should
   * branch on; recorded in the task report as a documentation gap for A0.
   */
  internalError: { error: 'internal_error' },
} as const;

/** The only body a bootstrap request may carry (§17.3/§17.4). */
interface BootstrapBody {
  readonly demoUserId?: unknown;
}

/**
 * Build the Express application.
 *
 * ## Why `authz` is optional, and why that cannot widen access
 *
 * ## Why `authz` is required
 *
 * It was optional in A5's branch for exactly one reason: making it required would have forced an
 * edit in `rooms/test-harness.ts`, which is A3-owned. That reason expired at integration. An
 * optional parameter means a production wiring mistake silently unmounts every session and
 * document route, so the server answers `404` for everything — a failure that reads like a data
 * problem for hours. A required parameter turns the same mistake into a compile error.
 *
 * Absence is therefore no longer representable. `rooms/test-harness.ts` constructs a real
 * `createAuthz` (A0 integration exception, `docs/DECISIONS.md` D-062 §2).
 *
 * ## Why `aiProvider` is a nullable, injectable third parameter
 *
 * `POST /api/ai/suggest` needs a provider, and tests need to drive that route without a
 * network (`docs/CONTRACTS.md` §11.2 "Test determinism"). The parameter is therefore an
 * **injection seam**: `undefined` (the default) builds the provider from the environment,
 * an explicit provider is used as-is, and an explicit `null` is "not configured". A missing
 * `OPENAI_API_KEY` yields `null`, i.e. a runtime `503 ai_provider_not_configured`; it must
 * not crash startup, because fail-fast configuration is M4 D3's decision
 * (`docs/DECISIONS.md` D-080 §3). `index.ts` constructs the provider explicitly only so it
 * can log whether AI is enabled.
 *
 * ## M4 B1 — `identity` is the injected Clerk seam
 *
 * The fourth parameter carries the `SessionVerifier` and `AppUserStore`. It is absent in
 * demo mode (every existing caller), and required by `createIdentityDeps` when
 * `config.authMode === 'clerk'` — a clerk app built without them throws at construction
 * rather than answering `401` to everything and looking like a sign-in problem.
 *
 * The demo bootstrap route is mounted only when `AUTH_MODE=demo` **and**
 * `NODE_ENV !== 'production'` (§18.5). When it is not mounted there is no route at all, so
 * the request falls through to the M0 `404 not_found` — the same answer as any unknown path,
 * which is what keeps "this endpoint used to exist" from being observable.
 */
export function createApp(
  config: ServerConfig,
  authz: AuthzService,
  aiProvider: ServerAiProvider | null = createServerAiProviderFromEnv(process.env),
  identity: IdentityOptions = {},
): Express {
  if (config.corsOrigin.trim() === '*') {
    // Fail closed and loudly: `*` plus `credentials: true` is a configuration the browser
    // rejects, and "fix it by dropping credentials" would silently turn cookies off.
    throw new Error('CORS_ORIGIN must be an explicit origin: "*" is not allowed with credentials');
  }

  // Resolved once, not per request: the mode and the injected verifier are process-wide, and
  // constructing this at every request would let a caller observe a different mode mid-flight.
  const identityDeps = createIdentityDeps(config.authMode ?? 'demo', authz, identity);
  const demoBootstrapEnabled =
    identityDeps.mode === 'demo' && config.nodeEnv !== 'production';

  const app = express();

  app.disable('x-powered-by');
  // Before every route: the CORS headers a browser needs, the preflight answer, and the CSRF
  // refusal for state-changing requests from a foreign origin (`security/origin.ts`).
  app.use(createOriginGuard(config.corsOrigin));

  /**
   * One limiter per application, not per process.
   *
   * A module-level singleton would make two servers in one process (every A3 harness, and the
   * restart scenarios) share buckets, so a test suite could exhaust another test's window. The
   * limiter belongs to the app instance, exactly like the routes it protects.
   */
  const bootstrapLimiter = new FixedWindowRateLimiter({
    limit: BOOTSTRAP_RATE_LIMIT,
    windowMs: BOOTSTRAP_RATE_WINDOW_MS,
  });

  /** Liveness probe. Must return 200 for the M0 acceptance criteria. */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  /** Tiny discovery endpoint so a browser can find the WS URL without guessing. */
  app.get('/api/meta', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'insighthub-server',
      wsPath: config.wsPath,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  mountAuthorizationRoutes(app, authz, identityDeps, demoBootstrapEnabled, bootstrapLimiter);
  mountAiRoutes(app, authz, aiProvider, identityDeps);

  /* ---------------------------------------------------------------- *
   * Fallbacks
   * ---------------------------------------------------------------- */

  // Unknown paths keep the M0 shape (§12): `404 { error: "not_found" }`.
  app.use((_req: Request, res: Response) => {
    res.status(404).json(RESPONSE_BODIES.notFound);
  });

  // Last, and four-argument so Express recognises it as an error handler. Never a stack, a path
  // or a SQL fragment on the wire (§7); the detail goes to the server log only.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error(
      '[http] unhandled request failure:',
      error instanceof Error ? error.message : String(error),
    );
    res.status(500).json(RESPONSE_BODIES.internalError);
  });

  return app;
}

/** Session + document endpoints (§12, §17.4, §18). */
function mountAuthorizationRoutes(
  app: Express,
  authz: AuthzService,
  identityDeps: IdentityDeps,
  demoBootstrapEnabled: boolean,
  bootstrapLimiter: FixedWindowRateLimiter,
): void {
  /* ---------------------------------------------------------------- *
   * Session (§17.2, §17.4, §18)
   * ---------------------------------------------------------------- */

  // §18.5: the demo fixture exists only outside production. When the gate is closed the route
  // is **not mounted at all**, so this path falls through to the unknown-path 404 — identical
  // to any other absent path, with no body or header that reveals it once existed.
  if (demoBootstrapEnabled) {
    app.post(
      '/api/session/bootstrap',
      // Rate limit before parsing: a caller over its window must not be able to make the server
      // read a body. The origin guard already ran, so a CSRF refusal never consumes quota.
      bootstrapRateLimit(bootstrapLimiter),
      parseBootstrapBody,
      (req: Request, res: Response) => {
        const demoUserId = readDemoUserId(req.body);
        const outcome = authz.bootstrap(demoUserId, req.headers.cookie);

        if (outcome.kind === 'invalid_demo_identity') {
          res.status(400).json(RESPONSE_BODIES.invalidDemoIdentity);
          return;
        }

        // The token exists only in this header. It is never put in the body: P2-9 requires that
        // no JS-reachable place can read it, and a body would be readable by `fetch`.
        res.cookie(SESSION_COOKIE_NAME, outcome.token, sessionCookieOptions(req));
        res.status(200).json(outcome.session);
      },
    );
  }

  app.get('/api/session', async (req: Request, res: Response) => {
    const user = await resolveAuthenticatedUser({ cookie: req.headers.cookie }, identityDeps);
    if (user === null) {
      res.status(401).json(unauthorizedBody(identityDeps.mode));
      return;
    }
    res.status(200).json(sessionBody(user));
  });

  app.delete('/api/session', async (req: Request, res: Response) => {
    if (identityDeps.mode === 'clerk') {
      // Clerk owns the authentication session (§18.2): there is nothing of ours to revoke.
      // What this route does in clerk mode is **clear our own stale demo cookie**, which is not
      // a privileged operation — the cookie is the caller's. It must therefore answer `204`
      // even when no Clerk session is present: the client calls it right after `signOut()`, and
      // a `401` there would leave the demo cookie behind forever (A2's B2 finding). Sign-out
      // itself is the Clerk client call, not this route.
      res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(req));
      res.status(204).end();
      return;
    }

    const destroyed = authz.destroySession(req.headers.cookie);
    if (!destroyed) {
      // A destroyed or expired token is `401` everywhere (§17.2) — including here, where a
      // second DELETE must not look like a success.
      res.status(401).json(RESPONSE_BODIES.unauthenticated);
      return;
    }
    res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions(req));
    res.status(204).end();
  });

  /* ---------------------------------------------------------------- *
   * Documents (§17.4)
   * ---------------------------------------------------------------- */

  app.get('/api/documents', async (req: Request, res: Response) => {
    const user = await resolveAuthenticatedUser({ cookie: req.headers.cookie }, identityDeps);
    if (user === null) {
      res.status(401).json(unauthorizedBody(identityDeps.mode));
      return;
    }
    // The same decision core as before; only the identity's origin changed (§18.1).
    const decision = await authz.listReadableDocuments(user.userId);
    if (decision.kind === 'unauthenticated') {
      res.status(401).json(unauthorizedBody(identityDeps.mode));
      return;
    }
    res.status(200).json({ documents: decision.documents });
  });

  /**
   * The production document read.
   *
   * Built by `createDocumentAccessHandler` with `canRead` — the same factory the table-driven
   * capability matrix uses with the other three capabilities, so the 403 mapping is exercised
   * through production code rather than through a mock.
   */
  app.get(
    '/api/documents/:id',
    createDocumentAccessHandler(authz, 'canRead', identityDeps),
  );
}

/**
 * Handle `GET /api/documents/:id` for one required capability.
 *
 * Exported because the capability matrix needs the **production** mapper for capabilities no
 * production route requires yet: Phase 2 has no endpoint that needs more than `canRead`
 * (`docs/TASKS.md` P2-6 is a decision-core property, and §17.3 forbids inventing a member
 * management endpoint to make a 403 observable). Mounting this factory with `canEdit` or
 * `canManageMembers` therefore proves the refusal path without inventing a product surface.
 *
 * `identityDeps` is required (not defaulted) so a caller cannot accidentally mount the
 * production handler with demo-only identity resolution after the mode changed.
 */
export function createDocumentAccessHandler(
  authz: AuthzService,
  capability: DocumentCapability,
  identityDeps: IdentityDeps,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const user = await resolveAuthenticatedUser({ cookie: req.headers.cookie }, identityDeps);
    if (user === null) {
      res.status(401).json(unauthorizedBody(identityDeps.mode));
      return;
    }
    const documentId = readDocumentIdParameter(req.params);
    const decision = await authz.authorizeDocument(documentId, user.userId, capability);
    respondToDocumentAccess(res, decision);
  };
}

/** The 401 body for one mode: §18.3's `session_required` vs §17.4's `unauthenticated`. */
function unauthorizedBody(mode: AuthMode): { error: string } {
  return mode === 'clerk' ? RESPONSE_BODIES.sessionRequired : RESPONSE_BODIES.unauthenticated;
}

/**
 * The body `GET /api/session` returns for one resolved identity.
 *
 * Demo sessions keep exactly the three §17.4 fields (`expiresAt` included). A Clerk identity
 * has no server-tracked expiry (§18.2), so the field is omitted rather than invented — the
 * alternative would be a local session lifetime masquerading as Clerk's.
 */
function sessionBody(user: AuthenticatedUser): Record<string, string> {
  const body: Record<string, string> = {
    userId: user.userId,
    displayName: user.displayName,
  };
  if (user.expiresAt !== undefined) body['expiresAt'] = user.expiresAt;
  return body;
}

/** Map one authorization decision to the frozen response (§17.4). */
export function respondToDocumentAccess(res: Response, decision: DocumentAccessDecision): void {
  switch (decision.kind) {
    case 'unauthenticated':
      res.status(401).json(RESPONSE_BODIES.unauthenticated);
      return;
    case 'not_found':
      res.status(404).json(RESPONSE_BODIES.notFound);
      return;
    case 'forbidden':
      res.status(403).json(RESPONSE_BODIES.forbidden);
      return;
    case 'granted':
      res.status(200).json(decision.document);
      return;
    default: {
      // Exhaustiveness guard: adding a decision kind without a response must fail the typecheck,
      // not fall through to a silent 200.
      const never: never = decision;
      throw new Error(`unhandled document access decision: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Parse a bootstrap body, scoped to this route.
 *
 * A malformed body never reaches the handler: it is answered with the endpoint's own `400`
 * (§17.4 has exactly one 400 for bootstrap), because a body Express could not parse cannot carry
 * a roster identity. The parser is mounted here rather than globally so no other route can
 * produce a body-parse failure the contract has no code for.
 */
const parseBootstrapBody: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  express.json({ limit: '16kb' })(req, res, (error?: unknown) => {
    if (error !== undefined && error !== null) {
      res.status(400).json(RESPONSE_BODIES.invalidDemoIdentity);
      return;
    }
    next();
  });
};

/**
 * Per-client-address limiter for `POST /api/session/bootstrap` (M4 B4).
 *
 * ## Why the socket address, not `X-Forwarded-For`
 *
 * A forwarded header is caller-controlled unless a trusted proxy sets it, so honouring it here
 * would let one client rotate a fake address per request and never be limited. `req.ip` is the
 * Express resolution, which uses the socket address while `trust proxy` is off — the deliberate
 * default in this app (see `sessionCookieOptions`). The route exists only in development/test
 * (§18.5), where clients connect directly, so the socket address is the client address. A future
 * deployment behind a TLS proxy would need `trust proxy` configured before **any** address-based
 * limiter is meaningful; that is recorded as a handoff item, not assumed here.
 *
 * ## Why the key is normalised
 *
 * Node reports IPv4 clients on a dual-stack listener as `::ffff:127.0.0.1`. Stripping that
 * prefix keeps one client in one bucket regardless of which stack accepted the connection.
 */
function rateLimitKey(req: Request): string {
  const address = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * Answer `429 rate_limited` once the per-address window is exhausted.
 *
 * `Retry-After` is the standard signal for "when may I try again"; the body stays the frozen
 * `{"error":"rate_limited"}` so a client never has to parse a message. The limiter is consulted
 * before the body is parsed, so a denied caller cannot make the server allocate a parse tree.
 */
function bootstrapRateLimit(limiter: FixedWindowRateLimiter): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = limiter.check(rateLimitKey(req));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json(RESPONSE_BODIES.rateLimited);
      return;
    }
    next();
  };
}

/**
 * Read `demoUserId` out of an untrusted body.
 *
 * Only `demoUserId` is read. A body carrying `userId` (or any other identity field) is therefore
 * *ignored* — it becomes "no valid demo identity" and yields `400` — which is P2-2 at the only
 * place a client is allowed to name an identity at all.
 */
function readDemoUserId(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return (body as BootstrapBody).demoUserId;
}

/** `req.params.id`, without trusting that Express gave us a string. */
function readDocumentIdParameter(params: unknown): string {
  if (typeof params !== 'object' || params === null) return '';
  const value = (params as Record<string, unknown>)['id'];
  return typeof value === 'string' ? value : '';
}

/**
 * Cookie attributes frozen by §17.2: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the
 * request arrived over TLS, and a lifetime that matches the server-side expiry exactly.
 *
 * `secure: req.secure` is deliberately literal — "served over TLS" means this request, not a
 * header a client could set. Behind a TLS-terminating proxy Express must be told
 * (`trust proxy`) before `req.secure` is meaningful; guessing from `X-Forwarded-Proto` here
 * would let any client decide whether a cookie is flagged `Secure`.
 */
function sessionCookieOptions(req: Request): {
  httpOnly: boolean;
  sameSite: 'lax';
  path: string;
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
  };
}
