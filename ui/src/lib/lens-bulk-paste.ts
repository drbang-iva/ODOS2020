import type { CatalogAdapter } from "./catalog-adapter";
import {
  LENS_DESIGN_TYPES,
  LENS_MATERIAL_SEEDS,
  LENS_RETAIL_MARKUP_MULTIPLIER,
  TREATMENT_FAMILIES,
  assertLensProduct,
  suggestedRetailPerPairCents,
  type LensDesignType,
  type LensOptimization,
  type LensProduct,
  type TreatmentFamily,
} from "./lens-catalog";

export const LENS_PRODUCT_PASTE_COLUMNS = [
  "lab",
  "designType",
  "productName",
  "minFitHeight",
  "compensatedRx",
  "optimization",
  "onSite",
  "priceLevel",
  "materialKey",
  "materialName",
  "materialIndex",
  "includedBaseCoating",
  "treatmentFamily",
  "treatmentBrand",
  "color",
  "unit",
  "wholesalePerPairCents",
  "retailPerPairCents",
  "singleLensCents",
  "sphMin",
  "sphMax",
  "cylMin",
  "cylMax",
  "addMin",
  "addMax",
  "defaultBillingCodeFamily",
  "importBatch",
  "sourceRef",
  "effectiveDate",
  "active",
] as const;

export type LensRetailRounding = "dollar-minus-2" | "nearest-dollar" | "nearest-cent";

export type LensRetailRule = {
  strategy: "multiplier" | "flat-adder";
  value: number;
  rounding: LensRetailRounding;
};

export const DEFAULT_LENS_RETAIL_RULE: LensRetailRule = {
  strategy: "multiplier",
  value: LENS_RETAIL_MARKUP_MULTIPLIER,
  rounding: "dollar-minus-2",
};

export type LensImportUnparsed = {
  sourceRow: string;
  reason: string;
};

export type LensImportMetadata = {
  lab: string;
  importBatch: string;
  sourceRef: string;
  effectiveDate: string;
};

export type LensPasteResult = {
  rows: LensProduct[];
  errors: string[];
  unparsed: LensImportUnparsed[];
  metadata?: LensImportMetadata;
  report: {
    parsedBaseCells: number;
    declaredBaseCells?: number;
    materializedRows: number;
    declaredMaterializedRows?: number;
  };
};

export type LensImportReviewProductRow = {
  classification: "NEW" | "CHANGED" | "DISCONTINUED";
  incoming: LensProduct;
  existing?: LensProduct;
  changes: string[];
  retailPreserved: boolean;
  suggestedRetailPerPairCents: number;
};

export type LensImportReviewUnparsedRow = LensImportUnparsed & {
  classification: "UNPARSED";
};

export type LensImportReviewRow = LensImportReviewProductRow | LensImportReviewUnparsedRow;

export type LensImportReview = {
  metadata?: LensImportMetadata;
  rows: LensImportReviewRow[];
  errors: string[];
  unchangedCount: number;
  report: LensPasteResult["report"];
  approvable: boolean;
};

type ParseOptions = {
  retailRules?: Partial<Record<LensDesignType, LensRetailRule>>;
};

const MIN_WHOLESALE_CENTS = 1;
const MAX_WHOLESALE_CENTS = 500_000;
const MAX_TREATMENT_ADDER_CENTS = 250_000;

export function parseLensProductPaste(
  input: string,
  idFactory: () => string = () => crypto.randomUUID(),
  options: ParseOptions = {},
): LensPasteResult {
  if (input.trimStart().startsWith("{")) {
    return parseMatrixImport(input, options);
  }
  return parseMaterializedRows(input, idFactory);
}

export function suggestedRetailForRule(
  wholesalePerPairCents: number,
  rule: LensRetailRule = DEFAULT_LENS_RETAIL_RULE,
): number {
  if (!Number.isFinite(rule.value) || rule.value < 0) throw new Error("Retail rule value must be a non-negative number.");
  const raw = rule.strategy === "multiplier"
    ? wholesalePerPairCents * rule.value
    : wholesalePerPairCents + rule.value;
  if (rule.rounding === "nearest-cent") return Math.round(raw);
  if (rule.rounding === "nearest-dollar") return Math.round(raw / 100) * 100;
  if (rule.strategy === "multiplier" && rule.value === LENS_RETAIL_MARKUP_MULTIPLIER) {
    return suggestedRetailPerPairCents(wholesalePerPairCents);
  }
  return Math.max(0, Math.round(raw / 100) * 100 - 2);
}

