import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "csv-parse/sync";
import {
  appointmentEncounterImportManifestSchema,
  type AppointmentEncounterImportManifest,
} from "../mcp/src/legacy-import/appointment-encounter-import.js";
import {
  analyzeAppointmentExport,
  APPOINTMENT_EXPORT_COLUMNS,
  type AppointmentExportColumn,
  type AppointmentExportRow,
  VERIFIED_APPOINTMENT_EXPORT_OFFICE,
} from "../mcp/src/legacy-import/appointment-export.js";
import {
  legacyVisitBulkManifestSchema,
  type LegacyVisitBulkFileChart,
} from "../mcp/src/legacy-import/bulk-visit-import.js";
import {
  FORBIDDEN_M2A_EHR_SOURCE_KEY,
  FORBIDDEN_M2A_EPM_SOURCE_KEY,
  junkRowReasons,
  patientImportManifestSchema,
  type PatientImportManifest,
  type SourcePerson,
} from "../mcp/src/legacy-import/patient-import.js";
import {
  defaultVisitTypeCatalog,
  ODOS_VISIT_TYPE_SYSTEM,
} from "../mcp/src/fhir/schedulingVisitType.js";
import { readSetupState } from "./setup-practice.js";

const EXAM_EXPORT_COLUMNS = [
  "ptSrNo",
  "exSrNo",
  "exDateTime",
  "exDevType",
  "exWhichEye",
] as const;
export const PATIENT_EXPORT_COLUMNS = [
  "ID",
  "FirstName",
  "LastName",
  "LastExamDate",
  "CreatedDate",
  "BirthDate",
  "Sex",
  "email",
  "SSN",
  "OldPatientNo",
  "address1",
  "address2",
  "city",
  "state",
  "zipcode",
  "country",
  "homephone",
  "homephoneext",
  "workphone",
  "workphoneext",
  "mobilephone",
  "mobilephoneext",
  "salutation",
  "companyid",
  "HomeOffice",
  "ConversionOrigin",
  "EMRPatientNum",
  "PatientUID",
  "ExamOffice",
  "Active",
] as const;

type PatientExportColumn = (typeof PATIENT_EXPORT_COLUMNS)[number];
type PatientExportRow = Record<PatientExportColumn, string>;
type ExamExportColumn = (typeof EXAM_EXPORT_COLUMNS)[number];
type ExamExportRow = Record<ExamExportColumn, string>;

interface JunkSourcePerson extends SourcePerson {
  readonly sourceSystem: "epm" | "ehr";
}

export interface PatientManifestGenerationResult {
  readonly manifests: readonly {
    readonly manifest: PatientImportManifest;
    readonly path: string;
    readonly importArguments: readonly string[];
  }[];
  readonly classifiedJunkRows: number;
}

export interface PatientReferenceInput {
  readonly patientReference: string;
  readonly patientUid: string;
  readonly epmPatientId: string;
  readonly ehrPatientId: string;
}

export interface VisitManifestGenerationResult {
  readonly bulkManifestPath: string;
  readonly charts: readonly {
    readonly chartKey: string;
    readonly manifestPath: string;
    readonly appointmentsPath: string;
    readonly examsPath: string;
  }[];
  readonly sourceAppointmentRows: number;
  readonly targetAppointmentRows: number;
  readonly targetExamRows: number;
  readonly visitTypes: readonly string[];
}

