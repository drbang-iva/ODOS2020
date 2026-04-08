import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Equipment routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let otherPracticeId: string;
  let accessToken: string;
  let patientId: string;

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
      `INSERT INTO practices (name) VALUES ('Equipment Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const other = await pool.query(
      `INSERT INTO practices (name) VALUES ('Other Practice') RETURNING id`,
    );
    otherPracticeId = other.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [
        practiceId,
        ['admin:users', 'admin:settings', 'clinical:read', 'clinical:write', 'patients:read', 'patients:write'],
      ],
    );

    await authService.createUser(practiceId, {
      email: 'admin@equip.com',
      password: 'securepass123',
      fullName: 'Admin',
      roleIds: [adminRole.rows[0].id],
      isProvider: false,
      serviceLineIds: [],
    });

    const tokens = await authService.login({
      email: 'admin@equip.com',
      password: 'securepass123',
      practiceId,
    });
    accessToken = tokens.accessToken;

    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Test', 'Patient', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = patient.rows[0].id;

    // Seed an equipment in the OTHER practice — must not be visible
    await pool.query(
      `INSERT INTO equipment_registry (practice_id, name, manufacturer, model, device_category, integration_type)
       VALUES ($1, 'Other OCT', 'Zeiss', 'Cirrus 5000', 'oct', 'dicom')`,
      [otherPracticeId],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });

  describe('equipment CRUD', () => {
    let equipmentId: string;

    it('POST creates equipment', async () => {
      const res = await app.request('/api/equipment', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'Main OCT',
          manufacturer: 'Zeiss',
          model: 'Cirrus 6000',
          deviceCategory: 'oct',
          integrationType: 'dicom',
          connectionConfig: { aeTitle: 'OSOD', port: 11112 },
          location: 'Exam Room 1',
          dataTypes: ['retina', 'nerve', 'anterior'],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Main OCT');
      expect(body.device_category).toBe('oct');
      expect(body.is_active).toBe(true);
      equipmentId = body.id;
    });

    it('GET lists equipment scoped to practice', async () => {
      const res = await app.request('/api/equipment', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.equipment).toHaveLength(1);
      expect(body.equipment[0].name).toBe('Main OCT');
      // Verify isolation from other practice
      expect(body.equipment.every((e: { practice_id: string }) => e.practice_id === practiceId)).toBe(true);
    });

    it('GET filters by deviceCategory', async () => {
      // Seed a second device of a different category
      await app.request('/api/equipment', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'HFA',
          manufacturer: 'Zeiss',
          model: 'Humphrey 3',
          deviceCategory: 'visual_field',
          integrationType: 'folder_watch',
        }),
      });

      const res = await app.request('/api/equipment?deviceCategory=oct', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json();
      expect(body.equipment).toHaveLength(1);
      expect(body.equipment[0].device_category).toBe('oct');
    });

    it('GET /:id returns equipment', async () => {
      const res = await app.request(`/api/equipment/${equipmentId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(equipmentId);
    });

    it('GET /:id returns 404 for missing', async () => {
      const res = await app.request('/api/equipment/00000000-0000-0000-0000-000000000000', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(404);
    });

    it('PATCH updates equipment', async () => {
      const res = await app.request(`/api/equipment/${equipmentId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ location: 'Exam Room 2', parserId: 'zeiss-oct-v1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.location).toBe('Exam Room 2');
      expect(body.parser_id).toBe('zeiss-oct-v1');
    });

    it('DELETE deactivates equipment', async () => {
      const res = await app.request(`/api/equipment/${equipmentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.is_active).toBe(false);
    });

    it('GET excludes inactive by default', async () => {
      const res = await app.request('/api/equipment', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json();
      expect(body.equipment.every((e: { is_active: boolean }) => e.is_active)).toBe(true);
    });

    it('GET includeInactive=true returns deactivated equipment', async () => {
      const res = await app.request('/api/equipment?includeInactive=true', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json();
      expect(body.equipment.some((e: { is_active: boolean }) => !e.is_active)).toBe(true);
    });

    it('rejects invalid deviceCategory', async () => {
      const res = await app.request('/api/equipment', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'Weird',
          manufacturer: 'X',
          model: 'Y',
          deviceCategory: 'not_a_category',
          integrationType: 'manual',
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('device readings', () => {
    let equipmentId: string;

    beforeAll(async () => {
      const res = await app.request('/api/equipment', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'Reading Test Device',
          manufacturer: 'Topcon',
          model: 'Maestro 2',
          deviceCategory: 'oct',
          integrationType: 'dicom',
        }),
      });
      const body = await res.json();
      equipmentId = body.id;
    });

    it('POST creates a reading', async () => {
      const res = await app.request('/api/equipment/readings', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          equipmentId,
          patientId,
          matchedBy: 'manual',
          readingType: 'oct_macula',
          structuredData: { od_thickness: 260, os_thickness: 265 },
          sourceType: 'manual',
          capturedAt: new Date().toISOString(),
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.equipment_id).toBe(equipmentId);
      expect(body.patient_id).toBe(patientId);
      expect(body.reading_type).toBe('oct_macula');
      expect(body.needs_review).toBe(false);
    });

    it('POST rejects reading for equipment in another practice', async () => {
      const otherEquip = await pool.query(
        `INSERT INTO equipment_registry (practice_id, name, manufacturer, model, device_category, integration_type)
         VALUES ($1, 'Foreign Device', 'X', 'Y', 'oct', 'manual') RETURNING id`,
        [otherPracticeId],
      );

      const res = await app.request('/api/equipment/readings', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          equipmentId: otherEquip.rows[0].id,
          readingType: 'oct_macula',
          sourceType: 'manual',
          capturedAt: new Date().toISOString(),
        }),
      });
      expect(res.status).toBe(404);
    });

    it('GET /readings lists with filters', async () => {
      // Create one that needs review
      await app.request('/api/equipment/readings', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          equipmentId,
          readingType: 'oct_nerve',
          sourceType: 'folder_watch',
          needsReview: true,
          capturedAt: new Date().toISOString(),
        }),
      });

      const res = await app.request('/api/equipment/readings?needsReview=true', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.readings.length).toBeGreaterThan(0);
      expect(body.readings.every((r: { needs_review: boolean }) => r.needs_review)).toBe(true);
    });

    it('GET /readings filters by patientId', async () => {
      const res = await app.request(`/api/equipment/readings?patientId=${patientId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await res.json();
      expect(body.readings.every((r: { patient_id: string | null }) => r.patient_id === patientId)).toBe(true);
    });

    it('POST /readings/:id/review marks as reviewed and assigns patient', async () => {
      // Create an unassigned reading
      const unassigned = await app.request('/api/equipment/readings', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          equipmentId,
          readingType: 'unassigned_test',
          sourceType: 'folder_watch',
          needsReview: true,
          capturedAt: new Date().toISOString(),
        }),
      });
      const { id } = await unassigned.json();

      const res = await app.request(`/api/equipment/readings/${id}/review`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ patientId }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.needs_review).toBe(false);
      expect(body.patient_id).toBe(patientId);
      expect(body.matched_by).toBe('manual');
      expect(body.reviewed_by).not.toBeNull();
      expect(body.reviewed_at).not.toBeNull();
    });
  });

  describe('permissions', () => {
    it('rejects equipment admin without admin:settings', async () => {
      const limitedRole = await pool.query(
        `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
         VALUES ($1, 'Limited', $2, false) RETURNING id`,
        [practiceId, ['patients:read']],
      );
      await authService.createUser(practiceId, {
        email: 'limited@equip.com',
        password: 'securepass123',
        fullName: 'Limited',
        roleIds: [limitedRole.rows[0].id],
        isProvider: false,
        serviceLineIds: [],
      });
      const tokens = await authService.login({
        email: 'limited@equip.com',
        password: 'securepass123',
        practiceId,
      });

      const res = await app.request('/api/equipment', {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated', async () => {
      const res = await app.request('/api/equipment');
      expect(res.status).toBe(401);
    });
  });

  describe('domain events (end-to-end via app)', () => {
    it('equipment.registered writes an audit event with newState', async () => {
      const res = await app.request('/api/equipment', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'Event Test OCT',
          manufacturer: 'Zeiss',
          model: 'Cirrus 5000',
          deviceCategory: 'oct',
          integrationType: 'dicom',
        }),
      });
      const body = await res.json();

      const audit = await pool.query(
        `SELECT metadata, new_state FROM audit_events
         WHERE entity_type = 'equipment' AND entity_id = $1`,
        [body.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].metadata.eventType).toBe('equipment.registered');
      expect(audit.rows[0].new_state.name).toBe('Event Test OCT');
    });

    it('device.reading_received + device.reading_matched emit when a reading lands already matched', async () => {
      // Register a device
      const eqRes = await app.request('/api/equipment', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'MWL Device',
          manufacturer: 'Topcon',
          model: 'Maestro 2',
          deviceCategory: 'oct',
          integrationType: 'dicom',
        }),
      });
      const eq = await eqRes.json();

      // Create a reading that's already matched (simulating MWL)
      const readingRes = await app.request('/api/equipment/readings', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          equipmentId: eq.id,
          patientId,
          matchedBy: 'mwl',
          readingType: 'oct_macula',
          structuredData: { od: 260, os: 265 },
          sourceType: 'dicom',
          capturedAt: new Date().toISOString(),
        }),
      });
      const reading = await readingRes.json();

      const audit = await pool.query(
        `SELECT metadata FROM audit_events
         WHERE entity_id = $1 AND entity_type = 'device_reading'
         ORDER BY created_at ASC`,
        [reading.id],
      );
      // Should have BOTH received + matched events
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows[0].metadata.eventType).toBe('device.reading_received');
      expect(audit.rows[1].metadata.eventType).toBe('device.reading_matched');
      expect(audit.rows[1].metadata.payload.matchedBy).toBe('mwl');
    });
  });
});
