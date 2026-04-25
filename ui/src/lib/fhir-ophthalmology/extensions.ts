// MIRROR of osod/mcp/src/fhir/ophthalmology/extensions.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type {
  CodeableConcept,
  Extension,
  Observation,
  ObservationComponent,
  Reference,
  Resource,
} from "./types.js";
import type { CommonObservationInput, EyeLaterality } from "./types.js";
import { dualCoding } from "./codeBindings.js";
import { attachBodyStructureToObservation, buildEyeBodyStructure } from "./bodyStructure.js";

export const OSOD_EXTENSION_URLS = {
  qualityScore: "https://osod.dev/fhir/StructureDefinition/quality-score",
  confidenceScore: "https://osod.dev/fhir/StructureDefinition/confidence-score",
  eyeLaterality: "https://osod.dev/fhir/StructureDefinition/eye-laterality",
  sourceSha256: "https://osod.dev/fhir/StructureDefinition/source-sha256",
} as const;

const LATERALITY_DISPLAY: Record<EyeLaterality, string> = {
  OD: "Right eye",
  OS: "Left eye",
  OU: "Both eyes",
  UNKNOWN: "Unknown eye laterality",
};

export function osodCoding(code: string, display?: string) {
  return dualCoding(code, display)[0];
}

export function osodConcept(code: string, display?: string): CodeableConcept {
  return {
    coding: dualCoding(code, display),
    text: display ?? code,
  };
}

export function reference<T extends Resource = Resource>(reference: string): Reference<T> {
  return { reference } as Reference<T>;
}

export function patientReference(patientId: string): string {
  return patientId.startsWith("Patient/") ? patientId : `Patient/${patientId}`;
}

export function encounterReference(encounterId: string): string {
  return encounterId.startsWith("Encounter/") ? encounterId : `Encounter/${encounterId}`;
}

export function normalizeLaterality(value: string): EyeLaterality {
  const normalized = value.trim().toUpperCase();
  if (normalized === "OD" || normalized === "OS" || normalized === "OU") {
    return normalized;
  }
  if (normalized === "UNKNOWN" || normalized === "UNK") {
    return "UNKNOWN";
  }
  throw new Error(`Unsupported eye laterality "${value}". Expected OD, OS, OU, or UNKNOWN.`);
}

export function lateralityConcept(eye: EyeLaterality): CodeableConcept {
  return osodConcept(eye, LATERALITY_DISPLAY[eye]);
}

export function lateralityExtension(eye: EyeLaterality): Extension {
  return {
    url: OSOD_EXTENSION_URLS.eyeLaterality,
    valueCodeableConcept: lateralityConcept(eye),
  };
}

export function decimalExtension(url: string, value: number): Extension {
  return { url, valueDecimal: value };
}

export function sourceSha256Extension(value: string): Extension {
  return { url: OSOD_EXTENSION_URLS.sourceSha256, valueString: value };
}

export function validateScore(name: string, value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number from 0 to 1.`);
  }
}

export function quantity(value: number, unit: string, system?: string, code?: string) {
  return {
    value,
    unit,
    ...(system ? { system } : {}),
    ...(code ? { code } : {}),
  };
}

export function component(code: string, display: string, value: Partial<ObservationComponent>) {
  return {
    code: osodConcept(code, display),
    ...value,
  } satisfies ObservationComponent;
}

export function applyCommonObservationFields(
  observation: Observation,
  input: CommonObservationInput,
): Observation {
  validateScore("qualityScore", input.qualityScore);
  validateScore("confidenceScore", input.confidenceScore);

  const extensions: Extension[] = [lateralityExtension(input.eye)];

  if (input.qualityScore !== undefined) {
    extensions.push(decimalExtension(OSOD_EXTENSION_URLS.qualityScore, input.qualityScore));
  }

  if (input.confidenceScore !== undefined) {
    extensions.push(decimalExtension(OSOD_EXTENSION_URLS.confidenceScore, input.confidenceScore));
  }

  const noteText = [input.sourceType && `sourceType=${input.sourceType}`, input.sourceLabel]
    .filter(Boolean)
    .join("; ");

  const observationWithCommonFields: Observation = {
    ...observation,
    subject: reference(input.patientReference),
    encounter: reference(input.encounterReference),
    category: [
      ...(observation.category ?? []),
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "exam",
            display: "Exam",
          },
        ],
      },
    ],
    effectiveDateTime: input.measuredAt,
    bodySite: lateralityConcept(input.eye),
    extension: [...(observation.extension ?? []), ...extensions],
    ...(input.method ? { method: input.method } : {}),
    ...(input.deviceReference ? { device: reference(input.deviceReference) } : {}),
    ...(input.performerReferences?.length
      ? { performer: input.performerReferences.map((r) => reference(r)) }
      : {}),
    ...(input.sourceReferences?.length
      ? { derivedFrom: input.sourceReferences.map((r) => reference(r)) }
      : {}),
    ...(input.interpretation ? { interpretation: input.interpretation } : {}),
    ...(input.referenceRange ? { referenceRange: input.referenceRange } : {}),
    ...(noteText ? { note: [{ text: noteText }] } : {}),
  };

  if (input.eye === "UNKNOWN") {
    return observationWithCommonFields;
  }

  return attachBodyStructureToObservation(
    observationWithCommonFields,
    buildEyeBodyStructure(input.eye, input.patientReference),
  );
}
