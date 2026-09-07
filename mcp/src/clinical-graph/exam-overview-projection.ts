import type { Observation } from "@medplum/fhirtypes";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import {
  customFieldEntries,
  type FindingQualifierValue,
  type QualifierSeed,
} from "./custom-fields.js";
import { translateRetiredFindingRead } from "./finding-read-compatibility.js";
import { findingDefinitionForObservation } from "./finding-observation-match.js";
import { isLiveObservation } from "./observation-liveness.js";
import type {
  ClinicalFindingDefinition,
  FindingInterpretation,
} from "./glaucoma-suspect.js";

export type ExamObservationState =
  | "examined"
  | "deferred-with-reason"
  | "deferred-without-reason";

export type ExamSectionState = ExamObservationState | "partial" | "not-examined" | "not-indicated";

export type ExamSectionRowState = NormalizedObservationExamState | { state: "not-examined" };

export type ExamFindingProvenanceState =
  | "current"
  | "carried-unreasserted"
  | "carried-reasserted";

export interface NormalizedObservationExamState {
  state: ExamObservationState;
  reason?: string;
  sourceEncoding: "observation" | "exam-state" | "dilation-declined" | "not-visualized-json";
}

export type ObservationSnapshotValue =
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | {
      kind: "quantity";
      value: number;
      unit?: string;
      system?: string;
      code?: string;
    }
  | { kind: "code"; code?: string; display?: string; text?: string }
  | { kind: "json"; value: Record<string, unknown> };

export interface ObservationSnapshot {
  recordedAt?: string;
  value?: ObservationSnapshotValue;
  components: Array<{
    code: string;
    display?: string;
    value?: ObservationSnapshotValue;
  }>;
}

export type ExamOverviewChange =
  | { kind: "numeric"; delta: number; unit?: string }
  | { kind: "changed" };

export interface ExamOverviewFindingProjection {
  observationReference: string;
  findingKey: string;
  sectionKey: string;
  display: string;
  laterality: "OD" | "OS" | "OU" | "UNKNOWN";
  examination: NormalizedObservationExamState;
  interpretation: FindingInterpretation;
  provenance: {
    state: ExamFindingProvenanceState;
    sourceDate?: string;
  };
  current: ObservationSnapshot;
  normalLabel?: string;
  sheetFindings?: Array<{
    display: string;
    qualifiers: string[];
  }>;
  summary?: string;
  event?: {
    administrations: Array<{
      agent: string;
      occurredAt: string;
    }>;
  };
  diagnoses?: Array<{
    display: string;
    laterality?: "OD" | "OS" | "OU";
  }>;
  attestation?: {
    attestedBy: string[];
    recordedAt?: string;
  };
  prior?: ObservationSnapshot;
  changeFromPrior?: ExamOverviewChange;
}

export interface ExamOverviewSectionProjection {
  sectionKey: string;
  label: string;
  state: ExamSectionState;
  findingObservationReferences: string[];
  abnormalCount: number;
  carriedUnreassertedCount: number;
  deferredWithoutReasonCount: number;
}

export interface ClinicalSectionRequirement {
  sectionKey: string;
  label: string;
  evidence:
    | { kind: "finding"; sectionKeyPrefixes: string[] }
    | { kind: "assessment" };
}

export interface ClinicalSectionApplicabilityPolicy {
  required: ClinicalSectionRequirement[];
  notIndicated: ClinicalSectionRequirement[];
}

export type ClinicalSectionApplicabilityRegistry = Record<
  string,
  ClinicalSectionApplicabilityPolicy
>;

// This registry measures clinical section completeness only. It is not billing-documentation
// adequacy and must not be consumed by, derived from, or joined to billing-code selection.
export const CLINICAL_SECTION_REQUIREMENTS: ClinicalSectionApplicabilityRegistry = {
  exams: {
    required: [
      findingRequirement("history", "History", ["hpi"]),
      findingRequirement("entrance", "Entrance", ["entrance:"]),
      findingRequirement("refraction", "Refraction", ["refraction"]),
      findingRequirement("pretest", "Pretest", ["wearing", "auto-refraction", "va", "tonometry"]),
      findingRequirement("ocular-health", "Ocular Health", ["ocular-health:", "optic-nerve", "gonioscopy"]),
      { sectionKey: "assessment", label: "Assessment", evidence: { kind: "assessment" } },
    ],
    notIndicated: [],
  },
};

