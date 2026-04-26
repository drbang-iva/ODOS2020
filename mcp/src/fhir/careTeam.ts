import type { CareTeam, CodeableConcept, Reference } from "@medplum/fhirtypes";

export const US_CORE_CARE_TEAM_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-careteam";
export const US_CORE_PRACTITIONER_ROLE_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitionerrole";
export const US_CORE_PRACTITIONER_PROFILE =
  "http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner";

export const CARE_TEAM_STATUS_CODES = [
  "proposed",
  "active",
  "suspended",
  "inactive",
  "entered-in-error",
] as const;

export type CareTeamStatusCode = (typeof CARE_TEAM_STATUS_CODES)[number];

export interface CareTeamRoleInput {
  system?: string;
  code?: string;
  display?: string;
  text?: string;
}

export interface CareTeamParticipantInput {
  role: CareTeamRoleInput | CodeableConcept;
  practitionerRoleReference?: string;
  practitionerReference?: string;
  relatedPersonReference?: string;
}

export interface CareTeamInput {
  patientReference: string;
  status?: CareTeamStatusCode;
  name?: string;
  participant: CareTeamParticipantInput[];
}

export function buildCareTeam(input: CareTeamInput): CareTeam {
  if (input.participant.length === 0) {
    throw new Error("CareTeam requires at least one participant.");
  }

  return {
    resourceType: "CareTeam",
    meta: { profile: [US_CORE_CARE_TEAM_PROFILE] },
    status: input.status ?? "active",
    ...(input.name ? { name: input.name } : {}),
    subject: reference(input.patientReference),
    participant: input.participant.map((participant) => ({
      role: [careTeamRoleConcept(participant.role)],
      member: reference(preferredCareTeamMemberReference(participant)),
    })),
  };
}

export function preferredCareTeamMemberReference(input: CareTeamParticipantInput): string {
  if (input.practitionerRoleReference) {
    return input.practitionerRoleReference;
  }
  if (input.practitionerReference) {
    return input.practitionerReference;
  }
  if (input.relatedPersonReference) {
    return input.relatedPersonReference;
  }
  throw new Error("CareTeam participant requires practitionerRoleReference, practitionerReference, or relatedPersonReference.");
}

export function careTeamRoleConcept(input: CareTeamRoleInput | CodeableConcept): CodeableConcept {
  if (isCodeableConcept(input)) {
    return input;
  }

  const hasCoding = Boolean(input.system || input.code || input.display);
  return {
    ...(hasCoding
      ? {
          coding: [
            {
              ...(input.system ? { system: input.system } : {}),
              ...(input.code ? { code: input.code } : {}),
              ...(input.display ? { display: input.display } : {}),
            },
          ],
        }
      : {}),
    text: input.text ?? input.display ?? input.code ?? "Care team member",
  };
}

function isCodeableConcept(input: CareTeamRoleInput | CodeableConcept): input is CodeableConcept {
  return "coding" in input;
}

function reference(value: string): Reference<never> {
  return { reference: value };
}