export function buildLensImportReview(
  parsed: LensPasteResult,
  existingProducts: readonly LensProduct[],
): LensImportReview {
  const rows: LensImportReviewRow[] = parsed.unparsed.map((row) => ({ classification: "UNPARSED", ...row }));
  const reviewErrors = [...parsed.errors];
  const existingByKey = new Map<string, LensProduct>();
  const existingById = new Map(existingProducts.map((product) => [product.id, product]));
  for (const product of existingProducts) {
    const key = lensCombinationKey(product);
    if (existingByKey.has(key)) reviewErrors.push(`Existing catalog contains duplicate combination ${key}.`);
    else existingByKey.set(key, product);
  }
  const incomingKeys = new Set<string>();
  let unchangedCount = 0;

  for (const candidate of parsed.rows) {
    const key = lensCombinationKey(candidate);
    incomingKeys.add(key);
    const idOwner = existingById.get(candidate.id);
    if (idOwner && lensCombinationKey(idOwner) !== key) {
      reviewErrors.push(`Stable id ${candidate.id} collides with existing combination ${lensCombinationKey(idOwner)}.`);
    }
    const existing = existingByKey.get(key);
    if (!existing) {
      rows.push({
        classification: "NEW",
        incoming: candidate,
        changes: ["New catalog combination"],
        retailPreserved: false,
        suggestedRetailPerPairCents: candidate.retailPerPairCents,
      });
      continue;
    }
    const incoming = {
      ...candidate,
      id: existing.id,
      retailPerPairCents: existing.retailPerPairCents,
      ...(existing.singleLensCents === undefined ? {} : { singleLensCents: existing.singleLensCents }),
      ...(candidate.defaultBillingCodeFamily || !existing.defaultBillingCodeFamily
        ? {}
        : { defaultBillingCodeFamily: existing.defaultBillingCodeFamily }),
      ...(existing.resource ? { resource: existing.resource } : {}),
    };
    const changes = describeChanges(existing, incoming);
    if (changes.length === 0) {
      unchangedCount += 1;
      continue;
    }
    rows.push({
      classification: "CHANGED",
      incoming,
      existing,
      changes,
      retailPreserved: true,
      suggestedRetailPerPairCents: candidate.retailPerPairCents,
    });
  }

  if (parsed.metadata) {
    for (const existing of existingProducts.filter((product) => product.lab === parsed.metadata!.lab && product.active)) {
      if (incomingKeys.has(lensCombinationKey(existing))) continue;
      rows.push({
        classification: "DISCONTINUED",
        existing,
        incoming: {
          ...existing,
          active: false,
          importBatch: parsed.metadata.importBatch,
          sourceRef: parsed.metadata.sourceRef,
          effectiveDate: parsed.metadata.effectiveDate,
        },
        changes: ["Status Active → Discontinued"],
        retailPreserved: true,
        suggestedRetailPerPairCents: existing.retailPerPairCents,
      });
    }
  }

  const actionableCount = rows.filter((row) => row.classification !== "UNPARSED").length;
  return {
    metadata: parsed.metadata,
    rows,
    errors: reviewErrors,
    unchangedCount,
    report: parsed.report,
    approvable: reviewErrors.length === 0 && parsed.unparsed.length === 0 && actionableCount > 0,
  };
}

export async function approveLensImport(
  review: LensImportReview,
  adapter: CatalogAdapter<LensProduct>,
): Promise<LensProduct[]> {
  if (review.errors.length > 0 || review.rows.some((row) => row.classification === "UNPARSED")) {
    throw new Error("Resolve every import error and UNPARSED row before approval.");
  }
  const actionable = review.rows.filter((row): row is LensImportReviewProductRow => row.classification !== "UNPARSED");
  if (actionable.length === 0) throw new Error("This import has no catalog changes to approve.");
  const validated = actionable.map((row) => assertLensProduct(row.incoming));
  const saved: LensProduct[] = [];
  for (const row of validated) saved.push(await adapter.save(row));
  return saved;
}

