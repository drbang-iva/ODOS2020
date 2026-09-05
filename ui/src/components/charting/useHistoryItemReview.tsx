import { useEffect, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { voidEncounterEntries } from "../../lib/encounter-void";
import type { HistoryCatalogs, HistoryTemplateSection } from "./HpiSection";
export type Target = { sectionKey: string; sectionId: string; optionCode?: string; eye?: "OD" | "OS" | "OU" };
type Review = { attestationReference: string; recordedAt: string; method: "individual" | "bulk"; activeTargets: Target[] };
type Retraction = { attestationReference: string; recordedAt: string; targets: Target[]; retracts: string };
type HistoryRecord = { lastReviewed?: Array<{ target: Target; lastReviewed: string }>; subjectSectionNudges?: Array<{ target: Target; text: string }>; subjectSectionSummaries?: Array<{ sectionKey: string; state: string; summary: string }> };
export const targetKey = (target: Target) => [target.sectionKey, target.sectionId, target.optionCode ?? "", target.eye ?? ""].join("|");

export function useHistoryItemReview({ patientReference, encounterReference, historyVersion, onChanged, onRecordedChange, enabled = true }: {
  patientReference: string; encounterReference: string; historyVersion: number; onChanged: () => void;
  onRecordedChange?: (hasRecorded: boolean) => void;
  enabled?: boolean;
}) {
  const [record, setRecord] = useState<HistoryRecord>({});
  const [acts, setActs] = useState<{ reviews: Review[]; retractions: Retraction[] }>({ reviews: [], retractions: [] });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const retries = useRef(new Map<string, object>());
  const encounterId = encounterReference.slice("Encounter/".length);
  const endpoint = `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}`;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void load().then(([history, items]) => { if (!cancelled) { setRecord(history); setActs(items); setReady(true); onRecordedChange?.(items.reviews.length > 0 || items.retractions.length > 0); setError(""); } })
      .catch(caught => { if (!cancelled) { setReady(false); setError(String(caught.message ?? caught)); } });
    return () => { cancelled = true; };
  }, [endpoint, historyVersion, onRecordedChange, enabled]);

  async function load(): Promise<[HistoryRecord, typeof acts]> {
    return Promise.all([request<HistoryRecord>(`${endpoint}/hpi`), request<typeof acts>(`${endpoint}/history/items`)]);
  }
  async function refresh() {
    const [history, items] = await load(); setRecord(history); setActs(items); setReady(true); onRecordedChange?.(items.reviews.length > 0 || items.retractions.length > 0);
  }
  async function gesture(target: Target, original?: Review, undo?: Retraction) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    const key = `${targetKey(target)}|${undo?.attestationReference ?? original?.attestationReference ?? "review"}`;
    try {
      if (undo) {
        await voidEncounterEntries(encounterReference, { scope: "observation", observationReference: undo.attestationReference });
      } else {
        const body = retries.current.get(key) ?? {
          patientReference, encounterReference, sectionKey: target.sectionKey, targets: [target], gestureId: crypto.randomUUID(),
          ...(original ? { action: "items-review-retracted", retracts: original.attestationReference } : { action: "items-reviewed", method: "individual" }),
        };
        retries.current.set(key, body);
        await request(`${clinicalGraphApiBase()}/clinical-graph/history/items/${original ? "retract" : "review"}`, body);
      }
      await refresh(); retries.current.delete(key); onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { pending.current = false; setBusy(false); }
  }
  const dates = new Map((record.lastReviewed ?? []).map(row => [targetKey(row.target), row.lastReviewed]));
  const current = new Map<string, Review>();
  for (const review of [...acts.reviews].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    for (const target of review.activeTargets) current.set(targetKey(target), review);
  }
  return { record, acts, ready, busy, error, setError, refresh, gesture, dates, current };
}
async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `History request failed (${response.status}).`);
  return result as T;
}

export function HistoryItemReviewControls({ sectionKey, section, catalogs, review }: {
  sectionKey: string; section: HistoryTemplateSection; catalogs: HistoryCatalogs; review: ReturnType<typeof useHistoryItemReview>;
}) {
  const targets = section.catalog && section.type !== "single_select"
    ? (catalogs[section.catalog] ?? []).map(option => ({ target: { sectionKey, sectionId: section.id, optionCode: option.code }, label: option.display }))
    : [{ target: { sectionKey, sectionId: section.id }, label: section.label }];
  return <div className="mt-2 space-y-1">{targets.map(({ target, label }) => {
    const key = targetKey(target), current = review.current.get(key), date = review.dates.get(key);
    const retraction = review.acts.retractions.filter(row => row.targets.some(t => targetKey(t) === key)).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const { stale, formatted } = historyItemDate(date);
    return <div key={key} data-history-item={key} className="flex flex-wrap items-center gap-3 text-xs">
      <label className="odos-hpi-muted inline-flex min-h-11 items-center gap-2"><input type="checkbox" aria-label={`Reviewed: ${label}`} checked={Boolean(current)} disabled={!review.ready || review.busy} onChange={() => void review.gesture(target, current)} />{label}</label>
      <span data-stale={stale} className={stale ? "text-amber-600" : "odos-hpi-muted"}>{stale ? "⚑ " : ""}{date ? `Last asked ${formatted}` : formatted}</span>
      {!current && retraction && <button type="button" disabled={review.busy} className="odos-hpi-muted min-h-11 underline" onClick={() => void review.gesture(target, undefined, retraction)}>Undo unmark</button>}
    </div>;
  })}</div>;
}

export function historyItemDate(date: string | undefined) {
    const stale = !date || new Date(date).getUTCFullYear() < new Date().getUTCFullYear();
    const formatted = date ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "2-digit", day: "2-digit", year: "numeric" }).format(new Date(date)) : "Never asked";
  return { stale, formatted };
}
