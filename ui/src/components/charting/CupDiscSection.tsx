import { useEffect, useMemo, useState, type ReactNode } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import { numericOptions } from "./power-options";
import { PowerDropdown } from "./PowerDropdown";
import type { SectionSaveStatus } from "./types";
import { DiagnosisPicker } from "./DiagnosisPicker";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

type Eye = "OD" | "OS";
type RiskTier = "normal" | "low" | "high";

interface DefinitionOption {
  code: string;
  display: string;
  active?: boolean;
  highRiskDriver?: boolean;
}

interface DefinitionField {
  display?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: DefinitionOption[];
}

interface CupDiscDefinition {
  definition: {
    fields: Record<string, DefinitionField>;
  };
}

interface EyeState {
  verticalCupDiscRatio: string;
  horizontalCupDiscRatio: string;
  discNerveSize: string;
  discAppearanceDescriptors: string[];
  methodSource: string;
  notVisualized: boolean;
}

interface EyePayload {
  verticalCupDiscRatio?: number;
  horizontalCupDiscRatio?: number;
  discNerveSize?: string;
  discAppearanceDescriptors?: string[];
  methodSource?: string;
  notVisualized?: boolean;
}

interface CupDiscEyeResult {
  observationReference: string;
  riskTier: RiskTier;
  icd10Code?: string;
  explanation: string;
  signals: string[];
  cupDiscAsymmetry?: number;
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "ODOS UI save_cup_disc";

function emptyEyeState(): EyeState {
  return {
    verticalCupDiscRatio: "",
    horizontalCupDiscRatio: "",
    discNerveSize: "",
    discAppearanceDescriptors: [],
    methodSource: "",
    notVisualized: false,
  };
}

function emptyRows(): Record<Eye, EyeState> {
  return { OD: emptyEyeState(), OS: emptyEyeState() };
}

export function CupDiscSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<CupDiscDefinition["definition"] | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [rows, setRows] = useState<Record<Eye, EyeState>>(emptyRows);
  const [results, setResults] = useState<Partial<Record<Eye, CupDiscEyeResult>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDefinitionLoading(true);
    setDefinitionError(null);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/glaucoma/cup-disc/definition`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Cup/disc definition request failed: ${response.status}`);
        }
        return (await response.json()) as CupDiscDefinition;
      })
      .then((body) => setDefinition(body.definition))
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

  useEffect(() => {
    const controller = new AbortController();
    setRows(emptyRows());
    setResults({});
    setError(null);
    setSaved(null);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/glaucoma/cup-disc?encounterReference=${encodeURIComponent(encounterReference)}`, {
      headers: authHeaders(), signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { eyes?: Partial<Record<Eye, { verticalCupDiscRatio?: number }>> };
      if (controller.signal.aborted) return;
      setRows(Object.fromEntries(EYES.map((eye) => [
        eye,
        {
          ...emptyEyeState(),
          ...(body.eyes?.[eye]?.verticalCupDiscRatio !== undefined
            ? { verticalCupDiscRatio: String(body.eyes[eye]!.verticalCupDiscRatio) }
            : {}),
        },
      ])) as Record<Eye, EyeState>);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [encounterReference]);

  const fields = definition?.fields ?? {};
  const verticalField = fields.verticalCupDiscRatio ?? {};
  const horizontalField = fields.horizontalCupDiscRatio ?? {};
  const verticalOptions = useMemo(
    () => numericOptions(verticalField, 0, 1, 0.05),
    [verticalField.maximum, verticalField.minimum, verticalField.step],
  );
  const horizontalOptions = useMemo(
    () => numericOptions(horizontalField, 0, 1, 0.05),
    [horizontalField.maximum, horizontalField.minimum, horizontalField.step],
  );
  const sizeOptions = useMemo(() => activeOptions(fields.discNerveSize), [fields.discNerveSize]);
  const descriptorOptions = useMemo(
    () => activeOptions(fields.discAppearanceDescriptors),
    [fields.discAppearanceDescriptors],
  );
  const methodOptions = useMemo(() => activeOptions(fields.methodSource), [fields.methodSource]);
  const savedAsymmetry = results.OD?.cupDiscAsymmetry ?? results.OS?.cupDiscAsymmetry;
  const bothVerticalEntered = EYES.every((eye) => rows[eye].verticalCupDiscRatio.trim());

  function updateEye(eye: Eye, next: Partial<EyeState>) {
    setRows((current) => ({
      ...current,
      [eye]: { ...current[eye], ...next },
    }));
    setResults((current) => {
      const nextResults = { ...current };
      delete nextResults[eye];
      return nextResults;
    });
  }

  function toggleDescriptor(eye: Eye, code: string) {
    const selected = rows[eye].discAppearanceDescriptors;
    updateEye(eye, {
      discAppearanceDescriptors: selected.includes(code)
        ? selected.filter((item) => item !== code)
        : [...selected, code],
    });
  }

  async function save() {
    let eyes: Partial<Record<Eye, EyePayload>>;
    try {
      eyes = buildPayload(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (Object.keys(eyes).length === 0) {
      setError("Enter at least one cup/disc row before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/glaucoma/cup-disc`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ patientReference, encounterReference, eyes }),
      });
      const body = (await response.json()) as { eyes?: Partial<Record<Eye, CupDiscEyeResult>>; error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `Cup/disc save failed: ${response.status}`);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl">
        <h2 className="text-lg font-semibold text-white">Cup/Disc</h2>

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
                  <Field label={verticalField.display ?? "Vertical C/D ratio"}>
                    <fieldset disabled={disabled}>
                      <PowerDropdown
                        value={row.verticalCupDiscRatio}
                        options={verticalOptions}
                        defaultValue={ratioDefault(verticalOptions)}
                        onChange={(value) => updateEye(eye, { verticalCupDiscRatio: value })}
                        ariaLabel={`${eye} vertical cup disc ratio picker`}
                      />
                    </fieldset>
                  </Field>

                  <Field label={horizontalField.display ?? "Horizontal C/D ratio"}>
                    <fieldset disabled={disabled}>
                      <PowerDropdown
                        value={row.horizontalCupDiscRatio}
                        options={horizontalOptions}
                        defaultValue={ratioDefault(horizontalOptions)}
                        onChange={(value) => updateEye(eye, { horizontalCupDiscRatio: value })}
                        ariaLabel={`${eye} horizontal cup disc ratio picker`}
                      />
                    </fieldset>
                  </Field>

                  <Field label="Disc/nerve size">
                    <select
                      value={row.discNerveSize}
                      onChange={(event) => updateEye(eye, { discNerveSize: event.target.value })}
                      disabled={definitionLoading}
                      className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand disabled:opacity-45"
                    >
                      <option value="">Select</option>
                      {sizeOptions.map((option) => (
                        <option key={option.code} value={option.code}>{option.display}</option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Method/source">
                    <select
                      value={row.methodSource}
                      onChange={(event) => updateEye(eye, { methodSource: event.target.value })}
                      disabled={definitionLoading}
                      className="h-11 w-full rounded border border-white/15 bg-bg-deep px-3 text-white outline-none focus:border-brand disabled:opacity-45"
                    >
                      <option value="">Select</option>
                      {methodOptions.map((option) => (
                        <option key={option.code} value={option.code}>{option.display}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="mt-4">
                  <div className="text-xs uppercase tracking-widest text-white/35">Disc appearance descriptors</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {descriptorOptions.map((option) => (
                      <label key={option.code} className="flex min-h-10 items-center gap-2 rounded border border-white/10 px-3 py-2 text-sm text-white/75">
                        <input
                          type="checkbox"
                          checked={row.discAppearanceDescriptors.includes(option.code)}
                          onChange={() => toggleDescriptor(eye, option.code)}
                          disabled={disabled}
                          className="h-4 w-4 accent-brand disabled:opacity-45"
                        />
                        {option.display}
                      </label>
                    ))}
                  </div>
                </div>

                {result && (
                  <div>
                    <div className={[
                      "mt-4 rounded border px-3 py-2 text-sm",
                      result.riskTier === "normal"
                        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                        : result.riskTier === "high"
                          ? "border-red-400/35 bg-red-500/10 text-red-100"
                          : "border-amber-300/35 bg-amber-400/10 text-amber-100",
                    ].join(" ")}>
                      {resultBadgeText(result)}
                    </div>
                    <DiagnosisPicker
                      encounterReference={encounterReference}
                      observationReferences={[result.observationReference]}
                      findingDefinitionKey="cup_disc_ratio"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {bothVerticalEntered && (
          <div className="mt-4 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/65">
            Derived C/D asymmetry: {savedAsymmetry !== undefined ? savedAsymmetry.toFixed(2) : "computed after save"}
          </div>
        )}

        <SectionFooter
          error={error}
          saved={saved}
          saving={saving || definitionLoading}
          onSave={save}
        />
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

function ratioDefault(options: string[]): string {
  return options.includes("0.30") ? "0.30" : options[0] ?? "";
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
        {saving ? "Saving..." : "Save Cup/Disc"}
      </button>
    </div>
  );
}

function buildPayload(rows: Record<Eye, EyeState>): Partial<Record<Eye, EyePayload>> {
  const payload: Partial<Record<Eye, EyePayload>> = {};
  for (const eye of EYES) {
    const row = rows[eye];
    if (!rowTouched(row)) continue;
    const vertical = parseRatio(row.verticalCupDiscRatio, `${eye} vertical C/D`, row.notVisualized);
    const horizontal = parseRatio(row.horizontalCupDiscRatio, `${eye} horizontal C/D`, true);
    payload[eye] = {
      ...(vertical !== undefined ? { verticalCupDiscRatio: vertical } : {}),
      ...(horizontal !== undefined ? { horizontalCupDiscRatio: horizontal } : {}),
      ...(row.discNerveSize ? { discNerveSize: row.discNerveSize } : {}),
      ...(row.discAppearanceDescriptors.length ? { discAppearanceDescriptors: row.discAppearanceDescriptors } : {}),
      ...(row.methodSource ? { methodSource: row.methodSource } : {}),
      ...(row.notVisualized ? { notVisualized: true } : {}),
    };
  }
  return payload;
}

function rowTouched(row: EyeState): boolean {
  return row.notVisualized ||
    Boolean(row.verticalCupDiscRatio.trim()) ||
    Boolean(row.horizontalCupDiscRatio.trim()) ||
    Boolean(row.discNerveSize) ||
    Boolean(row.methodSource) ||
    row.discAppearanceDescriptors.length > 0;
}

function parseRatio(value: string, label: string, optional: boolean): number | undefined {
  if (!value.trim()) {
    if (optional) return undefined;
    throw new Error(`${label} is required unless the eye is not visualized/deferred.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${label} must be a ratio from 0.00 to 1.00.`);
  }
  return parsed;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function resultBadgeText(result: CupDiscEyeResult): string {
  if (result.riskTier === "normal") {
    return "Normal - no suspect suggestion";
  }
  const tier = result.riskTier === "high" ? "High-risk" : "Low-risk";
  const code = result.icd10Code ? ` (${result.icd10Code})` : "";
  return `Suggested: ${tier} glaucoma suspect${code} - ${result.explanation}`;
}