export function generatePatientImportManifests(input: {
  readonly patientExportPath: string;
  readonly ehrPeoplePath: string;
  readonly outputDirectory: string;
  readonly expectedChartCount: number;
}): PatientManifestGenerationResult {
  assertExpectedChartCount(input.expectedChartCount);
  const epmRows = parsePatientExport(readFileSync(input.patientExportPath, "utf8"));
  const ehrRows = parseEhrPeople(readFileSync(input.ehrPeoplePath, "utf8"));
  const epmPeople = epmRows.map(epmPatientFromExport);
  const classifiedJunk = [
    ...classifyApprovedJunkRows(epmPeople, "epm"),
    ...classifyApprovedJunkRows(ehrRows, "ehr"),
  ].sort((left, right) =>
    left.sourceSystem.localeCompare(right.sourceSystem)
    || sourceKeyOrder(left.sourceKey, right.sourceKey)
  );
  if (classifiedJunk.length === 0) {
    throw new Error("No source row matched an approved junk rule; patient manifests require junk evidence.");
  }

  const targetEhrPeople = ehrRows.filter((row) => junkRowReasons(row).length === 0);
  if (targetEhrPeople.length !== input.expectedChartCount) {
    throw new Error(
      `EHR source-person input must contain exactly ${input.expectedChartCount} non-junk charts; `
      + `got ${targetEhrPeople.length}.`,
    );
  }
  assertUniqueSourceKeys(targetEhrPeople, "EHR");

  // PatientExport is full-practice input; the EHR cohort defines the target identities.
  const epmByIdentity = new Map<string, PatientImportManifest["epm"][]>();
  for (const person of epmPeople.filter((row) => junkRowReasons(row).length === 0)) {
    const key = identityKey(person);
    const matches = epmByIdentity.get(key) ?? [];
    matches.push(person);
    epmByIdentity.set(key, matches);
  }

  const outputDirectory = resolve(input.outputDirectory);
  ensurePrivateDirectory(outputDirectory);
  const claimedEpmSourceKeys = new Set<string>();
  const manifests = targetEhrPeople
    .sort((left, right) => sourceKeyOrder(left.sourceKey, right.sourceKey))
    .map((ehr) => {
      const matches = epmByIdentity.get(identityKey(ehr)) ?? [];
      if (matches.length !== 1) {
        throw new Error(
          `EHR source ${ehr.sourceKey} matched ${matches.length} PatientExport rows on `
          + "firstName+lastName+birthDate; exactly one is required.",
        );
      }
      const epm = matches[0]!;
      if (claimedEpmSourceKeys.has(epm.sourceKey)) {
        throw new Error(
          `PatientExport source ${epm.sourceKey} matched more than one EHR cohort person.`,
        );
      }
      claimedEpmSourceKeys.add(epm.sourceKey);
      assertOperatorPairComplete(epm.sourceKey, ehr.sourceKey);
      const manifest = patientImportManifestSchema.parse({
        epm,
        ehr,
        junkRows: classifiedJunk,
      });
      const path = join(outputDirectory, `patient-${safeFilePart(ehr.sourceKey)}.json`);
      writePrivateFile(path, JSON.stringify(manifest, null, 2) + "\n");
      return {
        manifest,
        path,
        importArguments: patientImportArguments(path, manifest),
      };
    });

  return {
    manifests,
    classifiedJunkRows: classifiedJunk.length,
  };
}

