import { useEffect, useMemo, useRef, useState } from "react";
import type { SectionSaveStatus } from "./types";
import { formatPowerOption, numericOptions } from "./power-options";
import { VaValueSelect } from "./VaValueSelect";
import {
  CustomFieldEditor,
  type CustomFieldEditorValue,
} from "./CustomFieldEditor";

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
  manufacturerCode?: string;
  lensTypeCode?: string;
  localCode?: string;
  parameterCode?: string;
  unit?: string;
  origin?: "practice";
  valueType?: "number" | "select";
  options?: DefinitionOption[];
  order?: number;
  min?: number;
  max?: number;
  step?: number;
}

interface DefinitionField {
  display?: string;
  minimum?: number;
  maximum?: number;
  step?: number;
  options?: DefinitionOption[];
  visibleCodes?: string[];
  allowCreate?: boolean;
  localCode?: string;
  origin?: "practice";
  valueType?: "number" | "select";
  unit?: string;
  min?: number;
  max?: number;
  order?: number;
  active?: boolean;
}

interface DefinitionResponse {
  definition: {
    stableKey?: string;
    fields: Record<string, DefinitionField>;
  };
  canManageFields?: boolean;
}

interface KeratometryReading {
  flatK: number | null;
  flatAxis: number | null;
  steepK: number | null;
  steepAxis: number | null;
  recordedAt: string;
}

interface KeratometryResponse {
  eyes: Record<Eye, KeratometryReading | null>;
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
  lensType: string;
  material: string;
  baseCurve: string;
  diameter: string;
  sphere: string;
  cylinder: string;
  axis: string;
  add: string;
  distanceVisualAcuity: string;
  nearVisualAcuity: string;
  distancePinholeVisualAcuity: string;
  other: string;
  manualEntry: boolean;
  additionalValues: Record<string, string>;
  overRefraction: OverRefractionState;
}

interface EyePayload {
  underlyingCondition?: string;
  manufacturer?: string;
  product?: string;
  lensType?: string;
  material?: string;
  baseCurve?: number;
  diameter?: number;
  sphere?: number;
  cylinder?: number;
  axis?: number;
  add?: number;
  distanceVisualAcuity?: string;
  nearVisualAcuity?: string;
  distancePinholeVisualAcuity?: string;
  other?: string;
  manualEntry: boolean;
  additionalFields: Array<{ code: string; value: number }>;
  customFields: Array<{ code: string; value: number | string }>;
  overRefraction?: {
    sphere?: number;
    cylinder?: number;
    axis?: number;
    distanceVisualAcuity?: string;
    nearVisualAcuity?: string;
  };
}

interface ManualCatalogEntry {
  manufacturer: string;
  product: string;
  lensType?: string;
}

const EYES: Eye[] = ["OD", "OS"];
const OPERATOR = "OSOD UI clinical_graph_specialty_contact_lens";

