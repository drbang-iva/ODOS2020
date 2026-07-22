import assert from "node:assert/strict";
import { test } from "node:test";
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

test("MCP billing identity loader binds its search to the deterministic singleton id", async () => {
  const canonical = { ...mcpBuild(config), id: mcpResourceId };
  let searchParams: Record<string, string> | undefined;
  const loaded = await mcpLoad({
    async search(_resourceType, params) {
      searchParams = params;
      return {
        resourceType: "Bundle",
        type: "searchset",
        entry: [{ resource: canonical }],
      };
    },
  });

  assert.deepEqual(searchParams, {
    _id: mcpResourceId,
    code: `${mcpSystem}|${mcpCode}`,
    _count: "1",
  });
  assert.deepEqual(loaded, config);
});

test("UI and MCP billing identity validation reject the same invalid NPI check digit", () => {
  const invalid = { ...config, npi: "1111111111" };
  assert.throws(() => mcpValidate(invalid), /NPI check digit is invalid/);
  assert.throws(() => uiValidate(invalid), /NPI check digit is invalid/);
});