export function generateVisitImportManifests(input: {
  readonly appointmentsExportPath: string;
  readonly examsTsvPath: string;
  readonly patientReferencesPath: string;
  readonly visitTypeMapPath: string;
  readonly setupStatePath: string;
  readonly outputDirectory: string;
  readonly expectedChartCount: number;
}): VisitManifestGenerationResult {
  assertExpectedChartCount(input.expectedChartCount);
  const appointmentsCsv = readFileSync(input.appointmentsExportPath, "utf8");
  const analysis = analyzeAppointmentExport(
    appointmentsCsv,
    VERIFIED_APPOINTMENT_EXPORT_OFFICE,
  );
  const appointmentRows = parseAppointmentRows(appointmentsCsv);
  const patientReferences = parsePatientReferences(
    readFileSync(input.patientReferencesPath, "utf8"),
    input.expectedChartCount,
  );
  const examRows = parseExamRows(readFileSync(input.examsTsvPath, "utf8"));
  const sourceVisitTypeMap = parseVisitTypeMap(
    readFileSync(input.visitTypeMapPath, "utf8"),
  );
  const setupState = readSetupState(resolve(input.setupStatePath));
  if (!setupState.organizationId || !setupState.locationId) {
    throw new Error(
      `Setup state ${resolve(input.setupStatePath)} must contain organizationId and locationId.`,
    );
  }

  const referenceByEpmId = uniqueIndex(
    patientReferences,
    (entry) => entry.epmPatientId,
    "EPM patient id",
  );
  const referenceByEhrId = uniqueIndex(
    patientReferences,
    (entry) => entry.ehrPatientId,
    "EHR patient id",
  );
  uniqueIndex(patientReferences, (entry) => entry.patientUid, "appointment PatientUID");
  uniqueIndex(patientReferences, (entry) => entry.patientReference, "FHIR Patient reference");

  const targetAppointmentRows = appointmentRows.filter((row) =>
    referenceByEpmId.has(normalized(row.PatientID))
  );
  for (const row of targetAppointmentRows) {
    const reference = referenceByEpmId.get(normalized(row.PatientID))!;
    if (normalized(row.PatientUID) !== reference.patientUid) {
      throw new Error(
        `EPM patient ${reference.epmPatientId} has AppointmentsExport PatientUID `
        + `${normalized(row.PatientUID)} instead of supplied ${reference.patientUid}.`,
      );
    }
  }
  for (const row of examRows) {
    if (!referenceByEhrId.has(normalized(row.ptSrNo))) {
      throw new Error(`Exam TSV contains out-of-cohort ptSrNo ${normalized(row.ptSrNo)}.`);
    }
  }
  const epmIdsWithAppointments = new Set(
    targetAppointmentRows.map((row) => normalized(row.PatientID)),
  );
  const chartsWithoutAppointments = patientReferences
    .filter((entry) => !epmIdsWithAppointments.has(entry.epmPatientId))
    .map((entry) => entry.epmPatientId);
  if (chartsWithoutAppointments.length > 0) {
    throw new Error(
      `AppointmentsExport has no rows for EPM patients: ${chartsWithoutAppointments.join(", ")}.`,
    );
  }

  const rawVisitTypes = [
    ...new Set(
      targetAppointmentRows
        .map((row) => normalized(row.appt_type))
    ),
  ].sort();
  const visitTypeMap = validateVisitTypeMap(rawVisitTypes, sourceVisitTypeMap);

  const outputDirectory = resolve(input.outputDirectory);
  const manifestsDirectory = join(outputDirectory, "manifests");
  const appointmentsDirectory = join(outputDirectory, "appointments");
  const examsDirectory = join(outputDirectory, "exams");
  for (const directory of [
    outputDirectory,
    manifestsDirectory,
    appointmentsDirectory,
    examsDirectory,
  ]) {
    ensurePrivateDirectory(directory);
  }

  const charts = patientReferences
    .sort((left, right) => sourceKeyOrder(left.ehrPatientId, right.ehrPatientId))
    .map((reference) => {
      const fileKey = safeFilePart(reference.ehrPatientId);
      const chartAppointmentRows = targetAppointmentRows.filter((row) =>
        normalized(row.PatientID) === reference.epmPatientId
      );
      const chartExamRows = examRows.filter((row) =>
        normalized(row.ptSrNo) === reference.ehrPatientId
      );
      const manifest = appointmentEncounterImportManifestSchema.parse({
        sourceOfficeNumber: VERIFIED_APPOINTMENT_EXPORT_OFFICE,
        patientReference: reference.patientReference,
        patientUid: reference.patientUid,
        epmPatientId: reference.epmPatientId,
        ehrPatientId: reference.ehrPatientId,
        organizationReference: `Organization/${setupState.organizationId}`,
        locationReference: `Location/${setupState.locationId}`,
        visitTypeMap,
      } satisfies AppointmentEncounterImportManifest);
      const manifestPath = join(manifestsDirectory, `chart-${fileKey}.json`);
      const appointmentsPath = join(appointmentsDirectory, `chart-${fileKey}.csv`);
      const examsPath = join(examsDirectory, `chart-${fileKey}.tsv`);
      writePrivateFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      writePrivateFile(appointmentsPath, serializeCsv(chartAppointmentRows));
      writePrivateFile(examsPath, serializeTsv(chartExamRows));
      return {
        chartKey: reference.ehrPatientId,
        manifestPath,
        appointmentsPath,
        examsPath,
      };
    });

  const bulkCharts: LegacyVisitBulkFileChart[] = charts.map((chart) => ({
    chartKey: chart.chartKey,
    manifestPath: relativeOutputPath(outputDirectory, chart.manifestPath),
    appointmentsPath: relativeOutputPath(outputDirectory, chart.appointmentsPath),
    examsPath: relativeOutputPath(outputDirectory, chart.examsPath),
  }));
  const bulkManifest = legacyVisitBulkManifestSchema.parse({ charts: bulkCharts });
  const bulkManifestPath = join(outputDirectory, "bulk-manifest.json");
  writePrivateFile(
    bulkManifestPath,
    JSON.stringify(bulkManifest, null, 2) + "\n",
  );

  return {
    bulkManifestPath,
    charts,
    sourceAppointmentRows: analysis.sourceRows,
    targetAppointmentRows: targetAppointmentRows.length,
    targetExamRows: examRows.length,
    visitTypes: rawVisitTypes,
  };
}

