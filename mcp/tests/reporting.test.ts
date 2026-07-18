import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaimSearchRow } from "../src/claims/claim-search.js";
import type { EraWorklistAttentionItem, WorklistCode } from "../src/claims/era-worklist.js";
import {
  projectServiceProduction,
  projectAccountsReceivableDashboard,
  toCsv,
} from "../src/reporting/reporting.js";
import type { Invoice, PaymentReconciliation } from "@medplum/fhirtypes";
import {
  ODOS_BALANCE_FUNDING_CODE,
  ODOS_PACKAGE_CREDIT_TENDER_CODE,
  ODOS_REVENUE_CLASS_SYSTEM,
} from "../src/commercial-engine/package-service.js";
import { ODOS_BANK_CREDIT_TENDER_CODE } from "../src/commercial-engine/credit-bank-service.js";
import {
  ODOS_PAYMENT_TENDER_SYSTEM,
  paymentTenderExtensionForReconciliation,
} from "../src/fhir/odosPaymentTender.js";

test("AR dashboard hand-computes average age, aging buckets, and open-worklist counts", () => {
  const claims = [10, 45, 75, 120].map(claimRow);
  const worklist = [
    worklistItem("era-denial", "task-1"),
    worklistItem("era-denial", "task-2"),
    worklistItem("era-line-linkage", "task-3"),
    worklistItem("claim-rejected", "task-4"),
  ];

  const dashboard = projectAccountsReceivableDashboard(claims, worklist);

  assert.equal(dashboard.outstandingClaimCount, 4);
  assert.equal(dashboard.averageDaysOutstanding, 62.5);
  assert.deepEqual(dashboard.agingBuckets.map((bucket) => bucket.claimCount), [1, 1, 1, 1]);
  assert.equal(dashboard.openWorklistTotal, 4);
  assert.equal(dashboard.openWorklistCounts["era-denial"], 2);
  assert.equal(dashboard.openWorklistCounts["era-line-linkage"], 1);
  assert.equal(dashboard.openWorklistCounts["claim-rejected"], 1);
  assert.equal(dashboard.totalOutstanding.status, "unavailable");
  assert.match(dashboard.totalOutstanding.reason, /No shipped Claim-to-Invoice balance link/);
});

test("CSV output quotes punctuation and neutralizes spreadsheet formulas", () => {
  const csv = toCsv(["Patient", "Message"], [["=IMPORTXML(1)", "said \"hello\", then left\nnext line"]]);
  assert.match(csv, /^\uFEFFPatient,Message\r\n'=IMPORTXML\(1\),/);
  assert.match(csv, /"said ""hello"", then left\nnext line"/);
});

test("a $3,600 package sale and one $1,200 redemption recognize exactly $1,200 of service production", () => {
  const funding: Invoice = {
    resourceType: "Invoice",
    id: "package-sale",
    status: "balanced",
    date: "2026-07-18T14:00:00Z",
    meta: { tag: [{ system: ODOS_REVENUE_CLASS_SYSTEM, code: ODOS_BALANCE_FUNDING_CODE }] },
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/odos-payment-tender",
      valueCodeableConcept: { coding: [{ system: ODOS_PAYMENT_TENDER_SYSTEM, code: "CASH" }] },
    }],
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: { text: "Dry-Eye IPL x3" },
      priceComponent: [{ type: "base", amount: usd(360_000) }],
    }],
    totalGross: usd(360_000),
    totalNet: usd(360_000),
  };
  const redemption: Invoice = {
    resourceType: "Invoice",
    id: "redemption-1",
    status: "issued",
    date: "2026-07-19T14:00:00Z",
    lineItem: [{
      sequence: 1,
      chargeItemReference: { reference: "ChargeItem/ipl-1" },
      priceComponent: [{ type: "base", amount: usd(120_000) }],
    }],
    totalGross: usd(120_000),
    totalNet: usd(120_000),
  };
  const packageCredit: PaymentReconciliation = {
    resourceType: "PaymentReconciliation",
    id: "package-credit-1",
    status: "active",
    outcome: "complete",
    created: "2026-07-19T14:00:00Z",
    paymentDate: "2026-07-19",
    paymentAmount: usd(120_000),
    detail: [{ request: { reference: "Invoice/redemption-1" }, amount: usd(120_000) }],
    extension: [paymentTenderExtensionForReconciliation({ code: ODOS_PACKAGE_CREDIT_TENDER_CODE })],
  };

  const report = projectServiceProduction("2026-07", [funding, redemption], [packageCredit]);

  assert.equal(report.cashCollectedCents, 360_000);
  assert.equal(report.balanceFundingCents, 360_000);
  assert.equal(report.productionCents, 120_000);
  assert.equal(report.productionInvoiceCount, 1);
});

