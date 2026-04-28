import type {
  Observation,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
} from "@medplum/fhirtypes";
import { reference } from "./common.js";
import {
  OSOD_FHIR_BASE,
  type DryEyeQuestionnaireInstrument,
  DRY_EYE_QUESTIONNAIRE_ITEM_COUNTS,
  dryEyeQuestionnaireInstrumentConcept,
  dryEyeQuestionnaireSummaryConcept,
  questionnaireUrlForInstrument,
} from "./terminology.js";

export interface DryEyeQuestionnaireAnswerInput {
  linkId: string;
  text?: string;
  valueInteger?: number;
  valueDecimal?: number;
  valueString?: string;
  valueBoolean?: boolean;
}

export function buildDryEyeQuestionnaireResponse(input: {
  instrument: DryEyeQuestionnaireInstrument;
  patientReference: string;
  encounterReference?: string;
  authored?: string;
  answers: DryEyeQuestionnaireAnswerInput[];
}): QuestionnaireResponse {
  return {
    resourceType: "QuestionnaireResponse",
    questionnaire: questionnaireUrlForInstrument(input.instrument),
    status: "completed",
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    authored: input.authored ?? new Date().toISOString(),
    item: input.answers.map(answerToResponseItem),
  };
}

export function buildDryEyeQuestionnaireScoreObservation(input: {
  instrument: DryEyeQuestionnaireInstrument;
  patientReference: string;
  questionnaireResponseReference: string;
  encounterReference?: string;
  effectiveDateTime?: string;
  score?: number;
  answers?: DryEyeQuestionnaireAnswerInput[];
}): Observation {
  return {
    resourceType: "Observation",
    meta: {
      profile: [`${OSOD_FHIR_BASE}/StructureDefinition/Observation-DryEyeQuestionnaireScore`],
    },
    status: "final",
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
    effectiveDateTime: input.effectiveDateTime ?? new Date().toISOString(),
    valueQuantity: {
      value: input.score ?? computeDryEyeQuestionnaireScore(input.instrument, input.answers ?? []),
      unit: "score",
    },
    derivedFrom: [reference(input.questionnaireResponseReference)],
    method: dryEyeQuestionnaireInstrumentConcept(input.instrument),
  };
}

export function computeDryEyeQuestionnaireScore(
  instrument: DryEyeQuestionnaireInstrument,
  answers: DryEyeQuestionnaireAnswerInput[],
): number {
  const numericValues = answers
    .map((answer) => answer.valueInteger ?? answer.valueDecimal)
    .filter((value): value is number => value !== undefined);
  if (numericValues.length === 0) {
    return 0;
  }
  const sum = numericValues.reduce((total, value) => total + value, 0);
  return Math.round((instrument === "OSDI" ? (sum * 25) / numericValues.length : sum) * 10) / 10;
}

export function defaultDryEyeQuestionnaireAnswers(
  instrument: DryEyeQuestionnaireInstrument,
  value = 0,
): DryEyeQuestionnaireAnswerInput[] {
  const count = DRY_EYE_QUESTIONNAIRE_ITEM_COUNTS[instrument];
  const prefix = instrument.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return Array.from({ length: count }, (_, index) => ({
    linkId: `${prefix}-${index + 1}`,
    text: `${instrument} item ${index + 1}`,
    valueInteger: value,
  }));
}

function answerToResponseItem(answer: DryEyeQuestionnaireAnswerInput): QuestionnaireResponseItem {
  return {
    linkId: answer.linkId,
    ...(answer.text ? { text: answer.text } : {}),
    answer: [answerValue(answer)],
  };
}

function answerValue(answer: DryEyeQuestionnaireAnswerInput): QuestionnaireResponseItemAnswer {
  if (answer.valueInteger !== undefined) return { valueInteger: answer.valueInteger };
  if (answer.valueDecimal !== undefined) return { valueDecimal: answer.valueDecimal };
  if (answer.valueBoolean !== undefined) return { valueBoolean: answer.valueBoolean };
  if (answer.valueString !== undefined) return { valueString: answer.valueString };
  throw new Error(`Questionnaire answer ${answer.linkId} has no value.`);
}
