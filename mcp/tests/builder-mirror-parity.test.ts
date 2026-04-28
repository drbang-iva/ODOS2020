import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEyeBodyStructure as buildMcpEyeBodyStructure } from "../src/fhir/ophthalmology/bodyStructure.js";
import { buildIopObservation as buildMcpIopObservation } from "../src/fhir/ophthalmology/iop.js";
import { buildRefractionObservation as buildMcpRefractionObservation } from "../src/fhir/ophthalmology/refraction.js";
import { buildSectionSaveBundle as buildMcpSectionSaveBundle } from "../src/fhir/ophthalmology/save-section-bundle.js";
import { buildVisualAcuityObservation as buildMcpVisualAcuityObservation } from "../src/fhir/ophthalmology/visualAcuity.js";
import { buildEyeBodyStructure as buildUiEyeBodyStructure } from "../../ui/src/lib/fhir-ophthalmology/bodyStructure.js";
import { buildIopObservation as buildUiIopObservation } from "../../ui/src/lib/fhir-ophthalmology/iop.js";
import { buildRefractionObservation as buildUiRefractionObservation } from "../../ui/src/lib/fhir-ophthalmology/refraction.js";
import { buildSectionSaveBundle as buildUiSectionSaveBundle } from "../../ui/src/lib/fhir-ophthalmology/save-section-bundle.js";
import { buildVisualAcuityObservation as buildUiVisualAcuityObservation } from "../../ui/src/lib/fhir-ophthalmology/visualAcuity.js";
import { osodConcept as mcpOsodConcept } from "../src/fhir/ophthalmology/extensions.js";
import { osodConcept as uiOsodConcept } from "../../ui/src/lib/fhir-ophthalmology/extensions.js";
import { buildEpisodeOfCare as buildMcpEpisodeOfCare } from "../src/fhir/episodeOfCare.js";
import { buildEpisodeOfCare as buildUiEpisodeOfCare } from "../../ui/src/lib/fhir-clinical/episodeOfCare.js";
import {
  buildEncounterDiagnosisComponent as buildMcpEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition as buildMcpEncounterDiagnosisCondition,
  buildProblemListCondition as buildMcpProblemListCondition,
} from "../src/fhir/condition.js";
import {
  buildEncounterDiagnosisComponent as buildUiEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition as buildUiEncounterDiagnosisCondition,
  buildProblemListCondition as buildUiProblemListCondition,
} from "../../ui/src/lib/fhir-clinical/condition.js";
import { buildAllergyIntolerance as buildMcpAllergyIntolerance } from "../src/fhir/allergyIntolerance.js";
import { buildAllergyIntolerance as buildUiAllergyIntolerance } from "../../ui/src/lib/fhir-clinical/allergyIntolerance.js";
import { buildSmokingStatusObservation as buildMcpSmokingStatusObservation } from "../src/fhir/smokingStatus.js";
import { buildSmokingStatusObservation as buildUiSmokingStatusObservation } from "../../ui/src/lib/fhir-clinical/smokingStatus.js";
import { buildCareTeam as buildMcpCareTeam } from "../src/fhir/careTeam.js";
import { buildCareTeam as buildUiCareTeam } from "../../ui/src/lib/fhir-clinical/careTeam.js";
import { buildProcedure as buildMcpProcedure } from "../src/fhir/procedure.js";
import { buildProcedure as buildUiProcedure } from "../../ui/src/lib/fhir-clinical/procedure.js";
import {
  buildDryEyeQuestionnaireResponse as buildMcpDryEyeQuestionnaireResponse,
  buildDryEyeQuestionnaireScoreObservation as buildMcpDryEyeQuestionnaireScoreObservation,
  defaultDryEyeQuestionnaireAnswers as defaultMcpDryEyeQuestionnaireAnswers,
} from "../src/fhir/dryEyeQuestionnaireResponse.js";
import {
  buildDryEyeQuestionnaireResponse as buildUiDryEyeQuestionnaireResponse,
  buildDryEyeQuestionnaireScoreObservation as buildUiDryEyeQuestionnaireScoreObservation,
  defaultDryEyeQuestionnaireAnswers as defaultUiDryEyeQuestionnaireAnswers,
} from "../../ui/src/lib/fhir-dry-eye/questionnaireResponse.js";
import { buildMeibographyObservation as buildMcpMeibographyObservation } from "../src/fhir/meibography.js";
import { buildMeibographyObservation as buildUiMeibographyObservation } from "../../ui/src/lib/fhir-dry-eye/meibography.js";
import { buildDryEyeTreatmentProcedure as buildMcpDryEyeTreatmentProcedure } from "../src/fhir/dryEyeProcedure.js";
import { buildDryEyeTreatmentProcedure as buildUiDryEyeTreatmentProcedure } from "../../ui/src/lib/fhir-dry-eye/procedure.js";
import { buildOphthalmicMedicationStatement as buildMcpOphthalmicMedicationStatement } from "../src/fhir/ophthalmicMedicationStatement.js";
import { buildOphthalmicMedicationStatement as buildUiOphthalmicMedicationStatement } from "../../ui/src/lib/fhir-dry-eye/ophthalmicMedicationStatement.js";
import { buildDryEyeAdverseEvent as buildMcpDryEyeAdverseEvent } from "../src/fhir/dryEyeAdverseEvent.js";
import { buildDryEyeAdverseEvent as buildUiDryEyeAdverseEvent } from "../../ui/src/lib/fhir-dry-eye/adverseEvent.js";
import {
  buildOrthoKFitObservation as buildMcpOrthoKFitObservation,
  buildOrthoKFittingEvent as buildMcpOrthoKFittingEvent,
  buildOrthoKLensDevice as buildMcpOrthoKLensDevice,
} from "../src/fhir/orthoK.js";
import {
  buildOrthoKFitObservation as buildUiOrthoKFitObservation,
  buildOrthoKFittingEvent as buildUiOrthoKFittingEvent,
  buildOrthoKLensDevice as buildUiOrthoKLensDevice,
} from "../../ui/src/lib/fhir-v04c/orthoK.js";
import {
  buildAtropineMedicationStatement as buildMcpAtropineMedicationStatement,
  buildMyopiaManagementCarePlan as buildMcpMyopiaManagementCarePlan,
} from "../src/fhir/myopiaManagement.js";
import {
  buildAtropineMedicationStatement as buildUiAtropineMedicationStatement,
  buildMyopiaManagementCarePlan as buildUiMyopiaManagementCarePlan,
} from "../../ui/src/lib/fhir-v04c/myopiaManagement.js";

