import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import type { ClaimSearchFilters, ClaimSearchRow } from "./claim-search.js";
import {
  reconcileClaimReadModel,
  type ClaimReadModelReconciliation,
  type ClaimReadModelRow,
  type ClaimWorklistGroup,
  type NeverPaidUntouchedMetricRow,
} from "./claim-read-model.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const SCHEMA_LEDGER_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const CLAIM_SCHEMA_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-08-30-claim-touch-ledger.sql", import.meta.url),
);
const SECONDS_PER_DAY = 60 * 60 * 24;

export interface ClaimReadModelStore {
  rebuild(rows: readonly ClaimReadModelRow[], projectedAt: string): Promise<void>;
  upsert(row: ClaimReadModelRow, projectedAt: string): Promise<void>;
  listAll(): Promise<ClaimReadModelRow[]>;
  search(input: { filters: ClaimSearchFilters; at: string }): Promise<ClaimSearchRow[]>;
  worklist(input: {
    at: string;
    thresholds: readonly [number, number, number];
  }): Promise<ClaimWorklistGroup[]>;
  neverPaidUntouchedMetric(): Promise<NeverPaidUntouchedMetricRow[]>;
  reconcile(truth: readonly ClaimReadModelRow[]): Promise<ClaimReadModelReconciliation>;
}

type ClaimReadModelPool = Pick<Pool, "connect" | "query" | "end">;

export class PgClaimReadModelStore implements ClaimReadModelStore {
  private readonly pool: ClaimReadModelPool;
  private readonly ownsPool: boolean;
  private schemaReady?: Promise<void>;

  constructor(options: {
    postgresUrl?: string;
    pool?: ClaimReadModelPool;
    initializeSchema?: boolean;
  } = {}) {
    this.ownsPool = !options.pool;
    this.pool = options.pool ?? new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
    if (options.initializeSchema === false) this.schemaReady = Promise.resolve();
  }

