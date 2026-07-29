import type { Encounter, Patient } from "@medplum/fhirtypes";
import { fhir } from "./fhir";

export type VisitLedgerFilter = "all" | "eye-exams" | "office-visits";
export const MIGRATION_TAG_SYSTEM = "https://odos2020.com/tags/migration";
export const MIGRATION_TAG_CODE = "eyefinity-import";

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
    status: "Preliminary" | "Final" | "Migrated";
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
    isPatientOverviewPayload,
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
    isStickyNote,
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
    isStickyNoteHistory,
  );
}

async function request<T>(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  isExpected: (body: unknown) => body is T,
): Promise<T> {
  const response = await fetchImpl(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
    },
  });
  const body = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    throw new Error(error ?? `Patient overview request failed with HTTP ${response.status}.`);
  }
  if (!isExpected(body)) throw new Error("Patient overview request returned an invalid response.");
  return body;
}

function isPatientOverviewPayload(body: unknown): body is PatientOverviewPayload {
  return isRecord(body) &&
    isRecord(body.patient) &&
    Array.isArray(body.insurance) &&
    isRecord(body.snapshot) &&
    Array.isArray(body.visits) &&
    body.visits.every((visit) => isRecord(visit) && Array.isArray(visit.diagnoses)) &&
    Array.isArray(body.diagnosisChoices);
}

function isStickyNote(body: unknown): body is NonNullable<PatientOverviewPayload["stickyNote"]> {
  return isRecord(body) && typeof body.id === "string" && typeof body.text === "string";
}

function isStickyNoteHistory(body: unknown): body is StickyNoteHistoryEntry[] {
  return Array.isArray(body) && body.every((entry) =>
    isRecord(entry) && typeof entry.versionId === "string" && typeof entry.text === "string",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMigratedEncounter(encounter: Encounter | null | undefined): boolean {
  return encounter?.meta?.tag?.some((tag) =>
    tag.system === MIGRATION_TAG_SYSTEM && tag.code === MIGRATION_TAG_CODE
  ) === true;
}
