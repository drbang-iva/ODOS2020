import type pg from 'pg';
import type { CreateAdjustmentInput } from '../schemas.js';
import { ChargeService } from './charge.service.js';

export interface AdjustmentRow {
  id: string;
  practice_id: string;
  charge_id: string;
  adjustment_type: string;
  amount_cents: number;
  reason: string;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export class AdjustmentService {
  private chargeService: ChargeService;

  constructor(private pool: pg.Pool) {
    this.chargeService = new ChargeService(pool);
  }

  /**
   * Create an adjustment against a charge. Verifies the charge belongs
   * to the practice and is not voided. Adjustments can be positive (debit)
   * or negative (refund/credit).
   */
  async create(
    practiceId: string,
    createdBy: string,
    input: CreateAdjustmentInput,
  ): Promise<AdjustmentRow> {
    const charge = await this.chargeService.get(practiceId, input.chargeId);
    if (!charge) throw new Error('Charge not found');
    if (charge.status === 'voided') {
      throw new Error('Cannot adjust a voided charge');
    }

    const result = await this.pool.query(
      `INSERT INTO adjustments (
        practice_id, charge_id, adjustment_type, amount_cents, reason, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        practiceId,
        input.chargeId,
        input.adjustmentType,
        input.amountCents,
        input.reason,
        input.notes ?? null,
        createdBy,
      ],
    );
    return result.rows[0];
  }

  async listForCharge(practiceId: string, chargeId: string): Promise<AdjustmentRow[]> {
    // Verify ownership of charge first
    const charge = await this.chargeService.get(practiceId, chargeId);
    if (!charge) throw new Error('Charge not found');

    const result = await this.pool.query(
      `SELECT * FROM adjustments WHERE charge_id = $1 ORDER BY created_at`,
      [chargeId],
    );
    return result.rows;
  }

  async get(practiceId: string, adjustmentId: string): Promise<AdjustmentRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM adjustments WHERE id = $1 AND practice_id = $2',
      [adjustmentId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Delete an adjustment. Used to reverse mistakes; full audit trail
   * is preserved by audit_events.
   */
  async delete(practiceId: string, adjustmentId: string): Promise<void> {
    const result = await this.pool.query(
      'DELETE FROM adjustments WHERE id = $1 AND practice_id = $2',
      [adjustmentId, practiceId],
    );
    if (result.rowCount === 0) throw new Error('Adjustment not found');
  }
}
