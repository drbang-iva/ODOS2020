import type { Claim, ClaimResponse, Invoice } from "@medplum/fhirtypes";
import { OSOD_CLAIM_CHARGE_ITEM_EXTENSION_URL } from "./claimmd-fhir.js";

export const OSOD_SOURCE_CLAIM_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-source-claim";
export const PATIENT_RESPONSIBILITY_INVOICE_IDENTIFIER_SYSTEM =
  "https://osod.dev/fhir/NamingSystem/patient-responsibility-invoice";

export function buildPatientResponsibilityInvoice(
  claim: Claim,
  response: ClaimResponse,
): Invoice | undefined {
  const claimReference = localReference(claim, "Claim");
  if (response.request?.reference !== claimReference) {
    throw new Error("ClaimResponse does not reference the source Claim.");
  }
  if (response.outcome === "error") return undefined;
  if (!claim.patient.reference || response.patient.reference !== claim.patient.reference) {
    throw new Error("ClaimResponse patient does not match the source Claim patient.");
  }

  const claimItems = new Map((claim.item ?? []).map((item) => [item.sequence, item]));
  const lineItem = (response.item ?? []).flatMap((responseItem) => {
    const amountCents = patientResponsibilityCents(responseItem.adjudication);
    if (amountCents === 0) return [];
    const claimItem = claimItems.get(responseItem.itemSequence);
    const chargeItemReference = claimItem?.extension?.find(
      (extension) => extension.url === OSOD_CLAIM_CHARGE_ITEM_EXTENSION_URL,
    )?.valueReference?.reference;
    if (!chargeItemReference || !/^ChargeItem\/[A-Za-z0-9.-]+$/.test(chargeItemReference)) {
      throw new PatientResponsibilityInvoiceUnavailableError(
        `Claim item ${responseItem.itemSequence} has patient responsibility but no persisted ChargeItem provenance.`,
      );
    }
    return [{
      sequence: responseItem.itemSequence,
      chargeItemReference: { reference: chargeItemReference },
      priceComponent: [{
        type: "base" as const,
        amount: { value: amountCents / 100, currency: "USD" as const },
      }],
    }];
  });
  const totalCents = lineItem.reduce(
    (sum, line) => sum + moneyCents(line.priceComponent[0].amount.value, line.priceComponent[0].amount.currency),
    0,
  );
  if (totalCents === 0) return undefined;

  return {
    resourceType: "Invoice",
    identifier: [{ system: PATIENT_RESPONSIBILITY_INVOICE_IDENTIFIER_SYSTEM, value: claimReference }],
    status: "issued",
    subject: { reference: claim.patient.reference },
    ...(response.created ? { date: response.created } : {}),
    extension: [{ url: OSOD_SOURCE_CLAIM_EXTENSION_URL, valueReference: { reference: claimReference } }],
    lineItem,
    totalGross: { value: totalCents / 100, currency: "USD" },
    totalNet: { value: totalCents / 100, currency: "USD" },
  };
}

export function patientResponsibilityInvoiceMatches(existing: Invoice, candidate: Invoice): boolean {
  return JSON.stringify(invoiceMoneyShape(existing)) === JSON.stringify(invoiceMoneyShape(candidate));
}

export class PatientResponsibilityInvoiceUnavailableError extends Error {}

function patientResponsibilityCents(
  adjudications: NonNullable<ClaimResponse["item"]>[number]["adjudication"],
): number {
  return adjudications.reduce((sum, adjudication) => {
    const category = adjudication.category.text ?? "";
    return /^adjustment\s+PR(?:\s|$)/i.test(category)
      ? sum + moneyCents(adjudication.amount?.value, adjudication.amount?.currency)
      : sum;
  }, 0);
}

function invoiceMoneyShape(invoice: Invoice): unknown {
  return {
    status: invoice.status,
    subject: invoice.subject?.reference,
    sourceClaim: invoice.extension?.find((extension) => extension.url === OSOD_SOURCE_CLAIM_EXTENSION_URL)
      ?.valueReference?.reference,
    lines: (invoice.lineItem ?? []).map((line) => ({
      sequence: line.sequence,
      chargeItemReference: line.chargeItemReference?.reference,
      baseCents: (line.priceComponent ?? [])
        .filter((component) => component.type === "base")
        .reduce((sum, component) => sum + moneyCents(component.amount?.value, component.amount?.currency), 0),
    })),
    grossCents: moneyCents(invoice.totalGross?.value, invoice.totalGross?.currency),
    netCents: moneyCents(invoice.totalNet?.value, invoice.totalNet?.currency),
  };
}

function localReference(resource: { id?: string }, resourceType: string): string {
  if (!resource.id) throw new Error(`${resourceType} is missing its id.`);
  return `${resourceType}/${resource.id}`;
}

function moneyCents(value: number | undefined, currency: string | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (currency && currency !== "USD")) {
    throw new Error("Patient-responsibility money must be a nonnegative USD amount.");
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    throw new Error("Patient-responsibility money must resolve to whole cents.");
  }
  return cents;
}
