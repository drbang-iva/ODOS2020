import type { ReactNode } from "react";
import { useDockedPanel } from "../commercial/panel-shared";

export const EXAM_ENTRY_SHEET_CONFIG = {
  pupils: { title: "Pupils", layout: "laterality-finding" },
  iop: { title: "Intraocular Pressure", layout: "paired-measurement" },
  gonioscopy: { title: "Gonioscopy", layout: "quadrant-grid" },
  // Visual Acuity has row fields but commits OD and OS together. Individual row saves are deferred.
  va: { title: "Visual Acuity", layout: "paired-row-form" },
  // Refraction currently records acuity inside OD and OS blocks only. An independent OU acuity is deferred.
  refraction: { title: "Refraction", layout: "refraction-blocks" },
} as const;

export type ExamEntrySheetSectionId = keyof typeof EXAM_ENTRY_SHEET_CONFIG;

export function isExamEntrySheetSectionId(sectionId: string): sectionId is ExamEntrySheetSectionId {
  return sectionId in EXAM_ENTRY_SHEET_CONFIG;
}

export function ExamEntrySheet({ sectionId, onCancel, children }: {
  sectionId: ExamEntrySheetSectionId;
  onCancel: () => void;
  children: ReactNode;
}) {
  const { dialogRef, initialFocusRef, titleId } = useDockedPanel(onCancel);
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
