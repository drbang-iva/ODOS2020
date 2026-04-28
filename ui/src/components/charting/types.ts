export type ChartSectionId =
  | "va"
  | "refraction"
  | "ortho-k"
  | "dry-eye"
  | "myopia-management"
  | "iop"
  | "assessment";

export interface SectionSaveStatus {
  completed: boolean;
  summary?: string;
  savedAt?: string;
  operator?: string;
}

export type SectionStatusMap = Record<ChartSectionId, SectionSaveStatus>;
