import type {
  Observation,
  QuestionnaireResponse,
  QuestionnaireResponseItem,
  QuestionnaireResponseItemAnswer,
} from "@medplum/fhirtypes";
import { OSOD_FHIR_BASE } from "./contactLens.js";
import {
  type DryEyeQuestionnaireInstrument,
  DRY_EYE_QUESTIONNAIRE_INSTRUMENTS,
  DRY_EYE_QUESTIONNAIRE_ITEM_COUNTS,
  dryEyeQuestionnaireInstrumentConcept,
  dryEyeQuestionnaireSummaryConcept,
  questionnaireUrlForInstrument,
} from "./dryEyeTerminology.js";
import { reference } from "./ophthalmology/extensions.js";

export interface DryEyeQuestionnaireAnswerInput {
  linkId: string;
  text?: string;
  valueInteger?: number;
  valueDecimal?: number;
  valueString?: string;
  valueBoolean?: boolean;
}

export interface DryEyeQuestionnaireResponseInput {
  instrument: DryEyeQuestionnaireInstrument;
  patientReference: string;
  encounterReference?: string;
  authored?: string;
  authorReference?: string;
  sourceReference?: string;
  answers: DryEyeQuestionnaireAnswerInput[];
}

export interface DryEyeQuestionnaireScoreObservationInput {
  instrument: DryEyeQuestionnaireInstrument;
  patientReference: string;
  questionnaireResponseReference: string;
  encounterReference?: string;
  effectiveDateTime?: string;
  score?: number;
  answers?: DryEyeQuestionnaireAnswerInput[];
}

export function buildDryEyeQuestionnaireResponse(
  input: DryEyeQuestionnaireResponseInput,
): QuestionnaireResponse {
  assertDryEyeQuestionnaireInstrument(input.instrument);
  if (input.answers.length === 0) {
    throw new Error("Dry-eye QuestionnaireResponse requires at least one answer.");
  }

  const authored = input.authored ?? new Date().toISOString();
  return {
    resourceType: "QuestionnaireResponse",
    questionnaire: questionnaireUrlForInstrument(input.instrument),
    status: "completed",
    subject: reference(input.patientReference),
    ...(input.encounterReference ? { encounter: reference(input.encounterReference) } : {}),
    authored,
    ...(input.authorReference ? { author: reference(input.authorReference) } : {}),
    ...(input.sourceReference ? { source: reference(input.sourceReference) } : {}),
    item: input.answers.map(answerToResponseItem),
  };
}

export function buildDryEyeQuestionnaireScoreObservation(
  input: DryEyeQuestionnaireScoreObservationInput,
): Observation {
  assertDryEyeQuestionnaireInstrument(input.instrument);
  const score = input.score ?? computeDryEyeQuestionnaireScore(
    input.instrument,
    input.answers ?? [],
  );
  const effectiveDateTime = input.effectiveDateTime ?? new Date().toISOString();

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
    effectiveDateTime,
    valueQuantity: {
      value: score,
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
  assertDryEyeQuestionnaireInstrument(instrument);
  const numericValues = answers
    .map((answer) => answer.valueInteger ?? answer.valueDecimal)
    .filter((value): value is number => value !== undefined);
  if (numericValues.length === 0) {
    return 0;
  }
  const sum = numericValues.reduce((total, value) => total + value, 0);
  if (instrument === "OSDI") {
    return roundScore((sum * 25) / numericValues.length);
  }
  return roundScore(sum);
}

function answerToResponseItem(
  answer: DryEyeQuestionnaireAnswerInput,
): QuestionnaireResponseItem {
  return {
    linkId: answer.linkId,
    ...(answer.text ? { text: answer.text } : {}),
    answer: [answerValue(answer)],
  };
}

function answerValue(
  answer: DryEyeQuestionnaireAnswerInput,
): QuestionnaireResponseItemAnswer {
  if (answer.valueInteger !== undefined) {
    return { valueInteger: answer.valueInteger };
  }
  if (answer.valueDecimal !== undefined) {
    return { valueDecimal: answer.valueDecimal };
  }
  if (answer.valueBoolean !== undefined) {
    return { valueBoolean: answer.valueBoolean };
  }
  if (answer.valueString !== undefined) {
    return { valueString: answer.valueString };
  }
  throw new Error(`Questionnaire answer ${answer.linkId} has no value.`);
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

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

export function defaultDryEyeQuestionnaireAnswers(
  instrument: DryEyeQuestionnaireInstrument,
  value = 0,
): DryEyeQuestionnaireAnswerInput[] {
  assertDryEyeQuestionnaireInstrument(instrument);
  const count = DRY_EYE_QUESTIONNAIRE_ITEM_COUNTS[instrument];
  const prefix = instrument.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return Array.from({ length: count }, (_, index) => ({
    linkId: `${prefix}-${index + 1}`,
    text: `${instrument} item ${index + 1}`,
    valueInteger: value,
  }));
}
