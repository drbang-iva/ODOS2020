import type { Coding, CodeableConcept, Encounter, Observation, ServiceRequest } from "@medplum/fhirtypes";

export const CDS_HOOKS_SPEC_VERSION = "2.0.1";
export const CDS_SERVICE_EXTENSION_URL =
  "https://osod.dev/fhir/StructureDefinition/cds-service";
export const CDS_SERVICE_REGISTRY_POLICY_URL =
  "https://osod.dev/fhir/Policy/cds-service-registry";
export const CDS_SERVICE_ACTIVITY_CODE_SYSTEM =
  "https://osod.dev/fhir/CodeSystem/cds-service-activity";
export const SNOMED_CT_SYSTEM = "http://snomed.info/sct";

export const CDS_HOOK_IDS = ["order-sign", "order-select", "encounter-discharge"] as const;
export type CdsHookId = (typeof CDS_HOOK_IDS)[number];

export const DEFAULT_CARD_TTL_MINUTES = 60;
export const DEFAULT_EXTERNAL_CDS_TIMEOUT_SECONDS = 10;

export interface CdsServiceDiscoveryEntry {
  readonly hook: CdsHookId;
  readonly title: string;
  readonly description: string;
  readonly id: string;
  readonly prefetch?: Record<string, string>;
  readonly usageRequirements?: string;
}

export interface CdsDiscoveryDocument {
  readonly services: CdsServiceDiscoveryEntry[];
}

export interface CdsFhirAuthorization {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
  readonly subject: string;
  readonly patient?: string;
}

export interface CdsServiceRequestBody {
  readonly hook: CdsHookId;
  readonly hookInstance: string;
  readonly fhirServer?: string;
  readonly fhirAuthorization?: CdsFhirAuthorization;
  readonly context: Record<string, unknown>;
  readonly prefetch?: Record<string, unknown>;
}

export interface CdsServiceResponse {
  readonly cards: CdsCard[];
}

export type CdsIndicator = "info" | "warning" | "critical";
export type CdsDsiType = "predictive" | "evidence-based" | "rules-based";

export interface CdsCardSource {
  readonly label: string;
  readonly url?: string;
  readonly icon?: string;
}

export interface CdsSuggestionAction {
  readonly type: "create" | "update" | "delete";
  readonly description: string;
  readonly resource?: Record<string, unknown>;
}

export interface CdsSuggestion {
  readonly uuid: string;
  readonly label: string;
  readonly actions?: CdsSuggestionAction[];
}

export interface CdsLink {
  readonly label: string;
  readonly url: string;
  readonly type?: "absolute" | "smart";
}

export interface CdsOverrideReason {
  readonly code: string;
  readonly system: string;
  readonly display?: string;
}

export interface CdsInterventionRiskManagement {
  readonly risk_identification: string;
  readonly risk_mitigation: string;
  readonly continual_monitoring: string;
}

export interface CdsSourceAttributes {
  readonly developer_identity: string;
  readonly funding_source: string;
  readonly evidence_basis_citation: string;
}

export interface CdsAlgorithmicValidityBounds {
  readonly intended_use_scope: string;
  readonly intended_user: string;
  readonly intended_health_outcome: string;
  readonly performance_metrics: string;
}

export interface CdsCard {
  readonly uuid: string;
  readonly summary: string;
  readonly indicator: CdsIndicator;
  readonly source: CdsCardSource;
  readonly detail?: string;
  readonly suggestions?: CdsSuggestion[];
  readonly links?: CdsLink[];
  readonly overrideReasons?: CdsOverrideReason[];
  readonly dsi_type: CdsDsiType;
  readonly intervention_risk_management: CdsInterventionRiskManagement;
  readonly source_attributes: CdsSourceAttributes;
  readonly training_data_demographics?: readonly string[];
  readonly algorithmic_validity_bounds?: CdsAlgorithmicValidityBounds;
  readonly card_ttl_minutes?: number;
  readonly generatedAt?: string;
}

export type CdsRiskClass = "LOW" | "MEDIUM" | "HIGH" | "SaMD-boundary-adjacent";
export type CdsPhiBoundary = "none" | "read-only" | "read-write" | "patient-payload";
export type CdsLaunchMode = "cds-service";
export type CdsNetworkEgress = "none" | "allowlist-required" | "unrestricted";

export interface CdsServiceMetadata {
  readonly serviceId: string;
  readonly title: string;
  readonly description: string;
  readonly endpointUrl: string;
  readonly cdsRiskClass: CdsRiskClass;
  readonly phiBoundary: CdsPhiBoundary;
  readonly launchMode: CdsLaunchMode;
  readonly networkEgress: CdsNetworkEgress;
  readonly externalServicesRequired: boolean;
  readonly baaRequired: boolean;
  readonly imageAnalysisProhibited: boolean;
  readonly allowedJurisdictions: readonly string[];
  readonly prohibitedStates: readonly string[];
  readonly scopeRequestCanonical: string;
  readonly hookSubscriptions: readonly CdsHookId[];
  readonly cardTtlMinutes: number;
  readonly requestTimeoutSeconds: number;
  readonly adminReviewStatus: "pending" | "approved" | "deactivated";
}

export interface CdsHookEvaluationInput {
  readonly hook: CdsHookId;
  readonly hookInstance: string;
  readonly fhirServer: string;
  readonly userId: string;
  readonly patientId?: string;
  readonly encounterId?: string;
  readonly serviceRequests?: readonly ServiceRequest[];
  readonly observations?: readonly Observation[];
  readonly encounter?: Encounter;
  readonly context?: Record<string, unknown>;
  readonly prefetch?: Record<string, unknown>;
  readonly now?: Date;
}

export interface CdsHookService {
  readonly discovery: CdsServiceDiscoveryEntry;
  readonly supportedCodes: readonly Coding[];
  matches(input: CdsHookEvaluationInput): boolean;
  invoke(input: CdsHookEvaluationInput): Promise<CdsServiceResponse> | CdsServiceResponse;
}

export interface CdsFeedbackItem {
  readonly card: string;
  readonly outcome: "accepted" | "overridden";
  readonly acceptedSuggestions?: readonly string[];
  readonly overrideReason?: {
    readonly reason?: CodeableConcept | Coding;
    readonly userComment?: string;
  };
  readonly outcomeTimestamp: string;
}

export interface CdsFeedbackRequest {
  readonly feedback: readonly CdsFeedbackItem[];
}
