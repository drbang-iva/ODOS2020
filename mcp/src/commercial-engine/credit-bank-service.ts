import type { ChargeItem, Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import {
  ODOS_PAYMENT_TENDER_EXTENSION_URL,
  ODOS_PAYMENT_TENDER_SYSTEM,
} from "../fhir/odosPaymentTender.js";
import { buildPaymentReconciliation } from "../payments/payment-reconciliation.js";
import type {
  CommercialFhirClient,
  PackageServiceDeps,
} from "./package-service.js";
import {
  ODOS_BALANCE_FUNDING_CODE,
  ODOS_REVENUE_CLASS_SYSTEM,
  isBalanceFundingInvoice,
} from "./package-service.js";
import {
  CommercialEngineConflictError,
  CommercialEngineInputError,
  type PatientCreditBank,
} from "./ledger-store.js";

export const ODOS_BANK_CREDIT_TENDER_CODE = "BANK_CREDIT";
export const ODOS_BANK_CREDIT_TRANSACTION_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/credit-bank-spend";
export const ODOS_CREDIT_BANK_DEPOSIT_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/credit-bank-deposit";
export const ODOS_CREDIT_BANK_BONUS_AMOUNT_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/credit-bank-bonus-amount";
export const ODOS_CREDIT_BANK_BONUS_REASON_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/credit-bank-bonus-reason";
export const ODOS_CREDIT_BANK_SPEND_INVOICE_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/credit-bank-spend-invoice";

export async function prepareCreditBankDeposit(
  deps: PackageServiceDeps,
  fhir: CommercialFhirClient,
  input: {
    patientReference: string;
    depositCents: number;
    bonusCents?: number;
    bonusReason?: string;
    staffReference: string;
  },
): Promise<Invoice> {
  localId(input.patientReference, "Patient");
  assertLocalReference(input.staffReference, ["Practitioner", "PractitionerRole"], "Staff reference");
  assertPositiveInteger(input.depositCents, "Deposit amount");
  const bonusCents = input.bonusCents ?? 0;
  assertNonnegativeInteger(bonusCents, "Bonus amount");
  const bonusReason = input.bonusReason?.trim();
  if (bonusCents > 0 && !bonusReason) throw new CommercialEngineInputError("Bonus reason is required.");
  const createdAt = deps.now?.() ?? new Date().toISOString();
  const invoice = await fhir.create<Invoice>({
    resourceType: "Invoice",
    status: "issued",
    subject: { reference: input.patientReference },
    date: createdAt,
    meta: {
      tag: [{
        system: ODOS_REVENUE_CLASS_SYSTEM,
        code: ODOS_BALANCE_FUNDING_CODE,
        display: "Balance funding",
      }],
    },
    identifier: [
      { system: ODOS_CREDIT_BANK_DEPOSIT_SYSTEM, value: createdAt },
      ...(bonusCents > 0 ? [
        { system: ODOS_CREDIT_BANK_BONUS_AMOUNT_SYSTEM, value: String(bonusCents) },
        { system: ODOS_CREDIT_BANK_BONUS_REASON_SYSTEM, value: bonusReason },
      ] : []),
    ],
    participant: [dataEntryParticipant(input.staffReference)],
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: { text: "Credit Bank deposit" },
      priceComponent: [{ type: "base", amount: usd(input.depositCents) }],
    }],
    totalGross: usd(input.depositCents),
    totalNet: usd(input.depositCents),
  });
  if (!invoice.id) throw new Error("Credit Bank deposit Invoice creation did not return an id.");
  return invoice;
}

