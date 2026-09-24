// Response types for the Open Charts projection, kept import-free so the UI can import them as types
// without pulling the mcp clinical-graph modules into its program.
export type Owner = { reference: string; name: string } | { unassigned: true };
export type Reason = { code: "needs-interpretation" | "unclassified-fee" | "duplicate-fee" | "no-interpreted-result" | "none-found" | "nothing-charted" | "signature-missing" | "checks-unavailable"; label?: string };
export interface DoctorRow {
  encounterId: string;
  patient: { reference: string; name: string };
  visitType?: string;
  serviceStart: string;
  serviceDate: string;
  liveState?: "waiting" | "roomed" | "with you" | "checked out";
  owner: Owner;
  kind: "open" | "nothing-charted" | "signature-missing";
  reasons: Reason[];
}
export interface ReviewRow { encounterId: string; patient: { reference: string; name: string }; serviceStart?: string; owner: Owner; reason: string }
export interface DeskRow { patient: { reference: string; name: string }; owner: Owner; serviceStart: string; serviceDate: string; status: "chart open"; priorDay: boolean }
export type OwnerCount = { owner: Owner; count: number; oldestServiceDate: string };
export interface Completeness { complete: boolean; incomplete?: string[] }
export interface Doctor extends Completeness {
  timeZone: string; timeZoneSource: "setting" | "environment"; caller: { practitioner?: string };
  today: { date: string; rows: DoctorRow[] };
  lastClinicDay: { date: string; rows: DoctorRow[] } | null;
  older: { count: number; oldestServiceDate?: string; byOwner: OwnerCount[]; rows?: DoctorRow[] };
  needsReview: ReviewRow[];
  counts: { open: number; nothingCharted: number; signatureMissing: number; needsReview: number };
  warnings?: string[];
}
export interface Desk extends Completeness {
  timeZone: string; timeZoneSource: "setting" | "environment";
  today: { date: string; count: number; rows: DeskRow[] };
  lastClinicDay: { date: string; count: number; rows: DeskRow[] } | null;
  older: { count: number; byOwner: OwnerCount[] };
}
