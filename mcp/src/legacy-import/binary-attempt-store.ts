import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createPostgresPool } from "../postgres.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const SCHEMA_LEDGER_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const ATTEMPT_SCHEMA_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-28-legacy-import-binary-attempts.sql", import.meta.url),
);

export type BinaryAttemptStatus =
  | "open"
  | "resolved-attached"
  | "resolved-not-created"
  | "resolved-disposed";

export interface BinaryAttempt {
  readonly attemptId: string;
  readonly sourceFilename: string;
  readonly patientReference: string;
  readonly mediaId?: string;
  readonly binaryId?: string;
  readonly status: BinaryAttemptStatus;
  readonly openedAt: string;
  readonly requestReturnedAt?: string;
  readonly resolvedAt?: string;
  readonly resolutionDetail?: string;
}

export interface BinaryAttemptStore {
  open(input: {
    sourceFilename: string;
    patientReference: string;
    mediaId?: string;
  }): Promise<BinaryAttempt>;
  recordReturned(attemptId: string, binaryId: string): Promise<BinaryAttempt>;
  resolveAttached(attemptId: string, mediaId: string, binaryId: string): Promise<BinaryAttempt>;
  resolveAttachedByBinaryId(binaryId: string, mediaId: string): Promise<number>;
  resolveNotCreated(attemptId: string, detail: string): Promise<BinaryAttempt>;
  resolveDisposed(attemptId: string, detail: string): Promise<BinaryAttempt>;
  reopenByBinaryId(binaryId: string, detail: string): Promise<void>;
  listOpen(): Promise<BinaryAttempt[]>;
  close?(): Promise<void>;
}

export class PgBinaryAttemptStore implements BinaryAttemptStore {
  private readonly pool: Pool;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string; pool?: Pool } = {}) {
    this.pool = options.pool ?? createPostgresPool(
      {
        connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
        max: 4,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 15_000,
      },
      "legacy binary attempts",
    );
  }

  async open(input: {
    sourceFilename: string;
    patientReference: string;
    mediaId?: string;
  }): Promise<BinaryAttempt> {
    assertPatientReference(input.patientReference);
    if (!input.sourceFilename.trim()) throw new Error("Binary attempt requires sourceFilename.");
    await this.ensureSchema();
    const result = await this.pool.query<BinaryAttemptRow>(`
      INSERT INTO odos_legacy_import_binary_attempts (
        attempt_id, source_filename, patient_reference, media_id
      ) VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [randomUUID(), input.sourceFilename, input.patientReference, input.mediaId ?? null]);
    return rowFromDb(requiredRow(result.rows[0]));
  }

  async recordReturned(attemptId: string, binaryId: string): Promise<BinaryAttempt> {
    return this.updateOpen(attemptId, `
      binary_id = $2,
      request_returned_at = now()
    `, [binaryId]);
  }

  async resolveAttached(attemptId: string, mediaId: string, binaryId: string): Promise<BinaryAttempt> {
    return this.updateOpen(attemptId, `
      media_id = $2,
      binary_id = $3,
      status = 'resolved-attached',
      resolved_at = now(),
      resolution_detail = 'completed Media references a hash-verified Binary'
    `, [mediaId, binaryId]);
  }

  async resolveAttachedByBinaryId(binaryId: string, mediaId: string): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(`
      UPDATE odos_legacy_import_binary_attempts
      SET media_id = $2,
          status = 'resolved-attached',
          resolved_at = now(),
          resolution_detail = 'completed Media references a hash-verified Binary'
      WHERE binary_id = $1
        AND status = 'open'
    `, [binaryId, mediaId]);
    return result.rowCount ?? 0;
  }

  async resolveNotCreated(attemptId: string, detail: string): Promise<BinaryAttempt> {
    return this.updateOpen(attemptId, `
      status = 'resolved-not-created',
      resolved_at = now(),
      resolution_detail = $2
    `, [detail]);
  }

  async resolveDisposed(attemptId: string, detail: string): Promise<BinaryAttempt> {
    return this.updateOpen(attemptId, `
      status = 'resolved-disposed',
      resolved_at = now(),
      resolution_detail = $2
    `, [detail]);
  }

  async reopenByBinaryId(binaryId: string, detail: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`
      UPDATE odos_legacy_import_binary_attempts
      SET status = 'open',
          resolved_at = NULL,
          resolution_detail = $2
      WHERE binary_id = $1
        AND status = 'resolved-attached'
    `, [binaryId, detail]);
  }

  async listOpen(): Promise<BinaryAttempt[]> {
    await this.ensureSchema();
    const result = await this.pool.query<BinaryAttemptRow>(`
      SELECT *
      FROM odos_legacy_import_binary_attempts
      WHERE status = 'open'
      ORDER BY opened_at, attempt_id
    `);
    return result.rows.map(rowFromDb);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async updateOpen(
    attemptId: string,
    assignments: string,
    values: readonly unknown[],
  ): Promise<BinaryAttempt> {
    await this.ensureSchema();
    const result = await this.pool.query<BinaryAttemptRow>(`
      UPDATE odos_legacy_import_binary_attempts
      SET ${assignments}
      WHERE attempt_id = $1
        AND status = 'open'
      RETURNING *
    `, [attemptId, ...values]);
    if (!result.rows[0]) {
      throw new Error(`Binary attempt ${attemptId} is missing or already resolved.`);
    }
    return rowFromDb(result.rows[0]);
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
      const filename = basename(ATTEMPT_SCHEMA_FILE);
      const applied = await client.query(
        "SELECT 1 FROM odos_schema_migrations WHERE filename = $1",
        [filename],
      );
      if (!applied.rowCount) {
        await client.query(await readFile(ATTEMPT_SCHEMA_FILE, "utf8"));
        await client.query(
          "INSERT INTO odos_schema_migrations (filename) VALUES ($1)",
          [filename],
        );
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

interface BinaryAttemptRow extends QueryResultRow {
  attempt_id: string;
  source_filename: string;
  patient_reference: string;
  media_id: string | null;
  binary_id: string | null;
  status: BinaryAttemptStatus;
  opened_at: Date | string;
  request_returned_at: Date | string | null;
  resolved_at: Date | string | null;
  resolution_detail: string | null;
}

function rowFromDb(row: BinaryAttemptRow): BinaryAttempt {
  return {
    attemptId: row.attempt_id,
    sourceFilename: row.source_filename,
    patientReference: row.patient_reference,
    ...(row.media_id ? { mediaId: row.media_id } : {}),
    ...(row.binary_id ? { binaryId: row.binary_id } : {}),
    status: row.status,
    openedAt: iso(row.opened_at),
    ...(row.request_returned_at ? { requestReturnedAt: iso(row.request_returned_at) } : {}),
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
    ...(row.resolution_detail ? { resolutionDetail: row.resolution_detail } : {}),
  };
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Binary attempt write returned no row.");
  return row;
}

function assertPatientReference(reference: string): void {
  if (!/^Patient\/[^/]+$/.test(reference)) {
    throw new Error("Binary attempt patientReference must be Patient/{id}.");
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function rollbackQuietly(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    return;
  }
}
