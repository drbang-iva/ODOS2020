import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  Bundle,
  CarePlan,
  ChargeItem,
  Claim,
  Condition,
  Coverage,
  CoverageEligibilityResponse,
  DocumentReference,
  Encounter,
  EpisodeOfCare,
  MedicationRequest,
  MedicationStatement,
  Observation,
  Patient,
  Procedure,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import express from "express";
import { registerClinicRoutes } from "../src/clinic/clinic-routes.js";
import {
  loadPatientOverview,
  loadPatientOverviewVisitDetail,
  loadPatientStickyNoteHistory,
  savePatientStickyNote,
  deriveBillingWeather,
} from "../src/clinic/patient-overview.js";
import {
  clinicalStatusConcept,
  conditionCategoryConcept,
  FHIR_CONDITION_CATEGORY_CODE_SYSTEM,
  FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
  verificationStatusConcept,
} from "../src/fhir/condition.js";
import { buildEyeBodyStructure } from "../src/fhir/ophthalmology/bodyStructure.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../src/fhir/schedulingVisitType.js";
import { buildDiagnosisCatalogSeeds } from "../src/clinical-graph/diagnosis-catalog-store.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../src/clinical-graph/diagnosis-pick-endpoint.js";
import { DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM } from "../src/fhir/dryEyeProcedure.js";

test("patient overview projects real snapshot resources and newest-first encounter diagnoses", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(condition("problem-eye", "Ocular condition", { category: "problem-list-item", bodySite: "Both eyes", encounterId: "newer" }));
  fake.add(condition("problem-medical", "Medical condition", { category: "problem-list-item", encounterId: "newer" }));
  fake.add({ resourceType: "Coverage", id: "coverage-1", status: "active", beneficiary: { reference: "Patient/p1" }, payor: [{ display: "Stable payer" }] } satisfies Coverage);
  fake.add({ resourceType: "Procedure", id: "procedure-1", status: "completed", subject: { reference: "Patient/p1" }, code: { text: "Ocular surgery" }, bodySite: [{ text: "Left eye" }] } satisfies Procedure);
  fake.add({ resourceType: "MedicationStatement", id: "ophthalmic-med", status: "active", medicationCodeableConcept: { text: "Ophthalmic medication" }, subject: { reference: "Patient/p1" }, dosage: [{ route: { text: "Ophthalmic" }, text: "One drop nightly" }] } satisfies MedicationStatement);
  fake.add({ resourceType: "MedicationRequest", id: "systemic-med", status: "active", intent: "order", medicationCodeableConcept: { text: "Systemic medication" }, subject: { reference: "Patient/p1" }, dosageInstruction: [{ text: "Daily" }] } satisfies MedicationRequest);
  fake.add({ resourceType: "Observation", id: "smoking", status: "final", code: { text: "Tobacco smoking status" }, subject: { reference: "Patient/p1" }, valueCodeableConcept: { text: "Former smoker" } } satisfies Observation);
  fake.add(encounter("older", "2025-06-01T14:00:00Z"));
  fake.add(encounter("newer", "2026-06-01T14:00:00Z"));
  fake.add({ resourceType: "Provenance", id: "signed-newer", target: [{ reference: "Encounter/newer" }, { reference: "Patient/p1" }], recorded: "2026-06-01T14:00:00Z", agent: [{ who: { display: "Dr. Clinician" } }] } satisfies Provenance);
  fake.add(condition("dx-old", "Older diagnosis", { category: "encounter-diagnosis", encounterId: "older", code: "DX-OLD" }));
  fake.add(condition("dx-new", "Newer diagnosis", { category: "encounter-diagnosis", encounterId: "newer", code: "DX-NEW" }));
  const resolved = condition("dx-resolved", "Resolved historical diagnosis", { category: "encounter-diagnosis", encounterId: "older", code: "DX-RESOLVED" });
  resolved.clinicalStatus = clinicalStatusConcept("resolved");
  fake.add(resolved);

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.snapshot.ocularHistory.map((row) => row.name), ["Ocular condition"]);
  assert.deepEqual(overview.snapshot.medicalConditions.map((row) => row.name), ["Medical condition"]);
  assert.deepEqual({
    insurance: overview.insurance,
    ocularSurgicalHistory: overview.snapshot.ocularSurgicalHistory,
    socialHistory: overview.snapshot.socialHistory,
    ophthalmicMedications: overview.snapshot.ophthalmicMedications,
    systemicMedications: overview.snapshot.systemicMedications,
  }, {
    insurance: ["Stable payer"],
    ocularSurgicalHistory: [{ id: "procedure-1", name: "Ocular surgery" }],
    socialHistory: ["Former smoker"],
    ophthalmicMedications: [{ id: "ophthalmic-med", name: "Ophthalmic medication", sig: "One drop nightly" }],
    systemicMedications: [{ id: "systemic-med", name: "Systemic medication", sig: "Daily" }],
  });
  assert.deepEqual(overview.visits.map((visit) => visit.encounterId), ["newer", "older"]);
  assert.deepEqual(overview.visits.map((visit) =>
    visit.diagnoses.find((diagnosis) => diagnosis.code)?.code
  ), ["DX-NEW", "DX-OLD"]);
  assert.deepEqual(overview.visits[1]?.diagnoses.map((diagnosis) => diagnosis.code), ["DX-OLD", "DX-RESOLVED"]);
  assert.deepEqual(overview.visits.map((visit) => visit.status), ["Final", "Preliminary"]);
  const provenanceSearch = fake.searches.find((row) => row.resourceType === "Provenance");
  assert.equal(provenanceSearch?.params.target, undefined);
  assert.equal(provenanceSearch?.params.patient, "Patient/p1");
  assert.equal(provenanceSearch?.params.recorded, undefined);
  assert.equal(provenanceSearch?.params._sort, "recorded");
});

