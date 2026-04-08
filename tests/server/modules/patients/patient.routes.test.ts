import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Patient routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let accessToken: string;

  const sampleBody = {
    firstName: 'Jane',
    lastName: 'Doe',
    dateOfBirth: '1990-06-15',
    sex: 'F',
    phonePrimary: '555-0100',
    addressLine1: '100 Main St',
    city: 'Edmond',
    state: 'OK',
    zip: '73034',
  };

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
      `INSERT INTO practices (name) VALUES ('Patient Routes Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [
        practiceId,
        [
          'admin:users',
          'patients:read',
          'patients:write',
          'patients:delete',
          'appointments:read',
          'appointments:write',
        ],
      ],
    );

    await authService.createUser(practiceId, {
      email: 'admin@test.com',
      password: 'securepass123',
      fullName: 'Admin',
      roleIds: [adminRole.rows[0].id],
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

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });

  it('POST /api/patients creates a patient', async () => {
    const res = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(sampleBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.first_name).toBe('Jane');
  });

  it('GET /api/patients lists patients', async () => {
    const res = await app.request('/api/patients', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.patients)).toBe(true);
    expect(body.total).toBeGreaterThan(0);
  });

  it('GET /api/patients?q=Jane filters by search query', async () => {
    const res = await app.request('/api/patients?q=Jane', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patients.length).toBeGreaterThan(0);
    expect(body.patients[0].first_name).toBe('Jane');
  });

  it('GET /api/patients/:id returns a patient', async () => {
    const createRes = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Bob', lastName: 'Smith' }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/patients/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.first_name).toBe('Bob');
  });

  it('GET /api/patients/:id returns 404 for missing patient', async () => {
    const res = await app.request('/api/patients/00000000-0000-0000-0000-000000000000', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(404);
  });

  it('PATCH /api/patients/:id updates a patient', async () => {
    const createRes = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Carol' }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/patients/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ email: 'carol@example.com', hobbies: ['running'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe('carol@example.com');
    expect(body.hobbies).toEqual(['running']);
  });

  it('DELETE /api/patients/:id deactivates', async () => {
    const createRes = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Deleteme' }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/patients/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is_active).toBe(false);
  });

  it('POST /api/patients/:id/insurance adds insurance', async () => {
    const createRes = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Insured' }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/patients/${id}/insurance`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        priority: 1,
        planType: 'vision',
        payerName: 'VSP',
        memberId: 'MEM001',
        subscriberRelationship: 'self',
        effectiveDate: '2026-01-01',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.payer_name).toBe('VSP');
  });

  it('GET /api/patients/:id/insurance lists insurance', async () => {
    const createRes = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'ListIns' }),
    });
    const { id } = await createRes.json();

    await app.request(`/api/patients/${id}/insurance`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        priority: 1,
        planType: 'medical',
        payerName: 'Aetna',
        memberId: 'AET001',
        subscriberRelationship: 'self',
        effectiveDate: '2026-01-01',
      }),
    });

    const res = await app.request(`/api/patients/${id}/insurance`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insurance).toHaveLength(1);
  });

  it('POST /api/patients/:id/responsible-parties links guardian', async () => {
    const minor = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Kid', dateOfBirth: '2015-01-01' }),
    });
    const { id: minorId } = await minor.json();

    const parent = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Parent', dateOfBirth: '1985-01-01' }),
    });
    const { id: parentId } = await parent.json();

    const res = await app.request(`/api/patients/${minorId}/responsible-parties`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        responsiblePartyPatientId: parentId,
        relationship: 'parent',
        isFinancialResponsible: true,
        isConsentAuthority: true,
        isInsuranceSubscriber: true,
        isPrimary: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.relationship).toBe('parent');
  });

  it('POST /api/patients/:id/alerts creates an alert', async () => {
    const createRes = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Alert' }),
    });
    const { id } = await createRes.json();

    const res = await app.request(`/api/patients/${id}/alerts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        alertType: 'allergy',
        severity: 'critical',
        message: 'Penicillin allergy',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.severity).toBe('critical');
  });

  it('POST /api/patients/:id/alerts/:alertId/resolve resolves an alert', async () => {
    const createRes = await app.request('/api/patients', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ ...sampleBody, firstName: 'Resolve' }),
    });
    const { id } = await createRes.json();

    const alertRes = await app.request(`/api/patients/${id}/alerts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        alertType: 'balance', severity: 'warning', message: 'Balance',
      }),
    });
    const { id: alertId } = await alertRes.json();

    const res = await app.request(`/api/patients/${id}/alerts/${alertId}/resolve`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is_resolved).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.request('/api/patients');
    expect(res.status).toBe(401);
  });
});