export async function finalizeCreditBankDeposit(
  deps: PackageServiceDeps,
  fhir: CommercialFhirClient,
  input: {
    patientReference: string;
    invoiceReference: string;
    staffReference: string;
    allowBonus: boolean;
  },
): Promise<PatientCreditBank> {
  const patientId = localId(input.patientReference, "Patient");
  const invoiceId = localId(input.invoiceReference, "Invoice");
  const invoice = await fhir.read<Invoice>("Invoice", invoiceId);
  if (invoice.subject?.reference !== input.patientReference
    || !isBalanceFundingInvoice(invoice)
    || !invoice.identifier?.some((identifier) => identifier.system === ODOS_CREDIT_BANK_DEPOSIT_SYSTEM)) {
    throw new CommercialEngineConflictError("The Invoice is not this patient's Credit Bank funding Invoice.");
  }
  if (!await invoiceIsPaid(fhir, invoice)) {
    throw new CommercialEngineConflictError("Credit Bank funding requires a successful payment.");
  }
  const bonusAmount = optionalIdentifier(invoice, ODOS_CREDIT_BANK_BONUS_AMOUNT_SYSTEM);
  const bonusReason = optionalIdentifier(invoice, ODOS_CREDIT_BANK_BONUS_REASON_SYSTEM);
  const bonusCents = bonusAmount === undefined ? 0 : positiveInteger(bonusAmount, "Credit Bank bonus amount");
  if ((bonusCents > 0 || bonusReason !== undefined) && (bonusCents === 0 || !bonusReason)) {
    throw new CommercialEngineConflictError("The Credit Bank funding Invoice has incomplete bonus terms.");
  }
  if (bonusCents > 0 && !input.allowBonus) {
    throw new CommercialEngineConflictError("Practice-admin role is required to finalize promotional bonus credit.");
  }
  return deps.store.finalizeCreditBankDeposit({
    patientFhirId: patientId,
    sourceInvoiceId: invoiceId,
    depositCents: moneyCents(invoice.totalNet?.value, "Credit Bank funding Invoice total"),
    bonusCents,
    ...(bonusReason ? { bonusReason } : {}),
    actorUserId: input.staffReference,
    depositedAt: invoice.date ?? deps.now?.() ?? new Date().toISOString(),
  });
}

export async function spendCreditBankAtCheckout(
  deps: PackageServiceDeps,
  fhir: CommercialFhirClient,
  input: {
    patientReference: string;
    chargeItemReference: string;
    staffReference: string;
  },
): Promise<{
  creditBank: PatientCreditBank;
  invoiceReference: string;
  paymentReference: string;
}> {
  const patientId = localId(input.patientReference, "Patient");
  const chargeItemId = localId(input.chargeItemReference, "ChargeItem");
  assertLocalReference(input.staffReference, ["Practitioner", "PractitionerRole"], "Staff reference");
  const chargeItem = await fhir.read<ChargeItem>("ChargeItem", chargeItemId);
  if (chargeItem.subject.reference !== input.patientReference) {
    throw new CommercialEngineConflictError("The charge does not belong to the selected patient.");
  }
  if (chargeItem.status !== "billable") {
    throw new CommercialEngineConflictError("Only a billable charge can use Credit Bank funds.");
  }
  const amountCents = moneyCents(chargeItem.priceOverride?.value, "Charge price");
  if (amountCents <= 0) throw new CommercialEngineInputError("The charge must have a positive real price.");
  const requestedAt = deps.now?.() ?? new Date().toISOString();
  let operation = await deps.store.beginCreditBankSpend({
    chargeItemFhirId: chargeItemId,
    patientFhirId: patientId,
    amountCents,
    createdAt: requestedAt,
  });
  if (operation.completedAt && operation.invoiceFhirId && operation.paymentFhirId) {
    return {
      creditBank: await deps.store.getCreditBank(patientId),
      invoiceReference: `Invoice/${operation.invoiceFhirId}`,
      paymentReference: `PaymentReconciliation/${operation.paymentFhirId}`,
    };
  }
  const invoice = operation.invoiceFhirId
    ? await fhir.read<Invoice>("Invoice", operation.invoiceFhirId)
    : await findOrCreateSpendInvoice(fhir, {
      patientReference: input.patientReference,
      chargeItemReference: input.chargeItemReference,
      chargeItemId,
      amountCents,
      staffReference: input.staffReference,
      createdAt: operation.createdAt,
    });
  if (!invoice.id) throw new Error("Credit Bank spend Invoice creation did not return an id.");
  assertSpendInvoice(invoice, input.patientReference, input.chargeItemReference, amountCents);
  operation = await deps.store.recordCreditBankSpendInvoice(chargeItemId, invoice.id);
  const creditBank = await deps.store.spendCreditBank({
    chargeItemFhirId: chargeItemId,
    patientFhirId: patientId,
    linkedFhirInvoiceId: invoice.id,
    amountCents,
    actorUserId: input.staffReference,
    spentAt: operation.createdAt,
  });
  const transactionId = `credit-bank:${chargeItemId}`;
  const payment = operation.paymentFhirId
    ? await fhir.read<PaymentReconciliation>("PaymentReconciliation", operation.paymentFhirId)
    : await findOrCreateSpendPayment(fhir, {
      transactionId,
      createdAt: operation.createdAt,
      amountCents,
      patientReference: input.patientReference,
      invoiceReference: `Invoice/${invoice.id}`,
      staffReference: input.staffReference,
      description: `Credit Bank payment for ${chargeItem.code.text ?? chargeItem.code.coding?.[0]?.display ?? "charge"}`,
    });
  if (!payment.id) throw new Error("Credit Bank PaymentReconciliation creation did not return an id.");
  assertSpendPayment(payment, `Invoice/${invoice.id}`, amountCents, transactionId);
  await deps.store.recordCreditBankSpendPayment(chargeItemId, payment.id);
  await deps.store.completeCreditBankSpend(chargeItemId, requestedAt);
  return {
    creditBank,
    invoiceReference: `Invoice/${invoice.id}`,
    paymentReference: `PaymentReconciliation/${payment.id}`,
  };
}

