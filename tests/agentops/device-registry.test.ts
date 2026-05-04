import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryAgentOpsDeviceRegistry,
  buildAgentDevice,
  buildModelDevice,
  hasPredictiveDsiSourceAttributes,
} from "../../mcp/src/agentops/device-registry.js";
import { addAiastSecurity, assertNoPractitionerAiastContradiction, AIAST_CODING } from "../../mcp/src/agentops/types.js";

const baseRegistration = {
  agentUri: "https://osod.dev/agents/iris",
  agentLogicalName: "Iris",
  agentRole: "strategic",
  agentRiskClass: "HIGH" as const,
  initiationModeCapabilities: ["user-initiated"] as const,
  vendorBaaStatus: "practice-admin-attested",
  deploymentDistinctIdentifier: "iris.local-iris",
  adminReviewStatus: "approved" as const,
  adminBaaConfirmation: true,
  model: {
    modelUri: "https://osod.dev/models/claude-opus-4-7",
    vendorName: "Anthropic",
    modelName: "claude-opus-4-7",
    modelVersion: "4.7",
    vendorBaaEligible: true,
    mcpBaaCarveOut: true,
  },
};

test("v0.55d AgentOps registry builds agent Device linked to model Device", () => {
  const agent = buildAgentDevice(baseRegistration);
  const model = buildModelDevice(baseRegistration.model);
  assert.equal(agent.resourceType, "Device");
  assert.equal(agent.parent?.reference, `Device/${model.id}`);
  assert.equal(agent.extension?.[0]?.url, "https://osod.dev/fhir/StructureDefinition/agent-identity");
  assert.equal(model.extension?.[0]?.url, "https://osod.dev/fhir/StructureDefinition/model-identity");
  assert.equal("installDate" in (model.version?.[0] ?? {}), false);
  assert.equal(hasPredictiveDsiSourceAttributes(agent), true);
});

test("v0.55d AIAST helper emits canonical THO coding and rejects Practitioner contradiction", () => {
  const resource = addAiastSecurity({ resourceType: "Observation", status: "preliminary", code: { text: "x" } });
  assert.deepEqual(resource.meta?.security?.[0], AIAST_CODING);
  assert.throws(() =>
    assertNoPractitionerAiastContradiction({
      resource,
      provenanceAgentReference: "Practitioner/practitioner-1",
    }),
  );
});

test("v0.55d AgentOps registration requires staged admin approval", () => {
  const registry = new InMemoryAgentOpsDeviceRegistry();
  const pending = registry.register({ ...baseRegistration, adminReviewStatus: "pending" });
  assert.equal(pending.status, "pending-review");
  assert.equal(registry.getDevice("https://osod.dev/agents/iris"), undefined);
  const registered = registry.register(baseRegistration);
  assert.equal(registered.status, "registered");
  assert.ok(registry.getDevice("https://osod.dev/agents/iris"));
});
