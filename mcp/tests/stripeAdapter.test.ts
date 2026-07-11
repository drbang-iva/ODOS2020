import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentReconciliation } from "@medplum/fhirtypes";
import {
  createStripeAdapter,
  STRIPE_TRANSACTION_SYSTEM,
} from "../src/payments/adapters/stripe-adapter.js";
import type { ChargeRequest } from "../src/payments/payment-processor-adapter.js";
import { OSOD_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/osodPaymentTender.js";

const CONFIG = { baseUrl: "https://api.stripe.com", secretKey: "sk_test_osod_fixture" };

function chargeRequest(overrides?: Partial<ChargeRequest>): ChargeRequest {
  return {
    amountCents: 5000,
    currency: "USD",
    patientReference: "Patient/p1",
    invoiceReference: "Invoice/inv1",
    taskReference: "Task/task1",
    staffReference: "Practitioner/staff1",
    description: "Optical order card payment",
    surface: "online",
    onlinePaymentToken: "pm_card_visa",
    ...overrides,
  };
}

interface CapturedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: URLSearchParams;
}

function fakeTransport(responses: Array<{ status: number; body: unknown }>) {
  const captured: CapturedFetch[] = [];
  const fetchImpl = (async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      form: new URLSearchParams(init?.body ?? ""),
    });
    const response = responses.shift();
    if (!response) throw new Error("No fake Stripe response configured");
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  }) as typeof fetch;
  return { captured, fetchImpl };
}

function fakeFhir() {
  const created: PaymentReconciliation[] = [];
  return {
    created,
    create: async <T,>(resource: T): Promise<T> => {
      created.push(resource as PaymentReconciliation);
      return { ...(resource as object), id: `pr-server-${created.length}` } as T;
    },
  };
}

test("adapter is test-mode online Stripe and does not require a PHI-vendor BAA", () => {
  const adapter = createStripeAdapter(CONFIG, fakeFhir());
  assert.equal(adapter.name, "stripe");
  assert.equal(adapter.surface, "online");
  assert.equal(adapter.vendorBaaRequired, false);
  assert.throws(
    () => createStripeAdapter({ ...CONFIG, secretKey: "sk_live_forbidden" }, fakeFhir()),
    /test-mode/,
  );
  assert.throws(
    () => createStripeAdapter({ ...CONFIG, baseUrl: "http://stripe-proxy.test" }, fakeFhir()),
    /HTTPS/,
  );
});

