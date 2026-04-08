import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createApp } from '../../../../src/server/app.js';
import { parseConfig } from '../../../../src/server/config/index.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('Catalog routes', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>['app'];
  let authService: ReturnType<typeof createApp>['authService'];
  let practiceId: string;
  let serviceLineId: string;
  let accessToken: string;
  let libraryItemId: string;

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
      `INSERT INTO practices (name) VALUES ('Catalog Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const sl = await pool.query(
      `INSERT INTO service_lines (practice_id, name, color)
       VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
      [practiceId],
    );
    serviceLineId = sl.rows[0].id;

    const adminRole = await pool.query(
      `INSERT INTO user_roles (practice_id, name, permission_set, is_system)
       VALUES ($1, 'Admin', $2, true) RETURNING id`,
      [practiceId, ['admin:settings', 'admin:users']],
    );

    await authService.createUser(practiceId, {
      email: 'admin@cat.com',
      password: 'securepass123',
      fullName: 'Admin',
      roleIds: [adminRole.rows[0].id],
      isProvider: false,
      serviceLineIds: [],
    });

    const tokens = await authService.login({
      email: 'admin@cat.com',
      password: 'securepass123',
      practiceId,
    });
    accessToken = tokens.accessToken;

    // Seed a system body area for body-area tests
    await pool.query(
      `INSERT INTO body_area_modifiers (name, short_code, duration_adjustment_minutes, is_system)
       VALUES ('Face', 'FACE', 0, true)`,
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });

  describe('treatment library', () => {
    it('POST creates a library item', async () => {
      const res = await app.request('/api/catalog/library', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          standardName: 'Comprehensive Exam — New Patient',
          category: 'Routine Examinations',
          typicalDurationMinutes: 45,
          cptCodes: ['99203', '92004'],
          equipmentTags: ['phoropter', 'slit_lamp'],
          providerScope: ['Provider'],
          serviceLines: ['eyecare'],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.standard_name).toBe('Comprehensive Exam — New Patient');
      libraryItemId = body.id;
    });

    it('GET lists library items', async () => {
      const res = await app.request('/api/catalog/library', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);
    });

    it('GET filters by category', async () => {
      const res = await app.request('/api/catalog/library?category=Routine%20Examinations', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].category).toBe('Routine Examinations');
    });

    it('GET filters by service line', async () => {
      const res = await app.request('/api/catalog/library?serviceLine=eyecare', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);
    });

    it('PATCH updates library item', async () => {
      const res = await app.request(`/api/catalog/library/${libraryItemId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ typicalDurationMinutes: 60 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.typical_duration_minutes).toBe(60);
    });

    it('POST /library/bulk inserts many items in one transaction', async () => {
      const res = await app.request('/api/catalog/library/bulk', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          items: [
            {
              standardName: 'Bulk Test Treatment 1',
              category: 'Test Category',
              typicalDurationMinutes: 30,
              cptCodes: ['11111'],
              equipmentTags: [],
              providerScope: ['Provider'],
              serviceLines: ['eyecare'],
              bodyAreaModifiersAvailable: false,
              consentRequired: false,
              isBillable: true,
              defaultColor: '#000000',
            },
            {
              standardName: 'Bulk Test Treatment 2',
              category: 'Test Category',
              typicalDurationMinutes: 45,
              cptCodes: ['22222'],
              equipmentTags: ['oct'],
              providerScope: ['Provider', 'Tech'],
              serviceLines: ['eyecare'],
              bodyAreaModifiersAvailable: false,
              consentRequired: false,
              isBillable: true,
              defaultColor: '#000000',
            },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);

      // Verify items are visible via the list endpoint
      const listRes = await app.request('/api/catalog/library?category=Test%20Category', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const listBody = await listRes.json();
      expect(listBody.items.length).toBe(2);
    });

    it('POST /library/bulk rejects empty items array', async () => {
      const res = await app.request('/api/catalog/library/bulk', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ items: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /library/bulk rejects bulk over 1000 items', async () => {
      const items = Array.from({ length: 1001 }, (_, i) => ({
        standardName: `T${i}`,
        category: 'Bulk',
        typicalDurationMinutes: 15,
        cptCodes: [],
        equipmentTags: [],
        providerScope: [],
        serviceLines: [],
        bodyAreaModifiersAvailable: false,
        consentRequired: false,
        isBillable: true,
        defaultColor: '#000000',
      }));
      const res = await app.request('/api/catalog/library/bulk', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ items }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('body area modifiers', () => {
    it('GET lists system + practice body areas', async () => {
      const res = await app.request('/api/catalog/body-areas', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bodyAreas.length).toBeGreaterThan(0);
      expect(body.bodyAreas.some((b: { name: string }) => b.name === 'Face')).toBe(true);
    });

    let customBodyAreaId: string;

    it('POST creates practice-specific body area', async () => {
      const res = await app.request('/api/catalog/body-areas', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          name: 'Custom Region',
          shortCode: 'CR',
          durationAdjustmentMinutes: 10,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Custom Region');
      expect(body.is_system).toBe(false);
      customBodyAreaId = body.id;
    });

    it('PATCH updates practice body area', async () => {
      const res = await app.request(`/api/catalog/body-areas/${customBodyAreaId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ durationAdjustmentMinutes: 20 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.duration_adjustment_minutes).toBe(20);
    });

    it('PATCH rejects modifying system body area', async () => {
      const sysArea = await pool.query(
        `SELECT id FROM body_area_modifiers WHERE is_system = true LIMIT 1`,
      );
      const res = await app.request(`/api/catalog/body-areas/${sysArea.rows[0].id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(400);
    });

    it('POST /body-areas/bulk inserts many practice body areas in one transaction', async () => {
      const res = await app.request('/api/catalog/body-areas/bulk', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          items: [
            { name: 'Bulk Area 1', shortCode: 'BA1', durationAdjustmentMinutes: 5, additionalEquipmentTags: [], additionalConsent: false },
            { name: 'Bulk Area 2', shortCode: 'BA2', durationAdjustmentMinutes: 10, additionalEquipmentTags: ['ipl'], additionalConsent: true },
            { name: 'Bulk Area 3', shortCode: 'BA3', durationAdjustmentMinutes: 0, additionalEquipmentTags: [], additionalConsent: false },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(3);

      // Verify they show up in the practice's body area list
      const listRes = await app.request('/api/catalog/body-areas', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const listBody = await listRes.json();
      const bulkNames = listBody.bodyAreas
        .filter((b: { is_system: boolean }) => !b.is_system)
        .map((b: { name: string }) => b.name);
      expect(bulkNames).toContain('Bulk Area 1');
      expect(bulkNames).toContain('Bulk Area 2');
      expect(bulkNames).toContain('Bulk Area 3');
    });

    it('POST /body-areas/bulk all inserted rows have is_system=false', async () => {
      const res = await app.request('/api/catalog/body-areas/bulk', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          items: [
            { name: 'NonSystemA', shortCode: 'NSA', durationAdjustmentMinutes: 0, additionalEquipmentTags: [], additionalConsent: false },
          ],
        }),
      });
      expect(res.status).toBe(201);

      const check = await pool.query(
        `SELECT is_system FROM body_area_modifiers WHERE name = 'NonSystemA'`,
      );
      expect(check.rows).toHaveLength(1);
      expect(check.rows[0].is_system).toBe(false);
    });
  });

  describe('appointment types', () => {
    let customAptId: string;

    it('POST creates a custom appointment type', async () => {
      const res = await app.request('/api/catalog/appointment-types', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          serviceLineId,
          name: 'Custom Visit',
          shortName: 'CV',
          color: '#FF0000',
          durationBlocks: 2,
          isCustom: true,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('Custom Visit');
      expect(body.is_custom).toBe(true);
      customAptId = body.id;
    });

    it('POST /from-library clones a library item with custom display name', async () => {
      const res = await app.request('/api/catalog/appointment-types/from-library', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          libraryId: libraryItemId,
          serviceLineId,
          displayName: 'IVA Comprehensive Exam',
          shortName: 'IVA-CE',
          durationBlocks: 4,
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.display_name).toBe('IVA Comprehensive Exam');
      expect(body.library_id).toBe(libraryItemId);
      // CPT codes should come from the library item
      expect(body.cpt_codes).toContain('99203');
    });

    it('GET lists appointment types', async () => {
      const res = await app.request('/api/catalog/appointment-types', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.appointmentTypes.length).toBeGreaterThan(0);
    });

    it('PATCH updates appointment type', async () => {
      const res = await app.request(`/api/catalog/appointment-types/${customAptId}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ displayName: 'Renamed Visit', priceCents: 15000 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.display_name).toBe('Renamed Visit');
      expect(body.price_cents).toBe(15000);
    });

    it('DELETE deactivates appointment type', async () => {
      const res = await app.request(`/api/catalog/appointment-types/${customAptId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.is_active).toBe(false);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await app.request('/api/catalog/library');
    expect(res.status).toBe(401);
  });
});
