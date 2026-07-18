import { useEffect, useMemo, useState } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import { fhir } from "../../lib/fhir";
import {
  LENS_PRODUCT_PASTE_COLUMNS,
  parseLensProductPaste,
} from "../../lib/lens-bulk-paste";
import {
  BP_DIGITAL_LENS_PRODUCTS,
  COATING_OPTION_SEEDS,
  MODIFIER_OPTION_SEEDS,
  coatingOptionAdapter,
  lensProductAdapter,
  lensVocabularyAdapter,
  modifierOptionAdapter,
  validateCoatingHouseDefaults,
  type CoatingOption,
  type LensProduct,
  type LensVocabularyItem,
  type LensVocabularyKind,
  type ModifierOption,
} from "../../lib/lens-catalog";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "./CatalogEditor";

type LensCatalogSettingsProps = {
  canWrite: boolean;
  initialProducts?: readonly LensProduct[];
  initialCoatings?: readonly CoatingOption[];
  initialModifiers?: readonly ModifierOption[];
  productAdapter?: CatalogAdapter<LensProduct>;
};

const LABS = [
  { key: "all", label: "All labs" },
  { key: "bp-digital", label: "BP Digital" },
  { key: "cherry-optical", label: "Cherry Optical" },
] as const;

export function LensCatalogSettings({
  canWrite,
  initialProducts,
  initialCoatings,
  initialModifiers,
  productAdapter: suppliedProductAdapter,
}: LensCatalogSettingsProps) {
  const products = useMemo(
    () => suppliedProductAdapter ?? lensProductAdapter(fhir),
    [suppliedProductAdapter],
  );
  const coatings = useMemo(() => coatingOptionAdapter(fhir), []);
  const modifiers = useMemo(() => modifierOptionAdapter(fhir), []);
  const materialVocabulary = useMemo(() => lensVocabularyAdapter(fhir, "material"), []);
  const treatmentVocabulary = useMemo(() => lensVocabularyAdapter(fhir, "treatment-family"), []);
  const designVocabulary = useMemo(() => lensVocabularyAdapter(fhir, "design-type"), []);

  return (
    <CatalogScene title="Lens Catalog" canWrite={canWrite}>
      {!canWrite && (
        <div className="border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
          Read only. Practice-admin access is required to edit the Lens Catalog.
        </div>
      )}
      <LensProductManager
        adapter={products}
        coatingAdapter={coatings}
        canWrite={canWrite}
        initialProducts={initialProducts}
        initialCoatings={initialCoatings}
      />
      <div className="grid gap-8 lg:grid-cols-2">
        <CatalogSection
          descriptor={coatingOptionDescriptor(coatings)}
          canWrite={canWrite}
          initialState={initialCoatings ? { items: [...initialCoatings] } : undefined}
        />
        <CatalogSection
          descriptor={modifierOptionDescriptor(modifiers)}
          canWrite={canWrite}
          initialState={initialModifiers ? { items: [...initialModifiers] } : undefined}
        />
      </div>
      <section className="grid gap-5 rounded-2xl border border-[#e0bc7e]/20 bg-[#121a2e] p-5 shadow-2xl">
        <header>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#e0bc7e]">Shared axes</div>
          <h2 className="mt-1 text-xl font-semibold">Canonical vocabularies</h2>
          <p className="mt-1 text-sm text-white/55">Changes apply across every lab catalog.</p>
        </header>
        <div className="grid gap-8 lg:grid-cols-3">
          <CatalogSection descriptor={vocabularyDescriptor(designVocabulary, "design-type")} canWrite={canWrite} />
          <CatalogSection descriptor={vocabularyDescriptor(materialVocabulary, "material")} canWrite={canWrite} />
          <CatalogSection descriptor={vocabularyDescriptor(treatmentVocabulary, "treatment-family")} canWrite={canWrite} />
        </div>
      </section>
    </CatalogScene>
  );
}

