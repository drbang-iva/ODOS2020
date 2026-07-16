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
      patientSkim: projectPatientSkim(ledger, charges.resources),
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
  const archive: Array<DaySeal & { totalCents: number | null }> = [];
  for (const seal of seals) {
    const ledger = await loadDayLedger(fhir, { date: seal.date, timeZone });
    archive.push({ ...seal, totalCents: ledger.payments.available ? ledger.payments.totalCents : null });
  }
  return archive;
}

function projectPatientSkim(ledger: DayLedger, charges: ChargeItem[]): PatientDaySkim[] {
  if (!ledger.payments.available) return [];
  const paidTotals = new Map<string, number>();
  for (const payment of ledger.payments.detail) {
    paidTotals.set(payment.patientReference, (paidTotals.get(payment.patientReference) ?? 0) + payment.amountCents);
  }
  const chargeTotals = new Map<string, number>();
  for (const charge of charges) {
    const patientReference = charge.subject.reference ?? "unattributed";
    chargeTotals.set(
      patientReference,
      (chargeTotals.get(patientReference) ?? 0) + moneyCents(
        charge.priceOverride?.value,
        `ChargeItem/${charge.id ?? "(unknown)"} priceOverride`,
      ),
    );
  }
  const patientReferences = new Set([...chargeTotals.keys(), ...paidTotals.keys()]);
  return [...patientReferences].map((patientReference) => ({
    patientReference,
    chargesTotalCents: chargeTotals.get(patientReference) ?? 0,
    paidTotalCents: paidTotals.get(patientReference) ?? 0,
  })).sort((a, b) =>
    b.paidTotalCents - a.paidTotalCents ||
    b.chargesTotalCents - a.chargesTotalCents ||
    a.patientReference.localeCompare(b.patientReference));
}