  async rebuild(rows: readonly ClaimReadModelRow[], projectedAt: string): Promise<void> {
    assertDateTime(projectedAt, "Projection timestamp");
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE odos_claim_work_state IN ACCESS EXCLUSIVE MODE");
      await client.query("DELETE FROM odos_claim_work_state");
      for (const row of rows) await upsertRow(client, row, projectedAt);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async upsert(row: ClaimReadModelRow, projectedAt: string): Promise<void> {
    assertDateTime(projectedAt, "Projection timestamp");
    await this.ensureSchema();
    await upsertRow(this.pool, row, projectedAt);
  }

  async listAll(): Promise<ClaimReadModelRow[]> {
    await this.ensureSchema();
    const result = await this.pool.query<ClaimReadModelDbRow>(`
      SELECT claim_reference, claim_number, patient_reference, patient_display,
        provider_reference, provider_display, cpt_codes, total_charged_cents,
        collected_cents, patient_responsibility_cents, claim_status,
        payer_reference, payer_display, office_reference, office_display,
        billed_at, is_open, touch_count, last_touched_at, last_touched_by,
        reason_code, reason_display, resolution_path
      FROM odos_claim_work_state
      ORDER BY claim_reference
    `);
    return result.rows.map(rowFromDb);
  }

  async search(input: { filters: ClaimSearchFilters; at: string }): Promise<ClaimSearchRow[]> {
    assertDateTime(input.at, "Claim search timestamp");
    await this.ensureSchema();
    const filters = input.filters;
    const patientReferences = filters.patientReferences ? [...filters.patientReferences] : null;
    const result = await this.pool.query<ClaimReadModelDbRow & { days_since_submission: string | number }>(`
      SELECT claim_reference, claim_number, patient_reference, patient_display,
        provider_reference, provider_display, cpt_codes, total_charged_cents,
        collected_cents, patient_responsibility_cents, claim_status,
        payer_reference, payer_display, office_reference, office_display,
        billed_at, is_open, touch_count, last_touched_at, last_touched_by,
        reason_code, reason_display, resolution_path,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - billed_at)) / ${SECONDS_PER_DAY}))::integer AS days_since_submission
      FROM odos_claim_work_state
      WHERE ($2::text[] IS NULL OR patient_reference = ANY($2::text[]))
        AND ($3::text IS NULL OR LOWER(patient_display) LIKE '%' || LOWER($3) || '%')
        AND ($4::text IS NULL OR LOWER(claim_reference) LIKE '%' || LOWER($4) || '%' OR LOWER(claim_number) LIKE '%' || LOWER($4) || '%')
        AND ($5::text IS NULL OR claim_status = $5)
        AND ($6::text IS NULL OR LOWER(payer_reference) LIKE '%' || LOWER($6) || '%' OR LOWER(payer_display) LIKE '%' || LOWER($6) || '%')
        AND ($7::text IS NULL OR LOWER(COALESCE(office_reference, '')) LIKE '%' || LOWER($7) || '%' OR LOWER(COALESCE(office_display, '')) LIKE '%' || LOWER($7) || '%')
        AND ($8::text IS NULL OR cpt_codes ? $8)
        AND ($9::integer IS NULL OR total_charged_cents >= $9)
        AND ($10::integer IS NULL OR total_charged_cents <= $10)
        AND ($11::integer IS NULL OR GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - billed_at)) / ${SECONDS_PER_DAY})) >= $11)
        AND ($12::integer IS NULL OR GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - billed_at)) / ${SECONDS_PER_DAY})) <= $12)
        AND (NOT $13::boolean OR is_open)
      ORDER BY days_since_submission DESC, claim_number
    `, [
      input.at, patientReferences, filters.patient ?? null, filters.claim ?? null,
      filters.status ?? null, filters.carrier ?? null, filters.office ?? null,
      filters.cpt ?? null, filters.minAmountCents ?? null, filters.maxAmountCents ?? null,
      filters.minDaysOutstanding ?? null, filters.maxDaysOutstanding ?? null,
      filters.outstandingOnly ?? false,
    ]);
    return result.rows.map((row) => {
      const projected = rowFromDb(row);
      return {
        claimReference: projected.claimReference,
        claimNumber: projected.claimNumber,
        patientReference: projected.patientReference,
        patient: projected.patient,
        providerReference: projected.providerReference,
        provider: projected.provider,
        cptCodes: projected.cptCodes,
        totalChargedCents: projected.totalChargedCents,
        insurancePaidCents: projected.collectedCents,
        patientResponsibilityCents: projected.patientResponsibilityCents,
        status: projected.status,
        payerReference: projected.payerReference,
        payer: projected.payer,
        ...(projected.officeReference ? { officeReference: projected.officeReference } : {}),
        ...(projected.office ? { office: projected.office } : {}),
        daysSinceSubmission: number(row.days_since_submission),
        touchCount: projected.touchCount,
        lastTouchedAt: projected.lastTouchedAt,
        lastTouchedBy: projected.lastTouchedBy,
      };
    });
  }

  async worklist(input: {
    at: string;
    thresholds: readonly [number, number, number];
  }): Promise<ClaimWorklistGroup[]> {
    assertDateTime(input.at, "Worklist timestamp");
    assertThresholds(input.thresholds);
    await this.ensureSchema();
    const [first, second, third] = input.thresholds;
    const result = await this.pool.query<ClaimWorklistGroupDbRow>(`
      WITH facts AS (
        SELECT *,
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - billed_at)) / ${SECONDS_PER_DAY}))::integer AS days_since_billed,
          CASE WHEN last_touched_at IS NULL THEN NULL
            ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - last_touched_at)) / ${SECONDS_PER_DAY}))::integer
          END AS days_since_touched
        FROM odos_claim_work_state
        WHERE is_open
      )
      SELECT reason_code, COALESCE(reason_display, 'No typed reason') AS reason_display,
        resolution_path, COUNT(*)::integer AS claim_count,
        SUM(GREATEST(0, total_charged_cents - collected_cents))::bigint AS outstanding_total,
        jsonb_agg(jsonb_build_object(
          'claimReference', claim_reference,
          'claimNumber', claim_number,
          'patientReference', patient_reference,
          'patient', patient_display,
          'providerReference', provider_reference,
          'provider', provider_display,
          'cptCodes', cpt_codes,
          'totalChargedCents', total_charged_cents,
          'collectedCents', collected_cents,
          'patientResponsibilityCents', patient_responsibility_cents,
          'status', claim_status,
          'payerReference', payer_reference,
          'payer', payer_display,
          'officeReference', office_reference,
          'office', office_display,
          'billedAt', billed_at,
          'open', is_open,
          'touchCount', touch_count,
          'lastTouchedAt', last_touched_at,
          'lastTouchedBy', last_touched_by,
          'reasonCode', reason_code,
          'reasonDisplay', reason_display,
          'resolutionPath', resolution_path,
          'daysSinceBilled', days_since_billed,
          'agingBucket', CASE
            WHEN days_since_billed >= $4 THEN CONCAT($4::text, '+')
            WHEN days_since_billed >= $3 THEN CONCAT($3::text, '-', ($4 - 1)::text)
            WHEN days_since_billed >= $2 THEN CONCAT($2::text, '-', ($3 - 1)::text)
            ELSE 'current'
          END,
          'daysSinceTouched', days_since_touched,
          'untouchedRankingDays', CASE WHEN touch_count = 0 THEN days_since_billed ELSE 0 END,
          'outstandingCents', GREATEST(0, total_charged_cents - collected_cents)
        ) ORDER BY
          (touch_count = 0 AND days_since_billed >= $2) DESC,
          CASE WHEN touch_count = 0 THEN days_since_billed ELSE 0 END DESC,
          days_since_billed DESC,
          claim_reference) AS rows_json
      FROM facts
      GROUP BY reason_code, reason_display, resolution_path
      ORDER BY
        MAX((touch_count = 0 AND days_since_billed >= $2)::integer) DESC,
        MAX(CASE WHEN touch_count = 0 THEN days_since_billed ELSE 0 END) DESC,
        COALESCE(reason_display, 'No typed reason')
    `, [input.at, first, second, third]);
    return result.rows.map((row) => ({
      reason: {
        code: row.reason_code,
        display: row.reason_display,
        resolutionPath: row.resolution_path,
      },
      count: number(row.claim_count),
      totalOutstandingCents: number(row.outstanding_total),
      rows: jsonRows(row.rows_json),
    }));
  }

  async neverPaidUntouchedMetric(): Promise<NeverPaidUntouchedMetricRow[]> {
    await this.ensureSchema();
    const result = await this.pool.query<NeverPaidMetricDbRow>(`
      SELECT payer_reference, payer_display,
        to_char(date_trunc('month', billed_at), 'YYYY-MM') AS billed_month,
        COUNT(*)::integer AS billed_claim_count,
        COUNT(*) FILTER (WHERE collected_cents = 0 AND touch_count = 0)::integer AS warning_count,
        (COUNT(*) FILTER (WHERE collected_cents = 0 AND touch_count = 0)::double precision
          / NULLIF(COUNT(*), 0)) AS warning_rate
      FROM odos_claim_work_state
      GROUP BY payer_reference, payer_display, date_trunc('month', billed_at)
      ORDER BY date_trunc('month', billed_at), payer_display
    `);
    return result.rows.map((row) => ({
      payerReference: row.payer_reference,
      payer: row.payer_display,
      billedMonth: row.billed_month,
      billedClaimCount: number(row.billed_claim_count),
      neverPaidUntouchedCount: number(row.warning_count),
      neverPaidUntouchedRate: number(row.warning_rate),
    }));
  }

  async reconcile(truth: readonly ClaimReadModelRow[]): Promise<ClaimReadModelReconciliation> {
    return reconcileClaimReadModel(truth, await this.listAll());
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.initializeSchema();
    await this.schemaReady;
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(await readFile(SCHEMA_LEDGER_FILE, "utf8"));
      await client.query("BEGIN");
      await client.query("LOCK TABLE odos_schema_migrations IN SHARE ROW EXCLUSIVE MODE");
      const filename = basename(CLAIM_SCHEMA_FILE);
      const applied = await client.query("SELECT 1 FROM odos_schema_migrations WHERE filename = $1", [filename]);
      if (!applied.rowCount) {
        await client.query(await readFile(CLAIM_SCHEMA_FILE, "utf8"));
        await client.query("INSERT INTO odos_schema_migrations (filename) VALUES ($1)", [filename]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      this.schemaReady = undefined;
      throw error;
    } finally {
      client.release();
    }
  }
}

async function upsertRow(
  database: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  row: ClaimReadModelRow,
  projectedAt: string,
): Promise<void> {
  await database.query(`
    INSERT INTO odos_claim_work_state (
      claim_reference, claim_number, patient_reference, patient_display,
      provider_reference, provider_display, cpt_codes, total_charged_cents,
      collected_cents, patient_responsibility_cents, claim_status,
      payer_reference, payer_display, office_reference, office_display,
      billed_at, is_open, touch_count, last_touched_at, last_touched_by,
      reason_code, reason_display, resolution_path, projected_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
      $12, $13, $14, $15, $16::timestamptz, $17, $18,
      $19::timestamptz, $20, $21, $22, $23, $24::timestamptz
    )
    ON CONFLICT (claim_reference) DO UPDATE SET
      claim_number = EXCLUDED.claim_number,
      patient_reference = EXCLUDED.patient_reference,
      patient_display = EXCLUDED.patient_display,
      provider_reference = EXCLUDED.provider_reference,
      provider_display = EXCLUDED.provider_display,
      cpt_codes = EXCLUDED.cpt_codes,
      total_charged_cents = EXCLUDED.total_charged_cents,
      collected_cents = EXCLUDED.collected_cents,
      patient_responsibility_cents = EXCLUDED.patient_responsibility_cents,
      claim_status = EXCLUDED.claim_status,
      payer_reference = EXCLUDED.payer_reference,
      payer_display = EXCLUDED.payer_display,
      office_reference = EXCLUDED.office_reference,
      office_display = EXCLUDED.office_display,
      billed_at = EXCLUDED.billed_at,
      is_open = EXCLUDED.is_open,
      touch_count = EXCLUDED.touch_count,
      last_touched_at = EXCLUDED.last_touched_at,
      last_touched_by = EXCLUDED.last_touched_by,
      reason_code = EXCLUDED.reason_code,
      reason_display = EXCLUDED.reason_display,
      resolution_path = EXCLUDED.resolution_path,
      projected_at = EXCLUDED.projected_at
  `, [
    row.claimReference,
    row.claimNumber,
    row.patientReference,
    row.patient,
    row.providerReference,
    row.provider,
    JSON.stringify(row.cptCodes),
    row.totalChargedCents,
    row.collectedCents,
    row.patientResponsibilityCents,
    row.status,
    row.payerReference,
    row.payer,
    row.officeReference ?? null,
    row.office ?? null,
    row.billedAt,
    row.open,
    row.touchCount,
    row.lastTouchedAt,
    row.lastTouchedBy,
    row.reasonCode,
    row.reasonDisplay,
    row.resolutionPath,
    projectedAt,
  ]);
}

function rowFromDb(row: ClaimReadModelDbRow): ClaimReadModelRow {
  return {
    claimReference: row.claim_reference,
    claimNumber: row.claim_number,
    patientReference: row.patient_reference,
    patient: row.patient_display,
    providerReference: row.provider_reference,
    provider: row.provider_display,
    cptCodes: jsonStrings(row.cpt_codes),
    totalChargedCents: number(row.total_charged_cents),
    collectedCents: number(row.collected_cents),
    patientResponsibilityCents: number(row.patient_responsibility_cents),
    status: row.claim_status as ClaimReadModelRow["status"],
    payerReference: row.payer_reference,
    payer: row.payer_display,
    ...(row.office_reference ? { officeReference: row.office_reference } : {}),
    ...(row.office_display ? { office: row.office_display } : {}),
    billedAt: iso(row.billed_at),
    open: row.is_open,
    touchCount: number(row.touch_count),
    lastTouchedAt: row.last_touched_at ? iso(row.last_touched_at) : null,
    lastTouchedBy: row.last_touched_by,
    reasonCode: row.reason_code,
    reasonDisplay: row.reason_display,
    resolutionPath: row.resolution_path,
  };
}

function jsonRows(value: unknown): ClaimWorklistGroup["rows"] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("Claim worklist rows must be a JSON array.");
  return parsed as ClaimWorklistGroup["rows"];
}

function jsonStrings(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Claim read-model CPT codes must be a JSON string array.");
  }
  return parsed;
}

