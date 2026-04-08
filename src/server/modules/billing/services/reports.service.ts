import type pg from 'pg';

/**
 * Standard AR aging buckets (days since service_date) used throughout
 * medical billing. `current` = today's/future-dated charges that aren't
 * yet past due.
 */
export const AR_BUCKETS = [
  'current',
  '0-30',
  '31-60',
  '61-90',
  '91-120',
  '120+',
] as const;

export type ArBucket = typeof AR_BUCKETS[number];

export interface ArAgingSummaryBucket {
  bucket: ArBucket;
  chargeCount: number;
  balanceCents: number;
}

export interface ArAgingSummary {
  asOf: string;
  totalBalanceCents: number;
  totalChargeCount: number;
  buckets: ArAgingSummaryBucket[];
}

export interface ArAgingDetailRow {
  chargeId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  serviceDate: string;
  cptCode: string;
  modifier: string | null;
  description: string | null;
  daysOverdue: number;
  totalAmountCents: number;
  paidCents: number;
  adjustedCents: number;
  balanceCents: number;
  bucket: ArBucket;
}

export interface ArAgingDetailsQuery {
  /** Filter to a single bucket. If omitted, all buckets are returned. */
  bucket?: ArBucket;
  /** Minimum unpaid balance (cents). Defaults to 1 — zero-balance charges are excluded. */
  minBalanceCents?: number;
  limit?: number;
  offset?: number;
}

export interface RevenueByProviderQuery {
  /** Inclusive start of the service_date range, YYYY-MM-DD */
  startDate: string;
  /** Inclusive end of the service_date range, YYYY-MM-DD */
  endDate: string;
  /** Optional: only count charges on a specific service line */
  serviceLineId?: string;
}

export interface RevenueByProviderRow {
  providerId: string;
  providerName: string;
  chargeCount: number;
  totalChargedCents: number;
  totalPaidCents: number;
  totalAdjustedCents: number;
  outstandingCents: number;
}

export interface RevenueByProviderReport {
  startDate: string;
  endDate: string;
  serviceLineId: string | null;
  generatedAt: string;
  providers: RevenueByProviderRow[];
  totals: {
    chargeCount: number;
    totalChargedCents: number;
    totalPaidCents: number;
    totalAdjustedCents: number;
    outstandingCents: number;
  };
}

/**
 * ReportsService — read-only reporting over billing data.
 *
 * AR aging computes days_overdue from (today - service_date) and bins each
 * unpaid charge into a bucket. Voided charges and voided payments are
 * excluded to match the patient_ledger view semantics.
 */
export class ReportsService {
  constructor(private pool: pg.Pool) {}

  /**
   * AR aging summary: total unpaid balance + charge count per bucket.
   * Excludes voided charges and voided payments.
   */
  async arAgingSummary(practiceId: string): Promise<ArAgingSummary> {
    const result = await this.pool.query(
      `
      WITH charge_balances AS (
        SELECT
          c.id,
          c.service_date,
          c.total_amount_cents
            - COALESCE((
                SELECT SUM(pa.amount_cents)
                FROM payment_applications pa
                JOIN payments pmt ON pmt.id = pa.payment_id
                WHERE pa.charge_id = c.id AND pmt.voided_at IS NULL
              ), 0)
            - COALESCE((
                SELECT SUM(amount_cents) FROM adjustments WHERE charge_id = c.id
              ), 0) AS balance_cents,
          (CURRENT_DATE - c.service_date) AS days_overdue
        FROM charges c
        WHERE c.practice_id = $1 AND c.status != 'voided'
      ),
      bucketed AS (
        SELECT
          CASE
            WHEN days_overdue < 0 THEN 'current'
            WHEN days_overdue <= 30 THEN '0-30'
            WHEN days_overdue <= 60 THEN '31-60'
            WHEN days_overdue <= 90 THEN '61-90'
            WHEN days_overdue <= 120 THEN '91-120'
            ELSE '120+'
          END AS bucket,
          balance_cents
        FROM charge_balances
        WHERE balance_cents > 0
      )
      SELECT
        bucket,
        COUNT(*)::int AS charge_count,
        COALESCE(SUM(balance_cents), 0)::bigint AS balance_cents
      FROM bucketed
      GROUP BY bucket
      `,
      [practiceId],
    );

    // Build a zero-filled bucket map so the response always includes every bucket
    const bucketMap = new Map<ArBucket, ArAgingSummaryBucket>();
    for (const b of AR_BUCKETS) {
      bucketMap.set(b, { bucket: b, chargeCount: 0, balanceCents: 0 });
    }

    let totalBalance = 0;
    let totalCount = 0;
    for (const row of result.rows) {
      const bucket = row.bucket as ArBucket;
      const cents = Number(row.balance_cents);
      const count = row.charge_count;
      bucketMap.set(bucket, {
        bucket,
        chargeCount: count,
        balanceCents: cents,
      });
      totalBalance += cents;
      totalCount += count;
    }

    return {
      asOf: new Date().toISOString(),
      totalBalanceCents: totalBalance,
      totalChargeCount: totalCount,
      buckets: AR_BUCKETS.map((b) => bucketMap.get(b)!),
    };
  }

