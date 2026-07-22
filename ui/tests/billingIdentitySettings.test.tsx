import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Basic } from "@medplum/fhirtypes";
import {
  BillingIdentitySettingsReady,
  type BillingIdentitySettingsClient,
} from "../src/scenes/settings/BillingIdentitySettings";
import {
  buildBillingIdentityResource,
  parseBillingIdentityConfig,
  type BillingIdentityConfig,
} from "../src/scenes/settings/billing-identity-config";

const config: BillingIdentityConfig = {
  name: "Synthetic Eye Care",
  npi: "1111111112",
  taxId: "900000001",
  taxIdType: "E",
  taxonomy: "152W00000X",
  address1: "1 Test Way",
  city: "Testville",
  state: "NY",
  zip: "10001",
};

function clientFixture() {
  const writes: Array<{ resource: Basic; sourceTag: string }> = [];
  const client = {
    async search() { return { resourceType: "Bundle" as const, type: "searchset" as const }; },
    async searchUrl() { return { resourceType: "Bundle" as const, type: "searchset" as const }; },
    async update<T extends Basic>(resource: T, sourceTag: string) {
      writes.push({ resource, sourceTag });
      return resource;
    },
  };
  return { client: client as BillingIdentitySettingsClient, writes };
}

test("billing identity is one plain practice form rather than a catalog", () => {
  const fixture = clientFixture();
  const html = renderToStaticMarkup(
    <BillingIdentitySettingsReady config={config} canWrite client={fixture.client} />,
  );
  for (const label of ["Practice name", "NPI", "Taxonomy", "Tax ID", "Address", "City", "State", "ZIP"]) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(html, /Catalog|Add row|Deactivate/);
  assert.match(html, /Save billing identity/);
});

test("practice-admin saves the deterministic billing identity Basic", async () => {
  const fixture = clientFixture();
  const resource = { ...buildBillingIdentityResource(config), id: "billing-identity-1", meta: { versionId: "4" } };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <BillingIdentitySettingsReady config={config} resource={resource} canWrite client={fixture.client} />,
    );
  });
  await act(async () => {
    await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0]?.sourceTag, "billing-identity-config");
  assert.equal(fixture.writes[0]?.resource.id, "billing-identity-1");
  assert.deepEqual(parseBillingIdentityConfig(fixture.writes[0]!.resource), config);
  act(() => renderer.unmount());
});

test("billing identity is read-only outside practice-admin", () => {
  const fixture = clientFixture();
  const html = renderToStaticMarkup(
    <BillingIdentitySettingsReady config={config} canWrite={false} client={fixture.client} />,
  );
  assert.match(html, /Practice-admin access is required/);
  assert.doesNotMatch(html, /Save billing identity/);
  assert.ok((html.match(/disabled=""/g) ?? []).length >= 10);
});
