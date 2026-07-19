import { fhir } from "./fhir";

export type MarginLineState = "Estimated" | "Settled" | "Flagged";
export type MarginProductClass = "frame" | "contact" | "other";

export interface MarginDeduction {
  label: string;
  amountCents: number;
}

export interface MarginLine {
  id: string;
  chargeItemReference: string;
  productClass: MarginProductClass;
  item: string;
  vendor: string;
  planKey?: string;
  planName: string;
  saleDate: string;
  wholesaleCents: number;
  retailCents: number;
  taxCents: number;
  patientPaidCents: number;
  estimatedPlanPaidCents?: number;
  planPaidCents?: number;
  deductions: MarginDeduction[];
  estimatedMarginCents: number;
  marginCents?: number;
  multiplierMilli?: number;
  driftCents?: number;
  state: MarginLineState;
  unpricedPlanPortion: boolean;
  collectReceiptReferences: string[];
  claimReference?: string;
  claimResponseReference?: string;
  paymentReconciliationReference?: string;
  linkageTaskReference?: string;
}

export interface MarginLedger {
  period: string;
  genesisDate: "2026-07-15";
  targetMultiplierMilli: number;
  realizedMarginCents: number;
  inFlightCents: number;
  driftCents: number;
  realizedMultiplierMilli?: number;
  settledLineCount: number;
  inFlightLineCount: number;
  lines: MarginLine[];
}

export async function fetchMarginLedger(
  period: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MarginLedger> {
  const response = await fetchImpl(`/practice/margin-ledger?${new URLSearchParams({ period })}`, {
    headers: {
      Accept: "application/json",
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
    },
  });
  const text = await response.text();
  let body: (MarginLedger & { error?: string }) | undefined;
  try {
    body = text ? JSON.parse(text) as MarginLedger & { error?: string } : undefined;
  } catch {
    if (response.ok) throw new Error("Margin ledger returned an invalid response.");
  }
  if (!response.ok) throw new Error(body?.error ?? `Margin ledger failed with HTTP ${response.status}.`);
  if (!body) throw new Error("Margin ledger returned an empty response.");
  return body;
}
