import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupClaimWorklist,
  neverPaidUntouchedMetric,
  projectClaimReadModel,
  reconcileClaimReadModel,
  type ClaimReadModelRow,
} from "../src/claims/claim-read-model.js";
import type { Claim } from "@medplum/fhirtypes";
import {
  CLAIM_LAST_TOUCHED_AT_EXTENSION_URL,
  CLAIM_LAST_TOUCHED_BY_EXTENSION_URL,
  CLAIM_REASON_EXTENSION_URL,
  CLAIM_REASON_RESOLUTION_PATH_EXTENSION_URL,
  CLAIM_TOUCH_COUNT_EXTENSION_URL,
} from "../src/claims/claim-touch-ledger.js";

const AT = "2026-08-30T12:00:00.000Z";

test("one follow-up worklist result groups reasons, totals dollars, and ranks old untouched claims first", () => {
  const groups = groupClaimWorklist([
    row({ claimReference: "Claim/touched-old", billedAt: "2026-05-01T12:00:00.000Z", touchCount: 1, lastTouchedAt: "2026-08-29T12:00:00.000Z", lastTouchedBy: "Practitioner/staff-1", reasonCode: "cob-review", reasonDisplay: "COB review", resolutionPath: "Review plan benefits" }),
    row({ claimReference: "Claim/untouched-new", billedAt: "2026-08-20T12:00:00.000Z", reasonCode: "missing-procedure", reasonDisplay: "Missing procedure", resolutionPath: "Add procedure" }),
    row({ claimReference: "Claim/untouched-old", billedAt: "2026-05-01T12:00:00.000Z", reasonCode: "cob-review", reasonDisplay: "COB review", resolutionPath: "Review plan benefits" }),
  ], AT, [30, 60, 90]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].reason, {
    code: "cob-review",
    display: "COB review",
    resolutionPath: "Review plan benefits",
  });
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].totalOutstandingCents, 25_000);
  assert.deepEqual(groups[0].rows.map((candidate) => candidate.claimReference), [
    "Claim/untouched-old",
    "Claim/touched-old",
  ]);
  assert.equal(groups[0].rows[0].touchCount, 0);
  assert.equal(groups[0].rows[0].lastTouchedAt, null);
  assert.equal(groups[0].rows[0].daysSinceTouched, null);
  assert.equal(groups[0].rows[0].untouchedRankingDays, 121);
});

test("never-paid-untouched metric groups numerator, denominator, and rate by payer and billed month", () => {
  const metric = neverPaidUntouchedMetric([
    row({ claimReference: "Claim/a", billedAt: "2026-06-02T12:00:00.000Z" }),
    row({ claimReference: "Claim/b", billedAt: "2026-06-20T12:00:00.000Z", collectedCents: 5_000 }),
    row({ claimReference: "Claim/c", billedAt: "2026-06-21T12:00:00.000Z", touchCount: 1, lastTouchedAt: "2026-06-22T12:00:00.000Z", lastTouchedBy: "Practitioner/staff-1" }),
    row({ claimReference: "Claim/d", billedAt: "2026-07-01T12:00:00.000Z" }),
  ]);

  assert.deepEqual(metric, [
    {
      payerReference: "Organization/payer-1",
      payer: "Synthetic Payer",
      billedMonth: "2026-06",
      billedClaimCount: 3,
      neverPaidUntouchedCount: 1,
      neverPaidUntouchedRate: 1 / 3,
    },
    {
      payerReference: "Organization/payer-1",
      payer: "Synthetic Payer",
      billedMonth: "2026-07",
      billedClaimCount: 1,
      neverPaidUntouchedCount: 1,
      neverPaidUntouchedRate: 1,
    },
  ]);
});

