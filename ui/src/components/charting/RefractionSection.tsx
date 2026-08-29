import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { LENS_DESIGN_TYPES } from "../../lib/lens-catalog";
import type { SectionSaveStatus } from "./types";
import { formatPowerOption, numericOptions } from "./power-options";
import { PowerDropdown } from "./PowerDropdown";
import { VaValueSelect } from "./VaValueSelect";
import { DiagnosisPicker } from "./DiagnosisPicker";
import { OdosSelect } from "../inputs/OdosSelect";
import { OdosWheel } from "../inputs/OdosWheel";
import {
  copyRefractionValues,
  refractionCopySources,
  type PrescriptionHistoryResponse,
} from "./prescription-copy";

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
  display?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: DefinitionOption[];
}

interface RefractionDefinitionResponse {
  definition: {
    fields: Record<string, DefinitionField>;
  };
  diagnosisOptions: DiagnosisOption[];
  refractiveThreshold: number;
}

interface DiagnosisOption {
  code: string;
  display: string;
  family: string;
  laterality: string;
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
  distancePinholeVisualAcuity: string;
}

interface BlockState {
  id: string;
  type: string;
  purpose: string;
  lensDesign: string;
  overContacts: boolean;
  remarks: string;
  prismEnabled: boolean;
  OD: EyeState;
  OS: EyeState;
}

interface EyePayload {
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  prismAmount?: number;
  prismBase?: string;
  distanceVisualAcuity?: string;
  nearVisualAcuity?: string;
  distancePinholeVisualAcuity?: string;
}

