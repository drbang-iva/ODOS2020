import {
  externalExceptionDescriptor,
  exceptionTypeUri,
  mapAgentOpsException,
  type AgentOpsExceptionDescriptor,
  type AgentOpsExceptionMappingInput,
} from "./exception-mapper.js";
import { PROTECTING_CARE_ACCESS_EXCEPTION, type AgentOpsExceptionCode } from "./types.js";

export interface SafetyValveProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
}

export interface SafetyValveResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: SafetyValveProblemDetails;
  readonly internalExceptionCode: AgentOpsExceptionCode;
}

export interface SafetyValveResponseInput extends AgentOpsExceptionMappingInput {
  readonly auditEventId: string;
  readonly externalMaskMode?: "privacy-problem" | "not-found";
}

const PROBLEM_CONTENT_TYPE = "application/problem+json";
const AUDIT_EVENT_HEADER = "X-OSOD-Audit-Event-Id";

export function buildSafetyValveResponse(input: SafetyValveResponseInput): SafetyValveResponse {
  const descriptor = mapAgentOpsException(input);
  if (!descriptor) {
    throw new Error(`AgentOps Safety Valve block is unmapped for rule ${input.rule_id}.`);
  }
  if (descriptor.code === PROTECTING_CARE_ACCESS_EXCEPTION && input.externalMaskMode === "not-found") {
    return {
      status: 404,
      headers: {
        [AUDIT_EVENT_HEADER]: input.auditEventId,
      },
      internalExceptionCode: descriptor.code,
    };
  }
  return problemResponse(descriptor, input.auditEventId);
}

export function problemResponse(
  internalDescriptor: AgentOpsExceptionDescriptor,
  auditEventId: string,
): SafetyValveResponse {
  const externalDescriptor = externalExceptionDescriptor(internalDescriptor);
  const status = externalDescriptor.httpStatus;
  return {
    status,
    headers: {
      "Content-Type": PROBLEM_CONTENT_TYPE,
      [AUDIT_EVENT_HEADER]: auditEventId,
    },
    body: {
      type: exceptionTypeUri(externalDescriptor),
      title: externalDescriptor.title,
      status,
      detail: "The requested AgentOps action was not completed under the practice's local governance policy.",
      instance: `/AuditEvent/${auditEventId}`,
    },
    internalExceptionCode: internalDescriptor.code,
  };
}

export function assertGenericSafetyValveDetail(body: SafetyValveProblemDetails): void {
  if (/\b(rule_id|patient|Patient\/|agent|Device\/|rationale|identifier)\b/i.test(body.detail)) {
    throw new Error("Safety Valve detail must be generic and must not disclose rule, patient, or agent identifiers.");
  }
}
