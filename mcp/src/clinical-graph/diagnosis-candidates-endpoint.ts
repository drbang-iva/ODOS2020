import { collectAllFhirSearchPages, type FhirSearchClient } from "../fhir-search.js";
import { customFieldEntries } from "./custom-fields.js";
import { currentFindingIdentifier, type CurrentFindingKey } from "./current-finding-identity.js";
import type { CurrentFindingFact, FindingBaseline, CurrentFindingProjection, FindingDefinitionView } from "./current-finding-reader.js";
import { loadDiagnosisFindingContext } from "./diagnosis-findings-endpoint.js";
import type { Basic, Bundle, Condition, Observation, Resource } from "@medplum/fhirtypes";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { FhirDiagnosisPickTallyStore } from "./diagnosis-pick-tally-store.js";
import {
  evaluateMappingTrigger,
  matchingMappingGroups,
} from "./diagnosis-mapping.js";
import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import { observationMatchesFindingDefinition } from "./finding-observation-match.js";
import {
  evaluateGlaucomaDiagnosisSuggestions,
  evaluateIopDiagnosisSuggestions,
  ICD10_CM_CODE_SYSTEM,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type DiagnosisCatalogRow,
  type DiagnosisSuggestionEvaluation,
  type FindingInstance,
  type FindingInterpretation,
  type FindingValue,
  type MappingTrigger,
} from "./glaucoma-suspect.js";
import { evaluateRefractiveErrorSuggestions } from "./refraction-suspect.js";
import { visualFieldDescriptorResolution } from "./entrance-definition.js";
import { stagedDiagnosisFamilyRow } from "./diagnosis-quick-list-endpoint.js";

export interface DiagnosisCandidatesFhirClient extends FhirSearchClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface DiagnosisCandidateLeafRow {
  diagnosisKey: string;
  display: string;
  icd10?: { code: string; display?: string } | {
    pattern: {
      unspecifiedEye?: string;
      right?: string;
      left?: string;
      bilateral?: string;
    };
  };
  codingStatus: DiagnosisCatalogRow["codingStatus"];
  priority: boolean;
  source: "rule" | "mapping";
}

export interface DiagnosisCandidateFamilyRow {
  familyGroup: string;
  clinicalFamily: string;
  display: string;
  axisLabel: string;
  members: Array<{ stableKey: string; stageLabel: string }>;
  priority: boolean;
  source: "rule" | "mapping";
}

export interface SupportingFindingFact { rowKey: string; key: CurrentFindingKey; baseline: Extract<FindingBaseline, {kind: "canonical"}> }
export type DiagnosisCandidateRow = (DiagnosisCandidateLeafRow | DiagnosisCandidateFamilyRow) & { supportingFacts?: SupportingFindingFact[]; linkable?: false };

export const VISUAL_FIELD_GLAUCOMA_SUPPRESSION_MESSAGE =
  "H53.4x not proposed — the glaucoma stage already carries the field defect.";

export type OrderedCandidate = DiagnosisCandidateRow & { order: number };

