import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Basic } from "@medplum/fhirtypes";
import {
  BillingIdentitySettingsReady,
  loadBillingIdentityConfigSingleton,
  type BillingIdentitySettingsClient,
} from "../src/scenes/settings/BillingIdentitySettings";
import {
  ODOS_BILLING_IDENTITY_CONFIG_RESOURCE_ID,
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
  const writes: Array<{ method: "create" | "update"; resource: Basic; sourceTag: string; headers?: Record<string, string> }> = [];
  const client = {
    async search() { return { resourceType: "Bundle" as const, type: "searchset" as const }; },
    async searchUrl() { return { resourceType: "Bundle" as const, type: "searchset" as const }; },
    async create<T extends Basic>(resource: T, sourceTag: string, headers?: Record<string, string>) {
      writes.push({ method: "create", resource, sourceTag, headers });
      return { ...resource, id: "server-assigned-billing-id" } as T;
    },
    async update<T extends Basic>(resource: T, sourceTag: string) {
      writes.push({ method: "update", resource, sourceTag });
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
  for (const label of ["Practice name", "NPI", "Taxonomy", "Tax ID", "Phone", "Email", "Fax", "Address", "City", "State", "ZIP"]) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(html, /Catalog|Add row|Deactivate/);
  assert.match(html, /Save billing identity/);
});

test("practice-admin updates the server-assigned billing identity Basic", async () => {
  const fixture = clientFixture();
  const resource = { ...buildBillingIdentityResource(config), id: ODOS_BILLING_IDENTITY_CONFIG_RESOURCE_ID, meta: { versionId: "4" } };
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
  assert.equal(fixture.writes[0]?.method, "update");
  assert.equal(fixture.writes[0]?.sourceTag, "billing-identity-config");
  assert.equal(fixture.writes[0]?.resource.id, ODOS_BILLING_IDENTITY_CONFIG_RESOURCE_ID);
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

test("billing identity loads the latest coded singleton without an id-bound read", async () => {
  const older = {
    ...buildBillingIdentityResource(config),
    id: "server-older",
    meta: { lastUpdated: "2026-07-21T12:00:00Z" },
  };
  const newer = {
    ...buildBillingIdentityResource({ ...config, name: "Newest Synthetic Eye Care" }),
    id: "server-newer",
    meta: { lastUpdated: "2026-07-22T12:00:00Z" },
  };
  const loaded = await loadBillingIdentityConfigSingleton({
    async search(resourceType, params) {
      assert.equal(resourceType, "Basic");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(params)), {
        code: "https://odos2020.com/fhir/CodeSystem/billing-identity-config|odos-billing-identity-config",
        _sort: "-_lastUpdated",
        _count: "1",
      });
      return { resourceType: "Bundle", type: "searchset", entry: [{ resource: newer }, { resource: older }] };
    },
  });

  assert.equal(loaded.resource?.id, "server-newer");
  assert.equal(loaded.config?.name, "Newest Synthetic Eye Care");
});

test("billing identity first save posts without a client id and keeps the server-assigned id", async () => {
  const fixture = clientFixture();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <BillingIdentitySettingsReady config={config} canWrite client={fixture.client} />,
    );
  });
  await act(async () => {
    await renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  assert.equal(fixture.writes[0]?.method, "create");
  assert.equal(fixture.writes[0]?.resource.id, undefined);
  assert.deepEqual(fixture.writes[0]?.headers, {
    "If-None-Exist": "code=https://odos2020.com/fhir/CodeSystem/billing-identity-config|odos-billing-identity-config",
  });
  assert.match(renderer.root.findByProps({ role: "status" }).children.join(""), /saved/i);
  act(() => renderer.unmount());
});
