import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coverage, Patient, RelatedPerson } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addChargeLine,
  addDiagnosisLine,
  buildCoverageResource,
  buildProfessionalClaimInput,
  coverageRelationshipCode,
  coverageGroupNumber,
  coverageIsSelf,
  coverageMemberId,
  dollarsToCents,
  initialClaimDraft,
  removeChargeLine,
  removeDiagnosisLine,
  resolveSubscriberFromCoverage,
  submitProfessionalClaim,
  subscriberFromCoverage,
  validateClaimDraft,
  type ClaimDraft,
} from "../src/lib/submit-claims";
import { ClaimReview, ClaimSubmissionResult, CoverageChoices, PersonFields, SubmissionAlert } from "../src/scenes/claims/SubmitClaims";

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
  const otherSubscriber = subscriberFromCoverage(other, PATIENT, RELATED_PERSON);

  assert.equal(coverageIsSelf(self), true);
  assert.equal(selfSubscriber.firstName, "Jane");
  assert.equal(selfSubscriber.lastName, "Doe");
  assert.equal(selfSubscriber.dateOfBirth, "1980-01-02");
  assert.equal(selfSubscriber.memberId, "MEM-123");
  assert.equal(selfSubscriber.relationshipCode, "18");
  assert.equal(coverageIsSelf(other), false);
  assert.equal(otherSubscriber.firstName, "Alex");
  assert.equal(otherSubscriber.middleName, "R");
  assert.equal(otherSubscriber.lastName, "Subscriber");
  assert.equal(otherSubscriber.dateOfBirth, "1977-03-04");
  assert.equal(otherSubscriber.sex, "M");
  assert.equal(otherSubscriber.address1, "900 Test Ave");
  assert.equal(otherSubscriber.city, "Greenville");
  assert.equal(otherSubscriber.state, "SC");
  assert.equal(otherSubscriber.zip, "29601");
  assert.equal(otherSubscriber.memberId, "MEM-123");
  assert.equal(otherSubscriber.relationshipCode, "G8");

  const html = renderToStaticMarkup(<PersonFields person={otherSubscriber} includePolicy onChange={() => undefined} />);
  assert.match(html, /value="Alex"/);
  assert.doesNotMatch(html, /readonly/);
});

test("all FHIR subscriber relationships map to verified Claim.MD 837P relationship codes", () => {
  const expected = {
    self: "18",
    spouse: "01",
    child: "19",
    common: "53",
    parent: "G8",
    other: "G8",
    injured: "G8",
  } as const;
  for (const [relationship, relationshipCode] of Object.entries(expected)) {
    assert.equal(coverageRelationshipCode(coverageFixture(relationship as keyof typeof expected)), relationshipCode);
  }
});

test("subscriber resolution fetches only valid non-self RelatedPerson references", async () => {
  const calls: string[] = [];
  const other = coverageFixture("other");
  other.subscriber = { reference: "RelatedPerson/subscriber-1" };
  const resolved = await resolveSubscriberFromCoverage(other, PATIENT, async (id) => {
    calls.push(id);
    return RELATED_PERSON;
  });
  assert.deepEqual(calls, ["subscriber-1"]);
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.subscriber.firstName, "Alex");

  const self = await resolveSubscriberFromCoverage(coverageFixture("self"), PATIENT, async () => {
    throw new Error("self coverage must not read RelatedPerson");
  });
  assert.equal(self.error, undefined);
  assert.equal(self.subscriber.firstName, "Jane");
});

test("missing or failed RelatedPerson resolution leaves an editable blank subscriber and surfaces an alert", async () => {
  const missing = await resolveSubscriberFromCoverage(coverageFixture("other"), PATIENT, async () => RELATED_PERSON);
  assert.match(missing.error ?? "", /does not reference a valid RelatedPerson/);
  assert.equal(missing.subscriber.firstName, "");
  assert.equal(missing.subscriber.relationshipCode, "G8");

  const malformedCoverage = coverageFixture("other");
  malformedCoverage.subscriber = { reference: "Patient/not-a-related-person" };
  const malformed = await resolveSubscriberFromCoverage(malformedCoverage, PATIENT, async () => RELATED_PERSON);
  assert.match(malformed.error ?? "", /does not reference a valid RelatedPerson/);

  const failedCoverage = coverageFixture("other");
  failedCoverage.subscriber = { reference: "RelatedPerson/missing" };
  const failed = await resolveSubscriberFromCoverage(failedCoverage, PATIENT, async () => {
    throw new Error("FHIR 404 Not Found");
  });
  assert.match(failed.error ?? "", /FHIR 404 Not Found/);
  assert.equal(failed.subscriber.firstName, "");
  const html = renderToStaticMarkup(
    <><SubmissionAlert message={failed.error ?? ""} /><PersonFields person={failed.subscriber} includePolicy onChange={() => undefined} /></>,
  );
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /readonly/);
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

function coverageFixture(relationship: "child" | "parent" | "spouse" | "common" | "other" | "self" | "injured"): Coverage {
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

const RELATED_PERSON: RelatedPerson = {
  resourceType: "RelatedPerson",
  id: "subscriber-1",
  patient: { reference: "Patient/pat-1" },
  name: [{ given: ["Alex", "R"], family: "Subscriber" }],
  birthDate: "1977-03-04",
  gender: "male",
  address: [{ line: ["900 Test Ave"], city: "Greenville", state: "SC", postalCode: "29601" }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
