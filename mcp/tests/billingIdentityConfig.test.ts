import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBillingIdentityResource,
  parseBillingIdentityConfig,
  validateBillingIdentityConfig,
  type BillingIdentityConfig,
} from "../src/claims/billing-identity-config.js";

const config: BillingIdentityConfig = {
  name: "Synthetic Eye Care",
  npi: "1111111112",
  taxId: "900000001",
  taxIdType: "E",
  taxonomy: "152W00000X",
  address1: "1 Test Way",
  city: "Testville",
  state: "ny",
  zip: "10001-0001",
  phone: "555-555-0100",
};

test("billing identity round-trips one coded Basic while preserving identity", () => {
  const existing = buildBillingIdentityResource(config);
  existing.id = "billing-identity-1";
  existing.meta = { versionId: "7" };
  const resource = buildBillingIdentityResource(config, existing);
  assert.equal(resource.id, "billing-identity-1");
  assert.equal(resource.meta?.versionId, "7");
  assert.deepEqual(parseBillingIdentityConfig(resource), { ...config, state: "NY" });
  assert.equal(resource.extension?.length, 1);
});

test("billing identity validates required clearinghouse defaults before persistence", () => {
  assert.doesNotThrow(() => validateBillingIdentityConfig(config));
  assert.throws(() => validateBillingIdentityConfig({ ...config, npi: "123" }), /NPI must be exactly 10 digits/);
  assert.throws(() => validateBillingIdentityConfig({ ...config, npi: "1111111111" }), /NPI check digit is invalid/);
  assert.throws(() => validateBillingIdentityConfig({ ...config, taxId: "" }), /Tax ID must be exactly 9 digits/);
  assert.throws(() => validateBillingIdentityConfig({ ...config, taxonomy: "" }), /Taxonomy is required/);
  assert.throws(() => validateBillingIdentityConfig({ ...config, state: "New York" }), /2-letter abbreviation/);
});

test("billing identity parser rejects another Basic and malformed JSON", () => {
  const resource = buildBillingIdentityResource(config);
  resource.code.coding![0]!.code = "other";
  assert.throws(() => parseBillingIdentityConfig(resource), /not the odos billing-identity-config singleton/);
  const malformed = buildBillingIdentityResource(config);
  malformed.extension![0]!.valueString = "{";
  assert.throws(() => parseBillingIdentityConfig(malformed), /JSON is malformed/);
});
