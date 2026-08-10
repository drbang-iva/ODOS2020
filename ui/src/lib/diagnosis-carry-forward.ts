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
  return page.pageSize === 4 && Array.isArray(page.encounters) && page.encounters.every(isPreviousExamGroup) &&
    (page.nextCursor === undefined || nonemptyString(page.nextCursor));
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
  return reference(group.encounterReference, "Encounter") && nonemptyString(group.date) &&
    nonemptyString(group.visitType) && Array.isArray(group.diagnoses) &&
    group.diagnoses.every(isPreviousExamDiagnosis);
}

function isPreviousExamDiagnosis(value: unknown): value is PreviousExamDiagnosis {
  if (!value || typeof value !== "object") return false;
  const diagnosis = value as Partial<PreviousExamDiagnosis>;
  const checkedReferenceIsConsistent = diagnosis.checked
    ? reference(diagnosis.currentConditionReference, "Condition")
    : diagnosis.currentConditionReference === undefined;
  return reference(diagnosis.conditionReference, "Condition") && nonemptyString(diagnosis.display) &&
    isPreviousExamIdentity(diagnosis.identity) && Array.isArray(diagnosis.findings) &&
    diagnosis.findings.every(isPreviousExamFinding) && typeof diagnosis.checked === "boolean" &&
    checkedReferenceIsConsistent;
}

function isPreviousExamIdentity(value: unknown): value is PreviousExamDiagnosisIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<PreviousExamDiagnosisIdentity>;
  return laterality(identity.laterality) && Array.isArray(identity.coding) && identity.coding.every((coding) =>
    Boolean(coding) && typeof coding === "object" &&
    optionalString(coding.system) && optionalString(coding.code) && optionalString(coding.display)
  ) && optionalString(identity.diagnosisKey) && optionalString(identity.text);
}

function isPreviousExamFinding(value: unknown): value is PreviousExamFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<PreviousExamFinding>;
  return reference(finding.observationReference, "Observation") && nonemptyString(finding.code) &&
    nonemptyString(finding.display) && (finding.presence === "present" || finding.presence === "absent") &&
    optionalString(finding.grade) && laterality(finding.laterality);
}

function reference(value: unknown, resourceType: "Encounter" | "Condition" | "Observation"): value is string {
  return typeof value === "string" && new RegExp(`^${resourceType}/[^/]+$`).test(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function laterality(value: unknown): value is PreviousExamLaterality {
  return value === "OD" || value === "OS" || value === "OU" || value === "UNKNOWN";
}
