// MIRROR of osod/mcp/src/fhir/ophthalmology/codeBindings.ts. Source of truth lives in MCP. Sync manually until v0.5 monorepo refactor. Parity guarded by mcp/tests/builder-mirror-parity.test.ts.
import type { Coding } from "@medplum/fhirtypes";

export const OPHTHALMOLOGY_CODE_BINDING_VERSION = "0.3.0";
export const OSOD_OPHTHALMOLOGY_CODE_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/ophthalmology";
export const SNOMED_CT_CODE_SYSTEM = "http://snomed.info/sct";

export const OPHTHALMOLOGY_CONCEPT_IDS = [
  "VISUAL_ACUITY",
  "VA_SNELLEN_RAW",
  "VA_LOGMAR",
  "VA_LETTER_SCORE",
  "VA_CHART_TYPE",
  "VA_CORRECTION",
  "VA_DISTANCE",
  "INTRAOCULAR_PRESSURE",
  "REFRACTION",
  "REFRACTION_TYPE",
  "SPHERE",
  "CYLINDER",
  "AXIS",
  "ADD",
  "PRISM",
  "OPHTHALMIC_RAW_ASSET",
  "OPHTHALMIC_SOURCE_DOCUMENT",
  "VISUAL_ACUITY_PANEL",
  "REFRACTION_PANEL",
  "OPHTHALMIC_DATA_CAPTURE",
] as const;

export type OphthalmologyConceptId = (typeof OPHTHALMOLOGY_CONCEPT_IDS)[number];

export const OSOD_TO_SNOMED: Partial<
  Record<OphthalmologyConceptId, { code: string; display: string }>
> = {
  INTRAOCULAR_PRESSURE: {
    code: "41633001",
    display: "Intraocular pressure",
  },
  REFRACTION: {
    code: "251794006",
    display: "Refraction",
  },
  SPHERE: {
    code: "251795007",
    display: "Sphere",
  },
  CYLINDER: {
    code: "251797004",
    display: "Cylinder",
  },
  AXIS: {
    code: "251799001",
    display: "Axis",
  },
};

export function isOphthalmologyConceptId(value: string): boolean {
  return OPHTHALMOLOGY_CONCEPT_IDS.includes(
    value as (typeof OPHTHALMOLOGY_CONCEPT_IDS)[number],
  );
}

export function dualCoding(
  osodCode: string,
  display?: string,
  snomedOverride?: { code: string; display: string },
): Coding[] {
  const coding: Coding[] = [
    {
      system: OSOD_OPHTHALMOLOGY_CODE_SYSTEM,
      code: osodCode,
      display: display ?? osodCode,
    },
  ];
  const snomed = snomedOverride ?? OSOD_TO_SNOMED[osodCode as OphthalmologyConceptId];

  if (snomed) {
    coding.push({
      system: SNOMED_CT_CODE_SYSTEM,
      code: snomed.code,
      display: snomed.display,
    });
  }

  return coding;
}
