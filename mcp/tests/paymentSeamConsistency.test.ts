import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice } from "@medplum/fhirtypes";
import { buildOpticalChargeItem } from "../src/fhir/opticalCharge.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import {
  buildFinancialSummary,
  paymentReconciliationsToTenderLines,
  renderReceiptSheet,
} from "../src/fhir/opticalFinancialSummary.js";
import { createManualCashAdapter } from "../src/payments/adapters/manual-cash-adapter.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";

/**
 * Receipt-consistency acceptance test — the anti-drift DoD guard (seam spec 2026-07-05 §8):
 *
 *   A processor charge and an equivalent manual-cash sale for the SAME order must render receipts
 *   whose Totals and AMOUNT DUE NOW are identical; only the Payments / tender rows differ.
 *
 * If this test starts failing, the Invoice/receipt model and the PaymentReconciliation model have
 * drifted. Both paths run end-to-end through the real pieces: the manual adapter records the tender
 * on the Invoice (receipt falls back to the tender extension); the processor path settles an
 * untendered Invoice with a PaymentReconciliation projected into the receipt's payments input.
 */

// One order, priced like the Slice-3 live walkthrough: gross 305.00, PPAY discounts, net 244.00.
const LINE_ITEMS = [
  {
    chargeItemReference: "ChargeItem/ci1",
    amountCents: 18500,
    discount: { code: "PPAY", amountCents: 3700 },
  },
  {
    chargeItemReference: "ChargeItem/ci2",
    amountCents: 12000,
    discount: { code: "PPAY", amountCents: 2400 },
  },
];

const CHARGES = [
  buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    code: "V2020",
    codeDisplay: "Frames, purchases",
    feeCents: 18500,
  }),
  buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    code: "V2100",
    codeDisplay: "Sphere, single vision",
    feeCents: 12000,
  }),
];

const RECEIPT_IDENTITY = {
  practiceName: "Integrated Vision & Aesthetics",
  patientName: "Wanda Walkthrough",
  receiptDate: "2026-07-05",
  orderId: "ORD-2001",
};

test("the same order paid by cash vs by processor renders identical money — only the tender rows differ", async () => {
  // Path A — manual cash: untendered bill, charged through the manual-cash adapter (real flow),
  // receipt derives the payment from the Invoice tender extension (no payments arg).
  const cashStore = {
    invoice: {
      ...buildOpticalInvoice({ patientReference: "Patient/p1", lineItems: LINE_ITEMS }),
      id: "inv-cash",
    } as Invoice,
  };
  const cashAdapter = createManualCashAdapter(
    {
      read: async <T,>(_rt: string, _id: string): Promise<T> =>
        structuredClone(cashStore.invoice) as T,
      update: async <T,>(_rt: string, _id: string, next: T): Promise<T> => {
        cashStore.invoice = structuredClone(next) as Invoice;
        return next;
      },
    },
    { now: () => "2026-07-05T15:00:00.000Z" },
  );
  await cashAdapter.charge({
    amountCents: 24400,
    currency: "USD",
    patientReference: "Patient/p1",
    invoiceReference: "Invoice/inv-cash",
    staffReference: "Practitioner/staff1",
    description: "Optical order cash payment",
    surface: "manual",
    tender: { code: "CASH" },
  });
  const cashSummary = buildFinancialSummary({
    ...RECEIPT_IDENTITY,
    invoice: cashStore.invoice,
    chargeItems: CHARGES,
  });

  // Path B — processor: the bill stays untendered; the settling payment is a PaymentReconciliation
  // linked to the Invoice, projected into the receipt's payments input.
  const processorInvoice: Invoice = {
    ...buildOpticalInvoice({ patientReference: "Patient/p1", lineItems: LINE_ITEMS }),
    id: "inv-card",
  };
  const paymentReconciliation = buildPaymentReconciliation({
    outcome: "success",
    createdIso: "2026-07-05T15:00:00.000Z",
    paymentDate: "2026-07-05",
    amountCents: 24400,
    invoiceReference: "Invoice/inv-card",
    taskReference: "Task/task1",
    staffReference: "Practitioner/staff1",
    processorTransactionId: "ch_test_abc123",
    processorTransactionSystem: "https://osod.dev/fhir/NamingSystem/stripe-transaction",
    feesCents: 738,
    surface: "online",
    tender: { code: "CARD", display: "VISA ****4242" },
    description: "Optical order card payment",
  });
  const cardSummary = buildFinancialSummary({
    ...RECEIPT_IDENTITY,
    invoice: processorInvoice,
    chargeItems: CHARGES,
    payments: paymentReconciliationsToTenderLines([paymentReconciliation]),
  });

  // THE GUARD: identical money…
  assert.deepEqual(cardSummary.totals, cashSummary.totals);
  assert.deepEqual(cardSummary.lines, cashSummary.lines);
  assert.equal(cashSummary.amountDueNowCents, 0);
  assert.equal(cardSummary.amountDueNowCents, 0);
  assert.equal(cardSummary.payments.paymentsAppliedCents, cashSummary.payments.paymentsAppliedCents);

  // …different tender rows (the only permitted difference).
  assert.deepEqual(cashSummary.payments.tenderLines, [{ tender: "CASH", amountCents: 24400 }]);
  assert.deepEqual(cardSummary.payments.tenderLines, [
    { tender: "VISA ****4242", amountCents: 24400 },
  ]);

  // And both render as real receipts with the same prominent balance.
  for (const html of [renderReceiptSheet(cashSummary), renderReceiptSheet(cardSummary)]) {
    assert.match(html, /AMOUNT DUE NOW: \$0\.00/);
    assert.match(html, /\$244\.00/);
    assert.doesNotMatch(html, /undefined/);
  }
});
