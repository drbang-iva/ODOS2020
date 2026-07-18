import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpticalChargeItem } from "../src/fhir/opticalCharge.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import {
  buildFinancialSummary,
  paymentReconciliationsToTenderLines,
  renderReceiptSheet,
} from "../src/fhir/opticalFinancialSummary.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";
import { ODOS_PAYMENT_TENDER_EXTENSION_URL } from "../src/fhir/odosPaymentTender.js";

// Real Slice-3 builders as fixtures — the receipt reads what the kernel actually produces.
const CHARGES = [
  buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    encounterReference: "Encounter/e1",
    code: "V2020",
    codeDisplay: "Frames, purchases",
    feeCents: 18500,
  }),
  buildOpticalChargeItem({
    patientReference: "Patient/p1",
    deviceRequestReference: "DeviceRequest/dr1",
    encounterReference: "Encounter/e1",
    code: "V2100",
    codeDisplay: "Sphere, single vision",
    feeCents: 12000,
  }),
];

const INVOICE = buildOpticalInvoice({
  patientReference: "Patient/p1",
  tender: "CASH",
  lineItems: [
    { chargeItemReference: "ChargeItem/ci1", amountCents: 18500, discount: { code: "PPAY", amountCents: 3700 } },
    { chargeItemReference: "ChargeItem/ci2", amountCents: 12000, discount: { code: "PPAY", amountCents: 2400 } },
  ],
});

test("buildFinancialSummary itemizes lines, reconciles totals to the Invoice, and derives AMOUNT DUE NOW", () => {
  const summary = buildFinancialSummary({
    practiceName: "Integrated Vision & Aesthetics",
    patientName: "Wanda Walkthrough",
    patientRef: "Patient/p1",
    receiptDate: "2026-07-04",
    orderId: "ORD-1001",
    providerName: "Dr. Bang",
    invoice: INVOICE,
    chargeItems: CHARGES,
  });

  // header
  assert.equal(summary.header.practiceName, "Integrated Vision & Aesthetics");
  assert.equal(summary.header.patientName, "Wanda Walkthrough");
  assert.equal(summary.header.orderId, "ORD-1001");

  // lines: description/code from the ChargeItems, money from the Invoice lines
  assert.equal(summary.lines.length, 2);
  assert.equal(summary.lines[0].description, "Frames, purchases");
  assert.equal(summary.lines[0].code, "V2020");
  assert.equal(summary.lines[0].feeCents, 18500);
  assert.deepEqual(summary.lines[0].discount, { code: "PPAY", amountCents: 3700 });
  assert.equal(summary.lines[0].taxCents, 0); // cash tier: no tax component on the Invoice
  assert.equal(summary.lines[0].patientBalanceCents, 14800); // 185.00 - 37.00
  assert.equal(summary.lines[1].patientBalanceCents, 9600); // 120.00 - 24.00

  // totals reconcile to the Invoice (gross 305.00, net 244.00)
  assert.equal(summary.totals.chargesSubtotalCents, 30500);
  assert.equal(summary.totals.discountTotalCents, 6100);
  assert.equal(summary.totals.taxTotalCents, 0);
  assert.equal(summary.totals.chargesPlusTaxCents, 30500);
  assert.equal(summary.totals.netCents, 24400);

  // payments: derived from the Invoice tender (CASH, full net) when not overridden
  assert.deepEqual(summary.payments.tenderLines, [{ tender: "CASH", amountCents: 24400 }]);
  assert.equal(summary.payments.paymentsAppliedCents, 24400);

  // paid in full → nothing due
  assert.equal(summary.amountDueNowCents, 0);
});

const IDENTITY = {
  practiceName: "IVA",
  patientName: "Wanda Walkthrough",
  receiptDate: "2026-07-04",
  orderId: "ORD-1001",
} as const;

