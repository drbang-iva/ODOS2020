import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Claim } from "@medplum/fhirtypes";
import {
  CLAIM_TOUCH_ACTIONS,
  ClaimTouchPrincipalError,
  buildClaimTouchTransaction,
  claimReasonState,
  claimTouchState,
  projectClaimWorkFacts,
} from "../src/claims/claim-touch-ledger.js";

const AT = "2026-08-30T12:00:00.000Z";

test("a human note creates one immutable touch and stamps the Claim with the authenticated principal", () => {
  const bundle = buildClaimTouchTransaction({
    claim: untouchedClaim(),
    principal: {
      kind: "human",
      actorReference: "Practitioner/staff-1",
      actorRole: "staff",
    },
    action: "note",
    at: AT,
    detail: "Called payer about COB review.",
  });

  assert.equal(bundle.type, "transaction");
  const updatedClaim = bundle.entry?.find((entry) => entry.resource?.resourceType === "Claim")?.resource as Claim;
  assert.deepEqual(claimTouchState(updatedClaim), {
    touchCount: 1,
    lastTouchedAt: AT,
    lastTouchedBy: "Practitioner/staff-1",
  });
  const provenance = bundle.entry?.find((entry) => entry.resource?.resourceType === "Provenance")?.resource;
  assert.equal(provenance?.resourceType, "Provenance");
  assert.equal(provenance?.activity?.coding?.[0]?.code, "note");
  assert.equal(provenance?.agent[0]?.who.reference, "Practitioner/staff-1");
  const communication = bundle.entry?.find((entry) => entry.resource?.resourceType === "Communication")?.resource;
  assert.equal(communication?.resourceType, "Communication");
  assert.equal(communication?.payload?.[0]?.contentString, "Called payer about COB review.");
});

test("the touch action vocabulary is closed to the five real follow-up actions", () => {
  assert.deepEqual(CLAIM_TOUCH_ACTIONS, [
    "note",
    "resubmission",
    "contact",
    "status-reason",
    "resolution",
  ]);
});

test("status and resolution touches carry a typed reason with its operational resolution path", () => {
  const reason = {
    system: "https://odos2020.com/fhir/CodeSystem/claim-follow-up-reason",
    code: "missing-procedure-code",
    display: "missing procedure code for item",
    resolutionPath: "Add the missing procedure code and resubmit",
  };
  const bundle = buildClaimTouchTransaction({
    claim: untouchedClaim(),
    principal: { kind: "human", actorReference: "Practitioner/staff-1", actorRole: "staff" },
    action: "status-reason",
    at: AT,
    reason,
  });
  const updatedClaim = bundle.entry?.find((entry) => entry.resource?.resourceType === "Claim")?.resource as Claim;

  assert.deepEqual(claimReasonState(updatedClaim), {
    code: reason.code,
    display: reason.display,
    resolutionPath: reason.resolutionPath,
  });
  assert.throws(() => buildClaimTouchTransaction({
    claim: untouchedClaim(),
    principal: { kind: "human", actorReference: "Practitioner/staff-1", actorRole: "staff" },
    action: "resolution",
    at: AT,
  }), /resolution requires a typed claim reason/);
});

test("the extensible reason CodeSystem seeds the three observed practice reasons exactly", () => {
  const catalog = JSON.parse(readFileSync(resolve(
    import.meta.dirname,
    "../../data/profiles/claim-follow-up-reason.json",
  ), "utf8")) as { concept: Array<{ code: string; display: string; property: Array<{ valueString: string }> }> };

  assert.deepEqual(catalog.concept.map(({ code, display, property }) => ({
    code,
    display,
    resolutionPath: property[0]?.valueString,
  })), [
    {
      code: "cob-secondary-benefit-review",
      display: "COB — secondary needs plan benefit review",
      resolutionPath: "Review the secondary plan benefits and coordinate coverage",
    },
    {
      code: "missing-procedure-code",
      display: "missing procedure code for item",
      resolutionPath: "Add the missing procedure code and resubmit",
    },
    {
      code: "invalid-authorization-number",
      display: "invalid authorization number",
      resolutionPath: "Verify or replace the authorization number before resubmission",
    },
  ]);
});

test("an automated principal cannot create a touch even when it supplies a human-looking actor reference", () => {
  assert.throws(
    () => buildClaimTouchTransaction({
      claim: untouchedClaim(),
      principal: {
        kind: "system",
        actorReference: "Practitioner/staff-1",
        actorRole: "system",
      },
      action: "contact",
      at: AT,
      detail: "ERA worker attempted to log contact.",
    }),
    (error: unknown) => error instanceof ClaimTouchPrincipalError
      && error.message === "Only an authenticated human practice principal may touch a claim.",
  );
});

test("a caller body cannot override the authenticated principal used by the touch transaction", () => {
  const bundle = buildClaimTouchTransaction({
    claim: untouchedClaim(),
    principal: {
      kind: "human",
      actorReference: "Practitioner/authenticated-staff",
      actorRole: "staff",
    },
    action: "note",
    at: AT,
    detail: JSON.stringify({ actorReference: "Practitioner/spoofed", kind: "system" }),
  });

  const updatedClaim = bundle.entry?.find((entry) => entry.resource?.resourceType === "Claim")?.resource as Claim;
  assert.equal(claimTouchState(updatedClaim).lastTouchedBy, "Practitioner/authenticated-staff");
});

test("never-touched claims keep touch facts absent while exposing an explicit untouched ranking key", () => {
  assert.deepEqual(claimTouchState(untouchedClaim()), { touchCount: 0 });
  assert.deepEqual(projectClaimWorkFacts({
    billedAt: "2026-05-31T12:00:00.000Z",
    status: "billed",
    touchCount: 0,
    at: AT,
    thresholds: [30, 60, 90],
  }), {
    daysSinceBilled: 91,
    agingBucket: "90+",
    touchCount: 0,
    lastTouchedAt: null,
    lastTouchedBy: null,
    daysSinceTouched: null,
    untouchedRankingDays: 91,
  });
});

test("absolute aging applies identically to every resting status and to touched claims", () => {
  for (const status of ["billed", "hold", "denied", "accepted", "other"] as const) {
    const row = projectClaimWorkFacts({
      billedAt: "2026-05-31T12:00:00.000Z",
      status,
      touchCount: 1,
      lastTouchedAt: "2026-08-29T12:00:00.000Z",
      lastTouchedBy: "Practitioner/staff-1",
      at: AT,
      thresholds: [30, 60, 90],
    });
    assert.equal(row.daysSinceBilled, 91, `${status} must not bypass aging`);
    assert.equal(row.agingBucket, "90+", `${status} must remain in the absolute bucket`);
    assert.equal(row.daysSinceTouched, 1, `${status} touch age remains independent`);
  }
});

function untouchedClaim(): Claim {
  return {
    resourceType: "Claim",
    id: "claim-1",
    meta: { versionId: "7" },
    status: "active",
    type: { text: "professional" },
    use: "claim",
    patient: { reference: "Patient/patient-1" },
    created: "2026-05-31T12:00:00.000Z",
    provider: { reference: "Practitioner/provider-1" },
    priority: { text: "normal" },
    insurer: { reference: "Organization/payer-1" },
    total: { value: 125, currency: "USD" },
  };
}
