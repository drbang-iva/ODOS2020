import type { Basic, ChargeItemDefinition, Extension } from "@medplum/fhirtypes";
import {
  resourceCatalogAdapter,
  type CatalogAdapter,
} from "./catalog-adapter";
import type { fhir } from "./fhir";
import { ODOS_WHOLESALE_COST_EXTENSION_URL } from "./optical-pricing-catalog";

export { ODOS_WHOLESALE_COST_EXTENSION_URL };

export const LENS_CATALOG_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/lens-catalog";
export const LENS_PRODUCT_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-lens-product";
export const LENS_CATALOG_OPTION_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-lens-catalog-option";
export const LENS_VOCABULARY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-lens-vocabulary";

const ACT_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const PRACTICE_ID = "odos-practice";
const RESOURCE_CAPABILITIES = {
  reorder: false,
  deactivate: true,
  presetSeed: false,
} as const;

export function lensProductChargeItemDefinitionCanonical(productId: string): string {
  return `https://odos2020.com/practice/${PRACTICE_ID}/charge-rules/lens-products/${encodeURIComponent(productId)}`;
}

export const LENS_DESIGN_TYPES = [
  "single-vision",
  "flat-top-28",
  "flat-top-35",
  "7x28",
  "8x35",
  "round",
  "blended",
  "double-segment",
  "aspheric",
  "progressive",
  "office-computer",
  "anti-fatigue",
  "trifocal",
  "lenticular",
] as const;

export type LensDesignType = (typeof LENS_DESIGN_TYPES)[number];

export const TREATMENT_FAMILIES = [
  "clear",
  "photochromic",
  "polarized",
  "photochromic-polarized",
  "blue-embedded",
  "tint-embedded",
] as const;

export type TreatmentFamily = (typeof TREATMENT_FAMILIES)[number];

export type LensMaterial = {
  key: string;
  name: string;
  index: number;
  includedBaseCoating?: string;
};

export const LENS_MATERIAL_SEEDS: readonly LensMaterial[] = [
  { key: "cr-39", name: "CR-39", index: 1.498 },
  { key: "poly", name: "Poly", index: 1.586 },
  { key: "trivex", name: "Trivex", index: 1.53, includedBaseCoating: "premium scratch" },
  { key: "mid-index-1-55", name: "Mid-Index", index: 1.55 },
  { key: "mid-index-1-56", name: "Mid-Index", index: 1.56 },
  { key: "hi-index", name: "Hi-Index", index: 1.6 },
  { key: "deluxe", name: "Deluxe", index: 1.67 },
  { key: "ultra", name: "Ultra", index: 1.74 },
];

export type LensOptimization = "balanced" | "distance" | "near" | "office";
export type LensPriceUnit = "pair";

const RX_FIELDS = ["sph-min", "sph-max", "cyl-min", "cyl-max", "add-min", "add-max"] as const;
type RxExtensionField = (typeof RX_FIELDS)[number];
type RxFieldKey = "sphMin" | "sphMax" | "cylMin" | "cylMax" | "addMin" | "addMax";

export type LensProduct = {
  id: string;
  active: boolean;
  lab: string;
  importBatch: string;
  sourceRef: string;
  effectiveDate: string;
  design: {
    type: LensDesignType;
    productName: string;
    minFitHeight?: number;
    compensatedRx?: boolean;
    optimization?: LensOptimization;
    onSite?: boolean;
    priceLevel?: string;
  };
  material: LensMaterial;
  treatment: {
    family: TreatmentFamily;
    brand: string;
    color?: string;
  };
  unit: LensPriceUnit;
  wholesalePerPairCents: number;
  retailPerPairCents: number;
  singleLensCents?: number;
  sphMin?: number;
  sphMax?: number;
  cylMin?: number;
  cylMax?: number;
  addMin?: number;
  addMax?: number;
  defaultBillingCodeFamily?: string;
  resource?: ChargeItemDefinition;
};

export type CoatingCategory = "AR" | "scratch" | "mirror" | "tint" | "uv";

export type CoatingOption = {
  id: string;
  active: boolean;
  lab: string;
  category: CoatingCategory;
  name: string;
  pricePerPairCents: number;
  uvProtection?: boolean;
  hydrophobic?: boolean;
  hevProtection?: boolean;
  warrantyYears?: number;
  isHouseDefault?: boolean;
  resource?: Basic;
};

export type ModifierUnit = "pair" | "perDiopter" | "perItem";
export type AutoTriggerField = "rxPrismTotal" | "frameMounting";
export type AutoTriggerOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export type ModifierOption = {
  id: string;
  active: boolean;
  lab: string;
  name: string;
  priceCents: number;
  unit: ModifierUnit;
  autoTrigger?: {
    field: AutoTriggerField;
    operator: AutoTriggerOperator;
    value: number | string;
  };
  resource?: Basic;
};

export type LensPackage = {
  id: string;
  active: boolean;
  lab: string;
  name: string;
  includesFrame: boolean;
  basePriceByDesignType: Record<string, number>;
  addOns: Array<{
    label: string;
    priceCents: number;
    mapsToAxis?: { field: "material" | "treatment"; value: string };
  }>;
  orderNotation?: string;
  resource?: Basic;
};

export type LensVocabularyKind = "design-type" | "material" | "treatment-family";

export type LensVocabularyItem = {
  id: string;
  active: boolean;
  kind: LensVocabularyKind;
  key: string;
  name: string;
  index?: number;
  includedBaseCoating?: string;
  resource?: Basic;
};

export type LegacyLensPricingMigration = {
  legacyId: string;
  legacyLabel: string;
  legacyRetailCents: number;
  outcome: "migrated" | "retired";
  targetId?: string;
  reason: string;
};

