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
  Provenance,
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
  odosConcept,
  quantity,
  reference,
} from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { buildDiagnosisCatalogSeeds } from "./diagnosis-catalog-seeds.js";

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

export const GLAUCOMA_FINDING_DEFINITION_KEYS = [
  "cup_disc_ratio",
  "intraocular_pressure",
  "corneal_hysteresis",
  "pachymetry_um",
  "rnfl_gcc",
] as const;

export type GlaucomaFindingDefinitionKey = typeof GLAUCOMA_FINDING_DEFINITION_KEYS[number];

const GLAUCOMA_FINDING_STUB_METADATA: Record<
  GlaucomaFindingDefinitionKey,
  Pick<ClinicalFindingDefinition, "sectionKey" | "anatomyTarget"> & {
    valueKind: "quantity" | "component-panel";
  }
> = {
  cup_disc_ratio: {
    sectionKey: "optic-nerve",
    anatomyTarget: "optic-nerve",
    valueKind: "quantity",
  },
  intraocular_pressure: {
    sectionKey: "tonometry",
    anatomyTarget: "eye",
    valueKind: "quantity",
  },
  corneal_hysteresis: {
    sectionKey: "tonometry",
    anatomyTarget: "cornea",
    valueKind: "quantity",
  },
  pachymetry_um: {
    sectionKey: "cornea",
    anatomyTarget: "cornea",
    valueKind: "quantity",
  },
  rnfl_gcc: {
    sectionKey: "oct",
    anatomyTarget: "retina",
    valueKind: "component-panel",
  },
};

/** Source class recorded on ODOS-local graph rows for provenance and audit context. */
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
  | "unreviewed"
  | "generated"
  | "shown"
  | "suppressed"
  | "accepted"
  | "rejected"
  | "expired"
  | "superseded";

/** Kinds of protocol actions the ODOS-local graph can prefill before clinician review. */
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

/** Provenance carried by ODOS-local graph rows and copied into derived artifacts when useful. */
export interface ClinicalGraphProvenance {
  source: ClinicalGraphSource;
  recordedAt: string;
  actorReference?: string;
  sourceReferences?: string[];
  ledgerRefs?: string[];
  note?: string;
}

export function patientScopedProvenanceTargets(
  primaryReference: string,
  patientReference: string,
): Reference[] {
  return [reference(primaryReference), reference(patientReference)];
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
  diagnosisCandidates?: DiagnosisCandidateEntry[];
  documentationElements?: DocumentationElementEntry[];
  allowDiagnosisMapping?: boolean;
  notBillReady: boolean;
  active: boolean;
  provenance: ClinicalGraphProvenance;
}

export type DocumentationElementValue = "normal" | "abnormal" | "deferred" | "absent";

export interface DocumentationElementEntry {
  code: string;
  origin: "seed" | "practice";
  active: boolean;
}

export type MappingTrigger =
  | { kind: "always" }
  | { kind: "abnormal" }
  | { kind: "numeric"; field: string; op: ">=" | "<=" | ">" | "<" | "=="; value: number }
  | { kind: "option"; field: string; anyOf: string[] };

export interface DiagnosisCandidateEntry {
  id: string;
  diagnosisKey: string;
  trigger: MappingTrigger;
  priority?: boolean;
  origin: "seed" | "practice";
  active: boolean;
}

export interface KeyFindingEntry {
  findingKey: string;
  label?: string;
  satisfiedBy: "this-encounter" | "any-on-file";
  withinMonths?: number;
  origin: "seed" | "practice";
  active: boolean;
}

export type DiagnosisIcd10 =
  | { code: string; display?: string }
  | {
      pattern: {
        unspecifiedEye?: string;
        right?: string;
        left?: string;
        bilateral?: string;
      };
    };

export interface DiagnosisCatalogRow extends DiagnosisDefinition {
  icd10?: DiagnosisIcd10;
  snomed?: { code: string; display: string };
  keyFindings?: KeyFindingEntry[];
  origin: "seed" | "practice";
}

/** A patient encounter finding instance; it remains independent of diagnoses until linked as evidence. */
export interface FindingInstance {
  id: string;
  /** Proposed findings are epistemically inert and may not project to Observation or diagnosis evidence. */
  state: "proposed" | "committed";
  findingDefinitionId: string;
  patientReference: string;
  encounterReference: string;
  observationReference?: string;
  laterality: EyeLaterality;
  value: FindingValue;
  interpretation?: FindingInterpretation;
  method?: CodeableConcept;
  performerReferences?: string[];
  sourceReferences?: string[];
  sourceType: SourceType | "agent" | "protocol";
  confidence?: number;
  recordedAt: string;
  provenance: ClinicalGraphProvenance;
}

/** Value payload supported by the Phase 1 finding-to-Observation projector. */
export type FindingValue =
  | { type: "quantity"; value: number; unit: string; system?: string; code?: string }
  | {
      type: "components";
      components: Array<{
        code: string;
        display: string;
        value: number | string | boolean;
        unit?: string;
        system?: string;
        unitCode?: string;
      }>;
    }
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

/** ODOS-local ranked candidate edge from a neutral finding to a possible diagnosis. */
export interface DiagnosisSuggestionEdge {
  id: string;
  sourceFindingDefinitionId?: string;
  sourceFindingInstanceId?: string;
  targetDiagnosisDefinitionId: string;
  predicateKey: string;
  predicateExpression: Record<string, unknown>;
  rank: number;
  score: number;
  confidence?: number;
  explanation: string;
  evidenceFindingInstanceIds: string[];
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
  stubs?: {
    findingDefinitions?: GlaucomaFindingDefinitionStubRow[];
  };
}

export interface GlaucomaFindingDefinitionStubRow {
  key: GlaucomaFindingDefinitionKey;
  display: string;
  status: ClinicalFindingDefinition["sourceStatus"];
  notBillReady: boolean;
  externalCode: null;
  valueSchema?: Record<string, unknown>;
  normalSemantics?: Record<string, unknown>;
}

/** Input to the glaucoma cup/disc predicate; produces a finding plus local suggestion edge only. */
export interface GlaucomaPredicateInput {
  cupDiscRatio: number;
  horizontalCupDiscRatio?: number;
  verticalCupDiscRatioOd?: number;
  verticalCupDiscRatioOs?: number;
  discAppearanceDescriptors?: string[];
  discNerveSize?: string;
  methodSource?: string;
  notVisualized?: boolean;
  riskConfig?: GlaucomaCupDiscRiskConfig;
  findingDefinition?: ClinicalFindingDefinition;
  ledger?: GlaucomaPhase0Ledger;
  laterality: EyeLaterality;
  patientReference: string;
  encounterReference: string;
  findingDefinitionId: string;
  findingInstanceId: string;
  recordedAt: string;
  provenance: ClinicalGraphProvenance;
}

