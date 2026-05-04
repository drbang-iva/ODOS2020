import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  lookupThresholdRule,
  parseAgentOpsPolicyYaml,
} from "../../mcp/src/agentops/threshold-matrix.js";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

test("v0.55d AgentOps policy YAML loads generic and Iris defaults", () => {
  const generic = parseAgentOpsPolicyYaml(
    readFileSync(resolve(repoRoot, "data/agentops-policies/defaults/generic.yaml"), "utf8"),
    "generic.yaml",
  );
  const iris = parseAgentOpsPolicyYaml(
    readFileSync(resolve(repoRoot, "data/agentops-policies/defaults/iris-starter.yaml"), "utf8"),
    "iris-starter.yaml",
  );
  assert.equal(generic.retention.retention_years, 7);
  assert.equal(iris.policies.some((rule) => rule.rule_id === "iris-finalize-chart-summary-user-initiated"), true);
  assert.equal(
    [...generic.policies, ...iris.policies].some((rule) => rule.composite_key.initiation_mode === "autonomously-initiated"),
    false,
  );
});

test("v0.55d threshold matrix resolves Iris-specific rule before generic default", () => {
  const rules = parseAgentOpsPolicyYaml(
    readFileSync(resolve(repoRoot, "data/agentops-policies/defaults/iris-starter.yaml"), "utf8"),
    "iris-starter.yaml",
  ).policies;
  const result = lookupThresholdRule(rules, {
    agent_uri: "https://osod.dev/agents/iris",
    tool_name: "iris-finalize-chart-summary",
    target_resourceType: "Composition",
    specific_action: "write",
    clinical_billing_patient_facing_impact: "clinical",
    initiation_mode: "user-initiated",
    at: "2026-05-04T12:00:00.000Z",
  });
  assert.equal(result.implicitDefault, false);
  assert.equal(result.rule.threshold_class, "MEDIUM");
});

test("v0.55d threshold matrix returns defensive HIGH confirmation for unknown actions", () => {
  const result = lookupThresholdRule([], {
    agent_uri: "https://osod.dev/agents/bodhi",
    tool_name: "bodhi-unknown-action",
    target_resourceType: "Observation",
    specific_action: "write",
    clinical_billing_patient_facing_impact: "clinical",
    initiation_mode: "user-initiated",
  });
  assert.equal(result.implicitDefault, true);
  assert.equal(result.rule.threshold_class, "HIGH");
  assert.equal(result.rule.on_violation.verdict, "confirmation-required");
});
