import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCanonicalCdsService } from "../../mcp/src/cds/service-registry.js";

const baseRegistration = {
  service_id: "mandate-8-cds",
  title: "Mandate 8 CDS",
  description: "Mandate 8 registration fixture.",
  endpoint_url: "https://cds.example.test/hooks/mandate-8",
  cds_risk_class: "LOW" as const,
  phi_boundary: "read-only" as const,
  launch_mode: "cds-service" as const,
  network_egress: "none" as const,
  external_services_required: false,
  baa_required: false,
  image_analysis_prohibited: true,
  allowedJurisdictions: [],
  prohibitedStates: [],
  scope_request_canonical: "system/Observation.rs",
  hook_subscriptions: ["order-sign" as const],
  card_ttl_minutes: 60,
  request_timeout_seconds: 10,
  admin_review_approved: true,
};

test("v0.55c Mandate 8 amended coverage blocks BAA-required CDS registration without admin confirmation", () => {
  assert.throws(
    () => buildCanonicalCdsService({ ...baseRegistration, baa_required: true }),
    /BAA confirmation is required/,
  );
});

test("v0.55c Mandate 8 amended coverage blocks patient-engagement-vendor CDS registration", () => {
  assert.throws(
    () => buildCanonicalCdsService({ ...baseRegistration, patient_engagement_vendor_profile: true }),
    /patient-engagement CDS services are outside v0.55c scope/,
  );
});
