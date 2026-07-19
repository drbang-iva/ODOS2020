import { useEffect, useMemo, useState } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import { fhir } from "../../lib/fhir";
import {
  DEFAULT_LENS_RETAIL_RULE,
  approveLensImport,
  buildLensImportReview,
  parseLensProductPaste,
  type LensImportReview,
  type LensRetailRule,
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
  type LensDesignType,
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
import { CurrencyInput } from "../../components/settings/CatalogFields";

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
          existingProducts={products}
          onCommitted={(saved) => setProducts((current) => mergeProducts(current, saved))}
        />
      )}
    </section>
  );
}

export function BulkPasteGrid({
  adapter,
  existingProducts = [],
  onCommitted,
}: {
  adapter: CatalogAdapter<LensProduct>;
  existingProducts?: readonly LensProduct[];
  onCommitted?: (rows: LensProduct[]) => void;
}) {
  const [paste, setPaste] = useState("");
  const [review, setReview] = useState<LensImportReview | null>(null);
  const [categories, setCategories] = useState<LensDesignType[]>([]);
  const [retailRules, setRetailRules] = useState<Partial<Record<LensDesignType, LensRetailRule>>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  function parsePreview(rules = retailRules) {
    const result = parseLensProductPaste(paste, undefined, { retailRules: rules });
    setReview(buildLensImportReview(result, existingProducts));
    setCategories(unique(result.rows.map((row) => row.design.type)) as LensDesignType[]);
    setErrors([]);
    setSavedCount(0);
  }

  async function approve() {
    if (!review) return;
    setSaving(true);
    setErrors([]);
    try {
      const saved = await approveLensImport(review, adapter);
      setSavedCount(saved.length);
      setReview(null);
      setPaste("");
      onCommitted?.(saved);
    } catch (error) {
      setErrors([errorMessage(error)]);
    } finally {
      setSaving(false);
    }
  }

  function updateRetail(index: number, retailPerPairCents: number) {
    setReview((current) => current ? {
      ...current,
      rows: current.rows.map((row, rowIndex) => rowIndex === index && row.classification !== "UNPARSED"
        ? { ...row, incoming: { ...row.incoming, retailPerPairCents } }
        : row),
    } : current);
  }

  function updateRule(category: LensDesignType, update: Partial<LensRetailRule>) {
    const current = retailRules[category] ?? DEFAULT_LENS_RETAIL_RULE;
    const next = { ...retailRules, [category]: { ...current, ...update } };
    setRetailRules(next);
    parsePreview(next);
  }

  return (
    <div className="border-t border-white/10 bg-[#0c1325]/70 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white/90">Import review</h3>
          <p className="mt-1 text-xs text-white/45">Paste a Lens Catalog v1 JSON file. Catalog data does not change until Approve.</p>
        </div>
        <button type="button" className="scheduler-button" onClick={() => parsePreview()}>Review file</button>
      </div>
      <textarea
        className="scheduler-input mt-3 min-h-36 w-full font-mono text-xs"
        value={paste}
        aria-label="Lens catalog import JSON"
        placeholder={'{"schemaVersion":1,"lab":"bp-digital",...}'}
        onChange={(event) => setPaste(event.target.value)}
      />
      {(errors.length > 0 || (review?.errors.length ?? 0) > 0) && (
        <div role="alert" className="mt-3 border border-red-400/30 bg-red-950/40 p-3 text-sm text-red-100">
          {[...errors, ...(review?.errors ?? [])].map((message) => <div key={message}>{message}</div>)}
        </div>
      )}
      {savedCount > 0 && <div role="status" className="mt-3 text-sm text-emerald-300">Approved {savedCount} catalog changes.</div>}
      {review && (
        <div className="mt-4 grid gap-4">
          <div className="flex flex-wrap gap-2 text-xs text-[color:var(--odos-muted)]">
            <span className="rounded-full border border-[color:var(--odos-line)] px-3 py-1">Base cells {review.report.parsedBaseCells}{review.report.declaredBaseCells === undefined ? "" : ` of ${review.report.declaredBaseCells}`}</span>
            <span className="rounded-full border border-[color:var(--odos-line)] px-3 py-1">Materialized {review.report.materializedRows}{review.report.declaredMaterializedRows === undefined ? "" : ` of ${review.report.declaredMaterializedRows}`}</span>
            <span className="rounded-full border border-[color:var(--odos-line)] px-3 py-1">Unchanged {review.unchangedCount}</span>
            {review.metadata && <span className="rounded-full border border-[color:var(--odos-line)] px-3 py-1">Batch {review.metadata.importBatch}</span>}
          </div>

          {categories.length > 0 && (
            <section className="rounded-xl border border-[color:var(--odos-line)] bg-[color:var(--odos-deep-surface)] p-4">
              <h4 className="text-sm font-semibold text-[color:var(--odos-text)]">Suggested-retail rules</h4>
              <p className="mt-1 text-xs text-[color:var(--odos-muted)]">Defaults use the canonical multiplier and .98 rounding. Rules apply by design category.</p>
              <div className="mt-3 grid gap-2">
                {categories.map((category) => {
                  const rule = retailRules[category] ?? DEFAULT_LENS_RETAIL_RULE;
                  return (
                    <div key={category} className="grid gap-2 sm:grid-cols-[minmax(9rem,1fr)_10rem_8rem_12rem]">
                      <span className="self-center text-xs font-semibold text-[color:var(--odos-muted)]">{category}</span>
                      <select aria-label={`${category} retail strategy`} className="scheduler-input text-xs" value={rule.strategy} onChange={(event) => updateRule(category, {
                        strategy: event.target.value as LensRetailRule["strategy"],
                        value: event.target.value === "multiplier" ? DEFAULT_LENS_RETAIL_RULE.value : 0,
                      })}>
                        <option value="multiplier">Multiplier</option>
                        <option value="flat-adder">Flat adder</option>
                      </select>
                      {rule.strategy === "multiplier" ? (
                        <input aria-label={`${category} retail multiplier`} className="scheduler-input text-xs" type="number" min="0" step="0.1" value={rule.value} onChange={(event) => updateRule(category, { value: Number(event.target.value) })} />
                      ) : (
                        <CurrencyInput ariaLabel={`${category} flat adder`} className="scheduler-input text-xs" value={rule.value} onChange={(value) => updateRule(category, { value: value ?? 0 })} />
                      )}
                      <select aria-label={`${category} retail rounding`} className="scheduler-input text-xs" value={rule.rounding} onChange={(event) => updateRule(category, { rounding: event.target.value as LensRetailRule["rounding"] })}>
                        <option value="dollar-minus-2">Round to .98</option>
                        <option value="nearest-dollar">Nearest dollar</option>
                        <option value="nearest-cent">Nearest cent</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-[color:var(--odos-muted)]"><tr>{["Status", "Product", "Old → new", "Wholesale", "Suggested retail", "Provenance"].map((heading) => <th key={heading} className="px-2 py-2">{heading}</th>)}</tr></thead>
            <tbody className="divide-y divide-white/10">
              {review.rows.map((row, index) => row.classification === "UNPARSED" ? (
                <tr key={`${row.sourceRow}-${index}`}>
                  <td className="px-2 py-3 font-semibold text-red-300">UNPARSED</td>
                  <td className="px-2 py-3 text-[color:var(--odos-muted)]">{row.sourceRow}</td>
                  <td className="px-2 py-3 text-red-200" colSpan={4}>{row.reason}</td>
                </tr>
              ) : (
                <tr key={`${row.classification}-${row.incoming.id}`}>
                  <td className="px-2 py-3 font-semibold text-[#f2d9aa]">{row.classification}</td>
                  <td className="px-2 py-3">
                    <strong className="block text-[color:var(--odos-text)]">{row.incoming.design.productName}</strong>
                    <span className="text-[color:var(--odos-muted)]">{row.incoming.material.name} · {row.incoming.treatment.brand}</span>
                  </td>
                  <td className="max-w-80 px-2 py-3 text-[color:var(--odos-muted)]">{row.changes.join("; ")}{row.retailPreserved && <span className="mt-1 block text-emerald-300">Existing retail preserved</span>}</td>
                  <td className="px-2 py-3 text-[color:var(--odos-muted)]">{money(row.incoming.wholesalePerPairCents)}/pair</td>
                  <td className="px-2 py-3">
                    {row.classification === "DISCONTINUED" ? money(row.incoming.retailPerPairCents) : <>
                      <CurrencyInput
                        ariaLabel={`Retail ${row.incoming.id}`}
                        className="scheduler-input min-w-28 text-xs"
                        value={row.incoming.retailPerPairCents}
                        onChange={(value) => updateRetail(index, value ?? 0)}
                      />
                      {row.classification === "CHANGED" && row.incoming.retailPerPairCents !== row.suggestedRetailPerPairCents && (
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-[color:var(--odos-muted)]">
                          Suggested {money(row.suggestedRetailPerPairCents)}
                          <button type="button" className="text-[#f2d9aa] underline" onClick={() => updateRetail(index, row.suggestedRetailPerPairCents)}>Use</button>
                        </span>
                      )}
                    </>}
                  </td>
                  <td className="max-w-56 px-2 py-3 text-[color:var(--odos-muted)]">{row.incoming.importBatch}<br />{row.incoming.sourceRef}<br />{row.incoming.effectiveDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {review.rows.length === 0 && <div className="p-5 text-center text-sm text-emerald-300">No catalog changes. This file is already applied.</div>}
          <div className="mt-3 flex justify-end">
            <button type="button" className="scheduler-button" disabled={saving || !review.approvable} onClick={() => void approve()}>
              {saving ? "Approving..." : `Approve ${review.rows.filter((row) => row.classification !== "UNPARSED").length} changes`}
            </button>
          </div>
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
      { type: "currency", key: "pricePerPairCents", label: "Price per pair", required: true, min: 0 },
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
      { type: "currency", key: "priceCents", label: "Price", required: true, min: 0 },
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
