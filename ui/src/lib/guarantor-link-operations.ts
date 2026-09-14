import type { Task } from "@medplum/fhirtypes";
import { fhir, toError } from "./fhir";

export interface GuarantorLinkOperation {
  task: Task;
  active: boolean;
  kind: "transfer" | "consolidate" | "correct";
  phase: string;
  sourcePersonId: string;
  destinationPersonId: string;
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
    const body = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined;
    throw typeof body?.error === "string" ? new Error(body.error) : await toError(response);
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

export async function correctGuarantorLinkOperation(taskId: string, reason: string): Promise<GuarantorLinkOperation> {
  let operationId: string;
  if (typeof crypto.randomUUID === "function") operationId = crypto.randomUUID();
  else {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return readResponse(await request(taskId, "correct", { operationId, reason }));
}