test("patient overview reflects active program enrollment and CarePlan session designation in the visit ledger", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add({
    resourceType: "EpisodeOfCare",
    id: "dry-eye-program",
    status: "active",
    patient: { reference: "Patient/p1" },
    type: [{ text: "Dry eye" }],
  } satisfies EpisodeOfCare);
  const visit = encounter("series-visit", "2026-08-19T14:00:00Z");
  visit.episodeOfCare = [{ reference: "EpisodeOfCare/dry-eye-program" }];
  fake.add(visit);
  fake.add({
    resourceType: "CarePlan",
    id: "ipl-series",
    status: "active",
    intent: "plan",
    subject: { reference: "Patient/p1" },
    title: "IPL",
    activity: Array.from({ length: 4 }, (_, index) => ({
      detail: { status: index === 0 ? "completed" : "not-started", description: `Session ${index + 1} of 4` },
    })),
  } satisfies CarePlan);
  fake.add({
    resourceType: "Procedure",
    id: "ipl-session-2",
    status: "in-progress",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/series-visit" },
    basedOn: [{ reference: "CarePlan/ipl-series" }],
    identifier: [{
      system: DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM,
      value: "CarePlan/ipl-series:2-of-4",
    }],
  } satisfies Procedure);

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.programs, [{
    episodeOfCareReference: "EpisodeOfCare/dry-eye-program",
    title: "Dry eye",
    status: "active",
  }]);
  assert.equal(overview.visits[0]?.program, "Dry eye");
  assert.equal(overview.visits[0]?.seriesDesignation, "IPL · session 2 of 4");
});

test("patient overview preserves a completed program title on its historical visit", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add({
    resourceType: "EpisodeOfCare",
    id: "completed-dry-eye-program",
    status: "finished",
    patient: { reference: "Patient/p1" },
    type: [{ text: "Dry eye" }],
  } satisfies EpisodeOfCare);
  const historicalVisit = encounter("historical-series-visit", "2026-07-19T14:00:00Z");
  historicalVisit.episodeOfCare = [{ reference: "EpisodeOfCare/completed-dry-eye-program" }];
  fake.add(historicalVisit);

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.programs, []);
  assert.equal(overview.visits[0]?.program, "Dry eye");
});

test("billing weather reads stored eligibility and never promotes uncertain coverage to green", async () => {
  const activeCoverage: Coverage = {
    resourceType: "Coverage",
    id: "coverage-1",
    status: "active",
    beneficiary: { reference: "Patient/p1" },
    payor: [{ reference: "Organization/payer-1", display: "Synthetic Health Plan" }],
    order: 1,
  };
  const response = (input: {
    created?: string;
    inforce?: boolean;
    deductible?: number | string;
    benefitEnd?: string;
    itemName?: string;
    benefitTypeText?: string;
    benefitTypeCode?: string;
  }): CoverageEligibilityResponse => {
    const benefitTypeText = input.benefitTypeText ?? (input.benefitTypeCode ? undefined : "remaining");
    return ({
    resourceType: "CoverageEligibilityResponse",
    status: "active",
    purpose: ["benefits"],
    patient: { reference: "Patient/p1" },
    created: input.created ?? "2026-08-03T12:00:00Z",
    request: { reference: "CoverageEligibilityRequest/request-1" },
    outcome: "complete",
    insurer: { reference: "Organization/payer-1" },
    insurance: [{
      coverage: { reference: "Coverage/coverage-1" },
      inforce: input.inforce,
      ...(input.benefitEnd ? { benefitPeriod: { end: input.benefitEnd } } : {}),
      item: input.deductible === undefined ? [] : [{
        name: input.itemName ?? "Deductible",
        benefit: [{
          type: {
            ...(benefitTypeText ? { text: benefitTypeText } : {}),
            ...(input.benefitTypeCode ? { coding: [{ code: input.benefitTypeCode }] } : {}),
          },
          allowedMoney: { value: input.deductible as number, currency: "USD" },
        }],
      }],
    }],
    });
  };

  assert.deepEqual(deriveBillingWeather([], [], "2026-08-03"), { state: "unknown" });
  assert.equal(deriveBillingWeather([activeCoverage], [response({ created: "not-a-fhir-instant", inforce: true, deductible: 0 })], "2026-08-03").state, "unknown");
  assert.equal(deriveBillingWeather([activeCoverage], [response({ created: "2026-08-02T23:59:59Z", inforce: true, deductible: 0 })], "2026-08-03").state, "unknown");
  assert.equal(deriveBillingWeather([activeCoverage], [response({ inforce: true, deductible: "unparseable" })], "2026-08-03").state, "unknown");
  assert.equal(deriveBillingWeather([activeCoverage], [response({ inforce: true, deductible: 0, benefitEnd: "2026-08-02" })], "2026-08-03").state, "unknown");
  assert.deepEqual(
    deriveBillingWeather([activeCoverage], [response({ inforce: true, deductible: 0 })], "2026-08-03"),
    { state: "covered", planName: "Synthetic Health Plan", deductibleRemainingCents: 0 },
  );
  assert.deepEqual(
    deriveBillingWeather([activeCoverage], [response({ inforce: true, deductible: 250 })], "2026-08-03"),
    { state: "high-deductible", planName: "Synthetic Health Plan", deductibleRemainingCents: 25_000 },
  );
  assert.equal(
    deriveBillingWeather([activeCoverage], [response({ inforce: true, deductible: 250, itemName: "Medical", benefitTypeText: "Deductible" })], "2026-08-03").state,
    "high-deductible",
  );
  assert.equal(
    deriveBillingWeather([activeCoverage], [response({ inforce: true, deductible: 250, itemName: "Medical", benefitTypeCode: "deductible" })], "2026-08-03").state,
    "high-deductible",
  );
  assert.equal(
    deriveBillingWeather([activeCoverage], [response({ created: "2026-08-04T00:30:00Z", inforce: true, deductible: 0 })], "2026-08-03", "America/New_York").state,
    "covered",
  );
  assert.equal(
    deriveBillingWeather([activeCoverage], [response({ created: "2026-08-04T00:30:00Z", inforce: true, deductible: 0 })], "2026-08-03").state,
    "unknown",
  );
  assert.deepEqual(
    deriveBillingWeather([activeCoverage], [response({ inforce: false })], "2026-08-03"),
    { state: "self-pay", planName: "Synthetic Health Plan" },
  );

  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(activeCoverage);
  fake.add(response({ created: "2026-08-04T00:30:00Z", inforce: true, deductible: 0 }));
  const overview = await loadPatientOverview(fake as never, "p1", { now: "2026-08-04T00:30:00Z", timeZone: "America/New_York" });
  assert.equal(overview.billingWeather.state, "covered");
  assert.deepEqual(
    fake.searches.find((search) => search.resourceType === "CoverageEligibilityResponse")?.params,
    { patient: "Patient/p1", _count: "100", _sort: "-created" },
  );
});

