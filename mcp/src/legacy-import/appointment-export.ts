import { parse } from "csv-parse/sync";

export const VERIFIED_APPOINTMENT_EXPORT_OFFICE = "00127314";
export const EYEFINITY_APPOINTMENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/eyefinity-appointment-composite";

export const APPOINTMENT_EXPORT_COLUMNS = [
  "OfficeNum",
  "PatientID",
  "FirstName",
  "lastname",
  "BirthDate",
  "Patient_no_old",
  "appt_date",
  "appt_start_time",
  "appt_end_time",
  "ProviderID",
  "ProviderFirst",
  "ProviderLast",
  "resourceid",
  "appt_cancel_ind",
  "appt_confirmed_ind",
  "PatientUID",
  "appt_type",
  "Notes",
] as const;

export type AppointmentExportColumn = (typeof APPOINTMENT_EXPORT_COLUMNS)[number];
export type AppointmentExportRow = Record<AppointmentExportColumn, string>;

export interface PreparedAppointmentRow {
  readonly row: AppointmentExportRow;
  readonly sourceKey: string;
  readonly visitDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly cancelled: boolean;
  readonly confirmed: boolean;
}

export interface AppointmentExportAmbiguity {
  readonly sourceKey: string;
  readonly patientUid: string;
  readonly visitDate: string;
  readonly rowCount: number;
  readonly activeRows: number;
  readonly cancelledRows: number;
}

export interface AppointmentExportAnalysis {
  readonly sourceRows: number;
  readonly exactDuplicates: number;
  readonly rowsAfterExactDedupe: number;
  readonly collisionGroups: number;
  readonly collisionRows: number;
  readonly resolvedCancelGroups: number;
  readonly ambiguousCollisionGroups: number;
  readonly duplicateSourceKeys: readonly string[];
  readonly appointments: readonly PreparedAppointmentRow[];
  readonly ambiguities: readonly AppointmentExportAmbiguity[];
}

interface ParsedCsvRecord {
  readonly record: AppointmentExportRow;
  readonly raw: string;
}

export function analyzeAppointmentExport(
  csv: string,
  sourceOfficeNumber: string,
): AppointmentExportAnalysis {
  if (sourceOfficeNumber !== VERIFIED_APPOINTMENT_EXPORT_OFFICE) {
    throw new Error(
      `Appointment collision rules are verified only for office export ${VERIFIED_APPOINTMENT_EXPORT_OFFICE}; got ${sourceOfficeNumber}.`,
    );
  }

  const parsed = parse(csv, {
    bom: true,
    columns: (headers: string[]) => {
      assertHeaders(headers);
      return headers;
    },
    raw: true,
    relax_quotes: true,
    skip_empty_lines: true,
  }) as ParsedCsvRecord[];

  const uniqueRows: AppointmentExportRow[] = [];
  const duplicateSourceKeys: string[] = [];
  const seenRawRows = new Set<string>();
  for (const entry of parsed) {
    if (seenRawRows.has(entry.raw)) {
      duplicateSourceKeys.push(appointmentCompositeKey(entry.record));
      continue;
    }
    seenRawRows.add(entry.raw);
    uniqueRows.push(entry.record);
  }

  const byComposite = new Map<string, AppointmentExportRow[]>();
  const patientIdByUid = new Map<string, string>();
  for (const row of uniqueRows) {
    validateRow(row);
    const patientUid = normalized(row.PatientUID);
    const patientId = normalized(row.PatientID);
    const priorPatientId = patientIdByUid.get(patientUid);
    if (priorPatientId && priorPatientId !== patientId) {
      throw new Error("One AppointmentsExport PatientUID maps to multiple PatientID values.");
    }
    patientIdByUid.set(patientUid, patientId);
    const sourceKey = appointmentCompositeKey(row);
    const group = byComposite.get(sourceKey) ?? [];
    group.push(row);
    byComposite.set(sourceKey, group);
  }

  const appointments: PreparedAppointmentRow[] = [];
  const ambiguities: AppointmentExportAmbiguity[] = [];
  let collisionGroups = 0;
  let collisionRows = 0;
  let resolvedCancelGroups = 0;

  for (const [sourceKey, rows] of byComposite) {
    if (rows.length === 1) {
      appointments.push(preparedRow(rows[0]!, sourceKey, parseBoolean(rows[0]!.appt_cancel_ind)));
      continue;
    }

    collisionGroups += 1;
    collisionRows += rows.length;
    const activeRows = rows.filter((row) => !parseBoolean(row.appt_cancel_ind));
    const cancelledRows = rows.length - activeRows.length;
    if (activeRows.length === 1 && cancelledRows === rows.length - 1) {
      resolvedCancelGroups += 1;
      appointments.push(preparedRow(activeRows[0]!, sourceKey, true));
      continue;
    }

    ambiguities.push({
      sourceKey,
      patientUid: normalized(rows[0]!.PatientUID),
      visitDate: parseAppointmentDate(rows[0]!.appt_date),
      rowCount: rows.length,
      activeRows: activeRows.length,
      cancelledRows,
    });
  }

  return {
    sourceRows: parsed.length,
    exactDuplicates: duplicateSourceKeys.length,
    rowsAfterExactDedupe: uniqueRows.length,
    collisionGroups,
    collisionRows,
    resolvedCancelGroups,
    ambiguousCollisionGroups: ambiguities.length,
    duplicateSourceKeys,
    appointments,
    ambiguities,
  };
}