test("reconciliation catches one corrupted money row and passes after rebuilding from FHIR truth", () => {
  const truth = [row({ claimReference: "Claim/a" }), row({ claimReference: "Claim/b" })];
  const corrupted = truth.map((candidate) => candidate.claimReference === "Claim/b"
    ? { ...candidate, totalChargedCents: candidate.totalChargedCents + 1 }
    : candidate);

  assert.deepEqual(reconcileClaimReadModel(truth, corrupted), {
    inSync: false,
    truthCount: 2,
    readModelCount: 2,
    divergences: [{
      claimReference: "Claim/b",
      kind: "mismatch",
      fields: ["totalChargedCents"],
    }],
  });
  assert.deepEqual(reconcileClaimReadModel(truth, structuredClone(truth)), {
    inSync: true,
    truthCount: 2,
    readModelCount: 2,
    divergences: [],
  });
});

test("FHIR Claim facts are the canonical source for rebuilding the read model", () => {
  const untouched: Claim = {
    resourceType: "Claim", id: "untouched", status: "active", use: "claim", created: "2026-06-01T12:00:00.000Z",
    patient: { reference: "Patient/patient-1", display: "Synthetic Patient" },
    provider: { reference: "Practitioner/provider-1", display: "Synthetic Provider" },
    insurer: { reference: "Organization/payer-1", display: "Synthetic Payer" },
    priority: { coding: [{ code: "normal" }] }, type: { coding: [{ code: "professional" }] },
    total: { value: 125, currency: "USD" },
  };
  const touched: Claim = {
    ...untouched, id: "touched", extension: [
      { url: CLAIM_TOUCH_COUNT_EXTENSION_URL, valueUnsignedInt: 1 },
      { url: CLAIM_LAST_TOUCHED_AT_EXTENSION_URL, valueDateTime: "2026-08-01T12:00:00.000Z" },
      { url: CLAIM_LAST_TOUCHED_BY_EXTENSION_URL, valueReference: { reference: "Practitioner/staff-1" } },
      { url: CLAIM_REASON_EXTENSION_URL, valueCodeableConcept: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/claim-follow-up-reason", code: "missing-procedure-code", display: "missing procedure code for item" }] } },
      { url: CLAIM_REASON_RESOLUTION_PATH_EXTENSION_URL, valueString: "Add the missing procedure code and resubmit" },
    ],
  };

  const projected = projectClaimReadModel({ claims: [untouched, touched], responses: [], tasks: [], relatedResources: [], at: AT });
  const untouchedRow = projected.find((row) => row.claimReference === "Claim/untouched")!;
  const touchedRow = projected.find((row) => row.claimReference === "Claim/touched")!;
  assert.equal(untouchedRow.touchCount, 0);
  assert.equal(untouchedRow.lastTouchedAt, null);
  assert.equal(touchedRow.touchCount, 1);
  assert.equal(touchedRow.lastTouchedAt, "2026-08-01T12:00:00.000Z");
  assert.equal(touchedRow.lastTouchedBy, "Practitioner/staff-1");
  assert.equal(touchedRow.reasonCode, "missing-procedure-code");
  assert.equal(touchedRow.resolutionPath, "Add the missing procedure code and resubmit");
});

function row(overrides: Partial<ClaimReadModelRow>): ClaimReadModelRow {
  return {
    claimReference: "Claim/default",
    claimNumber: "ODOS-1",
    patientReference: "Patient/patient-1",
    patient: "Synthetic Patient",
    providerReference: "Practitioner/provider-1",
    provider: "Synthetic Provider",
    cptCodes: ["PROC-A"],
    totalChargedCents: 12_500,
    collectedCents: 0,
    patientResponsibilityCents: 0,
    status: "submitted",
    payerReference: "Organization/payer-1",
    payer: "Synthetic Payer",
    billedAt: "2026-06-01T12:00:00.000Z",
    open: true,
    touchCount: 0,
    lastTouchedAt: null,
    lastTouchedBy: null,
    reasonCode: null,
    reasonDisplay: null,
    resolutionPath: null,
    ...overrides,
  };
}