async function findOrCreateSpendInvoice(
  fhir: CommercialFhirClient,
  input: {
    patientReference: string;
    chargeItemReference: string;
    chargeItemId: string;
    amountCents: number;
    staffReference: string;
    createdAt: string;
  },
): Promise<Invoice> {
  const search = await fhir.search<Invoice>("Invoice", {
    identifier: `${ODOS_CREDIT_BANK_SPEND_INVOICE_SYSTEM}|${input.chargeItemId}`,
    _count: "2",
  });
  assertCompleteSearch(search, "Credit Bank spend Invoice");
  const found = resources(search);
  if (found.length > 1) throw new CommercialEngineConflictError("Multiple Credit Bank spend Invoices exist for this charge.");
  return found[0] ?? fhir.create<Invoice>({
    resourceType: "Invoice",
    status: "issued",
    identifier: [{ system: ODOS_CREDIT_BANK_SPEND_INVOICE_SYSTEM, value: input.chargeItemId }],
    subject: { reference: input.patientReference },
    date: input.createdAt,
    participant: [dataEntryParticipant(input.staffReference)],
    lineItem: [{
      sequence: 1,
      chargeItemReference: { reference: input.chargeItemReference },
      priceComponent: [{ type: "base", amount: usd(input.amountCents) }],
    }],
    totalGross: usd(input.amountCents),
    totalNet: usd(input.amountCents),
  }, {
    "If-None-Exist": `identifier=${ODOS_CREDIT_BANK_SPEND_INVOICE_SYSTEM}|${input.chargeItemId}`,
  });
}

async function findOrCreateSpendPayment(
  fhir: CommercialFhirClient,
  input: {
    transactionId: string;
    createdAt: string;
    amountCents: number;
    patientReference: string;
    invoiceReference: string;
    staffReference: string;
    description: string;
  },
): Promise<PaymentReconciliation> {
  const search = await fhir.search<PaymentReconciliation>("PaymentReconciliation", {
    identifier: `${ODOS_BANK_CREDIT_TRANSACTION_SYSTEM}|${input.transactionId}`,
    _count: "2",
  });
  assertCompleteSearch(search, "Credit Bank payment");
  const found = resources(search);
  if (found.length > 1) throw new CommercialEngineConflictError("Multiple Credit Bank payments exist for this charge.");
  return found[0] ?? fhir.create<PaymentReconciliation>(buildPaymentReconciliation({
    outcome: "success",
    createdIso: input.createdAt,
    paymentDate: input.createdAt.slice(0, 10),
    amountCents: input.amountCents,
    subjectReference: input.patientReference,
    invoiceReference: input.invoiceReference,
    staffReference: input.staffReference,
    processorTransactionId: input.transactionId,
    processorTransactionSystem: ODOS_BANK_CREDIT_TRANSACTION_SYSTEM,
    surface: "manual",
    tender: { code: ODOS_BANK_CREDIT_TENDER_CODE, display: "Credit Bank" },
    description: input.description,
  }), {
    "If-None-Exist": `identifier=${ODOS_BANK_CREDIT_TRANSACTION_SYSTEM}|${input.transactionId}`,
  });
}

function assertSpendInvoice(invoice: Invoice, patientReference: string, chargeItemReference: string, amountCents: number): void {
  if (invoice.subject?.reference !== patientReference
    || moneyCents(invoice.totalNet?.value, "Credit Bank spend Invoice total") !== amountCents
    || !invoice.lineItem?.some((line) => line.chargeItemReference?.reference === chargeItemReference)) {
    throw new CommercialEngineConflictError("The recovered Credit Bank spend Invoice does not match this charge.");
  }
}

