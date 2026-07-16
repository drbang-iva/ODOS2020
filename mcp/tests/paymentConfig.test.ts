import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import { createPaymentDispatch } from "../src/payments/payment-config.js";
import { CLOVER_SANDBOX_BASE_URL } from "../src/payments/adapters/clover-adapter.js";

const CLOVER_CONFIG = {
  baseUrl: CLOVER_SANDBOX_BASE_URL,
  accessToken: "tok",
  deviceId: "DEV1",
  posId: "ODOS",
};
const STRIPE_CONFIG = { baseUrl: "https://api.stripe.com", secretKey: "sk_test_dispatch" };

function fakeFhir() {
  return {
    read: async <T,>(): Promise<T> => ({}) as T,
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({ resourceType: "Bundle", type: "searchset" }),
    update: async <T,>(_rt: string, _id: string, r: T): Promise<T> => r,
    create: async <T,>(r: T): Promise<T> => ({ ...(r as object), id: "pr-1" }) as T,
  };
}

test("getAdapter resolves the configured method to its adapter instance (unified backend — cash + card share one dispatch)", () => {
  const dispatch = createPaymentDispatch([
    { method: "manual-cash" },
    { method: "clover", config: CLOVER_CONFIG },
    { method: "stripe", config: STRIPE_CONFIG },
  ]);

  const cash = dispatch.getAdapter("manual-cash", fakeFhir());
  assert.equal(cash.name, "manual-cash");
  assert.equal(cash.surface, "manual");

  const clover = dispatch.getAdapter("clover", fakeFhir());
  assert.equal(clover.name, "clover");
  assert.equal(clover.surface, "in-clinic-pos");

  const stripe = dispatch.getAdapter("stripe", fakeFhir());
  assert.equal(stripe.name, "stripe");
  assert.equal(stripe.surface, "online");
});

test("methods() lists exactly the registered, enabled payment methods (drives the practice's checkout buttons)", () => {
  const dispatch = createPaymentDispatch([
    { method: "manual-cash" },
    { method: "clover", config: CLOVER_CONFIG },
    { method: "stripe", config: STRIPE_CONFIG },
  ]);
  assert.deepEqual(dispatch.methods().sort(), ["clover", "manual-cash", "stripe"]);
});

test("getAdapter throws for a method the practice has not configured", () => {
  const dispatch = createPaymentDispatch([{ method: "manual-cash" }]);
  assert.throws(() => dispatch.getAdapter("clover", fakeFhir()), /clover.*not configured|not configured.*clover/i);
});

test("the resolved clover adapter is wired with the registered config + injected transport (charges the configured base URL)", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ payment: { id: "CLOV1", result: "SUCCESS", amount: 5000 } }),
      text: async () => "",
    };
  }) as typeof fetch;

  const created: PaymentReconciliation[] = [];
  const fhir = {
    ...fakeFhir(),
    create: async <T,>(r: T): Promise<T> => {
      created.push(r as PaymentReconciliation);
      return { ...(r as object), id: "pr-9" } as T;
    },
  };

  const dispatch = createPaymentDispatch([{ method: "clover", config: CLOVER_CONFIG }], {
    fetchImpl,
    now: () => "2026-07-05T18:00:00.000Z",
    generateId: () => "fixed-id",
  });

  const adapter = dispatch.getAdapter("clover", fhir);
  const result = await adapter.charge({
    amountCents: 5000,
    currency: "USD",
    patientReference: "Patient/p1",
    invoiceReference: "Invoice/inv1",
    staffReference: "Practitioner/staff1",
    description: "card",
    surface: "in-clinic-pos",
  });

  assert.equal(result.outcome, "success");
  assert.equal(calls[0], `${CLOVER_SANDBOX_BASE_URL}/connect/v1/payments`);
  assert.equal(created.length, 1);
  assert.equal(created[0].paymentIdentifier?.value, "CLOV1");
});

test("createPaymentDispatch with no registrations exposes no methods and resolves nothing", () => {
  const dispatch = createPaymentDispatch([]);
  assert.deepEqual(dispatch.methods(), []);
  assert.throws(() => dispatch.getAdapter("manual-cash", fakeFhir()), /not configured/i);
});
