import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { CustomFindingDefinition, CustomFindingField } from "./CustomFindingSection";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";

export interface EyeCapture {
  state?: ExamState;
  selections: string[];
  other: string;
}

interface HistoryRow {
  eye?: Eye;
  state?: ExamState;
  values: Array<{ code: string; value: number | string | string[] }>;
  other?: string;
}

interface Props {
  definitions: CustomFindingDefinition[];
  focusedStableKey?: string;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus, stableKeys: string[]): void;
}

const EYES: Eye[] = ["OD", "OS"];

export function OcularHealthSection({
  definitions,
  focusedStableKey,
  patientReference,
  encounterReference,
  onSaved,
}: Props) {
  const [captures, setCaptures] = useState<Record<string, Record<Eye, EyeCapture>>>(() => emptyCaptures(definitions));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const definitionKey = useMemo(() => definitions.map((definition) => definition.stableKey).join("|"), [definitions]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all(definitions.map(async (definition) => {
      const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
      const response = await fetch(
        `${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history?${query}`,
        { headers: authHeaders(), signal: controller.signal },
      );
      const body = await response.json() as { rows?: HistoryRow[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `${definition.display} history failed: ${response.status}`);
      return [definition.stableKey, captureFromRows(definition, body.rows ?? [])] as const;
    }))
      .then((rows) => setCaptures(Object.fromEntries(rows)))
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [definitionKey, patientReference, encounterReference]);

  useEffect(() => {
    if (!focusedStableKey) return;
    document.getElementById(domId(focusedStableKey))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusedStableKey]);

  function updateEye(stableKey: string, eye: Eye, update: (capture: EyeCapture) => EyeCapture) {
    setCaptures((current) => ({
      ...current,
      [stableKey]: {
        ...current[stableKey],
        [eye]: update(current[stableKey]?.[eye] ?? emptyEye()),
      },
    }));
  }

  function setExamState(definition: CustomFindingDefinition, eye: Eye, state: ExamState) {
    updateEye(definition.stableKey, eye, (current) => ({
      ...current,
      state,
      ...(state === "abnormal" ? {} : { selections: [] }),
    }));
  }

  function copyEye(definition: CustomFindingDefinition, from: Eye, to: Eye) {
    updateEye(definition.stableKey, to, () => {
      const source = captures[definition.stableKey]?.[from] ?? emptyEye();
      return copyEyeCapture(source);
    });
  }

  function allNormal() {
    const result = applyAnteriorAllNormal(definitions, captures);
    setCaptures(result.captures);
    const { filled, skipped } = result;
    setMessage(`Marked ${filled} untouched ${filled === 1 ? "structure" : "structures"} normal${skipped ? `; skipped ${skipped} already touched` : ""}.`);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const touchedDefinitions = definitions.filter((definition) => {
        const row = captures[definition.stableKey];
        return row && (touched(row.OD) || touched(row.OS));
      });
      if (!touchedDefinitions.length) throw new Error("Capture at least one anterior structure before saving.");
      for (const definition of touchedDefinitions) {
        const field = abnormalField(definition);
        const row = captures[definition.stableKey] ?? emptyRow();
        const eyes = Object.fromEntries(EYES.flatMap((eye) => {
          const capture = row[eye];
          if (!capture.state) return [];
          return [[eye, {
            state: capture.state,
            customFields: capture.state === "abnormal" && field && capture.selections.length
              ? [{ code: field.localCode, value: capture.selections }]
              : [],
            ...(capture.other.trim() ? { other: capture.other.trim() } : {}),
          }]];
        }));
        const response = await fetch(
          `${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`,
          {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ patientReference, encounterReference, eyes }),
          },
        );
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `${definition.display} save failed: ${response.status}`);
      }
      const status = {
        completed: true,
        summary: `${touchedDefinitions.length}/9 anterior structures saved`,
        savedAt: new Date().toISOString(),
        operator: "OSOD UI ocular health",
      };
      setMessage(status.summary);
      onSaved(status, touchedDefinitions.map((definition) => definition.stableKey));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-7xl">
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 bg-bg-deep/95 pb-4 backdrop-blur">
          <div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Ocular Health</div><h2 className="mt-1 text-xl font-semibold text-white">Anterior Segment</h2><p className="mt-1 text-sm text-white/45">Choose an explicit state for each examined eye. Nothing defaults to normal.</p></div>
          <button type="button" onClick={allNormal} disabled={loading} className="rounded border border-emerald-300/50 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-300/15 disabled:opacity-40">Anterior All Normal</button>
        </div>
        {loading && <div className="py-8 text-sm text-white/45">Loading anterior findings…</div>}
        {!loading && <div className="mt-5 space-y-5">{definitions.map((definition) => {
          const field = abnormalField(definition);
          const row = captures[definition.stableKey] ?? emptyRow();
          return (
            <article id={domId(definition.stableKey)} key={definition.stableKey} className="scroll-mt-24 rounded border border-white/10 bg-bg-panel/65 p-4">
              <div className="mb-4"><h3 className="font-semibold text-white">{definition.display}</h3><p className="mt-1 text-sm text-white/45">{definition.normalTemplate}</p></div>
              <div className="grid gap-4 xl:grid-cols-2">{EYES.map((eye) => (
                <EyePanel
                  key={eye}
                  eye={eye}
                  capture={row[eye]}
                  field={field}
                  allowDeferred={definition.allowDeferred === true}
                  onState={(state) => setExamState(definition, eye, state)}
                  onSelections={(selections) => updateEye(definition.stableKey, eye, (current) => ({ ...current, selections }))}
                  onOther={(other) => updateEye(definition.stableKey, eye, (current) => ({ ...current, other }))}
                  onCopy={() => copyEye(definition, eye, eye === "OD" ? "OS" : "OD")}
                />
              ))}</div>
            </article>
          );
        })}</div>}
        <div className="sticky bottom-0 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-bg-deep/95 py-4 backdrop-blur">
          <div className="min-h-6 text-sm">{error ? <span className="text-rose-200">{error}</span> : <span className="text-white/55">{message}</span>}</div>
          <button type="button" onClick={save} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-white disabled:opacity-45">{saving ? "Saving…" : "Save Anterior Segment"}</button>
        </div>
      </div>
    </section>
  );
}

