import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export type PreviousExamLaterality = "OD" | "OS" | "OU" | "UNKNOWN";

export interface PreviousExamDiagnosisIdentity {
  diagnosisKey?: string;
  coding: Array<{ system?: string; code?: string; display?: string }>;
  text?: string;
  laterality: PreviousExamLaterality;
}

export interface PreviousExamFinding {
  observationReference: string;
  code: string;
  display: string;
  presence: "present" | "absent";
  grade?: string;
  laterality: PreviousExamLaterality;
}

export interface PreviousExamDiagnosis {
  conditionReference: string;
  display: string;
  identity: PreviousExamDiagnosisIdentity;
  findings: PreviousExamFinding[];
  checked: boolean;
  currentConditionReference?: string;
}

export interface PreviousExamGroup {
  encounterReference: string;
  date: string;
  visitType: string;
  diagnoses: PreviousExamDiagnosis[];
}

export interface PreviousExamsPage {
  pageSize: 4;
  encounters: PreviousExamGroup[];
  nextCursor?: string;
}

export interface DiagnosisPullResult {
  conditionReference: string;
  alreadyPresent: boolean;
}

export function appendPreviousExamsPage(
  current: readonly PreviousExamGroup[],
  page: PreviousExamsPage,
): PreviousExamGroup[] {
  const seen = new Set(current.map((encounter) => encounter.encounterReference));
  return [...current, ...page.encounters.filter((encounter) => {
    if (seen.has(encounter.encounterReference)) return false;
    seen.add(encounter.encounterReference);
    return true;
  })];
}

export function previousDiagnosisRowLabel(diagnosis: PreviousExamDiagnosis): string {
  return [
    diagnosis.display,
    diagnosis.identity.laterality,
    ...diagnosis.findings.map((finding) => [
      `${finding.display}: ${finding.presence}`,
      ...(finding.grade ? [`grade ${finding.grade}`] : []),
      finding.laterality,
    ].join(", ")),
  ].join(" · ");
}

export function formatDiagnosisHistoryDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export async function loadPreviousExamsPage(
  encounterReference: string,
  cursor: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PreviousExamsPage> {
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const fallback = "Previous exams could not be loaded. Try again.";
  const response = await safeFetch(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/previous-exams${query}`,
    { headers: authHeaders() },
    fetchImpl,
    fallback,
  );
  const body = await safeJson(response, fallback);
  if (!response.ok) throw new Error(safeServerError(body, fallback));
  if (!isPreviousExamsPage(body)) throw new Error(fallback);
  return body;
}

export async function pullPreviousDiagnosis(
  encounterReference: string,
  sourceEncounterReference: string,
  sourceConditionReference: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiagnosisPullResult> {
  const encounterId = encounterReference.replace(/^Encounter\//, "");
  const fallback = "Diagnosis could not be pulled. Try again.";
  const response = await safeFetch(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/previous-exams`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ sourceEncounterReference, sourceConditionReference }),
    },
    fetchImpl,
    fallback,
  );
  const body = await safeJson(response, fallback);
  if (!response.ok) throw new Error(safeServerError(body, fallback));
  if (!isDiagnosisPullResult(body)) throw new Error(fallback);
  return body;
}

async function safeFetch(
  input: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  fallback: string,
): Promise<Response> {
  try {
    return await fetchImpl(input, init);
  } catch {
    throw new Error(fallback);
  }
}

async function safeJson(response: Response, fallback: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(fallback);
  }
}

function safeServerError(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object" || !("error" in body)) return fallback;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 && error.length <= 240 && !/[\r\n]/.test(error)
    ? error
    : fallback;
}

function isPreviousExamsPage(body: unknown): body is PreviousExamsPage {
  if (!body || typeof body !== "object") return false;
  const page = body as Partial<PreviousExamsPage>;
  return page.pageSize === 4 && Array.isArray(page.encounters) && page.encounters.length <= page.pageSize &&
    page.encounters.every(isPreviousExamGroup) &&
    (page.nextCursor === undefined || trimmedNonblank(page.nextCursor));
}

