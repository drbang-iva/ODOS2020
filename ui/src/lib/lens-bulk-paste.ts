import {
  assertLensProduct,
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

export type LensPasteResult = {
  rows: LensProduct[];
  errors: string[];
};

export function parseLensProductPaste(
  input: string,
  idFactory: () => string = () => crypto.randomUUID(),
): LensPasteResult {
  const rows: LensProduct[] = [];
  const errors: string[] = [];
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let values: string[];
    try {
      values = parseDelimitedLine(line, line.includes("\t") ? "\t" : ",");
    } catch (error) {
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (index === 0 && values.join("|") === LENS_PRODUCT_PASTE_COLUMNS.join("|")) continue;
    if (values.length !== LENS_PRODUCT_PASTE_COLUMNS.length) {
      errors.push(`Row ${index + 1}: expected ${LENS_PRODUCT_PASTE_COLUMNS.length} columns, found ${values.length}.`);
      continue;
    }
    const value = Object.fromEntries(LENS_PRODUCT_PASTE_COLUMNS.map((column, columnIndex) => [column, values[columnIndex]?.trim() ?? ""]));
    try {
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
        wholesalePerPairCents: requiredNumber(value.wholesalePerPairCents, "wholesalePerPairCents"),
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
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rows, errors };
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
