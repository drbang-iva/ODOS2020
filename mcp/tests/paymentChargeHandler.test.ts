import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import { projectDayLedgerPayments } from "../src/desk/day-ledger.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import {
  handleChargeRequest,
  handlePaymentMethodsRequest,
  type ChargeHandlerDeps,
} from "../src/payments/payment-charge-handler.js";
import { createPaymentDispatch } from "../src/payments/payment-config.js";
import { CLOVER_SANDBOX_BASE_URL } from "../src/payments/adapters/clover-adapter.js";
import { StaffRoleServiceUnavailableError } from "../src/payments/payment-endpoint.js";

const STAFF = {
  staffReference: "Practitioner/staff1",
  actorRole: "front-desk" as const,
  roles: ["front-desk"] as const,
};

function cloverTransport(response: unknown, ok = true, status = 200) {
  const created: PaymentReconciliation[] = [];
  const fetchImpl = (async () => ({
    ok,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  })) as typeof fetch;
  const fhir = {
    read: async <T,>(): Promise<T> => ({}) as T,
    update: async <T,>(_rt: string, _id: string, r: T): Promise<T> => r,
    create: async <T,>(r: T): Promise<T> => {
      created.push(r as PaymentReconciliation);
      return { ...(r as object), id: "pr-server-1" } as T;
    },
  };
  return { created, fetchImpl, fhir };
}

function deps(overrides: Partial<ChargeHandlerDeps> & { fetchImpl?: typeof fetch; fhir?: unknown } = {}) {
  const audits: OdosAuditEventRecord[] = [];
  const fhir = overrides.fhir ?? cloverTransport({}).fhir;
  const base: ChargeHandlerDeps = {
    authenticate: async (authHeader) =>
      authHeader === "Bearer good" ? { ...STAFF, fhir: fhir as never } : null,
    dispatch: createPaymentDispatch([{ method: "clover", config: { baseUrl: CLOVER_SANDBOX_BASE_URL, accessToken: "t", deviceId: "D1", posId: "P" } }], {
      fetchImpl: overrides.fetchImpl,
      now: () => "2026-07-05T18:00:00.000Z",
      generateId: () => "id",
    }),
    recordAudit: async (row) => {
      audits.push(row);
    },
    now: () => "2026-07-05T18:00:00.000Z",
    ...("authenticate" in overrides ? { authenticate: overrides.authenticate! } : {}),
    ...("dispatch" in overrides ? { dispatch: overrides.dispatch! } : {}),
    ...("recordAudit" in overrides ? { recordAudit: overrides.recordAudit! } : {}),
  };
  return { audits, deps: base };
}

const BODY = {
  method: "clover",
  amountCents: 24400,
  patientReference: "Patient/p1",
  invoiceReference: "Invoice/inv1",
  taskReference: "Task/task1",
  description: "Optical order card payment",
  surface: "in-clinic-pos",
};

test("payment methods returns the configured dispatch methods for authenticated staff", async () => {
  const { deps: d } = deps({
    dispatch: createPaymentDispatch([{ method: "manual-cash" }]),
  });
  const res = await handlePaymentMethodsRequest(d, { authHeader: "Bearer good" });
  assert.deepEqual(res, { status: 200, body: { methods: ["manual-cash"] } });
});

test("payment methods rejects an unauthenticated caller with 401", async () => {
  const { deps: d } = deps();
  const res = await handlePaymentMethodsRequest(d, { authHeader: undefined });
  assert.deepEqual(res, {
    status: 401,
    body: { error: "Authentication required to view payment methods." },
  });
});