function LensProductManager({
  adapter,
  coatingAdapter,
  canWrite,
  initialProducts,
  initialCoatings,
}: {
  adapter: CatalogAdapter<LensProduct>;
  coatingAdapter: CatalogAdapter<CoatingOption>;
  canWrite: boolean;
  initialProducts?: readonly LensProduct[];
  initialCoatings?: readonly CoatingOption[];
}) {
  const [products, setProducts] = useState<LensProduct[]>(() => [...(initialProducts ?? [])]);
  const [coatings, setCoatings] = useState<CoatingOption[]>(() => [...(initialCoatings ?? [])]);
  const [loading, setLoading] = useState(initialProducts === undefined);
  const [error, setError] = useState<string | null>(null);
  const [lab, setLab] = useState("bp-digital");
  const [type, setType] = useState("");
  const [material, setMaterial] = useState("");
  const [treatment, setTreatment] = useState("");
  const [coating, setCoating] = useState("");
  const [color, setColor] = useState("");

  useEffect(() => {
    if (initialProducts !== undefined) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([adapter.list(), coatingAdapter.list()])
      .then(([loadedProducts, loadedCoatings]) => {
        if (cancelled) return;
        setProducts(loadedProducts);
        setCoatings(loadedCoatings);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [adapter, coatingAdapter, initialProducts]);

  const labProducts = lab === "all" ? products : products.filter((product) => product.lab === lab);
  const coatingLabs = new Set(coatings.filter((option) => option.active && option.name === coating).map((option) => option.lab));
  const visible = labProducts.filter((product) =>
    (!type || product.design.type === type)
    && (!material || `${product.material.name}|${product.material.index}` === material)
    && (!treatment || product.treatment.brand === treatment)
    && (!coating || coatingLabs.has(product.lab))
    && (!color || product.treatment.color === color),
  );
  const labCoatings = coatings.filter((option) => option.active && (lab === "all" || option.lab === lab));

  return (
    <section className="overflow-hidden rounded-2xl border border-[#e0bc7e]/25 bg-[#121a2e] shadow-2xl">
      <header className="border-b border-white/10 bg-gradient-to-r from-[#17203a] to-[#121a2e] p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#e0bc7e]">Manager view</div>
            <h2 className="mt-1 text-xl font-semibold">Lens products</h2>
            <p className="mt-1 text-sm text-white/55">Matrix-priced by design, material, and treatment. Margin stays here.</p>
          </div>
          <span className="rounded-full border border-[#e0bc7e]/25 bg-[#e0bc7e]/10 px-3 py-1 text-xs font-semibold text-[#f2d9aa]">
            {visible.length} {visible.length === 1 ? "row" : "rows"}
          </span>
        </div>
        <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Lens catalog labs">
          {LABS.map((candidate) => (
            <button
              key={candidate.key}
              type="button"
              role="tab"
              aria-selected={lab === candidate.key}
              className={lab === candidate.key
                ? "rounded-full border border-[#e0bc7e]/50 bg-[#e0bc7e]/15 px-4 py-2 text-sm font-semibold text-[#f4dfb8]"
                : "rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/60"}
              onClick={() => setLab(candidate.key)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-3 border-b border-white/10 p-5 sm:grid-cols-2 lg:grid-cols-5">
        <Facet label="Type" value={type} options={unique(labProducts.map((product) => product.design.type))} onChange={setType} />
        <Facet
          label="Material / index"
          value={material}
          options={unique(labProducts.map((product) => `${product.material.name}|${product.material.index}`))}
          optionLabel={(value) => value.replace("|", " · ")}
          onChange={setMaterial}
        />
        <Facet label="Treatment" value={treatment} options={unique(labProducts.map((product) => product.treatment.brand))} onChange={setTreatment} />
        <Facet label="Coating" value={coating} options={unique(labCoatings.map((option) => option.name))} onChange={setCoating} />
        <Facet label="Color" value={color} options={unique(labProducts.flatMap((product) => product.treatment.color ? [product.treatment.color] : []))} onChange={setColor} />
      </div>

      {error && <div role="alert" className="m-5 border border-red-400/30 bg-red-950/40 p-3 text-sm text-red-100">{error}</div>}
      {loading ? (
        <div className="p-6 text-sm text-white/50">Loading lens products...</div>
      ) : visible.length === 0 ? (
        <div className="p-8 text-center text-sm text-white/50">No lens products match these lab and facet choices.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[#0c1325] text-xs uppercase tracking-wide text-white/45">
              <tr>
                {['Product', 'Type', 'Index', 'Unit', 'Wholesale', 'Retail', 'Margin %', 'Status', 'Source'].map((heading) => (
                  <th key={heading} className="whitespace-nowrap px-4 py-3 font-semibold">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/8">
              {visible.map((product) => (
                <tr key={product.id} className="hover:bg-white/[0.025]">
                  <td className="px-4 py-3">
                    <strong className="block text-white/90">{product.design.productName}</strong>
                    <span className="text-xs text-white/45">{product.material.name} · {product.treatment.brand}{product.treatment.color ? ` · ${product.treatment.color}` : ""}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-white/65">{product.design.type}</td>
                  <td className="px-4 py-3 text-white/65">{product.material.index}</td>
                  <td className="px-4 py-3"><span className="rounded-full border border-white/10 px-2 py-1 text-xs uppercase text-white/55">{product.unit}</span></td>
                  <td className="px-4 py-3 text-white/65">{money(product.wholesalePerPairCents)}</td>
                  <td className="px-4 py-3 text-white/85">{money(product.retailPerPairCents)}</td>
                  <td className="px-4 py-3 font-semibold text-emerald-300">{margin(product)}%</td>
                  <td className="px-4 py-3"><span className={product.active ? "text-emerald-300" : "text-white/35"}>{product.active ? "Active" : "Discontinued"}</span></td>
                  <td className="max-w-52 px-4 py-3 text-xs text-white/45">{product.sourceRef}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && (
        <BulkPasteGrid
          adapter={adapter}
          onCommitted={(saved) => setProducts((current) => mergeProducts(current, saved))}
        />
      )}
    </section>
  );
}

export function BulkPasteGrid({
  adapter,
  onCommitted,
}: {
  adapter: CatalogAdapter<LensProduct>;
  onCommitted?: (rows: LensProduct[]) => void;
}) {
  const [paste, setPaste] = useState("");
  const [preview, setPreview] = useState<LensProduct[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  function parsePreview() {
    const result = parseLensProductPaste(paste);
    setPreview(result.rows);
    setErrors(result.errors);
    setSavedCount(0);
  }

  async function commit() {
    setSaving(true);
    setErrors([]);
    try {
      const saved: LensProduct[] = [];
      for (const row of preview) saved.push(await adapter.save(row));
      setSavedCount(saved.length);
      setPreview([]);
      setPaste("");
      onCommitted?.(saved);
    } catch (error) {
      setErrors([errorMessage(error)]);
    } finally {
      setSaving(false);
    }
  }

  function updatePreview(index: number, update: Partial<LensProduct>) {
    setPreview((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...update } : row));
  }

  return (
    <div className="border-t border-white/10 bg-[#0c1325]/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white/90">Bulk-paste grid</h3>
          <p className="mt-1 text-xs text-white/45">Paste tab- or comma-delimited rows in this fixed order:</p>
        </div>
        <button type="button" className="scheduler-button" onClick={parsePreview}>Preview rows</button>
      </div>
      <code className="mt-3 block overflow-x-auto whitespace-nowrap rounded-lg border border-white/10 bg-black/20 p-3 text-[11px] text-[#d8c49e]">
        {LENS_PRODUCT_PASTE_COLUMNS.join(" · ")}
      </code>
      <textarea
        className="scheduler-input mt-3 min-h-28 w-full font-mono text-xs"
        value={paste}
        aria-label="Pasted lens product rows"
        placeholder={LENS_PRODUCT_PASTE_COLUMNS.join("\t")}
        onChange={(event) => setPaste(event.target.value)}
      />
      {errors.length > 0 && (
        <div role="alert" className="mt-3 border border-red-400/30 bg-red-950/40 p-3 text-sm text-red-100">
          {errors.map((message) => <div key={message}>{message}</div>)}
        </div>
      )}
      {savedCount > 0 && <div role="status" className="mt-3 text-sm text-emerald-300">Saved {savedCount} lens products.</div>}
      {preview.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-white/45"><tr>{["Product", "Lab", "Material", "Index", "Treatment", "Wholesale", "Retail", "Source"].map((heading) => <th key={heading} className="px-2 py-2">{heading}</th>)}</tr></thead>
            <tbody className="divide-y divide-white/10">
              {preview.map((row, index) => (
                <tr key={row.id}>
                  <PreviewInput value={row.design.productName} label="Product" onChange={(value) => updatePreview(index, { design: { ...row.design, productName: value } })} />
                  <PreviewInput value={row.lab} label="Lab" onChange={(value) => updatePreview(index, { lab: value })} />
                  <PreviewInput value={row.material.name} label="Material" onChange={(value) => updatePreview(index, { material: { ...row.material, name: value } })} />
                  <PreviewInput value={String(row.material.index)} label="Index" type="number" onChange={(value) => updatePreview(index, { material: { ...row.material, index: Number(value) } })} />
                  <PreviewInput value={row.treatment.brand} label="Treatment" onChange={(value) => updatePreview(index, { treatment: { ...row.treatment, brand: value } })} />
                  <PreviewInput value={String(row.wholesalePerPairCents)} label="Wholesale" type="number" onChange={(value) => updatePreview(index, { wholesalePerPairCents: Number(value) })} />
                  <PreviewInput value={String(row.retailPerPairCents)} label="Retail" type="number" onChange={(value) => updatePreview(index, { retailPerPairCents: Number(value) })} />
                  <PreviewInput value={row.sourceRef} label="Source" onChange={(value) => updatePreview(index, { sourceRef: value })} />
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex justify-end">
            <button type="button" className="scheduler-button" disabled={saving} onClick={() => void commit()}>
              {saving ? "Saving..." : `Commit ${preview.length} ${preview.length === 1 ? "row" : "rows"}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function coatingOptionDescriptor(
  adapter: CatalogAdapter<CoatingOption>,
): CatalogDescriptor<CoatingOption> {
  return {
    title: "Coatings",
    singularLabel: "coating",
    adapter,
    fields: [
      { type: "text", key: "lab", label: "Lab", required: true },
      { type: "select", key: "category", label: "Category", required: true, options: ["AR", "scratch", "mirror", "tint", "uv"].map((value) => ({ value, label: value })) },
      { type: "text", key: "name", label: "Name", required: true },
      { type: "number", key: "pricePerPairCents", label: "Price per pair (cents)", required: true, min: 0 },
      { type: "toggle", key: "uvProtection", label: "UV protection" },
      { type: "toggle", key: "hydrophobic", label: "Hydrophobic" },
      { type: "toggle", key: "hevProtection", label: "HEV protection" },
      { type: "number", key: "warrantyYears", label: "Warranty years", min: 0 },
      { type: "toggle", key: "isHouseDefault", label: "House default" },
    ],
    createItem: () => ({
      id: `coating-${randomId()}`,
      active: true,
      lab: "bp-digital",
      category: "AR",
      name: "",
      pricePerPairCents: 0,
      uvProtection: false,
      hydrophobic: false,
      hevProtection: false,
      isHouseDefault: false,
    }),
    validateItem: (item, items) => validateCoatingHouseDefaults(mergeProducts(items, [item])),
    label: (item) => item.name,
    chips: (item) => [item.lab, item.category, item.isHouseDefault ? "HOUSE DEFAULT" : "OPTION"],
    facts: (item) => [`${money(item.pricePerPairCents)} per pair`],
    listGrammar: {
      searchPlaceholder: "Search coatings",
      searchText: (item) => `${item.lab} ${item.category} ${item.name}`,
      deactivateConsequence: (item) => `${item.name || "This coating"} remains in historical orders and leaves the active catalog.`,
    },
  };
}

export function modifierOptionDescriptor(
  adapter: CatalogAdapter<ModifierOption>,
): CatalogDescriptor<ModifierOption> {
  return {
    title: "Modifiers",
    singularLabel: "modifier",
    adapter,
    fields: [
      { type: "text", key: "lab", label: "Lab", required: true },
      { type: "text", key: "name", label: "Name", required: true },
      { type: "number", key: "priceCents", label: "Price (cents)", required: true, min: 0 },
      { type: "select", key: "unit", label: "Unit", required: true, options: [
        { value: "pair", label: "Pair" },
        { value: "perDiopter", label: "Per diopter" },
        { value: "perItem", label: "Per item" },
      ] },
    ],
    createItem: () => ({ id: `modifier-${randomId()}`, active: true, lab: "bp-digital", name: "", priceCents: 0, unit: "pair" }),
    label: (item) => item.name,
    chips: (item) => [item.lab, item.unit],
    facts: (item) => [money(item.priceCents), item.autoTrigger ? `${item.autoTrigger.field} ${item.autoTrigger.operator} ${item.autoTrigger.value}` : "Manual modifier"],
    readOnlyFacts: (item) => item.autoTrigger ? [{ label: "Automatic trigger", value: `${item.autoTrigger.field} ${item.autoTrigger.operator} ${item.autoTrigger.value}` }] : [],
    listGrammar: {
      searchPlaceholder: "Search modifiers",
      searchText: (item) => `${item.lab} ${item.name} ${item.unit}`,
      deactivateConsequence: (item) => `${item.name || "This modifier"} remains in historical orders and leaves the active catalog.`,
    },
  };
}

export function vocabularyDescriptor(
  adapter: CatalogAdapter<LensVocabularyItem>,
  kind: LensVocabularyKind,
): CatalogDescriptor<LensVocabularyItem> {
  const material = kind === "material";
  return {
    title: kind === "design-type" ? "Design types" : material ? "Materials" : "Treatment families",
    singularLabel: kind === "design-type" ? "design type" : material ? "material" : "treatment family",
    adapter,
    fields: [
      { type: "text", key: "key", label: "Key", required: true, unique: true },
      { type: "text", key: "name", label: "Display name", required: true },
      ...(material ? [
        { type: "number" as const, key: "index", label: "Index", required: true, min: 1.001 },
        { type: "text" as const, key: "includedBaseCoating", label: "Included base coating" },
      ] : []),
    ],
    createItem: () => ({ id: `${kind}-${randomId()}`, active: true, kind, key: "", name: "", ...(material ? { index: 1.5 } : {}) }),
    label: (item) => item.name,
    chips: (item) => [item.key, ...(item.index === undefined ? [] : [`INDEX ${item.index}`])],
    facts: (item) => item.includedBaseCoating ? [`Includes ${item.includedBaseCoating}`] : [],
    listGrammar: {
      searchPlaceholder: `Search ${kind === "design-type" ? "design types" : material ? "materials" : "treatment families"}`,
      searchText: (item) => `${item.key} ${item.name} ${item.index ?? ""}`,
      deactivateConsequence: (item) => `${item.name || "This vocabulary row"} remains on historical catalog products and is no longer offered for new rows.`,
    },
  };
}

function Facet({
  label,
  value,
  options,
  optionLabel = (option) => option,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  optionLabel?: (option: string) => string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-white/45">
      {label}
      <select className="scheduler-input text-sm normal-case tracking-normal" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All {label.toLocaleLowerCase()}</option>
        {options.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
      </select>
    </label>
  );
}

function PreviewInput({
  value,
  label,
  type = "text",
  onChange,
}: {
  value: string;
  label: string;
  type?: "text" | "number";
  onChange: (value: string) => void;
}) {
  return <td className="px-1 py-2"><input className="scheduler-input min-w-28 text-xs" aria-label={`Preview ${label}`} type={type} value={value} onChange={(event) => onChange(event.target.value)} /></td>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mergeProducts<Item extends { id: string }>(current: readonly Item[], saved: readonly Item[]): Item[] {
  const updates = new Map(saved.map((item) => [item.id, item]));
  const merged = current.map((item) => updates.get(item.id) ?? item);
  const existing = new Set(current.map((item) => item.id));
  return [...merged, ...saved.filter((item) => !existing.has(item.id))];
}

function margin(product: LensProduct): string {
  if (product.retailPerPairCents === 0) return "0.0";
  return (((product.retailPerPairCents - product.wholesalePerPairCents) / product.retailPerPairCents) * 100).toFixed(1);
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const LENS_CATALOG_TEST_SEEDS = {
  products: BP_DIGITAL_LENS_PRODUCTS,
  coatings: COATING_OPTION_SEEDS,
  modifiers: MODIFIER_OPTION_SEEDS,
} as const;
