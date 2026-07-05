import type { Extension, PaymentReconciliation } from "@medplum/fhirtypes";
import { paymentTenderExtensionForReconciliation } from "../fhir/osodPaymentTender.js";
import type { PaymentSurface } from "./payment-processor-adapter.js";

/**
 * FHIR R4 PaymentReconciliation emitter — the settling payment for a processor charge.
 *
 * The Invoice is the bill; this resource is the payment that settles it, linked via
 * detail[0].request → Invoice (R4-verified: detail.request targets Any). Manual cash/check tenders
 * do NOT come through here — they live on the Invoice's osod-payment-tender extension (Slice-3
 * trap #2 preserved). Contract: performance-od
 * decisions/2026-07-05-odos-payment-reconciliation-seam-spec.md §5.
 */

export const OSOD_PROCESSOR_FEES_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-processor-fees";

export const OSOD_PAYMENT_SURFACE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-payment-surface";

/** HL7 payment-type CodeSystem for PaymentReconciliation.detail.type (payment | adjustment | advance). */
export const HL7_PAYMENT_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/payment-type";

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
  /** The bill this payment settles — detail[0].request (THE LINK, seam spec §2). */
  invoiceReference: string;
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
  if (!input.invoiceReference) {
    throw new Error("A PaymentReconciliation requires the Invoice reference it settles (the bill).");
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
    detail: [
      {
        type: {
          coding: [{ system: HL7_PAYMENT_TYPE_SYSTEM, code: "payment", display: "Payment" }],
        },
        request: { reference: input.invoiceReference },
        amount,
      },
    ],
    extension: [
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
