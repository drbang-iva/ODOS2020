import type { Appointment, Invoice, Patient, PaymentReconciliation } from "@medplum/fhirtypes";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../fhir/odosPaymentTender.js";
import { collectAllPages, type PaginatedFhir } from "./fhir-pagination.js";
import type { WatcherMatch, WatcherPracticeSettings } from "./watcher-types.js";

const INACTIVE_APPOINTMENT_STATUSES = new Set(["cancelled", "noshow", "entered-in-error"]);
const PATIENT_BATCH_SIZE = 100;

export interface W1EvaluationInput {
  fhir: PaginatedFhir;
  date: string;
  now: string;
  timeZone?: string;
  settings: WatcherPracticeSettings;
}

export async function evaluateW1(input: W1EvaluationInput): Promise<WatcherMatch[]> {
  if (!input.settings.enabled) return [];
  const minimumBalanceCents = input.settings.minimumBalanceCents;
  if (!Number.isInteger(minimumBalanceCents) || Number(minimumBalanceCents) < 1) {
    throw new Error("W1 minimumBalanceCents must be a positive integer.");
  }

  const appointments = (await collectAllPages<Appointment>(
    input.fhir,
    "Appointment",
    { date: input.date, _count: "1000", _sort: "date" },
    "W1 appointments",
  )).filter(isActionableAppointment);

  const patientIds = new Set(
    appointments.map(patientReference).filter((reference): reference is string => Boolean(reference)),
  );
  if (patientIds.size === 0) return [];

  const patients: Patient[] = [];
  const patientReferences = [...patientIds];
  for (let index = 0; index < patientReferences.length; index += PATIENT_BATCH_SIZE) {
    const batch = patientReferences.slice(index, index + PATIENT_BATCH_SIZE);
    patients.push(...await collectAllPages<Patient>(
      input.fhir,
      "Patient",
      { _id: batch.map(referenceId).join(","), _count: "1000" },
      `W1 patients batch ${Math.floor(index / PATIENT_BATCH_SIZE) + 1}`,
    ));
  }
  const patientByReference = new Map(
    patients.filter((patient) => patient.id).map((patient) => [`Patient/${patient.id}`, patient]),
  );

  const invoices = await collectAllPages<Invoice>(
    input.fhir,
    "Invoice",
    { status: "issued", _count: "1000", _sort: "date" },
    "W1 invoices",
  );
  const payments = await collectAllPages<PaymentReconciliation>(
    input.fhir,
    "PaymentReconciliation",
    { status: "active", _count: "1000" },
    "W1 payment allocations",
  );
  const balances = aggregateBalances(invoices, patientIds, allocatedCentsByInvoice(payments));

  const matches: WatcherMatch[] = [];
  for (const appointment of appointments) {
    const patientRef = patientReference(appointment);
    if (!patientRef || !appointment.id || !appointment.start) continue;
    const balance = balances.get(patientRef);
    if (!balance || balance.totalCents < Number(minimumBalanceCents)) continue;

    const patient = patientByReference.get(patientRef);
    const display = patientDisplay(patient, appointment, patientRef);
    const month = formatMonth(balance.oldestAt, input.timeZone);
    const time = formatTime(appointment.start, input.timeZone);
    const money = formatMoney(balance.totalCents);
    const possessive = patient?.gender === "female" ? "her" : patient?.gender === "male" ? "his" : "their";
    const subject = patient?.gender === "female" ? "She's" : patient?.gender === "male" ? "He's" : "They're";
    const source = balance.count === 1
      ? `${money} from ${possessive} last visit`
      : `${money} across ${balance.count} visits`;

    matches.push({
      watcherId: "W1",
      conditionKey: `W1:Appointment/${appointment.id}`,
      patientReference: patientRef,
      patientDisplay: display,
      appointmentReference: `Appointment/${appointment.id}`,
      appointmentAt: appointment.start,
      frontDeskMessage: `${display} has a balance from ${month}. ${subject} on today's schedule at ${time} — ${source}.`,
      ownerMessage: `${display} is on today's schedule at ${time} with a ${money} balance from ${month}.`,
      balanceCents: balance.totalCents,
      ageDays: elapsedDays(balance.oldestAt, input.now),
      sourceOccurredAt: balance.oldestAt,
      sourceInvoiceCount: balance.count,
    });
  }
  return matches;
}