export interface GlaucomaCupDiscRiskConfig {
  lowFloor?: number;
  highFloor?: number;
  asymmetryLow?: number;
  asymmetryHigh?: number;
}

export interface GlaucomaIopRiskConfig {
  ohtnThreshold?: number;
}

export interface CaptureGlaucomaFindingInput {
  definition: ClinicalFindingDefinition;
  patientReference: string;
  encounterReference: string;
  laterality: EyeLaterality;
  value: FindingValue;
  recordedAt: string;
  provenance: ClinicalGraphProvenance;
  findingInstanceId?: string;
  observationId?: string;
  interpretation?: FindingInterpretation;
  sourceType?: FindingInstance["sourceType"];
  confidence?: number;
  method?: CodeableConcept;
  performerReferences?: string[];
  sourceReferences?: string[];
}

export interface CapturedGlaucomaFinding {
  finding: FindingInstance;
  observation: Observation;
  provenance: Provenance;
}

export interface GlaucomaSuggestionEngineInput {
  findings: readonly FindingInstance[];
  findingDefinitions: readonly ClinicalFindingDefinition[];
  provenance: ClinicalGraphProvenance;
  encounterReference?: string;
  ledger?: GlaucomaPhase0Ledger;
  riskConfig?: GlaucomaCupDiscRiskConfig;
}

export interface GlaucomaIopSuggestionEngineInput
  extends Omit<GlaucomaSuggestionEngineInput, "riskConfig"> {
  riskConfig?: GlaucomaIopRiskConfig;
}

export interface DiagnosisSuggestionEvaluation {
  diagnosisDefinition: DiagnosisDefinition;
  suggestionEdge: DiagnosisSuggestionEdge;
}

export interface GlaucomaCupDiscSuggestionResult {
  finding: FindingInstance;
  diagnosisDefinition?: DiagnosisDefinition;
  suggestionEdge?: DiagnosisSuggestionEdge;
}

export type GlaucomaIopRiskTier = "normal" | "ohtn";

export interface GlaucomaIopRiskEvaluation {
  riskTier: GlaucomaIopRiskTier;
  threshold: number;
  value?: number;
  notVisualized: boolean;
  signals: string[];
}

