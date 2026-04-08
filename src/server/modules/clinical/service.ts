import type pg from 'pg';
import type { CreateEncounterInput, ListEncountersInput } from './schemas.js';
import type { DomainEventBus } from '../../events/bus.js';
import { buildEvent, type ActorContext } from '../../events/builder.js';

export interface ClinicalEncounterRow {
  id: string;
  practice_id: string;
  patient_id: string;
  appointment_id: string | null;
  provider_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  protocol_id: string | null;
  signed_by: string | null;
  signed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * ClinicalEncounterService — SHELL ONLY.
 *
 * Creates, reads, lists, and signs encounters. Does NOT yet handle exam
 * fields (HPI, vitals, exam findings, assessment, plan) — those tables and
 * methods come in follow-up work after Eric red-pens each section.
 *
 * The signing lifecycle is intentionally simple: draft → signed. Amendments
 * to signed encounters (which in real EHRs create a new immutable record
 * with a pointer back) are deferred until exam fields exist.
 */
export class ClinicalEncounterService {
  constructor(
    private pool: pg.Pool,
    private eventBus: DomainEventBus,
  ) {}

  /**
   * Create a new draft encounter. Usually called when a provider opens a
   * patient's chart for the first time on a given visit. If the encounter
   * is linked to an appointment, we verify the appointment belongs to the
   * same practice and patient.
   */
  async create(
    practiceId: string,
    input: CreateEncounterInput,
    actor: ActorContext,
  ): Promise<ClinicalEncounterRow> {
    // Verify the patient belongs to the practice
    const patientCheck = await this.pool.query(
      'SELECT 1 FROM patients WHERE id = $1 AND practice_id = $2',
      [input.patientId, practiceId],
    );
    if (patientCheck.rows.length === 0) {
      throw new Error('Patient not found');
    }

    // Verify the provider belongs to the practice
    const providerCheck = await this.pool.query(
      'SELECT 1 FROM users WHERE id = $1 AND practice_id = $2 AND is_provider = true',
      [input.providerId, practiceId],
    );
    if (providerCheck.rows.length === 0) {
      throw new Error('Provider not found');
    }

    // If linked to an appointment, verify it matches practice + patient
    if (input.appointmentId) {
      const apptCheck = await this.pool.query(
        `SELECT 1 FROM appointments
         WHERE id = $1 AND practice_id = $2 AND patient_id = $3`,
        [input.appointmentId, practiceId, input.patientId],
      );
      if (apptCheck.rows.length === 0) {
        throw new Error('Appointment not found or does not match patient');
      }
    }

    const result = await this.pool.query(
      `INSERT INTO clinical_encounters (
        practice_id, patient_id, appointment_id, provider_id, protocol_id, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        practiceId,
        input.patientId,
        input.appointmentId ?? null,
        input.providerId,
        input.protocolId ?? null,
        actor.userId,
      ],
    );
    const row = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'encounter.created',
        entityType: 'clinical_encounter',
        entityId: row.id,
        payload: {
          patientId: row.patient_id,
          providerId: row.provider_id,
          appointmentId: row.appointment_id,
        },
        newState: row,
      }),
    );

    return row;
  }

  async get(
    practiceId: string,
    encounterId: string,
  ): Promise<ClinicalEncounterRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM clinical_encounters WHERE id = $1 AND practice_id = $2',
      [encounterId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async list(
    practiceId: string,
    input: ListEncountersInput,
  ): Promise<{ encounters: ClinicalEncounterRow[]; total: number }> {
    const conditions: string[] = ['practice_id = $1'];
    const values: unknown[] = [practiceId];
    let idx = 2;

    if (input.patientId) {
      conditions.push(`patient_id = $${idx++}`);
      values.push(input.patientId);
    }
    if (input.providerId) {
      conditions.push(`provider_id = $${idx++}`);
      values.push(input.providerId);
    }
    if (input.status) {
      conditions.push(`status = $${idx++}`);
      values.push(input.status);
    }
    if (input.startDate) {
      conditions.push(`started_at >= ($${idx++}::date)::timestamptz`);
      values.push(input.startDate);
    }
    if (input.endDate) {
      conditions.push(`started_at < (($${idx++}::date) + interval '1 day')::timestamptz`);
      values.push(input.endDate);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM clinical_encounters WHERE ${where}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(input.limit);
    const limitParam = idx++;
    values.push(input.offset);
    const offsetParam = idx++;

    const result = await this.pool.query(
      `SELECT * FROM clinical_encounters WHERE ${where}
       ORDER BY started_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    return { encounters: result.rows, total };
  }

  /**
   * Sign the encounter, locking it for billing. This is the transition
   * from draft → signed. Once signed:
   * - completed_at, signed_by, signed_at are set (enforced by table CHECK)
   * - No more edits via normal update paths (amendment flow comes later)
   */
  async sign(
    practiceId: string,
    encounterId: string,
    actor: ActorContext,
  ): Promise<ClinicalEncounterRow> {
    const before = await this.get(practiceId, encounterId);
    if (!before) throw new Error('Encounter not found');
    if (before.status === 'signed') throw new Error('Encounter already signed');

    const result = await this.pool.query(
      `UPDATE clinical_encounters
       SET status = 'signed',
           completed_at = NOW(),
           signed_by = $1,
           signed_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND practice_id = $3
       RETURNING *`,
      [actor.userId, encounterId, practiceId],
    );
    const after = result.rows[0];

    await this.eventBus.emit(
      buildEvent(actor, {
        type: 'encounter.signed',
        entityType: 'clinical_encounter',
        entityId: encounterId,
        payload: { signedBy: actor.userId },
        previousState: before,
        newState: after,
      }),
    );

    return after;
  }
}
