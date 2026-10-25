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
 * ## AI budget (M4 B5, `docs/DECISIONS.md` D-082 D3)
 *
 * The application owns exactly one `AiLimits` instance (`ai/limits.ts`): 20 requests/user/hour,
 * 100/user/day, 1 concurrent generation/user, 4 concurrent provider requests/server. It is
 * per-app, not a module singleton, so two apps in one process cannot share counters; the
 * optional fifth `createApp` parameter is the clock/limits injection seam for tests.
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
 *
 * ## Same-origin deployment and readiness (M4 B7, D-082 D2)
 *
 * Production serves the React build from this same process (`static-hosting.ts`): `/api/**`,
 * `/health`, `/ready` and the WebSocket keep their frozen answers, everything else is a file from
 * the build, and only a browser navigation (`Accept: text/html`) falls back to `index.html`. The
 * `GET /ready` probe is added here; `/health` remains liveness. `trust proxy` is enabled **only**
 * in production, where Render terminates TLS and the `Secure` cookie attribute depends on it.
 * Both behaviours are configured through {@link AppOptions}, which (unlike {@link ServerConfig})
 * carries process facts — the already-validated build and the readiness predicate.
 */
import { randomUUID } from 'node:crypto';

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { PROTOCOL_VERSION, type DocumentCapability } from '@insighthub/shared';

import { AiLimits } from './ai/limits.js';
import { createServerAiProviderFromEnv, type ServerAiProvider } from './ai/provider.js';
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
import {
  bindRequestDocument,
  bindRequestUser,
  requestLogging,
  requestLogger,
} from './logging/http.js';
import { createLogger, type Logger } from './logging/logger.js';
import {
  DEFAULT_NEW_DOCUMENT_TITLE,
  DOCUMENT_TITLE_MAX_LENGTH,
  type DocumentCreationStore,
} from './persistence/document-creation.js';
import { createOriginGuard } from './security/origin.js';
import { FixedWindowRateLimiter } from './security/rate-limit.js';
import { mountStaticHosting, type StaticAssets } from './static-hosting.js';

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
   * B12.5's refusal for `POST /api/documents`: unknown body field, a title of the wrong type,
   * or a title outside 1..200 after trimming. One body for every malformed request so the
   * endpoint cannot be probed for which field the server "would have accepted".
   */
  invalidRequest: { error: 'invalid_request' },
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
  /**
   * `GET /ready` (M4 B7): the process is serving and — in production — the web build is mounted.
   * A body of its own rather than reusing `{ status: "ok" }`: liveness (`/health`) and readiness
   * answer different questions, and one probe body for both would let a deployment forget which
   * one is wired to which URL.
   */
  ready: { status: 'ready' },
  /** `GET /ready` before the process is ready: the standard 503 "try again" answer. */
  starting: { status: 'starting' },
} as const;

/**
 * The seam for the two M4 B7 concerns that are **not** in `ServerConfig`.
 *
 * Both are process facts rather than configuration, and both must be injectable so a test can
 * build the production shape without a real checkout:
 *
 * - `staticAssets` is the already-validated web build (`static-hosting.ts`). Its presence also
 *   decides the default readiness of a production app. `index.ts` performs the check and passes
 *   the result; a hand-built app that omits it simply serves the API only, which is the pre-B7
 *   behaviour every existing test harness relies on.
 * - `isReady` overrides the readiness predicate. Production readiness is "the process is up and
 *   the static build is mounted", which is true by construction once `listen` has happened —
 *   the injection point exists so a test can prove the 503 transition without a second process.
 */