function parseMatrixImport(input: string, options: ParseOptions): LensPasteResult {
  const empty = emptyResult();
  let document: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input);
    if (!isRecord(parsed)) throw new Error("Import document must be a JSON object.");
    document = parsed;
  } catch (error) {
    return { ...empty, errors: [`File: ${errorMessage(error)}`] };
  }

  let metadata: LensImportMetadata;
  let declaredBaseCells: number;
  let declaredMaterializedRows: number;
  let baseCells: unknown[];
  let treatmentAdders: unknown[];
  try {
    if (document.schemaVersion !== 1) throw new Error("schemaVersion must be 1.");
    assertAllowedKeys(document, [
      "schemaVersion", "lab", "importBatch", "sourceRef", "effectiveDate",
      "declaredBaseCellCount", "declaredMaterializedRowCount", "baseCells", "treatmentAdders",
    ], "Import document");
    metadata = {
      lab: requiredString(document.lab, "lab"),
      importBatch: requiredString(document.importBatch, "importBatch"),
      sourceRef: requiredString(document.sourceRef, "sourceRef"),
      effectiveDate: requiredFhirDate(document.effectiveDate, "effectiveDate"),
    };
    declaredBaseCells = requiredCount(document.declaredBaseCellCount, "declaredBaseCellCount");
    declaredMaterializedRows = requiredCount(document.declaredMaterializedRowCount, "declaredMaterializedRowCount");
    baseCells = requiredArray(document.baseCells, "baseCells");
    treatmentAdders = requiredArray(document.treatmentAdders, "treatmentAdders");
  } catch (error) {
    return { ...empty, errors: [`File: ${errorMessage(error)}`] };
  }

  const unparsed: LensImportUnparsed[] = [];
  const bases: LensProduct[] = [];
  for (const [index, value] of baseCells.entries()) {
    try {
      bases.push(parseBaseCell(value, metadata, options.retailRules));
    } catch (error) {
      unparsed.push({ sourceRow: `baseCells[${index}]`, reason: errorMessage(error) });
    }
  }

  const rows = [...bases];
  for (const [index, value] of treatmentAdders.entries()) {
    try {
      const addOn = parseTreatmentAdder(value);
      const matches = bases.filter((base) => appliesToBase(addOn.appliesTo, base));
      if (matches.length === 0) throw new Error("Treatment add-on does not match any parsed base cell.");
      for (const base of matches) {
        const wholesalePerPairCents = base.wholesalePerPairCents + addOn.cents;
        assertSanePrice(wholesalePerPairCents, "Materialized wholesale price", MAX_WHOLESALE_CENTS);
        const rule = options.retailRules?.[base.design.type] ?? DEFAULT_LENS_RETAIL_RULE;
        rows.push(assertLensProduct({
          ...base,
          id: stableLensId(base.lab, base.design.productName, base.material.key, addOn.brand, addOn.color),
          sourceRef: combineSourceRefs(base.sourceRef, addOn.sourceRef ?? metadata.sourceRef),
          treatment: {
            family: addOn.family,
            brand: addOn.brand,
            ...(addOn.color ? { color: addOn.color } : {}),
          },
          wholesalePerPairCents,
          retailPerPairCents: suggestedRetailForRule(wholesalePerPairCents, rule),
        }));
      }
    } catch (error) {
      unparsed.push({ sourceRow: `treatmentAdders[${index}]`, reason: errorMessage(error) });
    }
  }

  const uniqueRows: LensProduct[] = [];
  const seen = new Set<string>();
  const ids = new Map<string, string>();
  for (const row of rows) {
    const key = lensCombinationKey(row);
    if (seen.has(key)) {
      unparsed.push({ sourceRow: row.sourceRef, reason: `Duplicate materialized combination ${key}.` });
    } else if (ids.has(row.id)) {
      unparsed.push({ sourceRow: row.sourceRef, reason: `Stable id ${row.id} collides with combination ${ids.get(row.id)}.` });
    } else {
      seen.add(key);
      ids.set(row.id, key);
      uniqueRows.push(row);
    }
  }

  const errors: string[] = [];
  if (bases.length !== declaredBaseCells) {
    errors.push(`Parsed ${bases.length} of ${declaredBaseCells} declared base cells.`);
  }
  if (uniqueRows.length !== declaredMaterializedRows) {
    errors.push(`Materialized ${uniqueRows.length} of ${declaredMaterializedRows} declared catalog rows.`);
  }
  return {
    rows: uniqueRows,
    errors,
    unparsed,
    metadata,
    report: {
      parsedBaseCells: bases.length,
      declaredBaseCells,
      materializedRows: uniqueRows.length,
      declaredMaterializedRows,
    },
  };
}

