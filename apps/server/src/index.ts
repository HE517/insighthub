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
import { openDocumentStore } from './persistence/open-store.js';
import { isSqliteCapabilityError } from './persistence/sqlite-runtime.js';
import type { DocumentStore } from './persistence/types.js';
import { findStartupRefusal } from './startup.js';
import { attachWebSocketServer } from './ws.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // The minimum M4 gate: a production process may not run on the demo fixture (B1), and clerk
  // mode may not start without the secret key it verifies sessions with (B2). Printed as a
  // code + a sentence, never a stack and never the value; B3 will extend this into the full
  // production config validator.
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
  if (
    authMode === 'clerk' &&
    !isNonEmptyEnvironmentValue(
      process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY,
    )
  ) {
    // Public key, not a secret — printing that it is absent is safe. `@clerk/backend` needs it
    // to authenticate a session token; refusing to start over it is B3's configuration gate.
    console.warn(
      '[server] auth    WARNING: CLERK_PUBLISHABLE_KEY (or VITE_CLERK_PUBLISHABLE_KEY) is not set; Clerk session verification will fail closed',
    );
  }

  // Built here (rather than inside `createApp`) only so the startup log can say which provider
  // is configured. A missing key is not a startup failure this round: the route answers
  // `503 ai_provider_not_configured` (D-080 §3 puts fail-fast in M4 D3). The log prints only
  // the provider class — never the key, the model or request material.
  //
  // `stub` is a development/evidence-only provider, selected only by an explicit
  // `AI_PROVIDER=stub`. Production configuration validation (M4 D3) must reject it; until then
  // the warning makes an accidentally stub-backed production server visible in the first lines
  // of its log. It is never a default and never a fallback for a broken OpenAI configuration.
  const aiKind = readServerAiProviderKind(process.env);
  const aiProvider = createServerAiProviderFromEnv(process.env);
  if (aiKind === 'stub') {
    console.log('[server] ai      ready  stub');
    console.log(
      '[server] ai      WARNING: stub is for development/evidence only; production config validation (M4 D3) must reject AI_PROVIDER=stub',
    );
  } else {
    console.log(`[server] ai      ${aiKind === 'disabled' ? 'disabled' : 'ready  openai'}`);
  }

  const app = createApp(config, authz, aiProvider, identityOptions);
  const server = createServer(app);
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

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);

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
 * so it is forwarded when the process has it. B3 owns making it a required production setting.
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
