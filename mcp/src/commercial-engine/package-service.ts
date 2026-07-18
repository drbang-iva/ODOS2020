import type {
  ChargeItem,
  Invoice,
  PaymentReconciliation,
  Procedure,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import {
  ODOS_PAYMENT_TENDER_EXTENSION_URL,
  ODOS_PAYMENT_TENDER_SYSTEM,
} from "../fhir/odosPaymentTender.js";
import { buildPaymentReconciliation } from "../payments/payment-reconciliation.js";
import {
  CommercialEngineConflictError,
  CommercialEngineInputError,
  type CommercialEngineStore,
  type PackageDefinition,
  type PackageRefundPolicy,
  type PatientPackageInstance,
} from "./ledger-store.js";

export const ODOS_REVENUE_CLASS_SYSTEM = "https://odos2020.com/fhir/CodeSystem/revenue-class";
export const ODOS_BALANCE_FUNDING_CODE = "balance-funding";
export const ODOS_PACKAGE_CREDIT_TENDER_CODE = "PACKAGE_CREDIT";
export const ODOS_PACKAGE_CREDIT_TRANSACTION_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-ledger-consumption";
export const ODOS_PACKAGE_SALE_DEFINITION_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-sale-definition";
export const ODOS_PACKAGE_SALE_NAME_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-sale-name";
export const ODOS_PACKAGE_SALE_ELIGIBLE_CODE_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-sale-eligible-procedure";
export const ODOS_PACKAGE_SALE_SESSION_COUNT_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-sale-session-count";
export const ODOS_PACKAGE_SALE_EXPIRY_DAYS_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-sale-expiry-days";
export const ODOS_PACKAGE_SALE_REFUND_POLICY_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-sale-refund-policy";
export const ODOS_PACKAGE_REDEMPTION_INVOICE_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-redemption-invoice";

export type CommercialFhirClient = Pick<MedplumClient, "create" | "read" | "search">;

export interface PackageServiceDeps {
  store: CommercialEngineStore;
  now?: () => string;
}

export async function preparePackageSale(
  deps: PackageServiceDeps,
  fhir: CommercialFhirClient,
  input: { patientReference: string; definitionId: string; staffReference: string },
): Promise<{ invoice: Invoice; definition: PackageDefinition }> {
  const patientId = localId(input.patientReference, "Patient");
  assertLocalReference(input.staffReference, ["Practitioner", "PractitionerRole"], "Staff reference");
  const definition = await deps.store.getDefinition(input.definitionId);
  if (!definition?.active) throw new CommercialEngineConflictError("The selected package definition is not active.");
  const createdAt = deps.now?.() ?? new Date().toISOString();
  const invoice = await fhir.create<Invoice>({
    resourceType: "Invoice",
    status: "issued",
    subject: { reference: `Patient/${patientId}` },
    date: createdAt,
    meta: {
      tag: [{
        system: ODOS_REVENUE_CLASS_SYSTEM,
        code: ODOS_BALANCE_FUNDING_CODE,
        display: "Balance funding",
      }],
    },
    identifier: [
      { system: ODOS_PACKAGE_SALE_DEFINITION_SYSTEM, value: definition.id },
      { system: ODOS_PACKAGE_SALE_NAME_SYSTEM, value: definition.name },
      ...definition.eligibleProcedureTypeCodes.map((value) => ({ system: ODOS_PACKAGE_SALE_ELIGIBLE_CODE_SYSTEM, value })),
      { system: ODOS_PACKAGE_SALE_SESSION_COUNT_SYSTEM, value: String(definition.sessionCount) },
      { system: ODOS_PACKAGE_SALE_EXPIRY_DAYS_SYSTEM, value: String(definition.expiryDays) },
      { system: ODOS_PACKAGE_SALE_REFUND_POLICY_SYSTEM, value: definition.refundPolicy },
    ],
    participant: [dataEntryParticipant(input.staffReference)],
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: { text: definition.name },
      priceComponent: [{ type: "base", amount: usd(definition.priceCents) }],
    }],
    totalGross: usd(definition.priceCents),
    totalNet: usd(definition.priceCents),
  });
  if (!invoice.id) throw new Error("Package sale Invoice creation did not return an id.");
  return { invoice, definition };
}