export const LEGACY_LENS_PRICING_MIGRATION: readonly LegacyLensPricingMigration[] = [
  {
    legacyId: "lens-bifocal-flat-top",
    legacyLabel: "Bifocal (flat top)",
    legacyRetailCents: 6250,
    outcome: "retired",
    reason: "A flat additive design price cannot represent a design-material-treatment matrix cell.",
  },
  {
    legacyId: "lens-progressive-addon",
    legacyLabel: "Progressive add-on",
    legacyRetailCents: 8200,
    outcome: "retired",
    reason: "A flat additive design price cannot represent a design-material-treatment matrix cell.",
  },
  {
    legacyId: "lens-ar-basic",
    legacyLabel: "AR basic",
    legacyRetailCents: 6915,
    outcome: "migrated",
    targetId: "legacy-ar-basic",
    reason: "The former per-lens retail value is preserved as a $138.30 per-pair coating option.",
  },
  {
    legacyId: "lens-prism-per-diopter",
    legacyLabel: "Prism (per diopter)",
    legacyRetailCents: 500,
    outcome: "migrated",
    targetId: "legacy-prism-per-diopter",
    reason: "The per-diopter value is preserved as a lab-distinct modifier option.",
  },
];

export const BP_DIGITAL_LENS_PRODUCTS: readonly LensProduct[] = [
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "poly", "clear", "Clear", 7798, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "poly", "photochromic", "Transitions GEN8", 13798, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "poly", "photochromic", "XTRActive", 13898, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "poly", "photochromic", "Neochrome", 11198, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "poly", "polarized", "Polarized", 11298, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "trivex", "clear", "Clear", 8298, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "trivex", "photochromic", "Transitions GEN8", 14498, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "hi-index", "clear", "Clear", 9798, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "deluxe", "clear", "Clear", 11298, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "deluxe", "photochromic", "Transitions GEN8", 16798, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "deluxe", "photochromic", "XTRActive", 16898, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "deluxe", "photochromic", "Neochrome", 15798, undefined),
  seedProduct("alpha-comfort", "progressive", "Alpha Comfort", 14, true, "deluxe", "polarized", "Polarized", 15398, undefined),
  seedProduct("alpha-luxury", "progressive", "Alpha Luxury", 14, undefined, "poly", "clear", "Clear", 8798, undefined),
  seedProduct("alpha-luxury", "progressive", "Alpha Luxury", 14, undefined, "poly", "photochromic", "Transitions GEN8", 14798, undefined),
  seedProduct("alpha-luxury", "progressive", "Alpha Luxury", 14, undefined, "deluxe", "clear", "Clear", 12298, undefined),
  seedProduct("alpha-luxury", "progressive", "Alpha Luxury", 14, undefined, "deluxe", "photochromic", "XTRActive", 17898, undefined),
  seedProduct("autograph-iii", "progressive", "Autograph III", 11, undefined, "poly", "clear", "Clear", 9798, undefined),
  seedProduct("autograph-iii", "progressive", "Autograph III", 11, undefined, "deluxe", "clear", "Clear", 11898, undefined),
  seedProduct("omnilux-custom", "progressive", "Omnilux Custom", 19, undefined, "poly", "clear", "Clear", 6398, undefined),
  seedProduct("omnilux-custom", "progressive", "Omnilux Custom", 19, undefined, "deluxe", "clear", "Clear", 10498, undefined),
  seedProduct("bp-digital-sv", "single-vision", "BP Digital SV", undefined, true, "poly", "clear", "Clear", 2698, "V21"),
  seedProduct("bp-digital-sv", "single-vision", "BP Digital SV", undefined, true, "poly", "photochromic", "Transitions GEN8", 8598, "V21"),
  seedProduct("bp-digital-sv", "single-vision", "BP Digital SV", undefined, true, "poly", "photochromic", "XTRActive", 9398, "V21"),
  seedProduct("bp-digital-sv", "single-vision", "BP Digital SV", undefined, true, "poly", "photochromic", "Neochrome", 7298, "V21"),
  seedProduct("bp-digital-sv", "single-vision", "BP Digital SV", undefined, true, "poly", "polarized", "Polarized", 7698, "V21"),
  seedProduct("bp-digital-sv", "single-vision", "BP Digital SV", undefined, true, "trivex", "clear", "Clear", 4098, "V21"),
  seedProduct("bp-digital-sv", "single-vision", "BP Digital SV", undefined, true, "deluxe", "clear", "Clear", 7998, "V21"),
  seedProduct("regular-sv", "single-vision", "Regular SV", undefined, undefined, "poly", "clear", "Clear", 1698, "V21"),
  seedProduct("regular-sv", "single-vision", "Regular SV", undefined, undefined, "deluxe", "clear", "Clear", 6998, "V21"),
];

export const COATING_OPTION_SEEDS: readonly CoatingOption[] = [
  {
    id: "bp-ultra-hmc-ar",
    active: true,
    lab: "bp-digital",
    category: "AR",
    name: "Ultra HMC AR",
    pricePerPairCents: 3198,
    isHouseDefault: true,
  },
  {
    id: "bp-blue-protect-ar",
    active: true,
    lab: "bp-digital",
    category: "AR",
    name: "BP Blue Protect AR",
    pricePerPairCents: 5198,
    uvProtection: true,
    hydrophobic: true,
    hevProtection: true,
  },
  {
    id: "bp-glacier-plus-uv-ar",
    active: true,
    lab: "bp-digital",
    category: "AR",
    name: "Glacier Plus UV AR",
    pricePerPairCents: 5998,
    uvProtection: true,
    hydrophobic: true,
  },
  {
    id: "legacy-ar-basic",
    active: true,
    lab: "legacy-unassigned",
    category: "AR",
    name: "AR basic (legacy)",
    pricePerPairCents: 13830,
    isHouseDefault: true,
  },
];

