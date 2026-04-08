import type pg from 'pg';
import type {
  CreatePatientInput,
  UpdatePatientInput,
  SearchPatientsInput,
  CreateInsuranceInput,
  UpdateInsuranceInput,
  CreateResponsiblePartyInput,
  CreateAlertInput,
} from './schemas.js';

export interface PatientRow {
  id: string;
  practice_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string;
  sex: string;
  email: string | null;
  phone_primary: string;
  phone_secondary: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  zip: string;
  ssn_encrypted: string | null;
  employer: string | null;
  occupation: string | null;
  hobbies: string[];
  referring_provider: string | null;
  referring_provider_npi: string | null;
  preferred_pharmacy: string | null;
  preferred_pharmacy_npi: string | null;
  preferred_language: string;
  communication_pref: string;
  race: string | null;
  ethnicity: string | null;
  balance_cents: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface InsuranceRow {
  id: string;
  patient_id: string;
  priority: number;
  plan_type: string;
  payer_name: string;
  payer_id: string | null;
  member_id: string;
  group_number: string | null;
  subscriber_name: string | null;
  subscriber_dob: string | null;
  subscriber_relationship: string;
  effective_date: string;
  termination_date: string | null;
  copay_cents: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ResponsiblePartyRow {
  id: string;
  patient_id: string;
  responsible_party_patient_id: string | null;
  relationship: string;
  is_financial_responsible: boolean;
  is_consent_authority: boolean;
  is_insurance_subscriber: boolean;
  insurance_subscriber_id: string | null;
  is_primary: boolean;
  court_order_notes: string | null;
  effective_date: string;
  end_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertRow {
  id: string;
  patient_id: string;
  alert_type: string;
  severity: string;
  message: string;
  is_resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_by: string;
  created_at: string;
}

export class PatientService {
  constructor(private pool: pg.Pool) {}

  // --- PATIENT CRUD ---

  async create(practiceId: string, input: CreatePatientInput): Promise<PatientRow> {
    const result = await this.pool.query(
      `INSERT INTO patients (
        practice_id, first_name, middle_name, last_name, preferred_name,
        date_of_birth, sex, email, phone_primary, phone_secondary,
        address_line1, address_line2, city, state, zip,
        ssn_encrypted, employer, occupation, hobbies,
        referring_provider, referring_provider_npi,
        preferred_pharmacy, preferred_pharmacy_npi, preferred_language,
        communication_pref, race, ethnicity
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21,
        $22, $23, $24,
        $25, $26, $27
      ) RETURNING *`,
      [
        practiceId,
        input.firstName,
        input.middleName ?? null,
        input.lastName,
        input.preferredName ?? null,
        input.dateOfBirth,
        input.sex,
        input.email ?? null,
        input.phonePrimary,
        input.phoneSecondary ?? null,
        input.addressLine1,
        input.addressLine2 ?? null,
        input.city,
        input.state,
        input.zip,
        input.ssnEncrypted ?? null,
        input.employer ?? null,
        input.occupation ?? null,
        input.hobbies,
        input.referringProvider ?? null,
        input.referringProviderNpi ?? null,
        input.preferredPharmacy ?? null,
        input.preferredPharmacyNpi ?? null,
        input.preferredLanguage,
        input.communicationPref,
        input.race ?? null,
        input.ethnicity ?? null,
      ],
    );
    return result.rows[0];
  }

  async get(practiceId: string, patientId: string): Promise<PatientRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM patients WHERE id = $1 AND practice_id = $2',
      [patientId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async update(
    practiceId: string,
    patientId: string,
    input: UpdatePatientInput,
  ): Promise<PatientRow> {
    const fieldMap: Record<string, string> = {
      firstName: 'first_name',
      middleName: 'middle_name',
      lastName: 'last_name',
      preferredName: 'preferred_name',
      dateOfBirth: 'date_of_birth',
      sex: 'sex',
      email: 'email',
      phonePrimary: 'phone_primary',
      phoneSecondary: 'phone_secondary',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      city: 'city',
      state: 'state',
      zip: 'zip',
      ssnEncrypted: 'ssn_encrypted',
      employer: 'employer',
      occupation: 'occupation',
      hobbies: 'hobbies',
      referringProvider: 'referring_provider',
      referringProviderNpi: 'referring_provider_npi',
      preferredPharmacy: 'preferred_pharmacy',
      preferredPharmacyNpi: 'preferred_pharmacy_npi',
      preferredLanguage: 'preferred_language',
      communicationPref: 'communication_pref',
      race: 'race',
      ethnicity: 'ethnicity',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    if (setClauses.length === 1) {
      // Nothing to update
      const existing = await this.get(practiceId, patientId);
      if (!existing) throw new Error('Patient not found');
      return existing;
    }

    values.push(patientId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE patients SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Patient not found');
    return result.rows[0];
  }

  async deactivate(practiceId: string, patientId: string): Promise<PatientRow> {
    const result = await this.pool.query(
      `UPDATE patients SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND practice_id = $2
       RETURNING *`,
      [patientId, practiceId],
    );
    if (result.rows.length === 0) throw new Error('Patient not found');
    return result.rows[0];
  }

  async search(practiceId: string, input: SearchPatientsInput): Promise<{ patients: PatientRow[]; total: number }> {
    const conditions: string[] = ['practice_id = $1', 'is_active = true'];
    const values: unknown[] = [practiceId];
    let idx = 2;

    if (input.q) {
      // Free text: search first_name, last_name, phone, email
      conditions.push(
        `(first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR phone_primary ILIKE $${idx} OR email ILIKE $${idx})`,
      );
      values.push(`%${input.q}%`);
      idx++;
    }
    if (input.name) {
      conditions.push(`(first_name ILIKE $${idx} OR last_name ILIKE $${idx})`);
      values.push(`%${input.name}%`);
      idx++;
    }
    if (input.phone) {
      conditions.push(`phone_primary ILIKE $${idx}`);
      values.push(`%${input.phone}%`);
      idx++;
    }
    if (input.dob) {
      conditions.push(`date_of_birth = $${idx}`);
      values.push(input.dob);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int as total FROM patients WHERE ${whereClause}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(input.limit);
    const limitParam = idx++;
    values.push(input.offset);
    const offsetParam = idx++;

    const result = await this.pool.query(
      `SELECT * FROM patients WHERE ${whereClause}
       ORDER BY last_name, first_name
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    return { patients: result.rows, total };
  }

  // --- INSURANCE ---

  async listInsurance(patientId: string): Promise<InsuranceRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM patient_insurance
       WHERE patient_id = $1
       ORDER BY priority`,
      [patientId],
    );
    return result.rows;
  }

  async addInsurance(patientId: string, input: CreateInsuranceInput): Promise<InsuranceRow> {
    const result = await this.pool.query(
      `INSERT INTO patient_insurance (
        patient_id, priority, plan_type, payer_name, payer_id,
        member_id, group_number, subscriber_name, subscriber_dob,
        subscriber_relationship, effective_date, termination_date, copay_cents
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13
      ) RETURNING *`,
      [
        patientId,
        input.priority,
        input.planType,
        input.payerName,
        input.payerId ?? null,
        input.memberId,
        input.groupNumber ?? null,
        input.subscriberName ?? null,
        input.subscriberDob ?? null,
        input.subscriberRelationship,
        input.effectiveDate,
        input.terminationDate ?? null,
        input.copayCents ?? null,
      ],
    );
    return result.rows[0];
  }

  async updateInsurance(
    patientId: string,
    insuranceId: string,
    input: UpdateInsuranceInput,
  ): Promise<InsuranceRow> {
    const fieldMap: Record<string, string> = {
      priority: 'priority',
      planType: 'plan_type',
      payerName: 'payer_name',
      payerId: 'payer_id',
      memberId: 'member_id',
      groupNumber: 'group_number',
      subscriberName: 'subscriber_name',
      subscriberDob: 'subscriber_dob',
      subscriberRelationship: 'subscriber_relationship',
      effectiveDate: 'effective_date',
      terminationDate: 'termination_date',
      copayCents: 'copay_cents',
    };

    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = fieldMap[key];
      if (!col) continue;
      setClauses.push(`${col} = $${idx++}`);
      values.push(value);
    }

    values.push(insuranceId);
    const idParam = idx++;
    values.push(patientId);
    const patientParam = idx++;

    const result = await this.pool.query(
      `UPDATE patient_insurance SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND patient_id = $${patientParam}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) throw new Error('Insurance not found');
    return result.rows[0];
  }

  async deleteInsurance(patientId: string, insuranceId: string): Promise<void> {
    const result = await this.pool.query(
      'DELETE FROM patient_insurance WHERE id = $1 AND patient_id = $2',
      [insuranceId, patientId],
    );
    if (result.rowCount === 0) throw new Error('Insurance not found');
  }

  // --- RESPONSIBLE PARTIES ---

  async listResponsibleParties(patientId: string): Promise<ResponsiblePartyRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM responsible_parties
       WHERE patient_id = $1
       ORDER BY is_primary DESC, created_at`,
      [patientId],
    );
    return result.rows;
  }

  async addResponsibleParty(
    patientId: string,
    input: CreateResponsiblePartyInput,
  ): Promise<ResponsiblePartyRow> {
    const result = await this.pool.query(
      `INSERT INTO responsible_parties (
        patient_id, responsible_party_patient_id, relationship,
        is_financial_responsible, is_consent_authority, is_insurance_subscriber,
        insurance_subscriber_id, is_primary, court_order_notes,
        effective_date, end_date
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9,
        COALESCE($10::date, CURRENT_DATE), $11
      ) RETURNING *`,
      [
        patientId,
        input.responsiblePartyPatientId ?? null,
        input.relationship,
        input.isFinancialResponsible,
        input.isConsentAuthority,
        input.isInsuranceSubscriber,
        input.insuranceSubscriberId ?? null,
        input.isPrimary,
        input.courtOrderNotes ?? null,
        input.effectiveDate ?? null,
        input.endDate ?? null,
      ],
    );
    return result.rows[0];
  }

  async deleteResponsibleParty(patientId: string, rpId: string): Promise<void> {
    const result = await this.pool.query(
      'DELETE FROM responsible_parties WHERE id = $1 AND patient_id = $2',
      [rpId, patientId],
    );
    if (result.rowCount === 0) throw new Error('Responsible party not found');
  }

  // --- ALERTS ---

  async listAlerts(patientId: string, includeResolved = false): Promise<AlertRow[]> {
    const whereClause = includeResolved
      ? 'patient_id = $1'
      : 'patient_id = $1 AND is_resolved = false';
    const result = await this.pool.query(
      `SELECT * FROM patient_alerts
       WHERE ${whereClause}
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
         created_at DESC`,
      [patientId],
    );
    return result.rows;
  }

  async addAlert(
    patientId: string,
    createdBy: string,
    input: CreateAlertInput,
  ): Promise<AlertRow> {
    const result = await this.pool.query(
      `INSERT INTO patient_alerts (patient_id, alert_type, severity, message, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [patientId, input.alertType, input.severity, input.message, createdBy],
    );
    return result.rows[0];
  }

  async resolveAlert(
    patientId: string,
    alertId: string,
    resolvedBy: string,
  ): Promise<AlertRow> {
    const result = await this.pool.query(
      `UPDATE patient_alerts
       SET is_resolved = true, resolved_by = $1, resolved_at = NOW()
       WHERE id = $2 AND patient_id = $3
       RETURNING *`,
      [resolvedBy, alertId, patientId],
    );
    if (result.rows.length === 0) throw new Error('Alert not found');
    return result.rows[0];
  }
}
