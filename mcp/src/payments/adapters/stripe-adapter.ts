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
 * Stripe PaymentIntents adapter — the card-not-present / online surface. ODOS receives only a
 * processor-created PaymentMethod id, consumes it once, and never persists it. No patient,
 * encounter, invoice, staff, or free-text description data is transmitted to Stripe.
 *
 * Endpoint shapes doc-verified 2026-07-11 against docs.stripe.com: POST /v1/payment_intents with
 * amount, currency, payment_method, payment_method_types[]=card, and confirm=true; POST /v1/refunds
 * with payment_intent and amount; POST /v1/payment_intents/:id/cancel; and GET
 * /v1/payment_intents/:id. Mutating requests carry Idempotency-Key and form-encoded bodies.
 * See docs/payments-stripe-sandbox.md for the exact source URLs and operator setup.
 */

export const STRIPE_BASE_URL = "https://api.stripe.com";

/** Identifier namespace for Stripe PaymentIntent ids on PaymentReconciliation.paymentIdentifier. */
export const STRIPE_TRANSACTION_SYSTEM = "https://odos2020.com/fhir/NamingSystem/stripe-payment-intent";

export interface StripeAdapterConfig {
  /** Stripe API base URL. Defaults to STRIPE_BASE_URL in env-driven registration. */
  baseUrl: string;
  /**
   * Test-mode secret key. Runtime-injected from the practice secrets store; used only in the
   * Authorization header and never persisted to any FHIR resource or log.
   */
  secretKey: string;
  /** The practice merchant Organization reference for PaymentReconciliation.paymentIssuer. */
  practiceOrgReference?: string;
}

export interface StripeAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
  generateId?: () => string;
}

interface StripePaymentError {
  code?: string;
  decline_code?: string;
  message?: string;
}

interface StripePaymentIntent {
  id?: string;
  status?: string;
  amount_received?: number;
  created?: number;
  last_payment_error?: StripePaymentError | null;
}

interface StripeErrorResponse {
  error?: StripePaymentError & { type?: string; payment_intent?: StripePaymentIntent };
}

interface StripeRefund {
  id?: string;
  status?: string | null;
  failure_reason?: string | null;
}

