import { defineConfig } from 'vitest/config';

/**
 * Root test runner for the pure-TypeScript workspaces (Vitest).
 *
 * `apps/server` integration tests use `node:test` instead (they boot a real
 * HTTP+WS server), so they are excluded here and run by `pnpm test:server`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/**'],
  },
});
