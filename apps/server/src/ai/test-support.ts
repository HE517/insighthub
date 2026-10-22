/**
 * Test support for the AI endpoint suites.
 *
 * Built the way production builds it: a real `authz` on a temporary `authz.db`, a real Express
 * app from `createApp`, and a real HTTP server on an ephemeral port. The only injected
 * component is the **provider**, which is exactly the seam `createApp` exposes — so the route,
 * the session guard, the authorization call and the response mapping all run unchanged.
 *
 * Not a `*.test.ts` file, so the server's test runner does not execute it (same convention as
 * `apps/server/src/authz/test-support.ts` and `apps/server/src/rooms/test-harness.ts`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app.js';
import { createAuthz, type AuthzService } from '../authz/public.js';
import { type ServerConfig } from '../config.js';
import type { ServerAiProvider } from './provider.js';

export const TEST_CORS_ORIGIN = 'http://localhost:5173';

export interface AiTestHarness {
  readonly baseUrl: string;
  readonly authz: AuthzService;
  readonly request: (path: string, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
}

/**
 * Boot a full HTTP + authz stack with one injected provider.
 *
 * `null` means "not configured" — the exact state the 503 test needs. Every test passes an
 * explicit provider (or `null`), so no test can accidentally pick up a developer's
 * `OPENAI_API_KEY` from the environment.
 */
export async function startAiHarness(aiProvider: ServerAiProvider | null): Promise<AiTestHarness> {
  const dataPath = await mkdtemp(join(tmpdir(), 'insighthub-ai-'));

  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    corsOrigin: TEST_CORS_ORIGIN,
    wsPath: '/ws',
    dataPath,
  };

  const authz = await createAuthz({ dataPath });
  const server: Server = createServer(createApp(config, authz, aiProvider));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    authz,
    request: (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${baseUrl}${path}`, init),
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      authz.close();
      await rm(dataPath, { recursive: true, force: true });
    },
  };
}

/** Bootstrap one demo identity and return the `Cookie` header value (never a body token). */
export async function bootstrapSession(
  harness: AiTestHarness,
  demoUserId: string,
): Promise<string> {
  const response = await harness.request('/api/session/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ demoUserId }),
  });
  if (response.status !== 200) {
    throw new Error(`bootstrap for ${demoUserId} failed with HTTP ${response.status}`);
  }
  const setCookie = response.headers.getSetCookie()[0];
  if (setCookie === undefined) throw new Error(`bootstrap for ${demoUserId} set no cookie`);
  const separator = setCookie.indexOf(';');
  return separator === -1 ? setCookie : setCookie.slice(0, separator);
}

/** POST one body to the endpoint. A string body is sent verbatim (for malformed-JSON cases). */
export function postSuggest(
  harness: AiTestHarness,
  cookie: string | null,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== null) headers['cookie'] = cookie;
  return harness.request('/api/ai/suggest', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * Response headers as a comparable record, minus `date`.
 *
 * Same helper and same reasoning as `authz/test-support.ts`: two byte-identical 404s a second
 * apart legitimately differ in `date`, and including it would make "the non-disclosure 404s are
 * identical" untestable rather than strict.
 */
export function comparableHeaders(response: Response): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'date') continue;
    record[name.toLowerCase()] = value;
  }
  return record;
}