function stripeHeaders(secretKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secretKey}`,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

function normalizedBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Stripe baseUrl must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Stripe baseUrl must use HTTPS because it receives the Stripe secret key.");
  }
  return baseUrl.replace(/\/$/, "");
}

export function assertStripeAdapterConfig(config: StripeAdapterConfig): void {
  if (!config.secretKey.startsWith("sk_test_")) {
    throw new Error("Stripe adapter requires a test-mode secret key beginning with sk_test_.");
  }
  normalizedBaseUrl(config.baseUrl);
}

export function createStripeAdapter(
  config: StripeAdapterConfig,
  fhir: Pick<MedplumClient, "create">,
  deps?: StripeAdapterDeps,
): PaymentProcessorAdapter {
  assertStripeAdapterConfig(config);

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const now = deps?.now ?? (() => new Date().toISOString());
  const generateId = deps?.generateId ?? (() => randomUUID());
  const baseUrl = normalizedBaseUrl(config.baseUrl);

  return {
    name: "stripe",
    surface: "online",
    vendorBaaRequired: false,

    async charge(args: ChargeRequest): Promise<TransactionResult> {
      if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
        throw new Error("Charge amount (amountCents) must be a positive integer number of cents.");
      }
      if (args.invoiceReference !== undefined && !/^Invoice\/[^/]+$/.test(args.invoiceReference)) {
        throw new Error(
          `Charge invoiceReference must be a local "Invoice/<id>" reference; got "${args.invoiceReference}".`,
        );
      }
      if (!args.onlinePaymentToken) {
        throw new Error("Stripe online charges require a transient onlinePaymentToken PaymentMethod id.");
      }

      const idempotencyKey = generateId();
      const form = new URLSearchParams({
        amount: String(args.amountCents),
        currency: args.currency.toLowerCase(),
        payment_method: args.onlinePaymentToken,
        "payment_method_types[]": "card",
        confirm: "true",
      });
      const response = await fetchImpl(`${baseUrl}/v1/payment_intents`, {
        method: "POST",
        headers: stripeHeaders(config.secretKey, idempotencyKey),
        body: form.toString(),
      });
      const body = (await response.json()) as StripePaymentIntent | StripeErrorResponse;

      if (!response.ok) {
        const error = (body as StripeErrorResponse).error;
        const paymentIntent = error?.payment_intent;
        const declined = error?.type === "card_error" || Boolean(error?.decline_code);
        return {
          transactionId: paymentIntent?.id ?? `stripe-attempt-${idempotencyKey}`,
          outcome: declined ? "declined" : "failed",
          amountChargedCents: 0,
          feesCents: 0,
          declineCode: error?.decline_code ?? error?.code,
          declineReason: error?.message ?? `Stripe PaymentIntent request failed with HTTP ${response.status}.`,
        };
      }

      const paymentIntent = body as StripePaymentIntent;
      if (!paymentIntent.id) {
        throw new Error("Stripe returned a PaymentIntent without an id.");
      }
      if (paymentIntent.status !== "succeeded") {
        const error = paymentIntent.last_payment_error;
        if (paymentIntent.status === "requires_payment_method" && error) {
          return {
            transactionId: paymentIntent.id,
            outcome: "declined",
            amountChargedCents: 0,
            feesCents: 0,
            declineCode: error.decline_code ?? error.code,
            declineReason: error.message ?? "Stripe requires a different payment method.",
          };
        }
        if (paymentIntent.status === "processing" || paymentIntent.status === "requires_action") {
          return {
            transactionId: paymentIntent.id,
            outcome: "pending",
            amountChargedCents: 0,
            feesCents: 0,
          };
        }
        return {
          transactionId: paymentIntent.id,
          outcome: "failed",
          amountChargedCents: 0,
          feesCents: 0,
          declineReason: `Stripe PaymentIntent returned status "${paymentIntent.status ?? "unknown"}".`,
        };
      }

      const amountChargedCents = paymentIntent.amount_received ?? args.amountCents;
      const chargedAt = now();
      const paymentReconciliation = buildPaymentReconciliation({
        outcome: "success",
        createdIso: chargedAt,
        paymentDate: (paymentIntent.created
          ? new Date(paymentIntent.created * 1000).toISOString()
          : chargedAt
        ).slice(0, 10),
        amountCents: amountChargedCents,
        subjectReference: args.patientReference,
        invoiceReference: args.invoiceReference,
        taskReference: args.taskReference,
        staffReference: args.staffReference,
        processorTransactionId: paymentIntent.id,
        processorTransactionSystem: STRIPE_TRANSACTION_SYSTEM,
        surface: "online",
        tender: { code: "STRIPE", display: "Stripe online card" },
        practiceOrgReference: config.practiceOrgReference,
        description: args.description,
      });
      const created = await fhir.create<PaymentReconciliation>(paymentReconciliation);

      return {
        transactionId: paymentIntent.id,
        paymentRecord: { resourceType: "PaymentReconciliation", id: created.id! },
        outcome: "success",
        amountChargedCents,
        feesCents: 0,
      };
    },

    async refund(args: RefundRequest): Promise<RefundResult> {
      if (!args.transactionId.trim()) {
        throw new Error("A Stripe refund requires the PaymentIntent id.");
      }
      if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
        throw new Error("Refund amount (amountCents) must be a positive integer number of cents.");
      }
      const form = new URLSearchParams({
        payment_intent: args.transactionId,
        amount: String(args.amountCents),
      });
      const response = await fetchImpl(`${baseUrl}/v1/refunds`, {
        method: "POST",
        headers: stripeHeaders(config.secretKey, generateId()),
        body: form.toString(),
      });
      const body = (await response.json()) as StripeRefund | StripeErrorResponse;
      if (!response.ok) {
        return {
          refundId: "",
          outcome: (body as StripeErrorResponse).error?.decline_code ? "declined" : "failed",
        };
      }
      const refund = body as StripeRefund;
      if (!refund.id) {
        throw new Error("Stripe returned a Refund without an id.");
      }
      return { refundId: refund.id, outcome: refund.status === "succeeded" ? "success" : "failed" };
    },

    async void(args: VoidRequest): Promise<VoidResult> {
      if (!args.transactionId) {
        throw new Error("A Stripe void requires the PaymentIntent id.");
      }
      const form = new URLSearchParams({ cancellation_reason: "requested_by_customer" });
      const response = await fetchImpl(
        `${baseUrl}/v1/payment_intents/${encodeURIComponent(args.transactionId)}/cancel`,
        {
          method: "POST",
          headers: stripeHeaders(config.secretKey, generateId()),
          body: form.toString(),
        },
      );
      if (!response.ok) {
        return { outcome: "failed" };
      }
      const paymentIntent = (await response.json()) as StripePaymentIntent;
      return { outcome: paymentIntent.status === "canceled" ? "success" : "failed" };
    },

    async settle(_args: SettleRequest): Promise<SettlementBatch> {
      throw new Error(
        "Stripe has no SettlementBatch analog in the PaymentIntents API; payout/balance reconciliation is deferred to v0.7.",
      );
    },

    async status(transactionId: string): Promise<TransactionState> {
      const response = await fetchImpl(
        `${baseUrl}/v1/payment_intents/${encodeURIComponent(transactionId)}`,
        { headers: stripeHeaders(config.secretKey) },
      );
      if (!response.ok) {
        return "unknown";
      }
      const paymentIntent = (await response.json()) as StripePaymentIntent;
      switch (paymentIntent.status) {
        case "requires_capture":
          return "authorized";
        case "succeeded":
          return "captured";
        case "canceled":
          return "voided";
        case "requires_payment_method":
          return paymentIntent.last_payment_error ? "declined" : "failed";
        default:
          return "unknown";
      }
    },
  };
}
