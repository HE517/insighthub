/**
 * `POST /api/ai/suggest` — the M3 Round 2 server endpoint (`docs/CONTRACTS.md` §11.2, §12).
 *
 * ```text
 * cookie ──► session (§17.2)                              ── 401 session_required
 * body   ──► aiSuggestHttpRequestSchema                   ── 400 invalid_request
 * documentId ──► authz.authorizeDocument(..., 'canRead')  ── 404 not_found (non-disclosure)
 * provider ──► suggest(input, signal)                     ── 503 / 504 / 502
 * draft  ──► aiSuggestionDraftSchema (boundary check)      ── 502 invalid_provider_output
 *        ──► 200 AiSuggestionDraft
 * ```
 *
 * ## The route decides nothing; it maps decisions
 *
 * The same division of labour as `app.ts` (`docs/ARCHITECTURE.md` §8.2): session identity and
 * document access come from `authz/**`, and the provider decides whether a draft exists. This
 * file only turns those answers into the frozen status codes and bodies.
 *
 * ## Non-disclosure is borrowed, not re-implemented
 *
 * §11.2 says an unknown document and "no membership" must behave exactly like §17.4: both are
 * `404 { error: "not_found" }`, byte-identical. That is achieved by calling the **same**
 * `authorizeDocument(..., 'canRead')` the document read endpoint uses, and by sharing the
 * same body object in `RESPONSE_BODIES`-style form. A separate check here ("does this
 * document exist?") would create a second place for the answer to drift.
 *
 * ## Fail closed
 *
 * Every branch either returns `200` with a schema-validated draft or an error body with
 * **only** an `error` field. There is no partial draft, no `operations: []`, no
 * "summary for the failure". The response body on a failure is a fixed object, so a provider
 * message (which could contain request material) can never reach the client.
 *
 * ## Cancellation (R9)
 *
 * The handler owns one `AbortController` per request. When the HTTP response closes (the
 * client went away) the signal aborts, the provider stops its network call, and the handler
 * writes nothing further. A late resolution after the abort is discarded rather than sent
 * to a dead socket.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  aiSuggestHttpRequestSchema,
  aiSuggestionDraftSchema,
  type AiSuggestHttpRequest,
} from '@insighthub/shared';

import type { AuthzService } from '../authz/public.js';
import {
  ServerAiProviderError,
  type ServerAiProvider,
  type ServerAiSuggestInput,
} from './provider.js';

/**
 * The frozen error bodies (§11.2). Declared once so the 404 in particular is the *same
 * object* as the document endpoint's non-disclosure answer, not a second literal that has to
 * be kept in sync.
 */
export const AI_RESPONSE_BODIES = {
  sessionRequired: { error: 'session_required' },
  invalidRequest: { error: 'invalid_request' },
  notFound: { error: 'not_found' },
  forbidden: { error: 'forbidden' },
  providerNotConfigured: { error: 'ai_provider_not_configured' },
  providerTimeout: { error: 'provider_timeout' },
  providerError: { error: 'provider_error' },
  invalidProviderOutput: { error: 'invalid_provider_output' },
} as const;

/** Mount the AI route. `provider` is `null` when no credential/configuration exists. */
export function mountAiRoutes(
  app: Express,
  authz: AuthzService,
  provider: ServerAiProvider | null,
): void {
  // The session guard runs **before** body parsing so "no session + malformed body" is the
  // contract's `401`, not a parser `400`. §11.2 lists the session check first, and a caller
  // without a session must not learn anything about body handling.
  app.post(
    '/api/ai/suggest',
    requireSession(authz),
    parseSuggestBody,
    createSuggestHandler(authz, provider),
  );
}

/** Resolve the session from the cookie only (§17.2: the cookie is the only carrier). */
function requireSession(authz: AuthzService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (authz.resolveSession(req.headers.cookie) === null) {
      res.status(401).json(AI_RESPONSE_BODIES.sessionRequired);
      return;
    }
    next();
  };
}

/**
 * Route-scoped JSON parser.
 *
 * The request carries up to `200_000` UTF-16 code units of document content, so Express's
 * 100 kb default would reject the contract's own maximum. The limit is the transport bound,
 * not the contract: `aiSuggestHttpRequestSchema` still enforces the real cap, and a body that
 * trips either one is `400 invalid_request` — never a stack trace and never a provider call.
 */