function parseBaseCell(
  value: unknown,
  metadata: LensImportMetadata,
  retailRules: ParseOptions["retailRules"],
): LensProduct {
  const row = requiredRecord(value, "Base cell");
  assertAllowedKeys(row, [
    "designType", "productName", "minFitHeight", "compensatedRx", "optimization", "onSite",
    "priceLevel", "materialKey", "materialIndex", "wholesalePrice", "rxEnvelope",
    "defaultBillingCodeFamily", "sourceRef",
  ], "Base cell");
  const designType = requiredString(row.designType, "designType") as LensDesignType;
  if (!LENS_DESIGN_TYPES.includes(designType)) throw new Error(`Unknown designType "${designType}".`);
  const materialKey = requiredString(row.materialKey, "materialKey");
  const material = LENS_MATERIAL_SEEDS.find((candidate) => candidate.key === materialKey);
  if (!material) throw new Error(`Unknown materialKey "${materialKey}".`);
  const materialIndex = requiredFinite(row.materialIndex, "materialIndex");
  if (materialIndex !== material.index) {
    throw new Error(`materialIndex ${materialIndex} does not match canonical ${material.key} index ${material.index}.`);
  }
  const price = parseExplicitPrice(row.wholesalePrice, "wholesalePrice", MAX_WHOLESALE_CENTS);
  const productName = requiredString(row.productName, "productName");
  const rx = row.rxEnvelope === undefined ? {} : parseRxEnvelope(row.rxEnvelope);
  const rule = retailRules?.[designType] ?? DEFAULT_LENS_RETAIL_RULE;
  return assertLensProduct({
    id: stableLensId(metadata.lab, productName, material.key, "Clear"),
    active: true,
    ...metadata,
    sourceRef: row.sourceRef === undefined ? metadata.sourceRef : requiredString(row.sourceRef, "sourceRef"),
    design: {
      type: designType,
      productName,
      ...optionalFiniteField("minFitHeight", row.minFitHeight),
      ...optionalBooleanField("compensatedRx", row.compensatedRx),
      ...optionalOptimization(row.optimization),
      ...optionalBooleanField("onSite", row.onSite),
      ...optionalStringField("priceLevel", row.priceLevel),
    },
    material: { ...material },
    treatment: { family: "clear", brand: "Clear" },
    unit: price.unit,
    wholesalePerPairCents: price.cents,
    retailPerPairCents: suggestedRetailForRule(price.cents, rule),
    ...rx,
    ...optionalStringField("defaultBillingCodeFamily", row.defaultBillingCodeFamily),
  });
}

function parseTreatmentAdder(value: unknown): {
  family: TreatmentFamily;
  brand: string;
  color?: string;
  cents: number;
  sourceRef?: string;
  appliesTo: Record<string, unknown>;
} {
  const row = requiredRecord(value, "Treatment add-on");
  assertAllowedKeys(row, [
    "treatmentFamily", "treatmentBrand", "color", "adderPrice", "appliesTo", "sourceRef",
  ], "Treatment add-on");
  const family = requiredString(row.treatmentFamily, "treatmentFamily") as TreatmentFamily;
  if (!TREATMENT_FAMILIES.includes(family)) throw new Error(`Unknown treatmentFamily "${family}".`);
  if (family === "clear") throw new Error("Treatment add-ons cannot use the clear family; clear is emitted by each base cell.");
  const price = parseExplicitPrice(row.adderPrice, "adderPrice", MAX_TREATMENT_ADDER_CENTS, 0);
  const appliesTo = row.appliesTo === undefined ? {} : requiredRecord(row.appliesTo, "appliesTo");
  assertAllowedKeys(appliesTo, ["productNames", "materialKeys", "designTypes"], "appliesTo");
  return {
    family,
    brand: requiredString(row.treatmentBrand, "treatmentBrand"),
    ...optionalStringField("color", row.color),
    cents: price.cents,
    ...optionalStringField("sourceRef", row.sourceRef),
    appliesTo,
  };
}

