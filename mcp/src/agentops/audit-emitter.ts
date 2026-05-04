import { createHash } from "node:crypto";
import {
  buildOsodAuditEventRow,
  type OsodAuditEventRecord,
  type OsodAuditEventType,
} from "../authz/osodAudit.js";
import type {
  AgentOpsAttemptedAction,
  AgentOpsAuditFields,
  AgentOpsExceptionCode,
  AgentOpsSourceIdentity,
  AgentOpsTargetFhirResource,
  AgentOpsVerdict,
  InitiationMode,
  ThresholdClass,
} from "./types.js";

export interface BuildAgentOpsAuditRecordInput {
  readonly eventType: Extract<OsodAuditEventType, `agentops.${string}`>;
  readonly agentIdentity: string;
  readonly attemptedAction: AgentOpsAttemptedAction;
  readonly targetFhirResource: AgentOpsTargetFhirResource;
  readonly thresholdClass: ThresholdClass;
  readonly verdict: AgentOpsVerdict;
  readonly rationale: {
    readonly rule_id: string;
    readonly rule_version: string;
  };
  readonly bearerToken?: string;
  readonly sourceIp: string;
  readonly initiationMode: InitiationMode;
  readonly section171ExceptionCode?: AgentOpsExceptionCode;
  readonly aiastTagConfirmation: boolean;
  readonly attemptedPayloadFull?: unknown;
  readonly retentionYears?: number;
  readonly timestamp?: string;
}

export function buildAgentOpsAuditRecord(input: BuildAgentOpsAuditRecordInput): OsodAuditEventRecord {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const agentOps = buildAgentOpsAuditFields(input, timestamp);
  return buildOsodAuditEventRow({
    eventType: input.eventType,
    actorReference: input.agentIdentity,
    actorRole: "autonomous-agent",
    resourceType: input.targetFhirResource.resourceType,
    resourceId: input.targetFhirResource.id,
    actionOutcome: input.verdict === "blocked" || input.verdict === "escalated" ? "denied" : "granted",
    eventTime: timestamp,
    actionReason: `${input.rationale.rule_id}@${input.rationale.rule_version}`,
    agentOps,
  });
}

export function buildAgentOpsAuditFields(
  input: BuildAgentOpsAuditRecordInput,
  timestamp: string,
): AgentOpsAuditFields {
  return {
    agent_identity: input.agentIdentity,
    attempted_action: input.attemptedAction,
    target_fhir_resource: input.targetFhirResource,
    threshold_class: input.thresholdClass,
    verdict: input.verdict,
    rationale: input.rationale,
    source_identity: sourceIdentity({
      bearerToken: input.bearerToken,
      sourceIp: input.sourceIp,
      agentIdentityUri: input.agentIdentity,
    }),
    section_171_exception_code: input.section171ExceptionCode,
    aiast_tag_confirmation: input.aiastTagConfirmation,
    initiation_mode: input.initiationMode,
    retention_until: retentionUntil(timestamp, input.retentionYears ?? 7),
    attempted_payload_full:
      input.verdict === "blocked" || input.verdict === "escalated"
        ? input.attemptedPayloadFull
        : undefined,
  };
}

export function sourceIdentity(input: {
  readonly bearerToken?: string;
  readonly sourceIp: string;
  readonly agentIdentityUri: string;
}): AgentOpsSourceIdentity {
  return {
    token_hash: sha256(input.bearerToken ?? ""),
    source_ip: input.sourceIp,
    agent_identity_uri: input.agentIdentityUri,
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function retentionUntil(timestamp: string, years: number): string {
  const date = new Date(timestamp);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString();
}
