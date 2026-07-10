import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaimSearchRow } from "../src/claims/claim-search.js";
import type { EraWorklistAttentionItem, WorklistCode } from "../src/claims/era-worklist.js";
import {
  projectAccountsReceivableDashboard,
  toCsv,
} from "../src/reporting/reporting.js";

test("AR dashboard hand-computes average age, aging buckets, and open-worklist counts", () => {
  const claims = [10, 45, 75, 120].map(claimRow);
  const worklist = [
    worklistItem("era-denial", "task-1"),
    worklistItem("era-denial", "task-2"),
    worklistItem("claim-rejected", "task-3"),
  ];

  const dashboard = projectAccountsReceivableDashboard(claims, worklist);

  assert.equal(dashboard.outstandingClaimCount, 4);
  assert.equal(dashboard.averageDaysOutstanding, 62.5);
  assert.deepEqual(dashboard.agingBuckets.map((bucket) => bucket.claimCount), [1, 1, 1, 1]);
  assert.equal(dashboard.openWorklistTotal, 3);
  assert.equal(dashboard.openWorklistCounts["era-denial"], 2);
  assert.equal(dashboard.openWorklistCounts["claim-rejected"], 1);
  assert.equal(dashboard.totalOutstanding.status, "unavailable");
  assert.match(dashboard.totalOutstanding.reason, /No shipped Claim-to-Invoice balance link/);
});

test("CSV output quotes punctuation and neutralizes spreadsheet formulas", () => {
  const csv = toCsv(["Patient", "Message"], [["=IMPORTXML(1)", "said \"hello\", then left\nnext line"]]);
  assert.match(csv, /^\uFEFFPatient,Message\r\n'=IMPORTXML\(1\),/);
  assert.match(csv, /"said ""hello"", then left\nnext line"/);
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
