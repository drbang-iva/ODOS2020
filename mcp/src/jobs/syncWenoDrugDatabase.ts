import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5432/medplum";
const SCHEMA_MIGRATIONS_DDL_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const DRUG_DATABASE_DDL_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-weno-drug-database.sql", import.meta.url),
);
const WRITE_BATCH_SIZE = 1_000;

const REQUIRED_HEADERS = [
  "RXCUI(DrugCoded)",
  "TTY(DrugDBCodeQualifier)",
  "FULL_NAME",
  "DISPLAY_NAME",
  "ROUTE",
  "STRENGTH",
  "SUPPRESS_FOR",
  "IS_RETIRED",
  "PSN(DrugDescription)",
  "NCPDP Quantity Term",
  "Potency Unit Code",
  "DEA Schedule #",
  "DEA Schedule",
] as const;

const CONTROLLED_SCHEDULES = new Set(["2", "3", "4", "5"]);
export const WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE = "C38046";

export type WenoDrugNameSource = "psn" | "displayName" | "fullName";

export class WenoDrugSearchValidationError extends Error {}

export interface WenoDrugRow {
  drugDbCode: string;
  drugDbCodeQualifier: string;
  quantityUnitOfMeasureCode: string;
  quantityUnitOfMeasureDisplay: string;
  deaScheduleCode: typeof WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE;
  psnDescription: string;
  nameSource: WenoDrugNameSource;
  route: string;
  strength: string;
  shelfTag?: string;
}

export type WenoDrugMalformedReason =
  | "deaScheduleNumber"
  | "requiredCodedField"
  | "displayName"
  | "deaScheduleCode"
  | "duplicateDrugCode";

export interface ParsedWenoDrugDatabase {
  rows: WenoDrugRow[];
  totalRows: number;
  parsed: number;
  filteredControlled: number;
  filteredRetired: number;
  filteredSuppressed: number;
  filteredRetiredOrSuppressed: number;
  malformed: number;
  malformedByReason: Partial<Record<WenoDrugMalformedReason, number>>;
  nameSourceCounts: Record<WenoDrugNameSource, number>;
}

export interface WenoDrugDatabaseStorageClient {
  store(rows: readonly WenoDrugRow[]): Promise<number>;
}

export type WenoDrugDatabasePool = Pick<Pool, "connect" | "query" | "end">;

