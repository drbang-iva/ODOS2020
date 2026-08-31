import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import type { Pool, PoolClient } from "pg";
import type { WenoDirectoryDownloadConfig } from "../integrations/weno/config.js";
import { createPostgresPool } from "../postgres.js";
import {
  downloadPharmacyDirectory,
  type PharmacyDirectoryRequest,
} from "../integrations/weno/wenoDirectoryDownloadClient.js";

const DEFAULT_POSTGRES_URL = "postgresql://medplum:medplum@127.0.0.1:5433/medplum";
const SCHEMA_MIGRATIONS_DDL_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-odos-schema-migrations.sql", import.meta.url),
);
const PHARMACY_DIRECTORY_DDL_FILE = fileURLToPath(
  new URL("../../../data/migrations/2026-07-17-weno-pharmacy-directory.sql", import.meta.url),
);
const WRITE_BATCH_SIZE = 1_000;

const LITE_HEADERS = [
  "Created",
  "Modified",
  "Deleted",
  "NCPDP_safe",
  "Mutually_Defined_ID_safe",
  "NPI_safe",
  "Business_Name",
  "Address_Line_1",
  "Address_Line_2",
  "City",
  "State",
  "ZipCode_safe",
  "Country_Code",
  "International",
  "Latitude",
  "Longitude",
  "Pharmacy_Phone_safe",
  "Test_Pharmacy",
  "State_Wide_Mail_Order",
  "Mail_Order_US_State_Serviced",
  "Mail_Order_US_Territories_Serviced",
  "On_WENO",
  "24HR",
] as const;

const FULL_ONLY_HEADERS = new Set([
  "Script_Msg_Accepted",
  "Connectivity_Status",
  "eRxDrugWarning",
]);

export type PharmacyServiceArea =
  | { type: "all" }
  | { type: "list"; codes: string[] };

export type PharmacyOpen24Hours = "yes" | "no" | "unknown";

export interface PharmacyDirectoryRow {
  created?: string;
  modified?: string;
  deleted?: string;
  ncpdpId: string;
  mutuallyDefinedId: string;
  npi: string;
  businessName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  countryCode: string;
  international: boolean;
  latitude?: number;
  longitude?: number;
  phone: string;
  testPharmacy: boolean;
  stateWideMailOrder: boolean;
  mailOrderStatesServiced: PharmacyServiceArea;
  mailOrderTerritoriesServiced: PharmacyServiceArea;
  onWeno: boolean;
  open24Hours: PharmacyOpen24Hours;
}

export interface ParsedPharmacyDirectory {
  rows: PharmacyDirectoryRow[];
  malformedRows: number;
  deduplicatedRows: number;
}

export interface WenoPharmacyDirectoryStorageClient {
  store(
    rows: PharmacyDirectoryRow[],
    mode: "incremental" | "replace",
  ): Promise<number>;
}

export type PharmacySearchType = "local-retail" | "mail-order";

export class WenoPharmacySearchValidationError extends Error {}

export interface PharmacySearchInput {
  state?: string;
  zip?: string;
  city?: string;
  county?: string;
  searchType?: PharmacySearchType;
  onWeno?: boolean;
  name?: string;
  street?: string;
  open24hr?: boolean;
  all?: boolean;
  includeTestPharmacies?: boolean;
}

export type WenoPharmacyDirectoryPool = Pick<Pool, "connect" | "query" | "end">;

export class PostgresWenoPharmacyDirectoryStorage implements WenoPharmacyDirectoryStorageClient {
  private readonly pool: WenoPharmacyDirectoryPool;
  private readonly ownsPool: boolean;
  private schemaReady?: Promise<void>;

  constructor(options: { postgresUrl?: string; pool?: WenoPharmacyDirectoryPool } = {}) {
    this.pool = options.pool ?? createPostgresPool(
      {
        connectionString: options.postgresUrl ?? DEFAULT_POSTGRES_URL,
        max: 4,
      },
      "WENO pharmacy directory",
    );
    this.ownsPool = !options.pool;
  }

