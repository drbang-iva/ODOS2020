import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PaymentService } from '../../../../src/server/modules/billing/services/payment.service.js';
import { ChargeService } from '../../../../src/server/modules/billing/services/charge.service.js';
import { FeeScheduleService } from '../../../../src/server/modules/billing/services/fee-schedule.service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('PaymentService', () => {
  let pool: pg.Pool;
  let paymentService: PaymentService;
  let chargeService: ChargeService;
  let feeService: FeeScheduleService;
  let practiceId: string;
  let providerId: string;
  let patientId: string;
  let userId: string;
  let chargeAId: string;
  let chargeBId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    paymentService = new PaymentService(pool);
    chargeService = new ChargeService(pool);
    feeService = new FeeScheduleService(pool);

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Pmt Test') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const provider = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name, is_provider)
       VALUES ($1, 'doc@test.com', 'h', 'Dr. Test', true) RETURNING id`,
      [practiceId],
    );
    providerId = provider.rows[0].id;
    userId = providerId;

    const patient = await pool.query(
      `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
       VALUES ($1, 'Jane', 'Doe', '1990-01-01', 'F', '555-0000', '100 Main', 'Edmond', 'OK', '73034') RETURNING id`,
      [practiceId],
    );
    patientId = patient.rows[0].id;

    const schedule = await feeService.create(practiceId, { name: 'Default', isDefault: true });
    await feeService.addItem(practiceId, schedule.id, { cptCode: '92004', amountCents: 22500 });
    await feeService.addItem(practiceId, schedule.id, { cptCode: '92014', amountCents: 18500 });

    const chargeA = await chargeService.create(practiceId, userId, {
      patientId, providerId, serviceDate: '2026-04-01',
      cptCode: '92004', units: 1, icd10Codes: [],
    });
    chargeAId = chargeA.id;

    const chargeB = await chargeService.create(practiceId, userId, {
      patientId, providerId, serviceDate: '2026-04-05',
      cptCode: '92014', units: 1, icd10Codes: [],
    });
    chargeBId = chargeB.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('create', () => {
    it('creates a patient payment with applications to multiple charges', async () => {
      const result = await paymentService.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'credit_card',
        amountCents: 41000, // covers both charges (22500 + 18500)
        paymentDate: '2026-04-08',
        applications: [
          { chargeId: chargeAId, amountCents: 22500 },
          { chargeId: chargeBId, amountCents: 18500 },
        ],
      });
      expect(result.payment.amount_cents).toBe(41000);
      expect(result.payment.unapplied_cents).toBe(0);
      expect(result.applications).toHaveLength(2);
    });

    it('creates a payment with leftover credit (unapplied)', async () => {
      const result = await paymentService.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 50000,
        paymentDate: '2026-04-08',
        applications: [{ chargeId: chargeAId, amountCents: 22500 }],
      });
      expect(result.payment.unapplied_cents).toBe(27500);
      expect(result.applications).toHaveLength(1);
    });

    it('creates a payment with no applications (full credit)', async () => {
      const result = await paymentService.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'check',
        amountCents: 10000,
        paymentDate: '2026-04-08',
        applications: [],
      });
      expect(result.payment.unapplied_cents).toBe(10000);
      expect(result.applications).toHaveLength(0);
    });

    it('rejects when applications sum exceeds payment amount', async () => {
      await expect(
        paymentService.create(practiceId, userId, {
          patientId,
          paymentType: 'patient',
          paymentMethod: 'cash',
          amountCents: 30000,
          paymentDate: '2026-04-08',
          applications: [
            { chargeId: chargeAId, amountCents: 22500 },
            { chargeId: chargeBId, amountCents: 18500 },
          ],
        }),
      ).rejects.toThrow('exceeds payment amount');
    });

    it('rejects application that exceeds charge unpaid balance', async () => {
      await expect(
        paymentService.create(practiceId, userId, {
          patientId,
          paymentType: 'patient',
          paymentMethod: 'cash',
          amountCents: 50000,
          paymentDate: '2026-04-08',
          applications: [{ chargeId: chargeAId, amountCents: 30000 }], // charge is only 22500
        }),
      ).rejects.toThrow('exceeds unpaid balance');
    });

    it('rejects application to voided charge', async () => {
      await chargeService.voidCharge(practiceId, chargeAId, userId, 'test');

      await expect(
        paymentService.create(practiceId, userId, {
          patientId,
          paymentType: 'patient',
          paymentMethod: 'cash',
          amountCents: 22500,
          paymentDate: '2026-04-08',
          applications: [{ chargeId: chargeAId, amountCents: 22500 }],
        }),
      ).rejects.toThrow('voided');
    });

    it('creates a carrier payment with payerName', async () => {
      const result = await paymentService.create(practiceId, userId, {
        paymentType: 'carrier',
        paymentMethod: 'eft',
        amountCents: 18000,
        payerName: 'VSP',
        referenceNumber: 'EOB-12345',
        paymentDate: '2026-04-08',
        applications: [{ chargeId: chargeAId, amountCents: 18000 }],
      });
      expect(result.payment.payer_name).toBe('VSP');
      expect(result.payment.payment_type).toBe('carrier');
    });

    it('rejects carrier payment without payerName', async () => {
      await expect(
        paymentService.create(practiceId, userId, {
          paymentType: 'carrier',
          paymentMethod: 'eft',
          amountCents: 18000,
          paymentDate: '2026-04-08',
          applications: [],
        }),
      ).rejects.toThrow('payerName');
    });

    it('rolls back transaction on application failure', async () => {
      // Try to create a payment where the second application is invalid
      try {
        await paymentService.create(practiceId, userId, {
          patientId,
          paymentType: 'patient',
          paymentMethod: 'cash',
          amountCents: 50000,
          paymentDate: '2026-04-08',
          applications: [
            { chargeId: chargeAId, amountCents: 22500 }, // valid
            { chargeId: chargeBId, amountCents: 30000 }, // invalid - exceeds balance
          ],
        });
      } catch {
        // Expected
      }

      // Verify NO payment was created
      const list = await paymentService.list(practiceId, { limit: 100, offset: 0 } as never);
      expect(list.total).toBe(0);
    });
  });

  describe('applyToCharge', () => {
    it('applies leftover unapplied balance to a new charge', async () => {
      const result = await paymentService.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 50000,
        paymentDate: '2026-04-08',
        applications: [{ chargeId: chargeAId, amountCents: 22500 }],
      });
      expect(result.payment.unapplied_cents).toBe(27500);

      // Now apply the leftover to chargeB
      const application = await paymentService.applyToCharge(practiceId, result.payment.id, userId, {
        chargeId: chargeBId,
        amountCents: 18500,
      });
      expect(application.amount_cents).toBe(18500);

      // Verify payment unapplied dropped
      const reload = await paymentService.get(practiceId, result.payment.id);
      expect(reload?.unapplied_cents).toBe(9000);
    });

    it('rejects applying more than unapplied balance', async () => {
      const result = await paymentService.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 22500,
        paymentDate: '2026-04-08',
        applications: [{ chargeId: chargeAId, amountCents: 22500 }],
      });

      await expect(
        paymentService.applyToCharge(practiceId, result.payment.id, userId, {
          chargeId: chargeBId,
          amountCents: 1000,
        }),
      ).rejects.toThrow('exceeds unapplied balance');
    });
  });

  describe('voidPayment', () => {
    it('marks payment as voided', async () => {
      const result = await paymentService.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 22500,
        paymentDate: '2026-04-08',
        applications: [{ chargeId: chargeAId, amountCents: 22500 }],
      });

      const voided = await paymentService.voidPayment(practiceId, result.payment.id, userId, 'NSF check');
      expect(voided.voided_at).not.toBeNull();
      expect(voided.voided_reason).toBe('NSF check');
    });

    it('rejects voiding already voided payment', async () => {
      const result = await paymentService.create(practiceId, userId, {
        patientId,
        paymentType: 'patient',
        paymentMethod: 'cash',
        amountCents: 22500,
        paymentDate: '2026-04-08',
        applications: [],
      });
      await paymentService.voidPayment(practiceId, result.payment.id, userId, 'first');
      await expect(
        paymentService.voidPayment(practiceId, result.payment.id, userId, 'second'),
      ).rejects.toThrow('already voided');
    });
  });

  describe('list', () => {
    it('filters by paymentType', async () => {
      await paymentService.create(practiceId, userId, {
        patientId, paymentType: 'patient', paymentMethod: 'cash',
        amountCents: 1000, paymentDate: '2026-04-01', applications: [],
      });
      await paymentService.create(practiceId, userId, {
        paymentType: 'carrier', paymentMethod: 'eft',
        amountCents: 5000, payerName: 'VSP',
        paymentDate: '2026-04-02', applications: [],
      });

      const carriers = await paymentService.list(practiceId, {
        paymentType: 'carrier', limit: 100, offset: 0,
      } as never);
      expect(carriers.total).toBe(1);
      expect(carriers.payments[0].payer_name).toBe('VSP');
    });
  });

  it('does not return payments from another practice', async () => {
    const result = await paymentService.create(practiceId, userId, {
      patientId, paymentType: 'patient', paymentMethod: 'cash',
      amountCents: 1000, paymentDate: '2026-04-01', applications: [],
    });
    const otherPractice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
    );
    const fetched = await paymentService.get(otherPractice.rows[0].id, result.payment.id);
    expect(fetched).toBeNull();
  });
});
