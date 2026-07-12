import type { Patient } from "@medplum/fhirtypes";
import { fhir } from "./fhir";

export type VisitLedgerFilter = "all" | "eye-exams" | "office-visits";

export interface PatientOverviewDiagnosis {
  conditionId: string;
  encounterId: string;
  name: string;
  code?: string;
  system?: string;
  laterality?: string;
}

export interface PatientOverviewMedication {
  id?: string;
  name: string;
  sig?: string;
}

export interface PatientOverviewPayload {
  patient: Patient;
  insurance: string[];
  unavailable?: { insurance?: string; medicationOrders?: string };
  stickyNote?: { id: string; text: string; editedAt?: string; editedBy?: string };
  snapshot: {
    ocularHistory: Array<{ id?: string; name: string; laterality?: string }>;
    ocularSurgicalHistory: Array<{ id?: string; name: string; date?: string }>;
    medicalConditions: Array<{ id?: string; name: string }>;
    socialHistory: string[];
    ophthalmicMedications: PatientOverviewMedication[];
    systemicMedications: PatientOverviewMedication[];
  };
  visits: Array<{
    encounterId: string;
    date?: string;
    provider?: string;
    facility?: string;
    visitType: string;
    status: "Preliminary" | "Final";
    diagnoses: PatientOverviewDiagnosis[];
  }>;
  diagnosisChoices: Array<{ name: string; code: string; system: string }>;
}

export interface StickyNoteHistoryEntry {
  versionId: string;
  text: string;
  editedAt?: string;
  editedBy?: string;
}

export async function fetchPatientOverview(
  patientId: string,
  options: { filter?: VisitLedgerFilter; diagnosisSystem?: string; diagnosisCode?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<PatientOverviewPayload> {
  const query = new URLSearchParams({ filter: options.filter ?? "all" });
  if (options.diagnosisSystem && options.diagnosisCode) {
    query.set("diagnosisSystem", options.diagnosisSystem);
    query.set("diagnosisCode", options.diagnosisCode);
  }
  return request<PatientOverviewPayload>(
    `/clinic/patients/${encodeURIComponent(patientId)}/overview?${query}`,
    { method: "GET" },
    fetchImpl,
  );
}

export async function saveStickyNote(
  patientId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NonNullable<PatientOverviewPayload["stickyNote"]>> {
  return request(
    `/clinic/patients/${encodeURIComponent(patientId)}/sticky-note`,
    { method: "POST", body: JSON.stringify({ text }) },
    fetchImpl,
  );
}

export async function fetchStickyNoteHistory(
  patientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StickyNoteHistoryEntry[]> {
  return request(
    `/clinic/patients/${encodeURIComponent(patientId)}/sticky-note/history`,
    { method: "GET" },
    fetchImpl,
  );
}

async function request<T>(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Patient overview request failed with HTTP ${response.status}.`);
  return body;
}
