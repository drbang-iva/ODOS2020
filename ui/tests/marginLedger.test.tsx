import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarginLedger } from "../src/scenes/MarginLedger";
import { fetchMarginLedger, type MarginLedger as MarginLedgerData, type MarginLine } from "../src/lib/margin-ledger";

const LINES: MarginLine[] = [
  line({
    id: "settled",
    item: "Meridian 88 · Havana",
    vendor: "Safilo",
    state: "Settled",
    estimatedPlanPaidCents: 7_800,
    planPaidCents: 5_400,
    estimatedMarginCents: 8_100,
    marginCents: 5_700,
    multiplierMilli: 1_919,
    driftCents: -2_400,
    deductions: [{ label: "Contractual adjustment (CO-45)", amountCents: 1_200 }],
    claimReference: "Claim/claim-1",
    claimResponseReference: "ClaimResponse/response-1",
    paymentReconciliationReference: "PaymentReconciliation/payment-1",
  }),
  line({
    id: "estimated",
    item: "Oasys 1-Day · 90pk ×2",
    vendor: "Johnson & Johnson",
    productClass: "contact",
    state: "Estimated",
    estimatedPlanPaidCents: 7_000,
    estimatedMarginCents: 11_400,
  }),
  line({
    id: "flagged",
    item: "Ateliers 5 · Tortoise",
    vendor: "Europa",
    state: "Flagged",
    estimatedPlanPaidCents: 9_200,
    estimatedMarginCents: 10_600,
    linkageTaskReference: "Task/task-1",
  }),
  line({
    id: "unpriced",
    item: "Brookline 04 · Slate",
    vendor: "ClearVision",
    state: "Estimated",
    unpricedPlanPortion: true,
    estimatedMarginCents: 1_200,
  }),
];

const LEDGER: MarginLedgerData = {
  period: "2026-07",
  genesisDate: "2026-07-15",
  targetMultiplierMilli: 3_000,
  realizedMarginCents: 5_700,
  inFlightCents: 23_200,
  driftCents: -2_400,
  realizedMultiplierMilli: 1_919,
  settledLineCount: 1,
  inFlightLineCount: 3,
  lines: LINES,
};

test("ledger renders four numerals, all three truth states, thin-state banner, and unpriced floor", () => {
  const html = renderToStaticMarkup(<MarginLedger initialLedger={LEDGER} />);
  for (const label of ["Realized margin", "In flight", "Drift", "Realized ×"]) assert.match(html, new RegExp(label));
  assert.match(html, /The ledger begins <strong>2026-07-15<\/strong>/);
  assert.match(html, />Settled</);
  assert.match(html, />Estimated</);
  assert.match(html, /Linkage review/);
  assert.match(html, /href="\/billing\/claims\/worklist\?lane=era-line-linkage"/);
  assert.match(html, /plan portion unpriced/);
  assert.match(html, /href="\/settings\/plan-profiles"/);
  assert.match(html, /named deduction/);
  assert.doesNotMatch(html, /margin-line-flagged[\s\S]*?margin-solid-money/);
});

test("margin ledger client binds the requested period and surfaces endpoint errors", async () => {
  const loaded = await fetchMarginLedger("2026-07", async (input) => {
    assert.equal(input, "/practice/margin-ledger?period=2026-07");
    return new Response(JSON.stringify(LEDGER), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  assert.equal(loaded.lines.length, 4);
  await assert.rejects(
    () => fetchMarginLedger("2026-07", async () => new Response(JSON.stringify({ error: "margin.read role required" }), { status: 403 })),
    /margin\.read role required/,
  );
  await assert.rejects(
    () => fetchMarginLedger("2026-07", async () => new Response("", { status: 404 })),
    /Margin ledger failed with HTTP 404/,
  );
});

function line(overrides: Partial<MarginLine> & Pick<MarginLine, "id" | "item" | "vendor" | "state" | "estimatedMarginCents">): MarginLine {
  return {
    id: overrides.id,
    chargeItemReference: `ChargeItem/${overrides.id}`,
    productClass: "frame",
    item: overrides.item,
    vendor: overrides.vendor,
    planName: "VSP",
    saleDate: "2026-07-15T14:32:00Z",
    wholesaleCents: 6_200,
    retailCents: 18_500,
    taxCents: 455,
    patientPaidCents: 6_500,
    deductions: [],
    estimatedMarginCents: overrides.estimatedMarginCents,
    state: overrides.state,
    unpricedPlanPortion: false,
    collectReceiptReferences: [`Invoice/invoice-${overrides.id}`],
    ...overrides,
  };
}
