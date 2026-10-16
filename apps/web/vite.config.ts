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
    // Bind IPv4 explicitly: Vite's default `localhost` resolves to ::1 on
    // Windows, which makes http://127.0.0.1:5173 unreachable while the backend
    // listens on 127.0.0.1. One address family for the whole dev stack.
    host: '127.0.0.1',
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
