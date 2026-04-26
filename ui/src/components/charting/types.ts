export type ChartSectionId = "va" | "iop" | "refraction" | "assessment";

export interface SectionSaveStatus {
  completed: boolean;
  summary?: string;
  savedAt?: string;
  operator?: string;
}

export type SectionStatusMap = Record<ChartSectionId, SectionSaveStatus>;
