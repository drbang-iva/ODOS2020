import type { AgentOpsThresholdMatrixStore } from "../threshold-matrix-loader.js";
import type {
  AgentOpsAttemptedAction,
  AgentOpsTargetFhirResource,
  InitiationMode,
} from "../types.js";
import { assertInitiationModeCapability } from "./supervisor.js";

export interface AgentToolInvocation {
  readonly agentUri: string;
  readonly initiation_mode: InitiationMode;
  readonly initiationModeCapabilities: readonly InitiationMode[];
  readonly action: AgentOpsAttemptedAction;
  readonly target: AgentOpsTargetFhirResource;
  readonly specific_action: "read" | "write" | "mutate" | "delete" | "execute";
  readonly clinical_billing_patient_facing_impact: "clinical" | "billing" | "patient-facing" | "none" | "mixed";
}

export function evaluateAgentToolInvocation(input: {
  readonly invocation: AgentToolInvocation;
  readonly thresholdMatrix: AgentOpsThresholdMatrixStore;
}) {
  assertInitiationModeCapability({
    requested: input.invocation.initiation_mode,
    capabilities: input.invocation.initiationModeCapabilities,
  });
  return input.thresholdMatrix.lookup({
    agent_uri: input.invocation.agentUri,
    tool_name: input.invocation.action.tool_name,
    target_resourceType: input.invocation.target.resourceType,
    specific_action: input.invocation.specific_action,
    clinical_billing_patient_facing_impact:
      input.invocation.clinical_billing_patient_facing_impact,
    initiation_mode: input.invocation.initiation_mode,
  });
}
