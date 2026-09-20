export interface ExamViewState {
  collapsed: string[];
  shelved: string[];
}

type ViewStorage = Pick<Storage, "getItem" | "setItem">;
const empty = (): ExamViewState => ({ collapsed: [], shelved: [] });
const key = (encounterId: string) => `odos:exam-view:v1:${encounterId}`;

export function loadExamViewState(encounterId: string, storage?: ViewStorage | null): ExamViewState {
  try {
    const source = storage === undefined ? (typeof window === "undefined" ? null : window.localStorage) : storage;
    const value: unknown = JSON.parse(source?.getItem(key(encounterId)) ?? "null");
    if (!value || typeof value !== "object") return empty();
    const candidate = value as Partial<ExamViewState>;
    if (!Array.isArray(candidate.collapsed) || !Array.isArray(candidate.shelved) ||
      ![...candidate.collapsed, ...candidate.shelved].every(id => typeof id === "string")) return empty();
    return { collapsed: [...new Set(candidate.collapsed)], shelved: [...new Set(candidate.shelved)] };
  } catch {
    return empty();
  }
}

export function saveExamViewState(encounterId: string, state: ExamViewState, storage?: ViewStorage | null): void {
  try {
    const target = storage === undefined ? (typeof window === "undefined" ? null : window.localStorage) : storage;
    target?.setItem(key(encounterId), JSON.stringify({ collapsed: state.collapsed, shelved: state.shelved }));
  } catch {
    // Session state remains usable when browser storage is unavailable.
  }
}

export function changeExamViewState(state: ExamViewState, action: "collapse" | "expand" | "shelve" | "open", id: string): ExamViewState {
  return {
    collapsed: [...state.collapsed.filter(value => value !== id), ...(action === "collapse" ? [id] : [])],
    shelved: [...state.shelved.filter(value => value !== id), ...(action === "shelve" ? [id] : [])],
  };
}