export interface ClinicalFindingOption {
  code: string;
  display: string;
  active?: boolean;
  highRiskDriver?: boolean;
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
    allowDiagnosisMapping: input.allowDiagnosisMapping ?? true,
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
    performerReferences: input.performerReferences ?? [],
    sourceReferences: input.sourceReferences ?? [],
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
  if (finding.state !== "committed") {
    throw new Error("Proposed findings are epistemically inert and cannot project to Observation.");
  }
  const base: Observation = {
    resourceType: "Observation",
    id: finding.observationReference?.startsWith("Observation/")
      ? finding.observationReference.slice("Observation/".length)
      : undefined,
    status: "preliminary",
    code: definition.fhirObservationCode ?? odosConcept(definition.stableKey, definition.display),
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
    method: finding.method,
    performerReferences: finding.performerReferences?.length
      ? finding.performerReferences
      : finding.provenance.actorReference
        ? [finding.provenance.actorReference]
        : undefined,
    sourceReferences: finding.sourceReferences?.length
      ? finding.sourceReferences
      : finding.provenance.sourceReferences,
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
 * Builds a non-committal suggestion edge; it is ODOS-local and never a confirmed diagnosis by itself.
 */
export function buildDiagnosisSuggestionEdge(
  input: Omit<DiagnosisSuggestionEdge, "id" | "visitState" | "evidenceFindingInstanceIds" | "score"> &
    Partial<Pick<DiagnosisSuggestionEdge, "id" | "visitState" | "evidenceFindingInstanceIds" | "score">>,
): DiagnosisSuggestionEdge {
  if (!input.sourceFindingDefinitionId && !input.sourceFindingInstanceId) {
    throw new Error("DiagnosisSuggestionEdge requires a source finding definition or instance.");
  }
  return {
    ...input,
    id: input.id ?? randomUUID(),
    evidenceFindingInstanceIds: input.evidenceFindingInstanceIds ??
      (input.sourceFindingInstanceId ? [input.sourceFindingInstanceId] : []),
    score: input.score ?? input.confidence ?? 1 / input.rank,
    visitState: input.visitState ?? "unreviewed",
  };
}

/**
 * Builds an ODOS-local encounter diagnosis; confirmation requires explicit status plus timestamp.
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
  riskTier: GlaucomaCupDiscSuspectRiskTier;
  provenance: ClinicalGraphProvenance;
  findingDefinitionIds?: string[];
  id?: string;
  ledger?: GlaucomaPhase0Ledger;
}): DiagnosisDefinition {
  const catalogRow = buildDiagnosisCatalogSeeds().find((row) =>
    row.stableKey === `glaucoma_suspect_open_angle_${input.riskTier}`
  );
  if (!catalogRow) throw new Error(`Glaucoma ${input.riskTier}-risk diagnosis catalog seed is missing.`);
  const code = diagnosisCatalogCode(catalogRow, input.laterality);
  const ledgerHit = resolveGlaucomaLedgerDiagnosis(code, input.ledger);
  const display = ledgerHit?.display ?? `Glaucoma suspect open angle ${input.riskTier} risk ${input.laterality}`;
  const codingStatus: CodingStatus = ledgerHit ? "verified" : "placeholder";
  return buildDiagnosisDefinition({
    id: input.id,
    stableKey: `glaucoma_suspect_open_angle_${input.riskTier}_${input.laterality.toLowerCase()}`,
    display,
    clinicalFamily: "glaucoma-suspect",
    icd10Family: input.riskTier === "high" ? "H40.02-" : "H40.01-",
    ...(ledgerHit ? { icd10Code: ledgerHit.code, icd10Display: ledgerHit.display } : {}),
    codingStatus,
    lateralityRequired: true,
    applicableFindingDefinitionIds: input.findingDefinitionIds,
    provenance: ledgerHit ? input.provenance : mandate14PlaceholderProvenance(input.provenance),
  });
}

export function buildGlaucomaFindingDefinitionStubs(input: {
  provenance: ClinicalGraphProvenance;
  ledger?: GlaucomaPhase0Ledger;
}): ClinicalFindingDefinition[] {
  const rows = input.ledger?.stubs?.findingDefinitions ??
    loadGlaucomaPhase0Ledger().stubs?.findingDefinitions ??
    [];

  return rows.map((row) => buildGlaucomaFindingDefinitionStub(row, input.provenance));
}

export function buildGlaucomaFindingDefinitionStub(
  row: GlaucomaFindingDefinitionStubRow,
  provenance: ClinicalGraphProvenance,
): ClinicalFindingDefinition {
  const metadata = GLAUCOMA_FINDING_STUB_METADATA[row.key];
  const seeded = row.valueSchema !== undefined;
  return buildClinicalFindingDefinition({
    id: `finding-def-${row.key.replaceAll("_", "-")}`,
    stableKey: row.key,
    display: row.display,
    sectionKey: metadata.sectionKey,
    anatomyTarget: metadata.anatomyTarget,
    valueSchema: row.valueSchema ?? glaucomaOperatorGatedValueSchema(metadata.valueKind),
    normalSemantics: row.normalSemantics ?? {
      status: "TODO: operator input required before clinical normal/abnormal semantics are seeded.",
    },
    sourceStatus: row.status,
    notBillReady: row.notBillReady,
    active: true,
    provenance: {
      ...provenance,
      note: [
        provenance.note,
        seeded
          ? "Seeded glaucoma finding definition; practice may edit option lists and risk parameter data before local use."
          : "Operator-gated glaucoma finding definition stub; no clinical value-set, unit binding, normal range, or threshold seeded.",
      ].filter(Boolean).join(" "),
    },
  });
}

export function glaucomaOperatorGatedValueSchema(
  valueKind: "quantity" | "component-panel",
): Record<string, unknown> {
  return {
    valueKind,
    operatorInputRequired: true,
    units: "TODO: operator input required before bill-ready use.",
    normalRange: "TODO: operator input required before bill-ready use.",
    seededPredicateExamples: [],
  };
}

export function getGlaucomaCupDiscDescriptorOptions(
  definition: ClinicalFindingDefinition,
): ClinicalFindingOption[] {
  return getClinicalFindingFieldOptions(definition, "discAppearanceDescriptors");
}

export function addGlaucomaCupDiscDescriptorOption(
  definition: ClinicalFindingDefinition,
  option: ClinicalFindingOption,
): ClinicalFindingDefinition {
  return addClinicalFindingFieldOption(definition, "discAppearanceDescriptors", option);
}

export function getGlaucomaIopMethodOptions(
  definition: ClinicalFindingDefinition,
): ClinicalFindingOption[] {
  return getClinicalFindingFieldOptions(definition, "method");
}

export function addGlaucomaIopMethodOption(
  definition: ClinicalFindingDefinition,
  option: ClinicalFindingOption,
): ClinicalFindingDefinition {
  return addClinicalFindingFieldOption(definition, "method", option);
}

function getClinicalFindingFieldOptions(
  definition: ClinicalFindingDefinition,
  fieldKey: string,
): ClinicalFindingOption[] {
  const options = asRecord(asRecord(definition.valueSchema.fields)[fieldKey]).options;
  return Array.isArray(options)
    ? options
        .map((option) => parseClinicalFindingOption(option))
        .filter((option): option is ClinicalFindingOption => Boolean(option))
    : [];
}

function addClinicalFindingFieldOption(
  definition: ClinicalFindingDefinition,
  fieldKey: string,
  option: ClinicalFindingOption,
): ClinicalFindingDefinition {
  const valueSchema = { ...definition.valueSchema };
  const fields = { ...asRecord(valueSchema.fields) };
  const field = { ...asRecord(fields[fieldKey]) };
  const options = getClinicalFindingFieldOptions(definition, fieldKey);
  field.options = [
    ...options.filter((candidate) => candidate.code !== option.code),
    option,
  ];
  fields[fieldKey] = field;
  valueSchema.fields = fields;
  return {
    ...definition,
    valueSchema,
  };
}

export function captureGlaucomaFinding(input: CaptureGlaucomaFindingInput): CapturedGlaucomaFinding {
  const findingId = input.findingInstanceId ??
    deterministicGraphId("finding", input.definition.stableKey, input.laterality, input.recordedAt);
  const observationReference = `Observation/${input.observationId ?? findingId}`;
  const performerReferences = input.performerReferences ??
    (input.provenance.actorReference ? [input.provenance.actorReference] : []);
  const sourceReferences = input.sourceReferences ?? input.provenance.sourceReferences ?? [];
  const finding = buildFindingInstance({
    id: findingId,
    state: "committed",
    findingDefinitionId: input.definition.id,
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    observationReference,
    laterality: input.laterality,
    value: input.value,
    interpretation: input.interpretation,
    method: input.method,
    performerReferences,
    sourceReferences,
    sourceType: input.sourceType,
    confidence: input.confidence,
    recordedAt: input.recordedAt,
    provenance: input.provenance,
  });
  const observation = projectFindingInstanceToObservation(finding, input.definition);
  const provenance = buildProvenance({
    targetReferences: [observationReference],
    occurredDateTime: input.recordedAt,
    recorded: input.recordedAt,
    activityCode: "CREATE",
    activityDisplay: "Capture glaucoma finding evidence",
    agents: [
      input.provenance.actorReference
        ? {
            typeCode: "author",
            typeDisplay: "Author",
            whoReference: input.provenance.actorReference,
          }
        : {
            typeCode: "author",
            typeDisplay: "Author",
            whoDisplay: `ODOS ${input.provenance.source} evidence source`,
          },
    ],
    entityReferences: sourceReferences,
    entityValues: (input.provenance.ledgerRefs ?? []).map((ledgerRef) => ({
      role: "source" as const,
      display: ledgerRef,
    })),
  });

  return { finding, observation, provenance };
}

/**
 * Builds the glaucoma-minimum cup/disc finding plus suggestion edge; it never confirms a diagnosis.
 */
export function buildGlaucomaCupDiscSuggestion(input: GlaucomaPredicateInput): {
  finding: FindingInstance;
  diagnosisDefinition?: DiagnosisDefinition;
  suggestionEdge?: DiagnosisSuggestionEdge;
} {
  const definition = input.findingDefinition ??
    defaultGlaucomaCupDiscFindingDefinition(input.provenance, input.ledger);
  const evidence = cupDiscEvidenceFromPredicateInput(input);
  const risk = evaluateCupDiscRisk(evidence, definition, input.riskConfig);
  const finding = buildFindingInstance({
    id: input.findingInstanceId,
    state: "committed",
    findingDefinitionId: input.findingDefinitionId,
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    laterality: input.laterality,
    value: cupDiscFindingValueFromPredicateInput(input),
    interpretation: evidence.notVisualized ? "unknown" : cupDiscInterpretationForRiskTier(risk.riskTier),
    recordedAt: input.recordedAt,
    provenance: input.provenance,
  });
  if (evidence.notVisualized || risk.riskTier === "normal") {
    return { finding };
  }
  const diagnosisDefinition = buildGlaucomaOpenAngleDiagnosisDefinition({
    laterality: input.laterality,
    riskTier: risk.riskTier,
    provenance: input.provenance,
    findingDefinitionIds: [input.findingDefinitionId],
    ledger: input.ledger,
  });
  const suggestionEdge = buildDiagnosisSuggestionEdge({
    sourceFindingInstanceId: finding.id,
    targetDiagnosisDefinitionId: diagnosisDefinition.id,
    predicateKey: "glaucoma_suspect_cup_disc_multisignal_v1",
    predicateExpression: cupDiscPredicateExpression(risk, evidence),
    rank: 1,
    score: cupDiscSuggestionScore(risk.riskTier),
    confidence: cupDiscSuggestionScore(risk.riskTier),
    explanation: cupDiscRiskExplanation(risk),
    ruleVersion: "glaucoma-cup-disc-multisignal-v1",
    provenance: input.provenance,
  });

  return { finding, diagnosisDefinition, suggestionEdge };
}

export function evaluateGlaucomaDiagnosisSuggestions(
  input: GlaucomaSuggestionEngineInput,
): DiagnosisSuggestionEvaluation[] {
  const definitionsById = new Map(input.findingDefinitions.map((definition) => [definition.id, definition]));
  const cupDiscFindings = input.findings
    .filter((finding) => finding.state === "committed")
    .filter((finding) => !input.encounterReference || finding.encounterReference === input.encounterReference)
    .filter((finding) => definitionsById.get(finding.findingDefinitionId)?.stableKey === "cup_disc_ratio")
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
  const evidenceByFindingId = new Map(
    cupDiscFindings.map((finding) => [finding.id, cupDiscEvidenceFromFindingValue(finding.value, finding)]),
  );
  const evaluations = cupDiscFindings
    .map((finding) => {
      const definition = definitionsById.get(finding.findingDefinitionId);
      const evidence = evidenceByFindingId.get(finding.id);
      if (!definition || !evidence || evidence.notVisualized) {
        return undefined;
      }
      const enrichedEvidence = withCrossFindingCupDiscAsymmetry(
        finding,
        evidence,
        cupDiscFindings,
        evidenceByFindingId,
      );
      const risk = evaluateCupDiscRisk(enrichedEvidence, definition, input.riskConfig);
      if (risk.riskTier === "normal") {
        return undefined;
      }
      const diagnosisDefinition = buildGlaucomaOpenAngleDiagnosisDefinition({
        id: deterministicGraphId("dx-def", "glaucoma-suspect-open-angle", risk.riskTier, finding.laterality),
        laterality: finding.laterality,
        riskTier: risk.riskTier,
        provenance: input.provenance,
        findingDefinitionIds: [definition.id],
        ledger: input.ledger,
      });
      const score = cupDiscSuggestionScore(risk.riskTier);
      const suggestionEdge = buildDiagnosisSuggestionEdge({
        id: deterministicGraphId(
          "suggestion",
          finding.id,
          "glaucoma-suspect-open-angle",
          risk.riskTier,
          finding.laterality,
        ),
        sourceFindingDefinitionId: definition.id,
        sourceFindingInstanceId: finding.id,
        targetDiagnosisDefinitionId: diagnosisDefinition.id,
        predicateKey: "glaucoma_suspect_cup_disc_multisignal_v1",
        predicateExpression: cupDiscPredicateExpression(risk, enrichedEvidence),
        rank: 1,
        score,
        confidence: score,
        explanation: cupDiscRiskExplanation(risk),
        evidenceFindingInstanceIds: [finding.id],
        ruleVersion: "glaucoma-cup-disc-multisignal-v1",
        visitState: "unreviewed",
        provenance: {
          ...input.provenance,
          source: "rule",
          sourceReferences: [
            ...(finding.observationReference ? [finding.observationReference] : []),
            ...(input.provenance.sourceReferences ?? []),
          ],
          note: [
            input.provenance.note,
            "Pure glaucoma cup/disc evaluator: finding evidence in, suggestion edge out; no EncounterDiagnosis, Condition, charge, or coverage side effects.",
          ].filter(Boolean).join(" "),
        },
      });

      return { diagnosisDefinition, suggestionEdge };
    })
    .filter((result): result is DiagnosisSuggestionEvaluation => Boolean(result))
    .sort((a, b) =>
      b.suggestionEdge.score - a.suggestionEdge.score ||
      a.suggestionEdge.id.localeCompare(b.suggestionEdge.id));

  return evaluations.map((evaluation, index) => ({
    diagnosisDefinition: evaluation.diagnosisDefinition,
    suggestionEdge: {
      ...evaluation.suggestionEdge,
      rank: index + 1,
    },
  }));
}

export function buildOcularHypertensionDiagnosisDefinition(input: {
  laterality: EyeLaterality;
  provenance: ClinicalGraphProvenance;
  findingDefinitionIds?: string[];
  id?: string;
  ledger?: GlaucomaPhase0Ledger;
}): DiagnosisDefinition {
  const catalogRow = buildDiagnosisCatalogSeeds().find((row) => row.stableKey === "ocular_hypertension");
  if (!catalogRow) throw new Error("Ocular-hypertension diagnosis catalog seed is missing.");
  const code = diagnosisCatalogCode(catalogRow, input.laterality);
  const ledgerHit = resolveGlaucomaLedgerDiagnosis(code, input.ledger);
  if (!ledgerHit) {
    throw new Error(`Ocular hypertension ICD-10-CM code ${code} is missing from the Phase 0 ledger.`);
  }
  return buildDiagnosisDefinition({
    id: input.id,
    stableKey: `ocular_hypertension_${input.laterality.toLowerCase()}`,
    display: ledgerHit.display,
    clinicalFamily: "ocular-hypertension",
    icd10Family: "H40.05-",
    icd10Code: ledgerHit.code,
    icd10Display: ledgerHit.display,
    codingStatus: "verified",
    lateralityRequired: true,
    applicableFindingDefinitionIds: input.findingDefinitionIds,
    provenance: input.provenance,
  });
}

export function evaluateIopFindingRisk(
  finding: FindingInstance,
  definition: ClinicalFindingDefinition,
  riskConfig?: GlaucomaIopRiskConfig,
): GlaucomaIopRiskEvaluation {
  const evidence = iopEvidenceFromFindingValue(finding.value);
  const threshold = resolveIopRiskThreshold(definition, riskConfig);
  if (evidence.notVisualized || evidence.value === undefined) {
    return {
      riskTier: "normal",
      threshold,
      notVisualized: evidence.notVisualized,
      signals: [],
    };
  }
  const riskTier: GlaucomaIopRiskTier = evidence.value >= threshold ? "ohtn" : "normal";
  return {
    riskTier,
    threshold,
    value: evidence.value,
    notVisualized: false,
    signals: riskTier === "ohtn" ? ["iop-threshold"] : [],
  };
}

export function evaluateIopDiagnosisSuggestions(
  input: GlaucomaIopSuggestionEngineInput,
): DiagnosisSuggestionEvaluation[] {
  const definitionsById = new Map(input.findingDefinitions.map((definition) => [definition.id, definition]));
  const iopFindings = input.findings
    .filter((finding) => !input.encounterReference || finding.encounterReference === input.encounterReference)
    .filter((finding) => definitionsById.get(finding.findingDefinitionId)?.stableKey === "intraocular_pressure")
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));