test("buildFinancialSummary supports partial payment — AMOUNT DUE NOW is the open balance", () => {
  const summary = buildFinancialSummary({
    ...IDENTITY,
    invoice: INVOICE,
    chargeItems: CHARGES,
    payments: [{ tender: "CHECK", amountCents: 10000 }],
  });
  assert.deepEqual(summary.payments.tenderLines, [{ tender: "CHECK", amountCents: 10000 }]);
  assert.equal(summary.payments.paymentsAppliedCents, 10000);
  assert.equal(summary.amountDueNowCents, 14400); // 244.00 − 100.00
});

test("buildFinancialSummary rejects an Invoice whose totals do not reconcile", () => {
  const tampered = { ...INVOICE, totalNet: { value: 999, currency: "USD" } };
  assert.throws(
    () => buildFinancialSummary({ ...IDENTITY, invoice: tampered, chargeItems: CHARGES }),
    /reconcile/i,
  );
});

test("buildFinancialSummary rejects a line-count mismatch between Invoice and ChargeItems", () => {
  assert.throws(
    () => buildFinancialSummary({ ...IDENTITY, invoice: INVOICE, chargeItems: CHARGES.slice(0, 1) }),
    /mismatch/i,
  );
});

test("buildFinancialSummary rejects an Invoice with no line items", () => {
  assert.throws(
    () => buildFinancialSummary({ ...IDENTITY, invoice: { ...INVOICE, lineItem: [] }, chargeItems: [] }),
    /line item/i,
  );
});

test("renderReceiptSheet renders the money document: identity, itemized lines, totals, payments, AMOUNT DUE NOW", () => {
  const summary = buildFinancialSummary({
    ...IDENTITY,
    practiceName: "Integrated Vision & Aesthetics",
    providerName: "Dr. Bang",
    invoice: INVOICE,
    chargeItems: CHARGES,
    payments: [{ tender: "CHECK", amountCents: 10000 }],
  });
  const html = renderReceiptSheet(summary);

  assert.match(html, /Receipt \/ Financial Summary/); // unmistakable title (corpus §1.6 lesson)
  assert.match(html, /Integrated Vision &amp; Aesthetics/); // escaped practice name
  assert.match(html, /Wanda Walkthrough/);
  assert.match(html, /Frames, purchases/); // line description
  assert.match(html, /V2020/); // display-only code
  assert.match(html, /\$185\.00/); // money formatted USD
  assert.match(html, /PPAY/); // discount code shown
  assert.match(html, /\$244\.00/); // net
  assert.match(html, /CHECK/); // tender line
  assert.match(html, /\$100\.00/); // payment applied
  assert.match(html, /AMOUNT DUE NOW/); // prominent balance label
  assert.match(html, /\$144\.00/); // open balance
  assert.doesNotMatch(html, /undefined/);
});

test("renderReceiptSheet shows $0.00 due when paid in full and em-dash for absent optionals", () => {
  const html = renderReceiptSheet(
    buildFinancialSummary({ ...IDENTITY, invoice: INVOICE, chargeItems: CHARGES }),
  );
  assert.match(html, /AMOUNT DUE NOW/);
  assert.match(html, /\$0\.00/);
  assert.match(html, /—/); // provider absent → em-dash
  assert.doesNotMatch(html, /undefined/);
});

test("MCP receipt renderer prints the configured footer message", () => {
  const html = renderReceiptSheet(
    buildFinancialSummary({
      ...IDENTITY,
      invoice: INVOICE,
      chargeItems: CHARGES,
      receiptFooterMessage: "Thank you for trusting our practice.",
    }),
  );
  assert.match(
    html,
    /class="practice-message">Thank you for trusting our practice\.<\/p>/,
  );
});

// --- Invoice ↔ PaymentReconciliation seam: the projection feeding the existing payments? hook ---
// (seam spec 2026-07-05 §3: payments come from exactly one source — PaymentReconciliation[] when any
// exist for the Invoice, else the Invoice tender extension — never both.)

function processorPayment(amountCents: number, display?: string) {
  return buildPaymentReconciliation({
    outcome: "success",
    createdIso: "2026-07-05T14:30:00.000Z",
    paymentDate: "2026-07-05",
    amountCents,
    subjectReference: "Patient/p1",
    invoiceReference: "Invoice/inv1",
    processorTransactionId: `txn-${amountCents}`,
    processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/stripe-transaction",
    surface: "online",
    tender: { code: "CARD", ...(display ? { display } : {}) },
  });
}

