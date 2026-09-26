export interface VisionWebLabAccount {
  supplierId: string;
  billAccount: string;
  shipAccount: string;
}
export interface VisionWebConfig {
  soapUrl?: string;
  tokenUrl?: string;
  apiBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  refId?: string;
  username?: string;
  password?: string;
  labAccounts?: string;
  productionEnabled?: boolean;
}
export type ConfiguredVisionWeb = Required<Omit<VisionWebConfig, "productionEnabled">> & Pick<VisionWebConfig, "productionEnabled">;
export const VISIONWEB_NOT_CONFIGURED = "VisionWeb is not configured — see VISIONWEB_* env vars";
export function visionWebConfigFromEnv(env: Record<string, string | undefined> = process.env): VisionWebConfig {
  return {
    soapUrl: env.VISIONWEB_SOAP_URL, tokenUrl: env.VISIONWEB_TOKEN_URL, apiBaseUrl: env.VISIONWEB_API_BASE_URL,
    clientId: env.VISIONWEB_CLIENT_ID, clientSecret: env.VISIONWEB_CLIENT_SECRET, refId: env.VISIONWEB_REF_ID,
    username: env.VISIONWEB_USERNAME, password: env.VISIONWEB_PASSWORD, labAccounts: env.VISIONWEB_LAB_ACCOUNTS,
    productionEnabled: env.VISIONWEB_PRODUCTION_ENABLED === "true",
  };
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}
export function isHttpsUrl(value: unknown): value is string {
  if (!nonempty(value)) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
function accounts(config: VisionWebConfig): Map<string, VisionWebLabAccount> | undefined {
  try {
    const raw: unknown = JSON.parse(config.labAccounts ?? "");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entries = Object.entries(raw);
    if (!entries.length) return undefined;
    if (!entries.every(([, v]) => v && typeof v === "object" && !Array.isArray(v)
      && typeof v.supplierId === "string" && /^\d{4}$/.test(v.supplierId)
      && nonempty(v.billAccount) && nonempty(v.shipAccount))) return undefined;
    return new Map(entries);
  } catch { return undefined; }
}
export function isVisionWebConfigured(config: VisionWebConfig): config is ConfiguredVisionWeb {
  return [config.soapUrl, config.tokenUrl, config.apiBaseUrl].every(isHttpsUrl)
    && [config.clientId, config.clientSecret, config.refId, config.username, config.password, config.labAccounts].every(nonempty)
    && accounts(config) !== undefined;
}
export function assertVisionWebConfigured(config: VisionWebConfig): asserts config is ConfiguredVisionWeb {
  if (!isVisionWebConfigured(config)) throw new Error(VISIONWEB_NOT_CONFIGURED);
}
export function assertVisionWebTransmission(config: VisionWebConfig): asserts config is ConfiguredVisionWeb {
  assertVisionWebConfigured(config);
  if (new URL(config.soapUrl).hostname !== "services.visionwebqa.com" && config.productionEnabled !== true) {
    throw new Error("VisionWeb production transmission is not enabled.");
  }
}
export function visionWebLabAccount(config: VisionWebConfig, lab: string): VisionWebLabAccount {
  assertVisionWebConfigured(config);
  const account = accounts(config)!.get(lab.trim());
  if (!account) throw new Error(`VisionWeb has no account for lab "${lab.trim()}" — add it to VISIONWEB_LAB_ACCOUNTS.`);
  return account;
}