function appliesToBase(selector: Record<string, unknown>, base: LensProduct): boolean {
  return matchesSelector(selector.productNames, base.design.productName, "productNames")
    && matchesSelector(selector.materialKeys, base.material.key, "materialKeys")
    && matchesSelector(selector.designTypes, base.design.type, "designTypes");
}

function matchesSelector(value: unknown, actual: string, field: string): boolean {
  if (value === undefined) return true;
  const candidates = requiredArray(value, field).map((candidate) => requiredString(candidate, field));
  return candidates.includes(actual);
}

function parseMaterializedRows(input: string, idFactory: () => string): LensPasteResult {
  const rows: LensProduct[] = [];
  const errors: string[] = [];
  const unparsed: LensImportUnparsed[] = [];
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let values: string[];
    try {
      values = parseDelimitedLine(line, line.includes("\t") ? "\t" : ",");
    } catch (error) {
      const reason = errorMessage(error);
      errors.push(`Row ${index + 1}: ${reason}`);
      unparsed.push({ sourceRow: `Row ${index + 1}`, reason });
      continue;
    }
    if (index === 0 && values.join("|") === LENS_PRODUCT_PASTE_COLUMNS.join("|")) continue;
    if (values.length !== LENS_PRODUCT_PASTE_COLUMNS.length) {
      const reason = `expected ${LENS_PRODUCT_PASTE_COLUMNS.length} columns, found ${values.length}.`;
      errors.push(`Row ${index + 1}: ${reason}`);
      unparsed.push({ sourceRow: `Row ${index + 1}`, reason });
      continue;
    }
    const value = Object.fromEntries(LENS_PRODUCT_PASTE_COLUMNS.map((column, columnIndex) => [column, values[columnIndex]?.trim() ?? ""]));
    try {
      if (value.unit !== "pair") throw new Error("unit must be explicitly declared as pair.");
      const wholesale = requiredNumber(value.wholesalePerPairCents, "wholesalePerPairCents");
      assertSanePrice(wholesale, "Wholesale price", MAX_WHOLESALE_CENTS);
      rows.push(assertLensProduct({
        id: `lens-bulk-${idFactory()}`,
        active: requiredBoolean(value.active, "active"),
        lab: value.lab,
        importBatch: value.importBatch,
        sourceRef: value.sourceRef,
        effectiveDate: value.effectiveDate,
        design: {
          type: value.designType as LensDesignType,
          productName: value.productName,
          ...optionalNumber("minFitHeight", value.minFitHeight),
          ...optionalBoolean("compensatedRx", value.compensatedRx),
          ...(value.optimization ? { optimization: value.optimization as LensOptimization } : {}),
          ...optionalBoolean("onSite", value.onSite),
          ...optionalString("priceLevel", value.priceLevel),
        },
        material: {
          key: value.materialKey,
          name: value.materialName,
          index: requiredNumber(value.materialIndex, "materialIndex"),
          ...optionalString("includedBaseCoating", value.includedBaseCoating),
        },
        treatment: {
          family: value.treatmentFamily as TreatmentFamily,
          brand: value.treatmentBrand,
          ...optionalString("color", value.color),
        },
        unit: "pair",
        wholesalePerPairCents: wholesale,
        retailPerPairCents: requiredNumber(value.retailPerPairCents, "retailPerPairCents"),
        ...optionalNumber("singleLensCents", value.singleLensCents),
        ...optionalNumber("sphMin", value.sphMin),
        ...optionalNumber("sphMax", value.sphMax),
        ...optionalNumber("cylMin", value.cylMin),
        ...optionalNumber("cylMax", value.cylMax),
        ...optionalNumber("addMin", value.addMin),
        ...optionalNumber("addMax", value.addMax),
        ...optionalString("defaultBillingCodeFamily", value.defaultBillingCodeFamily),
      }));
    } catch (error) {
      const reason = errorMessage(error);
      errors.push(`Row ${index + 1}: ${reason}`);
      unparsed.push({ sourceRow: `Row ${index + 1}`, reason });
    }
  }
  const first = rows[0];
  const metadataMatches = first && rows.every((row) =>
    row.lab === first.lab
    && row.importBatch === first.importBatch
    && row.sourceRef === first.sourceRef
    && row.effectiveDate === first.effectiveDate
  );
  if (first && !metadataMatches) {
    errors.push("Every materialized row must share lab, importBatch, sourceRef, and effectiveDate.");
  }
  return {
    rows,
    errors,
    unparsed,
    ...(metadataMatches ? { metadata: {
      lab: first.lab,
      importBatch: first.importBatch,
      sourceRef: first.sourceRef,
      effectiveDate: first.effectiveDate,
    } } : {}),
    report: { parsedBaseCells: rows.length, materializedRows: rows.length },
  };
}

