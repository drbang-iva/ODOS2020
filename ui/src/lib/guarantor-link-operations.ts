import type { Task } from "@medplum/fhirtypes";
import { fhir, toError } from "./fhir";

export interface GuarantorLinkOperation {
  task: Task;
  active: boolean;
  correctionInProgress?: boolean;
  kind: "attach" | "transfer" | "consolidate" | "correct";
  phase: string;
  sourcePersonId?: string;
  destinationPersonId?: string;
  relatedPersonIds: string[];
  patients: { relatedPersonId: string; patientId: string; name: string }[];
}

async function request(taskId: string, action?: "complete" | "correct", body?: object): Promise<Response> {
  const authorization = fhir.authHeader();
  return fetch(`/guarantors/link-operations/${encodeURIComponent(taskId)}${action ? `/${action}` : ""}`, {
    method: action ? "POST" : "GET",
    headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function readResponse(response: Response): Promise<GuarantorLinkOperation> {
  if (!response.ok) {
    const body = await response.clone().json().catch(() => undefined) as { error?: unknown; task?: unknown } | undefined;
    throw new GuarantorScreenError(typeof body?.error === "string" ? body.error : (await toError(response)).message, response.status, body);
  }
  return response.json() as Promise<GuarantorLinkOperation>;
}

export async function getGuarantorLinkOperation(taskId: string): Promise<GuarantorLinkOperation | undefined> {
  const response = await request(taskId);
  return response.status === 404 ? undefined : readResponse(response);
}

export async function completeGuarantorLinkOperation(taskId: string): Promise<GuarantorLinkOperation> {
  return readResponse(await request(taskId, "complete"));
}

export function newGuarantorOperationId(): string {
  let operationId: string;
  if (typeof crypto.randomUUID === "function") operationId = crypto.randomUUID();
  else {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return operationId;
}

export async function correctGuarantorLinkOperation(taskId: string, reason: string, operationId = newGuarantorOperationId()): Promise<GuarantorLinkOperation> {
  return readResponse(await request(taskId, "correct", { operationId, reason }));
}

export interface GuarantorSearchCard { personId: string; versionId: string; name: string; phones: string[]; city: string; postalCode: string }
export type GuarantorDraftInput = {
  kind: "attach"; destinationPersonId: string; relatedPersonIds: [string];
} | {
  kind: "transfer"; sourcePersonId: string; destinationPersonId: string; relatedPersonIds: [string];
} | {
  kind: "consolidate"; sourcePersonId: string; destinationPersonId: string; relatedPersonIds?: string[];
};
export interface GuarantorDraft { expected: Record<string, string>; relatedPersonIds: string[]; patients: { relatedPersonId: string; patientId: string; name?: import("@medplum/fhirtypes").HumanName[]; current: import("../../../mcp/src/clinic/responsible-party-demographics").ResponsiblePartyDemographics; resulting: import("../../../mcp/src/clinic/responsible-party-demographics").ResponsiblePartyDemographics }[] }
type GuarantorCreateFields = { operationId: string; expected: Record<string, string>; relatedPersonIds: string[]; reason: string };
type GuarantorCreateInput =
  | (Omit<Extract<GuarantorDraftInput, { kind: "attach" }>, "relatedPersonIds"> & GuarantorCreateFields)
  | (Omit<Extract<GuarantorDraftInput, { kind: "transfer" }>, "relatedPersonIds"> & GuarantorCreateFields)
  | (Omit<Extract<GuarantorDraftInput, { kind: "consolidate" }>, "relatedPersonIds"> & GuarantorCreateFields);
export type NewGuarantor = Record<"firstName"|"middleName"|"lastName"|"address"|"city"|"state"|"postalCode",string> & import("../../../mcp/src/clinic/patient-telecom").PhoneDraft;
export class GuarantorScreenError extends Error { constructor(message: string, readonly status: number, readonly body?: { task?: unknown }) { super(message); } }
async function screenRequest<T>(path: string, body?: object): Promise<T> {
  const authorization = fhir.authHeader();
  const response = await fetch(`/guarantors${path}`, { method: body ? "POST" : "GET", headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as { error?: unknown; task?: unknown };
  if (!response.ok) throw new GuarantorScreenError(typeof result.error === "string" ? result.error : "The guarantor result could not be confirmed. Reload before continuing.", response.status, result);
  return result as T;
}
export const searchGuarantors = (keys: { lastName: string; firstName?: string; phone?: string }) => screenRequest<GuarantorSearchCard[]>(`/search?${new URLSearchParams(keys)}`);
export const createNewGuarantor = (body: NewGuarantor) => screenRequest<{personId:string;versionId:string}>("",{ ...body, phones: body.phones.map(({ value, use }) => ({ value, use })) });
export const draftGuarantorOperation = (body: GuarantorDraftInput) => screenRequest<GuarantorDraft>("/link-operations/draft",body);
export const createGuarantorOperation = (body: GuarantorCreateInput) => screenRequest<GuarantorLinkOperation>("/link-operations",body);
export const guarantorOperationHistory = (id: string) => screenRequest<GuarantorLinkOperation[]>(`/link-operations?${new URLSearchParams({relatedPersonId:id})}`);
