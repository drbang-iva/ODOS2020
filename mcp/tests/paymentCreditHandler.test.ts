import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import type { OdosAuditEventRecord } from "../src/authz/odosAudit.js";
import {
  handleApplyCreditRequest,
  handlePaymentReconciliationsRequest,
  handleTransferCreditRequest,
  handleUnappliedCreditsRequest,
  handleVoidCreditRequest,
  type PaymentCreditHandlerDeps,
} from "../src/payments/payment-credit-handler.js";
import { createPaymentDispatch } from "../src/payments/payment-config.js";
import { StaffRoleServiceUnavailableError } from "../src/payments/payment-endpoint.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";

function storedPayment(invoiceReference?: string): PaymentReconciliation {
  return {
    ...buildPaymentReconciliation({
      outcome: "success",
      createdIso: "2026-07-10T13:00:00.000Z",
      paymentDate: "2026-07-10",
      amountCents: 7500,
      subjectReference: "Patient/p1",
      ...(invoiceReference ? { invoiceReference } : {}),
      staffReference: "Practitioner/staff1",
      processorTransactionId: "manual-1",
      processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/manual-payment",
      surface: "manual",
      tender: { code: "CASH", display: "Cash" },
    }),
    id: "credit-1",
    meta: { versionId: "1" },
  };
}

function setup(initial = storedPayment()) {
  let resource = structuredClone(initial);
  const audits: OdosAuditEventRecord[] = [];
  let downstreamCalls = 0;
  const fhir = {
    read: async <T extends Resource>(): Promise<T> => {
      downstreamCalls += 1;
      return structuredClone(resource) as T;
    },
    search: async <T extends Resource>(): Promise<Bundle<T>> => {
      downstreamCalls += 1;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: structuredClone(resource) as T }],
      };
    },
    create: async <T extends Resource>(next: T): Promise<T> => {
      downstreamCalls += 1;
      return next;
    },
    update: async <T extends Resource>(
      _resourceType: T["resourceType"],
      _id: string,
      next: T,
      headers?: Record<string, string>,
    ): Promise<T> => {
      downstreamCalls += 1;
      assert.equal(headers?.["If-Match"], `W/"${resource.meta?.versionId}"`);
      resource = { ...(next as PaymentReconciliation), meta: { versionId: "2" } };
      return structuredClone(resource) as T;
    },
  };
  const deps: PaymentCreditHandlerDeps = {
    authenticate: async (header) => header === "Bearer good"
      ? {
          staffReference: "Practitioner/staff1",
          actorRole: "front-desk",
          roles: ["front-desk"],
          fhir,
        }
      : null,
    lifecycleFhir: fhir,
    dispatch: createPaymentDispatch([{ method: "manual-cash" }]),
    recordAudit: async (row) => {
      downstreamCalls += 1;
      audits.push(row);
    },
    now: () => "2026-07-10T14:00:00.000Z",
  };
  return { audits, deps, current: () => resource, downstreamCalls: () => downstreamCalls };
}

test("payment credit reads map an unavailable staff-role service to a clean 503", async () => {
  const fixture = setup();
  fixture.deps.authenticate = async () => {
    throw new StaffRoleServiceUnavailableError(new Error("refresh failed"));
  };

  for (const result of [
    await handleUnappliedCreditsRequest(fixture.deps, {
      authHeader: "Bearer good",
      patientReference: "Patient/p1",
    }),
    await handlePaymentReconciliationsRequest(fixture.deps, {
      authHeader: "Bearer good",
      query: { patientReference: "Patient/p1" },
    }),
  ]) {
    assert.deepEqual(result, {
      status: 503,
      body: { error: "Payment service temporarily unavailable." },
    });
  }
  assert.equal(fixture.downstreamCalls(), 0);
});

test("payment credit mutations map an unavailable staff-role service to a clean 503", async () => {
  const fixture = setup();
  fixture.deps.authenticate = async () => {
    throw new StaffRoleServiceUnavailableError(new Error("refresh failed"));
  };

  const result = await handleApplyCreditRequest(fixture.deps, {
    authHeader: "Bearer good",
    body: {
      paymentReconciliationReference: "PaymentReconciliation/credit-1",
      invoiceReference: "Invoice/first",
      amountCents: 7500,
    },
  });
  assert.deepEqual(result, {
    status: 503,
    body: { error: "Payment service temporarily unavailable." },
  });
  assert.equal(fixture.downstreamCalls(), 0);
});

test("apply and transfer handlers audit payment.credit.applied with the transfer reason", async () => {
  const apply = setup();
  const authenticate = apply.deps.authenticate;
  apply.deps.authenticate = async (header) => {
    const staff = await authenticate(header);
    return staff ? {
      ...staff,
      actorRole: "clinician",
      roles: ["clinician", "front-desk", "practice-admin"],
    } : null;
  };
  const applyResult = await handleApplyCreditRequest(apply.deps, {
    authHeader: "Bearer good",
    body: {
      paymentReconciliationReference: "PaymentReconciliation/credit-1",
      invoiceReference: "Invoice/first",
      amountCents: 7500,
    },
  });
  assert.equal(applyResult.status, 200);
  assert.equal(apply.audits[0].eventType, "payment.credit.applied");
  assert.equal(apply.audits[0].actorRole, "practice-admin");
  assert.match(apply.audits[0].actionReason ?? "", /apply/);

  const transfer = setup(storedPayment("Invoice/wrong"));
  const transferResult = await handleTransferCreditRequest(transfer.deps, {
    authHeader: "Bearer good",
    body: {
      paymentReconciliationReference: "PaymentReconciliation/credit-1",
      fromInvoiceReference: "Invoice/wrong",
      toInvoiceReference: "Invoice/right",
      reason: "wrong patient selected",
    },
  });
  assert.equal(transferResult.status, 200);
  assert.equal(transfer.current().detail?.[0]?.request?.reference, "Invoice/right");
  assert.equal(transfer.audits[0].eventType, "payment.credit.applied");
  assert.match(transfer.audits[0].actionReason ?? "", /wrong patient selected/);
});

test("same-day void uses the recorded manual tender, cancels the PR, and audits payment.void.*", async () => {
  const { audits, deps, current } = setup();
  const result = await handleVoidCreditRequest(deps, {
    authHeader: "Bearer good",
    body: {
      paymentReconciliationReference: "PaymentReconciliation/credit-1",
      method: "manual-cash",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(current().status, "cancelled");
  assert.equal(audits[0].eventType, "payment.void.attempted");
  assert.equal(audits[0].actionOutcome, "granted");
});