export async function handleDiagnosisCandidatesRequest(
  deps: {
    authenticate(authHeader: string | undefined): Promise<{
      staffReference: string;
      actorRole: PracticeRoleId;
      fhir: DiagnosisCandidatesFhirClient;
    } | null>;
    now?: () => string;
  },
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { result: "unauthenticated", error: "Authentication required to read diagnosis candidates." } };
  if (!staffHasBusinessAction(staff, "chart.read")) {
    return { status: 403, body: { result: "forbidden", error: "chart.read role required" } };
  }
  const encounterId = readEncounterId(input.params);
  if (!encounterId) return { status: 400, body: { result: "invalid", reason: "invalid-encounter", error: "A valid encounter id is required." } };
  const encounterReference = `Encounter/${encounterId}`;
  try {
  const [definitions, catalog, tally] = await Promise.all([
    new FhirFindingDefinitionStore(staff.fhir).list(),
    new FhirDiagnosisCatalogStore(staff.fhir).list(),
    new FhirDiagnosisPickTallyStore(staff.fhir).read(staff.staffReference),
  ]);
  const context = await loadDiagnosisFindingContext(staff.fhir, encounterId, definitions);
  if (context.incomplete) return { status: context.kind === "refused" ? 403 : context.kind === "missing" ? 404 : 502,
    body: { result: "unavailable", kind: context.kind, error: context.reason } };
  const { projection, state } = context;
  const views = diagnosisDefinitionViews(projection, definitions);
  const findings = views.flatMap(view => findingInstancesFromObservation(view, definitions));
  const patientConditions = await collectAllFhirSearchPages<Condition>(staff.fhir, "Condition",
    await staff.fhir.search<Condition>("Condition", { subject: state.patientReference, _count: "200" }), staff.fhir.baseUrl);
  if (patientConditions.some(c => c.resourceType !== "Condition" || c.subject?.reference !== state.patientReference)) {
    return { status: 502, body: { result: "unavailable", kind: "foreign-or-unscoped", error: "Patient history returned a foreign Condition." } };
  }
  const provenance: ClinicalGraphProvenance = {
    source: "rule",
    recordedAt: deps.now?.() ?? new Date().toISOString(),
    actorReference: staff.staffReference,
    note: "Encounter diagnosis-candidates read; no suggestion edges or diagnoses persisted.",
  };
  const rules = [
    ...evaluateGlaucomaDiagnosisSuggestions({ findings, findingDefinitions: definitions, encounterReference, provenance }),
    ...evaluateIopDiagnosisSuggestions({ findings, findingDefinitions: definitions, encounterReference, provenance }),
    ...evaluateRefractiveErrorSuggestions({ findings, findingDefinitions: definitions, encounterReference, provenance }),
  ];
  const rulesByFinding = groupRulesByFinding(rules);
  const activeCatalog = new Map(catalog.filter((row) => row.active).map((row) => [row.stableKey, row]));
  const stagedGlaucomaPresent = state.conditions.some(isConfirmedStagedGlaucoma);
  const patientStagedGlaucomaPresent = patientConditions.some(condition => condition.encounter?.reference !== encounterReference && isConfirmedStagedGlaucoma(condition));

  return {
    status: 200,
    body: {
      encounterReference,
      findings: findings.map((finding) => {
        const definition = definitions.find((row) => row.id === finding.findingDefinitionId);
        const view = views.find(v => (v.id ?? v.projectionKey) === finding.id)!;
        const liveFacts = !projection.preRebuild && definition && customFieldEntries(definition, true).some(f => f.valueType === "multi-select")
          ? projection.currentFacts.filter(f => f.status === "live" && f.presence === "present" && f.key.stableKey === definition.stableKey && f.eye === finding.laterality)
          : [];
        const support = (trigger?: MappingTrigger) => {
          const facts = supportingFactsForTrigger(liveFacts, finding, trigger);
          return facts.length ? { supportingFacts: facts } : {};
        };
        const ruleCandidates = (rulesByFinding.get(finding.id) ?? []).flatMap((evaluation, order) => {
          const diagnosisKey = catalogKeyForRule(evaluation.diagnosisDefinition.stableKey);
          const row = activeCatalog.get(diagnosisKey);
          if (!row) return [];
          const icd10 = resolvedIcd10(row, finding, definition?.stableKey);
          return [{
            diagnosisKey,
            display: row.display,
            ...(icd10 ? { icd10 } : {}),
            codingStatus: row.codingStatus,
            priority: true,
            source: "rule" as const,
            ...support(),
            order,
          }];
        });
        const mappings = definition?.allowDiagnosisMapping === false ? [] : definition?.diagnosisCandidates ?? [];
        const matchedQualifierGroups = new Set(mappings.flatMap((mapping) =>
          mapping.active && (mapping.diagnosisKey !== undefined
            ? activeCatalog.has(mapping.diagnosisKey)
            : stagedDiagnosisFamilyRow(catalog, mapping.familyGroup) !== undefined)
            ? matchingMappingGroups(mapping.trigger, finding).qualifierGroups
            : []
        ));
        const mappingCandidates = mappings.flatMap((mapping, order): OrderedCandidate[] => {
          if (!mapping.active || !evaluateMappingTrigger(mapping.trigger, finding)) return [];
          const matchingGroups = matchingMappingGroups(mapping.trigger, finding);
          if (
            matchingGroups.qualifierGroups.length === 0 &&
            matchingGroups.optionGroups.some((group) => matchedQualifierGroups.has(group))
          ) return [];
          if (mapping.diagnosisKey !== undefined) {
            const row = activeCatalog.get(mapping.diagnosisKey);
            if (!row) return [];
            const icd10 = resolvedIcd10(row, finding, definition?.stableKey);
            return [{
              diagnosisKey: row.stableKey,
              display: row.display,
              ...(icd10 ? { icd10 } : {}),
              codingStatus: row.codingStatus,
              priority: mapping.priority === true,
              source: "mapping" as const,
              ...support(mapping.trigger),
              order,
            }];
          }
          const family = diagnosisFamilyCandidate(catalog, mapping.familyGroup, "mapping", mapping.priority === true);
          return family ? [{ ...family, source: "mapping", ...support(mapping.trigger), order }] : [];
        });
        const baseCandidates = orderDiagnosisCandidates(
          deduplicateDiagnosisCandidates([...ruleCandidates, ...mappingCandidates]),
          definition?.stableKey ? tally?.counts[definition.stableKey] : undefined,
        );
        const revealedGlaucomaFamilies = definition?.stableKey === "cup_disc_ratio" &&
          patientStagedGlaucomaPresent && ruleCandidates.length > 0
          ? ["primary-open-angle-glaucoma", "low-tension-glaucoma"].flatMap((familyGroup) => {
              const family = diagnosisFamilyCandidate(catalog, familyGroup, "rule", true);
              return family ? [family] : [];
            })
          : [];
        const candidates: DiagnosisCandidateRow[] = ([...baseCandidates, ...revealedGlaucomaFamilies] as DiagnosisCandidateRow[])
          .map(candidate => !finding.observationReference && !candidate.supportingFacts?.length ? { ...candidate, linkable: false } : candidate);
        const suppress = definition?.stableKey === "entrance:visual-field-defect" &&
          stagedGlaucomaPresent && candidates.length > 0;
        return {
          findingInstanceId: finding.id,
          findingDefinitionKey: definition?.stableKey,
          ...(finding.observationReference ? { observationReference: finding.observationReference } : {}),
          contributors: view.contributors,
          ...(!finding.observationReference && !candidates.some(c => c.supportingFacts?.length) ? { linkable: false } : {}),
          candidates: suppress ? [] : candidates,
          ...(suppress ? {
            suppressedCandidates: candidates,
            suppression: {
              message: VISUAL_FIELD_GLAUCOMA_SUPPRESSION_MESSAGE,
              overridable: true,
            },
          } : {}),
        };
      }),
    },
  };
  } catch (error) {
    const status = (error as { status?: number })?.status;
    const kind = status === 401 || status === 403 ? "refused" : status === 404 || status === 410 ? "missing" : "upstream";
    return { status: kind === "refused" ? 403 : kind === "missing" ? 404 : 502, body: { result: "unavailable", kind, error: "Diagnosis candidates could not be loaded." } };
  }
}

