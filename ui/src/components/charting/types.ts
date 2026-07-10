export type ChartSectionId =
  | "wearing"
  | "auto-refraction"
  | "va"
  | "refraction"
  | "soft-contact-lens"
  | "specialty-contact-lens"
  | "ortho-k"
  | "dry-eye"
  | "myopia-management"
  | "cup-disc"
  | "iop"
  | "assessment";

export interface SectionSaveStatus {
  completed: boolean;
  summary?: string;
  savedAt?: string;
  operator?: string;
}

export type SectionStatusMap = Record<ChartSectionId, SectionSaveStatus>;
