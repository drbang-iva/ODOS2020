import { useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { CustomFindingDefinition } from "./CustomFindingSection";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";
type Zone = "upper-left" | "upper-right" | "center" | "lower-left" | "lower-right";

interface EyeCapture {
  state?: ExamState;
  defects: Record<Zone, boolean>;
  method: string;
  unable: boolean;
  note: string;
}

interface HistoryRow {
  recordedAt: string;
  eye?: Eye;
  state?: ExamState;
  values: Array<{ label: string; value: number | string | string[] }>;
  other?: string;
  normalTemplate?: string;
}

const EYES: Eye[] = ["OD", "OS"];
const ZONES: Array<{ zone: Zone; label: string; code: string; position: string }> = [
  { zone: "upper-left", label: "Upper-left", code: "CUSTOM_CVF_UPPER_LEFT", position: "col-start-1 row-start-1" },
  { zone: "upper-right", label: "Upper-right", code: "CUSTOM_CVF_UPPER_RIGHT", position: "col-start-3 row-start-1" },
  { zone: "center", label: "Center", code: "CUSTOM_CVF_CENTER", position: "col-start-2 row-start-2" },
  { zone: "lower-left", label: "Lower-left", code: "CUSTOM_CVF_LOWER_LEFT", position: "col-start-1 row-start-3" },
  { zone: "lower-right", label: "Lower-right", code: "CUSTOM_CVF_LOWER_RIGHT", position: "col-start-3 row-start-3" },
];

export function CvfSection({ definition, patientReference, encounterReference, onSaved }: {
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
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

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
        if (!response.ok) throw new Error(body.error ?? `CVF history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then(setHistory)
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [definition.stableKey, encounterReference, historyVersion, patientReference]);

  function updateEye(eye: Eye, update: Partial<EyeCapture>) {
    setEyes((current) => ({ ...current, [eye]: { ...current[eye], ...update } }));
  }

  function setNormalOu() {
    setEyes((current) => ({
      OD: { ...current.OD, state: "normal" },
      OS: { ...current.OS, state: "normal" },
    }));
    setError(undefined);
    setMessage(definition.normalTemplate ?? "Full fields OU");
  }

  async function save() {
    const populated = EYES.filter((eye) => eyes[eye].state);
    if (populated.length === 0) {
      setError("Choose Normal, Abnormal, or Deferred for at least one eye.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          eyes: Object.fromEntries(populated.map((eye) => [eye, eyePayload(eyes[eye])])),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `CVF save failed: ${response.status}`);
      const status = { completed: true, summary: `CVF saved for ${populated.join(" / ")}`, savedAt: new Date().toISOString(), operator: "ODOS UI CVF" };
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
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[color:var(--odos-line)] pb-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Entrance Testing</div>
            <h2 className="mt-1 text-xl font-semibold">Confrontation visual fields</h2>
            <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Mark defects directly on the five-zone field for each eye.</p>
          </div>
          <button type="button" onClick={setNormalOu} className="rounded border border-emerald-300/50 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100">Full to finger counting OU</button>
        </header>
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {EYES.map((eye) => {
            const capture = eyes[eye];
            return (
              <div key={eye} className="rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-semibold">{eye}</h3>
                  <div className="flex gap-2">
                    {(["normal", "abnormal", "deferred"] as ExamState[]).map((state) => (
                      <button key={state} type="button" onClick={() => updateEye(eye, { state })} className={capture.state === state ? "rounded border border-brand bg-brand/20 px-3 py-1.5 text-xs capitalize" : "rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-xs capitalize text-[color:var(--odos-muted)]"}>{state}</button>
                    ))}
                  </div>
                </div>
                {capture.state === "abnormal" && (
                  <div className="mt-4">
                    <ZoneGrid eye={eye} capture={capture} update={(update) => updateEye(eye, update)} />
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <label className="text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">
                        Method
                        <select value={capture.method} disabled={capture.unable} onChange={(event) => updateEye(eye, { method: event.target.value })} className="mt-1 h-10 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm normal-case text-[color:var(--odos-text)] disabled:opacity-45">
                          <option value="">Select</option>
                          <option value="finger-count">Finger count</option>
                          <option value="hand-motion">Hand motion</option>
                        </select>
                      </label>
                      <label className="flex min-h-10 items-center gap-3 self-end rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm">
                        <input type="checkbox" checked={capture.unable} onChange={(event) => updateEye(eye, { unable: event.target.checked })} />
                        Unable to test
                      </label>
                    </div>
                  </div>
                )}
                <label className="mt-4 block text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">
                  Note
                  <textarea value={capture.note} disabled={!capture.state} onChange={(event) => updateEye(eye, { note: event.target.value })} rows={2} className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-2 text-sm normal-case text-[color:var(--odos-text)] disabled:opacity-45" />
                </label>
              </div>
            );
          })}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">{error ? <span className="text-rose-200">{error}</span> : <span className="text-[color:var(--odos-muted)]">{message}</span>}</div>
          <button type="button" onClick={() => void save()} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold disabled:opacity-45">{saving ? "Saving…" : "Save CVF"}</button>
        </div>
        <History rows={history} loading={loading} />
      </div>
    </section>
  );
}

function ZoneGrid({ eye, capture, update }: { eye: Eye; capture: EyeCapture; update(update: Partial<EyeCapture>): void }) {
  return (
    <div className="mx-auto max-w-md">
      <div className="relative aspect-square overflow-hidden rounded-full border border-[color:var(--odos-overlay-line-2)] bg-bg-deep/85 p-5">
        <div aria-hidden="true" className="absolute inset-x-5 top-1/2 h-px bg-[color:var(--odos-overlay-line)]" />
        <div aria-hidden="true" className="absolute inset-y-5 left-1/2 w-px bg-[color:var(--odos-overlay-line)]" />
        <div className="relative z-10 grid h-full grid-cols-3 grid-rows-3 gap-3">
          {ZONES.map(({ zone, label, position }) => {
            const marked = capture.defects[zone];
            return (
              <button
                key={zone}
                type="button"
                aria-label={`${eye} ${zone} field, ${marked ? "marked defect" : "unmarked"}`}
                aria-pressed={marked}
                disabled={capture.unable}
                onClick={() => update({ defects: { ...capture.defects, [zone]: !marked } })}
                className={`${position} min-h-16 rounded-xl border px-2 py-2 text-xs font-semibold transition disabled:opacity-35 ${marked ? "border-rose-300/70 bg-rose-400/25 text-rose-50" : "border-emerald-300/35 bg-emerald-300/[0.08] text-emerald-100 hover:bg-emerald-300/[0.14]"}`}
              >
                <span className="block">{label}</span>
                <span className="mt-1 block text-[10px] uppercase tracking-wide">{marked ? "Defect" : "Clear"}</span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-[color:var(--odos-muted)]">Select a zone to toggle clear / defect.</p>
    </div>
  );
}

function History({ rows, loading }: { rows: HistoryRow[]; loading: boolean }) {
  return (
    <div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)] bg-bg-panel/55">
      <div className="border-b border-[color:var(--odos-line)] px-4 py-3 font-semibold">History</div>
      {loading ? <div className="p-5 text-sm text-[color:var(--odos-muted)]">Loading history…</div> : rows.length === 0 ? <div className="p-5 text-sm text-[color:var(--odos-muted)]">No prior entries</div> : rows.map((row, index) => (
        <div key={`${row.recordedAt}-${row.eye}-${index}`} className="grid gap-2 border-b border-[color:var(--odos-line)] px-4 py-3 text-sm md:grid-cols-[70px_100px_1fr]">
          <span className="font-semibold">{row.eye}</span>
          <span className="capitalize text-[color:var(--odos-muted)]">{row.state}</span>
          <span className="text-[color:var(--odos-muted)]">{row.normalTemplate ?? row.values.map((entry) => `${entry.label}: ${Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}`).join(" · ")}{row.other ? ` — ${row.other}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

function eyePayload(capture: EyeCapture) {
  const customFields = capture.state === "abnormal" ? [
    ...ZONES.map(({ zone, code }) => ({ code, value: capture.defects[zone] ? "restricted" : "full" })),
    ...(capture.method ? [{ code: "CUSTOM_CVF_METHOD", value: capture.method }] : []),
    ...(capture.unable ? [{ code: "CUSTOM_CVF_UNABLE", value: "yes" }] : []),
  ] : [];
  return {
    state: capture.state,
    customFields,
    ...(capture.note.trim() ? { other: capture.note.trim() } : {}),
  };
}

function emptyEye(): EyeCapture {
  return {
    defects: { "upper-left": false, "upper-right": false, center: false, "lower-left": false, "lower-right": false },
    method: "",
    unable: false,
    note: "",
  };
}