export async function finalizePackageSale(
  deps: PackageServiceDeps,
  fhir: CommercialFhirClient,
  input: {
    patientReference: string;
    definitionId: string;
    invoiceReference: string;
    staffReference: string;
  },
): Promise<PatientPackageInstance> {
  const patientId = localId(input.patientReference, "Patient");
  const invoiceId = localId(input.invoiceReference, "Invoice");
  const invoice = await fhir.read<Invoice>("Invoice", invoiceId);
  if (invoice.subject?.reference !== input.patientReference || !isBalanceFundingInvoice(invoice)) {
    throw new CommercialEngineConflictError("The Invoice is not this patient's package-funding Invoice.");
  }
  if (!await invoiceIsPaid(fhir, invoice)) {
    throw new CommercialEngineConflictError("Package activation requires a successful payment.");
  }
  const terms = packageSaleTerms(invoice);
  if (terms.definitionId !== input.definitionId) {
    throw new CommercialEngineConflictError("The Invoice belongs to a different package definition.");
  }
  if (moneyCents(invoice.totalNet?.value, "Package sale Invoice total") !== terms.priceCents) {
    throw new CommercialEngineConflictError("The package sale Invoice does not match its frozen price.");
  }
  return deps.store.finalizeSale({
    definitionId: terms.definitionId,
    patientFhirId: patientId,
    sourceSaleInvoiceId: invoiceId,
    actorUserId: input.staffReference,
    soldAt: invoice.date ?? deps.now?.() ?? new Date().toISOString(),
    snapshotName: terms.name,
    snapshotEligibleProcedureTypeCodes: terms.eligibleProcedureTypeCodes,
    snapshotSessionCount: terms.sessionCount,
    snapshotPriceCents: terms.priceCents,
    snapshotExpiryDays: terms.expiryDays,
    snapshotRefundPolicy: terms.refundPolicy,
  });
}

export async function redeemPackageSession(
  deps: PackageServiceDeps,
  fhir: CommercialFhirClient,
  input: {
    patientReference: string;
    packageInstanceId: string;
    procedureReference: string;
    chargeItemReference: string;
    staffReference: string;
  },
): Promise<{
  package: PatientPackageInstance;
  invoiceReference: string;
  paymentReference: string;
}> {
  const patientId = localId(input.patientReference, "Patient");
  const procedureId = localId(input.procedureReference, "Procedure");
  const chargeItemId = localId(input.chargeItemReference, "ChargeItem");
  assertLocalReference(input.staffReference, ["Practitioner", "PractitionerRole"], "Staff reference");
  const [procedure, chargeItem] = await Promise.all([
    fhir.read<Procedure>("Procedure", procedureId),
    fhir.read<ChargeItem>("ChargeItem", chargeItemId),
  ]);
  if (procedure.subject.reference !== input.patientReference || chargeItem.subject.reference !== input.patientReference) {
    throw new CommercialEngineConflictError("The procedure and charge must belong to the selected patient.");
  }
  if (!chargeItem.supportingInformation?.some((reference) => reference.reference === input.procedureReference)) {
    throw new CommercialEngineConflictError("The charge is not linked to the selected procedure.");
  }
  if (chargeItem.status !== "billable") {
    throw new CommercialEngineConflictError("Only a billable procedure charge can use package credit.");
  }
  const procedureCodes = procedure.code?.coding?.flatMap((coding) => coding.code ?? []) ?? [];
  if (procedureCodes.length === 0) throw new CommercialEngineInputError("The procedure has no coded type for package matching.");
  const packages = await deps.store.listPatientPackages(patientId);
  const existingOperation = await deps.store.getRedemption(procedureId);
  const selectedPackage = existingOperation
    ? packages.find((instance) => instance.id === input.packageInstanceId)
    : applicablePackages(packages, procedureCodes, (deps.now?.() ?? new Date().toISOString()).slice(0, 10))
      .find((instance) => instance.id === input.packageInstanceId);
  if (!selectedPackage) {
    throw new CommercialEngineConflictError("The selected package is not currently eligible for this procedure.");
  }
  const amountCents = moneyCents(chargeItem.priceOverride?.value, "Procedure charge price");
  if (amountCents <= 0) throw new CommercialEngineInputError("The procedure charge must have a positive real price.");
  const requestedAt = deps.now?.() ?? new Date().toISOString();
  let operation = await deps.store.beginRedemption({
    procedureFhirId: procedureId,
    patientFhirId: patientId,
    packageInstanceId: input.packageInstanceId,
    chargeItemFhirId: chargeItemId,
    amountCents,
    createdAt: requestedAt,
  });
  if (operation.completedAt && operation.invoiceFhirId && operation.paymentFhirId) {
    return {
      package: selectedPackage,
      invoiceReference: `Invoice/${operation.invoiceFhirId}`,
      paymentReference: `PaymentReconciliation/${operation.paymentFhirId}`,
    };
  }
  const consumedAt = operation.createdAt;
  const invoice = operation.invoiceFhirId
    ? await fhir.read<Invoice>("Invoice", operation.invoiceFhirId)
    : await findOrCreateRedemptionInvoice(fhir, {
      patientReference: input.patientReference,
      chargeItemReference: input.chargeItemReference,
      procedureId,
      amountCents,
      staffReference: input.staffReference,
      createdAt: consumedAt,
    });
  if (!invoice.id) throw new Error("Package redemption Invoice creation did not return an id.");
  operation = await deps.store.recordRedemptionInvoice(procedureId, invoice.id);
  const transactionId = `${input.packageInstanceId}:${procedureId}`;
  const payment = operation.paymentFhirId
    ? await fhir.read<PaymentReconciliation>("PaymentReconciliation", operation.paymentFhirId)
    : await findOrCreateRedemptionPayment(fhir, {
      transactionId,
      createdAt: consumedAt,
      amountCents,
      patientReference: input.patientReference,
      invoiceReference: `Invoice/${invoice.id}`,
      staffReference: input.staffReference,
      description: `Package credit for ${procedure.code?.text ?? procedureCodes[0]}`,
    });
  if (!payment.id) throw new Error("Package credit PaymentReconciliation creation did not return an id.");
  assertPackageCreditPayment(payment, `Invoice/${invoice.id}`, amountCents, transactionId);
  await deps.store.recordRedemptionPayment(procedureId, payment.id);
  const packageInstance = await deps.store.consume({
    packageInstanceId: input.packageInstanceId,
    patientFhirId: patientId,
    procedureTypeCodes: procedureCodes,
    linkedFhirInvoiceId: invoice.id,
    linkedFhirProcedureId: procedureId,
    actorUserId: input.staffReference,
    consumedAt,
  });
  return {
    package: packageInstance,
    invoiceReference: `Invoice/${invoice.id}`,
    paymentReference: `PaymentReconciliation/${payment.id}`,
  };
}

