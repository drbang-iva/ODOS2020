import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { AuthService } from '../../../../src/server/modules/auth/service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long-for-validation';

const ADMIN_PERMISSIONS = [
  'admin:users', 'admin:settings',
  'patients:read', 'patients:write',
  'appointments:read', 'appointments:write',
  'billing:read', 'billing:submit',
  'clinical:read', 'clinical:write',
  'reports:read', 'reports:export',
];

const FRONT_DESK_PERMISSIONS = [
  'patients:read', 'patients:write',
  'appointments:read', 'appointments:write',
];

describe('AuthService', () => {
  let pool: pg.Pool;
  let auth: AuthService;
  let practiceId: string;
  let adminRoleId: string;
  let frontDeskRoleId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    // Reset DB
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    auth = new AuthService(pool, JWT_SECRET);

    // Create a practice for tests
    const result = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    practiceId = result.rows[0].id;

    // Create roles
    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ADMIN_PERMISSIONS],
    );
    adminRoleId = adminRole.rows[0].id;

    const frontDeskRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Front Desk', $2, true) RETURNING id`,
      [practiceId, FRONT_DESK_PERMISSIONS],
    );
    frontDeskRoleId = frontDeskRole.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('createUser', () => {
    it('creates a user with hashed password and permissions from roles', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: true,
        serviceLineIds: [],
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe('doc@test.com');
      expect(user.fullName).toBe('Dr. Test');
      expect(user.permissions).toContain('admin:users');
      expect(user.permissions).toContain('patients:read');
      // Password hash should NOT be returned
      expect((user as any).passwordHash).toBeUndefined();
      expect((user as any).password_hash).toBeUndefined();
    });

    it('creates a user with front desk permissions', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'front@test.com',
        password: 'securepass123',
        fullName: 'Front Desk Staff',
        roleIds: [frontDeskRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      expect(user.permissions).toContain('patients:read');
      expect(user.permissions).toContain('appointments:write');
      expect(user.permissions).not.toContain('admin:users');
      expect(user.permissions).not.toContain('billing:read');
    });

    it('creates a user with no roles (empty permissions)', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'agent@test.com',
        password: 'securepass123',
        fullName: 'Agent User',
        roleIds: [],
        isProvider: false,
        serviceLineIds: [],
      });

      expect(user.permissions).toEqual([]);
    });

    it('rejects duplicate email within same practice', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      await expect(
        auth.createUser(practiceId, {
          email: 'doc@test.com',
          password: 'securepass123',
          fullName: 'Dr. Test 2',
          roleIds: [frontDeskRoleId],
          isProvider: false,
          serviceLineIds: [],
        }),
      ).rejects.toThrow();
    });
  });

  describe('login', () => {
    it('returns JWT and refresh token for valid credentials', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      const result = await auth.login({
        email: 'doc@test.com',
        password: 'securepass123',
        practiceId,
      });

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(typeof result.accessToken).toBe('string');
      expect(typeof result.refreshToken).toBe('string');
    });

    it('rejects wrong password', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      await expect(
        auth.login({
          email: 'doc@test.com',
          password: 'wrongpassword',
          practiceId,
        }),
      ).rejects.toThrow('Invalid credentials');
    });

    it('rejects nonexistent email', async () => {
      await expect(
        auth.login({
          email: 'nobody@test.com',
          password: 'securepass123',
          practiceId,
        }),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('verifyAccessToken', () => {
    it('decodes a valid token with permissions', async () => {
      await auth.createUser(practiceId, {
        email: 'doc@test.com',
        password: 'securepass123',
        fullName: 'Dr. Test',
        roleIds: [adminRoleId],
        isProvider: false,
        serviceLineIds: [],
      });

      const { accessToken } = await auth.login({
        email: 'doc@test.com',
        password: 'securepass123',
        practiceId,
      });

      const payload = await auth.verifyAccessToken(accessToken);
      expect(payload.userId).toBeDefined();
      expect(payload.practiceId).toBe(practiceId);
      expect(payload.permissions).toContain('admin:users');
      expect(payload.permissions).toContain('patients:read');
    });
  });

  describe('createAgentKey', () => {
    it('returns the raw API key (only shown once)', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'agent@test.com',
        password: 'securepass123',
        fullName: 'Scheduling Agent',
        roleIds: [],
        isProvider: false,
        serviceLineIds: [],
      });

      const result = await auth.createAgentKey(practiceId, user.id, {
        name: 'local-scheduler',
        modelType: 'local',
        scopes: ['appointments:read', 'appointments:write'],
      });

      expect(result.rawKey).toBeDefined();
      expect(result.rawKey.startsWith('osod_')).toBe(true);
      expect(result.keyId).toBeDefined();
    });
  });

  describe('verifyAgentKey', () => {
    it('validates a correct API key and returns scopes', async () => {
      const user = await auth.createUser(practiceId, {
        email: 'agent@test.com',
        password: 'securepass123',
        fullName: 'Scheduling Agent',
        roleIds: [],
        isProvider: false,
        serviceLineIds: [],
      });

      const { rawKey } = await auth.createAgentKey(practiceId, user.id, {
        name: 'local-scheduler',
        modelType: 'local',
        scopes: ['appointments:read', 'appointments:write'],
      });

      const result = await auth.verifyAgentKey(rawKey);
      expect(result).not.toBeNull();
      expect(result!.scopes).toContain('appointments:read');
      expect(result!.modelType).toBe('local');
    });

    it('rejects an invalid API key', async () => {
      const result = await auth.verifyAgentKey('osod_invalid_key_here');
      expect(result).toBeNull();
    });
  });
});
