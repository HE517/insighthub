import { defineConfig } from 'vitest/config';

/**
 * The single test gate for the workspace's Vitest suites (M1-A0.2).
 *
 * `pnpm test` at the root runs this **and then** `apps/server`'s `node:test` suite, so one
 * command covers every agent's tests. There is deliberately only one Vitest config: a
 * second, directory-local config (`apps/web/vitest.config.ts`) was removed because two
 * files meant two possible answers to "what does the gate run?", and `mergeConfig`
 * concatenates `include` arrays, so an unfiltered run under it would execute the root's
 * files too.
 *
 * Everything here runs in the `node` environment. A1's collaboration core and A2's editor
 * logic are both written as DOM-free modules with injected seams (IndexedDB, WebSocket,
 * CodeMirror surface), so no Vitest *project* split is needed today. If a future suite
 * genuinely needs jsdom, add it as a Vitest `projects` entry **in this file** rather than as
 * a separate config the root gate cannot see.
 *
 * Included:
 *
 * - `packages/**` — the shared contract (A0).
 * - `apps/web/src/collab/**` — A1's collaboration core: socket-backed, but it carries its
 *   own Node transports, so it runs here unchanged.
 * - `apps/web/src/features/**` — A2's binding, cursor derivation, lifecycle and
 *   presentation logic.
 * - `apps/web/src/session/**` — A5's M2 Phase 2 session bootstrap (identity only; the token lives
 *   in an `httpOnly` cookie and is never reachable from JS). Added together with that code,
 *   because a test the gate does not run is not a test.
 *
 * Excluded: `apps/server/**`, whose integration tests boot a real HTTP+WS server and run
 * through `node:test` (`pnpm test:server`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/web/src/features/**/*.test.ts',
      'apps/web/src/collab/**/*.test.ts',
      'apps/web/src/session/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/server/**'],
  },
});
