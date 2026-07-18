import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import type { CatalogAdapter } from "../src/lib/catalog-adapter";
import {
  LENS_PRODUCT_PASTE_COLUMNS,
  parseLensProductPaste,
} from "../src/lib/lens-bulk-paste";
import {
  BP_DIGITAL_LENS_PRODUCTS,
  COATING_OPTION_SEEDS,
  LEGACY_LENS_PRICING_MIGRATION,
  LENS_DESIGN_TYPES,
  LENS_MATERIAL_SEEDS,
  MODIFIER_OPTION_SEEDS,
  ODOS_WHOLESALE_COST_EXTENSION_URL,
  TREATMENT_FAMILIES,
  assertLensProduct,
  buildCoatingOptionResource,
  buildLensPackageResource,
  buildLensProductResource,
  buildModifierOptionResource,
  evaluateModifierAutoTrigger,
  lensProductItem,
  suggestedRetailPerPairCents,
  validateCoatingHouseDefaults,
  type LensProduct,
} from "../src/lib/lens-catalog";
import {
  BulkPasteGrid,
  LensCatalogSettings,
} from "../src/scenes/settings/LensCatalogSettings";

test("canonical lens axes preserve the locked vocabulary and numeric material indexes", () => {
  assert.deepEqual(LENS_DESIGN_TYPES, [
    "single-vision", "flat-top-28", "flat-top-35", "7x28", "8x35", "round",
    "blended", "double-segment", "aspheric", "progressive", "office-computer",
    "anti-fatigue", "trifocal", "lenticular",
  ]);
  assert.deepEqual(TREATMENT_FAMILIES, [
    "clear", "photochromic", "polarized", "photochromic-polarized", "blue-embedded", "tint-embedded",
  ]);
  assert.ok(LENS_MATERIAL_SEEDS.every((material) => typeof material.index === "number" && Number.isFinite(material.index)));
  assert.deepEqual(
    LENS_MATERIAL_SEEDS.find((material) => material.key === "trivex"),
    { key: "trivex", name: "Trivex", index: 1.53, includedBaseCoating: "premium scratch" },
  );
  assert.deepEqual(
    LENS_MATERIAL_SEEDS.filter((material) => material.name === "Mid-Index").map((material) => material.index),
    [1.55, 1.56],
  );
});

test("BP Digital seeds contain the 30 source-priced matrix rows with cents-safe suggested retail", () => {
  assert.equal(BP_DIGITAL_LENS_PRODUCTS.length, 30);
  assert.equal(new Set(BP_DIGITAL_LENS_PRODUCTS.map((product) => product.id)).size, 30);
  assert.ok(BP_DIGITAL_LENS_PRODUCTS.every((product) => product.unit === "pair"));
  assert.ok(BP_DIGITAL_LENS_PRODUCTS.every((product) => product.sourceRef.startsWith("BP Digital 2025 price list p.")));
  assert.deepEqual(
    BP_DIGITAL_LENS_PRODUCTS.map((product) => product.wholesalePerPairCents),
    [
      7798, 13798, 13898, 11198, 11298, 8298, 14498, 9798, 11298, 16798,
      16898, 15798, 15398, 8798, 14798, 12298, 17898, 9798, 11898, 6398,
      10498, 2698, 8598, 9398, 7298, 7698, 4098, 7998, 1698, 6998,
    ],
  );
  assert.ok(BP_DIGITAL_LENS_PRODUCTS.every((product) =>
    product.retailPerPairCents === suggestedRetailPerPairCents(product.wholesalePerPairCents),
  ));

  const alphaComfort = BP_DIGITAL_LENS_PRODUCTS.find((product) =>
    product.design.productName === "Alpha Comfort"
    && product.material.key === "poly"
    && product.treatment.brand === "Clear",
  );
  assert.equal(alphaComfort?.wholesalePerPairCents, 7798);
  assert.equal(alphaComfort?.retailPerPairCents, 17198);
  assert.equal(suggestedRetailPerPairCents(7798), 17198);
  assert.equal(BP_DIGITAL_LENS_PRODUCTS.some((product) => product.singleLensCents !== undefined), false);
});

