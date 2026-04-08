import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { LedgerService } from '../../../../src/server/modules/billing/services/ledger.service.js';
import { PaymentService } from '../../../../src/server/modules/billing/services/payment.service.js';
import { ChargeService } from '../../../../src/server/modules/billing/services/charge.service.js';
import { AdjustmentService } from '../../../../src/server/modules/billing/services/adjustment.service.js';
import { FeeScheduleService } from '../../../../src/server/modules/billing/services/fee-schedule.service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('LedgerService', () => {
  let pool: pg.Pool;
  let ledger: LedgerService;
  let charges: ChargeService;
  let payments: PaymentService;
  let adjustments: AdjustmentService;
  let practiceId: string;
  let userId: string;
  let patientId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    ledger = new LedgerService(pool);
    charges = new ChargeService(pool);
    payments = new PaymentService(pool);
    adjustments = new AdjustmentService(pool);
    const fees = new FeeScheduleService(pool);

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Ledger Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
       VALUES ($1, 'doc@test.com', 'h', 'Dr. Test', true) RETURNING id`,
      [practiceId],
    );
    userId = user.rows[0].id;

    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Jane', 'Doe', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = patient.rows[0].id;

    const schedule = await fees.create(practiceId, { name: 'Default', isDefault: true });
    await fees.addItem(practiceId, schedule.id, { cptCode: '92004', amountCents: 22500 });
    await fees.addItem(practiceId, schedule.id, { cptCode: '92014', amountCents: 18500 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('getPatientLedger', () => {
    it('returns zeros for a patient with no charges', async () => {
      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result).not.toBeNull();
      expect(result?.total_charged_cents).toBe(0);
      expect(result?.balance_cents).toBe(0);
    });

    it('reflects charges in total_charged and balance', async () => {
      await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result?.total_charged_cents).toBe(22500);
      expect(result?.balance_cents).toBe(22500);
    });

    it('subtracts patient payments from balance', async () => {
      const charge = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await payments.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 10000,
        paymentDate: '2026-04-08',
        applications: [{ chargeId: charge.id, amountCents: 10000 }],
      });

      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result?.total_patient_paid_cents).toBe(10000);
      expect(result?.balance_cents).toBe(12500);
    });

    it('subtracts carrier payments separately', async () => {
      const charge = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await payments.create(practiceId, userId, {
        paymentType: 'carrier',
        paymentMethod: 'eft',
        amountCents: 18000,
        payerName: 'VSP',
        paymentDate: '2026-04-08',
        applications: [{ chargeId: charge.id, amountCents: 18000 }],
      });

      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result?.total_carrier_paid_cents).toBe(18000);
      expect(result?.total_patient_paid_cents).toBe(0);
      expect(result?.balance_cents).toBe(4500);
    });

    it('subtracts adjustments from balance', async () => {
      const charge = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await adjustments.create(practiceId, userId, {
        chargeId: charge.id,
        adjustmentType: 'contractual',
        amountCents: 5000,
        reason: 'allowed amount',
      });

      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result?.total_adjustments_cents).toBe(5000);
      expect(result?.balance_cents).toBe(17500);
    });

    it('combines all the math correctly: charge - patient pmt - carrier pmt - adjustment', async () => {
      // Two charges totaling $410
      const a = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      const b = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-05',
        cptCode: '92014', units: 1, icd10Codes: [],
      });

      // VSP pays $175 on charge A
      await payments.create(practiceId, userId, {
        paymentType: 'carrier', paymentMethod: 'eft',
        amountCents: 17500, payerName: 'VSP',
        paymentDate: '2026-04-15',
        applications: [{ chargeId: a.id, amountCents: 17500 }],
      });

      // Contractual adjustment $50 on charge A
      await adjustments.create(practiceId, userId, {
        chargeId: a.id, adjustmentType: 'contractual',
        amountCents: 5000, reason: 'allowed',
      });

      // Patient pays $50 cash on charge B
      await payments.create(practiceId, userId, {
        patientId, paymentType: 'patient', paymentMethod: 'cash',
        amountCents: 5000, paymentDate: '2026-04-15',
        applications: [{ chargeId: b.id, amountCents: 5000 }],
      });

      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result?.total_charged_cents).toBe(41000);
      expect(result?.total_carrier_paid_cents).toBe(17500);
      expect(result?.total_patient_paid_cents).toBe(5000);
      expect(result?.total_adjustments_cents).toBe(5000);
      // 41000 - 17500 - 5000 - 5000 = 13500
      expect(result?.balance_cents).toBe(13500);
    });

    it('excludes voided charges from the ledger', async () => {
      const charge = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await charges.voidCharge(practiceId, charge.id, userId, 'mistake');

      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result?.total_charged_cents).toBe(0);
      expect(result?.balance_cents).toBe(0);
    });

    it('excludes voided payments from the ledger', async () => {
      const charge = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      const pmt = await payments.create(practiceId, userId, {
        patientId, paymentType: 'patient', paymentMethod: 'check',
        amountCents: 22500, paymentDate: '2026-04-08',
        applications: [{ chargeId: charge.id, amountCents: 22500 }],
      });
      await payments.voidPayment(practiceId, pmt.payment.id, userId, 'NSF');

      const result = await ledger.getPatientLedger(practiceId, patientId);
      expect(result?.total_patient_paid_cents).toBe(0);
      expect(result?.balance_cents).toBe(22500);
    });
  });

  describe('getPatientChargeDetails', () => {
    it('returns charges with paid/adjusted/balance breakdown', async () => {
      const charge = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await payments.create(practiceId, userId, {
        patientId, paymentType: 'patient', paymentMethod: 'cash',
        amountCents: 10000, paymentDate: '2026-04-08',
        applications: [{ chargeId: charge.id, amountCents: 10000 }],
      });
      await adjustments.create(practiceId, userId, {
        chargeId: charge.id, adjustmentType: 'discount',
        amountCents: 2500, reason: 'cash discount',
      });

      const details = await ledger.getPatientChargeDetails(practiceId, patientId);
      expect(details).toHaveLength(1);
      expect(details[0].total_amount_cents).toBe(22500);
      expect(details[0].paid_cents).toBe(10000);
      expect(details[0].adjusted_cents).toBe(2500);
      expect(details[0].balance_cents).toBe(10000); // 22500 - 10000 - 2500
    });

    it('excludes voided charges', async () => {
      const a = await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-05',
        cptCode: '92014', units: 1, icd10Codes: [],
      });
      await charges.voidCharge(practiceId, a.id, userId, 'wrong');

      const details = await ledger.getPatientChargeDetails(practiceId, patientId);
      expect(details).toHaveLength(1);
      expect(details[0].cpt_code).toBe('92014');
    });

    it('orders by service date desc', async () => {
      await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-03-15',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await charges.create(practiceId, userId, {
        patientId, providerId: userId, serviceDate: '2026-04-15',
        cptCode: '92014', units: 1, icd10Codes: [],
      });

      const details = await ledger.getPatientChargeDetails(practiceId, patientId);
      // service_date comes back as a Date object from pg; compare via ISO string
      const firstDate = new Date(details[0].service_date).toISOString();
      const secondDate = new Date(details[1].service_date).toISOString();
      expect(firstDate.startsWith('2026-04-15')).toBe(true);
      expect(secondDate.startsWith('2026-03-15')).toBe(true);
    });
  });
});
