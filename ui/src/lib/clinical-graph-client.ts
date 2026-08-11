import type { Condition, Encounter } from "@medplum/fhirtypes";
import { CONCURRENT_EDIT_MESSAGE, fhir } from "./fhir";

export interface ClinicalGraphErrorBody {
  error?: string;
  code?: string;
}

export function clinicalGraphResponseError(
  response: Pick<Response, "status">,
  body: ClinicalGraphErrorBody,
  fallback: string,
): Error {
  if ((response.status === 409 && body.code === "concurrent-edit") || response.status === 412) {
    return new Error(CONCURRENT_EDIT_MESSAGE);
  }
  return new Error(body.error ?? fallback);
}

export function authHeaders(): Record<string, string> {
  const authorization = fhir.authHeader();
  return authorization ? { Authorization: authorization } : {};
}

export function clinicalGraphApiBase(): string {
  return import.meta.env?.VITE_ODOS_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}

export type DiagnosisCandidateSuggestion = {
  diagnosisKey: string;
  familyGroup?: never;
  display: string;
  priority: boolean;
  source: "rule" | "mapping";
} | {
  diagnosisKey?: never;
  familyGroup: string;
  clinicalFamily: string;
  display: string;
  axisLabel: string;
  members: Array<{ stableKey: string; stageLabel: string }>;
  priority: boolean;
  source: "rule" | "mapping";
};

export interface DiagnosisCandidateFinding {
  findingInstanceId: string;
  findingDefinitionKey?: string;
  observationReference?: string;
  candidates: DiagnosisCandidateSuggestion[];
}

export async function readDiagnosisCandidates(encounterId: string): Promise<DiagnosisCandidateFinding[]> {
  const response = await fetch(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-candidates`,
    { headers: authHeaders() },
  );
  const body = await response.json() as { findings?: DiagnosisCandidateFinding[]; error?: string };
  if (!response.ok) throw clinicalGraphResponseError(response, body, `Diagnosis candidates failed: ${response.status}`);
  return body.findings ?? [];
}

export type DiagnosisCompleteness = {
  encounterReference: string;
  diagnoses: Array<{
    conditionReference?: string;
    diagnosisKey: string;
    laterality: string;
    display: string;
    missing: Array<{ findingKey: string; display: string }>;
  }>;
};

export const DIAGNOSIS_COMPLETENESS_TIMEOUT_MS = 5_000;

export async function readDiagnosisCompleteness(
  encounterId: string,
  timeoutMs = DIAGNOSIS_COMPLETENESS_TIMEOUT_MS,
): Promise<DiagnosisCompleteness> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-completeness`,
      { headers: authHeaders(), signal: controller.signal },
    );
    const body = await response.json() as DiagnosisCompleteness & { error?: string };
    if (!response.ok) throw clinicalGraphResponseError(response, body, `Diagnosis completeness failed: ${response.status}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function submitDiagnosisPick(input: {
  encounterReference: string;
  diagnosisKey: string;
  action: "possible" | "confirm" | "discard";
  findingInstanceId?: string;
  laterality?: "OD" | "OS" | "OU";
  source?: "rule" | "mapping" | "catalog-search";
  status?: DiagnosisVisitStatus;
  stageDeferred?: boolean;
}): Promise<{ condition: Condition; encounter?: Encounter }> {
  const encounterId = input.encounterReference.replace(/^Encounter\//, "");
  const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-picks`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      diagnosisKey: input.diagnosisKey,
      action: input.action,
      ...(input.findingInstanceId ? { findingInstanceId: input.findingInstanceId } : {}),
      ...(input.laterality ? { laterality: input.laterality } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.stageDeferred ? { stageDeferred: true } : {}),
    }),
  });
  const body = await response.json() as { condition?: Condition; encounter?: Encounter; error?: string };
  if (!response.ok) throw clinicalGraphResponseError(response, body, `Diagnosis pick failed: ${response.status}`);
  if (!body.condition) throw new Error("Diagnosis pick response did not include the Condition.");
  window.dispatchEvent(new CustomEvent("odos:diagnosis-picked", { detail: { encounterReference: input.encounterReference } }));
  return { condition: body.condition, ...(body.encounter ? { encounter: body.encounter } : {}) };
}

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

export async function readDiagnosisVisitStatuses(encounterId: string): Promise<DiagnosisVisitStatusRow[]> {
  const response = await fetch(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-statuses`,
    { headers: authHeaders() },
  );
  const body = await response.json() as { statuses?: DiagnosisVisitStatusRow[]; error?: string };
  if (!response.ok) throw clinicalGraphResponseError(response, body, `Diagnosis visit statuses failed: ${response.status}`);
  return body.statuses ?? [];
}

export async function updateDiagnosisVisitStatus(input: {
  encounterId: string;
  conditionId: string;
  status: DiagnosisVisitStatus;
}): Promise<DiagnosisVisitStatusRow> {
  const response = await fetch(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(input.encounterId)}/diagnoses/${encodeURIComponent(input.conditionId)}/status`,
    {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: input.status }),
    },
  );
  const body = await response.json() as { status?: DiagnosisVisitStatusRow; error?: string };
  if (!response.ok) throw clinicalGraphResponseError(response, body, `Diagnosis visit status update failed: ${response.status}`);
  if (!body.status) throw new Error("Diagnosis visit status update returned no status.");
  return body.status;
}
