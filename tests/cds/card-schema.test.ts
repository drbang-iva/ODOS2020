import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCdsCard } from "../../mcp/src/cds/card-schema.js";

const baseCard = {
  uuid: "7b8f9d21-2d38-4d6b-a7f8-b7c172f9c2cc",
  summary: "Review local CDS guidance",
  indicator: "info",
  source: { label: "OSOD" },
  dsi_type: "rules-based",
  intervention_risk_management: {
    risk_identification: "FHIR-coded context only.",
    risk_mitigation: "Clinician decides whether to act.",
    continual_monitoring: "Feedback and stale-card audits are reviewed.",
  },
  source_attributes: {
    developer_identity: "PerformanceOD / OSOD",
    funding_source: "OSOD open-source project",
    evidence_basis_citation: "v0.55c verification ledger rows 28-35",
  },
};

test("v0.55c CDS card schema requires HTI-1 DSI fields", () => {
  assert.equal(validateCdsCard(baseCard).valid, true);
  const missing = { ...baseCard, source_attributes: undefined };
  const result = validateCdsCard(missing);
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("source_attributes is required"), true);
});

test("v0.55c predictive CDS cards require predictive-specific disclosure fields", () => {
  const predictive = { ...baseCard, dsi_type: "predictive" };
  const result = validateCdsCard(predictive);
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("training_data_demographics is required for predictive cards"), true);
  assert.equal(result.errors.includes("algorithmic_validity_bounds is required for predictive cards"), true);
});

test("v0.55c CDS card schema rejects executable card payloads", () => {
  const script = { ...baseCard, detail: "<script>alert('x')</script>" };
  assert.equal(validateCdsCard(script).valid, false);
  const executableSuggestion = {
    ...baseCard,
    suggestions: [{ uuid: "s1", label: "Run", actions: [{ type: "create", description: "x", body: "exec" }] }],
  };
  assert.equal(validateCdsCard(executableSuggestion).valid, false);
});

test("v0.55d agent-origin CDS cards require initiation_mode and agent_device_reference", () => {
  const missing = validateCdsCard(baseCard, { agentOrigin: true });
  assert.equal(missing.valid, false);
  assert.equal(missing.errors.includes("initiation_mode is required"), true);
  assert.equal(missing.errors.includes("agent_device_reference is required"), true);

  const agentCard = {
    ...baseCard,
    initiation_mode: "user-initiated",
    agent_device_reference: "Device/iris",
  };
  assert.equal(validateCdsCard(agentCard, { agentOrigin: true }).valid, true);
});