export function diagnosisDefinitionViews(projection: CurrentFindingProjection, definitions: readonly ClinicalFindingDefinition[]): FindingDefinitionView[] {
  return projection.definitionViews.map(view => {
    const definition = definitions.find(d => observationMatchesFindingDefinition(view, d));
    const panel = projection.panels.find(p => p.stableKey === definition?.stableKey && p.eye === observationLaterality(view));
    if (!definition || !panel) return view;
    const contexts = panel.snapshots.filter(s => s.source.kind === "panel-context" && s.status === "live");
    if (!contexts.length) return view;
    if (panel.conflict) throw new Error("Current finding panel context is ambiguous.");
    const time = (o: Observation) => o.effectiveDateTime ?? o.issued ?? o.meta?.lastUpdated ?? "";
    const latestTime = contexts.map(s => time(s.observation)).sort().at(-1);
    const latest = contexts.filter(s => time(s.observation) === latestTime);
    const fields = customFieldEntries(definition, true).filter(f => f.valueType !== "multi-select");
    const isContext = (c: NonNullable<Observation["component"]>[number]) => c.code.coding?.some(code => fields.some(f => code.code === f.localCode || code.code === `${panel.eye}_${f.localCode}`));
    return { ...view,
      component: [...(view.component ?? []).filter(c => !isContext(c)), ...(latest[0].observation.component ?? []).filter(isContext)],
      contributors: [...new Map([...view.contributors, ...latest.map(s => s.source)].map(c => [c.reference, c])).values()],
    };
  });
}

