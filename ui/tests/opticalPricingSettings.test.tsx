import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition } from "@medplum/fhirtypes";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LENS_PRICING_SEEDS,
  OSOD_WHOLESALE_COST_EXTENSION_URL,
  buildContactLensPricingResource,
  buildFramePricingResource,
  buildLensPricingResource,
  contactLensPricingAdapter,
  framePricingAdapter,
  lensPricingAdapter,
  type ContactLensPricingItem,
  type FramePricingItem,
  type LensPricingItem,
} from "../src/lib/optical-pricing-catalog";
import {
  contactLensPricingDescriptor,
  framePricingDescriptor,
  lensPricingDescriptor,
} from "../src/scenes/settings/OpticalPricingSettings";
import { CatalogSection } from "../src/scenes/settings/CatalogEditor";

test("lens pricing seeds exactly the four verified per-lens retail values without guessed labs or wholesale costs", () => {
  assert.deepEqual(
    LENS_PRICING_SEEDS.map((row) => ({
      label: row.label,
      category: row.category,
      billingCode: row.billingCode,
      lab: row.lab,
      perLensWholesaleCostCents: row.perLensWholesaleCostCents,
      perLensRetailPriceCents: row.perLensRetailPriceCents,
    })),
    [
      { label: "Bifocal (flat top)", category: "design", billingCode: "", lab: "", perLensWholesaleCostCents: undefined, perLensRetailPriceCents: 6250 },
      { label: "Progressive add-on", category: "design", billingCode: "V2781", lab: "", perLensWholesaleCostCents: undefined, perLensRetailPriceCents: 8200 },
      { label: "AR basic", category: "treatment", billingCode: "", lab: "", perLensWholesaleCostCents: undefined, perLensRetailPriceCents: 6915 },
      { label: "Prism (per diopter)", category: "treatment", billingCode: "", lab: "", perLensWholesaleCostCents: undefined, perLensRetailPriceCents: 500 },
    ],
  );
  assert.equal(new Set(LENS_PRICING_SEEDS.map((row) => row.id)).size, 4);
});

test("frame pricing adapter edits existing frame rules without creating parallel frame identity", async () => {
  const item: FramePricingItem = {
    id: "frame-rule-1",
    active: true,
    catalogCanonicalUrl: "https://osod.dev/catalog/frames/SKU-1",
    wholesaleCostCents: 4700,
    retailPriceCents: 19900,
  };
  const resource = { ...buildFramePricingResource(item), id: item.id };
  const writes: ChargeItemDefinition[] = [];
  const adapter = framePricingAdapter(resourceClient([resource], writes));
  const [row] = await adapter.list();

  assert.equal(row?.catalogCanonicalUrl, item.catalogCanonicalUrl);
  assert.equal(row?.wholesaleCostCents, 4700);
  assert.equal(row?.retailPriceCents, 19900);
  assert.equal(adapter.capabilities.deactivate, false);
  assert.equal("delete" in adapter, false);
  await adapter.save({ ...row!, wholesaleCostCents: 5100 });
  assert.equal(writes.at(-1)?.derivedFromUri?.[0], item.catalogCanonicalUrl);
  assert.equal(writes.at(-1)?.extension?.find((extension) => extension.url === OSOD_WHOLESALE_COST_EXTENSION_URL)?.valueMoney?.value, 51);
  assert.equal(writes.at(-1)?.propertyGroup?.[0]?.priceComponent?.[0]?.amount?.value, 199);
});

test("frame pricing descriptor is edit-only and uses the shared CatalogEditor field contract", () => {
  const descriptor = framePricingDescriptor(framePricingAdapter(resourceClient([], [])));
  assert.equal(descriptor.canCreate, false);
  assert.deepEqual(descriptor.fields.map((field) => [field.key, field.label]), [
    ["wholesaleCostCents", "Wholesale cost (cents)"],
    ["retailPriceCents", "Retail price (cents)"],
  ]);
});

test("lens pricing resource keeps wholesale metadata outside the sole retail base component", () => {
  const resource = buildLensPricingResource({
    ...LENS_PRICING_SEEDS[1]!,
    id: "lens-progressive",
    lab: "bp-digital",
    perLensWholesaleCostCents: 3100,
  });

  assert.equal(resource.propertyGroup?.[0]?.priceComponent?.length, 1);
  assert.equal(resource.propertyGroup?.[0]?.priceComponent?.[0]?.type, "base");
  assert.equal(resource.propertyGroup?.[0]?.priceComponent?.[0]?.amount?.value, 82);
  assert.equal(
    resource.extension?.find((extension) => extension.url === OSOD_WHOLESALE_COST_EXTENSION_URL)?.valueMoney?.value,
    31,
  );
  assert.equal(JSON.stringify(resource.propertyGroup).includes("31"), false);
});