export function classifyApprovedJunkRows(
  rows: readonly SourcePerson[],
  sourceSystem: "epm" | "ehr",
): JunkSourcePerson[] {
  return rows
    .filter((row) => junkRowReasons(row).length > 0)
    .map((row) => ({ ...row, sourceSystem }));
}

export function patientImportArguments(
  manifestPath: string,
  manifest: PatientImportManifest,
): readonly string[] {
  const operatorChart =
    manifest.epm.sourceKey === FORBIDDEN_M2A_EPM_SOURCE_KEY
    && manifest.ehr.sourceKey === FORBIDDEN_M2A_EHR_SOURCE_KEY;
  return [
    "--manifest",
    resolve(manifestPath),
    ...(operatorChart ? ["--allow-operator-test-data-chart"] : []),
  ];
}

export function resolveSetupStatePath(
  explicitPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string {
  return resolve(
    explicitPath
      ?? environment.ODOS_SETUP_STATE_PATH
      ?? join(workingDirectory, ".odos-setup-state.json"),
  );
}

export function isDirectExecution(importMetaUrl: string, argvPath: string): boolean {
  return importMetaUrl === pathToFileURL(resolve(argvPath)).href;
}

export function parseGeneratorCliArguments(
  args: readonly string[],
  input: {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
  },
): Readonly<Record<string, string>> {
  const known = new Set([...input.required, ...(input.optional ?? [])]);
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument value ${name}.`);
    }
    if (!known.has(name)) {
      throw new Error(`Unknown argument ${name}.`);
    }
    if (parsed[name] !== undefined) {
      throw new Error(`${name} was supplied more than once.`);
    }
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    parsed[name] = value;
  }
  for (const name of input.required) {
    if (parsed[name] === undefined) throw new Error(`${name} requires a value.`);
  }
  return parsed;
}

export function parseExpectedChartCount(value: string): number {
  const chartCount = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(chartCount)) {
    throw new Error(`--expected-charts must be a positive integer; got "${value}".`);
  }
  return chartCount;
}

export function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function parsePatientExport(csv: string): PatientExportRow[] {
  return parse(csv, {
    bom: true,
    columns: (headers: string[]) => {
      assertExactHeaders(headers, PATIENT_EXPORT_COLUMNS, "PatientExport");
      return headers;
    },
    relax_quotes: true,
    skip_empty_lines: true,
  }) as PatientExportRow[];
}

function parseEhrPeople(json: string): SourcePerson[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("EHR source-person input must be a JSON array.");
  }
  return parsed.map((value, index) => sourcePersonFromUnknown(value, index));
}

function sourcePersonFromUnknown(value: unknown, index: number): SourcePerson {
  if (!isObject(value)) {
    throw new Error(`EHR source-person row ${index + 1} must be an object.`);
  }
  const sourceKey = requiredString(value.sourceKey, `EHR row ${index + 1} sourceKey`);
  const firstName = requiredString(value.firstName, `EHR source ${sourceKey} firstName`);
  const lastName = requiredString(value.lastName, `EHR source ${sourceKey} lastName`);
  const birthDate = isoBirthDate(
    requiredString(value.birthDate, `EHR source ${sourceKey} birthDate`),
  );
  const middleName = optionalString(value.middleName);
  const suffix = optionalString(value.suffix);
  return {
    sourceKey,
    firstName,
    ...(middleName ? { middleName } : {}),
    lastName,
    ...(suffix ? { suffix } : {}),
    birthDate,
  };
}

function epmPatientFromExport(row: PatientExportRow): PatientImportManifest["epm"] {
  const sourceKey = requiredString(row.ID, "PatientExport ID");
  const firstName = requiredString(row.FirstName, `PatientExport ${sourceKey} FirstName`);
  const lastName = requiredString(row.LastName, `PatientExport ${sourceKey} LastName`);
  const birthDate = sourceBirthDate(
    requiredString(row.BirthDate, `PatientExport ${sourceKey} BirthDate`),
  );
  const gender = patientGender(row.Sex);
  const active = sourceBoolean(row.Active, `PatientExport ${sourceKey} Active`);
  const telecom = [
    contactPoint("email", row.email),
    contactPoint("phone", row.homephone, row.homephoneext, "home"),
    contactPoint("phone", row.workphone, row.workphoneext, "work"),
    contactPoint("phone", row.mobilephone, row.mobilephoneext, "mobile"),
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const addressLines = [normalized(row.address1), normalized(row.address2)].filter(Boolean);
  const addressFields = {
    ...(addressLines.length > 0 ? { line: addressLines } : {}),
    ...(normalized(row.city) ? { city: normalized(row.city) } : {}),
    ...(normalized(row.state) ? { state: normalized(row.state) } : {}),
    ...(normalized(row.zipcode) ? { postalCode: normalized(row.zipcode) } : {}),
    ...(normalized(row.country) ? { country: normalized(row.country) } : {}),
  };
  const hasAddress = Object.keys(addressFields).length > 0;
  return {
    sourceKey,
    firstName,
    lastName,
    birthDate,
    ...(active === undefined ? {} : { active }),
    ...(gender ? { gender } : {}),
    ...(telecom.length > 0 ? { telecom } : {}),
    ...(hasAddress ? { address: [{ use: "home", ...addressFields }] } : {}),
  };
}

function parsePatientReferences(
  json: string,
  expectedChartCount: number,
): PatientReferenceInput[] {
  const parsed: unknown = JSON.parse(json);
  const rows = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.charts)
      ? parsed.charts
      : undefined;
  if (!rows) {
    throw new Error("Patient-reference input must contain a chart-object array.");
  }
  if (rows.length !== expectedChartCount) {
    throw new Error(
      `Patient-reference input must contain exactly ${expectedChartCount} chart objects; `
      + `got ${rows.length}.`,
    );
  }
  return rows.map((value, index) => {
    if (!isObject(value)) {
      throw new Error(`Patient-reference row ${index + 1} must be an object.`);
    }
    const patientReference = requiredString(
      value.patientReference,
      `Patient-reference row ${index + 1} patientReference`,
    );
    if (!/^Patient\/[A-Za-z0-9.-]+$/.test(patientReference)) {
      throw new Error(`Invalid FHIR Patient reference ${patientReference}.`);
    }
    return {
      patientReference,
      patientUid: requiredString(value.patientUid, `Patient-reference row ${index + 1} patientUid`),
      epmPatientId: requiredString(
        value.epmPatientId,
        `Patient-reference row ${index + 1} epmPatientId`,
      ),
      ehrPatientId: requiredString(
        value.ehrPatientId,
        `Patient-reference row ${index + 1} ehrPatientId`,
      ),
    };
  });
}

function assertExpectedChartCount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Expected chart count must be a positive integer; got ${String(value)}.`);
  }
}

