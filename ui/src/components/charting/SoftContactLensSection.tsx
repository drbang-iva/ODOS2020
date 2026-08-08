import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";
import { formatSpherePower, numericOptions } from "./power-options";
import { VaValueSelect } from "./VaValueSelect";
import { OdosSelect } from "../inputs/OdosSelect";
import { OdosWheel } from "../inputs/OdosWheel";
import {
  copySoftContactLensValues,
  softContactLensCopySources,
  type PrescriptionHistoryResponse,
  type SoftContactLensCopySource,
} from "./prescription-copy";

interface Props {
  patientReference: string;
  encounterReference: string;
  onSaved: (status: SectionSaveStatus) => void;
}

type Eye = "OD" | "OS";
type Tab = "details" | "assessment" | "notes";

interface DefinitionOption {
  code: string;
  display: string;
  active?: boolean;
}

interface ProductOption extends DefinitionOption {
  manufacturerCode: string;
  design?: string;
  colorOptions?: DefinitionOption[];
  mfPowerOptions?: DefinitionOption[];
  baseCurveOptions?: DefinitionOption[];
  diameterOptions?: DefinitionOption[];
  frequentlyUsed?: boolean;
}

interface DefinitionField {
  display?: string;
  minimum?: number;
  maximum?: number;
  precision?: number;
  step?: number;
  options?: DefinitionOption[] | ProductOption[];
}

interface DefinitionResponse {
  definition: {
    fields: Record<string, DefinitionField>;
  };
}

interface OverRefractionState {
  sphere: string;
  cylinder: string;
  axis: string;
  distanceVisualAcuity: string;
  nearVisualAcuity: string;
}

interface EyeState {
  underlyingCondition: string;
  manufacturer: string;
  product: string;
  baseCurve: string;
  diameter: string;
  sphere: string;
  cylinder: string;
  axis: string;
  add: string;
  colorMfPower: string;
  distanceVisualAcuity: string;
  nearVisualAcuity: string;
  distancePinholeVisualAcuity: string;
  startDate: string;
  expirationDate: string;
  other: string;
  manualEntry: boolean;
  overRefraction: OverRefractionState;
}

