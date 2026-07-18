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
  type PatientPackageInstance,
} from "./ledger-store.js";

export const ODOS_REVENUE_CLASS_SYSTEM = "https://odos2020.com/fhir/CodeSystem/revenue-class";
export const ODOS_BALANCE_FUNDING_CODE = "balance-funding";
export const ODOS_PACKAGE_CREDIT_TENDER_CODE = "PACKAGE_CREDIT";
export const ODOS_PACKAGE_CREDIT_TRANSACTION_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/package-ledger-consumption";

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
  const definition = await deps.store.getDefinition(input.definitionId);
  if (!definition?.active) throw new CommercialEngineConflictError("The selected package definition is not active.");
  if (moneyCents(invoice.totalNet?.value, "Package sale Invoice total") !== definition.priceCents) {
    throw new CommercialEngineConflictError("The package definition price changed before sale completion; restart the sale.");
  }
  return deps.store.finalizeSale({
    definitionId: input.definitionId,
    patientFhirId: patientId,
    sourceSaleInvoiceId: invoiceId,
    actorUserId: input.staffReference,
    soldAt: invoice.date ?? deps.now?.() ?? new Date().toISOString(),
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
  const selectedPackage = applicablePackages(packages, procedureCodes, (deps.now?.() ?? new Date().toISOString()).slice(0, 10))
    .find((instance) => instance.id === input.packageInstanceId);
  if (!selectedPackage) {
    throw new CommercialEngineConflictError("The selected package is not currently eligible for this procedure.");
  }
  const amountCents = moneyCents(chargeItem.priceOverride?.value, "Procedure charge price");
  if (amountCents <= 0) throw new CommercialEngineInputError("The procedure charge must have a positive real price.");
  const consumedAt = deps.now?.() ?? new Date().toISOString();
  const invoice = await fhir.create<Invoice>({
    resourceType: "Invoice",
    status: "issued",
    subject: { reference: input.patientReference },
    date: consumedAt,
    participant: [dataEntryParticipant(input.staffReference)],
    lineItem: [{
      sequence: 1,
      chargeItemReference: { reference: input.chargeItemReference },
      priceComponent: [{ type: "base", amount: usd(amountCents) }],
    }],
    totalGross: usd(amountCents),
    totalNet: usd(amountCents),
  });
  if (!invoice.id) throw new Error("Package redemption Invoice creation did not return an id.");
  const payment = await fhir.create<PaymentReconciliation>(buildPaymentReconciliation({
    outcome: "success",
    createdIso: consumedAt,
    paymentDate: consumedAt.slice(0, 10),
    amountCents,
    subjectReference: input.patientReference,
    invoiceReference: `Invoice/${invoice.id}`,
    staffReference: input.staffReference,
    processorTransactionId: `${input.packageInstanceId}:${procedureId}`,
    processorTransactionSystem: ODOS_PACKAGE_CREDIT_TRANSACTION_SYSTEM,
    surface: "manual",
    tender: { code: ODOS_PACKAGE_CREDIT_TENDER_CODE, display: "Package credit" },
    description: `Package credit for ${procedure.code?.text ?? procedureCodes[0]}`,
  }));
  if (!payment.id) throw new Error("Package credit PaymentReconciliation creation did not return an id.");
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
    _count: "2",
  });
  return (reconciliations.entry ?? []).some((entry) => entry.resource?.outcome === "complete");
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
