import { fhir } from "./fhir";
import type { LabOrder } from "./optical-lab-order";
import type { FrameInventoryUnitStatus } from "./optical-frames";

export type { FrameInventoryUnitStatus } from "./optical-frames";

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

export const LAB_ORDER_STATUSES = [
  "patients-frame",
  "in-office-not-sent",
  "outbound",
  "at-lab",
  "lenses-on-order",
  "frame-on-order",
  "inbound",
  "received",
  "notified",
  "dispensed",
] as const;

export type LabOrderStatus = (typeof LAB_ORDER_STATUSES)[number];
export type LabOrderNotificationReason = "reached" | "left-message" | "unable";
export type LabOrderProblemReason = "lab-lost" | "lab-breakage-remake" | "cannot-locate" | "other";

export interface LabOrderProblemFlag {
  id: string;
  reason: LabOrderProblemReason;
  note: string;
  flaggedBy: string;
  flaggedAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface LabOrderBoardItem {
  reference: string;
  orderId: string;
  patientId?: string;
  patientName: string;
  lab: string;
  frame: string;
  lenses: string;
  frameSource?: 0 | 1 | 3 | 4;
  frameSourceLabel: string;
  frameOwnership?: "in-house" | "patients-own";
  inventoryUnitId?: string;
  inventoryStatus?: FrameInventoryUnitStatus;
  inventoryStatusLabel?: string;
  status: LabOrderStatus;
  statusLabel: string;
  notificationReason?: LabOrderNotificationReason;
  enteredAt: string;
  ageMinutes: number;
  warningMinutes?: number;
  limitMinutes?: number;
  needsAction: boolean;
  overdue: boolean;
  transportState: string;
  transmissionFact: { kind: "oma" | "manual" | "error" | "none"; label: string };
  problemFlags: LabOrderProblemFlag[];
  openFlag?: LabOrderProblemFlag;
}

export interface LabOrderBoardSummary {
  items: LabOrderBoardItem[];
  counts: Record<LabOrderStatus, number>;
  activeCount: number;
  unprojectableCount: number;
  skippedInventoryUnitCount: number;
  alarms: { flaggedProblems: number; atLabOverdue: number; transmissionFailures: number; receivedNotNotified: number };
  rollups: { preLab: number; outbound: number; atLab: number; inbound: number; notified: number };
  agingConfig: {
    outboundDays: number;
    inboundDays: number;
    atLabDays: number;
    receivedNotifyHours: number;
    notifiedRetryDays: number;
    notifiedFollowUpDays: number;
  };
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

export async function setLabOrderStatus(
  labOrderReference: string,
  status: LabOrderStatus,
  notificationReason?: LabOrderNotificationReason,
  options: LabOrderTransportOptions = {},
): Promise<{ status: LabOrderStatus; enteredAt: string; notificationReason?: LabOrderNotificationReason }> {
  return requestJson(`/lab-orders/${encodedReference(labOrderReference)}/status`, {
    method: "POST",
    body: JSON.stringify({ status, ...(notificationReason ? { notificationReason } : {}) }),
  }, options);
}

export async function flagLabOrderProblem(
  labOrderReference: string,
  reason: LabOrderProblemReason,
  note: string,
  options: LabOrderTransportOptions = {},
): Promise<{ flag: LabOrderProblemFlag }> {
  return requestJson(`/lab-orders/${encodedReference(labOrderReference)}/flags`, {
    method: "POST",
    body: JSON.stringify({ reason, note }),
  }, options);
}

export async function resolveLabOrderProblem(
  labOrderReference: string,
  flagId: string,
  options: LabOrderTransportOptions = {},
): Promise<{ flagId: string; resolvedAt: string }> {
  return requestJson(`/lab-orders/${encodedReference(labOrderReference)}/flags/${encodeURIComponent(flagId)}/resolve`, {
    method: "POST",
    body: JSON.stringify({}),
  }, options);
}

export async function fetchLabOrderWorklist(
  state?: string,
  options: LabOrderTransportOptions = {},
): Promise<LabOrderBoardSummary> {
  const query = state ? `?state=${encodeURIComponent(state)}` : "";
  return requestJson<LabOrderBoardSummary>(`/lab-orders${query}`, { method: "GET" }, options);
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
