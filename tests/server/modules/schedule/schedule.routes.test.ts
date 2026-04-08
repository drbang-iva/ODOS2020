import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Schedule routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let accessToken: string;
  let providerId: string;
  let patientId: string;
  let compExamTypeId: string;
  let eyecareSlId: string;

  const MONDAY = '2026-04-13';

  beforeAll(async () => {
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

    const practice = await pool.query(
      `INSERT INTO practices (name, schedule_block_minutes, timezone)
       VALUES ('Route Test', 15, 'America/Chicago') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const sl = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color)
       VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
      [practiceId],
    );
    eyecareSlId = sl.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [
        practiceId,
        [
          'admin:users',
          'patients:read',
          'patients:write',
          'appointments:read',
          'appointments:write',
        ],
      ],
    );
    const adminRoleId = adminRole.rows[0].id;

    const user = await authService.createUser(practiceId, {
      email: 'doc@route.com',
      password: 'securepass123',
      fullName: 'Dr. Route',
      roleIds: [adminRoleId],
      isProvider: true,
      serviceLineIds: [eyecareSlId],
    });
    providerId = user.id;

    const tokens = await authService.login({
      email: 'doc@route.com',
      password: 'securepass123',
      practiceId,
    });
    accessToken = tokens.accessToken;

    // Provider schedule Mon 08:00-12:00 + 13:00-17:00
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, 1, '08:00', '12:00', $2)`,
      [providerId, eyecareSlId],
    );
    await pool.query(
      `INSERT INTO provider_schedules (provider_id, day_of_week, start_time, end_time, service_line_id)
       VALUES ($1, 1, '13:00', '17:00', $2)`,
      [providerId, eyecareSlId],
    );

    const compExam = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
       VALUES ($1, $2, 'Comp Exam', 'CE', '#2563EB', 3, 'Comp Exam', $3) RETURNING id`,
      [practiceId, eyecareSlId, [eyecareSlId]],
    );
    compExamTypeId = compExam.rows[0].id;

    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Route', 'Patient', '1990-01-01', 'F', '555-0001', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = patient.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('GET /api/schedule/slots returns available slots', async () => {
    const res = await app.request(
      `/api/schedule/slots?providerId=${providerId}&date=${MONDAY}&appointmentTypeId=${compExamTypeId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots[0].startTime).toBeDefined();
    expect(body.slots[0].durationBlocks).toBe(3);
  });

  it('GET /api/schedule/grid returns grid with working hours', async () => {
    const res = await app.request(
      `/api/schedule/grid?providerId=${providerId}&date=${MONDAY}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workingHours).toHaveLength(2);
    expect(body.slots.length).toBeGreaterThan(0);
  });

  it('POST /api/schedule/appointments creates an appointment', async () => {
    const res = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T10:00:00.000Z`,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe('scheduled');
  });

  it('POST /api/schedule/appointments returns 409 for conflicts', async () => {
    const res = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T10:00:00.000Z`, // same as previous test
      }),
    });
    expect(res.status).toBe(409);
  });

  it('GET /api/schedule/appointments/:id returns the appointment', async () => {
    const createRes = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T11:00:00.000Z`,
      }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/schedule/appointments/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
  });

  it('POST /api/schedule/appointments/:id/status transitions status', async () => {
    const createRes = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T14:00:00.000Z`,
      }),
    });
    const { id } = await createRes.json();

    const confirmRes = await app.request(`/api/schedule/appointments/${id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(confirmRes.status).toBe(200);
    const body = await confirmRes.json();
    expect(body.status).toBe('confirmed');
  });

  it('POST /api/schedule/appointments/:id/cancel cancels with reason', async () => {
    const createRes = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T15:00:00.000Z`,
      }),
    });
    const { id } = await createRes.json();

    const cancelRes = await app.request(`/api/schedule/appointments/${id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ reason: 'Patient cancelled' }),
    });
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json();
    expect(body.status).toBe('cancelled');
    expect(body.cancelled_reason).toBe('Patient cancelled');
  });

  it('PATCH /api/schedule/appointments/:id reschedules', async () => {
    const createRes = await app.request('/api/schedule/appointments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        patientId,
        providerId,
        appointmentTypeId: compExamTypeId,
        serviceLineId: eyecareSlId,
        startTime: `${MONDAY}T08:00:00.000Z`,
      }),
    });
    const { id } = await createRes.json();

    const updateRes = await app.request(`/api/schedule/appointments/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ startTime: `${MONDAY}T08:45:00.000Z` }),
    });
    expect(updateRes.status).toBe(200);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.request(
      `/api/schedule/slots?providerId=${providerId}&date=${MONDAY}&appointmentTypeId=${compExamTypeId}`,
    );
    expect(res.status).toBe(401);
  });
});
