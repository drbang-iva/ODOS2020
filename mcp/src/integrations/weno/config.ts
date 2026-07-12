export interface WenoEzIntegrationConfig {
  encryptionKey?: string;
  baseUrl?: string;
  syncAdminEmail?: string;
  syncAdminPasswordRef?: string;
}

export function wenoEzIntegrationConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WenoEzIntegrationConfig {
  return {
    encryptionKey: env.WENO_EZ_ENCRYPTION_KEY,
    baseUrl: env.WENO_EZ_BASE_URL,
    syncAdminEmail: env.WENO_EZ_SYNC_ADMIN_EMAIL,
    syncAdminPasswordRef: env.WENO_EZ_SYNC_ADMIN_PASSWORD_REF,
  };
}

export function isWenoConfigured(config: WenoEzIntegrationConfig): boolean {
  return [
    config.encryptionKey,
    config.baseUrl,
    config.syncAdminEmail,
    config.syncAdminPasswordRef,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}