const parseSuggestBody: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  express.json({ limit: '2mb' })(req, res, (error?: unknown) => {
    if (error !== undefined && error !== null) {
      res.status(400).json(AI_RESPONSE_BODIES.invalidRequest);
      return;
    }
    next();
  });
};

function createSuggestHandler(
  authz: AuthzService,
  provider: ServerAiProvider | null,
): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = aiSuggestHttpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(AI_RESPONSE_BODIES.invalidRequest);
      return;
    }
    const request = parsed.data;

    // The one authorization decision. `authorizeDocument` is the same function the read
    // endpoint uses, so `not_found` here means the same thing and produces the same bytes
    // (§17.4 / §11.2).
    const decision = await authz.authorizeDocument(
      request.documentId,
      req.headers.cookie,
      'canRead',
    );
    switch (decision.kind) {
      case 'unauthenticated':
        // The guard above normally catches this; a session that expired between the two
        // checks must still be a 401, never a provider call.
        res.status(401).json(AI_RESPONSE_BODIES.sessionRequired);
        return;
      case 'not_found':
        res.status(404).json(AI_RESPONSE_BODIES.notFound);
        return;
      case 'forbidden':
        // Unreachable by construction: canRead is the only requirement, so a caller who
        // lacks it left through `not_found` above. Kept explicit (and mapped to the §17.4
        // 403) rather than falling through to a silent 200 if the capability ladder changes.
        res.status(403).json(AI_RESPONSE_BODIES.forbidden);
        return;
      case 'granted':
        break;
    }

    if (provider === null) {
      // Missing configuration is a normal runtime state this round, not a startup failure.
      res.status(503).json(AI_RESPONSE_BODIES.providerNotConfigured);
      return;
    }

    const controller = new AbortController();
    const abortOnClose = (): void => controller.abort();
    res.once('close', abortOnClose);
    try {
      const draft = await provider.suggest(toProviderInput(request), controller.signal);

      // Boundary validation: the seam promises a schema-valid draft, but this is the last
      // place before the shape crosses to the client, so a broken/fake provider must not be
      // able to emit something a client cannot parse.
      const validated = aiSuggestionDraftSchema.safeParse(draft);
      if (!validated.success) {
        sendFailure(res, 502, AI_RESPONSE_BODIES.invalidProviderOutput);
        return;
      }

      // A late answer for a client that already hung up is discarded, not written.
      if (controller.signal.aborted || res.writableEnded || res.socket?.destroyed === true) {
        return;
      }
      res.status(200).json(validated.data);
    } catch (error) {
      respondToProviderFailure(res, error);
    } finally {
      res.off('close', abortOnClose);
    }
  };
}

/** Copy only the fields the seam accepts; `documentId`/`baseRevision` are not sent upstream. */
function toProviderInput(request: AiSuggestHttpRequest): ServerAiSuggestInput {
  return {
    instruction: request.instruction,
    content: request.content,
    ...(request.selection === undefined ? {} : { selection: request.selection }),
  };
}

/**
 * Map a provider failure to §11.2.
 *
 * The provider's `message` is intentionally ignored: only `kind` is read. An unknown throw is
 * treated as `provider_error` — a bug in a provider must still fail closed, never fall
 * through to a 200 or to Express's error handler (which would be a `500`).
 */
function respondToProviderFailure(res: Response, error: unknown): void {
  if (error instanceof ServerAiProviderError) {
    switch (error.kind) {
      case 'not-configured':
        sendFailure(res, 503, AI_RESPONSE_BODIES.providerNotConfigured);
        return;
      case 'timeout':
        sendFailure(res, 504, AI_RESPONSE_BODIES.providerTimeout);
        return;
      case 'provider':
        sendFailure(res, 502, AI_RESPONSE_BODIES.providerError);
        return;
      case 'invalid-output':
        sendFailure(res, 502, AI_RESPONSE_BODIES.invalidProviderOutput);
        return;
      default: {
        // Exhaustiveness guard: a new kind must fail the typecheck instead of silently
        // becoming a 200.
        const never: never = error.kind;
        throw new Error(`unhandled AI provider error kind: ${String(never)}`);
      }
    }
  }

  sendFailure(res, 502, AI_RESPONSE_BODIES.providerError);
}

/** Write one fixed error body, unless the response can no longer carry it. */
function sendFailure(res: Response, status: number, body: { error: string }): void {
  if (res.headersSent || res.writableEnded || res.socket?.destroyed === true) return;
  res.status(status).json(body);
}
