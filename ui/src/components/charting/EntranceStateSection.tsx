import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { CustomFindingDefinition, CustomFindingField } from "./CustomFindingSection";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";

interface EyeCapture {
  state?: ExamState;
  values: Record<string, string>;
  other: string;
}

interface HistoryRow {
  recordedAt: string;
  eye?: Eye;
  state?: ExamState;
  values: Array<{ label: string; value: number | string | string[]; unit?: string }>;
  other?: string;
  normalTemplate?: string;
}

const EYES: Eye[] = ["OD", "OS"];

export function EntranceStateSection({ definition, patientReference, encounterReference, onSaved }: {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}) {
  const [eyes, setEyes] = useState<Record<Eye, EyeCapture>>(() => ({ OD: emptyEye(), OS: emptyEye() }));
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fields = definition.customFields.filter((field) => field.active).sort((a, b) => a.order - b.order);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
    setLoading(true);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history?${query}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as { rows?: HistoryRow[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `${definition.display} history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then(setHistory)
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [definition.stableKey, patientReference, encounterReference, historyVersion]);

  function updateEye(eye: Eye, update: Partial<EyeCapture>) {
    setEyes((current) => ({ ...current, [eye]: { ...current[eye], ...update } }));
  }

  function setNormalOu() {
    setEyes((current) => ({
      OD: { ...current.OD, state: "normal" },
      OS: { ...current.OS, state: "normal" },
    }));
    setMessage(definition.normalTemplate ?? "Normal OU selected");
    setError(null);
  }

  async function save() {
    const populated = EYES.filter((eye) => eyes[eye].state);
    if (populated.length === 0) {
      setError("Choose Normal, Abnormal, or Deferred for at least one eye.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          eyes: Object.fromEntries(populated.map((eye) => [eye, {
            state: eyes[eye].state,
            customFields: eyes[eye].state === "deferred" ? [] : fieldValues(fields, eyes[eye].values),
            ...(eyes[eye].other.trim() ? { other: eyes[eye].other.trim() } : {}),
          }])),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `${definition.display} save failed: ${response.status}`);
      const status = {
        completed: true,
        summary: `${definition.display} saved for ${populated.join(" / ")}`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI entrance battery",
      };
      setMessage(status.summary);
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
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[color:var(--odos-line)] pb-4">
          <div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Entrance Testing</div><h2 className="mt-1 text-xl font-semibold text-[color:var(--odos-text)]">{definition.display}</h2><p className="mt-1 text-sm text-[color:var(--odos-muted)]">Choose an explicit state. Nothing defaults to normal.</p></div>
          <button type="button" onClick={setNormalOu} className="rounded border border-emerald-300/50 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-300/15">Normal OU</button>
        </div>
        {definition.normalTemplate && <div className="mt-4 rounded border border-emerald-300/20 bg-emerald-300/[0.06] px-4 py-3 text-sm text-emerald-50/80">{definition.normalTemplate}</div>}
        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {EYES.map((eye) => <div key={eye} className="rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-4">
            <div className="text-sm font-semibold text-[color:var(--odos-text)]">{eye}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["normal", "abnormal", "deferred"] as ExamState[]).map((state) => <button key={state} type="button" onClick={() => updateEye(eye, { state })} className={eyes[eye].state === state ? "rounded border border-brand/70 bg-brand/20 px-3 py-1.5 text-xs font-semibold capitalize text-[color:var(--odos-text)]" : "rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-xs capitalize text-[color:var(--odos-muted)] hover:border-brand/60"}>{state}</button>)}
            </div>
            {eyes[eye].state && eyes[eye].state !== "deferred" && <div className="mt-4 grid gap-4 sm:grid-cols-2">{fields.map((field) => <FieldControl key={field.localCode} field={field} value={eyes[eye].values[field.localCode] ?? ""} onChange={(value) => updateEye(eye, { values: { ...eyes[eye].values, [field.localCode]: value } })} />)}</div>}
            <label className="mt-4 block"><span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">Note</span><textarea value={eyes[eye].other} disabled={!eyes[eye].state} onChange={(event) => updateEye(eye, { other: event.target.value })} rows={2} className="w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-2 text-sm text-[color:var(--odos-text)] outline-none focus:border-brand disabled:opacity-45" /></label>
          </div>)}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><div className="min-h-6 text-sm">{error ? <span className="text-rose-200">{error}</span> : <span className="text-[color:var(--odos-muted)]">{message}</span>}</div><button type="button" onClick={save} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-[color:var(--odos-text)] disabled:opacity-45">{saving ? "Saving…" : `Save ${definition.display}`}</button></div>
        <History rows={history} loading={loading} />
      </div>
    </section>
  );
}

function FieldControl({ field, value, onChange }: { field: CustomFindingField; value: string; onChange(value: string): void }) {
  return <label><span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">{field.display}</span>{field.valueType === "number" ? <div className="flex overflow-hidden rounded border border-[color:var(--odos-line-2)] bg-bg-deep"><input type="number" value={value} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(event.target.value)} className="h-10 min-w-0 flex-1 bg-transparent px-3 text-[color:var(--odos-text)] outline-none" />{field.unit && <span className="flex items-center border-l border-[color:var(--odos-line)] px-3 text-xs text-[color:var(--odos-muted)]">{field.unit}</span>}</div> : <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-[color:var(--odos-text)] outline-none focus:border-brand"><option value="">Select</option>{(field.options ?? []).filter((option) => option.active).map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}</select>}</label>;
}

function History({ rows, loading }: { rows: HistoryRow[]; loading: boolean }) {
  return <div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)] bg-bg-panel/55"><div className="border-b border-[color:var(--odos-line)] px-4 py-3 text-sm font-semibold text-[color:var(--odos-text)]">History</div>{loading ? <div className="p-6 text-sm text-[color:var(--odos-muted)]">Loading history…</div> : rows.length === 0 ? <div className="p-6 text-sm text-[color:var(--odos-muted)]">No prior entries</div> : <div className="divide-y divide-white/10">{rows.map((row, index) => <div key={`${row.recordedAt}-${row.eye}-${index}`} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[90px_120px_1fr]"><div className="font-semibold text-[color:var(--odos-text)]">{row.eye}</div><div className="capitalize text-[color:var(--odos-muted)]">{row.state}</div><div className="text-[color:var(--odos-muted)]">{row.normalTemplate ?? row.values.map((value) => `${value.label}: ${Array.isArray(value.value) ? value.value.join(", ") : value.value}${value.unit ? ` ${value.unit}` : ""}`).join(" · ")}{row.other ? ` — ${row.other}` : ""}</div></div>)}</div>}</div>;
}

function fieldValues(fields: CustomFindingField[], values: Record<string, string>) {
  return fields.flatMap((field) => {
    const value = values[field.localCode]?.trim();
    if (!value) return [];
    return [{ code: field.localCode, value: field.valueType === "number" ? Number(value) : value }];
  });
}

function emptyEye(): EyeCapture {
  return { values: {}, other: "" };
}
