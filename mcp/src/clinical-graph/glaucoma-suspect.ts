import { randomUUID } from "node:crypto";
import type {
  ActivityDefinition,
  ChargeItem,
  Claim,
  ClinicalImpression,
  CodeableConcept,
  Condition,
  DetectedIssue,
  Observation,
  PlanDefinition,
  Reference,
  Resource,
} from "@medplum/fhirtypes";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  type ConditionClinicalStatusCode,
  type ConditionVerificationStatusCode,
} from "../fhir/condition.js";
import type { EyeLaterality, SourceType } from "../fhir/ophthalmology/types.js";
import {
  applyCommonObservationFields,
  lateralityConcept,
  osodConcept,
  quantity,
  reference,
} from "../fhir/ophthalmology/extensions.js";

export const ICD10_CM_CODE_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";
export const CPT_CODE_SYSTEM = "urn:ama:cpt";

export const GLAUCOMA_CUP_DISC_HIGH_RISK_THRESHOLD = 0.6;

export type ClinicalGraphSource =
  | "manual"
  | "device"
  | "parser"
  | "agent"
  | "protocol"
  | "rule";
export type FindingInterpretation = "normal" | "abnormal" | "borderline" | "unknown";
export type SuggestionVisitState =
  | "generated"
  | "shown"
  | "suppressed"
  | "accepted"
  | "rejected"
  | "expired"
  | "superseded";
export type ProtocolActionKind =
  | "finding-prompt"
  | "plan-text"
  | "order"
  | "procedure"
  | "education"
  | "follow-up"
  | "charge-proposal";
export type PlanActionState = "selected" | "removed" | "modified" | "deferred";
export type ProcedureChargeSupportStatus =
  | "allowed"
  | "needs-review"
  | "not-allowed"
  | "warn-only"
  | "provisional";
export type ChargeProposalStatus = "suggested" | "selected" | "removed" | "overridden" | "staged";
export type CodingStatus = "verified" | "placeholder" | "provisional";

export interface ClinicalGraphProvenance {
  source: ClinicalGraphSource;
  recordedAt: string;
  actorReference?: string;
  sourceReferences?: string[];
  ledgerRefs?: string[];
  note?: string;
}

export interface ClinicalFindingDefinition {
  id: string;
  stableKey: string;
  display: string;
  sectionKey?: string;
  anatomyTarget?: "eye" | "optic-nerve" | "cornea" | "retina" | "other";
  valueSchema: Record<string, unknown>;
  normalSemantics?: Record<string, unknown>;
  sourceStatus: "verified-seed" | "unseeded-needs-operator-input" | "local-practice";
  fhirObservationCode?: CodeableConcept;
  notBillReady: boolean;
  active: boolean;
  provenance: ClinicalGraphProvenance;
}

export interface FindingInstance {
  id: string;
  findingDefinitionId: string;
  patientReference: string;
  encounterReference: string;
  observationReference?: string;
  laterality: EyeLaterality;
  value: FindingValue;
  interpretation?: FindingInterpretation;
  sourceType: SourceType | "agent" | "protocol";
  confidence?: number;
  recordedAt: string;
  provenance: ClinicalGraphProvenance;
}

export type FindingValue =
  | { type: "quantity"; value: number; unit: string; system?: string; code?: string }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "json"; value: Record<string, unknown> };

export interface DiagnosisDefinition {
  id: string;
  stableKey: string;
  display: string;
  clinicalFamily: string;
  icd10Family?: string;
  icd10Code?: string;
  icd10Display?: string;
  codingStatus: CodingStatus;
  lateralityRequired: boolean;
  applicableFindingDefinitionIds: string[];
  separatesSeverityStagePayerRisk: true;
  active: boolean;
  provenance: ClinicalGraphProvenance;
}

export interface DiagnosisSuggestionEdge {
  id: string;
  sourceFindingDefinitionId?: string;
  sourceFindingInstanceId?: string;
  targetDiagnosisDefinitionId: string;
  predicateKey: string;
  predicateExpression: Record<string, unknown>;
  rank: number;
  confidence?: number;
  explanation: string;
  ruleVersion?: string;
  visitState: SuggestionVisitState;
  acceptedAt?: string;
  rejectedAt?: string;
  provenance: ClinicalGraphProvenance;
}

