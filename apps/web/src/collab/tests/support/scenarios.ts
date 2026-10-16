import { awarenessStateSchema, type AwarenessState } from '@insighthub/shared';

import { createDocumentSession, type DocumentSession } from '../../internal/document-session.js';
import type { SessionOptions } from '../../internal/session-options.js';
import type { SyncSocketFactory } from '../../internal/sync-provider.js';
import { FakeIndexedDb } from './fake-indexeddb.js';
import { TestWebSocketClient } from './test-server.js';

/**
 * Shared per-test helpers: a fresh in-memory IndexedDB, and a session factory wired
 * to the in-process contract server with shortened timers.
 *
 * The backoff values are compressed so a reconnect test does not spend ten seconds
 * asleep, and the awareness window is shortened so presence assertions do not hinge
 * on a 50 ms sleep. Nothing else about the session changes: these tests run the
 * production code path.
 */

/** Reconnect pacing used by tests (production is 1 s → 10 s). */
export const TEST_RECONNECT_BASE_MS = 20;
export const TEST_RECONNECT_MAX_MS = 60;
/** Awareness coalescing window used by tests (production is 50 ms). */
export const TEST_AWARENESS_FLUSH_MS = 5;

/** The WebSocket constructor the collab layer calls, adapted to our Node double. */
export const testSocketFactory = TestWebSocketClient as unknown as SyncSocketFactory;

export interface TestContextOptions {
  /** Extra session dependencies (persistence hook, socket factory override). */
  dependencies?: Partial<Parameters<typeof createDocumentSession>[1]>;
  /** Placeholder URL: every test injects the socket factory, so it is never dialled. */
  wsUrl?: string;
}

export interface TestContext {
  readonly db: FakeIndexedDb;
  readonly openedSessions: DocumentSession[];
  /** A unique string, so parallel or repeated tests cannot share state. */
  nextId(prefix: string): string;
  /** Create a production session backed by the in-memory IndexedDB double. */
  create(options?: Partial<SessionOptions>): Promise<DocumentSession>;
  /** Recreate a session for an existing document (the reload scenario). */
  createFor(
    documentId: string,
    options?: Partial<SessionOptions> & { persistenceKey?: string },
  ): Promise<DocumentSession>;
  cleanup(): Promise<void>;
}

export function createTestContext(contextOptions: TestContextOptions = {}): TestContext {
  const db = new FakeIndexedDb();
  const restoreGlobals = db.install();
  const openedSessions: DocumentSession[] = [];
  let counter = 0;

  const nextId = (prefix: string): string => {
    counter += 1;
    return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const build = (
    documentId: string,
    options: Partial<SessionOptions> = {},
  ): Promise<DocumentSession> =>
    createDocumentSession(
      {
        documentId,
        user: { id: 'user-a', name: 'User A', color: '#3366ff' },
        persistenceKey: `test-db-${documentId}`,
        wsUrl: contextOptions.wsUrl ?? 'ws://127.0.0.1:1/ws',
        wsSocketFactory: testSocketFactory,
        indexedDB: db,
        ...options,
      },
      {
        indexedDB: db,
        awarenessFlushDelayMs: TEST_AWARENESS_FLUSH_MS,
        // Sessions start disconnected by default: a test opts in to the network by
        // calling `startNetwork` itself, which keeps "local durability" assertions
        // independent of the transport.
        startNetwork: false,
        ...contextOptions.dependencies,
      },
    ).then((session) => {
      openedSessions.push(session);
      return session;
    });

  return {
    db,
    openedSessions,
    nextId,
    create: (options = {}) => build(options.documentId ?? nextId('doc'), options),
    createFor: (documentId, options = {}) => build(documentId, options),
    async cleanup() {
      for (const session of openedSessions.splice(0)) {
        if (session.state !== 'destroyed') session.destroy();
      }
      restoreGlobals();
    },
  };
}

/**
 * Wait until `predicate` holds, or fail with a useful message.
 *
 * Used instead of a fixed sleep so a passing test does not encode machine speed.
 */
export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A valid remote awareness entry, for presence assertions. */
export function remoteAwarenessState(overrides: Partial<AwarenessState> = {}): AwarenessState {
  return awarenessStateSchema.parse({
    user: { id: 'peer', name: 'Peer', color: '#ff8800' },
    cursor: { anchor: 3, head: 3 },
    selection: null,
    updatedAt: 1,
    ...overrides,
  });
}
