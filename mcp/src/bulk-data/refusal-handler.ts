import {
  buildSafetyValveResponse,
  type SafetyValveResponse,
} from "../agentops/safety-valve.js";
import type { AgentOpsExceptionCode } from "../agentops/types.js";

export function bulkDataRefusalResponse(input: {
  readonly auditEventId: string;
  readonly ruleId: string;
  readonly exceptionCode: AgentOpsExceptionCode;
  readonly resourceType?: string;
  readonly toolName?: string;
}): SafetyValveResponse {
  return buildSafetyValveResponse({
    auditEventId: input.auditEventId,
    rule_id: input.ruleId,
    threshold_class: "HIGH",
    verdict: "blocked",
    target_resourceType: input.resourceType ?? "Group",
    specific_action: "read",
    tool_name: input.toolName ?? "bulk-data-export",
    configured_exception_code: input.exceptionCode,
  });
}
