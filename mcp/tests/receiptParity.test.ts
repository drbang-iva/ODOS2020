import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpticalChargeItem } from "../src/fhir/opticalCharge.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import {
  buildFinancialSummary as buildMcpFinancialSummary,
  paymentReconciliationsToTenderLines as mcpPaymentReconciliationsToTenderLines,
  renderReceiptSheet as renderMcpReceiptSheet,
  type BuildFinancialSummaryInput,
} from "../src/fhir/opticalFinancialSummary.js";
import { buildPaymentReconciliation } from "../src/payments/payment-reconciliation.js";
import {
  buildFinancialSummary as buildUiFinancialSummary,
  paymentReconciliationsToTenderLines as uiPaymentReconciliationsToTenderLines,
  renderReceiptSheet as renderUiReceiptSheet,
} from "../../ui/src/lib/optical-financial-summary.js";

const CHARGES = [
  buildOpticalChargeItem({
    patientReference: "Patient/receipt-parity",
    deviceRequestReference: "DeviceRequest/receipt-parity",
    encounterReference: "Encounter/receipt-parity",
    code: "V2020",
    codeDisplay: "Frames, purchases",
    feeCents: 19500,
  }),
  buildOpticalChargeItem({
    patientReference: "Patient/receipt-parity",
    deviceRequestReference: "DeviceRequest/receipt-parity",
    encounterReference: "Encounter/receipt-parity",
    code: "V2100",
    codeDisplay: "Sphere, single vision",
    feeCents: 12500,
  }),
];

const INVOICE = {
  ...buildOpticalInvoice({
    patientReference: "Patient/receipt-parity",
    tender: "CHECK",
    lineItems: [
      { chargeItemReference: "ChargeItem/receipt-ci-1", amountCents: 19500, discount: { code: "PPAY", amountCents: 3900 } },
      { chargeItemReference: "ChargeItem/receipt-ci-2", amountCents: 12500, discount: { code: "PPAY", amountCents: 2500 } },
    ],
  }),
  id: "receipt-parity-invoice",
};

const CASH_INVOICE = {
  ...buildOpticalInvoice({
    patientReference: "Patient/receipt-parity",
    tender: "CASH",
    lineItems: [
      { chargeItemReference: "ChargeItem/receipt-ci-1", amountCents: 19500, discount: { code: "PPAY", amountCents: 3900 } },
      { chargeItemReference: "ChargeItem/receipt-ci-2", amountCents: 12500, discount: { code: "PPAY", amountCents: 2500 } },
    ],
  }),
  id: "receipt-parity-cash-invoice",
};

const UNTENDERED_INVOICE = {
  ...buildOpticalInvoice({
    patientReference: "Patient/receipt-parity",
    lineItems: [
      { chargeItemReference: "ChargeItem/receipt-ci-1", amountCents: 19500, discount: { code: "PPAY", amountCents: 3900 } },
      { chargeItemReference: "ChargeItem/receipt-ci-2", amountCents: 12500, discount: { code: "PPAY", amountCents: 2500 } },
    ],
  }),
  id: "receipt-parity-card-invoice",
};

const CARD_PAYMENT = buildPaymentReconciliation({
  outcome: "success",
  createdIso: "2026-07-05T15:00:00.000Z",
  paymentDate: "2026-07-05",
  amountCents: 25600,
  subjectReference: "Patient/receipt-patient",
  invoiceReference: "Invoice/receipt-parity-card-invoice",
  taskReference: "Task/receipt-parity-task",
  staffReference: "Practitioner/receipt-staff",
  processorTransactionId: "clover-test-0010",
  processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/clover-payment",
  feesCents: 0,
  surface: "in-clinic-pos",
  tender: { code: "CARD", display: "VISA ****0010" },
  description: "Optical order card payment",
});

const INPUT: BuildFinancialSummaryInput = {
  practiceName: "Integrated Vision & Aesthetics",
  patientName: "Riley Receipt",
  patientRef: "Patient/receipt-parity",
  receiptDate: "2026-07-04",
  orderId: "ORD-RECEIPT-PARITY",
  providerName: "Dr. Bang",
  invoice: INVOICE,
  chargeItems: CHARGES,
};

test("UI financial-summary builder mirrors the MCP builder output", () => {
  assert.deepEqual(buildUiFinancialSummary(INPUT), buildMcpFinancialSummary(INPUT));
});

test("UI receipt sheet renderer mirrors the MCP renderer output", () => {
  const mcpSummary = buildMcpFinancialSummary(INPUT);
  const uiSummary = buildUiFinancialSummary(INPUT);
  assert.equal(renderUiReceiptSheet(uiSummary), renderMcpReceiptSheet(mcpSummary));
});

test("UI receipt renderer prints an escaped configured footer and omits an unset footer element", () => {
  const configured = buildUiFinancialSummary({
    ...INPUT,
    receiptFooterMessage: '<script>alert("receipt")</script>',
  });
  const html = renderUiReceiptSheet(configured);
  assert.match(html, /class="practice-message"/);
  assert.match(html, /&lt;script&gt;alert\(&quot;receipt&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(
    renderUiReceiptSheet(buildUiFinancialSummary(INPUT)),
    /class="practice-message"/,
  );
});

test("UI PaymentReconciliation tender projection mirrors the MCP projection output", () => {
  assert.deepEqual(
    uiPaymentReconciliationsToTenderLines([CARD_PAYMENT]),
    mcpPaymentReconciliationsToTenderLines([CARD_PAYMENT]),
  );
});

test("UI receipt sheet renderer mirrors MCP for an untendered Invoice paid by card PR", () => {
  const payments = mcpPaymentReconciliationsToTenderLines([CARD_PAYMENT]);
  const mcpSummary = buildMcpFinancialSummary({
    ...INPUT,
    invoice: UNTENDERED_INVOICE,
    payments,
  });
  const uiSummary = buildUiFinancialSummary({
    ...INPUT,
    invoice: UNTENDERED_INVOICE,
    payments: uiPaymentReconciliationsToTenderLines([CARD_PAYMENT]),
  });

  assert.deepEqual(uiSummary, mcpSummary);
  assert.equal(renderUiReceiptSheet(uiSummary), renderMcpReceiptSheet(mcpSummary));
});

test("UI receipt consistency: cash and card payments differ only by tender row", () => {
  const cashSummary = buildUiFinancialSummary({
    ...INPUT,
    invoice: CASH_INVOICE,
  });
  const cardSummary = buildUiFinancialSummary({
    ...INPUT,
    invoice: UNTENDERED_INVOICE,
    payments: uiPaymentReconciliationsToTenderLines([CARD_PAYMENT]),
  });

  assert.deepEqual(cardSummary.totals, cashSummary.totals);
  assert.deepEqual(cardSummary.lines, cashSummary.lines);
  assert.equal(cashSummary.amountDueNowCents, 0);
  assert.equal(cardSummary.amountDueNowCents, 0);
  assert.equal(cardSummary.payments.paymentsAppliedCents, cashSummary.payments.paymentsAppliedCents);
  assert.deepEqual(cashSummary.payments.tenderLines, [{ tender: "CASH", amountCents: 25600 }]);
  assert.deepEqual(cardSummary.payments.tenderLines, [
    { tender: "VISA ****0010", amountCents: 25600 },
  ]);
  assert.match(renderUiReceiptSheet(cashSummary), /AMOUNT DUE NOW: \$0\.00/);
  assert.match(renderUiReceiptSheet(cardSummary), /AMOUNT DUE NOW: \$0\.00/);
});
