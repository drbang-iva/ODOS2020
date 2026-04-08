import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default('1h'),
  REFRESH_TOKEN_EXPIRY: z.string().default('7d'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('localhost'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_AGENT_MAX_REQUESTS: z.coerce.number().int().positive().default(500),
});

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiry: string;
  refreshTokenExpiry: string;
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  rateLimitAgentMaxRequests: number;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    jwtSecret: parsed.JWT_SECRET,
    jwtExpiry: parsed.JWT_EXPIRY,
    refreshTokenExpiry: parsed.REFRESH_TOKEN_EXPIRY,
    port: parsed.PORT,
    host: parsed.HOST,
    nodeEnv: parsed.NODE_ENV,
    rateLimitWindowMs: parsed.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: parsed.RATE_LIMIT_MAX_REQUESTS,
    rateLimitAgentMaxRequests: parsed.RATE_LIMIT_AGENT_MAX_REQUESTS,
  };
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = parseConfig(process.env);
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
