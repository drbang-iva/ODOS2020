import type {
  Observation,
  QuestionnaireResponse,
} from "@medplum/fhirtypes";
import { ODOS_FHIR_BASE } from "./contactLens.js";
import {
  type DryEyeQuestionnaireInstrument,
  DRY_EYE_QUESTIONNAIRE_INSTRUMENTS,
  dryEyeQuestionnaireInstrumentConcept,
  dryEyeQuestionnaireSummaryConcept,
  questionnaireReferenceForInstrument,
} from "./dryEyeTerminology.js";
import { reference } from "./ophthalmology/extensions.js";

export interface DryEyeQuestionnaireResponseInput {
  instrument: DryEyeQuestionnaireInstrument;
  patientReference: string;
  encounterReference?: string;
  authored?: string;
  authorReference?: string;
  sourceReference?: string;
  totalScore: number;
}

export interface DryEyeQuestionnaireScoreObservationInput {
  instrument: DryEyeQuestionnaireInstrument;
  patientReference: string;
  questionnaireResponseReference: string;
  encounterReference?: string;
  effectiveDateTime?: string;
  score: number;
}

export function buildDryEyeQuestionnaireResponse(
  input: DryEyeQuestionnaireResponseInput,
): QuestionnaireResponse {
  assertDryEyeQuestionnaireInstrument(input.instrument);
  assertDryEyeQuestionnaireScore(input.totalScore);

  const authored = input.authored ?? new Date().toISOString();
  return {
    resourceType: "QuestionnaireResponse",
    questionnaire: questionnaireReferenceForInstrument(input.instrument),
    status: "completed",
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    authored,
    ...(input.authorReference ? { author: reference(input.authorReference) } : {}),
    ...(input.sourceReference ? { source: reference(input.sourceReference) } : {}),
    item: [{
      linkId: "total-score",
      text: "Total score",
      answer: [{ valueDecimal: input.totalScore }],
    }],
  };
}

export function buildDryEyeQuestionnaireScoreObservation(
  input: DryEyeQuestionnaireScoreObservationInput,
): Observation {
  assertDryEyeQuestionnaireInstrument(input.instrument);
  assertDryEyeQuestionnaireScore(input.score);
  const effectiveDateTime = input.effectiveDateTime ?? new Date().toISOString();

  return {
    resourceType: "Observation",
    meta: {
      profile: [`${ODOS_FHIR_BASE}/StructureDefinition/Observation-DryEyeQuestionnaireScore`],
    },
    status: "preliminary",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "survey",
            display: "Survey",
          },
        ],
        text: "Survey",
      },
    ],
    code: dryEyeQuestionnaireSummaryConcept(input.instrument),
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    effectiveDateTime,
    valueQuantity: {
      value: input.score,
      unit: "score",
    },
    derivedFrom: [reference(input.questionnaireResponseReference)],
    method: dryEyeQuestionnaireInstrumentConcept(input.instrument),
  };
}

function assertDryEyeQuestionnaireInstrument(
  value: string,
): asserts value is DryEyeQuestionnaireInstrument {
  if (!DRY_EYE_QUESTIONNAIRE_INSTRUMENTS.includes(value as DryEyeQuestionnaireInstrument)) {
    throw new Error(
      `Unsupported dry-eye questionnaire "${value}". Expected one of: ${DRY_EYE_QUESTIONNAIRE_INSTRUMENTS.join(", ")}.`,
    );
  }
}

function assertDryEyeQuestionnaireScore(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Dry-eye questionnaire score must be a finite number of zero or more.");
  }
}