export class PostgresWenoDrugDatabaseStorage implements WenoDrugDatabaseStorageClient {
  private readonly pool: WenoDrugDatabasePool;
  private readonly ownsPool: boolean;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string; pool?: WenoDrugDatabasePool } = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
      max: 4,
    });
    this.ownsPool = !options.pool;
  }

  async store(rows: readonly WenoDrugRow[]): Promise<number> {
    if (rows.length === 0) {
      throw new Error("WENO drug database replacement requires at least one parsed row.");
    }
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('odos_weno_drug_database'))");
      const stored = await replaceDrugDatabase(client, rows);
      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<WenoDrugRow[]> {
    await this.ensureSchema();
    const result = await this.pool.query<StoredWenoDrugRow>(`
      SELECT
        drug_db_code,
        drug_db_code_qualifier,
        quantity_unit_of_measure_code,
        quantity_unit_of_measure_display,
        dea_schedule_code,
        psn_description,
        name_source,
        route,
        strength,
        shelf_tag
      FROM odos_weno_drug_database
    `);
    return result.rows.map(storedRowToDrug);
  }

  async search(query: string): Promise<WenoDrugRow[]> {
    return searchDrugs(await this.list(), query);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.initializeSchema();
    await this.schemaReady;
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(await readFile(SCHEMA_MIGRATIONS_DDL_FILE, "utf8"));
      await client.query("BEGIN");
      await client.query("LOCK TABLE odos_schema_migrations IN SHARE ROW EXCLUSIVE MODE");
      const filename = basename(DRUG_DATABASE_DDL_FILE);
      const applied = await client.query(
        "SELECT 1 FROM odos_schema_migrations WHERE filename = $1",
        [filename],
      );
      if (!applied.rowCount) {
        await client.query(await readFile(DRUG_DATABASE_DDL_FILE, "utf8"));
        await client.query(
          "INSERT INTO odos_schema_migrations (filename) VALUES ($1)",
          [filename],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface IngestWenoDrugDatabaseResult extends Omit<ParsedWenoDrugDatabase, "rows"> {
  stored: number;
}

export async function ingestWenoDrugDatabaseFile(
  path: string,
  storage: WenoDrugDatabaseStorageClient,
): Promise<IngestWenoDrugDatabaseResult> {
  const parsed = parseWenoDrugDatabase(await readFile(path));
  const stored = await storage.store(parsed.rows);
  const { rows: _rows, ...counts } = parsed;
  return { ...counts, stored };
}

export function parseWenoDrugDatabase(
  source: string | ArrayBuffer | ArrayBufferView,
): ParsedWenoDrugDatabase {
  const lines = decodeSource(source).replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const headers = line.replace(/\r$/, "").split("|").map((value) => value.trim());
    return REQUIRED_HEADERS.every((header) => headers.includes(header));
  });
  if (headerIndex < 0) {
    throw new Error("WENO drug database has no recognizable header row.");
  }

  const headers = lines[headerIndex].replace(/\r$/, "").split("|").map((value) => value.trim());
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const rows: WenoDrugRow[] = [];
  const seenDrugCodes = new Set<string>();
  const malformedByReason: ParsedWenoDrugDatabase["malformedByReason"] = {};
  const nameSourceCounts: ParsedWenoDrugDatabase["nameSourceCounts"] = {
    psn: 0,
    displayName: 0,
    fullName: 0,
  };
  let totalRows = 0;
  let filteredControlled = 0;
  let filteredRetired = 0;
  let filteredSuppressed = 0;

  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    totalRows += 1;
    const values = line.replace(/\r$/, "").split("|");
    const get = (header: typeof REQUIRED_HEADERS[number]): string => {
      const index = indexes.get(header);
      return index === undefined ? "" : (values[index] ?? "").trim();
    };

    const scheduleNumber = get("DEA Schedule #");
    if (CONTROLLED_SCHEDULES.has(scheduleNumber)) {
      filteredControlled += 1;
      continue;
    }
    if (scheduleNumber !== "0") {
      incrementMalformed(malformedByReason, "deaScheduleNumber");
      continue;
    }

    if (get("IS_RETIRED")) {
      filteredRetired += 1;
      continue;
    }
    if (get("SUPPRESS_FOR")) {
      filteredSuppressed += 1;
      continue;
    }

    const drugDbCode = get("RXCUI(DrugCoded)");
    const drugDbCodeQualifier = get("TTY(DrugDBCodeQualifier)");
    const quantityUnitOfMeasureCode = get("Potency Unit Code");
    const quantityUnitOfMeasureDisplay = get("NCPDP Quantity Term");
    if (
      !drugDbCode
      || !drugDbCodeQualifier
      || !quantityUnitOfMeasureCode
      || !quantityUnitOfMeasureDisplay
    ) {
      incrementMalformed(malformedByReason, "requiredCodedField");
      continue;
    }

    const display = preferredDisplayName({
      psn: get("PSN(DrugDescription)"),
      displayName: get("DISPLAY_NAME"),
      fullName: get("FULL_NAME"),
    });
    if (!display) {
      incrementMalformed(malformedByReason, "displayName");
      continue;
    }

    const deaScheduleCode = get("DEA Schedule");
    if (deaScheduleCode !== WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE) {
      incrementMalformed(malformedByReason, "deaScheduleCode");
      continue;
    }
    if (seenDrugCodes.has(drugDbCode)) {
      incrementMalformed(malformedByReason, "duplicateDrugCode");
      continue;
    }
    seenDrugCodes.add(drugDbCode);
    nameSourceCounts[display.source] += 1;

    rows.push({
      drugDbCode,
      drugDbCodeQualifier,
      quantityUnitOfMeasureCode,
      quantityUnitOfMeasureDisplay,
      deaScheduleCode: WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE,
      psnDescription: display.value,
      nameSource: display.source,
      route: get("ROUTE"),
      strength: get("STRENGTH"),
    });
  }

  const malformed = Object.values(malformedByReason).reduce((sum, count) => sum + count, 0);
  return {
    rows,
    totalRows,
    parsed: rows.length,
    filteredControlled,
    filteredRetired,
    filteredSuppressed,
    filteredRetiredOrSuppressed: filteredRetired + filteredSuppressed,
    malformed,
    malformedByReason,
    nameSourceCounts,
  };
}

