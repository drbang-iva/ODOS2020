import { fhir } from "./fhir";
import type { LabOrder } from "./optical-lab-order";

export interface LabOrderSubmission {
  labOrderReference: string;
  transportState: string;
  transmittedVia: string;
  artifact?: { kind: string; content: string };
  submittedAt: string;
}

export interface LabOrderTransportOptions {
  authHeader?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export async function submitLabOrder(
  input: { order: LabOrder; orderTaskReference: string; lab: string },
  options: LabOrderTransportOptions = {},
): Promise<LabOrderSubmission> {
  return requestJson<LabOrderSubmission>("/lab-orders/submit", {
    method: "POST",
    body: JSON.stringify(input),
  }, options);
}

export async function advanceLabOrderTransport(
  labOrderReference: string,
  toState: string,
  note?: string,
  options: LabOrderTransportOptions = {},
): Promise<{ transportState: string }> {
  return requestJson<{ transportState: string }>(`/lab-orders/${encodedReference(labOrderReference)}/advance`, {
    method: "POST",
    body: JSON.stringify({ toState, ...(note ? { note } : {}) }),
  }, options);
}

export async function cancelLabOrder(
  labOrderReference: string,
  options: LabOrderTransportOptions = {},
): Promise<{ transportState: string }> {
  return requestJson<{ transportState: string }>(`/lab-orders/${encodedReference(labOrderReference)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  }, options);
}

export async function fetchLabOrderWorklist(
  state?: string,
  options: LabOrderTransportOptions = {},
): Promise<{ items: unknown[] }> {
  const query = state ? `?state=${encodeURIComponent(state)}` : "";
  return requestJson<{ items: unknown[] }>(`/lab-orders${query}`, { method: "GET" }, options);
}

export async function fetchLabOrderSheet(
  labOrderReference: string,
  options: LabOrderTransportOptions = {},
): Promise<{ kind: string; content: string }> {
  return requestJson<{ kind: string; content: string }>(
    `/lab-orders/${encodedReference(labOrderReference)}/sheet`,
    { method: "GET" },
    options,
  );
}

async function requestJson<T>(path: string, init: RequestInit, options: LabOrderTransportOptions): Promise<T> {
  const authHeader = (options.authHeader ?? fhir.authHeader)();
  if (!authHeader) {
    throw new Error("A signed-in FHIR session is required before managing lab orders.");
  }
  const response = await (options.fetchImpl ?? fetch)(path, {
    ...init,
    headers: {
      Authorization: authHeader,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      Accept: "application/json",
    },
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(labOrderErrorMessage(response, body));
  }
  return body as T;
}

function encodedReference(reference: string): string {
  return encodeURIComponent(reference);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

function labOrderErrorMessage(response: Response, body: unknown): string {
  const message =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : response.statusText;
  return `Lab-order request failed: ${response.status} ${message}`;
}