function parseAppointmentRows(csv: string): AppointmentExportRow[] {
  return parse(csv, {
    bom: true,
    columns: (headers: string[]) => {
      assertExactHeaders(headers, APPOINTMENT_EXPORT_COLUMNS, "AppointmentsExport");
      return headers;
    },
    relax_quotes: true,
    skip_empty_lines: true,
  }) as AppointmentExportRow[];
}

function parseExamRows(tsv: string): ExamExportRow[] {
  const rows = parse(tsv, {
    bom: true,
    columns: (headers: string[]) => {
      assertExactHeaders(headers, EXAM_EXPORT_COLUMNS, "Exam TSV");
      return headers;
    },
    delimiter: "\t",
    skip_empty_lines: true,
  }) as ExamExportRow[];
  for (const [index, row] of rows.entries()) {
    if (EXAM_EXPORT_COLUMNS.every((column) => /^-{3,}$/.test(row[column].trim()))) {
      throw new Error("Exam TSV contains a separator-artifact row.");
    }
    for (const column of EXAM_EXPORT_COLUMNS) {
      if (!normalized(row[column])) {
        throw new Error(`Exam TSV row ${index + 2} has no ${column}.`);
      }
      if (/[\t\r\n]/.test(row[column])) {
        throw new Error(
          `Exam TSV row ${index + 2} ${column} contains a delimiter character.`,
        );
      }
    }
    if (!/^\d{4}-\d{2}-\d{2} 00:00:00\.000$/.test(row.exDateTime.trim())) {
      throw new Error(
        `Exam TSV row ${index + 2} exDateTime must use YYYY-MM-DD 00:00:00.000.`,
      );
    }
    const date = row.exDateTime.trim().slice(0, 10);
    assertCalendarDate(
      date,
      `Exam TSV row ${index + 2} exDateTime is not a calendar date.`,
    );
  }
  return rows;
}

