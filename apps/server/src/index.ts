/**
 * Server entrypoint: HTTP + WebSocket on one port, with graceful shutdown.
 */
import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { attachWebSocketServer } from './ws.js';

const config = loadConfig();
const app = createApp(config);
const server = createServer(app);
const socket = attachWebSocketServer(server, config);

server.listen(config.port, config.host, () => {
  console.log(`[server] http  ready  http://${config.host}:${config.port}`);
  console.log(`[server] ws    ready  ws://${config.host}:${config.port}${config.wsPath}`);
  console.log(`[server] health       http://${config.host}:${config.port}/health`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received, shutting down`);
  await socket.close();
  server.close(() => process.exit(0));
  // Do not hang forever on lingering keep-alive connections.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
