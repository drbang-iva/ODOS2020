import type { Coverage } from "@medplum/fhirtypes";

export const COB_APPLICABILITY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-cob-applicability";

export const COB_APPLICABILITY_VALUES = [
  "unknown",
  "supported",
  "unsupported",
  "traditional-medicare",
  "capitated",
] as const;

export type CobApplicability = typeof COB_APPLICABILITY_VALUES[number];

export function coverageCobApplicability(coverage: Coverage): CobApplicability {
  const value = coverage.extension?.find(
    (extension) => extension.url === COB_APPLICABILITY_EXTENSION_URL,
  )?.valueCode;
  return COB_APPLICABILITY_VALUES.includes(value as CobApplicability)
    ? value as CobApplicability
    : "unknown";
}