export function applicablePackages(
  packages: readonly PatientPackageInstance[],
  procedureTypeCodes: readonly string[],
  onDate: string,
): PatientPackageInstance[] {
  return packages.filter((instance) =>
    instance.remainingSessions > 0
    && instance.expiryDate >= onDate
    && procedureTypeCodes.some((code) => instance.eligibleProcedureTypeCodes.includes(code)),
  );
}

export function isBalanceFundingInvoice(invoice: Invoice): boolean {
  return Boolean(invoice.meta?.tag?.some((tag) =>
    tag.system === ODOS_REVENUE_CLASS_SYSTEM && tag.code === ODOS_BALANCE_FUNDING_CODE,
  ));
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
  return allocatedCents >= moneyCents(invoice.totalNet?.value, "Package sale Invoice total");
}

function packageSaleTerms(invoice: Invoice): {
  definitionId: string;
  name: string;
  eligibleProcedureTypeCodes: string[];
  sessionCount: number;
  priceCents: number;
  expiryDays: number;
  refundPolicy: PackageRefundPolicy;
} {
  const definitionId = requiredIdentifier(invoice, ODOS_PACKAGE_SALE_DEFINITION_SYSTEM, "Package definition");
  const name = requiredIdentifier(invoice, ODOS_PACKAGE_SALE_NAME_SYSTEM, "Package name");
  const eligibleProcedureTypeCodes = invoice.identifier
    ?.filter((identifier) => identifier.system === ODOS_PACKAGE_SALE_ELIGIBLE_CODE_SYSTEM)
    .flatMap((identifier) => identifier.value ?? []) ?? [];
  if (eligibleProcedureTypeCodes.length === 0) {
    throw new CommercialEngineConflictError("The package sale Invoice has no frozen eligible procedures.");
  }
  const sessionCount = positiveIdentifierInteger(invoice, ODOS_PACKAGE_SALE_SESSION_COUNT_SYSTEM, "Session count");
  const expiryDays = positiveIdentifierInteger(invoice, ODOS_PACKAGE_SALE_EXPIRY_DAYS_SYSTEM, "Expiry days");
  const refundPolicy = requiredIdentifier(invoice, ODOS_PACKAGE_SALE_REFUND_POLICY_SYSTEM, "Refund policy");
  if (!(["non_refundable", "store_credit_only", "prorated_cash"] as const).includes(refundPolicy as PackageRefundPolicy)) {
    throw new CommercialEngineConflictError("The package sale Invoice has an invalid frozen refund policy.");
  }
  return {
    definitionId,
    name,
    eligibleProcedureTypeCodes,
    sessionCount,
    priceCents: moneyCents(invoice.totalNet?.value, "Package sale Invoice total"),
    expiryDays,
    refundPolicy: refundPolicy as PackageRefundPolicy,
  };
}

