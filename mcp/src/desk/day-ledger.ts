import type { Invoice, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import type { FhirSearchParams, MedplumClient } from "../fhir-client.js";
import {
  OSOD_PAYMENT_TENDER_EXTENSION_URL,
  OSOD_PAYMENT_TENDER_SYSTEM,
  type PaymentTenderCode,
} from "../fhir/osodPaymentTender.js";
import { filterUnappliedCredits } from "../payments/payment-credit-service.js";

const PAGE_LIMIT = "1000";
const LEDGER_PARTICIPANT_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ParticipationType";
const LEDGER_PARTICIPANT_CODE = "ENT";
const TENDERS: readonly PaymentTenderCode[] = ["CASH", "CHECK", "CARD_MANUAL"];

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

export interface DayLedgerPaymentsAvailable {
  available: true;
  tenderTotalsCents: Record<PaymentTenderCode, number>;
  totalCents: number;
  detail: DayLedgerPayment[];
  staffLedgerTotals: StaffLedgerTotal[];
}

export type DayLedgerPayments = DayLedgerPaymentsAvailable | {
  available: false;
  reason: string;
};

export type DayLedgerHeldCredits = {
  available: true;
  count: number;
  totalCents: number;
} | {
  available: false;
  reason: string;
};

export interface DayLedger {
  date: string;
  payments: DayLedgerPayments;
  heldCreditsToday: DayLedgerHeldCredits;
}

export async function loadDayLedger(
  fhir: Pick<MedplumClient, "search">,
  options: { date: string; timeZone?: string },
): Promise<DayLedger> {
  assertDate(options.date);
  const range = practiceDayRange(options.date, options.timeZone);
  const [invoiceRead, creditRead] = await Promise.all([
    searchAvailablePage<Invoice>(fhir, "Invoice", [
      ["date", `ge${range.start}`],
      ["date", `lt${range.end}`],
      ["_count", PAGE_LIMIT],
      ["_sort", "-date"],
    ]),
    searchAvailablePage<PaymentReconciliation>(fhir, "PaymentReconciliation", [
      ["status", "active"],
      ["created", `ge${range.start}`],
      ["created", `lt${range.end}`],
      ["_count", PAGE_LIMIT],
      ["_sort", "-created"],
    ]),
  ]);

  return {
    date: options.date,
    payments: invoiceRead.complete
      ? projectDayLedgerPayments(invoiceRead.resources, options.date, options.timeZone)
      : { available: false, reason: "The day's Invoice results exceed the ledger read limit." },
    heldCreditsToday: creditRead.complete
      ? projectHeldCredits(creditRead.resources, options.date, options.timeZone)
      : { available: false, reason: "The day's held-credit results exceed the ledger read limit." },
  };
}

export function projectDayLedgerPayments(
  invoices: readonly Invoice[],
  date: string,
  timeZone?: string,
): DayLedgerPaymentsAvailable {
  const detail = invoices.flatMap((invoice) => {
    if (!invoice.date || practiceDate(invoice.date, timeZone) !== date) return [];
    const tender = invoiceTender(invoice);
    if (!tender) return [];
    const patientReference = invoice.subject?.reference;
    if (!patientReference) throw new Error(`Invoice/${invoice.id ?? "(unknown)"} has no patient subject.`);
    const staffer = invoice.participant?.find((participant) =>
      participant.role?.coding?.some((coding) =>
        coding.system === LEDGER_PARTICIPANT_SYSTEM && coding.code === LEDGER_PARTICIPANT_CODE,
      ),
    )?.actor.reference;
    if (!staffer) throw new Error(`Invoice/${invoice.id ?? "(unknown)"} has no recording staff participant.`);
    return [{
      time: invoice.date,
      patientReference,
      staffer,
      tender,
      amountCents: moneyCents(invoice.totalNet?.value, `Invoice/${invoice.id ?? "(unknown)"} totalNet`),
    }];
  }).sort((a, b) => b.time.localeCompare(a.time));

  const tenderTotalsCents: Record<PaymentTenderCode, number> = {
    CASH: 0,
    CHECK: 0,
    CARD_MANUAL: 0,
  };
  const staff = new Map<string, StaffLedgerTotal>();
  for (const payment of detail) {
    tenderTotalsCents[payment.tender] += payment.amountCents;
    const current = staff.get(payment.staffer) ?? { staffer: payment.staffer, count: 0, subtotalCents: 0 };
    current.count += 1;
    current.subtotalCents += payment.amountCents;
    staff.set(payment.staffer, current);
  }
  return {
    available: true,
    tenderTotalsCents,
    totalCents: TENDERS.reduce((total, tender) => total + tenderTotalsCents[tender], 0),
    detail,
    staffLedgerTotals: [...staff.values()].sort((a, b) => b.subtotalCents - a.subtotalCents || a.staffer.localeCompare(b.staffer)),
  };
}

export function practiceDate(now: string, timeZone?: string): string {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("Ledger timestamp is invalid.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function practiceDayRange(date: string, timeZone?: string): { start: string; end: string } {
  assertDate(date);
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    start: zonedMidnightIso(year, month, day, timeZone),
    end: zonedMidnightIso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  };
}

function projectHeldCredits(
  payments: PaymentReconciliation[],
  date: string,
  timeZone?: string,
): DayLedgerHeldCredits {
  const today = payments.filter((payment) =>
    payment.created && practiceDate(payment.created, timeZone) === date,
  );
  const credits = filterUnappliedCredits(today);
  return {
    available: true,
    count: credits.length,
    totalCents: credits.reduce((total, credit) => total + credit.unappliedCents, 0),
  };
}

function invoiceTender(invoice: Invoice): PaymentTenderCode | undefined {
  const coding = invoice.extension
    ?.find((extension) => extension.url === OSOD_PAYMENT_TENDER_EXTENSION_URL)
    ?.valueCodeableConcept?.coding
    ?.find((candidate) => candidate.system === OSOD_PAYMENT_TENDER_SYSTEM);
  return TENDERS.includes(coding?.code as PaymentTenderCode) ? coding?.code as PaymentTenderCode : undefined;
}

function moneyCents(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is not a valid nonnegative USD amount.`);
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isInteger(cents) || Math.abs(scaled - cents) > 0.000001) {
    throw new Error(`${label} is not representable in whole cents.`);
  }
  return cents;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Ledger date must use YYYY-MM-DD.");
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new Error("Ledger date must be a real calendar date.");
  }
}

function zonedMidnightIso(year: number, month: number, day: number, timeZone?: string): string {
  if (!timeZone) return new Date(Date.UTC(year, month - 1, day)).toISOString();
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}

async function searchAvailablePage<T extends Resource>(
  fhir: Pick<MedplumClient, "search">,
  resourceType: T["resourceType"],
  params: FhirSearchParams,
): Promise<{ resources: T[]; complete: boolean }> {
  const bundle = await fhir.search<T>(resourceType, params);
  if (bundle.link?.some((link) => link.relation === "next")) {
    return { resources: [], complete: false };
  }
  return {
    resources: (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []),
    complete: true,
  };
}