export const MODIFIER_OPTION_SEEDS: readonly ModifierOption[] = [
  {
    id: "bp-prism-over-four",
    active: true,
    lab: "bp-digital",
    name: "Prism over 4Δ (per diopter)",
    priceCents: 298,
    unit: "perDiopter",
    autoTrigger: { field: "rxPrismTotal", operator: "gt", value: 4 },
  },
  {
    id: "bp-base-edging-fee",
    active: true,
    lab: "bp-digital",
    name: "Base edging fee",
    priceCents: 798,
    unit: "pair",
  },
  {
    id: "legacy-prism-per-diopter",
    active: true,
    lab: "legacy-unassigned",
    name: "Prism per diopter (legacy)",
    priceCents: 500,
    unit: "perDiopter",
  },
];

export const LENS_VOCABULARY_SEEDS: readonly LensVocabularyItem[] = [
  ...LENS_DESIGN_TYPES.map((key) => ({
    id: `design-${key}`,
    active: true,
    kind: "design-type" as const,
    key,
    name: designTypeLabel(key),
  })),
  ...LENS_MATERIAL_SEEDS.map((material) => ({
    id: `material-${material.key}`,
    active: true,
    kind: "material" as const,
    ...material,
  })),
  ...TREATMENT_FAMILIES.map((key) => ({
    id: `treatment-${key}`,
    active: true,
    kind: "treatment-family" as const,
    key,
    name: titleCase(key),
  })),
];

type LensCatalogClient = Pick<typeof fhir, "search" | "searchUrl" | "create" | "update">;

export function lensProductAdapter(client: LensCatalogClient): CatalogAdapter<LensProduct> {
  const base = resourceCatalogAdapter<LensProduct, ChargeItemDefinition>({
    resourceType: "ChargeItemDefinition",
    searchParams: { _count: "100" },
    client,
    sourceTag: "lens-product-catalog",
    capabilities: RESOURCE_CAPABILITIES,
    includeResource: (resource) => hasCatalogCode(resource, "lens-product"),
    toItem: lensProductItem,
    buildResource: buildLensProductResource,
    deactivateResource: (item) => buildLensProductResource({ ...item, active: false }),
  });
  return withChargeItemSeeds(base, BP_DIGITAL_LENS_PRODUCTS);
}

export function coatingOptionAdapter(client: LensCatalogClient): CatalogAdapter<CoatingOption> {
  const seeded = withBasicSeeds(
    basicOptionAdapter(client, "coating-option", assertCoatingOption, coatingOptionItem),
    COATING_OPTION_SEEDS,
  );
  return {
    ...seeded,
    async list() {
      const rows = await seeded.list();
      validateCoatingHouseDefaults(rows);
      return rows;
    },
    async save(item) {
      const rows = await seeded.list();
      validateCoatingHouseDefaults(replaceById(rows, assertCoatingOption(item)));
      return seeded.save(item);
    },
    async deactivate(item) {
      const rows = await seeded.list();
      validateCoatingHouseDefaults(replaceById(rows, { ...item, active: false }));
      return seeded.deactivate(item);
    },
  };
}

export function modifierOptionAdapter(client: LensCatalogClient): CatalogAdapter<ModifierOption> {
  return withBasicSeeds(
    basicOptionAdapter(client, "modifier-option", assertModifierOption, modifierOptionItem),
    MODIFIER_OPTION_SEEDS,
  );
}

export function lensPackageAdapter(client: LensCatalogClient): CatalogAdapter<LensPackage> {
  return basicOptionAdapter(client, "lens-package", assertLensPackage, lensPackageItem);
}

export function lensVocabularyAdapter(
  client: LensCatalogClient,
  kind: LensVocabularyKind,
): CatalogAdapter<LensVocabularyItem> {
  const base = resourceCatalogAdapter<LensVocabularyItem, Basic>({
    resourceType: "Basic",
    searchParams: { code: `${LENS_CATALOG_CODE_SYSTEM}|lens-vocabulary` },
    client,
    sourceTag: "lens-vocabulary",
    capabilities: RESOURCE_CAPABILITIES,
    includeResource: (resource) => lensVocabularyItem(resource).kind === kind,
    toItem: lensVocabularyItem,
    buildResource: buildLensVocabularyResource,
    deactivateResource: (item) => buildLensVocabularyResource({ ...item, active: false }),
  });
  return withBasicSeeds(base, LENS_VOCABULARY_SEEDS.filter((item) => item.kind === kind));
}

export function buildLensProductResource(input: LensProduct): ChargeItemDefinition {
  const item = assertLensProduct(input);
  const original = item.resource;
  const rxEnvelope = RX_FIELDS.flatMap((field) => decimalChild(field, item[rxFieldKey(field)]));
  return {
    ...original,
    resourceType: "ChargeItemDefinition",
    url: original?.url ?? lensProductChargeItemDefinitionCanonical(item.id),
    version: original?.version ?? "1",
    status: item.active ? "active" : "retired",
    title: item.design.productName,
    description: "Wholesale and retail prices are per pair.",
    code: {
      coding: [{
        system: LENS_CATALOG_CODE_SYSTEM,
        code: "lens-product",
        display: item.design.productName,
      }],
      text: item.design.productName,
    },
    extension: [
      {
        url: LENS_PRODUCT_EXTENSION_URL,
        extension: [
          { url: "lab", valueString: item.lab },
          { url: "import-batch", valueString: item.importBatch },
          { url: "source-ref", valueString: item.sourceRef },
          { url: "effective-date", valueDate: item.effectiveDate },
          { url: "unit", valueCode: item.unit },
          structured("design", [
            { url: "type", valueCode: item.design.type },
            { url: "product-name", valueString: item.design.productName },
            ...decimalChild("min-fit-height", item.design.minFitHeight),
            ...booleanChild("compensated-rx", item.design.compensatedRx),
            ...codeChild("optimization", item.design.optimization),
            ...booleanChild("on-site", item.design.onSite),
            ...stringChild("price-level", item.design.priceLevel),
          ]),
          structured("material", [
            { url: "key", valueCode: item.material.key },
            { url: "name", valueString: item.material.name },
            { url: "index", valueDecimal: item.material.index },
            ...stringChild("included-base-coating", item.material.includedBaseCoating),
          ]),
          structured("treatment", [
            { url: "family", valueCode: item.treatment.family },
            { url: "brand", valueString: item.treatment.brand },
            ...stringChild("color", item.treatment.color),
          ]),
          ...(rxEnvelope.length > 0 ? [structured("rx-envelope", rxEnvelope)] : []),
          ...moneyChild("single-lens-price", item.singleLensCents),
          ...stringChild("default-billing-code-family", item.defaultBillingCodeFamily),
        ],
      },
      {
        url: ODOS_WHOLESALE_COST_EXTENSION_URL,
        valueMoney: { value: item.wholesalePerPairCents / 100, currency: "USD" },
      },
      ...(original?.extension ?? []).filter(
        (extension) => extension.url !== LENS_PRODUCT_EXTENSION_URL
          && extension.url !== ODOS_WHOLESALE_COST_EXTENSION_URL,
      ),
    ],
    propertyGroup: [{
      priceComponent: [{
        type: "base",
        code: { coding: [{ system: ACT_CODE_SYSTEM, code: "CHRG" }] },
        amount: { value: item.retailPerPairCents / 100, currency: "USD" },
      }],
    }],
  };
}

