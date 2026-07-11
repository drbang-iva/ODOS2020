import { fhir } from "./fhir";

export function authHeaders(): Record<string, string> {
  const authorization = fhir.authHeader();
  return authorization ? { Authorization: authorization } : {};
}

export function clinicalGraphApiBase(): string {
  return import.meta.env.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
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

export async function readDiagnosisCompleteness(encounterId: string): Promise<DiagnosisCompleteness> {
  const response = await fetch(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-completeness`,
    { headers: authHeaders() },
  );
  const body = await response.json() as DiagnosisCompleteness & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Diagnosis completeness failed: ${response.status}`);
  return body;
}

export async function submitDiagnosisPick(input: {
  encounterReference: string;
  diagnosisKey: string;
  action: "possible" | "confirm" | "discard";
  findingInstanceId?: string;
  laterality?: "OD" | "OS" | "OU";
  source?: "rule" | "mapping" | "catalog-search";
}): Promise<void> {
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
    }),
  });
  const body = await response.json() as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Diagnosis pick failed: ${response.status}`);
  window.dispatchEvent(new CustomEvent("osod:diagnosis-picked", { detail: { encounterReference: input.encounterReference } }));
}
