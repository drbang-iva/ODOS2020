/// <reference types="vite/client" />

declare module "html-to-pdfmake" {
  import type { Content, StyleDictionary } from "pdfmake/interfaces";

  export default function htmlToPdfmake(
    html: string,
    options: {
      window: Window & typeof globalThis;
      removeExtraBlanks?: boolean;
      defaultStyles?: StyleDictionary;
    },
  ): Content;
}

interface ImportMetaEnv {
  readonly VITE_ODOS_MCP_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
