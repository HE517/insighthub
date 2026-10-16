/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute WebSocket URL. Empty means "derive from window.location". */
  readonly VITE_WS_URL?: string;
  /** Absolute HTTP API base. Empty means "use the dev-server proxy". */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
