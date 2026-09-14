export type DiagnosisNewness = "new" | "established";

export interface DiagnosisNewnessOverride {
  conditionReference: string;
  encounterId: string;
  value: DiagnosisNewness;
  setBy: string;
  setAt: string;
}

export interface DiagnosisNewnessRow {
  conditionReference: string;
  value: DiagnosisNewness;
  source: "suggestion" | "doctor";
  matchedBy?: "catalog-key" | "icd10-category";
  matchedEncounterReference?: string;
}

export interface DiagnosisNewnessStore {
  listNewnessOverrides(encounterId: string): Promise<DiagnosisNewnessOverride[]>;
  upsertNewnessOverride(input: Omit<DiagnosisNewnessOverride, "setAt"> & { at: string }): Promise<DiagnosisNewnessOverride>;
}
