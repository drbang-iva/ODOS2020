import assert from "node:assert/strict";
import { test } from "node:test";
import type { Procedure } from "@medplum/fhirtypes";
import {
  EPISODE_OF_CARE_TYPE_CODES,
  OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
  buildEpisodeOfCare,
  episodeOfCareTypeConcept,
  episodeOfCareTypeDefinition,
} from "../src/fhir/episodeOfCare.js";
import {
  CONDITION_BODY_SITE_EXTENSION_URL,
  FHIR_CONDITION_CATEGORY_CODE_SYSTEM,
  FHIR_DIAGNOSIS_ROLE_CODE_SYSTEM,
  US_CORE_CONDITION_CATEGORY_CODE_SYSTEM,
  US_CORE_CONDITION_ENCOUNTER_DIAGNOSIS_PROFILE,
  US_CORE_CONDITION_PROBLEMS_HEALTH_CONCERNS_PROFILE,
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  buildHealthConcernCondition,
  buildProblemListCondition,
  clinicalStatusConcept,
  conditionBodySite,
  conditionCodeConcept,
  hasConditionCategory,
  verificationStatusConcept,
} from "../src/fhir/condition.js";
import {
  NO_KNOWN_ALLERGY_SNOMED_CODE,
  SNOMED_CT_CODE_SYSTEM,
  US_CORE_ALLERGY_INTOLERANCE_PROFILE,
  buildAllergyIntolerance,
} from "../src/fhir/allergyIntolerance.js";
import {
  LOINC_CODE_SYSTEM,
  SNOMED_CT_CODE_SYSTEM as SMOKING_SNOMED_CT_CODE_SYSTEM,
  TOBACCO_SMOKING_STATUS_LOINC_CODE,
  US_CORE_SMOKING_STATUS_PROFILE,
  buildSmokingStatusObservation,
  smokingStatusAnswerConcept,
} from "../src/fhir/smokingStatus.js";
import {
  US_CORE_CARE_TEAM_PROFILE,
  buildCareTeam,
  preferredCareTeamMemberReference,
} from "../src/fhir/careTeam.js";
import {
  PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
  buildProcedure,
  procedureCodeConcept,
  withProcedureTargetBodyStructure,
} from "../src/fhir/procedure.js";

test("EpisodeOfCare.type uses the OSOD CodeSystem", () => {
  const concept = episodeOfCareTypeConcept("glaucoma");
  assert.equal(concept.coding?.[0]?.system, OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM);
  assert.equal(concept.coding?.[0]?.code, "glaucoma");
});

test("EpisodeOfCare builder includes patient, organization, period, and diagnoses", () => {
  const episode = buildEpisodeOfCare({
    typeCode: "myopia-management",
    status: "active",
    patientReference: "Patient/p1",
    managingOrganizationReference: "Organization/o1",
    periodStart: "2026-04-25T12:00:00.000Z",
    conditionReferences: ["Condition/c1", "Condition/c2"],
  });

  assert.equal(episode.patient.reference, "Patient/p1");
  assert.equal(episode.managingOrganization?.reference, "Organization/o1");
  assert.equal(episode.period?.start, "2026-04-25T12:00:00.000Z");
  assert.deepEqual(
    episode.diagnosis?.map((diagnosis) => diagnosis.condition.reference),
    ["Condition/c1", "Condition/c2"],
  );
});

test("EpisodeOfCare definitions cover every local type code", () => {
  for (const code of EPISODE_OF_CARE_TYPE_CODES) {
    assert.ok(episodeOfCareTypeDefinition(code).length > 20);
  }
});

test("EpisodeOfCare builder rejects unsupported type codes", () => {
  assert.throws(() =>
    buildEpisodeOfCare({
      typeCode: "retina" as never,
      status: "active",
      patientReference: "Patient/p1",
    }),
  );
});