const common = {
  patientReference: "Patient/p1",
  encounterReference: "Encounter/e1",
  eye: "OD" as const,
  measuredAt: "2026-04-25T12:00:00.000Z",
};

test("UI ophthalmology mirror matches MCP IOP builder output", () => {
  assertJsonEqual(
    buildMcpIopObservation({
      ...common,
      value: 14,
      method: mcpOsodConcept("GAT", "GAT"),
    }),
    buildUiIopObservation({
      ...common,
      value: 14,
      method: uiOsodConcept("GAT", "GAT"),
    }),
  );
});

test("UI ophthalmology mirror matches MCP refraction builder output", () => {
  assertJsonEqual(
    buildMcpRefractionObservation({
      ...common,
      refractionType: "MANIFEST",
      sphere: -1.25,
      cylinder: -0.5,
      axis: 90,
      add: 2,
    }),
    buildUiRefractionObservation({
      ...common,
      refractionType: "MANIFEST",
      sphere: -1.25,
      cylinder: -0.5,
      axis: 90,
      add: 2,
    }),
  );
});

test("UI ophthalmology mirror matches MCP visual acuity builder output", () => {
  assertJsonEqual(
    buildMcpVisualAcuityObservation({
      ...common,
      snellen: "20/25",
      chartType: "SNELLEN",
      correction: "SC",
    }),
    buildUiVisualAcuityObservation({
      ...common,
      snellen: "20/25",
      chartType: "SNELLEN",
      correction: "SC",
    }),
  );
});

test("UI ophthalmology mirror matches MCP BodyStructure builder output", () => {
  assertJsonEqual(
    buildMcpEyeBodyStructure("OS", "Patient/p1"),
    buildUiEyeBodyStructure("OS", "Patient/p1"),
  );
});

test("UI ophthalmology mirror matches MCP section-save composer output", () => {
  const input = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    section: "iop" as const,
    operatorDisplay: "OSOD parity test",
    measuredAt: "2026-04-25T12:00:00.000Z",
    recordedAt: "2026-04-25T12:00:00.001Z",
    entries: [
      { laterality: "OD" as const, value: 14, method: "GAT" as const },
      { laterality: "OS" as const, value: 15, method: "GAT" as const },
    ],
  };

  assertJsonEqual(
    buildMcpSectionSaveBundle(input),
    buildUiSectionSaveBundle(input),
  );
});