export interface AppOptions {
  /** The verified web-client build to serve on the same origin, or `null`/absent for none. */
  readonly staticAssets?: StaticAssets | null;
  /** Readiness predicate; defaults to "true outside production, and in production only with a web build". */
  readonly isReady?: () => boolean;
  /**
   * The structured logger (M4 B9). Defaults to a process logger whose level comes from
   * `LOG_LEVEL`, so a production process logs requests without extra wiring; tests inject a
   * capturing sink here and assert on what was — and was not — emitted.
   */
  readonly logger?: Logger;
  /**
   * Non-secret AI configuration for /api/meta (M4 B12). Proves from outside which provider and
   * model a deployment is actually running, without exposing a key.
   */
  readonly ai?: { readonly provider: string; readonly model?: string };
  /**
   * B12.5 creation seam (D-084 method C). `app.ts` owns the HTTP contract; the store owns the
   * atomic three-row insert. Absent when the app is built without a durable store (the AI
   * invariants harness deliberately has none), in which case the endpoint is not mounted at all
   * — a route that could only answer 500 is worse than an honest 404 for an unknown path.
   */
  readonly documentCreation?: DocumentCreationStore | null;
}

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
 * an explicit provider is used as-is, and an explicit `null` is "not configured". No configured
 * provider — unset/`disabled`, or a selected provider without its own key — yields `null`, i.e.
 * a runtime `503 ai_provider_not_configured`; it must not crash startup, because fail-fast
 * configuration is the production gate's decision (`docs/DECISIONS.md` D-080 §3, D-085 §1).
 * `index.ts` constructs the provider explicitly only so it can log whether AI is enabled.
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
/**
 * The environment-selected provider, or `null` when nothing is configured.
 *
 * Extracted so the default parameter stays one readable call: the factory returns the M4 B12
 * selection wrapper, and `createApp` only ever consumes the provider itself.
 */
function providerFromEnvironment(): ServerAiProvider | null {
  return createServerAiProviderFromEnv(process.env)?.provider ?? null;
}

