import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { AdjustmentService } from '../../../../src/server/modules/billing/services/adjustment.service.js';
import { ChargeService } from '../../../../src/server/modules/billing/services/charge.service.js';
import { FeeScheduleService } from '../../../../src/server/modules/billing/services/fee-schedule.service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('AdjustmentService', () => {
  let pool: pg.Pool;
  let service: AdjustmentService;
  let chargeService: ChargeService;
  let practiceId: string;
  let userId: string;
  let chargeId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    service = new AdjustmentService(pool);
    chargeService = new ChargeService(pool);
    const feeService = new FeeScheduleService(pool);

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Adj Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const provider = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
       VALUES ($1, 'doc@test.com', 'h', 'Dr. Test', true) RETURNING id`,
      [practiceId],
    );
    userId = provider.rows[0].id;

    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Jane', 'Doe', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );

    const schedule = await feeService.create(practiceId, { name: 'Default', isDefault: true });
    await feeService.addItem(practiceId, schedule.id, { cptCode: '92004', amountCents: 22500 });

    const charge = await chargeService.create(practiceId, userId, {
      patientId: patient.rows[0].id,
      providerId: userId,
      serviceDate: '2026-04-08',
      cptCode: '92004',
      units: 1,
      icd10Codes: [],
    });
    chargeId = charge.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('creates a contractual adjustment', async () => {
    const adj = await service.create(practiceId, userId, {
      chargeId,
      adjustmentType: 'contractual',
      amountCents: 5000,
      reason: 'VSP allowed amount: $175',
    });
    expect(adj.adjustment_type).toBe('contractual');
    expect(adj.amount_cents).toBe(5000);
  });

  it('creates a write-off adjustment', async () => {
    const adj = await service.create(practiceId, userId, {
      chargeId,
      adjustmentType: 'writeoff',
      amountCents: 22500,
      reason: 'Charity care',
      notes: 'Approved by Eric',
    });
    expect(adj.adjustment_type).toBe('writeoff');
    expect(adj.notes).toBe('Approved by Eric');
  });

  it('rejects adjustment for nonexistent charge', async () => {
    await expect(
      service.create(practiceId, userId, {
        chargeId: '00000000-0000-0000-0000-000000000000',
        adjustmentType: 'contractual',
        amountCents: 1000,
        reason: 'test',
      }),
    ).rejects.toThrow('not found');
  });

  it('rejects adjustment for voided charge', async () => {
    await chargeService.voidCharge(practiceId, chargeId, userId, 'mistake');
    await expect(
      service.create(practiceId, userId, {
        chargeId,
        adjustmentType: 'writeoff',
        amountCents: 22500,
        reason: 'too late',
      }),
    ).rejects.toThrow('voided');
  });

  it('lists all adjustments for a charge', async () => {
    await service.create(practiceId, userId, {
      chargeId, adjustmentType: 'contractual', amountCents: 5000, reason: 'A',
    });
    await service.create(practiceId, userId, {
      chargeId, adjustmentType: 'discount', amountCents: 2500, reason: 'B',
    });
    const list = await service.listForCharge(practiceId, chargeId);
    expect(list).toHaveLength(2);
  });

  it('reduces unpaid balance via adjustments', async () => {
    // Charge is 22500
    await service.create(practiceId, userId, {
      chargeId, adjustmentType: 'contractual', amountCents: 5000, reason: 'allowed',
    });
    const balance = await chargeService.getUnpaidBalance(chargeId);
    expect(balance).toBe(17500);
  });

  it('deletes an adjustment', async () => {
    const adj = await service.create(practiceId, userId, {
      chargeId, adjustmentType: 'discount', amountCents: 1000, reason: 'oops',
    });
    await service.delete(practiceId, adj.id);
    const list = await service.listForCharge(practiceId, chargeId);
    expect(list).toHaveLength(0);
  });

  it('does not return adjustments from another practice', async () => {
    const adj = await service.create(practiceId, userId, {
      chargeId, adjustmentType: 'discount', amountCents: 1000, reason: 'mine',
    });
    const otherPractice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
    );
    const fetched = await service.get(otherPractice.rows[0].id, adj.id);
    expect(fetched).toBeNull();
  });
});