test("UI clinical mirror matches MCP EpisodeOfCare builder output", () => {
  const input = {
    patientReference: "Patient/p1",
    typeCode: "dry-eye" as const,
    status: "active" as const,
    managingOrganizationReference: "Organization/o1",
    periodStart: "2026-04-25T12:00:00.000Z",
    conditionReferences: ["Condition/c1"],
  };

  assertJsonEqual(buildMcpEpisodeOfCare(input), buildUiEpisodeOfCare(input));
});

test("UI clinical mirror matches MCP encounter-diagnosis Condition builder output", () => {
  const input = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    code: { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "H52.13" },
    bodyStructureReference: "BodyStructure/b1",
  };

  assertJsonEqual(
    buildMcpEncounterDiagnosisCondition(input),
    buildUiEncounterDiagnosisCondition(input),
  );
});

test("UI clinical mirror matches MCP problem-list Condition builder output", () => {
  const input = {
    patientReference: "Patient/p1",
    code: { system: "http://snomed.info/sct", code: "73211009" },
    clinicalStatus: "active" as const,
  };

  assertJsonEqual(buildMcpProblemListCondition(input), buildUiProblemListCondition(input));
});

test("UI clinical mirror matches MCP Encounter.diagnosis component output", () => {
  assertJsonEqual(
    buildMcpEncounterDiagnosisComponent("Condition/c1", 1),
    buildUiEncounterDiagnosisComponent("Condition/c1", 1),
  );
});

test("UI clinical mirror matches MCP AllergyIntolerance builder output", () => {
  const input = {
    patientReference: "Patient/p1",
    noKnownAllergy: true,
  };

  assertJsonEqual(buildMcpAllergyIntolerance(input), buildUiAllergyIntolerance(input));
});

test("UI clinical mirror matches MCP Smoking Status builder output", () => {
  const input = {
    patientReference: "Patient/p1",
    statusCode: "266919005" as const,
    effectiveDateTime: "2026-04-25T12:00:00.000Z",
  };

  assertJsonEqual(
    buildMcpSmokingStatusObservation(input),
    buildUiSmokingStatusObservation(input),
  );
});

test("UI clinical mirror matches MCP CareTeam builder output", () => {
  const input = {
    patientReference: "Patient/p1",
    participant: [
      {
        role: { text: "Primary optometrist" },
        practitionerRoleReference: "PractitionerRole/pr1",
        practitionerReference: "Practitioner/pra1",
      },
    ],
  };

  assertJsonEqual(buildMcpCareTeam(input), buildUiCareTeam(input));
});

test("UI clinical mirror matches MCP Procedure builder output", () => {
  const input = {
    patientReference: "Patient/p1",
    status: "completed" as const,
    code: { system: "http://www.ama-assn.org/go/cpt", code: "92133" },
    bodyStructureReference: "BodyStructure/b1",
  };

  assertJsonEqual(buildMcpProcedure(input), buildUiProcedure(input));
});

test("UI dry-eye mirror matches MCP QuestionnaireResponse and score builders", () => {
  const answers = defaultMcpDryEyeQuestionnaireAnswers("DEQ-5", 1);
  assertJsonEqual(answers, defaultUiDryEyeQuestionnaireAnswers("DEQ-5", 1));
  const responseInput = {
    instrument: "DEQ-5" as const,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    authored: "2026-04-28T12:00:00.000Z",
    answers,
  };
  assertJsonEqual(
    buildMcpDryEyeQuestionnaireResponse(responseInput),
    buildUiDryEyeQuestionnaireResponse(responseInput),
  );
  const scoreInput = {
    instrument: "DEQ-5" as const,
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    questionnaireResponseReference: "QuestionnaireResponse/qr1",
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    answers,
  };
  assertJsonEqual(
    buildMcpDryEyeQuestionnaireScoreObservation(scoreInput),
    buildUiDryEyeQuestionnaireScoreObservation(scoreInput),
  );
});

test("UI dry-eye mirror matches MCP meibography builder", () => {
  const input = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    documentReference: "DocumentReference/img1",
    eye: "OS" as const,
    lid: "lower" as const,
    scoringSystem: "arita" as const,
    totalScore: 5,
    glandScores: [1, 1, 1, 1, 1],
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
  };
  assertJsonEqual(buildMcpMeibographyObservation(input), buildUiMeibographyObservation(input));
});