function parseVisitTypeMap(json: string): Map<string, { code: string; display: string }> {
  const parsed: unknown = JSON.parse(json);
  if (!isObject(parsed)) {
    throw new Error("Visit-type map input must be a JSON object.");
  }
  const result = new Map<string, { code: string; display: string }>();
  for (const [rawValue, mapping] of Object.entries(parsed)) {
    const normalizedRawValue = normalized(rawValue);
    if (!normalizedRawValue || !isObject(mapping)) {
      throw new Error("Each visit-type map entry requires a nonblank source label and object value.");
    }
    if (result.has(normalizedRawValue)) {
      throw new Error(`Visit-type map contains duplicate normalized key "${normalizedRawValue}".`);
    }
    result.set(normalizedRawValue, {
      code: requiredString(mapping.code, `${normalizedRawValue} code`),
      display: requiredString(mapping.display, `${normalizedRawValue} display`),
    });
  }
  return result;
}

function validateVisitTypeMap(
  rawVisitTypes: readonly string[],
  supplied: ReadonlyMap<string, { code: string; display: string }>,
): Record<string, { code: string; display: string }> {
  const unmapped = rawVisitTypes.filter((rawValue) => !supplied.has(rawValue));
  if (unmapped.length > 0) {
    throw new Error(
      `Unmapped target appt_type values: ${unmapped.map((value) => value || "(blank)").join(", ")}`,
    );
  }
  const shipped = new Map(
    defaultVisitTypeCatalog("eyecare").map((service) => {
      const coding = service.type
        ?.flatMap((concept) => concept.coding ?? [])
        .find((entry) => entry.system === ODOS_VISIT_TYPE_SYSTEM);
      if (!coding?.code || !coding.display) {
        throw new Error("Shipped eyecare visit type lacks its ODOS coding.");
      }
      return [coding.code, coding.display] as const;
    }),
  );
  return Object.fromEntries(rawVisitTypes.map((rawValue) => {
    const mapping = supplied.get(rawValue)!;
    if (shipped.get(mapping.code) !== mapping.display) {
      throw new Error(
        `Visit-type mapping for "${rawValue}" is not an exact shipped eyecare coding: `
        + `${mapping.code} / ${mapping.display}.`,
      );
    }
    return [rawValue, mapping];
  }));
}

function serializeCsv(rows: readonly AppointmentExportRow[]): string {
  return [
    APPOINTMENT_EXPORT_COLUMNS.map(csvCell).join(","),
    ...rows.map((row) =>
      APPOINTMENT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(",")
    ),
  ].join("\n") + "\n";
}

function serializeTsv(rows: readonly ExamExportRow[]): string {
  return [
    EXAM_EXPORT_COLUMNS.join("\t"),
    ...rows.map((row) => EXAM_EXPORT_COLUMNS.map((column) => row[column]).join("\t")),
  ].join("\n") + "\n";
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

function identityKey(person: SourcePerson): string {
  return JSON.stringify([
    normalizedName(person.firstName),
    normalizedName(person.lastName),
    person.birthDate,
  ]);
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function sourceBirthDate(value: string): string {
  const trimmed = value.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(trimmed);
  if (isoMatch) return isoBirthDate(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`);
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+.*)?$/.exec(trimmed);
  if (!usMatch) {
    throw new Error(`Unsupported source birth date "${value}".`);
  }
  return isoBirthDate(
    `${usMatch[3]}-${usMatch[1]!.padStart(2, "0")}-${usMatch[2]!.padStart(2, "0")}`,
  );
}

function isoBirthDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Birth date must use YYYY-MM-DD; got "${value}".`);
  }
  if (value === "9999-12-31" || value === "1899-12-31") return value;
  assertCalendarDate(value, `Birth date is not a calendar date: "${value}".`);
  return value;
}

function assertCalendarDate(value: string, message: string): void {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(message);
  }
}

