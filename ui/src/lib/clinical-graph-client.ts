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

const PROVIDER_ASSIGNMENT_TIMEOUT_MS = 15_000;

export async function assignProviderForAppointment(
  appointmentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_ASSIGNMENT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${clinicalGraphApiBase()}/clinical-graph/appointments/${encodeURIComponent(appointmentId)}/assign-provider`,
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ClinicalGraphErrorBody;
      throw new Error(body.error ?? `Provider assignment failed (${response.status}).`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export interface VisitChargeOption {
  procedureConceptKey: string;
  display: string;
  billingCode?: string;
}

export type VisitProcedureFamily = "eye-code" | "em" | "vision-plan";

export interface VisitChargeDiagnosis {
  reference: string;
  display: string;
  rank?: number;
}

export interface VisitChargeProposal {
  id: string;
  procedureConceptKey: string;
  dxPointers: string[];
  state: "accepted" | "removed" | "finalized";
}

export interface VisitChargeResponse {
  options: VisitChargeOption[];
  diagnoses: VisitChargeDiagnosis[];
  selectedProcedureConceptKey?: string;
  procedureFamily?: VisitProcedureFamily;
  proposal?: VisitChargeProposal;
}

export interface VisitChargeChange {
  procedureConceptKey?: string | null;
  dxPointer?: string | null;
}

export interface VisitChargeApi {
  read(encounterId: string): Promise<VisitChargeResponse>;
  save(encounterId: string, change: VisitChargeChange): Promise<Partial<VisitChargeResponse>>;
}

export function visitChargeApi(fetchImpl: typeof fetch = fetch): VisitChargeApi {
  const endpoint = (encounterId: string) =>
    `${clinicalGraphApiBase()}/clinical-graph/protocols/encounters/${encodeURIComponent(encounterId)}/visit-charge`;
  return {
    async read(encounterId) {
      const response = await fetchImpl(endpoint(encounterId), { headers: authHeaders() });
      const body = await response.json() as VisitChargeResponse & ClinicalGraphErrorBody;
      if (!response.ok) throw clinicalGraphResponseError(response, body, `Visit charge failed: ${response.status}`);
      return body;
    },
    async save(encounterId, change) {
      const response = await fetchImpl(endpoint(encounterId), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body = await response.json() as Partial<VisitChargeResponse> & ClinicalGraphErrorBody;
      if (!response.ok) throw clinicalGraphResponseError(response, body, `Visit charge update failed: ${response.status}`);
      return body;
    },
  };
}

export interface ProcedureChargeOption {
  procedureConceptKey: string;
  display: string;
  billingCode: string;
}

export interface ProcedureChargeDiagnosis {
  reference: string;
  display: string;
  rank?: number;
}

export interface ManualProcedureCharge {
  id: string;
  procedureConceptKey: string;
  laterality?: "OD" | "OS" | "OU";
  dxPointers: string[];
  state: "accepted" | "removed" | "finalized";
}

export interface ProcedureChargesResponse {
  options: ProcedureChargeOption[];
  diagnoses: ProcedureChargeDiagnosis[];
  proposals: ManualProcedureCharge[];
  attachedProcedures: AttachedProcedure[];
}

export interface AttachedProcedure {
  proposalId: string;
  procedureConceptKey: string;
  display: string;
  diagnosisReferences: string[];
}

export interface ProcedureChargeChange {
  laterality?: "OD" | "OS" | "OU" | null;
  dxPointer?: string | null;
  state?: "accepted" | "removed";
}

export interface ProcedureChargeApi {
  read(encounterId: string): Promise<ProcedureChargesResponse>;
  create(encounterId: string, procedureConceptKey: string): Promise<{ proposal: ManualProcedureCharge }>;
  patch(
    encounterId: string,
    proposalId: string,
    change: ProcedureChargeChange,
  ): Promise<{ proposal: ManualProcedureCharge }>;
}

export function procedureChargeApi(fetchImpl: typeof fetch = fetch): ProcedureChargeApi {
  const collection = (encounterId: string) =>
    `${clinicalGraphApiBase()}/clinical-graph/protocols/encounters/${encodeURIComponent(encounterId)}/procedure-charges`;
  return {
    async read(encounterId) {
      const response = await fetchImpl(collection(encounterId), { headers: authHeaders() });
      const body = await response.json() as ProcedureChargesResponse & ClinicalGraphErrorBody;
      if (!response.ok) {
        throw clinicalGraphResponseError(response, body, `Procedure charges failed: ${response.status}`);
      }
      return body;
    },
    async create(encounterId, procedureConceptKey) {
      const response = await fetchImpl(collection(encounterId), {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ procedureConceptKey }),
      });
      const body = await response.json() as { proposal: ManualProcedureCharge } & ClinicalGraphErrorBody;
      if (!response.ok) {
        throw clinicalGraphResponseError(response, body, `Procedure charge add failed: ${response.status}`);
      }
      return body;
    },
    async patch(encounterId, proposalId, change) {
      const response = await fetchImpl(`${collection(encounterId)}/${encodeURIComponent(proposalId)}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body = await response.json() as { proposal: ManualProcedureCharge } & ClinicalGraphErrorBody;
      if (!response.ok) {
        throw clinicalGraphResponseError(response, body, `Procedure charge update failed: ${response.status}`);
      }
      return body;
    },
  };
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

export async function updateDiagnosisOrder(
  encounterId: string,
  conditionReferences: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Encounter> {
  const response = await fetchImpl(
    `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/diagnosis-order`,
    {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ conditionReferences }),
    },
  );
  const body = await response.json() as { encounter?: Encounter; error?: string; code?: string };
  if (!response.ok) {
    throw clinicalGraphResponseError(response, body, `Diagnosis reorder failed: ${response.status}`);
  }
  if (!body.encounter) throw new Error("Diagnosis reorder response did not include the Encounter.");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("odos:encounter-diagnosis-updated", {
      detail: { encounterReference: `Encounter/${encounterId}` },
    }));
  }
  return body.encounter;
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
