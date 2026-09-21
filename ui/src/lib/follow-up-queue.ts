import { authHeaders, clinicalGraphApiBase, clinicalGraphResponseError } from "./clinical-graph-client";

export interface FollowUpQueueRow {
  orderable: string;
  focus?: string;
  label: string;
  sources: string[];
  state: "for-review" | "already-ordered" | "unavailable" | "not-today";
  decidedBy?: string;
  decidedAt?: string;
  actionIds?: string[];
  reason?: string;
  charge?: FollowUpCharge;
}
export type FollowUpCharge =
  | { status: "billed"; proposalId: string; dxPointer?: string; dxDisplay?: string }
  | { status: "removed"; proposalId: string; removedBy: string }
  | { status: "none" | "uncoded" | "protocol-pending" | "charged-elsewhere" | "finalized" };
export interface FollowUpDiagnosis { reference: string; display: string; rank?: number; matches: boolean }
export type FollowUpQueueResult = { recorded: false } | { recorded: true; rows: FollowUpQueueRow[]; canDecide: boolean; canAccept?: boolean; diagnoses?: FollowUpDiagnosis[] };

export async function loadFollowUpQueue(encounterId: string, signal?: AbortSignal): Promise<FollowUpQueueResult> {
  const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/follow-up-queue`, { headers: authHeaders(), signal });
  if (!response.ok) throw new Error("Follow-up queue unavailable.");
  return parseQueue(await response.json());
}

export async function decideFollowUpTest(encounterId: string, command: { orderable: string; focus?: string; decision: "not-today" | "put-back" }): Promise<FollowUpQueueResult> {
  const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/follow-up-queue/decisions`, {
    method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(command),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw clinicalGraphResponseError(response, body ?? {}, "The decision could not be saved.");
  return parseQueue(body);
}

export async function acceptFollowUpTest(encounterId: string, command: { orderable: string; focus?: string }): Promise<FollowUpQueueResult> {
  const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/follow-up-queue/accept`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(command),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw clinicalGraphResponseError(response, body ?? {}, "The test could not be accepted.");
  return parseQueue(body);
}

function parseQueue(input: unknown): FollowUpQueueResult {
  const value = input as Partial<FollowUpQueueResult> | null;
  if (value?.recorded === false) return { recorded: false };
  if (value?.recorded !== true || !Array.isArray(value.rows) || !value.rows.every(validRow) ||
    (value.canDecide !== undefined && typeof value.canDecide !== "boolean") ||
    (value.canAccept !== undefined && typeof value.canAccept !== "boolean") ||
    (value.diagnoses !== undefined && (!Array.isArray(value.diagnoses) || !value.diagnoses.every(validDiagnosis)))) throw new Error("Invalid follow-up queue.");
  return { recorded: true, rows: value.rows, canDecide: value.canDecide ?? false,
    ...(value.canAccept === undefined ? {} : { canAccept: value.canAccept }),
    ...(value.diagnoses === undefined ? {} : { diagnoses: value.diagnoses }) };
}

function validDiagnosis(value: unknown): value is FollowUpDiagnosis {
  if (!value || typeof value !== "object") return false;
  const diagnosis = value as Partial<FollowUpDiagnosis>;
  return typeof diagnosis.reference === "string" && /^Condition\/[A-Za-z0-9.-]+$/.test(diagnosis.reference) &&
    typeof diagnosis.display === "string" && typeof diagnosis.matches === "boolean" &&
    (diagnosis.rank === undefined || Number.isInteger(diagnosis.rank));
}

function validCharge(value: unknown): value is FollowUpCharge {
  if (!value || typeof value !== "object") return false;
  const charge = value as Partial<FollowUpCharge>;
  if (charge.status === "billed") return typeof charge.proposalId === "string" &&
    (charge.dxPointer === undefined || /^Condition\/[A-Za-z0-9.-]+$/.test(charge.dxPointer)) &&
    (charge.dxDisplay === undefined || typeof charge.dxDisplay === "string");
  if (charge.status === "removed") return typeof charge.proposalId === "string" && typeof charge.removedBy === "string";
  return ["none", "uncoded", "protocol-pending", "charged-elsewhere", "finalized"].includes(charge.status ?? "");
}

function validRow(value: unknown): value is FollowUpQueueRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<FollowUpQueueRow>;
  return typeof row.orderable === "string" && typeof row.label === "string" &&
    (row.focus === undefined || typeof row.focus === "string") &&
    Array.isArray(row.sources) && row.sources.every(source => typeof source === "string") &&
    (row.charge === undefined || validCharge(row.charge)) &&
    (row.state === "for-review" || (row.state === "not-today" && typeof row.decidedBy === "string" && typeof row.decidedAt === "string") || (row.state === "unavailable" && typeof row.reason === "string") ||
      (row.state === "already-ordered" && Array.isArray(row.actionIds) && row.actionIds.length > 0 && row.actionIds.every(id => typeof id === "string")));
}
