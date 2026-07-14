import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basic, Bundle } from "@medplum/fhirtypes";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { addFrameToInventory, type FrameCatalogItem, type PracticeFrameInventoryItem } from "../src/lib/optical-frames";
import { OpticalFrames } from "../src/scenes/OpticalFrames";

const CATALOG_URL = "https://osod.dev/catalog/frames/SKU-100";
const CATALOG_ITEM: FrameCatalogItem = {
  canonicalUrl: CATALOG_URL,
  sku: "SKU-100",
  display: "Test Frame",
  manufacturer: "OSOD",
  properties: {},
  publicityClass: "open",
};

test("addFrameToInventory creates qty 1 with the inventory extensions, AuditEvent, and Provenance", async () => {
  let transaction: Bundle | undefined;
  const result = await withFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/Basic?") && (!init?.method || init.method === "GET")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset" });
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      transaction = JSON.parse(String(init.body)) as Bundle;
      return jsonResponse({
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: "201 Created", location: "Basic/inventory-1/_history/1" } },
          { response: { status: "201 Created", location: "AuditEvent/audit-1/_history/1" } },
          { response: { status: "201 Created", location: "Provenance/provenance-1/_history/1" } },
        ],
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, () => addFrameToInventory(CATALOG_ITEM));

  assert.equal(result.id, "inventory-1");
  assert.equal(result.qtyOnHand, 1);
  assert.equal(result.status, "active");
  assert.equal(transaction?.entry?.length, 3);
  const inventory = transaction?.entry?.[0]?.resource as Basic;
  assert.equal(transaction?.entry?.[0]?.request?.method, "POST");
  assert.equal(inventory.code?.coding?.[0]?.code, "practice-frame-inventory");
  assert.deepEqual(inventory.extension, [
    { url: "https://osod.dev/fhir/StructureDefinition/catalog-canonical-url", valueString: CATALOG_URL },
    { url: "https://osod.dev/fhir/StructureDefinition/qty-on-hand", valueInteger: 1 },
    { url: "https://osod.dev/fhir/StructureDefinition/inventory-status", valueString: "active" },
  ]);
  assert.equal(inventory.extension?.some((extension) => extension.url?.includes("dispensary-location")), false);
  assert.equal(inventory.extension?.some((extension) => extension.url?.includes("sale-price-cents")), false);
  assert.equal(transaction?.entry?.[1]?.resource?.resourceType, "AuditEvent");
  assert.equal(transaction?.entry?.[2]?.resource?.resourceType, "Provenance");
});

test("addFrameToInventory reads the current version and increments through an audited transaction PATCH", async () => {
  const existing: Basic = {
    resourceType: "Basic",
    id: "inventory-1",
    extension: [
      { url: "https://osod.dev/fhir/StructureDefinition/catalog-canonical-url", valueString: CATALOG_URL },
      { url: "https://osod.dev/fhir/StructureDefinition/qty-on-hand", valueInteger: 2 },
      { url: "https://osod.dev/fhir/StructureDefinition/inventory-status", valueString: "active" },
    ],
  };
  const current: Basic = { ...existing, meta: { versionId: "7" }, extension: existing.extension?.map((extension) => extension.url?.includes("qty-on-hand") ? { ...extension, valueInteger: 4 } : extension) };
  let transaction: Bundle | undefined;

  const result = await withFetch(async (input, init) => {
    const url = String(input);
    if (url.includes("/Basic?") && (!init?.method || init.method === "GET")) {
      return jsonResponse({ resourceType: "Bundle", type: "searchset", entry: [{ resource: existing }] });
    }
    if (url.endsWith("/Basic/inventory-1") && (!init?.method || init.method === "GET")) {
      return jsonResponse(current);
    }
    if (url.endsWith("/fhir/R4") && init?.method === "POST") {
      transaction = JSON.parse(String(init.body)) as Bundle;
      return jsonResponse({
        resourceType: "Bundle",
        type: "transaction-response",
        entry: [
          { response: { status: "200 OK", location: "Basic/inventory-1/_history/8" } },
          { response: { status: "201 Created", location: "AuditEvent/audit-1/_history/1" } },
          { response: { status: "201 Created", location: "Provenance/provenance-1/_history/1" } },
        ],
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  }, () => addFrameToInventory(CATALOG_ITEM));

  assert.equal(result.qtyOnHand, 5);
  assert.equal(transaction?.entry?.length, 3);
  const patchEntry = transaction?.entry?.[0];
  assert.equal(patchEntry?.request?.method, "PATCH");
  assert.equal(patchEntry?.request?.url, "Basic/inventory-1");
  assert.equal(patchEntry?.request?.ifMatch, 'W/"7"');
  const patch = JSON.parse(Buffer.from((patchEntry?.resource as { data?: string }).data ?? "", "base64").toString("utf8"));
  assert.deepEqual(patch, [{ op: "replace", path: "/extension/1/valueInteger", value: 5 }]);
  assert.equal(transaction?.entry?.[1]?.resource?.resourceType, "AuditEvent");
  assert.equal(transaction?.entry?.[2]?.resource?.resourceType, "Provenance");
});

test("Catalog Add disables per row while pending and sends failures to the scene error surface", async () => {
  let resolveAdd!: (value: PracticeFrameInventoryItem) => void;
  const pendingAdd = new Promise<PracticeFrameInventoryItem>((resolve) => { resolveAdd = resolve; });
  const api = {
    searchCatalog: async () => [CATALOG_ITEM],
    loadInventory: async () => [],
    addToInventory: async () => pendingAdd,
  };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<OpticalFrames route="catalog" api={api} />); });
  const button = renderer.root.findAllByType("button").find((candidate) => candidate.children.join("") === "Add");
  assert.ok(button);
  act(() => button.props.onClick());
  assert.equal(button.props.disabled, true);
  assert.equal(button.children.join(""), "Adding…");
  await act(async () => resolveAdd({ id: "inventory-1", canonicalUrl: CATALOG_URL, qtyOnHand: 1, status: "active" }));
  assert.equal(button.props.disabled, false);
  assert.equal(button.children.join(""), "Added ✓");

  const failingApi = { ...api, addToInventory: async () => { throw new Error("Inventory write failed"); } };
  await act(async () => { renderer.update(<OpticalFrames route="catalog" api={failingApi} />); });
  const retry = renderer.root.findAllByProps({ className: "sidebar-button w-full" })[0];
  assert.ok(retry);
  await act(async () => { retry.props.onClick(); await Promise.resolve(); });
  assert.equal(renderer.root.findByProps({ role: "alert" }).children.join(""), "Inventory write failed");
});

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchImpl });
  try {
    return await run();
  } finally {
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/fhir+json" } });
}
