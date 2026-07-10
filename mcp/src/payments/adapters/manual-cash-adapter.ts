import { randomUUID } from "node:crypto";
import type { Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import type { MedplumClient } from "../../fhir-client.js";
import {
  OSOD_PAYMENT_TENDER_EXTENSION_URL,
  assertPaymentTender,
  paymentTenderExtension,
} from "../../fhir/osodPaymentTender.js";
import type {
  ChargeRequest,
  PaymentProcessorAdapter,
  RefundRequest,
  RefundResult,
  SettleRequest,
  SettlementBatch,
  TransactionResult,
  TransactionState,
  VoidRequest,
  VoidResult,
} from "../payment-processor-adapter.js";
import { buildPaymentReconciliation } from "../payment-reconciliation.js";

export const MANUAL_PAYMENT_SYSTEM = "https://osod.dev/fhir/NamingSystem/manual-payment";

/**
 * The manual cash/check adapter — the shipped Slice-3 cash path formalized behind the
 * PaymentProcessorAdapter interface. Zero vendor, zero new money movement.
 *
 * charge() records the tender on the Invoice's osod-payment-tender extension and balances the bill
 * when fully paid. Per the seam spec §4, a manual tender emits NO PaymentReconciliation — the
 * tendered Invoice IS the canonical payment record (cash never settles through a processor batch;
 * the absence of a PR is the correct answer for v0.7 settlement reconciliation). The exactly-one-
 * source invariant (§3) is enforced here: an Invoice that already carries a tender cannot be
 * charged again through this adapter.
 */

export interface ManualCashAdapterOptions {
  /** Injected clock (ISO dateTime) for deterministic tests; defaults to system time. */
  now?: () => string;
}

export function createManualCashAdapter(
  fhir: Pick<MedplumClient, "read" | "update" | "create">,
  options?: ManualCashAdapterOptions,
): PaymentProcessorAdapter {
  const now = options?.now ?? (() => new Date().toISOString());

  return {
    name: "manual-cash",
    surface: "manual",
    vendorBaaRequired: false,

    async charge(args: ChargeRequest): Promise<TransactionResult> {
      if (!args.tender?.code) {
        throw new Error("A manual cash charge requires a tender (CASH or CHECK).");
      }
      assertPaymentTender(args.tender.code);
      if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
        throw new Error("Charge amount (amountCents) must be a positive integer number of cents.");
      }
      if (args.invoiceReference === undefined) {
        const transactionId = `manual-${randomUUID()}`;
        const chargedAt = now();
        const created = await fhir.create<PaymentReconciliation>(
          buildPaymentReconciliation({
            outcome: "success",
            createdIso: chargedAt,
            paymentDate: chargedAt.slice(0, 10),
            amountCents: args.amountCents,
            subjectReference: args.patientReference,
            staffReference: args.staffReference,
            processorTransactionId: transactionId,
            processorTransactionSystem: MANUAL_PAYMENT_SYSTEM,
            surface: "manual",
            tender: args.tender,
            description: args.description,
          }),
        );
        return {
          transactionId,
          paymentRecord: { resourceType: "PaymentReconciliation", id: created.id! },
          outcome: "success",
          amountChargedCents: args.amountCents,
          feesCents: 0,
          settlementDate: chargedAt.slice(0, 10),
        };
      }
      const invoiceId = invoiceIdFromReference(args.invoiceReference);

      const invoice = await fhir.read<Invoice>("Invoice", invoiceId);
      const existingTender = invoice.extension?.some(
        (ext) => ext.url === OSOD_PAYMENT_TENDER_EXTENSION_URL,
      );
      if (existingTender) {
        throw new Error(
          `Invoice/${invoiceId} already carries a payment tender — payments come from exactly one source (seam spec §3).`,
        );
      }

      const netCents = Math.round((invoice.totalNet?.value ?? NaN) * 100);
      if (!Number.isFinite(netCents)) {
        throw new Error(`Invoice/${invoiceId} has no totalNet — cannot record a payment against it.`);
      }

      const paidInFull = args.amountCents >= netCents;
      const chargedAt = now();
      const updated: Invoice = {
        ...invoice,
        extension: [...(invoice.extension ?? []), paymentTenderExtension(args.tender.code)],
        ...(paidInFull ? { status: "balanced" as const } : {}),
      };
      await fhir.update<Invoice>("Invoice", invoiceId, updated);

      return {
        transactionId: `manual-${randomUUID()}`,
        paymentRecord: { resourceType: "Invoice", id: invoiceId },
        outcome: "success",
        amountChargedCents: args.amountCents,
        feesCents: 0,
        settlementDate: chargedAt.slice(0, 10),
      };
    },

    async refund(_args: RefundRequest): Promise<RefundResult> {
      throw new Error("Manual refunds are deferred to the v0.7 refund authorization workflow.");
    },

    async void(_args: VoidRequest): Promise<VoidResult> {
      return { outcome: "success" };
    },

    async settle(_args: SettleRequest): Promise<SettlementBatch> {
      throw new Error(
        "Manual cash does not batch-settle; till/deposit reconciliation is deferred to v0.7.",
      );
    },

    async status(_transactionId: string): Promise<TransactionState> {
      throw new Error("Manual transaction status lookup is deferred to v0.7 (no processor ledger).");
    },
  };
}

function invoiceIdFromReference(reference: string): string {
  const match = reference?.match(/^Invoice\/([^/]+)$/);
  if (!match) {
    throw new Error(`Charge invoiceReference must be a local "Invoice/<id>" reference; got "${reference}".`);
  }
  return match[1];
}
