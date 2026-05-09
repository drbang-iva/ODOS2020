import { createHash } from "node:crypto";

export const FRAME_CATALOG_SYSTEM = "https://osod.dev/catalog/frames";
export const FRAME_PROPERTY_CODE_SYSTEM = "https://osod.dev/fhir/CodeSystem/frame-property";
export const HCPCS_SYSTEM = "https://bluebutton.cms.gov/resources/codesystem/hcpcs";
export const SNOMED_SYSTEM = "http://snomed.info/sct";
export const UCUM_SYSTEM = "http://unitsofmeasure.org";
export const GS1_GTIN_SYSTEM = "https://gs1.org/gtin";
export const FRAMES_DATA_SKU_SYSTEM = "https://osod.dev/catalog/frames/frames-data-sku";
export const OSOD_FRAME_DEVICE_TYPE_CODE = "419681006";
export const OSOD_OPTOMETRY_SERVICE_LINE_CODE = "310105000";
export const OSOD_FHIR_SOURCE_HEADER = "catalog-sync.frames.bulk-ingest";

export type FrameShape =
  | "aviator"
  | "cat-eye"
  | "rectangular"
  | "oval"
  | "round"
  | "square"
  | "wayfarer"
  | "geometric"
  | "oversized"
  | "wraparound"
  | "other";

export type FrameGenderCategory = "men" | "women" | "unisex" | "kids";
export type FrameAgeGroup = "adult" | "youth" | "pediatric" | "infant";
export type FrameFinish = "matte" | "gloss" | "satin" | "mixed" | "other";
export type FramePublicityClass = "staff_only" | "no_public_price" | "open";
export type FrameCatalogStatus = "active" | "discontinued";

export interface FrameCatalogRow {
  readonly id?: string;
  readonly skuId: string;
  readonly brandId: string;
  readonly brandName: string;
  readonly manufacturerId: string;
  readonly manufacturerName: string;
  readonly modelName: string;
  readonly colorCode: string;
  readonly colorName: string;
  readonly sourceColorRaw: string;
  readonly sourceMaterialRaw: string;
  readonly frameShape: FrameShape | null;
  readonly genderCategory: FrameGenderCategory | null;
  readonly ageGroup: FrameAgeGroup | null;
  readonly colorGroup: string | null;
  readonly finish: FrameFinish | null;
  readonly progressiveCompatible: boolean | null;
  readonly minFittingHeightMm: number | null;
  readonly eyesizeMm: number | null;
  readonly dblMm: number | null;
  readonly templeMm: number | null;
  readonly bMm: number | null;
  readonly edMm: number | null;
  readonly weightGrams: number | null;
  readonly materialCode: string | null;
  readonly countryOfOrigin: string | null;
  readonly msrpCents: number | null;
  readonly labCostCents: number | null;
  readonly gtin14: string | null;
  readonly itemNumber: string | null;
  readonly publicityClass: FramePublicityClass;
  readonly status: FrameCatalogStatus;
  readonly sourceVersion: string;
  readonly sourceUrl: string;
  readonly accessDate: string;
}

export interface FrameVendorRecord extends Partial<FrameCatalogRow> {
  readonly skuId: string;
  readonly lastModifiedAt?: string;
}

export type FrameHcpcsCode = "V2020" | "V2025" | "V2600";

export interface ClaimLineItem {
  readonly productOrService: {
    readonly coding: readonly { readonly system: string; readonly code: string; readonly display?: string }[];
  };
  readonly unitPrice: { readonly value: number; readonly currency: "USD" };
  readonly quantity: { readonly value: number };
  readonly modifier?: readonly { readonly coding: readonly { readonly code: string }[] }[];
}

export function frameCanonicalUrl(skuId: string): string {
  return `${FRAME_CATALOG_SYSTEM}/${encodeURIComponent(skuId)}`;
}

export function normalizeGtin14(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const raw = String(value).trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(raw)) {
    throw new Error(`normalizeGtin14: expected GTIN-8/12/13/14 numeric input, got ${raw}`);
  }
  return raw.padStart(14, "0");
}

export function assertFiniteNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName}: FHIR Quantity source value must be a JavaScript finite number`);
  }
  return value;
}

export function optionalFiniteNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return assertFiniteNumber(value, fieldName);
}

export function fhirAttachmentSha1Base64(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha1").update(bytes).digest("base64");
}

export function materialChange(a: FrameCatalogRow, b: FrameCatalogRow): boolean {
  return JSON.stringify(stripNonMaterial(a)) !== JSON.stringify(stripNonMaterial(b));
}

function stripNonMaterial(row: FrameCatalogRow): Omit<FrameCatalogRow, "id" | "sourceUrl" | "accessDate" | "sourceVersion"> {
  const { id: _id, sourceUrl: _sourceUrl, accessDate: _accessDate, sourceVersion: _sourceVersion, ...material } = row;
  return material;
}
