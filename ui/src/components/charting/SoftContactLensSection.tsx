import { useEffect, useMemo, useState } from "react";
import { authHeaders, clinicalGraphApiBase } from "../../lib/clinical-graph-client";
import type { SectionSaveStatus } from "./types";
import { formatPowerOption, numericOptions } from "./power-options";
import { VaValueSelect } from "./VaValueSelect";

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
  frequentlyUsed?: boolean;
}

interface DefinitionField {
  display?: string;
  minimum?: number;
  maximum?: number;
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
  const [binocularPdDistance, setBinocularPdDistance] = useState("");
  const [binocularPdNear, setBinocularPdNear] = useState("");
  const [ouDistanceVisualAcuity, setOuDistanceVisualAcuity] = useState("");
  const [ouNearVisualAcuity, setOuNearVisualAcuity] = useState("");
  const [remarks, setRemarks] = useState("");
  const [assessmentRegimen, setAssessmentRegimen] = useState("");
  const [notes, setNotes] = useState("");
  const [eyes, setEyes] = useState<Record<Eye, EyeState>>(() => ({ OD: emptyEye(), OS: emptyEye() }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);

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

  const fields = definition?.definition.fields ?? {};
  const manufacturerOptions = useMemo(() => activeOptions(fields.manufacturer), [fields.manufacturer]);
  const products = useMemo(() => activeProductOptions(fields.product), [fields.product]);
  const sphereOptions = useMemo(() => numericOptions(fields.sphere, -30, 30, 0.25), [fields.sphere]);
  const cylinderOptions = useMemo(() => numericOptions(fields.cylinder, -20, 0, 0.25), [fields.cylinder]);
  const addOptions = useMemo(() => numericOptions(fields.add, 0, 4, 0.25), [fields.add]);
  const axisOptions = useMemo(() => numericOptions(fields.axis, 0, 180, 1), [fields.axis]);
  const overSphereOptions = useMemo(() => numericOptions(fields.overRefractionSphere, -20, 20, 0.25), [fields.overRefractionSphere]);
  const overCylinderOptions = useMemo(() => numericOptions(fields.overRefractionCylinder, -20, 0, 0.25), [fields.overRefractionCylinder]);
  const overAxisOptions = useMemo(() => numericOptions(fields.overRefractionAxis, 0, 180, 1), [fields.overRefractionAxis]);

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
    updateEye(eye, { manufacturer, product: "", colorMfPower: "" });
  }

  function selectProduct(eye: Eye, product: string) {
    updateEye(eye, { product, colorMfPower: "" });
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
          binocularPdDistance: optionalNumber(binocularPdDistance, "Binocular PD Dist"),
          binocularPdNear: optionalNumber(binocularPdNear, "Binocular PD Near"),
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

        {!definitionLoading && definition && activeTab === "details" && (
          <div className="mt-5 space-y-5">
            <div className="grid gap-4 rounded border border-white/10 bg-bg-panel/80 p-4 md:grid-cols-4">
              <SelectField label="Usage" value={usage} onChange={setUsage} options={activeOptions(fields.usage)} />
              <SelectField label="Status" value={status} onChange={setStatus} options={activeOptions(fields.status)} />
              <TextField label="Binocular PD Dist (mm)" value={binocularPdDistance} onChange={setBinocularPdDistance} inputMode="decimal" />
              <TextField label="Binocular PD Near (mm)" value={binocularPdNear} onChange={setBinocularPdNear} inputMode="decimal" />
            </div>

            {EYES.map((eye) => {
              const state = eyes[eye];
              const filteredProducts = products.filter((product) => product.manufacturerCode === state.manufacturer);
              const selectedProduct = products.find((product) => product.code === state.product);
              const cascadeOptions = activeNestedOptions(selectedProduct?.colorOptions ?? selectedProduct?.mfPowerOptions);
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
                    <TextField label="Base Curve (mm)" value={state.baseCurve} onChange={(value) => updateEye(eye, { baseCurve: value })} inputMode="decimal" />
                    <TextField label="Diameter (mm)" value={state.diameter} onChange={(value) => updateEye(eye, { diameter: value })} inputMode="decimal" />
                    <PowerField label="Sphere" value={state.sphere} onChange={(value) => updateEye(eye, { sphere: value })} options={sphereOptions} />
                    <PowerField label="Cylinder" value={state.cylinder} onChange={(value) => updateEye(eye, { cylinder: value })} options={cylinderOptions} />
                    <AxisField label="Axis" value={state.axis} onChange={(value) => updateEye(eye, { axis: value })} options={axisOptions} />
                    <PowerField label="Add" value={state.add} onChange={(value) => updateEye(eye, { add: value })} options={addOptions} />
                    {!state.manualEntry && cascadeOptions.length > 0 && (
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
                      <PowerField label="Sphere" value={state.overRefraction.sphere} onChange={(value) => updateOverRefraction(eye, { sphere: value })} options={overSphereOptions} />
                      <PowerField label="Cylinder" value={state.overRefraction.cylinder} onChange={(value) => updateOverRefraction(eye, { cylinder: value })} options={overCylinderOptions} />
                      <AxisField label="Axis" value={state.overRefraction.axis} onChange={(value) => updateOverRefraction(eye, { axis: value })} options={overAxisOptions} />
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

function SelectField({ label, value, onChange, options, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: DefinitionOption[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
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

function PowerField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand">
        <option value="">Select</option>
        {options.map((option) => <option key={option} value={option}>{formatPowerOption(Number(option))}</option>)}
      </select>
    </label>
  );
}

function AxisField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand">
        <option value="">Select</option>
        {options.map((option) => <option key={option} value={option}>{option}°</option>)}
      </select>
    </label>
  );
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

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}
