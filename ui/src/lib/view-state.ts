import { create } from "zustand";

export type ViewState =
  | { kind: "picker" }
  | { kind: "overview"; patientId: string }
  | { kind: "director"; patientId: string }
  | { kind: "encounter"; patientId: string; encounterId: string };

export function patientOverviewView(patientId: string): ViewState {
  return { kind: "overview", patientId };
}

export function openPatientOverview(patientId: string, historyMode: "push" | "replace" = "push"): void {
  const path = `/clinic?patientId=${encodeURIComponent(patientId)}`;
  if (typeof window !== "undefined") {
    if (historyMode === "replace") {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }
    window.dispatchEvent(new Event("popstate"));
  }
  useViewState.getState().setView(patientOverviewView(patientId));
}

export function openEncounter(
  patientId: string,
  encounterId: string,
  historyMode: "push" | "replace" = "push",
): void {
  const view: ViewState = { kind: "encounter", patientId, encounterId };
  const path = `/clinic?patientId=${encodeURIComponent(patientId)}&encounterId=${encodeURIComponent(encounterId)}`;
  if (typeof window !== "undefined") {
    if (historyMode === "replace") {
      window.history.replaceState({}, "", path);
    } else {
      window.history.pushState({}, "", path);
    }
    window.dispatchEvent(new Event("popstate"));
  }
  useViewState.getState().setView(view);
}

interface ViewStateStore {
  view: ViewState;
  setView: (view: ViewState) => void;
}

export const useViewState = create<ViewStateStore>((set) => ({
  view: { kind: "picker" },
  setView: (view) => set({ view }),
}));