export function supportingFactsForTrigger(facts: readonly CurrentFindingFact[], finding: FindingInstance, trigger?: MappingTrigger): SupportingFindingFact[] {
  if (trigger && !evaluateMappingTrigger(trigger, finding)) return [];
  if (trigger?.kind === "numeric") return [];
  if (trigger?.kind === "allOf") return unionSupports(trigger.triggers.flatMap(t => supportingFactsForTrigger(facts, finding, t)));
  return facts.flatMap(f => {
    if (f.baseline?.kind !== "canonical") return [];
    if (trigger?.kind === "option" && (f.key.fieldCode !== trigger.field || !trigger.anyOf.includes(f.key.optionCode))) return [];
    if (trigger?.kind === "qualifier" && (f.key.fieldCode !== trigger.field || f.key.optionCode !== trigger.option ||
      Object.entries(trigger.qualifiers).some(([k,v]) => f.qualifiers[k] !== v))) return [];
    return [{ rowKey: f.projectionKey, key: f.key, baseline: f.baseline }];
  });
}
function unionSupports(facts: readonly SupportingFindingFact[]): SupportingFindingFact[] {
  return [...new Map(facts.map(f => [currentFindingIdentifier(f.key).value, f])).values()];
}

export function deduplicateDiagnosisCandidates(candidates: readonly OrderedCandidate[]): OrderedCandidate[] {
  const byDiagnosisKey = new Map<string, OrderedCandidate>();
  for (let candidate of candidates) {
    const key = diagnosisCandidateKey(candidate);
    const current = byDiagnosisKey.get(key);
    const supports = unionSupports([...(current?.supportingFacts ?? []), ...(candidate.supportingFacts ?? [])]);
    if (supports.length) { candidate = { ...candidate, supportingFacts: supports }; if (current) current.supportingFacts = supports; }
    if (!current || candidate.source === "rule" && current.source !== "rule") {
      byDiagnosisKey.set(key, candidate);
      continue;
    }
    if (current.source === "rule" && candidate.source !== "rule") continue;
    if (Number(candidate.priority) > Number(current.priority) ||
      candidate.priority === current.priority && candidate.order < current.order) {
      byDiagnosisKey.set(key, candidate);
    }
  }
  return [...byDiagnosisKey.values()];
}

export function orderDiagnosisCandidates(
  candidates: readonly OrderedCandidate[],
  counts: Readonly<Record<string, number>> = {},
): DiagnosisCandidateRow[] {
  return [...candidates]
    .sort((left, right) =>
      (counts[diagnosisCandidateKey(right)] ?? 0) - (counts[diagnosisCandidateKey(left)] ?? 0) ||
      Number(right.priority) - Number(left.priority) ||
      left.order - right.order ||
      left.display.localeCompare(right.display)
    )
    .map(({ order: _order, ...candidate }) => candidate);
}

function diagnosisCandidateKey(candidate: DiagnosisCandidateRow): string {
  return "diagnosisKey" in candidate ? candidate.diagnosisKey : candidate.familyGroup;
}

function diagnosisFamilyCandidate(
  catalog: readonly DiagnosisCatalogRow[],
  familyGroup: string,
  source: DiagnosisCandidateFamilyRow["source"],
  priority: boolean,
): DiagnosisCandidateFamilyRow | undefined {
  const family = stagedDiagnosisFamilyRow(catalog, familyGroup);
  if (!family?.clinicalFamily || !family.axisLabel || !family.members) return undefined;
  return {
    familyGroup,
    clinicalFamily: family.clinicalFamily,
    display: family.display,
    axisLabel: family.axisLabel,
    members: family.members.map(({ stableKey, stageLabel }) => ({ stableKey, stageLabel })),
    priority,
    source,
  };
}