function number(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Claim read-model numeric result is invalid.");
  return parsed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertDateTime(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid date-time.`);
}

function assertThresholds(thresholds: readonly [number, number, number]): void {
  if (
    thresholds.some((threshold) => !Number.isInteger(threshold) || threshold <= 0)
    || !(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2])
  ) throw new Error("Claim aging thresholds must be three ascending positive whole days.");
}

interface ClaimReadModelDbRow {
  claim_reference: string;
  claim_number: string;
  patient_reference: string;
  patient_display: string;
  provider_reference: string;
  provider_display: string;
  cpt_codes: unknown;
  total_charged_cents: string | number;
  collected_cents: string | number;
  patient_responsibility_cents: string | number;
  claim_status: string;
  payer_reference: string;
  payer_display: string;
  office_reference: string | null;
  office_display: string | null;
  billed_at: Date | string;
  is_open: boolean;
  touch_count: string | number;
  last_touched_at: Date | string | null;
  last_touched_by: string | null;
  reason_code: string | null;
  reason_display: string | null;
  resolution_path: string | null;
}

interface ClaimWorklistGroupDbRow {
  reason_code: string | null;
  reason_display: string;
  resolution_path: string | null;
  claim_count: string | number;
  outstanding_total: string | number;
  rows_json: unknown;
}

interface NeverPaidMetricDbRow {
  payer_reference: string;
  payer_display: string;
  billed_month: string;
  billed_claim_count: string | number;
  warning_count: string | number;
  warning_rate: string | number;
}

async function rollbackQuietly(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the originating database error.
  }
}
