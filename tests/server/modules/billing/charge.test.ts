import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { ChargeService } from '../../../../src/server/modules/billing/services/charge.service.js';
import { FeeScheduleService } from '../../../../src/server/modules/billing/services/fee-schedule.service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('ChargeService', () => {
  let pool: pg.Pool;
  let service: ChargeService;
  let feeService: FeeScheduleService;
  let practiceId: string;
  let providerId: string;
  let patientId: string;
  let userId: string;
  let scheduleId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    service = new ChargeService(pool);
    feeService = new FeeScheduleService(pool);

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Charge Test') RETURNING id`,
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
    scheduleId = schedule.id;
    await feeService.addItem(practiceId, scheduleId, { cptCode: '92004', amountCents: 22500 });
    await feeService.addItem(practiceId, scheduleId, { cptCode: '92014', amountCents: 18500 });
    await feeService.addItem(practiceId, scheduleId, {
      cptCode: '92083',
      modifier: '26',
      amountCents: 8500,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('create', () => {
    it('creates a charge with explicit unit amount', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId,
        providerId,
        serviceDate: '2026-04-08',
        cptCode: '92004',
        unitAmountCents: 25000,
        units: 1,
        icd10Codes: ['H52.13'],
      });
      expect(charge.id).toBeDefined();
      expect(charge.unit_amount_cents).toBe(25000);
      expect(charge.total_amount_cents).toBe(25000);
      expect(charge.status).toBe('pending');
      expect(charge.icd10_codes).toEqual(['H52.13']);
    });

    it('auto-looks-up price from default fee schedule when amount omitted', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId,
        providerId,
        serviceDate: '2026-04-08',
        cptCode: '92004',
        units: 1,
        icd10Codes: [],
      });
      expect(charge.unit_amount_cents).toBe(22500);
      expect(charge.fee_schedule_id).toBe(scheduleId);
    });

    it('multiplies units by unit amount for total', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId,
        providerId,
        serviceDate: '2026-04-08',
        cptCode: '92014',
        units: 3,
        icd10Codes: [],
      });
      expect(charge.units).toBe(3);
      expect(charge.unit_amount_cents).toBe(18500);
      expect(charge.total_amount_cents).toBe(55500);
    });

    it('respects modifier when looking up price', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId,
        providerId,
        serviceDate: '2026-04-08',
        cptCode: '92083',
        modifier: '26',
        units: 1,
        icd10Codes: [],
      });
      expect(charge.unit_amount_cents).toBe(8500);
      expect(charge.modifier).toBe('26');
    });

    it('throws if no price available and no fee schedule', async () => {
      // Use a fresh practice with no fee schedule
      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('No Fees') RETURNING id`,
      );
      const otherUser = await pool.query(
        `INSERT INTO users (practice_id, email, password_hash, full_name)
         VALUES ($1, 'u@test.com', 'h', 'U') RETURNING id`,
        [otherPractice.rows[0].id],
      );
      const otherPatient = await pool.query(
        `INSERT INTO patients (practice_id, first_name, last_name, date_of_birth, sex, phone_primary, address_line1, city, state, zip)
         VALUES ($1, 'A', 'B', '1990-01-01', 'F', '555', '1 Main', 'X', 'OK', '73034') RETURNING id`,
        [otherPractice.rows[0].id],
      );

      await expect(
        service.create(otherPractice.rows[0].id, otherUser.rows[0].id, {
          patientId: otherPatient.rows[0].id,
          providerId: otherUser.rows[0].id,
          serviceDate: '2026-04-08',
          cptCode: '92004',
          units: 1,
          icd10Codes: [],
        }),
      ).rejects.toThrow('No price provided');
    });

    it('throws if CPT not in schedule', async () => {
      await expect(
        service.create(practiceId, userId, {
          patientId,
          providerId,
          serviceDate: '2026-04-08',
          cptCode: '99999',
          units: 1,
          icd10Codes: [],
        }),
      ).rejects.toThrow('Price not found');
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-01',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-05',
        cptCode: '92014', units: 1, icd10Codes: [],
      });
    });

    it('lists all charges for practice', async () => {
      const { charges, total } = await service.list(practiceId, { limit: 100, offset: 0 } as never);
      expect(total).toBe(2);
      expect(charges).toHaveLength(2);
    });

    it('filters by patient', async () => {
      const { charges } = await service.list(practiceId, { patientId, limit: 100, offset: 0 } as never);
      expect(charges).toHaveLength(2);
    });

    it('filters by service date range', async () => {
      const { charges } = await service.list(practiceId, {
        startDate: '2026-04-04',
        endDate: '2026-04-30',
        limit: 100,
        offset: 0,
      } as never);
      expect(charges).toHaveLength(1);
      expect(charges[0].cpt_code).toBe('92014');
    });

    it('filters by status', async () => {
      const { charges } = await service.list(practiceId, {
        status: 'pending',
        limit: 100,
        offset: 0,
      } as never);
      expect(charges).toHaveLength(2);
    });
  });

  describe('update', () => {
    it('recalculates total when units change', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-08',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      const updated = await service.update(practiceId, charge.id, { units: 2 });
      expect(updated.units).toBe(2);
      expect(updated.total_amount_cents).toBe(45000);
    });

    it('updates ICD-10 codes', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-08',
        cptCode: '92004', units: 1, icd10Codes: ['H52.13'],
      });
      const updated = await service.update(practiceId, charge.id, {
        icd10Codes: ['H52.13', 'H40.11X1'],
      });
      expect(updated.icd10_codes).toEqual(['H52.13', 'H40.11X1']);
    });

    it('rejects updating voided charge', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-08',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await service.voidCharge(practiceId, charge.id, userId, 'mistake');

      await expect(
        service.update(practiceId, charge.id, { notes: 'should fail' }),
      ).rejects.toThrow('Cannot update');
    });
  });

  describe('voidCharge', () => {
    it('marks charge as voided with reason and timestamp', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-08',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      const voided = await service.voidCharge(practiceId, charge.id, userId, 'wrong patient');
      expect(voided.status).toBe('voided');
      expect(voided.voided_reason).toBe('wrong patient');
      expect(voided.voided_at).not.toBeNull();
      expect(voided.voided_by).toBe(userId);
    });

    it('rejects voiding already voided charge', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-08',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      await service.voidCharge(practiceId, charge.id, userId, 'first');
      await expect(
        service.voidCharge(practiceId, charge.id, userId, 'second'),
      ).rejects.toThrow('already voided');
    });
  });

  describe('getUnpaidBalance', () => {
    it('returns full charge amount when nothing applied', async () => {
      const charge = await service.create(practiceId, userId, {
        patientId, providerId, serviceDate: '2026-04-08',
        cptCode: '92004', units: 1, icd10Codes: [],
      });
      const balance = await service.getUnpaidBalance(charge.id);
      expect(balance).toBe(22500);
    });
  });

  it('does not return charges from another practice', async () => {
    const charge = await service.create(practiceId, userId, {
      patientId, providerId, serviceDate: '2026-04-08',
      cptCode: '92004', units: 1, icd10Codes: [],
    });
    const otherPractice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
    );
    const fetched = await service.get(otherPractice.rows[0].id, charge.id);
    expect(fetched).toBeNull();
  });
});
