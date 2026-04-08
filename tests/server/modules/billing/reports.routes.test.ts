import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('Reports routes — AR aging', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let accessToken: string;
  let limitedAccessToken: string;
  let practiceId: string;
  let providerId: string;
  let patientId: string;
  let feeScheduleId: string;

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
      `INSERT INTO practices (name) VALUES ('Reports Routes Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    // Role with reports:read
    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [
        practiceId,
        [
          'admin:users',
          'admin:settings',
          'patients:read',
          'patients:write',
          'billing:read',
          'billing:submit',
          'reports:read',
        ],
      ],
    );
    const admin = await authService.createUser(practiceId, {
      email: 'admin@reports.com',
      password: 'securepass123',
      fullName: 'Admin',
      roleIds: [adminRole.rows[0].id],
      isProvider: true,
      serviceLineIds: [],
    });
    providerId = admin.id;
    accessToken = (
      await authService.login({
        email: 'admin@reports.com',
        password: 'securepass123',
        practiceId,
      })
    ).accessToken;

    // Role WITHOUT reports:read — used to verify 403
    const limitedRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'NoReports', $2, false) RETURNING id`,
      [practiceId, ['patients:read', 'billing:read']],
    );
    await authService.createUser(practiceId, {
      email: 'limited@reports.com',
      password: 'securepass123',
      fullName: 'Limited',
      roleIds: [limitedRole.rows[0].id],
      isProvider: false,
      serviceLineIds: [],
    });
    limitedAccessToken = (
      await authService.login({
        email: 'limited@reports.com',
        password: 'securepass123',
        practiceId,
      })
    ).accessToken;

    // Patient
    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Report', 'Patient', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = patient.rows[0].id;

    // Fee schedule + one CPT
    const fs = await pool.query(
      `INSERT INTO fee_schedules (practice_id, name, is_default)
       VALUES ($1, 'Default', true) RETURNING id`,
      [practiceId],
    );
    feeScheduleId = fs.rows[0].id;
    await pool.query(
      `INSERT INTO fee_schedule_items (fee_schedule_id, cpt_code, amount_cents)
       VALUES ($1, '92004', 22500)`,
      [feeScheduleId],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });

  async function seedCharge(serviceDate: string) {
    const res = await app.request('/api/billing/charges', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        patientId,
        providerId,
        serviceDate,
        cptCode: '92004',
        units: 1,
        icd10Codes: [],
      }),
    });
    return res.json();
  }

  it('GET /api/billing/reports/ar-aging returns all 6 buckets', async () => {
    const res = await app.request('/api/billing/reports/ar-aging', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buckets).toHaveLength(6);
    expect(body.buckets.map((b: { bucket: string }) => b.bucket)).toEqual([
      'current', '0-30', '31-60', '61-90', '91-120', '120+',
    ]);
  });

  it('GET /api/billing/reports/ar-aging reflects overdue charges', async () => {
    await seedCharge(daysAgo(45)); // 31-60 bucket

    const res = await app.request('/api/billing/reports/ar-aging', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json();
    const bucket = body.buckets.find((b: { bucket: string }) => b.bucket === '31-60');
    expect(bucket.chargeCount).toBeGreaterThanOrEqual(1);
    expect(bucket.balanceCents).toBeGreaterThanOrEqual(22500);
  });

  it('GET /api/billing/reports/ar-aging/details returns per-charge rows', async () => {
    await seedCharge(daysAgo(75));

    const res = await app.request('/api/billing/reports/ar-aging/details', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows[0].patientFirstName).toBeDefined();
    expect(body.rows[0].balanceCents).toBeGreaterThan(0);
  });

  it('GET /api/billing/reports/ar-aging/details?bucket=61-90 filters', async () => {
    const res = await app.request(
      '/api/billing/reports/ar-aging/details?bucket=61-90',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const row of body.rows) {
      expect(row.bucket).toBe('61-90');
    }
  });

  it('rejects users without reports:read permission', async () => {
    const res = await app.request('/api/billing/reports/ar-aging', {
      headers: { Authorization: `Bearer ${limitedAccessToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.request('/api/billing/reports/ar-aging');
    expect(res.status).toBe(401);
  });

  describe('GET /revenue-by-provider', () => {
    it('returns per-provider aggregation for the date range', async () => {
      // Seed a charge on a known service date so the report has something to aggregate
      await seedCharge('2026-03-15');

      const res = await app.request(
        '/api/billing/reports/revenue-by-provider?startDate=2026-01-01&endDate=2026-12-31',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.providers).toBeDefined();
      expect(body.totals).toBeDefined();
      // The admin test user is the provider on the seeded charge
      expect(body.providers.length).toBeGreaterThanOrEqual(1);
      expect(body.totals.totalChargedCents).toBeGreaterThanOrEqual(22500);
    });

    it('rejects missing startDate', async () => {
      const res = await app.request(
        '/api/billing/reports/revenue-by-provider?endDate=2026-12-31',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      expect(res.status).toBe(400);
    });

    it('rejects malformed date', async () => {
      const res = await app.request(
        '/api/billing/reports/revenue-by-provider?startDate=2026-01&endDate=2026-12-31',
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      expect(res.status).toBe(400);
    });

    it('rejects users without reports:read permission', async () => {
      const res = await app.request(
        '/api/billing/reports/revenue-by-provider?startDate=2026-01-01&endDate=2026-12-31',
        { headers: { Authorization: `Bearer ${limitedAccessToken}` } },
      );
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated requests', async () => {
      const res = await app.request(
        '/api/billing/reports/revenue-by-provider?startDate=2026-01-01&endDate=2026-12-31',
      );
      expect(res.status).toBe(401);
    });
  });
});
