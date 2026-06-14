import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GLAUCOMA_PHASE0_LEDGER_PATH = resolve(
  REPO_ROOT,
  "data/code-bindings/glaucoma-suspect-phase0-ledger.json",
);

/**
 * Standard ICD-10-CM coding system used only after a ledger-attested diagnosis is confirmed.
 */
export const ICD10_CM_CODE_SYSTEM = "http://hl7.org/fhir/sid/icd-10-cm";

/**
 * CPT system identifier; numeric CPT values stay outside this AGPL repo and bind through adapters.
 */
export const CPT_CODE_SYSTEM = "urn:ama:cpt";

/**
 * Glaucoma-minimum cup/disc split used to create OSOD-local suggestion edges, not diagnoses.
 */
export const GLAUCOMA_CUP_DISC_HIGH_RISK_THRESHOLD = 0.6;

/** Source class recorded on OSOD-local graph rows for provenance and audit context. */
export type ClinicalGraphSource =
  | "manual"
  | "device"
  | "parser"
  | "agent"
  | "protocol"
  | "rule";

/** Neutral interpretation of a finding before any diagnosis is confirmed. */
export type FindingInterpretation = "normal" | "abnormal" | "borderline" | "unknown";

/** UI/reconciliation lifecycle for non-committal diagnosis suggestion edges. */
export type SuggestionVisitState =
  | "generated"
  | "shown"
  | "suppressed"
  | "accepted"
  | "rejected"
  | "expired"
  | "superseded";

/** Kinds of protocol actions the OSOD-local graph can prefill before clinician review. */
export type ProtocolActionKind =
  | "finding-prompt"
  | "plan-text"
  | "order"
  | "procedure"
  | "education"
  | "follow-up"
  | "charge-proposal";

/** Selection lifecycle for protocol-generated actions before they project to FHIR or billing. */
export type PlanActionState = "selected" | "removed" | "modified" | "deferred";

/** Coverage support state for a local procedure-charge rule, before final billing readiness. */
export type ProcedureChargeSupportStatus =
  | "allowed"
  | "needs-review"
  | "not-allowed"
  | "warn-only"
  | "provisional";

/** Charge proposal lifecycle before a selected charge becomes a ChargeItem. */
export type ChargeProposalStatus = "suggested" | "selected" | "removed" | "overridden" | "staged";

/** Mandate-14 coding state; only verified rows may project code-bearing FHIR artifacts. */
export type CodingStatus = "verified" | "placeholder" | "provisional";

/** Provenance carried by OSOD-local graph rows and copied into derived artifacts when useful. */
export interface ClinicalGraphProvenance {
  source: ClinicalGraphSource;
  recordedAt: string;
  actorReference?: string;
  sourceReferences?: string[];
  ledgerRefs?: string[];
  note?: string;
}

/** Practice-editable definition for a neutral clinical finding that can project to Observation. */
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

/** A patient encounter finding instance; it remains independent of diagnoses until linked as evidence. */
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

/** Value payload supported by the Phase 1 finding-to-Observation projector. */
export type FindingValue =
  | { type: "quantity"; value: number; unit: string; system?: string; code?: string }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "json"; value: Record<string, unknown> };

/** Diagnosis definition resolved from the Phase 0 ledger or held as a placeholder until attested. */
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

/** OSOD-local ranked candidate edge from a neutral finding to a possible diagnosis. */
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

/** Encounter diagnosis row; only explicit confirmed rows may project to FHIR Condition. */
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
  confirmedAt?: string;
}

/** Local editable protocol source; stable versions can project to PlanDefinition. */
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

/** Template action inside a protocol definition before patient-specific instantiation. */
export interface ProtocolActionTemplate {
  actionKey: string;
  actionKind: ProtocolActionKind;
  display: string;
  defaultSelected: boolean;
  mergeKey?: string;
}

/** Patient-specific action generated from a protocol and reconciled by the clinician. */
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

