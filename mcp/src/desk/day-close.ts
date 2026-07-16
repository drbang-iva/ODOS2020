import type { ChargeItem, Invoice } from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import {
  loadDayLedger,
  moneyCents,
  practiceDayRange,
  searchAvailablePage,
  type DayLedger,
} from "./day-ledger.js";
import { createDaySeal, listDaySeals, loadDaySeal, type DaySeal } from "./day-seal.js";

export interface UnattachedCharge {
  chargeItemReference: string;
  patientReference: string;
  description: string;
  amountCents: number;
}

export interface PatientDaySkim {
  patientReference: string;
  chargesTotalCents: number;
  paidTotalCents: number;
}

export interface DayCloseReview {
  available: true;
  unattachedCharges: UnattachedCharge[];
  heldCreditsToday: DayLedger["heldCreditsToday"];
  patientSkim: PatientDaySkim[];
}

export interface DayCloseData {
  date: string;
  ledger: DayLedger;
  seal?: DaySeal;
  review: DayCloseReview | { available: false; reason: string; heldCreditsToday: DayLedger["heldCreditsToday"] };
}

type DayCloseFhir = Pick<MedplumClient, "search" | "create">;

export async function loadDayClose(
  fhir: Pick<MedplumClient, "search">,
  options: { date: string; timeZone?: string },
): Promise<DayCloseData> {
  const range = practiceDayRange(options.date, options.timeZone);
  const [ledger, seal, charges, invoices] = await Promise.all([
    loadDayLedger(fhir, options),
    loadDaySeal(fhir, options.date),
    searchAvailablePage<ChargeItem>(fhir, "ChargeItem", [
      ["status", "billable"],
      ["occurrence", `ge${range.start}`],
      ["occurrence", `lt${range.end}`],
      ["_count", "1000"],
      ["_sort", "occurrence"],
    ]),
    searchAvailablePage<Invoice>(fhir, "Invoice", [
      ["date", `ge${range.start}`],
      ["date", `lt${range.end}`],
      ["_count", "1000"],
    ]),
  ]);
  const patientSkim = ledger.payments.available ? projectPatientSkim(ledger) : [];
  if (!charges.complete || !invoices.complete) {
    return {
      date: options.date,
      ledger,
      ...(seal ? { seal } : {}),
      review: {
        available: false,
        reason: "The day review exceeds the guarded FHIR read limit.",
        heldCreditsToday: ledger.heldCreditsToday,
      },
    };
  }
  const attached = new Set(invoices.resources.flatMap((invoice) =>
    (invoice.lineItem ?? []).flatMap((line) => line.chargeItemReference?.reference ?? []),
  ));
  return {
    date: options.date,
    ledger,
    ...(seal ? { seal } : {}),
    review: {
      available: true,
      unattachedCharges: charges.resources.flatMap((charge) => {
        if (!charge.id || attached.has(`ChargeItem/${charge.id}`)) return [];
        return [{
          chargeItemReference: `ChargeItem/${charge.id}`,
          patientReference: charge.subject.reference ?? "unattributed",
          description: charge.code?.text ?? charge.code?.coding?.[0]?.display ?? "Unlabeled charge",
          amountCents: moneyCents(charge.priceOverride?.value, `ChargeItem/${charge.id} priceOverride`),
        }];
      }),
      heldCreditsToday: ledger.heldCreditsToday,
      patientSkim,
    },
  };
}

export async function sealDay(
  fhir: DayCloseFhir,
  input: { date: string; staffReference: string; sealedAt: string; timeZone?: string },
): Promise<{ seal: DaySeal; ledger: DayLedger }> {
  const ledger = await loadDayLedger(fhir, { date: input.date, timeZone: input.timeZone });
  if (!ledger.payments.available || !ledger.heldCreditsToday.available) {
    throw new Error("The day cannot be sealed while its financial totals are unavailable.");
  }
  const seal = await createDaySeal(fhir, input);
  return { seal, ledger };
}

export async function loadDaySealArchive(
  fhir: Pick<MedplumClient, "search">,
  timeZone?: string,
): Promise<Array<DaySeal & { totalCents: number | null }>> {
  const seals = await listDaySeals(fhir);
  return Promise.all(seals.map(async (seal) => {
    const ledger = await loadDayLedger(fhir, { date: seal.date, timeZone });
    return { ...seal, totalCents: ledger.payments.available ? ledger.payments.totalCents : null };
  }));
}

function projectPatientSkim(ledger: DayLedger): PatientDaySkim[] {
  if (!ledger.payments.available) return [];
  const totals = new Map<string, number>();
  for (const payment of ledger.payments.detail) {
    totals.set(payment.patientReference, (totals.get(payment.patientReference) ?? 0) + payment.amountCents);
  }
  return [...totals.entries()].map(([patientReference, paidTotalCents]) => ({
    patientReference,
    chargesTotalCents: paidTotalCents,
    paidTotalCents,
  })).sort((a, b) => b.paidTotalCents - a.paidTotalCents || a.patientReference.localeCompare(b.patientReference));
}