export function lensProductItem(resource: ChargeItemDefinition): LensProduct {
  if (!hasCatalogCode(resource, "lens-product")) {
    throw new Error("ChargeItemDefinition is not an ODOS lens product.");
  }
  const root = requiredExtension(resource.extension, LENS_PRODUCT_EXTENSION_URL, "Lens product");
  const design = requiredChild(root, "design", "Lens product design");
  const material = requiredChild(root, "material", "Lens product material");
  const treatment = requiredChild(root, "treatment", "Lens product treatment");
  const rx = child(root, "rx-envelope");
  const wholesale = resource.extension?.find(
    (extension) => extension.url === ODOS_WHOLESALE_COST_EXTENSION_URL,
  )?.valueMoney;
  if (wholesale?.currency !== "USD" || typeof wholesale.value !== "number") {
    throw new Error("Lens product wholesale price must be USD Money.");
  }
  const retail = resource.propertyGroup?.flatMap((group) => group.priceComponent ?? [])
    .find((component) => component.type === "base")?.amount;
  if (retail?.currency !== "USD" || typeof retail.value !== "number") {
    throw new Error("Lens product retail price must be USD Money.");
  }
  return assertLensProduct({
    id: canonicalTail(resource.url) || resource.id || "",
    active: resource.status === "active",
    lab: childString(root, "lab"),
    importBatch: childString(root, "import-batch"),
    sourceRef: childString(root, "source-ref"),
    effectiveDate: childValue(root, "effective-date")?.valueDate ?? "",
    design: {
      type: childCode(design, "type") as LensDesignType,
      productName: childString(design, "product-name"),
      ...optionalNumber("minFitHeight", childDecimal(design, "min-fit-height")),
      ...optionalBoolean("compensatedRx", childBoolean(design, "compensated-rx")),
      ...optionalString("optimization", childOptionalCode(design, "optimization") as LensOptimization | undefined),
      ...optionalBoolean("onSite", childBoolean(design, "on-site")),
      ...optionalString("priceLevel", childOptionalString(design, "price-level")),
    },
    material: {
      key: childCode(material, "key"),
      name: childString(material, "name"),
      index: childDecimal(material, "index") ?? Number.NaN,
      ...optionalString("includedBaseCoating", childOptionalString(material, "included-base-coating")),
    },
    treatment: {
      family: childCode(treatment, "family") as TreatmentFamily,
      brand: childString(treatment, "brand"),
      ...optionalString("color", childOptionalString(treatment, "color")),
    },
    unit: childCode(root, "unit") as LensPriceUnit,
    wholesalePerPairCents: moneyToCents(wholesale.value, "Lens product wholesale price"),
    retailPerPairCents: moneyToCents(retail.value, "Lens product retail price"),
    ...optionalNumber("singleLensCents", childMoneyCents(root, "single-lens-price")),
    ...Object.fromEntries(RX_FIELDS.flatMap((field) => {
      const value = rx ? childDecimal(rx, field) : undefined;
      return value === undefined ? [] : [[rxFieldKey(field), value]];
    })),
    ...optionalString("defaultBillingCodeFamily", childOptionalString(root, "default-billing-code-family")),
    resource,
  } as LensProduct);
}

export function buildCoatingOptionResource(item: CoatingOption): Basic {
  return buildBasicOption("coating-option", assertCoatingOption(item), [
    { url: "lab", valueString: item.lab },
    { url: "category", valueCode: item.category },
    { url: "name", valueString: item.name },
    ...moneyChild("price", item.pricePerPairCents),
    ...booleanChild("uv-protection", item.uvProtection),
    ...booleanChild("hydrophobic", item.hydrophobic),
    ...booleanChild("hev-protection", item.hevProtection),
    ...decimalChild("warranty-years", item.warrantyYears),
    ...booleanChild("house-default", item.isHouseDefault),
  ]);
}

export function buildModifierOptionResource(item: ModifierOption): Basic {
  const validated = assertModifierOption(item);
  return buildBasicOption("modifier-option", validated, [
    { url: "lab", valueString: validated.lab },
    { url: "name", valueString: validated.name },
    ...moneyChild("price", validated.priceCents),
    { url: "unit", valueCode: validated.unit },
    ...(validated.autoTrigger
      ? [structured("auto-trigger", [
          { url: "field", valueCode: validated.autoTrigger.field },
          { url: "operator", valueCode: validated.autoTrigger.operator },
          ...(typeof validated.autoTrigger.value === "number"
            ? [{ url: "value", valueDecimal: validated.autoTrigger.value }]
            : [{ url: "value", valueString: validated.autoTrigger.value }]),
        ])]
      : []),
  ]);
}

