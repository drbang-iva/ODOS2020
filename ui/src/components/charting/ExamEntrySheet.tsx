import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { Encounter } from "@medplum/fhirtypes";
import { useDockedPanel } from "../commercial/panel-shared";
import type { UndoLedgerSlot } from "../../lib/encounter-undo";
import { isClosedEncounterStatus, type EncounterVoidResult } from "../../lib/encounter-void";
import { ClearEncounterButton } from "./ClearControls";
import { UndoStrip } from "./UndoStrip";

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
  cvf: { title: "Confrontation visual fields", layout: "quadrant-grid" },
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
export type ExamEntrySheetId = ExamEntrySheetSectionId | "visit-charges" | "engage";

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
  const markDirtyCheckpoint = useCallback(() => {
    if (dirtyCheckpointRef.current !== undefined) dirtyCheckpointRef.current = true;
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
  /**
   * Ask whether unsaved edits may be discarded — WITHOUT discarding them. Returns true when the
   * sheet is clean or the clinician accepted. The caller commits the discard with `resetDirty()`
   * only once the action that needed it has actually succeeded; a failed action leaves the edits
   * on screen and the guard armed for the next transition.
   */
  const confirmDiscard = useCallback((messageTemplate?: string, destinationTitle?: string) => {
    if (!sectionId || !dirtyRef.current) return true;
    const currentTitle = EXAM_ENTRY_SHEET_CONFIG[sectionId].title;
    const message = messageTemplate
      ? messageTemplate.replace("{title}", currentTitle)
      : destinationTitle
        ? `Discard unsaved changes in ${currentTitle} and open ${destinationTitle}?`
        : `Discard unsaved changes in ${currentTitle}?`;
    if (typeof window === "undefined" || typeof window.confirm !== "function" || !window.confirm(message)) {
      lastFocusRef.current?.focus();
      return false;
    }
    return true;
  }, [sectionId]);
  const requestTransition = useCallback((destinationTitle: string | undefined, transition: () => void) => {
    if (!confirmDiscard(undefined, destinationTitle)) return false;
    dirtyRef.current = false;
    dirtyCheckpointRef.current = undefined;
    transition();
    return true;
  }, [confirmDiscard]);

  return {
    checkpointDirty,
    clearDirtyCheckpoint,
    confirmDiscard,
    markDirty,
    markDirtyCheckpoint,
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
  onDirtyCheckpoint,
  onFocusWithin,
  onRestoreDirtyCheckpoint,
  panelId,
  panelLabelledBy,
  panelTabs,
  active = true,
  hidden = false,
  encounterReference,
  encounterStatus,
  onEncounterCleared,
  undo,
  children,
}: {
  sectionId: ExamEntrySheetId;
  onCancel: () => void;
  /** When supplied with onEncounterCleared, the chrome carries the tier-3 "Clear everything charted this visit…" control. */
  encounterReference?: string;
  encounterStatus?: Encounter["status"];
  onEncounterCleared?: (result: EncounterVoidResult) => void;
  /** This section's pending Undo (§4b.1): rendered as a status strip directly beneath the heading row. */
  undo?: { slot: UndoLedgerSlot; onUndo: () => void | Promise<void>; confirmed?: boolean };
  onCheckpointDirty?: () => void;
  onClearDirtyCheckpoint?: () => void;
  onDirty?: () => void;
  onDirtyCheckpoint?: () => void;
  onFocusWithin?: (element: HTMLElement) => void;
  onRestoreDirtyCheckpoint?: () => void;
  panelId?: string;
  panelLabelledBy?: string;
  panelTabs?: ReactNode;
  active?: boolean;
  hidden?: boolean;
  children: ReactNode;
}) {
  const modal = sectionId === "visit-charges" || sectionId === "engage";
  const { dialogRef, initialFocusRef, titleId } = useDockedPanel(onCancel, active, { modal });
  const config = sectionId === "visit-charges"
    ? { title: "Visit & charges", layout: "visit-charges" }
    : sectionId === "engage"
      ? { title: "Engage", layout: "engage" }
      : EXAM_ENTRY_SHEET_CONFIG[sectionId];
  const findInnerCancel = () => Array.from(dialogRef.current?.querySelectorAll("button") ?? [])
    .find((button) => !button.closest("[data-entry-sheet-chrome]") && button.textContent?.trim() === "Cancel");
  const markEventDirty = (target: EventTarget | null) => {
    onDirty?.();
    const element = isElement(target) ? target : undefined;
    const editorRoot = findInnerCancel()?.parentElement?.parentElement;
    if (element && editorRoot && !editorRoot.contains(element)) onDirtyCheckpoint?.();
  };
  return (
    <div
      id={panelId}
      className="odos-exam-entry-layer"
      role={panelTabs ? "tabpanel" : undefined}
      aria-labelledby={panelLabelledBy}
      data-testid="exam-entry-layer"
      data-panel-tabs={panelTabs ? "true" : undefined}
      hidden={hidden}
    >
      {!panelTabs && (
        <div
          className="odos-exam-entry-restore-bar"
          data-testid="exam-entry-restore-bar"
          data-entry-sheet-chrome
          aria-hidden="true"
        >
          <strong>Exam overview</strong>
          <span>{modal ? "Chart remains visible behind this sheet" : `Parked while editing ${config.title}`}</span>
        </div>
      )}
      <aside
        id={sectionId === "visit-charges" ? "visit-charges-sheet" : sectionId === "engage" ? "engage-sheet" : undefined}
        ref={dialogRef}
        role="dialog"
        aria-modal={modal ? "true" : undefined}
        aria-labelledby={titleId}
        className="odos-exam-entry-sheet"
        data-panel-tabs={panelTabs ? "true" : undefined}
        data-testid="exam-entry-sheet"
        data-entry-sheet-layout={config.layout}
        data-entry-sheet-section={sectionId}
        data-undo-strip={!modal && undo ? "true" : undefined}
        onInputCapture={(event) => markEventDirty(event.target)}
        onChangeCapture={(event) => markEventDirty(event.target)}
        onClickCapture={(event) => {
          const target = isElement(event.target) ? event.target : undefined;
          const control = target?.closest('button, [role="button"]');
          if (!control) return;
          if (control.closest("[data-entry-sheet-chrome], [data-entry-sheet-pristine-action]")) return;
          const activeInnerCancel = findInnerCancel();
          if (control === activeInnerCancel) {
            queueMicrotask(() => onRestoreDirtyCheckpoint?.());
            return;
          }
          if (!activeInnerCancel) onCheckpointDirty?.();
          markEventDirty(event.target);
          if (!activeInnerCancel) {
            window.setTimeout(() => {
              if (!findInnerCancel()) onClearDirtyCheckpoint?.();
            }, 0);
          }
        }}
        onFocusCapture={(event) => onFocusWithin?.(event.target as HTMLElement)}
      >
        {panelTabs}
        <header className="odos-exam-entry-sheet-heading">
          <div>
            <span>Entry sheet</span>
            <h2 id={titleId}>{config.title}</h2>
          </div>
          <div className="odos-exam-entry-sheet-actions">
            {!modal && encounterReference && onEncounterCleared && (
              <ClearEncounterButton
                encounterReference={encounterReference}
                encounterStatus={encounterStatus}
                onCleared={onEncounterCleared}
              />
            )}
            <button
              ref={initialFocusRef}
              type="button"
              aria-label={modal ? `Cancel ${config.title} entry` : `Back to exam overview from ${config.title}`}
              data-testid="cancel-exam-entry-sheet"
              data-entry-sheet-chrome
              onClick={onCancel}
            >
              {modal ? "Cancel" : "Back to exam overview"}
            </button>
          </div>
        </header>
        {!modal && undo && (
          <UndoStrip slot={undo.slot} scope="section" confirmed={undo.confirmed ?? false} closed={isClosedEncounterStatus(encounterStatus)} onUndo={undo.onUndo} />
        )}
        <div className="odos-exam-entry-sheet-content">{children}</div>
      </aside>
    </div>
  );
}

/** `Element` only exists in a browser; the sheet's dirty tracking must not throw elsewhere. */
function isElement(target: EventTarget | null): target is Element {
  return typeof Element !== "undefined" && target instanceof Element;
}
