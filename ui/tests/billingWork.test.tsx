import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWorkLanes, type ClaimWorklistGroup, type ClaimWorklistRow, type WorkProjection } from "../src/lib/claim-work";
import type { ClaimsWorklistItem } from "../src/lib/claims-worklist";
import { BillingWork } from "../src/scenes/claims/BillingWork";

test("Work renders one collapsed row for a 15-claim reason batch", () => {
  const projection = healthyWorkFixture();
  const html = renderToStaticMarkup(<BillingWork initialProjection={projection} initialActiveLane="holds" />);

  assert.equal((html.match(/Missing procedure code for item OTH/g) ?? []).length, 1);
  assert.match(html, /15 claims/);
  assert.match(html, /\$1,875\.00/);
  assert.match(html, /oldest 62d/);
  assert.match(html, /Fix codes and resubmit/);
});

test("expanded Work rows show independent billed and touched days plus sourced money state", () => {
  const projection = healthyWorkFixture();
  const html = renderToStaticMarkup(
    <BillingWork
      initialProjection={projection}
      initialActiveLane="holds"
      initialExpandedGroupKey="holds:claim:missing-procedure-code"
    />,
  );

  for (const heading of ["Days billed", "Days touched", "Last worked by", "Money state"]) {
    assert.match(html, new RegExp(heading));
  }
  assert.match(html, />62d</);
  assert.match(html, />2d</);
  assert.match(html, />Never</);
  assert.match(html, /Practitioner\/staff-1/);
  assert.match(html, /charged/);
});

test("all seven lane labels remain visible while healthy counts and a truthful zero state render", () => {
  const html = renderToStaticMarkup(
    <BillingWork initialProjection={healthyWorkFixture()} initialActiveLane="hygiene" />,
  );

  for (const label of ["Aging", "Holds", "Denials", "Underpaid", "Unmatched", "Untouched", "Hygiene"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /data-lane-count="hygiene"[^>]*>0</);
  assert.match(html, /No hygiene work/);
  assert.match(html, /Projection current as of/);
});

test("degraded Work keeps navigation but hides every count, group, and reassuring zero state", () => {
  const projection: WorkProjection = {
    status: "degraded",
    reason: "stale",
    lastSuccessfulAt: "2026-08-30T11:30:00.000Z",
  };
  const html = renderToStaticMarkup(<BillingWork initialProjection={projection} />);

  assert.match(html, /Work data hidden/);
  assert.match(html, />Aging</);
  assert.doesNotMatch(html, /data-lane-count=/);
  assert.doesNotMatch(html, /Missing procedure code/);
  assert.doesNotMatch(html, /No aging work/);
});

test("legacy remits are visibly separated from live Unmatched work and name watcher silence", () => {
  const projection: WorkProjection = {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    lanes: buildWorkLanes([], [legacyRemit()]),
  };
  const html = renderToStaticMarkup(
    <BillingWork initialProjection={projection} initialActiveLane="unmatched" />,
  );

  assert.match(html, /Legacy — belongs to the prior system/);
  assert.match(html, /outside ODOS claim work and claim-watch alerts/);
  assert.match(html, /ERA-LEGACY-1/);
  assert.doesNotMatch(html, /Reconstruct claim/);
});

export function healthyWorkFixture(): Extract<WorkProjection, { status: "healthy" }> {
  return {
    status: "healthy",
    lastSuccessfulAt: "2026-08-30T12:00:00.000Z",
    lanes: buildWorkLanes([missingProcedureGroup()], []),
  };
}

function missingProcedureGroup(): ClaimWorklistGroup {
  const rows = Array.from({ length: 15 }, (_, index) => claimRow(index + 1));
  return {
    reason: {
      code: "missing-procedure-code",
      display: "Missing procedure code for item OTH",
      resolutionPath: "Fix codes and resubmit",
    },
    count: rows.length,
    totalOutstandingCents: rows.reduce((sum, row) => sum + row.outstandingCents, 0),
    rows,
  };
}

function claimRow(number: number): ClaimWorklistRow {
  const touched = number === 1;
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
    touchCount: touched ? 1 : 0,
    lastTouchedAt: touched ? "2026-08-28T12:00:00.000Z" : null,
    lastTouchedBy: touched ? "Practitioner/staff-1" : null,
    reasonCode: "missing-procedure-code",
    reasonDisplay: "Missing procedure code for item OTH",
    resolutionPath: "Fix codes and resubmit",
    daysSinceBilled: 62,
    agingBucket: "60-89",
    daysSinceTouched: touched ? 2 : null,
    untouchedRankingDays: touched ? 0 : 62,
    outstandingCents: 12_500,
  };
}

function legacyRemit(): ClaimsWorklistItem {
  return {
    id: "legacy-remit-1",
    taskReference: "Task/legacy-remit-1",
    title: "Unmatched ERA claim requires mapping",
    code: "era-unmatched",
    severity: "high",
    ageTimer: { startedAt: "2026-08-29T12:00:00.000Z", elapsedMinutes: 1_440 },
    action: "none",
    status: "resolved",
    resolutionDisposition: "legacy",
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
  };
}
