import type { AgentOpsThresholdMatrixStore } from "../threshold-matrix-loader.js";
import type { InitiationMode } from "../types.js";

export const AGENTOPS_CORE_SERVICE_NAME = "osod-core";
export const AGENTOPS_INTERNAL_NETWORK = "osod-internal";
export const AGENTOPS_EGRESS_NETWORK = "osod-egress";

export interface AgentSidecarSpec {
  readonly serviceName: string;
  readonly agentDeviceId: string;
  readonly networks: readonly string[];
  readonly memoryMb: number;
  readonly cpuShares: number;
}

export interface AgentOpsSupervisorConfig {
  readonly thresholdMatrix: AgentOpsThresholdMatrixStore;
  readonly defaultMemoryMb: number;
  readonly defaultCpuShares: number;
}

export function sidecarNameForAgent(agentDeviceId: string): string {
  const name = agentDeviceId.split("/").filter(Boolean).at(-1) ?? agentDeviceId;
  return `osod-agent-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

export function buildAgentSidecarSpec(input: {
  readonly agentDeviceId: string;
  readonly memoryMb?: number;
  readonly cpuShares?: number;
  readonly defaultMemoryMb?: number;
  readonly defaultCpuShares?: number;
}): AgentSidecarSpec {
  return {
    serviceName: sidecarNameForAgent(input.agentDeviceId),
    agentDeviceId: input.agentDeviceId,
    networks: [AGENTOPS_INTERNAL_NETWORK],
    memoryMb: input.memoryMb ?? input.defaultMemoryMb ?? 512,
    cpuShares: input.cpuShares ?? input.defaultCpuShares ?? 256,
  };
}

export function assertSidecarNetworkIsolation(spec: AgentSidecarSpec): void {
  if (spec.networks.includes(AGENTOPS_EGRESS_NETWORK)) {
    throw new Error("AgentOps sidecars must not attach to the egress network.");
  }
  if (!spec.networks.includes(AGENTOPS_INTERNAL_NETWORK)) {
    throw new Error("AgentOps sidecars must attach to the internal network.");
  }
}

export function assertInitiationModeCapability(input: {
  readonly requested: InitiationMode;
  readonly capabilities: readonly InitiationMode[];
}): void {
  if (!input.capabilities.includes(input.requested)) {
    throw new Error("AgentOps initiation_mode is outside the registered agent capability set.");
  }
}
