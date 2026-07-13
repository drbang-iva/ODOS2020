/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OSOD_MCP_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