export interface EncounterDiagnosis {
  id: string;
  diagnosisDefinitionId: string;
  patientReference: string;
  encounterReference: string;
  conditionReference?: string;
  clinicalStatus: ConditionClinicalStatusCode;
  verificationStatus: ConditionVerificationStatusCode;
  rank: number;
  laterality: EyeLaterality;
  clinicalSeverity?: CodeableConcept;
  diseaseStage?: CodeableConcept;
  payerRiskBucket?: "low" | "high" | "unknown" | string;
  evidenceFindingInstanceIds: string[];
  evidenceObservationReferences: string[];
  clinicianNote?: string;
  provenance: ClinicalGraphProvenance;
  confirmedAt: string;
}

export interface ProtocolDefinition {
  id: string;
  stableKey: string;
  display: string;
  diagnosisDefinitionId?: string;
  sourceStatus: "verified-seed" | "unseeded-needs-operator-input" | "local-practice";
  actionTemplates: ProtocolActionTemplate[];
  notBillReady: boolean;
  active: boolean;
  provenance: ClinicalGraphProvenance;
}

export interface ProtocolActionTemplate {
  actionKey: string;
  actionKind: ProtocolActionKind;
  display: string;
  defaultSelected: boolean;
  mergeKey?: string;
}

export interface PlanActionInstance {
  id: string;
  protocolDefinitionId?: string;
  encounterDiagnosisId?: string;
  linkedFindingInstanceIds: string[];
  actionKey: string;
  actionKind: ProtocolActionKind;
  state: PlanActionState;
  mergeKey?: string;
  generatedFhirReference?: string;
  provenance: ClinicalGraphProvenance;
}

export interface ProcedureChargeRule {
  id: string;
  diagnosisDefinitionId?: string;
  diagnosisFamily?: string;
  procedureSystem: string;
  procedureCode: string;
  payerContext?: string;
  jurisdiction?: string;
  supportStatus: ProcedureChargeSupportStatus;
  sourceAuthority: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  requiredEvidence: string[];
  lateralityConstraints?: Record<string, unknown>;
  verificationStatus: CodingStatus;
  notBillReady: boolean;
  sourceUrl?: string;
  accessDate?: string;
  provenance: ClinicalGraphProvenance;
}

export interface ChargeProposal {
  id: string;
  planActionInstanceId?: string;
  procedureSystem: string;
  procedureCode: string;
  linkedEncounterDiagnosisIds: string[];
  evidenceFindingInstanceIds: string[];
  status: ChargeProposalStatus;
  coverageWarnings: string[];
  selected: boolean;
  overrideReason?: string;
  chargeItemReference?: string;
  provenance: ClinicalGraphProvenance;
}

export interface GlaucomaPredicateInput {
  cupDiscRatio: number;
  laterality: EyeLaterality;
  patientReference: string;
  encounterReference: string;
  findingDefinitionId: string;
  findingInstanceId: string;
  recordedAt: string;
  provenance: ClinicalGraphProvenance;
}

export function buildClinicalFindingDefinition(
  input: Omit<ClinicalFindingDefinition, "id" | "active" | "notBillReady"> &
    Partial<Pick<ClinicalFindingDefinition, "id" | "active" | "notBillReady">>,
): ClinicalFindingDefinition {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    active: input.active ?? true,
    notBillReady: input.notBillReady ?? input.sourceStatus !== "verified-seed",
  };
}

export function buildFindingInstance(
  input: Omit<FindingInstance, "id" | "sourceType"> &
    Partial<Pick<FindingInstance, "id" | "sourceType">>,
): FindingInstance {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    sourceType: input.sourceType ?? "manual",
  };
}

