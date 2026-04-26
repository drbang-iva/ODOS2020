import type { ProvenanceInput } from "./types.js";
import type { CodeableConcept } from "@medplum/fhirtypes";
import { reference } from "./extensions.js";

const V3_DATA_OPERATION_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-DataOperation";
const PROVENANCE_PARTICIPANT_TYPE_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/provenance-participant-type";

const PROVENANCE_PARTICIPANT_TYPES: Record<string, string> = {
  author: "Author",
  performer: "Performer",
  custodian: "Custodian",
  transmitter: "Transmitter",
};

export function buildProvenance(input: ProvenanceInput): import("./types.js").Provenance {
  if (input.targetReferences.length === 0) {
    throw new Error("Provenance requires at least one target resource.");
  }
  if (input.agents.length === 0) {
    throw new Error("Provenance requires at least one agent.");
  }

  const recorded = input.recorded ?? new Date().toISOString();

  return {
    resourceType: "Provenance",
    target: input.targetReferences.map((r) => reference(r)),
    recorded,
    ...(input.occurredDateTime ? { occurredDateTime: input.occurredDateTime } : {}),
    ...(input.activityCode || input.activityDisplay
      ? {
          activity: dataOperationConcept(
            input.activityCode ?? "CREATE",
            input.activityDisplay ?? "Create",
          ),
        }
      : {}),
    agent: input.agents.map((agent) => ({
      ...(agent.typeCode || agent.typeDisplay
        ? {
            type: provenanceParticipantConcept(
              normalizeParticipantType(agent.typeCode),
              agent.typeDisplay,
            ),
          }
        : {}),
      ...(agent.roleCode || agent.roleDisplay
        ? {
            role: [
              provenanceParticipantConcept(
                normalizeParticipantType(agent.roleCode),
                agent.roleDisplay,
              ),
            ],
          }
        : {}),
      who: agent.whoReference
        ? reference(agent.whoReference)
        : { display: agent.whoDisplay ?? "Unknown OSOD source agent" },
    })),
    ...(input.entityReferences?.length || input.entityValues?.length
      ? {
          entity: [
            ...(input.entityReferences ?? []).map((r) => ({
              role: "source" as const,
              what: reference(r),
            })),
            ...(input.entityValues ?? []).map((entity) => ({
              role: entity.role ?? ("revision" as const),
              what: { display: entity.display },
            })),
          ],
        }
      : {}),
  };
}

function dataOperationConcept(code: string, display?: string): CodeableConcept {
  const normalized = code.trim().toUpperCase();

  return {
    coding: [
      {
        system: V3_DATA_OPERATION_CODE_SYSTEM,
        code: normalized,
        display: display ?? normalized.charAt(0) + normalized.slice(1).toLowerCase(),
      },
    ],
    text: display ?? normalized,
  };
}

function provenanceParticipantConcept(code: string, display?: string): CodeableConcept {
  return {
    coding: [
      {
        system: PROVENANCE_PARTICIPANT_TYPE_CODE_SYSTEM,
        code,
        display: display ?? PROVENANCE_PARTICIPANT_TYPES[code] ?? code,
      },
    ],
    text: display ?? PROVENANCE_PARTICIPANT_TYPES[code] ?? code,
  };
}

function normalizeParticipantType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized && PROVENANCE_PARTICIPANT_TYPES[normalized]) {
    return normalized;
  }

  return "author";
}