export function appointmentCompositeKey(row: AppointmentExportRow): string {
  return JSON.stringify([
    normalized(row.PatientUID),
    parseAppointmentDate(row.appt_date),
    parseTime(row.appt_start_time),
    parseTime(row.appt_end_time),
    normalized(row.ProviderID),
    normalized(row.appt_type),
  ]);
}

export function parseAppointmentDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) 12:00:00 AM$/.exec(value.trim());
  if (!match) {
    throw new Error(`Appointment date must use MM/DD/YYYY 12:00:00 AM; got "${value}".`);
  }
  const [, month, day, year] = match;
  assertCalendarDate(`${year}-${month}-${day}`);
  return `${year}-${month}-${day}`;
}

export function parseTime(value: string): string {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Appointment time must use HH:mm:ss; got "${value}".`);
  }
  const [, hour, minute, second] = match.map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59) {
    throw new Error(`Appointment time is outside the clock range: "${value}".`);
  }
  return value.trim();
}

function preparedRow(
  row: AppointmentExportRow,
  sourceKey: string,
  cancelled: boolean,
): PreparedAppointmentRow {
  return {
    row,
    sourceKey,
    visitDate: parseAppointmentDate(row.appt_date),
    startTime: parseTime(row.appt_start_time),
    endTime: parseTime(row.appt_end_time),
    cancelled,
    confirmed: parseBoolean(row.appt_confirmed_ind),
  };
}

function assertHeaders(headers: readonly string[]): void {
  if (
    headers.length !== APPOINTMENT_EXPORT_COLUMNS.length
    || headers.some((header, index) => header !== APPOINTMENT_EXPORT_COLUMNS[index])
  ) {
    throw new Error(
      `AppointmentsExport headers do not match the verified Greenwood schema: ${headers.join(",")}.`,
    );
  }
}

function validateRow(row: AppointmentExportRow): void {
  for (const field of [
    "PatientID",
    "PatientUID",
    "appt_date",
    "appt_start_time",
    "appt_end_time",
  ] as const) {
    if (!normalized(row[field])) {
      throw new Error(`AppointmentsExport row has no ${field}.`);
    }
  }
  const providerValues = [row.ProviderID, row.ProviderFirst, row.ProviderLast].map(normalized);
  if (
    providerValues.some(Boolean)
    && (!providerValues[0] || !providerValues[2])
  ) {
    throw new Error("AppointmentsExport provider requires ProviderID and ProviderLast when present.");
  }
  parseBoolean(row.appt_cancel_ind);
  parseBoolean(row.appt_confirmed_ind);
  parseAppointmentDate(row.appt_date);
  parseTime(row.appt_start_time);
  parseTime(row.appt_end_time);
}

function parseBoolean(value: string): boolean {
  if (value === "True") return true;
  if (value === "False") return false;
  throw new Error(`AppointmentsExport boolean must be True or False; got "${value}".`);
}

function assertCalendarDate(value: string): void {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month! - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Appointment date is not a calendar date: "${value}".`);
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}
