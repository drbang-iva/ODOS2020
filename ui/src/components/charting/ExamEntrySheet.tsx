import type { ReactNode } from "react";
import { useDockedPanel } from "../commercial/panel-shared";

export const EXAM_ENTRY_SHEET_CONFIG = {
  hpi: { title: "Chief Complaint / HPI / ROS", layout: "paired-row-form" },
  "manual-keratometry": { title: "Manual Keratometry", layout: "paired-measurement" },
  pachymetry: { title: "Pachymetry", layout: "paired-measurement" },
  // Visual Acuity has row fields but commits OD and OS together. Individual row saves are deferred.
  va: { title: "Visual Acuity", layout: "paired-row-form" },
  pupils: { title: "Pupils", layout: "laterality-finding" },
  stereopsis: { title: "Stereopsis", layout: "laterality-finding" },
  "color-vision": { title: "Color Vision", layout: "laterality-finding" },
  eom: { title: "EOM / Diplopia", layout: "quadrant-grid" },
  cvf: { title: "Visual Field", layout: "quadrant-grid" },
  "cover-test": { title: "Cover Test", layout: "paired-row-form" },
  iop: { title: "Intraocular Pressure", layout: "paired-measurement" },
  dilation: { title: "Dilation", layout: "paired-row-form" },
  "ortho-k": { title: "Ortho-K", layout: "paired-row-form" },
  "myopia-management": { title: "Myopia Management", layout: "paired-row-form" },
  "cup-disc": { title: "Cup/Disc", layout: "paired-measurement" },
  gonioscopy: { title: "Gonioscopy", layout: "quadrant-grid" },
  "dry-eye": { title: "Dry Eye", layout: "paired-row-form" },
  imaging: { title: "Manual imaging", layout: "paired-row-form" },
  assessment: { title: "Assessment", layout: "paired-row-form" },
  prescription: { title: "Plan · Prescriptions", layout: "paired-row-form" },
} as const;

// Refraction stays full-page until its 1320px editor has a stacked composition. It records OD/OS acuity only; OU acuity is deferred.
// Eye Growth stays full-page because its imported axial-growth chart creates a 1550px sheet composition.

export type ExamEntrySheetSectionId = keyof typeof EXAM_ENTRY_SHEET_CONFIG;

export function isExamEntrySheetSectionId(sectionId: string): sectionId is ExamEntrySheetSectionId {
  return sectionId in EXAM_ENTRY_SHEET_CONFIG;
}

export function ExamEntrySheet({ sectionId, onCancel, active = true, children }: {
  sectionId: ExamEntrySheetSectionId;
  onCancel: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  const { dialogRef, initialFocusRef, titleId } = useDockedPanel(onCancel, active);
  const config = EXAM_ENTRY_SHEET_CONFIG[sectionId];
  return (
    <div className="odos-exam-entry-layer" data-testid="exam-entry-layer">
      <div
        className="odos-exam-entry-restore-bar"
        data-testid="exam-entry-restore-bar"
        data-entry-sheet-chrome
        aria-hidden="true"
      >
        <strong>Exam overview</strong>
        <span>Parked while editing {config.title}</span>
      </div>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="odos-exam-entry-sheet"
        data-testid="exam-entry-sheet"
        data-entry-sheet-layout={config.layout}
        data-entry-sheet-section={sectionId}
      >
        <header className="odos-exam-entry-sheet-heading">
          <div>
            <span>Entry sheet</span>
            <h2 id={titleId}>{config.title}</h2>
          </div>
          <button
            ref={initialFocusRef}
            type="button"
            aria-label={`Cancel ${config.title} entry`}
            data-testid="cancel-exam-entry-sheet"
            data-entry-sheet-chrome
            onClick={onCancel}
          >
            Cancel
          </button>
        </header>
        <div className="odos-exam-entry-sheet-content">{children}</div>
      </aside>
    </div>
  );
}
