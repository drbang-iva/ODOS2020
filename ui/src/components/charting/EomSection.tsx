import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { CustomFindingDefinition } from "./CustomFindingSection";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";
type Position = "up-left" | "up" | "up-right" | "left" | "primary" | "right" | "down-left" | "down" | "down-right";
const POSITIONS: Array<{ code: Position; label: string }> = [
  { code: "up-left", label: "Up left" }, { code: "up", label: "Up" }, { code: "up-right", label: "Up right" },
  { code: "left", label: "Left" }, { code: "primary", label: "Primary" }, { code: "right", label: "Right" },
  { code: "down-left", label: "Down left" }, { code: "down", label: "Down" }, { code: "down-right", label: "Down right" },
];
const MOVEMENTS = ["-4", "-3", "-2", "-1", "0", "+1", "+2", "+3", "+4"];
interface HistoryRow { recordedAt: string; state: string; summary: string }

export function EomSection({ definition: _definition, patientReference, encounterReference, onSaved }: {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}) {
  const [state, setState] = useState<ExamState>();
  const [eyes, setEyes] = useState<Record<Eye, Partial<Record<Position, string>>>>({ OD: {}, OS: {} });
  const [nystagmus, setNystagmus] = useState(false);
  const [nystagmusNote, setNystagmusNote] = useState("");
  const [diplopia, setDiplopia] = useState(false);
  const [diplopiaType, setDiplopiaType] = useState<"monocular" | "binocular">("binocular");
  const [direction, setDirection] = useState("horizontal");
  const [comitancy, setComitancy] = useState<"comitant" | "incomitant">("comitant");
  const [worstGaze, setWorstGaze] = useState<Position>("primary");
  const [frequency, setFrequency] = useState("intermittent");
  const [onset, setOnset] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
    fetch(`${clinicalGraphApiBase()}/clinical-graph/eom/history?${query}`, { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => { const body = await response.json() as { rows?: HistoryRow[]; error?: string }; if (!response.ok) throw new Error(body.error); return body.rows ?? []; })
      .then(setHistory)
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => controller.abort();
  }, [patientReference, encounterReference, version]);

  function fullOu() {
    setState("normal");
    setError(undefined);
  }

  async function save() {
    if (!state) { setError("Choose Normal, Abnormal, or Deferred."); return; }
    setSaving(true); setError(undefined);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/eom`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference, encounterReference, state,
          ...(state === "abnormal" ? {
            eyes: Object.fromEntries((["OD", "OS"] as Eye[]).flatMap((eye) => Object.keys(eyes[eye]).length ? [[eye, eyes[eye]]] : [])),
            nystagmus: { present: nystagmus, ...(nystagmus && nystagmusNote.trim() ? { note: nystagmusNote.trim() } : {}) },
            diplopia: diplopia ? { present: true, type: diplopiaType, direction, comitancy, worstGaze, frequency, ...(onset ? { onset } : {}), ...(note.trim() ? { note: note.trim() } : {}) } : { present: false },
          } : {}),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `EOM save failed: ${response.status}`);
      const status = { completed: true, summary: state === "normal" ? "Full OU — SAFE" : `EOM ${state}`, savedAt: new Date().toISOString(), operator: "ODOS UI EOM" };
      onSaved(status); setVersion((current) => current + 1);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setSaving(false); }
  }

  return <section className="h-full overflow-y-auto p-6"><div className="max-w-6xl"><header className="flex flex-wrap items-start justify-between gap-4 border-b border-[color:var(--odos-line)] pb-4"><div><div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Entrance Testing</div><h2 className="mt-1 text-xl font-semibold text-[color:var(--odos-text)]">EOM / diplopia</h2><p className="mt-1 text-sm text-[color:var(--odos-muted)]">Nine-position motility, nystagmus, and structured diplopia findings.</p></div><button type="button" onClick={fullOu} className="rounded border border-emerald-300/50 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100">Full OU — SAFE</button></header><div className="mt-4 flex gap-2">{(["normal", "abnormal", "deferred"] as ExamState[]).map((value) => <button type="button" key={value} onClick={() => setState(value)} className={state === value ? "rounded border border-brand bg-brand/20 px-3 py-2 text-sm capitalize" : "rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-sm capitalize text-[color:var(--odos-muted)]"}>{value}</button>)}</div>{state === "abnormal" && <><div className="mt-5 grid gap-5 xl:grid-cols-2">{(["OD", "OS"] as Eye[]).map((eye) => <div key={eye} className="rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-4"><h3 className="font-semibold">{eye} nine-position gaze</h3><div className="mt-3 grid grid-cols-3 gap-2">{POSITIONS.map((position) => <label key={position.code} className="text-xs text-[color:var(--odos-muted)]">{position.label}<select aria-label={`${eye} ${position.label}`} value={eyes[eye][position.code] ?? ""} onChange={(event) => setEyes((current) => ({ ...current, [eye]: { ...current[eye], [position.code]: event.target.value } }))} className="mt-1 h-9 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-2 text-[color:var(--odos-text)]"><option value="">—</option>{MOVEMENTS.map((movement) => <option key={movement}>{movement}</option>)}</select></label>)}</div></div>)}</div><div className="mt-5 rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-4"><label className="flex items-center gap-2"><input type="checkbox" checked={nystagmus} onChange={(event) => setNystagmus(event.target.checked)} />Nystagmus present</label>{nystagmus && <textarea aria-label="Nystagmus note" value={nystagmusNote} onChange={(event) => setNystagmusNote(event.target.value)} className="mt-3 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-2" />}</div><div className="mt-5 rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-4"><label className="flex items-center gap-2"><input type="checkbox" checked={diplopia} onChange={(event) => setDiplopia(event.target.checked)} />Diplopia present</label>{diplopia && <div className="mt-3 grid gap-3 md:grid-cols-3"><Select label="Type" value={diplopiaType} values={["monocular", "binocular"]} onChange={(value) => setDiplopiaType(value as typeof diplopiaType)} /><Select label="Direction" value={direction} values={["horizontal", "vertical", "oblique", "torsional"]} onChange={setDirection} /><Select label="Comitancy" value={comitancy} values={["comitant", "incomitant"]} onChange={(value) => setComitancy(value as typeof comitancy)} /><Select label="Worst gaze" value={worstGaze} values={POSITIONS.map((row) => row.code)} onChange={(value) => setWorstGaze(value as Position)} /><Select label="Frequency" value={frequency} values={["constant", "intermittent"]} onChange={setFrequency} /><label className="text-xs text-[color:var(--odos-muted)]">Onset<input type="date" value={onset} onChange={(event) => setOnset(event.target.value)} className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-2" /></label><label className="md:col-span-3 text-xs text-[color:var(--odos-muted)]">Note<textarea value={note} onChange={(event) => setNote(event.target.value)} className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-2" /></label></div>}</div></>}<div className="mt-5 flex items-center justify-between"><span className="text-sm text-rose-200">{error}</span><button type="button" onClick={() => void save()} disabled={saving} className="rounded bg-brand px-5 py-2 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save EOM"}</button></div><History rows={history} /></div></section>;
}

function Select({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange(value: string): void }) {
  return <label className="text-xs text-[color:var(--odos-muted)]">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-2 text-[color:var(--odos-text)]">{values.map((option) => <option key={option}>{option}</option>)}</select></label>;
}
function History({ rows }: { rows: HistoryRow[] }) { return <div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)]"><div className="border-b border-[color:var(--odos-line)] px-4 py-3 font-semibold">History</div>{rows.length ? rows.map((row, index) => <div key={`${row.recordedAt}-${index}`} className="border-b border-[color:var(--odos-line)] px-4 py-3 text-sm text-[color:var(--odos-muted)]"><span className="mr-3 capitalize">{row.state}</span>{row.summary}</div>) : <div className="p-5 text-sm text-[color:var(--odos-muted)]">No prior entries</div>}</div>; }