test("successful create+confirm charge persists only the Stripe PaymentIntent id", async () => {
  const { captured, fetchImpl } = fakeTransport([
    {
      status: 200,
      body: {
        id: "pi_success",
        object: "payment_intent",
        amount_received: 5000,
        created: 1783771200,
        status: "succeeded",
      },
    },
  ]);
  const fhir = fakeFhir();
  const adapter = createStripeAdapter(CONFIG, fhir, {
    fetchImpl,
    now: () => "2026-07-11T15:00:00.000Z",
    generateId: () => "idem-charge-1",
  });

  const result = await adapter.charge(chargeRequest());

  assert.equal(captured[0].url, "https://api.stripe.com/v1/payment_intents");
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].headers.Authorization, "Bearer sk_test_osod_fixture");
  assert.equal(captured[0].headers["Idempotency-Key"], "idem-charge-1");
  assert.equal(captured[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(captured[0].form.get("amount"), "5000");
  assert.equal(captured[0].form.get("currency"), "usd");
  assert.equal(captured[0].form.get("payment_method"), "pm_card_visa");
  assert.equal(captured[0].form.get("payment_method_types[]"), "card");
  assert.equal(captured[0].form.get("confirm"), "true");
  assert.equal(captured[0].form.has("description"), false);
  assert.equal(captured[0].form.has("metadata"), false);

  assert.equal(result.outcome, "success");
  assert.equal(result.transactionId, "pi_success");
  assert.deepEqual(result.paymentRecord, { resourceType: "PaymentReconciliation", id: "pr-server-1" });
  assert.equal(fhir.created.length, 1);
  const pr = fhir.created[0];
  assert.equal(pr.paymentIdentifier?.system, STRIPE_TRANSACTION_SYSTEM);
  assert.equal(pr.paymentIdentifier?.value, "pi_success");
  assert.equal(pr.detail?.[0]?.request?.reference, "Invoice/inv1");
  assert.equal(
    pr.extension?.find((e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL)
      ?.valueCodeableConcept?.coding?.[0]?.code,
    "STRIPE",
  );
  const persisted = JSON.stringify(pr);
  assert.ok(!persisted.includes("pm_card_visa"));
  assert.ok(!persisted.includes(CONFIG.secretKey));
});

test("Stripe card_error decline creates no financial record and preserves documented decline fields", async () => {
  const { fetchImpl } = fakeTransport([
    {
      status: 402,
      body: {
        error: {
          type: "card_error",
          code: "card_declined",
          decline_code: "generic_decline",
          message: "Your card was declined.",
          payment_intent: { id: "pi_declined", status: "requires_payment_method" },
        },
      },
    },
  ]);
  const fhir = fakeFhir();
  const result = await createStripeAdapter(CONFIG, fhir, { fetchImpl }).charge(
    chargeRequest({ onlinePaymentToken: "pm_card_visa_chargeDeclined" }),
  );

  assert.equal(result.outcome, "declined");
  assert.equal(result.transactionId, "pi_declined");
  assert.equal(result.declineCode, "generic_decline");
  assert.equal(result.declineReason, "Your card was declined.");
  assert.equal(result.paymentRecord, undefined);
  assert.equal(fhir.created.length, 0);
});

test("successful partial refund uses the PaymentIntent id and amount", async () => {
  const { captured, fetchImpl } = fakeTransport([
    { status: 200, body: { id: "re_123", status: "succeeded", payment_intent: "pi_success" } },
  ]);
  const adapter = createStripeAdapter(CONFIG, fakeFhir(), {
    fetchImpl,
    generateId: () => "idem-refund-1",
  });

  const result = await adapter.refund({
    transactionId: "pi_success",
    amountCents: 1200,
    reason: "Patient returned item",
    staffReference: "Practitioner/staff1",
  });

  assert.deepEqual(result, { refundId: "re_123", outcome: "success" });
  assert.equal(captured[0].url, "https://api.stripe.com/v1/refunds");
  assert.equal(captured[0].form.get("payment_intent"), "pi_success");
  assert.equal(captured[0].form.get("amount"), "1200");
  assert.equal(captured[0].form.has("reason"), false);
  assert.equal(captured[0].headers["Idempotency-Key"], "idem-refund-1");
});

test("refund rejects a blank PaymentIntent id before calling Stripe", async () => {
  const { captured, fetchImpl } = fakeTransport([]);
  const adapter = createStripeAdapter(CONFIG, fakeFhir(), { fetchImpl });

  await assert.rejects(
    () =>
      adapter.refund({
        transactionId: "  ",
        amountCents: 1200,
        reason: "Patient returned item",
        staffReference: "Practitioner/staff1",
      }),
    /PaymentIntent id/,
  );
  assert.equal(captured.length, 0);
});

test("void cancels an uncaptured PaymentIntent", async () => {
  const { captured, fetchImpl } = fakeTransport([
    { status: 200, body: { id: "pi_uncaptured", status: "canceled" } },
  ]);
  const adapter = createStripeAdapter(CONFIG, fakeFhir(), {
    fetchImpl,
    generateId: () => "idem-void-1",
  });

  assert.deepEqual(
    await adapter.void({ transactionId: "pi_uncaptured", staffReference: "Practitioner/staff1" }),
    { outcome: "success" },
  );
  assert.equal(
    captured[0].url,
    "https://api.stripe.com/v1/payment_intents/pi_uncaptured/cancel",
  );
  assert.equal(captured[0].form.get("cancellation_reason"), "requested_by_customer");
  assert.equal(captured[0].headers["Idempotency-Key"], "idem-void-1");
});

test("status maps PaymentIntent lifecycle states and settle refuses to invent a batch", async () => {
  const { captured, fetchImpl } = fakeTransport([
    { status: 200, body: { id: "pi_auth", status: "requires_capture" } },
    { status: 200, body: { id: "pi_paid", status: "succeeded" } },
    { status: 200, body: { id: "pi_void", status: "canceled" } },
  ]);
  const adapter = createStripeAdapter(CONFIG, fakeFhir(), { fetchImpl });

  assert.equal(await adapter.status("pi_auth"), "authorized");
  assert.equal(await adapter.status("pi_paid"), "captured");
  assert.equal(await adapter.status("pi_void"), "voided");
  assert.equal(captured[0].method, "GET");
  assert.equal(captured[0].headers["Idempotency-Key"], undefined);
  await assert.rejects(() => adapter.settle({ settlementDate: "2026-07-11" }), /no SettlementBatch analog/);
});

test("charge validates amount, Invoice reference, and transient token before calling Stripe", async () => {
  const { captured, fetchImpl } = fakeTransport([]);
  const adapter = createStripeAdapter(CONFIG, fakeFhir(), { fetchImpl });

  await assert.rejects(() => adapter.charge(chargeRequest({ amountCents: 0 })), /amountCents/);
  await assert.rejects(() => adapter.charge(chargeRequest({ invoiceReference: "inv1" })), /Invoice\//);
  await assert.rejects(() => adapter.charge(chargeRequest({ onlinePaymentToken: undefined })), /onlinePaymentToken/);
  assert.equal(captured.length, 0);
});
