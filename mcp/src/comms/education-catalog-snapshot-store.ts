import type { Pool } from "pg";
import { createPostgresPool } from "../postgres.js";
import type { EducationContentItem } from "./education-catalog.js";

export interface LocalEducationCatalogEntry {
  item: EducationContentItem;
  lifecycle: {
    state: "active" | "retained" | "withdrawn";
    reviewedAt: string;
    publishedAt: string;
    retiredAt?: string;
    withdrawnAt?: string;
    withdrawnReason?: string | null;
    supersededBy?: number;
  };
  manifestSha256: string;
  absentUpstream: boolean;
  asOf: string | null;
}

export interface EducationCatalogSnapshot {
  practiceId: string;
  envelope: unknown;
  localCopy: LocalEducationCatalogEntry[];
  etag: string | null;
  asOf: string | null;
  acceptedAt: string;
  lastAttemptAt: string;
  lastAttemptOutcome: "accepted" | "not-modified" | "refused";
  lastRefusalCode: string | null;
}

export interface EducationCatalogSnapshotStore {
  load(practiceId: string): Promise<EducationCatalogSnapshot | undefined>;
  accept(snapshot: Omit<EducationCatalogSnapshot, "lastAttemptAt" | "lastAttemptOutcome" | "lastRefusalCode">): Promise<void>;
  recordAttempt(practiceId: string, attempt: { at: string; outcome: "not-modified" | "refused"; refusalCode: string | null }): Promise<void>;
}

export class PgEducationCatalogSnapshotStore implements EducationCatalogSnapshotStore {
  private readonly pool: Pool;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string } = {}) {
    this.pool = createPostgresPool({
      connectionString: options.postgresUrl ?? "postgresql://medplum:medplum@127.0.0.1:5433/medplum",
      max: 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    }, "education catalog", () => console.error("odos-mcp: education catalog storage unavailable"));
  }

  async load(practiceId: string): Promise<EducationCatalogSnapshot | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      SELECT practice_id AS "practiceId", envelope, local_copy AS "localCopy", etag,
        as_of AS "asOf", accepted_at AS "acceptedAt", last_attempt_at AS "lastAttemptAt",
        last_attempt_outcome AS "lastAttemptOutcome", last_refusal_code AS "lastRefusalCode"
      FROM odos_education_catalog_snapshots WHERE practice_id = $1
    `, [practiceId]);
    const row = result.rows[0];
    return row ? { ...row, acceptedAt: row.acceptedAt.toISOString(), lastAttemptAt: row.lastAttemptAt.toISOString() } : undefined;
  }

  async accept(snapshot: Parameters<EducationCatalogSnapshotStore["accept"]>[0]): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`
      INSERT INTO odos_education_catalog_snapshots
        (practice_id, contract_version, local_copy, envelope, etag, as_of,
         accepted_at, last_attempt_at, last_attempt_outcome, last_refusal_code)
      VALUES ($1, 2, $2::jsonb, $3::jsonb, $4, $5, $6::timestamptz, $6::timestamptz, 'accepted', NULL)
      ON CONFLICT (practice_id) DO UPDATE SET contract_version = EXCLUDED.contract_version,
        local_copy = EXCLUDED.local_copy, envelope = EXCLUDED.envelope, etag = EXCLUDED.etag,
        as_of = EXCLUDED.as_of, accepted_at = EXCLUDED.accepted_at,
        last_attempt_at = EXCLUDED.last_attempt_at, last_attempt_outcome = 'accepted', last_refusal_code = NULL
    `, [snapshot.practiceId, JSON.stringify(snapshot.localCopy), JSON.stringify(snapshot.envelope), snapshot.etag, snapshot.asOf, snapshot.acceptedAt]);
  }

  async recordAttempt(practiceId: string, attempt: Parameters<EducationCatalogSnapshotStore["recordAttempt"]>[1]): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`
      UPDATE odos_education_catalog_snapshots SET last_attempt_at = $2::timestamptz,
        last_attempt_outcome = $3, last_refusal_code = $4 WHERE practice_id = $1
    `, [practiceId, attempt.at, attempt.outcome, attempt.refusalCode]);
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS odos_education_catalog_snapshots (
        practice_id text PRIMARY KEY, contract_version int NOT NULL,
        local_copy jsonb NOT NULL, envelope jsonb NOT NULL, etag text, as_of text,
        accepted_at timestamptz NOT NULL, last_attempt_at timestamptz NOT NULL,
        last_attempt_outcome text NOT NULL CHECK (last_attempt_outcome IN ('accepted', 'not-modified', 'refused')),
        last_refusal_code text
      )
    `).then(() => undefined).catch(error => { this.schemaReady = undefined; throw error; });
    await this.schemaReady;
  }
}