export function projectFindingInstanceToObservation(
  finding: FindingInstance,
  definition: ClinicalFindingDefinition,
): Observation {
  const base: Observation = {
    resourceType: "Observation",
    id: finding.observationReference?.startsWith("Observation/")
      ? finding.observationReference.slice("Observation/".length)
      : undefined,
    status: "final",
    code: definition.fhirObservationCode ?? osodConcept(definition.stableKey, definition.display),
    ...(findingValueToObservationValue(finding.value)),
  };

  return applyCommonObservationFields(base, {
    patientReference: finding.patientReference,
    encounterReference: finding.encounterReference,
    eye: finding.laterality,
    measuredAt: finding.recordedAt,
    sourceType: observationSourceType(finding.sourceType),
    sourceLabel:
      finding.sourceType === "agent" || finding.sourceType === "protocol"
        ? `clinicalGraphSource=${finding.sourceType}`
        : undefined,
    confidenceScore: finding.confidence,
  });
}

export function buildDiagnosisDefinition(
  input: Omit<DiagnosisDefinition, "id" | "active" | "applicableFindingDefinitionIds" | "separatesSeverityStagePayerRisk"> &
    Partial<Pick<DiagnosisDefinition, "id" | "active" | "applicableFindingDefinitionIds">>,
): DiagnosisDefinition {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    active: input.active ?? true,
    applicableFindingDefinitionIds: input.applicableFindingDefinitionIds ?? [],
    separatesSeverityStagePayerRisk: true,
  };
}

export function buildDiagnosisSuggestionEdge(
  input: Omit<DiagnosisSuggestionEdge, "id" | "visitState"> &
    Partial<Pick<DiagnosisSuggestionEdge, "id" | "visitState">>,
): DiagnosisSuggestionEdge {
  if (!input.sourceFindingDefinitionId && !input.sourceFindingInstanceId) {
    throw new Error("DiagnosisSuggestionEdge requires a source finding definition or instance.");
  }
  return {
    ...input,
    id: input.id ?? randomUUID(),
    visitState: input.visitState ?? "generated",
  };
}

export function buildEncounterDiagnosis(
  input: Omit<EncounterDiagnosis, "id" | "clinicalStatus" | "verificationStatus" | "rank" | "evidenceFindingInstanceIds" | "evidenceObservationReferences" | "confirmedAt"> &
    Partial<
      Pick<
        EncounterDiagnosis,
        | "id"
        | "clinicalStatus"
        | "verificationStatus"
        | "rank"
        | "evidenceFindingInstanceIds"
        | "evidenceObservationReferences"
        | "confirmedAt"
      >
    >,
): EncounterDiagnosis {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    clinicalStatus: input.clinicalStatus ?? "active",
    verificationStatus: input.verificationStatus ?? "confirmed",
    rank: input.rank ?? 1,
    evidenceFindingInstanceIds: input.evidenceFindingInstanceIds ?? [],
    evidenceObservationReferences: input.evidenceObservationReferences ?? [],
    confirmedAt: input.confirmedAt ?? input.provenance.recordedAt,
  };
}

export function projectEncounterDiagnosisToCondition(
  encounterDiagnosis: EncounterDiagnosis,
  definition: DiagnosisDefinition,
): Condition {
  if (definition.codingStatus !== "verified" || !definition.icd10Code) {
    throw new Error("Only verified DiagnosisDefinition rows can project to FHIR Condition.");
  }

  const condition = buildEncounterDiagnosisCondition({
    patientReference: encounterDiagnosis.patientReference,
    encounterReference: encounterDiagnosis.encounterReference,
    code: {
      system: ICD10_CM_CODE_SYSTEM,
      code: definition.icd10Code,
      display: definition.icd10Display ?? definition.display,
    },
    clinicalStatus: encounterDiagnosis.clinicalStatus,
    verificationStatus: encounterDiagnosis.verificationStatus,
    recordedDate: encounterDiagnosis.confirmedAt,
    bodySiteText: lateralityDisplay(encounterDiagnosis.laterality),
  });

  return {
    ...condition,
    bodySite: [lateralityConcept(encounterDiagnosis.laterality)],
    ...(encounterDiagnosis.clinicalSeverity
      ? { severity: encounterDiagnosis.clinicalSeverity }
      : {}),
    ...(encounterDiagnosis.diseaseStage
      ? { stage: [{ summary: encounterDiagnosis.diseaseStage }] }
      : {}),
    ...(encounterDiagnosis.evidenceObservationReferences.length
      ? {
          evidence: [
            {
              detail: encounterDiagnosis.evidenceObservationReferences.map((r) =>
                reference<Resource>(r),
              ),
            },
          ],
        }
      : {}),
  };
}

