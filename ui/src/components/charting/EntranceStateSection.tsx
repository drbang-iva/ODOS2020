import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { removeValueConfirmSpec, voidEncounterEntries } from "../../lib/encounter-void";
import { ClearSectionButton } from "./ClearControls";
import { EditEntriesToggle, RemoveValueButton, SectionEditingProvider } from "./section-editing";
import { useEncounterEdit } from "./encounter-edit-context";
import { OdosSelect } from "../inputs/OdosSelect";
import type { CustomFindingDefinition, CustomFindingField } from "./CustomFindingSection";
import { PowerDropdown } from "./PowerDropdown";
import { numericOptions } from "./power-options";
import type { SectionSaveStatus } from "./types";

type Eye = "OD" | "OS";
type ExamState = "normal" | "abnormal" | "deferred";

interface Capture {
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
  observationReference?: string;
}

const EYES: Eye[] = ["OD", "OS"];

export function EntranceStateSection({ definition, patientReference, encounterReference, onSaved }: {
  definition: CustomFindingDefinition;
  patientReference: string;
  encounterReference: string;
  onSaved(status: SectionSaveStatus): void;
}) {
  const [eyes, setEyes] = useState<Record<Eye, Capture>>(() => ({ OD: emptyCapture(), OS: emptyCapture() }));
  const [shared, setShared] = useState<Capture>(() => emptyCapture());
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { onCleared } = useEncounterEdit();
  const fields = useMemo(
    () => definition.customFields.filter((field) => field.active).sort((left, right) => left.order - right.order),
    [definition.customFields],
  );

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

  function updateEye(eye: Eye, update: Partial<Capture>) {
    setEyes((current) => ({ ...current, [eye]: { ...current[eye], ...update } }));
  }

  function setNormal() {
    const update = normalStateUpdate(definition);
    if (definition.perEye) {
      setEyes((current) => ({
        OD: { ...current.OD, ...update },
        OS: { ...current.OS, ...update },
      }));
    } else {
      setShared((current) => ({ ...current, ...update }));
    }
    setMessage(definition.normalTemplate ?? "Normal selected");
    setError(null);
  }

  async function save() {
    const body = definition.perEye ? perEyeBody() : sharedBody();
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/custom/${encodeURIComponent(definition.stableKey)}`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ patientReference, encounterReference, ...body }),
      });
      const responseBody = await response.json() as { error?: string };
      if (!response.ok) throw new Error(responseBody.error ?? `${definition.display} save failed: ${response.status}`);
      const summary = definition.perEye
        ? `${definition.display} saved for ${EYES.filter((eye) => eyes[eye].state).join(" / ")}`
        : `${definition.display} saved once for the binocular exam`;
      const status = { completed: true, summary, savedAt: new Date().toISOString(), operator: "ODOS UI entrance battery" };
      setMessage(status.summary);
      onSaved(status);
      setHistoryVersion((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function removeRow(observationReference: string) {
    try {
      const result = await voidEncounterEntries(encounterReference, { scope: "observation", observationReference });
      onCleared?.({ scope: "observation", result });
      setHistoryVersion((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function resetForm() {
    setEyes({ OD: emptyCapture(), OS: emptyCapture() });
    setShared(emptyCapture());
    setMessage(null);
    setError(null);
    setHistoryVersion((current) => current + 1);
  }

  function perEyeBody(): { eyes: Record<string, unknown> } | undefined {
    const populated = EYES.filter((eye) => eyes[eye].state);
    if (populated.length === 0) {
      setError("Choose Normal, Abnormal, or Deferred for at least one eye.");
      return undefined;
    }
    return {
      eyes: Object.fromEntries(populated.map((eye) => [eye, capturePayload(definition, fields, eyes[eye])])),
    };
  }

  function sharedBody(): Record<string, unknown> | undefined {
    if (!shared.state) {
      setError("Choose Normal, Abnormal, or Deferred for the binocular exam.");
      return undefined;
    }
    return capturePayload(definition, fields, shared);
  }

  const cards = definition.perEye
    ? EYES.map((eye) => ({ key: eye, label: eye, capture: eyes[eye], update: (update: Partial<Capture>) => updateEye(eye, update) }))
    : [{ key: "binocular", label: "Binocular", capture: shared, update: (update: Partial<Capture>) => setShared((current) => ({ ...current, ...update })) }];

  return (
    <SectionEditingProvider hasRecorded={history.length > 0}>
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[color:var(--odos-line)] pb-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-light">Entrance Testing</div>
            <h2 className="mt-1 text-xl font-semibold text-[color:var(--odos-text)]">{definition.display}</h2>
            <p className="mt-1 text-sm text-[color:var(--odos-muted)]">
              {definition.perEye ? "Choose an explicit state for each eye." : "Record this binocular test once; it cannot differ by eye."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={setNormal} className="rounded border border-emerald-300/50 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-300/15">
              {definition.perEye ? "Normal OU" : "Mark normal"}
            </button>
            <EditEntriesToggle />
            <ClearSectionButton
              encounterReference={encounterReference}
              sectionKey={definition.sectionKey ?? definition.stableKey}
              label={definition.display}
              hasRecorded={history.length > 0}
              onCleared={(result) => {
                resetForm();
                onCleared?.({ scope: "section", result });
              }}
            />
          </div>
        </div>
        {definition.normalTemplate && <div className="mt-4 rounded border border-emerald-300/20 bg-emerald-300/[0.06] px-4 py-3 text-sm text-emerald-50/80">{definition.normalTemplate}</div>}
        {definition.sourceStatus === "unseeded-needs-operator-input" && definition.setupMessage && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-amber-300/30 bg-amber-300/[0.08] px-4 py-3 text-sm text-amber-100">
            <span><span className="font-semibold">Needs practice setup:</span> {definition.setupMessage}</span>
            <a href="/admin/practice/settings/chart-fields" className="font-semibold underline underline-offset-4 hover:text-[color:var(--odos-text)]">Open chart field settings</a>
          </div>
        )}
        <div className={`mt-5 grid gap-4 ${definition.perEye ? "xl:grid-cols-2" : "max-w-2xl"}`}>
          {cards.map(({ key, label, capture, update }) => (
            <div key={key} className="rounded border border-[color:var(--odos-line)] bg-bg-panel/65 p-4">
              <div className="text-sm font-semibold text-[color:var(--odos-text)]">{label}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {(["normal", "abnormal"] as ExamState[]).map((state) => (
                  <button key={state} type="button" onClick={() => update(state === "normal" ? normalStateUpdate(definition) : { state })} className={capture.state === state ? "rounded border border-brand/70 bg-brand/20 px-3 py-1.5 text-xs font-semibold capitalize text-[color:var(--odos-text)]" : "rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-xs capitalize text-[color:var(--odos-muted)] hover:border-brand/60"}>{state}</button>
                ))}
                {definition.allowDeferred === true && <button type="button" onClick={() => update({ state: "deferred" })} className={capture.state === "deferred" ? "rounded border border-brand/70 bg-brand/20 px-3 py-1.5 text-xs font-semibold capitalize text-[color:var(--odos-text)]" : "rounded border border-[color:var(--odos-line-2)] px-3 py-1.5 text-xs capitalize text-[color:var(--odos-muted)] hover:border-brand/60"}>deferred</button>}
              </div>
              {capture.state && capture.state !== "deferred" && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {fields.filter((field) => !isDerivedColorTotal(definition, field)).map((field) => (
                    <FieldControl
                      key={field.localCode}
                      field={field}
                      value={capture.values[field.localCode] ?? ""}
                      onChange={(value) => update({ values: { ...capture.values, [field.localCode]: value } })}
                    />
                  ))}
                  {definition.stableKey === "entrance:color" && <ColorTotal values={capture.values} />}
                </div>
              )}
              <label className="mt-4 block">
                <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">Note</span>
                <textarea value={capture.other} disabled={!capture.state} onChange={(event) => update({ other: event.target.value })} rows={2} className="w-full rounded border border-[color:var(--odos-line-2)] bg-bg-deep p-2 text-sm text-[color:var(--odos-text)] outline-none focus:border-brand disabled:opacity-45" />
              </label>
            </div>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-h-6 text-sm">{error ? <span className="text-rose-200">{error}</span> : <span className="text-[color:var(--odos-muted)]">{message}</span>}</div>
          <button type="button" onClick={() => void save()} disabled={saving || loading} className="rounded bg-brand px-5 py-2 text-sm font-semibold text-[color:var(--odos-text)] disabled:opacity-45">{saving ? "Saving…" : `Save ${definition.display}`}</button>
        </div>
        <History rows={history} loading={loading} perEye={definition.perEye} label={definition.display} onRemove={removeRow} />
      </div>
    </section>
    </SectionEditingProvider>
  );
}

function FieldControl({ field, value, onChange }: { field: CustomFindingField; value: string; onChange(value: string): void }) {
  if (field.localCode.endsWith("_UNABLE")) {
    return (
      <label className="flex min-h-10 items-center gap-3 rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm text-[color:var(--odos-text)]">
        <input type="checkbox" checked={value === "yes"} onChange={(event) => onChange(event.target.checked ? "yes" : "")} />
        {field.display}
      </label>
    );
  }
  if (field.valueType === "number") {
    const options = numericOptions(undefined, field.min ?? 0, field.max ?? 100, field.step ?? 1);
    const defaultValue = options[Math.floor(options.length / 2)] ?? options[0] ?? "";
    return (
      <label>
        <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">{field.display}</span>
        <div className="flex min-w-0 overflow-hidden rounded border border-[color:var(--odos-line-2)] bg-bg-deep">
          <div className="min-w-0 flex-1"><PowerDropdown value={value} options={options} defaultValue={defaultValue} onChange={onChange} ariaLabel={field.display} /></div>
          {field.unit && <span className="flex items-center border-l border-[color:var(--odos-line)] px-3 text-xs text-[color:var(--odos-muted)]">{field.unit}</span>}
        </div>
      </label>
    );
  }
  const options = (field.options ?? []).filter((option) => option.active);
  const needsSetup = field.valueType === "select" && options.length === 0;
  return (
    <label>
      <span className="mb-1 block text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">{field.display}</span>
      <OdosSelect
        disabled={needsSetup}
        value={value}
        options={[
          { value: "", label: needsSetup ? "Needs practice setup" : "Select" },
          ...options.map((option) => ({ value: option.code, label: option.display })),
        ]}
        onChange={onChange}
        ariaLabel={field.display}
      />
    </label>
  );
}

function ColorTotal({ values }: { values: Record<string, string> }) {
  const test = values.CUSTOM_COLOR_TEST;
  const total = colorPlateTotal(test) ?? (test === "hrr" ? "Needs practice setup" : "Select a test");
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-[color:var(--odos-faint)]">Plates total</div>
      <div className={`flex h-10 items-center rounded border border-[color:var(--odos-line-2)] bg-bg-deep px-3 text-sm ${test === "hrr" ? "text-amber-100" : "text-[color:var(--odos-muted)]"}`}>{total}</div>
    </div>
  );
}

function History({ rows, loading, perEye, label, onRemove }: { rows: HistoryRow[]; loading: boolean; perEye: boolean; label: string; onRemove(observationReference: string): void }) {
  return (
    <div className="mt-8 overflow-hidden rounded border border-[color:var(--odos-line)] bg-bg-panel/55">
      <div className="border-b border-[color:var(--odos-line)] px-4 py-3 text-sm font-semibold text-[color:var(--odos-text)]">History</div>
      {loading ? <div className="p-6 text-sm text-[color:var(--odos-muted)]">Loading history…</div> : rows.length === 0 ? <div className="p-6 text-sm text-[color:var(--odos-muted)]">No prior entries</div> : (
        <div className="divide-y divide-white/10">
          {rows.map((row, index) => (
            <div key={`${row.recordedAt}-${row.eye}-${index}`} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[90px_120px_1fr_auto]">
              <div className="font-semibold text-[color:var(--odos-text)]">{perEye ? row.eye : "Binocular"}</div>
              <div className="capitalize text-[color:var(--odos-muted)]">{row.state}</div>
              <div className="text-[color:var(--odos-muted)]">{row.normalTemplate ?? row.values.map((entry) => `${entry.label}: ${Array.isArray(entry.value) ? entry.value.join(", ") : entry.value}${entry.unit ? ` ${entry.unit}` : ""}`).join(" · ")}{row.other ? ` — ${row.other}` : ""}</div>
              <div className="flex items-start justify-end">
                {row.observationReference && (
                  <RemoveValueButton
                    label={`${label}${perEye && row.eye ? ` ${row.eye}` : ""}`}
                    confirm={row.other ? removeValueConfirmSpec(`${label}${perEye && row.eye ? ` ${row.eye}` : ""}`, "note") : undefined}
                    onRemove={() => onRemove(row.observationReference!)}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function capturePayload(definition: CustomFindingDefinition, fields: CustomFindingField[], capture: Capture) {
  const values = derivedValues(definition, capture.values);
  return {
    state: capture.state,
    customFields: capture.state === "deferred" ? [] : fieldValues(fields, values),
    ...(capture.other.trim() ? { other: capture.other.trim() } : {}),
  };
}

function derivedValues(definition: CustomFindingDefinition, values: Record<string, string>) {
  if (definition.stableKey !== "entrance:color") return values;
  const next = { ...values };
  const total = colorPlateTotal(next.CUSTOM_COLOR_TEST);
  if (total) next.CUSTOM_COLOR_PLATES_TOTAL = total;
  else delete next.CUSTOM_COLOR_PLATES_TOTAL;
  return next;
}

export function colorPlateTotal(testCode: string | undefined): string | undefined {
  return testCode === "ishihara" ? "7" : undefined;
}

function fieldValues(fields: CustomFindingField[], values: Record<string, string>) {
  return fields.flatMap((field) => {
    const value = values[field.localCode]?.trim();
    if (!value) return [];
    return [{ code: field.localCode, value: field.valueType === "number" ? Number(value) : value }];
  });
}

function isDerivedColorTotal(definition: CustomFindingDefinition, field: CustomFindingField) {
  return definition.stableKey === "entrance:color" && field.localCode === "CUSTOM_COLOR_PLATES_TOTAL";
}

function emptyCapture(): Capture {
  return { values: {}, other: "" };
}

function normalStateUpdate(definition: CustomFindingDefinition): Partial<Capture> {
  const values = Object.fromEntries(definition.customFields.flatMap((field) =>
    field.defaultValue === undefined ? [] : [[field.localCode, String(field.defaultValue)]]
  ));
  return Object.keys(values).length > 0 ? { state: "normal", values } : { state: "normal" };
}
