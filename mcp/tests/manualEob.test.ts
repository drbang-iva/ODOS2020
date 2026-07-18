import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendManualEobPosting,
  buildManualEobHeader,
  closeManualEobHeader,
  parseManualEobHeader,
} from "../src/claims/manual-eob.js";

test("manual EOB Basic persists a resumable applied total and posting references", () => {
  const draft = {
    ...buildManualEobHeader({
      payerReference: "Organization/payer-1",
      paymentReference: "EFT-900",
      paymentDate: "2026-07-10",
      depositDate: "2026-07-11",
      totalAmountCents: 10_000,
      createdAt: "2026-07-10T12:00:00.000Z",
    }),
    id: "eob-1",
  };
  const partial = appendManualEobPosting(draft, {
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    paymentReconciliationReference: "PaymentReconciliation/payment-1",
    amountCents: 8_000,
    postedAt: "2026-07-10T12:05:00.000Z",
  });

  assert.deepEqual(parseManualEobHeader(partial), {
    id: "eob-1",
    payerReference: "Organization/payer-1",
    paymentReference: "EFT-900",
    paymentDate: "2026-07-10",
    depositDate: "2026-07-11",
    totalAmountCents: 10_000,
    appliedAmountCents: 8_000,
    remainingAmountCents: 2_000,
    status: "draft",
    createdAt: "2026-07-10T12:00:00.000Z",
    postings: [{
      claimReference: "Claim/claim-1",
      claimResponseReference: "ClaimResponse/response-1",
      paymentReconciliationReference: "PaymentReconciliation/payment-1",
      amountCents: 8_000,
      postedAt: "2026-07-10T12:05:00.000Z",
    }],
  });
  assert.equal(parseManualEobHeader(closeManualEobHeader(partial)).status, "closed");
});

test("manual EOB header rejects duplicate claims and over-application", () => {
  const draft = {
    ...buildManualEobHeader({
      payerReference: "Organization/payer-1",
      paymentReference: "CHECK-1",
      paymentDate: "2026-07-10",
      depositDate: "2026-07-10",
      totalAmountCents: 5_000,
      createdAt: "2026-07-10T12:00:00.000Z",
    }),
    id: "eob-1",
  };
  const posting = {
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    paymentReconciliationReference: "PaymentReconciliation/payment-1",
    amountCents: 4_000,
    postedAt: "2026-07-10T12:05:00.000Z",
  };
  const partial = appendManualEobPosting(draft, posting);
  assert.throws(() => appendManualEobPosting(partial, posting), /already posted/);
  assert.throws(() => appendManualEobPosting(partial, {
    ...posting,
    claimReference: "Claim/claim-2",
    claimResponseReference: "ClaimResponse/response-2",
    paymentReconciliationReference: "PaymentReconciliation/payment-2",
    amountCents: 1_001,
  }), /exceeds/);
});
