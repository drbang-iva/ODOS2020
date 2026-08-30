import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import * as remittanceApi from "../src/claims/manual-eob.js";
import {
  appendManualEobPosting,
  buildManualEobHeader,
  closeManualEobHeader,
  parseManualEobHeader,
} from "../src/claims/manual-eob.js";

interface RemittanceApi {
  buildRemittanceBatch(input: Record<string, unknown>): Basic;
  appendRemittanceAllocation(batch: Basic, allocation: Record<string, unknown>): Basic;
  reverseRemittanceAllocation(batch: Basic, input: Record<string, unknown>): Basic;
  buildProviderAdjustment(input: Record<string, unknown>): Basic;
  projectRemittanceBatch(batch: Basic, adjustments: Basic[], asOf: string): Record<string, unknown>;
}

const remittance = remittanceApi as unknown as Partial<RemittanceApi>;

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
    provenance: "manual",
    sourceReference: "urn:odos:manual-eob:EFT-900",
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

test("remittance batch persists source provenance and a remittance date distinct from creation", () => {
  const batch = buildManualEobHeader({
    payerReference: "Organization/payer-1",
    paymentReference: "835-TRACE-1",
    paymentDate: "2026-07-01",
    depositDate: "2026-07-03",
    totalAmountCents: 10_000,
    createdAt: "2026-07-20T12:00:00.000Z",
    provenance: "clearinghouse",
    sourceReference: "urn:stedi:835:835-TRACE-1",
  } as Parameters<typeof buildManualEobHeader>[0] & {
    provenance: string;
    sourceReference: string;
  });
  const values = batch.extension?.[0]?.extension ?? [];

  assert.equal(values.find((entry) => entry.url === "remittance-date")?.valueDate, "2026-07-01");
  assert.equal(values.find((entry) => entry.url === "creation-date")?.valueDateTime, "2026-07-20T12:00:00.000Z");
  assert.equal(values.find((entry) => entry.url === "provenance")?.valueCode, "clearinghouse");
  assert.equal(values.find((entry) => entry.url === "source-reference")?.valueUri, "urn:stedi:835:835-TRACE-1");
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

test("remittance allocations preserve origin, confidence, and append-only individual reversal history", () => {
  assert.equal(typeof remittance.buildRemittanceBatch, "function");
  assert.equal(typeof remittance.appendRemittanceAllocation, "function");
  assert.equal(typeof remittance.reverseRemittanceAllocation, "function");
  const build = remittance.buildRemittanceBatch!;
  const append = remittance.appendRemittanceAllocation!;
  const reverse = remittance.reverseRemittanceAllocation!;
  const batch = {
    ...build({
      payerReference: "Organization/payer-1",
      paymentReference: "TRACE-2",
      remittanceDate: "2026-08-01",
      creationDate: "2026-08-20T12:00:00.000Z",
      totalAmountCents: 80_000,
      provenance: "clearinghouse",
      sourceReference: "urn:stedi:835:TRACE-2",
    }),
    id: "batch-2",
  };
  const proposed = append(batch, {
    id: "allocation-1",
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    paymentReconciliationReference: "PaymentReconciliation/payment-1",
    amountCents: 80_000,
    origin: "machine-proposed",
    confidence: 0.97,
    recordedAt: "2026-08-20T12:05:00.000Z",
  });
  const reversed = reverse(proposed, {
    allocationId: "allocation-1",
    reversalAllocationId: "allocation-2",
    recordedAt: "2026-08-21T12:00:00.000Z",
  });
  const projection = remittance.projectRemittanceBatch!(reversed, [], "2026-08-30T00:00:00.000Z");

  assert.equal(projection.claimActivityCents, 0);
  assert.equal(projection.unallocatedAmountCents, 80_000);
  assert.equal(projection.balanced, false);
  assert.equal(projection.ageDays, 29);
  assert.deepEqual(projection.allocations, [
    {
      id: "allocation-1",
      claimReference: "Claim/claim-1",
      claimResponseReference: "ClaimResponse/response-1",
      paymentReconciliationReference: "PaymentReconciliation/payment-1",
      amountCents: 80_000,
      origin: "machine-proposed",
      confidence: 0.97,
      recordedAt: "2026-08-20T12:05:00.000Z",
    },
    {
      id: "allocation-2",
      claimReference: "Claim/claim-1",
      claimResponseReference: "ClaimResponse/response-1",
      paymentReconciliationReference: "PaymentReconciliation/payment-1",
      amountCents: -80_000,
      origin: "human-entered",
      recordedAt: "2026-08-21T12:00:00.000Z",
      reversalOfAllocationId: "allocation-1",
    },
  ]);
  assert.throws(() => reverse(reversed, {
    allocationId: "allocation-1",
    reversalAllocationId: "allocation-3",
    recordedAt: "2026-08-22T12:00:00.000Z",
  }), /already reversed/);
  assert.throws(() => append(batch, {
    id: "allocation-bad",
    claimReference: "Claim/claim-2",
    amountCents: 1,
    origin: "machine-proposed",
    recordedAt: "2026-08-20T12:05:00.000Z",
  }), /confidence/);
});

test("provider adjustments stay distinct from claims and normalize Stedi PLB signs in batch balance", () => {
  assert.equal(typeof remittance.buildProviderAdjustment, "function");
  const batch = {
    ...remittance.buildRemittanceBatch!({
      payerReference: "Organization/payer-1",
      paymentReference: "TRACE-3",
      remittanceDate: "2026-08-01",
      creationDate: "2026-08-01T12:00:00.000Z",
      totalAmountCents: 200_000,
      provenance: "clearinghouse",
      sourceReference: "urn:stedi:835:TRACE-3",
    }),
    id: "batch-3",
  };
  const allocated = remittance.appendRemittanceAllocation!(batch, {
    id: "allocation-3",
    claimReference: "Claim/claim-3",
    amountCents: 205_000,
    origin: "human-entered",
    recordedAt: "2026-08-01T12:05:00.000Z",
  });
  const plb = {
    ...remittance.buildProviderAdjustment!({
      batchReference: "Basic/batch-3",
      payerReference: "Organization/payer-1",
      identifier: "PLB-1",
      reasonCode: "WO",
      reasonText: "Overpayment recovery",
      rawSourceAmountCents: 5_000,
      sourceSystem: "stedi-835",
      createdAt: "2026-08-01T12:06:00.000Z",
    }),
    id: "plb-1",
  };
  const projection = remittance.projectRemittanceBatch!(allocated, [plb], "2026-08-30T00:00:00.000Z");

  assert.equal(projection.claimActivityCents, 205_000);
  assert.equal(projection.providerActivityCents, -5_000);
  assert.equal(projection.accountedAmountCents, 200_000);
  assert.equal(projection.unallocatedAmountCents, 0);
  assert.equal(projection.balanced, true);
  assert.throws(() => remittance.buildProviderAdjustment!({
    batchReference: "Basic/batch-3",
    payerReference: "Organization/payer-1",
    claimReference: "Claim/claim-3",
    identifier: "PLB-bad",
    reasonText: "Must not become a claim event",
    rawSourceAmountCents: 1,
    sourceSystem: "stedi-835",
    createdAt: "2026-08-01T12:06:00.000Z",
  }), /claim-level/);
});