export function buildLensPackageResource(item: LensPackage): Basic {
  const validated = assertLensPackage(item);
  return buildBasicOption("lens-package", validated, [
    { url: "lab", valueString: validated.lab },
    { url: "name", valueString: validated.name },
    { url: "includes-frame", valueBoolean: validated.includesFrame },
    ...Object.entries(validated.basePriceByDesignType).map(([type, cents]) =>
      structured("base-price", [
        { url: "design-type", valueCode: type },
        { url: "price", valueMoney: { value: cents / 100, currency: "USD" } },
      ])),
    ...validated.addOns.map((addOn) => structured("add-on", [
      { url: "label", valueString: addOn.label },
      { url: "price", valueMoney: { value: addOn.priceCents / 100, currency: "USD" } },
      ...(addOn.mapsToAxis
        ? [structured("maps-to-axis", [
            { url: "field", valueCode: addOn.mapsToAxis.field },
            { url: "value", valueString: addOn.mapsToAxis.value },
          ])]
        : []),
    ])),
    ...stringChild("order-notation", validated.orderNotation),
  ]);
}

export function buildLensVocabularyResource(item: LensVocabularyItem): Basic {
  const validated = assertLensVocabularyItem(item);
  return buildBasicResource("lens-vocabulary", validated, [{
    url: LENS_VOCABULARY_EXTENSION_URL,
    extension: [
      { url: "active", valueBoolean: validated.active },
      { url: "kind", valueCode: validated.kind },
      { url: "key", valueCode: validated.key },
      { url: "name", valueString: validated.name },
      ...decimalChild("index", validated.index),
      ...stringChild("included-base-coating", validated.includedBaseCoating),
    ],
  }]);
}

export function validateCoatingHouseDefaults(options: readonly CoatingOption[]): void {
  const activeByLab = new Map<string, CoatingOption[]>();
  for (const option of options.filter((candidate) => candidate.active)) {
    const rows = activeByLab.get(option.lab) ?? [];
    rows.push(option);
    activeByLab.set(option.lab, rows);
  }
  for (const [lab, rows] of activeByLab) {
    const defaults = rows.filter((row) => row.isHouseDefault);
    if (defaults.length !== 1) {
      throw new Error(`Coating options for ${lab} must have exactly one active house default; found ${defaults.length}.`);
    }
  }
}

export function evaluateModifierAutoTrigger(
  trigger: ModifierOption["autoTrigger"],
  context: Partial<Record<AutoTriggerField, number | string>>,
): boolean {
  if (!trigger) return false;
  const actual = context[trigger.field];
  if (actual === undefined) return false;
  switch (trigger.operator) {
    case "gt": return typeof actual === "number" && typeof trigger.value === "number" && actual > trigger.value;
    case "gte": return typeof actual === "number" && typeof trigger.value === "number" && actual >= trigger.value;
    case "lt": return typeof actual === "number" && typeof trigger.value === "number" && actual < trigger.value;
    case "lte": return typeof actual === "number" && typeof trigger.value === "number" && actual <= trigger.value;
    case "eq": return actual === trigger.value;
    case "neq": return actual !== trigger.value;
  }
}

export function suggestedRetailPerPairCents(wholesalePerPairCents: number): number {
  assertCents(wholesalePerPairCents, "Wholesale price per pair");
  return Math.round((wholesalePerPairCents * 22) / 1000) * 100 - 2;
}

export function assertLensProduct(item: LensProduct): LensProduct {
  if (!item.id.trim()) throw new Error("Lens product id is required.");
  if (!item.lab.trim()) throw new Error("Lens product lab is required.");
  if (!item.importBatch.trim()) throw new Error("Lens product import batch is required.");
  if (!item.sourceRef.trim()) throw new Error("Lens product source reference is required.");
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(item.effectiveDate)) {
    throw new Error("Lens product effective date must be a FHIR date.");
  }
  if (!LENS_DESIGN_TYPES.includes(item.design.type)) throw new Error("Lens product design type is invalid.");
  if (!item.design.productName.trim()) throw new Error("Lens product name is required.");
  if (item.design.minFitHeight !== undefined) assertFinite(item.design.minFitHeight, "Minimum fit height");
  if (!item.material.key.trim() || !item.material.name.trim()) throw new Error("Lens product material is required.");
  if (!Number.isFinite(item.material.index) || item.material.index <= 1) {
    throw new Error("Lens material index must be a numeric value greater than 1.");
  }
  if (!TREATMENT_FAMILIES.includes(item.treatment.family)) throw new Error("Lens treatment family is invalid.");
  if (!item.treatment.brand.trim()) throw new Error("Lens treatment brand is required.");
  if (item.unit !== "pair") throw new Error("Lens product price unit must be pair.");
  assertCents(item.wholesalePerPairCents, "Wholesale price per pair");
  assertCents(item.retailPerPairCents, "Retail price per pair");
  if (item.singleLensCents !== undefined) assertCents(item.singleLensCents, "Single-lens price");
  for (const field of RX_FIELDS) {
    const value = item[rxFieldKey(field)];
    if (value !== undefined) assertFinite(value, field);
  }
  assertRange(item.sphMin, item.sphMax, "Sphere");
  assertRange(item.cylMin, item.cylMax, "Cylinder");
  assertRange(item.addMin, item.addMax, "Add");
  return item;
}

function basicOptionAdapter<Item extends CoatingOption | ModifierOption | LensPackage>(
  client: LensCatalogClient,
  code: "coating-option" | "modifier-option" | "lens-package",
  validate: (item: Item) => Item,
  toItem: (resource: Basic) => Item,
): CatalogAdapter<Item> {
  return resourceCatalogAdapter<Item, Basic>({
    resourceType: "Basic",
    searchParams: { code: `${LENS_CATALOG_CODE_SYSTEM}|${code}` },
    client,
    sourceTag: code,
    capabilities: RESOURCE_CAPABILITIES,
    toItem,
    buildResource: (item) => {
      validate(item);
      if (code === "coating-option") return buildCoatingOptionResource(item as CoatingOption);
      if (code === "modifier-option") return buildModifierOptionResource(item as ModifierOption);
      return buildLensPackageResource(item as LensPackage);
    },
    deactivateResource: (item) => {
      const inactive = { ...item, active: false } as Item;
      if (code === "coating-option") return buildCoatingOptionResource(inactive as CoatingOption);
      if (code === "modifier-option") return buildModifierOptionResource(inactive as ModifierOption);
      return buildLensPackageResource(inactive as LensPackage);
    },
  });
}