/** Local coverage rule linking diagnosis context to an internal procedure concept or adapter code. */
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

/** Staged billing candidate; not final billing until selected and projected downstream. */
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

/** Minimal ledger code row used to attest generated glaucoma diagnosis definitions. */
export interface GlaucomaPhase0DiagnosisCode {
  code: string;
  display: string;
  family: string;
  laterality: EyeLaterality;
  sourceRefs: string[];
}

/** Phase 0 ledger subset required by the glaucoma diagnosis resolver. */
export interface GlaucomaPhase0Ledger {
  accessDate?: string;
  diagnosisCodes: GlaucomaPhase0DiagnosisCode[];
}

/** Input to the glaucoma cup/disc predicate; produces a finding plus local suggestion edge only. */
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

/**
 * Builds a neutral finding definition that can be reused by manual, device, parser, or agent inputs.
 */
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

/**
 * Builds an encounter finding instance without implying any diagnosis or billing code.
 */
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

/**
 * Projects a neutral FindingInstance to FHIR Observation while preserving laterality and provenance.
 */
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

/**
 * Builds a diagnosis definition and rejects verified rows that lack an attested ICD-10-CM code.
 */
export function buildDiagnosisDefinition(
  input: Omit<DiagnosisDefinition, "id" | "active" | "applicableFindingDefinitionIds" | "separatesSeverityStagePayerRisk"> &
    Partial<Pick<DiagnosisDefinition, "id" | "active" | "applicableFindingDefinitionIds">>,
): DiagnosisDefinition {
  if (input.codingStatus === "verified" && !input.icd10Code) {
    throw new Error("Verified DiagnosisDefinition requires an ICD-10-CM code.");
  }

  return {
    ...input,
    id: input.id ?? randomUUID(),
    active: input.active ?? true,
    applicableFindingDefinitionIds: input.applicableFindingDefinitionIds ?? [],
    separatesSeverityStagePayerRisk: true,
  };
}

/**
 * Builds a non-committal suggestion edge; it is OSOD-local and never a confirmed diagnosis by itself.
 */
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

/**
 * Builds an OSOD-local encounter diagnosis; confirmation requires explicit status plus timestamp.
 */
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
  const verificationStatus = input.verificationStatus ?? "unconfirmed";
  if (verificationStatus === "confirmed" && !input.confirmedAt) {
    throw new Error("Confirmed EncounterDiagnosis requires confirmedAt.");
  }
  if (verificationStatus !== "confirmed" && input.confirmedAt) {
    throw new Error("Only confirmed EncounterDiagnosis rows can carry confirmedAt.");
  }

  return {
    ...input,
    id: input.id ?? randomUUID(),
    clinicalStatus: input.clinicalStatus ?? "active",
    verificationStatus,
    rank: input.rank ?? 1,
    evidenceFindingInstanceIds: input.evidenceFindingInstanceIds ?? [],
    evidenceObservationReferences: input.evidenceObservationReferences ?? [],
    confirmedAt: input.confirmedAt,
  };
}

/**
 * Projects only explicitly confirmed, ledger-verified encounter diagnoses to FHIR Condition.
 */
