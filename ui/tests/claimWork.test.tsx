import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchTouchClaims,
  buildWorkLanes,
  loadClaimWork,
  rowFacts,
  type ClaimWorklistGroup,
  type ClaimWorklistRow,
  type WorkLaneId,
} from "../src/lib/claim-work";
import type { ClaimsWorklistItem } from "../src/lib/claims-worklist";

test("reason groups stay batched while aging and untouched remain independent lanes", () => {
  const lanes = buildWorkLanes([
    claimGroup("missing-procedure-code", "Missing procedure code for item OTH", 15, {
      daysSinceBilled: 62,
      agingBucket: "61-90",
      touchCount: 0,
      daysSinceTouched: null,
      untouchedRankingDays: 62,
    }),
    claimGroup("cob-review", "Coordination of benefits review", 25, {
      daysSinceBilled: 12,
      agingBucket: "current",
      touchCount: 1,
      daysSinceTouched: 2,
      untouchedRankingDays: 0,
    }),
  ], []);

  assert.equal(lane(lanes, "holds").groups.find((group) => group.title.includes("Missing"))?.count, 15);
  assert.equal(lane(lanes, "aging").groups.some((group) => group.count === 15), true);
  assert.equal(lane(lanes, "untouched").groups.some((group) => group.count === 15), true);
  assert.deepEqual(lanes.map((value) => value.id), [
    "aging", "holds", "denials", "underpaid", "unmatched", "untouched", "hygiene",
  ]);
});

test("billed age and touched age remain independent row facts", () => {
  const touched = claimRow(1, {
    daysSinceBilled: 62,
    agingBucket: "61-90",
    touchCount: 1,
    daysSinceTouched: 2,
    untouchedRankingDays: 0,
  });
  const untouched = claimRow(2, {
    daysSinceBilled: 62,
    agingBucket: "61-90",
    touchCount: 0,
    daysSinceTouched: null,
    untouchedRankingDays: 62,
  });

  assert.deepEqual(rowFacts(touched), { daysSinceBilled: 62, daysSinceTouched: 2 });
  assert.deepEqual(rowFacts(untouched), { daysSinceBilled: 62, daysSinceTouched: null });
});

test("legacy remits stay visibly separate and claim-watch silent", () => {
  const legacy = eraItem({
    id: "legacy-remit-1",
    status: "resolved",
    action: "none",
    resolutionDisposition: "legacy",
  });
  const lanes = buildWorkLanes([], [legacy]);
  const unmatched = lane(lanes, "unmatched");

  assert.equal(unmatched.groups.length, 1);
  assert.equal(unmatched.groups[0].kind, "legacy-remit");
  assert.equal(unmatched.groups[0].title, "Legacy — belongs to the prior system");
  assert.equal(unmatched.groups[0].claimWatchEligible, false);
  assert.deepEqual(unmatched.groups[0].claimReferences, []);
  assert.equal(
    lanes.flatMap((value) => value.groups).some((group) => (
      group.kind === "claim" && group.claimReferences.includes("Claim/legacy-remit-1")
    )),
    false,
  );
});

test("a stale claim response discards embedded counts and groups", async () => {
  let calls = 0;
  const projection = await loadClaimWork({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({
        error: "Claim read model projection is stale; FHIR remains authoritative.",
        projection: projectionStatus("stale"),
        groups: [claimGroup("stale", "Stale group", 99)],
      }, 503);
    },
  });

  assert.deepEqual(projection, {
    status: "degraded",
    reason: "stale",
    lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
  });
  assert.equal(calls, 1);
  assert.equal("lanes" in projection, false);
});

test("healthy loading combines claim groups with the existing ERA worklist", async () => {
  const requested: string[] = [];
  const projection = await loadClaimWork({
    fetchImpl: async (input) => {
      const path = String(input);
      requested.push(path);
      if (path.endsWith("/claims/follow-up-worklist")) {
        return jsonResponse({
          groups: [claimGroup("missing-procedure-code", "Missing procedure", 2)],
          projection: projectionStatus("healthy"),
        });
      }
      return jsonResponse({ items: [eraItem()] });
    },
  });

  assert.equal(projection.status, "healthy");
  assert.deepEqual(requested, ["/claims/follow-up-worklist", "/claims/worklist"]);
  assert.equal(projection.status === "healthy" && lane(projection.lanes, "unmatched").count, 1);
});

