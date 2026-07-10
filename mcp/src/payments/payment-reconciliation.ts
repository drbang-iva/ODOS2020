import type { Extension, PaymentReconciliation } from "@medplum/fhirtypes";
import { paymentTenderExtensionForReconciliation } from "../fhir/osodPaymentTender.js";
import type { PaymentSurface } from "./payment-processor-adapter.js";

/**
 * FHIR R4 PaymentReconciliation emitter — the collected patient payment.
 *
 * An immediate payment links to its Invoice through detail[].request. A pre-payment has an empty
 * detail[] until charges post. Manual cash/check still lives on the Invoice when the bill already
 * exists; only the no-Invoice-yet exception emits a PaymentReconciliation. Contract: performance-od
 * decisions/2026-07-09-odos-unapplied-credit-seam-addendum.md §2-§3.
 */

export const OSOD_PROCESSOR_FEES_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-processor-fees";

export const OSOD_PAYMENT_SURFACE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-payment-surface";

export const OSOD_PAYMENT_SUBJECT_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-payment-subject";

/** HL7 payment-type CodeSystem for PaymentReconciliation.detail.type (payment | adjustment | advance). */
export const HL7_PAYMENT_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/payment-type";

/** Identifier namespace for Claim.MD ERA ids carried on insurance PaymentReconciliations. */
export const CLAIMMD_ERA_PAYMENT_SYSTEM = "https://osod.dev/fhir/NamingSystem/claimmd-era";

export interface PatientPaymentAllocationInput {
  invoiceReference: string;
  amountCents: number;
}

export interface ProcessorPaymentInput {
  /**
   * Only money that moved gets a PaymentReconciliation: success (settled) or pending
   * (authorized, unsettled). A declined/failed charge is recorded as a payment.charge.failed
   * AuditEvent only.
   */
  outcome: "success" | "pending";
  /** PaymentReconciliation.created (R4 dateTime, ISO). */
  createdIso: string;
  /** Date on the financial instrument, YYYY-MM-DD (R4 date). Settlement date, else charge date. */
  paymentDate: string;
  /** Amount charged in whole cents. */
  amountCents: number;
  /** The Patient account that owns the payment or unapplied credit. */
  subjectReference: string;
  /** Existing bill settled immediately. Omit for a pre-payment with no Invoice yet. */
  invoiceReference?: string;
  /** Explicit plural allocations. Omit to use invoiceReference or to collect fully unapplied. */
  allocations?: PatientPaymentAllocationInput[];
  /** The order's 17-status lifecycle Task (PaymentReconciliation.request). */
  taskReference?: string;
  /** The staff member who initiated the transaction (PaymentReconciliation.requestor). */
  staffReference?: string;
  /** The processor's transaction id (PaymentReconciliation.paymentIdentifier.value). */
  processorTransactionId: string;
  /** Adapter transaction-id namespace (PaymentReconciliation.paymentIdentifier.system). */
  processorTransactionSystem: string;
  /** Processor fees in whole cents (osod-processor-fees extension; v0.7 settlement recon input). */
  feesCents?: number;
  surface: PaymentSurface;
  /** Receipt tender label: coded tender + optional instrument display (e.g. "VISA ****4242"). */
  tender: { code: string; display?: string };
  /** In-clinic POS terminal hardware reference (non-secret; rides in the surface extension). */
  inClinicTerminalId?: string;
  /** Financing platform's application id (rides in the surface extension). */
  financingApplicationId?: string;
  /** The practice merchant Organization that received the settlement (paymentIssuer). */
  practiceOrgReference?: string;
  /** Human-readable purpose (disposition). */
  description?: string;
}

