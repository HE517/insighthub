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
 * ## CORS
 *
 * The API is served on a different port than the Vite dev server, so the browser needs
 * `credentials: true` and an **explicit** origin — `Access-Control-Allow-Origin: *` is illegal
 * together with credentials, and would also mean "any site may call the API with the user's
 * cookie". A `*` configuration is therefore refused at startup rather than quietly weakened.
 */
import cors from 'cors';
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
  type AuthzService,
  type DocumentAccessDecision,
} from './authz/public.js';
import { type ServerConfig } from './config.js';

/**
 * The frozen response bodies.
 *
 * Declared once, and reused for every call site, so "the same body" is not a coincidence of two
 * template literals agreeing. `not_found` in particular must be identical for an unknown
 * document, a caller with no membership and a caller without `canRead` (§17.4).
 */
const RESPONSE_BODIES = {
  unauthenticated: { error: 'unauthenticated' },
  notFound: { error: 'not_found' },
  forbidden: { error: 'forbidden' },
  invalidDemoIdentity: { error: 'invalid_demo_identity' },
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
 */
export function createApp(
  config: ServerConfig,
  authz: AuthzService,
  aiProvider: ServerAiProvider | null = createServerAiProviderFromEnv(process.env),
): Express {
  if (config.corsOrigin.trim() === '*') {
    // Fail closed and loudly: `*` plus `credentials: true` is a configuration the browser
    // rejects, and "fix it by dropping credentials" would silently turn cookies off.
    throw new Error('CORS_ORIGIN must be an explicit origin: "*" is not allowed with credentials');
  }

  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin, credentials: true }));

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

  mountAuthorizationRoutes(app, authz);
  mountAiRoutes(app, authz, aiProvider);

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

/** Session + document endpoints (§12, §17.4). Mounted only when an authorization seam exists. */
function mountAuthorizationRoutes(app: Express, authz: AuthzService): void {
  /* ---------------------------------------------------------------- *
   * Session (§17.2, §17.4)
   * ---------------------------------------------------------------- */

  app.post(
    '/api/session/bootstrap',
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

  app.get('/api/session', (req: Request, res: Response) => {
    const session = authz.resolveSession(req.headers.cookie);
    if (session === null) {
      res.status(401).json(RESPONSE_BODIES.unauthenticated);
      return;
    }
    res.status(200).json(session);
  });

  app.delete('/api/session', (req: Request, res: Response) => {
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
    const decision = await authz.listReadableDocuments(req.headers.cookie);
    if (decision.kind === 'unauthenticated') {
      res.status(401).json(RESPONSE_BODIES.unauthenticated);
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
  app.get('/api/documents/:id', createDocumentAccessHandler(authz, 'canRead'));
}

/**
 * Handle `GET /api/documents/:id` for one required capability.
 *
 * Exported because the capability matrix needs the **production** mapper for capabilities no
 * production route requires yet: Phase 2 has no endpoint that needs more than `canRead`
 * (`docs/TASKS.md` P2-6 is a decision-core property, and §17.3 forbids inventing a member
 * management endpoint to make a 403 observable). Mounting this factory with `canEdit` or
 * `canManageMembers` therefore proves the refusal path without inventing a product surface.
 */
export function createDocumentAccessHandler(
  authz: AuthzService,
  capability: DocumentCapability,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const documentId = readDocumentIdParameter(req.params);
    const decision = await authz.authorizeDocument(documentId, req.headers.cookie, capability);
    respondToDocumentAccess(res, decision);
  };
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
