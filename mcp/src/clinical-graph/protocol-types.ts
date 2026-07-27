import type { CodeableConcept } from "@medplum/fhirtypes";

export type LateralityMode = "inherit-dx" | "OU-always" | { fixed: "OD" | "OS" | "OU" };
export type DiagnosisVisitStatus =
  | "new"
  | "stable"
  | "improved"
  | "worsening"
  | "resolved-this-visit";
export type ProtocolTrigger =
  | { kind: "diagnosis"; dxKeys: string[]; statusScope?: DiagnosisVisitStatus[] }
  | { kind: "visit-type"; visitTypes: string[] };
export type ProtocolItemType =
  | "finding-seed" | "order" | "medication" | "counseling" | "education"
  | "instruction" | "follow-up" | "series-prescription" | "charge-seed";

export interface ProtocolItem {
  itemKey: string;
  itemType: ProtocolItemType;
  defaultSelected: boolean;
  lateralityMode: LateralityMode;
  mergeKey?: string;
  linkedDxScope?: string[];
  payload: Record<string, unknown>;
  capture?: {
    source: "device-measured" | "observed-estimate" | "structured";
    seedValueKept?: boolean;
  };
}

export interface ProtocolDefinitionDraft {
  title: string;
  trigger: ProtocolTrigger;
  applicability?: Record<string, unknown>;
  ownership: { ownerId: string; sharing: string };
  categories: string[];
  items: ProtocolItem[];
  mergePolicy?: Record<string, unknown>;
  provenanceNote?: string;
}

export interface ProtocolDefinition {
  id: string;
  version: number;
  acceptCharges?: boolean;
  draft?: ProtocolDefinitionDraft;
  title: string;
  trigger: ProtocolTrigger;
  applicability?: Record<string, unknown>;
  ownership: { ownerId: string; sharing: string };
  categories: string[];
  status: "draft" | "active" | "retired";
  items: ProtocolItem[];
  mergePolicy?: Record<string, unknown>;
  provenanceNote?: string;
  authoring: {
    origin: "clinician" | "encounter-capture";
    at: string;
    actor: string;
  };
  audit: {
    createdBy: string;
    createdAt: string;
    publishedBy?: string;
    publishedAt?: string;
    forkedFrom?: { id: string; version: number };
  };
}

export interface PlanActionInstance {
  id: string;
  encounterId: string;
  patientId: string;
  protocolApplicationId: string | null;
  sourceItemKey?: string;
  actionType: ProtocolItemType;
  linkedDx: string[];
  linkedFindings: string[];
  state: "proposed" | "selected" | "removed" | "modified" | "completed" | "cancelled";
  mergeKey?: string;
  payload: Record<string, unknown>;
  protocolDefaultPayload?: Record<string, unknown>;
  modifiedFields: string[];
  materializedFhirRef?: string;
  chargeProposalRef?: string;
  provenance: InstanceProvenance;
}

export interface ProtocolApplication {
  id: string;
  encounterId: string;
  patientId: string;
  protocolId: string;
  protocolVersion: number;
  appliedBy: string;
  appliedAt: string;
  stackedWith: string[];
  dispositions: Array<{
    itemKey: string;
    outcome: "applied-default" | "applied-modified" | "opted-out";
  }>;
  dedupResolutions: Array<Record<string, unknown>>;
  clinicalImpressionRef?: string;
  undoState: "active" | "unapplied";
  confirmed: boolean;
}

export interface ProcedureChargeRule {
  id: string;
  version: number;
  procedureConceptKey: string;
  dxScope: string[];
  jurisdiction: { payerClass: string; macId?: string; payerId?: string };
  outcome: "allowed" | "needs-review" | "not-allowed" | "warn-only";
  frequencyLimit?: { count: number; per: "eye" | "patient"; periodMonths: number };
  requiredEvidence?: string[];
  lateralityConstraint?: string;
  pairEdits?: string[];
  sourceAuthority: {
    kind: string;
    citation: string;
    url: string;
    additionalUrls?: string[];
    accessedDate: string;
  };
  effectivePeriod: { start: string; end?: string };
  verificationStatus: "verified" | "provisional";
}

export interface ChargeProposal {
  id: string;
  encounterId: string;
  protocolApplicationId: string;
  planActionRef: string;
  procedureConceptKey: string;
  units: number;
  laterality: "OD" | "OS" | "OU";
  dxPointers: string[];
  evidenceRefs: string[];
  coverageEvaluations: Array<{
    at: string;
    ruleId: string;
    ruleVersion: number;
    outcome: ProcedureChargeRule["outcome"] | "no-rule";
    messages: string[];
    detectedIssueRef?: string;
  }>;
  state: "staged" | "accepted" | "overridden" | "removed" | "finalized";
  override?: { reason: string; actor: string; at: string; abnFlag: boolean };
  chargeItemRef?: string;
  provenance: InstanceProvenance;
}

export interface ProtocolFindingInstance {
  id: string;
  encounterId: string;
  patientId: string;
  protocolApplicationId: string;
  sourceItemKey: string;
  findingDefKey: string;
  laterality?: "OD" | "OS" | "OU";
  componentKey?: string;
  state: "proposed" | "committed" | "removed";
  value?: unknown;
  editedBeforeCommit: boolean;
  provenance: InstanceProvenance;
  observationReference?: string;
}

export interface InstanceProvenance {
  source: "protocol-default" | "clinician-entered";
  entryMode?: "propagated-uniform" | "quadrant-specific";
  actor: string;
  at: string;
  protocolId?: string;
  protocolVersion?: number;
}

export interface EducationAsset {
  id: string;
  title: string;
  body: string;
}

export interface ProtocolOfferDiagnosis {
  reference: string;
  code: string;
  confirmed: boolean;
  visitStatus?: DiagnosisVisitStatus;
}

export type ProtocolConcept = CodeableConcept | string;
