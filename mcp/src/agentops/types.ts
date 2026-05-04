import type { Coding, Resource } from "@medplum/fhirtypes";

export const AGENT_IDENTITY_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/agent-identity";
export const MODEL_IDENTITY_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/model-identity";
export const AGENTOPS_RECORD_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/agentops-record";
export const AGENTOPS_BLOCKED_PAYLOAD_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/agentops-blocked-payload";
export const SOURCE_SHA256_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/source-sha256";

export const AIAST_CODE_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-ObservationValue";
export const AIAST_CODING: Coding = {
  system: "http://terminology.hl7.org/CodeSystem/v3-ObservationValue",
  code: "AIAST",
  display: "Artificial Intelligence asserted",
};

export const THRESHOLD_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ThresholdClass = (typeof THRESHOLD_CLASSES)[number];

export const AGENTOPS_VERDICTS = [
  "allowed",
  "blocked",
  "confirmation-required",
  "confirmed",
  "escalated",
] as const;
export type AgentOpsVerdict = (typeof AGENTOPS_VERDICTS)[number];

export const INITIATION_MODES = ["user-initiated", "autonomously-initiated"] as const;
export type InitiationMode = (typeof INITIATION_MODES)[number];

export const SPECIFIC_ACTIONS = ["read", "write", "mutate", "delete", "execute"] as const;
export type SpecificAction = (typeof SPECIFIC_ACTIONS)[number];

export const IMPACT_CLASSES = ["clinical", "billing", "patient-facing", "none", "mixed"] as const;
export type ClinicalBillingPatientFacingImpact = (typeof IMPACT_CLASSES)[number];

export const AGENTOPS_EXCEPTION_CODES = [
  "PreventingHarm",
  "Privacy",
  "Security",
  "Infeasibility",
  "HealthITPerformance",
  "ProtectingCareAccess",
  "ContentAndManner",
  "Fees",
  "Licensing",
  "TEFCAManner",
] as const;
export type AgentOpsExceptionCode = (typeof AGENTOPS_EXCEPTION_CODES)[number];

export const PROTECTING_CARE_ACCESS_EXCEPTION: AgentOpsExceptionCode = "ProtectingCareAccess";

export const AGENTOPS_AUDIT_EVENT_TYPES = [
  "agentops.action.attempted",
  "agentops.action.allowed",
  "agentops.action.blocked",
  "agentops.action.confirmed",
  "agentops.action.escalated",
  "agentops.action.rolled-back",
  "agentops.policy.loaded",
  "agentops.policy.collision",
] as const;
export type AgentOpsAuditEventType = (typeof AGENTOPS_AUDIT_EVENT_TYPES)[number];

export interface AgentOpsAttemptedAction {
  readonly tool_name: string;
  readonly parameters: Record<string, unknown>;
}

export interface AgentOpsTargetFhirResource {
  readonly resourceType: string;
  readonly id: string;
  readonly version: string | null;
}

export interface AgentOpsSourceIdentity {
  readonly token_hash: string;
  readonly source_ip: string;
  readonly agent_identity_uri: string;
}

export interface AgentOpsAuditFields {
  readonly agent_identity: string;
  readonly attempted_action: AgentOpsAttemptedAction;
  readonly target_fhir_resource: AgentOpsTargetFhirResource;
  readonly threshold_class: ThresholdClass;
  readonly verdict: AgentOpsVerdict;
  readonly rationale: {
    readonly rule_id: string;
    readonly rule_version: string;
  };
  readonly source_identity: AgentOpsSourceIdentity;
  readonly section_171_exception_code?: AgentOpsExceptionCode;
  readonly aiast_tag_confirmation: boolean;
  readonly initiation_mode: InitiationMode;
  readonly retention_until: string;
  readonly attempted_payload_full?: unknown;
}

export function addAiastSecurity<T extends Resource>(resource: T): T {
  const currentSecurity = resource.meta?.security ?? [];
  if (currentSecurity.some(isAiastCoding)) {
    return resource;
  }
  return {
    ...resource,
    meta: {
      ...resource.meta,
      security: [...currentSecurity, AIAST_CODING],
    },
  };
}

export function hasAiastSecurity(resource: Resource | undefined): boolean {
  return Boolean(resource?.meta?.security?.some(isAiastCoding));
}

export function isAiastCoding(coding: Coding): boolean {
  return coding.system === AIAST_CODE_SYSTEM && coding.code === "AIAST";
}

export function assertNoPractitionerAiastContradiction(input: {
  readonly resource: Resource;
  readonly provenanceAgentReference: string;
}): void {
  if (hasAiastSecurity(input.resource) && input.provenanceAgentReference.startsWith("Practitioner/")) {
    throw new Error(
      "AgentOps provenance contradiction: AIAST-tagged resources must use Provenance.agent.who Reference(Device).",
    );
  }
}

export function isThresholdClass(value: unknown): value is ThresholdClass {
  return typeof value === "string" && THRESHOLD_CLASSES.includes(value as ThresholdClass);
}

export function isAgentOpsVerdict(value: unknown): value is AgentOpsVerdict {
  return typeof value === "string" && AGENTOPS_VERDICTS.includes(value as AgentOpsVerdict);
}

export function isInitiationMode(value: unknown): value is InitiationMode {
  return typeof value === "string" && INITIATION_MODES.includes(value as InitiationMode);
}

export function isSpecificAction(value: unknown): value is SpecificAction {
  return typeof value === "string" && SPECIFIC_ACTIONS.includes(value as SpecificAction);
}

export function isImpactClass(value: unknown): value is ClinicalBillingPatientFacingImpact {
  return typeof value === "string" && IMPACT_CLASSES.includes(value as ClinicalBillingPatientFacingImpact);
}

export function isAgentOpsExceptionCode(value: unknown): value is AgentOpsExceptionCode {
  return typeof value === "string" && AGENTOPS_EXCEPTION_CODES.includes(value as AgentOpsExceptionCode);
}