export function buildPaymentReconciliation(input: ProcessorPaymentInput): PaymentReconciliation {
  if (input.outcome !== "success" && input.outcome !== "pending") {
    throw new Error(
      "A declined/failed charge does not create a PaymentReconciliation — record it as a payment.charge.failed AuditEvent only (seam spec §5).",
    );
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Payment amount (amountCents) must be a positive integer number of cents.");
  }
  if (input.feesCents !== undefined && (!Number.isInteger(input.feesCents) || input.feesCents < 0)) {
    throw new Error("Processor fees (feesCents) must be a nonnegative integer number of cents.");
  }
  if (!/^Patient\/[^/]+$/.test(input.subjectReference)) {
    throw new Error('Payment subject must be a local "Patient/<id>" reference.');
  }
  if (input.invoiceReference !== undefined && !/^Invoice\/[^/]+$/.test(input.invoiceReference)) {
    throw new Error('invoiceReference must be a local "Invoice/<id>" reference when supplied.');
  }
  if (input.invoiceReference !== undefined && input.allocations !== undefined) {
    throw new Error("Supply invoiceReference or allocations, not both.");
  }
  if (!input.processorTransactionId || !input.processorTransactionSystem) {
    throw new Error("A PaymentReconciliation requires the processor transaction id and its namespace.");
  }
  if (!input.createdIso) {
    throw new Error("A PaymentReconciliation requires a created timestamp (createdIso).");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) {
    throw new Error("paymentDate must be an R4 date (YYYY-MM-DD).");
  }

  const amount = { value: input.amountCents / 100, currency: "USD" as const };
  const allocations = input.allocations ?? (input.invoiceReference
    ? [{ invoiceReference: input.invoiceReference, amountCents: input.amountCents }]
    : []);
  let allocatedCents = 0;
  for (const allocation of allocations) {
    if (!/^Invoice\/[^/]+$/.test(allocation.invoiceReference)) {
      throw new Error('Every payment allocation must reference a local "Invoice/<id>".');
    }
    if (!Number.isInteger(allocation.amountCents) || allocation.amountCents <= 0) {
      throw new Error("Payment allocation amountCents must be a positive integer number of cents.");
    }
    allocatedCents += allocation.amountCents;
  }
  if (allocatedCents > input.amountCents) {
    throw new Error(
      `Payment allocations total ${allocatedCents} cents but paymentAmount is only ${input.amountCents} cents.`,
    );
  }

  const surfaceExtension: Extension = {
    url: OSOD_PAYMENT_SURFACE_EXTENSION_URL,
    extension: [
      { url: "surface", valueCode: input.surface },
      ...(input.inClinicTerminalId
        ? [{ url: "terminal-id", valueString: input.inClinicTerminalId }]
        : []),
      ...(input.financingApplicationId
        ? [{ url: "financing-application-id", valueString: input.financingApplicationId }]
        : []),
    ],
  };

  return {
    resourceType: "PaymentReconciliation",
    status: "active",
    outcome: input.outcome === "success" ? "complete" : "queued",
    created: input.createdIso,
    paymentDate: input.paymentDate,
    paymentAmount: amount,
    paymentIdentifier: {
      system: input.processorTransactionSystem,
      value: input.processorTransactionId,
    },
    ...(input.taskReference ? { request: { reference: input.taskReference } } : {}),
    ...(input.staffReference ? { requestor: { reference: input.staffReference } } : {}),
    ...(input.practiceOrgReference
      ? { paymentIssuer: { reference: input.practiceOrgReference } }
      : {}),
    ...(input.description ? { disposition: input.description } : {}),
    detail: allocations.map((allocation) => ({
      type: {
        coding: [{ system: HL7_PAYMENT_TYPE_SYSTEM, code: "payment", display: "Payment" }],
      },
      request: { reference: allocation.invoiceReference },
      amount: { value: allocation.amountCents / 100, currency: "USD" },
    })),
    extension: [
      {
        url: OSOD_PAYMENT_SUBJECT_EXTENSION_URL,
        valueReference: { reference: input.subjectReference },
      },
      paymentTenderExtensionForReconciliation(input.tender),
      ...(input.feesCents !== undefined
        ? [
            {
              url: OSOD_PROCESSOR_FEES_EXTENSION_URL,
              valueMoney: { value: input.feesCents / 100, currency: "USD" as const },
            },
          ]
        : []),
      surfaceExtension,
    ],
  };
}

export interface InsurancePaymentReconciliationInput {
  createdIso: string;
  paymentDate: string;
  amountCents: number;
  claimReference: string;
  claimResponseReference: string;
  insurerReference?: string;
  practiceOrgReference?: string;
  processorTransactionId: string;
  processorTransactionSystem: string;
  description?: string;
}

export function buildInsurancePaymentReconciliation(
  input: InsurancePaymentReconciliationInput,
): PaymentReconciliation {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("Insurance payment amount (amountCents) must be a positive integer number of cents.");
  }
  if (!/^Claim\//.test(input.claimReference)) {
    throw new Error('Insurance PaymentReconciliation detail.request must reference a local "Claim/<id>".');
  }
  if (!/^ClaimResponse\//.test(input.claimResponseReference)) {
    throw new Error('Insurance PaymentReconciliation detail.response must reference a local "ClaimResponse/<id>".');
  }
  if (!input.processorTransactionId || !input.processorTransactionSystem) {
    throw new Error("Insurance PaymentReconciliation requires an ERA/payment identifier and namespace.");
  }
  if (!input.createdIso) {
    throw new Error("Insurance PaymentReconciliation requires a created timestamp.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) {
    throw new Error("paymentDate must be an R4 date (YYYY-MM-DD).");
  }

  const amount = { value: input.amountCents / 100, currency: "USD" as const };

  return {
    resourceType: "PaymentReconciliation",
    status: "active",
    outcome: "complete",
    created: input.createdIso,
    paymentDate: input.paymentDate,
    paymentAmount: amount,
    paymentIdentifier: {
      system: input.processorTransactionSystem,
      value: input.processorTransactionId,
    },
    ...(input.insurerReference ? { paymentIssuer: { reference: input.insurerReference } } : {}),
    ...(input.practiceOrgReference ? { requestor: { reference: input.practiceOrgReference } } : {}),
    ...(input.description ? { disposition: input.description } : {}),
    detail: [
      {
        type: {
          coding: [{ system: HL7_PAYMENT_TYPE_SYSTEM, code: "payment", display: "Payment" }],
        },
        request: { reference: input.claimReference },
        response: { reference: input.claimResponseReference },
        ...(input.practiceOrgReference ? { payee: { reference: input.practiceOrgReference } } : {}),
        amount,
      },
    ],
  };
}
