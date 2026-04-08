import type pg from 'pg';
import type {
  CreatePaymentInput,
  ApplyPaymentInput,
  ListPaymentsInput,
} from '../schemas.js';
import { ChargeService } from './charge.service.js';

export interface PaymentRow {
  id: string;
  practice_id: string;
  patient_id: string | null;
  payment_type: string;
  payment_method: string;
  amount_cents: number;
  unapplied_cents: number;
  payer_name: string | null;
  reference_number: string | null;
  payment_date: string;
  notes: string | null;
  voided_reason: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentApplicationRow {
  id: string;
  payment_id: string;
  charge_id: string;
  amount_cents: number;
  applied_at: string;
  applied_by: string;
}

export class PaymentService {
  private chargeService: ChargeService;

  constructor(private pool: pg.Pool) {
    this.chargeService = new ChargeService(pool);
  }

  /**
   * Create a payment and (optionally) apply it to one or more charges in a
   * single transaction. Validates that the sum of applications doesn't exceed
   * the payment amount, and that no individual application exceeds its
   * charge's unpaid balance.
   */
  async create(
    practiceId: string,
    createdBy: string,
    input: CreatePaymentInput,
  ): Promise<{ payment: PaymentRow; applications: PaymentApplicationRow[] }> {
    // Validate carrier payments have payer_name
    if (input.paymentType === 'carrier' && !input.payerName) {
      throw new Error('Carrier payments require payerName');
    }

    // Sum of applications cannot exceed payment amount
    const totalApplied = input.applications.reduce((sum, a) => sum + a.amountCents, 0);
    if (totalApplied > input.amountCents) {
      throw new Error(
        `Total applied (${totalApplied}) exceeds payment amount (${input.amountCents})`,
      );
    }

    // Verify all charges belong to this practice + don't overpay
    for (const app of input.applications) {
      const charge = await this.chargeService.get(practiceId, app.chargeId);
      if (!charge) throw new Error(`Charge ${app.chargeId} not found`);
      if (charge.status === 'voided') {
        throw new Error(`Cannot apply payment to voided charge ${app.chargeId}`);
      }
      const balance = await this.chargeService.getUnpaidBalance(app.chargeId);
      if (app.amountCents > balance) {
        throw new Error(
          `Application of ${app.amountCents} exceeds unpaid balance ${balance} on charge ${app.chargeId}`,
        );
      }
    }

    // Wrap in a transaction so payment + applications are atomic
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const unapplied = input.amountCents - totalApplied;

      const paymentResult = await client.query(
        `INSERT INTO payments (
          practice_id, patient_id, payment_type, payment_method,
          amount_cents, unapplied_cents, payer_name, reference_number,
          payment_date, notes, created_by
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11
        ) RETURNING *`,
        [
          practiceId,
          input.patientId ?? null,
          input.paymentType,
          input.paymentMethod,
          input.amountCents,
          unapplied,
          input.payerName ?? null,
          input.referenceNumber ?? null,
          input.paymentDate,
          input.notes ?? null,
          createdBy,
        ],
      );
      const payment = paymentResult.rows[0];

      const applications: PaymentApplicationRow[] = [];
      for (const app of input.applications) {
        const appResult = await client.query(
          `INSERT INTO payment_applications (payment_id, charge_id, amount_cents, applied_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [payment.id, app.chargeId, app.amountCents, createdBy],
        );
        applications.push(appResult.rows[0]);
      }

      await client.query('COMMIT');
      return { payment, applications };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async get(practiceId: string, paymentId: string): Promise<PaymentRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM payments WHERE id = $1 AND practice_id = $2',
      [paymentId, practiceId],
    );
    return result.rows[0] ?? null;
  }

  async list(
    practiceId: string,
    input: ListPaymentsInput,
  ): Promise<{ payments: PaymentRow[]; total: number }> {
    const conditions: string[] = ['practice_id = $1'];
    const values: unknown[] = [practiceId];
    let idx = 2;

    if (input.patientId) {
      conditions.push(`patient_id = $${idx++}`);
      values.push(input.patientId);
    }
    if (input.paymentType) {
      conditions.push(`payment_type = $${idx++}`);
      values.push(input.paymentType);
    }
    if (input.startDate) {
      conditions.push(`payment_date >= $${idx++}`);
      values.push(input.startDate);
    }
    if (input.endDate) {
      conditions.push(`payment_date <= $${idx++}`);
      values.push(input.endDate);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM payments WHERE ${where}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(input.limit);
    const limitParam = idx++;
    values.push(input.offset);
    const offsetParam = idx++;

    const result = await this.pool.query(
      `SELECT * FROM payments WHERE ${where}
       ORDER BY payment_date DESC, created_at DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    return { payments: result.rows, total };
  }

  /**
   * List all applications (charge links) for a payment.
   * Used for the "where did this payment go" view.
   */
  async listApplications(paymentId: string): Promise<PaymentApplicationRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM payment_applications WHERE payment_id = $1 ORDER BY applied_at`,
      [paymentId],
    );
    return result.rows;
  }

  /**
   * Apply (more of) an existing payment's unapplied balance to a charge.
   * Used when a payment was created with leftover credit and you later
   * want to put that credit toward a new charge.
   */
  async applyToCharge(
    practiceId: string,
    paymentId: string,
    appliedBy: string,
    input: ApplyPaymentInput,
  ): Promise<PaymentApplicationRow> {
    const payment = await this.get(practiceId, paymentId);
    if (!payment) throw new Error('Payment not found');
    if (payment.voided_at) throw new Error('Cannot apply voided payment');
    if (input.amountCents > payment.unapplied_cents) {
      throw new Error(
        `Application of ${input.amountCents} exceeds unapplied balance ${payment.unapplied_cents}`,
      );
    }

    const charge = await this.chargeService.get(practiceId, input.chargeId);
    if (!charge) throw new Error('Charge not found');
    if (charge.status === 'voided') throw new Error('Cannot apply payment to voided charge');

    const balance = await this.chargeService.getUnpaidBalance(input.chargeId);
    if (input.amountCents > balance) {
      throw new Error(
        `Application of ${input.amountCents} exceeds unpaid balance ${balance} on charge`,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const appResult = await client.query(
        `INSERT INTO payment_applications (payment_id, charge_id, amount_cents, applied_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [paymentId, input.chargeId, input.amountCents, appliedBy],
      );

      await client.query(
        `UPDATE payments SET unapplied_cents = unapplied_cents - $1, updated_at = NOW()
         WHERE id = $2`,
        [input.amountCents, paymentId],
      );

      await client.query('COMMIT');
      return appResult.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Void a payment. Reverses all applications by setting voided_at on the
   * payment. Application rows stay (immutable record) but the payment_ledger
   * view ignores voided payments via the WHERE clause.
   */
  async voidPayment(
    practiceId: string,
    paymentId: string,
    voidedBy: string,
    reason: string,
  ): Promise<PaymentRow> {
    const existing = await this.get(practiceId, paymentId);
    if (!existing) throw new Error('Payment not found');
    if (existing.voided_at) throw new Error('Payment already voided');

    const result = await this.pool.query(
      `UPDATE payments
       SET voided_at = NOW(), voided_by = $1, voided_reason = $2, updated_at = NOW()
       WHERE id = $3 AND practice_id = $4
       RETURNING *`,
      [voidedBy, reason, paymentId, practiceId],
    );
    return result.rows[0];
  }
}
