import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coverage, Patient } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addChargeLine,
  addDiagnosisLine,
  buildCoverageResource,
  buildProfessionalClaimInput,
  coverageGroupNumber,
  coverageIsSelf,
  coverageMemberId,
  dollarsToCents,
  initialClaimDraft,
  removeChargeLine,
  removeDiagnosisLine,
  submitProfessionalClaim,
  subscriberFromCoverage,
  validateClaimDraft,
  type ClaimDraft,
} from "../src/lib/submit-claims";
import { ClaimReview, ClaimSubmissionResult, CoverageChoices } from "../src/scenes/claims/SubmitClaims";

const PATIENT: Patient = {
  resourceType: "Patient",
  id: "pat-1",
  name: [{ use: "official", given: ["Jane", "Q"], family: "Doe" }],
  birthDate: "1980-01-02",
  gender: "female",
  address: [{ use: "home", line: ["1 Main St"], city: "Greenville", state: "SC", postalCode: "29601" }],
};

test("assembled request matches ProfessionalClaimInput and ChargeItem payload fields", () => {
  const claim = buildProfessionalClaimInput(validDraft());
  assert.deepEqual(Object.keys(claim).sort(), [
    "billingProvider",
    "chargeItems",
    "coverageReference",
    "created",
    "diagnoses",
    "insurerReference",
    "patient",
    "patientAccountNumber",
    "patientReference",
    "payerId",
    "providerReference",
    "renderingProvider",
    "serviceDate",
    "subscriber",
  ]);
  assert.deepEqual(claim.diagnoses[0], {
    system: "http://hl7.org/fhir/sid/icd-10-cm",
    code: "TEST-DX",
    display: "Synthetic diagnosis",
  });
  assert.deepEqual(claim.chargeItems[0].code.coding?.[0], {
    system: "urn:ama:cpt",
    code: "TEST-PROC",
    display: "Synthetic procedure",
  });
  assert.equal(claim.chargeItems[0].status, "billable");
  assert.equal(claim.chargeItems[0].subject.reference, "Patient/pat-1");
  assert.equal(claim.chargeItems[0].quantity?.value, 1);
});

test("Coverage creation stamps member ID twice and preserves group, relationship, payor, and period", () => {
  const coverage = buildCoverageResource({
    patientReference: "Patient/pat-1",
    payorReference: "Organization/payer-1",
    payorDisplay: "Test Payer",
    memberId: "MEM-123",
    groupNumber: "GRP-9",
    relationship: "self",
    effectiveDate: "2026-07-01",
  });
  assert.equal(coverage.subscriberId, "MEM-123");
  assert.equal(coverage.identifier?.[0]?.value, "MEM-123");
  assert.equal(coverageMemberId(coverage), "MEM-123");
  assert.equal(coverageGroupNumber(coverage), "GRP-9");
  assert.equal(coverage.relationship?.coding?.[0]?.code, "self");
  assert.equal(coverage.subscriber?.reference, "Patient/pat-1");
  assert.equal(coverage.payor[0].reference, "Organization/payer-1");
  assert.equal(coverage.period?.start, "2026-07-01");

  const html = renderToStaticMarkup(
    <CoverageChoices coverages={[{ ...coverage, id: "cov-1" }]} selectedReference="Coverage/cov-1" onSelect={() => undefined} />,
  );
  assert.match(html, /Test Payer/);
  assert.match(html, /Member MEM-123/);
  assert.match(html, /checked=""/);
});

test("subscriber prefill uses patient demographics for self and stays editable for other", () => {
  const self = coverageFixture("self");
  const other = coverageFixture("other");
  const selfSubscriber = subscriberFromCoverage(self, PATIENT);
  const otherSubscriber = subscriberFromCoverage(other, PATIENT);

  assert.equal(coverageIsSelf(self), true);
  assert.equal(selfSubscriber.firstName, "Jane");
  assert.equal(selfSubscriber.lastName, "Doe");
  assert.equal(selfSubscriber.dateOfBirth, "1980-01-02");
  assert.equal(selfSubscriber.memberId, "MEM-123");
  assert.equal(selfSubscriber.relationshipCode, "18");
  assert.equal(coverageIsSelf(other), false);
  assert.equal(otherSubscriber.firstName, "");
  assert.equal(otherSubscriber.lastName, "");
  assert.equal(otherSubscriber.memberId, "MEM-123");
  assert.equal(otherSubscriber.relationshipCode, undefined);
});

