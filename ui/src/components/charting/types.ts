export type BuiltInSectionId =
  | "aesthetics-consent"
  | "hpi"
  | "wearing"
  | "auto-refraction"
  | "pupils"
  | "stereopsis"
  | "color-vision"
  | "eom"
  | "cvf"
  | "cover-test"
  | "pachymetry"
  | "manual-keratometry"
  | "dilation"
  | "va"
  | "refraction"
  | "soft-contact-lens"
  | "specialty-contact-lens"
  | "refraction-history"
  | "eye-growth"
  | "ortho-k"
  | "dry-eye"
  | "myopia-management"
  | "cup-disc"
  | "gonioscopy"
  | "imaging"
  | "iop"
  | "assessment"
  | "prescription";

export type ChartSectionId =
  | BuiltInSectionId
  | `custom:${string}`
  | `dry-eye:${string}`
  | `ocular-health:${string}`
  | `procedure:${string}`;

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
