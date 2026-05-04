import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSafetyValveResponse } from "../../mcp/src/agentops/safety-valve.js";

test("v0.55d Safety Valve returns RFC 7807 problem details with dynamic status", () => {
  const response = buildSafetyValveResponse({
    rule_id: "generic-high-frequency-query-user-initiated",
    rule_version: "2026-05-04",
    threshold_class: "HIGH",
    verdict: "blocked",
    target_resourceType: "Observation",
    specific_action: "read",
    tool_name: "high-frequency-fhir-query",
    configured_exception_code: "HealthITPerformance",
    auditEventId: "audit-123",
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers["Content-Type"], "application/problem+json");
  assert.equal(response.headers["X-OSOD-Audit-Event-Id"], "audit-123");
  assert.equal(response.body?.type, "https://osod.dev/fhir/exception/171.205");
  assert.equal(response.body?.status, response.status);
  assert.equal(/rule_id|Patient\/|Device\/|agent_uri/.test(response.body?.detail ?? ""), false);
  assert.equal("X-OSOD-IB-Exception" in response.headers, false);
});

test("v0.55d Safety Valve masks care-access exception externally while retaining internal code", () => {
  const response = buildSafetyValveResponse({
    rule_id: "practice-local-protected-care-rule",
    rule_version: "2026-05-04",
    threshold_class: "CRITICAL",
    verdict: "blocked",
    target_resourceType: "Patient",
    specific_action: "read",
    tool_name: "practice-local-query",
    configured_exception_code: "ProtectingCareAccess",
    auditEventId: "audit-456",
  });
  assert.equal(response.status, 403);
  assert.equal(response.internalExceptionCode, "ProtectingCareAccess");
  assert.equal(response.body?.type, "https://osod.dev/fhir/exception/171.202");
  assert.equal(JSON.stringify(response.body).includes("ProtectingCareAccess"), false);
  assert.equal(JSON.stringify(response.body).includes("171.206"), false);
});

test("v0.55d TEFCA Manner maps to HTTP 406 problem details", () => {
  const response = buildSafetyValveResponse({
    rule_id: "tefca-qhin-manner-only",
    rule_version: "2026-05-04",
    threshold_class: "HIGH",
    verdict: "blocked",
    target_resourceType: "Bundle",
    specific_action: "read",
    tool_name: "tefca-qhin-query",
    configured_exception_code: "TEFCAManner",
    auditEventId: "audit-789",
  });
  assert.equal(response.status, 406);
  assert.equal(response.body?.type, "https://osod.dev/fhir/exception/171.403");
});
