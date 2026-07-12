import { fhir } from "./fhir";

export type OfficeTier = "ambient" | "urgent" | "patient-pinned";

export interface OfficeMessage {
  id: string;
  text: string;
  sentAt: string;
  sender: { reference: string; display: string };
  tier: OfficeTier;
  patient?: { reference: string; id: string; display: string };
  acknowledgement?: { by: string; display: string; at: string };
}

export async function fetchClinicOfficeMessages(fetchImpl: typeof fetch = fetch): Promise<OfficeMessage[]> {
  return request("/clinic/office/messages", { method: "GET" }, fetchImpl, isOfficeMessages);
}

export async function fetchDeskOfficeMessages(fetchImpl: typeof fetch = fetch): Promise<OfficeMessage[]> {
  return request("/desk/office/messages", { method: "GET" }, fetchImpl, isOfficeMessages);
}

export async function sendOfficeMessage(input: { text: string; tier: OfficeTier; patientId?: string }, fetchImpl: typeof fetch = fetch): Promise<OfficeMessage> {
  return request("/desk/office/messages", { method: "POST", body: JSON.stringify(input) }, fetchImpl, isOfficeMessage);
}

export async function acknowledgeOfficeMessage(messageId: string, fetchImpl: typeof fetch = fetch): Promise<OfficeMessage> {
  return request(`/clinic/office/messages/${encodeURIComponent(messageId)}/ack`, { method: "POST" }, fetchImpl, isOfficeMessage);
}

async function request<T>(path: string, init: RequestInit, fetchImpl: typeof fetch, validate: (body: unknown) => body is T): Promise<T> {
  const response = await fetchImpl(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
    },
  });
  const body = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Office request failed with HTTP ${response.status}.`);
  if (!validate(body)) throw new Error("Office request returned an invalid response.");
  return body;
}

function isOfficeMessages(body: unknown): body is OfficeMessage[] { return Array.isArray(body) && body.every(isOfficeMessage); }
function isOfficeMessage(body: unknown): body is OfficeMessage {
  return isRecord(body)
    && typeof body.id === "string"
    && typeof body.text === "string"
    && typeof body.sentAt === "string"
    && isRecord(body.sender)
    && typeof body.sender.reference === "string"
    && typeof body.sender.display === "string"
    && (body.tier === "ambient" || body.tier === "urgent" || body.tier === "patient-pinned")
    && (body.acknowledgement === undefined || (isRecord(body.acknowledgement) && typeof body.acknowledgement.by === "string" && typeof body.acknowledgement.display === "string" && typeof body.acknowledgement.at === "string"));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
