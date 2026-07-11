import type { MedplumClient } from "../fhir-client.js";
import { createManualCashAdapter } from "./adapters/manual-cash-adapter.js";
import { createCloverAdapter, type CloverAdapterConfig } from "./adapters/clover-adapter.js";
import { createStripeAdapter, type StripeAdapterConfig } from "./adapters/stripe-adapter.js";
import type { PaymentProcessorAdapter } from "./payment-processor-adapter.js";

/**
 * Payment dispatch — the vendor-neutral resolver that maps a practice's configured payment method
 * to its concrete adapter, wired with the per-request FHIR client + injected transport/clock.
 *
 * This is the unified backend seam (decision 2026-07-05, operator-confirmed): every tender resolves
 * through one dispatch, so cash and card share a single charge path server-side even though the
 * dispensary UI keeps taking cash on its resilient client-side rail. Per-practice adapter config
 * persistence (`osod_payment_adapter_config` + secrets store) is deferred per the 2026-05-05
 * architecture; registrations are constructed at service start from that config.
 */

export type AdapterRegistration =
  | { method: "manual-cash" }
  | { method: "clover"; config: CloverAdapterConfig }
  | { method: "stripe"; config: StripeAdapterConfig };

export interface PaymentDispatchDeps {
  fetchImpl?: typeof fetch;
  now?: () => string;
  generateId?: () => string;
}

/** The per-request FHIR client the resolved adapter uses (bound to the caller in the endpoint). */
export type DispatchFhirClient = Pick<MedplumClient, "read" | "search" | "update" | "create">;

export interface PaymentDispatch {
  /** Resolve the configured adapter for a method, wired with the caller's FHIR client. */
  getAdapter(method: string, fhir: DispatchFhirClient): PaymentProcessorAdapter;
  /** The registered, enabled methods (drives which checkout buttons the practice shows). */
  methods(): string[];
}

export function createPaymentDispatch(
  registrations: AdapterRegistration[],
  deps: PaymentDispatchDeps = {},
): PaymentDispatch {
  const byMethod = new Map<string, AdapterRegistration>(
    registrations.map((registration) => [registration.method, registration]),
  );

  return {
    methods() {
      return [...byMethod.keys()];
    },

    getAdapter(method: string, fhir: DispatchFhirClient): PaymentProcessorAdapter {
      const registration = byMethod.get(method);
      if (!registration) {
        throw new Error(`Payment method "${method}" is not configured for this practice.`);
      }
      switch (registration.method) {
        case "manual-cash":
          return createManualCashAdapter(fhir, { now: deps.now });
        case "clover":
          return createCloverAdapter(registration.config, fhir, {
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            generateId: deps.generateId,
          });
        case "stripe":
          return createStripeAdapter(registration.config, fhir, {
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            generateId: deps.generateId,
          });
        default: {
          const exhaustive: never = registration;
          throw new Error(`Unhandled payment adapter registration: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  };
}
