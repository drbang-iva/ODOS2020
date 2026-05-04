import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAgentOpsDeviceRegistry } from "../../mcp/src/agentops/device-registry.js";

const baseRegistration = {
  agentUri: "https://osod.dev/agents/iris",
  agentLogicalName: "Iris",
  agentRole: "strategic",
  agentRiskClass: "HIGH" as const,
  initiationModeCapabilities: ["user-initiated"] as const,
  vendorBaaStatus: "practice-admin-attested",
  deploymentDistinctIdentifier: "iris.local-iris",
  adminReviewStatus: "approved" as const,
  model: {
    modelUri: "https://osod.dev/models/claude-opus-4-7",
    vendorName: "Anthropic",
    modelName: "claude-opus-4-7",
    modelVersion: "4.7",
    vendorBaaEligible: true,
    mcpBaaCarveOut: true,
  },
};

test("v0.55d blocks AgentOps registration when vendor BAA eligibility lacks admin attestation", () => {
  const registry = new InMemoryAgentOpsDeviceRegistry();
  assert.throws(() =>
    registry.register({
      ...baseRegistration,
      adminBaaConfirmation: false,
      model: {
        ...baseRegistration.model,
        vendorBaaEligible: false,
      },
    }),
  );
});

test("v0.55d blocks Anthropic AgentOps registration that declares third-party MCP routing", () => {
  const registry = new InMemoryAgentOpsDeviceRegistry();
  assert.throws(() =>
    registry.register({
      ...baseRegistration,
      adminBaaConfirmation: true,
      declaresThirdPartyMcpRouting: true,
    }),
  );
});
