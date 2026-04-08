import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('002_schema_v2 migration', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    // Reset test DB
    const setupPool = new pg.Pool({ connectionString: TEST_DB_URL });
    await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setupPool.end();

    // Run all migrations (001 + 002)
    await runMigrations(TEST_DB_URL);

    // Create main test pool
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  // ---- Task 1: Patient Schema Additions ----

  it('patients table has all 10 new columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'patients'
      AND column_name IN (
        'middle_name', 'ssn_encrypted', 'employer', 'occupation',
        'hobbies', 'referring_provider', 'referring_provider_npi',
        'preferred_pharmacy_npi', 'race', 'ethnicity'
      )
      ORDER BY column_name
    `);
    expect(result.rows.length).toBe(10);
  });

  it('can insert a patient with new fields', async () => {
    // Need a practice first
    const practice = await pool.query(
      "INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id"
    );
    const practiceId = practice.rows[0].id;

    const result = await pool.query(`
      INSERT INTO patients (
        practice_id, first_name, last_name, middle_name, date_of_birth, sex,
        phone_primary, address_line1, city, state, zip,
        ssn_encrypted, employer, occupation, hobbies,
        referring_provider, referring_provider_npi, preferred_pharmacy_npi,
        race, ethnicity
      ) VALUES (
        $1, 'Jane', 'Doe', 'Marie', '1990-05-15', 'F',
        '555-1234', '123 Main St', 'Austin', 'TX', '78701',
        'encrypted_ssn_value', 'Acme Corp', 'Engineer',
        ARRAY['reading', 'cycling'],
        'Dr. Smith', '1234567890', '9876543210',
        'White', 'Not Hispanic'
      ) RETURNING id, middle_name, employer, hobbies
    `, [practiceId]);

    expect(result.rows[0].middle_name).toBe('Marie');
    expect(result.rows[0].employer).toBe('Acme Corp');
    expect(result.rows[0].hobbies).toEqual(['reading', 'cycling']);
  });

  // ---- Task 2: Responsible Parties ----

  it('responsible_parties table exists with correct columns', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'responsible_parties'
      ORDER BY column_name
    `);
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toContain('patient_id');
    expect(columns).toContain('responsible_party_patient_id');
    expect(columns).toContain('relationship');
    expect(columns).toContain('is_financial_responsible');
    expect(columns).toContain('is_consent_authority');
    expect(columns).toContain('is_insurance_subscriber');
    expect(columns).toContain('insurance_subscriber_id');
    expect(columns).toContain('is_primary');
    expect(columns).toContain('court_order_notes');
    expect(columns).toContain('effective_date');
    expect(columns).toContain('end_date');
  });

  it('enforces relationship check constraint — valid parent works', async () => {
    // Get a patient
    const patient = await pool.query('SELECT id FROM patients LIMIT 1');
    const patientId = patient.rows[0].id;

    const result = await pool.query(`
      INSERT INTO responsible_parties (patient_id, relationship, is_financial_responsible, is_consent_authority)
      VALUES ($1, 'parent', true, true)
      RETURNING id
    `, [patientId]);
    expect(result.rows[0].id).toBeDefined();
  });

  it('enforces relationship check constraint — invalid uncle fails', async () => {
    const patient = await pool.query('SELECT id FROM patients LIMIT 1');
    const patientId = patient.rows[0].id;

    await expect(
      pool.query(`
        INSERT INTO responsible_parties (patient_id, relationship)
        VALUES ($1, 'uncle')
      `, [patientId])
    ).rejects.toThrow();
  });

  // ---- Task 3: Permission Model ----

  it('user_roles and user_role_assignments tables exist', async () => {
    const roles = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_roles'
    `);
    expect(roles.rows.length).toBeGreaterThan(0);

    const assignments = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_role_assignments'
    `);
    expect(assignments.rows.length).toBeGreaterThan(0);
  });

  it('user can have multiple roles with union of permissions', async () => {
    const practice = await pool.query('SELECT id FROM practices LIMIT 1');
    const practiceId = practice.rows[0].id;

    // Create user Hannah (role is now nullable)
    const user = await pool.query(`
      INSERT INTO users (practice_id, email, full_name, is_provider)
      VALUES ($1, 'hannah@iva.com', 'Hannah Tech', false)
      RETURNING id
    `, [practiceId]);
    const userId = user.rows[0].id;

    // Create 3 roles
    const role1 = await pool.query(`
      INSERT INTO user_roles (practice_id, name, permission_set)
      VALUES ($1, 'front_desk', ARRAY['schedule:read', 'schedule:write', 'patient:read'])
      RETURNING id
    `, [practiceId]);

    const role2 = await pool.query(`
      INSERT INTO user_roles (practice_id, name, permission_set)
      VALUES ($1, 'billing_clerk', ARRAY['billing:read', 'billing:write'])
      RETURNING id
    `, [practiceId]);

    const role3 = await pool.query(`
      INSERT INTO user_roles (practice_id, name, permission_set)
      VALUES ($1, 'pre_test_tech', ARRAY['patient:read', 'device:read', 'device:write'])
      RETURNING id
    `, [practiceId]);

    // Assign all 3 roles
    await pool.query(`
      INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)
    `, [userId, role1.rows[0].id]);
    await pool.query(`
      INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)
    `, [userId, role2.rows[0].id]);
    await pool.query(`
      INSERT INTO user_role_assignments (user_id, role_id) VALUES ($1, $2)
    `, [userId, role3.rows[0].id]);

    // Query union of permissions
    const perms = await pool.query(`
      SELECT DISTINCT unnest(ur.permission_set) AS perm
      FROM user_role_assignments ura
      JOIN user_roles ur ON ur.id = ura.role_id
      WHERE ura.user_id = $1
      ORDER BY perm
    `, [userId]);

    const permList = perms.rows.map((r: { perm: string }) => r.perm);
    expect(permList).toContain('schedule:read');
    expect(permList).toContain('schedule:write');
    expect(permList).toContain('patient:read');
    expect(permList).toContain('billing:read');
    expect(permList).toContain('billing:write');
    expect(permList).toContain('device:read');
    expect(permList).toContain('device:write');
    // patient:read appears in two roles but should be deduplicated
    expect(permList.length).toBe(7);
  });

  it('enforces unique constraint on role assignment', async () => {
    // Get existing assignment and its service_line_id
    const existing = await pool.query(`
      SELECT user_id, role_id, service_line_id FROM user_role_assignments LIMIT 1
    `);
    const { user_id, role_id } = existing.rows[0];

    // Create a service line (unique constraint includes service_line_id, NULLs are distinct in PG)
    const practice = await pool.query('SELECT id FROM practices LIMIT 1');
    const sl = await pool.query(
      "INSERT INTO service_lines (practice_id, name) VALUES ($1, 'UniqueTest') RETURNING id",
      [practice.rows[0].id]
    );
    const serviceLineId = sl.rows[0].id;

    // Insert with a specific service_line_id
    await pool.query(`
      INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)
    `, [user_id, role_id, serviceLineId]);

    // Try to insert duplicate with same service_line_id — should fail
    await expect(
      pool.query(`
        INSERT INTO user_role_assignments (user_id, role_id, service_line_id) VALUES ($1, $2, $3)
      `, [user_id, role_id, serviceLineId])
    ).rejects.toThrow();
  });

  // ---- Task 4: Treatment Library + Body Area Modifiers + Appointment Types ----

  it('treatment_library table exists', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'treatment_library'
      ORDER BY column_name
    `);
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toContain('standard_name');
    expect(columns).toContain('category');
    expect(columns).toContain('subcategory');
    expect(columns).toContain('typical_duration_minutes');
    expect(columns).toContain('cpt_codes');
    expect(columns).toContain('equipment_tags');
    expect(columns).toContain('provider_scope');
    expect(columns).toContain('service_lines');
    expect(columns).toContain('body_area_modifiers_available');
    expect(columns).toContain('consent_required');
    expect(columns).toContain('is_billable');
    expect(columns).toContain('default_color');
  });

  it('body_area_modifiers table exists', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'body_area_modifiers'
      ORDER BY column_name
    `);
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toContain('name');
    expect(columns).toContain('short_code');
    expect(columns).toContain('duration_adjustment_minutes');
    expect(columns).toContain('additional_equipment_tags');
    expect(columns).toContain('additional_consent');
    expect(columns).toContain('is_system');
    expect(columns).toContain('practice_id');
  });

  it('appointment_types has new columns from refactor', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'appointment_types'
      AND column_name IN (
        'library_id', 'display_name', 'service_line_ids', 'body_area_modifier_ids',
        'equipment_tags', 'provider_scope', 'is_custom', 'price_cents',
        'cpt_codes', 'requires_consultation', 'series_enabled', 'series_count',
        'online_bookable', 'photo_required'
      )
      ORDER BY column_name
    `);
    expect(result.rows.length).toBe(14);
  });

  it('treatment_library links to appointment_types via library_id', async () => {
    // Create a treatment
    const treatment = await pool.query(`
      INSERT INTO treatment_library (standard_name, category, typical_duration_minutes, cpt_codes, service_lines)
      VALUES ('Comprehensive Eye Exam', 'optometry', 30, ARRAY['92004', '92014'], ARRAY['eyecare'])
      RETURNING id
    `);
    const treatmentId = treatment.rows[0].id;

    // Get practice + service line
    const practice = await pool.query('SELECT id FROM practices LIMIT 1');
    const practiceId = practice.rows[0].id;

    const sl = await pool.query(`
      INSERT INTO service_lines (practice_id, name) VALUES ($1, 'Eyecare') RETURNING id
    `, [practiceId]);
    const serviceLineId = sl.rows[0].id;

    // Create appointment type linked to treatment
    const appt = await pool.query(`
      INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, duration_blocks, library_id, display_name)
      VALUES ($1, $2, 'Comp Eye Exam', 'CEE', 2, $3, 'Comprehensive Eye Exam')
      RETURNING id, library_id
    `, [practiceId, serviceLineId, treatmentId]);

    expect(appt.rows[0].library_id).toBe(treatmentId);

    // Verify FK join works
    const joined = await pool.query(`
      SELECT at.name, tl.standard_name, tl.cpt_codes
      FROM appointment_types at
      JOIN treatment_library tl ON tl.id = at.library_id
      WHERE at.id = $1
    `, [appt.rows[0].id]);

    expect(joined.rows[0].standard_name).toBe('Comprehensive Eye Exam');
    expect(joined.rows[0].cpt_codes).toEqual(['92004', '92014']);
  });
});