export function buildProtocolDefinition(
  input: Omit<ProtocolDefinition, "id" | "active" | "notBillReady" | "actionTemplates"> &
    Partial<Pick<ProtocolDefinition, "id" | "active" | "notBillReady" | "actionTemplates">>,
): ProtocolDefinition {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    actionTemplates: input.actionTemplates ?? [],
    active: input.active ?? true,
    notBillReady: input.notBillReady ?? input.sourceStatus !== "verified-seed",
  };
}

export function buildPlanActionInstance(
  input: Omit<PlanActionInstance, "id" | "linkedFindingInstanceIds" | "state"> &
    Partial<Pick<PlanActionInstance, "id" | "linkedFindingInstanceIds" | "state">>,
): PlanActionInstance {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    linkedFindingInstanceIds: input.linkedFindingInstanceIds ?? [],
    state: input.state ?? "selected",
  };
}

export function buildProcedureChargeRule(
  input: Omit<ProcedureChargeRule, "id" | "requiredEvidence" | "notBillReady"> &
    Partial<Pick<ProcedureChargeRule, "id" | "requiredEvidence" | "notBillReady">>,
): ProcedureChargeRule {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    requiredEvidence: input.requiredEvidence ?? [],
    notBillReady: input.notBillReady ?? input.verificationStatus !== "verified",
  };
}

export function buildChargeProposal(
  input: Omit<ChargeProposal, "id" | "linkedEncounterDiagnosisIds" | "evidenceFindingInstanceIds" | "coverageWarnings" | "selected" | "status"> &
    Partial<
      Pick<
        ChargeProposal,
        | "id"
        | "linkedEncounterDiagnosisIds"
        | "evidenceFindingInstanceIds"
        | "coverageWarnings"
        | "selected"
        | "status"
      >
    >,
): ChargeProposal {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    linkedEncounterDiagnosisIds: input.linkedEncounterDiagnosisIds ?? [],
    evidenceFindingInstanceIds: input.evidenceFindingInstanceIds ?? [],
    coverageWarnings: input.coverageWarnings ?? [],
    selected: input.selected ?? false,
    status: input.status ?? "suggested",
  };
}

export function buildGlaucomaOpenAngleDiagnosisDefinition(input: {
  laterality: EyeLaterality;
  riskBucket: "low" | "high";
  provenance: ClinicalGraphProvenance;
  findingDefinitionIds?: string[];
  id?: string;
}): DiagnosisDefinition {
  const code = glaucomaOpenAngleBorderlineCode(input.riskBucket, input.laterality);
  const riskDisplay = input.riskBucket === "high" ? "high risk" : "low risk";
  return buildDiagnosisDefinition({
    id: input.id,
    stableKey: `glaucoma_suspect_open_angle_${input.riskBucket}_${input.laterality.toLowerCase()}`,
    display: `Open angle with borderline findings, ${riskDisplay}, ${lateralityDisplay(input.laterality).toLowerCase()}`,
    clinicalFamily: "glaucoma-suspect",
    icd10Family: input.riskBucket === "high" ? "H40.02-" : "H40.01-",
    icd10Code: code,
    icd10Display: `Open angle with borderline findings, ${riskDisplay}, ${lateralityDisplay(input.laterality).toLowerCase()}`,
    codingStatus: "verified",
    lateralityRequired: true,
    applicableFindingDefinitionIds: input.findingDefinitionIds,
    provenance: input.provenance,
  });
}

