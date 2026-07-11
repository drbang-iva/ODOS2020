import type { ChargeItemDefinition, Extension } from "@medplum/fhirtypes";
import {
  resourceCatalogAdapter,
  type CatalogAdapter,
} from "./catalog-adapter";
import type { fhir } from "./fhir";

export const OSOD_WHOLESALE_COST_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-wholesale-cost";
export const OSOD_OPTICAL_LAB_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-optical-lab";
export const OSOD_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/osod-contact-lens-product-identity";

const HCPCS_SYSTEM = "https://bluebutton.cms.gov/resources/codesystem/hcpcs";
const OPTICAL_PRICING_CATALOG_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/optical-pricing-catalog";
const LENS_PRICING_CATEGORY_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/lens-pricing-category";
const ACT_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const PRACTICE_ID = "osod-practice";
const FRAME_CATALOG_PREFIX = "https://osod.dev/catalog/frames/";
const SNOMED_SYSTEM = "http://snomed.info/sct";
const OSOD_OPTOMETRY_SERVICE_LINE_CODE = "310105000";

export type LensPricingCategory = "design" | "material" | "treatment";

export type LensPricingItem = {
  id: string;
  active: boolean;
  label: string;
  category: LensPricingCategory;
  billingCode: string;
  lab: string;
  perLensWholesaleCostCents?: number;
  perLensRetailPriceCents: number;
  resource?: ChargeItemDefinition;
};

export type FramePricingItem = {
  id: string;
  active: boolean;
  catalogCanonicalUrl: string;
  wholesaleCostCents?: number;
  retailPriceCents: number;
  resource?: ChargeItemDefinition;
};

export type ContactLensPricingItem = {
  id: string;
  active: boolean;
  manufacturerCode: string;
  manufacturerDisplay: string;
  productCode: string;
  productDisplay: string;
  wholesaleCostCents?: number;
  retailPriceCents: number;
  resource?: ChargeItemDefinition;
};

export const LENS_PRICING_SEEDS: readonly LensPricingItem[] = [
  lensSeed("lens-bifocal-flat-top", "Bifocal (flat top)", "design", "", 6250),
  lensSeed("lens-progressive-addon", "Progressive add-on", "design", "V2781", 8200),
  lensSeed("lens-ar-basic", "AR basic", "treatment", "", 6915),
  lensSeed("lens-prism-per-diopter", "Prism (per diopter)", "treatment", "", 500),
];

type OpticalPricingClient = Pick<
  typeof fhir,
  "search" | "searchUrl" | "create" | "update"
>;

const RESOURCE_CAPABILITIES = {
  reorder: false,
  deactivate: true,
  presetSeed: false,
} as const;

export function framePricingAdapter(
  client: OpticalPricingClient,
): CatalogAdapter<FramePricingItem> {
  return resourceCatalogAdapter<FramePricingItem, ChargeItemDefinition>({
    resourceType: "ChargeItemDefinition",
    searchParams: { _count: "100" },
    client,
    sourceTag: "frame-pricing-catalog",
    capabilities: { ...RESOURCE_CAPABILITIES, deactivate: false },
    includeResource: (resource) =>
      Boolean(resource.derivedFromUri?.some((url) => url.startsWith(FRAME_CATALOG_PREFIX))),
    toItem: framePricingItem,
    buildResource: buildFramePricingResource,
    deactivateResource: (item) => ({
      ...buildFramePricingResource(item),
      status: "retired",
    }),
  });
}

export function lensPricingAdapter(
  client: OpticalPricingClient,
): CatalogAdapter<LensPricingItem> {
  const base = resourceCatalogAdapter<LensPricingItem, ChargeItemDefinition>({
    resourceType: "ChargeItemDefinition",
    searchParams: { _count: "100" },
    client,
    sourceTag: "lens-pricing-catalog",
    capabilities: RESOURCE_CAPABILITIES,
    includeResource: (resource) => hasCatalogKind(resource, "lens-pricing"),
    toItem: lensPricingItem,
    buildResource: buildLensPricingResource,
    deactivateResource: (item) => ({
      ...buildLensPricingResource(item),
      status: "retired",
    }),
  });
  return {
    ...base,
    async list() {
      const rows = await base.list();
      const persistedKeys = new Set(
        rows.map((row) => canonicalTail(row.resource?.url)).filter(Boolean),
      );
      return [
        ...rows,
        ...LENS_PRICING_SEEDS
          .filter((seed) => !persistedKeys.has(seed.id))
          .map((seed) => structuredClone(seed)),
      ];
    },
    async deactivate(item) {
      return item.resource?.id
        ? base.deactivate(item)
        : base.save({ ...item, active: false });
    },
  };
}

export function contactLensPricingAdapter(
  client: OpticalPricingClient,
): CatalogAdapter<ContactLensPricingItem> {
  return resourceCatalogAdapter<ContactLensPricingItem, ChargeItemDefinition>({
    resourceType: "ChargeItemDefinition",
    searchParams: { _count: "100" },
    client,
    sourceTag: "contact-lens-pricing-catalog",
    capabilities: RESOURCE_CAPABILITIES,
    includeResource: (resource) => hasCatalogKind(resource, "contact-lens-pricing"),
    toItem: contactLensPricingItem,
    buildResource: buildContactLensPricingResource,
    deactivateResource: (item) => ({
      ...buildContactLensPricingResource(item),
      status: "retired",
    }),
  });
}

