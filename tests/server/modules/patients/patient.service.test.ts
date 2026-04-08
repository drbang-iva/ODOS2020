import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PatientService } from '../../../../src/server/modules/patients/service.js';
import { runMigrations } from '../../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('PatientService', () => {
  let pool: pg.Pool;
  let service: PatientService;
  let practiceId: string;
  let userId: string;

  const sample = {
    firstName: 'Jane',
    middleName: 'Marie',
    lastName: 'Doe',
    dateOfBirth: '1990-06-15',
    sex: 'F' as const,
    phonePrimary: '555-0100',
    addressLine1: '100 Main St',
    city: 'Edmond',
    state: 'OK',
    zip: '73034',
    hobbies: [],
    preferredLanguage: 'en',
    communicationPref: 'phone' as const,
  };

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    service = new PatientService(pool);

    const practice = await pool.query(
      `INSERT INTO practices (name) VALUES ('Test Practice') RETURNING id`,
    );
    practiceId = practice.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (practice_id, email, password_hash, full_name)
       VALUES ($1, 'test@test.com', 'hash', 'Test User') RETURNING id`,
      [practiceId],
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('create', () => {
    it('creates a patient with all required fields', async () => {
      const patient = await service.create(practiceId, sample);
      expect(patient.id).toBeDefined();
      expect(patient.first_name).toBe('Jane');
      expect(patient.last_name).toBe('Doe');
      expect(patient.middle_name).toBe('Marie');
      expect(patient.hobbies).toEqual([]);
      expect(patient.is_active).toBe(true);
    });

    it('creates a patient with all optional fields', async () => {
      const patient = await service.create(practiceId, {
        ...sample,
        employer: 'Acme Corp',
        occupation: 'Engineer',
        hobbies: ['cycling', 'reading'],
        referringProvider: 'Dr. Smith',
        referringProviderNpi: '1234567890',
        race: 'Asian',
        ethnicity: 'Not Hispanic or Latino',
        ssnEncrypted: 'enc_ssn_123',
      });
      expect(patient.employer).toBe('Acme Corp');
      expect(patient.hobbies).toEqual(['cycling', 'reading']);
      expect(patient.race).toBe('Asian');
    });
  });

  describe('get', () => {
    it('returns a patient by id', async () => {
      const created = await service.create(practiceId, sample);
      const fetched = await service.get(practiceId, created.id);
      expect(fetched?.id).toBe(created.id);
    });

    it('returns null for non-existent patient', async () => {
      const fetched = await service.get(practiceId, '00000000-0000-0000-0000-000000000000');
      expect(fetched).toBeNull();
    });

    it('does not return patients from other practices', async () => {
      const created = await service.create(practiceId, sample);
      const otherPractice = await pool.query(
        `INSERT INTO practices (name) VALUES ('Other') RETURNING id`,
      );
      const fetched = await service.get(otherPractice.rows[0].id, created.id);
      expect(fetched).toBeNull();
    });
  });

  describe('update', () => {
    it('updates patient fields', async () => {
      const created = await service.create(practiceId, sample);
      const updated = await service.update(practiceId, created.id, {
        email: 'jane@example.com',
        phonePrimary: '555-9999',
      });
      expect(updated.email).toBe('jane@example.com');
      expect(updated.phone_primary).toBe('555-9999');
    });

    it('updates array fields like hobbies', async () => {
      const created = await service.create(practiceId, sample);
      const updated = await service.update(practiceId, created.id, {
        hobbies: ['tennis', 'hiking'],
      });
      expect(updated.hobbies).toEqual(['tennis', 'hiking']);
    });

    it('throws when patient not found', async () => {
      await expect(
        service.update(practiceId, '00000000-0000-0000-0000-000000000000', { email: 'x@x.com' }),
      ).rejects.toThrow('not found');
    });
  });

  describe('deactivate', () => {
    it('sets is_active to false', async () => {
      const created = await service.create(practiceId, sample);
      const deactivated = await service.deactivate(practiceId, created.id);
      expect(deactivated.is_active).toBe(false);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await service.create(practiceId, { ...sample, firstName: 'Alice', lastName: 'Johnson', phonePrimary: '555-1001' });
      await service.create(practiceId, { ...sample, firstName: 'Bob', lastName: 'Smith', phonePrimary: '555-1002' });
      await service.create(practiceId, { ...sample, firstName: 'Charlie', lastName: 'Johnson', phonePrimary: '555-1003', dateOfBirth: '1985-01-01' });
    });

    it('returns all active patients with no filters', async () => {
      const { patients, total } = await service.search(practiceId, { limit: 25, offset: 0, hobbies: [] as never } as never);
      expect(total).toBe(3);
      expect(patients).toHaveLength(3);
    });

    it('searches by free text q (name)', async () => {
      const { patients } = await service.search(practiceId, { q: 'Johnson', limit: 25, offset: 0 } as never);
      expect(patients).toHaveLength(2);
    });

    it('searches by free text q (phone fragment)', async () => {
      const { patients } = await service.search(practiceId, { q: '1002', limit: 25, offset: 0 } as never);
      expect(patients).toHaveLength(1);
      expect(patients[0].first_name).toBe('Bob');
    });

    it('searches by specific name filter', async () => {
      const { patients } = await service.search(practiceId, { name: 'Alice', limit: 25, offset: 0 } as never);
      expect(patients).toHaveLength(1);
    });

    it('searches by DOB', async () => {
      const { patients } = await service.search(practiceId, { dob: '1985-01-01', limit: 25, offset: 0 } as never);
      expect(patients).toHaveLength(1);
      expect(patients[0].first_name).toBe('Charlie');
    });

    it('respects pagination', async () => {
      const { patients, total } = await service.search(practiceId, { limit: 2, offset: 0 } as never);
      expect(total).toBe(3);
      expect(patients).toHaveLength(2);
    });

    it('excludes inactive patients', async () => {
      const created = await service.create(practiceId, { ...sample, firstName: 'Inactive' });
      await service.deactivate(practiceId, created.id);
      const { patients } = await service.search(practiceId, { q: 'Inactive', limit: 25, offset: 0 } as never);
      expect(patients).toHaveLength(0);
    });
  });

  describe('insurance', () => {
    let patientId: string;

    beforeEach(async () => {
      const p = await service.create(practiceId, sample);
      patientId = p.id;
    });

    it('adds and lists insurance', async () => {
      await service.addInsurance(patientId, {
        priority: 1,
        planType: 'vision',
        payerName: 'VSP',
        memberId: 'MEM123',
        subscriberRelationship: 'self',
        effectiveDate: '2026-01-01',
      });
      const list = await service.listInsurance(patientId);
      expect(list).toHaveLength(1);
      expect(list[0].payer_name).toBe('VSP');
    });

    it('orders insurance by priority', async () => {
      await service.addInsurance(patientId, {
        priority: 2, planType: 'vision', payerName: 'EyeMed', memberId: '222',
        subscriberRelationship: 'self', effectiveDate: '2026-01-01',
      });
      await service.addInsurance(patientId, {
        priority: 1, planType: 'medical', payerName: 'Aetna', memberId: '111',
        subscriberRelationship: 'self', effectiveDate: '2026-01-01',
      });
      const list = await service.listInsurance(patientId);
      expect(list[0].priority).toBe(1);
      expect(list[1].priority).toBe(2);
    });

    it('updates insurance', async () => {
      const ins = await service.addInsurance(patientId, {
        priority: 1, planType: 'vision', payerName: 'VSP', memberId: 'MEM123',
        subscriberRelationship: 'self', effectiveDate: '2026-01-01',
      });
      const updated = await service.updateInsurance(patientId, ins.id, {
        memberId: 'MEM456',
        copayCents: 2000,
      });
      expect(updated.member_id).toBe('MEM456');
      expect(updated.copay_cents).toBe(2000);
    });

    it('deletes insurance', async () => {
      const ins = await service.addInsurance(patientId, {
        priority: 1, planType: 'vision', payerName: 'VSP', memberId: 'MEM123',
        subscriberRelationship: 'self', effectiveDate: '2026-01-01',
      });
      await service.deleteInsurance(patientId, ins.id);
      const list = await service.listInsurance(patientId);
      expect(list).toHaveLength(0);
    });
  });

  describe('responsible parties', () => {
    it('links a minor to a parent', async () => {
      const minor = await service.create(practiceId, {
        ...sample, firstName: 'Kid', lastName: 'Doe', dateOfBirth: '2015-01-01',
      });
      const parent = await service.create(practiceId, {
        ...sample, firstName: 'Mom', lastName: 'Doe', dateOfBirth: '1985-01-01',
      });

      const rp = await service.addResponsibleParty(minor.id, {
        responsiblePartyPatientId: parent.id,
        relationship: 'parent',
        isFinancialResponsible: true,
        isConsentAuthority: true,
        isInsuranceSubscriber: true,
        isPrimary: true,
      });

      expect(rp.relationship).toBe('parent');
      expect(rp.is_consent_authority).toBe(true);

      const list = await service.listResponsibleParties(minor.id);
      expect(list).toHaveLength(1);
      expect(list[0].responsible_party_patient_id).toBe(parent.id);
    });

    it('deletes responsible party', async () => {
      const minor = await service.create(practiceId, { ...sample, firstName: 'Kid' });
      const rp = await service.addResponsibleParty(minor.id, {
        relationship: 'parent',
        isFinancialResponsible: true,
        isConsentAuthority: true,
        isInsuranceSubscriber: false,
        isPrimary: true,
      });
      await service.deleteResponsibleParty(minor.id, rp.id);
      const list = await service.listResponsibleParties(minor.id);
      expect(list).toHaveLength(0);
    });
  });

  describe('alerts', () => {
    let patientId: string;

    beforeEach(async () => {
      const p = await service.create(practiceId, sample);
      patientId = p.id;
    });

    it('creates and lists unresolved alerts by default', async () => {
      await service.addAlert(patientId, userId, {
        alertType: 'allergy',
        severity: 'critical',
        message: 'Sulfa allergy',
      });
      const alerts = await service.listAlerts(patientId);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('critical');
    });

    it('orders alerts by severity (critical first)', async () => {
      await service.addAlert(patientId, userId, { alertType: 'custom', severity: 'info', message: 'Info' });
      await service.addAlert(patientId, userId, { alertType: 'allergy', severity: 'critical', message: 'Critical' });
      await service.addAlert(patientId, userId, { alertType: 'balance', severity: 'warning', message: 'Warning' });

      const alerts = await service.listAlerts(patientId);
      expect(alerts[0].severity).toBe('critical');
      expect(alerts[1].severity).toBe('warning');
      expect(alerts[2].severity).toBe('info');
    });

    it('resolves alerts', async () => {
      const alert = await service.addAlert(patientId, userId, {
        alertType: 'balance', severity: 'warning', message: 'Balance due',
      });
      const resolved = await service.resolveAlert(patientId, alert.id, userId);
      expect(resolved.is_resolved).toBe(true);
      expect(resolved.resolved_by).toBe(userId);
      expect(resolved.resolved_at).not.toBeNull();
    });

    it('excludes resolved alerts by default', async () => {
      const alert = await service.addAlert(patientId, userId, {
        alertType: 'balance', severity: 'warning', message: 'Old',
      });
      await service.resolveAlert(patientId, alert.id, userId);

      const unresolved = await service.listAlerts(patientId);
      expect(unresolved).toHaveLength(0);

      const all = await service.listAlerts(patientId, true);
      expect(all).toHaveLength(1);
    });
  });
});
