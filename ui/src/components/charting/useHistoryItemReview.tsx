import { useEffect, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { voidEncounterEntries } from "../../lib/encounter-void";
import { acquireSectionWrite } from "./encounter-edit-context";
import type { HistoryCatalogs, HistoryTemplateSection } from "./HpiSection";
export type Target = { sectionKey: string; sectionId: string; optionCode?: string; eye?: "OD" | "OS" | "OU" };
type Review = { attestationReference: string; recordedAt: string; method: "individual" | "bulk"; activeTargets: Target[] };
type Retraction = { attestationReference: string; recordedAt: string; targets: Target[]; retracts: string };
type Lock = { sectionKey: string; gestureId: string };
type HistoryActs = { reviews: Review[]; retractions: Retraction[]; locks: Lock[] };
type HistoryRecord = { answers?: Array<{ id: string; templateKey: string; sectionId: string; optionCode?: string; eye?: "OD" | "OS" | "OU"; observationReference?: string; subjectScope: "encounter" | "patient"; value: { kind: "tri-state"; status: "positive" | "negative" } }>; lastReviewed?: Array<{ target: Target; lastReviewed: string }>; subjectSectionNudges?: Array<{ target: Target; text: string }>; subjectSectionSummaries?: Array<{ sectionKey: string; state: string; summary: string }> };
export const targetKey = (target: Target) => [target.sectionKey, target.sectionId, target.optionCode ?? "", target.eye ?? ""].join("|");

export function useHistoryItemReview({ patientReference, encounterReference, historyVersion, onChanged, onRecordedChange, onReconciled, enabled = true }: {
  patientReference: string; encounterReference: string; historyVersion: number; onChanged: () => void;
  onRecordedChange?: (hasRecorded: boolean) => void;
  onReconciled?: (answers: NonNullable<HistoryRecord["answers"]>) => void;
  enabled?: boolean;
}) {
  const [record, setRecord] = useState<HistoryRecord>({});
  const [acts, setActs] = useState<HistoryActs>({ reviews: [], retractions: [], locks: [] });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const retries = useRef(new Map<string, object>());
  const loadGeneration = useRef(0);
  const owner = useRef<object>();
  const serverLockReleases = useRef(new Map<string, () => void>());
  const onReconciledRef = useRef(onReconciled);
  onReconciledRef.current = onReconciled;
  const encounterId = encounterReference.slice("Encounter/".length);
  const endpoint = `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}`;
  useEffect(() => {
    owner.current = {};
    pending.current = false; setBusy(false); setReady(false);
    setActs({ reviews: [], retractions: [], locks: [] });
    return () => { owner.current = undefined; };
  }, [endpoint, patientReference, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const generation = ++loadGeneration.current;
    void load().then(([history, items]) => { if (!cancelled && generation === loadGeneration.current) { applyLoaded(history, items); setError(""); } })
      .catch(caught => { if (!cancelled) { setReady(false); setError(String(caught.message ?? caught)); } });
    return () => { cancelled = true; };
  }, [endpoint, historyVersion, onRecordedChange, enabled]);
  const lockSignature = acts.locks.map(lock => `${lock.sectionKey}|${lock.gestureId}`).sort().join(",");
  useEffect(() => {
    if (!enabled || !lockSignature) return;
    let cancelled = false;
    const requestOwner = owner.current;
    void (async () => {
      while (!cancelled && requestOwner && requestOwner === owner.current) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try {
          const loaded = await load();
          if (cancelled || requestOwner !== owner.current) return;
          applyLoaded(...loaded);
          if (!loaded[1].locks.length) {
            onReconciledRef.current?.(loaded[0].answers ?? []);
            onChanged();
            return;
          }
        } catch { /* The durable freeze remains until a read establishes quiescence. */ }
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint, enabled, lockSignature]);

  async function load(): Promise<[HistoryRecord, HistoryActs]> {
    return Promise.all([request<HistoryRecord>(`${endpoint}/hpi`), request<HistoryActs>(`${endpoint}/history/items`)]);
  }
  async function refresh() {
    const requestOwner = owner.current;
    const generation = ++loadGeneration.current;
    const loaded = await load();
    if (requestOwner && requestOwner === owner.current && generation === loadGeneration.current) applyLoaded(...loaded);
    return loaded;
  }
  function applyLoaded(history: HistoryRecord, items: HistoryActs) {
    const normalized = { ...items, locks: items.locks ?? [] };
    syncServerLocks(normalized.locks);
    setRecord(history); setActs(normalized); setReady(true);
    onRecordedChange?.(items.reviews.length > 0 || items.retractions.length > 0);
  }
  function lockKey(lock: Lock) { return `${encounterReference}|${lock.sectionKey}|${lock.gestureId}`; }
  function syncServerLocks(locks: Lock[]) {
    const active = new Set(locks.map(lockKey));
    for (const [key, release] of serverLockReleases.current) {
      if (!active.has(key)) { release(); serverLockReleases.current.delete(key); }
    }
    for (const lock of locks) {
      const key = lockKey(lock);
      if (serverLockReleases.current.has(key)) continue;
      const release = acquireSectionWrite(encounterReference, [lock.sectionKey]);
      if (release) serverLockReleases.current.set(key, release);
    }
  }
  function adoptServerLock(lock: Lock, release: () => void) {
    serverLockReleases.current.set(lockKey(lock), release);
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
  async function bulkDeny(targets: Target[], callbacks?: {
    beforeRecord?: () => Promise<void>;
    onRecorded?: (answers: NonNullable<HistoryRecord["answers"]>) => void;
  }): Promise<void> {
    if (pending.current) return undefined;
    if (!targets.length) return undefined;
    const requestOwner = owner.current;
    const ownsRequest = () => Boolean(requestOwner && requestOwner === owner.current);
    if (!enabled || !ownsRequest()) return;
    const gestureId = crypto.randomUUID();
    const lock = { sectionKey: targets[0].sectionKey, gestureId };
    const release = acquireSectionWrite(encounterReference, [lock.sectionKey]);
    if (!release) return;
    pending.current = true; setBusy(true); setError("");
    let releaseLocally = true;
    try {
      await callbacks?.beforeRecord?.();
      if (!ownsRequest()) return;
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/history/items/review`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ patientReference, encounterReference, sectionKey: targets[0].sectionKey,
          action: "items-reviewed", method: "bulk", targets, gestureId }),
      });
      const result = await response.json();
      if (!ownsRequest()) return;
      if (!response.ok) {
        setError(result.error ?? `History request failed (${response.status}).`);
        const [history, items] = await refresh();
        if (ownsRequest()) callbacks?.onRecorded?.(history.answers ?? []);
        if (ownsRequest() && items.locks.some(candidate => candidate.gestureId === gestureId && candidate.sectionKey === lock.sectionKey)) {
          adoptServerLock(lock, release); releaseLocally = false;
        }
        return undefined;
      }
      const [history] = await refresh();
      if (!ownsRequest()) return;
      callbacks?.onRecorded?.(history.answers ?? []);
      setError(result.message ?? ""); onChanged();
    } catch (caught) {
      if (!ownsRequest()) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      adoptServerLock(lock, release); releaseLocally = false;
      setActs(current => ({ ...current, locks: current.locks.some(candidate => candidate.gestureId === gestureId)
        ? current.locks : [...current.locks, lock] }));
      setError(message);
      return undefined;
    } finally {
      if (ownsRequest()) { if (releaseLocally) release(); pending.current = false; setBusy(false); }
    }
  }
  const dates = new Map((record.lastReviewed ?? []).map(row => [targetKey(row.target), row.lastReviewed]));
  const current = new Map<string, Review>();
  for (const review of [...acts.reviews].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    for (const target of review.activeTargets) current.set(targetKey(target), review);
  }
  return { record, acts, ready, busy, error, setError, refresh, gesture, bulkDeny, dates, current };
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