interface BlockPayload {
  type: string;
  purpose?: string;
  lensDesign?: string;
  overContacts: boolean;
  remarks?: string;
  OD?: EyePayload;
  OS?: EyePayload;
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "ODOS UI clinical_graph_refraction";

export function RefractionSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<RefractionDefinitionResponse | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [definitionRefresh, setDefinitionRefresh] = useState(0);
  const [blocks, setBlocks] = useState<BlockState[]>(() => [emptyBlock(), emptyBlock()]);
  const [savedObservationReferences, setSavedObservationReferences] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [sourceType, setSourceType] = useState("manual");
  const [history, setHistory] = useState<PrescriptionHistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDefinitionLoading(true);
    setDefinitionError(null);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/refraction/definition`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Refraction definition request failed: ${response.status}`);
        }
        return (await response.json()) as RefractionDefinitionResponse;
      })
      .then((body) => {
        setDefinition(body);
        const options = activeOptions(body.definition.fields.type);
        setSourceType((current) => current || activeOptions(body.definition.fields.sourceType)[0]?.code || "manual");
        setBlocks((current) => current.map((block, index) => ({
          ...block,
          type: block.type || options[index]?.code || options[0]?.code || "",
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
  }, [definitionRefresh]);

  useEffect(() => {
    const controller = new AbortController();
    setHistory(null);
    setHistoryError(null);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/refraction/history?${new URLSearchParams({ patient: patientReference })}`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as PrescriptionHistoryResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `Prescription history request failed: ${response.status}`);
        return body;
      })
      .then((body) => {
        if (!controller.signal.aborted) setHistory(body);
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          setHistoryError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => controller.abort();
  }, [patientReference]);

  const fields = definition?.definition.fields ?? {};
  const typeOptions = useMemo(() => activeOptions(fields.type), [fields.type]);
  const sourceTypes = useMemo(() => activeOptions(fields.sourceType), [fields.sourceType]);
  const powerOptions = useMemo(() => numericOptions(fields.sphere, -20, 20, 0.25), [fields.sphere]);
  const prismOptions = useMemo(() => numericOptions(fields.prismAmount, 0.25, 20, 0.25), [fields.prismAmount]);
  const prismBases = useMemo(() => activeOptions(fields.prismBase), [fields.prismBase]);
  const purposes = useMemo(() => activeOptions(fields.purpose), [fields.purpose]);
  const axisMinimum = fields.axis?.minimum ?? 0;
  const axisMaximum = fields.axis?.maximum ?? 180;
  const axisStep = fields.axis?.step ?? 1;
  const typeLabels = useMemo(
    () => Object.fromEntries(typeOptions.map((option) => [option.code, option.display])),
    [typeOptions],
  );

  function updateBlock(blockId: string, next: Partial<BlockState>) {
    setBlocks((current) => current.map((block) => block.id === blockId ? { ...block, ...next } : block));
    clearSavedObservationReferences(blockId);
  }

  function updateEye(blockId: string, eye: Eye, next: Partial<EyeState>) {
    setBlocks((current) => current.map((block) =>
      block.id === blockId
        ? { ...block, [eye]: { ...block[eye], ...next } }
        : block));
    clearSavedObservationReferences(blockId);
  }

  function togglePrism(blockId: string) {
    setBlocks((current) => current.map((block) => {
      if (block.id !== blockId) return block;
      if (!block.prismEnabled) return { ...block, prismEnabled: true };
      return {
        ...block,
        prismEnabled: false,
        OD: { ...block.OD, prismAmount: "", prismBase: "" },
        OS: { ...block.OS, prismAmount: "", prismBase: "" },
      };
    }));
    clearSavedObservationReferences(blockId);
  }

  function addBlock() {
    const manifest = typeOptions.find((option) => option.code === "MANIFEST")?.code;
    setBlocks((current) => [...current, emptyBlock(manifest ?? typeOptions[0]?.code ?? "")]);
  }

  function copyOdToOs(blockId: string) {
    setBlocks((current) => current.map((block) =>
      block.id === blockId ? { ...block, OS: { ...block.OD } } : block));
    clearSavedObservationReferences(blockId);
  }

  function pullFromSource(blockId: string, sourceId: string) {
    if (!sourceId) return;
    setBlocks((current) => {
      const source = refractionCopySources(current, blockId, history, encounterReference, typeLabels)
        .find((candidate) => candidate.id === sourceId);
      if (!source) return current;
      return current.map((block) => block.id === blockId ? copyRefractionValues(block, source) : block);
    });
    clearSavedObservationReferences(blockId);
  }

  function removeBlock(blockId: string) {
    setBlocks((current) => current.filter((candidate) => candidate.id !== blockId));
    clearSavedObservationReferences(blockId);
  }

  function clearSavedObservationReferences(blockId: string) {
    setSavedObservationReferences((current) => {
      if (!(blockId in current)) return current;
      const next = { ...current };
      delete next[blockId];
      return next;
    });
  }

  async function save() {
    let payloadEntries: Array<{ blockId: string; payload: BlockPayload }>;
    try {
      payloadEntries = buildPayload(blocks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (payloadEntries.length === 0) {
      setError("Enter at least one refraction block before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/refraction`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ patientReference, encounterReference, sourceType, blocks: payloadEntries.map((entry) => entry.payload) }),
      });
      const body = (await response.json()) as {
        blocks?: Array<{ eyes?: Partial<Record<Eye, { observationReference?: string }>> }>;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `Refraction save failed: ${response.status}`);
      }
      setSavedObservationReferences(Object.fromEntries((body.blocks ?? []).flatMap((savedBlock, index) => {
        const blockId = payloadEntries[index]?.blockId;
        return blockId ? [[
          blockId,
          Object.values(savedBlock.eyes ?? {}).flatMap((eye) => eye?.observationReference ? [eye.observationReference] : []),
        ]] : [];
      })));
      const savedBlockCount = body.blocks?.length ?? payloadEntries.length;
      const status = {
        completed: true,
        summary: `${savedBlockCount} refraction block${savedBlockCount === 1 ? "" : "s"} saved`,
        savedAt: new Date().toISOString(),
        operator: OPERATOR,
      };
      setSaved(status);
      onSaved(status);
      setDefinitionRefresh((current) => current + 1);
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
            <h2 className="text-lg font-semibold text-white">Refraction</h2>
            <p className="mt-1 text-sm text-white/45">Typed OD/OS blocks with Manifest-only diagnosis suggestions</p>
          </div>
          <div className="flex items-end gap-3">
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
              onClick={addBlock}
              disabled={definitionLoading || typeOptions.length === 0}
              className="rounded border border-brand/50 bg-brand/10 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand/20 disabled:opacity-45"
            >
              ＋ Add refraction
            </button>
          </div>
        </div>

        {definitionError && (
          <div className="mt-5 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {definitionError}
          </div>
        )}
        {historyError && (
          <div className="mt-5 rounded border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
            Copy sources unavailable: {historyError}
          </div>
        )}

        <div className="mt-5 space-y-5">
          {blocks.map((block, blockIndex) => {
            const copySources = refractionCopySources(blocks, block.id, history, encounterReference, typeLabels);
            return (
              <div key={block.id} className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
              <div className="flex flex-wrap items-end gap-3 border-b border-white/10 bg-white/[0.03] p-4">
                <label className="block min-w-[220px]">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Refraction Type</span>
                  <OdosSelect
                    value={block.type}
                    disabled={definitionLoading}
                    options={[
                      { value: "", label: "Select" },
                      ...typeOptions.map((option) => ({ value: option.code, label: option.display })),
                    ]}
                    onChange={(type) => updateBlock(block.id, { type })}
                    ariaLabel="Refraction type"
                  />
                </label>
                <label className="block min-w-[260px] flex-1">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Pull values from</span>
                  <OdosSelect
                    value=""
                    options={copySources.length > 0
                      ? [{ value: "", label: "Pull from…" }, ...copySources.map((source) => ({ value: source.id, label: source.label }))]
                      : [{ value: "", label: "No populated prescription sources" }]}
                    onChange={(sourceId) => pullFromSource(block.id, sourceId)}
                    ariaLabel={`Pull values into refraction ${blockIndex + 1}`}
                    disabled={copySources.length === 0}
                  />
                </label>
                <label className="block min-w-[260px] flex-1">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Purpose</span>
                  <OdosSelect
                    value={block.purpose}
                    options={[
                      { value: "", label: "Select" },
                      ...purposes.map((purpose) => ({ value: purpose.code, label: purpose.display })),
                    ]}
                    onChange={(purpose) => updateBlock(block.id, { purpose })}
                    ariaLabel={`Refraction ${blockIndex + 1} purpose`}
                  />
                </label>
                <label className="block min-w-[260px] flex-1">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Lens Design</span>
                  <OdosSelect
                    value={block.lensDesign}
                    options={[
                      { value: "", label: "Select" },
                      ...LENS_DESIGN_TYPES.map((lensDesign) => ({ value: lensDesign, label: lensDesign })),
                    ]}
                    onChange={(lensDesign) => updateBlock(block.id, { lensDesign })}
                    ariaLabel={`Refraction ${blockIndex + 1} lens design`}
                  />
                </label>
                <label className="flex h-10 items-center gap-2 rounded border border-white/15 px-3 text-sm text-white/65">
                  <input
                    type="checkbox"
                    aria-label={`Refraction ${blockIndex + 1} over contacts`}
                    checked={block.overContacts}
                    onChange={(event) => updateBlock(block.id, { overContacts: event.target.checked })}
                    className="accent-brand"
                  />
                  Over contacts
                </label>
                <label className="block min-w-[260px] flex-1">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Remarks</span>
                  <input
                    value={block.remarks}
                    onChange={(event) => updateBlock(block.id, { remarks: event.target.value })}
                    maxLength={2000}
                    placeholder="Optional clinical remarks"
                    className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
                  />
                </label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={block.prismEnabled}
                  aria-label={`Prism for refraction ${blockIndex + 1}`}
                  onClick={() => togglePrism(block.id)}
                  className={`rounded border px-3 py-2 text-sm font-semibold transition ${block.prismEnabled ? "border-brand/60 bg-brand/15 text-white" : "border-white/15 text-white/55 hover:border-brand/40 hover:text-white"}`}
                >
                  Prism {block.prismEnabled ? "On" : "Off"}
                </button>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs uppercase tracking-widest text-white/25">Block {blockIndex + 1}</span>
                  {blocks.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeBlock(block.id)}
                      className="rounded border border-white/10 px-2 py-1 text-xs text-white/45 hover:border-red-400/40 hover:text-red-100"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className={block.prismEnabled ? "min-w-[1510px]" : "min-w-[1320px]"}>
                  <div className={`grid ${block.prismEnabled ? "grid-cols-[54px_repeat(4,105px)_110px_100px_repeat(3,minmax(220px,1fr))_100px]" : "grid-cols-[54px_repeat(4,105px)_repeat(3,minmax(220px,1fr))_100px]"} gap-2 bg-white/[0.025] px-4 py-2 text-xs uppercase tracking-widest text-white/35`}>
                    <div>Eye</div><div>Sphere</div><div>Cylinder</div><div>Axis</div><div>Add</div>
                    {block.prismEnabled && <><div>Prism</div><div>Base</div></>}
                    <div>Dist VA</div><div>Near VA</div><div>Dist PH</div><div />
                  </div>
                  {EYES.map((eye) => (
                    <div key={eye} className={`grid ${block.prismEnabled ? "grid-cols-[54px_repeat(4,105px)_110px_100px_repeat(3,minmax(220px,1fr))_100px]" : "grid-cols-[54px_repeat(4,105px)_repeat(3,minmax(220px,1fr))_100px]"} items-center gap-2 border-t border-white/10 px-4 py-3`}>
                      <div className="text-sm font-semibold text-white">{eye}</div>
                      {(["sphere", "cylinder", "add"] as const).slice(0, 2).map((field) => (
                        <PowerDropdown
                          key={field}
                          value={block[eye][field]}
                          onChange={(value) => updateEye(block.id, eye, { [field]: value })}
                          options={powerOptions}
                          defaultValue="0.00"
                          ariaLabel={`${eye} ${field}`}
                          formatOption={formatDiopterOption}
                        />
                      ))}
                      <OdosWheel
                        value={block[eye].axis === "" ? null : Number(block[eye].axis)}
                        centerOn={0}
                        min={axisMinimum}
                        max={axisMaximum}
                        step={axisStep}
                        format={String}
                        onChange={(value) => updateEye(block.id, eye, { axis: String(value) })}
                        ariaLabel={`${eye} axis`}
                        unit="°"
                        states={[{ value: "", label: "Not recorded" }]}
                        selectedState={block[eye].axis === "" ? "" : undefined}
                        onStateChange={(value) => updateEye(block.id, eye, { axis: value })}
                      />
                      <PowerDropdown
                        value={block[eye].add}
                        onChange={(value) => updateEye(block.id, eye, { add: value })}
                        options={powerOptions}
                        defaultValue="0.00"
                        ariaLabel={`${eye} add`}
                        formatOption={formatDiopterOption}
                      />
                      {block.prismEnabled && (
                        <>
                          <PowerDropdown
                            value={block[eye].prismAmount}
                            options={prismOptions}
                            defaultValue="0.25"
                            onChange={(value) => updateEye(block.id, eye, { prismAmount: value })}
                            ariaLabel={`${eye} prism amount`}
                          />
                          <OdosSelect
                            value={block[eye].prismBase}
                            options={[
                              { value: "", label: "Select" },
                              ...prismBases.map((option) => ({ value: option.code, label: option.display })),
                            ]}
                            onChange={(prismBase) => updateEye(block.id, eye, { prismBase })}
                            ariaLabel={`${eye} prism base`}
                          />
                        </>
                      )}
                      <VaValueSelect
                        value={block[eye].distanceVisualAcuity}
                        onChange={(value) => updateEye(block.id, eye, { distanceVisualAcuity: value })}
                        ariaLabel={`${eye} distance visual acuity`}
                      />
                      <VaValueSelect
                        value={block[eye].nearVisualAcuity}
                        onChange={(value) => updateEye(block.id, eye, { nearVisualAcuity: value })}
                        ariaLabel={`${eye} near visual acuity`}
                      />
                      <VaValueSelect
                        value={block[eye].distancePinholeVisualAcuity}
                        onChange={(value) => updateEye(block.id, eye, { distancePinholeVisualAcuity: value })}
                        ariaLabel={`${eye} distance pinhole visual acuity`}
                      />
                      <div>
                        {eye === "OD" && (
                          <button
                            type="button"
                            onClick={() => copyOdToOs(block.id)}
                            className="rounded border border-white/15 px-2 py-2 text-xs text-white/65 hover:border-brand/50 hover:text-white"
                          >
                            Copy OD→OS
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-4 pb-4">
                <DiagnosisPicker
                  encounterReference={encounterReference}
                  observationReferences={savedObservationReferences[block.id] ?? []}
                  findingDefinitionKey="refraction"
                />
              </div>
              </div>
            );
          })}
        </div>

        <SectionFooter error={error} saved={saved} saving={saving || definitionLoading} onSave={save} />
      </div>
    </section>
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
        type="button"
        onClick={onSave}
        disabled={saving}
        className="rounded border border-brand/60 bg-brand/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Refraction"}
      </button>
    </div>
  );
}

function formatDiopterOption(option: string): string {
  return formatPowerOption(Number(option));
}

function emptyBlock(type = ""): BlockState {
  return {
    id: crypto.randomUUID(),
    type,
    purpose: "",
    lensDesign: "",
    overContacts: false,
    remarks: "",
    prismEnabled: false,
    OD: emptyEye(),
    OS: emptyEye(),
  };
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
    distancePinholeVisualAcuity: "",
  };
}

function buildPayload(blocks: BlockState[]): Array<{ blockId: string; payload: BlockPayload }> {
  return blocks.flatMap((block, blockIndex) => {
    const eyes = Object.fromEntries(EYES.flatMap((eye) => {
      const row = block[eye];
      if (!eyeTouched(row)) return [];
      if ((row.cylinder && !row.axis) || (!row.cylinder && row.axis)) {
        throw new Error(`Block ${blockIndex + 1} ${eye} cylinder and axis must be saved together.`);
      }
      if ((row.prismAmount && !row.prismBase) || (!row.prismAmount && row.prismBase)) {
        throw new Error(`Block ${blockIndex + 1} ${eye} prism amount and base must be saved together.`);
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
        distancePinholeVisualAcuity: row.distancePinholeVisualAcuity || undefined,
      })]];
    })) as Partial<Record<Eye, EyePayload>>;
    if (Object.keys(eyes).length === 0) return [];
    if (!block.type) {
      throw new Error(`Block ${blockIndex + 1} requires a refraction type.`);
    }
    return [{
      blockId: block.id,
      payload: {
        type: block.type,
        ...(block.purpose.trim() ? { purpose: block.purpose.trim() } : {}),
        ...(block.lensDesign ? { lensDesign: block.lensDesign } : {}),
        overContacts: block.overContacts,
        ...(block.remarks.trim() ? { remarks: block.remarks.trim() } : {}),
        ...eyes,
      },
    }];
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