export function SpecialtyContactLensSection({ patientReference, encounterReference, onSaved }: Props) {
  const [definition, setDefinition] = useState<DefinitionResponse | null>(null);
  const [keratometry, setKeratometry] = useState<KeratometryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [usage, setUsage] = useState("");
  const [status, setStatus] = useState("");
  const [remarks, setRemarks] = useState("");
  const [eyes, setEyes] = useState<Record<Eye, EyeState>>(() => ({ OD: emptyEye(), OS: emptyEye() }));
  const [visibleAdditionalCodes, setVisibleAdditionalCodes] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualCatalog, setManualCatalog] = useState<ManualCatalogEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SectionSaveStatus | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [definitionSaving, setDefinitionSaving] = useState(false);
  const [layoutSaved, setLayoutSaved] = useState(false);
  const pickerInitialized = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    Promise.all([
      fetch(`${clinicalGraphApiBase()}/clinical-graph/contact-lens/specialty/definition`, {
        headers: authHeaders(),
        signal: controller.signal,
      }),
      fetch(`${clinicalGraphApiBase()}/clinical-graph/contact-lens/keratometry?patient=${encodeURIComponent(patientReference)}`, {
        headers: authHeaders(),
        signal: controller.signal,
      }),
    ])
      .then(async ([definitionResponse, keratometryResponse]) => {
        if (!definitionResponse.ok) throw new Error(`Specialty contact lens definition request failed: ${definitionResponse.status}`);
        if (!keratometryResponse.ok) throw new Error(`Last keratometry request failed: ${keratometryResponse.status}`);
        return await Promise.all([
          definitionResponse.json() as Promise<DefinitionResponse>,
          keratometryResponse.json() as Promise<KeratometryResponse>,
        ]);
      })
      .then(([nextDefinition, nextKeratometry]) => {
        setDefinition(nextDefinition);
        setKeratometry(nextKeratometry);
        if (!pickerInitialized.current) {
          setVisibleAdditionalCodes(nextDefinition.definition.fields.additionalFields?.visibleCodes ?? []);
          pickerInitialized.current = true;
        }
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setLoadError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [patientReference, refresh]);

  const fields = definition?.definition.fields ?? {};
  const catalogManufacturers = useMemo(() => activeOptions(fields.manufacturer), [fields.manufacturer]);
  const catalogProducts = useMemo(() => activeProductOptions(fields.product), [fields.product]);
  const manufacturerOptions = useMemo(() => uniqueOptions([
    ...catalogManufacturers,
    ...manualCatalog.map((entry) => ({ code: entry.manufacturer, display: entry.manufacturer })),
  ]), [catalogManufacturers, manualCatalog]);
  const products = useMemo(() => uniqueOptions([
    ...catalogProducts,
    ...manualCatalog.map((entry) => ({
      code: entry.product,
      display: entry.product,
      manufacturerCode: entry.manufacturer,
      lensTypeCode: entry.lensType,
    })),
  ]), [catalogProducts, manualCatalog]);
  const customOptions = useMemo(() => Object.values(fields).flatMap((field) =>
    field.origin === "practice" && field.active !== false && field.localCode && field.display && field.valueType
      ? [{
          code: field.localCode,
          localCode: field.localCode,
          display: field.display,
          active: true,
          origin: "practice" as const,
          valueType: field.valueType,
          unit: field.unit,
          options: field.options,
          order: field.order,
          min: field.min,
          max: field.max,
          step: field.step,
        }]
      : []), [fields]);
  const additionalOptions = useMemo(() => [
    ...activeOptions(fields.additionalFields).map((option) => ({ ...option, valueType: "number" as const })),
    ...customOptions,
  ], [customOptions, fields.additionalFields]);
  const visibleAdditional = visibleAdditionalCodes.flatMap((code) => {
    const option = additionalOptions.find((candidate) => candidate.code === code);
    return option ? [option] : [];
  });
  const hiddenAdditional = additionalOptions.filter((option) => !visibleAdditionalCodes.includes(option.code));
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
      [eye]: { ...current[eye], overRefraction: { ...current[eye].overRefraction, ...next } },
    }));
  }

  function updateAdditionalValue(eye: Eye, code: string, value: string) {
    setEyes((current) => ({
      ...current,
      [eye]: {
        ...current[eye],
        additionalValues: { ...current[eye].additionalValues, [code]: value },
      },
    }));
  }

  function selectManufacturer(eye: Eye, manufacturer: string) {
    updateEye(eye, { manufacturer, product: "" });
  }

  function selectProduct(eye: Eye, productCode: string) {
    const product = products.find((candidate) => candidate.code === productCode);
    updateEye(eye, { product: productCode, ...(product?.lensTypeCode ? { lensType: product.lensTypeCode } : {}) });
  }

  function addAdditionalField(code: string) {
    setVisibleAdditionalCodes((current) => current.includes(code) ? current : [...current, code]);
  }

  function removeAdditionalField(code: string) {
    setVisibleAdditionalCodes((current) => current.filter((candidate) => candidate !== code));
    setEyes((current) => Object.fromEntries(EYES.map((eye) => {
      const { [code]: _removed, ...remaining } = current[eye].additionalValues;
      return [eye, { ...current[eye], additionalValues: remaining }];
    })) as Record<Eye, EyeState>);
  }

  function moveAdditionalField(code: string, direction: -1 | 1) {
    setVisibleAdditionalCodes((current) => {
      const index = current.indexOf(code);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  async function mutateDefinition(body: Record<string, unknown>) {
    const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/finding-definitions/specialty_contact_lens`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { definition?: DefinitionResponse["definition"]; field?: DefinitionOption; error?: string };
    if (!response.ok) throw new Error(result.error ?? `Finding-definition update failed: ${response.status}`);
    if (result.definition) setDefinition((current) => ({
      definition: result.definition!,
      canManageFields: current?.canManageFields,
    }));
    return result;
  }

  async function enableCreation() {
    setDefinitionSaving(true);
    setError(null);
    try {
      await mutateDefinition({ action: "set-picker-config", allowCreate: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDefinitionSaving(false);
    }
  }

  async function saveLayout() {
    setDefinitionSaving(true);
    setError(null);
    setLayoutSaved(false);
    try {
      await mutateDefinition({ action: "set-picker-config", visibleCodes: visibleAdditionalCodes });
      setLayoutSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDefinitionSaving(false);
    }
  }

  async function createField(value: CustomFieldEditorValue) {
    setDefinitionSaving(true);
    setError(null);
    try {
      const result = await mutateDefinition({ action: "create-custom-field", ...value });
      const code = result.field?.localCode ?? result.field?.code;
      if (code) addAdditionalField(code);
      setEditorOpen(false);
      setLayoutSaved(false);
    } finally {
      setDefinitionSaving(false);
    }
  }

  async function save() {
    let payloadEyes: Partial<Record<Eye, EyePayload>>;
    try {
      payloadEyes = Object.fromEntries(EYES.flatMap((eye) => {
        const payload = buildEyePayload(eyes[eye], eye, visibleAdditional);
        return payload ? [[eye, payload]] : [];
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    if (Object.keys(payloadEyes).length === 0) {
      setError("Enter at least one specialty contact lens eye before saving.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${clinicalGraphApiBase()}/clinical-graph/contact-lens/specialty`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(compact({
          patientReference,
          encounterReference,
          usage,
          status,
          remarks,
          eyes: payloadEyes,
        })),
      });
      const body = await response.json() as {
        eyes?: Record<string, unknown>;
        catalogAdditions?: ManualCatalogEntry[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `Specialty contact lens save failed: ${response.status}`);
      if (body.catalogAdditions?.length) {
        setManualCatalog((current) => uniqueCatalogEntries([...current, ...body.catalogAdditions!]));
      }
      const count = Object.keys(body.eyes ?? payloadEyes).length;
      const nextSaved = {
        completed: true,
        summary: `Specialty CL saved for ${count} eye${count === 1 ? "" : "s"}`,
        savedAt: new Date().toISOString(),
        operator: OPERATOR,
      };
      setSaved(nextSaved);
      onSaved(nextSaved);
      setRefresh((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto p-6">
      <div className="max-w-[1800px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Specialty Contact Lens</h2>
            <p className="mt-1 text-sm text-white/45">RGP, scleral, hybrid, and corneal-reshaping lens fitting</p>
          </div>
          <div className="text-right text-xs text-white/40">
            <div>Provider: current clinical session</div>
            <div>Facility and recorded time: encounter-derived on save</div>
          </div>
        </div>

        {loading && <div className="mt-5 rounded border border-white/10 bg-bg-panel p-4 text-sm text-white/55">Loading specialty lens catalog and last keratometry…</div>}
        {loadError && <div className="mt-5 rounded border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">{loadError}</div>}

        {!loading && definition && (
          <div className="mt-5 space-y-5">
            <div className="grid gap-4 rounded border border-white/10 bg-bg-panel/80 p-4 md:grid-cols-2">
              <SelectField label="Usage" value={usage} onChange={setUsage} options={activeOptions(fields.usage)} />
              <SelectField label="Status" value={status} onChange={setStatus} options={activeOptions(fields.status)} />
            </div>

            <div className="rounded border border-white/10 bg-bg-panel/80 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Additional Fields</h3>
                  <p className="mt-1 text-xs text-white/45">Show only the geometry fields needed for this fit, then reorder them.</p>
                </div>
                <button type="button" onClick={() => setPickerOpen((current) => !current)} className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10">
                  {pickerOpen ? "Close picker" : "Manage fields"}
                </button>
              </div>
              {pickerOpen && (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <PickerList
                      title="Visible"
                      options={visibleAdditional}
                      onRemove={removeAdditionalField}
                      onMove={moveAdditionalField}
                    />
                    <PickerList title="Hidden" options={hiddenAdditional} onAdd={addAdditionalField} />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {definition.canManageFields && fields.additionalFields?.allowCreate && (
                      <button type="button" onClick={() => setEditorOpen(true)} className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10">+ Create field…</button>
                    )}
                    {definition.canManageFields && !fields.additionalFields?.allowCreate && (
                      <button type="button" onClick={enableCreation} disabled={definitionSaving} className="rounded border border-brand/60 px-3 py-2 text-sm text-brand-light hover:bg-brand/10 disabled:opacity-50">Enable field creation</button>
                    )}
                    {definition.canManageFields && (
                      <button type="button" onClick={saveLayout} disabled={definitionSaving} className="rounded bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Save field layout</button>
                    )}
                    {layoutSaved && <span className="text-sm text-emerald-300">Practice field layout saved</span>}
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-5 xl:grid-cols-2">
              {EYES.map((eye) => {
                const state = eyes[eye];
                const filteredProducts = products.filter((product) => product.manufacturerCode === state.manufacturer);
                return (
                  <div key={eye} className="rounded border border-white/10 bg-bg-panel/75 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-3xl font-semibold text-white">{eye}</h3>
                      <label className="flex items-center gap-2 text-sm text-white/70">
                        <input
                          type="checkbox"
                          checked={state.manualEntry}
                          onChange={(event) => updateEye(eye, { manualEntry: event.target.checked, manufacturer: "", product: "" })}
                          className="h-4 w-4 accent-brand"
                        />
                        Manual Entry
                      </label>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                      <SelectField label="Lens Type" value={state.lensType} onChange={(value) => updateEye(eye, { lensType: value })} options={activeOptions(fields.lensType)} />
                      <SelectField label="Material" value={state.material} onChange={(value) => updateEye(eye, { material: value })} options={activeOptions(fields.material)} />
                      <TextField label="Base Curve (mm)" value={state.baseCurve} onChange={(value) => updateEye(eye, { baseCurve: value })} inputMode="decimal" />
                      <TextField label="Diameter (mm)" value={state.diameter} onChange={(value) => updateEye(eye, { diameter: value })} inputMode="decimal" />
                      <PowerField label="Sphere" value={state.sphere} onChange={(value) => updateEye(eye, { sphere: value })} options={sphereOptions} />
                      <PowerField label="Cylinder" value={state.cylinder} onChange={(value) => updateEye(eye, { cylinder: value })} options={cylinderOptions} />
                      <AxisField label="Axis" value={state.axis} onChange={(value) => updateEye(eye, { axis: value })} options={axisOptions} />
                      <PowerField label="Add" value={state.add} onChange={(value) => updateEye(eye, { add: value })} options={addOptions} />
                      <VaField label="Dist VA" value={state.distanceVisualAcuity} onChange={(value) => updateEye(eye, { distanceVisualAcuity: value })} />
                      <VaField label="Near VA" value={state.nearVisualAcuity} onChange={(value) => updateEye(eye, { nearVisualAcuity: value })} />
                      <VaField label="Dist PH" value={state.distancePinholeVisualAcuity} onChange={(value) => updateEye(eye, { distancePinholeVisualAcuity: value })} />
                      <div className="sm:col-span-2 lg:col-span-3">
                        <TextField label="Other" value={state.other} onChange={(value) => updateEye(eye, { other: value })} />
                      </div>
                    </div>

                    <KeratometryReadout reading={keratometry?.eyes[eye] ?? null} />

                    {visibleAdditional.length > 0 && (
                      <div className="mt-5 rounded border border-white/10 bg-bg-deep/50 p-4">
                        <h4 className="text-sm font-semibold text-white">Additional lens geometry</h4>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {visibleAdditional.map((field) => field.valueType === "select" ? (
                            <SelectField
                              key={field.code}
                              label={field.display}
                              value={state.additionalValues[field.code] ?? ""}
                              onChange={(value) => updateAdditionalValue(eye, field.code, value)}
                              options={activeOptions({ options: field.options })}
                            />
                          ) : (
                            <TextField
                              key={field.code}
                              label={`${field.display}${field.unit ? ` (${field.unit})` : ""}`}
                              value={state.additionalValues[field.code] ?? ""}
                              onChange={(value) => updateAdditionalValue(eye, field.code, value)}
                              inputMode="decimal"
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-5 rounded border border-brand/20 bg-brand/5 p-4">
                      <h4 className="text-sm font-semibold text-white">Over-Refraction over this {eye} lens</h4>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
            </div>

            <TextAreaField label="Remarks" value={remarks} onChange={setRemarks} maxLength={2000} />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={saving || loading || !definition} className="rounded bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand/85 disabled:cursor-not-allowed disabled:opacity-50">
            {saving ? "Saving…" : "Save Specialty Contact Lens"}
          </button>
          {saved && <span className="text-sm text-emerald-300">{saved.summary}</span>}
          {error && <span className="text-sm text-red-300">{error}</span>}
        </div>
      </div>
      {editorOpen && <CustomFieldEditor saving={definitionSaving} onCancel={() => setEditorOpen(false)} onSave={createField} />}
    </section>
  );
}

function PickerList({ title, options, onAdd, onRemove, onMove }: {
  title: string;
  options: DefinitionOption[];
  onAdd?: (code: string) => void;
  onRemove?: (code: string) => void;
  onMove?: (code: string, direction: -1 | 1) => void;
}) {
  return (
    <div className="rounded border border-white/10 bg-bg-deep/60 p-3">
      <h4 className="text-xs uppercase tracking-widest text-white/40">{title}</h4>
      <div className="mt-2 space-y-2">
        {options.length === 0 && <div className="text-sm text-white/35">None</div>}
        {options.map((option, index) => (
          <div key={option.code} className="flex items-center gap-2 rounded border border-white/10 bg-bg-panel/60 px-3 py-2 text-sm text-white/75">
            <span className="flex-1">{option.display}</span>
            {onMove && (
              <>
                <button type="button" onClick={() => onMove(option.code, -1)} disabled={index === 0} className="rounded px-2 py-1 text-white/60 hover:bg-white/10 disabled:opacity-25" aria-label={`Move ${option.display} up`}>↑</button>
                <button type="button" onClick={() => onMove(option.code, 1)} disabled={index === options.length - 1} className="rounded px-2 py-1 text-white/60 hover:bg-white/10 disabled:opacity-25" aria-label={`Move ${option.display} down`}>↓</button>
              </>
            )}
            {onRemove && <button type="button" onClick={() => onRemove(option.code)} className="rounded px-2 py-1 text-red-200 hover:bg-red-400/10" aria-label={`Remove ${option.display}`}>−</button>}
            {onAdd && <button type="button" onClick={() => onAdd(option.code)} className="rounded px-2 py-1 text-emerald-200 hover:bg-emerald-400/10" aria-label={`Add ${option.display}`}>＋</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function KeratometryReadout({ reading }: { reading: KeratometryReading | null }) {
  return (
    <div className="mt-5 rounded border border-cyan-300/20 bg-cyan-300/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-cyan-100">Last Keratometry</h4>
        <span className="text-xs text-white/40">{reading ? formatRecordedAt(reading.recordedAt) : "No auto-K recorded"}</span>
      </div>
      {reading && (
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Readout label="Flat" value={reading.flatK} />
          <Readout label="Flat Axis" value={reading.flatAxis} suffix="°" />
          <Readout label="Steep" value={reading.steepK} />
          <Readout label="Steep Axis" value={reading.steepAxis} suffix="°" />
        </div>
      )}
    </div>
  );
}

function Readout({ label, value, suffix = "" }: { label: string; value: number | null; suffix?: string }) {
  return <div><div className="text-xs uppercase tracking-wider text-white/35">{label}</div><div className="mt-1 text-white">{value ?? "—"}{value === null ? "" : suffix}</div></div>;
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
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-2 text-sm text-white outline-none focus:border-brand disabled:opacity-45">
        <option value="">Select</option>
        {options.map((option) => <option key={option.code} value={option.code}>{option.display}</option>)}
      </select>
    </label>
  );
}

function TextField({ label, value, onChange, inputMode }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: "decimal";
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-white/35">{label}</span>
      <input type="text" inputMode={inputMode} value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded border border-white/15 bg-bg-deep px-3 text-sm text-white outline-none focus:border-brand" />
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

function TextAreaField({ label, value, onChange, maxLength }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
}) {
  return (
    <label className="block rounded border border-white/10 bg-bg-panel/80 p-4">
      <span className="mb-2 flex justify-between text-xs uppercase tracking-widest text-white/35"><span>{label}</span><span>{value.length}/{maxLength}</span></span>
      <textarea value={value} maxLength={maxLength} rows={5} onChange={(event) => onChange(event.target.value)} className="w-full resize-y rounded border border-white/15 bg-bg-deep p-3 text-sm text-white outline-none focus:border-brand" />
    </label>
  );
}

function emptyEye(): EyeState {
  return {
    underlyingCondition: "",
    manufacturer: "",
    product: "",
    lensType: "",
    material: "",
    baseCurve: "",
    diameter: "",
    sphere: "",
    cylinder: "",
    axis: "",
    add: "",
    distanceVisualAcuity: "",
    nearVisualAcuity: "",
    distancePinholeVisualAcuity: "",
    other: "",
    manualEntry: false,
    additionalValues: {},
    overRefraction: { sphere: "", cylinder: "", axis: "", distanceVisualAcuity: "", nearVisualAcuity: "" },
  };
}

function buildEyePayload(state: EyeState, eye: Eye, visibleAdditional: DefinitionOption[]): EyePayload | undefined {
  const additionalFields = visibleAdditional.filter((field) => field.origin !== "practice").flatMap((field) => {
    const raw = state.additionalValues[field.code] ?? "";
    return raw === "" ? [] : [{ code: field.code, value: requiredNumber(raw, `${eye} ${field.display}`) }];
  });
  const customFields = visibleAdditional.filter((field) => field.origin === "practice").flatMap((field) => {
    const raw = state.additionalValues[field.code] ?? "";
    if (raw === "") return [];
    return [{
      code: field.localCode ?? field.code,
      value: field.valueType === "select" ? raw : requiredNumber(raw, `${eye} ${field.display}`),
    }];
  });
  const touched = state.manualEntry || Object.entries(state).some(([key, value]) =>
    !["manualEntry", "additionalValues", "overRefraction"].includes(key) && value !== "") ||
    additionalFields.length > 0 || customFields.length > 0 || Object.values(state.overRefraction).some(Boolean);
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
    lensType: state.lensType,
    material: state.material,
    baseCurve: optionalNumber(state.baseCurve, `${eye} base curve`),
    diameter: optionalNumber(state.diameter, `${eye} diameter`),
    sphere: optionalNumber(state.sphere, `${eye} sphere`),
    cylinder: optionalNumber(state.cylinder, `${eye} cylinder`),
    axis: optionalNumber(state.axis, `${eye} axis`),
    add: optionalNumber(state.add, `${eye} add`),
    distanceVisualAcuity: state.distanceVisualAcuity,
    nearVisualAcuity: state.nearVisualAcuity,
    distancePinholeVisualAcuity: state.distancePinholeVisualAcuity,
    other: state.other,
    manualEntry: state.manualEntry,
    additionalFields,
    customFields,
    overRefraction: Object.keys(overRefraction).length > 0 ? overRefraction : undefined,
  }) as EyePayload;
}

function activeOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return (field?.options ?? []).filter((option) => option.active !== false);
}

function activeProductOptions(field: DefinitionField | undefined): DefinitionOption[] {
  return activeOptions(field).filter((option) => typeof option.manufacturerCode === "string");
}

function uniqueOptions(options: DefinitionOption[]): DefinitionOption[] {
  return [...new Map(options.map((option) => [option.code, option])).values()];
}

function uniqueCatalogEntries(entries: ManualCatalogEntry[]): ManualCatalogEntry[] {
  return [...new Map(entries.map((entry) => [`${entry.manufacturer}\u0000${entry.product}`, entry])).values()];
}

function requiredNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric.`);
  return parsed;
}

function optionalNumber(value: string, label: string): number | undefined {
  return value === "" ? undefined : requiredNumber(value, label);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}

function formatRecordedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function clinicalGraphApiBase(): string {
  return import.meta.env.VITE_OSOD_MCP_BASE_URL?.replace(/\/$/, "") ?? "";
}

function authHeaders(): Record<string, string> {
  const token = window.localStorage.getItem("osod_access_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
