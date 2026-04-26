import type { CodeableConcept, EpisodeOfCare, Reference } from "@medplum/fhirtypes";

export const OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/episode-of-care-type";
export const OSOD_EPISODE_OF_CARE_TYPE_VALUE_SET =
  "https://osod.dev/fhir/ValueSet/episode-of-care-type";

export const EPISODE_OF_CARE_TYPE_CODES = [
  "myopia-management",
  "glaucoma",
  "dry-eye",
  "diabetic-eye-care",
] as const;

export const EPISODE_OF_CARE_STATUS_CODES = [
  "planned",
  "waitlist",
  "active",
  "onhold",
  "finished",
  "cancelled",
  "entered-in-error",
] as const;

export type EpisodeOfCareTypeCode = (typeof EPISODE_OF_CARE_TYPE_CODES)[number];
export type EpisodeOfCareStatusCode = (typeof EPISODE_OF_CARE_STATUS_CODES)[number];

const EPISODE_TYPE_DISPLAY: Record<EpisodeOfCareTypeCode, string> = {
  "myopia-management": "Myopia management",
  glaucoma: "Glaucoma",
  "dry-eye": "Dry eye",
  "diabetic-eye-care": "Diabetic eye care",
};

const EPISODE_TYPE_DEFINITION: Record<EpisodeOfCareTypeCode, string> = {
  "myopia-management":
    "Longitudinal optometric program for monitoring and treating progressive myopia.",
  glaucoma:
    "Longitudinal optometric program for glaucoma suspicion, diagnosis, monitoring, or treatment coordination.",
  "dry-eye":
    "Longitudinal optometric program for ocular surface disease and dry eye evaluation, treatment, and follow-up.",
  "diabetic-eye-care":
    "Longitudinal optometric program for diabetic retinal evaluation, monitoring, and care coordination.",
};

export interface EpisodeOfCareInput {
  typeCode: EpisodeOfCareTypeCode;
  status: EpisodeOfCareStatusCode;
  patientReference: string;
  managingOrganizationReference?: string;
  periodStart?: string;
  periodEnd?: string;
  conditionReferences?: string[];
}

export function buildEpisodeOfCare(input: EpisodeOfCareInput): EpisodeOfCare {
  assertEpisodeType(input.typeCode);

  return {
    resourceType: "EpisodeOfCare",
    status: input.status,
    type: [episodeOfCareTypeConcept(input.typeCode)],
    patient: reference(input.patientReference),
    ...(input.managingOrganizationReference
      ? { managingOrganization: reference(input.managingOrganizationReference) }
      : {}),
    ...(input.periodStart || input.periodEnd
      ? {
          period: {
            ...(input.periodStart ? { start: input.periodStart } : {}),
            ...(input.periodEnd ? { end: input.periodEnd } : {}),
          },
        }
      : {}),
    ...(input.conditionReferences?.length
      ? {
          diagnosis: input.conditionReferences.map((conditionReference) => ({
            condition: reference(conditionReference),
          })),
        }
      : {}),
  };
}

export function episodeOfCareTypeConcept(code: EpisodeOfCareTypeCode): CodeableConcept {
  assertEpisodeType(code);

  return {
    coding: [
      {
        system: OSOD_EPISODE_OF_CARE_TYPE_CODE_SYSTEM,
        code,
        display: EPISODE_TYPE_DISPLAY[code],
      },
    ],
    text: EPISODE_TYPE_DISPLAY[code],
  };
}

export function episodeOfCareTypeDefinition(code: EpisodeOfCareTypeCode): string {
  assertEpisodeType(code);
  return EPISODE_TYPE_DEFINITION[code];
}

export function assertEpisodeType(value: string): asserts value is EpisodeOfCareTypeCode {
  if (!EPISODE_OF_CARE_TYPE_CODES.includes(value as EpisodeOfCareTypeCode)) {
    throw new Error(
      `Unsupported EpisodeOfCare.type "${value}". Expected one of: ${EPISODE_OF_CARE_TYPE_CODES.join(", ")}.`,
    );
  }
}

function reference(value: string): Reference<never> {
  return { reference: value };
}
