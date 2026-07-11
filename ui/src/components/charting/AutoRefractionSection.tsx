import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { formatPowerOption, numericOptions } from "./power-options";
import type { SectionSaveStatus } from "./types";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

type Eye = "OD" | "OS";

interface DefinitionOption {
  code: string;
  display: string;
  active?: boolean;
}

interface DefinitionField {
  minimum?: number;
  maximum?: number;
  step?: number;
  precision?: number;
  options?: DefinitionOption[];
}

interface DefinitionSummary {
  fields: Record<string, DefinitionField>;
}

interface AutoDefinitionResponse {
  definitions: {
    autoRefraction: DefinitionSummary;
    autoKeratometry: DefinitionSummary;
  };
}

interface EyeState {
  sphere: string;
  cylinder: string;
  axis: string;
  flatK: string;
  flatAxis: string;
  steepK: string;
  steepAxis: string;
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "OSOD UI clinical_graph_auto_refraction";

export function AutoRefractionSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<AutoDefinitionResponse | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState("");
  const [remarks, setRemarks] = useState("");
  const [eyes, setEyes] = useState<Record<Eye, EyeState>>(() => ({ OD: emptyEye(), OS: emptyEye() }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${clinicalGraphApiBase()}/clinical-graph/auto-refraction/definition`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Auto-refraction definition request failed: ${response.status}`);
        return await response.json() as AutoDefinitionResponse;
      })
      .then((body) => {
        setDefinition(body);
        setSourceType(activeOptions(body.definitions.autoRefraction.fields.sourceType)[0]?.code ?? "");
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") {
          setDefinitionError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDefinitionLoading(false);
      });
    return () => controller.abort();
  }, []);

  const refractionFields = definition?.definitions.autoRefraction.fields ?? {};
  const keratometryFields = definition?.definitions.autoKeratometry.fields ?? {};
  const sourceTypes = useMemo(() => activeOptions(refractionFields.sourceType), [refractionFields.sourceType]);
  const powerOptions = useMemo(() => numericOptions(refractionFields.sphere, -20, 20, 0.25), [refractionFields.sphere]);
  const axisOptions = useMemo(() => numericOptions(refractionFields.axis, 0, 180, 1), [refractionFields.axis]);

  function updateEye(eye: Eye, next: Partial<EyeState>) {
    setEyes((current) => ({ ...current, [eye]: { ...current[eye], ...next } }));
  }

  async function save() {
    let payloadEyes: Partial<Record<Eye, Record<string, number>>>;
    try {
      payloadEyes = buildPayload(eyes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (Object.keys(payloadEyes).length === 0) {
      setError("Enter at least one Auto-Refraction or Auto-K value before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/auto-refraction`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          sourceType,
          ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
          eyes: payloadEyes,
        }),
      });
      const body = await response.json() as { eyes?: Record<string, unknown>; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Auto-refraction save failed: ${response.status}`);
      const count = Object.keys(body.eyes ?? payloadEyes).length;
      const status = {
        completed: true,
        summary: `Auto-Refraction / Auto-K saved for ${count} eye${count === 1 ? "" : "s"}`,
        savedAt: new Date().toISOString(),
        operator: OPERATOR,
      };
      setSaved(status);
      onSaved(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-[1380px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Auto-Refraction / Auto-K</h2>
            <p className="mt-1 text-sm text-white/45">Objective pretest measurements from manual entry or a future device feed</p>
          </div>
          <label className="block min-w-[180px]">
            <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Source</span>
            <select
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value)}
              disabled={definitionLoading}
              className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand disabled:opacity-45"
            >
              <option value="">Select</option>
              {sourceTypes.map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}
            </select>
          </label>
        </div>

        {definitionError && (
          <div className="mt-5 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {definitionError}
          </div>
        )}

        <div className="mt-5 overflow-hidden rounded border border-white/10 bg-white/[0.02]">
          <div className="border-b border-white/10 bg-white/[0.03] px-4 py-3">
            <h3 className="text-sm font-semibold text-white">Auto-Refraction (ARx)</h3>
          </div>
          <div className="grid grid-cols-[54px_repeat(3,minmax(120px,180px))] gap-2 bg-white/[0.025] px-4 py-2 text-xs uppercase tracking-widest text-white/35">
            <div>Eye</div><div>Sphere</div><div>Cylinder</div><div>Axis</div>
          </div>
          {EYES.map((eye) => (
            <div key={eye} className="grid grid-cols-[54px_repeat(3,minmax(120px,180px))] items-center gap-2 border-t border-white/10 px-4 py-3">
              <div className="text-sm font-semibold text-white">{eye}</div>
              <PowerSelect value={eyes[eye].sphere} options={powerOptions} onChange={(value) => updateEye(eye, { sphere: value })} ariaLabel={`${eye} auto-refraction sphere`} />
              <PowerSelect value={eyes[eye].cylinder} options={powerOptions} onChange={(value) => updateEye(eye, { cylinder: value })} ariaLabel={`${eye} auto-refraction cylinder`} />
              <select
                value={eyes[eye].axis}
                onChange={(event) => updateEye(eye, { axis: event.target.value })}
                aria-label={`${eye} auto-refraction axis`}
                className="h-10 rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand"
              >
                <option value="">Select</option>
                {axisOptions.map((value) => <option key={value} value={value}>{value}°</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="mt-5 overflow-hidden rounded border border-white/10 bg-white/[0.02]">
          <div className="border-b border-white/10 bg-white/[0.03] px-4 py-3">
            <h3 className="text-sm font-semibold text-white">Auto-Keratometry</h3>
            <p className="mt-1 text-xs text-white/40">K values accept 30.00–60.00 D with up to two decimal places.</p>
          </div>
          <div className="grid grid-cols-[54px_repeat(4,minmax(130px,190px))] gap-2 bg-white/[0.025] px-4 py-2 text-xs uppercase tracking-widest text-white/35">
            <div>Eye</div><div>Flat K</div><div>Flat Axis</div><div>Steep K</div><div>Steep Axis</div>
          </div>
          {EYES.map((eye) => (
            <div key={eye} className="grid grid-cols-[54px_repeat(4,minmax(130px,190px))] items-center gap-2 border-t border-white/10 px-4 py-3">
              <div className="text-sm font-semibold text-white">{eye}</div>
              <NumberInput value={eyes[eye].flatK} field={keratometryFields.flatK} fallback={{ min: 30, max: 60, step: 0.01 }} onChange={(value) => updateEye(eye, { flatK: value })} ariaLabel={`${eye} flat K`} />
              <NumberInput value={eyes[eye].flatAxis} field={keratometryFields.flatAxis} fallback={{ min: 0, max: 180, step: 1 }} onChange={(value) => updateEye(eye, { flatAxis: value })} ariaLabel={`${eye} flat axis`} />
              <NumberInput value={eyes[eye].steepK} field={keratometryFields.steepK} fallback={{ min: 30, max: 60, step: 0.01 }} onChange={(value) => updateEye(eye, { steepK: value })} ariaLabel={`${eye} steep K`} />
              <NumberInput value={eyes[eye].steepAxis} field={keratometryFields.steepAxis} fallback={{ min: 0, max: 180, step: 1 }} onChange={(value) => updateEye(eye, { steepAxis: value })} ariaLabel={`${eye} steep axis`} />
            </div>
          ))}
        </div>

        <label className="mt-5 block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Remarks</span>
          <textarea
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="Optional pretest remarks"
            className="w-full rounded border border-white/15 bg-bg-deep px-3 py-2 text-sm text-white outline-none focus:border-brand"
          />
        </label>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="min-h-10">
            {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
            {saved && !error && <div className="text-sm text-white/70">{saved.summary}</div>}
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving || definitionLoading}
            className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Auto-Refraction / Auto-K"}
          </button>
        </div>
      </div>
    </section>
  );
}

function PowerSelect({ value, onChange, options, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      className="h-10 rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand"
    >
      <option value="">Select</option>
      {options.map((option) => <option key={option} value={option}>{formatPowerOption(Number(option))}</option>)}
    </select>
  );
}

function NumberInput({ value, onChange, field, fallback, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  field: DefinitionField | undefined;
  fallback: { min: number; max: number; step: number };
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      min={field?.minimum ?? fallback.min}
      max={field?.maximum ?? fallback.max}
      step={field?.step ?? (field?.precision ? 10 ** -field.precision : fallback.step)}
      aria-label={ariaLabel}
      className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
    />
  );
}

function emptyEye(): EyeState {
  return { sphere: "", cylinder: "", axis: "", flatK: "", flatAxis: "", steepK: "", steepAxis: "" };
}

function buildPayload(eyes: Record<Eye, EyeState>): Partial<Record<Eye, Record<string, number>>> {
  return Object.fromEntries(EYES.flatMap((eye) => {
    const row = eyes[eye];
    if (!Object.values(row).some((value) => value)) return [];
    if ((row.cylinder && !row.axis) || (!row.cylinder && row.axis)) {
      throw new Error(`${eye} Auto-Refraction cylinder and axis must be saved together.`);
    }
    const kValues = [row.flatK, row.flatAxis, row.steepK, row.steepAxis];
    if (kValues.some(Boolean) && !kValues.every(Boolean)) {
      throw new Error(`${eye} Auto-K requires flat K, flat axis, steep K, and steep axis together.`);
    }
    return [[eye, definedRecord({
      sphere: parseOptionalNumber(row.sphere),
      cylinder: parseOptionalNumber(row.cylinder),
      axis: parseOptionalNumber(row.axis),
      flatK: parseOptionalNumber(row.flatK),
      flatAxis: parseOptionalNumber(row.flatAxis),
      steepK: parseOptionalNumber(row.steepK),
      steepAxis: parseOptionalNumber(row.steepAxis),
    })]];
  })) as Partial<Record<Eye, Record<string, number>>>;
}

function parseOptionalNumber(value: string): number | undefined {
  return value ? Number(value) : undefined;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function definedRecord<T extends Record<string, unknown>>(value: T): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Record<string, number>;
}
