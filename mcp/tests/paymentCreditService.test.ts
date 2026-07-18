import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Bundle,
  ChargeItem,
  Invoice,
  PaymentReconciliation,
} from "@medplum/fhirtypes";
import { buildFinancialSummary, paymentReconciliationsToTenderLines } from "../src/fhir/opticalFinancialSummary.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/odosPaymentTender.js";
import {
  applyPaymentCredit,
  buildUnappliedCreditReceipt,
  filterUnappliedCredits,
  renderUnappliedCreditReceipt,
  transferPaymentCredit,
  voidPaymentCredit,
} from "../src/payments/payment-credit-service.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";

function payment(overrides: Partial<Parameters<typeof buildPaymentReconciliation>[0]> & {
  id?: string;
  versionId?: string;
} = {}): PaymentReconciliation {
  const { id = "credit-1", versionId = "1", ...inputOverrides } = overrides;
  return {
    ...buildPaymentReconciliation({
      outcome: "success",
      createdIso: "2026-07-10T13:00:00.000Z",
      paymentDate: "2026-07-10",
      amountCents: 7500,
      subjectReference: "Patient/p1",
      staffReference: "Practitioner/staff1",
      processorTransactionId: "manual-credit-1",
      processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/manual-payment",
      surface: "manual",
      tender: { code: "CASH", display: "Cash" },
      description: "Check-in copay",
      ...inputOverrides,
    }),
    id,
    meta: { versionId },
  };
}

function fakeFhir(initial: PaymentReconciliation[]) {
  const resources = new Map(initial.map((resource) => [resource.id!, structuredClone(resource)]));
  const updates: Array<{ id: string; headers: Record<string, string> | undefined }> = [];
  return {
    resources,
    updates,
    read: async <T>(_resourceType: string, id: string): Promise<T> =>
      structuredClone(resources.get(id)) as T,
    search: async <T>(): Promise<Bundle<T>> => ({
      resourceType: "Bundle",
      type: "searchset",
      entry: [...resources.values()].map((resource) => ({ resource: structuredClone(resource) as T })),
    }),
    update: async <T>(_resourceType: string, id: string, resource: T, headers?: Record<string, string>): Promise<T> => {
      const current = resources.get(id)!;
      assert.equal(headers?.["If-Match"], `W/"${current.meta?.versionId}"`);
      const nextVersion = String(Number(current.meta?.versionId) + 1);
      const updated = { ...(resource as object), meta: { ...(current.meta ?? {}), versionId: nextVersion } } as PaymentReconciliation;
      resources.set(id, structuredClone(updated));
      updates.push({ id, headers });
      return structuredClone(updated) as T;
    },
  };
}

function invoice(id: string, amountCents: number, patientReference = "Patient/p1"): Invoice {
  return {
    ...buildOpticalInvoice({
      patientReference,
      lineItems: [{ chargeItemReference: `ChargeItem/${id}-ci`, amountCents }],
    }),
    id,
  };
}

function chargeItem(id: string, amountCents: number): ChargeItem {
  return {
    resourceType: "ChargeItem",
    id: `${id}-ci`,
    status: "billable",
    code: { coding: [{ code: "VISIT", display: "Visit charges" }] },
    subject: { reference: "Patient/p1" },
    quantity: { value: 1 },
    priceOverride: { value: amountCents / 100, currency: "USD" },
  };
}

test("$75 pre-pay plus $110 charge settles a $185 Invoice with two tender lines and zero due", async () => {
  const prepay = payment({ tender: { code: "CARD", display: "VISA ****4242" }, surface: "online" });
  const fhir = fakeFhir([prepay]);
  const applied = await applyPaymentCredit(fhir, {
    paymentReconciliationReference: "PaymentReconciliation/credit-1",
    invoiceReference: "Invoice/visit-1",
    amountCents: 7500,
  });
  const balancePayment = payment({
    id: "balance-1",
    amountCents: 11000,
    invoiceReference: "Invoice/visit-1",
    processorTransactionId: "card-balance-1",
    tender: { code: "CARD", display: "MASTERCARD ****1111" },
    surface: "online",
  });
  const visitInvoice = invoice("visit-1", 18500);
  const summary = buildFinancialSummary({
    practiceName: "IVA",
    patientName: "Patient One",
    receiptDate: "2026-07-10",
    orderId: "visit-1",
    invoice: visitInvoice,
    chargeItems: [chargeItem("visit-1", 18500)],
    payments: paymentReconciliationsToTenderLines(
      [applied, balancePayment],
      "Invoice/visit-1",
    ),
  });
  const singlePaymentSummary = buildFinancialSummary({
    practiceName: "IVA",
    patientName: "Patient One",
    receiptDate: "2026-07-10",
    orderId: "visit-1",
    invoice: visitInvoice,
    chargeItems: [chargeItem("visit-1", 18500)],
    payments: [{ tender: "CARD", amountCents: 18500 }],
  });

  assert.deepEqual(summary.payments.tenderLines, [
    { tender: "VISA ****4242", amountCents: 7500 },
    { tender: "MASTERCARD ****1111", amountCents: 11000 },
  ]);
  assert.equal(summary.amountDueNowCents, 0);
  assert.deepEqual(summary.totals, singlePaymentSummary.totals);
});