function isActionableAppointment(appointment: Appointment): boolean {
  return Boolean(
    appointment.id
      && appointment.start
      && !INACTIVE_APPOINTMENT_STATUSES.has(appointment.status)
      && patientReference(appointment),
  );
}

function patientReference(appointment: Appointment): string | undefined {
  return appointment.participant
    .map((participant) => participant.actor?.reference)
    .find((reference) => reference?.startsWith("Patient/"));
}

function referenceId(reference: string): string {
  return reference.slice(reference.indexOf("/") + 1);
}

function aggregateBalances(
  invoices: Invoice[],
  patientIds: Set<string>,
  allocatedCents: ReadonlyMap<string, number>,
) {
  const result = new Map<string, { totalCents: number; count: number; oldestAt: string }>();
  for (const invoice of invoices) {
    const patientRef = invoice.subject?.reference;
    if (!patientRef || !patientIds.has(patientRef)) continue;
    const amount = invoice.totalNet;
    if (
      !amount
      || typeof amount.value !== "number"
      || !Number.isFinite(amount.value)
      || amount.value < 0
      || (amount.currency && amount.currency !== "USD")
    ) {
      throw new Error(
        `Invoice/${invoice.id ?? "unknown"} has no computable USD totalNet; W1 cannot publish a complete balance watch.`,
      );
    }
    const occurredAt = invoice.date ?? invoice.meta?.lastUpdated;
    if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
      throw new Error(
        `Invoice/${invoice.id ?? "unknown"} has no usable date; W1 cannot publish a complete balance watch.`,
      );
    }
    if (!invoice.id) {
      throw new Error("Issued Invoice has no id; W1 cannot reconcile its payment allocations.");
    }
    const tendered = invoice.extension?.some(
      (extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL,
    ) ?? false;
    const cents = tendered
      ? 0
      : Math.max(0, Math.round(amount.value * 100) - (allocatedCents.get(`Invoice/${invoice.id}`) ?? 0));
    if (cents === 0) continue;
    const current = result.get(patientRef);
    result.set(patientRef, {
      totalCents: (current?.totalCents ?? 0) + cents,
      count: (current?.count ?? 0) + 1,
      oldestAt: !current || occurredAt < current.oldestAt ? occurredAt : current.oldestAt,
    });
  }
  return result;
}

function allocatedCentsByInvoice(payments: PaymentReconciliation[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const payment of payments) {
    if (payment.status !== "active" || payment.outcome !== "complete") continue;
    for (const detail of payment.detail ?? []) {
      const reference = detail.request?.reference;
      if (!/^Invoice\/[A-Za-z0-9.-]+$/.test(reference ?? "")) continue;
      const amount = detail.amount;
      if (
        !amount
        || typeof amount.value !== "number"
        || !Number.isFinite(amount.value)
        || amount.value < 0
        || (amount.currency && amount.currency !== "USD")
      ) {
        throw new Error(
          `PaymentReconciliation/${payment.id ?? "unknown"} has an invalid Invoice allocation; W1 cannot publish a complete balance watch.`,
        );
      }
      const cents = Math.round(amount.value * 100);
      result.set(reference!, (result.get(reference!) ?? 0) + cents);
    }
  }
  return result;
}

function patientDisplay(patient: Patient | undefined, appointment: Appointment, reference: string): string {
  const name = patient?.name?.find((candidate) => candidate.family || candidate.given?.length);
  const given = name?.given?.[0]?.trim();
  const family = name?.family?.trim();
  if (given && family) return `${given} ${family[0]}.`;
  const appointmentDisplay = appointment.participant
    .find((participant) => participant.actor?.reference === reference)?.actor?.display?.trim();
  return appointmentDisplay || reference;
}

function formatTime(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMonth(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    month: "long",
  }).format(new Date(value));
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function elapsedDays(from: string, to: string): number {
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000));
}
