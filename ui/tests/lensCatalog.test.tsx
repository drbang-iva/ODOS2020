import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import type { CatalogAdapter } from "../src/lib/catalog-adapter";
import {
  DEFAULT_LENS_RETAIL_RULE,
  LENS_PRODUCT_PASTE_COLUMNS,
  approveLensImport,
  buildLensImportReview,
  parseLensProductPaste,
  suggestedRetailForRule,
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

const BP_IMPORT_JSON = readFileSync(new URL("./fixtures/bp-digital-lens-import-v1.json", import.meta.url), "utf8");

test("canonical lens axes preserve the locked vocabulary and numeric material indexes", () => {
  assert.deepEqual(LENS_DESIGN_TYPES, [
    "single-vision", "flat-top-28", "flat-top-35", "7x28", "8x35", "round",
    "blended", "double-segment", "aspheric", "progressive", "office-computer",
    "anti-fatigue", "trifocal", "lenticular", "executive", "stellest", "multifocal", "bifocal",
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

test("v1 matrix materialization reproduces all 30 known-correct BP seed rows exactly", () => {
  const parsed = parseLensProductPaste(BP_IMPORT_JSON);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.unparsed, []);
  assert.deepEqual(parsed.report, {
    parsedBaseCells: 15,
    declaredBaseCells: 15,
    materializedRows: 30,
    declaredMaterializedRows: 30,
  });
  assert.deepEqual(
    [...parsed.rows].sort((left, right) => left.id.localeCompare(right.id)),
    [...BP_DIGITAL_LENS_PRODUCTS].sort((left, right) => left.id.localeCompare(right.id)),
  );
  assert.equal(
    parsed.rows.find((row) => row.id === "bp-alpha-comfort-poly-transitions-gen8")?.wholesalePerPairCents,
    13798,
  );
});

test("retail rules support per-category strategies and rounding without changing the default", () => {
  assert.equal(suggestedRetailForRule(7798), suggestedRetailPerPairCents(7798));
  assert.equal(suggestedRetailForRule(7798, { strategy: "multiplier", value: 2, rounding: "nearest-dollar" }), 15600);
  assert.equal(suggestedRetailForRule(7798, { strategy: "flat-adder", value: 5000, rounding: "nearest-cent" }), 12798);
  assert.equal(suggestedRetailForRule(7798, { strategy: "multiplier", value: 0, rounding: "dollar-minus-2" }), 0);
  assert.deepEqual(DEFAULT_LENS_RETAIL_RULE, { strategy: "multiplier", value: 2.2, rounding: "dollar-minus-2" });
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
  assert.match(parseLensProductPaste("too,few,columns").errors[0] ?? "", /expected 30 columns/);
});

test("materialized rows reject mixed provenance metadata and disable discontinuation metadata", () => {
  for (const column of ["lab", "importBatch", "sourceRef", "effectiveDate"] as const) {
    const second = validPasteLine().split("\t");
    const columnIndex = LENS_PRODUCT_PASTE_COLUMNS.indexOf(column);
    second[columnIndex] = column === "effectiveDate" ? "2026" : `${second[columnIndex]}-different`;
    let id = 0;
    const parsed = parseLensProductPaste(`${validPasteLine()}\n${second.join("\t")}`, () => String(++id));

    assert.match(parsed.errors.join("\n"), /Every materialized row must share lab, importBatch, sourceRef, and effectiveDate/);
    assert.equal(parsed.metadata, undefined);
    assert.equal(buildLensImportReview(parsed, []).approvable, false);
  }
});

test("FHIR dates preserve partial precision and reject impossible calendar values", () => {
  for (const effectiveDate of ["2025", "2026-02", "2024-02-29"]) {
    const document = smallImportDocument();
    document.effectiveDate = effectiveDate;
    assert.deepEqual(parseLensProductPaste(JSON.stringify(document)).errors, []);
  }
  for (const effectiveDate of ["2026-00", "2026-13", "2026-02-29", "2026-04-31", "2026-99-99"]) {
    const document = smallImportDocument();
    document.effectiveDate = effectiveDate;
    assert.match(parseLensProductPaste(JSON.stringify(document)).errors.join("\n"), /effectiveDate must be a FHIR date/);
  }
});

test("validation rejects undeclared units and classifies implausible prices and unknown vocabulary as UNPARSED", () => {
  const barePrice = smallImportDocument();
  barePrice.baseCells[0]!.wholesalePrice = 7798;
  const bareResult = parseLensProductPaste(JSON.stringify(barePrice));
  assert.equal(bareResult.rows.length, 1);
  assert.match(bareResult.unparsed[0]?.reason ?? "", /bare numbers are rejected/);
  assert.equal(buildLensImportReview(bareResult, []).approvable, false);

  const outOfRange = smallImportDocument();
  outOfRange.baseCells[0]!.wholesalePrice = { cents: 900_000, unit: "pair" };
  const rangeResult = parseLensProductPaste(JSON.stringify(outOfRange));
  assert.match(rangeResult.unparsed[0]?.reason ?? "", /through 500000/);

  const unknownMaterial = smallImportDocument();
  unknownMaterial.baseCells[0]!.materialKey = "mystery-plastic";
  const materialResult = parseLensProductPaste(JSON.stringify(unknownMaterial));
  assert.match(materialResult.unparsed[0]?.reason ?? "", /Unknown materialKey/);

  const unknownTreatment = smallImportDocument();
  unknownTreatment.treatmentAdders.push({
    treatmentFamily: "magic",
    treatmentBrand: "Unknown",
    adderPrice: { cents: 1000, unit: "pair" },
    appliesTo: { productNames: ["Alpha Comfort"] },
  });
  unknownTreatment.declaredMaterializedRowCount = 2;
  const treatmentResult = parseLensProductPaste(JSON.stringify(unknownTreatment));
  assert.match(treatmentResult.unparsed[0]?.reason ?? "", /Unknown treatmentFamily/);

  const misspelledSelector = smallImportDocument();
  misspelledSelector.treatmentAdders.push({
    treatmentFamily: "photochromic",
    treatmentBrand: "Transitions GEN8",
    adderPrice: { cents: 6000, unit: "pair" },
    appliesTo: { materialKey: ["poly"] },
  });
  const selectorResult = parseLensProductPaste(JSON.stringify(misspelledSelector));
  assert.match(selectorResult.unparsed[0]?.reason ?? "", /appliesTo contains unknown field: materialKey/);
});

test("review classifies NEW, CHANGED, DISCONTINUED, and UNPARSED with an old-to-new price", () => {
  const document = smallImportDocument();
  document.baseCells[0]!.wholesalePrice = { cents: 7898, unit: "pair" };
  document.treatmentAdders.push({
    treatmentFamily: "unknown",
    treatmentBrand: "Unreadable",
    adderPrice: { cents: 1000, unit: "pair" },
  });
  const existing = [
    BP_DIGITAL_LENS_PRODUCTS.find((row) => row.id === "bp-alpha-comfort-poly-clear")!,
    BP_DIGITAL_LENS_PRODUCTS.find((row) => row.id === "bp-regular-sv-poly-clear")!,
  ];
  const review = buildLensImportReview(parseLensProductPaste(JSON.stringify(document)), existing);

  assert.deepEqual(new Set(review.rows.map((row) => row.classification)), new Set(["NEW", "CHANGED", "DISCONTINUED", "UNPARSED"]));
  const changed = review.rows.find((row) => row.classification === "CHANGED");
  assert.ok(changed && changed.classification === "CHANGED");
  assert.ok(changed.changes.includes("Wholesale $77.98 → $78.98"));
  assert.equal(review.approvable, false);
});

test("matched manual retail survives a changed import and is marked preserved", () => {
  const document = smallImportDocument();
  document.baseCells.splice(1, 1);
  document.declaredBaseCellCount = 1;
  document.declaredMaterializedRowCount = 1;
  document.baseCells[0]!.wholesalePrice = { cents: 7898, unit: "pair" };
  const existing = {
    ...BP_DIGITAL_LENS_PRODUCTS.find((row) => row.id === "bp-alpha-comfort-poly-clear")!,
    retailPerPairCents: 54_321,
    singleLensCents: 27_160,
  };
  const review = buildLensImportReview(parseLensProductPaste(JSON.stringify(document)), [existing]);
  const changed = review.rows.find((row) => row.classification === "CHANGED");

  assert.ok(changed && changed.classification === "CHANGED");
  assert.equal(changed.incoming.retailPerPairCents, 54_321);
  assert.equal(changed.incoming.singleLensCents, 27_160);
  assert.equal(changed.retailPreserved, true);
  assert.equal(changed.suggestedRetailPerPairCents, suggestedRetailPerPairCents(7898));
});

test("stable id collision blocks approval without overwriting manual retail", async () => {
  const document = smallImportDocument();
  document.baseCells.splice(1, 1);
  document.declaredBaseCellCount = 1;
  document.declaredMaterializedRowCount = 1;
  document.baseCells[0]!.productName = "Alpha-Comfort";
  document.baseCells[0]!.wholesalePrice = { cents: 9_998, unit: "pair" };
  const existing = {
    ...structuredClone(BP_DIGITAL_LENS_PRODUCTS.find((row) => row.id === "bp-alpha-comfort-poly-clear")!),
    wholesalePerPairCents: 9_998,
    retailPerPairCents: 54_321,
  };
  const saved = [existing];
  const review = buildLensImportReview(parseLensProductPaste(JSON.stringify(document)), saved);
  const incoming = review.rows.find((row) => row.classification === "NEW");

  assert.ok(incoming && incoming.classification === "NEW");
  assert.equal(incoming.incoming.id, existing.id);
  assert.equal(incoming.incoming.retailPerPairCents, 21_998);
  assert.match(review.errors.join("\n"), /Stable id bp-alpha-comfort-poly-clear/);
  assert.equal(review.approvable, false);
  await assert.rejects(() => approveLensImport(review, memoryAdapter(saved)), /Resolve every import error/);
  assert.equal(saved[0]?.retailPerPairCents, 54_321);
});

test("Approve stamps provenance, deactivates absent rows, and identical re-import is idempotent", async () => {
  const saved: LensProduct[] = [{
    ...structuredClone(BP_DIGITAL_LENS_PRODUCTS[0]!),
    id: "bp-retired-design-poly-clear",
    design: { ...BP_DIGITAL_LENS_PRODUCTS[0]!.design, productName: "Retired Design" },
  }];
  const adapter = memoryAdapter(saved);
  const firstReview = buildLensImportReview(parseLensProductPaste(BP_IMPORT_JSON), saved);
  const committed = await approveLensImport(firstReview, adapter);

  assert.equal(committed.length, 31);
  assert.equal(new Set(saved.map((row) => row.id)).size, 31);
  assert.ok(saved.every((row) => row.importBatch === "bp-digital-2025-a1"));
  assert.ok(saved.every((row) => row.sourceRef.startsWith("BP Digital 2025 price list")));
  assert.ok(saved.every((row) => row.effectiveDate === "2025"));
  assert.equal(saved.find((row) => row.id === "bp-retired-design-poly-clear")?.active, false);

  const secondReview = buildLensImportReview(parseLensProductPaste(BP_IMPORT_JSON), saved);
  assert.equal(secondReview.rows.length, 0);
  assert.equal(secondReview.unchangedCount, 30);
  assert.equal(secondReview.approvable, false);
  assert.equal(saved.length, 31);
});

test("import review does not mutate before Approve and commits the complete reviewed batch", async () => {
  const saved: LensProduct[] = [];
  const adapter = memoryAdapter(saved);
  const renderer = create(<BulkPasteGrid adapter={adapter} existingProducts={[]} />);
  const textarea = renderer.root.findByProps({ "aria-label": "Lens catalog import JSON" });

  await act(async () => textarea.props.onChange({ target: { value: JSON.stringify(smallImportDocument()) } }));
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Review file")?.props.onClick());
  assert.equal(saved.length, 0);
  assert.equal(renderer.root.findAll((node) => node.children.join("") === "NEW").length, 2);
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Approve 2 changes")?.props.onClick());
  assert.equal(saved.length, 2);
});

test("Lens Catalog retail review accepts $425.00 and persists 42500 cents", async () => {
  const saved: LensProduct[] = [];
  const renderer = create(<BulkPasteGrid adapter={memoryAdapter(saved)} existingProducts={[]} />);
  const textarea = renderer.root.findByProps({ "aria-label": "Lens catalog import JSON" });
  await act(async () => textarea.props.onChange({ target: { value: JSON.stringify(smallImportDocument()) } }));
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Review file")?.props.onClick());
  const retail = renderer.root.findAllByType("input").find((input) => String(input.props["aria-label"] ?? "").startsWith("Retail "));
  assert.ok(retail);
  assert.match(retail.props.value, /^\d+\.\d{2}$/);
  act(() => retail.props.onFocus());
  act(() => retail.props.onChange({ target: { value: "425.00" } }));
  act(() => retail.props.onBlur());
  assert.equal(renderer.root.findAllByType("input").find((input) => input.props["aria-label"] === retail.props["aria-label"])?.props.value, "425.00");
  await act(async () => renderer.root.findAllByType("button").find((button) => button.children.join("") === "Approve 2 changes")?.props.onClick());
  assert.equal(saved.some((product) => product.retailPerPairCents === 42_500), true);
  act(() => renderer.unmount());
});

test("Approve validates every edited retail value before the first catalog write", async () => {
  const saved: LensProduct[] = [];
  const review = buildLensImportReview(parseLensProductPaste(JSON.stringify(smallImportDocument())), []);
  const second = review.rows.findLast((row) => row.classification !== "UNPARSED");
  assert.ok(second && second.classification !== "UNPARSED");
  second.incoming.retailPerPairCents = Number.NaN;

  await assert.rejects(() => approveLensImport(review, memoryAdapter(saved)), /Retail price per pair must be a nonnegative whole number of cents/);
  assert.equal(saved.length, 0);
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
  assert.match(html, /Import review/);
  assert.match(html, /Canonical vocabularies/);
  assert.match(html, /Ultra HMC AR/);
  assert.match(html, /Prism over 4Δ/);
});

function smallImportDocument(): {
  schemaVersion: number;
  lab: string;
  importBatch: string;
  sourceRef: string;
  effectiveDate: string;
  declaredBaseCellCount: number;
  declaredMaterializedRowCount: number;
  baseCells: Array<Record<string, unknown>>;
  treatmentAdders: Array<Record<string, unknown>>;
} {
  return {
    schemaVersion: 1,
    lab: "bp-digital",
    importBatch: "bp-digital-review-test",
    sourceRef: "BP Digital review fixture",
    effectiveDate: "2026-07-18",
    declaredBaseCellCount: 2,
    declaredMaterializedRowCount: 2,
    baseCells: [
      {
        designType: "progressive",
        productName: "Alpha Comfort",
        minFitHeight: 14,
        onSite: true,
        materialKey: "poly",
        materialIndex: 1.586,
        wholesalePrice: { cents: 7798, unit: "pair" },
        sourceRef: "BP Digital review fixture p.1",
      },
      {
        designType: "single-vision",
        productName: "New Digital SV",
        materialKey: "poly",
        materialIndex: 1.586,
        wholesalePrice: { cents: 2898, unit: "pair" },
        sourceRef: "BP Digital review fixture p.2",
      },
    ],
    treatmentAdders: [],
  };
}

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
    unit: "pair",
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
      const index = saved.findIndex((candidate) => candidate.id === item.id);
      if (index === -1) saved.push(item);
      else saved[index] = item;
      return item;
    },
    deactivate(item) {
      return { ...item, active: false };
    },
  };
}
