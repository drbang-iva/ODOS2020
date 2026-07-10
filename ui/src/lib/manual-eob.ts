import type { ClaimsApiOptions } from "./claims-worklist";

export interface ManualEobPosting {
  claimReference: string;
  claimResponseReference: string;
  paymentReconciliationReference: string;
  amountCents: number;
  postedAt: string;
}

export interface ManualEobHeader {
  id: string;
  payerReference: string;
  paymentReference: string;
  paymentDate: string;
  depositDate: string;
  totalAmountCents: number;
  appliedAmountCents: number;
  remainingAmountCents: number;
  status: "draft" | "closed";
  createdAt: string;
  postings: ManualEobPosting[];
}

export interface ManualEobLineInput {
  itemSequence: number;
  allowedCents: number;
  paidCents: number;
  deductibleCents: number;
  coinsuranceCents: number;
  copayCents: number;
}

export async function fetchManualEobs(options: ClaimsApiOptions = {}): Promise<ManualEobHeader[]> {
  const body = await requestJson<{ items?: ManualEobHeader[] }>("/claims/manual-eob", {}, options);
  return body.items ?? [];
}

export async function createManualEob(
  input: {
    payerReference: string;
    paymentReference: string;
    paymentDate: string;
    depositDate: string;
    totalAmountCents: number;
  },
  options: ClaimsApiOptions = {},
): Promise<ManualEobHeader> {
  const body = await requestJson<{ header: ManualEobHeader }>(
    "/claims/manual-eob",
    { method: "POST", body: JSON.stringify(input) },
    options,
  );
  return body.header;
}

export async function postManualEobClaim(
  id: string,
  input: { claimReference: string; lines: ManualEobLineInput[] },
  options: ClaimsApiOptions = {},
): Promise<ManualEobHeader> {
  const body = await requestJson<{ header: ManualEobHeader }>(
    `/claims/manual-eob/${encodeURIComponent(id)}/post`,
    { method: "POST", body: JSON.stringify(input) },
    options,
  );
  return body.header;
}

export async function closeManualEob(
  id: string,
  options: ClaimsApiOptions = {},
): Promise<ManualEobHeader> {
  const body = await requestJson<{ header: ManualEobHeader }>(
    `/claims/manual-eob/${encodeURIComponent(id)}/close`,
    { method: "POST" },
    options,
  );
  return body.header;
}

export function dollarsToCents(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Amount must be a nonnegative dollar value with at most two decimal places.");
  }
  const [dollars, fractional = ""] = normalized.split(".");
  return Number(dollars) * 100 + Number(fractional.padEnd(2, "0"));
}

async function requestJson<T>(path: string, init: RequestInit, options: ClaimsApiOptions): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? "").replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.authorization ? { Authorization: options.authorization } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as { error?: string } : {};
  if (!response.ok) throw new Error(body.error ?? `Manual EOB request failed with HTTP ${response.status}.`);
  return body as T;
}