test("paymentReconciliationsToTenderLines projects PRs into receipt tender lines (display ?? code)", () => {
  const lines = paymentReconciliationsToTenderLines([
    processorPayment(20000, "VISA ****4242"),
    processorPayment(4400),
  ]);
  // Patient-facing labels prefer the display (Slice-3c live-drive lesson: raw codes are unfriendly):
  // the adapter's instrument label wins, else the vocabulary display ("Card"), else the raw code.
  assert.deepEqual(lines, [
    { tender: "VISA ****4242", amountCents: 20000 },
    { tender: "Card", amountCents: 4400 },
  ]);
});

test("paymentReconciliationsToTenderLines falls back to the raw code for a practice-custom tender", () => {
  const pr = processorPayment(1000);
  const custom = {
    ...pr,
    extension: pr.extension?.map((ext) =>
      ext.url === ODOS_PAYMENT_TENDER_EXTENSION_URL
        ? { url: ext.url, valueCodeableConcept: { coding: [{ code: "GIFTCERT" }] } }
        : ext,
    ),
  };
  assert.deepEqual(paymentReconciliationsToTenderLines([custom]), [
    { tender: "GIFTCERT", amountCents: 1000 },
  ]);
});

test("a processor-settled receipt derives AMOUNT DUE NOW from the projected PRs (untendered Invoice)", () => {
  const untenderedInvoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    lineItems: [
      { chargeItemReference: "ChargeItem/ci1", amountCents: 18500, discount: { code: "PPAY", amountCents: 3700 } },
      { chargeItemReference: "ChargeItem/ci2", amountCents: 12000, discount: { code: "PPAY", amountCents: 2400 } },
    ],
  });
  const summary = buildFinancialSummary({
    practiceName: "Integrated Vision & Aesthetics",
    patientName: "Wanda Walkthrough",
    receiptDate: "2026-07-05",
    orderId: "ORD-1002",
    invoice: untenderedInvoice,
    chargeItems: CHARGES,
    payments: paymentReconciliationsToTenderLines([processorPayment(24400, "VISA ****4242")]),
  });
  assert.equal(summary.payments.paymentsAppliedCents, 24400);
  assert.equal(summary.amountDueNowCents, 0);
  assert.deepEqual(summary.payments.tenderLines, [{ tender: "VISA ****4242", amountCents: 24400 }]);
});

test("a partial processor payment (deposit) leaves the balance due", () => {
  const untenderedInvoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 18500 }],
  });
  const summary = buildFinancialSummary({
    practiceName: "IV&A",
    patientName: "Wanda Walkthrough",
    receiptDate: "2026-07-05",
    orderId: "ORD-1003",
    invoice: untenderedInvoice,
    chargeItems: [CHARGES[0]],
    payments: paymentReconciliationsToTenderLines([processorPayment(10000, "VISA ****4242")]),
  });
  assert.equal(summary.amountDueNowCents, 8500);
});

test("paymentReconciliationsToTenderLines rejects a PR without the odos-payment-tender extension", () => {
  const pr = processorPayment(1000);
  const stripped = { ...pr, extension: pr.extension?.filter((e) => !e.url.includes("payment-tender")) };
  assert.throws(() => paymentReconciliationsToTenderLines([stripped]), /tender/i);
});

test("an untendered Invoice with no payments still refuses the tender fallback (processor path must pass payments)", () => {
  const untenderedInvoice = buildOpticalInvoice({
    patientReference: "Patient/p1",
    lineItems: [{ chargeItemReference: "ChargeItem/ci1", amountCents: 18500 }],
  });
  assert.throws(
    () =>
      buildFinancialSummary({
        practiceName: "IV&A",
        patientName: "Wanda Walkthrough",
        receiptDate: "2026-07-05",
        orderId: "ORD-1004",
        invoice: untenderedInvoice,
        chargeItems: [CHARGES[0]],
      }),
    /tender/i,
  );
});