function isDiagnosisPullResult(body: unknown): body is DiagnosisPullResult {
  if (!body || typeof body !== "object") return false;
  const result = body as Partial<DiagnosisPullResult>;
  return typeof result.conditionReference === "string" && /^Condition\/[^/]+$/.test(result.conditionReference) &&
    typeof result.alreadyPresent === "boolean";
}

function isPreviousExamGroup(value: unknown): value is PreviousExamGroup {
  if (!value || typeof value !== "object") return false;
  const group = value as Partial<PreviousExamGroup>;
  return reference(group.encounterReference, "Encounter") && validFhirDateOrDateTime(group.date) &&
    trimmedNonblank(group.visitType) && Array.isArray(group.diagnoses) &&
    group.diagnoses.every(isPreviousExamDiagnosis);
}

function isPreviousExamDiagnosis(value: unknown): value is PreviousExamDiagnosis {
  if (!value || typeof value !== "object") return false;
  const diagnosis = value as Partial<PreviousExamDiagnosis>;
  const checkedReferenceIsConsistent = diagnosis.checked
    ? reference(diagnosis.currentConditionReference, "Condition")
    : diagnosis.currentConditionReference === undefined;
  return reference(diagnosis.conditionReference, "Condition") && trimmedNonblank(diagnosis.display) &&
    isPreviousExamIdentity(diagnosis.identity) && Array.isArray(diagnosis.findings) &&
    diagnosis.findings.every(isPreviousExamFinding) && typeof diagnosis.checked === "boolean" &&
    checkedReferenceIsConsistent;
}

function isPreviousExamIdentity(value: unknown): value is PreviousExamDiagnosisIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<PreviousExamDiagnosisIdentity>;
  return laterality(identity.laterality) && Array.isArray(identity.coding) && identity.coding.every((coding) =>
    Boolean(coding) && typeof coding === "object" &&
    optionalTrimmedNonblank(coding.system) && optionalTrimmedNonblank(coding.code) &&
    optionalTrimmedNonblank(coding.display)
  ) && optionalTrimmedNonblank(identity.diagnosisKey) && optionalTrimmedNonblank(identity.text);
}

function isPreviousExamFinding(value: unknown): value is PreviousExamFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<PreviousExamFinding>;
  return reference(finding.observationReference, "Observation") && trimmedNonblank(finding.code) &&
    trimmedNonblank(finding.display) && (finding.presence === "present" || finding.presence === "absent") &&
    optionalTrimmedNonblank(finding.grade) && laterality(finding.laterality);
}

function reference(value: unknown, resourceType: "Encounter" | "Condition" | "Observation"): value is string {
  return typeof value === "string" && new RegExp(`^${resourceType}/[^/]+$`).test(value);
}

function trimmedNonblank(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function optionalTrimmedNonblank(value: unknown): value is string | undefined {
  return value === undefined || trimmedNonblank(value);
}

function laterality(value: unknown): value is PreviousExamLaterality {
  return value === "OD" || value === "OS" || value === "OU" || value === "UNKNOWN";
}

function validFhirDateOrDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = value.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (date) return validCalendarDate(date[1]!, date[2], date[3]);
  const dateTime = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/,
  );
  return Boolean(
    dateTime &&
    validCalendarDate(dateTime[1]!, dateTime[2], dateTime[3]) &&
    Number.isFinite(Date.parse(value)),
  );
}

function validCalendarDate(yearValue: string, monthValue?: string, dayValue?: string): boolean {
  const year = Number(yearValue);
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (monthValue === undefined) return dayValue === undefined;
  const month = Number(monthValue);
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (dayValue === undefined) return true;
  const day = Number(dayValue);
  if (!Number.isInteger(day) || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}
