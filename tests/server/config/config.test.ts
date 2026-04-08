import { describe, it, expect } from 'vitest';
import { parseConfig, type Config } from '../../../src/server/config/index.js';

describe('parseConfig', () => {
  it('parses valid environment variables', () => {
    const env = {
      DATABASE_URL: 'postgresql://osod:osod_dev@localhost:5432/osod',
      JWT_SECRET: 'a'.repeat(64),
      PORT: '3000',
    };

    const config = parseConfig(env);
    expect(config.databaseUrl).toBe(env.DATABASE_URL);
    expect(config.jwtSecret).toBe(env.JWT_SECRET);
    expect(config.port).toBe(3000);
  });

  it('applies defaults for optional fields', () => {
    const env = {
      DATABASE_URL: 'postgresql://osod:osod_dev@localhost:5432/osod',
      JWT_SECRET: 'a'.repeat(64),
    };

    const config = parseConfig(env);
    expect(config.port).toBe(3000);
    expect(config.host).toBe('localhost');
    expect(config.nodeEnv).toBe('development');
    expect(config.jwtExpiry).toBe('1h');
    expect(config.refreshTokenExpiry).toBe('7d');
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.rateLimitMaxRequests).toBe(100);
    expect(config.rateLimitAgentMaxRequests).toBe(500);
  });

  it('throws on missing DATABASE_URL', () => {
    const env = { JWT_SECRET: 'a'.repeat(64) };
    expect(() => parseConfig(env)).toThrow();
  });

  it('throws on missing JWT_SECRET', () => {
    const env = { DATABASE_URL: 'postgresql://localhost/osod' };
    expect(() => parseConfig(env)).toThrow();
  });

  it('coerces PORT to number', () => {
    const env = {
      DATABASE_URL: 'postgresql://localhost/osod',
      JWT_SECRET: 'a'.repeat(64),
      PORT: '8080',
    };

    const config = parseConfig(env);
    expect(config.port).toBe(8080);
  });
});