test("encounter-diagnosis Condition uses the US Core encounter diagnosis profile", () => {
  const condition = buildEncounterDiagnosisCondition({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    code: { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H52.13" },
  });

  assert.equal(condition.meta?.profile?.[0], US_CORE_CONDITION_ENCOUNTER_DIAGNOSIS_PROFILE);
  assert.equal(condition.category?.[0]?.coding?.[0]?.system, FHIR_CONDITION_CATEGORY_CODE_SYSTEM);
  assert.equal(condition.category?.[0]?.coding?.[0]?.code, "encounter-diagnosis");
  assert.equal(condition.encounter?.reference, "Encounter/e1");
});

test("Encounter.diagnosis component carries billing role and rank", () => {
  const diagnosis = buildEncounterDiagnosisComponent("Condition/c1", 1);
  assert.equal(diagnosis.condition.reference, "Condition/c1");
  assert.equal(diagnosis.rank, 1);
  assert.equal(diagnosis.use?.coding?.[0]?.system, FHIR_DIAGNOSIS_ROLE_CODE_SYSTEM);
  assert.equal(diagnosis.use?.coding?.[0]?.code, "billing");
});

test("Encounter.diagnosis rank rejects zero", () => {
  assert.throws(() => buildEncounterDiagnosisComponent("Condition/c1", 0));
});

test("problem-list Condition is longitudinal and omits Encounter", () => {
  const condition = buildProblemListCondition({
    patientReference: "Patient/p1",
    code: { system: "http://snomed.info/sct", code: "73211009", display: "Diabetes mellitus" },
  });

  assert.equal(condition.meta?.profile?.[0], US_CORE_CONDITION_PROBLEMS_HEALTH_CONCERNS_PROFILE);
  assert.equal(condition.category?.[0]?.coding?.[0]?.code, "problem-list-item");
  assert.equal(condition.encounter, undefined);
});

test("health-concern Condition uses the US Core health-concern category system", () => {
  const condition = buildHealthConcernCondition({
    patientReference: "Patient/p1",
    code: { system: "http://snomed.info/sct", code: "161891005", display: "Backache" },
  });

  assert.equal(condition.meta?.profile?.[0], US_CORE_CONDITION_PROBLEMS_HEALTH_CONCERNS_PROFILE);
  assert.equal(condition.category?.[0]?.coding?.[0]?.system, US_CORE_CONDITION_CATEGORY_CODE_SYSTEM);
  assert.equal(condition.category?.[0]?.coding?.[0]?.code, "health-concern");
});

test("Condition clinicalStatus builder uses the FHIR clinical status code", () => {
  assert.equal(clinicalStatusConcept("resolved").coding?.[0]?.code, "resolved");
});

test("Condition verificationStatus builder supports entered-in-error", () => {
  const concept = verificationStatusConcept("entered-in-error");
  assert.equal(concept.coding?.[0]?.code, "entered-in-error");
  assert.equal(concept.coding?.[0]?.display, "Entered in Error");
});

test("hasConditionCategory distinguishes encounter and problem list Conditions", () => {
  const condition = buildProblemListCondition({
    patientReference: "Patient/p1",
    code: { system: "http://snomed.info/sct", code: "38341003" },
  });

  assert.equal(hasConditionCategory(condition, "problem-list-item"), true);
  assert.equal(hasConditionCategory(condition, "encounter-diagnosis"), false);
});

test("Condition bodySite uses the standard bodySite extension", () => {
  const bodySite = conditionBodySite("BodyStructure/b1", "Right eye");
  assert.equal(bodySite[0].extension?.[0]?.url, CONDITION_BODY_SITE_EXTENSION_URL);
  assert.equal(bodySite[0].extension?.[0]?.valueReference?.reference, "BodyStructure/b1");
});

test("Condition code concept preserves coding text", () => {
  const concept = conditionCodeConcept({
    system: "http://hl7.org/fhir/sid/icd-10-cm",
    code: "H40.013",
    display: "Open angle with borderline findings, low risk, bilateral",
    text: "Glaucoma suspect OU",
  });
  assert.equal(concept.text, "Glaucoma suspect OU");
  assert.equal(concept.coding?.[0]?.code, "H40.013");
});

test("AllergyIntolerance builder is code-first", () => {
  const allergy = buildAllergyIntolerance({
    patientReference: "Patient/p1",
    code: { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980", display: "Penicillin" },
  });

  assert.equal(allergy.meta?.profile?.[0], US_CORE_ALLERGY_INTOLERANCE_PROFILE);
  assert.equal(allergy.code?.coding?.[0]?.code, "7980");
  assert.equal(allergy.reaction, undefined);
});

test("No known allergy uses SNOMED 716186003 in AllergyIntolerance.code", () => {
  const allergy = buildAllergyIntolerance({
    patientReference: "Patient/p1",
    noKnownAllergy: true,
  });

  assert.equal(allergy.code?.coding?.[0]?.system, SNOMED_CT_CODE_SYSTEM);
  assert.equal(allergy.code?.coding?.[0]?.code, NO_KNOWN_ALLERGY_SNOMED_CODE);
});

test("AllergyIntolerance reaction.substance stays secondary to code", () => {
  const allergy = buildAllergyIntolerance({
    patientReference: "Patient/p1",
    code: { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980" },
    reaction: [
      {
        manifestation: { system: "http://snomed.info/sct", code: "247472004", display: "Hives" },
        substance: { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980" },
      },
    ],
  });

  assert.equal(allergy.code?.coding?.[0]?.code, "7980");
  assert.equal(allergy.reaction?.[0]?.substance?.coding?.[0]?.code, "7980");
});

test("entered-in-error AllergyIntolerance omits clinicalStatus", () => {
  const allergy = buildAllergyIntolerance({
    patientReference: "Patient/p1",
    code: { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980" },
    verificationStatus: "entered-in-error",
  });

  assert.equal(allergy.clinicalStatus, undefined);
  assert.equal(allergy.verificationStatus?.coding?.[0]?.code, "entered-in-error");
});

test("Smoking Status Observation uses US Core profile and LOINC 72166-2", () => {
  const observation = buildSmokingStatusObservation({
    patientReference: "Patient/p1",
    statusCode: "266919005",
    effectiveDateTime: "2026-04-25T12:00:00.000Z",
  });

  assert.equal(observation.meta?.profile?.[0], US_CORE_SMOKING_STATUS_PROFILE);
  assert.equal(observation.code.coding?.[0]?.system, LOINC_CODE_SYSTEM);
  assert.equal(observation.code.coding?.[0]?.code, TOBACCO_SMOKING_STATUS_LOINC_CODE);
});

test("Smoking Status value uses the US Core SNOMED answer set", () => {
  const answer = smokingStatusAnswerConcept("8517006");
  assert.equal(answer.coding?.[0]?.system, SMOKING_SNOMED_CT_CODE_SYSTEM);
  assert.equal(answer.coding?.[0]?.display, "Former smoker");
});

test("Smoking Status builder rejects unsupported answers", () => {
  assert.throws(() =>
    buildSmokingStatusObservation({
      patientReference: "Patient/p1",
      statusCode: "123456" as never,
      effectiveDateTime: "2026-04-25T12:00:00.000Z",
    }),
  );
});

test("CareTeam builder uses PractitionerRole when present", () => {
  const careTeam = buildCareTeam({
    patientReference: "Patient/p1",
    participant: [
      {
        role: { text: "Primary optometrist" },
        practitionerRoleReference: "PractitionerRole/pr1",
        practitionerReference: "Practitioner/pra1",
      },
    ],
  });

  assert.equal(careTeam.meta?.profile?.[0], US_CORE_CARE_TEAM_PROFILE);
  assert.equal(careTeam.participant?.[0]?.member?.reference, "PractitionerRole/pr1");
});

test("CareTeam participant falls back to Practitioner", () => {
  assert.equal(
    preferredCareTeamMemberReference({
      role: { text: "Optometrist" },
      practitionerReference: "Practitioner/pra1",
    }),
    "Practitioner/pra1",
  );
});

test("CareTeam participant supports RelatedPerson fallback", () => {
  assert.equal(
    preferredCareTeamMemberReference({
      role: { text: "Caregiver" },
      relatedPersonReference: "RelatedPerson/rp1",
    }),
    "RelatedPerson/rp1",
  );
});

test("CareTeam builder rejects empty participant lists", () => {
  assert.throws(() => buildCareTeam({ patientReference: "Patient/p1", participant: [] }));
});

test("Procedure builder uses procedure-targetBodyStructure extension", () => {
  const procedure = buildProcedure({
    patientReference: "Patient/p1",
    status: "completed",
    code: { system: "http://www.ama-assn.org/go/cpt", code: "92133" },
    bodyStructureReference: "BodyStructure/b1",
  });

  assert.equal(procedure.extension?.[0]?.url, PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL);
  assert.equal(procedure.extension?.[0]?.valueReference?.reference, "BodyStructure/b1");
});

test("Procedure body-structure helper replaces existing target extension", () => {
  const procedure: Procedure = {
    resourceType: "Procedure",
    status: "completed",
    subject: { reference: "Patient/p1" },
    code: procedureCodeConcept({ system: "http://www.ama-assn.org/go/cpt", code: "92133" }),
    extension: [
      {
        url: PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
        valueReference: { reference: "BodyStructure/old" },
      },
    ],
  };

  const updated = withProcedureTargetBodyStructure(procedure, "BodyStructure/new");
  assert.equal(updated.extension?.length, 1);
  assert.equal(updated.extension?.[0]?.valueReference?.reference, "BodyStructure/new");
});

test("Procedure body-structure helper removes target extension when omitted", () => {
  const procedure: Procedure = {
    resourceType: "Procedure",
    status: "completed",
    subject: { reference: "Patient/p1" },
    code: procedureCodeConcept({ system: "http://www.ama-assn.org/go/cpt", code: "92133" }),
    extension: [
      {
        url: PROCEDURE_TARGET_BODY_STRUCTURE_EXTENSION_URL,
        valueReference: { reference: "BodyStructure/old" },
      },
      { url: "https://osod.dev/fhir/StructureDefinition/example", valueString: "keep" },
    ],
  };

  const updated = withProcedureTargetBodyStructure(procedure, undefined);
  assert.deepEqual(
    updated.extension?.map((extension) => extension.url),
    ["https://osod.dev/fhir/StructureDefinition/example"],
  );
});

test("Procedure code concept preserves display text", () => {
  const concept = procedureCodeConcept({
    system: "http://www.ama-assn.org/go/cpt",
    code: "92133",
    display: "Scanning computerized ophthalmic diagnostic imaging",
  });
  assert.equal(concept.text, "Scanning computerized ophthalmic diagnostic imaging");
});
