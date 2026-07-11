import type { Observation } from "@medplum/fhirtypes";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";

export function observationMatchesFindingDefinition(
  observation: Observation,
  definition: ClinicalFindingDefinition,
): boolean {
  // System-aware matching is intentionally deferred to a cross-slice L1/L2/L3 hardening pass.
  const expected = new Set([
    definition.stableKey.toLowerCase(),
    ...(definition.fhirObservationCode?.coding ?? []).flatMap((coding) =>
      coding.code ? [coding.code.toLowerCase()] : []
    ),
  ]);
  return observation.code.coding?.some((coding) =>
    coding.code && expected.has(coding.code.toLowerCase())
  ) === true;
}

export function findingDefinitionForObservation(
  observation: Observation,
  definitions: readonly ClinicalFindingDefinition[],
): ClinicalFindingDefinition | undefined {
  return definitions.find((definition) => observationMatchesFindingDefinition(observation, definition));
}
