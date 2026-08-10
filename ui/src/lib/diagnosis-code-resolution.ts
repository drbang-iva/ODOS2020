import type { CodeableConcept, Condition } from "@medplum/fhirtypes";

export const ICD10_CM_CODE_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";
export const DIAGNOSIS_CATALOG_CODE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/diagnosis-catalog";
export const DIAGNOSIS_CATALOG_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/diagnosis-catalog-stable-key";

export interface DiagnosisCodeResolutionRow {
  stableKey: string;
  display: string;
  lateralityRequired?: boolean;
  bilateralResolution?: "emit-both-eyes";
  icd10?: { code: string; display?: string } | {
    pattern: { unspecifiedEye?: string; right?: string; left?: string; bilateral?: string };
  };
}

export function resolveDiagnosisCodes(
  row: DiagnosisCodeResolutionRow,
  laterality: "right" | "left" | "bilateral" | undefined,
): string[] {
  if (!row.icd10) return [];
  if ("code" in row.icd10) return [row.icd10.code];
  if (laterality === "bilateral" && row.bilateralResolution === "emit-both-eyes") {
    const { right, left } = row.icd10.pattern;
    return right && left ? [right, left] : [];
  }
  if (laterality) return codeArray(row.icd10.pattern[laterality]);
  return codeArray(row.icd10.pattern.unspecifiedEye);
}

export function conditionCodeForDiagnosisResolution(
  row: DiagnosisCodeResolutionRow,
  laterality: "OD" | "OS" | "OU",
): CodeableConcept | undefined {
  const codes = resolveDiagnosisCodes(row, laterality === "OD" ? "right" : laterality === "OS" ? "left" : "bilateral");
  if (codes.length === 1) {
    return {
      coding: [{ system: ICD10_CM_CODE_SYSTEM, code: codes[0], display: row.display }],
      text: row.display,
    };
  }
  if (codes.length > 1) {
    return {
      coding: [{ system: DIAGNOSIS_CATALOG_CODE_SYSTEM, code: row.stableKey, display: row.display }],
      text: row.display,
    };
  }
  return undefined;
}

export function conditionResolvedCodeLabel(
  condition: Condition,
  catalog: readonly DiagnosisCodeResolutionRow[],
): string {
  const stableKey = conditionCatalogStableKey(condition);
  const row = stableKey ? catalog.find((candidate) => candidate.stableKey === stableKey) : undefined;
  const usesCatalogConcept = condition.code?.coding?.some((coding) =>
    coding.system === DIAGNOSIS_CATALOG_CODE_SYSTEM
  );
  if (usesCatalogConcept) {
    const codes = row ? resolveDiagnosisCodes(row, conditionLaterality(condition)) : [];
    if (codes.length) return codes.join(" + ");
  }
  return condition.code?.coding
    ?.filter((coding) => coding.system === ICD10_CM_CODE_SYSTEM && coding.code)
    .map((coding) => coding.code)
    .join(" + ") || "Uncoded";
}

export function conditionCatalogStableKey(condition: Condition): string | undefined {
  const identifier = condition.identifier?.find((row) => row.system === DIAGNOSIS_CATALOG_IDENTIFIER_SYSTEM)?.value;
  if (identifier) {
    const parts = identifier.split("::");
    if (parts.length >= 2) return parts.at(-2);
  }
  return condition.code?.coding?.find((coding) => coding.system === DIAGNOSIS_CATALOG_CODE_SYSTEM)?.code;
}

function conditionLaterality(condition: Condition): "right" | "left" | "bilateral" | undefined {
  const value = condition.bodySite?.[0]?.text ?? condition.identifier?.find((row) =>
    row.system === DIAGNOSIS_CATALOG_IDENTIFIER_SYSTEM
  )?.value?.split("::").at(-1);
  if (value === "OD" || value === "right") return "right";
  if (value === "OS" || value === "left") return "left";
  if (value === "OU" || value === "bilateral") return "bilateral";
  return undefined;
}

function codeArray(code: string | undefined): string[] {
  return code ? [code] : [];
}
