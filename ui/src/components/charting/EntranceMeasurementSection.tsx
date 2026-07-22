import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { CustomFindingDefinition, CustomFindingField } from "./CustomFindingSection";
import { PowerDropdown } from "./PowerDropdown";
import { numericOptions } from "./power-options";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
const EYES: Eye[] = ["OD", "OS"];

interface HistoryRow {
  recordedAt: string;
  eye?: Eye;
  values: Array<{ label: string; value: number | string; unit?: string }>;
}

export function EntranceMeasurementSection({ definition, patientReference, encounterReference, onSaved }: {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fields = useMemo(() => definition.customFields.filter((field) => field.active).sort((a, b) => a.order - b.order), [definition.customFields]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
    fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history?${query}`, { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { rows?: HistoryRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `${definition.display} history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then(setHistory)
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => controller.abort();
  }, [definition.stableKey, patientReference, encounterReference, historyVersion]);

  function setValue(eye: Eye, field: CustomFindingField, value: string) {
    setValues((current) => ({ ...current, [`${eye}:${field.localCode}`]: value }));
  }

  async function save() {
    const eyes = Object.fromEntries(EYES.flatMap((eye) => {
      const customFields = fields.flatMap((field) => {
        const value = values[`${eye}:${field.localCode}`]?.trim();
        return value ? [{ code: field.localCode, value: field.valueType === "number" ? Number(value) : value }] : [];
      });
      return customFields.length ? [[eye, { customFields }]] : [];
    }));
    if (Object.keys(eyes).length === 0) {
      setError(`Enter at least one ${definition.display} value before saving.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ patientReference, encounterReference, eyes }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `${definition.display} save failed: ${response.status}`);
      const status = { completed: true, summary: `${definition.display} saved`, savedAt: new Date().toISOString(), operator: "ODOS UI entrance measurements" };
      setMessage(status.summary);
      onSaved(status);
      setHistoryVersion((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return <section className="h-full overflow-y-auto p-6"><div className="max-w-[1380px]"><div className="border-b border-[color:var(--odos-line)] pb-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Entrance Testing</div><h2 className="mt-1 text-xl font-semibold text-[color:var(--odos-text)]">{definition.display}</h2><p className="mt-1 text-sm text-[color:var(--odos-muted)]">Per-eye measurements; no normal state is inferred.</p></div><div className="mt-5 overflow-x-auto rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)]"><div className={`grid ${fields.length === 3 ? "grid-cols-[54px_repeat(3,minmax(150px,220px))]" : "grid-cols-[54px_repeat(5,minmax(130px,190px))]"} gap-2 bg-bg-panel/55 px-4 py-2 text-xs uppercase tracking-widest text-[color:var(--odos-faint)]`}><div>Eye</div>{fields.map((field) => <div key={field.localCode}>{field.display}</div>)}</div>{EYES.map((eye) => <div key={eye} className={`grid ${fields.length === 3 ? "grid-cols-[54px_repeat(3,minmax(150px,220px))]" : "grid-cols-[54px_repeat(5,minmax(130px,190px))]"} items-center gap-2 border-t border-[color:var(--odos-line)] px-4 py-3`}><div className="text-sm font-semibold text-[color:var(--odos-text)]">{eye}</div>{fields.map((field) => <MeasurementControl key={field.localCode} field={field} value={values[`${eye}:${field.localCode}`] ?? ""} onChange={(value) => setValue(eye, field, value)} />)}</div>)}</div><div className="mt-5 flex items-center justify-between gap-3"><div className="text-sm">{error ? <span className="text-rose-200">{error}</span> : <span className="text-[color:var(--odos-muted)]">{message}</span>}</div><button type="button" onClick={save} disabled={saving} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-[color:var(--odos-text)] disabled:opacity-45">{saving ? "Saving…" : `Save ${definition.display}`}</button></div><div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)] bg-bg-panel/55"><div className="border-b border-[color:var(--odos-line)] px-4 py-3 text-sm font-semibold text-[color:var(--odos-text)]">History</div>{history.length === 0 ? <div className="p-6 text-sm text-[color:var(--odos-muted)]">No prior entries</div> : <div className="divide-y divide-white/10">{history.map((row, index) => <div key={`${row.recordedAt}-${row.eye}-${index}`} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[90px_1fr]"><div className="font-semibold text-[color:var(--odos-text)]">{row.eye}</div><div className="text-[color:var(--odos-muted)]">{row.values.map((value) => `${value.label}: ${value.value}${value.unit ? ` ${value.unit}` : ""}`).join(" · ")}</div></div>)}</div>}</div></div></section>;
}

function MeasurementControl({ field, value, onChange }: { field: CustomFindingField; value: string; onChange(value: string): void }) {
  if (field.valueType === "number" && field.localCode.includes("AXIS")) {
    return <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-2 text-sm text-[color:var(--odos-text)] outline-none focus:border-brand"><option value="">Select</option>{numericOptions(undefined, field.min ?? 0, field.max ?? 180, field.step ?? 1).map((option) => <option key={option} value={option}>{option}°</option>)}</select>;
  }
  if (field.valueType === "number") {
    const options = numericOptions(undefined, field.min ?? 0, field.max ?? 100, field.step ?? 1);
    const defaultValue = field.localCode === "CUSTOM_CCT" ? "540" : "43.50";
    return <PowerDropdown value={value} options={options} defaultValue={defaultValue} onChange={onChange} ariaLabel={field.display} />;
  }
  if (field.valueType === "select") {
    return <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-2 text-sm text-[color:var(--odos-text)] outline-none focus:border-brand"><option value="">Select</option>{(field.options ?? []).filter((option) => option.active).map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}</select>;
  }
  return <input type="time" value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm text-[color:var(--odos-text)] outline-none focus:border-brand" />;
}
