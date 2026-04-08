import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('003_billing migration', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const setup = new pg.Pool({ connectionString: TEST_DB_URL });
    await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await setup.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('creates fee_schedules table', async () => {
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'fee_schedules' ORDER BY column_name
    `);
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('practice_id');
    expect(cols).toContain('name');
    expect(cols).toContain('is_default');
    expect(cols).toContain('effective_date');
  });

  it('creates fee_schedule_items table with cpt_code + modifier uniqueness', async () => {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'fee_schedule_items'
    `);
    expect(cols.rows.map((r) => r.column_name)).toContain('cpt_code');
    expect(cols.rows.map((r) => r.column_name)).toContain('amount_cents');
  });

  it('creates charges table with full billing fields', async () => {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'charges' ORDER BY column_name
    `);
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames).toContain('cpt_code');
    expect(colNames).toContain('icd10_codes');
    expect(colNames).toContain('total_amount_cents');
    expect(colNames).toContain('insurance_responsibility_cents');
    expect(colNames).toContain('patient_responsibility_cents');
    expect(colNames).toContain('status');
  });

  it('creates payments table with type and method', async () => {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'payments'
    `);
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames).toContain('payment_type');
    expect(colNames).toContain('payment_method');
    expect(colNames).toContain('unapplied_cents');
  });

  it('creates payment_applications junction table', async () => {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'payment_applications'
    `);
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames).toContain('payment_id');
    expect(colNames).toContain('charge_id');
    expect(colNames).toContain('amount_cents');
  });

  it('creates adjustments table', async () => {
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'adjustments'
    `);
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames).toContain('charge_id');
    expect(colNames).toContain('adjustment_type');
    expect(colNames).toContain('amount_cents');
    expect(colNames).toContain('reason');
  });

  it('creates patient_ledger view', async () => {
    const result = await pool.query(`
      SELECT viewname FROM pg_views WHERE viewname = 'patient_ledger'
    `);
    expect(result.rows).toHaveLength(1);
  });

  it('patient_ledger view returns balance for a patient', async () => {
    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Ledger Test') RETURNING id`,
    );
    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Test', 'P', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practice.rows[0].id],
    );

    const ledger = await pool.query(
      `SELECT * FROM patient_ledger WHERE patient_id = $1`,
      [patient.rows[0].id],
    );
    expect(ledger.rows).toHaveLength(1);
    // Postgres returns SUM as numeric (string in node-pg) or null when no rows
    expect(Number(ledger.rows[0].balance_cents ?? 0)).toBe(0);
    expect(Number(ledger.rows[0].total_charged_cents ?? 0)).toBe(0);
  });

  it('rejects negative charge amounts via CHECK constraint', async () => {
    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Constraint Test') RETURNING id`,
    );
    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'C', 'P', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practice.rows[0].id],
    );
    const user = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name)
       VALUES ($1, 'u@test.com', 'h', 'U') RETURNING id`,
      [practice.rows[0].id],
    );

    await expect(
      pool.query(
        `INSERT INTO charges (practice_id, patient_id, provider_id, service_date,
                              cpt_code, units, unit_amount_cents, total_amount_cents, created_by)
         VALUES ($1, $2, $3, '2026-04-08', '92004', 1, -100, -100, $3)`,
        [practice.rows[0].id, patient.rows[0].id, user.rows[0].id],
      ),
    ).rejects.toThrow();
  });
});
