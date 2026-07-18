/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ODOS_MCP_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
