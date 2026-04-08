import type pg from 'pg';

export interface PatientLedgerRow {
  patient_id: string;
  practice_id: string;
  total_charged_cents: number;
  total_patient_paid_cents: number;
  total_carrier_paid_cents: number;
  total_adjustments_cents: number;
  balance_cents: number;
}

export interface ChargeWithDetailsRow {
  id: string;
  service_date: string;
  cpt_code: string;
  modifier: string | null;
  description: string | null;
  units: number;
  total_amount_cents: number;
  status: string;
  paid_cents: number;
  adjusted_cents: number;
  balance_cents: number;
}

/**
 * LedgerService — read-only views over billing data.
 *
 * patient_ledger view in the migration handles the running balance math:
 * total_charged - patient_paid - carrier_paid - adjustments = balance
 *
 * Voided charges and voided payments are excluded by the view.
 */
export class LedgerService {
  constructor(private pool: pg.Pool) {}

  /** Get the running balance + totals for a single patient. */
  async getPatientLedger(
    practiceId: string,
    patientId: string,
  ): Promise<PatientLedgerRow | null> {
    const result = await this.pool.query(
      `SELECT
        patient_id, practice_id,
        COALESCE(total_charged_cents, 0)::bigint AS total_charged_cents,
        COALESCE(total_patient_paid_cents, 0)::bigint AS total_patient_paid_cents,
        COALESCE(total_carrier_paid_cents, 0)::bigint AS total_carrier_paid_cents,
        COALESCE(total_adjustments_cents, 0)::bigint AS total_adjustments_cents,
        COALESCE(balance_cents, 0)::bigint AS balance_cents
       FROM patient_ledger
       WHERE patient_id = $1 AND practice_id = $2`,
      [patientId, practiceId],
    );
    if (result.rows.length === 0) return null;

    // Postgres returns bigint as string; convert to number
    const row = result.rows[0];
    return {
      patient_id: row.patient_id,
      practice_id: row.practice_id,
      total_charged_cents: Number(row.total_charged_cents),
      total_patient_paid_cents: Number(row.total_patient_paid_cents),
      total_carrier_paid_cents: Number(row.total_carrier_paid_cents),
      total_adjustments_cents: Number(row.total_adjustments_cents),
      balance_cents: Number(row.balance_cents),
    };
  }

  /**
   * Get the per-charge ledger detail for a patient: each charge with its
   * applied payments, adjustments, and remaining balance.
   * Voided charges are excluded.
   */
  async getPatientChargeDetails(
    practiceId: string,
    patientId: string,
  ): Promise<ChargeWithDetailsRow[]> {
    const result = await this.pool.query(
      `SELECT
        c.id,
        c.service_date,
        c.cpt_code,
        c.modifier,
        c.description,
        c.units,
        c.total_amount_cents,
        c.status,
        COALESCE((
          SELECT SUM(pa.amount_cents)
          FROM payment_applications pa
          JOIN payments pmt ON pmt.id = pa.payment_id
          WHERE pa.charge_id = c.id AND pmt.voided_at IS NULL
        ), 0)::bigint AS paid_cents,
        COALESCE((
          SELECT SUM(amount_cents) FROM adjustments WHERE charge_id = c.id
        ), 0)::bigint AS adjusted_cents,
        (c.total_amount_cents
          - COALESCE((
              SELECT SUM(pa.amount_cents)
              FROM payment_applications pa
              JOIN payments pmt ON pmt.id = pa.payment_id
              WHERE pa.charge_id = c.id AND pmt.voided_at IS NULL
            ), 0)
          - COALESCE((SELECT SUM(amount_cents) FROM adjustments WHERE charge_id = c.id), 0)
        )::bigint AS balance_cents
       FROM charges c
       WHERE c.patient_id = $1 AND c.practice_id = $2 AND c.status != 'voided'
       ORDER BY c.service_date DESC, c.created_at DESC`,
      [patientId, practiceId],
    );

    return result.rows.map((r) => ({
      id: r.id,
      service_date: r.service_date,
      cpt_code: r.cpt_code,
      modifier: r.modifier,
      description: r.description,
      units: r.units,
      total_amount_cents: r.total_amount_cents,
      status: r.status,
      paid_cents: Number(r.paid_cents),
      adjusted_cents: Number(r.adjusted_cents),
      balance_cents: Number(r.balance_cents),
    }));
  }
}