test("condition summary windows to the newest three encounters and dedupes by code or text", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("third", "2026-04-01T14:00:00Z"));
  fake.add(encounter("older", "2025-01-01T14:00:00Z"));
  fake.add(encounter("newest", "2026-06-01T14:00:00Z"));
  fake.add(encounter("second", "2026-05-01T14:00:00Z"));
  fake.add(condition("medical-third", "Repeated medical", {
    category: "problem-list-item", encounterId: "third", code: "DX-REPEAT",
  }));
  fake.add(condition("medical-newest", "Repeated medical", {
    category: "problem-list-item", encounterId: "newest", code: "DX-REPEAT",
  }));
  fake.add(condition("medical-second", "Repeated medical", {
    category: "problem-list-item", encounterId: "second", code: "DX-REPEAT",
  }));
  fake.add(condition("ocular-third", "Repeated ocular", {
    category: "problem-list-item", encounterId: "third", bodySite: "Both eyes",
  }));
  fake.add(condition("ocular-newest", "Repeated ocular", {
    category: "problem-list-item", encounterId: "newest", bodySite: "Both eyes",
  }));
  fake.add(condition("ocular-second", "Repeated ocular", {
    category: "problem-list-item", encounterId: "second", bodySite: "Both eyes",
  }));
  fake.add(condition("medical-second-unique", "Second encounter condition", {
    category: "problem-list-item", encounterId: "second", code: "DX-SECOND",
  }));
  fake.add(condition("medical-third-unique", "Third encounter condition", {
    category: "problem-list-item", encounterId: "third", code: "DX-THIRD",
  }));
  fake.add(condition("older-only", "Older condition", {
    category: "problem-list-item", encounterId: "older", code: "DX-OLDER",
  }));
  fake.add(condition("unlinked", "Unlinked condition", {
    category: "problem-list-item", code: "DX-UNLINKED",
  }));
  const enteredInError = condition("entered-in-error", "Invalid condition", {
    category: "problem-list-item", encounterId: "newest", code: "DX-INVALID",
  });
  enteredInError.verificationStatus = verificationStatusConcept("entered-in-error");
  fake.add(enteredInError);

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.snapshot.medicalConditions, [
    { id: "unlinked", name: "Unlinked condition" },
    { id: "medical-newest", name: "Repeated medical" },
    { id: "medical-second-unique", name: "Second encounter condition" },
    { id: "medical-third-unique", name: "Third encounter condition" },
  ]);
  assert.deepEqual(overview.snapshot.ocularHistory, [{
    id: "ocular-newest",
    name: "Repeated ocular",
    laterality: "Both eyes",
  }]);
});

test("condition summary uses every available encounter when the patient has fewer than three", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("older", "2026-05-01T14:00:00Z"));
  fake.add(encounter("newer", "2026-06-01T14:00:00Z"));
  fake.add(condition("condition-older", "Two-visit condition", {
    category: "problem-list-item", encounterId: "older", code: "DX-TWO-VISITS",
  }));
  fake.add(condition("condition-newer", "Two-visit condition", {
    category: "problem-list-item", encounterId: "newer", code: "DX-TWO-VISITS",
  }));

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.snapshot.medicalConditions, [{
    id: "condition-newer",
    name: "Two-visit condition",
  }]);
});

test("condition summary keeps longitudinal problem-list conditions without an encounter reference", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("newest", "2026-06-01T14:00:00Z"));
  fake.add(encounter("second", "2026-05-01T14:00:00Z"));
  fake.add(encounter("third", "2026-04-01T14:00:00Z"));
  fake.add(condition("diabetes", "Type 2 diabetes mellitus", {
    category: "problem-list-item", code: "DX-DIABETES",
  }));
  fake.add(condition("hypertension", "Hypertension", {
    category: "problem-list-item", encounterId: "newest", code: "DX-HYPERTENSION",
  }));

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.snapshot.medicalConditions, [
    { id: "diabetes", name: "Type 2 diabetes mellitus" },
    { id: "hypertension", name: "Hypertension" },
  ]);
});

test("condition summary is unchanged when the visit ledger is filtered to eye exams", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("office-newest", "2026-06-01T14:00:00Z", "office-visit"));
  fake.add(encounter("office-second", "2026-05-01T14:00:00Z", "office-visit"));
  fake.add(encounter("office-third", "2026-04-01T14:00:00Z", "office-visit"));
  fake.add(encounter("eye-newest", "2025-03-01T14:00:00Z", "routine-exam-new"));
  fake.add(encounter("eye-second", "2025-02-01T14:00:00Z", "routine-exam-established"));
  fake.add(encounter("eye-third", "2025-01-01T14:00:00Z", "medicaid-exam"));
  fake.add(condition("diabetes", "Type 2 diabetes mellitus", {
    category: "problem-list-item", encounterId: "office-newest", code: "DX-DIABETES",
  }));
  fake.add(condition("ocular-hypertension", "Ocular hypertension", {
    category: "problem-list-item", encounterId: "office-second", bodySite: "Both eyes", code: "DX-OCULAR",
  }));
  fake.add(condition("longitudinal-asthma", "Longitudinal asthma", {
    category: "problem-list-item", code: "DX-LONGITUDINAL",
  }));

  const unfiltered = await loadPatientOverview(fake as never, "p1");
  const eyeExams = await loadPatientOverview(fake as never, "p1", { filter: "eye-exams" });

  assert.deepEqual(eyeExams.snapshot.medicalConditions, [
    { id: "longitudinal-asthma", name: "Longitudinal asthma" },
    { id: "diabetes", name: "Type 2 diabetes mellitus" },
  ]);
  assert.deepEqual(eyeExams.snapshot.medicalConditions, unfiltered.snapshot.medicalConditions);
  assert.deepEqual(eyeExams.snapshot.ocularHistory, unfiltered.snapshot.ocularHistory);
  assert.deepEqual(eyeExams.visits.map((visit) => visit.encounterId), ["eye-newest", "eye-second", "eye-third"]);
});

test("condition summary is unchanged when the visit ledger is filtered by diagnosis", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("office-newest", "2026-06-01T14:00:00Z", "office-visit"));
  fake.add(encounter("office-second", "2026-05-01T14:00:00Z", "office-visit"));
  fake.add(encounter("office-third", "2026-04-01T14:00:00Z", "office-visit"));
  fake.add(encounter("selected-old", "2025-01-01T14:00:00Z", "routine-exam-new"));
  fake.add(condition("diabetes", "Type 2 diabetes mellitus", {
    category: "problem-list-item", encounterId: "office-newest", code: "DX-DIABETES",
  }));
  fake.add(condition("ocular-hypertension", "Ocular hypertension", {
    category: "problem-list-item", encounterId: "office-second", bodySite: "Both eyes", code: "DX-OCULAR",
  }));
  fake.add(condition("selected-diagnosis", "Selected ledger diagnosis", {
    category: "encounter-diagnosis", encounterId: "selected-old", code: "DX-SELECTED",
  }));

  const unfiltered = await loadPatientOverview(fake as never, "p1");
  const byDiagnosis = await loadPatientOverview(fake as never, "p1", {
    diagnosisSystem: "https://example.test/diagnosis",
    diagnosisCode: "DX-SELECTED",
  });

  assert.deepEqual(byDiagnosis.snapshot.medicalConditions, unfiltered.snapshot.medicalConditions);
  assert.deepEqual(byDiagnosis.snapshot.ocularHistory, unfiltered.snapshot.ocularHistory);
  assert.deepEqual(byDiagnosis.visits.map((visit) => visit.encounterId), ["selected-old"]);
});

