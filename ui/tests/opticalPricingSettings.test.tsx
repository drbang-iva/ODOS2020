import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bundle, ChargeItemDefinition } from "@medplum/fhirtypes";
import {
  ODOS_WHOLESALE_COST_EXTENSION_URL,
  buildContactLensPricingResource,
  buildFramePricingResource,
  contactLensPricingAdapter,
  framePricingAdapter,
  type ContactLensPricingItem,
  type FramePricingItem,
} from "../src/lib/optical-pricing-catalog";
import {
  contactLensPricingDescriptor,
  framePricingDescriptor,
} from "../src/scenes/settings/OpticalPricingSettings";

test("frame pricing adapter edits existing frame rules without creating parallel frame identity", async () => {
  const item: FramePricingItem = {
    id: "frame-rule-1",
    active: true,
    catalogCanonicalUrl: "https://odos2020.com/catalog/frames/SKU-1",
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
  assert.equal(writes.at(-1)?.extension?.find((extension) => extension.url === ODOS_WHOLESALE_COST_EXTENSION_URL)?.valueMoney?.value, 51);
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