  /**
   * AR aging drill-down: the individual charges that make up the summary.
   * Optionally filterable by bucket, with pagination. Ordered by days_overdue
   * descending (most overdue first) so collectors see the worst cases on top.
   */
  async arAgingDetails(
    practiceId: string,
    query: ArAgingDetailsQuery = {},
  ): Promise<{ rows: ArAgingDetailRow[]; total: number }> {
    const minBalance = query.minBalanceCents ?? 1;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const baseQuery = `
      WITH charge_balances AS (
        SELECT
          c.id AS charge_id,
          c.patient_id,
          p.first_name AS patient_first_name,
          p.last_name AS patient_last_name,
          c.service_date,
          c.cpt_code,
          c.modifier,
          c.description,
          c.total_amount_cents,
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
            - COALESCE((
                SELECT SUM(amount_cents) FROM adjustments WHERE charge_id = c.id
              ), 0))::bigint AS balance_cents,
          (CURRENT_DATE - c.service_date) AS days_overdue
        FROM charges c
        JOIN patients p ON p.id = c.patient_id
        WHERE c.practice_id = $1 AND c.status != 'voided'
      ),
      bucketed AS (
        SELECT *,
          CASE
            WHEN days_overdue < 0 THEN 'current'
            WHEN days_overdue <= 30 THEN '0-30'
            WHEN days_overdue <= 60 THEN '31-60'
            WHEN days_overdue <= 90 THEN '61-90'
            WHEN days_overdue <= 120 THEN '91-120'
            ELSE '120+'
          END AS bucket
        FROM charge_balances
        WHERE balance_cents >= $2
      )
    `;

    const conditions: string[] = [];
    const values: unknown[] = [practiceId, minBalance];
    let idx = 3;

    if (query.bucket) {
      conditions.push(`bucket = $${idx++}`);
      values.push(query.bucket);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.pool.query(
      `${baseQuery} SELECT COUNT(*)::int AS total FROM bucketed ${whereClause}`,
      values,
    );
    const total = countResult.rows[0].total;

    values.push(limit);
    const limitParam = idx++;
    values.push(offset);
    const offsetParam = idx++;

    const rowsResult = await this.pool.query(
      `${baseQuery}
       SELECT * FROM bucketed ${whereClause}
       ORDER BY days_overdue DESC, balance_cents DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      values,
    );

    const rows: ArAgingDetailRow[] = rowsResult.rows.map((r) => ({
      chargeId: r.charge_id,
      patientId: r.patient_id,
      patientFirstName: r.patient_first_name,
      patientLastName: r.patient_last_name,
      serviceDate: r.service_date instanceof Date
        ? r.service_date.toISOString().slice(0, 10)
        : String(r.service_date),
      cptCode: r.cpt_code,
      modifier: r.modifier,
      description: r.description,
      daysOverdue: r.days_overdue,
      totalAmountCents: r.total_amount_cents,
      paidCents: Number(r.paid_cents),
      adjustedCents: Number(r.adjusted_cents),
      balanceCents: Number(r.balance_cents),
      bucket: r.bucket as ArBucket,
    }));

    return { rows, total };
  }

  /**
   * Revenue by provider over a date range.
   *
   * For each provider who has at least one non-voided charge in the range,
   * returns charge_count, total_charged, total_paid, total_adjusted, and
   * outstanding = charged - paid - adjusted.
   *
   * Date range filters on service_date (inclusive on both ends), which is
   * what CMS and commercial payers care about — not when the charge was
   * entered into the system.
   *
   * Voided charges and voided payments are excluded (matches the ledger
   * view + AR aging semantics).
   *
   * Optional serviceLineId filter lets you split "eyecare revenue" from
   * "aesthetics revenue" for providers who work both.
   */
  async revenueByProvider(
    practiceId: string,
    query: RevenueByProviderQuery,
  ): Promise<RevenueByProviderReport> {
    const conditions: string[] = [
      `c.practice_id = $1`,
      `c.status != 'voided'`,
      `c.service_date >= $2::date`,
      `c.service_date <= $3::date`,
    ];
    const values: unknown[] = [practiceId, query.startDate, query.endDate];
    let idx = 4;

    // NOTE: charges has no direct service_line_id column; it's derived through
    // the charge's appointment. Filtering by serviceLineId here requires the
    // charge to have an appointment_id with a matching service line. Charges
    // that weren't created from an appointment are excluded when this filter
    // is applied — usually the right behavior for "revenue by service line"
    // reporting, but a limitation to be aware of.
    let joinClause = '';
    if (query.serviceLineId) {
      joinClause = 'JOIN appointments a ON a.id = c.appointment_id';
      conditions.push(`a.service_line_id = $${idx++}`);
      values.push(query.serviceLineId);
    }

    const whereClause = conditions.join(' AND ');

    const result = await this.pool.query(
      `
      SELECT
        c.provider_id,
        u.full_name AS provider_name,
        COUNT(*)::int AS charge_count,
        COALESCE(SUM(c.total_amount_cents), 0)::bigint AS total_charged_cents,
        COALESCE(SUM(
          (SELECT COALESCE(SUM(pa.amount_cents), 0)
           FROM payment_applications pa
           JOIN payments pmt ON pmt.id = pa.payment_id
           WHERE pa.charge_id = c.id AND pmt.voided_at IS NULL)
        ), 0)::bigint AS total_paid_cents,
        COALESCE(SUM(
          (SELECT COALESCE(SUM(amount_cents), 0)
           FROM adjustments WHERE charge_id = c.id)
        ), 0)::bigint AS total_adjusted_cents
      FROM charges c
      JOIN users u ON u.id = c.provider_id
      ${joinClause}
      WHERE ${whereClause}
      GROUP BY c.provider_id, u.full_name
      ORDER BY total_charged_cents DESC
      `,
      values,
    );

    const providers: RevenueByProviderRow[] = result.rows.map((r) => {
      const charged = Number(r.total_charged_cents);
      const paid = Number(r.total_paid_cents);
      const adjusted = Number(r.total_adjusted_cents);
      return {
        providerId: r.provider_id,
        providerName: r.provider_name,
        chargeCount: r.charge_count,
        totalChargedCents: charged,
        totalPaidCents: paid,
        totalAdjustedCents: adjusted,
        outstandingCents: charged - paid - adjusted,
      };
    });

    const totals = providers.reduce(
      (acc, p) => ({
        chargeCount: acc.chargeCount + p.chargeCount,
        totalChargedCents: acc.totalChargedCents + p.totalChargedCents,
        totalPaidCents: acc.totalPaidCents + p.totalPaidCents,
        totalAdjustedCents: acc.totalAdjustedCents + p.totalAdjustedCents,
        outstandingCents: acc.outstandingCents + p.outstandingCents,
      }),
      {
        chargeCount: 0,
        totalChargedCents: 0,
        totalPaidCents: 0,
        totalAdjustedCents: 0,
        outstandingCents: 0,
      },
    );

    return {
      startDate: query.startDate,
      endDate: query.endDate,
      serviceLineId: query.serviceLineId ?? null,
      generatedAt: new Date().toISOString(),
      providers,
      totals,
    };
  }
}
