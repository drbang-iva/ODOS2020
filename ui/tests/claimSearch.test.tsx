import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  claimSearchFiltersFromQuery,
  failedClaimsCount,
  fetchClaimSearch,
  type ClaimSearchRow,
} from "../src/lib/claim-search";
import type { ClaimsWorklistItem } from "../src/lib/claims-worklist";
import { ClaimSearchContent } from "../src/scenes/claims/ClaimSearch";

test("claim search renders the results grid, collapsed additional criteria, and failed-claims badge", () => {
  const html = renderToStaticMarkup(
    <ClaimSearchContent
      filters={{}}
      items={[row()]}
      failedCount={2}
      loading={false}
      onFiltersChange={() => undefined}
      onSearch={() => undefined}
      onOpenWorklist={() => undefined}
    />,
  );

  assert.match(html, /Additional Search Criteria/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /2 failed claims/);
  for (const heading of ["Claim #", "Patient", "Provider", "CPT", "Charged", "Insurance paid", "Patient responsibility", "Status", "Payer", "Days since submission"]) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, /ODOS-CLAIM-1/);
  assert.match(html, /\$125\.00/);
  assert.match(html, /\$25\.00/);
});

test("claim search keeps decimal mode for money and uses numeric mode for whole-day filters", () => {
  const html = renderToStaticMarkup(
    <ClaimSearchContent
      filters={{}}
      items={[]}
      failedCount={0}
      loading={false}
      onFiltersChange={() => undefined}
      onSearch={() => undefined}
      onOpenWorklist={() => undefined}
    />,
  );
  const inputs = html.match(/<input[^>]*>/g) ?? [];
  const minimumCharged = inputs.find((input) => input.includes('placeholder="0.00"'));
  const minimumDays = inputs.find((input) => input.includes('placeholder="0"'));
  assert.match(minimumCharged ?? "", /step="0\.01"[^>]*inputMode="decimal"/);
  assert.match(minimumDays ?? "", /step="1"[^>]*inputMode="numeric"/);
});

test("failed-claims badge counts only open claim-rejected and era-denial worklist items", () => {
  assert.equal(failedClaimsCount([
    worklistItem("claim-rejected", "new"),
    worklistItem("era-denial", "in-review"),
    worklistItem("era-denial", "resolved"),
    worklistItem("era-integrity", "new"),
    worklistItem("era-underpayment", "new"),
  ]), 2);
});

test("claim search client sends supported filters and authorization to the bespoke endpoint", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const items = await fetchClaimSearch(
    { patient: "Jamie Synthetic", status: "paid", cpt: "PROC-A", minAmount: "100.00" },
    {
      authorization: "Bearer test",
      fetchImpl: async (input, init) => {
        request = { url: String(input), init };
        return new Response(JSON.stringify({ items: [row()] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );

  assert.equal(items.length, 1);
  assert.match(request?.url ?? "", /^\/claims\/search\?/);
  assert.match(request?.url ?? "", /patient=Jamie\+Synthetic/);
  assert.match(request?.url ?? "", /status=paid/);
  assert.match(request?.url ?? "", /cpt=PROC-A/);
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, "Bearer test");
});

test("claim search restores AR drill-down filters from the dashboard URL", () => {
  assert.deepEqual(
    claimSearchFiltersFromQuery("?outstanding=true&minDays=31&maxDays=60"),
    { outstanding: "true", minDays: "31", maxDays: "60" },
  );
});

function row(): ClaimSearchRow {
  return {
    claimReference: "Claim/claim-1",
    claimNumber: "ODOS-CLAIM-1",
    patientReference: "Patient/patient-1",
    patient: "Jamie Synthetic",
    providerReference: "Practitioner/provider-1",
    provider: "Alex Synthetic",
    cptCodes: ["PROC-A"],
    totalChargedCents: 12_500,
    insurancePaidCents: 8_000,
    patientResponsibilityCents: 2_500,
    status: "paid",
    payerReference: "Organization/payer-1",
    payer: "Synthetic Health",
    daysSinceSubmission: 4,
  };
}

function worklistItem(
  code: ClaimsWorklistItem["code"],
  status: ClaimsWorklistItem["status"],
): ClaimsWorklistItem {
  return {
    id: `${code}-${status}`,
    taskReference: `Task/${code}-${status}`,
    title: code,
    code,
    severity: code === "era-underpayment" ? "medium" : "high",
    ageTimer: { startedAt: "2026-07-09T12:00:00.000Z", elapsedMinutes: 30 },
    action: status === "new" ? "claim" : status === "in-review" ? "resolve" : "none",
    status,
    evidence: code === "claim-rejected"
      ? { kind: "claim-rejected", claimMdMessage: "Rejected" }
      : {
          kind: "era",
          pcn: "PCN-1",
          eraId: "ERA-1",
          chargedCents: 12_500,
          allowedCents: 10_000,
          paidCents: 0,
          patientResponsibilityCents: 0,
          shortfallCents: 10_000,
          adjustments: [],
        },
  };
}