function EyePanel({ eye, capture, field, allowDeferred, onState, onSelections, onOther, onCopy }: {
  eye: Eye;
  capture: EyeCapture;
  field?: CustomFindingField;
  allowDeferred: boolean;
  onState(state: ExamState): void;
  onSelections(selections: string[]): void;
  onOther(other: string): void;
  onCopy(): void;
}) {
  const options = (field?.options ?? []).filter((option) => option.active);
  const parents = options.filter((option) => !option.parentCode);
  const priority = parents.filter((option) => option.priority);
  const additional = parents.filter((option) => !option.priority);
  return (
    <div className="rounded border border-white/10 bg-bg-deep/60 p-4">
      <div className="flex items-center justify-between"><span className="text-sm font-semibold text-white">{eye}</span><button type="button" onClick={onCopy} className="rounded border border-white/15 px-2 py-1 text-xs text-white/55 hover:text-white">{eye === "OD" ? "Copy to OS →" : "← Copy to OD"}</button></div>
      <div className="mt-3 flex flex-wrap gap-2">
        <StateButton label="Normal" selected={capture.state === "normal"} onClick={() => onState("normal")} />
        <StateButton label="Abnormal" selected={capture.state === "abnormal"} onClick={() => onState("abnormal")} />
        {allowDeferred && <StateButton label="Not performed / deferred" selected={capture.state === "deferred"} onClick={() => onState("deferred")} />}
      </div>
      {capture.state === "abnormal" && field && (
        <div className="mt-4 space-y-3">
          <OptionList options={priority} allOptions={options} selected={capture.selections} onChange={onSelections} />
          {additional.length > 0 && <details><summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-white/40">More findings ({additional.length})</summary><div className="mt-3"><OptionList options={additional} allOptions={options} selected={capture.selections} onChange={onSelections} /></div></details>}
        </div>
      )}
      <label className="mt-4 block"><span className="mb-1 block text-xs uppercase tracking-wide text-white/35">Other</span><textarea value={capture.other} onChange={(event) => onOther(event.target.value)} rows={2} className="w-full rounded border border-white/15 bg-bg-deep p-2 text-sm text-white outline-none focus:border-brand" /></label>
    </div>
  );
}

function OptionList({ options, allOptions, selected, onChange }: {
  options: NonNullable<CustomFindingField["options"]>;
  allOptions: NonNullable<CustomFindingField["options"]>;
  selected: string[];
  onChange(selected: string[]): void;
}) {
  return <div className="grid gap-2 sm:grid-cols-2">{options.map((option) => {
    const children = allOptions.filter((candidate) => candidate.parentCode === option.code);
    const checked = selected.includes(option.code);
    return <div key={option.code} className="min-w-0"><label className="flex items-start gap-2 text-sm text-white/75"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked ? [...selected, option.code] : selected.filter((code) => code !== option.code && !code.startsWith(`${option.code}::`)))} className="mt-0.5 accent-brand" /><span>{option.display}</span></label>{checked && children.length > 0 && <div className="ml-6 mt-2 space-y-1 border-l border-white/10 pl-3">{children.map((child) => <label key={child.code} className="flex items-center gap-2 text-xs text-white/60"><input type="checkbox" checked={selected.includes(child.code)} onChange={(event) => onChange(event.target.checked ? [...selected, child.code] : selected.filter((code) => code !== child.code))} className="accent-brand" />{child.display}</label>)}</div>}</div>;
  })}</div>;
}

