import { fhir } from "./fhir";

export type DeskTone = "ok" | "warn" | "alert" | "info" | "off";
export interface DeskStat<T = number | string | null> { value: T; tone: DeskTone; unavailableReason?: string }
export interface DeskSummary {
  cards: {
    schedule: { today: DeskStat<number>; confirmed: DeskStat<number>; checkedIn: DeskStat<number>; webRequests: DeskStat<number>; agenda: Array<{ time: string; patient: string; visitType: string }> };
    attention: { items: Array<{ tone: "alert" | "warn" | "info"; label: string; detail: string; href?: string }> };
    frontLine: { available: false; message: string; needsReply: DeskStat<null>; missedCalls: DeskStat<null>; voicemails: DeskStat<null>; urgent: DeskStat<null>; messages: [] };
    pendingRx: { spectacle: DeskStat<number>; contactLens: DeskStat<null>; labOrdersUnsent: DeskStat<null>; oldestWaiting: DeskStat<number | null> };
    productPickup: { openOrders: DeskStat<number>; atLab: DeskStat<number>; readyNotNotified: DeskStat<null>; awaitingPickup: DeskStat<number> };
    claims: { failed: DeskStat<number>; inProcess: DeskStat<number>; paperQueue: DeskStat<null>; heldCents: DeskStat<number>; lastTransmission: DeskStat<string | null> };
    payments: { unappliedCount: DeskStat<number>; unappliedCents: DeskStat<number>; patientCreditsOpen: DeskStat<number>; patientOpenBalanceCents: DeskStat<number>; terminalMode: DeskStat<string> };
    remits: { waitingToPost: DeskStat<number>; unpostedCents: DeskStat<number> };
    statements: { available: true; cadence: DeskStat<string>; invalidRejects: DeskStat<number>; lastStatement: DeskStat<string | null> };
  };
  pulse: { itemsNeedingYou: number; everythingElseAtTarget: boolean; lastClaimTransmission: string | null; lastClaimTransmissionTone: DeskTone };
}

export async function fetchDeskSummary(fetchImpl: typeof fetch = fetch): Promise<DeskSummary> {
  const response = await fetchImpl("/desk/summary", {
    headers: {
      Accept: "application/json",
      ...(fhir.authHeader() ? { Authorization: fhir.authHeader()! } : {}),
    },
  });
  const body = await response.json() as DeskSummary & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Desk summary failed with HTTP ${response.status}.`);
  return body;
}