export function buildGlaucomaCupDiscSuggestion(input: GlaucomaPredicateInput): {
  finding: FindingInstance;
  diagnosisDefinition: DiagnosisDefinition;
  suggestionEdge: DiagnosisSuggestionEdge;
} {
  const riskBucket = input.cupDiscRatio >= GLAUCOMA_CUP_DISC_HIGH_RISK_THRESHOLD ? "high" : "low";
  const finding = buildFindingInstance({
    id: input.findingInstanceId,
    findingDefinitionId: input.findingDefinitionId,
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    laterality: input.laterality,
    value: { type: "quantity", value: input.cupDiscRatio, unit: "ratio", code: "1" },
    interpretation: riskBucket === "high" ? "abnormal" : "borderline",
    recordedAt: input.recordedAt,
    provenance: input.provenance,
  });
  const diagnosisDefinition = buildGlaucomaOpenAngleDiagnosisDefinition({
    laterality: input.laterality,
    riskBucket,
    provenance: input.provenance,
    findingDefinitionIds: [input.findingDefinitionId],
  });
  const suggestionEdge = buildDiagnosisSuggestionEdge({
    sourceFindingInstanceId: finding.id,
    targetDiagnosisDefinitionId: diagnosisDefinition.id,
    predicateKey: "glaucoma_suspect_cup_disc_threshold_v0",
    predicateExpression: {
      finding: "cup_disc_ratio",
      operator: riskBucket === "high" ? ">=" : "<",
      threshold: GLAUCOMA_CUP_DISC_HIGH_RISK_THRESHOLD,
      deferred: ["rule-versioning", "recalc-invalidation", "cross-recompute-persistence"],
    },
    rank: 1,
    confidence: riskBucket === "high" ? 0.8 : 0.55,
    explanation:
      riskBucket === "high"
        ? "Cup/disc ratio meets the glaucoma-minimum high-risk branch."
        : "Cup/disc ratio stays below the glaucoma-minimum high-risk branch.",
    provenance: input.provenance,
  });

  return { finding, diagnosisDefinition, suggestionEdge };
}

export function buildSuggestionReconciliationClinicalImpression(input: {
  patientReference: string;
  encounterReference: string;
  date: string;
  acceptedConditionReferences: string[];
  rejectedSuggestionSummaries: string[];
  reviewedObservationReferences: string[];
  summary: string;
}): ClinicalImpression {
  return {
    resourceType: "ClinicalImpression",
    status: "completed",
    subject: reference(input.patientReference),
    encounter: reference(input.encounterReference),
    date: input.date,
    investigation: input.reviewedObservationReferences.length
      ? [
          {
            code: osodConcept("reviewed-observations", "Reviewed observations"),
            item: input.reviewedObservationReferences.map((r) => reference<Observation>(r)),
          },
        ]
      : undefined,
    finding: [
      ...input.acceptedConditionReferences.map((conditionReference) => ({
        itemReference: reference<Resource>(conditionReference),
        basis: "Accepted by clinician as confirmed encounter diagnosis.",
      })),
      ...input.rejectedSuggestionSummaries.map((basis) => ({
        basis,
      })),
    ],
    summary: input.summary,
  };
}

export function buildCoverageWarningDetectedIssue(input: {
  patientReference: string;
  implicatedReferences: string[];
  detail: string;
  identifiedDateTime: string;
}): DetectedIssue {
  return {
    resourceType: "DetectedIssue",
    status: "final",
    code: osodConcept("coverage-warning", "Coverage warning"),
    severity: "moderate",
    patient: reference(input.patientReference),
    identifiedDateTime: input.identifiedDateTime,
    implicated: input.implicatedReferences.map((r) => reference<Resource>(r)),
    detail: input.detail,
  };
}

export function projectChargeProposalToChargeItem(input: {
  proposal: ChargeProposal;
  patientReference: string;
  encounterReference: string;
  occurrenceDateTime: string;
}): ChargeItem {
  return {
    resourceType: "ChargeItem",
    status: "planned",
    code: codeableConcept(input.proposal.procedureSystem, input.proposal.procedureCode),
    subject: reference(input.patientReference),
    context: reference(input.encounterReference),
    occurrenceDateTime: input.occurrenceDateTime,
    supportingInformation: [
      ...input.proposal.linkedEncounterDiagnosisIds.map((id) =>
        reference<Resource>(`Condition/${id}`),
      ),
      ...input.proposal.evidenceFindingInstanceIds.map((id) =>
        reference<Resource>(`Observation/${id}`),
      ),
    ],
    note: input.proposal.coverageWarnings.map((text) => ({ text })),
  };
}

