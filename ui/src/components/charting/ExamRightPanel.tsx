import type { KeyboardEvent, ReactNode } from "react";

export type ExamRightPanelTab = "entry" | "images" | "imaging" | "engage";

export interface ExamRightPanelState {
  activeTab: ExamRightPanelTab;
  returnTab: "images" | "imaging" | "engage";
  summoned: boolean;
}

export const INITIAL_EXAM_RIGHT_PANEL_STATE: ExamRightPanelState = {
  activeTab: "images",
  returnTab: "images",
  summoned: false,
};

export const EXAM_RIGHT_PANEL_IDS: Record<ExamRightPanelTab, string> = {
  entry: "exam-right-panel-entry",
  images: "exam-right-panel-images",
  engage: "exam-right-panel-engage",
  imaging: "exam-right-panel-imaging",
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
      : state.activeTab === "entry" ? "images" : state.activeTab,
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
    summoned: state.returnTab !== "images",
  };
}

export function closeExamRightPanelEntry(state: ExamRightPanelState): ExamRightPanelState {
  return state.activeTab === "entry" ? finishExamRightPanelEntry(state) : state;
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
  const tabs: ExamRightPanelTab[] = entryTitle
    ? ["entry", "images", "imaging", "engage"]
    : ["images", "imaging", "engage"];
  const focusSelectedTab = (tab: ExamRightPanelTab) => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(
        `.odos-exam-entry-layer:not([hidden]) [role="tab"][data-panel-tab="${tab}"]`,
      )?.focus();
    });
  };
  const selectTab = (tab: ExamRightPanelTab) => {
    onSelect(tab);
    focusSelectedTab(tab);
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextTab: ExamRightPanelTab | undefined;
    const currentIndex = Math.max(0, tabs.indexOf(activeTab));
    if (event.key === "ArrowRight") nextTab = tabs[(currentIndex + 1) % tabs.length];
    if (event.key === "ArrowLeft") nextTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length];
    if (event.key === "Home") nextTab = tabs[0];
    if (event.key === "End") nextTab = tabs[tabs.length - 1];
    if (!nextTab) return;
    event.preventDefault();
    selectTab(nextTab);
  };
  return (
    <div className="odos-exam-right-panel-tabs" role="tablist" aria-label="Exam right panel" data-entry-sheet-chrome>
      {entryTitle && (
        <button
          id={`${instanceId}-entry-tab`}
          type="button"
          role="tab"
          aria-selected={activeTab === "entry"}
          aria-controls={EXAM_RIGHT_PANEL_IDS.entry}
          tabIndex={activeTab === "entry" ? 0 : -1}
          data-entry-tab="true"
          data-panel-tab="entry"
          data-parked={activeTab === "entry" ? "false" : "true"}
          onClick={() => selectTab("entry")}
          onKeyDown={onTabKeyDown}
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
        aria-controls={EXAM_RIGHT_PANEL_IDS.images}
        tabIndex={activeTab === "images" ? 0 : -1}
        data-panel-tab="images"
        onClick={() => selectTab("images")}
        onKeyDown={onTabKeyDown}
      >
        <span>Photos</span>
        {imageCount > 0 && <span className="odos-exam-right-panel-count-badge">{imageCount}</span>}
      </button>
      <button
        id={`${instanceId}-imaging-tab`}
        type="button"
        role="tab"
        aria-selected={activeTab === "imaging"}
        aria-controls={EXAM_RIGHT_PANEL_IDS.imaging}
        tabIndex={activeTab === "imaging" ? 0 : -1}
        data-panel-tab="imaging"
        onClick={() => selectTab("imaging")}
        onKeyDown={onTabKeyDown}
      >
        Imaging
      </button>
      <button
        id={`${instanceId}-engage-tab`}
        type="button"
        role="tab"
        aria-selected={activeTab === "engage"}
        aria-controls={EXAM_RIGHT_PANEL_IDS.engage}
        tabIndex={activeTab === "engage" ? 0 : -1}
        data-panel-tab="engage"
        onClick={() => selectTab("engage")}
        onKeyDown={onTabKeyDown}
      >
        Engage
      </button>
    </div>
  );
}

export function ExamRightPanelSurface({
  active,
  label,
  panelId,
  labelledBy,
  tabs,
  children,
}: {
  active: boolean;
  label: "Photos" | "Imaging" | "Engage";
  panelId: string;
  labelledBy: string;
  tabs: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      id={panelId}
      className="odos-exam-entry-layer"
      role="tabpanel"
      aria-label={label}
      aria-labelledby={labelledBy}
      data-panel-tabs="true"
      hidden={!active}
    >
      <section className="odos-exam-right-panel-surface">
        {tabs}
        <div className="odos-exam-right-panel-content">{children}</div>
      </section>
    </div>
  );
}
