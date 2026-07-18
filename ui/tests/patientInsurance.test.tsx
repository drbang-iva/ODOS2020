import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, Coverage, CoverageEligibilityResponse, Patient, RelatedPerson } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BENEFIT_KINDS,
  ODOS_BENEFIT_FREQUENCY_MONTHS_EXTENSION_URL,
  ODOS_BENEFIT_LAST_USED_EXTENSION_URL,
  benefitAllowanceDollars,
  benefitCopayDollars,
  benefitItem,
  benefitUsedDollars,
  buildCoverageSaveBundle,
  buildManualBenefitsBundle,
  coverageDraftFromResource,
  deriveBenefitStatus,
  emptyManualBenefitsDraft,
  fetchPatientInsurance,
  fetchVisionBenefits,
  hasActiveApplicableBenefit,
  latestBenefitsByCoverage,
  nextEligibleDate,
  savePatientInsurance,
  saveVisionBenefits,
  validateManualBenefitsDraft,
} from "../src/lib/patient-insurance";
import {
  applyPlanTemplate,
  type PlanTemplate,
} from "../src/lib/insurance-config";
import { coverageGroupName, coverageGroupNumber, SUBSCRIBER_RELATIONSHIP_SYSTEM } from "../src/lib/submit-claims";
import { CoverageEditor, InsuranceGrid } from "../src/scenes/insurance/PatientInsurance";
import { BenefitsTable } from "../src/scenes/insurance/VisionPlanBenefits";

const PATIENT: Patient = {
  resourceType: "Patient",
  id: "patient-1",
  name: [{ given: ["Jane"], family: "Doe" }],
  birthDate: "1980-01-02",
  gender: "female",
  address: [{ line: ["1 Main St"], city: "Greenville", state: "SC", postalCode: "29601" }],
};

const LEGACY_COVERAGE: Coverage = {
  resourceType: "Coverage",
  id: "legacy-coverage",
  meta: { versionId: "7" },
  status: "active",
  subscriberId: "MEM-123",
  identifier: [{ value: "MEM-123" }],
  beneficiary: { reference: "Patient/patient-1" },
  relationship: { coding: [{ code: "other", display: "Other" }] },
  payor: [{ reference: "Organization/payer-1", display: "Legacy Vision" }],
  class: [{ type: { coding: [{ code: "group", display: "Group" }] }, value: "GRP-9" }],
  period: { start: "2026-07-01" },
};

test("exact #57 legacy Coverage renders in the grid and editor, then upgrades in one transaction", () => {
  const grid = renderToStaticMarkup(<InsuranceGrid coverages={[LEGACY_COVERAGE]} relatedPeople={[]} patient={PATIENT} onEdit={() => undefined} />);
  assert.match(grid, /Legacy Vision/);
  assert.match(grid, /GRP-9/);
  assert.match(grid, /Other — details not captured/);

  const legacyDraft = coverageDraftFromResource(LEGACY_COVERAGE, PATIENT);
  const editor = renderToStaticMarkup(<CoverageEditor draft={legacyDraft} patient={PATIENT} relatedPeople={[]} saving={false} onChange={() => undefined} onCancel={() => undefined} onSave={() => undefined} />);
  assert.match(editor, /Edit insurance/);
  assert.match(editor, /value="other" selected=""/);
  assert.match(editor, /value="GRP-9"/);

  const upgradedDraft = {
    ...legacyDraft,
    coverageType: "vision" as const,
    groupName: "Employer Plan",
    subscriber: {
      firstName: "John",
      middleName: "Q",
      lastName: "Doe",
      birthDate: "1978-03-04",
      gender: "male" as const,
      address: "2 Main St",
      city: "Greenville",
      state: "SC",
      postalCode: "29601",
    },
  };
  const bundle = buildCoverageSaveBundle({ draft: upgradedDraft, existingCoverage: LEGACY_COVERAGE, uuid: () => "subscriber-upgrade" });
  const relatedEntry = bundle.entry?.find((entry) => entry.resource?.resourceType === "RelatedPerson");
  const coverageEntry = bundle.entry?.find((entry) => entry.resource?.resourceType === "Coverage");
  const relatedPerson = relatedEntry?.resource as RelatedPerson;
  const coverage = coverageEntry?.resource as Coverage;
  assert.equal(bundle.type, "transaction");
  assert.equal(relatedEntry?.request?.method, "POST");
  assert.equal(coverageEntry?.request?.method, "PUT");
  assert.equal(coverageEntry?.request?.ifMatch, 'W/"7"');
  assert.equal(coverage.subscriber?.reference, relatedEntry?.fullUrl);
  assert.equal(coverage.relationship?.coding?.[0]?.system, SUBSCRIBER_RELATIONSHIP_SYSTEM);
  assert.equal(coverageGroupNumber(coverage), "GRP-9");
  assert.equal(coverageGroupName(coverage), "Employer Plan");
  assert.equal(relatedPerson.patient.reference, "Patient/patient-1");
  assert.equal(relatedPerson.name?.[0]?.given?.join(" "), "John Q");
  assert.equal(relatedPerson.name?.[0]?.family, "Doe");
  assert.equal(relatedPerson.relationship?.[0]?.coding?.[0]?.code, "other");
});