export interface ClinicalCompletenessTraceRow {
  sectionKey: string;
  label: string;
  state: ExamSectionState;
  resolved: boolean;
  carriedUnreassertedCount: number;
}

export interface ClinicalExamCompleteness {
  status: "complete" | "incomplete" | "unconfigured";
  requiredSectionCount: number;
  resolvedSectionCount: number;
  trace: ClinicalCompletenessTraceRow[];
  documentationIssues: Array<{
    sectionKey: string;
    issue: "deferred-reason-missing";
  }>;
}

export interface ExamOverviewProjection {
  encounterReference: string;
  patientReference: string;
  visitTypeCategoryId?: string;
  historySummary?: string;
  findings: ExamOverviewFindingProjection[];
  sections: ExamOverviewSectionProjection[];
  completeness: ClinicalExamCompleteness;
}

export interface BuildExamOverviewProjectionInput {
  encounterReference: string;
  patientReference: string;
  visitTypeCategoryId?: string;
  definitions: readonly ClinicalFindingDefinition[];
  currentObservations: readonly Observation[];
  priorObservationCandidates: readonly Observation[];
  assessmentRows: ReadonlyArray<{ problemStatusRecorded: boolean }>;
  provenanceByObservation?: Readonly<Record<string, {
    state: ExamFindingProvenanceState;
    sourceDate?: string;
  }>>;
  clinicalContextByObservation?: Readonly<Record<string, {
    summary?: string;
    event?: ExamOverviewFindingProjection["event"];
    diagnoses?: ExamOverviewFindingProjection["diagnoses"];
    attestation?: ExamOverviewFindingProjection["attestation"];
  }>>;
  applicabilityRegistry?: ClinicalSectionApplicabilityRegistry;
}

export function normalizeObservationExamState(
  observation: Observation,
): NormalizedObservationExamState {
  const examState = componentString(observation, "EXAM_STATE");
  if (examState === "deferred") {
    return deferredState(componentString(observation, "OTHER"), "exam-state");
  }
  if (componentBoolean(observation, "DILATION_DECLINED") === true) {
    return deferredState(componentString(observation, "DECLINE_REASON"), "dilation-declined");
  }
  if (jsonObject(observation.valueString)?.notVisualized === true) {
    return { state: "deferred-without-reason", sourceEncoding: "not-visualized-json" };
  }
  return { state: "examined", sourceEncoding: "observation" };
}

export function deriveExamSectionState(input: {
  applicable: boolean;
  rows: readonly ExamSectionRowState[];
}): ExamSectionState {
  if (!input.applicable) return "not-indicated";
  if (input.rows.length === 0) return "not-examined";
  if (input.rows.every((row) => row.state === "not-examined")) return "not-examined";
  if (!input.rows.every((row) => row.state !== "not-examined")) return "partial";
  if (input.rows.some((row) => row.state === "examined")) return "examined";
  if (input.rows.some((row) => row.state === "deferred-without-reason")) {
    return "deferred-without-reason";
  }
  return "deferred-with-reason";
}

export function observationSnapshot(observation: Observation): ObservationSnapshot {
  const components = (observation.component ?? []).map((component) => ({
    code: conceptCode(component.code),
    ...(conceptDisplay(component.code) ? { display: conceptDisplay(component.code) } : {}),
    ...(snapshotValue(component) ? { value: snapshotValue(component) } : {}),
  })).sort((left, right) => left.code.localeCompare(right.code));
  const value = snapshotValue(observation);
  return {
    ...(observationTime(observation) ? { recordedAt: observationTime(observation) } : {}),
    ...(value ? { value } : {}),
    components,
  };
}

export function deriveChangeFromPrior(
  current: ObservationSnapshot,
  prior: ObservationSnapshot | undefined,
): ExamOverviewChange | undefined {
  if (!prior) return undefined;
  if (current.value?.kind === "quantity" && prior.value?.kind === "quantity") {
    const currentUnit = current.value.code ?? current.value.unit;
    const priorUnit = prior.value.code ?? prior.value.unit;
    if (currentUnit === priorUnit) {
      const delta = normalizedNumber(current.value.value - prior.value.value);
      if (delta === 0 && sameClinicalSnapshot(current, prior)) return undefined;
      return {
        kind: "numeric",
        delta,
        ...(current.value.unit ? { unit: current.value.unit } : {}),
      };
    }
  }
  return sameClinicalSnapshot(current, prior) ? undefined : { kind: "changed" };
}

