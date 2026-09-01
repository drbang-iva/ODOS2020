import { type CSSProperties, useEffect, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { MethodField } from "../inputs/MethodField";
import type { CustomFindingDefinition } from "./CustomFindingSection";
import { DiagnosisPicker } from "./DiagnosisPicker";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";
type Quadrant = "upper-left" | "upper-right" | "lower-left" | "lower-right";

interface EyeCapture {
  state?: ExamState;
  defects: Record<Quadrant, boolean>;
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
const QUADRANTS: Array<{ quadrant: Quadrant; label: string; code: string; position: CSSProperties }> = [
  { quadrant: "upper-left", label: "Upper-left", code: "CUSTOM_CVF_UPPER_LEFT", position: { left: "0", top: "0" } },
  { quadrant: "upper-right", label: "Upper-right", code: "CUSTOM_CVF_UPPER_RIGHT", position: { right: "0", top: "0" } },
  { quadrant: "lower-left", label: "Lower-left", code: "CUSTOM_CVF_LOWER_LEFT", position: { bottom: "0", left: "0" } },
  { quadrant: "lower-right", label: "Lower-right", code: "CUSTOM_CVF_LOWER_RIGHT", position: { bottom: "0", right: "0" } },
];

export function CvfSection({ definition, fieldDefectDefinition, patientReference, encounterReference, onSaved }: {
  definition: CustomFindingDefinition;
  fieldDefectDefinition: CustomFindingDefinition;
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
            <h2 className="mt-1 text-xl font-semibold">Visual Field</h2>
            <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Record the clinical field pattern and confrontation findings without collapsing one into the other.</p>
          </div>
          <button type="button" onClick={setNormalOu} className="rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)] px-4 py-2 text-sm font-semibold text-[color:var(--odos-text)]">Full to finger counting OU</button>
        </header>
        <div className="mt-7 border-t border-[color:var(--odos-line)] pt-5">
          <h3 className="font-semibold">Confrontation Fields</h3>
          <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Mark defects directly on the four-quadrant field for each eye.</p>
        </div>
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {EYES.map((eye) => {
            const capture = eyes[eye];
            return (
              <div key={eye} className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4">
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
                    <MethodField
                      label="Method"
                      renderValueControl={() => (
                        <QuadrantGrid eye={eye} capture={capture} update={(update) => updateEye(eye, update)} />
                      )}
                      methodValue={capture.method}
                      methodOptions={[
                        { value: "", label: "Select" },
                        { value: "finger-count", label: "Finger count" },
                        { value: "hand-motion", label: "Hand motion" },
                      ]}
                      onMethodChange={(method) => updateEye(eye, { method })}
                      methodAriaLabel={`${eye} CVF method`}
                      disabled={capture.unable}
                    />
                    <label className="mt-3 flex min-h-10 items-center gap-3 rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)] px-3 text-sm">
                      <input type="checkbox" checked={capture.unable} onChange={(event) => updateEye(eye, { unable: event.target.checked })} />
                      Unable to test
                    </label>
                  </div>
                )}
                <label className="mt-4 block text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">
                  Note
                  <textarea value={capture.note} disabled={!capture.state} onChange={(event) => updateEye(eye, { note: event.target.value })} rows={2} className="mt-1 w-full rounded border border-[color:var(--odos-line-2)] bg-[color:var(--odos-surface-2)] p-2 text-sm normal-case text-[color:var(--odos-text)] disabled:opacity-45" />
                </label>
              </div>
            );
          })}
        </div>
        <FieldDefectPanel
          definition={fieldDefectDefinition}
          patientReference={patientReference}
          encounterReference={encounterReference}
          onSaved={onSaved}
        />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">{error ? <span className="text-[color:var(--odos-alert)]">{error}</span> : <span className="text-[color:var(--odos-muted)]">{message}</span>}</div>
          <button type="button" onClick={() => void save()} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold disabled:opacity-45">{saving ? "Saving…" : "Save CVF"}</button>
        </div>
        <History rows={history} loading={loading} />
      </div>
    </section>
  );
}

