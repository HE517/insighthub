/**
 * Server entrypoint: HTTP + WebSocket on one port, with graceful shutdown.
 *
 * ## M2 startup order is load-bearing (`docs/DECISIONS.md` D-051)
 *
 * ```text
 * loadConfig  →  open the durable store (capability-checked)  →  open authz  →  listen
 * ```
 *
 * The store and the authorization subsystem are opened **before** the server listens, and a
 * failure exits with a diagnostic instead of starting. There is deliberately no branch that
 * continues without storage: a silent memory-only server is exactly the M1 data-loss mode that
 * `M2-P0-1` removes, so "refuse to start" is the correct behaviour rather than a harsh one. The
 * same reasoning applies to authorization (M2 Phase 2): a server that cannot resolve roles would
 * answer `404` for everything, which looks like a data problem for hours.
 *
 * M4 B3 added the production configuration gate as step 1, and M4 B7 adds the static-build check
 * as the last step before `listen` (D-082 D2):
 *
 * ```text
 * config gate  →  store  →  authz  →  static build check  →  listen
 * ```
 *
 * The static check is last on purpose. It is the cheapest failure to fix, but it only matters
 * once the process can actually serve data, and running it after the store has proved itself
 * means the operator's log already says whether the durable layer opened. It is still before
 * `listen`: a deployment whose web build is missing must not answer the Render health check as
 * if it were serving the product.
 *
 * The capability check itself lives in `persistence/sqlite-runtime.ts`, which is also why
 * this file awaits it: a static import of a missing built-in would throw during ESM
 * evaluation, before any diagnostic could be printed.
 *
 * ## M2 Phase 2 seam
 *
 * `createAuthz` is constructed here and handed to **both** layers: `createApp` for the HTTP API
 * and `attachWebSocketServer` for the socket. The wiring is real, not provisional: the WS
 * enforcement points (`ws.ts`, `rooms/**`) consume it through `authz/public.ts`, so the upgrade,
 * the join decision and every BINARY frame get the same answer the HTTP API gets.
 */
import { createServer } from 'node:http';