test("diagnosis and charge helpers add at least two rows and remove the selected row", () => {
  const diagnoses = addDiagnosisLine([{ code: "FIRST", description: "First" }]);
  diagnoses[1] = { code: "SECOND", description: "Second" };
  assert.equal(diagnoses.length, 2);
  assert.deepEqual(removeDiagnosisLine(diagnoses, 0), [{ code: "SECOND", description: "Second" }]);

  const charges = addChargeLine([{ codeType: "CPT", code: "FIRST", description: "First", feeDollars: "1.00", quantity: "1" }]);
  charges[1] = { codeType: "HCPCS", code: "SECOND", description: "Second", feeDollars: "2.00", quantity: "2" };
  assert.equal(charges.length, 2);
  assert.deepEqual(removeChargeLine(charges, 0), [charges[1]]);
});

test("125.50 dollars becomes 12550 cents while FHIR Money remains 125.50 USD", () => {
  assert.equal(dollarsToCents("125.50"), 12_550);
  const claim = buildProfessionalClaimInput(validDraft());
  assert.deepEqual(claim.chargeItems[0].priceOverride, { value: 125.5, currency: "USD" });
});

test("submit posts the claim envelope and returns Claim.MD success identifiers", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const claim = buildProfessionalClaimInput(validDraft());
  const result = await submitProfessionalClaim(claim, {
    authorization: "Bearer test",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ claimId: "claim-1", status: "A" });
    },
  });
  assert.deepEqual(result, { claimId: "claim-1", status: "A" });
  assert.equal(calls[0].url, "/claims/submit");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { claim });

  const html = renderToStaticMarkup(<ClaimSubmissionResult result={result} onAnother={() => undefined} />);
  assert.match(html, /claim-1/);
  assert.match(html, />A</);
  assert.match(html, /Compose another claim/);
});

test("502 submit errors surface in an alert and are not retried", async () => {
  let callCount = 0;
  const claim = buildProfessionalClaimInput(validDraft());
  await assert.rejects(
    submitProfessionalClaim(claim, {
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse({ error: "Claim submission failed: rejected" }, 502);
      },
    }),
    /Claim submission failed: rejected/,
  );
  assert.equal(callCount, 1);

  const html = renderToStaticMarkup(
    <ClaimReview claim={claim} error="Claim submission failed: rejected" submitting={false} onEdit={() => undefined} onSubmit={() => undefined} />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Claim submission failed: rejected/);
});

test("client validation blocks the builder-required references and nonempty line arrays", () => {
  const draft = validDraft();
  draft.patientReference = "";
  draft.providerReference = "";
  draft.coverageReference = "";
  draft.diagnoses = [];
  draft.charges = [];
  const errors = validateClaimDraft(draft).join(" ");
  assert.match(errors, /Select a patient/);
  assert.match(errors, /FHIR provider reference is required/);
  assert.match(errors, /Select a Coverage/);
  assert.match(errors, /At least one diagnosis is required/);
  assert.match(errors, /At least one charge is required/);
  assert.throws(() => buildProfessionalClaimInput(draft), /Select a patient/);
});

function validDraft(): ClaimDraft {
  const draft = initialClaimDraft("2026-07-09");
  return {
    ...draft,
    serviceDate: "2026-07-08",
    patientReference: "Patient/pat-1",
    providerReference: "Practitioner/pract-1",
    insurerReference: "Organization/payer-1",
    coverageReference: "Coverage/cov-1",
    patientAccountNumber: "PCN-1",
    payerId: "PAYER-1",
    billingProvider: { npi: "1111111111", name: "Test Practice" },
    renderingProvider: { npi: "2222222222", firstName: "Eric", lastName: "Bang" },
    patient: {
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1980-01-02",
      sex: "F",
      address1: "1 Main St",
      city: "Greenville",
      state: "SC",
      zip: "29601",
    },
    subscriber: {
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1980-01-02",
      sex: "F",
      memberId: "MEM-123",
      groupNumber: "GRP-9",
      relationshipCode: "18",
    },
    diagnoses: [{ code: "TEST-DX", description: "Synthetic diagnosis" }],
    charges: [{ codeType: "CPT", code: "TEST-PROC", description: "Synthetic procedure", feeDollars: "125.50", quantity: "1" }],
  };
}

function coverageFixture(relationship: "self" | "other"): Coverage {
  return {
    ...buildCoverageResource({
      patientReference: "Patient/pat-1",
      payorReference: "Organization/payer-1",
      memberId: "MEM-123",
      groupNumber: "GRP-9",
      relationship,
      effectiveDate: "2026-07-01",
    }),
    id: `cov-${relationship}`,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