export function buildExamOverviewProjection(
  input: BuildExamOverviewProjectionInput,
): ExamOverviewProjection {
  const priorRows = input.priorObservationCandidates.filter((observation) =>
    observation.encounter?.reference !== undefined &&
    observation.encounter.reference !== input.encounterReference
  ).flatMap((observation) => {
    const identity = observationIdentity(observation, input.definitions);
    return identity ? [{ observation, identity }] : [];
  });
  const findings = input.currentObservations
    .filter(isUsableObservation)
    .flatMap((observation): ExamOverviewFindingProjection[] => {
      const identity = observationIdentity(observation, input.definitions);
      const observationReference = observation.id ? `Observation/${observation.id}` : undefined;
      if (!identity || !observationReference) return [];
      const laterality = observationLaterality(observation);
      const prior = latestPriorObservation(priorRows, identity.findingKey, laterality, observation);
      const currentSnapshot = observationSnapshot(observation);
      const priorSnapshot = prior ? observationSnapshot(prior) : undefined;
      const provenance = input.provenanceByObservation?.[observationReference] ?? { state: "current" as const };
      const clinicalContext = input.clinicalContextByObservation?.[observationReference];
      const changeFromPrior = deriveChangeFromPrior(currentSnapshot, priorSnapshot);
      const definition = input.definitions.find((row) => row.active && row.stableKey === identity.findingKey);
      const sheet = definition ? sheetFindingProjection(observation, definition, laterality) : {};
      return [{
        observationReference,
        findingKey: identity.findingKey,
        sectionKey: identity.sectionKey,
        display: identity.display,
        laterality,
        examination: normalizeObservationExamState(observation),
        interpretation: observationInterpretation(observation),
        provenance,
        current: currentSnapshot,
        ...sheet,
        ...(clinicalContext?.summary ? { summary: clinicalContext.summary } : {}),
        ...(clinicalContext?.event ? { event: clinicalContext.event } : {}),
        ...(clinicalContext?.diagnoses?.length ? { diagnoses: clinicalContext.diagnoses } : {}),
        ...(clinicalContext?.attestation ? { attestation: clinicalContext.attestation } : {}),
        ...(priorSnapshot ? { prior: priorSnapshot } : {}),
        ...(changeFromPrior ? { changeFromPrior } : {}),
      }];
    })
    .sort((left, right) => findingOrder(left, right, input.definitions));
  const registry = input.applicabilityRegistry ?? CLINICAL_SECTION_REQUIREMENTS;
  const policy = input.visitTypeCategoryId !== undefined &&
      Object.hasOwn(registry, input.visitTypeCategoryId)
    ? registry[input.visitTypeCategoryId]
    : undefined;
  if (!policy) {
    return {
      encounterReference: input.encounterReference,
      patientReference: input.patientReference,
      ...(input.visitTypeCategoryId ? { visitTypeCategoryId: input.visitTypeCategoryId } : {}),
      findings,
      sections: [],
      completeness: unconfiguredCompleteness(),
    };
  }
  const requiredSections = policy.required.map((requirement) => sectionProjection(
    requirement,
    true,
    findings,
    input.definitions,
    input.assessmentRows,
  ));
  const notIndicatedSections = policy.notIndicated.map((requirement) => sectionProjection(
    requirement,
    false,
    findings,
    input.definitions,
    input.assessmentRows,
  ));
  const trace = requiredSections.map((section): ClinicalCompletenessTraceRow => ({
    sectionKey: section.sectionKey,
    label: section.label,
    state: section.state,
    resolved: sectionResolved(section.state),
    carriedUnreassertedCount: section.carriedUnreassertedCount,
  }));
  const documentationIssues = requiredSections.flatMap((section) =>
    section.deferredWithoutReasonCount > 0
      ? [{ sectionKey: section.sectionKey, issue: "deferred-reason-missing" as const }]
      : []
  );
  const resolvedSectionCount = trace.filter((row) => row.resolved).length;
  return {
    encounterReference: input.encounterReference,
    patientReference: input.patientReference,
    ...(input.visitTypeCategoryId ? { visitTypeCategoryId: input.visitTypeCategoryId } : {}),
    findings,
    sections: [...requiredSections, ...notIndicatedSections],
    completeness: {
      status: resolvedSectionCount === trace.length ? "complete" : "incomplete",
      requiredSectionCount: trace.length,
      resolvedSectionCount,
      trace,
      documentationIssues,
    },
  };
}

