/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEDPLUM_ADMIN_EMAIL: string;
  readonly VITE_MEDPLUM_ADMIN_PASSWORD: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
