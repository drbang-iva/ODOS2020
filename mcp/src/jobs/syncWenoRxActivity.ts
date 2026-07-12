import type { Bundle, MedicationRequest } from "@medplum/fhirtypes";
import type { WenoEzIntegrationConfig } from "../integrations/weno/config.js";
import {
  pullNewRxSyncReport,
  type NewRxSyncReportRequest,
  type NewRxSyncReportRow,
} from "../integrations/weno/wenoEzIntegrationClient.js";

export const WENO_MESSAGE_IDENTIFIER_SYSTEM =
  "https://osod.dev/fhir/NamingSystem/weno-new-rx-message-id";
export const OSOD_TRANSMISSION_METHOD_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-transmission-method";
export const WENO_RX_SYNC_WRITE_HEADERS = {
  "X-OSOD-Source": "weno-new-rx-sync",
} as const;

export type WenoRxSyncTrigger = "scheduled" | "manual";

export interface WenoRxSyncFhirClient {
  search<T extends MedicationRequest>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  create<T extends MedicationRequest>(
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface SyncWenoRxActivityInput {
  trigger: WenoRxSyncTrigger;
  config: WenoEzIntegrationConfig;
  request: NewRxSyncReportRequest;
  fhir: WenoRxSyncFhirClient;
}

export interface SyncWenoRxActivityResult {
  created: number;
  skipped: number;
}

export async function syncWenoRxActivity(
  input: SyncWenoRxActivityInput,
): Promise<SyncWenoRxActivityResult> {
  const report = await pullNewRxSyncReport(input.config, input.request);
  const rows = parseNewRxSyncReport(report, input.request.ResponseFormat ?? "CSV");
  let created = 0;
  let skipped = 0;

  for (const row of rows) {
    const existing = await input.fhir.search<MedicationRequest>("MedicationRequest", {
      identifier: `${WENO_MESSAGE_IDENTIFIER_SYSTEM}|${row.RelatestoNewRxMsgID}`,
      _count: "1",
    });
    if (existing.entry?.some((entry) => entry.resource)) {
      skipped += 1;
      continue;
    }
    await input.fhir.create(buildWenoMedicationRequest(row), WENO_RX_SYNC_WRITE_HEADERS);
    created += 1;
  }

  return { created, skipped };
}

export function buildWenoMedicationRequest(row: NewRxSyncReportRow): MedicationRequest {
  for (const field of [
    "PatientID",
    "RelatestoNewRxMsgID",
    "DeliveryStatus",
    "DateTimeofactionUTC",
    "SynchType",
  ] as const) {
    if (!row[field]?.trim()) throw new Error(`WENO Sync Report row is missing ${field}.`);
  }
  return {
    resourceType: "MedicationRequest",
    identifier: [{ system: WENO_MESSAGE_IDENTIFIER_SYSTEM, value: row.RelatestoNewRxMsgID }],
    status: "unknown",
    intent: "order",
    medicationCodeableConcept: {
      text: "WENO prescription; structured medication detail pending signed-record retrieval",
    },
    subject: { reference: patientReference(row.PatientID) },
    authoredOn: row.DateTimeofactionUTC,
    reportedBoolean: true,
    extension: [{
      url: OSOD_TRANSMISSION_METHOD_EXTENSION_URL,
      valueCode: "electronically-sent",
    }],
    note: [{
      text: `WENO sync type: ${row.SynchType}; delivery status: ${row.DeliveryStatus}`,
    }],
  };
}

export function parseNewRxSyncReport(
  report: string,
  format: "CSV" | "JSON",
): NewRxSyncReportRow[] {
  if (format === "JSON") {
    const parsed = JSON.parse(report) as unknown;
    if (!Array.isArray(parsed)) throw new Error("WENO JSON Sync Report must be an array.");
    return parsed.map(readRow);
  }

  const records = parseCsv(report);
  const [headers, ...values] = records;
  if (!headers) return [];
  return values.filter((row) => row.some((value) => value.length > 0)).map((row) => {
    const source = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    return readRow(source);
  });
}

function readRow(value: unknown): NewRxSyncReportRow {
  if (!isRecord(value)) throw new Error("WENO Sync Report row must be an object.");
  return {
    PatientID: requiredString(value.PatientID, "PatientID"),
    RelatestoNewRxMsgID: requiredString(value.RelatestoNewRxMsgID, "RelatestoNewRxMsgID"),
    DeliveryStatus: requiredString(value.DeliveryStatus, "DeliveryStatus"),
    DateTimeofactionUTC: requiredString(value.DateTimeofactionUTC, "DateTimeofactionUTC"),
    SynchType: requiredString(value.SynchType, "SynchType"),
  };
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("WENO CSV Sync Report has an unterminated quoted field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function patientReference(patientId: string): string {
  const reference = patientId.startsWith("Patient/") ? patientId : `Patient/${patientId}`;
  if (!/^Patient\/[A-Za-z0-9.-]+$/.test(reference)) {
    throw new Error("WENO Sync Report PatientID cannot be converted to a local Patient reference.");
  }
  return reference;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`WENO Sync Report row is missing ${field}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