function coatingOptionItem(resource: Basic): CoatingOption {
  const root = basicOptionRoot(resource, "coating-option");
  return assertCoatingOption({
    id: basicStableId(resource),
    active: childBoolean(root, "active") ?? false,
    lab: childString(root, "lab"),
    category: childCode(root, "category") as CoatingCategory,
    name: childString(root, "name"),
    pricePerPairCents: requiredChildMoneyCents(root, "price"),
    ...optionalBoolean("uvProtection", childBoolean(root, "uv-protection")),
    ...optionalBoolean("hydrophobic", childBoolean(root, "hydrophobic")),
    ...optionalBoolean("hevProtection", childBoolean(root, "hev-protection")),
    ...optionalNumber("warrantyYears", childDecimal(root, "warranty-years")),
    ...optionalBoolean("isHouseDefault", childBoolean(root, "house-default")),
    resource,
  });
}

function modifierOptionItem(resource: Basic): ModifierOption {
  const root = basicOptionRoot(resource, "modifier-option");
  const trigger = child(root, "auto-trigger");
  const triggerValue = trigger ? childValue(trigger, "value") : undefined;
  return assertModifierOption({
    id: basicStableId(resource),
    active: childBoolean(root, "active") ?? false,
    lab: childString(root, "lab"),
    name: childString(root, "name"),
    priceCents: requiredChildMoneyCents(root, "price"),
    unit: childCode(root, "unit") as ModifierUnit,
    ...(trigger
      ? { autoTrigger: {
          field: childCode(trigger, "field") as AutoTriggerField,
          operator: childCode(trigger, "operator") as AutoTriggerOperator,
          value: triggerValue?.valueDecimal ?? triggerValue?.valueString ?? "",
        } }
      : {}),
    resource,
  });
}

function lensPackageItem(resource: Basic): LensPackage {
  const root = basicOptionRoot(resource, "lens-package");
  const basePriceByDesignType = Object.fromEntries(
    children(root, "base-price").map((entry) => [
      childCode(entry, "design-type"),
      requiredChildMoneyCents(entry, "price"),
    ]),
  );
  const addOns = children(root, "add-on").map((entry) => {
    const axis = child(entry, "maps-to-axis");
    return {
      label: childString(entry, "label"),
      priceCents: requiredChildMoneyCents(entry, "price"),
      ...(axis ? { mapsToAxis: {
        field: childCode(axis, "field") as "material" | "treatment",
        value: childString(axis, "value"),
      } } : {}),
    };
  });
  return assertLensPackage({
    id: basicStableId(resource),
    active: childBoolean(root, "active") ?? false,
    lab: childString(root, "lab"),
    name: childString(root, "name"),
    includesFrame: childBoolean(root, "includes-frame") ?? false,
    basePriceByDesignType,
    addOns,
    ...optionalString("orderNotation", childOptionalString(root, "order-notation")),
    resource,
  });
}

function lensVocabularyItem(resource: Basic): LensVocabularyItem {
  if (!hasBasicCode(resource, "lens-vocabulary")) {
    throw new Error("Basic resource is not an ODOS lens vocabulary item.");
  }
  const root = requiredExtension(resource.extension, LENS_VOCABULARY_EXTENSION_URL, "Lens vocabulary");
  return assertLensVocabularyItem({
    id: basicStableId(resource),
    active: childBoolean(root, "active") ?? false,
    kind: childCode(root, "kind") as LensVocabularyKind,
    key: childCode(root, "key"),
    name: childString(root, "name"),
    ...optionalNumber("index", childDecimal(root, "index")),
    ...optionalString("includedBaseCoating", childOptionalString(root, "included-base-coating")),
    resource,
  });
}

function buildBasicOption(
  code: "coating-option" | "modifier-option" | "lens-package",
  item: CoatingOption | ModifierOption | LensPackage,
  fields: Extension[],
): Basic {
  return buildBasicResource(code, item, [{
    url: LENS_CATALOG_OPTION_EXTENSION_URL,
    extension: [{ url: "active", valueBoolean: item.active }, ...fields],
  }]);
}

function buildBasicResource(
  code: "coating-option" | "modifier-option" | "lens-package" | "lens-vocabulary",
  item: { id: string; resource?: Basic },
  extension: Extension[],
): Basic {
  return {
    resourceType: "Basic",
    ...(item.resource?.id ? { id: item.resource.id } : {}),
    ...(item.resource?.meta ? { meta: item.resource.meta } : {}),
    identifier: [{
      system: `https://odos2020.com/fhir/NamingSystem/${code}-key`,
      value: item.id,
    }],
    code: { coding: [{ system: LENS_CATALOG_CODE_SYSTEM, code }] },
    extension,
  };
}

function basicOptionRoot(resource: Basic, code: "coating-option" | "modifier-option" | "lens-package"): Extension {
  if (!hasBasicCode(resource, code)) throw new Error(`Basic resource is not an ODOS ${code}.`);
  return requiredExtension(resource.extension, LENS_CATALOG_OPTION_EXTENSION_URL, code);
}

function assertCoatingOption(item: CoatingOption): CoatingOption {
  assertBasicIdentity(item, "Coating option");
  if (!(["AR", "scratch", "mirror", "tint", "uv"] as const).includes(item.category)) {
    throw new Error("Coating category is invalid.");
  }
  assertCents(item.pricePerPairCents, "Coating price per pair");
  if (item.warrantyYears !== undefined && (!Number.isFinite(item.warrantyYears) || item.warrantyYears < 0)) {
    throw new Error("Coating warranty years must be nonnegative.");
  }
  return item;
}

