export type ChartSectionId = "va" | "iop" | "refraction";

export interface SectionSaveStatus {
  completed: boolean;
  summary?: string;
  savedAt?: string;
  operator?: string;
}

export type SectionStatusMap = Record<ChartSectionId, SectionSaveStatus>;
