import type { ReactNode } from "react";

export type ExamRightPanelTab = "entry" | "images" | "engage";

export interface ExamRightPanelState {
  activeTab: ExamRightPanelTab;
  returnTab: "images" | "engage";
  summoned: boolean;
}

export const INITIAL_EXAM_RIGHT_PANEL_STATE: ExamRightPanelState = {
  activeTab: "images",
  returnTab: "images",
  summoned: false,
};

export function examRightPanelEntryTitle(sectionId: string, defaultTitle: string): string {
  return sectionId === "hpi" ? "History" : defaultTitle;
}

export function openExamRightPanelEntry(
  state: ExamRightPanelState,
  entryAlreadyOpen = false,
): ExamRightPanelState {
  return {
    activeTab: "entry",
    returnTab: entryAlreadyOpen
      ? state.returnTab
      : state.activeTab === "engage" ? "engage" : "images",
    summoned: true,
  };
}

export function selectExamRightPanelTab(
  state: ExamRightPanelState,
  activeTab: ExamRightPanelTab,
): ExamRightPanelState {
  return { ...state, activeTab, summoned: true };
}

export function finishExamRightPanelEntry(state: ExamRightPanelState): ExamRightPanelState {
  return {
    activeTab: state.returnTab,
    returnTab: state.returnTab,
    summoned: state.returnTab === "engage",
  };
}

export function closeExamRightPanelEngage(
  state: ExamRightPanelState,
  entryOpen: boolean,
): ExamRightPanelState {
  return entryOpen
    ? { ...state, activeTab: "entry", summoned: true }
    : INITIAL_EXAM_RIGHT_PANEL_STATE;
}

export function ExamRightPanelTabs({
  instanceId,
  activeTab,
  entryTitle,
  imageCount,
  onSelect,
}: {
  instanceId: string;
  activeTab: ExamRightPanelTab;
  entryTitle?: string;
  imageCount: number;
  onSelect: (tab: ExamRightPanelTab) => void;
}) {
  return (
    <div className="odos-exam-right-panel-tabs" role="tablist" aria-label="Exam right panel" data-entry-sheet-chrome>
      {entryTitle && (
        <button
          id={`${instanceId}-entry-tab`}
          type="button"
          role="tab"
          aria-selected={activeTab === "entry"}
          data-entry-tab="true"
          data-parked={activeTab === "entry" ? "false" : "true"}
          onClick={() => onSelect("entry")}
        >
          <span>{entryTitle}</span>
          {activeTab !== "entry" && <span className="odos-exam-right-panel-parked-dot" aria-hidden="true" />}
        </button>
      )}
      <button
        id={`${instanceId}-images-tab`}
        type="button"
        role="tab"
        aria-selected={activeTab === "images"}
        onClick={() => onSelect("images")}
      >
        <span>Images</span>
        {imageCount > 0 && <span className="odos-exam-right-panel-count-badge">{imageCount}</span>}
      </button>
      <button
        id={`${instanceId}-engage-tab`}
        type="button"
        role="tab"
        aria-selected={activeTab === "engage"}
        onClick={() => onSelect("engage")}
      >
        Engage
      </button>
    </div>
  );
}

export function ExamRightPanelSurface({
  active,
  label,
  tabs,
  children,
}: {
  active: boolean;
  label: "Images" | "Engage";
  tabs: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="odos-exam-entry-layer" data-panel-tabs="true" hidden={!active}>
      <section className="odos-exam-right-panel-surface" role="tabpanel" aria-label={label}>
        {tabs}
        <div className="odos-exam-right-panel-content">{children}</div>
      </section>
    </div>
  );
}
