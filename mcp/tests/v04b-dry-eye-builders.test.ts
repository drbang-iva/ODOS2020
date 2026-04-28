import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL,
  DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL,
  DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL,
  DRY_EYE_QUESTIONNAIRE_INSTRUMENTS,
  DRY_EYE_QUESTIONNAIRE_URLS,
  OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL,
  buildDryEyeCanonicalResources,
} from "../src/fhir/dryEyeTerminology.js";
import {
  buildDryEyeQuestionnaireResponse,
  buildDryEyeQuestionnaireScoreObservation,
  defaultDryEyeQuestionnaireAnswers,
} from "../src/fhir/dryEyeQuestionnaireResponse.js";
import {
  buildDryEyeTreatmentProcedure,
  buildDryEyeTreatmentSeriesChildren,
  buildDryEyeTreatmentSeriesProcedure,
  procedureStatusForDryEyeUpdate,
} from "../src/fhir/dryEyeProcedure.js";
import { buildMeibographyObservation } from "../src/fhir/meibography.js";
import { buildOphthalmicMedicationStatement } from "../src/fhir/ophthalmicMedicationStatement.js";
import { buildDryEyeAdverseEvent } from "../src/fhir/dryEyeAdverseEvent.js";

test("dry-eye QuestionnaireResponse builder uses canonical instrument and derived summary Observation", () => {
  const answers = defaultDryEyeQuestionnaireAnswers("OSDI", 2);
  const response = buildDryEyeQuestionnaireResponse({
    instrument: "OSDI",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    authored: "2026-04-28T12:00:00.000Z",
    answers,
  });
  const score = buildDryEyeQuestionnaireScoreObservation({
    instrument: "OSDI",
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    questionnaireResponseReference: "QuestionnaireResponse/qr1",
    effectiveDateTime: response.authored,
    answers,
  });

  assert.equal(response.questionnaire, DRY_EYE_QUESTIONNAIRE_URLS.OSDI);
  assert.equal(response.subject?.reference, "Patient/p1");
  assert.equal(score.derivedFrom?.[0]?.reference, "QuestionnaireResponse/qr1");
  assert.equal(score.subject.reference, "Patient/p1");
  assert.equal(score.valueQuantity?.value, 50);
  const scoreSourceReferences = score.derivedFrom?.map((source) => source.reference ?? "") ?? [];
  assert.ok(scoreSourceReferences.every((reference) => !reference.startsWith("Device/")));
});

test("dry-eye canonical installer resources include all four questionnaire definitions and extensions", () => {
  const canonical = buildDryEyeCanonicalResources();
  const urls = canonical.map((resource) => resource.url);
  for (const instrument of DRY_EYE_QUESTIONNAIRE_INSTRUMENTS) {
    assert.ok(urls.includes(DRY_EYE_QUESTIONNAIRE_URLS[instrument]));
  }
  assert.ok(urls.includes(DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL));
  assert.ok(urls.includes(DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL));
  assert.ok(urls.includes(DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL));
  assert.ok(urls.includes(OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL));
});

test("meibography Observation derives from DocumentReference and preserves lid/laterality", () => {
  const observation = buildMeibographyObservation({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    documentReference: "DocumentReference/img1",
    eye: "OD",
    lid: "upper",
    scoringSystem: "meiboscore",
    totalScore: 6,
    glandScores: [2, 2, 2],
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
  });

  assert.equal(observation.derivedFrom?.[0]?.reference, "DocumentReference/img1");
  assert.equal(observation.bodySite?.text, "OD upper lid");
  assert.equal(observation.component?.length, 3);
});

test("dry-eye treatment session chains to series parent and records device parameters", () => {
  const parent = buildDryEyeTreatmentSeriesProcedure({
    patientReference: "Patient/p1",
    treatmentType: "IPL",
    totalSessions: 4,
    treatmentDeviceReference: "Device/ipl1",
  });
  const session = buildDryEyeTreatmentProcedure({
    patientReference: "Patient/p1",
    treatmentType: "IPL",
    seriesProcedureReference: "Procedure/series1",
    treatmentDeviceReference: "Device/ipl1",
    sessionNumber: 1,
    totalSessions: 4,
    parameters: { energyMj: 14, wavelengthNm: 590, spotCount: 42 },
  });
  const children = buildDryEyeTreatmentSeriesChildren({
    patientReference: "Patient/p1",
    treatmentType: "IPL",
    totalSessions: 4,
    seriesProcedureReference: "Procedure/series1",
  });

  assert.equal(parent.usedReference?.[0]?.reference, "Device/ipl1");
  assert.equal(session.partOf?.[0]?.reference, "Procedure/series1");
  assert.equal(session.usedReference?.[0]?.reference, "Device/ipl1");
  assert.equal(session.extension?.find((extension) => extension.url === DRY_EYE_PROCEDURE_ENERGY_EXTENSION_URL)?.valueQuantity?.code, "mJ");
  assert.equal(session.extension?.find((extension) => extension.url === DRY_EYE_PROCEDURE_WAVELENGTH_EXTENSION_URL)?.valueQuantity?.code, "nm");
  assert.equal(session.extension?.find((extension) => extension.url === DRY_EYE_PROCEDURE_SPOT_COUNT_EXTENSION_URL)?.valueInteger, 42);
  assert.equal(children.length, 4);
  assert.equal(children[0].partOf?.[0]?.reference, "Procedure/series1");
  assert.equal(procedureStatusForDryEyeUpdate("aborted"), "stopped");
});

test("ophthalmic MedicationStatement records route and OTC/Rx flag", () => {
  const statement = buildOphthalmicMedicationStatement({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    medication: { text: "Restasis" },
    supplyType: "rx",
    dosageText: "One drop twice daily",
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    dateAsserted: "2026-04-28T12:00:00.000Z",
  });

  assert.equal(statement.context?.reference, "Encounter/e1");
  assert.equal(statement.dosage?.[0]?.route?.text, "Ophthalmic route");
  assert.equal(statement.extension?.[0]?.url, OPHTHALMIC_MEDICATION_SUPPLY_TYPE_EXTENSION_URL);
  assert.equal(statement.extension?.[0]?.valueCode, "rx");
});

test("dry-eye AdverseEvent captures USCDI-forward-compatible event and suspect entity", () => {
  const adverseEvent = buildDryEyeAdverseEvent({
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    event: { text: "Corneal edema" },
    suspectEntityReferences: ["Procedure/ipl1"],
    recordedDate: "2026-04-28T12:00:00.000Z",
  });

  assert.equal(adverseEvent.resourceType, "AdverseEvent");
  assert.equal(adverseEvent.subject.reference, "Patient/p1");
  assert.equal(adverseEvent.suspectEntity?.[0]?.instance.reference, "Procedure/ipl1");
});
