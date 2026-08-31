import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { createPostgresPool } from "../postgres.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const SCHEMA_LEDGER_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const STATUS_SCHEMA_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-21-encounter-diagnosis-statuses.sql", import.meta.url),
);

export const DIAGNOSIS_VISIT_STATUSES = [
  "new",
  "stable",
  "improved",
  "worsening",
  "resolved-this-visit",
] as const;

export type DiagnosisVisitStatus = (typeof DIAGNOSIS_VISIT_STATUSES)[number];

export interface DiagnosisVisitStatusRow {
  conditionReference: string;
  encounterId: string;
  status: DiagnosisVisitStatus;
  setBy: string;
  setAt: string;
  updatedAt: string;
}

export interface DiagnosisVisitStatusStore {
  listByEncounter(encounterId: string): Promise<DiagnosisVisitStatusRow[]>;
  upsert(input: {
    conditionReference: string;
    encounterId: string;
    status: DiagnosisVisitStatus;
    setBy: string;
    at: string;
  }): Promise<DiagnosisVisitStatusRow>;
}

export class PgDiagnosisVisitStatusStore implements DiagnosisVisitStatusStore {
  private readonly pool: Pool;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string } = {}) {
    this.pool = createPostgresPool(
      {
        connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
        max: 4,
      },
      "diagnosis visit status",
    );
  }

  async listByEncounter(encounterId: string): Promise<DiagnosisVisitStatusRow[]> {
    await this.ensureSchema();
    const result = await this.pool.query<DiagnosisVisitStatusDbRow>(`
      SELECT condition_reference, encounter_id, status, set_by, set_at, updated_at
      FROM odos_encounter_diagnosis_statuses
      WHERE encounter_id = $1
      ORDER BY condition_reference
    `, [encounterId]);
    return result.rows.map(rowFromDb);
  }

  async upsert(input: {
    conditionReference: string;
    encounterId: string;
    status: DiagnosisVisitStatus;
    setBy: string;
    at: string;
  }): Promise<DiagnosisVisitStatusRow> {
    assertVisitStatus(input.status);
    await this.ensureSchema();
    const result = await this.pool.query<DiagnosisVisitStatusDbRow>(`
      INSERT INTO odos_encounter_diagnosis_statuses (
        condition_reference, encounter_id, status, set_by, set_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)
      ON CONFLICT (condition_reference) DO UPDATE SET
        encounter_id = EXCLUDED.encounter_id,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
      RETURNING condition_reference, encounter_id, status, set_by, set_at, updated_at
    `, [input.conditionReference, input.encounterId, input.status, input.setBy, input.at]);
    if (!result.rows[0]) throw new Error("Diagnosis visit status was not returned after persistence.");
    return rowFromDb(result.rows[0]);
  }

  async close(): Promise<void> {
    await this.pool.end();
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
      const filename = basename(STATUS_SCHEMA_FILE);
      const applied = await client.query("SELECT 1 FROM odos_schema_migrations WHERE filename = $1", [filename]);
      if (!applied.rowCount) {
        await client.query(await readFile(STATUS_SCHEMA_FILE, "utf8"));
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

interface DiagnosisVisitStatusDbRow {
  condition_reference: string;
  encounter_id: string;
  status: string;
  set_by: string;
  set_at: Date | string;
  updated_at: Date | string;
}

function rowFromDb(row: DiagnosisVisitStatusDbRow): DiagnosisVisitStatusRow {
  assertVisitStatus(row.status);
  return {
    conditionReference: row.condition_reference,
    encounterId: row.encounter_id,
    status: row.status,
    setBy: row.set_by,
    setAt: iso(row.set_at),
    updatedAt: iso(row.updated_at),
  };
}

function assertVisitStatus(value: string): asserts value is DiagnosisVisitStatus {
  if (!(DIAGNOSIS_VISIT_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported diagnosis visit status: ${value}`);
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function rollbackQuietly(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the originating database error.
  }
}