export function findingInstancesFromObservation(
  observation: Observation,
  definitions: readonly ClinicalFindingDefinition[],
): FindingInstance[] {
  const definition = definitions.find((row) => observationMatchesFindingDefinition(observation, row));
  const id = observation.id ?? (observation as { projectionKey?: string }).projectionKey;
  const encounterReference = observation.encounter?.reference;
  const patientReference = observation.subject?.reference;
  const recordedAt = observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated;
  if (!definition || !id || !encounterReference || !patientReference || !recordedAt) return [];
  const value = findingValueFromObservation(observation, definition);
  if (!value) return [];
  return [{
    id,
    state: "committed",
    presence: observation.valueBoolean === false ? "absent" : "present",
    findingDefinitionId: definition.id,
    patientReference,
    encounterReference,
    ...(observation.id ? { observationReference: `Observation/${observation.id}` } : {}),
    laterality: observationLaterality(observation),
    value,
    interpretation: observationInterpretation(observation),
    method: observation.method,
    performerReferences: (observation.performer ?? []).flatMap((row) => row.reference ? [row.reference] : []),
    sourceReferences: (observation.derivedFrom ?? []).flatMap((row) => row.reference ? [row.reference] : []),
    sourceType: observation.note?.some((note) => note.text?.includes("sourceType=device")) ? "device" : "manual",
    recordedAt,
    provenance: { source: "manual", recordedAt },
  }];
}

function findingValueFromObservation(
  observation: Observation,
  definition: ClinicalFindingDefinition,
): FindingValue | undefined {
  if (definition.stableKey === "refraction") return refractionFindingValue(observation);
  if (observation.valueQuantity?.value !== undefined) {
    return {
      type: "quantity",
      value: observation.valueQuantity.value,
      unit: observation.valueQuantity.unit ?? "",
      ...(observation.valueQuantity.system ? { system: observation.valueQuantity.system } : {}),
      ...(observation.valueQuantity.code ? { code: observation.valueQuantity.code } : {}),
    };
  }
  if (observation.valueString !== undefined) {
    try {
      const parsed = JSON.parse(observation.valueString) as unknown;
      if (isRecord(parsed)) return { type: "json", value: parsed };
    } catch {
      return { type: "string", value: observation.valueString };
    }
    return { type: "string", value: observation.valueString };
  }
  if (observation.component?.length) {
    const clinicalBoolean = observation.component.find((component) =>
      component.code.coding?.some((coding) => coding.code === "CLINICAL_VALUE") &&
      component.valueBoolean !== undefined
    )?.valueBoolean;
    if (clinicalBoolean !== undefined) return { type: "boolean", value: clinicalBoolean };
    return {
      type: "components",
      components: observation.component.flatMap((component) => {
        const code = component.code.coding?.find((coding) => coding.code)?.code;
        const display = component.code.text ?? component.code.coding?.find((coding) => coding.display)?.display ?? code;
        const value = component.valueQuantity?.value ?? component.valueString ?? component.valueBoolean ?? component.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
        if (!code || !display || value === undefined) return [];
        return [{ code, display, value, ...(component.valueQuantity?.unit ? { unit: component.valueQuantity.unit } : {}) }];
      }),
    };
  }
  if (observation.valueBoolean !== undefined) return { type: "presence" };
  return undefined;
}

function refractionFindingValue(observation: Observation): FindingValue | undefined {
  const component = (code: string) => observation.component?.find((row) =>
    row.code.coding?.some((coding) => coding.code === code)
  );
  const refractionType = component("REFRACTION_TYPE")?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  const blockId = component("REFRACTION_BLOCK_ID")?.valueString;
  if (!refractionType || !blockId) return undefined;
  return {
    type: "json",
    value: compactRecord({
      blockId,
      refractionType,
      sphere: component("SPHERE")?.valueQuantity?.value,
      cylinder: component("CYLINDER")?.valueQuantity?.value,
      axis: component("AXIS")?.valueQuantity?.value,
      add: component("ADD")?.valueQuantity?.value,
      customFields: observation.component?.flatMap((row) => {
        const code = row.code.coding?.find((coding) => coding.code?.startsWith("CUSTOM_"))?.code;
        const value = row.valueQuantity?.value ?? row.valueString ?? row.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
        return code && value !== undefined ? [{ code, value }] : [];
      }) ?? [],
    }),
  };
}