interface EyePayload {
  underlyingCondition?: string;
  manufacturer?: string;
  product?: string;
  baseCurve?: number;
  diameter?: number;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  colorMfPower?: string;
  distanceVisualAcuity?: string;
  nearVisualAcuity?: string;
  distancePinholeVisualAcuity?: string;
  startDate?: string;
  expirationDate?: string;
  other?: string;
  manualEntry: boolean;
  overRefraction?: {
    sphere?: number;
    cylinder?: number;
    axis?: number;
    distanceVisualAcuity?: string;
    nearVisualAcuity?: string;
  };
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "ODOS UI clinical_graph_soft_contact_lens";

export function SoftContactLensSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<DefinitionResponse | null>(null);
  const [definitionLoading, setDefinitionLoading] = useState(true);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [definitionRefresh, setDefinitionRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("details");
  const [usage, setUsage] = useState("");
  const [status, setStatus] = useState("");
  const [ouDistanceVisualAcuity, setOuDistanceVisualAcuity] = useState("");
  const [ouNearVisualAcuity, setOuNearVisualAcuity] = useState("");
  const [remarks, setRemarks] = useState("");
  const [assessmentRegimen, setAssessmentRegimen] = useState("");
  const [notes, setNotes] = useState("");
  const [eyes, setEyes] = useState<Record<Eye, EyeState>>(() => ({ OD: emptyEye(), OS: emptyEye() }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [history, setHistory] = useState<PrescriptionHistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDefinitionLoading(true);
    setDefinitionError(null);
    fetch(`${clinicalGraphApiBase()}/clinical-graph/contact-lens/soft/definition`, {
      headers: authHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Soft contact lens definition request failed: ${response.status}`);
        return await response.json() as DefinitionResponse;
      })
      .then(setDefinition)
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") {
          setDefinitionError(caught instanceof Error ? caught.message : String(caught));
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
  const manufacturerOptions = useMemo(() => activeOptions(fields.manufacturer), [fields.manufacturer]);
  const products = useMemo(() => activeProductOptions(fields.product), [fields.product]);
  const cylinderOptions = useMemo(() => numericOptions(fields.cylinder, -8, 0, 0.25), [fields.cylinder]);
  const addOptions = useMemo(() => numericOptions(fields.add, 0, 4, 0.25), [fields.add]);
  const axisOptions = useMemo(() => numericOptions(fields.axis, 0, 180, 1), [fields.axis]);
  const overSphereOptions = useMemo(() => numericOptions(fields.overRefractionSphere, -20, 20, 0.25), [fields.overRefractionSphere]);
  const overCylinderOptions = useMemo(() => numericOptions(fields.overRefractionCylinder, -8, 0, 0.25), [fields.overRefractionCylinder]);
  const overAxisOptions = useMemo(() => numericOptions(fields.overRefractionAxis, 0, 180, 1), [fields.overRefractionAxis]);
  const copySources = useMemo(
    () => softContactLensCopySources(history, encounterReference),
    [encounterReference, history],
  );

  function updateEye(eye: Eye, next: Partial<EyeState>) {
    setEyes((current) => ({ ...current, [eye]: { ...current[eye], ...next } }));
  }

  function updateOverRefraction(eye: Eye, next: Partial<OverRefractionState>) {
    setEyes((current) => ({
      ...current,
      [eye]: {
        ...current[eye],
        overRefraction: { ...current[eye].overRefraction, ...next },
      },
    }));
  }

  function selectManufacturer(eye: Eye, manufacturer: string) {
    updateEye(eye, { manufacturer, product: "", baseCurve: "", diameter: "", colorMfPower: "" });
  }

  function selectProduct(eye: Eye, product: string) {
    updateEye(eye, { product, baseCurve: "", diameter: "", colorMfPower: "" });
  }

  function pullFromSource(sourceId: string) {
    if (!sourceId) return;
    const source = copySources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    setEyes((current) => {
      const copied = copySoftContactLensValues(current, source);
      return {
        OD: copiedCatalogEntry(copied.OD, source.eyes.OD),
        OS: copiedCatalogEntry(copied.OS, source.eyes.OS),
      };
    });
  }

  function copiedCatalogEntry(
    eye: EyeState,
    source: SoftContactLensCopySource["eyes"][Eye],
  ): EyeState {
    if (!source || ["manufacturer", "product", "baseCurve", "diameter", "colorMfPower"].every(
      (field) => source[field as keyof typeof source] === undefined,
    )) return eye;
    const knownManufacturer = manufacturerOptions.some((option) => option.code === eye.manufacturer);
    const product = products.find((candidate) =>
      candidate.code === eye.product && candidate.manufacturerCode === eye.manufacturer);
    const knownProduct = !eye.product || product !== undefined;
    const knownBaseCurve = source.baseCurve === undefined
      || activeNestedOptions(product?.baseCurveOptions).some((option) => option.code === eye.baseCurve);
    const knownDiameter = source.diameter === undefined
      || activeNestedOptions(product?.diameterOptions).some((option) => option.code === eye.diameter);
    const knownCascade = source.colorMfPower === undefined
      || activeNestedOptions([...(product?.colorOptions ?? []), ...(product?.mfPowerOptions ?? [])])
        .some((option) => option.code === eye.colorMfPower);
    return knownManufacturer && knownProduct && knownBaseCurve && knownDiameter && knownCascade
      ? eye
      : { ...eye, manualEntry: true };
  }

  async function save() {
    let payloadEyes: Partial<Record<Eye, EyePayload>>;
    try {
      payloadEyes = Object.fromEntries(EYES.flatMap((eye) => {
        const payload = buildEyePayload(eyes[eye], eye);
        return payload ? [[eye, payload]] : [];
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    if (Object.keys(payloadEyes).length === 0) {
      setError("Enter at least one soft contact lens eye before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/contact-lens/soft`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(compact({
          patientReference,
          encounterReference,
          usage,
          status,
          ouDistanceVisualAcuity,
          ouNearVisualAcuity,
          remarks,
          assessmentRegimen,
          notes,
          eyes: payloadEyes,
        })),
      });
      const body = await response.json() as { eyes?: Record<string, unknown>; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Soft contact lens save failed: ${response.status}`);
      const count = Object.keys(body.eyes ?? payloadEyes).length;
      const nextSaved = {
        completed: true,
        summary: `Soft CL saved for ${count} eye${count === 1 ? "" : "s"}`,
        savedAt: new Date().toISOString(),
        operator: OPERATOR,
      };
      setSaved(nextSaved);
      onSaved(nextSaved);
      setDefinitionRefresh((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-[1600px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Soft Contact Lenses</h2>
            <p className="mt-1 text-sm text-white/45">Soft lens prescription with product-specific catalog options and embedded over-refraction</p>
          </div>
          <div className="text-right text-xs text-white/40">
            <div>Provider: current clinical session</div>
            <div>Facility and recorded time: encounter-derived on save</div>
          </div>
        </div>

        <div className="mt-5 flex gap-2 border-b border-white/10">
          <TabButton active={activeTab === "details"} onClick={() => setActiveTab("details")}>Details</TabButton>
          <TabButton active={activeTab === "assessment"} onClick={() => setActiveTab("assessment")}>Assessment and CL Regimen</TabButton>
          <TabButton active={activeTab === "notes"} onClick={() => setActiveTab("notes")}>Notes</TabButton>
        </div>

        {definitionLoading && <div className="mt-5 rounded border border-white/10 bg-bg-panel p-4 text-sm text-white/55">Loading practice contact lens catalog…</div>}
        {definitionError && <div className="mt-5 rounded border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">{definitionError}</div>}
        {historyError && <div className="mt-5 rounded border border-amber-400/35 bg-amber-400/10 p-4 text-sm text-amber-100">Copy sources unavailable: {historyError}</div>}

        {!definitionLoading && definition && activeTab === "details" && (
          <div className="mt-5 space-y-5">
            <div className="grid gap-4 rounded border border-white/10 bg-bg-panel/80 p-4 md:grid-cols-3">
              <SelectField label="Usage" value={usage} onChange={setUsage} options={activeOptions(fields.usage)} />
              <SelectField label="Status" value={status} onChange={setStatus} options={activeOptions(fields.status)} />
              <label className="block">
                <span className={FIELD_LABEL_CLASS}>Pull values from</span>
                <OdosSelect
                  value=""
                  options={copySources.length > 0
                    ? [{ value: "", label: "Pull from…" }, ...copySources.map((source) => ({ value: source.id, label: source.label }))]
                    : [{ value: "", label: "No populated contact lens sources" }]}
                  onChange={pullFromSource}
                  ariaLabel="Pull contact lens values from"
                  disabled={copySources.length === 0}
                />
              </label>
            </div>

            {EYES.map((eye) => {
              const state = eyes[eye];
              const filteredProducts = products.filter((product) => product.manufacturerCode === state.manufacturer);
              const selectedProduct = products.find((product) => product.code === state.product);
              const cascadeOptions = activeNestedOptions(selectedProduct?.colorOptions ?? selectedProduct?.mfPowerOptions);
              const baseCurveOptions = softLensProductParameterOptions(selectedProduct, "baseCurveOptions");
              const diameterOptions = softLensProductParameterOptions(selectedProduct, "diameterOptions");
              return (
                <div key={eye} className="rounded border border-white/10 bg-bg-panel/75 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-base font-semibold text-white">{eye}</h3>
                    <label className="flex items-center gap-2 text-sm text-white/70">
                      <input
                        type="checkbox"
                        checked={state.manualEntry}
                        onChange={(event) => updateEye(eye, {
                          manualEntry: event.target.checked,
                          manufacturer: "",
                          product: "",
                          colorMfPower: "",
                        })}
                        className="h-4 w-4 accent-brand"
                      />
                      Manual Entry
                    </label>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <SelectField label="Underlying Condition" value={state.underlyingCondition} onChange={(value) => updateEye(eye, { underlyingCondition: value })} options={activeOptions(fields.underlyingCondition)} />
                    {state.manualEntry ? (
                      <>
                        <TextField label="Manufacturer" value={state.manufacturer} onChange={(value) => updateEye(eye, { manufacturer: value })} />
                        <TextField label="Product" value={state.product} onChange={(value) => updateEye(eye, { product: value })} />
                      </>
                    ) : (
                      <>
                        <SelectField label="Manufacturer" value={state.manufacturer} onChange={(value) => selectManufacturer(eye, value)} options={manufacturerOptions} />
                        <SelectField label="Product" value={state.product} onChange={(value) => selectProduct(eye, value)} options={filteredProducts} disabled={!state.manufacturer} />
                      </>
                    )}
                    {state.manualEntry ? (
                      <DefinitionWheelField label="Base Curve (mm)" value={state.baseCurve} onChange={(value) => updateEye(eye, { baseCurve: value })} field={fields.baseCurve} ariaLabel={`${eye} manual base curve`} />
                    ) : (
                      <CatalogWheelField label="Base Curve (mm)" value={state.baseCurve} onChange={(value) => updateEye(eye, { baseCurve: value })} options={baseCurveOptions} disabled={!state.product} ariaLabel={`${eye} catalog base curve`} />
                    )}
                    {state.manualEntry ? (
                      <DefinitionWheelField label="Diameter (mm)" value={state.diameter} onChange={(value) => updateEye(eye, { diameter: value })} field={fields.diameter} ariaLabel={`${eye} manual diameter`} />
                    ) : (
                      <CatalogWheelField label="Diameter (mm)" value={state.diameter} onChange={(value) => updateEye(eye, { diameter: value })} options={diameterOptions} disabled={!state.product} ariaLabel={`${eye} catalog diameter`} />
                    )}
                    <SphereWheelField
                      label="Sphere"
                      value={state.sphere}
                      onChange={(value) => updateEye(eye, { sphere: value })}
                      field={fields.sphere}
                      ariaLabel={`${eye} sphere`}
                    />
                    <PowerField label="Cylinder" value={state.cylinder} onChange={(value) => updateEye(eye, { cylinder: value })} options={cylinderOptions} ariaLabel={`${eye} cylinder`} />
                    <AxisField label="Axis" value={state.axis} onChange={(value) => updateEye(eye, { axis: value })} options={axisOptions} ariaLabel={`${eye} axis`} />
                    <PowerField label="Add" value={state.add} onChange={(value) => updateEye(eye, { add: value })} options={addOptions} ariaLabel={`${eye} add`} format={formatSignedPower} />
                    {state.manualEntry ? (
                      <TextField label="Color/MF-PWR" value={state.colorMfPower} onChange={(value) => updateEye(eye, { colorMfPower: value })} />
                    ) : cascadeOptions.length > 0 && (
                      <SelectField label="Color/MF-PWR" value={state.colorMfPower} onChange={(value) => updateEye(eye, { colorMfPower: value })} options={cascadeOptions} />
                    )}
                    <VaField label="Dist VA" value={state.distanceVisualAcuity} onChange={(value) => updateEye(eye, { distanceVisualAcuity: value })} />
                    <VaField label="Near VA" value={state.nearVisualAcuity} onChange={(value) => updateEye(eye, { nearVisualAcuity: value })} />
                    <VaField label="Dist PH" value={state.distancePinholeVisualAcuity} onChange={(value) => updateEye(eye, { distancePinholeVisualAcuity: value })} />
                    <TextField label="Start Date" value={state.startDate} onChange={(value) => updateEye(eye, { startDate: value })} type="date" />
                    <TextField label="Expiration Date" value={state.expirationDate} onChange={(value) => updateEye(eye, { expirationDate: value })} type="date" />
                    <div className="md:col-span-2">
                      <TextField label="Other" value={state.other} onChange={(value) => updateEye(eye, { other: value })} />
                    </div>
                  </div>

                  <div className="mt-5 rounded border border-brand/20 bg-brand/5 p-4">
                    <h4 className="text-sm font-semibold text-white">Over-Refraction over this {eye} lens</h4>
                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                      <PowerField label="Sphere" value={state.overRefraction.sphere} onChange={(value) => updateOverRefraction(eye, { sphere: value })} options={overSphereOptions} ariaLabel={`${eye} over-refraction sphere`} />
                      <PowerField label="Cylinder" value={state.overRefraction.cylinder} onChange={(value) => updateOverRefraction(eye, { cylinder: value })} options={overCylinderOptions} ariaLabel={`${eye} over-refraction cylinder`} />
                      <AxisField label="Axis" value={state.overRefraction.axis} onChange={(value) => updateOverRefraction(eye, { axis: value })} options={overAxisOptions} ariaLabel={`${eye} over-refraction axis`} />
                      <VaField label="Dist VA" value={state.overRefraction.distanceVisualAcuity} onChange={(value) => updateOverRefraction(eye, { distanceVisualAcuity: value })} />
                      <VaField label="Near VA" value={state.overRefraction.nearVisualAcuity} onChange={(value) => updateOverRefraction(eye, { nearVisualAcuity: value })} />
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="grid gap-4 rounded border border-white/10 bg-bg-panel/80 p-4 md:grid-cols-2">
              <VaField label="OU Dist VA" value={ouDistanceVisualAcuity} onChange={setOuDistanceVisualAcuity} />
              <VaField label="OU Near VA" value={ouNearVisualAcuity} onChange={setOuNearVisualAcuity} />
            </div>
            <TextAreaField label="Remarks" value={remarks} onChange={setRemarks} maxLength={2000} />
          </div>
        )}

        {!definitionLoading && definition && activeTab === "assessment" && (
          <div className="mt-5">
            <TextAreaField label="Assessment and CL Regimen" value={assessmentRegimen} onChange={setAssessmentRegimen} maxLength={2000} rows={12} />
          </div>
        )}

        {!definitionLoading && definition && activeTab === "notes" && (
          <div className="mt-5">
            <TextAreaField label="Notes" value={notes} onChange={setNotes} maxLength={2000} rows={12} />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving || definitionLoading || !definition}
            className="rounded bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Soft Contact Lenses"}
          </button>
          {saved && <span className="text-sm text-emerald-300">{saved.summary}</span>}
          {error && <span className="text-sm text-red-300">{error}</span>}
        </div>
      </div>
    </section>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={["border-b-2 px-4 py-3 text-sm font-medium", active ? "border-brand text-white" : "border-transparent text-white/50 hover:text-white/75"].join(" ")}
    >
      {children}
    </button>
  );
}

const FIELD_LABEL_CLASS = "mb-1 block text-xs uppercase tracking-widest text-white/35";

function SelectField({ label, value, onChange, options, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: DefinitionOption[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <OdosSelect
        value={value}
        options={[
          { value: "", label: "Select" },
          ...options.map((option) => ({ value: option.code, label: option.display })),
        ]}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={label}
      />
    </label>
  );
}

function NativeSelectField({ label, value, onChange, options, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: DefinitionOption[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="h-10 w-full rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand disabled:opacity-45"
      >
        <option value="">Select</option>
        {options.map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}
      </select>
    </label>
  );
}

function TextField({ label, value, onChange, type = "text", inputMode }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "date";
  inputMode?: "decimal";
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand"
      />
    </label>
  );
}

function DefinitionWheelField({ label, value, onChange, field, ariaLabel }: {
  label: string;
  value: string;
  onChange(value: string): void;
  field: DefinitionField | undefined;
  ariaLabel: string;
}) {
  const step = field?.step ?? (field?.precision === undefined ? undefined : 10 ** -field.precision);
  if (field?.minimum === undefined || field.maximum === undefined || step === undefined) {
    return <TextField label={label} value={value} onChange={onChange} inputMode="decimal" />;
  }
  return (
    <label className="block">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <OdosWheel
        value={value === "" ? 0 : Number(value)}
        centerOn={0}
        min={field.minimum}
        max={field.maximum}
        step={step}
        format={(next) => next.toFixed(field.precision ?? decimalPlaces(step))}
        onChange={(next) => onChange(String(next))}
        ariaLabel={ariaLabel}
        unit="mm"
        states={[{ value: "", label: "Not recorded" }]}
        selectedState={value === "" ? "" : undefined}
        onStateChange={onChange}
      />
    </label>
  );
}

function CatalogWheelField({ label, value, onChange, options, disabled, ariaLabel }: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: DefinitionOption[];
  disabled: boolean;
  ariaLabel: string;
}) {
  const wheel = catalogWheel(options);
  if (!wheel) {
    return <NativeSelectField label={label} value={value} onChange={onChange} options={options} disabled={disabled} />;
  }
  return (
    <label className="block">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <OdosWheel
        value={value === "" ? wheel.min : Number(value)}
        centerOn={0}
        min={wheel.min}
        max={wheel.max}
        step={wheel.step}
        format={(next) => options.find((option) => Number(option.code) === next)?.display ?? String(next)}
        onChange={(next) => onChange(options.find((option) => Number(option.code) === next)?.code ?? String(next))}
        ariaLabel={ariaLabel}
        unit="mm"
        states={[{ value: "", label: "Not recorded" }]}
        selectedState={value === "" ? "" : undefined}
        onStateChange={onChange}
        disabled={disabled}
      />
    </label>
  );
}

function PowerField({ label, value, onChange, options, ariaLabel, format = formatSpherePower }: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: string[];
  ariaLabel: string;
  format?: (value: number) => string;
}) {
  const wheel = requiredWheel(options);
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      <OdosWheel
        value={value === "" ? 0 : Number(value)}
        centerOn={0}
        min={wheel.min}
        max={wheel.max}
        step={wheel.step}
        format={format}
        onChange={(next) => onChange(next.toFixed(2))}
        ariaLabel={ariaLabel}
        unit="D"
        states={[{ value: "", label: "Not recorded" }]}
        selectedState={value === "" ? "" : undefined}
        onStateChange={onChange}
      />
    </label>
  );
}

function SphereWheelField({ label, value, onChange, field, ariaLabel }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  field: DefinitionField | undefined;
  ariaLabel: string;
}) {
  const minimum = field?.minimum ?? -20;
  const maximum = field?.maximum ?? 20;
  const step = field?.step ?? 0.25;
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-[color:var(--odos-faint)]">{label}</span>
      <OdosWheel
        value={value === "" ? 0 : Number(value)}
        centerOn={0}
        min={minimum}
        max={maximum}
        step={step}
        format={formatSpherePower}
        onChange={(next) => onChange(next.toFixed(2))}
        ariaLabel={ariaLabel}
        unit="D"
        states={[{ value: "", label: "Not recorded" }]}
        selectedState={value === "" ? "" : undefined}
        onStateChange={onChange}
      />
    </label>
  );
}

function AxisField({ label, value, onChange, options, ariaLabel }: {
  label: string;
  value: string;
  onChange(value: string): void;
  options: string[];
  ariaLabel: string;
}) {
  const wheel = requiredWheel(options);
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      <OdosWheel
        value={value === "" ? 0 : Number(value)}
        centerOn={0}
        min={wheel.min}
        max={wheel.max}
        step={wheel.step}
        format={String}
        onChange={(next) => onChange(String(next))}
        ariaLabel={ariaLabel}
        unit="°"
        states={[{ value: "", label: "Not recorded" }]}
        selectedState={value === "" ? "" : undefined}
        onStateChange={onChange}
      />
    </label>
  );
}

function catalogWheel(options: DefinitionOption[]): { min: number; max: number; step: number } | undefined {
  if (!options.length || options.some((option) =>
    !Number.isFinite(Number(option.code)) || !Number.isFinite(Number(option.display))
  )) return undefined;
  const values = options.map((option) => Number(option.code));
  if (values.length === 1) return { min: values[0]!, max: values[0]!, step: 1 };
  const step = values[1]! - values[0]!;
  if (step <= 0 || values.some((value, index) => index > 0 && Math.abs(value - values[index - 1]! - step) > 1e-9)) return undefined;
  return { min: values[0]!, max: values.at(-1)!, step };
}

function requiredWheel(options: string[]): { min: number; max: number; step: number } {
  const values = options.map(Number);
  return {
    min: values[0]!,
    max: values.at(-1)!,
    step: values.length > 1 ? values[1]! - values[0]! : 1,
  };
}

function decimalPlaces(value: number): number {
  return String(value).split(".")[1]?.length ?? 0;
}

function formatSignedPower(value: number): string {
  return `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}`;
}

function VaField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      <VaValueSelect value={value} onChange={onChange} ariaLabel={label} />
    </label>
  );
}

function TextAreaField({ label, value, onChange, maxLength, rows = 5 }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  rows?: number;
}) {
  return (
    <label className="block rounded border border-white/10 bg-bg-panel/80 p-4">
      <span className="mb-2 flex justify-between text-xs uppercase tracking-widest text-white/35"><span>{label}</span><span>{value.length}/{maxLength}</span></span>
      <textarea
        value={value}
        maxLength={maxLength}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded border border-white/15 bg-bg-deep p-3 text-sm text-white outline-none focus:border-brand"
      />
    </label>
  );
}

function emptyEye(): EyeState {
  return {
    underlyingCondition: "",
    manufacturer: "",
    product: "",
    baseCurve: "",
    diameter: "",
    sphere: "",
    cylinder: "",
    axis: "",
    add: "",
    colorMfPower: "",
    distanceVisualAcuity: "",
    nearVisualAcuity: "",
    distancePinholeVisualAcuity: "",
    startDate: "",
    expirationDate: "",
    other: "",
    manualEntry: false,
    overRefraction: {
      sphere: "",
      cylinder: "",
      axis: "",
      distanceVisualAcuity: "",
      nearVisualAcuity: "",
    },
  };
}

function buildEyePayload(state: EyeState, eye: Eye): EyePayload | undefined {
  const touched = state.manualEntry || Object.entries(state).some(([key, value]) =>
    key !== "manualEntry" && key !== "overRefraction" && value !== "") ||
    Object.values(state.overRefraction).some(Boolean);
  if (!touched) return undefined;
  if ((state.cylinder === "") !== (state.axis === "")) throw new Error(`${eye} cylinder and axis must be entered together.`);
  if ((state.overRefraction.cylinder === "") !== (state.overRefraction.axis === "")) {
    throw new Error(`${eye} over-refraction cylinder and axis must be entered together.`);
  }
  const overRefraction = compact({
    sphere: optionalNumber(state.overRefraction.sphere, `${eye} over-refraction sphere`),
    cylinder: optionalNumber(state.overRefraction.cylinder, `${eye} over-refraction cylinder`),
    axis: optionalNumber(state.overRefraction.axis, `${eye} over-refraction axis`),
    distanceVisualAcuity: state.overRefraction.distanceVisualAcuity,
    nearVisualAcuity: state.overRefraction.nearVisualAcuity,
  });
  return compact({
    underlyingCondition: state.underlyingCondition,
    manufacturer: state.manufacturer,
    product: state.product,
    baseCurve: optionalNumber(state.baseCurve, `${eye} base curve`),
    diameter: optionalNumber(state.diameter, `${eye} diameter`),
    sphere: optionalNumber(state.sphere, `${eye} sphere`),
    cylinder: optionalNumber(state.cylinder, `${eye} cylinder`),
    axis: optionalNumber(state.axis, `${eye} axis`),
    add: optionalNumber(state.add, `${eye} add`),
    colorMfPower: state.colorMfPower,
    distanceVisualAcuity: state.distanceVisualAcuity,
    nearVisualAcuity: state.nearVisualAcuity,
    distancePinholeVisualAcuity: state.distancePinholeVisualAcuity,
    startDate: state.startDate,
    expirationDate: state.expirationDate,
    other: state.other,
    manualEntry: state.manualEntry,
    overRefraction: Object.keys(overRefraction).length > 0 ? overRefraction : undefined,
  }) as EyePayload;
}

function optionalNumber(value: string, label: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric.`);
  return parsed;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function activeProductOptions(field: DefinitionField | undefined): ProductOption[] {
  return (field?.options ?? []).filter((option): option is ProductOption =>
    option.active !== false && "manufacturerCode" in option && typeof option.manufacturerCode === "string");
}

function activeNestedOptions(options: DefinitionOption[] | undefined): DefinitionOption[] {
  return (options ?? []).filter((option) => option.active !== false);
}

export function softLensProductParameterOptions(
  product: { baseCurveOptions?: DefinitionOption[]; diameterOptions?: DefinitionOption[] } | undefined,
  parameter: "baseCurveOptions" | "diameterOptions",
): DefinitionOption[] {
  return activeNestedOptions(product?.[parameter]);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}
