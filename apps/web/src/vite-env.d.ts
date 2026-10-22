/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute WebSocket URL. Empty means "derive from window.location". */
  readonly VITE_WS_URL?: string;
  /** Absolute HTTP API base. Empty means "use the dev-server proxy". */
  readonly VITE_API_BASE?: string;
  /**
   * Which `AiProvider` the browser should use: `"remote"` calls `POST /api/ai/suggest`;
   * anything else (including unset) keeps the deterministic local provider. Never a key.
   */
  readonly VITE_AI_PROVIDER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
