/**
 * Same-origin static hosting of the built web client (M4 B7, `docs/DECISIONS.md` D-082 D2).
 *
 * The production topology is **one Render Web Service, one Node process, one origin**: Express
 * serves `GET /api/**`, `/health`, `/ready` and the WebSocket upgrade, and the same process also
 * serves the React build. There is no second frontend origin and no CDN in V1, which is what
 * makes the session cookie (`SameSite=Lax`, `HttpOnly`) work without any cross-site exception.
 *
 * Three rules shape this module:
 *
 * 1. **The API prefixes win.** The SPA fallback deliberately excludes `/api`, `/ws`, `/health`
 *    and `/ready`. A client that asks for an unknown API path must keep getting the frozen
 *    `404 {"error":"not_found"}` (§12) — not an HTML page with status 200, which would turn a
 *    typo in an endpoint into an unparseable response.
 * 2. **Only a navigation gets the shell.** The fallback requires `Accept: text/html`, so
 *    `fetch()` (which sends the wildcard `*` media range) still sees a JSON 404. That wildcard
 *    case is the one that matters for programmatic callers and for tests: `req.accepts('html')`
 *    would treat the wildcard as "yes" and swallow every unknown GET.
 * 3. **A production server does not publish its sources.** Vite emits source maps
 *    (`apps/web/vite.config.ts` sets `sourcemap: true`), and a `.map` file next to the bundle
 *    reconstructs the original TypeScript. In production the file server refuses `.map` (and
 *    TypeScript/style sources, should a future build ever copy them), so the request behaves
 *    like any other missing file instead of exposing the client source.
 *
 * ## Why the check is split from the app
 *
 * `resolveStaticAssets` answers "is the build there?" before the process listens, and
 * `index.ts` turns a missing build into `STATIC_DIR_MISSING` (production only). `mountStaticHosting`
 * then serves a directory the caller has already proven exists. Keeping the I/O decision out of
 * `createApp` means a test can build the app around a temporary `dist` without depending on the
 * real one, and the entrypoint — not a middleware — owns the refusal.
 */
import { statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { StartupRefusal } from './startup.js';

/** The stable refusal code (`docs/CONTRACTS.md` §18.6 vocabulary, M4 B7). */
export const STATIC_DIR_REFUSAL_CODE = 'STATIC_DIR_MISSING' as const;

/** A verified web-client build: its directory and the absolute path of its entry document. */
export interface StaticAssets {
  readonly directory: string;
  readonly indexFile: string;
}

/** The outcome of the startup check: usable assets, or a refusal in the B3 `{ code, message }` shape. */
export type StaticAssetsResolution =
  | { readonly kind: 'available'; readonly assets: StaticAssets }
  | { readonly kind: 'missing'; readonly refusal: StartupRefusal };

/**
 * The one sentence every static refusal carries.
 *
 * It names the requirement (a directory containing `index.html`) and the action (build the web
 * app), and it contains **no configured value** — the same rule B3 applies to every refusal, so
 * an operator's path or a malformed value cannot leak into a log line.
 */
const STATIC_REFUSAL_MESSAGE =
  'STATIC_DIR must be a directory containing the built web client index.html; run the web build before starting the server (the path is never printed)';

/**
 * Check that `STATIC_DIR` is a directory containing `index.html`.
 *
 * Synchronous on purpose: the entrypoint calls it once, before `listen`, and a rejected
 * promise would add an error path that no test needs. A missing directory and a directory
 * without `index.html` produce the **same** code: both mean "the web build is not there", and
 * distinguishing them would leak which one an operator got wrong without helping the fix.
 */
export function resolveStaticAssets(directory: string | undefined): StaticAssetsResolution {
  const configured = (directory ?? '').trim();
  if (configured === '') {
    return {
      kind: 'missing',
      refusal: { code: STATIC_DIR_REFUSAL_CODE, message: STATIC_REFUSAL_MESSAGE },
    };
  }

  const resolvedDirectory = resolve(configured);
  const indexFile = join(resolvedDirectory, 'index.html');
  if (!isDirectory(resolvedDirectory) || !isFile(indexFile)) {
    return {
      kind: 'missing',
      refusal: { code: STATIC_DIR_REFUSAL_CODE, message: STATIC_REFUSAL_MESSAGE },
    };
  }

  return { kind: 'available', assets: { directory: resolvedDirectory, indexFile } };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- *
 * Routing rules
 * ---------------------------------------------------------------- */

/**
 * Prefixes that belong to the server, and therefore never to the SPA.
 *
 * Matched as a path segment (`/api` or `/api/...`), not as a raw string prefix, so `/apiary`
 * is still an ordinary navigation path.
 */
const RESERVED_PATH_PREFIXES: readonly string[] = ['/api', '/ws', '/health', '/ready'];

/** True when a request path names a server surface (API, socket or probe) rather than the client. */
export function isReservedPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return RESERVED_PATH_PREFIXES.some(
    (reserved) => path === reserved || path.startsWith(`${reserved}/`),
  );
}

/**
 * True when the caller asked for a document (a browser navigation), rather than data.
 *
 * The check is a substring test on the header, not `req.accepts('html')`: the latter is true for
 * `Accept: * / *`, and a test or a `fetch` call must keep receiving the JSON 404. Header values
 * are case-insensitive, and no other content type is close enough to a navigation to matter.
 */
export function wantsHtml(accept: string | undefined): boolean {
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

/** True for a path the SPA fallback may answer: a GET/HEAD navigation outside the server prefixes. */
export function isSpaNavigationRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (isReservedPath(req.path)) return false;
  return wantsHtml(req.headers.accept);
}

/**
 * Build metadata / source files that must never be published by a production server.
 *
 * Vite's build emits `.js.map`; TypeScript and style sources are here so a future build that
 * copies them cannot start serving them without this list being reviewed. Ordinary assets
 * (`.js`, `.css`, `.html`, images, fonts, `.json`) are untouched.
 */
const SOURCE_ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.map',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.jsx',
  '.scss',
  '.sass',
  '.less',
  '.tsbuildinfo',
]);

/** True when the path names a source/development artefact rather than a shipped asset. */
export function isSourceArtifact(pathname: string): boolean {
  return SOURCE_ARTIFACT_EXTENSIONS.has(extname(pathname).toLowerCase());
}

/* ---------------------------------------------------------------- *
 * Mounting
 * ---------------------------------------------------------------- */

export interface StaticHostingOptions {
  /** `NODE_ENV=production`. Outside production the source-artefact filter is not applied. */
  readonly production: boolean;
}

/**
 * Serve the web build, then the SPA shell for navigations.
 *
 * Must be mounted **after** every API route and immediately before the JSON 404 fallback: the
 * API has already had its chance to answer, a real file is served first, and only a navigation
 * that matched neither reaches `index.html`.
 */
export function mountStaticHosting(
  app: Express,
  assets: StaticAssets,
  options: StaticHostingOptions,
): void {
  const files: RequestHandler = express.static(assets.directory, {
    // The shell is served by the fallback below, never as a directory index: a request for `/`
    // and a request for `/some/route` must produce the same document, and a directory index
    // would also answer `/assets/` with an HTML body where only files belong.
    index: false,
    // `.env`, `.git` and friends inside the build directory are never served. `express.static`
    // treats them as missing, so no response body reveals that they exist.
    dotfiles: 'ignore',
    // A directory request (`/assets`) must not redirect; it falls through to the rules below.
    redirect: false,
    etag: true,
    // Let a miss continue to the API prefixes, the fallback and the JSON 404.
    fallthrough: true,
  });

  app.use((req: Request, res: Response, next: NextFunction): void => {
    // In production a source artefact is treated as missing: skip the file server so the request
    // can only reach the fallback (an HTML shell) or the JSON 404 — never the bytes themselves.
    if (options.production && isSourceArtifact(req.path)) {
      next();
      return;
    }
    files(req, res, next);
  });

  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (!isSpaNavigationRequest(req)) {
      next();
      return;
    }
    res.sendFile(assets.indexFile);
  });
}
