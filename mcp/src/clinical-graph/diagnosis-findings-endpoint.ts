import type {
  Bundle,
  Condition,
  Encounter,
  Observation,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import {
  FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
  hasConditionCategory,
} from "../fhir/condition.js";
import {
  ODOS_EXTENSION_URLS,
  lateralityConcept,
  odosConcept,
} from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { collectAllFhirSearchPages } from "../fhir-search.js";
import { customFieldEntries } from "./custom-fields.js";
import {
  DIAGNOSIS_FINDING_REASSERTION_CODE,
  ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM,
  readDiagnosisCarryState,
  type DiagnosisCarryState,
  type SourceAbsentFindingSnapshot,
} from "./diagnosis-carry-provenance.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "./diagnosis-pick-endpoint.js";
import { FhirFindingDefinitionStore } from "./finding-definition-store.js";
import type {
  ClinicalFindingDefinition,
  DiagnosisCatalogRow,
  MappingTrigger,
} from "./glaucoma-suspect.js";
import { FAMILY_RESOLUTION_MODES } from "./diagnosis-catalog-seeds.js";
import {
  buildFindingInstance,
  patientScopedProvenanceTargets,
  projectFindingInstanceToObservation,
} from "./glaucoma-suspect.js";

export type FindingLaterality = "OD" | "OS" | "OU" | "UNKNOWN";

export interface AtomicFindingCatalogRow {
  atomicFindingId: string;
  findingDefinitionId: string;
  findingDefinitionKey: string;
  fieldCode: string;
  optionCode: string;
  display: string;
  sectionKey: string;
  gradeScale: string[];
  diagnosisKeys: string[];
  origin: "shipped" | "custom";
}

export interface EncounterFindingRow extends AtomicFindingCatalogRow {
  laterality: FindingLaterality;
  lateralitySource: "inherited" | "explicit";
  source: "atomic" | "section" | "offered";
  presence?: "present" | "absent";
  grade?: string;
  observationReference?: string;
  conditionReference?: string;
  carried?: boolean;
  priorPresence?: "present" | "absent";
  priorGrade?: string;
  priorLaterality?: FindingLaterality;
}

export interface DiagnosisFindingsPayload {
  canWrite: boolean;
  diagnosis?: DiagnosisCatalogRow;
  carryProvenance?: {
    pulledFromDate?: string;
    unchangedSinceDate?: string;
    edited: boolean;
    integrityWarning?: string;
  };
  findings: EncounterFindingRow[];
  catalog: AtomicFindingCatalogRow[];
  unassigned: EncounterFindingRow[];
  bySection: Record<string, EncounterFindingRow[]>;
  visitDiagnoses: Array<{
    conditionReference: string;
    diagnosisKey: string;
    display: string;
    laterality: FindingLaterality;
  }>;
}

export interface DiagnosisFindingsFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Resource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

export interface DiagnosisFindingsEndpointDeps {
  fhirBaseUrl: string;
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: DiagnosisFindingsFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[] | Promise<ClinicalFindingDefinition[]>;
  diagnosisCatalog?: () => DiagnosisCatalogRow[] | Promise<DiagnosisCatalogRow[]>;
  now?: () => string;
}

const paramsSchema = z.object({ encounterId: z.string().trim().min(1).max(128) }).strict();
const readQuerySchema = z.object({
  condition: z.string().regex(/^Condition\/[^/]+$/).optional(),
}).strict();
const patientReferenceSchema = z.string().regex(/^Patient\/[^/]+$/);
const observationReferenceSchema = z.string().regex(/^Observation\/[^/]+$/);
const conditionReferenceSchema = z.string().regex(/^Condition\/[^/]+$/);
const atomicFindingIdSchema = z.string().trim().min(1).max(500);
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assert"),
    patientReference: patientReferenceSchema,
    conditionReference: conditionReferenceSchema,
    atomicFindingId: atomicFindingIdSchema,
    presence: z.enum(["present", "absent"]),
    laterality: z.enum(["OD", "OS", "OU"]).optional(),
  }).strict(),
  z.object({
    action: z.literal("clear"),
    patientReference: patientReferenceSchema,
    observationReference: observationReferenceSchema,
  }).strict(),
  z.object({
    action: z.literal("grade"),
    patientReference: patientReferenceSchema,
    observationReference: observationReferenceSchema,
    grade: z.string().trim().min(1).max(100).nullable(),
  }).strict(),
  z.object({
    action: z.literal("laterality"),
    patientReference: patientReferenceSchema,
    observationReference: observationReferenceSchema,
    laterality: z.enum(["OD", "OS", "OU"]).nullable(),
  }).strict(),
  z.object({
    action: z.literal("assign"),
    patientReference: patientReferenceSchema,
    observationReference: observationReferenceSchema,
    conditionReference: conditionReferenceSchema,
  }).strict(),
  z.object({
    action: z.literal("standalone"),
    patientReference: patientReferenceSchema,
    observationReference: observationReferenceSchema,
  }).strict(),
]);