test("self Coverage keeps Patient demographics read-only and existing non-self subscribers update in place", () => {
  const selfCoverage: Coverage = { ...LEGACY_COVERAGE, id: "self-coverage", subscriber: { reference: "Patient/patient-1" }, relationship: { coding: [{ code: "self" }] } };
  const selfDraft = coverageDraftFromResource(selfCoverage, PATIENT);
  const selfHtml = renderToStaticMarkup(<CoverageEditor draft={selfDraft} patient={PATIENT} relatedPeople={[]} saving={false} onChange={() => undefined} onCancel={() => undefined} onSave={() => undefined} />);
  assert.match(selfHtml, /read-only here/);
  assert.match(selfHtml, /readonly=""[^>]*value="Jane"/);

  const existing: RelatedPerson = { resourceType: "RelatedPerson", id: "subscriber-1", meta: { versionId: "3" }, patient: { reference: "Patient/patient-1" }, name: [{ given: ["John"], family: "Doe" }] };
  const draft = { ...coverageDraftFromResource({ ...LEGACY_COVERAGE, subscriber: { reference: "RelatedPerson/subscriber-1" } }, PATIENT, existing), subscriberReference: "RelatedPerson/subscriber-1", subscriber: { firstName: "John", middleName: "", lastName: "Doe", birthDate: "1978-03-04", gender: "male" as const, address: "", city: "", state: "", postalCode: "" } };
  const bundle = buildCoverageSaveBundle({ draft, existingCoverage: LEGACY_COVERAGE, existingRelatedPerson: existing, uuid: () => "unused" });
  const relatedEntry = bundle.entry?.find((entry) => entry.resource?.resourceType === "RelatedPerson");
  assert.equal(relatedEntry?.request?.method, "PUT");
  assert.equal(relatedEntry?.request?.url, "RelatedPerson/subscriber-1");
  assert.equal(relatedEntry?.request?.ifMatch, 'W/"3"');
});

test("manual benefit entry emits the required request-response history pair and benefit money/extensions", () => {
  const coverage = { ...LEGACY_COVERAGE, id: "coverage-1" };
  const draft = emptyManualBenefitsDraft("Patient/patient-1", coverage, "2026-07-10");
  draft.endDate = "2027-07-10";
  draft.authorizationReference = "AUTH-123";
  draft.benefits[1] = { kind: "exam", excluded: false, allowanceDollars: "150.00", usedDollars: "25.00", copayDollars: "10.00", lastUsed: "2026-01-15", frequencyMonths: "12" };
  const ids = ["request-1", "response-1"];
  const bundle = buildManualBenefitsBundle(draft, { created: "2026-07-10T12:00:00Z", staffReference: "Practitioner/staff-1", uuid: () => ids.shift() ?? "unused" });
  const requestEntry = bundle.entry?.find((entry) => entry.resource?.resourceType === "CoverageEligibilityRequest");
  const responseEntry = bundle.entry?.find((entry) => entry.resource?.resourceType === "CoverageEligibilityResponse");
  const response = responseEntry?.resource as CoverageEligibilityResponse;
  const exam = benefitItem(response, "exam");
  assert.equal(bundle.type, "transaction");
  assert.equal(response.request.reference, requestEntry?.fullUrl);
  assert.equal(response.insurance?.[0]?.coverage.reference, "Coverage/coverage-1");
  assert.equal(response.preAuthRef, "AUTH-123");
  assert.equal(benefitAllowanceDollars(exam), 150);
  assert.equal(benefitUsedDollars(exam), 25);
  assert.equal(benefitCopayDollars(exam), 10);
  assert.equal(exam?.extension?.find((extension) => extension.url === ODOS_BENEFIT_LAST_USED_EXTENSION_URL)?.valueDate, "2026-01-15");
  assert.equal(exam?.extension?.find((extension) => extension.url === ODOS_BENEFIT_FREQUENCY_MONTHS_EXTENSION_URL)?.valueUnsignedInt, 12);
  assert.equal(nextEligibleDate(exam), "2027-01-15");
});