function describeChanges(existing: LensProduct, incoming: LensProduct): string[] {
  const changes: string[] = [];
  addChange(changes, "Wholesale", money(existing.wholesalePerPairCents), money(incoming.wholesalePerPairCents));
  addChange(changes, "Status", existing.active ? "Active" : "Discontinued", incoming.active ? "Active" : "Discontinued");
  addChange(changes, "Design type", existing.design.type, incoming.design.type);
  addChange(changes, "Fit height", existing.design.minFitHeight, incoming.design.minFitHeight);
  addChange(changes, "Compensated Rx", existing.design.compensatedRx, incoming.design.compensatedRx);
  addChange(changes, "Optimization", existing.design.optimization, incoming.design.optimization);
  addChange(changes, "On site", existing.design.onSite, incoming.design.onSite);
  addChange(changes, "Price level", existing.design.priceLevel, incoming.design.priceLevel);
  addChange(changes, "Material name", existing.material.name, incoming.material.name);
  addChange(changes, "Material index", existing.material.index, incoming.material.index);
  addChange(changes, "Included coating", existing.material.includedBaseCoating, incoming.material.includedBaseCoating);
  addChange(changes, "Source", existing.sourceRef, incoming.sourceRef);
  addChange(changes, "Effective date", existing.effectiveDate, incoming.effectiveDate);
  addChange(changes, "Import batch", existing.importBatch, incoming.importBatch);
  for (const field of ["sphMin", "sphMax", "cylMin", "cylMax", "addMin", "addMax", "defaultBillingCodeFamily"] as const) {
    addChange(changes, field, existing[field], incoming[field]);
  }
  return changes;
}

function addChange(changes: string[], label: string, oldValue: unknown, newValue: unknown): void {
  if (oldValue === newValue) return;
  changes.push(`${label} ${display(oldValue)} → ${display(newValue)}`);
}

function lensCombinationKey(product: LensProduct): string {
  return [
    product.lab,
    product.design.productName,
    product.material.key,
    product.material.index,
    product.treatment.family,
    product.treatment.brand,
    product.treatment.color ?? "",
  ].join("|").toLocaleLowerCase();
}

function stableLensId(lab: string, productName: string, materialKey: string, treatmentBrand: string, color?: string): string {
  const labPrefix = lab === "bp-digital" ? "bp" : slug(lab);
  return [labPrefix, slug(productName), slug(materialKey), slug(treatmentBrand), ...(color ? [slug(color)] : [])].join("-");
}

function parseExplicitPrice(value: unknown, field: string, maximum: number, minimum = MIN_WHOLESALE_CENTS): { cents: number; unit: "pair" } {
  if (!isRecord(value)) throw new Error(`${field} must declare both cents and unit; bare numbers are rejected.`);
  assertAllowedKeys(value, ["cents", "unit"], field);
  const cents = requiredFinite(value.cents, `${field}.cents`);
  if (value.unit !== "pair") throw new Error(`${field}.unit must be explicitly declared as pair.`);
  assertSanePrice(cents, field, maximum, minimum);
  return { cents, unit: "pair" };
}