test("lens resource adapter round-trips per-lab, per-lens rows and deactivates without delete", async () => {
  const writes: ChargeItemDefinition[] = [];
  const resource = buildLensPricingResource({
    ...LENS_PRICING_SEEDS[0]!,
    id: "lens-bifocal",
    lab: "bp-digital",
  });
  const client = resourceClient([resource], writes);
  const adapter = lensPricingAdapter(client);
  const [row] = await adapter.list();

  assert.equal(row?.lab, "bp-digital");
  assert.equal(row?.perLensRetailPriceCents, 6250);
  assert.equal(adapter.capabilities.reorder, false);
  assert.equal("delete" in adapter, false);
  const retired = await adapter.deactivate(row!);
  assert.equal(retired.active, false);
  assert.equal(writes.at(-1)?.status, "retired");
});

test("persisting one lens seed does not hide the other three verified defaults", async () => {
  const persistedProgressive = {
    ...buildLensPricingResource({
      ...LENS_PRICING_SEEDS[1]!,
      lab: "bp-digital",
    }),
    id: "fhir-progressive-id",
  };
  const rows = await lensPricingAdapter(resourceClient([persistedProgressive], [])).list();

  assert.equal(rows.length, 4);
  assert.equal(rows.find((row) => row.label === "Progressive add-on")?.lab, "bp-digital");
  assert.deepEqual(
    rows.map((row) => row.label).sort(),
    ["AR basic", "Bifocal (flat top)", "Prism (per diopter)", "Progressive add-on"].sort(),
  );
});

test("contact-lens pricing reuses manufacturer/product identity, ships empty, and has no inventory fields", async () => {
  const item: ContactLensPricingItem = {
    id: "cl-precision1",
    active: true,
    manufacturerCode: "alcon",
    manufacturerDisplay: "Alcon",
    productCode: "precision1",
    productDisplay: "Precision1",
    wholesaleCostCents: 3200,
    retailPriceCents: 6500,
  };
  const resource = buildContactLensPricingResource(item);
  assert.equal(JSON.stringify(resource).includes("quantity"), false);
  assert.equal(JSON.stringify(resource).includes("boxCount"), false);

  const adapter = contactLensPricingAdapter(resourceClient([], []));
  assert.deepEqual(await adapter.list(), []);
  const descriptor = contactLensPricingDescriptor(adapter);
  const keys = descriptor.fields.map((field) => field.key);
  assert.deepEqual(keys, [
    "manufacturerCode",
    "manufacturerDisplay",
    "productCode",
    "productDisplay",
    "wholesaleCostCents",
    "retailPriceCents",
  ]);
  assert.equal(keys.some((key) => /quantity|box|inventory/i.test(key)), false);
});

test("shared CatalogEditor descriptors visibly label per-lens prices and group lens rows by lab", () => {
  const lensDescriptor = lensPricingDescriptor(lensPricingAdapter(resourceClient([], [])));
  assert.equal(lensDescriptor.groupBy?.label, "Lab");
  assert.equal(lensDescriptor.groupBy?.value(LENS_PRICING_SEEDS[0]!), "Unassigned lab");
  assert.equal(lensDescriptor.fields.find((field) => field.key === "perLensWholesaleCostCents")?.label, "Wholesale cost per lens (cents)");
  assert.equal(lensDescriptor.fields.find((field) => field.key === "perLensRetailPriceCents")?.label, "Retail price per lens (cents)");

  const html = renderToStaticMarkup(
    <CatalogSection
      descriptor={lensDescriptor}
      canWrite
      initialState={{ items: LENS_PRICING_SEEDS as LensPricingItem[], selectedId: LENS_PRICING_SEEDS[0]!.id }}
    />,
  );
  assert.match(html, /Wholesale cost per lens \(cents\)/);
  assert.match(html, /Retail price per lens \(cents\)/);
  assert.match(html, /Unassigned lab/);
  assert.match(html, /Bifocal \(flat top\)/);
  assert.match(html, /Search lens pricing/);
  assert.match(html, />New lens price</);
  assert.match(html, /settings-required-dot/);
  assert.match(html, />Deactivate</);
});

function resourceClient(
  resources: ChargeItemDefinition[],
  writes: ChargeItemDefinition[],
) {
  return {
    async search<T extends ChargeItemDefinition>(): Promise<Bundle<T>> {
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: resources.map((resource) => ({ resource: resource as T })),
      };
    },
    async searchUrl<T extends ChargeItemDefinition>(): Promise<Bundle<T>> {
      return { resourceType: "Bundle", type: "searchset" };
    },
    async create<T extends ChargeItemDefinition>(resource: T): Promise<T> {
      writes.push(resource);
      return { ...resource, id: resource.id ?? "created" };
    },
    async update<T extends ChargeItemDefinition>(resource: T): Promise<T> {
      writes.push(resource);
      return resource;
    },
  };
}