test("applying a plan template copies only plan-level facts and keeps the 7a bundle path unchanged", () => {
  const coverage = { ...LEGACY_COVERAGE, id: "coverage-1" };
  const draft = emptyManualBenefitsDraft("Patient/patient-1", coverage, "2026-07-10");
  draft.benefits = draft.benefits.map((benefit) => ({
    ...benefit,
    usedDollars: benefit.kind === "exam" ? "25.00" : "",
    lastUsed: benefit.kind === "exam" ? "2026-01-15" : "",
  }));
  const template: PlanTemplate = {
    id: "template-1",
    label: "Example plan",
    benefits: Object.fromEntries(
      BENEFIT_KINDS.map((kind) => [
        kind,
        {
          excluded: kind === "medical",
          allowanceDollars: 150,
          copayDollars: 10,
          frequencyMonths: 12,
        },
      ]),
    ) as PlanTemplate["benefits"],
  };

  const applied = applyPlanTemplate(draft, template);
  for (const benefit of applied.benefits) {
    assert.equal(benefit.excluded, benefit.kind === "medical");
    assert.equal(benefit.allowanceDollars, "150");
    assert.equal(benefit.copayDollars, "10");
    assert.equal(benefit.frequencyMonths, "12");
  }
  const exam = applied.benefits.find((benefit) => benefit.kind === "exam")!;
  assert.equal(exam.usedDollars, "25.00");
  assert.equal(exam.lastUsed, "2026-01-15");
  assert.deepEqual(validateManualBenefitsDraft(applied), []);
  const ids = ["request-prefill", "response-prefill"];
  const bundle = buildManualBenefitsBundle(applied, {
    created: "2026-07-10T12:00:00Z",
    uuid: () => ids.shift() ?? "unused",
  });
  assert.equal(bundle.type, "transaction");
  assert.deepEqual(
    bundle.entry?.map((entry) => entry.resource?.resourceType),
    ["CoverageEligibilityRequest", "CoverageEligibilityResponse"],
  );
});

test("applying an incomplete plan template leaves an undefined benefit kind untouched", () => {
  const coverage = { ...LEGACY_COVERAGE, id: "coverage-1" };
  const draft = emptyManualBenefitsDraft("Patient/patient-1", coverage, "2026-07-10");
  draft.benefits = draft.benefits.map((benefit) => ({
    ...benefit,
    allowanceDollars: "25",
    usedDollars: "5",
    lastUsed: "2026-01-15",
  }));
  const missingFrame = draft.benefits.find((benefit) => benefit.kind === "frame")!;
  const template: PlanTemplate = {
    id: "incomplete-template",
    label: "Incomplete example",
    benefits: Object.fromEntries(
      BENEFIT_KINDS
        .filter((kind) => kind !== "frame")
        .map((kind) => [
          kind,
          {
            excluded: true,
            allowanceDollars: 150,
            copayDollars: 10,
            frequencyMonths: 12,
          },
        ]),
    ) as PlanTemplate["benefits"],
  };

  const applied = applyPlanTemplate(draft, template);
  assert.deepEqual(
    applied.benefits.find((benefit) => benefit.kind === "frame"),
    missingFrame,
  );
  const exam = applied.benefits.find((benefit) => benefit.kind === "exam")!;
  assert.equal(exam.excluded, true);
  assert.equal(exam.allowanceDollars, "150");
  assert.equal(exam.copayDollars, "10");
  assert.equal(exam.frequencyMonths, "12");
  assert.equal(exam.usedDollars, "5");
  assert.equal(exam.lastUsed, "2026-01-15");
});

