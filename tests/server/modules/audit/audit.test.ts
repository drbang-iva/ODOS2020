import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Audit routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let otherPracticeId: string;
  let userId: string;
  let patientId: string;
  let accessToken: string;

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
      `INSERT INTO practices (name) VALUES ('Audit Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    // Another practice to verify isolation
    const other = await pool.query(
      `INSERT INTO practices (name) VALUES ('Other Practice') RETURNING id`,
    );
    otherPracticeId = other.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ['admin:users', 'reports:read', 'reports:export', 'patients:read', 'patients:write']],
    );

    const user = await authService.createUser(practiceId, {
      email: 'admin@audit.com',
      password: 'securepass123',
      fullName: 'Auditor',
      roleIds: [adminRole.rows[0].id],
      isProvider: false,
      serviceLineIds: [],
    });
    userId = user.id;

    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Audit', 'Test', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = patient.rows[0].id;

    // Seed a variety of audit events directly
    const now = new Date();
    const events = [
      // 3 events for our patient
      { action: 'create', actor: userId, actorType: 'human', entityType: 'patient', entityId: patientId, offset: 0 },
      { action: 'update', actor: userId, actorType: 'human', entityType: 'patient', entityId: patientId, offset: 1000 },
      { action: 'access', actor: userId, actorType: 'human', entityType: 'patient', entityId: patientId, offset: 2000 },
      // 1 appointment event
      { action: 'create', actor: userId, actorType: 'human', entityType: 'appointment', entityId: patientId, offset: 3000 },
      // 1 agent-driven event
      { action: 'access', actor: userId, actorType: 'local_agent', entityType: 'patient', entityId: patientId, offset: 4000 },
      // Event in another practice (must NOT be visible)
      { action: 'create', actor: userId, actorType: 'human', entityType: 'patient', entityId: patientId, offset: 5000, practiceOverride: otherPracticeId },
    ];

    for (const e of events) {
      await pool.query(
        `INSERT INTO audit_events
         (practice_id, entity_type, entity_id, action, actor_id, actor_type, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          e.practiceOverride ?? practiceId,
          e.entityType,
          e.entityId,
          e.action,
          e.actor,
          e.actorType,
          new Date(now.getTime() + e.offset).toISOString(),
        ],
      );
    }

    const tokens = await authService.login({
      email: 'admin@audit.com',
      password: 'securepass123',
      practiceId,
    });
    accessToken = tokens.accessToken;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const authHeader = () => ({ Authorization: `Bearer ${accessToken}` });

  it('GET /api/audit returns events scoped to practice', async () => {
    const res = await app.request('/api/audit', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 5 events in our practice, 1 in other practice (excluded)
    expect(body.total).toBe(5);
    expect(body.events).toHaveLength(5);
  });

  it('does NOT return events from other practices', async () => {
    const res = await app.request('/api/audit', { headers: authHeader() });
    const body = await res.json();
    const otherPracticeEvents = body.events.filter(
      (e: { practice_id: string }) => e.practice_id === otherPracticeId,
    );
    expect(otherPracticeEvents).toHaveLength(0);
  });

  it('filters by entityType', async () => {
    const res = await app.request('/api/audit?entityType=appointment', { headers: authHeader() });
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.events[0].entity_type).toBe('appointment');
  });

  it('filters by action', async () => {
    const res = await app.request('/api/audit?action=create', { headers: authHeader() });
    const body = await res.json();
    // 1 patient create + 1 appointment create = 2 creates (the other-practice create is excluded)
    expect(body.total).toBe(2);
  });

  it('filters by actorType', async () => {
    const res = await app.request('/api/audit?actorType=local_agent', { headers: authHeader() });
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.events[0].actor_type).toBe('local_agent');
  });

  it('filters by entityId', async () => {
    const res = await app.request(`/api/audit?entityId=${patientId}`, { headers: authHeader() });
    const body = await res.json();
    expect(body.total).toBe(5);
  });

  it('respects pagination', async () => {
    const res = await app.request('/api/audit?limit=2&offset=0', { headers: authHeader() });
    const body = await res.json();
    expect(body.total).toBe(5);
    expect(body.events).toHaveLength(2);
  });

  it('orders events newest first', async () => {
    const res = await app.request('/api/audit', { headers: authHeader() });
    const body = await res.json();
    for (let i = 0; i < body.events.length - 1; i++) {
      expect(new Date(body.events[i].created_at).getTime())
        .toBeGreaterThanOrEqual(new Date(body.events[i + 1].created_at).getTime());
    }
  });

  it('GET /api/audit/entity/:entityType/:entityId returns full history', async () => {
    const res = await app.request(`/api/audit/entity/patient/${patientId}`, { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 4 patient events in our practice (create, update, access, local_agent access)
    expect(body.events).toHaveLength(4);
  });

  it('rejects users without reports:read permission', async () => {
    // Create a user with only patients:read
    const limitedRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Limited', $2, false) RETURNING id`,
      [practiceId, ['patients:read']],
    );
    await authService.createUser(practiceId, {
      email: 'limited@audit.com',
      password: 'securepass123',
      fullName: 'Limited User',
      roleIds: [limitedRole.rows[0].id],
      isProvider: false,
      serviceLineIds: [],
    });
    const tokens = await authService.login({
      email: 'limited@audit.com',
      password: 'securepass123',
      practiceId,
    });

    const res = await app.request('/api/audit', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated', async () => {
    const res = await app.request('/api/audit');
    expect(res.status).toBe(401);
  });
});