const WRITE_HEADERS = { "X-ODOS-Source": "diagnosis-findings" } as const;
const GRADE_COMPONENT = "GRADE";
const LATERALITY_SOURCE_COMPONENT = "LATERALITY_SOURCE";

export async function handleDiagnosisFindingsReadRequest(
  deps: DiagnosisFindingsEndpointDeps,
  input: {
    authHeader: string | undefined;
    params: unknown;
    query: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read encounter findings." } };
  }
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const parsedParams = paramsSchema.safeParse(input.params);
  const parsedQuery = readQuerySchema.safeParse(input.query);
  if (!parsedParams.success || !parsedQuery.success) {
    return { status: 400, body: { error: "Invalid encounter findings request." } };
  }
  try {
  const encounter = await staff.fhir.read<Encounter>("Encounter", parsedParams.data.encounterId);
  const patientReference = encounter.subject?.reference;
  if (!patientReference?.startsWith("Patient/")) {
    return { status: 400, body: { error: "Encounter findings require an encounter patient." } };
  }
  const encounterReference = `Encounter/${parsedParams.data.encounterId}`;
  const [definitions, diagnoses, conditionRows, observationRows] = await Promise.all([
    findingDefinitions(deps, staff.fhir),
    diagnosisCatalog(deps, staff.fhir),
    allEncounterResources<Condition>(staff.fhir, "Condition", encounterReference, "200", deps.fhirBaseUrl),
    allEncounterResources<Observation>(staff.fhir, "Observation", encounterReference, "500", deps.fhirBaseUrl),
  ]);
  const conditions = conditionRows.filter((condition) =>
    condition.subject.reference === patientReference && isCurrentVisitDiagnosis(condition)
  );
  const selectedCondition = parsedQuery.data.condition
    ? conditions.find((condition) => conditionReference(condition) === parsedQuery.data.condition)
    : undefined;
  if (parsedQuery.data.condition && !selectedCondition) {
    return { status: 404, body: { error: "Selected diagnosis is not part of this encounter." } };
  }
  const catalog = materializeAtomicFindingCatalog(definitions);
  const diagnosisRows = diagnoses.map((diagnosis) => materializeDiagnosis(diagnosis, catalog));
  const visits = conditions.flatMap((condition) => {
    const diagnosisKey = conditionDiagnosisKey(condition, parsedParams.data.encounterId, diagnosisRows);
    const reference = conditionReference(condition);
    if (!diagnosisKey || !reference) return [];
    return [{
      condition,
      conditionReference: reference,
      diagnosisKey,
      display: condition.code?.text ?? diagnosisRows.find((row) => row.stableKey === diagnosisKey)?.display ?? diagnosisKey,
      laterality: conditionLaterality(condition, parsedParams.data.encounterId),
    }];
  });
  const bindingIndex = conditionBindings(visits);
  const observations = observationRows.filter((observation) =>
    observation.subject?.reference === patientReference && observation.status !== "entered-in-error"
  );
  const carryState = selectedCondition
    ? await readDiagnosisCarryState(staff.fhir, selectedCondition, observations)
    : undefined;
  const charted = [
    ...atomicFindingRows(observations, catalog, bindingIndex, carryState?.observationCarried),
    ...sectionFindingRows(observations, definitions, catalog, visits, bindingIndex),
  ];
  const selectedVisit = selectedCondition
    ? visits.find((visit) => visit.conditionReference === conditionReference(selectedCondition))
    : undefined;
  const selectedDiagnosis = selectedVisit
    ? diagnosisRows.find((diagnosis) => diagnosis.stableKey === selectedVisit.diagnosisKey)
    : undefined;
  const findings = selectedVisit
    ? selectedFindings(
        selectedVisit,
        selectedDiagnosis,
        charted,
        catalog,
        carryState?.sourceAbsentSnapshots ?? [],
      )
    : [];
  const unassigned = charted
    .filter((row) => !row.conditionReference)
    .sort(findingRowOrder);
  const bySection = [...charted].sort(findingRowOrder).reduce<Record<string, EncounterFindingRow[]>>(
    (groups, row) => {
      (groups[row.sectionKey] ??= []).push(row);
      return groups;
    },
    {},
  );
  const body: DiagnosisFindingsPayload = {
    canWrite: staffMay(staff.actorRole, "chart.write"),
    ...(selectedDiagnosis ? { diagnosis: selectedDiagnosis } : {}),
    ...(carryState && (carryState.pulledFromDate || carryState.integrityWarning)
      ? { carryProvenance: carrySummary(carryState) }
      : {}),
    findings,
    catalog,
    unassigned,
    bySection,
    visitDiagnoses: visits.map((visit) => ({
      conditionReference: visit.conditionReference,
      diagnosisKey: visit.diagnosisKey,
      display: visit.display,
      laterality: visit.laterality,
    })),
  };
  return { status: 200, body };
  } catch (error) {
    return diagnosisFindingsDependencyResponse(error);
  }
}

