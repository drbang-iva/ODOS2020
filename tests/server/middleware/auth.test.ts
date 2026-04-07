import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import pg from 'pg';
import { createAuthMiddleware } from '../../../src/server/middleware/auth.js';
import { AuthService } from '../../../src/server/modules/auth/service.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long-for-validation';

describe('auth middleware', () => {
  let pool: pg.Pool;
  let authService: AuthService;
  let app: Hono;
  let practiceId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    authService = new AuthService(pool, JWT_SECRET);

    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;

    app = new Hono();
    app.use('/api/*', createAuthMiddleware(authService));
    app.get('/api/test', (c) => c.json({ ok: true, auth: c.get('auth') }));
    app.get('/health', (c) => c.json({ ok: true }));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('rejects requests without auth', async () => {
    const res = await app.request('/api/test');
    expect(res.status).toBe(401);
  });

  it('allows requests with valid JWT', async () => {
    await authService.createUser(practiceId, {
      email: 'doc@test.com',
      password: 'securepass123',
      fullName: 'Dr. Test',
      role: 'admin',
      isProvider: false,
      serviceLineIds: [],
    });

    const { accessToken } = await authService.login({
      email: 'doc@test.com',
      password: 'securepass123',
      practiceId,
    });

    const res = await app.request('/api/test', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.auth.role).toBe('admin');
    expect(body.auth.actorType).toBe('human');
  });

  it('allows requests with valid API key', async () => {
    const user = await authService.createUser(practiceId, {
      email: 'agent@test.com',
      password: 'securepass123',
      fullName: 'Agent',
      role: 'agent',
      isProvider: false,
      serviceLineIds: [],
    });

    const { rawKey } = await authService.createAgentKey(practiceId, user.id, {
      name: 'test-agent',
      modelType: 'local',
      scopes: ['patients:read'],
    });

    const res = await app.request('/api/test', {
      headers: { 'X-API-Key': rawKey },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.auth.actorType).toBe('local_agent');
  });

  it('does not require auth for non-api routes', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
