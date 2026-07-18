export interface WenoEzIntegrationConfig {
  encryptionKey?: string;
  baseUrl?: string;
  syncAdminEmail?: string;
  syncAdminPasswordRef?: string;
}

export interface WenoSwitchConfig {
  partnerId?: string;
  partnerPasswordMd5?: string;
  routingId?: string;
  senderSoftwareDeveloper?: string;
  senderSoftwareVersion?: string;
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

export function wenoSwitchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WenoSwitchConfig {
  return {
    partnerId: env.WENO_SWITCH_PARTNER_ID,
    partnerPasswordMd5: env.WENO_SWITCH_PARTNER_PASSWORD_MD5,
    routingId: env.WENO_SWITCH_ROUTING_ID,
    senderSoftwareDeveloper: env.WENO_SWITCH_SENDER_SOFTWARE_DEVELOPER,
    senderSoftwareVersion: env.WENO_SWITCH_SENDER_SOFTWARE_VERSION,
  };
}

export function isWenoSwitchConfigured(config: WenoSwitchConfig): boolean {
  return [
    config.partnerId,
    config.partnerPasswordMd5,
    config.routingId,
    config.senderSoftwareDeveloper,
    config.senderSoftwareVersion,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}