  const evaluations = iopFindings
    .map((finding) => {
      const definition = definitionsById.get(finding.findingDefinitionId);
      if (!definition) {
        return undefined;
      }
      const risk = evaluateIopFindingRisk(finding, definition, input.riskConfig);
      if (risk.riskTier === "normal" || risk.value === undefined) {
        return undefined;
      }
      const diagnosisDefinition = buildOcularHypertensionDiagnosisDefinition({
        id: deterministicGraphId("dx-def", "ocular-hypertension", finding.laterality),
        laterality: finding.laterality,
        provenance: input.provenance,
        findingDefinitionIds: [definition.id],
        ledger: input.ledger,
      });
      const suggestionEdge = buildDiagnosisSuggestionEdge({
        id: deterministicGraphId("suggestion", finding.id, "ocular-hypertension", finding.laterality),
        sourceFindingDefinitionId: definition.id,
        sourceFindingInstanceId: finding.id,
        targetDiagnosisDefinitionId: diagnosisDefinition.id,
        predicateKey: "ocular_hypertension_iop_single_tier_v1",
        predicateExpression: {
          finding: "intraocular_pressure",
          predicate: "single-tier-ocular-hypertension-iop",
          riskTier: risk.riskTier,
          threshold: risk.threshold,
          observed: definedRecord({
            intraocularPressure: risk.value,
            unit: "mmHg",
            notVisualized: risk.notVisualized,
          }),
          signals: risk.signals,
          deferred: ["rule-versioning", "recalc-invalidation", "cross-recompute-persistence"],
        },
        rank: 1,
        score: 0.65,
        confidence: 0.65,
        explanation: `Ocular-hypertension suspect suggestion because IOP ${risk.value} mmHg is >= threshold ${risk.threshold} mmHg.`,
        evidenceFindingInstanceIds: [finding.id],
        ruleVersion: "ocular-hypertension-iop-v1",
        visitState: "unreviewed",
        provenance: {
          ...input.provenance,
          source: "rule",
          sourceReferences: [
            ...(finding.observationReference ? [finding.observationReference] : []),
            ...(input.provenance.sourceReferences ?? []),
          ],
          note: [
            input.provenance.note,
            "Pure IOP evaluator: finding evidence in, ocular-hypertension suggestion edge out; no EncounterDiagnosis, Condition, charge, or coverage side effects.",
          ].filter(Boolean).join(" "),
        },
      });
      return { diagnosisDefinition, suggestionEdge };
    })
    .filter((result): result is DiagnosisSuggestionEvaluation => Boolean(result))
    .sort((a, b) =>
      b.suggestionEdge.score - a.suggestionEdge.score ||
      a.suggestionEdge.id.localeCompare(b.suggestionEdge.id));

