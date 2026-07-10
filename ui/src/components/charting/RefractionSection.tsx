import { useEffect, useMemo, useState } from "react";
import { fhir } from "../../lib/fhir";
import type { SectionSaveStatus } from "./types";
import { formatPowerOption, numericOptions } from "./power-options";
import { VaValueSelect } from "./VaValueSelect";

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

interface Suggestion {
  id: string;
  code: string;
  display: string;
  family: string;
  explanation: string;
  visitState: string;
}

interface EyeState {
  sphere: string;
  cylinder: string;
  axis: string;
  add: string;
  distanceVisualAcuity: string;
  nearVisualAcuity: string;
  distancePinholeVisualAcuity: string;
}

interface BlockState {
  id: string;
  type: string;
  purpose: string;
  remarks: string;
  OD: EyeState;
  OS: EyeState;
}

interface EyePayload {
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  distanceVisualAcuity?: string;
  nearVisualAcuity?: string;
  distancePinholeVisualAcuity?: string;
}

interface BlockPayload {
  type: string;
  purpose?: string;
  remarks?: string;
  OD?: EyePayload;
  OS?: EyePayload;
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "OSOD UI clinical_graph_refraction";

export function RefractionSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<RefractionDefinitionResponse | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [definitionRefresh, setDefinitionRefresh] = useState(0);
  const [blocks, setBlocks] = useState<BlockState[]>(() => [emptyBlock(), emptyBlock()]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestionSelections, setSuggestionSelections] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [sourceType, setSourceType] = useState("manual");

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

  const fields = definition?.definition.fields ?? {};
  const typeOptions = useMemo(() => activeOptions(fields.type), [fields.type]);
  const sourceTypes = useMemo(() => activeOptions(fields.sourceType), [fields.sourceType]);
  const powerOptions = useMemo(() => numericOptions(fields.sphere, -20, 20, 0.25), [fields.sphere]);
  const axisOptions = useMemo(() => numericOptions(fields.axis, 0, 180, 1), [fields.axis]);

  function updateBlock(blockId: string, next: Partial<BlockState>) {
    setBlocks((current) => current.map((block) => block.id === blockId ? { ...block, ...next } : block));
  }

  function updateEye(blockId: string, eye: Eye, next: Partial<EyeState>) {
    setBlocks((current) => current.map((block) =>
      block.id === blockId
        ? { ...block, [eye]: { ...block[eye], ...next } }
        : block));
  }

  function addBlock() {
    const manifest = typeOptions.find((option) => option.code === "MANIFEST")?.code;
    setBlocks((current) => [...current, emptyBlock(manifest ?? typeOptions[0]?.code ?? "")]);
  }

  function copyOdToOs(blockId: string) {
    setBlocks((current) => current.map((block) =>
      block.id === blockId ? { ...block, OS: { ...block.OD } } : block));
  }