function FieldDefectPanel({ definition, patientReference, encounterReference, onSaved }: {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}) {
  const field = definition.customFields.find((candidate) => candidate.localCode === "CUSTOM_FIELD_DEFECT");
  const options = field?.options?.filter((option) => option.active) ?? [];
  const [descriptor, setDescriptor] = useState("");
  const [savedDescriptor, setSavedDescriptor] = useState("");
  const [observationReference, setObservationReference] = useState<string>();
  const [historyVersion, setHistoryVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ patient: patientReference, encounter: encounterReference });
    setLoading(true);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}/history?${query}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as {
          rows?: Array<{
            observationReference?: string;
            values: Array<{ code: string; value: number | string | string[] }>;
          }>;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? `Field Defect history failed: ${response.status}`);
        return body.rows ?? [];
      })
      .then((rows) => {
        const latest = rows[0];
        const display = latest?.values.find((value) => value.code === "CUSTOM_FIELD_DEFECT")?.value;
        const restored = typeof display === "string"
          ? options.find((option) => option.display === display)?.code
          : undefined;
        setDescriptor(restored ?? "");
        setSavedDescriptor(restored ?? "");
        setObservationReference(latest?.observationReference);
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [definition.stableKey, encounterReference, historyVersion, patientReference]);

  async function save() {
    if (!descriptor) {
      setError("Choose a Field Defect before saving.");
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
          customFields: [{ code: "CUSTOM_FIELD_DEFECT", value: descriptor }],
        }),
      });
      const body = await response.json() as { observationReference?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Field Defect save failed: ${response.status}`);
      const display = options.find((option) => option.code === descriptor)?.display ?? descriptor;
      const status = {
        completed: true,
        summary: `Field Defect saved: ${display}`,
        savedAt: new Date().toISOString(),
        operator: "ODOS UI Visual Field",
      };
      setSavedDescriptor(descriptor);
      setObservationReference(body.observationReference);
      setMessage(status.summary);
      setHistoryVersion((current) => current + 1);
      onSaved(status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Field Defect</h3>
          <p className="mt-1 text-sm text-[color:var(--odos-muted)]">Stored as its own clinical descriptor; the diagnosis proposal is derived separately.</p>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || loading}
          className="rounded bg-brand px-4 py-2 text-sm font-semibold disabled:opacity-45"
        >
          {saving ? "Saving…" : "Save Field Defect"}
        </button>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {(["pre-chiasmal", "chiasmal", "post-chiasmal"] as const).map((lesionSite) => (
          <div key={lesionSite} className="rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface-2)] p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--odos-faint)]">
              {lesionSite === "pre-chiasmal" ? "Pre-chiasmal" : lesionSite === "chiasmal" ? "Chiasmal" : "Post-chiasmal"}
            </div>
            <div className="mt-2 space-y-2">
              {options.filter((option) => option.parentCode === lesionSite).map((option) => (
                <DescriptorButton key={option.code} option={option} selected={descriptor === option.code} onSelect={setDescriptor} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {options.filter((option) => !option.parentCode).map((option) => (
        <div key={option.code} className="mt-3 max-w-sm">
          <DescriptorButton option={option} selected={descriptor === option.code} onSelect={setDescriptor} />
        </div>
      ))}
      <div className="mt-3 min-h-5 text-sm">
        {error ? <span className="text-[color:var(--odos-alert)]">{error}</span> : <span className="text-[color:var(--odos-muted)]">{message}</span>}
      </div>
      {observationReference && descriptor === savedDescriptor && (
        <DiagnosisPicker
          encounterReference={encounterReference}
          observationReferences={[observationReference]}
          findingDefinitionKey={definition.stableKey}
          refreshKey={historyVersion}
        />
      )}
    </section>
  );
}

function DescriptorButton({ option, selected, onSelect }: {
  option: NonNullable<CustomFindingDefinition["customFields"][number]["options"]>[number];
  selected: boolean;
  onSelect(code: string): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(option.code)}
      className={selected
        ? "w-full rounded border border-brand bg-brand/20 px-3 py-2 text-left text-sm text-[color:var(--odos-text)]"
        : "w-full rounded border border-[color:var(--odos-line-2)] px-3 py-2 text-left text-sm text-[color:var(--odos-muted)] hover:border-brand/60 hover:text-[color:var(--odos-text)]"}
    >
      {option.display}
    </button>
  );
}

function QuadrantGrid({ eye, capture, update }: { eye: Eye; capture: EyeCapture; update(update: Partial<EyeCapture>): void }) {
  return (
    <div className="mx-auto max-w-md">
      <div className="relative aspect-square overflow-hidden rounded-full border border-[color:var(--odos-overlay-line-2)] bg-slate-50">
        {QUADRANTS.map(({ quadrant, label, position }) => {
          const marked = capture.defects[quadrant];
          const toggle = () => update({ defects: { ...capture.defects, [quadrant]: !marked } });
          return (
            <button
              key={quadrant}
              type="button"
              aria-label={`${eye} ${quadrant} field, ${marked ? "defect" : "clear"}`}
              aria-pressed={marked}
              disabled={capture.unable}
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggle();
                }
              }}
              style={position}
              className={`absolute flex h-1/2 w-1/2 items-center justify-center transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[color:var(--odos-accent)] disabled:opacity-35 ${marked ? "bg-slate-900 text-slate-50" : "bg-slate-50 text-slate-900 hover:bg-slate-100"}`}
            >
              <span className="pointer-events-none w-[84%] text-center text-[10px] font-semibold sm:text-xs">
                <span className="block">{label}</span>
                <span className="mt-1 block uppercase tracking-wide">{marked ? "Defect" : "Clear"}</span>
              </span>
            </button>
          );
        })}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 z-20 h-px bg-[color:var(--odos-overlay-line-2)]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px bg-[color:var(--odos-overlay-line-2)]" />
      </div>
      <p className="mt-2 text-center text-xs text-[color:var(--odos-muted)]">Select a quadrant to toggle clear / defect.</p>
    </div>
  );
}

function History({ rows, loading }: { rows: HistoryRow[]; loading: boolean }) {
  return (
    <div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)] bg-[color:var(--odos-surface)]">
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
    ...QUADRANTS.map(({ quadrant, code }) => ({ code, value: capture.defects[quadrant] ? "restricted" : "full" })),
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
    defects: { "upper-left": false, "upper-right": false, "lower-left": false, "lower-right": false },
    method: "",
    unable: false,
    note: "",
  };
}