test("all six benefit statuses are derived from period, authorization, exclusion, and used facts", () => {
  const base = responseFixture();
  const item = benefitItem(base, "exam");
  assert.equal(deriveBenefitStatus(base, undefined, "2026-07-10"), "Does not Exist");
  assert.equal(deriveBenefitStatus(base, { ...item, excluded: true }, "2026-07-10"), "Does not Exist");
  assert.equal(deriveBenefitStatus({ ...base, preAuthRef: "AUTH" }, item, "2026-07-10"), "Authorized");
  assert.equal(deriveBenefitStatus({ ...base, preAuthRef: "AUTH", insurance: [{ ...base.insurance![0], benefitPeriod: { end: "2026-01-01" } }] }, item, "2026-07-10"), "Authorization Expired");
  assert.equal(deriveBenefitStatus(base, { ...item, benefit: [{ type: { text: "Allowance" }, usedMoney: { value: 1, currency: "USD" } }] }, "2026-07-10"), "Used");
  assert.equal(deriveBenefitStatus(base, item, "2026-07-10"), "Eligibility Active");
  assert.equal(deriveBenefitStatus({ ...base, insurance: [{ ...base.insurance![0], inforce: false }] }, item, "2026-07-10"), "Eligibility Expired");
});

test("claim context is active only when a current Coverage has an active applicable lens benefit", () => {
  const response = responseFixture();
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [response], ["lens"], "2026-07-10"), true);
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [{ ...response, status: "cancelled" }], ["lens"], "2026-07-10"), false);
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [{ ...response, outcome: "error" }], ["lens"], "2026-07-10"), false);
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [], ["lens"], "2026-07-10"), false);
  assert.equal(
    hasActiveApplicableBenefit([{ ...LEGACY_COVERAGE, status: "cancelled" }], [response], ["lens"], "2026-07-10"),
    false,
  );
  assert.equal(
    hasActiveApplicableBenefit([{ ...LEGACY_COVERAGE, period: { end: "2026-07-09" } }], [response], ["lens"], "2026-07-10"),
    false,
  );
  assert.equal(
    hasActiveApplicableBenefit(
      [{ ...LEGACY_COVERAGE, period: { start: "2026-07-10T23:59:59Z" } }],
      [response],
      ["lens"],
      "2026-07-10",
    ),
    true,
  );
  const futureBenefit: CoverageEligibilityResponse = {
    ...response,
    insurance: [{
      ...response.insurance![0],
      benefitPeriod: { start: "2026-07-11T00:00:00Z", end: "2027-06-30T23:59:59Z" },
    }],
  };
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [futureBenefit], ["lens"], "2026-07-10"), false);
  const sameDayBenefit: CoverageEligibilityResponse = {
    ...futureBenefit,
    insurance: [{
      ...futureBenefit.insurance![0],
      benefitPeriod: { start: "2026-07-10T23:59:59Z", end: "2026-07-10T23:59:59Z" },
    }],
  };
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [sameDayBenefit], ["lens"], "2026-07-10"), true);
  const expiredBenefit: CoverageEligibilityResponse = {
    ...response,
    insurance: [{
      ...response.insurance![0],
      benefitPeriod: { start: "2026-07-01", end: "2026-07-09T23:59:59Z" },
    }],
  };
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [expiredBenefit], ["lens"], "2026-07-10"), false);
  const absoluteReference: CoverageEligibilityResponse = {
    ...response,
    insurance: [{
      ...response.insurance![0],
      coverage: { reference: "https://fhir.example/Coverage/legacy-coverage" },
    }],
  };
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [absoluteReference], ["lens"], "2026-07-10"), true);
  const chronologicallyNewerExpired: CoverageEligibilityResponse = {
    ...response,
    id: "response-newer",
    created: "2026-07-09T23:30:00-02:00",
    insurance: [{ ...response.insurance![0], inforce: false }],
  };
  const lexicallyNewerButOlder: CoverageEligibilityResponse = {
    ...response,
    id: "response-older",
    created: "2026-07-10T00:00:00Z",
  };
  assert.equal(
    hasActiveApplicableBenefit(
      [LEGACY_COVERAGE],
      [lexicallyNewerButOlder, chronologicallyNewerExpired],
      ["lens"],
      "2026-07-10",
    ),
    false,
  );
  const multiInsurance: CoverageEligibilityResponse = {
    ...response,
    insurance: [
      {
        coverage: { reference: "Coverage/unrelated" },
        inforce: false,
        benefitPeriod: { start: "2026-07-01", end: "2027-06-30" },
        item: [],
      },
      response.insurance![0],
    ],
  };
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [multiInsurance], ["lens"], "2026-07-10"), true);
  const excludedLens: CoverageEligibilityResponse = {
    ...response,
    insurance: [{
      ...response.insurance![0],
      item: response.insurance![0].item?.map((item) => item.name === "lens" ? { ...item, excluded: true } : item),
    }],
  };
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [excludedLens], ["lens"], "2026-07-10"), false);
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [excludedLens], ["exam"], "2026-07-10"), true);
});

