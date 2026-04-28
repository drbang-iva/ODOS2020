import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRY_EYE_QUESTIONNAIRE_INSTRUMENTS,
  DRY_EYE_TREATMENT_TYPE_CODES,
} from "../src/fhir/dryEyeTerminology.js";
import {
  buildDryEyeQuestionnaireResponse,
  buildDryEyeQuestionnaireScoreObservation,
  defaultDryEyeQuestionnaireAnswers,
} from "../src/fhir/dryEyeQuestionnaireResponse.js";
import {
  DRY_EYE_PROCEDURE_STATUS_CODES,
  buildDryEyeTreatmentProcedure,
} from "../src/fhir/dryEyeProcedure.js";
import {
  OPHTHALMIC_MEDICATION_STATUS_CODES,
  buildOphthalmicMedicationStatement,
} from "../src/fhir/ophthalmicMedicationStatement.js";
import { buildMeibographyObservation } from "../src/fhir/meibography.js";
import { buildDryEyeAdverseEvent } from "../src/fhir/dryEyeAdverseEvent.js";

test("v0.4b dry-eye questionnaire inventory emits stable QuestionnaireResponse and score shapes", async (t) => {
  for (const instrument of DRY_EYE_QUESTIONNAIRE_INSTRUMENTS) {
    for (let value = 0; value < 10; value += 1) {
      await t.test(`${instrument} value ${value}`, () => {
        const answers = defaultDryEyeQuestionnaireAnswers(instrument, value);
        const response = buildDryEyeQuestionnaireResponse({
          instrument,
          patientReference: "Patient/p1",
          authored: "2026-04-28T12:00:00.000Z",
          answers,
        });
        const score = buildDryEyeQuestionnaireScoreObservation({
          instrument,
          patientReference: "Patient/p1",
          questionnaireResponseReference: "QuestionnaireResponse/qr1",
          effectiveDateTime: "2026-04-28T12:00:00.000Z",
          answers,
        });
        assert.equal(response.resourceType, "QuestionnaireResponse");
        assert.equal(response.item?.length, answers.length);
        assert.equal(score.derivedFrom?.[0]?.reference, "QuestionnaireResponse/qr1");
      });
    }
  }
});

test("v0.4b dry-eye treatment inventory supports every treatment code and Procedure status", async (t) => {
  for (const treatmentType of DRY_EYE_TREATMENT_TYPE_CODES) {
    for (const status of DRY_EYE_PROCEDURE_STATUS_CODES) {
      await t.test(`${treatmentType} ${status}`, () => {
        const procedure = buildDryEyeTreatmentProcedure({
          patientReference: "Patient/p1",
          treatmentType,
          status,
          treatmentDeviceReference: "Device/device1",
        });
        assert.equal(procedure.resourceType, "Procedure");
        assert.equal(procedure.status, status);
        assert.equal(procedure.code?.coding?.[0]?.code, treatmentType);
        assert.equal(procedure.usedReference?.[0]?.reference, "Device/device1");
      });
    }
  }
});

test("v0.4b dry-eye treatment inventory binds energy and wavelength to UCUM", async (t) => {
  const energies = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26];
  for (const treatmentType of DRY_EYE_TREATMENT_TYPE_CODES) {
    for (const energyMj of energies) {
      await t.test(`${treatmentType} ${energyMj}mJ`, () => {
        const procedure = buildDryEyeTreatmentProcedure({
          patientReference: "Patient/p1",
          treatmentType,
          parameters: { energyMj, wavelengthNm: 590, spotCount: 40 },
        });
        const quantities = (procedure.extension ?? []).flatMap((extension) =>
          extension.valueQuantity ? [extension.valueQuantity] : [],
        );
        assert.ok(quantities.some((quantity) => quantity.system === "http://unitsofmeasure.org" && quantity.code === "mJ"));
        assert.ok(quantities.some((quantity) => quantity.system === "http://unitsofmeasure.org" && quantity.code === "nm"));
      });
    }
  }
});

test("v0.4b dry-eye medication inventory supports expected products and FHIR statuses", async (t) => {
  const products = [
    ["Artificial tears", "otc"],
    ["Restasis", "rx"],
    ["Cequa", "rx"],
    ["Xiidra", "rx"],
    ["Doxycycline", "rx"],
    ["Omega-3", "supplement"],
  ] as const;
  for (const [product, supplyType] of products) {
    for (const status of OPHTHALMIC_MEDICATION_STATUS_CODES) {
      await t.test(`${product} ${status}`, () => {
        const statement = buildOphthalmicMedicationStatement({
          patientReference: "Patient/p1",
          medication: { text: product },
          status,
          supplyType,
          dateAsserted: "2026-04-28T12:00:00.000Z",
        });
        assert.equal(statement.resourceType, "MedicationStatement");
        assert.equal(statement.status, status);
        assert.equal(statement.medicationCodeableConcept?.text, product);
        assert.equal(statement.extension?.[0]?.valueCode, supplyType);
      });
    }
  }
});

test("v0.4b meibography inventory covers Meiboscore and Arita per-lid ranges", async (t) => {
  const eyes = ["OD", "OS", "OU"] as const;
  const lids = ["upper", "lower"] as const;
  for (const eye of eyes) {
    for (const lid of lids) {
      for (let totalScore = 0; totalScore <= 9; totalScore += 1) {
        await t.test(`meiboscore ${eye} ${lid} ${totalScore}`, () => {
          const observation = buildMeibographyObservation({
            patientReference: "Patient/p1",
            documentReference: "DocumentReference/img1",
            eye,
            lid,
            scoringSystem: "meiboscore",
            totalScore,
          });
          assert.equal(observation.valueInteger, totalScore);
          assert.equal(observation.derivedFrom?.[0]?.reference, "DocumentReference/img1");
        });
      }
      for (let totalScore = 0; totalScore <= 15; totalScore += 1) {
        await t.test(`arita ${eye} ${lid} ${totalScore}`, () => {
          const observation = buildMeibographyObservation({
            patientReference: "Patient/p1",
            documentReference: "DocumentReference/img1",
            eye,
            lid,
            scoringSystem: "arita",
            totalScore,
          });
          assert.equal(observation.valueInteger, totalScore);
          assert.equal(observation.derivedFrom?.[0]?.reference, "DocumentReference/img1");
        });
      }
    }
  }
});

test("v0.4b dry-eye adverse event inventory captures common forward-compatible events", async (t) => {
  for (const eventText of [
    "Corneal edema",
    "Hypoxia-related neovascularization",
    "Contact-lens-induced microbial keratitis",
    "Photophobia after IPL",
    "Lid irritation",
    "Medication intolerance",
    "Allergic conjunctivitis",
    "Ocular surface inflammation flare",
  ]) {
    await t.test(eventText, () => {
      const adverseEvent = buildDryEyeAdverseEvent({
        patientReference: "Patient/p1",
        event: { text: eventText },
        recordedDate: "2026-04-28T12:00:00.000Z",
      });
      assert.equal(adverseEvent.resourceType, "AdverseEvent");
      assert.equal(adverseEvent.event?.text, eventText);
      assert.equal(adverseEvent.subject.reference, "Patient/p1");
    });
  }
});