export function projectEncounterDiagnosisToCondition(
  encounterDiagnosis: EncounterDiagnosis,
  definition: DiagnosisDefinition,
): Condition {
  if (encounterDiagnosis.verificationStatus !== "confirmed") {
    throw new Error("Only confirmed EncounterDiagnosis rows can project to FHIR Condition.");
  }
  if (!encounterDiagnosis.confirmedAt) {
    throw new Error("Confirmed EncounterDiagnosis rows require confirmedAt before FHIR Condition projection.");
  }
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

/**
 * Builds the local source protocol that can later project a stable version to PlanDefinition.
 */
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

/**
 * Builds a patient-specific protocol action for clinician review before FHIR or billing projection.
 */
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

/**
 * Builds a local coverage rule; bill-ready status is withheld unless the rule is verified.
 */
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

/**
 * Builds a staged charge proposal that remains separate from final Claim submission.
 */
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

/**
 * Builds a glaucoma open-angle suspect diagnosis only after resolving its code/display in Phase 0.
 */
export function buildGlaucomaOpenAngleDiagnosisDefinition(input: {
  laterality: EyeLaterality;
  riskBucket: "low" | "high";
  provenance: ClinicalGraphProvenance;
  findingDefinitionIds?: string[];
  id?: string;
  ledger?: GlaucomaPhase0Ledger;
}): DiagnosisDefinition {
  const code = glaucomaOpenAngleBorderlineCode(input.riskBucket, input.laterality);
  const ledgerHit = resolveGlaucomaLedgerDiagnosis(code, input.ledger);
  const display = ledgerHit?.display ?? `Glaucoma suspect open angle ${input.riskBucket} risk ${input.laterality}`;
  const codingStatus: CodingStatus = ledgerHit ? "verified" : "placeholder";
  return buildDiagnosisDefinition({
    id: input.id,
    stableKey: `glaucoma_suspect_open_angle_${input.riskBucket}_${input.laterality.toLowerCase()}`,
    display,
    clinicalFamily: "glaucoma-suspect",
    icd10Family: input.riskBucket === "high" ? "H40.02-" : "H40.01-",
    ...(ledgerHit ? { icd10Code: ledgerHit.code, icd10Display: ledgerHit.display } : {}),
    codingStatus,
    lateralityRequired: true,
    applicableFindingDefinitionIds: input.findingDefinitionIds,
    provenance: ledgerHit ? input.provenance : mandate14PlaceholderProvenance(input.provenance),
  });
}

/**
 * Builds the glaucoma-minimum cup/disc finding plus suggestion edge; it never confirms a diagnosis.
 */
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

/**
 * Records clinician reconciliation of accepted Conditions and rejected OSOD-local suggestions.
 */
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

/**
 * Projects a coverage warning to FHIR DetectedIssue without making billing final.
 */
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

/**
 * Projects a selected charge proposal to a planned ChargeItem for downstream review.
 */
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

/**
 * Builds a FHIR Claim with diagnosis pointers after confirmed Conditions and charge items exist.
 */
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

/**
 * Projects a local protocol definition to FHIR PlanDefinition for stable/exported versions.
 */
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

/**
 * Projects a protocol action template to an ActivityDefinition for stable/exported versions.
 */
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

/**
 * Builds the Encounter.diagnosis component pointing at a confirmed Condition.
 */
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

let cachedGlaucomaPhase0Ledger: GlaucomaPhase0Ledger | undefined;

function resolveGlaucomaLedgerDiagnosis(
  code: string,
  ledger = loadGlaucomaPhase0Ledger(),
): GlaucomaPhase0DiagnosisCode | undefined {
  return ledger.diagnosisCodes.find((row) => row.code === code);
}

function loadGlaucomaPhase0Ledger(): GlaucomaPhase0Ledger {
  cachedGlaucomaPhase0Ledger ??= JSON.parse(
    readFileSync(GLAUCOMA_PHASE0_LEDGER_PATH, "utf8"),
  ) as GlaucomaPhase0Ledger;
  return cachedGlaucomaPhase0Ledger;
}

function mandate14PlaceholderProvenance(
  provenance: ClinicalGraphProvenance,
): ClinicalGraphProvenance {
  return {
    ...provenance,
    note: [
      provenance.note,
      "Mandate-14 TODO: resolve generated glaucoma-suspect diagnosis against the Phase-0 ledger before verified projection.",
    ].filter(Boolean).join(" "),
  };
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

/**
 * Creates a typed FHIR Reference from a literal resource reference string.
 */
export function ref<T extends Resource = Resource>(value: string): Reference<T> {
  return reference<T>(value);
}