test("condition summary compares complete coding sets without depending on coding order", async () => {
  const partialOverlap = new FakeFhir();
  partialOverlap.add(patient());
  partialOverlap.add(encounter("newer", "2026-06-01T14:00:00Z"));
  partialOverlap.add(encounter("older", "2026-05-01T14:00:00Z"));
  const firstDiagnosis = condition("first-diagnosis", "First diagnosis", {
    category: "problem-list-item", encounterId: "newer",
  });
  firstDiagnosis.code = {
    text: "First diagnosis",
    coding: [
      { system: "https://example.test/icd", code: "SHARED" },
      { system: "https://example.test/snomed", code: "FIRST" },
    ],
  };
  partialOverlap.add(firstDiagnosis);
  const secondDiagnosis = condition("second-diagnosis", "Second diagnosis", {
    category: "problem-list-item", encounterId: "older",
  });
  secondDiagnosis.code = {
    text: "Second diagnosis",
    coding: [
      { system: "https://example.test/icd", code: "SHARED" },
      { system: "https://example.test/snomed", code: "SECOND" },
    ],
  };
  partialOverlap.add(secondDiagnosis);

  const partialOverlapOverview = await loadPatientOverview(partialOverlap as never, "p1");

  assert.deepEqual(partialOverlapOverview.snapshot.medicalConditions, [
    { id: "first-diagnosis", name: "First diagnosis" },
    { id: "second-diagnosis", name: "Second diagnosis" },
  ]);

  const reorderedMatch = new FakeFhir();
  reorderedMatch.add(patient());
  reorderedMatch.add(encounter("newer", "2026-06-01T14:00:00Z"));
  reorderedMatch.add(encounter("older", "2026-05-01T14:00:00Z"));
  const newestCodingOrder = condition("newest-match", "Same diagnosis", {
    category: "problem-list-item", encounterId: "newer",
  });
  newestCodingOrder.code = {
    text: "Same diagnosis",
    coding: [
      { system: "https://example.test/icd", code: "MATCH-ICD" },
      { system: "https://example.test/snomed", code: "MATCH-SNOMED" },
    ],
  };
  reorderedMatch.add(newestCodingOrder);
  const olderCodingOrder = condition("older-match", "Same diagnosis", {
    category: "problem-list-item", encounterId: "older",
  });
  olderCodingOrder.code = {
    text: "Same diagnosis",
    coding: [
      { system: "https://example.test/snomed", code: "MATCH-SNOMED" },
      { system: "https://example.test/icd", code: "MATCH-ICD" },
    ],
  };
  reorderedMatch.add(olderCodingOrder);

  const reorderedMatchOverview = await loadPatientOverview(reorderedMatch as never, "p1");

  assert.deepEqual(reorderedMatchOverview.snapshot.medicalConditions, [
    { id: "newest-match", name: "Same diagnosis" },
  ]);
});

test("visit ledger includes an encounter-linked problem-list Condition", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("legacy-visit", "2021-01-31T14:00:00Z"));
  fake.add(condition("legacy-problem", "Imported legacy problem", {
    category: "problem-list-item",
    encounterId: "legacy-visit",
    code: "DX-LEGACY",
  }));

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.visits[0]?.diagnoses.map((diagnosis) => diagnosis.code), ["DX-LEGACY"]);
  const ledgerConditionSearch = fake.searches.find(
    (row) => row.resourceType === "Condition" && row.params.encounter,
  );
  assert.equal(ledgerConditionSearch?.params.encounter, "Encounter/legacy-visit");
  assert.equal(
    ledgerConditionSearch?.params.category,
    `${FHIR_CONDITION_CATEGORY_CODE_SYSTEM}|encounter-diagnosis,`
      + `${FHIR_CONDITION_CATEGORY_CODE_SYSTEM}|problem-list-item`,
  );
  assert.equal(
    ledgerConditionSearch?.params["verification-status"],
    `${FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM}|confirmed`,
  );
});

test("visit ledger keeps native encounter-diagnosis Conditions", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("native-visit", "2026-06-01T14:00:00Z"));
  fake.add(condition("native-diagnosis", "Native diagnosis", {
    category: "encounter-diagnosis",
    encounterId: "native-visit",
    code: "DX-NATIVE",
  }));

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.visits[0]?.diagnoses.map((diagnosis) => diagnosis.code), ["DX-NATIVE"]);
});

test("visit ledger renders both resolved ICD-10-CM codes for one bilateral eyelid Condition", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("eyelid-visit", "2026-08-10T14:00:00Z"));
  const bilateral = condition("eyelid-bilateral", "Meibomian gland dysfunction", {
    category: "encounter-diagnosis",
    encounterId: "eyelid-visit",
  });
  bilateral.identifier = [{
    system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
    value: "eyelid-visit::meibomian_gland_dysfunction::bilateral",
  }];
  bilateral.bodySite = [{ text: "OU" }];
  bilateral.code = {
    coding: [{
      system: "https://odos2020.com/fhir/CodeSystem/diagnosis-catalog",
      code: "meibomian_gland_dysfunction",
      display: "Meibomian gland dysfunction",
    }],
    text: "Meibomian gland dysfunction",
  };
  fake.add(bilateral);
  const legacy = condition("eyelid-legacy", "Ulcerative blepharitis right eye, unspecified eyelid", {
    category: "encounter-diagnosis",
    encounterId: "eyelid-visit",
  });
  legacy.identifier = [{
    system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
    value: "eyelid-visit::ulcerative_blepharitis::right",
  }];
  legacy.bodySite = [{ text: "OD" }];
  legacy.code = {
    coding: [{
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: "H01.013",
      display: "Ulcerative blepharitis right eye, unspecified eyelid",
    }],
    text: "Ulcerative blepharitis right eye, unspecified eyelid",
  };
  fake.add(legacy);

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.visits[0]?.diagnoses.map((diagnosis) => diagnosis.code), [
    "H02.88A + H02.88B",
    "H01.013",
  ]);
});

