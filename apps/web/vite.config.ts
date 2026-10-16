import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Web dev server.
 *
 * The `/api`, `/health` and `/ws` prefixes are proxied to the backend so the
 * browser only ever talks to one origin in development. `ws: true` is required
 * for the WebSocket upgrade to be forwarded.
 *
 * The backend origin is configurable so tests/tooling can run the stack on a
 * non-default port instead of colliding with a running dev server.
 */
const backendHost = process.env.INSIGHTHUB_SERVER_HOST ?? '127.0.0.1';
const backendPort = process.env.PORT ?? '3001';
const httpTarget = `http://${backendHost}:${backendPort}`;
const wsTarget = `ws://${backendHost}:${backendPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: httpTarget, changeOrigin: true },
      '/health': { target: httpTarget, changeOrigin: true },
      '/ws': { target: wsTarget, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
