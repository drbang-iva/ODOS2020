import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Practice admin routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let accessToken: string;
  let adminRoleId: string;

  beforeAll(async () => {
    const setup = new pg.Pool({ connectionString: TEST_DB_URL });
    await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setup.end();
    await runMigrations(TEST_DB_URL);

    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    const config = parseConfig({
      DATABASE_URL: TEST_DB_URL,
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long-for-validation',
    });
    const appResult = createApp({ pool, config });
    app = appResult.app;
    authService = appResult.authService;

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Practice Admin Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ['admin:users', 'admin:settings', 'patients:read', 'patients:write']],
    );
    adminRoleId = adminRole.rows[0].id;

    await authService.createUser(practiceId, {
      email: 'admin@test.com',
      password: 'securepass123',
      fullName: 'Admin',
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

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });

  describe('practice settings', () => {
    it('GET /api/practice returns settings', async () => {
      const res = await app.request('/api/practice', { headers: { Authorization: `Bearer ${accessToken}` } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(practiceId);
      expect(body.schedule_block_minutes).toBe(15);
    });

    it('PATCH /api/practice updates settings', async () => {
      const res = await app.request('/api/practice', {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: 'Updated Name', scheduleBlockMinutes: 30 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Updated Name');
      expect(body.schedule_block_minutes).toBe(30);
    });

    it('PATCH /api/practice rejects invalid block minutes', async () => {
      const res = await app.request('/api/practice', {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ scheduleBlockMinutes: 7 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('service lines', () => {
    let createdSlId: string;

    it('POST creates service line', async () => {
      const res = await app.request('/api/practice/service-lines', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: 'Eyecare', color: '#2563EB', sortOrder: 1 }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Eyecare');
      createdSlId = body.id;
    });

    it('GET lists service lines', async () => {
      const res = await app.request('/api/practice/service-lines', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.serviceLines.length).toBeGreaterThan(0);
    });

    it('PATCH updates service line', async () => {
      const res = await app.request(`/api/practice/service-lines/${createdSlId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: 'Eye Care' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Eye Care');
    });

    it('DELETE deactivates service line', async () => {
      const res = await app.request(`/api/practice/service-lines/${createdSlId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.is_active).toBe(false);
    });
  });

  describe('users', () => {
    it('GET /api/practice/users lists users', async () => {
      const res = await app.request('/api/practice/users', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.users.length).toBeGreaterThan(0);
      expect(body.users[0]).not.toHaveProperty('password_hash');
    });

    it('PATCH /api/practice/users/:id updates user', async () => {
      const newUser = await authService.createUser(practiceId, {
        email: 'staff@test.com',
        password: 'securepass123',
        fullName: 'Staff Member',
        roleIds: [],
        isProvider: false,
        serviceLineIds: [],
      });

      const res = await app.request(`/api/practice/users/${newUser.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ fullName: 'Updated Staff', isProvider: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.full_name).toBe('Updated Staff');
      expect(body.is_provider).toBe(true);
    });

    it('POST /api/practice/users/:id/roles assigns a role', async () => {
      const newUser = await authService.createUser(practiceId, {
        email: 'roleassign@test.com',
        password: 'securepass123',
        fullName: 'Role Assign',
        roleIds: [],
        isProvider: false,
        serviceLineIds: [],
      });

      const res = await app.request(`/api/practice/users/${newUser.id}/roles`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ roleId: adminRoleId }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.role_id).toBe(adminRoleId);
    });

    it('GET /api/practice/users/:id/roles lists assignments', async () => {
      const newUser = await authService.createUser(practiceId, {
        email: 'listroles@test.com',
        password: 'securepass123',
        fullName: 'List Roles',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      const res = await app.request(`/api/practice/users/${newUser.id}/roles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assignments).toHaveLength(1);
      expect(body.assignments[0].role_name).toBe('Admin');
    });
  });

  describe('roles', () => {
    let customRoleId: string;

    it('GET /api/practice/roles lists all roles', async () => {
      const res = await app.request('/api/practice/roles', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.roles.length).toBeGreaterThan(0);
    });

    it('POST creates a custom role', async () => {
      const res = await app.request('/api/practice/roles', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'Front Desk Lead',
          permissionSet: ['patients:read', 'patients:write', 'appointments:read', 'appointments:write'],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Front Desk Lead');
      expect(body.is_system).toBe(false);
      customRoleId = body.id;
    });

    it('PATCH updates custom role', async () => {
      const res = await app.request(`/api/practice/roles/${customRoleId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: 'Front Desk Manager' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('Front Desk Manager');
    });

    it('PATCH rejects modifying system role', async () => {
      const res = await app.request(`/api/practice/roles/${adminRoleId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(400);
    });

    it('DELETE removes custom role', async () => {
      const res = await app.request(`/api/practice/roles/${customRoleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
    });

    it('DELETE rejects deleting system role', async () => {
      const res = await app.request(`/api/practice/roles/${adminRoleId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(400);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await app.request('/api/practice');
    expect(res.status).toBe(401);
  });
});
