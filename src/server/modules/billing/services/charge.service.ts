import type pg from 'pg';
import type {
  CreateChargeInput,
  UpdateChargeInput,
  ListChargesInput,
} from '../schemas.js';
import { FeeScheduleService } from './fee-schedule.service.js';

export interface ChargeRow {
  id: string;
  practice_id: string;
  patient_id: string;
  appointment_id: string | null;
  provider_id: string;
  service_date: string;
  cpt_code: string;
  modifier: string | null;
  icd10_codes: string[];
  description: string | null;
  units: number;
  unit_amount_cents: number;
  total_amount_cents: number;
  insurance_responsibility_cents: number;
  patient_responsibility_cents: number;
  status: string;
  fee_schedule_id: string | null;
  notes: string | null;
  voided_reason: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class ChargeService {
  private feeScheduleService: FeeScheduleService;

  constructor(private pool: pg.Pool) {
    this.feeScheduleService = new FeeScheduleService(pool);
  }

  /**
   * Create a new charge. If unitAmountCents is not provided, looks it up
   * from the specified feeScheduleId or the practice's default schedule.
   * Throws if no price can be determined.
   */
  async create(
    practiceId: string,
    createdBy: string,
    input: CreateChargeInput,
  ): Promise<ChargeRow> {
    // Resolve unit price
    let unitAmount = input.unitAmountCents;
    let feeScheduleId = input.feeScheduleId ?? null;

    if (unitAmount === undefined) {
      // Need to look up price from a schedule
      let schedule = feeScheduleId
        ? await this.feeScheduleService.get(practiceId, feeScheduleId)
        : await this.feeScheduleService.getDefault(practiceId);

      if (!schedule) {
        throw new Error(
          'No price provided and no fee schedule available. Set a default fee schedule or provide unitAmountCents.',
        );
      }

      const price = await this.feeScheduleService.lookupPrice(
        schedule.id,
        input.cptCode,
        input.modifier,
      );
      if (price === null) {
        throw new Error(
          `Price not found for CPT ${input.cptCode}${input.modifier ? ` (${input.modifier})` : ''} in schedule ${schedule.name}. Add it to the schedule or provide unitAmountCents.`,
        );
      }

      unitAmount = price;
      feeScheduleId = schedule.id;
    }

    const totalAmount = unitAmount * input.units;

    const result = await this.pool.query(
      `INSERT INTO charges (
        practice_id, patient_id, appointment_id, provider_id, service_date,
        cpt_code, modifier, icd10_codes, description, units,
        unit_amount_cents, total_amount_cents, fee_schedule_id, notes, created_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15
      ) RETURNING *`,
      [
        practiceId,
        input.patientId,
        input.appointmentId ?? null,
        input.providerId,
        input.serviceDate,
        input.cptCode,
        input.modifier ?? null,
        input.icd10Codes,
        input.description ?? null,
        input.units,
        unitAmount,
        totalAmount,
        feeScheduleId,
        input.notes ?? null,
        createdBy,
      ],
    );
    return result.rows[0];
  }

  async get(practiceId: string, chargeId: string): Promise<ChargeRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM charges WHERE id = $1 AND practice_id = $2',
      [chargeId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async list(
    practiceId: string,
    input: ListChargesInput,
  ): Promise<{ charges: ChargeRow[]; total: number }> {
    const conditions: string[] = ['practice_id = $1'];
    const values: unknown[] = [practiceId];
    let idx = 2;

    if (input.patientId) {
      conditions.push(`patient_id = $${idx++}`);
      values.push(input.patientId);
    }
    if (input.appointmentId) {
      conditions.push(`appointment_id = $${idx++}`);
      values.push(input.appointmentId);
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
      conditions.push(`service_date >= $${idx++}`);
      values.push(input.startDate);
    }
    if (input.endDate) {
      conditions.push(`service_date <= $${idx++}`);
      values.push(input.endDate);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int as total FROM charges WHERE ${where}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(input.limit);
    const limitParam = idx++;
    values.push(input.offset);
    const offsetParam = idx++;

    const result = await this.pool.query(
      `SELECT * FROM charges WHERE ${where}
       ORDER BY service_date DESC, created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    return { charges: result.rows, total };
  }

  /**
   * Update a charge. Only allowed for charges in 'pending' status.
   * Recalculates total_amount_cents if units or unit_amount_cents change.
   */
  async update(
    practiceId: string,
    chargeId: string,
    input: UpdateChargeInput,
  ): Promise<ChargeRow> {
    const existing = await this.get(practiceId, chargeId);
    if (!existing) throw new Error('Charge not found');
    if (existing.status !== 'pending') {
      throw new Error(`Cannot update ${existing.status} charge — only pending charges can be edited`);
    }

    const newUnits = input.units ?? existing.units;
    const newUnitAmount = input.unitAmountCents ?? existing.unit_amount_cents;
    const newTotal = newUnits * newUnitAmount;

    const fieldMap: Record<string, string> = {
      icd10Codes: 'icd10_codes',
      description: 'description',
      units: 'units',
      unitAmountCents: 'unit_amount_cents',
      notes: 'notes',
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

    // Always recompute total if units/amount changed
    if (input.units !== undefined || input.unitAmountCents !== undefined) {
      setClauses.push(`total_amount_cents = $${idx++}`);
      values.push(newTotal);
    }

    values.push(chargeId);
    const idParam = idx++;
    values.push(practiceId);
    const practiceParam = idx++;

    const result = await this.pool.query(
      `UPDATE charges SET ${setClauses.join(', ')}
       WHERE id = $${idParam} AND practice_id = $${practiceParam}
       RETURNING *`,
      values,
    );
    return result.rows[0];
  }

  /**
   * Void a charge. Soft delete — keeps the row for audit but excludes from
   * ledger calculations. A voided charge cannot be unvoided; create a new
   * charge if needed.
   */
  async voidCharge(
    practiceId: string,
    chargeId: string,
    voidedBy: string,
    reason: string,
  ): Promise<ChargeRow> {
    const existing = await this.get(practiceId, chargeId);
    if (!existing) throw new Error('Charge not found');
    if (existing.status === 'voided') throw new Error('Charge already voided');

    const result = await this.pool.query(
      `UPDATE charges
       SET status = 'voided', voided_reason = $1, voided_at = NOW(), voided_by = $2, updated_at = NOW()
       WHERE id = $3 AND practice_id = $4
       RETURNING *`,
      [reason, voidedBy, chargeId, practiceId],
    );
    return result.rows[0];
  }

  /**
   * Get the unpaid balance for a charge: total - applied payments - adjustments.
   * Used by payment apply logic to prevent overpayment.
   */
  async getUnpaidBalance(chargeId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT
        c.total_amount_cents
          - COALESCE((SELECT SUM(amount_cents) FROM payment_applications WHERE charge_id = c.id), 0)
          - COALESCE((SELECT SUM(amount_cents) FROM adjustments WHERE charge_id = c.id), 0)
        AS balance_cents
       FROM charges c WHERE c.id = $1`,
      [chargeId],
    );
    return Number(result.rows[0]?.balance_cents ?? 0);
  }
}
