import { useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { voidEncounterEntries } from "../../lib/encounter-void";
import { ClearSectionButton } from "./ClearControls";
import { EditEntriesToggle, RemoveValueButton, SectionEditingProvider } from "./section-editing";
import { useEncounterEdit } from "./encounter-edit-context";
import { referencesByEye, usePersistedVoidEntries } from "./use-persisted-void-entries";
import { OdosSelect } from "../inputs/OdosSelect";
import { OdosWheel } from "../inputs/OdosWheel";
import { formatPowerOption, numericOptions } from "./power-options";
import { PowerDropdown } from "./PowerDropdown";
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

interface AutoHistoryResponse {
  eyes?: Partial<Record<Eye, {
    sphere?: number;
    cylinder?: number;
    axis?: number;
    flatK?: number;
    flatAxis?: number;
    steepK?: number;
    steepAxis?: number;
    observationReferences?: string[];
  }>>;
  binocularPdDistance?: number;
  binocularPdNear?: number;
  binocularPdObservationReferences?: string[];
  remarks?: string;
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
const OPERATOR = "ODOS UI clinical_graph_auto_refraction";

export function AutoRefractionSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<AutoDefinitionResponse | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState("");
  const [remarks, setRemarks] = useState("");
  const [binocularPdDistance, setBinocularPdDistance] = useState("");
  const [binocularPdNear, setBinocularPdNear] = useState("");
  const [eyes, setEyes] = useState<Record<Eye, EyeState>>(() => ({ OD: emptyEye(), OS: emptyEye() }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [savedReferences, setSavedReferences] = useState<Partial<Record<Eye | "OU", string[]>>>({});
  const editorRevisionRef = useRef(0);
  const persistedEntriesRevisionRef = useRef(0);
  const persistedRequestRevisionRef = useRef(0);
  const identityRef = useRef("");
  const identityKey = `${patientReference}|${encounterReference}`;
  const { onCleared } = useEncounterEdit();
  // Readings persisted before this session are recorded values too: offer their × on reopen.
  const persisted = usePersistedVoidEntries(encounterReference, "auto-refraction");

  useEffect(() => {
    identityRef.current = identityKey;
    editorRevisionRef.current += 1;
    persistedEntriesRevisionRef.current += 1;
    persistedRequestRevisionRef.current = persistedEntriesRevisionRef.current;
    setEyes({ OD: emptyEye(), OS: emptyEye() });
    setBinocularPdDistance("");
    setBinocularPdNear("");
    setRemarks("");
    setSavedReferences({});
    setSaved(null);
    setError(null);
  }, [identityKey]);

  useEffect(() => {
    if (
      !persisted.loaded
      || persisted.encounterReference !== encounterReference
      || persistedEntriesRevisionRef.current !== persistedRequestRevisionRef.current
    ) return;
    const hydrated = referencesByEye(persisted.entries);
    setSavedReferences((current) => {
      const next = { ...current };
      for (const key of ["OD", "OS", "OU"] as const) {
        const merged = [...new Set([...(current[key] ?? []), ...(hydrated[key] ?? [])])];
        if (merged.length) next[key] = merged;
      }
      return next;
    });
  }, [persisted]);

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

  useEffect(() => {
    const controller = new AbortController();
    const requestIdentity = identityKey;
    const requestRevision = editorRevisionRef.current;
    const query = new URLSearchParams({ patientReference, encounterReference });
    fetch(`${clinicalGraphApiBase()}/clinical-graph/auto-refraction/history?${query}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as AutoHistoryResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Auto-refraction history request failed: ${response.status}`);
        return body;
      })
      .then((body) => {
        if (
          controller.signal.aborted
          || identityRef.current !== requestIdentity
          || editorRevisionRef.current !== requestRevision
        ) return;
        setEyes(Object.fromEntries(EYES.map((eye) => {
          const savedEye = body.eyes?.[eye];
          return [eye, {
            sphere: savedValue(savedEye?.sphere),
            cylinder: savedValue(savedEye?.cylinder),
            axis: savedValue(savedEye?.axis),
            flatK: savedValue(savedEye?.flatK),
            flatAxis: savedValue(savedEye?.flatAxis),
            steepK: savedValue(savedEye?.steepK),
            steepAxis: savedValue(savedEye?.steepAxis),
          }];
        })) as Record<Eye, EyeState>);
        setBinocularPdDistance(savedValue(body.binocularPdDistance));
        setBinocularPdNear(savedValue(body.binocularPdNear));
        setRemarks(body.remarks ?? "");
        const nextReferences: Partial<Record<Eye | "OU", string[]>> = {};
        for (const eye of EYES) {
          const references = body.eyes?.[eye]?.observationReferences ?? [];
          if (references.length) nextReferences[eye] = [...new Set(references)];
        }
        if (body.binocularPdObservationReferences?.length) {
          nextReferences.OU = [...new Set(body.binocularPdObservationReferences)];
        }
        setSavedReferences((current) => {
          const merged = { ...current };
          for (const key of ["OD", "OS", "OU"] as const) {
            const references = [...new Set([...(current[key] ?? []), ...(nextReferences[key] ?? [])])];
            if (references.length) merged[key] = references;
          }
          return merged;
        });
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [encounterReference, patientReference]);

  const refractionFields = definition?.definitions.autoRefraction.fields ?? {};
  const keratometryFields = definition?.definitions.autoKeratometry.fields ?? {};
  const sourceTypes = useMemo(() => activeOptions(refractionFields.sourceType), [refractionFields.sourceType]);
  const sphereOptions = useMemo(() => numericOptions(undefined, -16, 12, 0.25).reverse(), []);
  const cylinderOptions = useMemo(() => numericOptions(undefined, -8, 0, 0.25).reverse(), []);
  const axisMinimum = refractionFields.axis?.minimum ?? 0;
  const axisMaximum = refractionFields.axis?.maximum ?? 180;
  const axisStep = refractionFields.axis?.step ?? 1;
  const binocularPdOptions = useMemo(() => numericOptions(undefined, 50, 75, 1), []);
  const flatKOptions = useMemo(() => numericOptions(keratometryFields.flatK, 30, 60, 0.25), [keratometryFields.flatK]);
  const steepKOptions = useMemo(() => numericOptions(keratometryFields.steepK, 30, 60, 0.25), [keratometryFields.steepK]);

  function updateEye(eye: Eye, next: Partial<EyeState>) {
    editorRevisionRef.current += 1;
    setEyes((current) => ({ ...current, [eye]: { ...current[eye], ...next } }));
  }

  async function removeSaved(key: Eye | "OU") {
    editorRevisionRef.current += 1;
    persistedEntriesRevisionRef.current += 1;
    const references = savedReferences[key] ?? [];
    if (references.length === 0) return;
    try {
      const result = await voidEncounterEntries(encounterReference, { scope: "observation", observationReference: references });
      setSavedReferences((current) => { const next = { ...current }; delete next[key]; return next; });
      if (key === "OU") {
        setBinocularPdDistance("");
        setBinocularPdNear("");
      } else {
        setEyes((current) => ({ ...current, [key]: emptyEye() }));
      }
      setSaved(null);
      onCleared?.({ scope: "observation", result });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function resetForm() {
    editorRevisionRef.current += 1;
    persistedEntriesRevisionRef.current += 1;
    setEyes({ OD: emptyEye(), OS: emptyEye() });
    setBinocularPdDistance("");
    setBinocularPdNear("");
    setRemarks("");
    setSavedReferences({});
    setSaved(null);
    setError(null);
  }

  async function save() {
    let requestBody: ReturnType<typeof buildAutoRefractionRequestBody>;
    try {
      requestBody = buildAutoRefractionRequestBody({
        patientReference,
        encounterReference,
        sourceType,
        remarks,
        binocularPdDistance,
        binocularPdNear,
        eyes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (
      Object.keys(requestBody.eyes).length === 0
      && requestBody.binocularPdDistance === undefined
      && requestBody.binocularPdNear === undefined
    ) {
      setError("Enter at least one Auto-Refraction, Auto-K, or binocular PD value before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/auto-refraction`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const body = await response.json() as {
        eyes?: Record<string, { autoRefractionObservationReference?: string; autoKeratometryObservationReference?: string }>;
        binocularPd?: { observationReference?: string };
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `Auto-refraction save failed: ${response.status}`);
      const count = Object.keys(body.eyes ?? requestBody.eyes).length;
      const pdSaved = Boolean(
        body.binocularPd
        || requestBody.binocularPdDistance !== undefined
        || requestBody.binocularPdNear !== undefined
      );
      const savedScope = [
        count > 0 ? `${count} eye${count === 1 ? "" : "s"}` : "",
        pdSaved ? "binocular PD" : "",
      ].filter(Boolean).join(" and ");
      const status = {
        completed: true,
        summary: `Auto-Refraction / Auto-K saved for ${savedScope}`,
        savedAt: new Date().toISOString(),
        operator: OPERATOR,
      };
      setSaved(status);
      setSavedReferences({
        ...Object.fromEntries(EYES.flatMap((eye) => {
          const references = [body.eyes?.[eye]?.autoRefractionObservationReference, body.eyes?.[eye]?.autoKeratometryObservationReference]
            .filter((reference): reference is string => Boolean(reference));
          return references.length ? [[eye, references]] : [];
        })),
        ...(body.binocularPd?.observationReference ? { OU: [body.binocularPd.observationReference] } : {}),
      });
      onSaved(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionEditingProvider hasRecorded={Object.keys(savedReferences).length > 0}>
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-[1380px]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Auto-Refraction / Auto-K</h2>
            <p className="mt-1 text-sm text-white/45">Objective pretest measurements from manual entry or a future device feed</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
          <EditEntriesToggle />
          <ClearSectionButton
            encounterReference={encounterReference}
            sectionKey="auto-refraction"
            label="Auto-refraction / Auto-K"
            hasRecorded={Object.keys(savedReferences).length > 0}
            onCleared={(result) => {
              resetForm();
              onCleared?.({ scope: "section", result });
            }}
          />
          <label className="block min-w-[180px]">
            <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Source</span>
            <OdosSelect
              value={sourceType}
              disabled={definitionLoading}
              options={[
                { value: "", label: "Select" },
                ...sourceTypes.map((option) => ({ value: option.code, label: option.display })),
              ]}
              onChange={(value) => { editorRevisionRef.current += 1; setSourceType(value); }}
              ariaLabel="Source"
            />
          </label>
          </div>
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
          <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
            <div>
              <div className="grid grid-cols-[minmax(54px,max-content)_repeat(3,minmax(120px,180px))] gap-2 bg-white/[0.025] px-4 py-2 text-xs uppercase tracking-widest text-white/35">
                <div>Eye</div><div>Sphere</div><div>Cylinder</div><div>Axis</div>
              </div>
              {EYES.map((eye) => (
                <div key={eye} className="grid grid-cols-[minmax(54px,max-content)_repeat(3,minmax(120px,180px))] items-center gap-2 border-t border-white/10 px-4 py-3">
                  <div className="flex items-center gap-1 text-sm font-semibold text-white">
                    <span>{eye}</span>
                    {savedReferences[eye] && <RemoveValueButton label={`Auto-refraction ${eye}`} onRemove={() => removeSaved(eye)} />}
                  </div>
                  <PowerDropdown value={eyes[eye].sphere} options={sphereOptions} defaultValue="0.00" onChange={(value) => updateEye(eye, { sphere: value })} ariaLabel={`${eye} auto-refraction sphere`} formatOption={formatDiopterOption} />
                  <PowerDropdown value={eyes[eye].cylinder} options={cylinderOptions} defaultValue="0.00" onChange={(value) => updateEye(eye, { cylinder: value })} ariaLabel={`${eye} auto-refraction cylinder`} formatOption={formatDiopterOption} />
                  <AxisWheel
                    value={eyes[eye].axis}
                    onChange={(value) => updateEye(eye, { axis: value })}
                    ariaLabel={`${eye} auto-refraction axis`}
                    min={axisMinimum}
                    max={axisMaximum}
                    step={axisStep}
                  />
                </div>
              ))}
            </div>
            <div className="border-t border-white/10 bg-white/[0.015] p-4 lg:border-l lg:border-t-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-white/45">
                <span>Binocular PD (OU)</span>
                {savedReferences.OU && <RemoveValueButton label="Binocular PD" onRemove={() => removeSaved("OU")} />}
              </div>
              <p className="mt-1 text-xs text-white/35">Single distance and near measurements in millimeters.</p>
              <div className="mt-4 grid gap-3">
                <label>
                  <span className="mb-1 block text-xs text-[color:var(--odos-muted)]">Distance (mm)</span>
                  <PowerDropdown
                    value={binocularPdDistance}
                    options={binocularPdOptions}
                    defaultValue="63"
                    onChange={(value) => { editorRevisionRef.current += 1; setBinocularPdDistance(value); }}
                    ariaLabel="Binocular PD distance"
                    formatOption={(value) => `${value} mm`}
                  />
                </label>
                <label>
                  <span className="mb-1 block text-xs text-[color:var(--odos-muted)]">Near (mm)</span>
                  <PowerDropdown
                    value={binocularPdNear}
                    options={binocularPdOptions}
                    defaultValue="63"
                    onChange={(value) => { editorRevisionRef.current += 1; setBinocularPdNear(value); }}
                    ariaLabel="Binocular PD near"
                    formatOption={(value) => `${value} mm`}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded border border-white/10 bg-white/[0.02]">
          <div className="border-b border-white/10 bg-white/[0.03] px-4 py-3">
            <h3 className="text-sm font-semibold text-white">Auto-Keratometry</h3>
            <p className="mt-1 text-xs text-white/40">K values accept 30.00–60.00 D with up to two decimal places.</p>
          </div>
          <div className="grid grid-cols-[minmax(54px,max-content)_repeat(4,minmax(130px,190px))] gap-2 bg-white/[0.025] px-4 py-2 text-xs uppercase tracking-widest text-white/35">
            <div>Eye</div><div>Flat K</div><div>Flat Axis</div><div>Steep K</div><div>Steep Axis</div>
          </div>
          {EYES.map((eye) => (
            <div key={eye} className="grid grid-cols-[minmax(54px,max-content)_repeat(4,minmax(130px,190px))] items-center gap-2 border-t border-white/10 px-4 py-3">
              <div className="text-sm font-semibold text-white">{eye}</div>
              <PowerDropdown value={eyes[eye].flatK} options={flatKOptions} defaultValue="43.50" onChange={(value) => updateEye(eye, { flatK: value })} ariaLabel={`${eye} flat K`} />
              <AxisWheel value={eyes[eye].flatAxis} onChange={(value) => updateEye(eye, { flatAxis: value })} ariaLabel={`${eye} flat axis`} min={axisMinimum} max={axisMaximum} step={axisStep} />
              <PowerDropdown value={eyes[eye].steepK} options={steepKOptions} defaultValue="43.50" onChange={(value) => updateEye(eye, { steepK: value })} ariaLabel={`${eye} steep K`} />
              <AxisWheel value={eyes[eye].steepAxis} onChange={(value) => updateEye(eye, { steepAxis: value })} ariaLabel={`${eye} steep axis`} min={axisMinimum} max={axisMaximum} step={axisStep} />
            </div>
          ))}
        </div>

        <label className="mt-5 block">
          <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Remarks</span>
          <textarea
            value={remarks}
            onChange={(event) => { editorRevisionRef.current += 1; setRemarks(event.target.value); }}
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
    </SectionEditingProvider>
  );
}

function formatDiopterOption(option: string): string {
  return formatPowerOption(Number(option));
}

function AxisWheel({ value, onChange, ariaLabel, min, max, step }: {
  value: string;
  onChange(value: string): void;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <OdosWheel
      value={value === "" ? null : Number(value)}
      centerOn={0}
      min={min}
      max={max}
      step={step}
      format={String}
      onChange={(next) => onChange(String(next))}
      ariaLabel={ariaLabel}
      unit="°"
      states={[{ value: "", label: "Not recorded" }]}
      selectedState={value === "" ? "" : undefined}
      onStateChange={onChange}
    />
  );
}

function emptyEye(): EyeState {
  return { sphere: "", cylinder: "", axis: "", flatK: "", flatAxis: "", steepK: "", steepAxis: "" };
}

function savedValue(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
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

export function buildAutoRefractionRequestBody(input: {
  patientReference: string;
  encounterReference: string;
  sourceType: string;
  remarks: string;
  binocularPdDistance: string;
  binocularPdNear: string;
  eyes: Record<Eye, EyeState>;
}) {
  const binocularPdDistance = parseOptionalNumber(input.binocularPdDistance);
  const binocularPdNear = parseOptionalNumber(input.binocularPdNear);
  return {
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    sourceType: input.sourceType,
    ...(input.remarks.trim() ? { remarks: input.remarks.trim() } : {}),
    ...(binocularPdDistance !== undefined ? { binocularPdDistance } : {}),
    ...(binocularPdNear !== undefined ? { binocularPdNear } : {}),
    eyes: buildPayload(input.eyes),
  };
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function definedRecord<T extends Record<string, unknown>>(value: T): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Record<string, number>;
}
