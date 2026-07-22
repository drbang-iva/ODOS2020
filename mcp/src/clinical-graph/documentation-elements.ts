import type { Observation, ObservationComponent } from "@medplum/fhirtypes";
import { odosConcept } from "../fhir/ophthalmology/extensions.js";
import type {
  ClinicalFindingDefinition,
  DocumentationElementValue,
} from "./glaucoma-suspect.js";

export const DOCUMENTATION_ELEMENT_VALUES = ["normal", "abnormal", "deferred", "absent"] as const;

export function withDocumentationElements(
  observation: Observation,
  definition: ClinicalFindingDefinition,
  value: DocumentationElementValue,
): Observation {
  const entries = (definition.documentationElements ?? []).filter((entry) => entry.active);
  if (entries.length === 0) return observation;
  const codes = new Set(entries.map((entry) => entry.code));
  const retained = (observation.component ?? []).filter((component) =>
    !component.code.coding?.some((coding) => coding.code && codes.has(coding.code))
  );
  const additions: ObservationComponent[] = entries.map((entry) => ({
    code: odosConcept(entry.code, entry.code),
    valueCodeableConcept: odosConcept(value, value),
  }));
  return { ...observation, component: [...retained, ...additions] };
}

export function documentationElementValue(
  observation: Observation,
  code: string,
): DocumentationElementValue | undefined {
  const value = observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  )?.valueCodeableConcept?.coding?.find((coding) =>
    DOCUMENTATION_ELEMENT_VALUES.includes(coding.code as DocumentationElementValue)
  )?.code;
  return value as DocumentationElementValue | undefined;
}
