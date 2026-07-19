import { useMemo } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import { fhir } from "../../lib/fhir";
import {
  contactLensPricingAdapter,
  framePricingAdapter,
  type ContactLensPricingItem,
  type FramePricingItem,
} from "../../lib/optical-pricing-catalog";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "./CatalogEditor";

export function OpticalPricingSettings({ canWrite }: { canWrite: boolean }) {
  const frameAdapter = useMemo(() => framePricingAdapter(fhir), []);
  const contactLensAdapter = useMemo(() => contactLensPricingAdapter(fhir), []);
  const frameDescriptor = useMemo(
    () => framePricingDescriptor(frameAdapter),
    [frameAdapter],
  );
  const contactLensDescriptor = useMemo(
    () => contactLensPricingDescriptor(contactLensAdapter),
    [contactLensAdapter],
  );

  return (
    <CatalogScene title="Optical pricing" canWrite={canWrite}>
      {!canWrite && (
        <div className="border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
          Read only. Practice-admin access is required to edit optical pricing.
        </div>
      )}
      <CatalogSection descriptor={frameDescriptor} canWrite={canWrite} />
      <CatalogSection descriptor={contactLensDescriptor} canWrite={canWrite} />
    </CatalogScene>
  );
}

export function framePricingDescriptor(
  adapter: CatalogAdapter<FramePricingItem>,
): CatalogDescriptor<FramePricingItem> {
  return {
    title: "Frame pricing",
    singularLabel: "frame price",
    adapter,
    canCreate: false,
    fields: [
      { type: "currency", key: "wholesaleCostCents", label: "Wholesale cost", min: 0 },
      { type: "currency", key: "retailPriceCents", label: "Retail price", required: true, min: 0 },
    ],
    createItem: () => ({
      id: "",
      active: true,
      catalogCanonicalUrl: "",
      retailPriceCents: 0,
    }),
    label: (item) => decodeURIComponent(item.catalogCanonicalUrl.split("/").at(-1) ?? "Frame"),
    facts: (item) => [
      `${money(item.retailPriceCents)} retail`,
      item.wholesaleCostCents === undefined
        ? "Wholesale TBD"
        : `${money(item.wholesaleCostCents)} wholesale`,
    ],
    readOnlyFacts: (item) => [
      { label: "Frame catalog item", value: item.catalogCanonicalUrl },
    ],
    listGrammar: {
      searchPlaceholder: "Search frame pricing",
      searchText: (item) => `${item.catalogCanonicalUrl} ${item.retailPriceCents} ${item.wholesaleCostCents ?? ""}`,
      deactivateConsequence: () => "The frame keeps its catalog identity and pricing history; this pricing row becomes inactive.",
    },
  };
}

export function contactLensPricingDescriptor(
  adapter: CatalogAdapter<ContactLensPricingItem>,
): CatalogDescriptor<ContactLensPricingItem> {
  return {
    title: "Contact lens pricing",
    singularLabel: "contact lens price",
    adapter,
    fields: [
      { type: "text", key: "manufacturerCode", label: "Brand code", required: true },
      { type: "text", key: "manufacturerDisplay", label: "Brand", required: true },
      { type: "text", key: "productCode", label: "Product code", required: true },
      { type: "text", key: "productDisplay", label: "Product name", required: true },
      { type: "currency", key: "wholesaleCostCents", label: "Wholesale cost", min: 0 },
      { type: "currency", key: "retailPriceCents", label: "Retail price", required: true, min: 0 },
    ],
    createItem: () => ({
      id: `contact-lens-price-${crypto.randomUUID()}`,
      active: true,
      manufacturerCode: "",
      manufacturerDisplay: "",
      productCode: "",
      productDisplay: "",
      retailPriceCents: 0,
    }),
    label: (item) => item.productDisplay,
    chips: (item) => [item.manufacturerDisplay],
    facts: (item) => [
      `${money(item.retailPriceCents)} retail`,
      item.wholesaleCostCents === undefined
        ? "Wholesale TBD"
        : `${money(item.wholesaleCostCents)} wholesale`,
    ],
    listGrammar: {
      searchPlaceholder: "Search contact lens pricing",
      searchText: (item) => `${item.manufacturerCode} ${item.manufacturerDisplay} ${item.productCode} ${item.productDisplay}`,
      deactivateConsequence: (item) => `${item.productDisplay || "This contact lens price"} remains in historical records and leaves the active pricing list.`,
    },
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
