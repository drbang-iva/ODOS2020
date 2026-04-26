import type { CodeableConcept, Observation, Reference } from "@medplum/fhirtypes";

export const US_CORE_SMOKING_STATUS_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-smokingstatus";
export const LOINC_CODE_SYSTEM = "http://loinc.org";
export const SNOMED_CT_CODE_SYSTEM = "http://snomed.info/sct";
export const US_CORE_SMOKING_STATUS_VALUE_SET =
  "http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.11.20.9.38";
export const TOBACCO_SMOKING_STATUS_LOINC_CODE = "72166-2";

export const SMOKING_STATUS_CODES = [
  "449868002",
  "428041000124106",
  "8517006",
  "266919005",
  "77176002",
  "266927001",
  "428071000124103",
  "428061000124105",
] as const;

export type SmokingStatusCode = (typeof SMOKING_STATUS_CODES)[number];

const SMOKING_STATUS_DISPLAY: Record<SmokingStatusCode, string> = {
  "449868002": "Current every day smoker",
  "428041000124106": "Current some day smoker",
  "8517006": "Former smoker",
  "266919005": "Never smoker",
  "77176002": "Smoker, current status unknown",
  "266927001": "Unknown if ever smoked",
  "428071000124103": "Current Heavy tobacco smoker",
  "428061000124105": "Current Light tobacco smoker",
};

export interface SmokingStatusObservationInput {
  patientReference: string;
  statusCode: SmokingStatusCode;
  effectiveDateTime: string;
  performerReferences?: string[];
}

export function buildSmokingStatusObservation(
  input: SmokingStatusObservationInput,
): Observation {
  assertSmokingStatusCode(input.statusCode);

  return {
    resourceType: "Observation",
    meta: { profile: [US_CORE_SMOKING_STATUS_PROFILE] },
    status: "final",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "social-history",
            display: "Social History",
          },
        ],
        text: "Social History",
      },
    ],
    code: {
      coding: [
        {
          system: LOINC_CODE_SYSTEM,
          code: TOBACCO_SMOKING_STATUS_LOINC_CODE,
          display: "Tobacco smoking status",
        },
      ],
      text: "Tobacco smoking status",
    },
    subject: reference(input.patientReference),
    effectiveDateTime: input.effectiveDateTime,
    valueCodeableConcept: smokingStatusAnswerConcept(input.statusCode),
    ...(input.performerReferences?.length
      ? { performer: input.performerReferences.map((performer) => reference(performer)) }
      : {}),
  };
}

export function smokingStatusAnswerConcept(code: SmokingStatusCode): CodeableConcept {
  assertSmokingStatusCode(code);
  return {
    coding: [
      {
        system: SNOMED_CT_CODE_SYSTEM,
        code,
        display: SMOKING_STATUS_DISPLAY[code],
      },
    ],
    text: SMOKING_STATUS_DISPLAY[code],
  };
}

export function assertSmokingStatusCode(value: string): asserts value is SmokingStatusCode {
  if (!SMOKING_STATUS_CODES.includes(value as SmokingStatusCode)) {
    throw new Error(
      `Unsupported US Core Smoking Status code "${value}". Expected one of: ${SMOKING_STATUS_CODES.join(", ")}.`,
    );
  }
}

function reference(value: string): Reference<never> {
  return { reference: value };
}