function observationLaterality(observation: Observation): FindingInstance["laterality"] {
  const code = observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    observation.bodySite?.coding?.find((coding) => coding.code)?.code;
  return code === "OD" || code === "OS" || code === "OU" ? code : "UNKNOWN";
}

function observationInterpretation(observation: Observation): FindingInterpretation | undefined {
  const code = observation.interpretation?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.code)?.code?.toLowerCase();
  if (code === "a" || code === "abnormal") return "abnormal";
  if (code === "b" || code === "borderline") return "borderline";
  if (code === "n" || code === "normal") return "normal";
  return code ? "unknown" : undefined;
}

function resolvedIcd10(
  row: DiagnosisCatalogRow,
  finding: FindingInstance,
  definitionStableKey: string | undefined,
): DiagnosisCandidateLeafRow["icd10"] | undefined {
  if (!row.icd10) return undefined;
  if ("code" in row.icd10) return row.icd10;
  const descriptor = visualFieldDescriptorResolution(definitionStableKey, finding.value);
  if (
    descriptor?.codeSelection?.kind === "field" &&
    row.stableKey === "vf_homonymous_bilateral"
  ) {
    const code = row.icd10.pattern[descriptor.codeSelection.slot];
    return code ? { code } : { pattern: row.icd10.pattern };
  }
  if (
    descriptor?.codeSelection?.kind === "eye" &&
    row.clinicalFamily === "visual-field-defect" &&
    row.lateralityRequired
  ) {
    const code = row.icd10.pattern[descriptor.codeSelection.slot];
    return code ? { code } : { pattern: row.icd10.pattern };
  }
  if (!row.lateralityRequired) {
    const code = row.icd10.pattern.unspecifiedEye;
    return code ? { code } : { pattern: row.icd10.pattern };
  }
  const code = finding.laterality === "OD" ? row.icd10.pattern.right
    : finding.laterality === "OS" ? row.icd10.pattern.left
    : finding.laterality === "OU" ? row.icd10.pattern.bilateral
    : row.icd10.pattern.unspecifiedEye;
  return code ? { code } : { pattern: row.icd10.pattern };
}

function isConfirmedStagedGlaucoma(condition: Condition): boolean {
  const verified = condition.verificationStatus?.coding?.some((coding) => coding.code === "confirmed") === true;
  if (!verified) return false;
  const inactive = condition.clinicalStatus?.coding?.some((coding) =>
    coding.code === "inactive" || coding.code === "remission" || coding.code === "resolved"
  ) === true;
  if (inactive) return false;
  return condition.code?.coding?.some((coding) =>
    coding.system === ICD10_CM_CODE_SYSTEM &&
    typeof coding.code === "string" && /^H40\.[A-Z0-9]{3}[123]$/i.test(coding.code)
  ) === true;
}

function groupRulesByFinding(rows: readonly DiagnosisSuggestionEvaluation[]) {
  const grouped = new Map<string, DiagnosisSuggestionEvaluation[]>();
  for (const row of rows) {
    const id = row.suggestionEdge.sourceFindingInstanceId;
    if (id) grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return grouped;
}

function catalogKeyForRule(stableKey: string): string {
  if (stableKey.startsWith("glaucoma_suspect_open_angle_low_")) return "glaucoma_suspect_open_angle_low";
  if (stableKey.startsWith("glaucoma_suspect_open_angle_high_")) return "glaucoma_suspect_open_angle_high";
  if (stableKey.startsWith("ocular_hypertension_")) return "ocular_hypertension";
  for (const family of ["hyperopia", "myopia", "astigmatism", "anisometropia", "presbyopia"] as const) {
    if (stableKey === family || stableKey.startsWith(`${family}_`)) return family;
  }
  return stableKey;
}

function readEncounterId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.encounterId;
  return typeof id === "string" && /^[A-Za-z0-9.-]+$/.test(id) ? id : undefined;
}

function staffMay(role: PracticeRoleId, action: "chart.read"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, row]) => row !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
