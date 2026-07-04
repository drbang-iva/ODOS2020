import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpticalChargeItem } from "../src/fhir/opticalCharge.js";
import { buildOpticalInvoice } from "../src/fhir/opticalInvoice.js";
import {
  buildFinancialSummary as buildMcpFinancialSummary,
  renderReceiptSheet as renderMcpReceiptSheet,
  type BuildFinancialSummaryInput,
} from "../src/fhir/opticalFinancialSummary.js";
import {
  buildFinancialSummary as buildUiFinancialSummary,
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