test("legacy unspecified diagnosis keys remain catalog-resolvable and render in the visit ledger", async () => {
  const stableKeys = [
    "keratoconus_unspecified_stability",
    "t2_dr_unspecified_with_dme",
    "t2_dr_unspecified_without_dme",
  ];
  const catalog = buildDiagnosisCatalogSeeds();
  const rows = stableKeys.map((stableKey) => {
    const row = catalog.find((candidate) => candidate.stableKey === stableKey);
    assert.ok(row?.icd10, `Missing retained diagnosis catalog row ${stableKey}`);
    const code = "code" in row.icd10 ? row.icd10.code : row.icd10.pattern.right;
    assert.ok(code, `Missing retained ICD-10 resolution for ${stableKey}`);
    return { row, code };
  });
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("legacy-unspecified", "2021-01-31T14:00:00Z"));
  rows.forEach(({ row, code }, index) => {
    const existing = condition(`legacy-unspecified-${index + 1}`, row.display, {
      category: "encounter-diagnosis",
      encounterId: "legacy-unspecified",
      code,
    });
    existing.identifier = [{
      system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
      value: `${row.stableKey}::${"code" in row.icd10! ? "none" : "right"}`,
    }];
    existing.code = {
      text: row.display,
      coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code, display: row.display }],
    };
    fake.add(existing);
  });

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(
    overview.visits[0]?.diagnoses.map(({ name, code }) => ({ name, code })),
    rows.map(({ row, code }) => ({ name: row.display, code })),
  );
});

test("visit ledger batches encounter-linked Conditions without dropping or duplicating rows", async () => {
  const fake = new FakeFhir();
  const encounterCount = 120;
  const expectedConditionIds: string[] = [];
  fake.add(patient());
  for (let index = 0; index < encounterCount; index += 1) {
    const encounterId = `ledger-visit-${index}`;
    const conditionId = `ledger-condition-${index}`;
    fake.add(encounter(encounterId, new Date(Date.UTC(2020, 0, index + 1)).toISOString()));
    fake.add(condition(conditionId, `Ledger diagnosis ${index}`, {
      category: "encounter-diagnosis",
      encounterId,
      code: `DX-${index}`,
    }));
    expectedConditionIds.push(conditionId);
  }
  fake.add(condition("ledger-condition-49", "Duplicate search row", {
    category: "encounter-diagnosis",
    encounterId: "ledger-visit-49",
    code: "DX-49",
  }));

  const overview = await loadPatientOverview(fake as never, "p1");

  const projectedConditionIds = overview.visits.flatMap((visit) =>
    visit.diagnoses.map((diagnosis) => diagnosis.conditionId)
  );
  assert.deepEqual(projectedConditionIds.toSorted(), expectedConditionIds.toSorted());
  assert.equal(projectedConditionIds.length, new Set(projectedConditionIds).size);
  const ledgerConditionSearches = fake.searches.filter(
    (row) => row.resourceType === "Condition" && row.params.encounter,
  );
  assert.ok(ledgerConditionSearches.length > 1);
  for (const search of ledgerConditionSearches) {
    assert.ok(search.params.encounter.split(",").length <= 50);
    assert.equal(search.params.patient, "p1");
    assert.equal(
      search.params.category,
      `${FHIR_CONDITION_CATEGORY_CODE_SYSTEM}|encounter-diagnosis,`
        + `${FHIR_CONDITION_CATEGORY_CODE_SYSTEM}|problem-list-item`,
    );
    assert.equal(
      search.params["verification-status"],
      `${FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM}|confirmed`,
    );
    assert.equal(search.params._count, "100");
  }
});

