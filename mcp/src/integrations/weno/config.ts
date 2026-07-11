export interface WenoEzIntegrationConfig {
  accountId?: string;
  encryptionKey?: string;
  baseUrl?: string;
  adminCredentialsRef?: string;
}

export function wenoEzIntegrationConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WenoEzIntegrationConfig {
  return {
    accountId: env.WENO_EZ_ACCOUNT_ID,
    encryptionKey: env.WENO_EZ_ENCRYPTION_KEY,
    baseUrl: env.WENO_EZ_BASE_URL,
    adminCredentialsRef: env.WENO_EZ_ADMIN_CREDENTIALS_REF,
  };
}

export function isWenoConfigured(config: WenoEzIntegrationConfig): boolean {
  return [
    config.accountId,
    config.encryptionKey,
    config.baseUrl,
    config.adminCredentialsRef,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}
