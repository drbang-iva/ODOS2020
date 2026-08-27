import { useCallback, useEffect, useRef, type ReactNode } from "react";
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
export type ExamEntrySheetId = ExamEntrySheetSectionId | "visit-charges";

export function isExamEntrySheetSectionId(sectionId: string): sectionId is ExamEntrySheetSectionId {
  return sectionId in EXAM_ENTRY_SHEET_CONFIG;
}

export function useExamEntrySheetGuard(sectionId?: ExamEntrySheetSectionId) {
  const dirtyRef = useRef(false);
  const dirtyCheckpointRef = useRef<boolean>();
  const lastFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    dirtyRef.current = false;
    dirtyCheckpointRef.current = undefined;
    lastFocusRef.current = null;
  }, [sectionId]);

  const resetDirty = useCallback((keepCancelableEditorOpen = false) => {
    dirtyRef.current = false;
    dirtyCheckpointRef.current = keepCancelableEditorOpen ? false : undefined;
  }, []);
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);
  const checkpointDirty = useCallback(() => {
    dirtyCheckpointRef.current = dirtyRef.current;
  }, []);
  const restoreDirtyCheckpoint = useCallback(() => {
    if (dirtyCheckpointRef.current === undefined) return;
    dirtyRef.current = dirtyCheckpointRef.current;
    dirtyCheckpointRef.current = undefined;
  }, []);
  const clearDirtyCheckpoint = useCallback(() => {
    dirtyCheckpointRef.current = undefined;
  }, []);
  const rememberFocus = useCallback((element: HTMLElement) => {
    lastFocusRef.current = element;
  }, []);
  const requestTransition = useCallback((destinationTitle: string | undefined, transition: () => void) => {
    if (sectionId && dirtyRef.current) {
      const currentTitle = EXAM_ENTRY_SHEET_CONFIG[sectionId].title;
      const message = destinationTitle
        ? `Discard unsaved changes in ${currentTitle} and open ${destinationTitle}?`
        : `Discard unsaved changes in ${currentTitle}?`;
      if (typeof window === "undefined" || typeof window.confirm !== "function" || !window.confirm(message)) {
        lastFocusRef.current?.focus();
        return false;
      }
    }
    dirtyRef.current = false;
    dirtyCheckpointRef.current = undefined;
    transition();
    return true;
  }, [sectionId]);

  return {
    checkpointDirty,
    clearDirtyCheckpoint,
    markDirty,
    rememberFocus,
    requestTransition,
    resetDirty,
    restoreDirtyCheckpoint,
  };
}

export function ExamEntrySheet({
  sectionId,
  onCancel,
  onCheckpointDirty,
  onClearDirtyCheckpoint,
  onDirty,
  onFocusWithin,
  onRestoreDirtyCheckpoint,
  active = true,
  hidden = false,
  children,
}: {
  sectionId: ExamEntrySheetId;
  onCancel: () => void;
  onCheckpointDirty?: () => void;
  onClearDirtyCheckpoint?: () => void;
  onDirty?: () => void;
  onFocusWithin?: (element: HTMLElement) => void;
  onRestoreDirtyCheckpoint?: () => void;
  active?: boolean;
  hidden?: boolean;
  children: ReactNode;
}) {
  const modal = sectionId === "visit-charges";
  const { dialogRef, initialFocusRef, titleId } = useDockedPanel(onCancel, active, { modal });
  const config = sectionId === "visit-charges"
    ? { title: "Visit & charges", layout: "visit-charges" }
    : EXAM_ENTRY_SHEET_CONFIG[sectionId];
  return (
    <div className="odos-exam-entry-layer" data-testid="exam-entry-layer" hidden={hidden}>
      <div
        className="odos-exam-entry-restore-bar"
        data-testid="exam-entry-restore-bar"
        data-entry-sheet-chrome
        aria-hidden="true"
      >
        <strong>Exam overview</strong>
        <span>{sectionId === "visit-charges" ? "Chart remains visible behind this sheet" : `Parked while editing ${config.title}`}</span>
      </div>
      <aside
        id={sectionId === "visit-charges" ? "visit-charges-sheet" : undefined}
        ref={dialogRef}
        role="dialog"
        aria-modal={modal ? "true" : undefined}
        aria-labelledby={titleId}
        className="odos-exam-entry-sheet"
        data-testid="exam-entry-sheet"
        data-entry-sheet-layout={config.layout}
        data-entry-sheet-section={sectionId}
        onInputCapture={onDirty}
        onChangeCapture={onDirty}
        onClickCapture={(event) => {
          const target = event.target instanceof Element ? event.target : undefined;
          const control = target?.closest('button, [role="button"]');
          if (!control) return;
          if (control.closest("[data-entry-sheet-chrome], [data-entry-sheet-pristine-action]")) return;
          const innerCancel = control.matches("button") && control.textContent?.trim() === "Cancel";
          if (innerCancel) {
            queueMicrotask(() => onRestoreDirtyCheckpoint?.());
            return;
          }
          const hadInnerCancel = Array.from(dialogRef.current?.querySelectorAll("button") ?? [])
            .some((button) => !button.closest("[data-entry-sheet-chrome]") && button.textContent?.trim() === "Cancel");
          if (!hadInnerCancel) onCheckpointDirty?.();
          onDirty?.();
          if (!hadInnerCancel) {
            window.setTimeout(() => {
              const hasInnerCancel = Array.from(dialogRef.current?.querySelectorAll("button") ?? [])
                .some((button) => !button.closest("[data-entry-sheet-chrome]") && button.textContent?.trim() === "Cancel");
              if (!hasInnerCancel) onClearDirtyCheckpoint?.();
            }, 0);
          }
        }}
        onFocusCapture={(event) => onFocusWithin?.(event.target as HTMLElement)}
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