import { createApp } from './app.js';
import { createServerAiProviderFromEnv, readServerAiProviderKind } from './ai/openai.js';
import {
  createAuthz,
  createClerkSessionVerifier,
  createIdentityDeps,
  isAppUserStore,
  type AuthzService,
  type IdentityOptions,
  type SessionVerifier,
} from './authz/public.js';
import { loadConfig, type AuthMode } from './config.js';
import { isDocumentMetaStore, StoreDocumentCatalog } from './persistence/document-meta.js';
import { startBackupScheduler } from './persistence/backup-scheduler.js';
import { openDocumentStore } from './persistence/open-store.js';
import { isSqliteCapabilityError } from './persistence/sqlite-runtime.js';
import type { DocumentStore } from './persistence/types.js';
import { resolveStaticAssets, type StaticAssets } from './static-hosting.js';
import { findStartupRefusal } from './startup.js';
import { attachWebSocketServer } from './ws.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // M4 B3 configuration gate (`docs/CONTRACTS.md` §18.6, D-082 D2/D3). In production every
  // required setting is checked before anything is opened or a port is bound: demo auth, a
  // clerk mode without its secret, a development CORS origin, a relative/ephemeral data path,
  // the AI stub, and OpenAI with no key are all startup refusals. The gate returns a stable code
  // and a sentence that never contains a value, so a secret cannot reach the log.
  //
  // It is printed here and the process exits with code 1 *before* `listen`. The exit status is
  // set via `process.exitCode` (not `process.exit(1)`) so pending stderr writes are flushed on
  // pipes — the observable contract is the same: no listener, exit code 1.
  const refusal = findStartupRefusal(config, process.env);
  if (refusal !== null) {
    console.error(`[server] refusing to start: ${refusal.code}`);
    console.error(`[server]   ${refusal.message}`);
    process.exitCode = 1;
    return;
  }

  const dataPath = config.dataPath;

  if (dataPath === undefined) {
    // Unreachable through `loadConfig`, and it must not silently degrade if someone
    // changes that later.
    console.error('[server] refusing to start: no INSIGHTHUB_DATA_PATH configured');
    process.exitCode = 1;
    return;
  }

  let store: DocumentStore;
  try {
    const opened = await openDocumentStore(dataPath);
    store = opened.store;
    console.log(`[server] store  ready  ${opened.dataPath} (journal=${opened.journalMode})`);
  } catch (error) {
    // Startup failure with a clear diagnostic. The message names the unmet runtime or
    // filesystem requirement; the hint says what to do. Never a stack trace on the
    // operator's console as the only clue, and never a memory-only fallback.
    if (isSqliteCapabilityError(error)) {
      console.error(`[server] refusing to start: ${error.code}`);
      console.error(`[server]   ${error.message}`);
      console.error(`[server]   hint: ${error.hint}`);
      if (error.cause instanceof Error) {
        console.error(`[server]   cause: ${error.cause.message}`);
      }
    } else {
      console.error('[server] refusing to start: the durable store could not be opened');
      console.error(`[server]   ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
    return;
  }

  let authz: AuthzService;
  try {
    // The document API's metadata comes from the durable store (`persistence/document-meta.ts`)
    // rather than from a fixture: `authz/documents.ts` is an injected seam precisely so the real
    // source can land here without touching `authz/**` (`docs/DECISIONS.md` D-062 §4).
    const documents = isDocumentMetaStore(store) ? new StoreDocumentCatalog(store) : undefined;
    authz = await createAuthz({ dataPath, ...(documents === undefined ? {} : { documents }) });
    console.log(
      `[server] authz  ready  ${authz.membershipCount} membership rows, sessions process-scoped`,
    );
  } catch (error) {
    console.error('[server] refusing to start: authorization could not be initialised');
    console.error(`[server]   ${error instanceof Error ? error.message : String(error)}`);
    await store.close();
    process.exitCode = 1;
    return;
  }

  // M4 B7 (D-082 D2): production serves the React build from this process, so a build that is
  // absent or has no `index.html` is a **startup refusal**, not a runtime 404. It runs after the
  // store and authz are open — the order an operator debugs a failed deploy in — and before
  // `listen`, so a process that cannot serve the product never looks healthy to Render.
  //
  // Outside production a missing build only disables static hosting: the Vite dev server serves
  // the client, and every API test / browser-suite run must keep working without running the web
  // build first. That is why the refusal is production-only rather than the check being skipped.
  let staticAssets: StaticAssets | null = null;
  const staticResolution = resolveStaticAssets(config.staticDir);
  if (staticResolution.kind === 'available') {
    staticAssets = staticResolution.assets;
    console.log(`[server] static ready  ${staticAssets.directory}`);
  } else if (config.nodeEnv === 'production') {
    console.error(`[server] refusing to start: ${staticResolution.refusal.code}`);
    console.error(`[server]   ${staticResolution.refusal.message}`);
    authz.close();
    await store.close();
    process.exitCode = 1;
    return;
  } else {
    console.warn('[server] static disabled: no web client build found (development/test only)');
  }

  // The identity seam is built **once** and handed to both transports, so a socket and an HTTP
  // request cannot disagree about who a cookie denotes (`docs/CONTRACTS.md` §18.4). In demo mode
  // it is the pre-B1 session lookup; in clerk mode it is `createClerkSessionVerifier` plus the
  // `app_user` mapping. The `findStartupRefusal` gate above guarantees the secret exists.
  const authMode = config.authMode ?? 'demo';
  const verifier = createSessionVerifier(authMode, process.env);
  const identityOptions: IdentityOptions = {
    // The internal-user mapping lives in the document database (`app_user`, §18.1). In demo
    // mode this is unused.
    appUsers: isAppUserStore(store) ? store : null,
    verifier,
  };
  // Constructing the deps validates the mode's inputs: a clerk server without a verifier or
  // without the mapping store fails here instead of silently admitting nobody.
  const identity = createIdentityDeps(authMode, authz, identityOptions);

  console.log(`[server] auth    ready  ${authMode === 'clerk' ? 'clerk' : 'demo'}`);
  // The publishable key is a **public** value, so reporting its absence is safe. It is not a
  // startup refusal (B3's gate covers the server-only secret); a clerk server without it fails
  // closed per request instead.
  if (
    authMode === 'clerk' &&
    !isNonEmptyEnvironmentValue(
      process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY,
    )
  ) {
    console.warn(
      '[server] auth    WARNING: CLERK_PUBLISHABLE_KEY (or VITE_CLERK_PUBLISHABLE_KEY) is not set; Clerk session verification will fail closed',
    );
  }

  // Built here (rather than inside `createApp`) only so the startup log can say which provider
  // is configured. A missing key is not a startup failure at runtime: the route answers
  // `503 ai_provider_not_configured`. In **production** the config gate above already refuses
  // `AI_PROVIDER=stub` and `openai` without a key, so the warning below can only appear in
  // development/test. The log prints only the provider class — never the key, the model or
  // request material.
  const aiKind = readServerAiProviderKind(process.env);
  const aiProvider = createServerAiProviderFromEnv(process.env);
  if (aiKind === 'stub') {
    console.log('[server] ai      ready  stub');
    console.log(
      '[server] ai      WARNING: stub is for development/evidence only; production rejects AI_PROVIDER=stub',
    );
  } else {
    console.log(`[server] ai      ${aiKind === 'disabled' ? 'disabled' : 'ready  openai'}`);
  }

  const app = createApp(config, authz, aiProvider, identityOptions, undefined, { staticAssets });
  const server = createServer(app);

  /*
   * Daily logical backups (M4 B8, D-082 D2). Disabled by default; a deployment turns it on with
   * `BACKUP_ENABLED=true`. It runs in this process because a Render cron job cannot mount the
   * web service's disk; the timer is unref'd so it can never keep the process alive.
   */
  const backupScheduler =
    config.backupEnabled === true
      ? startBackupScheduler({
          dataPath,
          ...(config.backupDir === undefined ? {} : { backupDir: config.backupDir }),
          ...(config.backupRetentionDays === undefined
            ? {}
            : { retentionDays: config.backupRetentionDays }),
          onError: (error: unknown) => {
            console.error(
              `[server] backup  failed  ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        })
      : null;
  if (backupScheduler !== null) {
    console.log('[server] backup  scheduled  daily, 7-day retention');
  }
  // All three seams are supplied, so none of `attachWebSocketServer`'s fail-closed checks can
  // fire: a data directory without a store, without authz, or a clerk-mode socket without an
  // identity resolver is a wiring mistake, not a mode.
  const socket = attachWebSocketServer(server, config, { store, authz, identity });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

  // The real bound address, not `config.port`: with `PORT=0` the OS picks the port, and the
  // integration tests (real process restarts, `M2-P0-1` scenarios B/C) need to read it back
  // rather than guess.
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  console.log(`[server] http  ready  http://${config.host}:${port}`);
  console.log(`[server] ws    ready  ws://${config.host}:${port}${config.wsPath}`);
  console.log(`[server] health       http://${config.host}:${port}/health`);
  console.log(`[server] ready        http://${config.host}:${port}/ready`);

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);

    // Stop the backup timer first: a scheduled snapshot must not race a closing store.
    backupScheduler?.stop();
    // Order matters: stop the transports first so no new mutation can enter the pipeline,
    // then flush and release the store. `registry.destroy()` inside `socket.close()` stops
    // every per-document queue, so nothing is left mid-append when the store closes.
    await socket.close();
    // Sessions are in memory, so closing authz only drops them and releases `authz.db`. It runs
    // after the transports stop: an in-flight HTTP request must not see a closed membership table.
    authz.close();
    await store.close();

    server.close(() => {
      process.exit(0);
    });
    // Do not hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Build the Clerk verifier for clerk mode, or `null` in demo mode.
 *
 * Only **presence** of the secret is inspected here; the value is passed to the SDK and never
 * logged. `findStartupRefusal` already refuses a clerk start without it, so the `null` return
 * below is an unreachable fail-closed guard rather than a configuration path — a clerk-mode app
 * built with `null` throws in `createIdentityDeps` instead of serving 401s forever.
 *
 * The publishable key is optional here: it is a **public** value (the browser already has it as
 * `VITE_CLERK_PUBLISHABLE_KEY`), but `@clerk/backend` needs it to authenticate session cookies,
 * so it is forwarded when the process has it. B3's production gate deliberately covers only the
 * server-only secret; a missing publishable key stays a startup warning.
 */
function createSessionVerifier(authMode: AuthMode, env: NodeJS.ProcessEnv): SessionVerifier | null {
  if (authMode !== 'clerk') return null;

  const secretKey = env.CLERK_SECRET_KEY;
  if (typeof secretKey !== 'string' || secretKey.trim() === '') return null;

  const publishableKey = env.CLERK_PUBLISHABLE_KEY ?? env.VITE_CLERK_PUBLISHABLE_KEY;
  return createClerkSessionVerifier({
    secretKey,
    ...(isNonEmptyEnvironmentValue(publishableKey) ? { publishableKey } : {}),
  });
}

/** True for a defined, non-blank environment value (an empty shell variable means "unset"). */
function isNonEmptyEnvironmentValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

await main();
