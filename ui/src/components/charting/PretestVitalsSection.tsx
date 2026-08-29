import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { CAROTENOID_COLOR_BANDS, carotenoidPresentation } from "../../lib/carotenoid-score";
import { SerialTrendChart } from "./SerialTrendChart";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

interface BloodPressureReading {
  observationReference: string;
  encounterReference?: string;
  recordedAt: string;
  systolic: number;
  diastolic: number;
  cuffSite: string;
  position: string;
}

interface CarotenoidReading {
  observationReference: string;
  encounterReference?: string;
  recordedAt: string;
  score: number;
  device: string;
}

interface BodyMeasurementReading {
  observationReference: string;
  encounterReference?: string;
  recordedAt: string;
  value: number;
  unit: string;
  code: string;
}

interface History {
  bloodPressure: BloodPressureReading[];
  carotenoid: CarotenoidReading[];
  height: BodyMeasurementReading | null;
  weight: BodyMeasurementReading | null;
}

export function PretestVitalsSection({ patientReference, encounterReference, onSaved }: Props) {
  const [history, setHistory] = useState<History>({ bloodPressure: [], carotenoid: [], height: null, weight: null });
  const [systolic, setSystolic] = useState("");
  const [diastolic, setDiastolic] = useState("");
  const [cuffSite, setCuffSite] = useState("");
  const [position, setPosition] = useState("");
  const [bpTime, setBpTime] = useState("");
  const [height, setHeight] = useState("");
  const [weight, setWeight] = useState("");
  const [bodyMeasurementsTime, setBodyMeasurementsTime] = useState("");
  const [score, setScore] = useState("");
  const [scoreTime, setScoreTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function load() {
    const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/pretest-vitals/history?patient=${encodeURIComponent(patientReference)}`, { headers: authHeaders() });
    const body = await response.json() as History & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Pretest vitals history failed: ${response.status}`);
    setHistory({
      bloodPressure: body.bloodPressure ?? [],
      carotenoid: body.carotenoid ?? [],
      height: body.height ?? null,
      weight: body.weight ?? null,
    });
  }

  useEffect(() => { void load().catch((caught) => setError(message(caught))); }, [patientReference]);

  async function saveBloodPressure() {
    const sys = Number(systolic);
    const dia = Number(diastolic);
    if (!Number.isInteger(sys) || !Number.isInteger(dia)) {
      setError("Enter systolic and diastolic before saving.");
      return;
    }
    const saved = await save("blood-pressure", {
      patientReference, encounterReference, systolic: sys, diastolic: dia,
      ...(cuffSite.trim() ? { cuffSite: cuffSite.trim() } : {}),
      ...(position ? { position } : {}),
      ...(iso(bpTime) ? { recordedAt: iso(bpTime) } : {}),
    }, `BP ${sys}/${dia}`);
    if (saved) { setSystolic(""); setDiastolic(""); }
  }

  async function saveCarotenoid() {
    const value = Number(score);
    if (!Number.isInteger(value)) { setError("Enter a whole-number skin carotenoid score before saving."); return; }
    const saved = await save("carotenoid", {
      patientReference, encounterReference, score: value, ...(iso(scoreTime) ? { recordedAt: iso(scoreTime) } : {}),
    }, `Skin carotenoid ${value.toLocaleString()}`);
    if (saved) setScore("");
  }

  async function saveBodyMeasurements() {
    const heightValue = Number(height);
    const weightValue = Number(weight);
    if (!Number.isFinite(heightValue) || heightValue <= 0 || !Number.isFinite(weightValue) || weightValue <= 0) {
      setError("Enter a positive height and weight before saving.");
      return;
    }
    const saved = await save("body-measurements", {
      patientReference,
      encounterReference,
      height: { value: heightValue, unit: "in" },
      weight: { value: weightValue, unit: "lb" },
      ...(iso(bodyMeasurementsTime) ? { recordedAt: iso(bodyMeasurementsTime) } : {}),
    }, `Height ${heightValue} in · Weight ${weightValue} lb`);
    if (saved) { setHeight(""); setWeight(""); }
  }

  async function save(kind: string, body: unknown, summary: string): Promise<boolean> {
    setSaving(true); setError(undefined);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/pretest-vitals/${kind}`, {
        method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Save failed: ${response.status}`);
      await load();
      onSaved({ completed: true, summary, savedAt: new Date().toISOString(), operator: "ODOS UI pretest vitals" });
      return true;
    } catch (caught) { setError(message(caught)); return false; } finally { setSaving(false); }
  }

  const bpSeries = useMemo(() => [
    { id: "systolic", label: "Systolic", color: "var(--odos-alert)", points: history.bloodPressure.map((row) => ({ id: `${row.observationReference}-s`, x: Date.parse(row.recordedAt), value: row.systolic, title: bloodPressureSummary(row) })) },
    { id: "diastolic", label: "Diastolic", color: "var(--odos-sapphire)", points: history.bloodPressure.map((row) => ({ id: `${row.observationReference}-d`, x: Date.parse(row.recordedAt), value: row.diastolic, title: bloodPressureSummary(row) })) },
  ], [history.bloodPressure]);
  const carotenoidSeries = useMemo(() => [{ id: "score", label: "Score", color: "var(--odos-text)", points: history.carotenoid.map((row) => {
    const presentation = carotenoidPresentation(row.score);
    return { id: row.observationReference, x: Date.parse(row.recordedAt), value: row.score, title: `${row.score.toLocaleString()} · ${presentation.label} · ${presentation.color}` };
  }) }], [history.carotenoid]);

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header><h2 className="text-lg font-semibold text-[color:var(--odos-text)]">Pretest vitals + BioPhotonic score</h2><p className="text-sm text-[color:var(--odos-muted)]">Repeat readings are retained as separate observations.</p></header>
        {error && <p role="alert" className="rounded border border-[color:var(--odos-alert)] bg-[color-mix(in_srgb,var(--odos-alert)_10%,transparent)] p-3 text-sm text-[color:var(--odos-text)]">{error}</p>}
        <div className="grid gap-6 xl:grid-cols-2">
          <article className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4">
            <h3 className="font-semibold text-[color:var(--odos-text)]">Blood pressure</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Systolic (mmHg)"><input aria-label="Systolic blood pressure" type="number" min="30" max="300" value={systolic} onChange={(e) => setSystolic(e.target.value)} /></Field>
              <Field label="Diastolic (mmHg)"><input aria-label="Diastolic blood pressure" type="number" min="20" max="200" value={diastolic} onChange={(e) => setDiastolic(e.target.value)} /></Field>
              <Field label="Cuff arm / site"><input aria-label="Blood pressure cuff site" value={cuffSite} onChange={(e) => setCuffSite(e.target.value)} placeholder="Left upper arm" /></Field>
              <Field label="Patient position"><select aria-label="Patient position" value={position} onChange={(e) => setPosition(e.target.value)}><option value="">Not recorded</option><option value="sitting">Sitting</option><option value="standing">Standing</option></select></Field>
              <Field label="Time"><input aria-label="Blood pressure time" type="datetime-local" value={bpTime} onChange={(e) => setBpTime(e.target.value)} /></Field>
            </div>
            <button type="button" disabled={saving} onClick={() => void saveBloodPressure()} className="mt-4 rounded bg-brand px-4 py-2 text-sm font-semibold text-[color:var(--odos-accent-ink)]">Save blood pressure</button>
          </article>
          <article className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4">
            <h3 className="font-semibold text-[color:var(--odos-text)]">Height and weight</h3>
            <p className="mt-1 text-xs text-[color:var(--odos-muted)]">Stored as separate vital-sign Observations from one capture.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Height (in)"><input aria-label="Height in inches" type="number" min="0" step="0.01" value={height} onChange={(e) => setHeight(e.target.value)} /></Field>
              <Field label="Weight (lb)"><input aria-label="Weight in pounds" type="number" min="0" step="0.01" value={weight} onChange={(e) => setWeight(e.target.value)} /></Field>
              <Field label="Time"><input aria-label="Height and weight time" type="datetime-local" value={bodyMeasurementsTime} onChange={(e) => setBodyMeasurementsTime(e.target.value)} /></Field>
            </div>
            <button type="button" disabled={saving} onClick={() => void saveBodyMeasurements()} className="mt-4 rounded bg-brand px-4 py-2 text-sm font-semibold text-[color:var(--odos-accent-ink)]">Save height and weight</button>
          </article>
          <article className="rounded border border-[color:var(--odos-line)] bg-[var(--odos-surface)] p-4">
            <h3 className="font-semibold text-[color:var(--odos-text)]">BioPhotonic skin carotenoid score</h3>
            <p className="mt-1 text-xs text-[color:var(--odos-muted)]">Device: Nu Skin Pharmanex S3 · score stored as a unitless integer</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label="Score"><input aria-label="Skin carotenoid score" type="number" min={10_000} max={90_000} step="1" value={score} onChange={(e) => setScore(e.target.value)} /></Field>
              <Field label="Time"><input aria-label="Skin carotenoid score time" type="datetime-local" value={scoreTime} onChange={(e) => setScoreTime(e.target.value)} /></Field>
            </div>
            <button type="button" disabled={saving} onClick={() => void saveCarotenoid()} className="mt-4 rounded bg-brand px-4 py-2 text-sm font-semibold text-[color:var(--odos-accent-ink)]">Save score</button>
          </article>
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <div><h3 className="mb-2 font-semibold text-[color:var(--odos-text)]">Blood pressure trend</h3><SerialTrendChart ariaLabel="Blood pressure trend" series={bpSeries} xFormat={formatDate} yFormat={(v) => `${Math.round(v)}`} emptyText="Blood pressure not recorded" overlays={[
            { kind: "line", id: "s1", label: "Adult Stage 1 systolic threshold · 130 mmHg", value: 130, color: "var(--odos-amber)" },
            { kind: "line", id: "d1", label: "Adult Stage 1 diastolic threshold · 80 mmHg", value: 80, color: "var(--odos-gold)" },
          ]} /><p className="mt-2 text-xs text-[color:var(--odos-faint)]">A single reading does not diagnose hypertension; guideline classification uses averaged repeat measurements on separate occasions.</p></div>
          <div><h3 className="mb-2 font-semibold text-[color:var(--odos-text)]">Skin carotenoid trend</h3><SerialTrendChart ariaLabel="Skin carotenoid score trend" series={carotenoidSeries} xFormat={formatDate} yFormat={(v) => Math.round(v).toLocaleString()} yDomain={[10_000, 90_000]} emptyText="Skin carotenoid score not recorded" overlays={CAROTENOID_COLOR_BANDS.map((band) => ({ kind: "band" as const, id: band.color, label: `${band.color} · ${band.min.toLocaleString()}–${band.max.toLocaleString()}`, lower: band.min, upper: band.max, color: band.hex }))} /></div>
        </div>
        <HistoryList history={history} />
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1 text-xs text-[color:var(--odos-muted)]"><span>{label}</span>{children}</label>; }
function iso(value: string): string | undefined { return value ? new Date(value).toISOString() : undefined; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function formatDate(value: number): string { return new Date(value).toLocaleDateString(); }
function bloodPressureSummary(row: BloodPressureReading): string {
  return [`${row.systolic}/${row.diastolic} mmHg`, row.cuffSite, row.position].filter(Boolean).join(" · ");
}
function HistoryList({ history }: { history: History }) {
  return <div className="grid gap-6 xl:grid-cols-2">
    <article><h3 className="font-semibold text-[color:var(--odos-text)]">Latest height and weight</h3><div className="mt-2 space-y-1 text-sm text-[color:var(--odos-muted)]">
      <p>{history.height ? `${history.height.value} ${history.height.unit} · ${new Date(history.height.recordedAt).toLocaleString()}` : "Height not recorded"}</p>
      <p>{history.weight ? `${history.weight.value} ${history.weight.unit} · ${new Date(history.weight.recordedAt).toLocaleString()}` : "Weight not recorded"}</p>
    </div></article>
    <article><h3 className="font-semibold text-[color:var(--odos-text)]">Blood pressure readings</h3>{history.bloodPressure.length ? <ul className="mt-2 space-y-1 text-sm text-[color:var(--odos-muted)]">{history.bloodPressure.map((row) => <li key={row.observationReference}>{bloodPressureSummary(row)} · {new Date(row.recordedAt).toLocaleString()}</li>)}</ul> : <p className="mt-2 text-sm text-[color:var(--odos-faint)]">Blood pressure not recorded</p>}</article>
    <article><h3 className="font-semibold text-[color:var(--odos-text)]">Skin carotenoid readings</h3>{history.carotenoid.length ? <ul className="mt-2 space-y-1 text-sm text-[color:var(--odos-muted)]">{history.carotenoid.map((row) => { const p = carotenoidPresentation(row.score); return <li key={row.observationReference}><i className="mr-2 inline-block h-3 w-3 rounded-full" style={{ background: CAROTENOID_COLOR_BANDS.find((band) => band.color === p.color)?.hex }} />{row.score.toLocaleString()} · {p.label} · {p.color} · {new Date(row.recordedAt).toLocaleString()}</li>; })}</ul> : <p className="mt-2 text-sm text-[color:var(--odos-faint)]">Skin carotenoid score not recorded</p>}</article>
  </div>;
}
