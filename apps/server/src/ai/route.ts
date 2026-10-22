/**
 * `POST /api/ai/suggest` — the M3 Round 2 server endpoint (`docs/CONTRACTS.md` §11.2, §12).
 *
 * ```text
 * cookie ──► resolveAuthenticatedUser (§18)               ── 401 session_required
 * body   ──► aiSuggestHttpRequestSchema                   ── 400 invalid_request
 * documentId ──► authz.authorizeDocument(userId, 'canRead') ── 404 not_found (non-disclosure)
 * budget ──► aiLimits.acquire(userId)                      ── 429 rate_limited (+ Retry-After)
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
 *
 * ## Budget enforcement (M4 B5, `docs/DECISIONS.md` D-082 D3)
 *
 * Every decision that can refuse a request (session, body, read access) runs **before** the
 * budget, so a request that would be a 401/400/404 never consumes a user's hourly or daily
 * allotment. After `granted`, and before the provider is touched, the handler calls
 * `aiLimits.acquire(userId)`:
 *
 * - denied → `429 {"error":"rate_limited"}` plus `Retry-After` (whole seconds), and the
 *   provider is **not** called. Concurrency exhaustion is the same 429, never a 503: the
 *   caller is allowed to use the endpoint, just not right now;
 * - allowed → the generation is counted immediately and one server slot is reserved.
 *
 * The reservation is released in `finally`, so a provider throw, an `invalid-output` answer,
 * a timeout, or a client abort all return the slot. The *count* is deliberately not released:
 * the provider was called and tokens were spent, so failed generations still count against
 * 20/h and 100/d. Limiter refusals cost nothing and are not counted.
 *
 * `429` is the only status this module adds, which keeps a budget refusal distinguishable from
 * every provider failure (`502`/`503`/`504`) on the wire.
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

import type { AuthzService, AuthenticatedUser, IdentityDeps } from '../authz/public.js';
import { resolveAuthenticatedUser } from '../authz/public.js';
import {
  bindRequestDocument,
  bindRequestUser,
  getRequestId,
  requestLogger,
} from '../logging/http.js';
import { readConfiguredAiModel } from '../logging/startup.js';
import type { AiLimits } from './limits.js';
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
  /**
   * The M4 B5 budget refusal (§11.2). Its own status (429) and its own body, so a caller can
   * tell "come back later" apart from "the provider failed"; `Retry-After` says when.
   */
  rateLimited: { error: 'rate_limited' },
} as const;

/** Mount the AI route. `provider` is `null` when no credential/configuration exists. */
export function mountAiRoutes(
  app: Express,
  authz: AuthzService,
  provider: ServerAiProvider | null,
  identityDeps: IdentityDeps,
  limits: AiLimits,
): void {
  // The session guard runs **before** body parsing so "no session + malformed body" is the
  // contract's `401`, not a parser `400`. §11.2 lists the session check first, and a caller
  // without a session must not learn anything about body handling.
  app.post(
    '/api/ai/suggest',
    requireSession(identityDeps),
    parseSuggestBody,
    createSuggestHandler(authz, provider, limits),
  );
}

/** Where the guard leaves the resolved identity for the handler. */
const AUTHENTICATED_USER_LOCAL = 'insighthub.authenticatedUser';

/**
 * Resolve the identity from the cookie only (§17.2/§18: the cookie is the only carrier).
 *
 * The body is the AI endpoint's existing `session_required` in both modes — it predates the
 * Clerk seam and §11.2 already names that code, so demo behaviour does not change here.
 */
