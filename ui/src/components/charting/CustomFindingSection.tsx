import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";

export interface CustomFindingField {
  localCode: string;
  display: string;
  valueType: "number" | "select";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ code: string; display: string; active: boolean }>;
  order: number;
  active: boolean;
}

export interface CustomFindingDefinition {
  stableKey: `custom:${string}`;
  sectionKey?: string;
  display: string;
  active: boolean;
  perEye: boolean;
  customFields: CustomFindingField[];
}

interface Props {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

interface HistoryRow {
  recordedAt: string;
  eye?: Eye;
  values: Array<{ code: string; label: string; value: number | string; unit?: string }>;
  remarks?: string;
}

const EYES: Eye[] = ["OD", "OS"];

export function CustomFindingSection({ definition, patientReference, encounterReference, onSaved }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const fields = definition.customFields.filter((field) => field.active).sort((left, right) => left.order - right.order);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true);
    setHistoryError(null);
    fetch(historyUrl(definition.stableKey, patientReference), { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { rows?: HistoryRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `Custom section history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then(setHistory)
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setHistoryError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [definition.stableKey, patientReference, historyVersion]);

  function update(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = definition.perEye
        ? {
            patientReference,
            encounterReference,
            eyes: Object.fromEntries(EYES.flatMap((eye) => {
              const customFields = fieldValues(fields, values, eye);
              return customFields.length ? [[eye, { customFields }]] : [];
            })),
            ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
          }
        : {
            patientReference,
            encounterReference,
            customFields: fieldValues(fields, values),
            ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
          };
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Custom section save failed: ${response.status}`);
      const status = {
        completed: true,
        summary: definition.perEye ? "OD/OS saved" : "Saved",
        savedAt: new Date().toISOString(),
        operator: "OSOD UI custom section",
      };
      setSaved(status);
      onSaved(status);
      setHistoryVersion((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <div className="border-b border-white/10 pb-4">
          <h2 className="text-lg font-semibold text-white">{definition.display}</h2>
          <p className="mt-1 text-sm text-white/45">Practice-created chart section</p>
        </div>
        <div className={definition.perEye ? "mt-5 grid gap-4 xl:grid-cols-2" : "mt-5 max-w-2xl"}>
          {(definition.perEye ? EYES : [undefined]).map((eye) => (
            <div key={eye ?? "record"} className="rounded border border-white/10 bg-white/[0.02] p-4">
              {eye && <div className="mb-4 text-sm font-semibold text-white">{eye}</div>}
              <div className="grid gap-4 md:grid-cols-2">
                {fields.map((field) => (
                  <CustomFieldControl
                    key={field.localCode}
                    field={field}
                    value={values[valueKey(field.localCode, eye)] ?? ""}
                    onChange={(value) => update(valueKey(field.localCode, eye), value)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <label className="mt-4 block max-w-4xl">
          <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Other / notes</span>
          <textarea value={remarks} onChange={(event) => setRemarks(event.target.value)} rows={3} className="w-full rounded border border-white/15 bg-bg-deep p-3 text-white outline-none focus:border-brand" />
        </label>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-h-10">
            {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
            {saved && !error && <div className="text-sm text-white/70">{saved.summary}<span className="ml-3 text-xs text-white/45">{saved.savedAt}</span></div>}
          </div>
          <button type="button" onClick={save} disabled={saving} className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:opacity-50">{saving ? "Saving…" : `Save ${definition.display}`}</button>
        </div>
        <div className="mt-8 overflow-hidden rounded border border-white/10 bg-bg-panel/55">
          <div className="border-b border-white/10 px-4 py-3 text-sm font-semibold text-white">History</div>
          {historyLoading && <div className="p-6 text-sm text-white/45">Loading history…</div>}
          {!historyLoading && historyError && <div className="p-6 text-sm text-rose-300">{historyError}</div>}
          {!historyLoading && !historyError && history.length === 0 && <div className="p-6 text-sm text-white/45">No prior entries</div>}
          {!historyLoading && !historyError && history.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-white/35"><tr><th className="px-4 py-3">Date</th>{definition.perEye && <th className="px-4 py-3">Eye</th>}<th className="px-4 py-3">Values</th><th className="px-4 py-3">Other / notes</th></tr></thead>
                <tbody>{history.map((row, index) => <tr key={`${row.recordedAt}-${row.eye ?? "record"}-${index}`} className="border-t border-white/10"><td className="px-4 py-3 text-white/65">{formatDate(row.recordedAt)}</td>{definition.perEye && <td className="px-4 py-3 text-white/75">{row.eye}</td>}<td className="px-4 py-3 text-white/75">{row.values.map((value) => `${value.label}: ${value.value}${value.unit ? ` ${value.unit}` : ""}`).join(" · ") || "—"}</td><td className="px-4 py-3 text-white/55">{row.remarks ?? "—"}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CustomFieldControl({ field, value, onChange }: {
  field: CustomFindingField;
  value: string;
  onChange(value: string): void;
}) {
  const hint = [
    field.min !== undefined ? `min ${field.min}` : "",
    field.max !== undefined ? `max ${field.max}` : "",
    field.step !== undefined ? `step ${field.step}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{field.display}</span>
      {field.valueType === "number" ? (
        <div className="flex overflow-hidden rounded border border-white/15 bg-bg-deep focus-within:border-brand">
          <input type="number" value={value} min={field.min} max={field.max} step={field.step ?? "any"} onChange={(event) => onChange(event.target.value)} className="h-11 min-w-0 flex-1 bg-transparent px-3 text-white outline-none" />
          {field.unit && <span className="flex items-center border-l border-white/10 px-3 text-sm text-white/45">{field.unit}</span>}
        </div>
      ) : (
        <select value={value} onChange={(event) => onChange(event.target.value)} className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand">
          <option value="">Select</option>
          {(field.options ?? []).filter((option) => option.active).map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}
        </select>
      )}
      {hint && <span className="mt-1 block text-xs text-white/30">{hint}</span>}
    </label>
  );
}

function fieldValues(fields: CustomFindingField[], values: Record<string, string>, eye?: Eye) {
  return fields.flatMap((field) => {
    const raw = values[valueKey(field.localCode, eye)]?.trim();
    if (!raw) return [];
    return [{ code: field.localCode, value: field.valueType === "number" ? Number(raw) : raw }];
  });
}

function valueKey(code: string, eye?: Eye): string {
  return `${eye ?? "record"}:${code}`;
}

function historyUrl(stableKey: string, patientReference: string): string {
  return `${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(stableKey)}/history?${new URLSearchParams({ patient: patientReference })}`;
}


function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
