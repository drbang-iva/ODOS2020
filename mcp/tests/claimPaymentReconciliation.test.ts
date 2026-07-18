import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaimResponse } from "@medplum/fhirtypes";
import { ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL } from "../src/claims/claimmd-fhir.js";
import {
  buildInsurancePaymentReconciliation,
  claimResponseLinePaymentAllocations,
  INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE,
  INSURANCE_CLAIM_ROLLUP_DETAIL_CODE,
  ODOS_INSURANCE_PAYMENT_DETAIL_LEVEL_SYSTEM,
} from "../src/payments/payment-reconciliation.js";

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
    processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/claimmd-era",
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

test("identity-linked lines are discriminated and their detail amounts do not duplicate the payment total", () => {
  const response: ClaimResponse = {
    resourceType: "ClaimResponse",
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-15",
    insurer: { reference: "Organization/payer-1" },
    request: { reference: "Claim/claim-1" },
    outcome: "complete",
    item: [{
      itemSequence: 1,
      extension: [{
        url: ODOS_CLAIM_CHARGE_ITEM_EXTENSION_URL,
        valueReference: { reference: "ChargeItem/charge-1" },
      }],
      adjudication: [{ category: { text: "paid" }, amount: { value: 80, currency: "USD" } }],
    }],
  };
  const pr = buildInsurancePaymentReconciliation({
    createdIso: "2026-07-15T12:00:00.000Z",
    paymentDate: "2026-07-15",
    amountCents: 8_000,
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    processorTransactionId: "ERA-1",
    processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/test-era",
    lineAllocations: claimResponseLinePaymentAllocations(response),
  });

  assert.deepEqual(pr.detail?.[0], {
    type: { coding: [
      { system: "http://terminology.hl7.org/CodeSystem/payment-type", code: "payment", display: "Payment" },
      { system: ODOS_INSURANCE_PAYMENT_DETAIL_LEVEL_SYSTEM, code: INSURANCE_CLAIM_ROLLUP_DETAIL_CODE, display: "Claim rollup" },
    ] },
    request: { reference: "Claim/claim-1" },
    response: { reference: "ClaimResponse/response-1" },
  });
  assert.deepEqual(pr.detail?.[1], {
    type: { coding: [
      { system: "http://terminology.hl7.org/CodeSystem/payment-type", code: "payment", display: "Payment" },
      { system: ODOS_INSURANCE_PAYMENT_DETAIL_LEVEL_SYSTEM, code: INSURANCE_CHARGE_ITEM_ALLOCATION_DETAIL_CODE, display: "ChargeItem allocation" },
    ] },
    request: { reference: "ChargeItem/charge-1" },
    response: { reference: "ClaimResponse/response-1" },
    amount: { value: 80, currency: "USD" },
  });
  assert.equal(pr.detail?.reduce((sum, detail) => sum + (detail.amount?.value ?? 0), 0), 80);
});

test("a partially linked insurance payment leaves only the unallocated remainder on the Claim rollup", () => {
  const pr = buildInsurancePaymentReconciliation({
    createdIso: "2026-07-15T12:00:00.000Z",
    paymentDate: "2026-07-15",
    amountCents: 10_000,
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    processorTransactionId: "ERA-2",
    processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/test-era",
    lineAllocations: [{ chargeItemReference: "ChargeItem/charge-1", amountCents: 8_000 }],
  });

  assert.equal(pr.detail?.[0]?.amount?.value, 20);
  assert.equal(pr.detail?.[1]?.amount?.value, 80);
  assert.equal(pr.detail?.reduce((sum, detail) => sum + (detail.amount?.value ?? 0), 0), 100);
});

test("positional-only ClaimResponse lines leave the existing whole-claim payment detail unchanged", () => {
  const response: ClaimResponse = {
    resourceType: "ClaimResponse",
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-15",
    insurer: { reference: "Organization/payer-1" },
    request: { reference: "Claim/claim-1" },
    outcome: "complete",
    item: [{
      itemSequence: 1,
      adjudication: [{ category: { text: "paid" }, amount: { value: 80, currency: "USD" } }],
    }],
  };
  assert.deepEqual(claimResponseLinePaymentAllocations(response), []);
});

test("buildInsurancePaymentReconciliation retains its amount, reference, and date guards", () => {
  const valid = {
    createdIso: "2026-07-10T12:00:00.000Z",
    paymentDate: "2026-07-10",
    amountCents: 100,
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    processorTransactionId: "EFT-1",
    processorTransactionSystem: "https://odos2020.com/fhir/NamingSystem/manual-eob",
  };
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, amountCents: 0 }), /positive integer number of cents/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, amountCents: -1 }), /positive integer number of cents/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, claimReference: "Invoice/claim-1" }), /Claim\/<id>/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, claimResponseReference: "Claim/response-1" }), /ClaimResponse\/<id>/);
  assert.throws(() => buildInsurancePaymentReconciliation({ ...valid, paymentDate: "" }), /paymentDate must be an R4 date/);
});
