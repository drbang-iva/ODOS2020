import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Clinical encounters (shell)', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let providerToken: string;
  let providerId: string;
  let patientId: string;
  let otherPatientId: string;
  let appointmentId: string;
  let serviceLineId: string;
  let appointmentTypeId: string;

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
      `INSERT INTO practices (name) VALUES ('Clinical Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    // Provider role with clinical read/write
    const providerRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Provider', $2, true) RETURNING id`,
      [
        practiceId,
        [
          'patients:read',
          'patients:write',
          'appointments:read',
          'appointments:write',
          'clinical:read',
          'clinical:write',
        ],
      ],
    );

    const provider = await authService.createUser(practiceId, {
      email: 'doc@clinical.com',
      password: 'securepass123',
      fullName: 'Dr. Clinical',
      roleIds: [providerRole.rows[0].id],
      isProvider: true,
      serviceLineIds: [],
    });
    providerId = provider.id;

    providerToken = (
      await authService.login({
        email: 'doc@clinical.com',
        password: 'securepass123',
        practiceId,
      })
    ).accessToken;

    // Two patients — second one is used to verify cross-patient rejection
    const p1 = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Clinical', 'Patient', '1990-01-01', 'F', '555-1000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Other', 'Patient', '1985-01-01', 'M', '555-1001', '200 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    otherPatientId = p2.rows[0].id;

    // Service line + appointment type + appointment for the "linked to appointment" test
    const sl = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color)
       VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
      [practiceId],
    );
    serviceLineId = sl.rows[0].id;

    const at = await pool.query(
      `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
       VALUES ($1, $2, 'Comp Exam', 'CE', '#2563EB', 3, 'Comp Exam', $3) RETURNING id`,
      [practiceId, serviceLineId, [serviceLineId]],
    );
    appointmentTypeId = at.rows[0].id;

    const apt = await pool.query(
      `INSERT INTO appointments (
        practice_id, patient_id, provider_id, appointment_type_id,
        service_line_id, start_time, duration_blocks, created_by
      ) VALUES ($1, $2, $3, $4, $5, '2026-04-15T14:00:00Z', 3, $3)
      RETURNING id`,
      [practiceId, patientId, providerId, appointmentTypeId, serviceLineId],
    );
    appointmentId = apt.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${providerToken}`,
  });

  describe('POST /api/clinical/encounters', () => {
    it('creates a draft encounter with valid inputs', async () => {
      const res = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          patientId,
          providerId,
          appointmentId,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe('draft');
      expect(body.patient_id).toBe(patientId);
      expect(body.provider_id).toBe(providerId);
      expect(body.appointment_id).toBe(appointmentId);
      expect(body.started_at).toBeDefined();
      expect(body.completed_at).toBeNull();
      expect(body.signed_at).toBeNull();
      expect(body.protocol_id).toBeNull();
    });

    it('creates a walk-in encounter with no appointment', async () => {
      const res = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          patientId,
          providerId,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.appointment_id).toBeNull();
    });

    it('accepts an optional protocolId for later specialty workflow attachment', async () => {
      const protocolId = '11111111-1111-1111-1111-111111111111';
      const res = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          patientId,
          providerId,
          protocolId,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.protocol_id).toBe(protocolId);
    });

    it('rejects nonexistent patient', async () => {
      const res = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          patientId: '00000000-0000-0000-0000-000000000000',
          providerId,
        }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects nonexistent provider', async () => {
      const res = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          patientId,
          providerId: '00000000-0000-0000-0000-000000000000',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects appointment that belongs to a different patient', async () => {
      const res = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          patientId: otherPatientId, // not the patient the appointment is for
          providerId,
          appointmentId,
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/clinical/encounters/:id', () => {
    let encounterId: string;

    beforeAll(async () => {
      const res = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ patientId, providerId }),
      });
      const body = await res.json();
      encounterId = body.id;
    });

    it('returns the encounter', async () => {
      const res = await app.request(`/api/clinical/encounters/${encounterId}`, {
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(encounterId);
    });

    it('returns 404 for missing encounter', async () => {
      const res = await app.request('/api/clinical/encounters/00000000-0000-0000-0000-000000000000', {
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/clinical/encounters (list)', () => {
    it('lists encounters with a total', async () => {
      const res = await app.request(`/api/clinical/encounters?patientId=${patientId}`, {
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBeGreaterThan(0);
      expect(Array.isArray(body.encounters)).toBe(true);
      expect(body.encounters.every((e: { patient_id: string }) => e.patient_id === patientId)).toBe(true);
    });

    it('filters by status=draft', async () => {
      const res = await app.request('/api/clinical/encounters?status=draft', {
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.encounters.every((e: { status: string }) => e.status === 'draft')).toBe(true);
    });
  });

  describe('POST /api/clinical/encounters/:id/sign', () => {
    it('signs a draft encounter, locking it with signed_by + signed_at + completed_at', async () => {
      const createRes = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ patientId, providerId }),
      });
      const { id } = await createRes.json();

      const signRes = await app.request(`/api/clinical/encounters/${id}/sign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(signRes.status).toBe(200);
      const body = await signRes.json();
      expect(body.status).toBe('signed');
      expect(body.signed_by).toBe(providerId);
      expect(body.signed_at).not.toBeNull();
      expect(body.completed_at).not.toBeNull();
    });

    it('rejects signing an already-signed encounter', async () => {
      const createRes = await app.request('/api/clinical/encounters', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ patientId, providerId }),
      });
      const { id } = await createRes.json();

      await app.request(`/api/clinical/encounters/${id}/sign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${providerToken}` },
      });

      const secondSign = await app.request(`/api/clinical/encounters/${id}/sign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(secondSign.status).toBe(400);
    });

    it('returns 404 for missing encounter', async () => {
      const res = await app.request('/api/clinical/encounters/00000000-0000-0000-0000-000000000000/sign', {
        method: 'POST',
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('multi-tenant isolation', () => {
    it('cannot see another practice\'s encounters', async () => {
      // Create another practice with its own encounter
      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other Practice') RETURNING id`,
      );
      const otherPracticeId = otherPractice.rows[0].id;

      const otherPatient = await pool.query(
        `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
         VALUES ($1, 'O', 'P', '1990-01-01', 'F', '555', '1 Main', 'X', 'OK', '73034') RETURNING id`,
        [otherPracticeId],
      );
      const otherProvider = await pool.query(
        `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
         VALUES ($1, 'other@o.com', 'h', 'Other Dr', true) RETURNING id`,
        [otherPracticeId],
      );

      const otherEnc = await pool.query(
        `INSERT INTO clinical_encounters (practice_id, patient_id, provider_id, created_by)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [otherPracticeId, otherPatient.rows[0].id, otherProvider.rows[0].id],
      );

      // Try to fetch it as the first practice's provider
      const res = await app.request(`/api/clinical/encounters/${otherEnc.rows[0].id}`, {
        headers: { Authorization: `Bearer ${providerToken}` },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('permissions', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await app.request('/api/clinical/encounters');
      expect(res.status).toBe(401);
    });

    it('rejects users without clinical:read', async () => {
      const limitedRole = await pool.query(
        `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
         VALUES ($1, 'Limited', $2, false) RETURNING id`,
        [practiceId, ['patients:read']],
      );
      await authService.createUser(practiceId, {
        email: 'limited@clinical.com',
        password: 'securepass123',
        fullName: 'Limited',
        roleIds: [limitedRole.rows[0].id],
        isProvider: false,
        serviceLineIds: [],
      });
      const tokens = await authService.login({
        email: 'limited@clinical.com',
        password: 'securepass123',
        practiceId,
      });

      const res = await app.request('/api/clinical/encounters', {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
