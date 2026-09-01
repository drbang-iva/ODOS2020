import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Basic } from "@medplum/fhirtypes";
import { createLiveAuthorizationClients, loadRepoEnv, requireMedplumAdmin } from "./integration-helpers.js";
import {
  ODOS_BILLING_IDENTITY_CONFIG_CODE as mcpCode,
  ODOS_BILLING_IDENTITY_CONFIG_RESOURCE_ID as mcpResourceId,
  ODOS_BILLING_IDENTITY_CONFIG_SYSTEM as mcpSystem,
  buildBillingIdentityResource as mcpBuild,
  loadBillingIdentityConfig as mcpLoad,
  parseBillingIdentityConfig as mcpParse,
  validateBillingIdentityConfig as mcpValidate,
  type BillingIdentityConfig,
} from "../src/claims/billing-identity-config.js";
import {
  ODOS_BILLING_IDENTITY_CONFIG_CODE as uiCode,
  ODOS_BILLING_IDENTITY_CONFIG_RESOURCE_ID as uiResourceId,
  ODOS_BILLING_IDENTITY_CONFIG_SYSTEM as uiSystem,
  buildBillingIdentityResource as uiBuild,
  parseBillingIdentityConfig as uiParse,
  validateBillingIdentityConfig as uiValidate,
} from "../../ui/src/scenes/settings/billing-identity-config.js";

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

test("UI billing identity mirror matches the MCP coded singleton wire shape", () => {
  assert.equal(uiSystem, mcpSystem);
  assert.equal(uiCode, mcpCode);
  assert.equal(uiResourceId, mcpResourceId);
  assert.deepEqual(uiBuild(config), mcpBuild(config));
  assert.deepEqual(uiParse(uiBuild(config)), mcpParse(mcpBuild(config)));
});

test("MCP billing identity loader searches by code and uses the latest server-assigned singleton", async () => {
  const older = { ...mcpBuild(config), id: "server-older", meta: { lastUpdated: "2026-07-21T12:00:00Z" } };
  const latestConfig = { ...config, name: "Latest Synthetic Eye Care" };
  const latest = { ...mcpBuild(latestConfig), id: "server-latest", meta: { lastUpdated: "2026-07-22T12:00:00Z" } };
  let searchParams: Record<string, string> | undefined;
  const loaded = await mcpLoad({
    async search(_resourceType, params) {
      searchParams = params;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: latest }, { resource: older }],
      };
    },
  });

  assert.deepEqual(searchParams, {
    code: `${mcpSystem}|${mcpCode}`,
    _sort: "-_lastUpdated",
    _count: "1",
  });
  assert.deepEqual(loaded, latestConfig);
});

test("UI and MCP billing identity validation reject the same invalid NPI check digit", () => {
  const invalid = { ...config, npi: "1111111111" };
  assert.throws(() => mcpValidate(invalid), /NPI check digit is invalid/);
  assert.throws(() => uiValidate(invalid), /NPI check digit is invalid/);
});

test("real Medplum assigns ids and reloads coded Basic singletons", { timeout: 90_000 }, async (t) => {
  loadRepoEnv();
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103";
  const credentials = requireMedplumAdmin(
    t,
    "billingIdentityConfigParity",
    "MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD are required for the singleton persistence integration test.",
  );
  if (!credentials) {
    return;
  }
  const { email, password } = credentials;

  const { seederFhir: fhir, seederAccessToken: accessToken } = await createLiveAuthorizationClients({
    baseUrl,
    email,
    password,
  });
  const runId = randomUUID();
  const createdIds: string[] = [];
  try {
    const probeId = `billing-identity-config-probe-${runId}`;
    await assert.rejects(
      fhir.update<Basic>("Basic", probeId, {
        resourceType: "Basic",
        id: probeId,
        code: { coding: [{
          system: "https://odos2020.com/fhir/CodeSystem/integration-test-singleton",
          code: `hardcoded-id-${runId}`,
        }] },
      }),
      /invalid id/i,
    );
    for (const setting of ["billing-identity", "statement-messages", "appearance"]) {
      const system = "https://odos2020.com/fhir/CodeSystem/integration-test-singleton";
      const code = `${setting}-${runId}`;
      const candidate: Basic = {
        resourceType: "Basic",
        code: { coding: [{ system, code }] },
      };
      const conditionalHeaders = { "If-None-Exist": `code=${system}|${code}` };
      const [first, second] = await Promise.all([
        fhir.create<Basic>(candidate, conditionalHeaders),
        fhir.create<Basic>(candidate, conditionalHeaders),
      ]);
      assert.ok(first.id);
      assert.equal(second.id, first.id);
      assert.notEqual(first.id, setting);
      createdIds.push(first.id);

      const reloaded = await fhir.search<Basic>("Basic", { code: `${system}|${code}`, _count: "10" });
      assert.equal(reloaded.entry?.length, 1);
      assert.equal(reloaded.entry[0]?.resource?.id, first.id);

      const updated = await fhir.update<Basic>("Basic", first.id, {
        ...first,
        extension: [{ url: "https://odos2020.com/fhir/StructureDefinition/integration-test-singleton", valueString: "updated" }],
      });
      assert.equal(updated.id, first.id);
    }
  } finally {
    for (const id of createdIds.reverse()) {
      await fetch(`${baseUrl.replace(/\/$/, "")}/fhir/R4/Basic/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  }
});