function findingRequirement(
  sectionKey: string,
  label: string,
  sectionKeyPrefixes: string[],
): ClinicalSectionRequirement {
  return { sectionKey, label, evidence: { kind: "finding", sectionKeyPrefixes } };
}

function deferredState(
  reason: string | undefined,
  sourceEncoding: "exam-state" | "dilation-declined",
): NormalizedObservationExamState {
  const normalizedReason = reason?.trim();
  return normalizedReason
    ? { state: "deferred-with-reason", reason: normalizedReason, sourceEncoding }
    : { state: "deferred-without-reason", sourceEncoding };
}

function componentString(observation: Observation, code: string): string | undefined {
  return observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  )?.valueString;
}

function componentBoolean(observation: Observation, code: string): boolean | undefined {
  return observation.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  )?.valueBoolean;
}

function jsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value?.trim().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotValue(
  source: Observation | NonNullable<Observation["component"]>[number],
): ObservationSnapshotValue | undefined {
  if (source.valueQuantity?.value !== undefined) {
    return {
      kind: "quantity",
      value: source.valueQuantity.value,
      ...(source.valueQuantity.unit ? { unit: source.valueQuantity.unit } : {}),
      ...(source.valueQuantity.system ? { system: source.valueQuantity.system } : {}),
      ...(source.valueQuantity.code ? { code: source.valueQuantity.code } : {}),
    };
  }
  if (source.valueBoolean !== undefined) return { kind: "boolean", value: source.valueBoolean };
  if (source.valueInteger !== undefined) return { kind: "number", value: source.valueInteger };
  if (source.valueString !== undefined) {
    const parsed = jsonObject(source.valueString);
    return parsed ? { kind: "json", value: parsed } : { kind: "string", value: source.valueString };
  }
  if (source.valueCodeableConcept) {
    return {
      kind: "code",
      ...(conceptCode(source.valueCodeableConcept) !== "UNKNOWN"
        ? { code: conceptCode(source.valueCodeableConcept) }
        : {}),
      ...(conceptDisplay(source.valueCodeableConcept) ? { display: conceptDisplay(source.valueCodeableConcept) } : {}),
      ...(source.valueCodeableConcept.text ? { text: source.valueCodeableConcept.text } : {}),
    };
  }
  return undefined;
}

function conceptCode(concept: { coding?: Array<{ code?: string }> }): string {
  return concept.coding?.find((coding) => coding.code)?.code ?? "UNKNOWN";
}

function conceptDisplay(concept: { coding?: Array<{ display?: string }>; text?: string }): string | undefined {
  return concept.coding?.find((coding) => coding.display)?.display ?? concept.text;
}

function normalizedNumber(value: number): number {
  return Number(value.toFixed(12));
}

function sameClinicalSnapshot(left: ObservationSnapshot, right: ObservationSnapshot): boolean {
  return JSON.stringify({ value: left.value, components: left.components }) ===
    JSON.stringify({ value: right.value, components: right.components });
}

function observationIdentity(
  observation: Observation,
  definitions: readonly ClinicalFindingDefinition[],
): { findingKey: string; sectionKey: string; display: string } | undefined {
  const definition = findingDefinitionForObservation(observation, definitions.filter((row) => row.active));
  if (definition) {
    return {
      findingKey: definition.stableKey,
      sectionKey: definition.sectionKey ?? definition.stableKey,
      display: definition.display,
    };
  }
  const coding = observation.code.coding?.find((row) => row.code);
  if (coding?.code === "VISUAL_ACUITY" || coding?.code === "VISUAL_ACUITY_PANEL") {
    return {
      findingKey: coding.code,
      sectionKey: "va",
      display: coding.display ?? observation.code.text ?? "Visual acuity",
    };
  }
  return undefined;
}

function latestPriorObservation(
  rows: ReadonlyArray<{
    observation: Observation;
    identity: { findingKey: string; sectionKey: string; display: string };
  }>,
  findingKey: string,
  laterality: ExamOverviewFindingProjection["laterality"],
  current: Observation,
): Observation | undefined {
  const currentInstant = observationComparisonInstant(current);
  if (currentInstant === undefined) return undefined;
  return rows
    .filter((row) => row.identity.findingKey === findingKey && observationLaterality(row.observation) === laterality)
    .map((row) => row.observation)
    .filter(isUsableObservation)
    .filter((observation) => {
      const candidateInstant = observationComparisonInstant(observation);
      return candidateInstant !== undefined && candidateInstant < currentInstant;
    })
    .sort((left, right) => observationComparisonInstant(right)! - observationComparisonInstant(left)!)[0];
}