export function buildClaimWithDiagnosisPointers(input: {
  patientReference: string;
  providerReference: string;
  created: string;
  diagnosisConditionReferences: string[];
  chargeItems: Array<{ sequence: number; procedureSystem: string; procedureCode: string; diagnosisSequence: number[] }>;
}): Claim {
  return {
    resourceType: "Claim",
    status: "active",
    type: osodConcept("professional", "Professional"),
    use: "claim",
    patient: reference(input.patientReference),
    created: input.created,
    provider: reference(input.providerReference),
    priority: osodConcept("normal", "Normal"),
    insurance: [
      {
        sequence: 1,
        focal: true,
        coverage: { display: "Phase 1 placeholder coverage; payer workflow not implemented." },
      },
    ],
    diagnosis: input.diagnosisConditionReferences.map((conditionReference, index) => ({
      sequence: index + 1,
      diagnosisReference: reference<Condition>(conditionReference),
    })),
    item: input.chargeItems.map((item) => ({
      sequence: item.sequence,
      productOrService: codeableConcept(item.procedureSystem, item.procedureCode),
      diagnosisSequence: item.diagnosisSequence,
    })),
  };
}

export function projectProtocolDefinitionToPlanDefinition(protocol: ProtocolDefinition): PlanDefinition {
  return {
    resourceType: "PlanDefinition",
    status: protocol.active ? "active" : "retired",
    name: protocol.stableKey,
    title: protocol.display,
    action: protocol.actionTemplates.map((action) => ({
      id: action.actionKey,
      title: action.display,
      code: [osodConcept(action.actionKind, action.actionKind)],
      precheckBehavior: action.defaultSelected ? "yes" : "no",
    })),
  };
}

export function projectProtocolActionToActivityDefinition(
  protocol: ProtocolDefinition,
  action: ProtocolActionTemplate,
): ActivityDefinition {
  return {
    resourceType: "ActivityDefinition",
    status: protocol.active ? "active" : "retired",
    name: `${protocol.stableKey}_${action.actionKey}`,
    title: action.display,
    kind: "Task",
    code: osodConcept(action.actionKind, action.actionKind),
  };
}

export function encounterDiagnosisComponent(
  conditionReference: string,
  diagnosis: EncounterDiagnosis,
) {
  return buildEncounterDiagnosisComponent(conditionReference, diagnosis.rank);
}

function glaucomaOpenAngleBorderlineCode(
  riskBucket: "low" | "high",
  laterality: EyeLaterality,
): string {
  const prefix = riskBucket === "high" ? "H40.02" : "H40.01";
  return `${prefix}${lateralityDigit(laterality)}`;
}

function lateralityDigit(laterality: EyeLaterality): "1" | "2" | "3" | "9" {
  if (laterality === "OD") return "1";
  if (laterality === "OS") return "2";
  if (laterality === "OU") return "3";
  return "9";
}

function lateralityDisplay(laterality: EyeLaterality): string {
  if (laterality === "OD") return "Right eye";
  if (laterality === "OS") return "Left eye";
  if (laterality === "OU") return "Bilateral";
  return "Unspecified eye";
}

function findingValueToObservationValue(
  value: FindingValue,
): Pick<Observation, "valueBoolean" | "valueQuantity" | "valueString"> {
  if (value.type === "quantity") {
    return {
      valueQuantity: quantity(
        value.value,
        value.unit,
        value.system ?? (value.code ? "http://unitsofmeasure.org" : undefined),
        value.code,
      ),
    };
  }
  if (value.type === "boolean") {
    return { valueBoolean: value.value };
  }
  if (value.type === "json") {
    return { valueString: JSON.stringify(value.value) };
  }
  return { valueString: value.value };
}

function codeableConcept(system: string, code: string, display?: string): CodeableConcept {
  return {
    coding: [{ system, code, ...(display ? { display } : {}) }],
    text: display ?? code,
  };
}

function observationSourceType(sourceType: FindingInstance["sourceType"]): SourceType {
  if (sourceType === "agent" || sourceType === "protocol") {
    return "unknown";
  }
  return sourceType;
}

export function ref<T extends Resource = Resource>(value: string): Reference<T> {
  return reference<T>(value);
}
