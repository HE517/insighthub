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
import { createAuthz, type AuthzService } from './authz/public.js';
import { loadConfig } from './config.js';
import { isDocumentMetaStore, StoreDocumentCatalog } from './persistence/document-meta.js';
import { openDocumentStore } from './persistence/open-store.js';
import { isSqliteCapabilityError } from './persistence/sqlite-runtime.js';
import type { DocumentStore } from './persistence/types.js';
import { attachWebSocketServer } from './ws.js';

async function main(): Promise<void> {
  const config = loadConfig();
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

  const app = createApp(config, authz);
  const server = createServer(app);
  // Both seams are supplied, so neither of `attachWebSocketServer`'s fail-closed checks can
  // fire: a data directory without a store or without authz is a wiring mistake, not a mode.
  const socket = attachWebSocketServer(server, config, { store, authz });

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

await main();
