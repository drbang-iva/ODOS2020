import type { ChargeItemDefinition, Extension } from "@medplum/fhirtypes";
import {
  resourceCatalogAdapter,
  type CatalogAdapter,
} from "./catalog-adapter";
import type { fhir } from "./fhir";

export const ODOS_WHOLESALE_COST_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-wholesale-cost";
export const ODOS_OPTICAL_LAB_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-optical-lab";
export const ODOS_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL =
  "https://odos2020.com/fhir/StructureDefinition/odos-contact-lens-product-identity";

const HCPCS_SYSTEM = "https://bluebutton.cms.gov/resources/codesystem/hcpcs";
const OPTICAL_PRICING_CATALOG_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/optical-pricing-catalog";
const ACT_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const PRACTICE_ID = "odos-practice";
const FRAME_CATALOG_PREFIX = "https://odos2020.com/catalog/frames/";
const SNOMED_SYSTEM = "http://snomed.info/sct";
const ODOS_OPTOMETRY_SERVICE_LINE_CODE = "310105000";

export function frameChargeItemDefinitionCanonical(catalogCanonicalUrl: string): string {
  return `https://odos2020.com/practice/${PRACTICE_ID}/charge-rules/frames/${encodeURIComponent(catalogCanonicalUrl)}`;
}

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
      frameChargeItemDefinitionCanonical(item.catalogCanonicalUrl),
    version: original?.version ?? "1",
    status: item.active ? "active" : "retired",
    code: original?.code ?? {
      coding: [
        { system: HCPCS_SYSTEM, code: "V2020", display: "Frames, purchases" },
        {
          system: SNOMED_SYSTEM,
          code: ODOS_OPTOMETRY_SERVICE_LINE_CODE,
          display: "Optometry service",
        },
      ],
    },
    derivedFromUri: [item.catalogCanonicalUrl],
    extension: [
      ...moneyExtension(item.wholesaleCostCents),
      ...(original?.extension ?? []).filter(
        (extension) => extension.url !== ODOS_WHOLESALE_COST_EXTENSION_URL,
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
      url: ODOS_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL,
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
      ODOS_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL,
      ODOS_WHOLESALE_COST_EXTENSION_URL,
    ]),
  });
}

function buildPricingResource({
  item,
  catalogKind,
  label,
  retailPriceCents,
  managedExtensions,
  managedExtensionUrls,
}: {
  item: ContactLensPricingItem;
  catalogKind: "contact-lens-pricing";
  label: string;
  retailPriceCents: number;
  managedExtensions: Extension[];
  managedExtensionUrls: ReadonlySet<string>;
}): ChargeItemDefinition {
  const original = item.resource;
  return {
    ...original,
    resourceType: "ChargeItemDefinition",
    url:
      original?.url ??
      `https://odos2020.com/practice/${PRACTICE_ID}/charge-rules/${catalogKind}/${encodeURIComponent(item.id)}`,
    version: original?.version ?? "1",
    status: item.active ? "active" : "retired",
    title: label,
    code: {
      coding: [
        {
          system: OPTICAL_PRICING_CATALOG_SYSTEM,
          code: catalogKind,
          display: label,
        },
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
    (extension) => extension.url === ODOS_CONTACT_LENS_PRODUCT_IDENTITY_EXTENSION_URL,
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
          url: ODOS_WHOLESALE_COST_EXTENSION_URL,
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
    (extension) => extension.url === ODOS_WHOLESALE_COST_EXTENSION_URL,
  )?.valueMoney?.value;
  return typeof value === "number" ? Math.round(value * 100) : undefined;
}

function childExtensionCode(extension: Extension | undefined, url: string): string {
  return extension?.extension?.find((child) => child.url === url)?.valueCode ?? "";
}

function childExtensionString(extension: Extension | undefined, url: string): string {
  return extension?.extension?.find((child) => child.url === url)?.valueString ?? "";
}

function hasCatalogKind(
  resource: ChargeItemDefinition,
  kind: "contact-lens-pricing",
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
