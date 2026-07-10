import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInsurancePaymentReconciliation } from "../src/payments/payment-reconciliation.js";

test("buildInsurancePaymentReconciliation adds the v0.6d insurance row: request Claim, response ClaimResponse", () => {
  const pr = buildInsurancePaymentReconciliation({
    createdIso: "2026-07-09T12:00:00.000Z",
    paymentDate: "2026-07-09",
    amountCents: 17000,
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/cr-1",
    insurerReference: "Organization/payer-1",
    practiceOrgReference: "Organization/practice-1",
    processorTransactionId: "era-900",
    processorTransactionSystem: "https://osod.dev/fhir/NamingSystem/claimmd-era",
    description: "Claim.MD ERA era-900",
  });

  assert.equal(pr.resourceType, "PaymentReconciliation");
  assert.equal(pr.status, "active");
  assert.equal(pr.outcome, "complete");
  assert.equal(pr.paymentAmount.value, 170);
  assert.equal(pr.paymentIdentifier?.value, "era-900");
  assert.equal(pr.paymentIssuer?.reference, "Organization/payer-1");
  assert.equal(pr.detail?.[0]?.request?.reference, "Claim/claim-1");
  assert.equal(pr.detail?.[0]?.response?.reference, "ClaimResponse/cr-1");
  assert.equal(pr.detail?.[0]?.amount?.value, 170);
});

test("buildInsurancePaymentReconciliation retains its amount, reference, and date guards", () => {
  const valid = {
    createdIso: "2026-07-10T12:00:00.000Z",
    paymentDate: "2026-07-10",
    amountCents: 100,
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    processorTransactionId: "EFT-1",
    processorTransactionSystem: "https://osod.dev/fhir/NamingSystem/manual-eob",
  };
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, amountCents: 0 }), /positive integer number of cents/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, amountCents: -1 }), /positive integer number of cents/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, claimReference: "Invoice/claim-1" }), /Claim\/<id>/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, claimResponseReference: "Claim/response-1" }), /ClaimResponse\/<id>/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, paymentDate: "" }), /paymentDate must be an R4 date/);
});