test("UI dry-eye mirror matches MCP treatment Procedure builder", () => {
  const input = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    treatmentType: "IPL" as const,
    seriesProcedureReference: "Procedure/series1",
    performedDateTime: "2026-04-28T12:00:00.000Z",
    treatmentDeviceReference: "Device/ipl1",
    sessionNumber: 1,
    totalSessions: 4,
    parameters: { energyMj: 14, wavelengthNm: 590, spotCount: 42 },
  };
  assertJsonEqual(buildMcpDryEyeTreatmentProcedure(input), buildUiDryEyeTreatmentProcedure(input));
});

test("UI dry-eye mirror matches MCP MedicationStatement and AdverseEvent builders", () => {
  const medicationInput = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    medication: { text: "Restasis" },
    supplyType: "rx" as const,
    indicationText: "Dry eye",
    dosageText: "One drop twice daily",
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    dateAsserted: "2026-04-28T12:00:00.000Z",
  };
  assertJsonEqual(
    buildMcpOphthalmicMedicationStatement(medicationInput),
    buildUiOphthalmicMedicationStatement(medicationInput),
  );
  const adverseEventInput = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    event: { text: "Corneal edema" },
    date: "2026-04-28T12:00:00.000Z",
    recordedDate: "2026-04-28T12:00:00.000Z",
    suspectEntityReferences: ["Procedure/ipl1"],
  };
  assertJsonEqual(
    buildMcpDryEyeAdverseEvent(adverseEventInput),
    buildUiDryEyeAdverseEvent(adverseEventInput),
  );
});

test("UI v0.4c Ortho-K mirror matches MCP lens, fitting, and fit finding builders", () => {
  const lensInput = {
    patientReference: "Patient/p1",
    deviceName: "Night lens OD",
    manufacturer: "Paragon",
    definitionReference: "DeviceDefinition/paragon-crt",
    properties: [
      { code: "base-curve-mm", valueNumber: 7.8, unitCode: "mm" as const },
      { code: "reverse-curve-depth-um", valueNumber: 550, unitCode: "um" as const },
      { code: "sphere-power", valueNumber: -2, unitCode: "[diop]" as const },
    ],
  };
  assertJsonEqual(buildMcpOrthoKLensDevice(lensInput), buildUiOrthoKLensDevice(lensInput));

  const procedureInput = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    lensDeviceReference: "Device/lens1",
    performedDateTime: "2026-04-28T12:00:00.000Z",
    noteText: "Initial fit",
  };
  assertJsonEqual(
    buildMcpOrthoKFittingEvent(procedureInput),
    buildUiOrthoKFittingEvent(procedureInput),
  );

  const observationInput = {
    patientReference: "Patient/p1",
    encounterReference: "Encounter/e1",
    lensDeviceReference: "Device/lens1",
    findingCode: "centration" as const,
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    valueCode: "well-centered",
    valueDisplay: "Well-centered",
  };
  assertJsonEqual(
    buildMcpOrthoKFitObservation(observationInput),
    buildUiOrthoKFitObservation(observationInput),
  );
});

test("UI v0.4c myopia mirror matches MCP CarePlan and atropine builders", () => {
  const carePlanInput = {
    patientReference: "Patient/p1",
    episodeOfCareReference: "EpisodeOfCare/mm1",
    encounterReference: "Encounter/e1",
    created: "2026-04-28T12:00:00.000Z",
    activities: [
      {
        interventionCode: "ortho-K" as const,
        status: "in-progress" as const,
        resourceReference: "Device/lens1",
        description: "Ortho-K intervention",
      },
      {
        interventionCode: "atropine-medium-dose" as const,
        status: "scheduled" as const,
        description: "Atropine pending",
      },
    ],
  };
  assertJsonEqual(
    buildMcpMyopiaManagementCarePlan(carePlanInput),
    buildUiMyopiaManagementCarePlan(carePlanInput),
  );

  const atropineInput = {
    patientReference: "Patient/p1",
    episodeOfCareReference: "EpisodeOfCare/mm1",
    concentration: "0.025%" as const,
    frequencyText: "1 drop OU qhs",
    effectiveDateTime: "2026-04-28T12:00:00.000Z",
    dateAsserted: "2026-04-28T12:00:00.000Z",
  };
  assertJsonEqual(
    buildMcpAtropineMedicationStatement(atropineInput),
    buildUiAtropineMedicationStatement(atropineInput),
  );
});

function assertJsonEqual(left: unknown, right: unknown): void {
  assert.equal(JSON.stringify(left), JSON.stringify(right));
}