test("a $500 Credit Bank deposit plus $50 bonus funds $550 production without fabricating cash", () => {
  const funding: Invoice = {
    resourceType: "Invoice",
    id: "bank-funding",
    status: "balanced",
    date: "2026-07-18T14:00:00Z",
    meta: { tag: [{ system: ODOS_REVENUE_CLASS_SYSTEM, code: ODOS_BALANCE_FUNDING_CODE }] },
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/odos-payment-tender",
      valueCodeableConcept: { coding: [{ system: ODOS_PAYMENT_TENDER_SYSTEM, code: "CASH" }] },
    }],
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: { text: "Credit Bank deposit" },
      priceComponent: [{ type: "base", amount: usd(50_000) }],
    }],
    totalGross: usd(50_000),
    totalNet: usd(50_000),
  };
  const service: Invoice = {
    resourceType: "Invoice",
    id: "bank-service",
    status: "issued",
    date: "2026-07-19T14:00:00Z",
    lineItem: [{
      sequence: 1,
      chargeItemReference: { reference: "ChargeItem/service-1" },
      priceComponent: [{ type: "base", amount: usd(55_000) }],
    }],
    totalGross: usd(55_000),
    totalNet: usd(55_000),
  };
  const bankCredit: PaymentReconciliation = {
    resourceType: "PaymentReconciliation",
    id: "bank-credit-1",
    status: "active",
    outcome: "complete",
    created: "2026-07-19T14:00:00Z",
    paymentDate: "2026-07-19",
    paymentAmount: usd(55_000),
    detail: [{ request: { reference: "Invoice/bank-service" }, amount: usd(55_000) }],
    extension: [paymentTenderExtensionForReconciliation({ code: ODOS_BANK_CREDIT_TENDER_CODE })],
  };

  const report = projectServiceProduction("2026-07", [funding, service], [bankCredit]);

  assert.equal(report.cashCollectedCents, 50_000);
  assert.equal(report.productionCents, 55_000);
  assert.equal(report.balanceFundingCents, 50_000);
  assert.equal(report.productionInvoiceCount, 1);
});

test("partial allocations do not recognize an Invoice as fully collected production", () => {
  const invoice: Invoice = {
    resourceType: "Invoice",
    id: "partially-paid-service",
    status: "issued",
    date: "2026-07-20T14:00:00Z",
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: { text: "Synthetic service" },
      priceComponent: [{ type: "base", amount: usd(120_000) }],
    }],
    totalGross: usd(120_000),
    totalNet: usd(120_000),
  };
  const partial: PaymentReconciliation = {
    resourceType: "PaymentReconciliation",
    status: "active",
    outcome: "complete",
    created: "2026-07-20T14:00:00Z",
    paymentDate: "2026-07-20",
    paymentAmount: usd(60_000),
    detail: [{ request: { reference: "Invoice/partially-paid-service" }, amount: usd(60_000) }],
  };

  const report = projectServiceProduction("2026-07", [invoice], [partial]);

  assert.equal(report.cashCollectedCents, 60_000);
  assert.equal(report.productionCents, 0);
  assert.equal(report.productionInvoiceCount, 0);
});

test("an unrecognized tender extension cannot mark an issued Invoice collected", () => {
  const invoice: Invoice = {
    resourceType: "Invoice",
    id: "spoofed-tender",
    status: "issued",
    extension: [{
      url: "https://odos2020.com/fhir/StructureDefinition/odos-payment-tender",
      valueCodeableConcept: { coding: [{ system: "https://example.test/not-odos", code: "CASH" }] },
    }],
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: { text: "Synthetic service" },
      priceComponent: [{ type: "base", amount: usd(12_000) }],
    }],
    totalGross: usd(12_000),
    totalNet: usd(12_000),
  };

  assert.deepEqual(projectServiceProduction("2026-07", [invoice], []), {
    period: "2026-07",
    cashCollectedCents: 0,
    productionCents: 0,
    balanceFundingCents: 0,
    productionInvoiceCount: 0,
  });
});

function claimRow(daysSinceSubmission: number): ClaimSearchRow {
  return {
    claimReference: `Claim/claim-${daysSinceSubmission}`,
    claimNumber: `CLAIM-${daysSinceSubmission}`,
    patientReference: "Patient/patient-1",
    patient: "Jamie Synthetic",
    providerReference: "Practitioner/provider-1",
    provider: "Alex Synthetic",
    cptCodes: ["PROC-A"],
    totalChargedCents: 10_000,
    insurancePaidCents: 0,
    patientResponsibilityCents: 0,
    status: "submitted",
    payerReference: "Organization/payer-1",
    payer: "Synthetic Health",
    daysSinceSubmission,
  };
}

function worklistItem(code: WorklistCode, id: string): EraWorklistAttentionItem {
  return {
    id,
    taskReference: `Task/${id}`,
    title: code,
    code,
    severity: code === "era-underpayment" ? "medium" : "high",
    ageTimer: { startedAt: "2026-07-10T12:00:00.000Z", elapsedMinutes: 30 },
    action: "claim",
    status: "new",
    evidence: code === "claim-rejected"
      ? { kind: "claim-rejected", claimMdMessage: "Rejected" }
      : {
          kind: "era",
          pcn: "PCN-1",
          eraId: "ERA-1",
          chargedCents: 10_000,
          allowedCents: 8_000,
          paidCents: 0,
          patientResponsibilityCents: 0,
          shortfallCents: 8_000,
          adjustments: [],
        },
  };
}

function usd(cents: number): { value: number; currency: "USD" } {
  return { value: cents / 100, currency: "USD" };
}