function observationComparisonInstant(observation: Observation): number | undefined {
  const value = observation.effectiveDateTime ?? observation.issued;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function observationTime(observation: Observation): string {
  return observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "";
}

function observationLaterality(observation: Observation): ExamOverviewFindingProjection["laterality"] {
  const code = observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    observation.bodySite?.coding?.find((coding) => coding.code)?.code;
  if (code === "OD" || code === "right") return "OD";
  if (code === "OS" || code === "left") return "OS";
  if (code === "OU" || code === "bilateral") return "OU";
  return "UNKNOWN";
}

function observationInterpretation(observation: Observation): FindingInterpretation {
  const code = observation.interpretation?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.code)?.code?.toLowerCase();
  if (code === "a" || code === "abnormal") return "abnormal";
  if (code === "b" || code === "borderline" || code === "e") return "borderline";
  if (code === "n" || code === "normal") return "normal";
  return "unknown";
}

function sectionProjection(
  requirement: ClinicalSectionRequirement,
  applicable: boolean,
  findings: readonly ExamOverviewFindingProjection[],
  definitions: readonly ClinicalFindingDefinition[],
  assessmentRows: ReadonlyArray<{ problemStatusRecorded: boolean }>,
): ExamOverviewSectionProjection {
  const evidence = requirement.evidence;
  const rows = evidence.kind === "assessment"
    ? []
    : findings.filter((finding) => evidence.sectionKeyPrefixes.some((prefix) =>
      finding.sectionKey.startsWith(prefix)
    ));
  const carriedUnreassertedCount = rows.filter((row) =>
    row.provenance.state === "carried-unreasserted"
  ).length;
  const currentRows = rows.filter((row) => row.provenance.state !== "carried-unreasserted");
  const definitionSlots = evidence.kind === "assessment"
    ? []
    : definitions.filter((definition) => definition.active && evidence.sectionKeyPrefixes.some((prefix) =>
      (definition.sectionKey ?? definition.stableKey).startsWith(prefix)
    ));
  const findingSlots = evidence.kind === "assessment"
    ? []
    : findingSectionSlots(definitionSlots, currentRows);
  const state = !applicable
    ? "not-indicated"
    : requirement.evidence.kind === "assessment"
      ? assessmentSectionState(assessmentRows)
      : deriveExamSectionState({ applicable: true, rows: findingSlots });
  return {
    sectionKey: requirement.sectionKey,
    label: requirement.label,
    state,
    findingObservationReferences: rows.map((row) => row.observationReference),
    abnormalCount: rows.filter((row) => row.interpretation === "abnormal").length,
    carriedUnreassertedCount,
    deferredWithoutReasonCount: currentRows.filter((row) =>
      row.examination.state === "deferred-without-reason"
    ).length,
  };
}

function sectionResolved(state: ExamSectionState): boolean {
  return state === "examined" ||
    state === "deferred-with-reason" ||
    state === "deferred-without-reason";
}

function assessmentSectionState(
  rows: ReadonlyArray<{ problemStatusRecorded: boolean }>,
): ExamSectionState {
  if (rows.length === 0) return "not-examined";
  return rows.every((row) => row.problemStatusRecorded) ? "examined" : "partial";
}

function unconfiguredCompleteness(): ClinicalExamCompleteness {
  return {
    status: "unconfigured",
    requiredSectionCount: 0,
    resolvedSectionCount: 0,
    trace: [],
    documentationIssues: [],
  };
}

function isUsableObservation(observation: Observation): boolean {
  return isLiveObservation(observation);
}

function findingOrder(
  left: ExamOverviewFindingProjection,
  right: ExamOverviewFindingProjection,
  definitions: readonly ClinicalFindingDefinition[],
): number {
  const lateralityRank = (value: ExamOverviewFindingProjection["laterality"]): number =>
    value === "OD" ? 0 : value === "OS" ? 1 : value === "OU" ? 2 : 3;
  const order = new Map(definitions.filter((row) => row.active).map((row, index) => [row.stableKey, index]));
  const leftOrder = order.get(left.findingKey) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = order.get(right.findingKey) ?? Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder ||
    left.sectionKey.localeCompare(right.sectionKey) ||
    left.display.localeCompare(right.display) ||
    lateralityRank(left.laterality) - lateralityRank(right.laterality);
}

