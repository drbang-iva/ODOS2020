import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCanonicalSmartClientApp, SmartAppRegistryError } from "../../mcp/src/smart/registration/smart-client-app.js";
import { runVendorCanonicalShapePass } from "../../scripts/preflight-lint.ts";

const baseBulkDataClient = {
  redirect_uris: ["http://127.0.0.1:5173/bulk/callback"],
  token_endpoint_auth_method: "private_key_jwt" as const,
  jwks_uri: "http://127.0.0.1:8181/.well-known/jwks.json",
  scope: "system/Patient.rs system/Observation.rs system/Group.rs",
  scope_request_canonical: "system/Patient.rs system/Observation.rs system/Group.rs",
  client_name: "Local Bulk Export Client",
  risk_class: "high" as const,
  phi_boundary: "patient-payload" as const,
  launch_mode: "backend" as const,
  network_egress: "local-only" as const,
  external_services_required: false,
  baa_required: true,
  image_analysis_prohibited: true,
  allowedJurisdictions: ["US"],
  prohibitedStates: [],
};

test("v0.55e blocks Bulk Data registration when vendor is not BAA eligible", () => {
  assert.throws(
    () =>
      buildCanonicalSmartClientApp({
        ...baseBulkDataClient,
        vendor_baa_eligible: false,
        practice_baa_or_contract_attested_at: "2026-05-05T00:00:00.000Z",
      }),
    (error) => error instanceof SmartAppRegistryError && error.status === 403 && error.code === "vendor-baa-not-eligible",
  );
});

test("v0.55e blocks Bulk Data registration until the local practice attests its BAA or contract", () => {
  assert.throws(
    () =>
      buildCanonicalSmartClientApp({
        ...baseBulkDataClient,
        vendor_baa_eligible: true,
      }),
    (error) =>
      error instanceof SmartAppRegistryError &&
      error.status === 403 &&
      error.code === "practice-baa-attestation-required",
  );

  const app = buildCanonicalSmartClientApp({
    ...baseBulkDataClient,
    vendor_baa_eligible: true,
    practice_baa_or_contract_attested_at: "2026-05-05T00:00:00.000Z",
  });
  assert.equal(app.policy.vendorBaaEligible, true);
  assert.equal(app.policy.practiceBaaOrContractAttestedAt, "2026-05-05T00:00:00.000Z");
});

test("v0.55e blocks image-byte-to-LLM Bulk Data paths at build and registration boundaries", () => {
  const imagePayloadLint = runVendorCanonicalShapePass({
    files: [
      {
        path: "mcp/src/bulk-data/bad.ts",
        text: "anthropic.messages.create({ body: Buffer.from('image/png') });\n",
      },
    ],
  });
  assert.equal(imagePayloadLint.status, "hard-block");
  assert.equal(imagePayloadLint.findings[0]?.code, "agentops-image-payload-to-llm-block");

  assert.throws(
    () =>
      buildCanonicalSmartClientApp({
        ...baseBulkDataClient,
        vendor_baa_eligible: true,
        practice_baa_or_contract_attested_at: "2026-05-05T00:00:00.000Z",
        image_analysis_prohibited: false,
      }),
    /image analysis is prohibited/,
  );
});