function assertSanePrice(value: number, field: string, maximum: number, minimum = MIN_WHOLESALE_CENTS): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be whole cents from ${minimum} through ${maximum}; received ${value}.`);
  }
}

function parseRxEnvelope(value: unknown): Partial<Pick<LensProduct, "sphMin" | "sphMax" | "cylMin" | "cylMax" | "addMin" | "addMax">> {
  const rx = requiredRecord(value, "rxEnvelope");
  assertAllowedKeys(rx, ["sphMin", "sphMax", "cylMin", "cylMax", "addMin", "addMax"], "rxEnvelope");
  return {
    ...optionalFiniteField("sphMin", rx.sphMin),
    ...optionalFiniteField("sphMax", rx.sphMax),
    ...optionalFiniteField("cylMin", rx.cylMin),
    ...optionalFiniteField("cylMax", rx.cylMax),
    ...optionalFiniteField("addMin", rx.addMin),
    ...optionalFiniteField("addMax", rx.addMax),
  };
}

function emptyResult(): LensPasteResult {
  return { rows: [], errors: [], unparsed: [], report: { parsedBaseCells: 0, materializedRows: 0 } };
}

function parseDelimitedLine(line: string, delimiter: "," | "\t"): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("Pasted row contains an unclosed quoted value.");
  values.push(value);
  return values;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function requiredFhirDate(value: unknown, field: string): string {
  const date = requiredString(value, field);
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date);
  if (!match) throw new Error(`${field} must be a FHIR date.`);
  const year = Number(match[1]);
  const month = match[2] === undefined ? undefined : Number(match[2]);
  const day = match[3] === undefined ? undefined : Number(match[3]);
  if (month !== undefined && (month < 1 || month > 12)) throw new Error(`${field} must be a FHIR date.`);
  if (day !== undefined && month !== undefined) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
    if (day < 1 || day > daysInMonth) throw new Error(`${field} must be a FHIR date.`);
  }
  return date;
}

function requiredCount(value: unknown, field: string): number {
  const count = requiredFinite(value, field);
  if (!Number.isInteger(count) || count < 0) throw new Error(`${field} must be a non-negative integer.`);
  return count;
}

function requiredFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be numeric.`);
  return value;
}

function requiredNumber(value: string, field: string): number {
  if (value === "") throw new Error(`${field} is required.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric.`);
  return parsed;
}

function requiredBoolean(value: string, field: string): boolean {
  const parsed = parseBoolean(value);
  if (parsed === undefined) throw new Error(`${field} must be true or false.`);
  return parsed;
}

function optionalStringField<Key extends string>(key: Key, value: unknown): { [K in Key]?: string } {
  if (value === undefined || value === "") return {};
  return { [key]: requiredString(value, key) } as { [K in Key]?: string };
}

function optionalFiniteField<Key extends string>(key: Key, value: unknown): { [K in Key]?: number } {
  if (value === undefined || value === "") return {};
  return { [key]: requiredFinite(value, key) } as { [K in Key]?: number };
}

function optionalBooleanField<Key extends string>(key: Key, value: unknown): { [K in Key]?: boolean } {
  if (value === undefined || value === "") return {};
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false.`);
  return { [key]: value } as { [K in Key]?: boolean };
}

function optionalOptimization(value: unknown): { optimization?: LensOptimization } {
  if (value === undefined || value === "") return {};
  if (!["balanced", "distance", "near", "office"].includes(String(value))) throw new Error(`Unknown optimization "${String(value)}".`);
  return { optimization: value as LensOptimization };
}

function optionalString<Key extends string>(key: Key, value: string): { [K in Key]?: string } {
  return value === "" ? {} : { [key]: value } as { [K in Key]?: string };
}

function optionalNumber<Key extends string>(key: Key, value: string): { [K in Key]?: number } {
  return value === "" ? {} : { [key]: requiredNumber(value, key) } as { [K in Key]?: number };
}

function optionalBoolean<Key extends string>(key: Key, value: string): { [K in Key]?: boolean } {
  if (value === "") return {};
  const parsed = parseBoolean(value);
  if (parsed === undefined) throw new Error(`${key} must be true or false.`);
  return { [key]: parsed } as { [K in Key]?: boolean };
}

function parseBoolean(value: string): boolean | undefined {
  if (value.toLocaleLowerCase() === "true") return true;
  if (value.toLocaleLowerCase() === "false") return false;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

function combineSourceRefs(left: string, right: string): string {
  return left === right ? left : `${left}; ${right}`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function display(value: unknown): string {
  if (value === undefined || value === "") return "—";
  return String(value);
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