export function createApp(
  config: ServerConfig,
  authz: AuthzService,
  aiProvider: ServerAiProvider | null = providerFromEnvironment(),
  identity: IdentityOptions = {},
  aiLimits: AiLimits = new AiLimits({
    // The frozen D-082 D3 numbers are the defaults; the suite raises the budgets through the
    // same configuration so it can exercise the route without being the thing that hits 429.
    ...(config.aiRateLimitPerHour === undefined ? {} : { perHour: config.aiRateLimitPerHour }),
    ...(config.aiRateLimitPerDay === undefined ? {} : { perDay: config.aiRateLimitPerDay }),
    ...(config.aiMaxConcurrentPerUser === undefined
      ? {}
      : { perUserConcurrent: config.aiMaxConcurrentPerUser }),
    ...(config.aiMaxConcurrentServer === undefined
      ? {}
      : { perServerConcurrent: config.aiMaxConcurrentServer }),
  }),
  options: AppOptions = {},
): Express {
  if (config.corsOrigin.trim() === '*') {
    // Fail closed and loudly: `*` plus `credentials: true` is a configuration the browser
    // rejects, and "fix it by dropping credentials" would silently turn cookies off.
    throw new Error('CORS_ORIGIN must be an explicit origin: "*" is not allowed with credentials');
  }

  // Resolved once, not per request: the mode and the injected verifier are process-wide, and
  // constructing this at every request would let a caller observe a different mode mid-flight.
  const identityDeps = createIdentityDeps(config.authMode ?? 'demo', authz, identity);
  const demoBootstrapEnabled = identityDeps.mode === 'demo' && config.nodeEnv !== 'production';

  const app = express();

  app.disable('x-powered-by');

  /*
   * Structured request logging (M4 B9, D-082 §5) is the **first** middleware: a request refused
   * by the origin guard, a body parser or a route must still produce its one `http.request` line,
   * with the same `requestId` the handlers used. The middleware only reads method/path/status and
   * the duration; it never touches the body, a cookie or an Authorization header.
   *
   * The default is a real process logger (level from `LOG_LEVEL`) so a hand-built app is never
   * silently unlogged; tests inject `options.logger` with a capturing sink.
   */
  const logger = options.logger ?? createLogger();
  app.use(requestLogging(logger));

  // Render terminates TLS in front of the process (D-082 D2), so exactly one proxy hop must be
  // trusted for `req.secure` — and therefore the `Secure` cookie attribute — to mean "the client
  // spoke https". Only in production: in development the client connects directly, and trusting
  // a caller-supplied `X-Forwarded-*` header would let a client decide whether its session cookie
  // is marked Secure or which address the bootstrap limiter counts. The B4 limiter keeps using
  // `req.ip` and production never mounts the demo bootstrap route (§18.5), so this does not
  // widen an unauthenticated surface.
  if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }

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
    // The limit is configuration (`BOOTSTRAP_RATE_LIMIT_PER_MINUTE`, default 10): one suite run
    // opens far more pages than a human ever would, and the limiter behaviour itself is what the
    // tests pin. A hard-coded value would force the suite to bypass the guard it is meant to prove.
    limit: config.bootstrapRateLimitPerMinute ?? BOOTSTRAP_RATE_LIMIT,
    windowMs: BOOTSTRAP_RATE_WINDOW_MS,
  });

  /** Liveness probe. Must return 200 for the M0 acceptance criteria. */
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  /**
   * Readiness probe (M4 B7). Distinct from `/health` on purpose: a Render health check must keep
   * a live process from being restarted while it is still starting, whereas `/ready` may answer
   * `503` until every dependency the process owns is open. The entrypoint only calls `listen`
   * after the config gate, the store, authz and (in production) the web build have succeeded, so
   * by the time this route can be reached the work is done — the predicate is injectable so the
   * 503 branch is a tested state rather than an unreachable one.
   */
  const staticReady = options.staticAssets !== undefined && options.staticAssets !== null;
  const isReady = options.isReady ?? (() => config.nodeEnv !== 'production' || staticReady);
  app.get('/ready', (_req: Request, res: Response) => {
    if (isReady()) {
      res.status(200).json(RESPONSE_BODIES.ready);
      return;
    }
    res.status(503).json(RESPONSE_BODIES.starting);
  });

  /** Tiny discovery endpoint so a browser can find the WS URL without guessing. */
  app.get('/api/meta', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'insighthub-server',
      wsPath: config.wsPath,
      protocolVersion: PROTOCOL_VERSION,
      // Which build is serving: the diagnostics below are only trustworthy if this matches the
      // commit that introduced them. Render sets RENDER_GIT_COMMIT; absent elsewhere.
      ...(config.commit === undefined ? {} : { commit: config.commit }),
      ...(options.ai === undefined ? {} : { ai: options.ai }),
    });
  });

  mountAuthorizationRoutes(
    app,
    authz,
    identityDeps,
    demoBootstrapEnabled,
    bootstrapLimiter,
    options.documentCreation ?? null,
  );
  mountAiRoutes(app, authz, aiProvider, identityDeps, aiLimits);

  // Same-origin hosting of the built web client (M4 B7, D-082 D2). Mounted after every API
  // route so `/api/**` is never served a file or the SPA shell; the fallback excludes the API,
  // socket and probe prefixes for the same reason (see `static-hosting.ts`).
  if (options.staticAssets !== undefined && options.staticAssets !== null) {
    mountStaticHosting(app, options.staticAssets, {
      production: config.nodeEnv === 'production',
    });
  }

  /* ---------------------------------------------------------------- *
   * Fallbacks
   * ---------------------------------------------------------------- */

  // Unknown paths keep the M0 shape (§12): `404 { error: "not_found" }`.
  app.use((_req: Request, res: Response) => {
    res.status(404).json(RESPONSE_BODIES.notFound);
  });

  // Last, and four-argument so Express recognises it as an error handler. Never a stack, a path
  // or a SQL fragment on the wire (§7). The detail goes to the **structured** log only as a
  // class name plus the frozen `internal_error` code (M4 B9): an exception message can carry the
  // user's document text or a SQL fragment, so it is deliberately not the log's payload.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    requestLogger(res).error('http.error', {
      errorCode: 'internal_error',
      errorClass: error instanceof Error ? error.name : typeof error,
    });
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
  documentCreation: DocumentCreationStore | null,
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
    // M4 B9: the request log now carries the internal user id (`docs/CONTRACTS.md` §18.1), so
    // request ↔ session correlation is a field lookup rather than a timestamp guess.
    bindRequestUser(res, user.userId);
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
    bindRequestUser(res, user.userId);
    // The same decision core as before; only the identity's origin changed (§18.1).
    const decision = await authz.listReadableDocuments(user.userId);
    if (decision.kind === 'unauthenticated') {
      res.status(401).json(unauthorizedBody(identityDeps.mode));
      return;
    }
    res.status(200).json({ documents: decision.documents });
  });

  /**
   * B12.5 self-service creation (D-084 method C).
   *
   * Order is the contract:
   *
   * ```text
   * identity (401) → strict body (400) → one atomic insert (201)
   * ```
   *
   * Identity comes first so an unauthenticated caller cannot make the server parse a body, and
   * so the only 401 body this endpoint ever emits is `session_required` (D-084 acceptance #1;
   * the UI that calls it runs under Clerk, where that is also the mode's normal body).
   *
   * The id and the owner are **server facts**: `randomUUID()` for the id, the resolved internal
   * user id for the owner. The body schema accepts exactly one optional `title`; `documentId`,
   * `ownerId` and `role` are unknown fields and therefore `400`, not silently ignored.
   *
   * The success body contains only the two values the client needs to switch to the new
   * document. No owner, revision, timestamp or capability is returned: the client's role comes
   * from the existing `join-room.role` path, not from this response.
   */
  if (documentCreation !== null) {
    app.post('/api/documents', async (req: Request, res: Response) => {
      const user = await resolveAuthenticatedUser({ cookie: req.headers.cookie }, identityDeps);
      if (user === null) {
        // D-084 acceptance #1 names this body explicitly for creation.
        res.status(401).json(RESPONSE_BODIES.sessionRequired);
        return;
      }
      bindRequestUser(res, user.userId);

      let rawBody: unknown;
      try {
        rawBody = await readCreateDocumentBody(req, res);
      } catch {
        // A body the parser could not read is the endpoint's own 400: there is no other code
        // for "malformed request" in the frozen vocabulary.
        res.status(400).json(RESPONSE_BODIES.invalidRequest);
        return;
      }

      const input = parseCreateDocumentInput(rawBody);
      if (input === null) {
        res.status(400).json(RESPONSE_BODIES.invalidRequest);
        return;
      }

      const documentId = randomUUID();
      // One transaction on one connection (D-084 #4): a rejection here has rolled all three rows
      // back; the error handler returns 500 without a half-created document.
      await documentCreation.createDocumentWithOwner({
        documentId,
        title: input.title,
        ownerUserId: user.userId,
      });

      // The document is bound only after the commit: the log records ids that exist.
      bindRequestDocument(res, documentId);
      res.status(201).json({ documentId, title: input.title });
    });
  }

  /**
   * The production document read.
   *
   * Built by `createDocumentAccessHandler` with `canRead` — the same factory the table-driven
   * capability matrix uses with the other three capabilities, so the 403 mapping is exercised
   * through production code rather than through a mock.
   */
  app.get('/api/documents/:id', createDocumentAccessHandler(authz, 'canRead', identityDeps));
}