test("cash pre-payment allocates without adding an Invoice tender and is counted exactly once", async () => {
  const cash = payment();
  const fhir = fakeFhir([cash]);
  const applied = await applyPaymentCredit(fhir, {
    paymentReconciliationReference: "PaymentReconciliation/credit-1",
    invoiceReference: "Invoice/cash-visit",
    amountCents: 7500,
  });
  const cashInvoice = invoice("cash-visit", 7500);
  assert.ok(
    !cashInvoice.extension?.some((extension) => extension.url === ODOS_PAYMENT_TENDER_EXTENSION_URL),
  );
  assert.deepEqual(
    paymentReconciliationsToTenderLines([applied], "Invoice/cash-visit"),
    [{ tender: "Cash", amountCents: 7500 }],
  );
});

test("same-day unapplied void cancels the PR and removes it from the unapplied query", async () => {
  const fhir = fakeFhir([payment()]);
  const voidedTransactions: string[] = [];
  const cancelled = await voidPaymentCredit(fhir, {
    paymentReconciliationReference: "PaymentReconciliation/credit-1",
    nowIso: "2026-07-10T17:00:00.000Z",
    method: "manual-cash",
    voidAtProcessor: async (transactionId) => {
      voidedTransactions.push(transactionId);
      return "success";
    },
  });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(voidedTransactions, ["manual-credit-1"]);
  assert.deepEqual(filterUnappliedCredits([cancelled], "Patient/p1"), []);
});

test("over-allocation is a hard error and performs no conditional write", async () => {
  const fhir = fakeFhir([payment()]);
  await assert.rejects(
    () => applyPaymentCredit(fhir, {
      paymentReconciliationReference: "PaymentReconciliation/credit-1",
      invoiceReference: "Invoice/visit-1",
      amountCents: 10000,
    }),
    /only 7500|nothing was written/i,
  );
  assert.equal(fhir.updates.length, 0);
  assert.deepEqual(fhir.resources.get("credit-1")?.detail, []);
});

test("a guarantor's $200 credit can allocate across two patients without double-counting receipts", async () => {
  const guarantorPayment = payment({
    amountCents: 20000,
    subjectReference: "Patient/guarantor",
    tender: { code: "CARD", display: "VISA ****2000" },
    surface: "online",
  });
  const fhir = fakeFhir([guarantorPayment]);
  await applyPaymentCredit(fhir, {
    paymentReconciliationReference: "PaymentReconciliation/credit-1",
    invoiceReference: "Invoice/child-a",
    amountCents: 7500,
  });
  const allocated = await applyPaymentCredit(fhir, {
    paymentReconciliationReference: "PaymentReconciliation/credit-1",
    invoiceReference: "Invoice/child-b",
    amountCents: 12500,
  });
  const childA = paymentReconciliationsToTenderLines([allocated], "Invoice/child-a");
  const childB = paymentReconciliationsToTenderLines([allocated], "Invoice/child-b");
  assert.deepEqual(childA, [{ tender: "VISA ****2000", amountCents: 7500 }]);
  assert.deepEqual(childB, [{ tender: "VISA ****2000", amountCents: 12500 }]);
  assert.equal(childA[0].amountCents + childB[0].amountCents, 20000);
  assert.deepEqual(filterUnappliedCredits([allocated], "Patient/guarantor"), []);
});

test("transfer re-points one allocation atomically and T0 receipt contains the required proof fields", async () => {
  const allocated = payment({ invoiceReference: "Invoice/wrong" });
  const fhir = fakeFhir([allocated]);
  const transferred = await transferPaymentCredit(fhir, {
    paymentReconciliationReference: "PaymentReconciliation/credit-1",
    fromInvoiceReference: "Invoice/wrong",
    toInvoiceReference: "Invoice/right",
  });
  assert.equal(transferred.detail?.[0]?.request?.reference, "Invoice/right");
  assert.equal(fhir.updates[0].headers?.["If-Match"], 'W/"1"');

  const receipt = buildUnappliedCreditReceipt({
    paymentReconciliation: payment(),
    staff: "Alex Front Desk",
    practice: "Integrated Vision & Aesthetics",
  });
  assert.deepEqual(receipt, {
    amountCents: 7500,
    tender: "Cash",
    date: "2026-07-10",
    staff: "Alex Front Desk",
    practice: "Integrated Vision & Aesthetics",
    notice: "Unapplied credit — will be applied to today's charges.",
  });
  assert.match(renderUnappliedCreditReceipt(receipt), /\$75\.00/);
  assert.match(renderUnappliedCreditReceipt(receipt), /Unapplied credit/);
});

test("unapplied-credit receipt prints an escaped configured footer and omits an empty footer element", () => {
  const configured = buildUnappliedCreditReceipt({
    paymentReconciliation: payment(),
    staff: "Alex Front Desk",
    practice: "Integrated Vision & Aesthetics",
    receiptFooterMessage: '<script>alert("credit")</script>',
  });
  const html = renderUnappliedCreditReceipt(configured);
  assert.match(html, /class="practice-message"/);
  assert.match(html, /&lt;script&gt;alert\(&quot;credit&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);

  const unset = buildUnappliedCreditReceipt({
    paymentReconciliation: payment(),
    staff: "Alex Front Desk",
    practice: "Integrated Vision & Aesthetics",
  });
  assert.doesNotMatch(renderUnappliedCreditReceipt(unset), /class="practice-message"/);
});