  async function save() {
    let payloadBlocks: BlockPayload[];
    try {
      payloadBlocks = buildPayload(blocks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (payloadBlocks.length === 0) {
      setError("Enter at least one refraction block before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/refraction`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ patientReference, encounterReference, sourceType, blocks: payloadBlocks }),
      });
      const body = (await response.json()) as {
        blocks?: unknown[];
        suggestions?: Suggestion[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `Refraction save failed: ${response.status}`);
      }
      const nextSuggestions = body.suggestions ?? [];
      setSuggestions(nextSuggestions);
      setSuggestionSelections(Object.fromEntries(nextSuggestions.map((suggestion) => [suggestion.id, suggestion.code])));
      const savedBlockCount = body.blocks?.length ?? payloadBlocks.length;
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
            <label className="block"><span className="mb-1 block text-xs uppercase tracking-wide text-white/35">Source</span><select value={sourceType} onChange={(event) => setSourceType(event.target.value)} className="h-10 rounded border border-white/15 bg-bg-deep px-3 text-sm text-white">{sourceTypes.map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}</select></label>
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

        <div className="mt-5 space-y-5">
          {blocks.map((block, blockIndex) => (
            <div key={block.id} className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
              <div className="flex flex-wrap items-end gap-3 border-b border-white/10 bg-white/[0.03] p-4">
                <label className="block min-w-[220px]">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Refraction Type</span>
                  <select
                    value={block.type}
                    onChange={(event) => updateBlock(block.id, { type: event.target.value })}
                    disabled={definitionLoading}
                    className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand disabled:opacity-45"
                  >
                    <option value="">Select</option>
                    {typeOptions.map((option) => (
                      <option key={option.code} value={option.code}>{option.display}</option>
                    ))}
                  </select>
                </label>
                <label className="block min-w-[260px] flex-1">
                  <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">Purpose</span>
                  <input
                    value={block.purpose}
                    onChange={(event) => updateBlock(block.id, { purpose: event.target.value })}
                    placeholder={block.type === "FINAL_RX" ? "General wear" : "Optional"}
                    className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
                  />
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
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-xs uppercase tracking-widest text-white/25">Block {blockIndex + 1}</span>
                  {blocks.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setBlocks((current) => current.filter((candidate) => candidate.id !== block.id))}
                      className="rounded border border-white/10 px-2 py-1 text-xs text-white/45 hover:border-red-400/40 hover:text-red-100"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <div className="min-w-[1320px]">
                  <div className="grid grid-cols-[54px_repeat(4,105px)_repeat(3,minmax(220px,1fr))_100px] gap-2 bg-white/[0.025] px-4 py-2 text-xs uppercase tracking-widest text-white/35">
                    <div>Eye</div><div>Sphere</div><div>Cylinder</div><div>Axis</div><div>Add</div>
                    <div>Dist VA</div><div>Near VA</div><div>Dist PH</div><div />
                  </div>
                  {EYES.map((eye) => (
                    <div key={eye} className="grid grid-cols-[54px_repeat(4,105px)_repeat(3,minmax(220px,1fr))_100px] items-center gap-2 border-t border-white/10 px-4 py-3">
                      <div className="text-sm font-semibold text-white">{eye}</div>
                      {(["sphere", "cylinder", "add"] as const).slice(0, 2).map((field) => (
                        <PowerSelect
                          key={field}
                          value={block[eye][field]}
                          onChange={(value) => updateEye(block.id, eye, { [field]: value })}
                          options={powerOptions}
                          ariaLabel={`${eye} ${field}`}
                        />
                      ))}
                      <select
                        value={block[eye].axis}
                        onChange={(event) => updateEye(block.id, eye, { axis: event.target.value })}
                        aria-label={`${eye} axis`}
                        className="h-10 rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand"
                      >
                        <option value="">Select</option>
                        {axisOptions.map((value) => <option key={value} value={value}>{value}°</option>)}
                      </select>
                      <PowerSelect
                        value={block[eye].add}
                        onChange={(value) => updateEye(block.id, eye, { add: value })}
                        options={powerOptions}
                        ariaLabel={`${eye} add`}
                      />
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
            </div>
          ))}
        </div>

        {suggestions.length > 0 && definition && (
          <div className="mt-6 rounded border border-amber-300/25 bg-amber-400/[0.06] p-4">
            <div className="text-sm font-semibold text-amber-100">Non-committal diagnosis suggestions</div>
            <div className="mt-1 text-xs text-amber-100/60">
              Review, override, or reject each suggestion. No diagnosis is confirmed by this list.
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {suggestions.map((suggestion) => {
                const options = definition.diagnosisOptions.filter((option) => option.family === suggestion.family);
                return (
                  <label key={suggestion.id} className="rounded border border-white/10 bg-bg-deep/60 p-3">
                    <span className="block text-sm text-white/80">{suggestion.explanation}</span>
                    <select
                      value={suggestionSelections[suggestion.id] ?? ""}
                      onChange={(event) => setSuggestionSelections((current) => ({
                        ...current,
                        [suggestion.id]: event.target.value,
                      }))}
                      className="mt-3 h-10 w-full rounded border border-amber-300/25 bg-bg-deep px-3 text-sm text-white outline-none focus:border-amber-300/60"
                    >
                      <option value="">Reject suggestion</option>
                      {options.map((option) => (
                        <option key={option.code} value={option.code}>{option.code} — {option.display}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <SectionFooter error={error} saved={saved} saving={saving || definitionLoading} onSave={save} />
      </div>
    </section>
  );
}

function PowerSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
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
      {options.map((option) => (
        <option key={option} value={option}>{formatPowerOption(Number(option))}</option>
      ))}
    </select>
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

function emptyBlock(type = ""): BlockState {
  return {
    id: crypto.randomUUID(),
    type,
    purpose: "",
    remarks: "",
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
    distanceVisualAcuity: "",
    nearVisualAcuity: "",
    distancePinholeVisualAcuity: "",
  };
}

function buildPayload(blocks: BlockState[]): BlockPayload[] {
  return blocks.flatMap((block, blockIndex) => {
    const eyes = Object.fromEntries(EYES.flatMap((eye) => {
      const row = block[eye];
      if (!eyeTouched(row)) return [];
      if ((row.cylinder && !row.axis) || (!row.cylinder && row.axis)) {
        throw new Error(`Block ${blockIndex + 1} ${eye} cylinder and axis must be saved together.`);
      }
      return [[eye, definedRecord({
        sphere: parseOptionalNumber(row.sphere),
        cylinder: parseOptionalNumber(row.cylinder),
        axis: parseOptionalNumber(row.axis),
        add: parseOptionalNumber(row.add),
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
      type: block.type,
      ...(block.purpose.trim() ? { purpose: block.purpose.trim() } : {}),
      ...(block.remarks.trim() ? { remarks: block.remarks.trim() } : {}),
      ...eyes,
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

function authHeaders(): HeadersInit {
  const authorization = fhir.authHeader();
  return authorization ? { Authorization: authorization } : {};
}

function clinicalGraphApiBase(): string {
  return import.meta.env.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}
