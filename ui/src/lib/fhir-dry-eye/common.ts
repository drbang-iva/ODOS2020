import type { CodeableConcept, Reference, Resource } from "@medplum/fhirtypes";

export type DryEyeLaterality = "OD" | "OS" | "OU";

const LATERALITY_DISPLAY: Record<DryEyeLaterality, string> = {
  OD: "Right eye",
  OS: "Left eye",
  OU: "Both eyes",
};

export function reference<T extends Resource = Resource>(value: string): Reference<T> {
  return { reference: value } as Reference<T>;
}

export function normalizeLaterality(value: string): DryEyeLaterality {
  const normalized = value.trim().toUpperCase();
  if (normalized === "OD" || normalized === "OS" || normalized === "OU") {
    return normalized;
  }
  throw new Error(`Unsupported eye laterality "${value}". Expected OD, OS, or OU.`);
}

export function lateralityConcept(value: DryEyeLaterality): CodeableConcept {
  return {
    coding: [
      {
        system: "https://osod.dev/fhir/CodeSystem/ophthalmology",
        code: value,
        display: LATERALITY_DISPLAY[value],
      },
    ],
    text: LATERALITY_DISPLAY[value],
  };
}
