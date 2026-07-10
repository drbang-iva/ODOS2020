import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  fetchAccountsReceivableDashboard,
  queryPath,
  type AccountsReceivableDashboardData,
} from "../src/lib/reporting";
import { AccountsReceivableDashboardContent } from "../src/scenes/claims/AccountsReceivableDashboard";

test("AR dashboard renders the truthful gap, age buckets, and drillable source-table actions", () => {
  const html = renderToStaticMarkup(
    <AccountsReceivableDashboardContent
      data={dashboard()}
      onOpenClaims={() => undefined}
      onOpenWorklist={() => undefined}
    />,
  );

  for (const text of [
    "Total outstanding",
    "Unavailable",
    "Average days outstanding",
    "62.5",
    "Open worklist",
    "0-30 days",
    "31-60 days",
    "61-90 days",
    "91+ days",
  ]) assert.match(html, new RegExp(text.replace("+", "\\+")));
  assert.match(html, /intentionally not calculated/);
  assert.equal((html.match(/<button/g) ?? []).length, 7);
});

test("AR dashboard client reaches the authenticated reporting route", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const result = await fetchAccountsReceivableDashboard({
    authorization: "Bearer test",
    fetchImpl: async (input, init) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify(dashboard()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(result.averageDaysOutstanding, 62.5);
  assert.equal(request?.url, "/reports/accounts-receivable");
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, "Bearer test");
  assert.equal(
    queryPath("/claims/search/export", { outstanding: "true", minDays: "31", maxDays: "60" }),
    "/claims/search/export?outstanding=true&minDays=31&maxDays=60",
  );
});

function dashboard(): AccountsReceivableDashboardData {
  return {
    totalOutstanding: {
      status: "unavailable",
      reason: "No shipped Claim-to-Invoice balance link supports an honest dollar total.",
    },
    outstandingClaimCount: 4,
    averageDaysOutstanding: 62.5,
    agingBuckets: [
      { code: "0-30", label: "0-30 days", minDays: 0, maxDays: 30, claimCount: 1 },
      { code: "31-60", label: "31-60 days", minDays: 31, maxDays: 60, claimCount: 1 },
      { code: "61-90", label: "61-90 days", minDays: 61, maxDays: 90, claimCount: 1 },
      { code: "91-plus", label: "91+ days", minDays: 91, claimCount: 1 },
    ],
    openWorklistCounts: {
      "era-denial": 2,
      "era-underpayment": 0,
      "era-unmatched": 0,
      "claim-rejected": 1,
    },
    openWorklistTotal: 3,
  };
}