function StateButton({ label, selected, onClick }: { label: string; selected: boolean; onClick(): void }) {
  return <button type="button" onClick={onClick} className={selected ? "rounded border border-brand/70 bg-brand/20 px-3 py-1.5 text-xs font-semibold text-white" : "rounded border border-white/15 px-3 py-1.5 text-xs text-white/55 hover:border-white/30"}>{label}</button>;
}

function captureFromRows(definition: CustomFindingDefinition, rows: HistoryRow[]): Record<Eye, EyeCapture> {
  const field = abnormalField(definition);
  return Object.fromEntries(EYES.map((eye) => {
    const row = rows.find((candidate) => candidate.eye === eye);
    const value = row?.values.find((candidate) => candidate.code === field?.localCode)?.value;
    return [eye, {
      ...(row?.state ? { state: row.state } : {}),
      selections: Array.isArray(value) ? value : [],
      other: row?.other ?? "",
    }];
  })) as Record<Eye, EyeCapture>;
}

function abnormalField(definition: CustomFindingDefinition): CustomFindingField | undefined {
  return definition.customFields.find((field) => field.active && field.valueType === "multi-select");
}

function emptyCaptures(definitions: CustomFindingDefinition[]) {
  return Object.fromEntries(definitions.map((definition) => [definition.stableKey, emptyRow()]));
}

function emptyRow(): Record<Eye, EyeCapture> {
  return { OD: emptyEye(), OS: emptyEye() };
}

function emptyEye(): EyeCapture {
  return { selections: [], other: "" };
}

function touched(capture: EyeCapture): boolean {
  return Boolean(capture.state || capture.other.trim() || capture.selections.length);
}

export function copyEyeCapture(source: EyeCapture): EyeCapture {
  return { ...source, selections: [...source.selections] };
}

export function applyAnteriorAllNormal(
  definitions: Array<Pick<CustomFindingDefinition, "stableKey">>,
  captures: Record<string, Record<Eye, EyeCapture>>,
): { captures: Record<string, Record<Eye, EyeCapture>>; filled: number; skipped: number } {
  let skipped = 0;
  const next = Object.fromEntries(definitions.map((definition) => {
    const row = captures[definition.stableKey] ?? emptyRow();
    if (touched(row.OD) || touched(row.OS)) {
      skipped += 1;
      return [definition.stableKey, row];
    }
    return [definition.stableKey, {
      OD: { ...row.OD, state: "normal" as const },
      OS: { ...row.OS, state: "normal" as const },
    }];
  }));
  return { captures: next, filled: definitions.length - skipped, skipped };
}

function domId(stableKey: string): string {
  return `structure-${stableKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
