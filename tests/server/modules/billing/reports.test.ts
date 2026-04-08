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

  describe('revenueByProvider', () => {
    let provider2Id: string;
    let eyecareSlId: string;
    let aestheticsSlId: string;

    beforeEach(async () => {
      // Create a second provider so we can test multi-provider reporting
      const p2 = await pool.query(
        `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
         VALUES ($1, 'doc2@test.com', 'h', 'Dr. Second', true) RETURNING id`,
        [practiceId],
      );
      provider2Id = p2.rows[0].id;

      // Two service lines for the serviceLineId filter test
      const sl1 = await pool.query(
        `INSERT INTO service_lines (practice_id, name, color)
         VALUES ($1, 'Eyecare', '#2563EB') RETURNING id`,
        [practiceId],
      );
      eyecareSlId = sl1.rows[0].id;

      const sl2 = await pool.query(
        `INSERT INTO service_lines (practice_id, name, color)
         VALUES ($1, 'Aesthetics', '#DB2777') RETURNING id`,
        [practiceId],
      );
      aestheticsSlId = sl2.rows[0].id;
    });

    /**
     * Helper: insert a charge directly with a specific provider, bypassing
     * ChargeService because we don't need a fee schedule lookup for these
     * tests (we set the amount explicitly).
     *
     * Optionally links the charge to an appointment so the serviceLineId
     * filter has something to join through — charges has no direct
     * service_line_id column; it's derived via appointment.
     */
    async function rawCharge(
      providerId: string,
      serviceDate: string,
      amountCents: number,
      appointmentId: string | null = null,
    ): Promise<string> {
      const result = await pool.query(
        `INSERT INTO charges (
          practice_id, patient_id, provider_id, appointment_id,
          service_date, cpt_code, units, unit_amount_cents, total_amount_cents, created_by
        ) VALUES ($1, $2, $3, $4, $5, '92004', 1, $6, $6, $3)
        RETURNING id`,
        [practiceId, patient1Id, providerId, appointmentId, serviceDate, amountCents],
      );
      return result.rows[0].id;
    }

    /**
     * Helper: create an appointment linked to a specific service line,
     * returning its id so a charge can be linked to it for the serviceLineId
     * filter test.
     */
    async function rawAppointment(
      providerId: string,
      serviceLineId: string,
      startTime: string,
    ): Promise<string> {
      // Need an appointment_type to satisfy the FK on appointments
      const atRes = await pool.query(
        `INSERT INTO appointment_types (practice_id, service_line_id, name, short_name, color, duration_blocks, display_name, service_line_ids)
         VALUES ($1, $2, 'Test Type', 'TT', '#2563EB', 1, 'Test Type', $3)
         RETURNING id`,
        [practiceId, serviceLineId, [serviceLineId]],
      );
      const aptTypeId = atRes.rows[0].id;

      const aptRes = await pool.query(
        `INSERT INTO appointments (
          practice_id, patient_id, provider_id, appointment_type_id,
          service_line_id, start_time, duration_blocks, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, 1, $3)
        RETURNING id`,
        [practiceId, patient1Id, providerId, aptTypeId, serviceLineId, startTime],
      );
      return aptRes.rows[0].id;
    }

    it('returns empty providers array when no charges exist in range', async () => {
      const report = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(report.providers).toHaveLength(0);
      expect(report.totals.chargeCount).toBe(0);
      expect(report.totals.totalChargedCents).toBe(0);
    });

    it('aggregates charges per provider with totals', async () => {
      // Provider 1: 2 charges totaling $450
      await rawCharge(userId, '2026-02-01', 22500);
      await rawCharge(userId, '2026-02-15', 22500);
      // Provider 2: 1 charge for $185
      await rawCharge(provider2Id, '2026-02-10', 18500);

      const report = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      expect(report.providers).toHaveLength(2);
      // Ordered by total_charged DESC, so provider 1 first
      expect(report.providers[0].providerId).toBe(userId);
      expect(report.providers[0].chargeCount).toBe(2);
      expect(report.providers[0].totalChargedCents).toBe(45000);
      expect(report.providers[0].providerName).toBe('Dr. Test');

      expect(report.providers[1].providerId).toBe(provider2Id);
      expect(report.providers[1].chargeCount).toBe(1);
      expect(report.providers[1].totalChargedCents).toBe(18500);
      expect(report.providers[1].providerName).toBe('Dr. Second');

      expect(report.totals.chargeCount).toBe(3);
      expect(report.totals.totalChargedCents).toBe(63500);
    });

    it('subtracts payments from outstanding', async () => {
      const chargeId = await rawCharge(userId, '2026-02-01', 22500);
      await payments.create(practiceId, userId, {
        patientId: patient1Id,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 10000,
        paymentDate: '2026-02-05',
        applications: [{ chargeId, amountCents: 10000 }],
      });

      const report = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      expect(report.providers).toHaveLength(1);
      expect(report.providers[0].totalChargedCents).toBe(22500);
      expect(report.providers[0].totalPaidCents).toBe(10000);
      expect(report.providers[0].outstandingCents).toBe(12500);
    });

    it('subtracts adjustments from outstanding', async () => {
      const chargeId = await rawCharge(userId, '2026-02-01', 22500);
      await adjustments.create(practiceId, userId, {
        chargeId,
        adjustmentType: 'contractual',
        amountCents: 5000,
        reason: 'allowed',
      });

      const report = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      expect(report.providers[0].totalAdjustedCents).toBe(5000);
      expect(report.providers[0].outstandingCents).toBe(17500);
    });

    it('excludes voided charges from totals', async () => {
      const chargeId = await rawCharge(userId, '2026-02-01', 22500);
      await rawCharge(userId, '2026-02-15', 18500);
      await charges.voidCharge(practiceId, chargeId, userId, 'mistake');

      const report = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      expect(report.providers[0].chargeCount).toBe(1);
      expect(report.providers[0].totalChargedCents).toBe(18500);
    });

    it('excludes voided payments (outstanding goes back up)', async () => {
      const chargeId = await rawCharge(userId, '2026-02-01', 22500);
      const pmt = await payments.create(practiceId, userId, {
        patientId: patient1Id,
        paymentType: 'patient',
        paymentMethod: 'check',
        amountCents: 22500,
        paymentDate: '2026-02-05',
        applications: [{ chargeId, amountCents: 22500 }],
      });
      await payments.voidPayment(practiceId, pmt.payment.id, userId, 'NSF');

      const report = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });

      expect(report.providers[0].totalPaidCents).toBe(0);
      expect(report.providers[0].outstandingCents).toBe(22500);
    });

    it('filters by service_date range (inclusive both ends)', async () => {
      await rawCharge(userId, '2026-01-31', 10000); // before range
      await rawCharge(userId, '2026-02-01', 20000); // start boundary
      await rawCharge(userId, '2026-02-15', 30000); // inside
      await rawCharge(userId, '2026-02-28', 40000); // end boundary
      await rawCharge(userId, '2026-03-01', 50000); // after range

      const report = await reports.revenueByProvider(practiceId, {
        startDate: '2026-02-01',
        endDate: '2026-02-28',
      });

      expect(report.totals.chargeCount).toBe(3);
      expect(report.totals.totalChargedCents).toBe(90000); // 20000 + 30000 + 40000
    });

    it('filters by serviceLineId when provided (via appointment join)', async () => {
      // Same provider, two different service lines. Each charge is tied to
      // an appointment so the filter can join through.
      const eyecareAppt = await rawAppointment(
        userId,
        eyecareSlId,
        '2026-02-01T14:00:00Z',
      );
      const aestheticsAppt = await rawAppointment(
        userId,
        aestheticsSlId,
        '2026-02-02T14:00:00Z',
      );
      await rawCharge(userId, '2026-02-01', 22500, eyecareAppt);
      await rawCharge(userId, '2026-02-02', 30000, aestheticsAppt);

      const eyecareReport = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        serviceLineId: eyecareSlId,
      });
      expect(eyecareReport.totals.chargeCount).toBe(1);
      expect(eyecareReport.totals.totalChargedCents).toBe(22500);
      expect(eyecareReport.serviceLineId).toBe(eyecareSlId);

      const aestheticsReport = await reports.revenueByProvider(practiceId, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        serviceLineId: aestheticsSlId,
      });
      expect(aestheticsReport.totals.chargeCount).toBe(1);
      expect(aestheticsReport.totals.totalChargedCents).toBe(30000);
    });

    it('does not leak charges from other practices', async () => {
      await rawCharge(userId, '2026-02-01', 22500);

      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
      );
      const report = await reports.revenueByProvider(otherPractice.rows[0].id, {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(report.providers).toHaveLength(0);
    });
  });
});
