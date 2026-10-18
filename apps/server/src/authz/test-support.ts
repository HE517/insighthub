/**
 * Test support for the authorization suites.
 *
 * Everything the tests need is built the way production builds it: a **real** `authz` on a real
 * temporary `authz.db`, a **real** Express app from `createApp`, and a **real** HTTP server on an
 * ephemeral port. No route handler, decision or cookie path is stubbed, so a test that passes
 * here has exercised the code the server actually runs.
 *
 * Not a `*.test.ts` file, so the test runner does not execute it — same convention as
 * `apps/server/src/rooms/test-harness.ts` and `apps/server/src/persistence/test-stores.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../app.js';
import { type ServerConfig } from '../config.js';
import { createAuthz, type AuthzService } from './authz.js';
import type { DocumentCatalog } from './documents.js';

/** CORS origin used by every harness. An explicit origin, never `*` (§17.4). */
export const TEST_CORS_ORIGIN = 'http://localhost:5173';

export interface HarnessOptions {
  /** Injected clock, for the 12 h expiry without sleeping. */
  readonly now?: () => number;
  /** Replacement document catalog, for the "membership without metadata" case. */
  readonly documents?: DocumentCatalog;
  /** Override the data directory (to reopen a previous one and simulate a restart). */
  readonly dataPath?: string;
}

export interface Harness {
  readonly baseUrl: string;
  readonly authz: AuthzService;
  readonly dataPath: string;
  readonly config: ServerConfig;
  /** `fetch` against the harness server. A `cookie` header can be supplied directly. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Close the HTTP server, the authz subsystem and (when this harness created it) the temporary
   * data directory. Reopening a shared directory sets `ownsDataPath: false`.
   */
  close(): Promise<void>;
}

/** Boot a full HTTP + authz stack on a temporary data directory. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const ownsDataPath = options.dataPath === undefined;
  const dataPath = options.dataPath ?? (await mkdtemp(join(tmpdir(), 'insighthub-authz-')));

  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    corsOrigin: TEST_CORS_ORIGIN,
    wsPath: '/ws',
    dataPath,
  };

  const authz = await createAuthz({
    dataPath,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.documents === undefined ? {} : { documents: options.documents }),
  });

  const server: Server = createServer(createApp(config, authz));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    authz,
    dataPath,
    config,
    request: (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`${baseUrl}${path}`, init),
    close: async (): Promise<void> => {
      // Stop accepting new requests before releasing the membership table, so a failing test can
      // never surface as "closed store" noise from an in-flight request.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      authz.close();
      if (ownsDataPath) await rm(dataPath, { recursive: true, force: true });
    },
  };
}

/** Every `Set-Cookie` header value on a response. */
export function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = response.headers.get('set-cookie');
  return combined === null ? [] : [combined];
}

/** The `name=value` pair of a `Set-Cookie` header, ready to be sent back as a `Cookie`. */
export function cookiePair(setCookie: string): string {
  const separator = setCookie.indexOf(';');
  return (separator === -1 ? setCookie : setCookie.slice(0, separator)).trim();
}

export interface BootstrappedSession {
  /** `insighthub_session=…`, to put in a `Cookie` header. */
  readonly cookie: string;
  readonly userId: string;
  readonly displayName: string;
  readonly expiresAt: string;
  /** The raw token, extracted from the Set-Cookie header (never from a body). */
  readonly token: string;
}

/**
 * Bootstrap one demo identity and return everything a test needs to act as that identity.
 *
 * The token is read out of the `Set-Cookie` **header**: if it ever appeared in the body this
 * helper would still find it in the header, so a test that "the body has no token" cannot pass by
 * accident.
 */
export async function bootstrap(
  harness: Harness,
  demoUserId: string,
): Promise<BootstrappedSession> {
  const response = await harness.request('/api/session/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ demoUserId }),
  });
  if (response.status !== 200) {
    throw new Error(`bootstrap for ${demoUserId} failed with HTTP ${response.status}`);
  }
  const cookies = setCookies(response);
  if (cookies.length === 0) throw new Error(`bootstrap for ${demoUserId} set no cookie`);
  const pair = cookiePair(cookies[0] as string);
  const body = (await response.json()) as {
    userId: string;
    displayName: string;
    expiresAt: string;
  };
  return {
    cookie: pair,
    userId: body.userId,
    displayName: body.displayName,
    expiresAt: body.expiresAt,
    token: pair.slice(pair.indexOf('=') + 1),
  };
}

/** `GET path` with an optional session cookie. */
export function getWithSession(
  harness: Harness,
  path: string,
  cookie: string | null,
  headers: Record<string, string> = {},
): Promise<Response> {
  return harness.request(path, {
    headers: cookie === null ? headers : { ...headers, cookie },
  });
}

/**
 * The response headers as a comparable record, minus `date`.
 *
 * `date` is a clock reading: two identical responses a second apart legitimately differ in it, so
 * including it would make "the three 404s are identical" untestable rather than strict. Every
 * other header — status-adjacent ones included — must match, which is what §17.4 asks for.
 */
export function comparableHeaders(response: Response): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'date') continue;
    record[name.toLowerCase()] = value;
  }
  return record;
}
