import assert from "node:assert/strict";
import { test } from "node:test";
import type { Claim } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createManualEob,
  dollarsToCents,
  postManualEobClaim,
  type ManualEobHeader,
} from "../src/lib/manual-eob";
import { ManualEobPostingPanel, ManualEobSummary } from "../src/scenes/claims/CarrierPayments";

test("carrier payment summary uses the applied and remaining Foxfire framing", () => {
  const html = renderToStaticMarkup(<ManualEobSummary header={header()} busy={false} onClose={() => undefined} />);
  assert.match(html, /Applied \$70\.00 \/ Remaining \$30\.00/);
  assert.match(html, /EFT-900/);
  assert.match(html, /Close EOB/);
  assert.match(html, /Claim\/claim-1/);
});

test("manual posting panel renders paid, allowed, and separate PR-1, PR-2, PR-3 inputs", () => {
  const html = renderToStaticMarkup(
    <ManualEobPostingPanel
      claim={claim()}
      lines={[{ itemSequence: 1, allowed: "100.00", paid: "70.00", deductible: "10.00", coinsurance: "12.00", copay: "8.00" }]}
      busy={false}
      onChange={() => undefined}
      onClose={() => undefined}
      onPost={() => undefined}
    />,
  );
  for (const label of ["Allowed", "Paid", "PR-1 deductible", "PR-2 coinsurance", "PR-3 copay"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /Submitted \$125\.00/);
  assert.match(html, /Post claim line/);
});

test("manual EOB client creates a header then posts integer-cent line inputs", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response({ header: header() }, init?.method === "POST" ? 201 : 200);
  };
  await createManualEob({
    payerReference: "Organization/payer-1",
    paymentReference: "EFT-900",
    paymentDate: "2026-07-10",
    depositDate: "2026-07-11",
    totalAmountCents: 10_000,
  }, { authorization: "Bearer test", fetchImpl });
  await postManualEobClaim("eob-1", {
    claimReference: "Claim/claim-1",
    lines: [{ itemSequence: 1, allowedCents: 10_000, paidCents: 7_000, deductibleCents: 1_000, coinsuranceCents: 1_200, copayCents: 800 }],
  }, { authorization: "Bearer test", fetchImpl });

  assert.equal(calls[0].url, "/claims/manual-eob");
  assert.equal(calls[1].url, "/claims/manual-eob/eob-1/post");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)).lines[0], {
    itemSequence: 1,
    allowedCents: 10_000,
    paidCents: 7_000,
    deductibleCents: 1_000,
    coinsuranceCents: 1_200,
    copayCents: 800,
  });
  assert.equal(dollarsToCents("125.50"), 12_550);
});

function header(): ManualEobHeader {
  return {
    id: "eob-1",
    payerReference: "Organization/payer-1",
    paymentReference: "EFT-900",
    paymentDate: "2026-07-10",
    depositDate: "2026-07-11",
    totalAmountCents: 10_000,
    appliedAmountCents: 7_000,
    remainingAmountCents: 3_000,
    status: "draft",
    createdAt: "2026-07-10T12:00:00.000Z",
    postings: [{
      claimReference: "Claim/claim-1",
      claimResponseReference: "ClaimResponse/response-1",
      paymentReconciliationReference: "PaymentReconciliation/payment-1",
      amountCents: 7_000,
      postedAt: "2026-07-10T12:05:00.000Z",
    }],
  };
}

function claim(): Claim {
  return {
    resourceType: "Claim",
    id: "claim-1",
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: "Patient/pat-1" },
    created: "2026-07-10",
    insurer: { reference: "Organization/payer-1" },
    provider: { reference: "Practitioner/provider-1" },
    priority: { text: "normal" },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: "Coverage/cov-1" } }],
    item: [{
      sequence: 1,
      productOrService: { coding: [{ system: "https://osod.test/procedure", code: "PROC-A" }] },
      net: { value: 125, currency: "USD" },
    }],
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