test("batch client rejects an explicitly partial server report", async () => {
  const claimReferences = Array.from({ length: 15 }, (_, index) => `Claim/claim-${index + 1}`);
  await assert.rejects(
    batchTouchClaims({
      claimReferences,
      action: "resolution",
      reasonCode: "missing-procedure-code",
      detail: "Fix and resubmit",
      idempotencyKey: "batch-ui-partial-001",
    }, {
      fetchImpl: async () => jsonResponse({ requested: 15, touched: 14, items: [] }, 201),
    }),
    /Batch touch incomplete: 14 of 15 claims were stamped/,
  );
});

function lane<T extends { id: WorkLaneId }>(lanes: readonly T[], id: WorkLaneId): T {
  return lanes.find((value) => value.id === id)!;
}

function claimGroup(
  code: string,
  display: string,
  count: number,
  facts: Partial<ClaimWorklistRow> = {},
): ClaimWorklistGroup {
  const rows = Array.from({ length: count }, (_, index) => claimRow(index + 1, {
    reasonCode: code,
    reasonDisplay: display,
    resolutionPath: "Fix codes and resubmit",
    ...facts,
  }));
  return {
    reason: { code, display, resolutionPath: "Fix codes and resubmit" },
    count,
    totalOutstandingCents: rows.reduce((sum, row) => sum + row.outstandingCents, 0),
    rows,
  };
}

function claimRow(number: number, overrides: Partial<ClaimWorklistRow> = {}): ClaimWorklistRow {
  return {
    claimReference: `Claim/claim-${number}`,
    claimNumber: `ODOS-${number}`,
    patientReference: `Patient/patient-${number}`,
    patient: `Synthetic Patient ${number}`,
    providerReference: "Practitioner/provider-1",
    provider: "Synthetic Provider",
    cptCodes: ["PROC-A"],
    totalChargedCents: 12_500,
    collectedCents: 0,
    patientResponsibilityCents: 0,
    status: "submitted",
    payerReference: "Organization/payer-1",
    payer: "Synthetic Payer",
    billedAt: "2026-06-29T12:00:00.000Z",
    open: true,
    touchCount: 0,
    lastTouchedAt: null,
    lastTouchedBy: null,
    reasonCode: "missing-procedure-code",
    reasonDisplay: "Missing procedure code",
    resolutionPath: "Fix codes and resubmit",
    daysSinceBilled: 62,
    agingBucket: "61-90",
    daysSinceTouched: null,
    untouchedRankingDays: 62,
    outstandingCents: 12_500,
    ...overrides,
  };
}

function eraItem(overrides: Partial<ClaimsWorklistItem> = {}): ClaimsWorklistItem {
  return {
    id: "unmatched-1",
    taskReference: "Task/unmatched-1",
    title: "Unmatched ERA claim requires mapping",
    code: "era-unmatched",
    severity: "high",
    ageTimer: { startedAt: "2026-08-29T12:00:00.000Z", elapsedMinutes: 1_440 },
    action: "claim",
    status: "new",
    evidence: {
      kind: "era",
      pcn: "LEGACY-PCN-1",
      eraId: "ERA-LEGACY-1",
      chargedCents: 12_500,
      allowedCents: 8_000,
      paidCents: 8_000,
      patientResponsibilityCents: 0,
      shortfallCents: 0,
      adjustments: [],
    },
    ...overrides,
  };
}

function projectionStatus(state: "healthy" | "failed" | "stale" | "uninitialized") {
  return {
    state,
    lastAttemptAt: "2026-08-30T11:30:00.000Z",
    lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
    lastFailureAt: state === "failed" ? "2026-08-30T11:31:00.000Z" : null,
    invalidatedAt: state === "stale" ? "2026-08-30T11:31:00.000Z" : null,
    staleAfterMs: 180_000,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
