import { randomUUID } from "node:crypto";
import type { PaymentReconciliation } from "@medplum/fhirtypes";
import type { MedplumClient } from "../../fhir-client.js";
import { buildPaymentReconciliation } from "../payment-reconciliation.js";
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

/**
 * Clover REST Pay Display adapter (cloud connection) — the in-clinic dispensary card-present
 * surface. The physical Clover device (Flex / Mini / Compact) collects the card; ODOS only
 * dispatches the charge and receives the outcome, so no PAN/CVV/track data ever enters ODOS
 * (PCI scope minimization). On SUCCESS the adapter settles the Invoice by creating the
 * PaymentReconciliation (seam spec §2/§5); declined/failed charges create no financial record.
 *
 * Endpoint shapes doc-verified 2026-07-05 against docs.clover.com (rest-pay-overview,
 * rest-pay-development-basics, making-a-sale, refunding-a-charge): POST
 * {base}/connect/v1/payments with an OAuth expiring token (NOT a static merchant token),
 * X-Clover-Device-Id (device serial), X-POS-Id, and an Idempotency-Key. Sandbox base URL is
 * https://apisandbox.dev.clover.com; sandbox setup (developer account, test merchant,
 * semi-integrated app + Remote App ID, OAuth token, Dev Kit device) is an operator step —
 * see docs/payments-clover-sandbox.md.
 */

export const CLOVER_SANDBOX_BASE_URL = "https://apisandbox.dev.clover.com";

/** Identifier namespace for Clover payment ids carried on PaymentReconciliation.paymentIdentifier. */
export const CLOVER_TRANSACTION_SYSTEM = "https://odos2020.com/fhir/NamingSystem/clover-payment";

export interface CloverAdapterConfig {
  /** REST Pay Display base URL (sandbox: CLOVER_SANDBOX_BASE_URL). Never hardcoded in callers. */
  baseUrl: string;
  /**
   * OAuth-generated expiring access token (docs: "not a merchant token"). Runtime-injected from
   * the practice secrets store; used for the Authorization header only and never persisted to
   * any FHIR resource or log.
   */
  accessToken: string;
  /** Target device serial (X-Clover-Device-Id) — also recorded as the surface terminal-id. */
  deviceId: string;
  /** POS identity string (X-POS-Id). */
  posId: string;
  /** The practice merchant Organization reference for PaymentReconciliation.paymentIssuer. */
  practiceOrgReference?: string;
}

export interface CloverAdapterDeps {
  /** Injected transport for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected clock (ISO dateTime) for deterministic tests; defaults to system time. */
  now?: () => string;
  /** Injected id source for Idempotency-Key / externalPaymentId; defaults to randomUUID. */
  generateId?: () => string;
}

/** Shape of the REST Pay Display make-a-sale response we consume (docs make-a-sale sample). */
interface CloverPaymentResponse {
  payment?: {
    id?: string;
    result?: string;
    amount?: number;
    createdTime?: number;
    cardTransaction?: { cardType?: string; last4?: string };
  };
  message?: string;
}

export function createCloverAdapter(
  config: CloverAdapterConfig,
  fhir: Pick<MedplumClient, "create">,
  deps?: CloverAdapterDeps,
): PaymentProcessorAdapter {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.now ?? (() => new Date().toISOString());
  const generateId = deps?.generateId ?? (() => randomUUID());

  return {
    name: "clover",
    surface: "in-clinic-pos",
    vendorBaaRequired: true,

    async charge(args: ChargeRequest): Promise<TransactionResult> {
      if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
        throw new Error("Charge amount (amountCents) must be a positive integer number of cents.");
      }
      if (args.invoiceReference !== undefined && !/^Invoice\/[^/]+$/.test(args.invoiceReference)) {
        throw new Error(
          `Charge invoiceReference must be a local "Invoice/<id>" reference; got "${args.invoiceReference}".`,
        );
      }

      const externalPaymentId = `odos-${generateId()}`;
      const response = await fetchImpl(`${config.baseUrl}/connect/v1/payments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "X-Clover-Device-Id": config.deviceId,
          "X-POS-Id": config.posId,
          "Idempotency-Key": generateId(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: args.amountCents,
          externalPaymentId,
          final: true,
        }),
      });

      if (!response.ok) {
        return {
          transactionId: externalPaymentId,
          outcome: "failed",
          amountChargedCents: 0,
          feesCents: 0,
          declineReason: `Clover REST Pay request failed with HTTP ${response.status}.`,
        };
      }

      const body = (await response.json()) as CloverPaymentResponse;
      const payment = body.payment;
      if (payment?.result !== "SUCCESS") {
        return {
          transactionId: payment?.id ?? externalPaymentId,
          outcome: "declined",
          amountChargedCents: 0,
          feesCents: 0,
          declineCode: payment?.result,
          declineReason: body.message ?? `Clover device returned result "${payment?.result ?? "unknown"}".`,
        };
      }
      if (!payment.id) {
        throw new Error("Clover reported SUCCESS without a payment id — cannot record the settlement.");
      }

      const amountChargedCents = payment.amount ?? args.amountCents;
      const card = payment.cardTransaction;
      const chargedAt = now();
      const paymentReconciliation = buildPaymentReconciliation({
        outcome: "success",
        createdIso: chargedAt,
        paymentDate: (payment.createdTime ? new Date(payment.createdTime).toISOString() : chargedAt).slice(0, 10),
        amountCents: amountChargedCents,
        subjectReference: args.patientReference,
        invoiceReference: args.invoiceReference,
        taskReference: args.taskReference,
        staffReference: args.staffReference,
        processorTransactionId: payment.id,
        processorTransactionSystem: CLOVER_TRANSACTION_SYSTEM,
        surface: "in-clinic-pos",
        tender: {
          code: "CLOVER",
          ...(card?.cardType && card?.last4 ? { display: `${card.cardType} ****${card.last4}` } : {}),
        },
        inClinicTerminalId: config.deviceId,
        practiceOrgReference: config.practiceOrgReference,
        description: args.description,
      });
      const created = await fhir.create<PaymentReconciliation>(paymentReconciliation);

      return {
        transactionId: payment.id,
        paymentRecord: { resourceType: "PaymentReconciliation", id: created.id! },
        outcome: "success",
        amountChargedCents,
        feesCents: 0,
      };
    },

    async refund(_args: RefundRequest): Promise<RefundResult> {
      throw new Error(
        "Clover refunds are deferred to the v0.7 refund authorization workflow (endpoint: POST /connect/v1/payments/{paymentId}/refunds).",
      );
    },

    async void(args: VoidRequest): Promise<VoidResult> {
      if (!args.transactionId) {
        throw new Error("A Clover void requires the processor transaction id.");
      }
      const response = await fetchImpl(
        `${config.baseUrl}/connect/v1/payments/${encodeURIComponent(args.transactionId)}/void`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "X-Clover-Device-Id": config.deviceId,
            "X-POS-Id": config.posId,
            "Idempotency-Key": generateId(),
            "User-Agent": "ODOS/0.6c",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ voidReason: "USER_CANCEL" }),
        },
      );
      return { outcome: response.status === 200 ? "success" : "failed" };
    },

    async settle(_args: SettleRequest): Promise<SettlementBatch> {
      throw new Error(
        "Clover settlement-batch reconciliation is deferred to v0.7 (daily closeout matched against local PaymentReconciliations).",
      );
    },

    async status(_transactionId: string): Promise<TransactionState> {
      throw new Error("Clover transaction status lookup is deferred to v0.7.");
    },
  };
}
