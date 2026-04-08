import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../src/server/app.js';
import { parseConfig } from '../../../src/server/config/index.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

const ADMIN_PERMISSIONS = [
  'admin:users', 'admin:settings',
  'patients:read', 'patients:write',
  'appointments:read', 'appointments:write',
  'billing:read', 'billing:submit',
  'clinical:read', 'clinical:write',
  'reports:read', 'reports:export',
];

describe('OSOD smoke test', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let accessToken: string;

  beforeAll(async () => {
    // Reset test DB
    const setupPool = new pg.Pool({ connectionString: TEST_DB_URL });
    await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setupPool.end();

    await runMigrations(TEST_DB_URL);

    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    const config = parseConfig({
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long-for-validation',
    });

    const appResult = createApp({ pool, config });
    app = appResult.app;
    authService = appResult.authService;

    // Create practice and admin role
    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ADMIN_PERMISSIONS],
    );
    const adminRoleId = adminRole.rows[0].id;

    await authService.createUser(practiceId, {
      email: 'admin@test.com',
      password: 'securepass123',
      fullName: 'Admin User',
      roleIds: [adminRoleId],
      isProvider: false,
      serviceLineIds: [],
    });

    const tokens = await authService.login({
      email: 'admin@test.com',
      password: 'securepass123',
      practiceId,
    });
    accessToken = tokens.accessToken;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('GET /health returns ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('POST /api/auth/login returns tokens', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.com',
        password: 'securepass123',
        practiceId,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('POST /api/auth/login rejects bad password', async () => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.com',
        password: 'wrongpassword',
        practiceId,
      }),
    });
    expect(res.status).toBe(401);
  });

  it('protected routes reject unauthenticated requests', async () => {
    const res = await app.request('/api/patients');
    expect(res.status).toBe(401);
  });

  it('protected routes accept valid JWT', async () => {
    const res = await app.request('/api/patients', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/refresh rotates tokens', async () => {
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.com',
        password: 'securepass123',
        practiceId,
      }),
    });
    const { refreshToken } = await loginRes.json();

    const res = await app.request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });
});
