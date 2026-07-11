import { useMemo } from "react";
import type { CatalogAdapter } from "../../lib/catalog-adapter";
import { fhir } from "../../lib/fhir";
import {
  contactLensPricingAdapter,
  framePricingAdapter,
  lensPricingAdapter,
  type ContactLensPricingItem,
  type FramePricingItem,
  type LensPricingItem,
} from "../../lib/optical-pricing-catalog";
import { useRole } from "../../lib/role-context";
import {
  CatalogScene,
  CatalogSection,
  type CatalogDescriptor,
} from "./CatalogEditor";

export function OpticalPricingSettings() {
  const { role } = useRole();
  const canWrite = role === "practice-admin";
  const frameAdapter = useMemo(() => framePricingAdapter(fhir), []);
  const lensAdapter = useMemo(() => lensPricingAdapter(fhir), []);
  const contactLensAdapter = useMemo(() => contactLensPricingAdapter(fhir), []);
  const lensDescriptor = useMemo(
    () => lensPricingDescriptor(lensAdapter),
    [lensAdapter],
  );
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
      <CatalogSection descriptor={lensDescriptor} canWrite={canWrite} />
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
      { type: "number", key: "wholesaleCostCents", label: "Wholesale cost (cents)", min: 0 },
      { type: "number", key: "retailPriceCents", label: "Retail price (cents)", required: true, min: 0 },
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
  };
}

export function lensPricingDescriptor(
  adapter: CatalogAdapter<LensPricingItem>,
): CatalogDescriptor<LensPricingItem> {
  return {
    title: "Lens pricing",
    singularLabel: "lens price",
    adapter,
    fields: [
      { type: "text", key: "lab", label: "Lab" },
      {
        type: "select",
        key: "category",
        label: "Category",
        required: true,
        options: [
          { value: "design", label: "Lens design" },
          { value: "material", label: "Material" },
          { value: "treatment", label: "Treatment" },
        ],
      },
      { type: "text", key: "label", label: "Lens item", required: true },
      { type: "text", key: "billingCode", label: "CPT/HCPCS code" },
      {
        type: "number",
        key: "perLensWholesaleCostCents",
        label: "Wholesale cost per lens (cents)",
        min: 0,
      },
      {
        type: "number",
        key: "perLensRetailPriceCents",
        label: "Retail price per lens (cents)",
        required: true,
        min: 0,
      },
    ],
    createItem: () => ({
      id: `lens-price-${crypto.randomUUID()}`,
      active: true,
      label: "",
      category: "design",
      billingCode: "",
      lab: "",
      perLensRetailPriceCents: 0,
    }),
    label: (item) => item.label,
    chips: (item) => [categoryLabel(item.category), "PER LENS"],
    facts: (item) => [
      item.billingCode || "Code TBD",
      `${money(item.perLensRetailPriceCents)} retail per lens`,
      item.perLensWholesaleCostCents === undefined
        ? "Wholesale TBD"
        : `${money(item.perLensWholesaleCostCents)} wholesale per lens`,
    ],
    groupBy: {
      label: "Lab",
      value: (item) => item.lab || "Unassigned lab",
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
      { type: "number", key: "wholesaleCostCents", label: "Wholesale cost (cents)", min: 0 },
      { type: "number", key: "retailPriceCents", label: "Retail price (cents)", required: true, min: 0 },
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
  };
}

function categoryLabel(category: LensPricingItem["category"]): string {
  return category === "design"
    ? "Lens design"
    : category === "material"
      ? "Material"
      : "Treatment";
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
