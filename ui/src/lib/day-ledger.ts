import { fhir } from "./fhir";

export type PaymentTenderCode = "CASH" | "CHECK" | "CARD_MANUAL";

export interface DayLedgerPayment {
  time: string;
  patientReference: string;
  staffer: string;
  tender: PaymentTenderCode;
  amountCents: number;
}

export interface StaffLedgerTotal {
  staffer: string;
  count: number;
  subtotalCents: number;
}

export type DayLedger = {
  date: string;
  payments: {
    available: true;
    tenderTotalsCents: Record<PaymentTenderCode, number>;
    totalCents: number;
    detail: DayLedgerPayment[];
    staffLedgerTotals: StaffLedgerTotal[];
  } | {
    available: false;
    reason: string;
  };
  heldCreditsToday: {
    available: true;
    count: number;
    totalCents: number;
  } | {
    available: false;
    reason: string;
  };
};

export async function fetchDayLedger(
  date?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DayLedger> {
  const query = date ? `?${new URLSearchParams({ date })}` : "";
  const response = await fetchImpl(`/desk/ledger${query}`, {
    headers: {
      Accept: "application/json",
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
    },
  });
  const body = await response.json() as DayLedger & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Day Ledger failed with HTTP ${response.status}.`);
  return body;
}