test("latest benefit selection treats malformed created timestamps as older than valid responses", () => {
  const valid = responseFixture();
  const malformed: CoverageEligibilityResponse = {
    ...valid,
    id: "malformed-created",
    created: "not-a-fhir-instant",
    insurance: [{ ...valid.insurance![0], inforce: false }],
  };
  const latest = latestBenefitsByCoverage([malformed, valid]);
  assert.equal(latest.get("Coverage/legacy-coverage")?.id, valid.id);
  assert.equal(hasActiveApplicableBenefit([LEGACY_COVERAGE], [malformed, valid], ["lens"], "2026-07-10"), true);
});

test("both insurance clients use their dedicated routes and preserve transaction bodies", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const body = String(input).includes("vision-benefits")
      ? (init?.method === "POST" ? { resourceType: "Bundle", type: "transaction-response" } : { responses: [] })
      : (init?.method === "POST" ? { resourceType: "Bundle", type: "transaction-response" } : { coverages: [], relatedPeople: [] });
    return jsonResponse(body);
  };
  const options = { authorization: "Bearer test", fetchImpl: fetchImpl as typeof fetch };
  const bundle: Bundle = { resourceType: "Bundle", type: "transaction" };
  await fetchPatientInsurance("Patient/patient-1", options);
  await savePatientInsurance(bundle, options);
  await fetchVisionBenefits("Patient/patient-1", options);
  await saveVisionBenefits(bundle, options);
  assert.deepEqual(calls.map((call) => call.url), [
    "/insurance/coverages?patientReference=Patient%2Fpatient-1",
    "/insurance/coverages",
    "/insurance/vision-benefits?patientReference=Patient%2Fpatient-1",
    "/insurance/vision-benefits",
  ]);
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer test");
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { bundle });
});

test("benefit table renders the exact column vocabulary, derived status, history, and detail view", () => {
  const response = responseFixture();
  const reference = "Coverage/legacy-coverage";
  const html = renderToStaticMarkup(<BenefitsTable coverages={[LEGACY_COVERAGE]} latest={new Map([[reference, response]])} responses={[response]} today="2026-07-10" expandedCoverage={reference} historyCoverage={reference} onToggleBenefits={() => undefined} onToggleHistory={() => undefined} onManualEntry={() => undefined} />);
  for (const label of ["Effective Date", "Medical", "Exam", "Frame", "Lens", "Contacts", "Contact Exam", "Eligibility", "Allowance", "Reuse Auth", "Benefits"]) assert.match(html, new RegExp(label));
  assert.match(html, /Eligibility Active/);
  assert.match(html, /History \(1\)/);
  assert.match(html, /Next eligible/);
});

function responseFixture(): CoverageEligibilityResponse {
  return {
    resourceType: "CoverageEligibilityResponse",
    id: "response-1",
    status: "active",
    purpose: ["benefits"],
    patient: { reference: "Patient/patient-1" },
    created: "2026-07-10T12:00:00Z",
    request: { reference: "CoverageEligibilityRequest/request-1" },
    outcome: "complete",
    insurer: { reference: "Organization/payer-1" },
    insurance: [{ coverage: { reference: "Coverage/legacy-coverage" }, inforce: true, benefitPeriod: { start: "2026-07-01", end: "2027-06-30" }, item: BENEFIT_KINDS.map((kind) => ({ category: { text: kind === "contact-exam" ? "Contact Exam" : `${kind[0].toUpperCase()}${kind.slice(1)}` }, name: kind, excluded: false })) }],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
