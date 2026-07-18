export interface OcucoGatekeeperConfig {
  baseUrl?: string;
  jwtKey?: string;
  jwtSecret?: string;
}

export function ocucoGatekeeperConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OcucoGatekeeperConfig {
  return {
    baseUrl: env.OCUCO_GATEKEEPER_BASE_URL,
    jwtKey: env.OCUCO_GATEKEEPER_JWT_KEY,
    jwtSecret: env.OCUCO_GATEKEEPER_JWT_SECRET,
  };
}

export function isOcucoGatekeeperConfigured(config: OcucoGatekeeperConfig): boolean {
  return [config.baseUrl, config.jwtKey, config.jwtSecret]
    .every((value) => typeof value === "string" && value.trim().length > 0);
}
