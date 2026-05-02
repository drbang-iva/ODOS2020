import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateSmartClientAppStructureDefinition } from "../../../scripts/validate-structure-definition.ts";
import {
  buildCanonicalSmartClientApp,
  readSmartClientApp,
} from "../../../mcp/src/smart/registration/smart-client-app.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("v0.55b smart-client-app StructureDefinition and Endpoint extension expose all required fields", () => {
  const issues = validateSmartClientAppStructureDefinition(
    resolve(REPO_ROOT, "data/canonical-extensions/smart-client-app.json"),
  );
  assert.deepEqual(issues, []);

  const app = buildCanonicalSmartClientApp({
    redirect_uris: ["http://127.0.0.1:5173/callback"],
    token_endpoint_auth_method: "none",
    scope: "user/Observation.rs",
    scope_request_canonical: "user/Observation.rs",
    client_name: "All Fields SMART App",
    launch_uri: "http://127.0.0.1:5173/launch",
    allowed_origin: ["http://127.0.0.1:5173"],
    risk_class: "low",
    phi_boundary: "metadata-only",
    launch_mode: "ehr-and-standalone",
    network_egress: "local-only",
    external_services_required: false,
    baa_required: false,
    image_analysis_prohibited: true,
    allowedJurisdictions: ["US"],
    prohibitedStates: ["US-SC"],
  });
  const parsed = readSmartClientApp(app.canonicalRecord);
  assert.equal(parsed.metadata.clientType, "public");
  assert.equal(parsed.metadata.tokenEndpointAuthMethod, "none");
  assert.deepEqual(parsed.metadata.redirectUris, ["http://127.0.0.1:5173/callback"]);
  assert.equal(parsed.metadata.launchUri, "http://127.0.0.1:5173/launch");
  assert.equal(parsed.metadata.defaultScope, "user/Observation.rs");
  assert.deepEqual(parsed.metadata.allowedOrigin, ["http://127.0.0.1:5173"]);
  assert.equal(parsed.policy.riskClass, "low");
  assert.equal(parsed.policy.phiBoundary, "metadata-only");
  assert.equal(parsed.policy.launchMode, "ehr-and-standalone");
  assert.equal(parsed.policy.networkEgress, "local-only");
  assert.equal(parsed.policy.externalServicesRequired, false);
  assert.equal(parsed.policy.baaRequired, false);
  assert.equal(parsed.policy.imageAnalysisProhibited, true);
  assert.deepEqual(parsed.policy.allowedJurisdictions, ["US"]);
  assert.deepEqual(parsed.policy.prohibitedStates, ["US-SC"]);
  assert.equal(parsed.policy.scopeRequestCanonical, "user/Observation.rs");
});