function findingSectionSlots(
  definitions: readonly ClinicalFindingDefinition[],
  findings: readonly ExamOverviewFindingProjection[],
): ExamSectionRowState[] {
  const definitionKeys = new Set(definitions.map((row) => row.stableKey));
  const definedSlots = definitions.map((definition): ExamSectionRowState => {
    const rows = findings.filter((finding) => finding.findingKey === definition.stableKey);
    return rows.length === 0
      ? { state: "not-examined" }
      : { state: deriveExamSectionState({ applicable: true, rows: rows.map((row) => row.examination) }) as ExamObservationState,
          sourceEncoding: "observation" };
  });
  const observedOnlySlots = [...new Set(findings
    .filter((finding) => !definitionKeys.has(finding.findingKey))
    .map((finding) => finding.findingKey))]
    .map((findingKey): ExamSectionRowState => {
      const rows = findings.filter((finding) => finding.findingKey === findingKey);
      return {
        state: deriveExamSectionState({ applicable: true, rows: rows.map((row) => row.examination) }) as ExamObservationState,
        sourceEncoding: "observation",
      };
    });
  return [...definedSlots, ...observedOnlySlots];
}

function sheetFindingProjection(
  observation: Observation,
  definition: ClinicalFindingDefinition,
  laterality: ExamOverviewFindingProjection["laterality"],
): Pick<ExamOverviewFindingProjection, "normalLabel" | "sheetFindings"> {
  const normalLabel = typeof definition.normalSemantics?.sheetLabel === "string"
    ? definition.normalSemantics.sheetLabel
    : undefined;
  const prefix = definition.valueSchema.perEye === true && (laterality === "OD" || laterality === "OS")
    ? `${laterality}_`
    : "";
  const sheetFindings = customFieldEntries(definition, true).flatMap((field) => {
    if (field.valueType !== "multi-select") return [];
    const compatibility = translateRetiredFindingRead(observation, definition.stableKey, field, prefix);
    const selected = compatibility.value;
    if (!Array.isArray(selected)) return [];
    return selected.flatMap((optionCode) => {
      const option = field.options?.find((candidate) => candidate.code === optionCode);
      if (!option) return [];
      const qualifiers = (option.qualifiers ?? []).flatMap((qualifier) => {
        const component = observation.component?.find((row) => row.code.coding?.some((coding) =>
          coding.code === `${prefix}${field.localCode}::${option.code}::${qualifier.key}`
        ));
        const translatedValue = compatibility.findingDetails[option.code]?.[qualifier.key];
        const label = component
          ? sheetQualifierLabel(component, qualifier)
          : translatedValue === undefined
            ? undefined
            : sheetQualifierValueLabel(translatedValue);
        return label ? [label] : [];
      });
      return [{ display: option.display, qualifiers }];
    });
  });
  return {
    ...(normalLabel ? { normalLabel } : {}),
    ...(sheetFindings.length ? { sheetFindings } : {}),
  };
}

function sheetQualifierValueLabel(value: FindingQualifierValue): string {
  if (typeof value === "number" || typeof value === "string") return String(value);
  return `${value.from}–${value.to} o'clock ${value.clockwise ? "clockwise" : "counterclockwise"}`;
}

function sheetQualifierLabel(
  component: NonNullable<Observation["component"]>[number],
  qualifier: QualifierSeed,
): string | undefined {
  if (component.valueQuantity?.value !== undefined) {
    return `${component.valueQuantity.value}${component.valueQuantity.unit ? ` ${component.valueQuantity.unit}` : ""}`;
  }
  const coded = conceptDisplay(component.valueCodeableConcept ?? {}) ??
    component.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  if (coded) return coded;
  if (qualifier.kind === "extent" && component.valueString) {
    const extent = jsonObject(component.valueString);
    if (typeof extent?.from === "number" && typeof extent.to === "number" && typeof extent.clockwise === "boolean") {
      return `${extent.from}–${extent.to} o'clock ${extent.clockwise ? "clockwise" : "counterclockwise"}`;
    }
  }
  return component.valueString?.trim() || undefined;
}
