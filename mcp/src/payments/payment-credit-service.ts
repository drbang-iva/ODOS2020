import type {
  Bundle,
  PaymentReconciliation,
  PaymentReconciliationDetail,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../fhir/odosPaymentTender.js";
import {
  HL7_PAYMENT_TYPE_SYSTEM,
  ODOS_PAYMENT_SUBJECT_EXTENSION_URL,
} from "./payment-reconciliation.js";

export type PaymentCreditFhirClient = Pick<MedplumClient, "read" | "search" | "update">;

export interface ApplyPaymentCreditInput {
  paymentReconciliationReference: string;
  invoiceReference: string;
  amountCents: number;
}

export interface TransferPaymentCreditInput {
  paymentReconciliationReference: string;
  fromInvoiceReference: string;
  toInvoiceReference: string;
}

export interface VoidPaymentCreditInput {
  paymentReconciliationReference: string;
  nowIso: string;
  method: "manual-cash" | "clover";
  voidAtProcessor(transactionId: string): Promise<"success" | "failed">;
}

export interface UnappliedCredit {
  paymentReconciliation: PaymentReconciliation;
  unappliedCents: number;
  subjectReference: string;
}

export interface UnappliedCreditReceipt {
  amountCents: number;
  tender: string;
  date: string;
  staff: string;
  practice: string;
  notice: "Unapplied credit — will be applied to today's charges.";
}

export async function applyPaymentCredit(
  fhir: PaymentCreditFhirClient,
  input: ApplyPaymentCreditInput,
): Promise<PaymentReconciliation> {
  assertPositiveCents(input.amountCents, "Allocation");
  assertInvoiceReference(input.invoiceReference);
  const current = await readPaymentReconciliation(fhir, input.paymentReconciliationReference);
  assertMutable(current);
  const nextDetail = [...(current.detail ?? []), paymentDetail(input.invoiceReference, input.amountCents)];
  assertAllocationInvariant(current, nextDetail);
  return conditionalUpdate(fhir, current, { ...current, detail: nextDetail });
}

export async function transferPaymentCredit(
  fhir: PaymentCreditFhirClient,
  input: TransferPaymentCreditInput,
): Promise<PaymentReconciliation> {
  assertInvoiceReference(input.fromInvoiceReference);
  assertInvoiceReference(input.toInvoiceReference);
  if (input.fromInvoiceReference === input.toInvoiceReference) {
    throw new Error("A credit transfer requires different source and target Invoices.");
  }
  const current = await readPaymentReconciliation(fhir, input.paymentReconciliationReference);
  assertMutable(current);
  const matches = (current.detail ?? [])
    .map((detail, index) => ({ detail, index }))
    .filter(({ detail }) => detail.request?.reference === input.fromInvoiceReference);
  if (matches.length !== 1) {
    throw new Error(
      `Credit transfer requires exactly one allocation for ${input.fromInvoiceReference}; found ${matches.length}.`,
    );
  }
  const amountCents = detailAmountCents(matches[0].detail);
  const nextDetail = (current.detail ?? []).filter((_, index) => index !== matches[0].index);
  nextDetail.push(paymentDetail(input.toInvoiceReference, amountCents));
  assertAllocationInvariant(current, nextDetail);
  return conditionalUpdate(fhir, current, { ...current, detail: nextDetail });
}

export async function voidPaymentCredit(
  fhir: PaymentCreditFhirClient,
  input: VoidPaymentCreditInput,
): Promise<PaymentReconciliation> {
  const current = await readPaymentReconciliation(fhir, input.paymentReconciliationReference);
  assertMutable(current);
  if (unappliedPaymentCents(current) <= 0) {
    throw new Error("Only a fully or partially unapplied payment can be voided in Phase 6a.");
  }
  const recordedMethod = paymentMethodForReconciliation(current);
  if (recordedMethod !== input.method) {
    throw new Error(`Payment tender requires the ${recordedMethod} adapter, not ${input.method}.`);
  }
  assertVoidWindow(current, input.nowIso, input.method);
  const transactionId = current.paymentIdentifier?.value;
  if (!transactionId) {
    throw new Error("PaymentReconciliation has no transaction id to void.");
  }
  if (await input.voidAtProcessor(transactionId) !== "success") {
    throw new Error("Payment void failed; the PaymentReconciliation remains active.");
  }

  try {
    return await conditionalUpdate(fhir, current, { ...current, status: "cancelled" });
  } catch (error) {
    if (!isVersionConflict(error)) {
      throw error;
    }
    const latest = await readPaymentReconciliation(fhir, input.paymentReconciliationReference);
    if (latest.status === "cancelled") {
      return latest;
    }
    return conditionalUpdate(fhir, latest, { ...latest, status: "cancelled" });
  }
}

export function filterUnappliedCredits(
  paymentReconciliations: PaymentReconciliation[],
  subjectReference?: string,
): UnappliedCredit[] {
  if (subjectReference !== undefined) {
    assertPatientReference(subjectReference);
  }
  return paymentReconciliations.flatMap((paymentReconciliation) => {
    if (paymentReconciliation.status !== "active") {
      return [];
    }
    const paymentSubject = paymentSubjectReference(paymentReconciliation);
    if (!paymentSubject || (subjectReference && paymentSubject !== subjectReference)) {
      return [];
    }
    assertPatientReference(paymentSubject);
    const unappliedCents = unappliedPaymentCents(paymentReconciliation);
    return unappliedCents > 0
      ? [{ paymentReconciliation, unappliedCents, subjectReference: paymentSubject }]
      : [];
  });
}

export async function queryUnappliedCredits(
  fhir: Pick<MedplumClient, "search">,
  subjectReference?: string,
): Promise<UnappliedCredit[]> {
  const bundle: Bundle<PaymentReconciliation> = await fhir.search<PaymentReconciliation>(
    "PaymentReconciliation",
    { status: "active", _count: "1000" },
  );
  if (bundle.link?.some((link) => link.relation === "next")) {
    throw new Error("Unapplied-credit query exceeded one FHIR page; refusing a partial ledger result.");
  }
  return filterUnappliedCredits(
    (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []),
    subjectReference,
  );
}

export function buildUnappliedCreditReceipt(input: {
  paymentReconciliation: PaymentReconciliation;
  staff: string;
  practice: string;
}): UnappliedCreditReceipt {
  if (!input.staff || !input.practice) {
    throw new Error("Unapplied-credit receipt requires staff and practice labels.");
  }
  const pr = input.paymentReconciliation;
  const tender = paymentTenderLabel(pr);
  const amountCents = paymentAmountCents(pr);
  const date = pr.paymentDate ?? pr.created?.slice(0, 10);
  if (!date) {
    throw new Error("PaymentReconciliation has no payment date for the receipt.");
  }
  return {
    amountCents,
    tender,
    date,
    staff: input.staff,
    practice: input.practice,
    notice: "Unapplied credit — will be applied to today's charges.",
  };
}

export function renderUnappliedCreditReceipt(receipt: UnappliedCreditReceipt): string {
  return `<section class="odos-unapplied-credit-receipt">
<h1>Payment Receipt</h1>
<dl>
  <dt>Practice</dt><dd>${escapeHtml(receipt.practice)}</dd>
  <dt>Date</dt><dd>${escapeHtml(receipt.date)}</dd>
  <dt>Staff</dt><dd>${escapeHtml(receipt.staff)}</dd>
  <dt>Tender</dt><dd>${escapeHtml(receipt.tender)}</dd>
  <dt>Amount</dt><dd>${money(receipt.amountCents)}</dd>
</dl>
<p>${escapeHtml(receipt.notice)}</p>
</section>`;
}

export function paymentSubjectReference(pr: PaymentReconciliation): string | undefined {
  return pr.extension?.find((extension) => extension.url === ODOS_PAYMENT_SUBJECT_EXTENSION_URL)
    ?.valueReference?.reference;
}

export function unappliedPaymentCents(pr: PaymentReconciliation): number {
  const paymentCents = paymentAmountCents(pr);
  const allocatedCents = (pr.detail ?? []).reduce(
    (total, detail) => total + detailAmountCents(detail),
    0,
  );
  if (allocatedCents > paymentCents) {
    throw new Error(
      `PaymentReconciliation allocation invariant violated: ${allocatedCents} allocated cents exceeds ${paymentCents} payment cents.`,
    );
  }
  return paymentCents - allocatedCents;
}

export function paymentMethodForReconciliation(
  pr: PaymentReconciliation,
): "manual-cash" | "clover" {
  const code = paymentTenderCode(pr);
  if (code === "CASH" || code === "CHECK") {
    return "manual-cash";
  }
  if (code === "CLOVER") {
    return "clover";
  }
  throw new Error(`No Phase 6a void adapter is registered for payment tender "${code}".`);
}

export function canVoidPaymentCredit(pr: PaymentReconciliation, nowIso: string): boolean {
  try {
    assertMutable(pr);
    if (unappliedPaymentCents(pr) <= 0 || !pr.paymentIdentifier?.value) {
      return false;
    }
    assertVoidWindow(pr, nowIso, paymentMethodForReconciliation(pr));
    return true;
  } catch {
    return false;
  }
}

function assertAllocationInvariant(
  pr: PaymentReconciliation,
  detail: PaymentReconciliationDetail[],
): void {
  const allocatedCents = detail.reduce((total, item) => total + detailAmountCents(item), 0);
  const paymentCents = paymentAmountCents(pr);
  if (allocatedCents > paymentCents) {
    throw new Error(
      `Payment allocation would total ${allocatedCents} cents but paymentAmount is only ${paymentCents} cents; nothing was written.`,
    );
  }
}

function assertMutable(pr: PaymentReconciliation): void {
  if (pr.status !== "active") {
    throw new Error(`PaymentReconciliation/${pr.id ?? "(unknown)"} is ${pr.status}, not active.`);
  }
  const subjectReference = paymentSubjectReference(pr);
  if (!subjectReference) {
    throw new Error("PaymentReconciliation is missing the required odos-payment-subject extension.");
  }
  assertPatientReference(subjectReference);
  unappliedPaymentCents(pr);
}

function paymentDetail(invoiceReference: string, amountCents: number): PaymentReconciliationDetail {
  return {
    type: {
      coding: [{ system: HL7_PAYMENT_TYPE_SYSTEM, code: "payment", display: "Payment" }],
    },
    request: { reference: invoiceReference },
    amount: { value: amountCents / 100, currency: "USD" },
  };
}

async function readPaymentReconciliation(
  fhir: Pick<MedplumClient, "read">,
  reference: string,
): Promise<PaymentReconciliation> {
  const id = reference.match(/^PaymentReconciliation\/([^/]+)$/)?.[1];
  if (!id) {
    throw new Error('paymentReconciliationReference must be a local "PaymentReconciliation/<id>" reference.');
  }
  return fhir.read<PaymentReconciliation>("PaymentReconciliation", id);
}

async function conditionalUpdate(
  fhir: Pick<MedplumClient, "update">,
  current: PaymentReconciliation,
  next: PaymentReconciliation,
): Promise<PaymentReconciliation> {
  if (!current.id || !current.meta?.versionId) {
    throw new Error("PaymentReconciliation is missing id/meta.versionId; refusing a non-atomic update.");
  }
  return fhir.update<PaymentReconciliation>(
    "PaymentReconciliation",
    current.id,
    next,
    { "If-Match": `W/"${current.meta.versionId}"` },
  );
}

function assertVoidWindow(
  pr: PaymentReconciliation,
  nowIso: string,
  method: "manual-cash" | "clover",
): void {
  const nowMs = Date.parse(nowIso);
  const createdMs = Date.parse(pr.created ?? "");
  if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs)) {
    throw new Error("Void requires valid PaymentReconciliation.created and current timestamps.");
  }
  if (pr.paymentDate !== nowIso.slice(0, 10)) {
    throw new Error("Phase 6a permits only same-day voids.");
  }
  if (method === "clover" && (nowMs < createdMs || nowMs - createdMs > 25 * 60 * 1000)) {
    throw new Error("Clover's pre-settlement void window has closed; refunds remain deferred to v0.7.");
  }
}

