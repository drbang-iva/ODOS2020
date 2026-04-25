import { create } from "zustand";

export type ViewState =
  | { kind: "picker" }
  | { kind: "director"; patientId: string }
  | { kind: "encounter"; patientId: string; encounterId: string };

interface ViewStateStore {
  view: ViewState;
  setView: (view: ViewState) => void;
}

export const useViewState = create<ViewStateStore>((set) => ({
  view: { kind: "picker" },
  setView: (view) => set({ view }),
}));