/** The validated creation request. `title` is already trimmed. */
interface CreateDocumentBody {
  readonly title: string;
}

/**
 * Parse and validate the **entire** `POST /api/documents` body.
 *
 * Returns `null` for every violation, so the route has one `400 invalid_request` branch. The
 * accepted shape is exactly `{}` or `{ "title": string }`; any other key is refused rather than
 * ignored, which is what makes "the client cannot submit an owner/role/id" observable.
 */
function parseCreateDocumentInput(body: unknown): CreateDocumentBody | null {
  // No body at all is a valid request: it creates `Untitled document`.
  if (body === undefined) return { title: DEFAULT_NEW_DOCUMENT_TITLE };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'title')) return null;
  if (keys.length > 1) return null;

  const rawTitle = record['title'];
  if (rawTitle === undefined) return { title: DEFAULT_NEW_DOCUMENT_TITLE };
  if (typeof rawTitle !== 'string') return null;

  const title = rawTitle.trim();
  if (title.length < 1 || title.length > DOCUMENT_TITLE_MAX_LENGTH) return null;
  return { title };
}

/**
 * Read a JSON body **after** authentication.
 *
 * `express.json()` is normally mounted before the handler. Here it is deliberately not: an
 * unauthenticated request must be refused with 401 before the server allocates a parse tree or
 * reads the payload. The middleware is scoped to this route and its failure is the route's 400.
 */
const createDocumentJsonParser = express.json({ limit: '8kb' });

function readCreateDocumentBody(req: Request, res: Response): Promise<unknown> {
  return new Promise((resolve, reject) => {
    createDocumentJsonParser(req, res, (error?: unknown) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve(req.body);
    });
  });
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
    bindRequestUser(res, user.userId);
    // The id is bound even when the decision is `not_found`/`forbidden`: the operator log
    // records what was asked for and what was answered, without exposing either to the client.
    bindRequestDocument(res, documentId);
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
