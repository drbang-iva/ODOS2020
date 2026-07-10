import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, PaymentReconciliation, Resource } from "@medplum/fhirtypes";
import type { OsodAuditEventRecord } from "../src/authz/osodAudit.js";
import {
  handleApplyCreditRequest,
  handleTransferCreditRequest,
  handleVoidCreditRequest,
  type PaymentCreditHandlerDeps,
} from "../src/payments/payment-credit-handler.js";
import { createPaymentDispatch } from "../src/payments/payment-config.js";
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
      processorTransactionSystem: "https://osod.dev/fhir/NamingSystem/manual-payment",
      surface: "manual",
      tender: { code: "CASH", display: "Cash" },
    }),
    id: "credit-1",
    meta: { versionId: "1" },
  };
}

function setup(initial = storedPayment()) {
  let resource = structuredClone(initial);
  const audits: OsodAuditEventRecord[] = [];
  const fhir = {
    read: async <T extends Resource>(): Promise<T> => structuredClone(resource) as T,
    search: async <T extends Resource>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [{ resource: structuredClone(resource) as T }],
    }),
    create: async <T extends Resource>(next: T): Promise<T> => next,
    update: async <T extends Resource>(
      _resourceType: T["resourceType"],
      _id: string,
      next: T,
      headers?: Record<string, string>,
    ): Promise<T> => {
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
          fhir,
        }
      : null,
    lifecycleFhir: fhir,
    dispatch: createPaymentDispatch([{ method: "manual-cash" }]),
    recordAudit: async (row) => { audits.push(row); },
    now: () => "2026-07-10T14:00:00.000Z",
  };
  return { audits, deps, current: () => resource };
}

test("apply and transfer handlers audit payment.credit.applied with the transfer reason", async () => {
  const apply = setup();
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
