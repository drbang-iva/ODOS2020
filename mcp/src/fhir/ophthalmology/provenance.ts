import type { ProvenanceInput } from "./types.js";
import { osodConcept, reference } from "./extensions.js";

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
          activity: osodConcept(
            input.activityCode ?? "OPHTHALMIC_DATA_CAPTURE",
            input.activityDisplay ?? "Ophthalmic data capture",
          ),
        }
      : {}),
    agent: input.agents.map((agent) => ({
      ...(agent.typeCode || agent.typeDisplay
        ? { type: osodConcept(agent.typeCode ?? "source-agent", agent.typeDisplay ?? "Source agent") }
        : {}),
      ...(agent.roleCode || agent.roleDisplay
        ? { role: [osodConcept(agent.roleCode ?? "author", agent.roleDisplay ?? "Author")] }
        : {}),
      who: agent.whoReference
        ? reference(agent.whoReference)
        : { display: agent.whoDisplay ?? "Unknown OSOD source agent" },
    })),
    ...(input.entityReferences?.length
      ? {
          entity: input.entityReferences.map((r) => ({
            role: "source" as const,
            what: reference(r),
          })),
        }
      : {}),
  };
}