export function buildLensPricingResource(item: LensPricingItem): ChargeItemDefinition {
  assertNonnegativeCents(item.perLensRetailPriceCents, "Retail price per lens");
  if (item.perLensWholesaleCostCents !== undefined) {
    assertNonnegativeCents(item.perLensWholesaleCostCents, "Wholesale cost per lens");
  }
  const managedExtensions: Extension[] = [
    ...(item.lab ? [{ url: OSOD_OPTICAL_LAB_EXTENSION_URL, valueString: item.lab }] : []),
    ...moneyExtension(item.perLensWholesaleCostCents),
  ];
  return buildPricingResource({
    item,
    catalogKind: "lens-pricing",
    label: item.label,
    billingCode: item.billingCode,
    supplementalCoding: [{ system: LENS_PRICING_CATEGORY_SYSTEM, code: item.category }],
    retailPriceCents: item.perLensRetailPriceCents,
    description: "Wholesale and retail prices are per lens.",
    managedExtensions,
    managedExtensionUrls: new Set([
      OSOD_OPTICAL_LAB_EXTENSION_URL,
      OSOD_WHOLESALE_COST_EXTENSION_URL,
    ]),
  });
}

export function buildFramePricingResource(item: FramePricingItem): ChargeItemDefinition {
  assertNonnegativeCents(item.retailPriceCents, "Retail price");
  if (item.wholesaleCostCents !== undefined) {
    assertNonnegativeCents(item.wholesaleCostCents, "Wholesale cost");
  }
  const original = item.resource;
  return {
    ...original,
    resourceType: "ChargeItemDefinition",
    url:
      original?.url ??
      `https://osod.dev/practice/${PRACTICE_ID}/charge-rules/frames/${encodeURIComponent(item.catalogCanonicalUrl)}`,
    version: original?.version ?? "1",
    status: item.active ? "active" : "retired",
    code: original?.code ?? {
      coding: [
        { system: HCPCS_SYSTEM, code: "V2020", display: "Frames, purchases" },
        {
          system: SNOMED_SYSTEM,
          code: OSOD_OPTOMETRY_SERVICE_LINE_CODE,
          display: "Optometry service",
        },
      ],
    },
    derivedFromUri: [item.catalogCanonicalUrl],
    extension: [
      ...moneyExtension(item.wholesaleCostCents),
      ...(original?.extension ?? []).filter(
        (extension) => extension.url !== OSOD_WHOLESALE_COST_EXTENSION_URL,
      ),
    ],
    propertyGroup: [
      {
        priceComponent: [
          {
            type: "base",
            code: { coding: [{ system: ACT_CODE_SYSTEM, code: "CHRG" }] },
            amount: { value: item.retailPriceCents / 100, currency: "USD" },
          },
        ],
      },
    ],
  };
}

export function buildContactLensPricingResource(
  item: ContactLensPricingItem,
): ChargeItemDefinition {
  assertNonnegativeCents(item.retailPriceCents, "Retail price");
  if (item.wholesaleCostCents !== undefined) {
    assertNonnegativeCents(item.wholesaleCostCents, "Wholesale cost");
  }
  const managedExtensions: Extension[] = [
    {
      url: OSOD_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL,
      extension: [
        { url: "manufacturer-code", valueCode: item.manufacturerCode },
        { url: "manufacturer-display", valueString: item.manufacturerDisplay },
        { url: "product-code", valueCode: item.productCode },
        { url: "product-display", valueString: item.productDisplay },
      ],
    },
    ...moneyExtension(item.wholesaleCostCents),
  ];
  return buildPricingResource({
    item,
    catalogKind: "contact-lens-pricing",
    label: item.productDisplay,
    retailPriceCents: item.retailPriceCents,
    managedExtensions,
    managedExtensionUrls: new Set([
      OSOD_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL,
      OSOD_WHOLESALE_COST_EXTENSION_URL,
    ]),
  });
}

function buildPricingResource({
  item,
  catalogKind,
  label,
  billingCode,
  supplementalCoding = [],
  retailPriceCents,
  description,
  managedExtensions,
  managedExtensionUrls,
}: {
  item: LensPricingItem | ContactLensPricingItem;
  catalogKind: "lens-pricing" | "contact-lens-pricing";
  label: string;
  billingCode?: string;
  supplementalCoding?: NonNullable<NonNullable<ChargeItemDefinition["code"]>["coding"]>;
  retailPriceCents: number;
  description?: string;
  managedExtensions: Extension[];
  managedExtensionUrls: ReadonlySet<string>;
}): ChargeItemDefinition {
  const original = item.resource;
  return {
    ...original,
    resourceType: "ChargeItemDefinition",
    url:
      original?.url ??
      `https://osod.dev/practice/${PRACTICE_ID}/charge-rules/${catalogKind}/${encodeURIComponent(item.id)}`,
    version: original?.version ?? "1",
    status: item.active ? "active" : "retired",
    title: label,
    ...(description ? { description } : {}),
    code: {
      coding: [
        {
          system: OPTICAL_PRICING_CATALOG_SYSTEM,
          code: catalogKind,
          display: label,
        },
        ...(billingCode
          ? [{ system: HCPCS_SYSTEM, code: billingCode }]
          : []),
        ...supplementalCoding,
      ],
      text: label,
    },
    extension: [
      ...managedExtensions,
      ...(original?.extension ?? []).filter(
        (extension) => !managedExtensionUrls.has(extension.url),
      ),
    ],
    propertyGroup: [
      {
        priceComponent: [
          {
            type: "base",
            code: { coding: [{ system: ACT_CODE_SYSTEM, code: "CHRG" }] },
            amount: { value: retailPriceCents / 100, currency: "USD" },
          },
        ],
      },
    ],
  };
}