function assertSpendPayment(
  payment: PaymentReconciliation,
  invoiceReference: string,
  amountCents: number,
  transactionId: string,
): void {
  const allocated = (payment.detail ?? []).reduce((sum, detail) =>
    detail.request?.reference === invoiceReference
      ? sum + moneyCents(detail.amount?.value, "Credit Bank allocation")
      : sum, 0);
  if (payment.status !== "active"
    || payment.outcome !== "complete"
    || payment.paymentIdentifier?.system !== ODOS_BANK_CREDIT_TRANSACTION_SYSTEM
    || payment.paymentIdentifier.value !== transactionId
    || allocated < amountCents) {
    throw new CommercialEngineConflictError("The recovered Credit Bank payment is not a complete settlement for this Invoice.");
  }
}

async function invoiceIsPaid(fhir: CommercialFhirClient, invoice: Invoice): Promise<boolean> {
  if (invoice.status === "balanced" || invoice.extension?.some((extension) =>
    extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL
    && extension.valueCodeableConcept?.coding?.some((coding) => coding.system === ODOS_PAYMENT_TENDER_SYSTEM),
  )) return true;
  if (!invoice.id) return false;
  const reconciliations = await fhir.search<PaymentReconciliation>("PaymentReconciliation", {
    request: `Invoice/${invoice.id}`,
    status: "active",
    _count: "1000",
  });
  if (reconciliations.link?.some((link) => link.relation === "next")) return false;
  const allocatedCents = (reconciliations.entry ?? []).reduce((total, entry) => {
    const payment = entry.resource;
    if (payment?.outcome !== "complete") return total;
    return total + (payment.detail ?? []).reduce((sum, detail) =>
      detail.request?.reference === `Invoice/${invoice.id}`
        ? sum + moneyCents(detail.amount?.value, "Payment allocation")
        : sum, 0);
  }, 0);
  return allocatedCents >= moneyCents(invoice.totalNet?.value, "Credit Bank funding Invoice total");
}

function optionalIdentifier(invoice: Invoice, system: string): string | undefined {
  const values = invoice.identifier?.filter((identifier) => identifier.system === system)
    .flatMap((identifier) => identifier.value ?? []) ?? [];
  if (values.length > 1) throw new CommercialEngineConflictError("The Credit Bank funding Invoice has duplicate terms.");
  return values[0]?.trim() || undefined;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new CommercialEngineConflictError(`${label} is invalid.`);
  return parsed;
}

function assertCompleteSearch(bundle: { link?: Array<{ relation: string }> }, label: string): void {
  if (bundle.link?.some((link) => link.relation === "next")) {
    throw new CommercialEngineConflictError(`The ${label} search was incomplete.`);
  }
}

function resources<T extends Invoice | PaymentReconciliation>(bundle: { entry?: Array<{ resource?: T }> }): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function dataEntryParticipant(staffReference: string): NonNullable<Invoice["participant"]>[number] {
  return {
    role: {
      coding: [{
        system: "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
        code: "ENT",
        display: "data entry person",
      }],
    },
    actor: { reference: staffReference },
  };
}

function usd(cents: number): { value: number; currency: "USD" } {
  return { value: cents / 100, currency: "USD" };
}

function moneyCents(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CommercialEngineInputError(`${label} is invalid.`);
  }
  const scaled = value * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 0.000001) {
    throw new CommercialEngineInputError(`${label} is not representable in whole cents.`);
  }
  return cents;
}

function localId(reference: string, resourceType: string): string {
  const match = reference.match(new RegExp(`^${resourceType}/([A-Za-z0-9.-]+)$`));
  if (!match) throw new CommercialEngineInputError(`${resourceType} reference is invalid.`);
  return match[1];
}

function assertLocalReference(reference: string, types: readonly string[], label: string): void {
  if (!types.some((type) => new RegExp(`^${type}/[A-Za-z0-9.-]+$`).test(reference))) {
    throw new CommercialEngineInputError(`${label} is invalid.`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CommercialEngineInputError(`${label} must be a positive whole number.`);
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CommercialEngineInputError(`${label} must be a nonnegative whole number.`);
}
