import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  REFERENCE_POPULATIONS,
  type ReferencePopulation,
} from "./myopia-reference-dataset.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const SCHEMA_LEDGER_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const SETTINGS_SCHEMA_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-25-myopia-reference-population.sql", import.meta.url),
);

export interface MyopiaPatientSettings {
  patientReference: string;
  referencePopulation: ReferencePopulation;
  updatedBy?: string;
  updatedAt?: string;
}

export interface MyopiaReferencePopulationStore {
  get(patientReference: string): Promise<MyopiaPatientSettings>;
  set(input: {
    patientReference: string;
    referencePopulation: ReferencePopulation;
    updatedBy: string;
    updatedAt: string;
  }): Promise<MyopiaPatientSettings>;
}

export class PgMyopiaReferencePopulationStore implements MyopiaReferencePopulationStore {
  private readonly pool: Pool;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string } = {}) {
    this.pool = new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
  }

  async get(patientReference: string): Promise<MyopiaPatientSettings> {
    assertPatientReference(patientReference);
    await this.ensureSchema();
    const result = await this.pool.query<MyopiaPatientSettingsDbRow>(`
      SELECT patient_reference, reference_population, updated_by, updated_at
      FROM odos_myopia_patient_settings
      WHERE patient_reference = $1
    `, [patientReference]);
    return result.rows[0]
      ? rowFromDb(result.rows[0])
      : { patientReference, referencePopulation: "NOT_REPRESENTED" };
  }

  async set(input: {
    patientReference: string;
    referencePopulation: ReferencePopulation;
    updatedBy: string;
    updatedAt: string;
  }): Promise<MyopiaPatientSettings> {
    assertPatientReference(input.patientReference);
    assertReferencePopulation(input.referencePopulation);
    const updatedAt = new Date(input.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) throw new Error("Myopia patient settings require a valid updatedAt.");
    await this.ensureSchema();
    const result = await this.pool.query<MyopiaPatientSettingsDbRow>(`
      INSERT INTO odos_myopia_patient_settings (
        patient_reference, reference_population, updated_by, updated_at
      ) VALUES ($1, $2, $3, $4::timestamptz)
      ON CONFLICT (patient_reference) DO UPDATE SET
        reference_population = EXCLUDED.reference_population,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at
      RETURNING patient_reference, reference_population, updated_by, updated_at
    `, [
      input.patientReference,
      input.referencePopulation,
      input.updatedBy,
      updatedAt.toISOString(),
    ]);
    if (!result.rows[0]) throw new Error("Myopia patient settings were not returned after persistence.");
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
      const filename = basename(SETTINGS_SCHEMA_FILE);
      const applied = await client.query(
        "SELECT 1 FROM odos_schema_migrations WHERE filename = $1",
        [filename],
      );
      if (!applied.rowCount) {
        await client.query(await readFile(SETTINGS_SCHEMA_FILE, "utf8"));
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

interface MyopiaPatientSettingsDbRow {
  patient_reference: string;
  reference_population: string;
  updated_by: string;
  updated_at: Date | string;
}

function rowFromDb(row: MyopiaPatientSettingsDbRow): MyopiaPatientSettings {
  assertReferencePopulation(row.reference_population);
  return {
    patientReference: row.patient_reference,
    referencePopulation: row.reference_population,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

function assertPatientReference(value: string): void {
  if (!/^Patient\/[^/]+$/.test(value)) {
    throw new Error("Myopia patient settings require Patient/{id}.");
  }
}

function assertReferencePopulation(value: string): asserts value is ReferencePopulation {
  if (!(REFERENCE_POPULATIONS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported reference population: ${value}`);
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
