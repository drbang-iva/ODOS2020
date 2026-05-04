import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENTOPS_EGRESS_NETWORK,
  AGENTOPS_INTERNAL_NETWORK,
  assertSidecarNetworkIsolation,
  buildAgentSidecarSpec,
} from "../../mcp/src/agentops/runtime/supervisor.js";

test("v0.55d AgentOps sidecar spec attaches only to the internal network", () => {
  const spec = buildAgentSidecarSpec({ agentDeviceId: "https://osod.dev/agents/iris" });
  assert.equal(spec.serviceName, "osod-agent-iris");
  assert.deepEqual(spec.networks, [AGENTOPS_INTERNAL_NETWORK]);
  assert.doesNotThrow(() => assertSidecarNetworkIsolation(spec));
  assert.throws(() =>
    assertSidecarNetworkIsolation({
      ...spec,
      networks: [AGENTOPS_INTERNAL_NETWORK, AGENTOPS_EGRESS_NETWORK],
    }),
  );
});