  async store(
    rows: PharmacyDirectoryRow[],
    mode: "incremental" | "replace",
  ): Promise<number> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('odos_weno_pharmacy_directory'))");
      const stored = mode === "replace"
        ? await replaceDirectory(client, rows)
        : await incrementDirectory(client, rows);
      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<PharmacyDirectoryRow[]> {
    await this.ensureSchema();
    const result = await this.pool.query<StoredPharmacyDirectoryRow>(`
      SELECT
        created_at_vendor,
        modified_at_vendor,
        ncpdp_id,
        mutually_defined_id,
        npi,
        business_name,
        address_line_1,
        address_line_2,
        city,
        state,
        zip_code,
        country_code,
        international,
        latitude,
        longitude,
        pharmacy_phone,
        test_pharmacy,
        state_wide_mail_order,
        mail_order_states_kind,
        mail_order_states_codes,
        mail_order_territories_kind,
        mail_order_territories_codes,
        on_weno,
        open_24_hours
      FROM odos_weno_pharmacy_directory
    `);
    return result.rows.map(storedRowToPharmacy);
  }

  async search(input: PharmacySearchInput): Promise<PharmacyDirectoryRow[]> {
    return searchPharmacies(await this.list(), input);
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
      const filename = basename(PHARMACY_DIRECTORY_DDL_FILE);
      const applied = await client.query(
        "SELECT 1 FROM odos_schema_migrations WHERE filename = $1",
        [filename],
      );
      if (!applied.rowCount) {
        await client.query(await readFile(PHARMACY_DIRECTORY_DDL_FILE, "utf8"));
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

export type WenoPharmacyDirectoryTrigger =
  | "scheduled-daily"
  | "scheduled-weekly-full"
  | "manual";

export interface SyncWenoPharmacyDirectoryInput {
  trigger: WenoPharmacyDirectoryTrigger;
  config: WenoDirectoryDownloadConfig;
  request: PharmacyDirectoryRequest;
  storage: WenoPharmacyDirectoryStorageClient;
}

export interface SyncWenoPharmacyDirectoryResult {
  trigger: WenoPharmacyDirectoryTrigger;
  fetchedBytes: number;
  parsed: number;
  stored: number;
  malformedRows?: number;
  deduplicatedRows?: number;
}

export async function syncWenoPharmacyDirectory(
  input: SyncWenoPharmacyDirectoryInput,
): Promise<SyncWenoPharmacyDirectoryResult> {
  const bytes = await downloadPharmacyDirectory(input.config, input.request);
  const parsed = parsePharmacyDirectoryZip(bytes);
  const stored = await input.storage.store(
    parsed.rows,
    pharmacyDirectoryStorageMode(input.request.Daily),
  );
  return {
    trigger: input.trigger,
    fetchedBytes: bytes.byteLength,
    parsed: parsed.rows.length,
    stored,
    malformedRows: parsed.malformedRows,
    deduplicatedRows: parsed.deduplicatedRows,
  };
}

export function pharmacyDirectoryStorageMode(
  daily: PharmacyDirectoryRequest["Daily"],
): "incremental" | "replace" {
  return daily === "N" ? "replace" : "incremental";
}

export function parsePharmacyDirectoryZip(bytes: ArrayBuffer): ParsedPharmacyDirectory {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch (error) {
    throw new Error("WENO pharmacy directory ZIP could not be opened.", { cause: error });
  }

  const candidates: CsvCandidate[] = [];
  for (const [filename, contents] of Object.entries(files)) {
    if (!filename.toLowerCase().endsWith(".csv")) continue;
    const parsed = parseCsv(contents);
    if (parsed.records.length < 2) continue;
    const headers = parsed.records[1].map(canonicalizeLiteHeader);
    if (!LITE_HEADERS.every((header) => headers.includes(header))) continue;
    if (headers.some((header) => FULL_ONLY_HEADERS.has(header))) continue;
    candidates.push({ filename, headers, records: parsed.records, skipped: parsed.skipped });
  }

  if (candidates.length === 0) {
    throw new Error(
      "WENO pharmacy directory ZIP has no recognizable LITE CSV header on row 2; expected the verified 23-column LITE schema.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `WENO pharmacy directory ZIP has multiple recognizable LITE CSVs (${candidates.map((candidate) => candidate.filename).join(", ")}).`,
    );
  }

  const candidate = candidates[0];
  const indexes = new Map(candidate.headers.map((header, index) => [header, index]));
  const rowsByKey = new Map<string, PharmacyDirectoryRow>();
  let malformedRows = candidate.skipped;
  let deduplicatedRows = 0;
  for (const record of candidate.records.slice(2)) {
    if (record.every((value) => value.trim() === "")) continue;
    try {
      const row = parseDirectoryRow(record, indexes);
      const key = pharmacyDirectoryKey(row);
      if (rowsByKey.has(key)) {
        deduplicatedRows += 1;
        rowsByKey.delete(key);
      }
      rowsByKey.set(key, row);
    } catch {
      malformedRows += 1;
    }
  }
  return { rows: [...rowsByKey.values()], malformedRows, deduplicatedRows };
}

export function searchPharmacies(
  rows: readonly PharmacyDirectoryRow[],
  input: PharmacySearchInput,
): PharmacyDirectoryRow[] {
  const state = input.state?.trim().toUpperCase();
  if (!state) {
    throw new WenoPharmacySearchValidationError("Pharmacy search requires a state.");
  }
  const zip = input.zip?.trim();
  const city = input.city?.trim();
  const county = input.county?.trim();
  if (!zip && !city && !county) {
    throw new WenoPharmacySearchValidationError("Pharmacy search requires a place: ZIP, city, or county.");
  }
  if (!input.searchType) {
    throw new WenoPharmacySearchValidationError("Pharmacy search requires a search type: local-retail or mail-order.");
  }
  if (input.searchType === "local-retail" && county && !zip && !city) {
    throw new WenoPharmacySearchValidationError(
      "County-only local-retail search is unavailable because the WENO LITE directory has no county column; provide a ZIP or city.",
    );
  }

  const name = validatedTextFilter("name", input.name);
  const street = validatedTextFilter("street", input.street);
  const hasAdditionalFilter = input.onWeno === true
    || name !== undefined
    || street !== undefined
    || input.open24hr === true
    || input.all === true;
  if (!hasAdditionalFilter) {
    throw new WenoPharmacySearchValidationError(
      "Pharmacy search requires onWeno, a name or street of at least 3 characters, open24hr, or explicit all.",
    );
  }

  return rows
    .filter((row) => !row.deleted)
    .filter((row) => input.includeTestPharmacies === true || !row.testPharmacy)
    .filter((row) => {
      if (input.searchType === "mail-order") {
        return row.stateWideMailOrder && serviceAreaIncludes(row.mailOrderStatesServiced, state);
      }
      if (row.state.toUpperCase() !== state) return false;
      return (zip ? row.zip === zip : false)
        || (city ? row.city.localeCompare(city, undefined, { sensitivity: "accent" }) === 0 : false);
    })
    .filter((row) => input.onWeno === true ? row.onWeno : true)
    .filter((row) => name ? row.businessName.toLocaleLowerCase().includes(name) : true)
    .filter((row) => street
      ? `${row.addressLine1} ${row.addressLine2}`.toLocaleLowerCase().includes(street)
      : true)
    .filter((row) => input.open24hr === true ? row.open24Hours === "yes" : true)
    .sort((left, right) => {
      if (left.onWeno !== right.onWeno) return left.onWeno ? -1 : 1;
      const byName = left.businessName.localeCompare(right.businessName);
      return byName || pharmacyDirectoryKey(left).localeCompare(pharmacyDirectoryKey(right));
    });
}

export function pharmacyDirectoryKey(row: PharmacyDirectoryRow): string {
  const key = row.ncpdpId || row.mutuallyDefinedId;
  if (!key) {
    throw new Error("WENO pharmacy directory row has neither an NCPDP ID nor a mutually defined ID.");
  }
  return key;
}

interface CsvCandidate {
  filename: string;
  headers: string[];
  records: string[][];
  skipped: number;
}

interface StoredPharmacyDirectoryRow {
  created_at_vendor: Date | null;
  modified_at_vendor: Date | null;
  ncpdp_id: string | null;
  mutually_defined_id: string | null;
  npi: string | null;
  business_name: string;
  address_line_1: string;
  address_line_2: string;
  city: string;
  state: string;
  zip_code: string;
  country_code: string;
  international: boolean;
  latitude: number | null;
  longitude: number | null;
  pharmacy_phone: string;
  test_pharmacy: boolean;
  state_wide_mail_order: boolean;
  mail_order_states_kind: "all" | "list";
  mail_order_states_codes: string[];
  mail_order_territories_kind: "all" | "list";
  mail_order_territories_codes: string[];
  on_weno: boolean;
  open_24_hours: PharmacyOpen24Hours;
}

function canonicalizeLiteHeader(value: string): string {
  const header = value.trim();
  return header === "Mail_Order_ US_Territories_Serviced"
    ? "Mail_Order_US_Territories_Serviced"
    : header;
}

function parseCsv(contents: Uint8Array): { records: string[][]; skipped: number } {
  let skipped = 0;
  const records = parse(new TextDecoder().decode(contents), {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    on_skip: () => {
      skipped += 1;
    },
  }) as string[][];
  return { records, skipped };
}

function parseDirectoryRow(
  record: string[],
  indexes: ReadonlyMap<string, number>,
): PharmacyDirectoryRow {
  const get = (header: typeof LITE_HEADERS[number]): string => {
    const index = indexes.get(header);
    return index === undefined ? "" : (record[index] ?? "").trim();
  };
  const row: PharmacyDirectoryRow = {
    created: parseDateTime(get("Created")),
    modified: parseDateTime(get("Modified")),
    deleted: parseDeletedDateTime(get("Deleted")),
    ncpdpId: stripSafeBrackets(get("NCPDP_safe")),
    mutuallyDefinedId: stripSafeBrackets(get("Mutually_Defined_ID_safe")),
    npi: stripSafeBrackets(get("NPI_safe")),
    businessName: get("Business_Name"),
    addressLine1: get("Address_Line_1"),
    addressLine2: nullableText(get("Address_Line_2")),
    city: get("City"),
    state: get("State").toUpperCase(),
    zip: stripSafeBrackets(get("ZipCode_safe")),
    countryCode: get("Country_Code").toUpperCase(),
    international: parseBoolean(get("International"), "International"),
    latitude: parseCoordinate(get("Latitude")),
    longitude: parseCoordinate(get("Longitude")),
    phone: stripSafeBrackets(get("Pharmacy_Phone_safe")),
    testPharmacy: parseBoolean(get("Test_Pharmacy"), "Test_Pharmacy"),
    stateWideMailOrder: parseStateWideMailOrder(get("State_Wide_Mail_Order")),
    mailOrderStatesServiced: parseServiceArea(get("Mail_Order_US_State_Serviced")),
    mailOrderTerritoriesServiced: parseServiceArea(get("Mail_Order_US_Territories_Serviced")),
    onWeno: parseBoolean(get("On_WENO"), "On_WENO"),
    open24Hours: parseOpen24Hours(get("24HR")),
  };
  pharmacyDirectoryKey(row);
  return row;
}

function stripSafeBrackets(value: string): string {
  const normalized = nullableText(value);
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1).trim()
    : normalized;
}

function nullableText(value: string): string {
  const normalized = value.trim();
  return normalized.toUpperCase() === "NULL" ? "" : normalized;
}

function parseDateTime(value: string): string | undefined {
  const normalized = nullableText(value);
  if (!normalized) return undefined;
  return parseIsoDateTime(normalized) ?? parseUsDateTime(normalized);
}

function parseDeletedDateTime(value: string): string | undefined {
  const normalized = nullableText(value);
  if (!normalized) return undefined;
  const parsed = parseDateTime(normalized);
  if (!parsed) {
    throw new Error("WENO pharmacy directory Deleted is not a valid datetime.");
  }
  return parsed;
}

function parseIsoDateTime(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(value)) {
    return undefined;
  }
  const utcValue = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00Z`
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const parsed = new Date(utcValue);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function parseUsDateTime(value: string): string | undefined {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM))?$/i.exec(value);
  if (!match) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const twelveHour = match[4] ? Number(match[4]) : 12;
  const minute = match[5] ? Number(match[5]) : 0;
  const second = match[6] ? Number(match[6]) : 0;
  const meridiem = match[7]?.toUpperCase() ?? "AM";
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || twelveHour < 1 || twelveHour > 12
    || minute > 59
    || second > 59
  ) {
    return undefined;
  }
  const hour = twelveHour % 12 + (meridiem === "PM" ? 12 : 0);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return parsed.toISOString();
}

function parseBoolean(value: string, field: string): boolean {
  const normalized = nullableText(value).toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(normalized)) return true;
  if (["", "false", "f", "no", "n", "0"].includes(normalized)) return false;
  throw new Error(`WENO pharmacy directory ${field} is not a recognized boolean.`);
}

function parseStateWideMailOrder(value: string): boolean {
  const normalized = nullableText(value).toLowerCase();
  if (normalized === "local") return false;
  if (normalized === "state") return true;
  throw new Error("WENO pharmacy directory State_Wide_Mail_Order must be Local or State.");
}

function parseCoordinate(value: string): number | undefined {
  const normalized = nullableText(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseServiceArea(value: string): PharmacyServiceArea {
  const normalized = nullableText(value);
  if (!normalized) return { type: "list", codes: [] };
  if (normalized.toLowerCase() === "all") return { type: "all" };
  const codes = [...new Set(normalized.split("|").map((code) => code.trim().toUpperCase()))];
  if (codes.some((code) => !/^[A-Z]{2}$/.test(code))) {
    throw new Error("WENO pharmacy directory service area contains an invalid state or territory code.");
  }
  return { type: "list", codes };
}

function parseOpen24Hours(value: string): PharmacyOpen24Hours {
  const normalized = nullableText(value).toLowerCase();
  if (normalized === "y" || normalized === "yes") return "yes";
  if (normalized === "n" || normalized === "no") return "no";
  if (normalized === "unknown" || normalized === "") return "unknown";
  throw new Error("WENO pharmacy directory 24HR must be Yes, No, blank, Y, N, or Unknown.");
}

function validatedTextFilter(field: string, value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length < 3) {
    throw new WenoPharmacySearchValidationError(`Pharmacy search ${field} must be at least 3 characters.`);
  }
  return normalized.toLocaleLowerCase();
}

function serviceAreaIncludes(area: PharmacyServiceArea, state: string): boolean {
  return area.type === "all" || area.codes.includes(state);
}

async function replaceDirectory(
  client: PoolClient,
  rows: readonly PharmacyDirectoryRow[],
): Promise<number> {
  await client.query(`
    CREATE TEMP TABLE odos_weno_pharmacy_directory_stage
      (LIKE odos_weno_pharmacy_directory INCLUDING ALL)
      ON COMMIT DROP
  `);
  const activeRows = rows.filter((row) => !row.deleted);
  await insertRows(client, "odos_weno_pharmacy_directory_stage", activeRows, false);
  await client.query("DELETE FROM odos_weno_pharmacy_directory");
  const inserted = await client.query(`
    INSERT INTO odos_weno_pharmacy_directory
    SELECT * FROM odos_weno_pharmacy_directory_stage
  `);
  return inserted.rowCount ?? 0;
}

async function incrementDirectory(
  client: PoolClient,
  rows: readonly PharmacyDirectoryRow[],
): Promise<number> {
  let stored = 0;
  const activeRows = rows.filter((row) => !row.deleted);
  stored += await insertRows(client, "odos_weno_pharmacy_directory", activeRows, true);
  const deletedKeys = rows.filter((row) => row.deleted).map(pharmacyDirectoryKey);
  for (const batch of batches(deletedKeys, WRITE_BATCH_SIZE)) {
    const result = await client.query(
      "DELETE FROM odos_weno_pharmacy_directory WHERE directory_key = ANY($1::text[])",
      [batch],
    );
    stored += result.rowCount ?? 0;
  }
  return stored;
}

async function insertRows(
  client: PoolClient,
  table: "odos_weno_pharmacy_directory" | "odos_weno_pharmacy_directory_stage",
  rows: readonly PharmacyDirectoryRow[],
  upsert: boolean,
): Promise<number> {
  let stored = 0;
  for (const batch of batches(rows, WRITE_BATCH_SIZE)) {
    const values: unknown[] = [];
    const placeholders = batch.map((row) => {
      const rowValues = pharmacyToStoredValues(row);
      const offset = values.length;
      values.push(...rowValues);
      return `(${rowValues.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    const result = await client.query(`
      INSERT INTO ${table} (
        directory_key, created_at_vendor, modified_at_vendor, ncpdp_id,
        mutually_defined_id, npi, business_name, address_line_1, address_line_2,
        city, state, zip_code, country_code, international, latitude, longitude,
        pharmacy_phone, test_pharmacy, state_wide_mail_order, mail_order_states_kind,
        mail_order_states_codes, mail_order_territories_kind, mail_order_territories_codes,
        on_weno, open_24_hours
      ) VALUES ${placeholders.join(", ")}
      ${upsert ? `
        ON CONFLICT (directory_key) DO UPDATE SET
          created_at_vendor = EXCLUDED.created_at_vendor,
          modified_at_vendor = EXCLUDED.modified_at_vendor,
          ncpdp_id = EXCLUDED.ncpdp_id,
          mutually_defined_id = EXCLUDED.mutually_defined_id,
          npi = EXCLUDED.npi,
          business_name = EXCLUDED.business_name,
          address_line_1 = EXCLUDED.address_line_1,
          address_line_2 = EXCLUDED.address_line_2,
          city = EXCLUDED.city,
          state = EXCLUDED.state,
          zip_code = EXCLUDED.zip_code,
          country_code = EXCLUDED.country_code,
          international = EXCLUDED.international,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          pharmacy_phone = EXCLUDED.pharmacy_phone,
          test_pharmacy = EXCLUDED.test_pharmacy,
          state_wide_mail_order = EXCLUDED.state_wide_mail_order,
          mail_order_states_kind = EXCLUDED.mail_order_states_kind,
          mail_order_states_codes = EXCLUDED.mail_order_states_codes,
          mail_order_territories_kind = EXCLUDED.mail_order_territories_kind,
          mail_order_territories_codes = EXCLUDED.mail_order_territories_codes,
          on_weno = EXCLUDED.on_weno,
          open_24_hours = EXCLUDED.open_24_hours,
          synced_at = now()
      ` : ""}
    `, values);
    stored += result.rowCount ?? 0;
  }
  return stored;
}

function pharmacyToStoredValues(row: PharmacyDirectoryRow): unknown[] {
  return [
    pharmacyDirectoryKey(row),
    row.created ?? null,
    row.modified ?? null,
    row.ncpdpId || null,
    row.mutuallyDefinedId || null,
    row.npi || null,
    row.businessName,
    row.addressLine1,
    row.addressLine2,
    row.city,
    row.state,
    row.zip,
    row.countryCode,
    row.international,
    row.latitude ?? null,
    row.longitude ?? null,
    row.phone,
    row.testPharmacy,
    row.stateWideMailOrder,
    row.mailOrderStatesServiced.type,
    row.mailOrderStatesServiced.type === "list" ? row.mailOrderStatesServiced.codes : [],
    row.mailOrderTerritoriesServiced.type,
    row.mailOrderTerritoriesServiced.type === "list" ? row.mailOrderTerritoriesServiced.codes : [],
    row.onWeno,
    row.open24Hours,
  ];
}

function storedRowToPharmacy(row: StoredPharmacyDirectoryRow): PharmacyDirectoryRow {
  return {
    created: row.created_at_vendor?.toISOString(),
    modified: row.modified_at_vendor?.toISOString(),
    ncpdpId: row.ncpdp_id ?? "",
    mutuallyDefinedId: row.mutually_defined_id ?? "",
    npi: row.npi ?? "",
    businessName: row.business_name,
    addressLine1: row.address_line_1,
    addressLine2: row.address_line_2,
    city: row.city,
    state: row.state,
    zip: row.zip_code,
    countryCode: row.country_code,
    international: row.international,
    latitude: row.latitude ?? undefined,
    longitude: row.longitude ?? undefined,
    phone: row.pharmacy_phone,
    testPharmacy: row.test_pharmacy,
    stateWideMailOrder: row.state_wide_mail_order,
    mailOrderStatesServiced: row.mail_order_states_kind === "all"
      ? { type: "all" }
      : { type: "list", codes: row.mail_order_states_codes },
    mailOrderTerritoriesServiced: row.mail_order_territories_kind === "all"
      ? { type: "all" }
      : { type: "list", codes: row.mail_order_territories_codes },
    onWeno: row.on_weno,
    open24Hours: row.open_24_hours,
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
