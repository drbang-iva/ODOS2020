import { fhir } from "./fhir";
import type { DayLedger } from "./day-ledger";

export interface DaySeal {
  id: string;
  date: string;
  sealedBy: string;
  sealedAt: string;
}

export interface DayCloseData {
  date: string;
  ledger: DayLedger;
  seal?: DaySeal;
  review: {
    available: true;
    unattachedCharges: Array<{
      chargeItemReference: string;
      patientReference: string;
      description: string;
      amountCents: number;
    }>;
    heldCreditsToday: DayLedger["heldCreditsToday"];
    patientSkim: Array<{
      patientReference: string;
      chargesTotalCents: number;
      paidTotalCents: number;
    }>;
  } | {
    available: false;
    reason: string;
    heldCreditsToday: DayLedger["heldCreditsToday"];
  };
}

export interface DaySealArchiveRow extends DaySeal {
  totalCents: number | null;
}

export async function fetchDaySeal(date: string, fetchImpl: typeof fetch = fetch): Promise<DaySeal | null> {
  const body = await request<{ seal: DaySeal | null }>(`/desk/ledger/seal?${new URLSearchParams({ date })}`, {}, fetchImpl);
  return body.seal;
}

export function fetchDayClose(date?: string, fetchImpl: typeof fetch = fetch): Promise<DayCloseData> {
  const query = date ? `?${new URLSearchParams({ date })}` : "";
  return request<DayCloseData>(`/desk/ledger/close${query}`, {}, fetchImpl);
}

export function postDaySeal(date: string, fetchImpl: typeof fetch = fetch): Promise<{ seal: DaySeal; ledger: DayLedger }> {
  return request("/desk/ledger/seal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date }),
  }, fetchImpl);
}

export async function fetchDaySealArchive(fetchImpl: typeof fetch = fetch): Promise<DaySealArchiveRow[]> {
  const body = await request<{ seals: DaySealArchiveRow[] }>("/desk/ledger/archive", {}, fetchImpl);
  return body.seals;
}

async function request<T>(input: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(input, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
      ...init.headers,
    },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Day close failed with HTTP ${response.status}.`);
  return body;
}