function assertModifierOption(item: ModifierOption): ModifierOption {
  assertBasicIdentity(item, "Modifier option");
  assertCents(item.priceCents, "Modifier price");
  if (!(["pair", "perDiopter", "perItem"] as const).includes(item.unit)) {
    throw new Error("Modifier unit is invalid.");
  }
  if (item.autoTrigger) {
    if (!(["rxPrismTotal", "frameMounting"] as const).includes(item.autoTrigger.field)) {
      throw new Error("Modifier auto-trigger field is invalid.");
    }
    if (!(["gt", "gte", "lt", "lte", "eq", "neq"] as const).includes(item.autoTrigger.operator)) {
      throw new Error("Modifier auto-trigger operator is invalid.");
    }
    if (typeof item.autoTrigger.value !== "number" && typeof item.autoTrigger.value !== "string") {
      throw new Error("Modifier auto-trigger value must be a number or string.");
    }
  }
  return item;
}

function assertLensPackage(item: LensPackage): LensPackage {
  assertBasicIdentity(item, "Lens package");
  if (Object.keys(item.basePriceByDesignType).length === 0) {
    throw new Error("Lens package needs at least one base design price.");
  }
  for (const [type, cents] of Object.entries(item.basePriceByDesignType)) {
    if (!type.trim()) throw new Error("Lens package design type is required.");
    assertCents(cents, `Lens package ${type} base price`);
  }
  for (const addOn of item.addOns) {
    if (!addOn.label.trim()) throw new Error("Lens package add-on label is required.");
    assertCents(addOn.priceCents, `Lens package ${addOn.label} price`);
    if (addOn.mapsToAxis && !(["material", "treatment"] as const).includes(addOn.mapsToAxis.field)) {
      throw new Error("Lens package add-on axis is invalid.");
    }
  }
  return item;
}

function assertLensVocabularyItem(item: LensVocabularyItem): LensVocabularyItem {
  if (!item.id.trim() || !item.key.trim() || !item.name.trim()) {
    throw new Error("Lens vocabulary id, key, and name are required.");
  }
  if (!(["design-type", "material", "treatment-family"] as const).includes(item.kind)) {
    throw new Error("Lens vocabulary kind is invalid.");
  }
  if (item.kind === "material") {
    if (!Number.isFinite(item.index) || (item.index ?? 0) <= 1) {
      throw new Error("Material vocabulary index must be a numeric value greater than 1.");
    }
  } else if (item.index !== undefined) {
    throw new Error("Only material vocabulary rows can carry a refractive index.");
  }
  return item;
}

function assertBasicIdentity(item: { id: string; lab: string; name: string }, label: string): void {
  if (!item.id.trim()) throw new Error(`${label} id is required.`);
  if (!item.lab.trim()) throw new Error(`${label} lab is required.`);
  if (!item.name.trim()) throw new Error(`${label} name is required.`);
}

function seedProduct(
  designKey: string,
  type: LensDesignType,
  productName: string,
  minFitHeight: number | undefined,
  onSite: boolean | undefined,
  materialKey: string,
  family: TreatmentFamily,
  brand: string,
  wholesalePerPairCents: number,
  defaultBillingCodeFamily: string | undefined,
): LensProduct {
  const material = LENS_MATERIAL_SEEDS.find((candidate) => candidate.key === materialKey);
  if (!material) throw new Error(`Unknown seeded lens material ${materialKey}.`);
  return assertLensProduct({
    id: `bp-${designKey}-${materialKey}-${slug(brand)}`,
    active: true,
    lab: "bp-digital",
    importBatch: "bp-digital-2025-a1",
    sourceRef: sourceRefFor(productName),
    effectiveDate: "2025",
    design: {
      type,
      productName,
      ...(minFitHeight === undefined ? {} : { minFitHeight }),
      ...(onSite === undefined ? {} : { onSite }),
    },
    material: { ...material },
    treatment: { family, brand },
    unit: "pair",
    wholesalePerPairCents,
    retailPerPairCents: suggestedRetailPerPairCents(wholesalePerPairCents),
    ...(defaultBillingCodeFamily ? { defaultBillingCodeFamily } : {}),
  });
}

function sourceRefFor(productName: string): string {
  if (productName === "Alpha Comfort" || productName === "Alpha Luxury") return "BP Digital 2025 price list p.3";
  if (productName === "BP Digital SV" || productName === "Regular SV") return "BP Digital 2025 price list p.2";
  if (productName === "Autograph III") return "BP Digital 2025 price list p.5";
  return "BP Digital 2025 price list p.4";
}

function withChargeItemSeeds(
  base: CatalogAdapter<LensProduct>,
  seeds: readonly LensProduct[],
): CatalogAdapter<LensProduct> {
  return {
    ...base,
    async list() {
      return mergeSeeds(await base.list(), seeds);
    },
    async save(item) {
      const stored = (await base.list()).find((candidate) => candidate.id === item.id);
      return base.save(stored?.resource && !item.resource ? { ...item, resource: stored.resource } : item);
    },
    async deactivate(item) {
      return item.resource?.id ? base.deactivate(item) : base.save({ ...item, active: false });
    },
  };
}

function withBasicSeeds<Item extends { id: string; active: boolean; resource?: Basic }>(
  base: CatalogAdapter<Item>,
  seeds: readonly Item[],
): CatalogAdapter<Item> {
  return {
    ...base,
    async list() {
      return mergeSeeds(await base.list(), seeds);
    },
    async save(item) {
      const stored = (await base.list()).find((candidate) => candidate.id === item.id);
      return base.save(stored?.resource && !item.resource ? { ...item, resource: stored.resource } : item);
    },
    async deactivate(item) {
      return item.resource?.id ? base.deactivate(item) : base.save({ ...item, active: false });
    },
  };
}

function mergeSeeds<Item extends { id: string }>(stored: Item[], seeds: readonly Item[]): Item[] {
  const storedIds = new Set(stored.map((item) => item.id));
  return [...stored, ...seeds.filter((seed) => !storedIds.has(seed.id)).map((seed) => structuredClone(seed))];
}