test("manual CASH through /payments/charge is dated, staff-attributed, and counted by Day Ledger", async () => {
  let storedInvoice: Invoice = {
    ...buildOpticalInvoice({
      patientReference: "Patient/p1",
      lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 24400 }],
    }),
    id: "inv1",
  };
  const fhir = {
    read: async <T,>(): Promise<T> => structuredClone(storedInvoice) as T,
    search: async () => ({ resourceType: "Bundle" as const, type: "searchset" as const }),
    update: async <T,>(_resourceType: string, _id: string, resource: T): Promise<T> => {
      storedInvoice = structuredClone(resource) as Invoice;
      return resource;
    },
    create: async <T,>(resource: T): Promise<T> => resource,
  };
  const dispatch = createPaymentDispatch([{ method: "manual-cash" }], {
    now: () => "2026-07-15T14:30:00.000Z",
  });
  const { deps: d } = deps({ fhir, dispatch });

  const response = await handleChargeRequest(d, {
    authHeader: "Bearer good",
    body: {
      method: "manual-cash",
      amountCents: 24400,
      patientReference: "Patient/p1",
      invoiceReference: "Invoice/inv1",
      description: "Optical order cash payment",
      surface: "manual",
      tender: { code: "CASH" },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(storedInvoice.date, "2026-07-15T14:30:00.000Z");
  assert.equal(storedInvoice.participant?.[0]?.actor.reference, "Practitioner/staff1");
  const ledger = projectDayLedgerPayments([storedInvoice], "2026-07-15", "America/New_York");
  assert.equal(ledger.tenderTotalsCents.CASH, 24400);
  assert.equal(ledger.totalCents, 24400);
});

test("a successful card charge returns 200 with the transaction result and audits payment.charge.completed against the PR", async () => {
  const { created, fetchImpl, fhir } = cloverTransport({
    payment: { id: "CLOV1", result: "SUCCESS", amount: 24400, cardTransaction: { cardType: "VISA", last4: "0010" } },
  });
  const { audits, deps: d } = deps({ fetchImpl, fhir });

  const res = await handleChargeRequest(d, { authHeader: "Bearer good", body: BODY });

  assert.equal(res.status, 200);
  const result = res.body as { outcome: string; paymentRecord?: { id: string } };
  assert.equal(result.outcome, "success");
  assert.equal(result.paymentRecord?.id, "pr-server-1");
  assert.equal(created.length, 1);
  assert.equal(created[0].extension?.find((extension) =>
    extension.url.endsWith("/odos-payment-subject"))?.valueReference?.reference, "Patient/p1");

  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, "payment.charge.completed");
  assert.equal(audits[0].actorId, "staff1");
  assert.equal(audits[0].resourceType, "PaymentReconciliation");
  assert.equal(audits[0].actionOutcome, "granted");
});

test("a multi-role clinician-primary caller charges as a deterministic granting role", async () => {
  const { fetchImpl, fhir } = cloverTransport({
    payment: { id: "CLOV1", result: "SUCCESS", amount: 24400 },
  });
  const { audits, deps: d } = deps({
    fetchImpl,
    fhir,
    authenticate: async () => ({
      staffReference: "Practitioner/owner",
      actorRole: "clinician",
      roles: ["clinician", "front-desk", "practice-admin"],
      fhir: fhir as never,
    }),
  });

  const result = await handleChargeRequest(d, { authHeader: "Bearer good", body: BODY });

  assert.equal(result.status, 200);
  assert.equal(audits[0].actorRole, "practice-admin");
});

