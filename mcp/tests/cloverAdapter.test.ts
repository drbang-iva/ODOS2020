import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentReconciliation } from "@medplum/fhirtypes";
import {
  CLOVER_TRANSACTION_SYSTEM,
  createCloverAdapter,
} from "../src/payments/adapters/clover-adapter.js";
import type { ChargeRequest } from "../src/payments/payment-processor-adapter.js";
import { OSOD_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/osodPaymentTender.js";
import { OSOD_PAYMENT_SURFACE_EXTENSION_URL } from "../src/payments/payment-reconciliation.js";

/**
 * Clover REST Pay Display (cloud) adapter tests. Endpoint shapes doc-verified 2026-07-05 against
 * docs.clover.com (rest-pay-overview, rest-pay-development-basics, making-a-sale, refunding-a-charge):
 * POST {base}/connect/v1/payments with OAuth bearer + X-Clover-Device-Id + X-POS-Id + Idempotency-Key.
 * The response fixture below is the docs' verbatim make-a-sale sample.
 */

// docs.clover.com/dev/docs/making-a-sale — verbatim response sample
const CLOVER_SUCCESS_RESPONSE = {
  payment: {
    amount: 24400,
    cardTransaction: {
      authCode: "729168",
      cardType: "VISA",
      cardholderName: "Card Holder",
      entryType: "EMV_CONTACT",
      last4: "0010",
      referenceId: "108100502390",
      state: "CLOSED",
      transactionNo: "000290",
      type: "AUTH",
    },
    createdTime: 1616427189908,
    externalPaymentId: "32-470-941-0752",
    id: "75MYGBEV8EM3Y",
    offline: false,
    order: { id: "BZ0GN8ADGTPKJ" },
    result: "SUCCESS",
    taxAmount: 0,
  },
};

const CONFIG = {
  baseUrl: "https://apisandbox.dev.clover.com",
  accessToken: "test-oauth-token-abc",
  deviceId: "C030UQ01234567",
  posId: "OSOD-Dispensary",
};

function chargeRequest(overrides?: Partial<ChargeRequest>): ChargeRequest {
  return {
    amountCents: 24400,
    currency: "USD",
    patientReference: "Patient/p1",
    invoiceReference: "Invoice/inv1",
    taskReference: "Task/task1",
    staffReference: "Practitioner/staff1",
    description: "Optical order card payment",
    surface: "in-clinic-pos",
    ...overrides,
  };
}

interface CapturedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeTransport(status: number, responseBody: unknown) {
  const captured: CapturedFetch[] = [];
  const fetchImpl = (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : {},
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
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

test("adapter metadata: clover is the in-clinic POS surface and needs a vendor BAA", () => {
  const adapter = createCloverAdapter(CONFIG, fakeFhir());
  assert.equal(adapter.name, "clover");
  assert.equal(adapter.surface, "in-clinic-pos");
  assert.equal(adapter.vendorBaaRequired, true);
});

test("a successful device charge posts to /connect/v1/payments and settles the Invoice with a PaymentReconciliation", async () => {
  const { captured, fetchImpl } = fakeTransport(200, CLOVER_SUCCESS_RESPONSE);
  const fhir = fakeFhir();
  const adapter = createCloverAdapter(CONFIG, fhir, {
    fetchImpl,
    now: () => "2026-07-05T16:00:00.000Z",
  });

  const result = await adapter.charge(chargeRequest());

  // the wire call — doc-verified shape
  assert.equal(captured.length, 1);
  const req = captured[0];
  assert.equal(req.url, "https://apisandbox.dev.clover.com/connect/v1/payments");
  assert.equal(req.method, "POST");
  assert.equal(req.headers["Authorization"], "Bearer test-oauth-token-abc");
  assert.equal(req.headers["X-Clover-Device-Id"], "C030UQ01234567");
  assert.equal(req.headers["X-POS-Id"], "OSOD-Dispensary");
  assert.equal(req.headers["Content-Type"], "application/json");
  assert.ok(req.headers["Idempotency-Key"], "payment requests require an Idempotency-Key");
  assert.equal(req.body.amount, 24400);
  assert.equal(req.body.final, true);
  assert.ok(String(req.body.externalPaymentId).startsWith("osod-"));

  // the transaction result
  assert.equal(result.outcome, "success");
  assert.equal(result.transactionId, "75MYGBEV8EM3Y");
  assert.equal(result.amountChargedCents, 24400);
  assert.deepEqual(result.paymentRecord, { resourceType: "PaymentReconciliation", id: "pr-server-1" });

  // the settling PaymentReconciliation (seam spec §5)
  assert.equal(fhir.created.length, 1);
  const pr = fhir.created[0];
  assert.equal(pr.resourceType, "PaymentReconciliation");
  assert.equal(pr.outcome, "complete");
  assert.equal(pr.detail?.[0]?.request?.reference, "Invoice/inv1");
  assert.equal(pr.request?.reference, "Task/task1");
  assert.equal(pr.requestor?.reference, "Practitioner/staff1");
  assert.equal(pr.paymentIdentifier?.system, CLOVER_TRANSACTION_SYSTEM);
  assert.equal(pr.paymentIdentifier?.value, "75MYGBEV8EM3Y");
  assert.equal(pr.created, "2026-07-05T16:00:00.000Z");
  assert.equal(pr.paymentDate, "2021-03-22"); // derived from the response createdTime epoch

  const tender = pr.extension?.find((e) => e.url === OSOD_PAYMENT_TENDER_EXTENSION_URL)
    ?.valueCodeableConcept?.coding?.[0];
  assert.equal(tender?.code, "CLOVER");
  assert.equal(tender?.display, "VISA ****0010");

  const surfaceExt = pr.extension?.find((e) => e.url === OSOD_PAYMENT_SURFACE_EXTENSION_URL);
  assert.equal(surfaceExt?.extension?.find((e) => e.url === "surface")?.valueCode, "in-clinic-pos");
  assert.equal(
    surfaceExt?.extension?.find((e) => e.url === "terminal-id")?.valueString,
    "C030UQ01234567",
  );

  // PCI: the OAuth token exists in the request header only — never in the persisted record
  assert.ok(!JSON.stringify(pr).includes(CONFIG.accessToken));
});

test("a declined device charge creates NO PaymentReconciliation (money that did not move has no financial record)", async () => {
  const { fetchImpl } = fakeTransport(200, {
    payment: { id: "DECL123", result: "FAIL", amount: 24400 },
  });
  const fhir = fakeFhir();
  const adapter = createCloverAdapter(CONFIG, fhir, { fetchImpl });

  const result = await adapter.charge(chargeRequest());

  assert.equal(result.outcome, "declined");
  assert.equal(result.declineCode, "FAIL");
  assert.equal(result.transactionId, "DECL123");
  assert.equal(result.paymentRecord, undefined);
  assert.equal(fhir.created.length, 0);
});

test("a transport/auth failure maps to outcome failed with the HTTP status, and no record is written", async () => {
  const { fetchImpl } = fakeTransport(401, { message: "401 Unauthorized" });
  const fhir = fakeFhir();
  const adapter = createCloverAdapter(CONFIG, fhir, { fetchImpl });

  const result = await adapter.charge(chargeRequest());

  assert.equal(result.outcome, "failed");
  assert.match(result.declineReason ?? "", /401/);
  assert.equal(result.paymentRecord, undefined);
  assert.equal(fhir.created.length, 0);
});

test("charge validates the amount and the Invoice reference before touching the device", async () => {
  const { captured, fetchImpl } = fakeTransport(200, CLOVER_SUCCESS_RESPONSE);
  const adapter = createCloverAdapter(CONFIG, fakeFhir(), { fetchImpl });

  await assert.rejects(() => adapter.charge(chargeRequest({ amountCents: 0 })), /amountCents/);
  await assert.rejects(() => adapter.charge(chargeRequest({ invoiceReference: "inv1" })), /Invoice\//);
  assert.equal(captured.length, 0);
});

test("two charges use distinct idempotency keys and external payment ids", async () => {
  const { captured, fetchImpl } = fakeTransport(200, CLOVER_SUCCESS_RESPONSE);
  const adapter = createCloverAdapter(CONFIG, fakeFhir(), { fetchImpl });

  await adapter.charge(chargeRequest());
  await adapter.charge(chargeRequest());

  assert.notEqual(captured[0].headers["Idempotency-Key"], captured[1].headers["Idempotency-Key"]);
  assert.notEqual(captured[0].body.externalPaymentId, captured[1].body.externalPaymentId);
});

test("refund / void / settle / status are explicit v0.7 deferrals (scope fence)", async () => {
  const adapter = createCloverAdapter(CONFIG, fakeFhir());
  await assert.rejects(
    () => adapter.refund({ transactionId: "t", amountCents: 1, reason: "r", staffReference: "s" }),
    /v0\.7/,
  );
  await assert.rejects(() => adapter.void({ transactionId: "t", staffReference: "s" }), /v0\.7/);
  await assert.rejects(() => adapter.settle({ settlementDate: "2026-07-05" }), /v0\.7/);
  await assert.rejects(() => adapter.status("t"), /v0\.7/);
});
