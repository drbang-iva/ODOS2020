export type ChartSectionId = "va" | "refraction" | "dry-eye" | "iop" | "assessment";

export interface SectionSaveStatus {
  completed: boolean;
  summary?: string;
  savedAt?: string;
  operator?: string;
}

export type SectionStatusMap = Record<ChartSectionId, SectionSaveStatus>;