async function findOrCreateRedemptionInvoice(
  fhir: CommercialFhirClient,
  input: {
    patientReference: string;
    chargeItemReference: string;
    procedureId: string;
    amountCents: number;
    staffReference: string;
    createdAt: string;
  },
): Promise<Invoice> {
  const found = resources(await fhir.search<Invoice>("Invoice", {
    identifier: `${ODOS_PACKAGE_REDEMPTION_INVOICE_SYSTEM}|${input.procedureId}`,
    _count: "2",
  }));
  if (found.length > 1) throw new CommercialEngineConflictError("Multiple package redemption Invoices exist for this procedure.");
  const invoice = found[0] ?? await fhir.create<Invoice>({
    resourceType: "Invoice",
    status: "issued",
    identifier: [{ system: ODOS_PACKAGE_REDEMPTION_INVOICE_SYSTEM, value: input.procedureId }],
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
  });
  if (invoice.subject?.reference !== input.patientReference
    || moneyCents(invoice.totalNet?.value, "Package redemption Invoice total") !== input.amountCents
    || !invoice.lineItem?.some((line) => line.chargeItemReference?.reference === input.chargeItemReference)) {
    throw new CommercialEngineConflictError("The recovered package redemption Invoice does not match this procedure charge.");
  }
  return invoice;
}

async function findOrCreateRedemptionPayment(
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
  const found = resources(await fhir.search<PaymentReconciliation>("PaymentReconciliation", {
    identifier: `${ODOS_PACKAGE_CREDIT_TRANSACTION_SYSTEM}|${input.transactionId}`,
    _count: "2",
  }));
  if (found.length > 1) throw new CommercialEngineConflictError("Multiple package-credit payments exist for this procedure.");
  return found[0] ?? fhir.create<PaymentReconciliation>(buildPaymentReconciliation({
    outcome: "success",
    createdIso: input.createdAt,
    paymentDate: input.createdAt.slice(0, 10),
    amountCents: input.amountCents,
    subjectReference: input.patientReference,
    invoiceReference: input.invoiceReference,
    staffReference: input.staffReference,
    processorTransactionId: input.transactionId,
    processorTransactionSystem: ODOS_PACKAGE_CREDIT_TRANSACTION_SYSTEM,
    surface: "manual",
    tender: { code: ODOS_PACKAGE_CREDIT_TENDER_CODE, display: "Package credit" },
    description: input.description,
  }));
}

function assertPackageCreditPayment(
  payment: PaymentReconciliation,
  invoiceReference: string,
  amountCents: number,
  transactionId: string,
): void {
  const allocated = (payment.detail ?? []).reduce((sum, detail) =>
    detail.request?.reference === invoiceReference
      ? sum + moneyCents(detail.amount?.value, "Package-credit allocation")
      : sum, 0);
  if (payment.status !== "active"
    || payment.outcome !== "complete"
    || payment.paymentIdentifier?.system !== ODOS_PACKAGE_CREDIT_TRANSACTION_SYSTEM
    || payment.paymentIdentifier.value !== transactionId
    || allocated < amountCents) {
    throw new CommercialEngineConflictError("The recovered package-credit payment is not a complete settlement for this Invoice.");
  }
}

function requiredIdentifier(invoice: Invoice, system: string, label: string): string {
  const values = invoice.identifier?.filter((identifier) => identifier.system === system).flatMap((identifier) => identifier.value ?? []) ?? [];
  if (values.length !== 1 || !values[0].trim()) {
    throw new CommercialEngineConflictError(`${label} is missing from the package sale Invoice.`);
  }
  return values[0];
}

function positiveIdentifierInteger(invoice: Invoice, system: string, label: string): number {
  const value = Number(requiredIdentifier(invoice, system, label));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CommercialEngineConflictError(`${label} is invalid on the package sale Invoice.`);
  }
  return value;
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
