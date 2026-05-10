import {
  normalizeGtin14,
  type FrameAgeGroup,
  type FrameCatalogRow,
  type FrameFinish,
  type FrameGenderCategory,
  type FramePublicityClass,
  type FrameShape,
  type FrameVendorRecord,
} from "../../../catalog/frame-types.js";
import { streamTextLines } from "./stream-lines.js";

export type FramesDataFileFormat = "tracing-points" | "spex-upc" | "frames-data-365-export" | "unknown";

export interface ParseFrameFileOptions {
  readonly filePath: string;
  readonly fileFormat: FramesDataFileFormat;
  readonly sourceVersion: string;
  readonly sourceUrl: string;
  readonly accessDate: string;
}

export async function* parseFrameCatalogRowsFromFile(
  options: ParseFrameFileOptions,
): AsyncGenerator<FrameVendorRecord> {
  let headers: string[] | undefined;
  for await (const rawLine of streamTextLines(options.filePath)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("{")) {
      yield mapObjectToFrameVendorRecord(JSON.parse(line) as Record<string, unknown>, options);
      continue;
    }
    const cells = parseCsvLine(line);
    if (!headers) {
      headers = cells.map(normalizeHeader);
      continue;
    }
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    yield mapObjectToFrameVendorRecord(row, options);
  }
}

export function mapObjectToFrameVendorRecord(
  row: Record<string, unknown>,
  options: Pick<ParseFrameFileOptions, "sourceVersion" | "sourceUrl" | "accessDate">,
): FrameVendorRecord {
  const skuId = requiredString(read(row, "skuId", "sku", "sku_id", "upc", "itemNumber"), "skuId");
  return {
    skuId,
    brandId: stringOrDefault(read(row, "brandId", "brand_id"), slug(requiredString(read(row, "brandName", "brand"), "brandName"))),
    brandName: requiredString(read(row, "brandName", "brand"), "brandName"),
    manufacturerId: stringOrDefault(read(row, "manufacturerId", "manufacturer_id"), "unknown"),
    manufacturerName: stringOrDefault(read(row, "manufacturerName", "manufacturer"), "Unknown manufacturer"),
    modelName: requiredString(read(row, "modelName", "model"), "modelName"),
    colorCode: stringOrDefault(read(row, "colorCode", "color_code"), "unknown"),
    colorName: stringOrDefault(read(row, "colorName", "color"), "Unknown color"),
    sourceColorRaw: stringOrDefault(read(row, "sourceColorRaw", "source_color_raw", "color"), "Unknown color"),
    sourceMaterialRaw: stringOrDefault(read(row, "sourceMaterialRaw", "source_material_raw", "material"), "Unknown material"),
    frameShape: enumOrNull<FrameShape>(read(row, "frameShape", "frame_shape")),
    genderCategory: enumOrNull<FrameGenderCategory>(read(row, "genderCategory", "gender_category")),
    ageGroup: enumOrNull<FrameAgeGroup>(read(row, "ageGroup", "age_group")),
    colorGroup: nullableString(read(row, "colorGroup", "color_group")),
    finish: enumOrNull<FrameFinish>(read(row, "finish")),
    progressiveCompatible: nullableBoolean(read(row, "progressiveCompatible", "progressive_compatible")),
    minFittingHeightMm: nullableNumber(read(row, "minFittingHeightMm", "min_fitting_height_mm")),
    eyesizeMm: nullableNumber(read(row, "eyesizeMm", "eyesize_mm", "eyeSize", "eyesize")),
    dblMm: nullableNumber(read(row, "dblMm", "dbl_mm", "dbl")),
    templeMm: nullableNumber(read(row, "templeMm", "temple_mm", "temple")),
    bMm: nullableNumber(read(row, "bMm", "b_mm", "b")),
    edMm: nullableNumber(read(row, "edMm", "ed_mm", "ed")),
    weightGrams: nullableNumber(read(row, "weightGrams", "weight_grams", "weight")),
    materialCode: nullableString(read(row, "materialCode", "material_code")),
    countryOfOrigin: nullableString(read(row, "countryOfOrigin", "country_of_origin")),
    msrpCents: cents(read(row, "msrpCents", "msrp_cents", "msrp")),
    labCostCents: cents(read(row, "labCostCents", "lab_cost_cents", "labCost")),
    gtin14: normalizeGtin14(nullableString(read(row, "gtin14", "gtin", "upc"))),
    itemNumber: nullableString(read(row, "itemNumber", "item_number")),
    publicityClass: enumOrNull<FramePublicityClass>(read(row, "publicityClass", "publicity_class")) ?? "staff_only",
    status: enumOrNull<FrameCatalogRow["status"]>(read(row, "status")) ?? "active",
    sourceVersion: options.sourceVersion,
    sourceUrl: options.sourceUrl,
    accessDate: options.accessDate,
    lastModifiedAt: nullableString(read(row, "lastModifiedAt", "last_modified_at")) ?? undefined,
  };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/^\uFEFF/, "").replace(/[-\s]+(.)?/g, (_, char: string | undefined) => char?.toUpperCase() ?? "");
}

function read(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== "") {
      return row[key];
    }
  }
  return undefined;
}

function requiredString(value: unknown, field: string): string {
  const result = nullableString(value);
  if (!result) {
    throw new Error(`frame file parser: missing required ${field}`);
  }
  return result;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return nullableString(value) ?? fallback;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const stringValue = String(value).trim();
  return stringValue ? stringValue : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`frame file parser: numeric field could not parse ${String(value)}`);
  }
  return parsed;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(normalized)) return true;
  if (["false", "no", "0", "n"].includes(normalized)) return false;
  throw new Error(`frame file parser: boolean field could not parse ${String(value)}`);
}

function cents(value: unknown): number | null {
  const numeric = nullableNumber(value);
  if (numeric === null) {
    return null;
  }
  return Number.isInteger(numeric) && numeric > 999 ? numeric : Math.round(numeric * 100);
}

function enumOrNull<T extends string>(value: unknown): T | null {
  const stringValue = nullableString(value);
  return stringValue ? (stringValue as T) : null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