test("LensProduct validates required fields and numeric index, while optional Rx envelopes round-trip through FHIR", () => {
  const source = {
    ...structuredClone(BP_DIGITAL_LENS_PRODUCTS[0]!),
    sphMin: -8,
    sphMax: 6,
    cylMin: -4,
    cylMax: 0,
    addMin: 0.75,
    addMax: 3.5,
  };
  const resource = buildLensProductResource(source);
  const roundTrip = lensProductItem(resource);

  assert.deepEqual(
    [roundTrip.sphMin, roundTrip.sphMax, roundTrip.cylMin, roundTrip.cylMax, roundTrip.addMin, roundTrip.addMax],
    [-8, 6, -4, 0, 0.75, 3.5],
  );
  assert.equal(roundTrip.material.index, 1.586);
  assert.equal(resource.extension?.find((extension) => extension.url === ODOS_WHOLESALE_COST_EXTENSION_URL)?.valueMoney?.value, 77.98);
  assert.equal(resource.propertyGroup?.[0]?.priceComponent?.[0]?.amount?.value, 171.98);
  assert.throws(() => assertLensProduct({ ...source, lab: "" }), /lab is required/);
  assert.throws(() => assertLensProduct({ ...source, material: { ...source.material, index: Number.NaN } }), /index must be a numeric value/);
  assert.throws(() => assertLensProduct({ ...source, sphMin: 2, sphMax: -2 }), /Sphere minimum cannot exceed maximum/);
});

test("coating, modifier, and package builders validate their own FHIR resources", () => {
  const coating = buildCoatingOptionResource(COATING_OPTION_SEEDS[0]!);
  const modifier = buildModifierOptionResource(MODIFIER_OPTION_SEEDS[0]!);
  const lensPackage = buildLensPackageResource({
    id: "bp-save-the-sale",
    active: true,
    lab: "bp-digital",
    name: "Save the Sale",
    includesFrame: true,
    basePriceByDesignType: { "single-vision": 9900, progressive: 19900 },
    addOns: [{ label: "Poly", priceCents: 2000, mapsToAxis: { field: "material", value: "poly" } }],
    orderNotation: "STS",
  });

  assert.equal(coating.code?.coding?.[0]?.code, "coating-option");
  assert.equal(modifier.code?.coding?.[0]?.code, "modifier-option");
  assert.match(JSON.stringify(modifier), /rxPrismTotal/);
  assert.equal(lensPackage.code?.coding?.[0]?.code, "lens-package");
  assert.match(JSON.stringify(lensPackage), /STS/);
  assert.throws(() => buildLensPackageResource({
    id: "empty",
    active: true,
    lab: "bp-digital",
    name: "Empty",
    includesFrame: false,
    basePriceByDesignType: {},
    addOns: [],
  }), /at least one base design price/);
});

test("each populated lab has exactly one active house-default coating", () => {
  assert.doesNotThrow(() => validateCoatingHouseDefaults(COATING_OPTION_SEEDS));
  assert.throws(
    () => validateCoatingHouseDefaults(COATING_OPTION_SEEDS.map((option) => ({ ...option, isHouseDefault: false }))),
    /exactly one active house default; found 0/,
  );
  assert.throws(
    () => validateCoatingHouseDefaults([...COATING_OPTION_SEEDS, { ...COATING_OPTION_SEEDS[1]!, id: "second-default", isHouseDefault: true }]),
    /exactly one active house default; found 2/,
  );
});

test("BP prism auto-trigger fires only above 4 delta", () => {
  const prism = MODIFIER_OPTION_SEEDS.find((modifier) => modifier.id === "bp-prism-over-four")!;
  assert.equal(evaluateModifierAutoTrigger(prism.autoTrigger, { rxPrismTotal: 4.01 }), true);
  assert.equal(evaluateModifierAutoTrigger(prism.autoTrigger, { rxPrismTotal: 4 }), false);
  assert.equal(evaluateModifierAutoTrigger(prism.autoTrigger, { rxPrismTotal: 3.99 }), false);
});

test("all four former lens-pricing seeds have an explicit migrated or retired outcome", () => {
  assert.deepEqual(
    LEGACY_LENS_PRICING_MIGRATION.map((entry) => [entry.legacyId, entry.outcome, entry.targetId]),
    [
      ["lens-bifocal-flat-top", "retired", undefined],
      ["lens-progressive-addon", "retired", undefined],
      ["lens-ar-basic", "migrated", "legacy-ar-basic"],
      ["lens-prism-per-diopter", "migrated", "legacy-prism-per-diopter"],
    ],
  );
  assert.equal(COATING_OPTION_SEEDS.find((option) => option.id === "legacy-ar-basic")?.pricePerPairCents, 13830);
  assert.equal(MODIFIER_OPTION_SEEDS.find((option) => option.id === "legacy-prism-per-diopter")?.priceCents, 500);
});

