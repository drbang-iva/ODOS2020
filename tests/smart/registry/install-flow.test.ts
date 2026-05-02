import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCanonicalSmartClientApp } from "../../../mcp/src/smart/registration/smart-client-app.js";
import {
  InMemorySmartAppInstallationRepository,
  reviewSmartAppInstall,
} from "../../../mcp/src/smart/registration/install-flow.js";

test("v0.55b install flow blocks SC autonomous-refraction app and records the block reason", () => {
  const app = buildCanonicalSmartClientApp({
    redirect_uris: ["http://127.0.0.1:5173/callback"],
    token_endpoint_auth_method: "none",
    scope: "user/Observation.rs",
    scope_request_canonical: "user/Observation.rs",
    client_name: "Synthetic Autonomous Refraction Fixture",
    risk_class: "autonomous-refraction",
    phi_boundary: "metadata-only",
    launch_mode: "standalone",
    network_egress: "local-only",
    external_services_required: false,
    baa_required: false,
    image_analysis_prohibited: true,
    allowedJurisdictions: ["US"],
    prohibitedStates: ["US-SC"],
  });
  const repository = new InMemorySmartAppInstallationRepository();
  const result = reviewSmartAppInstall({
    app,
    repository,
    adminUserId: "admin-1",
    adminRole: "practice-admin",
    practiceJurisdiction: "US-SC",
    now: "2026-05-01T12:00:00.000Z",
  });
  assert.equal(result.installation, undefined);
  assert.equal(repository.records[0]?.installState, "blocked");
  assert.match(repository.records[0]?.blockReason ?? "", /SC ECCPL ruling 2026-01-21/);
  assert.equal(result.auditRows[0]?.eventType, "smart-app-jurisdiction-blocked");
  assert.equal(result.auditRows[0]?.actionOutcome, "denied");
});