export function searchDrugs(rows: readonly WenoDrugRow[], query: string): WenoDrugRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    throw new WenoDrugSearchValidationError("Drug search requires a non-blank query.");
  }
  return rows
    .filter((row) => row.psnDescription.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const leftName = left.psnDescription.toLocaleLowerCase();
      const rightName = right.psnDescription.toLocaleLowerCase();
      const leftPrefix = leftName.startsWith(normalizedQuery);
      const rightPrefix = rightName.startsWith(normalizedQuery);
      if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
      const byName = left.psnDescription.localeCompare(right.psnDescription);
      return byName || left.drugDbCode.localeCompare(right.drugDbCode);
    });
}

interface StoredWenoDrugRow {
  drug_db_code: string;
  drug_db_code_qualifier: string;
  quantity_unit_of_measure_code: string;
  quantity_unit_of_measure_display: string;
  dea_schedule_code: typeof WENO_NON_CONTROLLED_DEA_SCHEDULE_CODE;
  psn_description: string;
  name_source: WenoDrugNameSource;
  route: string;
  strength: string;
  shelf_tag: string | null;
}

function preferredDisplayName(input: {
  psn: string;
  displayName: string;
  fullName: string;
}): { value: string; source: WenoDrugNameSource } | undefined {
  if (input.psn) return { value: input.psn, source: "psn" };
  if (input.displayName) return { value: input.displayName, source: "displayName" };
  if (input.fullName) return { value: input.fullName, source: "fullName" };
  return undefined;
}

function decodeSource(source: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof source === "string") return source;
  const bytes = source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return new TextDecoder().decode(bytes);
}

function incrementMalformed(
  counts: ParsedWenoDrugDatabase["malformedByReason"],
  reason: WenoDrugMalformedReason,
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

async function replaceDrugDatabase(
  client: PoolClient,
  rows: readonly WenoDrugRow[],
): Promise<number> {
  await client.query(`
    CREATE TEMP TABLE odos_weno_drug_database_stage
      (LIKE odos_weno_drug_database INCLUDING ALL)
      ON COMMIT DROP
  `);
  await insertRows(client, "odos_weno_drug_database_stage", rows);
  await client.query("DELETE FROM odos_weno_drug_database");
  const inserted = await client.query(`
    INSERT INTO odos_weno_drug_database
    SELECT * FROM odos_weno_drug_database_stage
  `);
  return inserted.rowCount ?? 0;
}

async function insertRows(
  client: PoolClient,
  table: "odos_weno_drug_database_stage",
  rows: readonly WenoDrugRow[],
): Promise<void> {
  for (const batch of batches(rows, WRITE_BATCH_SIZE)) {
    const values: unknown[] = [];
    const placeholders = batch.map((row) => {
      const rowValues = drugToStoredValues(row);
      const offset = values.length;
      values.push(...rowValues);
      return `(${rowValues.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    await client.query(`
      INSERT INTO ${table} (
        drug_db_code, drug_db_code_qualifier, quantity_unit_of_measure_code,
        quantity_unit_of_measure_display, dea_schedule_code, psn_description,
        name_source, route, strength, shelf_tag
      ) VALUES ${placeholders.join(", ")}
    `, values);
  }
}

function drugToStoredValues(row: WenoDrugRow): unknown[] {
  return [
    row.drugDbCode,
    row.drugDbCodeQualifier,
    row.quantityUnitOfMeasureCode,
    row.quantityUnitOfMeasureDisplay,
    row.deaScheduleCode,
    row.psnDescription,
    row.nameSource,
    row.route,
    row.strength,
    row.shelfTag ?? null,
  ];
}

function storedRowToDrug(row: StoredWenoDrugRow): WenoDrugRow {
  return {
    drugDbCode: row.drug_db_code,
    drugDbCodeQualifier: row.drug_db_code_qualifier,
    quantityUnitOfMeasureCode: row.quantity_unit_of_measure_code,
    quantityUnitOfMeasureDisplay: row.quantity_unit_of_measure_display,
    deaScheduleCode: row.dea_schedule_code,
    psnDescription: row.psn_description,
    nameSource: row.name_source,
    route: row.route,
    strength: row.strength,
    shelfTag: row.shelf_tag ?? undefined,
  };
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function rollbackQuietly(client: Pick<PoolClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the originating database failure.
  }
}
