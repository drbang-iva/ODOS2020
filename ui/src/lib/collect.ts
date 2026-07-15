import { fhir } from "./fhir";
import type { OpticalOrderStatusCode, OpticalOrderTypeCode } from "./optical-order";

export type CollectTender = "CASH" | "CHECK" | "CARD_MANUAL";

export interface OpenChargeLine {
  id: string;
  amountCents: number;
  description: string;
  date: string;
  source: "optical" | "other";
  code?: string;
  quantity?: number;
  feeCents?: number;
  taxCents?: number;
  discount?: { code: string; amountCents: number };
}

export interface OpticalCollectionCharge {
  id: string;
  code: string;
  feeCents: number;
  taxCents?: number;
  quantity?: number;
  discount?: { code: string; amountCents: number };
}

export interface OpticalCollectionOrder {
  patientReference: string;
  visionPrescriptionReference: string;
  encounterReference?: string;
  orderHcpcsCode: string;
  orderHcpcsDisplay?: string;
  businessStatus: OpticalOrderStatusCode;
  orderType: OpticalOrderTypeCode;
  charges: OpticalCollectionCharge[];
}

export interface CompletedCollection {
  deviceRequestId: string;
  taskId: string;
  chargeItemIds: string[];
  invoiceId: string;
  outcome: "success";
  amountChargedCents: number;
  tender: CollectTender;
}

export interface CollectionRequest {
  patientReference: string;
  selectedOpenChargeLineIds: string[];
  amountCents: number;
  opticalOrder?: OpticalCollectionOrder;
}

interface CollectionApiOptions {
  authHeader?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export async function fetchOpenCharges(
  patientReference: string,
  options: CollectionApiOptions = {},
): Promise<OpenChargeLine[]> {
  const response = await authorizedFetch(
    `/payments/patient/${encodeURIComponent(patientReference)}/open-charges`,
    undefined,
    options,
  );
  const body = await readJson(response);
  if (!response.ok) throw new Error(paymentError(response, body));
  if (!Array.isArray(body) || !body.every(isOpenChargeLine)) throw new Error("Open-charges response is invalid.");
  return body;
}

export async function collectRecordedTender(
  request: CollectionRequest & { tender: CollectTender },
  options: CollectionApiOptions = {},
): Promise<CompletedCollection> {
  const response = await authorizedFetch("/payments/collect", request, options);
  const body = await readJson(response);
  if (!response.ok) throw new Error(paymentError(response, body));
  if (!isPreparedCollection(body) || !isPositiveInteger((body as { amountChargedCents?: unknown }).amountChargedCents) ||
      (body as { outcome?: unknown }).outcome !== "success" || !isCollectTender((body as { tender?: unknown }).tender)) {
    throw new Error("Recorded-tender collection response is invalid.");
  }
  return body as CompletedCollection;
}

export function centsFromMoneyInput(input: string): number | undefined {
  const match = input.trim().replace(/^\$/, "").match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) return undefined;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) ? total : undefined;
}

export function moneyInputFromCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

async function authorizedFetch(
  path: string,
  body: unknown | undefined,
  options: CollectionApiOptions,
): Promise<Response> {
  const authorization = (options.authHeader ?? fhir.authHeader)();
  if (!authorization) throw new Error("A signed-in FHIR session is required to collect a payment.");
  return (options.fetchImpl ?? fetch)(path, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: {
      Authorization: authorization,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  });
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

function paymentError(response: Response, body: unknown): string {
  const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : response.statusText;
  return `${response.status} ${message}`.trim();
}

function isOpenChargeLine(value: unknown): value is OpenChargeLine {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Record<string, unknown>;
  return typeof line.id === "string" && isNonnegativeInteger(line.amountCents) &&
    typeof line.description === "string" && typeof line.date === "string" &&
    (line.source === "optical" || line.source === "other") &&
    (line.code === undefined || typeof line.code === "string") &&
    (line.quantity === undefined || (typeof line.quantity === "number" && Number.isFinite(line.quantity) && line.quantity > 0)) &&
    (line.feeCents === undefined || isNonnegativeInteger(line.feeCents)) &&
    (line.taxCents === undefined || isNonnegativeInteger(line.taxCents)) &&
    (line.discount === undefined || isDiscount(line.discount));
}

function isDiscount(value: unknown): value is { code: string; amountCents: number } {
  if (typeof value !== "object" || value === null) return false;
  const discount = value as Record<string, unknown>;
  return typeof discount.code === "string" && isNonnegativeInteger(discount.amountCents);
}

function isPreparedCollection(value: unknown): value is Pick<CompletedCollection, "deviceRequestId" | "taskId" | "invoiceId" | "chargeItemIds"> {
  if (typeof value !== "object" || value === null) return false;
  const prepared = value as Record<string, unknown>;
  return typeof prepared.deviceRequestId === "string" && typeof prepared.taskId === "string" &&
    typeof prepared.invoiceId === "string" && prepared.invoiceId.length > 0 &&
    Array.isArray(prepared.chargeItemIds) && prepared.chargeItemIds.every((id) => typeof id === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCollectTender(value: unknown): value is CollectTender {
  return value === "CASH" || value === "CHECK" || value === "CARD_MANUAL";
}