function replaceById<Item extends { id: string }>(items: readonly Item[], next: Item): Item[] {
  const found = items.some((item) => item.id === next.id);
  return found ? items.map((item) => item.id === next.id ? next : item) : [...items, next];
}

function hasCatalogCode(resource: ChargeItemDefinition, code: string): boolean {
  return Boolean(resource.code?.coding?.some(
    (coding) => coding.system === LENS_CATALOG_CODE_SYSTEM && coding.code === code,
  ));
}

function hasBasicCode(resource: Basic, code: string): boolean {
  return Boolean(resource.code?.coding?.some(
    (coding) => coding.system === LENS_CATALOG_CODE_SYSTEM && coding.code === code,
  ));
}

function basicStableId(resource: Basic): string {
  return resource.identifier?.find((identifier) => identifier.value)?.value ?? resource.id ?? "";
}

function structured(url: string, extension: Extension[]): Extension {
  return { url, extension };
}

function stringChild(url: string, value: string | undefined): Extension[] {
  return value === undefined || value === "" ? [] : [{ url, valueString: value }];
}

function codeChild(url: string, value: string | undefined): Extension[] {
  return value === undefined || value === "" ? [] : [{ url, valueCode: value }];
}

function decimalChild(url: string, value: number | undefined): Extension[] {
  return value === undefined ? [] : [{ url, valueDecimal: value }];
}

function booleanChild(url: string, value: boolean | undefined): Extension[] {
  return value === undefined ? [] : [{ url, valueBoolean: value }];
}

function moneyChild(url: string, cents: number | undefined): Extension[] {
  if (cents === undefined) return [];
  assertCents(cents, url);
  return [{ url, valueMoney: { value: cents / 100, currency: "USD" } }];
}

function requiredExtension(
  extensions: readonly Extension[] | undefined,
  url: string,
  label: string,
): Extension {
  const found = extensions?.find((extension) => extension.url === url);
  if (!found) throw new Error(`${label} extension is required.`);
  return found;
}

function child(extension: Extension, url: string): Extension | undefined {
  return extension.extension?.find((candidate) => candidate.url === url);
}

function children(extension: Extension, url: string): Extension[] {
  return extension.extension?.filter((candidate) => candidate.url === url) ?? [];
}

function requiredChild(extension: Extension, url: string, label: string): Extension {
  const found = child(extension, url);
  if (!found) throw new Error(`${label} extension is required.`);
  return found;
}

function childValue(extension: Extension, url: string): Extension | undefined {
  return child(extension, url);
}

function childString(extension: Extension, url: string): string {
  const value = childOptionalString(extension, url);
  if (value === undefined) throw new Error(`${url} is required.`);
  return value;
}

function childOptionalString(extension: Extension, url: string): string | undefined {
  return child(extension, url)?.valueString;
}

function childCode(extension: Extension, url: string): string {
  const value = childOptionalCode(extension, url);
  if (!value) throw new Error(`${url} is required.`);
  return value;
}

function childOptionalCode(extension: Extension, url: string): string | undefined {
  return child(extension, url)?.valueCode;
}

function childDecimal(extension: Extension, url: string): number | undefined {
  return child(extension, url)?.valueDecimal;
}

function childBoolean(extension: Extension, url: string): boolean | undefined {
  return child(extension, url)?.valueBoolean;
}

function childMoneyCents(extension: Extension, url: string): number | undefined {
  const money = child(extension, url)?.valueMoney;
  if (money === undefined) return undefined;
  if (money.currency !== "USD" || typeof money.value !== "number") throw new Error(`${url} must be USD Money.`);
  return moneyToCents(money.value, url);
}

function requiredChildMoneyCents(extension: Extension, url: string): number {
  const value = childMoneyCents(extension, url);
  if (value === undefined) throw new Error(`${url} price is required.`);
  return value;
}

function optionalString<Key extends string>(key: Key, value: string | undefined): { [K in Key]?: string } {
  return value === undefined ? {} : { [key]: value } as { [K in Key]?: string };
}

function optionalNumber<Key extends string>(key: Key, value: number | undefined): { [K in Key]?: number } {
  return value === undefined ? {} : { [key]: value } as { [K in Key]?: number };
}

function optionalBoolean<Key extends string>(key: Key, value: boolean | undefined): { [K in Key]?: boolean } {
  return value === undefined ? {} : { [key]: value } as { [K in Key]?: boolean };
}

function rxFieldKey(field: RxExtensionField): RxFieldKey {
  return field.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()) as RxFieldKey;
}

function assertCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative whole number of cents.`);
}

function moneyToCents(value: number, label: string): number {
  const cents = Math.round(value * 100);
  if (Math.abs(cents / 100 - value) > 1e-9) throw new Error(`${label} must resolve to whole cents.`);
  assertCents(cents, label);
  return cents;
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
}

function assertRange(min: number | undefined, max: number | undefined, label: string): void {
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${label} minimum cannot exceed maximum.`);
}

function canonicalTail(url: string | undefined): string {
  return url?.split("/").at(-1) ?? "";
}

function designTypeLabel(type: LensDesignType): string {
  const labels: Record<LensDesignType, string> = {
    "single-vision": "Single vision",
    "flat-top-28": "Flat top 28",
    "flat-top-35": "Flat top 35",
    "7x28": "7x28",
    "8x35": "8x35",
    round: "Round",
    blended: "Blended",
    "double-segment": "Double segment",
    aspheric: "Aspheric",
    progressive: "Progressive",
    "office-computer": "Office / computer",
    "anti-fatigue": "Anti-fatigue",
    trifocal: "Trifocal",
    lenticular: "Lenticular",
  };
  return labels[type];
}

function titleCase(value: string): string {
  return value.split("-").map((word) => word[0]?.toLocaleUpperCase() + word.slice(1)).join(" ");
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
