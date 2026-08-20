export interface WenoDirectoryDownloadConfig {
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
  endpoint?: string;
}

export const DEFAULT_WENO_SWITCH_ENDPOINT =
  "https://cert.wenoexchange.com/wenox/restapi/WenoSwitch";

export function wenoDirectoryDownloadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WenoDirectoryDownloadConfig {
  return {
    encryptionKey: env.WENO_EZ_ENCRYPTION_KEY,
    baseUrl: env.WENO_EZ_BASE_URL,
    syncAdminEmail: env.WENO_EZ_SYNC_ADMIN_EMAIL,
    syncAdminPasswordRef: env.WENO_EZ_SYNC_ADMIN_PASSWORD_REF,
  };
}

export function isWenoDirectoryDownloadConfigured(
  config: WenoDirectoryDownloadConfig,
): boolean {
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
    endpoint: env.WENO_SWITCH_ENDPOINT?.trim() || DEFAULT_WENO_SWITCH_ENDPOINT,
  };
}

export function isWenoSwitchConfigured(config: WenoSwitchConfig): boolean {
  return [
    config.partnerId,
    config.partnerPasswordMd5,
    config.routingId,
    config.senderSoftwareDeveloper,
    config.senderSoftwareVersion,
    config.endpoint,
  ].every((value) => typeof value === "string" && value.trim().length > 0);
}