  return evaluations.map((evaluation, index) => ({
    diagnosisDefinition: evaluation.diagnosisDefinition,
    suggestionEdge: {
      ...evaluation.suggestionEdge,
      rank: index + 1,
    },
  }));
}

export function rejectDiagnosisSuggestionEdge(
  edge: DiagnosisSuggestionEdge,
  input: { rejectedAt: string; provenance?: ClinicalGraphProvenance; reason?: string },
): DiagnosisSuggestionEdge {
  return {
    ...edge,
    visitState: "rejected",
    acceptedAt: undefined,
    rejectedAt: input.rejectedAt,
    provenance: {
      ...edge.provenance,
      ...(input.provenance ?? {}),
      note: [
        edge.provenance.note,
        input.provenance?.note,
        input.reason ? `Rejected suggestion: ${input.reason}` : undefined,
      ].filter(Boolean).join(" "),
    },
  };
}

/**
 * Records clinician reconciliation of accepted Conditions and rejected ODOS-local suggestions.
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
            code: odosConcept("reviewed-observations", "Reviewed observations"),
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
    code: odosConcept("coverage-warning", "Coverage warning"),
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
    type: odosConcept("professional", "Professional"),
    use: "claim",
    patient: reference(input.patientReference),
    created: input.created,
    provider: reference(input.providerReference),
    priority: odosConcept("normal", "Normal"),
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
      code: [odosConcept(action.actionKind, action.actionKind)],
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
    code: odosConcept(action.actionKind, action.actionKind),
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

interface IopRiskEvidence {
  value?: number;
  notVisualized: boolean;
}

function iopEvidenceFromFindingValue(value: FindingValue): IopRiskEvidence {
  if (value.type === "quantity") {
    return { value: value.value, notVisualized: false };
  }
  if (value.type === "json") {
    return {
      value: readNumber(value.value.value) ??
        readNumber(value.value.intraocularPressure) ??
        readNumber(value.value.iop),
      notVisualized: readBoolean(value.value.notVisualized) ??
        readBoolean(value.value.deferred) ??
        false,
    };
  }
  if (value.type === "components") {
    const evidence: IopRiskEvidence = { notVisualized: false };
    for (const component of value.components) {
      const code = normalizeDescriptorCode(component.code);
      if (code === "intraocular-pressure" || code === "iop") {
        evidence.value = readNumber(component.value);
      } else if (code === "not-visualized" || code === "deferred" || code === "not-visualized-deferred") {
        evidence.notVisualized = readBoolean(component.value) ?? evidence.notVisualized;
      }
    }
    return evidence;
  }
  return { notVisualized: false };
}

export function resolveIopRiskThreshold(
  definition: ClinicalFindingDefinition,
  riskConfig?: GlaucomaIopRiskConfig,
): number {
  if (riskConfig?.ohtnThreshold !== undefined) {
    return assertIopThreshold(riskConfig.ohtnThreshold, "ohtnThreshold");
  }
  const riskPredicate = asRecord(definition.normalSemantics?.riskPredicate);
  const thresholdParameters = asRecord(riskPredicate.thresholdParameters);
  const parameter = asRecord(thresholdParameters.ohtnThreshold);
  const defaultValue = readNumber(parameter.defaultValue);
  if (defaultValue === undefined) {
    throw new Error("IOP risk parameter ohtnThreshold defaultValue is missing from the finding definition.");
  }
  return assertIopThreshold(defaultValue, "IOP risk parameter ohtnThreshold default");
}

function assertIopThreshold(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 3 || value > 80) {
    throw new Error(`${name} must be a finite IOP value from 3 to 80 mmHg.`);
  }
  return value;
}

interface CupDiscRiskEvidence {
  verticalCupDiscRatio?: number;
  horizontalCupDiscRatio?: number;
  verticalCupDiscRatioOd?: number;
  verticalCupDiscRatioOs?: number;
  asymmetry?: number;
  descriptors: string[];
  discNerveSize?: string;
  methodSource?: string;
  notVisualized: boolean;
}

interface CupDiscRiskSignal {
  key: string;
  display: string;
  observedValue?: number | string;
}

export type GlaucomaCupDiscRiskTier = "normal" | "low" | "high";
export type GlaucomaCupDiscSuspectRiskTier = Exclude<GlaucomaCupDiscRiskTier, "normal">;

interface CupDiscRiskThresholds {
  lowFloor: number;
  highFloor: number;
  asymmetryLow: number;
  asymmetryHigh: number;
}

interface CupDiscRiskEvaluation {
  riskTier: GlaucomaCupDiscRiskTier;
  thresholds: CupDiscRiskThresholds;
  lowSignals: CupDiscRiskSignal[];
  highSignals: CupDiscRiskSignal[];
}

function defaultGlaucomaCupDiscFindingDefinition(
  provenance: ClinicalGraphProvenance,
  ledger?: GlaucomaPhase0Ledger,
): ClinicalFindingDefinition {
  const definition = buildGlaucomaFindingDefinitionStubs({ provenance, ledger })
    .find((row) => row.stableKey === "cup_disc_ratio");
  if (!definition) {
    throw new Error("Glaucoma cup/disc finding definition seed is missing.");
  }
  return definition;
}

function cupDiscFindingValueFromPredicateInput(input: GlaucomaPredicateInput): FindingValue {
  const descriptorSelections = input.discAppearanceDescriptors ?? [];
  const hasExtendedPayload =
    input.horizontalCupDiscRatio !== undefined ||
    input.verticalCupDiscRatioOd !== undefined ||
    input.verticalCupDiscRatioOs !== undefined ||
    descriptorSelections.length > 0 ||
    input.discNerveSize !== undefined ||
    input.methodSource !== undefined ||
    input.notVisualized === true;
  if (!hasExtendedPayload) {
    return { type: "quantity", value: input.cupDiscRatio, unit: "ratio", code: "1" };
  }
  return {
    type: "json",
    value: definedRecord({
      verticalCupDiscRatio: input.cupDiscRatio,
      horizontalCupDiscRatio: input.horizontalCupDiscRatio,
      verticalCupDiscRatioOd: input.verticalCupDiscRatioOd,
      verticalCupDiscRatioOs: input.verticalCupDiscRatioOs,
      discAppearanceDescriptors: descriptorSelections,
      discNerveSize: input.discNerveSize,
      methodSource: input.methodSource,
      notVisualized: input.notVisualized === true,
    }),
  };
}

function cupDiscEvidenceFromPredicateInput(input: GlaucomaPredicateInput): CupDiscRiskEvidence {
  return addDerivedCupDiscAsymmetry({
    verticalCupDiscRatio: input.cupDiscRatio,
    horizontalCupDiscRatio: input.horizontalCupDiscRatio,
    verticalCupDiscRatioOd: input.verticalCupDiscRatioOd,
    verticalCupDiscRatioOs: input.verticalCupDiscRatioOs,
    descriptors: input.discAppearanceDescriptors ?? [],
    discNerveSize: input.discNerveSize,
    methodSource: input.methodSource,
    notVisualized: input.notVisualized === true,
  });
}

function cupDiscEvidenceFromFindingValue(
  value: FindingValue,
  finding: FindingInstance,
): CupDiscRiskEvidence {
  const evidence: CupDiscRiskEvidence = {
    descriptors: [],
    notVisualized: false,
  };
  if (value.type === "quantity") {
    evidence.verticalCupDiscRatio = value.value;
    if (finding.laterality === "OD") {
      evidence.verticalCupDiscRatioOd = value.value;
    }
    if (finding.laterality === "OS") {
      evidence.verticalCupDiscRatioOs = value.value;
    }
    return addDerivedCupDiscAsymmetry(evidence);
  }
  if (value.type === "json") {
    const payload = value.value;
    evidence.verticalCupDiscRatio = readNumber(payload.verticalCupDiscRatio) ??
      readNumber(payload.cupDiscRatio);
    evidence.horizontalCupDiscRatio = readNumber(payload.horizontalCupDiscRatio);
    evidence.verticalCupDiscRatioOd = readNumber(payload.verticalCupDiscRatioOd);
    evidence.verticalCupDiscRatioOs = readNumber(payload.verticalCupDiscRatioOs);
    evidence.asymmetry = readNumber(payload.cupDiscAsymmetry) ?? readNumber(payload.asymmetry);
    evidence.descriptors = readStringArray(payload.discAppearanceDescriptors)
      .concat(readStringArray(payload.descriptors));
    evidence.discNerveSize = readString(payload.discNerveSize);
    evidence.methodSource = readString(payload.methodSource);
    evidence.notVisualized = readBoolean(payload.notVisualized) ??
      readBoolean(payload.deferred) ??
      false;
    if (finding.laterality === "OD" && evidence.verticalCupDiscRatio !== undefined) {
      evidence.verticalCupDiscRatioOd ??= evidence.verticalCupDiscRatio;
    }
    if (finding.laterality === "OS" && evidence.verticalCupDiscRatio !== undefined) {
      evidence.verticalCupDiscRatioOs ??= evidence.verticalCupDiscRatio;
    }
    return addDerivedCupDiscAsymmetry(evidence);
  }
  if (value.type === "components") {
    for (const component of value.components) {
      const code = normalizeDescriptorCode(component.code);
      if (code === "vertical-cup-disc-ratio" || code === "vertical-cd-ratio" || code === "cup-disc-ratio") {
        evidence.verticalCupDiscRatio = readNumber(component.value);
      } else if (code === "horizontal-cup-disc-ratio" || code === "horizontal-cd-ratio") {
        evidence.horizontalCupDiscRatio = readNumber(component.value);
      } else if (code === "vertical-cup-disc-ratio-od" || code === "vertical-cd-ratio-od") {
        evidence.verticalCupDiscRatioOd = readNumber(component.value);
      } else if (code === "vertical-cup-disc-ratio-os" || code === "vertical-cd-ratio-os") {
        evidence.verticalCupDiscRatioOs = readNumber(component.value);
      } else if (code === "cup-disc-asymmetry" || code === "cd-asymmetry") {
        evidence.asymmetry = readNumber(component.value);
      } else if (code === "disc-appearance-descriptor") {
        evidence.descriptors.push(...readStringArray(component.value));
      } else if (code === "not-visualized" || code === "deferred" || code === "not-visualized-deferred") {
        evidence.notVisualized = readBoolean(component.value) ?? evidence.notVisualized;
      }
    }
    if (finding.laterality === "OD" && evidence.verticalCupDiscRatio !== undefined) {
      evidence.verticalCupDiscRatioOd ??= evidence.verticalCupDiscRatio;
    }
    if (finding.laterality === "OS" && evidence.verticalCupDiscRatio !== undefined) {
      evidence.verticalCupDiscRatioOs ??= evidence.verticalCupDiscRatio;
    }
    return addDerivedCupDiscAsymmetry(evidence);
  }
  return evidence;
}

function withCrossFindingCupDiscAsymmetry(
  finding: FindingInstance,
  evidence: CupDiscRiskEvidence,
  cupDiscFindings: readonly FindingInstance[],
  evidenceByFindingId: ReadonlyMap<string, CupDiscRiskEvidence>,
): CupDiscRiskEvidence {
  if (evidence.asymmetry !== undefined) {
    return evidence;
  }
  const related = cupDiscFindings
    .filter((candidate) =>
      candidate.findingDefinitionId === finding.findingDefinitionId &&
      candidate.patientReference === finding.patientReference &&
      candidate.encounterReference === finding.encounterReference)
    .map((candidate) => ({ finding: candidate, evidence: evidenceByFindingId.get(candidate.id) }))
    .filter((candidate): candidate is { finding: FindingInstance; evidence: CupDiscRiskEvidence } =>
      candidate.evidence !== undefined && !candidate.evidence.notVisualized);
  const od = latestCupDiscVerticalForLaterality(related, "OD") ?? evidence.verticalCupDiscRatioOd;
  const os = latestCupDiscVerticalForLaterality(related, "OS") ?? evidence.verticalCupDiscRatioOs;
  if (od === undefined || os === undefined) {
    return evidence;
  }
  return addDerivedCupDiscAsymmetry({
    ...evidence,
    verticalCupDiscRatioOd: od,
    verticalCupDiscRatioOs: os,
  });
}

function latestCupDiscVerticalForLaterality(
  candidates: ReadonlyArray<{ finding: FindingInstance; evidence: CupDiscRiskEvidence }>,
  laterality: "OD" | "OS",
): number | undefined {
  const matching = candidates
    .filter((candidate) => candidate.finding.laterality === laterality)
    .filter((candidate) => candidate.evidence.verticalCupDiscRatio !== undefined)
    .sort((a, b) =>
      b.finding.recordedAt.localeCompare(a.finding.recordedAt) ||
      b.finding.id.localeCompare(a.finding.id));
  return matching[0]?.evidence.verticalCupDiscRatio;
}

function addDerivedCupDiscAsymmetry(evidence: CupDiscRiskEvidence): CupDiscRiskEvidence {
  if (
    evidence.asymmetry === undefined &&
    evidence.verticalCupDiscRatioOd !== undefined &&
    evidence.verticalCupDiscRatioOs !== undefined
  ) {
    return {
      ...evidence,
      asymmetry: Number(Math.abs(evidence.verticalCupDiscRatioOd - evidence.verticalCupDiscRatioOs).toFixed(3)),
    };
  }
  return evidence;
}

function evaluateCupDiscRisk(
  evidence: CupDiscRiskEvidence,
  definition: ClinicalFindingDefinition,
  riskConfig?: GlaucomaCupDiscRiskConfig,
): CupDiscRiskEvaluation {
  const thresholds = resolveCupDiscRiskThresholds(definition, riskConfig);
  const lowSignals: CupDiscRiskSignal[] = [];
  const highSignals: CupDiscRiskSignal[] = [];
  if (evidence.verticalCupDiscRatio !== undefined && evidence.verticalCupDiscRatio >= thresholds.highFloor) {
    highSignals.push({
      key: "vertical-cup-disc-ratio",
      display: `vertical C/D ${evidence.verticalCupDiscRatio.toFixed(2)} >= high floor ${thresholds.highFloor.toFixed(2)}`,
      observedValue: evidence.verticalCupDiscRatio,
    });
  } else if (evidence.verticalCupDiscRatio !== undefined && evidence.verticalCupDiscRatio >= thresholds.lowFloor) {
    lowSignals.push({
      key: "vertical-cup-disc-ratio",
      display: `vertical C/D ${evidence.verticalCupDiscRatio.toFixed(2)} >= low floor ${thresholds.lowFloor.toFixed(2)}`,
      observedValue: evidence.verticalCupDiscRatio,
    });
  }
  const selectedDescriptorCodes = new Set(evidence.descriptors.map(normalizeDescriptorCode));
  for (const option of getGlaucomaCupDiscDescriptorOptions(definition)) {
    if (
      option.active !== false &&
      option.highRiskDriver === true &&
      selectedDescriptorCodes.has(normalizeDescriptorCode(option.code))
    ) {
      highSignals.push({
        key: `descriptor:${option.code}`,
        display: option.display,
        observedValue: option.code,
      });
    }
  }
  if (evidence.asymmetry !== undefined && evidence.asymmetry >= thresholds.asymmetryHigh) {
    highSignals.push({
      key: "cup-disc-asymmetry",
      display: `C/D asymmetry ${evidence.asymmetry.toFixed(2)} >= high threshold ${thresholds.asymmetryHigh.toFixed(2)}`,
      observedValue: evidence.asymmetry,
    });
  } else if (evidence.asymmetry !== undefined && evidence.asymmetry >= thresholds.asymmetryLow) {
    lowSignals.push({
      key: "cup-disc-asymmetry",
      display: `C/D asymmetry ${evidence.asymmetry.toFixed(2)} >= low threshold ${thresholds.asymmetryLow.toFixed(2)}`,
      observedValue: evidence.asymmetry,
    });
  }
  return {
    riskTier: highSignals.length > 0 ? "high" : lowSignals.length > 0 ? "low" : "normal",
    thresholds,
    lowSignals,
    highSignals,
  };
}

function cupDiscPredicateExpression(
  risk: CupDiscRiskEvaluation,
  evidence: CupDiscRiskEvidence,
): Record<string, unknown> {
  return {
    finding: "cup_disc_ratio",
    predicate: "three-tier-borderline-suspect-cup-disc",
    riskTier: risk.riskTier,
    thresholds: risk.thresholds,
    observed: definedRecord({
      verticalCupDiscRatio: evidence.verticalCupDiscRatio,
      horizontalCupDiscRatio: evidence.horizontalCupDiscRatio,
      verticalCupDiscRatioOd: evidence.verticalCupDiscRatioOd,
      verticalCupDiscRatioOs: evidence.verticalCupDiscRatioOs,
      cupDiscAsymmetry: evidence.asymmetry,
      discAppearanceDescriptors: evidence.descriptors,
      notVisualized: evidence.notVisualized,
    }),
    lowRiskSignals: risk.lowSignals.map((signal) => signal.key),
    highRiskSignals: risk.highSignals.map((signal) => signal.key),
    deferred: ["rule-versioning", "recalc-invalidation", "cross-recompute-persistence"],
  };
}

function cupDiscRiskExplanation(risk: CupDiscRiskEvaluation): string {
  if (risk.riskTier === "high") {
    return `High-risk glaucoma-suspect suggestion because ${risk.highSignals.map((signal) => signal.display).join(", ")} fired.`;
  }
  if (risk.riskTier === "low") {
    return `Low-risk glaucoma-suspect suggestion because ${risk.lowSignals.map((signal) => signal.display).join(", ")} fired and no high-risk signal fired.`;
  }
  return "Normal cup/disc finding: no glaucoma-suspect suggestion edge emitted.";
}

function cupDiscInterpretationForRiskTier(riskTier: GlaucomaCupDiscRiskTier): FindingInterpretation {
  if (riskTier === "high") return "abnormal";
  if (riskTier === "low") return "borderline";
  return "normal";
}

function cupDiscSuggestionScore(riskTier: GlaucomaCupDiscSuspectRiskTier): number {
  return riskTier === "high" ? 0.8 : 0.55;
}

function resolveCupDiscRiskThresholds(
  definition: ClinicalFindingDefinition,
  riskConfig?: GlaucomaCupDiscRiskConfig,
): CupDiscRiskThresholds {
  const riskPredicate = asRecord(definition.normalSemantics?.riskPredicate);
  const thresholdParameters = asRecord(riskPredicate.thresholdParameters);
  const thresholds = {
    lowFloor: resolveCupDiscRiskParameter(thresholdParameters, "lowFloor", riskConfig?.lowFloor),
    highFloor: resolveCupDiscRiskParameter(thresholdParameters, "highFloor", riskConfig?.highFloor),
    asymmetryLow: resolveCupDiscRiskParameter(thresholdParameters, "asymmetryLow", riskConfig?.asymmetryLow),
    asymmetryHigh: resolveCupDiscRiskParameter(thresholdParameters, "asymmetryHigh", riskConfig?.asymmetryHigh),
  };
  if (thresholds.lowFloor > thresholds.highFloor) {
    throw new Error("lowFloor must be less than or equal to highFloor.");
  }
  if (thresholds.asymmetryLow > thresholds.asymmetryHigh) {
    throw new Error("asymmetryLow must be less than or equal to asymmetryHigh.");
  }
  return thresholds;
}

function resolveCupDiscRiskParameter(
  thresholdParameters: Record<string, unknown>,
  key: keyof GlaucomaCupDiscRiskConfig,
  override: number | undefined,
): number {
  if (override !== undefined) {
    return assertRatio(override, key);
  }
  const parameter = asRecord(thresholdParameters[key]);
  const defaultValue = readNumber(parameter.defaultValue);
  if (defaultValue === undefined) {
    throw new Error(`Cup/disc risk parameter ${key} defaultValue is missing from the finding definition.`);
  }
  return assertRatio(
    defaultValue,
    `cup/disc risk parameter ${key} default`,
  );
}

function assertRatio(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite ratio from 0.00 to 1.00.`);
  }
  return value;
}

function getCupDiscDescriptorField(definition: ClinicalFindingDefinition): Record<string, unknown> {
  const fields = asRecord(definition.valueSchema.fields);
  return asRecord(fields.discAppearanceDescriptors);
}

function parseClinicalFindingOption(value: unknown): ClinicalFindingOption | undefined {
  const record = asRecord(value);
  const code = readString(record.code);
  const display = readString(record.display);
  if (!code || !display) {
    return undefined;
  }
  return {
    code,
    display,
    ...(typeof record.active === "boolean" ? { active: record.active } : {}),
    ...(typeof record.highRiskDriver === "boolean" ? { highRiskDriver: record.highRiskDriver } : {}),
  };
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function definedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) =>
      item !== undefined &&
      (!Array.isArray(item) || item.length > 0)),
  );
}

function normalizeDescriptorCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function glaucomaOpenAngleBorderlineCode(
  riskTier: GlaucomaCupDiscSuspectRiskTier,
  laterality: EyeLaterality,
): string {
  const prefix = riskTier === "high" ? "H40.02" : "H40.01";
  return `${prefix}${lateralityDigit(laterality)}`;
}

let cachedGlaucomaPhase0Ledger: GlaucomaPhase0Ledger | undefined;

function resolveGlaucomaLedgerDiagnosis(
  code: string,
  ledger = loadGlaucomaPhase0Ledger(),
): GlaucomaPhase0DiagnosisCode | undefined {
  return ledger.diagnosisCodes.find((row) => row.code === code);
}

export function loadGlaucomaPhase0Ledger(): GlaucomaPhase0Ledger {
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

function diagnosisCatalogCode(definition: DiagnosisCatalogRow, laterality: EyeLaterality): string {
  if (!definition.icd10) throw new Error(`Diagnosis catalog seed ${definition.stableKey} has no ICD-10-CM coding.`);
  if ("code" in definition.icd10) return definition.icd10.code;
  const code = laterality === "OD" ? definition.icd10.pattern.right
    : laterality === "OS" ? definition.icd10.pattern.left
    : laterality === "OU" ? definition.icd10.pattern.bilateral
    : definition.icd10.pattern.unspecifiedEye;
  if (!code) throw new Error(`Diagnosis catalog seed ${definition.stableKey} lacks ${laterality} coding.`);
  return code;
}

function lateralityDisplay(laterality: EyeLaterality): string {
  if (laterality === "OD") return "Right eye";
  if (laterality === "OS") return "Left eye";
  if (laterality === "OU") return "Bilateral";
  return "Unspecified eye";
}

function findingValueToObservationValue(
  value: FindingValue,
): Pick<Observation, "component" | "valueBoolean" | "valueQuantity" | "valueString"> {
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
  if (value.type === "components") {
    return {
      component: value.components.map((item) => ({
        code: odosConcept(item.code, item.display),
        ...(typeof item.value === "number"
          ? {
              valueQuantity: quantity(
                item.value,
                item.unit ?? "",
                item.system ?? (item.unitCode ? "http://unitsofmeasure.org" : undefined),
                item.unitCode,
              ),
            }
          : typeof item.value === "boolean"
            ? { valueBoolean: item.value }
            : { valueString: item.value }),
      })),
    };
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

function deterministicGraphId(prefix: string, ...parts: Array<string | number | undefined>): string {
  return [prefix, ...parts.filter((part) => part !== undefined)]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Creates a typed FHIR Reference from a literal resource reference string.
 */
export function ref<T extends Resource = Resource>(value: string): Reference<T> {
  return reference<T>(value);
}