test("omitting invoiceReference selects pay-before-bill mode and preserves the existing charge endpoint", async () => {
  const { created, fetchImpl, fhir } = cloverTransport({
    payment: { id: "PREPAY1", result: "SUCCESS", amount: 7500 },
  });
  const { audits, deps: d } = deps({ fetchImpl, fhir });

  const res = await handleChargeRequest(d, {
    authHeader: "Bearer good",
    body: { ...BODY, amountCents: 7500, invoiceReference: undefined },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(created[0].detail, []);
  assert.equal(audits[0].eventType, "payment.charge.completed");
  assert.equal(audits[0].resourceType, "PaymentReconciliation");
});

test("the charge is attributed to the AUTHENTICATED staff, never a staffReference from the request body", async () => {
  const { created, fetchImpl, fhir } = cloverTransport({
    payment: { id: "CLOV1", result: "SUCCESS", amount: 24400 },
  });
  const { deps: d } = deps({ fetchImpl, fhir });

  await handleChargeRequest(d, {
    authHeader: "Bearer good",
    body: { ...BODY, staffReference: "Practitioner/IMPOSTOR" },
  });

  assert.equal(created[0].requestor?.reference, "Practitioner/staff1");
});

test("a missing/invalid token is rejected 401 before any adapter call or audit", async () => {
  let charged = false;
  const fetchImpl = (async () => {
    charged = true;
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as typeof fetch;
  const { audits, deps: d } = deps({ fetchImpl });

  const res = await handleChargeRequest(d, { authHeader: undefined, body: BODY });

  assert.equal(res.status, 401);
  assert.equal(charged, false);
  assert.equal(audits.length, 0);
});

test("payment charge maps an unavailable staff-role service to a clean 503", async () => {
  let downstreamCalls = 0;
  const { audits, deps: d } = deps({
    authenticate: async () => { throw new StaffRoleServiceUnavailableError(new Error("refresh failed")); },
    dispatch: {
      methods: () => [],
      getAdapter: () => {
        downstreamCalls += 1;
        throw new Error("unexpected adapter lookup");
      },
    },
    recordAudit: async () => { downstreamCalls += 1; },
  });

  const res = await handleChargeRequest(d, { authHeader: "Bearer good", body: BODY });

  assert.deepEqual(res, {
    status: 503,
    body: { error: "Payment service temporarily unavailable." },
  });
  assert.equal(downstreamCalls, 0);
  assert.equal(audits.length, 0);
});

test("a declined card returns 200 with outcome declined, writes no PR, and audits payment.charge.failed", async () => {
  const { created, fetchImpl, fhir } = cloverTransport({ payment: { id: "D1", result: "DECLINED" } });
  const { audits, deps: d } = deps({ fetchImpl, fhir });

  const res = await handleChargeRequest(d, { authHeader: "Bearer good", body: BODY });

  assert.equal(res.status, 200);
  assert.equal((res.body as { outcome: string }).outcome, "declined");
  assert.equal(created.length, 0);
  assert.equal(audits[0].eventType, "payment.charge.failed");
  assert.equal(audits[0].actionOutcome, "denied");
  // a failed attempt still audits against the Invoice it targeted
  assert.equal(audits[0].resourceType, "Invoice");
});

test("an unconfigured payment method is rejected 400 (no adapter, no audit of a completed charge)", async () => {
  const { audits, deps: d } = deps();
  const res = await handleChargeRequest(d, {
    authHeader: "Bearer good",
    body: { ...BODY, method: "stripe" },
  });
  assert.equal(res.status, 400);
  assert.match((res.body as { error: string }).error, /not configured|method/i);
  assert.ok(!audits.some((a) => a.eventType === "payment.charge.completed"));
});

test("malformed bodies are rejected 400 (amount, invoice reference, method)", async () => {
  const { deps: d } = deps();
  for (const bad of [
    { ...BODY, amountCents: 0 },
    { ...BODY, amountCents: 1.5 },
    { ...BODY, invoiceReference: "inv1" },
    { ...BODY, method: "" },
    { amountCents: 100 },
  ]) {
    const res = await handleChargeRequest(d, { authHeader: "Bearer good", body: bad });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

test("an unexpected adapter/transport error returns 502 and audits the failure (money-safe: surfaced, not swallowed)", async () => {
  const throwingDispatch = {
    methods: () => ["clover"],
    getAdapter: () => ({
      name: "clover",
      surface: "in-clinic-pos" as const,
      vendorBaaRequired: true,
      charge: async () => {
        throw new Error("socket hang up");
      },
      refund: async () => ({ refundId: "", outcome: "failed" as const }),
      void: async () => ({ outcome: "failed" as const }),
      settle: async () => ({ batchId: "", settlementDate: "", totalCents: 0, feesCents: 0, transactionIds: [] }),
      status: async () => "unknown" as const,
    }),
  };
  const { audits, deps: d } = deps({ dispatch: throwingDispatch });

  const res = await handleChargeRequest(d, { authHeader: "Bearer good", body: BODY });

  assert.equal(res.status, 502);
  assert.equal(audits[0].eventType, "payment.charge.failed");
  assert.match((res.body as { error: string }).error, /socket hang up|charge failed/i);
});

test("an authenticated staff whose role lacks payment.charge is rejected 403 before any adapter call or audit", async () => {
  let charged = false;
  const fetchImpl = (async () => {
    charged = true;
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as typeof fetch;
  const { audits, deps: d } = deps({
    fetchImpl,
    authenticate: async () => ({
      staffReference: "Practitioner/doc1",
      actorRole: "clinician",
      roles: ["clinician"],
      fhir: cloverTransport({}).fhir as never,
    }),
  });
  const res = await handleChargeRequest(d, { authHeader: "Bearer good", body: BODY });
  assert.equal(res.status, 403);
  assert.match((res.body as { error: string }).error, /payment\.charge/);
  assert.equal(charged, false);
  assert.equal(audits.length, 0);
});