function patientGender(
  value: string,
): PatientImportManifest["epm"]["gender"] | undefined {
  const normalizedValue = normalized(value).toLocaleLowerCase("en-US");
  if (!normalizedValue) return undefined;
  if (normalizedValue === "m" || normalizedValue === "male") return "male";
  if (normalizedValue === "f" || normalizedValue === "female") return "female";
  if (normalizedValue === "other") return "other";
  if (normalizedValue === "unknown" || normalizedValue === "u") return "unknown";
  throw new Error(`Unsupported PatientExport Sex value "${value}".`);
}

function sourceBoolean(value: string, label: string): boolean | undefined {
  const normalizedValue = normalized(value).toLocaleLowerCase("en-US");
  if (!normalizedValue) return undefined;
  if (["true", "1", "yes", "y"].includes(normalizedValue)) return true;
  if (["false", "0", "no", "n"].includes(normalizedValue)) return false;
  throw new Error(`${label} must be a source boolean; got "${value}".`);
}

function contactPoint(
  system: "email" | "phone",
  value: string,
  extension?: string,
  use?: "home" | "work" | "mobile",
): NonNullable<PatientImportManifest["epm"]["telecom"]>[number] | undefined {
  const base = normalized(value);
  if (!base) return undefined;
  const ext = normalized(extension ?? "");
  return {
    system,
    value: ext ? `${base} x${ext}` : base,
    ...(use ? { use } : {}),
  };
}

function assertOperatorPairComplete(epmSourceKey: string, ehrSourceKey: string): void {
  const hasOperatorEpm = epmSourceKey === FORBIDDEN_M2A_EPM_SOURCE_KEY;
  const hasOperatorEhr = ehrSourceKey === FORBIDDEN_M2A_EHR_SOURCE_KEY;
  if (hasOperatorEpm !== hasOperatorEhr) {
    throw new Error(
      "The operator chart acknowledgement is valid only for the exact "
      + `EPM ${FORBIDDEN_M2A_EPM_SOURCE_KEY} / EHR ${FORBIDDEN_M2A_EHR_SOURCE_KEY} pair.`,
    );
  }
}

function assertUniqueSourceKeys(rows: readonly SourcePerson[], label: string): void {
  uniqueIndex(rows, (row) => row.sourceKey, `${label} source key`);
}

function uniqueIndex<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = normalized(keyFor(value));
    if (!key) throw new Error(`${label} must not be blank.`);
    if (result.has(key)) throw new Error(`Duplicate ${label}: ${key}.`);
    result.set(key, value);
  }
  return result;
}

function assertExactHeaders(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length
    || actual.some((header, index) => header !== expected[index])
  ) {
    throw new Error(`${label} headers do not match the verified schema: ${actual.join(",")}.`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !normalized(value)) {
    throw new Error(`${label} must be a nonblank string.`);
  }
  return normalized(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && normalized(value) ? normalized(value) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFilePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`Source key cannot form a safe filename: ${value}.`);
  }
  return safe;
}

function sourceKeyOrder(left: string, right: string): number {
  return left.localeCompare(right, "en-US", { numeric: true });
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateFile(path: string, contents: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function relativeOutputPath(outputDirectory: string, path: string): string {
  const parent = resolve(outputDirectory);
  const absolute = resolve(path);
  const nativeRelative = relative(parent, absolute);
  if (
    !nativeRelative
    || nativeRelative === ".."
    || nativeRelative.startsWith(`..${sep}`)
    || isAbsolute(nativeRelative)
  ) {
    throw new Error(`${basename(path)} was written outside the bulk output directory.`);
  }
  return nativeRelative.split(sep).join(posix.sep);
}
