import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fhir } from "../../lib/fhir";
import { IopTimeline } from "./IopTimeline";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

type Eye = "OD" | "OS";
type RiskTier = "normal" | "ohtn";

interface DefinitionOption {
  code: string;
  display: string;
  active?: boolean;
}

interface DefinitionField {
  display?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  unit?: string;
  options?: DefinitionOption[];
}

interface IopDefinition {
  definitions: {
    intraocularPressure: {
      fields: Record<string, DefinitionField>;
    };
    cornealHysteresis: {
      fields: Record<string, DefinitionField>;
    };
  };
}

interface EyeState {
  value: string;
  method: string;
  date: string;
  timeOfDay: string;
  cornealHysteresis: string;
  notVisualized: boolean;
}

interface EyePayload {
  value?: number;
  method?: string;
  date?: string;
  timeOfDay?: string;
  cornealHysteresis?: number;
  notVisualized?: boolean;
}

interface IopEyeResult {
  observationReference: string;
  cornealHysteresisObservationReference?: string;
  riskTier: RiskTier;
  icd10Code?: string;
  explanation: string;
  signals: string[];
  threshold: number;
  value?: number;
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "OSOD UI clinical_graph_iop";

export function IopSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<IopDefinition["definitions"] | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [rows, setRows] = useState<Record<Eye, EyeState>>(() => initialRows());
  const [results, setResults] = useState<Partial<Record<Eye, IopEyeResult>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [timelineRefresh, setTimelineRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setDefinitionLoading(true);
    setDefinitionError(null);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/iop/definition`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`IOP definition request failed: ${response.status}`);
        }
        return (await response.json()) as IopDefinition;
      })
      .then((body) => {
        setDefinition(body.definitions);
        const firstMethod = activeOptions(body.definitions.intraocularPressure.fields.method)[0]?.code;
        if (firstMethod) {
          setRows((current) => Object.fromEntries(
            EYES.map((eye) => [
              eye,
              { ...current[eye], method: current[eye].method || firstMethod },
            ]),
          ) as Record<Eye, EyeState>);
        }
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") {
          setDefinitionError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDefinitionLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  const iopFields = definition?.intraocularPressure.fields ?? {};
  const chFields = definition?.cornealHysteresis.fields ?? {};
  const valueField = iopFields.value ?? {};
  const methodOptions = useMemo(() => activeOptions(iopFields.method), [iopFields.method]);
  const dateField = iopFields.date ?? {};
  const timeField = iopFields.timeOfDay ?? {};
  const chValueField = chFields.value ?? {};

  function updateEye(eye: Eye, next: Partial<EyeState>) {
    setRows((current) => ({
      ...current,
      [eye]: { ...current[eye], ...next },
    }));
  }

  async function save() {
    let eyes: Partial<Record<Eye, EyePayload>>;
    try {
      eyes = buildPayload(rows, valueField, chValueField);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (Object.keys(eyes).length === 0) {
      setError("Enter at least one IOP row before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/iop`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ patientReference, encounterReference, eyes }),
      });
      const body = (await response.json()) as { eyes?: Partial<Record<Eye, IopEyeResult>>; error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `IOP save failed: ${response.status}`);
      }

      const savedResults = body.eyes ?? {};
      setResults(savedResults);
      const status = {
        completed: true,
        summary: EYES.flatMap((eye) => {
          const result = savedResults[eye];
          return result ? [`${eye} ${result.riskTier}`] : [];
        }).join(" - "),
        savedAt: new Date().toISOString(),
        operator: OPERATOR,
      };
      setSaved(status);
      onSaved(status);
      setTimelineRefresh((current) => current + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="text-lg font-semibold text-white">Intraocular Pressure</h2>

        {definitionError && (
          <div className="mt-5 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {definitionError}
          </div>
        )}

        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          {EYES.map((eye) => {
            const row = rows[eye];
            const result = results[eye];
            const disabled = row.notVisualized || definitionLoading;
            return (
              <div key={eye} className="rounded border border-white/10 bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-white">{eye}</div>
                  <label className="flex items-center gap-2 text-sm text-white/70">
                    <input
                      type="checkbox"
                      checked={row.notVisualized}
                      onChange={(event) => updateEye(eye, { notVisualized: event.target.checked })}
                      className="h-4 w-4 accent-brand"
                    />
                    Not visualized/deferred
                  </label>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <Field label={valueField.display ?? "IOP"}>
                    <input
                      value={row.value}
                      onChange={(event) => updateEye(eye, { value: event.target.value })}
                      inputMode="decimal"
                      type="number"
                      min={valueField.minimum ?? 3}
                      max={valueField.maximum ?? 80}
                      step={valueField.step ?? 1}
                      disabled={disabled}
                      placeholder="14"
                      className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand disabled:opacity-45"
                    />
                  </Field>

                  <Field label={iopFields.method?.display ?? "Method"}>
                    <select
                      value={row.method}
                      onChange={(event) => updateEye(eye, { method: event.target.value })}
                      disabled={disabled}
                      className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand disabled:opacity-45"
                    >
                      <option value="">Select</option>
                      {methodOptions.map((option) => (
                        <option key={option.code} value={option.code}>{option.display}</option>
                      ))}
                    </select>
                  </Field>

                  <Field label={dateField.display ?? "Date"}>
                    <input
                      value={row.date}
                      onChange={(event) => updateEye(eye, { date: event.target.value })}
                      type="date"
                      disabled={disabled}
                      className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand disabled:opacity-45"
                    />
                  </Field>

                  <Field label={timeField.display ?? "Time"}>
                    <input
                      value={row.timeOfDay}
                      onChange={(event) => updateEye(eye, { timeOfDay: event.target.value })}
                      type="time"
                      disabled={disabled}
                      className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand disabled:opacity-45"
                    />
                  </Field>

                  <Field label={chValueField.display ?? "CH"}>
                    <input
                      value={row.cornealHysteresis}
                      onChange={(event) => updateEye(eye, { cornealHysteresis: event.target.value })}
                      inputMode="decimal"
                      type="number"
                      min={chValueField.minimum ?? 0}
                      max={chValueField.maximum ?? 15}
                      step={chValueField.step ?? 0.1}
                      disabled={disabled}
                      placeholder="9.8"
                      className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand disabled:opacity-45"
                    />
                  </Field>
                </div>

                {result && (
                  <div className={[
                    "mt-4 rounded border px-3 py-2 text-sm",
                    result.riskTier === "ohtn"
                      ? "border-amber-300/35 bg-amber-400/10 text-amber-100"
                      : "border-emerald-400/30 bg-emerald-400/10 text-emerald-100",
                  ].join(" ")}>
                    {resultBadgeText(result)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <SectionFooter
          error={error}
          saved={saved}
          saving={saving || definitionLoading}
          onSave={save}
        />
        <IopTimeline patientReference={patientReference} refreshSignal={timelineRefresh} />
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      {children}
    </label>
  );
}

function SectionFooter({
  error,
  saved,
  saving,
  onSave,
}: {
  error: string | null;
  saved: SectionSaveStatus | null;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-h-10">
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
        {saved && !error && (
          <div className="text-sm text-white/70">
            {saved.summary}
            <span className="ml-3 rounded border border-white/10 px-2 py-1 text-xs text-white/45">
              {saved.operator} {saved.savedAt}
            </span>
          </div>
        )}
      </div>
      <button
        onClick={onSave}
        disabled={saving}
        className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save IOP"}
      </button>
    </div>
  );
}

function initialRows(): Record<Eye, EyeState> {
  const now = new Date();
  const row = {
    value: "",
    method: "",
    date: dateInputValue(now),
    timeOfDay: timeInputValue(now),
    cornealHysteresis: "",
    notVisualized: false,
  };
  return {
    OD: { ...row },
    OS: { ...row },
  };
}

function buildPayload(
  rows: Record<Eye, EyeState>,
  valueField: DefinitionField,
  chValueField: DefinitionField,
): Partial<Record<Eye, EyePayload>> {
  const payload: Partial<Record<Eye, EyePayload>> = {};
  for (const eye of EYES) {
    const row = rows[eye];
    if (!rowTouched(row)) continue;
    if (row.notVisualized) {
      payload[eye] = {
        notVisualized: true,
        ...(row.date ? { date: row.date } : {}),
        ...(row.timeOfDay ? { timeOfDay: row.timeOfDay } : {}),
      };
      continue;
    }
    const value = parseRequiredNumber(
      row.value,
      `${eye} IOP`,
      valueField.minimum ?? 3,
      valueField.maximum ?? 80,
    );
    const ch = parseOptionalNumber(
      row.cornealHysteresis,
      `${eye} CH`,
      chValueField.minimum ?? 0,
      chValueField.maximum ?? 15,
    );
    if (!row.method) {
      throw new Error(`${eye} method is required.`);
    }
    if (!row.date) {
      throw new Error(`${eye} date is required.`);
    }
    if (!row.timeOfDay) {
      throw new Error(`${eye} time is required.`);
    }
    payload[eye] = {
      value,
      method: row.method,
      date: row.date,
      timeOfDay: row.timeOfDay,
      ...(ch !== undefined ? { cornealHysteresis: ch } : {}),
    };
  }
  return payload;
}

function rowTouched(row: EyeState): boolean {
  return row.notVisualized ||
    Boolean(row.value.trim()) ||
    Boolean(row.cornealHysteresis.trim());
}

function parseRequiredNumber(value: string, label: string, minimum: number, maximum: number): number {
  if (!value.trim()) {
    throw new Error(`${label} is required unless the eye is not visualized/deferred.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseOptionalNumber(value: string, label: string, minimum: number, maximum: number): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function resultBadgeText(result: IopEyeResult): string {
  if (result.riskTier === "normal") {
    return "Normal - no suspect suggestion";
  }
  const code = result.icd10Code ? ` ${result.icd10Code}` : "";
  return `Suggested: Ocular hypertension${code}`;
}

function authHeaders(): HeadersInit {
  const authorization = fhir.authHeader();
  return authorization ? { Authorization: authorization } : {};
}

function clinicalGraphApiBase(): string {
  const meta = import.meta as ImportMeta & { env?: { VITE_OSOD_MCP_BASE_URL?: string } };
  return meta.env?.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}

function dateInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function timeInputValue(date: Date): string {
  return [
    date.getHours().toString().padStart(2, "0"),
    date.getMinutes().toString().padStart(2, "0"),
  ].join(":");
}
