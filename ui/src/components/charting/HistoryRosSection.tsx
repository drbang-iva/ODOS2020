import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { voidEncounterEntries } from "../../lib/encounter-void";
import type { HistoryCatalogs, HistorySubjectSection, HistoryTemplateAnswer } from "./HpiSection";

type Target = { sectionKey: string; sectionId: string; optionCode?: string; eye?: "OD" | "OS" | "OU" };
type Review = { attestationReference: string; recordedAt: string; method: "individual" | "bulk"; activeTargets: Target[] };
type Retraction = { attestationReference: string; recordedAt: string; targets: Target[]; retracts: string };
type HistoryRecord = { lastReviewed?: Array<{ target: Target; lastReviewed: string }>; subjectSectionSummaries?: Array<{ sectionKey: string; state: string; summary: string }> };
const targetKey = (target: Target) => [target.sectionKey, target.sectionId, target.optionCode ?? "", target.eye ?? ""].join("|");

export function HistoryRosSection({ declaration, catalogs, patientReference, encounterReference, answers, followUp, historyVersion, onChange, onChanged, saveIndicator, makeAnswerId }: {
  declaration: HistorySubjectSection; catalogs: HistoryCatalogs; patientReference: string; encounterReference: string;
  answers: HistoryTemplateAnswer[]; followUp: boolean; historyVersion: number;
  onChange: (next: HistoryTemplateAnswer | undefined, prior: HistoryTemplateAnswer | undefined) => void;
  onChanged: () => void; saveIndicator: ReactNode; makeAnswerId: (sectionId: string, optionCode?: string) => string;
}) {
  const [open, setOpen] = useState(!followUp);
  const [record, setRecord] = useState<HistoryRecord>({});
  const [acts, setActs] = useState<{ reviews: Review[]; retractions: Retraction[] }>({ reviews: [], retractions: [] });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const retries = useRef(new Map<string, object>());
  const encounterId = encounterReference.slice("Encounter/".length);
  const endpoint = `${clinicalGraphApiBase()}/clinical-graph/encounters/${encodeURIComponent(encounterId)}`;
  useEffect(() => setOpen(!followUp), [followUp]);
  useEffect(() => {
    let cancelled = false;
    void load().then(([history, items]) => { if (!cancelled) { setRecord(history); setActs(items); setReady(true); setError(""); } })
      .catch(caught => { if (!cancelled) { setReady(false); setError(String(caught.message ?? caught)); } });
    return () => { cancelled = true; };
  }, [endpoint, historyVersion]);

  async function load(): Promise<[HistoryRecord, typeof acts]> {
    return Promise.all([request<HistoryRecord>(`${endpoint}/hpi`), request<typeof acts>(`${endpoint}/history/items`)]);
  }
  async function refresh() {
    const [history, items] = await load(); setRecord(history); setActs(items); setReady(true);
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
          patientReference, encounterReference, sectionKey: declaration.key, targets: [target], gestureId: crypto.randomUUID(),
          ...(original ? { action: "items-review-retracted", retracts: original.attestationReference } : { action: "items-reviewed", method: "individual" }),
        };
        retries.current.set(key, body);
        await request(`${clinicalGraphApiBase()}/clinical-graph/history/items/${original ? "retract" : "review"}`, body);
      }
      await refresh(); retries.current.delete(key); onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { pending.current = false; setBusy(false); }
  }
  function put(sectionId: string, value: HistoryTemplateAnswer["value"], optionCode?: string) {
    const prior = answers.find(answer => answer.sectionId === sectionId && answer.optionCode === optionCode);
    onChange({ id: prior?.id ?? makeAnswerId(sectionId, optionCode),
      subjectScope: declaration.subjectScope, templateKey: declaration.key, sectionId, ...(optionCode ? { optionCode } : {}), value,
      ...(prior?.observationReference ? { observationReference: prior.observationReference } : {}) }, prior);
  }
  const projection = record.subjectSectionSummaries?.find(row => row.sectionKey === declaration.key);
  const dates = new Map((record.lastReviewed ?? []).map(row => [targetKey(row.target), row.lastReviewed]));
  const current = new Map<string, Review>();
  for (const review of [...acts.reviews].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    for (const target of review.activeTargets) current.set(targetKey(target), review);
  }
  const options = declaration.sections.flatMap(section => section.group_by === "system" && section.catalog ? catalogs[section.catalog] ?? [] : []);
  const count = options.filter(option => current.has(targetKey({ sectionKey: declaration.key, sectionId: declaration.sections.find(s => s.group_by === "system")!.id, optionCode: option.code }))).length;
  return <article data-testid={`history-${declaration.key}`} className="odos-hpi-border rounded border bg-bg-panel/70">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-inherit px-5 py-4">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="min-w-0 flex-1 text-left">
        <span className="odos-hpi-text font-semibold">{open ? "▾" : "▸"} {declaration.label}</span>
        {followUp && <span className="odos-hpi-muted ml-3 text-sm">Complaint-directed</span>}
        <span className="odos-hpi-muted mt-1 block line-clamp-2 text-sm" title={projection?.summary}>{projection?.summary || "Not started"}</span>
      </button>
      <span className="odos-hpi-muted text-xs">{projection?.state === "charted" ? "Charted" : projection?.state === "started" ? "Started" : "Not started"}</span>
      {saveIndicator}
    </header>
    {error && <div className="px-5 py-2 text-red-400" role="alert">{error} <button type="button" onClick={() => void refresh().then(() => setError("")).catch(caught => setError(String(caught)))}>Refresh</button></div>}
    {open && <div className="p-5">
      <p className="odos-hpi-muted mb-3 text-sm">{count} of {options.length} items reviewed{busy ? " · saving review…" : ""}</p>
      {declaration.sections.map(section => {
        if (section.group_by === "system" && section.catalog) {
          const grouped = new Map<string, typeof options>();
          for (const option of catalogs[section.catalog] ?? []) { const group = option.system ?? "Other"; grouped.set(group, [...(grouped.get(group) ?? []), option]); }
          return <div key={section.id} className="overflow-x-auto"><table className="w-full text-sm" aria-label="Review of Systems items">
            <thead className="odos-hpi-faint text-left text-xs"><tr><th className="pb-2">Reviewed</th><th>Item</th><th>Last asked</th><th>Answer</th></tr></thead>
            <tbody>{[...grouped].map(([system, items]) => <Fragment key={system}>
              <tr data-ros-system={system}><th colSpan={4} scope="colgroup" className="odos-hpi-border odos-hpi-faint border-t pb-2 pt-4 text-left text-xs font-medium uppercase tracking-wider">{system}</th></tr>
              {items.map(option => {
                const target = { sectionKey: declaration.key, sectionId: section.id, optionCode: option.code }, key = targetKey(target);
                const review = current.get(key), date = dates.get(key);
                const retraction = acts.retractions.filter(row => row.targets.some(t => targetKey(t) === key)).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
                const prior = answers.find(answer => answer.sectionId === section.id && answer.optionCode === option.code);
                const value = prior?.value.kind === "tri-state" ? prior.value.status : undefined;
                const stale = !date || new Date(date).getUTCFullYear() < new Date().getUTCFullYear();
                const formatted = date ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "2-digit", day: "2-digit", year: "numeric" }).format(new Date(date)) : "Never asked";
                return <tr key={option.code} data-ros-item={option.code}>
                  <td className="py-1"><label className="inline-flex min-h-11 min-w-11 items-center justify-center"><input type="checkbox" aria-label={`Reviewed: ${option.display}`} checked={Boolean(review)} disabled={!ready || busy} onChange={() => void gesture(target, review)} className="h-4 w-4 accent-teal-600" /></label></td>
                  <th scope="row" className="odos-hpi-text min-w-40 pr-4 text-left font-normal">{option.display}</th>
                  <td data-stale={stale} className={`whitespace-nowrap pr-4 text-xs ${stale ? "text-amber-600" : "odos-hpi-muted"}`}>
                    {stale ? "⚑ " : ""}{date ? `Last asked ${formatted}` : formatted}
                    {!review && retraction && <button type="button" className="ml-3 min-h-11 underline" disabled={busy} onClick={() => void gesture(target, undefined, retraction)}>Undo unmark</button>}
                  </td>
                  <td><div className="flex gap-1">{(["positive", "negative"] as const).map(status => <button key={status} type="button" aria-label={`${status === "positive" ? "Yes" : "No"}: ${option.display}`} aria-pressed={value === status}
                    className={`min-h-11 min-w-11 rounded border px-3 ${value === status ? status === "positive" ? "border-teal-600 bg-teal-600/15 text-teal-600" : "border-slate-400 bg-slate-400/15 odos-hpi-text" : "odos-hpi-border odos-hpi-muted"}`}
                    onClick={() => put(section.id, { kind: "tri-state", status }, option.code)}>{status === "positive" ? "Yes" : "No"}</button>)}
                    {prior && <button type="button" aria-label={`Clear answer: ${option.display}`} className="odos-hpi-muted min-h-11 px-2 text-xs underline" onClick={() => onChange(undefined, prior)}>Clear</button>}
                  </div></td>
                </tr>;
              })}
            </Fragment>)}</tbody>
          </table></div>;
        }
        const answer = answers.find(answer => answer.sectionId === section.id);
        return <label key={section.id} className="odos-hpi-muted mt-4 block text-sm">{section.label}<textarea aria-label={section.label} className="odos-hpi-border odos-hpi-text mt-2 block w-full rounded border bg-bg-panel p-3" value={answer?.value.kind === "text" ? answer.value.text : ""}
          onChange={event => event.target.value ? put(section.id, { kind: "text", text: event.target.value }) : onChange(undefined, answer)} /></label>;
      })}
    </div>}
  </article>;
}

async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, { method: body ? "POST" : "GET", headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `History request failed (${response.status}).`);
  return result as T;
}