export async function handleDiagnosisFindingsMutationRequest(
  deps: DiagnosisFindingsEndpointDeps,
  input: {
    authHeader: string | undefined;
    params: unknown;
    body: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to update encounter findings." } };
  }
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsedParams = paramsSchema.safeParse(input.params);
  const parsedBody = mutationSchema.safeParse(input.body);
  if (!parsedParams.success || !parsedBody.success) {
    return {
      status: 400,
      body: { error: parsedBody.success ? "Invalid encounter findings mutation." : parsedBody.error.issues[0]?.message },
    };
  }
  try {
  const encounterId = parsedParams.data.encounterId;
  const encounterReference = `Encounter/${encounterId}`;
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  if (encounter.subject?.reference !== parsedBody.data.patientReference) {
    return { status: 400, body: { error: "Finding patient must match the encounter patient." } };
  }
  const conditions = (await allEncounterResources<Condition>(
    staff.fhir,
    "Condition",
    encounterReference,
    "200",
    deps.fhirBaseUrl,
  )).filter((condition) =>
    condition.subject.reference === parsedBody.data.patientReference && isCurrentVisitDiagnosis(condition)
  );
  const definitions = await findingDefinitions(deps, staff.fhir);
  const catalog = materializeAtomicFindingCatalog(definitions);
  if (parsedBody.data.action === "assert") {
    const assertion = parsedBody.data;
    const condition = conditions.find((candidate) =>
      conditionReference(candidate) === assertion.conditionReference
    );
    const catalogRow = catalog.find((row) => row.atomicFindingId === assertion.atomicFindingId);
    if (!condition || !catalogRow) {
      return { status: 400, body: { error: "Finding and diagnosis must belong to this encounter catalog." } };
    }
    const inheritedLaterality = conditionLaterality(condition, encounterId);
    const laterality = assertion.laterality ?? inheritedLaterality;
    if (laterality === "UNKNOWN") {
      return { status: 400, body: { error: "Finding laterality must be explicit when the diagnosis has no laterality." } };
    }
    const observations = await allEncounterResources<Observation>(
      staff.fhir,
      "Observation",
      encounterReference,
      "500",
      deps.fhirBaseUrl,
    );
    const existing = observations.find((observation) =>
      observation.status !== "entered-in-error" &&
      observation.subject?.reference === assertion.patientReference &&
      observation.code.coding?.some((coding) => coding.code === catalogRow.atomicFindingId) &&
      observationLaterality(observation) === laterality
    );
    const carryState = await readDiagnosisCarryState(staff.fhir, condition, observations);
    const existingReference = existing ? observationReference(existing) : undefined;
    const reassertingCarriedFinding = isCarriedFindingReassertion(
      carryState,
      existingReference,
      assertion.atomicFindingId,
      laterality,
    );
    const recordedAt = deps.now?.() ?? new Date().toISOString();
    const observation = existing?.id
      ? await staff.fhir.update<Observation>("Observation", existing.id, {
          ...existing,
          status: "preliminary",
          valueBoolean: assertion.presence === "present",
          effectiveDateTime: recordedAt,
        }, WRITE_HEADERS)
      : await staff.fhir.create<Observation>(buildAtomicObservation({
          catalogRow,
          definition: definitions.find((definition) => definition.id === catalogRow.findingDefinitionId)!,
          patientReference: assertion.patientReference,
          encounterReference,
          laterality,
          lateralitySource: assertion.laterality ? "explicit" : "inherited",
          presence: assertion.presence,
          staffReference: staff.staffReference,
          recordedAt,
        }), WRITE_HEADERS);
    const reference = observationReference(observation)!;
    await rehomeEvidence(staff.fhir, conditions, reference, assertion.conditionReference);
    if (reassertingCarriedFinding) {
      await persistFindingReassertionProvenance(
        staff.fhir,
        reference,
        assertion.patientReference,
        staff.staffReference,
        recordedAt,
      );
    }
    await persistMutationProvenance(
      staff.fhir,
      [reference],
      assertion.patientReference,
      staff.staffReference,
      recordedAt,
      existing ? "UPDATE" : "CREATE",
    );
    return { status: 200, body: { observationReference: reference } };
  }
  const observation = await readEncounterAtomicObservation(
    staff.fhir,
    parsedBody.data.observationReference,
    encounterReference,
    parsedBody.data.patientReference,
    catalog,
  );
  if (!observation) {
    return { status: 400, body: { error: "Atomic finding Observation is outside this encounter or catalog." } };
  }
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  if (parsedBody.data.action === "assign") {
    const assignment = parsedBody.data;
    if (!conditions.some((condition) => conditionReference(condition) === assignment.conditionReference)) {
      return { status: 400, body: { error: "Assigned diagnosis must belong to this encounter and patient." } };
    }
    await rehomeEvidence(staff.fhir, conditions, assignment.observationReference, assignment.conditionReference);
    await persistMutationProvenance(
      staff.fhir,
      [assignment.observationReference, assignment.conditionReference],
      assignment.patientReference,
      staff.staffReference,
      recordedAt,
      "UPDATE",
    );
    return { status: 200, body: { observationReference: assignment.observationReference } };
  }
  if (parsedBody.data.action === "standalone") {
    await rehomeEvidence(staff.fhir, conditions, parsedBody.data.observationReference);
    await persistMutationProvenance(
      staff.fhir,
      [parsedBody.data.observationReference],
      parsedBody.data.patientReference,
      staff.staffReference,
      recordedAt,
      "UPDATE",
    );
    return { status: 200, body: { observationReference: parsedBody.data.observationReference } };
  }
  if (!observation.id) {
    return { status: 400, body: { error: "Atomic finding Observation has no id." } };
  }
  let next: Observation;
  if (parsedBody.data.action === "clear") {
    next = { ...observation, status: "entered-in-error" };
    await rehomeEvidence(staff.fhir, conditions, parsedBody.data.observationReference);
  } else if (parsedBody.data.action === "grade") {
    const catalogRow = catalog.find((row) =>
      observation.code.coding?.some((coding) => coding.code === row.atomicFindingId)
    )!;
    if (parsedBody.data.grade !== null && !catalogRow.gradeScale.includes(parsedBody.data.grade)) {
      return { status: 400, body: { error: "Grade must use the configured finding scale." } };
    }
    next = withStringComponent(observation, GRADE_COMPONENT, "Grade", parsedBody.data.grade);
  } else {
    const laterality = parsedBody.data.laterality ?? inheritedObservationLaterality(
      observation,
      conditions,
      encounterId,
    );
    if (!laterality || laterality === "UNKNOWN") {
      return { status: 400, body: { error: "Cannot restore laterality without one diagnosis binding." } };
    }
    next = withStringComponent({
      ...observation,
      extension: [
        ...(observation.extension ?? []).filter((extension) => extension.url !== ODOS_EXTENSION_URLS.eyeLaterality),
        { url: ODOS_EXTENSION_URLS.eyeLaterality, valueCodeableConcept: lateralityConcept(laterality) },
      ],
    }, LATERALITY_SOURCE_COMPONENT, "Laterality source", parsedBody.data.laterality ? "explicit" : "inherited");
  }
  const updated = await staff.fhir.update<Observation>("Observation", observation.id, next, WRITE_HEADERS);
  await persistMutationProvenance(
    staff.fhir,
    [parsedBody.data.observationReference],
    parsedBody.data.patientReference,
    staff.staffReference,
    recordedAt,
    "UPDATE",
  );
  return { status: 200, body: { observationReference: observationReference(updated) } };
  } catch (error) {
    return diagnosisFindingsDependencyResponse(error);
  }
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

export function materializeAtomicFindingCatalog(
  definitions: readonly ClinicalFindingDefinition[],
): AtomicFindingCatalogRow[] {
  return definitions
    .filter((definition) => definition.active)
    .flatMap((definition) => customFieldEntries(definition).flatMap((field) =>
      field.options?.filter((option) => option.active).map((option): AtomicFindingCatalogRow => ({
        atomicFindingId: `${definition.stableKey}::${field.localCode}::${option.code}`,
        findingDefinitionId: definition.id,
        findingDefinitionKey: definition.stableKey,
        fieldCode: field.localCode,
        optionCode: option.code,
        display: option.display,
        sectionKey: definition.sectionKey ?? definition.stableKey,
        gradeScale: option.qualifiers
          ?.filter((qualifier) => qualifier.kind === "graded")
          .flatMap((qualifier) => qualifier.options) ?? [],
        diagnosisKeys: [...new Set((definition.diagnosisCandidates ?? [])
          .filter((candidate) => candidate.active && triggerIncludesOption(
            candidate.trigger,
            field.localCode,
            option.code,
          ))
          .flatMap((candidate) => {
            if (candidate.diagnosisKey !== undefined) return [candidate.diagnosisKey];
            const mode = FAMILY_RESOLUTION_MODES[candidate.familyGroup];
            return mode?.mode === "staged" ? mode.members.map((member) => member.stableKey) : [];
          }))].sort(),
        origin: definition.sourceStatus === "local-practice" ? "custom" : "shipped",
      })) ?? []
    ))
    .sort((left, right) => left.display.localeCompare(right.display) ||
      left.atomicFindingId.localeCompare(right.atomicFindingId));
}

function selectedFindings(
  visit: VisitDiagnosis,
  diagnosis: DiagnosisCatalogRow | undefined,
  charted: readonly EncounterFindingRow[],
  catalog: readonly AtomicFindingCatalogRow[],
  sourceAbsentSnapshots: readonly SourceAbsentFindingSnapshot[],
): EncounterFindingRow[] {
  const selectedCharted = charted.filter((row) => row.conditionReference === visit.conditionReference);
  const chartedIdentities = new Set(charted
    .filter((row) => !row.conditionReference || row.conditionReference === visit.conditionReference)
    .map((row) => `${row.atomicFindingId}|${row.laterality}`));
  const priorAbsent = uniqueAbsentSnapshots(sourceAbsentSnapshots);
  const offered = diagnosis
    ? catalog
        .filter((row) => row.diagnosisKeys.includes(diagnosis.stableKey))
        .filter((row) => !chartedIdentities.has(`${row.atomicFindingId}|${visit.laterality}`))
        .map((row): EncounterFindingRow => {
          const prior = priorAbsent.get(`${row.atomicFindingId}|${visit.laterality}`);
          return {
            ...row,
            laterality: visit.laterality,
            lateralitySource: "inherited",
            source: "offered",
            ...(prior ? {
              priorPresence: prior.presence,
              ...(prior.grade ? { priorGrade: prior.grade } : {}),
              priorLaterality: prior.laterality,
            } : {}),
          };
        })
    : [];
  return [...selectedCharted, ...offered].sort(findingRowOrder);
}

function atomicFindingRows(
  observations: readonly Observation[],
  catalog: readonly AtomicFindingCatalogRow[],
  bindingIndex: ReadonlyMap<string, string[]>,
  observationCarried: Readonly<Record<string, boolean>> = {},
): EncounterFindingRow[] {
  const catalogByCode = new Map(catalog.map((row) => [row.atomicFindingId, row]));
  return observations.flatMap((observation) => {
    const code = observation.code.coding?.find((coding) => catalogByCode.has(coding.code ?? ""))?.code;
    const catalogRow = code ? catalogByCode.get(code) : undefined;
    const reference = observationReference(observation);
    if (!catalogRow || !reference) return [];
    const bindings = bindingIndex.get(reference) ?? [];
    return [{
      ...catalogRow,
      laterality: observationLaterality(observation),
      lateralitySource: componentString(observation, LATERALITY_SOURCE_COMPONENT) === "inherited"
        ? "inherited" as const
        : "explicit" as const,
      source: "atomic" as const,
      presence: observation.valueBoolean === false ? "absent" as const : "present" as const,
      ...(observationGrade(observation) ? { grade: observationGrade(observation) } : {}),
      observationReference: reference,
      ...(Object.hasOwn(observationCarried, reference) ? { carried: observationCarried[reference] } : {}),
      ...(bindings.length === 1 ? { conditionReference: bindings[0] } : {}),
    }];
  });
}

function uniqueAbsentSnapshots(
  snapshots: readonly SourceAbsentFindingSnapshot[],
): Map<string, SourceAbsentFindingSnapshot> {
  const unique = new Map<string, SourceAbsentFindingSnapshot>();
  const ambiguous = new Set<string>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.atomicFindingId}|${snapshot.laterality}`;
    if (unique.has(key)) {
      unique.delete(key);
      ambiguous.add(key);
    } else if (!ambiguous.has(key)) {
      unique.set(key, snapshot);
    }
  }
  return unique;
}

function carrySummary(state: DiagnosisCarryState): NonNullable<DiagnosisFindingsPayload["carryProvenance"]> {
  return {
    ...(state.pulledFromDate ? { pulledFromDate: state.pulledFromDate } : {}),
    ...(state.unchangedSinceDate ? { unchangedSinceDate: state.unchangedSinceDate } : {}),
    edited: state.edited,
    ...(state.integrityWarning ? { integrityWarning: state.integrityWarning } : {}),
  };
}

function sectionFindingRows(
  observations: readonly Observation[],
  definitions: readonly ClinicalFindingDefinition[],
  catalog: readonly AtomicFindingCatalogRow[],
  visits: readonly VisitDiagnosis[],
  bindingIndex: ReadonlyMap<string, string[]>,
): EncounterFindingRow[] {
  const definitionByCode = new Map(definitions.map((definition) => [definition.stableKey, definition]));
  const latest = new Map<string, Observation>();
  for (const observation of observations) {
    const definitionCode = observation.code.coding?.find((coding) =>
      definitionByCode.has(coding.code ?? "")
    )?.code;
    if (!definitionCode) continue;
    const key = `${definitionCode}|${observationLaterality(observation)}`;
    const current = latest.get(key);
    if (!current || observationTime(observation) > observationTime(current)) latest.set(key, observation);
  }
  return [...latest.values()].flatMap((observation) => {
    const definitionCode = observation.code.coding?.find((coding) =>
      definitionByCode.has(coding.code ?? "")
    )?.code;
    const definition = definitionCode ? definitionByCode.get(definitionCode) : undefined;
    const reference = observationReference(observation);
    if (!definition || !reference) return [];
    const explicitBindings = bindingIndex.get(reference) ?? [];
    const laterality = observationLaterality(observation);
    return catalog.filter((row) => row.findingDefinitionId === definition.id).flatMap((row) => {
      const present = observation.component?.some((component) =>
        component.valueBoolean === true && component.code.coding?.some((coding) =>
          coding.code === `${row.fieldCode}::${row.optionCode}` ||
          coding.code?.endsWith(`_${row.fieldCode}::${row.optionCode}`)
        )
      );
      if (!present) return [];
      const inferred = explicitBindings.length === 0
        ? visits.filter((visit) =>
            row.diagnosisKeys.includes(visit.diagnosisKey) &&
            lateralityMatches(laterality, visit.laterality)
          ).map((visit) => visit.conditionReference)
        : [];
      const bindings = explicitBindings.length ? explicitBindings : inferred;
      const grade = sectionGrade(observation, row);
      return [{
        ...row,
        laterality,
        lateralitySource: "explicit" as const,
        source: "section" as const,
        presence: "present" as const,
        ...(grade ? { grade } : {}),
        observationReference: reference,
        ...(bindings.length === 1 ? { conditionReference: bindings[0] } : {}),
      }];
    });
  });
}

function materializeDiagnosis(
  diagnosis: DiagnosisCatalogRow,
  catalog: readonly AtomicFindingCatalogRow[],
): DiagnosisCatalogRow {
  const applicableFindingDefinitionIds = [...new Set(catalog
    .filter((row) => row.diagnosisKeys.includes(diagnosis.stableKey))
    .map((row) => row.findingDefinitionId))].sort();
  return { ...diagnosis, applicableFindingDefinitionIds };
}

function conditionBindings(visits: readonly VisitDiagnosis[]): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const visit of visits) {
    for (const reference of visit.condition.evidence?.flatMap((evidence) => evidence.detail ?? []) ?? []) {
      if (!reference.reference?.startsWith("Observation/")) continue;
      bindings.set(reference.reference, [
        ...(bindings.get(reference.reference) ?? []),
        visit.conditionReference,
      ]);
    }
  }
  return bindings;
}

function triggerIncludesOption(trigger: MappingTrigger, field: string, option: string): boolean {
  if (trigger.kind === "option") return trigger.field === field && trigger.anyOf.includes(option);
  if (trigger.kind === "qualifier") return trigger.field === field && trigger.option === option;
  if (trigger.kind === "allOf") {
    return trigger.triggers.some((nested) => triggerIncludesOption(nested, field, option));
  }
  return false;
}

function sectionGrade(observation: Observation, row: AtomicFindingCatalogRow): string | undefined {
  const suffix = `${row.fieldCode}::${row.optionCode}::grade`;
  const component = observation.component?.find((candidate) => candidate.code.coding?.some((coding) =>
    coding.code === suffix || coding.code?.endsWith(`_${suffix}`)
  ));
  const value = component?.valueString ?? component?.valueCodeableConcept?.coding?.[0]?.code;
  return value && row.gradeScale.includes(value) ? value : undefined;
}

function observationGrade(observation: Observation): string | undefined {
  const component = observation.component?.find((candidate) => candidate.code.coding?.some((coding) =>
    coding.code === GRADE_COMPONENT
  ));
  return component?.valueString ?? component?.valueCodeableConcept?.coding?.[0]?.code;
}

function observationLaterality(observation: Observation): FindingLaterality {
  const code = observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    observation.bodySite?.coding?.find((coding) => coding.code)?.code;
  if (code === "OD" || code === "right") return "OD";
  if (code === "OS" || code === "left") return "OS";
  if (code === "OU" || code === "bilateral") return "OU";
  return "UNKNOWN";
}

function conditionLaterality(condition: Condition, encounterId: string): FindingLaterality {
  const recorded = condition.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    condition.bodySite?.flatMap((bodySite) => [
      ...(bodySite.coding ?? []).flatMap((coding) => coding.code ? [coding.code] : []),
      ...(bodySite.text ? [bodySite.text] : []),
    ]).find((value) => value === "OD" || value === "OS" || value === "OU" ||
      value === "right" || value === "left" || value === "bilateral");
  if (recorded === "OD" || recorded === "right") return "OD";
  if (recorded === "OS" || recorded === "left") return "OS";
  if (recorded === "OU" || recorded === "bilateral") return "OU";
  const value = condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM && identifier.value?.startsWith(`${encounterId}::`)
  )?.value?.split("::").at(-1);
  if (value === "right") return "OD";
  if (value === "left") return "OS";
  if (value === "bilateral") return "OU";
  return "UNKNOWN";
}

function isCurrentVisitDiagnosis(condition: Condition): boolean {
  if (!hasConditionCategory(condition, "encounter-diagnosis")) return false;
  const verification = condition.verificationStatus?.coding?.find((coding) =>
    coding.system === FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM
  )?.code;
  return verification === "confirmed" ||
    verification === "provisional" ||
    verification === "differential" ||
    verification === "unconfirmed";
}

function lateralityMatches(finding: FindingLaterality, diagnosis: FindingLaterality): boolean {
  return finding === "UNKNOWN" || diagnosis === "UNKNOWN" || finding === diagnosis;
}

function conditionDiagnosisKey(
  condition: Condition,
  encounterId: string,
  diagnoses: readonly DiagnosisCatalogRow[],
): string | undefined {
  const value = condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value;
  return diagnoses.find((diagnosis) =>
    value === diagnosis.stableKey || value?.startsWith(`${encounterId}::${diagnosis.stableKey}::`)
  )?.stableKey;
}

function conditionReference(condition: Condition): string | undefined {
  return condition.id ? `Condition/${condition.id}` : undefined;
}

function observationReference(observation: Observation): string | undefined {
  return observation.id ? `Observation/${observation.id}` : undefined;
}

function observationTime(observation: Observation): string {
  return observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "";
}

function findingRowOrder(left: EncounterFindingRow, right: EncounterFindingRow): number {
  const sourceRank = (source: EncounterFindingRow["source"]) => source === "offered" ? 1 : 0;
  return sourceRank(left.source) - sourceRank(right.source) ||
    left.display.localeCompare(right.display) ||
    left.laterality.localeCompare(right.laterality);
}

async function allEncounterResources<T extends Condition | Observation>(
  fhir: DiagnosisFindingsFhirClient,
  resourceType: T["resourceType"],
  encounterReference: string,
  count: string,
  fhirBaseUrl: string,
): Promise<T[]> {
  // search-contract: diagnosis-findings.encounter-resources
  const first = await fhir.search<T>(resourceType, {
    encounter: encounterReference,
    _count: count,
  });
  return collectAllFhirSearchPages<T>(fhir, resourceType, first, fhirBaseUrl);
}

function diagnosisFindingsDependencyResponse(error: unknown): { status: number; body: { error: string } } {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 401 || status === 403) {
    return {
      status: 403,
      body: { error: "Diagnosis findings are outside the caller's patient compartment." },
    };
  }
  if (status === 404 || status === 410) {
    return {
      status: 404,
      body: { error: "Diagnosis findings resources were not found." },
    };
  }
  console.error("odos-mcp: diagnosis findings dependency failed:", error);
  return {
    status: 502,
    body: { error: "FHIR diagnosis findings dependency failed." },
  };
}

async function findingDefinitions(
  deps: DiagnosisFindingsEndpointDeps,
  fhir: DiagnosisFindingsFhirClient,
): Promise<ClinicalFindingDefinition[]> {
  return deps.findingDefinitions?.() ?? new FhirFindingDefinitionStore(fhir).list();
}

async function diagnosisCatalog(
  deps: DiagnosisFindingsEndpointDeps,
  fhir: DiagnosisFindingsFhirClient,
): Promise<DiagnosisCatalogRow[]> {
  return deps.diagnosisCatalog?.() ?? new FhirDiagnosisCatalogStore(fhir).list();
}

function buildAtomicObservation(input: {
  catalogRow: AtomicFindingCatalogRow;
  definition: ClinicalFindingDefinition;
  patientReference: string;
  encounterReference: string;
  laterality: Exclude<FindingLaterality, "UNKNOWN">;
  lateralitySource: "inherited" | "explicit";
  presence: "present" | "absent";
  staffReference: string;
  recordedAt: string;
}): Observation {
  const definition: ClinicalFindingDefinition = {
    ...input.definition,
    stableKey: input.catalogRow.atomicFindingId,
    display: input.catalogRow.display,
    fhirObservationCode: odosConcept(input.catalogRow.atomicFindingId, input.catalogRow.display),
  };
  const finding = buildFindingInstance({
    state: "committed",
    presence: input.presence,
    findingDefinitionId: input.catalogRow.findingDefinitionId,
    patientReference: input.patientReference,
    encounterReference: input.encounterReference,
    laterality: input.laterality,
    value: { type: "presence" },
    performerReferences: [input.staffReference],
    sourceReferences: [],
    sourceType: "manual",
    recordedAt: input.recordedAt,
    provenance: {
      source: "manual",
      recordedAt: input.recordedAt,
      actorReference: input.staffReference,
      note: "Diagnosis findings assertion.",
    },
  });
  return withStringComponent(
    projectFindingInstanceToObservation(finding, definition),
    LATERALITY_SOURCE_COMPONENT,
    "Laterality source",
    input.lateralitySource,
  );
}

async function readEncounterAtomicObservation(
  fhir: DiagnosisFindingsFhirClient,
  reference: string,
  encounterReference: string,
  patientReference: string,
  catalog: readonly AtomicFindingCatalogRow[],
): Promise<Observation | undefined> {
  const observation = await fhir.read<Observation>("Observation", reference.slice("Observation/".length));
  if (
    observation.encounter?.reference !== encounterReference ||
    observation.subject?.reference !== patientReference ||
    !catalog.some((row) => observation.code.coding?.some((coding) => coding.code === row.atomicFindingId))
  ) return undefined;
  return observation;
}

async function rehomeEvidence(
  fhir: DiagnosisFindingsFhirClient,
  conditions: readonly Condition[],
  observationReference: string,
  targetConditionReference?: string,
): Promise<void> {
  for (const condition of conditions) {
    if (!condition.id) continue;
    const reference = conditionReference(condition);
    const current = condition.evidence ?? [];
    const withoutObservation = current.flatMap((evidence) => {
      const detail = (evidence.detail ?? []).filter((candidate) =>
        candidate.reference !== observationReference
      );
      return detail.length || evidence.code?.length ? [{ ...evidence, ...(detail.length ? { detail } : { detail: undefined }) }] : [];
    });
    const nextEvidence = reference === targetConditionReference
      ? [...withoutObservation, { detail: [{ reference: observationReference }] }]
      : withoutObservation;
    if (JSON.stringify(nextEvidence) === JSON.stringify(current)) continue;
    await fhir.update<Condition>("Condition", condition.id, {
      ...condition,
      ...(nextEvidence.length ? { evidence: nextEvidence } : { evidence: undefined }),
    }, WRITE_HEADERS);
  }
}

function withStringComponent(
  observation: Observation,
  code: string,
  display: string,
  value: string | null,
): Observation {
  const components = (observation.component ?? []).filter((component) =>
    !component.code.coding?.some((coding) => coding.code === code)
  );
  return {
    ...observation,
    ...(value === null
      ? { component: components.length ? components : undefined }
      : {
          component: [
            ...components,
            { code: odosConcept(code, display), valueString: value },
          ],
        }),
  };
}

function componentString(observation: Observation, code: string): string | undefined {
  return observation.component?.find((component) => component.code.coding?.some((coding) => coding.code === code))
    ?.valueString;
}

function inheritedObservationLaterality(
  observation: Observation,
  conditions: readonly Condition[],
  encounterId: string,
): FindingLaterality | undefined {
  const reference = observationReference(observation);
  const bound = conditions.filter((condition) => condition.evidence?.some((evidence) =>
    evidence.detail?.some((detail) => detail.reference === reference)
  ));
  return bound.length === 1 ? conditionLaterality(bound[0]!, encounterId) : undefined;
}

async function persistMutationProvenance(
  fhir: DiagnosisFindingsFhirClient,
  targetReferences: string[],
  patientReference: string,
  staffReference: string,
  recordedAt: string,
  activityCode: "CREATE" | "UPDATE",
): Promise<void> {
  const provenance: Provenance = buildProvenance({
    targetReferences: [
      ...targetReferences,
      ...patientScopedProvenanceTargets(targetReferences[0]!, patientReference)
        .flatMap((reference) => reference.reference ? [reference.reference] : []),
    ].filter((reference, index, all) => all.indexOf(reference) === index),
    recorded: recordedAt,
    activityCode,
    activityDisplay: activityCode === "CREATE" ? "Create" : "Update",
    agents: [{ whoReference: staffReference, typeCode: "author" }],
  });
  await fhir.create(provenance, WRITE_HEADERS);
}

async function persistFindingReassertionProvenance(
  fhir: DiagnosisFindingsFhirClient,
  targetReference: string,
  patientReference: string,
  staffReference: string,
  recordedAt: string,
): Promise<void> {
  const provenance: Provenance = buildProvenance({
    targetReferences: [targetReference],
    patientReference,
    recorded: recordedAt,
    activityCode: "UPDATE",
    activityDisplay: "Diagnosis finding reassertion",
    agents: [{ whoReference: staffReference, typeCode: "author" }],
  });
  provenance.activity = {
    coding: [{
      system: ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM,
      code: DIAGNOSIS_FINDING_REASSERTION_CODE,
      display: "Diagnosis finding reasserted",
    }],
    text: "Diagnosis finding reassertion",
  };
  await fhir.create(provenance, WRITE_HEADERS);
}

function isCarriedFindingReassertion(
  carryState: DiagnosisCarryState,
  existingReference: string | undefined,
  atomicFindingId: string,
  laterality: Exclude<FindingLaterality, "UNKNOWN">,
): boolean {
  if (existingReference && carryState.observationReasserted[existingReference]) return false;
  if (existingReference && carryState.observationCarried[existingReference]) return true;
  return carryState.sourceAbsentSnapshots.some((snapshot) =>
    snapshot.atomicFindingId === atomicFindingId && snapshot.laterality === laterality
  );
}

interface VisitDiagnosis {
  condition: Condition;
  conditionReference: string;
  diagnosisKey: string;
  display: string;
  laterality: FindingLaterality;
}