function lensPricingItem(resource: ChargeItemDefinition): LensPricingItem {
  return {
    id: resource.id ?? canonicalTail(resource.url),
    active: resource.status === "active",
    label: resource.title ?? resource.code?.text ?? "",
    category: (
      resource.code?.coding?.find((coding) => coding.system === LENS_PRICING_CATEGORY_SYSTEM)
        ?.code ?? "design"
    ) as LensPricingCategory,
    billingCode:
      resource.code?.coding?.find((coding) => coding.system === HCPCS_SYSTEM)?.code ?? "",
    lab: extensionString(resource, OSOD_OPTICAL_LAB_EXTENSION_URL),
    perLensWholesaleCostCents: extensionMoneyCents(resource),
    perLensRetailPriceCents: retailPriceCents(resource),
    resource,
  };
}

function framePricingItem(resource: ChargeItemDefinition): FramePricingItem {
  return {
    id: resource.id ?? canonicalTail(resource.url),
    active: resource.status === "active",
    catalogCanonicalUrl:
      resource.derivedFromUri?.find((url) => url.startsWith(FRAME_CATALOG_PREFIX)) ?? "",
    wholesaleCostCents: extensionMoneyCents(resource),
    retailPriceCents: retailPriceCents(resource),
    resource,
  };
}

function contactLensPricingItem(resource: ChargeItemDefinition): ContactLensPricingItem {
  const identity = resource.extension?.find(
    (extension) => extension.url === OSOD_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL,
  );
  return {
    id: resource.id ?? canonicalTail(resource.url),
    active: resource.status === "active",
    manufacturerCode: childExtensionCode(identity, "manufacturer-code"),
    manufacturerDisplay: childExtensionString(identity, "manufacturer-display"),
    productCode: childExtensionCode(identity, "product-code"),
    productDisplay: childExtensionString(identity, "product-display"),
    wholesaleCostCents: extensionMoneyCents(resource),
    retailPriceCents: retailPriceCents(resource),
    resource,
  };
}

function moneyExtension(cents: number | undefined): Extension[] {
  return cents === undefined
    ? []
    : [
        {
          url: OSOD_WHOLESALE_COST_EXTENSION_URL,
          valueMoney: { value: cents / 100, currency: "USD" },
        },
      ];
}

function retailPriceCents(resource: ChargeItemDefinition): number {
  const value = resource.propertyGroup
    ?.flatMap((group) => group.priceComponent ?? [])
    .find((component) => component.type === "base")
    ?.amount?.value;
  if (typeof value !== "number") {
    throw new Error("Optical pricing resource is missing its retail base price.");
  }
  return Math.round(value * 100);
}

function extensionMoneyCents(resource: ChargeItemDefinition): number | undefined {
  const value = resource.extension?.find(
    (extension) => extension.url === OSOD_WHOLESALE_COST_EXTENSION_URL,
  )?.valueMoney?.value;
  return typeof value === "number" ? Math.round(value * 100) : undefined;
}

function extensionString(resource: ChargeItemDefinition, url: string): string {
  return resource.extension?.find((extension) => extension.url === url)?.valueString ?? "";
}

function childExtensionCode(extension: Extension | undefined, url: string): string {
  return extension?.extension?.find((child) => child.url === url)?.valueCode ?? "";
}

function childExtensionString(extension: Extension | undefined, url: string): string {
  return extension?.extension?.find((child) => child.url === url)?.valueString ?? "";
}

function hasCatalogKind(
  resource: ChargeItemDefinition,
  kind: "lens-pricing" | "contact-lens-pricing",
): boolean {
  return Boolean(
    resource.code?.coding?.some(
      (coding) => coding.system === OPTICAL_PRICING_CATALOG_SYSTEM && coding.code === kind,
    ),
  );
}

function canonicalTail(url: string | undefined): string {
  return url?.split("/").at(-1) ?? "";
}

function assertNonnegativeCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative whole number of cents.`);
  }
}

function lensSeed(
  id: string,
  label: string,
  category: LensPricingCategory,
  billingCode: string,
  perLensRetailPriceCents: number,
): LensPricingItem {
  return {
    id,
    active: true,
    label,
    category,
    billingCode,
    lab: "",
    perLensRetailPriceCents,
  };
}
