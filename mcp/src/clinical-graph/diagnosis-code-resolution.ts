import type { DiagnosisCatalogRow } from "./glaucoma-suspect.js";
import type { VisualFieldDescriptorResolution } from "./entrance-definition.js";

export function resolveConditionCodes(
  row: DiagnosisCatalogRow,
  laterality: "right" | "left" | "bilateral" | undefined,
  visualFieldDescriptor?: VisualFieldDescriptorResolution,
): string[] {
  if (!row.icd10) return [];
  if ("code" in row.icd10) return [row.icd10.code];
  if (
    visualFieldDescriptor?.codeSelection?.kind === "field" &&
    row.stableKey === "vf_homonymous_bilateral"
  ) {
    return codeArray(row.icd10.pattern[visualFieldDescriptor.codeSelection.slot]);
  }
  if (
    visualFieldDescriptor?.codeSelection?.kind === "eye" &&
    row.clinicalFamily === "visual-field-defect" &&
    row.lateralityRequired
  ) {
    return codeArray(row.icd10.pattern[visualFieldDescriptor.codeSelection.slot]);
  }
  if (!row.lateralityRequired) return codeArray(row.icd10.pattern.unspecifiedEye);
  if (laterality === "bilateral" && row.bilateralResolution === "emit-both-eyes") {
    const { right, left } = row.icd10.pattern;
    return right && left ? [right, left] : [];
  }
  if (laterality) return codeArray(row.icd10.pattern[laterality]);
  return codeArray(row.icd10.pattern.unspecifiedEye);
}

function codeArray(code: string | undefined): string[] {
  return code ? [code] : [];
}
