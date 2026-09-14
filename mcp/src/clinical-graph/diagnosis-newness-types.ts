export type DiagnosisNewness = "new" | "established";

export interface DiagnosisNewnessOverride {
  conditionReference: string;
  encounterId: string;
  value: DiagnosisNewness;
  setBy: string;
  setAt: string;
}

export type DiagnosisNewnessRow = {
  conditionReference: string;
  matchedBy?: "catalog-key" | "icd10-category";
  matchedEncounterReference?: string;
} & ({ value: DiagnosisNewness; source: "suggestion" | "doctor" } | { value?: never; source: "unavailable" });

export interface DiagnosisNewnessStore {
  listNewnessOverrides(encounterId: string): Promise<DiagnosisNewnessOverride[]>;
  upsertNewnessOverride(input: Omit<DiagnosisNewnessOverride, "setAt"> & { at: string }): Promise<DiagnosisNewnessOverride>;
}
