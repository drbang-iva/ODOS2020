import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { ReportsService } from '../../../../src/server/modules/billing/services/reports.service.js';
import { ChargeService } from '../../../../src/server/modules/billing/services/charge.service.js';
import { PaymentService } from '../../../../src/server/modules/billing/services/payment.service.js';
import { AdjustmentService } from '../../../../src/server/modules/billing/services/adjustment.service.js';
import { FeeScheduleService } from '../../../../src/server/modules/billing/services/fee-schedule.service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

/**
 * Helper: format a date N days ago as YYYY-MM-DD. Used to seed charges
 * with specific "days overdue" values so we can assert each bucket.
 */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('ReportsService — AR aging', () => {
  let pool: pg.Pool;
  let reports: ReportsService;
  let charges: ChargeService;
  let payments: PaymentService;
  let adjustments: AdjustmentService;
  let fees: FeeScheduleService;
  let practiceId: string;
  let userId: string;
  let patient1Id: string;
  let patient2Id: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    reports = new ReportsService(pool);
    charges = new ChargeService(pool);
    payments = new PaymentService(pool);
    adjustments = new AdjustmentService(pool);
    fees = new FeeScheduleService(pool);

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('AR Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const provider = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
       VALUES ($1, 'doc@test.com', 'h', 'Dr. Test', true) RETURNING id`,
      [practiceId],
    );
    userId = provider.rows[0].id;

    const p1 = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Alice', 'Payer', '1990-01-01', 'F', '555-0001', '1 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patient1Id = p1.rows[0].id;

    const p2 = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Bob', 'Overdue', '1985-01-01', 'M', '555-0002', '2 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patient2Id = p2.rows[0].id;

    const schedule = await fees.create(practiceId, { name: 'Default', isDefault: true });
    await fees.addItem(practiceId, schedule.id, { cptCode: '92004', amountCents: 22500 });
    await fees.addItem(practiceId, schedule.id, { cptCode: '92014', amountCents: 18500 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createCharge(patientId: string, serviceDate: string, cpt = '92004') {
    return charges.create(practiceId, userId, {
      patientId,
      providerId: userId,
      serviceDate,
      cptCode: cpt,
      units: 1,
      icd10Codes: [],
    });
  }

  describe('arAgingSummary', () => {
    it('returns all 6 buckets even when empty', async () => {
      const summary = await reports.arAgingSummary(practiceId);
      expect(summary.buckets).toHaveLength(6);
      expect(summary.buckets.map((b) => b.bucket)).toEqual([
        'current', '0-30', '31-60', '61-90', '91-120', '120+',
      ]);
      expect(summary.totalBalanceCents).toBe(0);
      expect(summary.totalChargeCount).toBe(0);
    });

    it('bins charges into the correct aging buckets', async () => {
      // Seed one charge in each bucket using well-known days_overdue values
      await createCharge(patient1Id, daysAgo(-1));   // future -> 'current'
      await createCharge(patient1Id, daysAgo(15));   // -> '0-30'
      await createCharge(patient1Id, daysAgo(45));   // -> '31-60'
      await createCharge(patient1Id, daysAgo(75));   // -> '61-90'
      await createCharge(patient1Id, daysAgo(105));  // -> '91-120'
      await createCharge(patient1Id, daysAgo(200));  // -> '120+'

      const summary = await reports.arAgingSummary(practiceId);
      const findBucket = (b: string) =>
        summary.buckets.find((x) => x.bucket === b)!;

      expect(findBucket('current').chargeCount).toBe(1);
      expect(findBucket('0-30').chargeCount).toBe(1);
      expect(findBucket('31-60').chargeCount).toBe(1);
      expect(findBucket('61-90').chargeCount).toBe(1);
      expect(findBucket('91-120').chargeCount).toBe(1);
      expect(findBucket('120+').chargeCount).toBe(1);
      expect(summary.totalChargeCount).toBe(6);
      // 6 charges at $225 each = $1350.00 = 135000 cents
      expect(summary.totalBalanceCents).toBe(135000);
    });

    it('excludes charges whose balance is paid in full', async () => {
      const c = await createCharge(patient1Id, daysAgo(45));
      await payments.create(practiceId, userId, {
        patientId: patient1Id,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 22500,
        paymentDate: daysAgo(0),
        applications: [{ chargeId: c.id, amountCents: 22500 }],
      });

      const summary = await reports.arAgingSummary(practiceId);
      expect(summary.totalBalanceCents).toBe(0);
      expect(summary.totalChargeCount).toBe(0);
    });

    it('reflects partial payments in the bucket balance', async () => {
      const c = await createCharge(patient1Id, daysAgo(45));
      await payments.create(practiceId, userId, {
        patientId: patient1Id,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 10000,
        paymentDate: daysAgo(0),
        applications: [{ chargeId: c.id, amountCents: 10000 }],
      });

      const summary = await reports.arAgingSummary(practiceId);
      const bucket = summary.buckets.find((b) => b.bucket === '31-60')!;
      expect(bucket.chargeCount).toBe(1);
      expect(bucket.balanceCents).toBe(12500); // 22500 - 10000
    });

    it('reflects adjustments in the bucket balance', async () => {
      const c = await createCharge(patient1Id, daysAgo(75));
      await adjustments.create(practiceId, userId, {
        chargeId: c.id,
        adjustmentType: 'contractual',
        amountCents: 5000,
        reason: 'allowed',
      });

      const summary = await reports.arAgingSummary(practiceId);
      const bucket = summary.buckets.find((b) => b.bucket === '61-90')!;
      expect(bucket.chargeCount).toBe(1);
      expect(bucket.balanceCents).toBe(17500); // 22500 - 5000
    });

    it('excludes voided charges entirely', async () => {
      const c = await createCharge(patient1Id, daysAgo(45));
      await charges.voidCharge(practiceId, c.id, userId, 'mistake');

      const summary = await reports.arAgingSummary(practiceId);
      expect(summary.totalBalanceCents).toBe(0);
      expect(summary.totalChargeCount).toBe(0);
    });

    it('excludes voided payments from the paid calculation', async () => {
      const c = await createCharge(patient1Id, daysAgo(45));
      const pmt = await payments.create(practiceId, userId, {
        patientId: patient1Id,
        paymentType: 'patient',
        paymentMethod: 'check',
        amountCents: 22500,
        paymentDate: daysAgo(0),
        applications: [{ chargeId: c.id, amountCents: 22500 }],
      });
      // NSF — void the payment
      await payments.voidPayment(practiceId, pmt.payment.id, userId, 'NSF');

      const summary = await reports.arAgingSummary(practiceId);
      // Balance should be fully back in the bucket because the voided payment
      // no longer counts against the charge
      expect(summary.totalBalanceCents).toBe(22500);
      expect(summary.totalChargeCount).toBe(1);
    });

    it('does not leak charges from other practices', async () => {
      await createCharge(patient1Id, daysAgo(45));

      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
      );
      const summary = await reports.arAgingSummary(otherPractice.rows[0].id);
      expect(summary.totalChargeCount).toBe(0);
    });
  });

  describe('arAgingDetails', () => {
    beforeEach(async () => {
      // Seed two overdue charges in different buckets for patient1, one
      // fully-paid charge (balance 0, excluded), and one charge for patient2
      const c1 = await createCharge(patient1Id, daysAgo(45));   // 31-60
      await createCharge(patient1Id, daysAgo(200));              // 120+
      const paid = await createCharge(patient1Id, daysAgo(50));  // paid off
      await payments.create(practiceId, userId, {
        patientId: patient1Id,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 22500,
        paymentDate: daysAgo(0),
        applications: [{ chargeId: paid.id, amountCents: 22500 }],
      });
      await createCharge(patient2Id, daysAgo(75));  // 61-90
      // Reference c1 to silence unused warning (it's asserted below via queries)
      void c1;
    });

    it('returns charges with patient names and per-row balance breakdown', async () => {
      const { rows, total } = await reports.arAgingDetails(practiceId);
      // Expect 3 rows (the paid charge is excluded because balance=0)
      expect(total).toBe(3);
      expect(rows).toHaveLength(3);

      // Most overdue first
      expect(rows[0].bucket).toBe('120+');
      expect(rows[0].daysOverdue).toBeGreaterThanOrEqual(200);

      // Every row has a patient name and a positive balance
      for (const r of rows) {
        expect(r.patientFirstName).toBeDefined();
        expect(r.patientLastName).toBeDefined();
        expect(r.balanceCents).toBeGreaterThan(0);
      }
    });

    it('filters by bucket', async () => {
      const { rows, total } = await reports.arAgingDetails(practiceId, { bucket: '61-90' });
      expect(total).toBe(1);
      expect(rows[0].bucket).toBe('61-90');
      expect(rows[0].patientFirstName).toBe('Bob');
    });

    it('excludes zero-balance charges by default', async () => {
      const { rows } = await reports.arAgingDetails(practiceId);
      // None of the rows should have balance 0
      expect(rows.every((r) => r.balanceCents > 0)).toBe(true);
    });

    it('respects pagination', async () => {
      const { rows, total } = await reports.arAgingDetails(practiceId, { limit: 2, offset: 0 });
      expect(total).toBe(3);
      expect(rows).toHaveLength(2);
    });

    it('does not leak charges from other practices', async () => {
      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
      );
      const { total } = await reports.arAgingDetails(otherPractice.rows[0].id);
      expect(total).toBe(0);
    });
  });
});
