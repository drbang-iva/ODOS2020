export type BuiltInSectionId =
  | "wearing"
  | "auto-refraction"
  | "va"
  | "refraction"
  | "soft-contact-lens"
  | "specialty-contact-lens"
  | "refraction-history"
  | "ortho-k"
  | "dry-eye"
  | "myopia-management"
  | "cup-disc"
  | "iop"
  | "assessment"
  | "prescription";

export type ChartSectionId = BuiltInSectionId | `custom:${string}` | `ocular-health:${string}`;

export interface SectionSaveStatus {
  completed: boolean;
  summary?: string;
  savedAt?: string;
  operator?: string;
}

export type SectionStatusMap = Partial<Record<ChartSectionId, SectionSaveStatus>>;

const INCOMPLETE_STATUS: SectionSaveStatus = { completed: false };

export function sectionStatus(statuses: SectionStatusMap, id: ChartSectionId): SectionSaveStatus {
  return statuses[id] ?? INCOMPLETE_STATUS;
}
