import { useEffect, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "./clinical-graph-client";

export interface ExamViewState {
  collapsed: string[];
  shelved: string[];
}

const empty = (): ExamViewState => ({ collapsed: [], shelved: [] });
const url = (encounterId: string) => `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}/exam-view-state`;

export async function loadExamViewState(encounterId: string, request: typeof fetch = fetch): Promise<ExamViewState> {
  try {
    const response = await request(url(encounterId), { headers: authHeaders() });
    if (!response.ok) return empty();
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") return empty();
    const candidate = value as Partial<ExamViewState>;
    if (!Array.isArray(candidate.collapsed) || !Array.isArray(candidate.shelved) ||
      ![...candidate.collapsed, ...candidate.shelved].every(id => typeof id === "string")) return empty();
    return { collapsed: [...new Set(candidate.collapsed)], shelved: [...new Set(candidate.shelved)] };
  } catch {
    return empty();
  }
}

export async function saveExamViewState(encounterId: string, state: ExamViewState, request: typeof fetch = fetch): Promise<void> {
  try {
    await request(url(encounterId), {
      method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(state),
    });
  } catch {
    // A failed preference write leaves the session's optimistic state intact.
  }
}

export function createExamViewStateWriter(encounterId: string, request: typeof fetch = fetch) {
  let pending: ExamViewState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (pending) {
      const state = pending;
      pending = undefined;
      writes = writes.then(() => saveExamViewState(encounterId, state, request));
    }
    return writes;
  }
  return {
    schedule(state: ExamViewState) {
      pending = { collapsed: [...state.collapsed], shelved: [...state.shelved] };
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, 300);
    },
    flush,
  };
}

export function useExamViewState(encounterId: string, request: typeof fetch = fetch) {
  const [view, setView] = useState(() => ({ encounterId, state: empty() }));
  const session = useRef<{ encounterId: string; state: ExamViewState; changed: boolean; writer: ReturnType<typeof createExamViewStateWriter> }>();
  useEffect(() => {
    let active = true;
    const current = { encounterId, state: empty(), changed: false, writer: createExamViewStateWriter(encounterId, request) };
    session.current = current;
    setView({ encounterId, state: current.state });
    void loadExamViewState(encounterId, request).then(state => {
      if (active && !current.changed) {
        current.state = state;
        setView({ encounterId, state });
      }
    });
    return () => { active = false; void current.writer.flush(); };
  }, [encounterId, request]);
  return {
    state: view.encounterId === encounterId ? view.state : empty(),
    change(action: "collapse" | "expand" | "shelve" | "open", id: string) {
      const current = session.current;
      if (!current || current.encounterId !== encounterId) return;
      current.changed = true;
      current.state = changeExamViewState(current.state, action, id);
      setView({ encounterId, state: current.state });
      current.writer.schedule(current.state);
    },
  };
}

export function changeExamViewState(state: ExamViewState, action: "collapse" | "expand" | "shelve" | "open", id: string): ExamViewState {
  return {
    collapsed: [...state.collapsed.filter(value => value !== id), ...(action === "collapse" ? [id] : [])],
    shelved: [...state.shelved.filter(value => value !== id), ...(action === "shelve" ? [id] : [])],
  };
}