test("bulk paste parses a valid fixed-order row and reports malformed input without throwing", () => {
  const valid = validPasteLine();
  const parsed = parseLensProductPaste(valid, () => "test-id");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.id, "lens-bulk-test-id");
  assert.equal(parsed.rows[0]?.material.index, 1.586);
  assert.equal(parsed.rows[0]?.sphMin, -8);
  assert.equal(parsed.rows[0]?.singleLensCents, undefined);

  assert.doesNotThrow(() => parseLensProductPaste('"unclosed'));
  assert.match(parseLensProductPaste('"unclosed').errors[0] ?? "", /unclosed quoted value/);
  assert.match(parseLensProductPaste("too,few,columns").errors[0] ?? "", /expected 29 columns/);
});

test("bulk-paste preview remains editable and commits every preview row through CatalogAdapter.save", async () => {
  const saved: LensProduct[] = [];
  const adapter = memoryAdapter(saved);
  const renderer = create(<BulkPasteGrid adapter={adapter} />);
  const textarea = renderer.root.findByProps({ "aria-label": "Pasted lens product rows" });

  await act(async () => textarea.props.onChange({ target: { value: validPasteLine() } }));
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Preview rows")?.props.onClick());
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Preview Product" }).length, 1);
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Commit 1 row")?.props.onClick());
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.design.productName, "Alpha Comfort");
});

test("Lens Catalog manager renders the 30 BP rows, required facets, manager-only margin, and option editors", () => {
  const html = renderToStaticMarkup(
    <LensCatalogSettings
      canWrite
      initialProducts={BP_DIGITAL_LENS_PRODUCTS}
      initialCoatings={COATING_OPTION_SEEDS}
      initialModifiers={MODIFIER_OPTION_SEEDS}
      productAdapter={memoryAdapter([])}
    />,
  );

  assert.match(html, /Lens Catalog/);
  assert.match(html, /30 rows/);
  for (const label of ["All labs", "BP Digital", "Cherry Optical", "Type", "Material \/ index", "Treatment", "Coating", "Color"]) {
    assert.match(html, new RegExp(label));
  }
  for (const column of ["Product", "Index", "Unit", "Wholesale", "Retail", "Margin %", "Status", "Source"]) {
    assert.match(html, new RegExp(`>${column}<`));
  }
  assert.match(html, /Alpha Comfort/);
  assert.match(html, /Autograph III/);
  assert.match(html, /Bulk-paste grid/);
  assert.match(html, /Canonical vocabularies/);
  assert.match(html, /Ultra HMC AR/);
  assert.match(html, /Prism over 4Δ/);
});

function validPasteLine(): string {
  const values: Record<(typeof LENS_PRODUCT_PASTE_COLUMNS)[number], string> = {
    lab: "bp-digital",
    designType: "progressive",
    productName: "Alpha Comfort",
    minFitHeight: "14",
    compensatedRx: "true",
    optimization: "balanced",
    onSite: "true",
    priceLevel: "",
    materialKey: "poly",
    materialName: "Poly",
    materialIndex: "1.586",
    includedBaseCoating: "",
    treatmentFamily: "clear",
    treatmentBrand: "Clear",
    color: "",
    wholesalePerPairCents: "7798",
    retailPerPairCents: "17198",
    singleLensCents: "",
    sphMin: "-8",
    sphMax: "6",
    cylMin: "-4",
    cylMax: "0",
    addMin: "0.75",
    addMax: "3.5",
    defaultBillingCodeFamily: "",
    importBatch: "paste-test",
    sourceRef: "BP Digital 2025 price list p.3",
    effectiveDate: "2025",
    active: "true",
  };
  return LENS_PRODUCT_PASTE_COLUMNS.map((column) => values[column]).join("\t");
}

function memoryAdapter(saved: LensProduct[]): CatalogAdapter<LensProduct> {
  return {
    capabilities: { reorder: false, deactivate: true, presetSeed: false },
    list: () => [...saved],
    save(item) {
      saved.push(item);
      return item;
    },
    deactivate(item) {
      return { ...item, active: false };
    },
  };
}