export function paymentAmountCents(pr: PaymentReconciliation): number {
  const value = pr.paymentAmount?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("PaymentReconciliation has no positive paymentAmount.");
  }
  return Math.round(value * 100);
}

function detailAmountCents(detail: PaymentReconciliationDetail): number {
  const value = detail.amount?.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Every PaymentReconciliation detail allocation requires a positive amount.");
  }
  return Math.round(value * 100);
}

export function paymentTenderCode(pr: PaymentReconciliation): string {
  const code = pr.extension?.find((extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.[0]?.code;
  if (!code) {
    throw new Error("PaymentReconciliation is missing the odos-payment-tender extension.");
  }
  return code;
}

export function paymentTenderLabel(pr: PaymentReconciliation): string {
  const coding = pr.extension?.find((extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.[0];
  const tender = coding?.display ?? coding?.code;
  if (!tender) {
    throw new Error("PaymentReconciliation is missing the odos-payment-tender extension.");
  }
  return tender;
}

function assertPositiveCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} amountCents must be a positive integer number of cents.`);
  }
}

function assertInvoiceReference(reference: string): void {
  if (!/^Invoice\/[^/]+$/.test(reference)) {
    throw new Error('Invoice reference must be a local "Invoice/<id>" reference.');
  }
}

function assertPatientReference(reference: string): void {
  if (!/^Patient\/[^/]+$/.test(reference)) {
    throw new Error('Payment subject must be a local "Patient/<id>" reference.');
  }
}

function isVersionConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 412;
}

function money(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
