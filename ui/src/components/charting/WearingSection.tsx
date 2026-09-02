import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { formatPowerOption, numericOptions } from "./power-options";
import { PowerDropdown } from "./PowerDropdown";
import type { SectionSaveStatus } from "./types";
import { VaValueSelect } from "./VaValueSelect";
import { OdosSelect } from "../inputs/OdosSelect";
import { OdosWheel } from "../inputs/OdosWheel";
import { ClearSectionButton } from "./ClearControls";
import { useEncounterEdit } from "./encounter-edit-context";

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
  options?: DefinitionOption[];
}

interface WearingDefinitionResponse {
  definition: { fields: Record<string, DefinitionField> };
}

interface EyeState {
  sphere: string;
  cylinder: string;
  axis: string;
  add: string;
  prismAmount: string;
  prismBase: string;
  distanceVisualAcuity: string;
  nearVisualAcuity: string;
}

interface PairState {
  id: string;
  eyeglassType: string;
  remarks: string;
  OD: EyeState;
  OS: EyeState;
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "ODOS UI clinical_graph_wearing";

export function WearingSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<WearingDefinitionResponse | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [pairs, setPairs] = useState<PairState[]>(() => [emptyPair()]);
  const [leftGlassesAtHome, setLeftGlassesAtHome] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [sourceType, setSourceType] = useState("manual");
  const { onCleared } = useEncounterEdit();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${clinicalGraphApiBase()}/clinical-graph/wearing/definition`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Wearing definition request failed: ${response.status}`);
        return await response.json() as WearingDefinitionResponse;
      })
      .then((body) => {
        setDefinition(body);
        const firstType = activeOptions(body.definition.fields.eyeglassType)[0]?.code ?? "";
        setSourceType(activeOptions(body.definition.fields.sourceType)[0]?.code ?? "manual");
        setPairs((current) => current.map((pair) => ({
          ...pair,
          eyeglassType: pair.eyeglassType || firstType,
        })));
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

  const fields = definition?.definition.fields ?? {};
  const eyeglassTypes = useMemo(() => activeOptions(fields.eyeglassType), [fields.eyeglassType]);
  const sourceTypes = useMemo(() => activeOptions(fields.sourceType), [fields.sourceType]);
  const prismBases = useMemo(() => activeOptions(fields.prismBase), [fields.prismBase]);
  const sphereOptions = useMemo(() => numericOptions(undefined, -16, 12, 0.25).reverse(), []);
  const cylinderOptions = useMemo(() => numericOptions(undefined, -8, 0, 0.25).reverse(), []);
  const addOptions = useMemo(() => numericOptions(undefined, 0.5, 5, 0.25), []);
  const axisMinimum = fields.axis?.minimum ?? 0;
  const axisMaximum = fields.axis?.maximum ?? 180;
  const axisStep = fields.axis?.step ?? 1;
  const prismOptions = useMemo(() => numericOptions(fields.prismAmount, 0.25, 20, 0.25), [fields.prismAmount]);

  function updatePair(pairId: string, next: Partial<PairState>) {
    setPairs((current) => current.map((pair) => pair.id === pairId ? { ...pair, ...next } : pair));
  }

  function updateEye(pairId: string, eye: Eye, next: Partial<EyeState>) {
    setPairs((current) => current.map((pair) => pair.id === pairId
      ? { ...pair, [eye]: { ...pair[eye], ...next } }
      : pair));
  }

  function addPair() {
    setPairs((current) => [...current, emptyPair(eyeglassTypes[0]?.code ?? "")]);
  }

  function toggleLeftAtHome(checked: boolean) {
    setLeftGlassesAtHome(checked);
    setError(null);
    if (checked) setPairs([emptyPair(eyeglassTypes[0]?.code ?? "")]);
  }

  function resetForm() {
    setPairs([emptyPair(eyeglassTypes[0]?.code ?? "")]);
    setLeftGlassesAtHome(false);
    setSaved(null);
    setError(null);
  }

  async function save() {
    let payloadPairs: Array<Record<string, unknown>> = [];
    try {
      if (!leftGlassesAtHome) payloadPairs = buildPayload(pairs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/wearing`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          patientReference,
          encounterReference,
          sourceType,
          leftGlassesAtHome,
          pairs: payloadPairs,
        }),
      });
      const body = await response.json() as { pairs?: unknown[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Wearing save failed: ${response.status}`);
      const count = body.pairs?.length ?? 0;
      const status = {
        completed: true,
        summary: leftGlassesAtHome
          ? "Left glasses at home saved"
          : `${count} Wearing pair${count === 1 ? "" : "s"} saved`,
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
      <div className="max-w-[1500px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Wearing (WRx)</h2>
            <p className="mt-1 text-sm text-white/45">Pretest lensometer capture for glasses worn into the visit</p>
          </div>
          <div className="flex items-end gap-3">
            <ClearSectionButton
              encounterReference={encounterReference}
              sectionKey="wearing"
              label="Wearing Rx"
              hasRecorded={saved !== null}
              probeOnMount
              onCleared={(result) => {
                resetForm();
                onCleared?.({ scope: "section", result });
              }}
            />
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-white/35">Source</span>
              <OdosSelect
                value={sourceType}
                options={sourceTypes.map((option) => ({ value: option.code, label: option.display }))}
                onChange={setSourceType}
                ariaLabel="Source"
              />
            </label>
            <button
              type="button"
              onClick={addPair}
              disabled={definitionLoading || leftGlassesAtHome || eyeglassTypes.length === 0}
              className="rounded border border-brand/50 bg-brand/10 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand/20 disabled:opacity-45"
            >
              ＋ Add pair
            </button>
          </div>
        </div>

        <label className="mt-5 flex items-center gap-3 rounded border border-white/10 bg-white/[0.03] p-4 text-sm text-white/80">
          <input
            type="checkbox"
            checked={leftGlassesAtHome}
            onChange={(event) => toggleLeftAtHome(event.target.checked)}
            className="h-4 w-4 accent-brand"
          />
          Left glasses at home
          <span className="text-xs text-white/40">Save the status without prescription values.</span>
        </label>

        {definitionError && (
          <div className="mt-5 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {definitionError}
          </div>
        )}

        <fieldset disabled={leftGlassesAtHome || definitionLoading} className="mt-5 space-y-5 disabled:opacity-45">
          {pairs.map((pair, pairIndex) => (
            <div key={pair.id} className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
              <div className="flex flex-wrap items-end gap-3 border-b border-white/10 bg-white/[0.03] p-4">
                <label className="block min-w-[280px]">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Eyeglass Type</span>
                  <OdosSelect
                    value={pair.eyeglassType}
                    options={[
                      { value: "", label: "Select" },
                      ...eyeglassTypes.map((option) => ({ value: option.code, label: option.display })),
                    ]}
                    onChange={(eyeglassType) => updatePair(pair.id, { eyeglassType })}
                    ariaLabel="Eyeglass type"
                  />
                </label>
                <label className="block min-w-[300px] flex-1">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Remarks</span>
                  <input
                    value={pair.remarks}
                    onChange={(event) => updatePair(pair.id, { remarks: event.target.value })}
                    maxLength={2000}
                    placeholder="Optional remarks about this pair"
                    className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
                  />
                </label>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs uppercase tracking-widest text-white/25">Pair {pairIndex + 1}</span>
                  {pairs.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPairs((current) => current.filter((candidate) => candidate.id !== pair.id))}
                      className="rounded border border-white/10 px-2 py-1 text-xs text-white/45 hover:border-red-400/40 hover:text-red-100"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className="min-w-[1510px]">
                  <div className="grid grid-cols-[54px_repeat(4,105px)_110px_100px_repeat(2,minmax(220px,1fr))] gap-2 bg-white/[0.025] px-4 py-2 text-xs uppercase tracking-widest text-white/35">
                    <div>Eye</div><div>Sphere</div><div>Cylinder</div><div>Axis</div><div>Add</div>
                    <div>Prism</div><div>Base</div><div>Dist VA</div><div>Near VA</div>
                  </div>
                  {EYES.map((eye) => (
                    <div key={eye} className="grid grid-cols-[54px_repeat(4,105px)_110px_100px_repeat(2,minmax(220px,1fr))] items-center gap-2 border-t border-white/10 px-4 py-3">
                      <div className="text-sm font-semibold text-white">{eye}</div>
                      <PowerDropdown value={pair[eye].sphere} options={sphereOptions} defaultValue="0.00" onChange={(value) => updateEye(pair.id, eye, { sphere: value })} ariaLabel={`${eye} sphere`} formatOption={formatDiopterOption} />
                      <PowerDropdown value={pair[eye].cylinder} options={cylinderOptions} defaultValue="0.00" onChange={(value) => updateEye(pair.id, eye, { cylinder: value })} ariaLabel={`${eye} cylinder`} formatOption={formatDiopterOption} />
                      <OdosWheel
                        value={pair[eye].axis === "" ? null : Number(pair[eye].axis)}
                        centerOn={0}
                        min={axisMinimum}
                        max={axisMaximum}
                        step={axisStep}
                        format={String}
                        onChange={(value) => updateEye(pair.id, eye, { axis: String(value) })}
                        ariaLabel={`${eye} axis`}
                        unit="°"
                        states={[{ value: "", label: "Not recorded" }]}
                        selectedState={pair[eye].axis === "" ? "" : undefined}
                        onStateChange={(value) => updateEye(pair.id, eye, { axis: value })}
                      />
                      <PowerDropdown value={pair[eye].add} options={addOptions} defaultValue="0.50" onChange={(value) => updateEye(pair.id, eye, { add: value })} ariaLabel={`${eye} add`} formatOption={formatDiopterOption} />
                      <PowerDropdown value={pair[eye].prismAmount} options={prismOptions} defaultValue="0.25" onChange={(value) => updateEye(pair.id, eye, { prismAmount: value })} ariaLabel={`${eye} prism amount`} />
                      <OdosSelect
                        value={pair[eye].prismBase}
                        options={[
                          { value: "", label: "Select" },
                          ...prismBases.map((option) => ({ value: option.code, label: option.display })),
                        ]}
                        onChange={(prismBase) => updateEye(pair.id, eye, { prismBase })}
                        ariaLabel={`${eye} prism base`}
                      />
                      <VaValueSelect value={pair[eye].distanceVisualAcuity} onChange={(value) => updateEye(pair.id, eye, { distanceVisualAcuity: value })} ariaLabel={`${eye} distance visual acuity`} />
                      <VaValueSelect value={pair[eye].nearVisualAcuity} onChange={(value) => updateEye(pair.id, eye, { nearVisualAcuity: value })} ariaLabel={`${eye} near visual acuity`} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </fieldset>

        <SectionFooter error={error} saved={saved} saving={saving || definitionLoading} onSave={save} />
      </div>
    </section>
  );
}

function SectionFooter({ error, saved, saving, onSave }: {
  error: string | null;
  saved: SectionSaveStatus | null;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-h-10">
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
        {saved && !error && <div className="text-sm text-white/70">{saved.summary}</div>}
      </div>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Wearing"}
      </button>
    </div>
  );
}

function formatDiopterOption(option: string): string {
  return formatPowerOption(Number(option));
}

function emptyPair(eyeglassType = ""): PairState {
  return { id: crypto.randomUUID(), eyeglassType, remarks: "", OD: emptyEye(), OS: emptyEye() };
}

function emptyEye(): EyeState {
  return {
    sphere: "",
    cylinder: "",
    axis: "",
    add: "",
    prismAmount: "",
    prismBase: "",
    distanceVisualAcuity: "",
    nearVisualAcuity: "",
  };
}

function buildPayload(pairs: PairState[]): Array<Record<string, unknown>> {
  return pairs.map((pair, pairIndex) => {
    if (!pair.eyeglassType) throw new Error(`Pair ${pairIndex + 1} requires an eyeglass type.`);
    const eyes = Object.fromEntries(EYES.flatMap((eye) => {
      const row = pair[eye];
      if (!eyeTouched(row)) return [];
      if ((row.cylinder && !row.axis) || (!row.cylinder && row.axis)) {
        throw new Error(`Pair ${pairIndex + 1} ${eye} cylinder and axis must be saved together.`);
      }
      if ((row.prismAmount && !row.prismBase) || (!row.prismAmount && row.prismBase)) {
        throw new Error(`Pair ${pairIndex + 1} ${eye} prism amount and base must be saved together.`);
      }
      return [[eye, definedRecord({
        sphere: parseOptionalNumber(row.sphere),
        cylinder: parseOptionalNumber(row.cylinder),
        axis: parseOptionalNumber(row.axis),
        add: parseOptionalNumber(row.add),
        prismAmount: parseOptionalNumber(row.prismAmount),
        prismBase: row.prismBase || undefined,
        distanceVisualAcuity: row.distanceVisualAcuity || undefined,
        nearVisualAcuity: row.nearVisualAcuity || undefined,
      })]];
    }));
    if (Object.keys(eyes).length === 0) throw new Error(`Pair ${pairIndex + 1} requires at least one populated eye.`);
    return {
      eyeglassType: pair.eyeglassType,
      ...(pair.remarks.trim() ? { remarks: pair.remarks.trim() } : {}),
      ...eyes,
    };
  });
}

function eyeTouched(row: EyeState): boolean {
  return Object.values(row).some((value) => value.trim());
}

function parseOptionalNumber(value: string): number | undefined {
  return value ? Number(value) : undefined;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function definedRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