function requireSession(identityDeps: IdentityDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = await resolveAuthenticatedUser({ cookie: req.headers.cookie }, identityDeps);
    if (user === null) {
      res.status(401).json(AI_RESPONSE_BODIES.sessionRequired);
      return;
    }
    // M4 B9: the internal user id joins the request's log context here, so both this route's
    // `ai.suggest` event and the final `http.request` line carry it.
    bindRequestUser(res, user.userId);
    res.locals[AUTHENTICATED_USER_LOCAL] = user;
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

/**
 * The closed outcome vocabulary of `ai.suggest` (M4 B9).
 *
 * Every terminal state of the route maps to exactly one of these, so an operator can count
 * "requests that produced a draft" against "requests the provider failed" without parsing prose.
 * A client abort is deliberately **not** an outcome: the caller left, no answer was delivered,
 * and the `http.request` line's status already tells that story.
 */
type AiSuggestOutcome =
  | 'ok'
  | 'refused'
  | 'rate_limited'
  | 'provider_error'
  | 'timeout'
  | 'invalid_output';

/** Severity for one AI outcome: a refusal is normal, a provider failure is an error. */
function outcomeLevel(outcome: AiSuggestOutcome): 'info' | 'warn' | 'error' {
  switch (outcome) {
    case 'ok':
    case 'refused':
      return 'info';
    case 'rate_limited':
    case 'timeout':
    case 'invalid_output':
      return 'warn';
    case 'provider_error':
      return 'error';
  }
}

function createSuggestHandler(
  authz: AuthzService,
  provider: ServerAiProvider | null,
  limits: AiLimits,
): RequestHandler {
  // Configuration, not request material: the model the adapter would use. It is safe to log and
  // is what makes "which model produced this outcome?" answerable after a deployment.
  const model = readConfiguredAiModel(process.env);

  return async (req: Request, res: Response): Promise<void> => {
    const user = res.locals[AUTHENTICATED_USER_LOCAL] as AuthenticatedUser | undefined;
    const log = requestLogger(res);
    const requestId = getRequestId(res);
    if (user === undefined) {
      // Unreachable while `requireSession` is mounted first; kept so a future re-ordering fails
      // closed instead of authorizing an anonymous request.
      log.warn('ai.suggest', {
        ...(requestId === undefined ? {} : { requestId }),
        model,
        outcome: 'refused',
      });
      res.status(401).json(AI_RESPONSE_BODIES.sessionRequired);
      return;
    }

    /**
     * One `ai.suggest` line per terminal state.
     *
     * Only correlation identifiers, the model and the outcome are emitted. The instruction, the
     * document content, the selection text and the proposal are **never** arguments to this
     * function (M4 B9): the operator needs to know that a suggestion was refused or produced,
     * not what the user was writing.
     */
    const record = (
      outcome: AiSuggestOutcome,
      documentId?: string,
      producedBy?: string,
    ): void => {
      log.log(outcomeLevel(outcome), 'ai.suggest', {
        ...(requestId === undefined ? {} : { requestId }),
        userId: user.userId,
        ...(documentId === undefined ? {} : { documentId }),
        // The draft names the model that actually produced it (the stub reports `stub`); for a
        // refusal there is no draft, so the configured model is the only truthful answer.
        model: producedBy ?? model,
        outcome,
      });
    };

    const parsed = aiSuggestHttpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      record('refused');
      res.status(400).json(AI_RESPONSE_BODIES.invalidRequest);
      return;
    }
    const request = parsed.data;
    // Correlates the route event and the final `http.request` line with the document, without
    // publishing it to the client on a refusal.
    bindRequestDocument(res, request.documentId);

    // The one authorization decision. `authorizeDocument` is the same function the read
    // endpoint uses, so `not_found` here means the same thing and produces the same bytes
    // (§17.4 / §11.2). The identity is the **internal** user id resolved above (§18.1).
    const decision = await authz.authorizeDocument(request.documentId, user.userId, 'canRead');
    switch (decision.kind) {
      case 'unauthenticated':
        // The guard above normally catches this; a session that expired between the two
        // checks must still be a 401, never a provider call.
        record('refused', request.documentId);
        res.status(401).json(AI_RESPONSE_BODIES.sessionRequired);
        return;
      case 'not_found':
        record('refused', request.documentId);
        res.status(404).json(AI_RESPONSE_BODIES.notFound);
        return;
      case 'forbidden':
        // Unreachable by construction: canRead is the only requirement, so a caller who
        // lacks it left through `not_found` above. Kept explicit (and mapped to the §17.4
        // 403) rather than falling through to a silent 200 if the capability ladder changes.
        record('refused', request.documentId);
        res.status(403).json(AI_RESPONSE_BODIES.forbidden);
        return;
      case 'granted':
        break;
    }

    if (provider === null) {
      // Missing configuration is a normal runtime state this round, not a startup failure.
      // Checked before the budget: a request that cannot reach a provider must not consume
      // the caller's hourly/daily allowance.
      record('provider_error', request.documentId);
      res.status(503).json(AI_RESPONSE_BODIES.providerNotConfigured);
      return;
    }

    // Check-and-reserve in one synchronous call, after every refusal branch above and before
    // the provider. `acquire` never awaits, so two concurrent requests cannot both observe a
    // free slot. A denial writes the frozen 429 + Retry-After and stops here: no provider
    // call, no abort controller, no counter.
    const budget = limits.acquire(user.userId);
    if (!budget.allowed) {
      record('rate_limited', request.documentId);
      res.setHeader('Retry-After', String(budget.retryAfterSeconds));
      res.status(429).json(AI_RESPONSE_BODIES.rateLimited);
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
        record('invalid_output', request.documentId);
        sendFailure(res, 502, AI_RESPONSE_BODIES.invalidProviderOutput);
        return;
      }

      // A late answer for a client that already hung up is discarded, not written. No
      // `ai.suggest` line either: there is no delivered outcome to report.
      if (controller.signal.aborted || res.writableEnded || res.socket?.destroyed === true) {
        return;
      }
      record('ok', request.documentId, validated.data.model);
      res.status(200).json(validated.data);
    } catch (error) {
      const outcome = respondToProviderFailure(res, error);
      // A client that went away mid-generation is not a provider failure; the abort signal is
      // the only reliable way to tell the two apart here.
      if (!controller.signal.aborted) record(outcome, request.documentId);
    } finally {
      res.off('close', abortOnClose);
      // Every path — success, typed provider failure, invalid output, timeout, abort, or an
      // unexpected throw — gives the server slot back. The hour/day counts are deliberately
      // not restored: the provider was invoked and its cost is already spent (D-082 D3).
      limits.release(user.userId);
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
 * Map a provider failure to §11.2, and report the `ai.suggest` outcome it represents.
 *
 * The provider's `message` is intentionally ignored: only `kind` is read. An unknown throw is
 * treated as `provider_error` — a bug in a provider must still fail closed, never fall
 * through to a 200 or to Express's error handler (which would be a `500`).
 */
function respondToProviderFailure(res: Response, error: unknown): AiSuggestOutcome {
  if (error instanceof ServerAiProviderError) {
    switch (error.kind) {
      case 'not-configured':
        sendFailure(res, 503, AI_RESPONSE_BODIES.providerNotConfigured);
        return 'provider_error';
      case 'timeout':
        sendFailure(res, 504, AI_RESPONSE_BODIES.providerTimeout);
        return 'timeout';
      case 'provider':
        sendFailure(res, 502, AI_RESPONSE_BODIES.providerError);
        return 'provider_error';
      case 'invalid-output':
        sendFailure(res, 502, AI_RESPONSE_BODIES.invalidProviderOutput);
        return 'invalid_output';
      default: {
        // Exhaustiveness guard: a new kind must fail the typecheck instead of silently
        // becoming a 200.
        const never: never = error.kind;
        throw new Error(`unhandled AI provider error kind: ${String(never)}`);
      }
    }
  }

  sendFailure(res, 502, AI_RESPONSE_BODIES.providerError);
  return 'provider_error';
}

/** Write one fixed error body, unless the response can no longer carry it. */
function sendFailure(res: Response, status: number, body: { error: string }): void {
  if (res.headersSent || res.writableEnded || res.socket?.destroyed === true) return;
  res.status(status).json(body);
}
