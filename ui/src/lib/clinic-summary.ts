import { fhir } from "./fhir";

export type ClinicFlowState = "with-you" | "roomed" | "waiting" | "checked-out" | "scheduled";

export interface ClinicFlowRow {
  appointmentId?: string;
  encounterId?: string;
  patientId?: string;
  time: string;
  patient: string;
  age?: number;
  sex?: "F" | "M" | "X" | "U";
  visitType: string;
  state: ClinicFlowState;
  stateDetail: string;
  room?: string;
  timeInOfficeMinutes?: number;
  waitingMinutes?: number;
  arrivedLateMinutes?: number;
  flags: { unsigned: boolean };
}

export interface ClinicSignatureRow {
  encounterId: string;
  patientId?: string;
  patient: string;
  visitType: string;
  checkoutAt: string;
  ageMinutes: number;
  olderThan24Hours: boolean;
}

export interface ClinicSummary {
  flow: ClinicFlowRow[];
  signatures: { count: number; olderThan24Hours: number; rows: ClinicSignatureRow[] };
  erx: { available: false; message: string };
  review: { available: false; message: string };
}

export async function fetchClinicSummary(fetchImpl: typeof fetch = fetch): Promise<ClinicSummary> {
  const response = await fetchImpl("/clinic/summary", {
    headers: {
      Accept: "application/json",
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
    },
  });
  const body = await response.json() as ClinicSummary & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Clinic summary failed with HTTP ${response.status}.`);
  return body;
}
