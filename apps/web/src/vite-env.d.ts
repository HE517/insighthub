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
  /**
   * Clerk **publishable** key (M4 B2, `docs/CONTRACTS.md` §18.6). Public by design: it is inlined
   * into the browser bundle and only identifies the Clerk application. Present and non-blank
   * enables Clerk mode; absent keeps the demo application. The secret key never appears here.
   */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
