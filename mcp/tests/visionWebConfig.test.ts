import assert from "node:assert/strict";
import { test } from "node:test";
import { visionWebConfigFromEnv, isVisionWebConfigured, assertVisionWebTransmission, visionWebLabAccount } from "../src/integrations/visionweb/config.js";

import { env } from "./fixtures/visionweb/support.js";
test("V1 config rejects each absent field, bad URL and every invalid account", () => {
  assert.equal(isVisionWebConfigured(visionWebConfigFromEnv(env)), true);
  for (const key of Object.keys(env)) {
    assert.equal(isVisionWebConfigured(visionWebConfigFromEnv({ ...env, [key]: undefined })), false, key);
  }
  for (const value of ["{", "[]", "null", "{}", JSON.stringify({ Demo: { supplierId: "999", billAccount: "a", shipAccount: "b" } }), JSON.stringify({ Demo: { supplierId: "9992", billAccount: null, shipAccount: "b" } }), JSON.stringify({ Good: { supplierId: "9992", billAccount: "a", shipAccount: "b" }, Bad: null })]) {
    assert.equal(isVisionWebConfigured(visionWebConfigFromEnv({ ...env, VISIONWEB_LAB_ACCOUNTS: value })), false);
  }
  for (const key of ["VISIONWEB_SOAP_URL", "VISIONWEB_TOKEN_URL", "VISIONWEB_API_BASE_URL"]) {
    for (const value of ["http://example.test", "not-a-url"]) assert.equal(isVisionWebConfigured(visionWebConfigFromEnv({ ...env, [key]: value })), false);
  }
});
test("V2 production flag is exact and V3 lab lookup uses configured keys only", () => {
  for (const flag of [undefined, "TRUE", "1"]) assert.throws(() => assertVisionWebTransmission(visionWebConfigFromEnv({ ...env, VISIONWEB_SOAP_URL: "https://production.example/upload", VISIONWEB_PRODUCTION_ENABLED: flag })), /production transmission is not enabled/);
  assert.doesNotThrow(() => assertVisionWebTransmission(visionWebConfigFromEnv({ ...env, VISIONWEB_SOAP_URL: "https://production.example/upload", VISIONWEB_PRODUCTION_ENABLED: "true" })));
  for (const lab of ["toString", "__proto__", "constructor", "Other"]) assert.throws(() => visionWebLabAccount(visionWebConfigFromEnv(env), lab), /has no account for lab/);
});
