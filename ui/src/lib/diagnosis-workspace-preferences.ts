export type EncounterChartView = "diagnosis" | "structure";

const CHART_VIEW_KEY = "odos:encounter-chart-view";

export function loadEncounterChartView(storage = browserStorage()): EncounterChartView {
  if (!storage && typeof window === "undefined") return "structure";
  const value = storage?.getItem(CHART_VIEW_KEY);
  return value === "structure" || value === "diagnosis" ? value : "diagnosis";
}

export function saveEncounterChartView(
  view: EncounterChartView,
  storage = browserStorage(),
): void {
  storage?.setItem(CHART_VIEW_KEY, view);
}

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}