test("patient overview route stays available with more than 1000 other-patient Provenance rows", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("signed-visit", "2026-06-01T14:00:00Z"));
  fake.add({
    resourceType: "Provenance",
    id: "signed-visit-proof",
    target: [{ reference: "Encounter/signed-visit" }, { reference: "Patient/p1" }],
    recorded: "2026-06-01T14:00:00Z",
    agent: [{ who: { display: "Dr. Clinician" } }],
  } satisfies Provenance);
  for (let index = 0; index < 1_001; index += 1) {
    fake.add({
      resourceType: "Provenance",
      id: `other-patient-${index}`,
      target: [{ reference: `Observation/other-${index}` }, { reference: `Patient/other-${index}` }],
      recorded: "2026-06-01T14:30:00Z",
      agent: [{ who: { reference: "Practitioner/other" } }],
    } satisfies Provenance);
  }

  const app = express();
  registerClinicRoutes(app, {
    authenticateService: async () => undefined,
    authenticate: async (header) => header === "Bearer good"
      ? { staffReference: "Practitioner/staff-1", actorRole: "provider", fhir: fake as never }
      : null,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const { port } = listener.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/clinic/patients/p1/overview`, {
      headers: { Authorization: "Bearer good" },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { visits: Array<{ encounterId: string; status: string }> };
    assert.deepEqual(body.visits, [{
      encounterId: "signed-visit",
      date: "2026-06-01T14:00:00Z",
      provider: "Dr. Clinician",
      facility: "Practice location",
      visitType: "Comprehensive exam",
      status: "Final",
      diagnoses: [],
    }]);
    assert.equal(
      fake.searches.find((row) => row.resourceType === "Provenance")?.params.patient,
      "Patient/p1",
    );
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("empty snapshot stays honestly empty and visit filters issue distinct FHIR searches", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("eye-visit", "2026-06-01T14:00:00Z", "routine-exam-new"));
  fake.add(encounter("office-visit", "2026-05-01T14:00:00Z", "office-visit"));

  const eye = await loadPatientOverview(fake as never, "p1", { filter: "eye-exams" });
  assert.deepEqual(eye.snapshot, {
    ocularHistory: [], ocularSurgicalHistory: [], medicalConditions: [], socialHistory: [], ophthalmicMedications: [], systemicMedications: [],
  });
  assert.deepEqual(eye.visits.map((visit) => visit.encounterId), ["eye-visit"]);
  assert.ok(fake.searches.some((row) => row.resourceType === "Encounter" && !row.params.type && !row.params._id));
  assert.match(fake.searches.find((row) => row.resourceType === "Encounter" && row.params.type)?.params.type ?? "", /routine-exam-new/);

  fake.searches.length = 0;
  const office = await loadPatientOverview(fake as never, "p1", { filter: "office-visits" });
  assert.deepEqual(office.visits.map((visit) => visit.encounterId), ["office-visit"]);
  assert.ok(fake.searches.some((row) => row.resourceType === "Encounter" && !row.params.type && !row.params._id));
  assert.match(fake.searches.find((row) => row.resourceType === "Encounter" && row.params.type)?.params.type ?? "", /office-visit/);
});

test("legacy encounter ledger status comes from the migration tag and does not invent Provenance", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add({
    ...encounter("migrated", "2019-04-03T14:00:00Z"),
    meta: {
      tag: [{
        system: "https://odos2020.com/tags/migration",
        code: "eyefinity-import",
      }],
    },
  });

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.equal(overview.visits[0]?.status, "Migrated");
  assert.equal(
    fake.searches.find((row) => row.resourceType === "Provenance")?.params.patient,
    "Patient/p1",
  );
  assert.equal(
    fake.resources.some((resource) => resource.resourceType === "Provenance"),
    false,
  );
});

test("visit detail lazily projects encounter-owned summaries, horizontal cards, and OCT numeric depth", async () => {
  const fake = new FakeFhir();
  const visit = encounter("detail-visit", "2026-06-30T14:00:00Z");
  visit.reasonCode = [{ text: "Pressure check" }];
  visit.reasonReference = [{ display: "Pressure check" }, { display: "Referral concern" }];
  const snomedRightEye = buildEyeBodyStructure("OD", "Patient/p1").location!;
  fake.add(visit);
  fake.add({
    resourceType: "Observation",
    id: "iop-od",
    status: "final",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/detail-visit" },
    code: { coding: [{ code: "INTRAOCULAR_PRESSURE" }], text: "Intraocular pressure" },
    bodySite: { coding: [{ system: "https://odos2020.com/fhir/CodeSystem/laterality", code: "OD", display: "Right eye" }] },
    valueQuantity: { value: 16, unit: "mmHg" },
  } satisfies Observation);
  fake.add({
    resourceType: "Observation",
    id: "iop-snomed",
    status: "final",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/detail-visit" },
    code: { coding: [{ code: "INTRAOCULAR_PRESSURE" }], text: "Intraocular pressure" },
    bodySite: snomedRightEye,
    valueQuantity: { value: 17, unit: "mmHg" },
  } satisfies Observation);
  fake.add({
    resourceType: "Observation",
    id: "oct-rnfl",
    status: "final",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/detail-visit" },
    code: { text: "OCT RNFL" },
    component: [
      { code: { text: "OD average" }, valueQuantity: { value: 84, unit: "um" } },
      { code: { text: "OD inferior" }, valueQuantity: { value: 71, unit: "um" } },
    ],
  } satisfies Observation);
  fake.add({
    resourceType: "Observation",
    id: "dry-eye-finding",
    status: "final",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/detail-visit" },
    code: { text: "Tear break-up time" },
    valueQuantity: { value: 4, unit: "s" },
  } satisfies Observation);
  fake.add({
    resourceType: "MedicationRequest",
    id: "med-1",
    status: "active",
    intent: "order",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/detail-visit" },
    medicationCodeableConcept: { text: "Recorded ophthalmic medication" },
    dosageInstruction: [{ text: "One drop nightly" }],
  } satisfies MedicationRequest);
  fake.add({
    resourceType: "CarePlan",
    id: "plan-1",
    status: "active",
    intent: "plan",
    subject: { reference: "Patient/p1" },
    encounter: { reference: "Encounter/detail-visit" },
    activity: [{ detail: { status: "scheduled", description: "Repeat testing" } }],
  } satisfies CarePlan);
  fake.add({
    resourceType: "Claim",
    id: "claim-1",
    status: "active",
    type: { text: "Professional claim" },
    use: "claim",
    patient: { reference: "Patient/p1" },
    created: "2026-06-30",
    provider: { reference: "Practitioner/staff-1" },
    priority: { text: "Normal" },
    insurer: { display: "Recorded payer" },
    item: [{ sequence: 1, productOrService: { text: "Recorded service" }, encounter: [{ reference: "Encounter/detail-visit" }] }],
    total: { value: 125, currency: "USD" },
  } satisfies Claim);
  fake.add({
    resourceType: "ChargeItem",
    id: "charge-1",
    status: "billable",
    code: { text: "Recorded charge" },
    subject: { reference: "Patient/p1" },
    context: { reference: "Encounter/detail-visit" },
    occurrenceDateTime: "2026-06-30",
    priceOverride: { value: 25, currency: "USD" },
  } satisfies ChargeItem);

  const detail = await loadPatientOverviewVisitDetail(fake as never, "p1", "detail-visit");

  assert.equal(detail.reason, "Pressure check · Referral concern");
  assert.equal(detail.iop.summary, "OD 16 mmHg · Right eye 17 mmHg");
  const snomedRightEyeCode = snomedRightEye.coding?.[0]?.code;
  assert.ok(snomedRightEyeCode);
  assert.equal(detail.iop.summary.includes(snomedRightEyeCode), false);
  assert.equal(detail.medications.summary, "Recorded ophthalmic medication");
  assert.equal(detail.plan.summary, "Repeat testing");
  assert.equal(detail.financial.summary, "1 claim · 1 charge");
  assert.equal(detail.financial.cards.find((card) => card.id === "claim-1")?.detail, "active · $125.00");
  assert.equal(detail.financial.cards.find((card) => card.id === "charge-1")?.detail, "billable · $25.00");
  const claimSearch = fake.searches.find((search) => search.resourceType === "Claim");
  assert.ok(claimSearch);
  for (const key of ["patient", "encounter", "_count"]) assert.ok(key in claimSearch.params);
  assert.equal(claimSearch.params.patient, "Patient/p1");
  assert.equal(claimSearch.params.encounter, "Encounter/detail-visit");
  assert.deepEqual(detail.findings.cards.find((card) => card.id === "oct-rnfl")?.values, [
    { label: "OD average", value: "84 um" },
    { label: "OD inferior", value: "71 um" },
  ]);
  assert.equal(detail.findings.cards.find((card) => card.id === "dry-eye-finding")?.values, undefined);
});

test("migrated visit detail with no structured content remains honestly empty", async () => {
  const fake = new FakeFhir();
  fake.add({
    ...encounter("migrated-empty", "2019-04-03T14:00:00Z"),
    meta: { tag: [{ system: "https://odos2020.com/tags/migration", code: "eyefinity-import" }] },
  });

  const detail = await loadPatientOverviewVisitDetail(fake as never, "p1", "migrated-empty");

  assert.equal(detail.reason, undefined);
  assert.deepEqual(
    [detail.iop, detail.findings, detail.medications, detail.plan, detail.financial].map((group) => group.cards.length),
    [0, 0, 0, 0, 0],
  );
});

test("visit detail reports role-scoped financial sources as unavailable", async () => {
  const fake = new FakeFhir();
  fake.add(encounter("financial-unavailable", "2026-06-30T14:00:00Z"));
  fake.deniedTypes.add("Claim");
  fake.deniedTypes.add("ChargeItem");

  const detail = await loadPatientOverviewVisitDetail(fake as never, "p1", "financial-unavailable");

  assert.deepEqual(detail.financial.cards, []);
  assert.equal(
    detail.financial.unavailable,
    "Claims unavailable from this session · Charges unavailable from this session",
  );
});

test("visit detail does not disguise unexpected financial-source failures as unavailable wiring", async () => {
  const fake = new FakeFhir();
  fake.add(encounter("financial-failure", "2026-06-30T14:00:00Z"));
  fake.failedTypes.set("Claim", 500);

  await assert.rejects(
    loadPatientOverviewVisitDetail(fake as never, "p1", "financial-failure"),
    /Claim unavailable/,
  );
});

test("overview stays usable and reports honest wiring when role-scoped optional reads are unavailable", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.deniedTypes.add("Coverage");
  fake.deniedTypes.add("MedicationRequest");

  const overview = await loadPatientOverview(fake as never, "p1");

  assert.deepEqual(overview.insurance, []);
  assert.deepEqual(overview.snapshot.systemicMedications, []);
  assert.deepEqual(overview.unavailable, {
    insurance: "Insurance unavailable from this session",
    medicationOrders: "Medication orders unavailable from this session",
  });
});

test("overview does not disguise unexpected optional-source failures as unavailable wiring", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.failedTypes.set("Coverage", 500);

  await assert.rejects(loadPatientOverview(fake as never, "p1"), /Coverage unavailable/);
});

test("diagnosis filtering searches Condition by code then searches only matching Encounter ids", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("match", "2026-06-01T14:00:00Z"));
  fake.add(encounter("other", "2025-06-01T14:00:00Z"));
  fake.add(condition("dx-match", "Selected diagnosis", { category: "encounter-diagnosis", encounterId: "match", code: "DX-SELECTED" }));

  await loadPatientOverview(fake as never, "p1", {
    filter: "eye-exams",
    diagnosisSystem: "https://example.test/diagnosis",
    diagnosisCode: "DX-SELECTED",
  });

  const ledgerConditionSearch = fake.searches.find(
    (row) => row.resourceType === "Condition" && row.params.encounter,
  );
  assert.equal(ledgerConditionSearch?.params.code, "https://example.test/diagnosis|DX-SELECTED");
  assert.equal(ledgerConditionSearch?.params.encounter, "Encounter/match");
  assert.equal(
    ledgerConditionSearch?.params.category,
    `${FHIR_CONDITION_CATEGORY_CODE_SYSTEM}|encounter-diagnosis,`
      + `${FHIR_CONDITION_CATEGORY_CODE_SYSTEM}|problem-list-item`,
  );
  assert.ok(fake.searches.some((row) => row.resourceType === "Encounter" && !row.params.type && !row.params._id));
  const filteredEncounterSearch = fake.searches.find((row) => row.resourceType === "Encounter" && row.params._id);
  assert.equal(filteredEncounterSearch?.params._id, "match");
  assert.equal(filteredEncounterSearch?.params.type, undefined);
});

test("diagnosis filtering does not select a visit from an unconfirmed Condition", async () => {
  const fake = new FakeFhir();
  fake.add(patient());
  fake.add(encounter("unconfirmed-visit", "2026-06-01T14:00:00Z"));
  const unconfirmed = condition("unconfirmed-diagnosis", "Unconfirmed diagnosis", {
    category: "encounter-diagnosis",
    encounterId: "unconfirmed-visit",
    code: "DX-SELECTED",
  });
  unconfirmed.verificationStatus = verificationStatusConcept("provisional");
  fake.add(unconfirmed);

  const overview = await loadPatientOverview(fake as never, "p1", {
    diagnosisSystem: "https://example.test/diagnosis",
    diagnosisCode: "DX-SELECTED",
  });

  assert.deepEqual(overview.visits, []);
});

test("sticky note create and second edit persist prior text in native DocumentReference history", async () => {
  const fake = new FakeFhir();
  const first = await savePatientStickyNote(fake as never, {
    patientId: "p1",
    text: "First chart-front note",
    authorReference: "Practitioner/one",
    now: "2026-07-11T14:00:00Z",
  });
  const second = await savePatientStickyNote(fake as never, {
    patientId: "p1",
    text: "Second chart-front note",
    authorReference: "Practitioner/two",
    now: "2026-07-11T15:00:00Z",
  });
  const history = await loadPatientStickyNoteHistory(fake as never, "p1");

  assert.equal(first.text, "First chart-front note");
  assert.equal(second.text, "Second chart-front note");
  assert.deepEqual(history.map((entry) => entry.text), ["Second chart-front note", "First chart-front note"]);
  assert.deepEqual(history.map((entry) => entry.editedBy), ["Practitioner/two", "Practitioner/one"]);
});

test("sticky-note conditional-create races update the winning resource with this edit", async () => {
  const fake = new FakeFhir();
  fake.conditionalCreateResponse = {
    resourceType: "DocumentReference",
    id: "sticky-1",
    meta: { versionId: "1" },
    status: "current",
    identifier: [{ system: "https://odos2020.com/fhir/identifier/patient-sticky-note", value: "p1" }],
    subject: { reference: "Patient/p1" },
    content: [{ attachment: { data: Buffer.from("Concurrent edit", "utf8").toString("base64") } }],
  };

  const saved = await savePatientStickyNote(fake as never, {
    patientId: "p1",
    text: "This caller's edit",
    authorReference: "Practitioner/one",
    now: "2026-07-11T14:00:00Z",
  });

  assert.equal(saved.text, "This caller's edit");
  assert.equal(fake.updateCalls, 1);
});

class FakeFhir {
  resources: Resource[] = [];
  searches: Array<{ resourceType: string; params: Record<string, string> }> = [];
  documentHistory: DocumentReference[] = [];
  deniedTypes = new Set<string>();
  failedTypes = new Map<string, number>();
  conditionalCreateResponse?: DocumentReference;
  updateCalls = 0;

  add(resource: Resource) { this.resources.push(resource); }

  async read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T> {
    const resource = this.resources.find((candidate) => candidate.resourceType === resourceType && candidate.id === id);
    if (!resource) throw new Error(`${resourceType}/${id} not found`);
    return resource as T;
  }

  async search<T extends Resource>(resourceType: T["resourceType"], params: Record<string, string> = {}): Promise<Bundle<T>> {
    this.searches.push({ resourceType, params: { ...params } });
    const failureStatus = this.failedTypes.get(resourceType);
    if (failureStatus) {
      const error = new Error(`${resourceType} unavailable`) as Error & { status?: number };
      error.status = failureStatus;
      throw error;
    }
    if (this.deniedTypes.has(resourceType)) {
      const error = new Error(`${resourceType} unavailable`) as Error & { status?: number };
      error.status = 403;
      throw error;
    }
    let rows = this.resources.filter((resource) => resource.resourceType === resourceType) as T[];
    if (resourceType === "DocumentReference" && params.identifier) {
      rows = rows.filter((resource) => (resource as DocumentReference).identifier?.some((identifier) => `${identifier.system}|${identifier.value}` === params.identifier));
    }
    if (resourceType === "Condition" && params.category) {
      const requestedCategories = params.category.split(",");
      rows = rows.filter((resource) => (resource as Condition).category?.some((category) =>
        category.coding?.some((coding) => requestedCategories.includes(coding.code ?? "")
          || requestedCategories.includes(`${coding.system}|${coding.code}`))
      ));
    }
    if (resourceType === "Condition" && params.code) {
      rows = rows.filter((resource) => (resource as Condition).code?.coding?.some((coding) => `${coding.system}|${coding.code}` === params.code));
    }
    if (resourceType === "Condition" && params["verification-status"]) {
      const requestedStatuses = params["verification-status"].split(",");
      rows = rows.filter((resource) => (resource as Condition).verificationStatus?.coding?.some(
        (coding) => requestedStatuses.includes(coding.code ?? "")
          || requestedStatuses.includes(`${coding.system}|${coding.code}`),
      ));
    }
    if (resourceType === "Encounter" && params._id) rows = rows.filter((resource) => params._id.split(",").includes(resource.id ?? ""));
    if (resourceType === "EpisodeOfCare" && params.status) {
      rows = rows.filter((resource) => (resource as EpisodeOfCare).status === params.status);
    }
    if (resourceType === "Encounter" && params.type) {
      const requestedTypes = params.type.split(",");
      rows = rows.filter((resource) => (resource as Encounter).type?.some((concept) =>
        concept.coding?.some((coding) => requestedTypes.includes(`${coding.system}|${coding.code}`)),
      ));
    }
    if (resourceType === "Provenance" && params.patient) {
      rows = rows.filter((resource) => (resource as Provenance).target.some(
        (target) => target.reference === params.patient,
      ));
    }
    if (params.encounter) {
      const encounterReferences = params.encounter.split(",").map((reference) =>
        reference.startsWith("Encounter/") ? reference : `Encounter/${reference}`
      );
      rows = rows.filter((resource) => {
        if (resource.resourceType === "Claim") {
          return resource.item?.some((item) => item.encounter?.some((reference) =>
            encounterReferences.includes(reference.reference ?? "")
          ));
        }
        return "encounter" in resource && encounterReferences.includes(
          (resource as Observation | MedicationRequest | CarePlan).encounter?.reference ?? "",
        );
      });
    }
    if (resourceType === "ChargeItem" && params.context) {
      rows = rows.filter((resource) => (resource as ChargeItem).context?.reference === params.context);
    }
    return bundle(rows);
  }

  async create<T extends Resource>(resource: T): Promise<T> {
    if (this.conditionalCreateResponse) {
      const winner = structuredClone(this.conditionalCreateResponse);
      this.resources.push(winner);
      this.documentHistory.unshift(winner);
      return winner as T;
    }
    const version = { ...resource, id: "sticky-1", meta: { ...resource.meta, versionId: "1", lastUpdated: "2026-07-11T14:00:00Z" } } as T;
    this.resources.push(version);
    this.documentHistory.unshift(structuredClone(version as DocumentReference));
    return version;
  }

  async update<T extends Resource>(_resourceType: T["resourceType"], id: string, resource: T): Promise<T> {
    this.updateCalls += 1;
    const versionId = String(this.documentHistory.length + 1);
    const updated = { ...resource, id, meta: { ...resource.meta, versionId, lastUpdated: "2026-07-11T15:00:00Z" } } as T;
    this.resources = this.resources.map((candidate) => candidate.resourceType === resource.resourceType && candidate.id === id ? updated : candidate);
    this.documentHistory.unshift(structuredClone(updated as DocumentReference));
    return updated;
  }

  async history<T extends Resource>(): Promise<Bundle<T>> {
    return bundle(this.documentHistory as T[]);
  }
}

function patient(): Patient {
  return { resourceType: "Patient", id: "p1", name: [{ given: ["Alex"], family: "Patient" }], birthDate: "1980-01-01", gender: "female" };
}

function encounter(id: string, start: string, visitCode?: string): Encounter {
  return {
    resourceType: "Encounter",
    id,
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p1" },
    period: { start, end: start },
    type: [{ text: "Comprehensive exam", ...(visitCode ? { coding: [{ system: ODOS_VISIT_TYPE_SYSTEM, code: visitCode }] } : {}) }],
    participant: [{ individual: { display: "Dr. Clinician" } }],
    serviceProvider: { display: "Practice location" },
  };
}

function condition(id: string, name: string, options: { category: "problem-list-item" | "encounter-diagnosis"; bodySite?: string; encounterId?: string; code?: string }): Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/p1" },
    category: [conditionCategoryConcept(options.category)],
    clinicalStatus: clinicalStatusConcept("active"),
    verificationStatus: verificationStatusConcept("confirmed"),
    code: { text: name, ...(options.code ? { coding: [{ system: "https://example.test/diagnosis", code: options.code, display: name }] } : {}) },
    ...(options.bodySite ? { bodySite: [{ text: options.bodySite }] } : {}),
    ...(options.encounterId ? { encounter: { reference: `Encounter/${options.encounterId}` } } : {}),
  };
}

function bundle<T extends Resource>(resources: T[]): Bundle<T> {
  return { resourceType: "Bundle", type: "searchset", entry: resources.map((resource) => ({ resource })) };
}
