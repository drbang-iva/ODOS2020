import type { Bundle, Condition, Encounter, Observation, Provenance, Resource } from "@medplum/fhirtypes";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { V3_DATA_OPERATION_CODE_SYSTEM } from "../fhir/ophthalmology/provenance.js";

export const ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/provenance-activity";
export const DIAGNOSIS_FINDING_REASSERTION_CODE = "diagnosis-finding-reasserted";

export interface DiagnosisCarryProvenanceFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
}

export interface SourceAbsentFindingSnapshot {
  observationReference: string;
  atomicFindingId: string;
  presence: "absent";
  grade?: string;
  laterality: "OD" | "OS" | "OU" | "UNKNOWN";
}

export interface DiagnosisCarryState {
  pulledFromDate?: string;
  unchangedSinceDate?: string;
  edited: boolean;
  integrityWarning?: string;
  sourceAbsentSnapshots: SourceAbsentFindingSnapshot[];
  observationCarried: Record<string, boolean>;
  observationReasserted: Record<string, boolean>;
}

export async function readDiagnosisCarryState(
  fhir: DiagnosisCarryProvenanceFhirClient,
  condition: Condition,
  observations: readonly Observation[],
): Promise<DiagnosisCarryState> {
  try {
    return await readDiagnosisCarryStateFromAvailableLineage(fhir, condition, observations);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 404 || status === 410) {
      return integrityFailure("Diagnosis carry lineage resource is missing or gone.");
    }
    throw error;
  }
}

async function readDiagnosisCarryStateFromAvailableLineage(
  fhir: DiagnosisCarryProvenanceFhirClient,
  condition: Condition,
  observations: readonly Observation[],
): Promise<DiagnosisCarryState> {
  const empty = emptyState();
  const currentReference = resourceReference(condition);
  if (!currentReference) return empty;

  const provenanceCache = new Map<string, Promise<Provenance[]>>();
  const currentCarry = await carryForTarget(fhir, currentReference, provenanceCache);
  if (currentCarry.kind === "none") return empty;
  if (currentCarry.kind === "invalid") return integrityFailure(currentCarry.warning);

  const sourceReference = directSourceConditionReference(currentCarry.provenance);
  if (!sourceReference) {
    return integrityFailure("Diagnosis carry provenance source Condition is missing or ambiguous.");
  }
  const sourceCondition = await readReference<Condition>(fhir, sourceReference, "Condition");
  const pulledFromDate = await conditionEncounterDate(fhir, sourceCondition);
  if (!pulledFromDate) {
    return integrityFailure("Diagnosis carry provenance source encounter date is missing.");
  }

  const sourceAbsentSnapshots = await absentSourceSnapshots(fhir, currentCarry.provenance);
  const observationCarried: Record<string, boolean> = {};
  const observationReasserted: Record<string, boolean> = {};
  let integrityWarning: string | undefined;
  let edited = false;

  const conditionTarget = await targetState(
    fhir,
    currentReference,
    currentCarry.provenance,
    currentCarry.recorded,
    provenanceCache,
  );
  edited ||= conditionTarget.edited;
  integrityWarning = conditionTarget.warning;

  const activeObservationReferences = new Set(observations.flatMap((observation) => {
    const reference = resourceReference(observation);
    return reference ? [reference] : [];
  }));
  const carriedObservationReferences = new Set<string>();
  for (const target of currentCarry.provenance.target) {
    const reference = target.reference;
    if (!reference?.match(observationReferencePattern)) continue;
    carriedObservationReferences.add(reference);
    const state = await targetState(
      fhir,
      reference,
      currentCarry.provenance,
      currentCarry.recorded,
      provenanceCache,
    );
    if (activeObservationReferences.has(reference)) observationCarried[reference] = !state.edited;
    edited ||= state.edited;
    integrityWarning ??= state.warning;
  }
  for (const observation of observations) {
    const reference = resourceReference(observation);
    if (
      !reference ||
      (!carriedObservationReferences.has(reference) &&
        !matchesSourceAbsentSnapshot(observation, sourceAbsentSnapshots))
    ) continue;
    const provenances = await provenancesForTarget(fhir, reference, provenanceCache);
    if (provenances.some((provenance) => {
      const reassertedAt = recordedInstant(provenance.recorded);
      return isFindingReassertionProvenance(provenance) &&
        reassertedAt !== undefined &&
        reassertedAt > currentCarry.recorded;
    })) {
      observationReasserted[reference] = true;
    }
  }

  if (edited) {
    return {
      pulledFromDate,
      edited: true,
      ...(integrityWarning ? { integrityWarning } : {}),
      sourceAbsentSnapshots,
      observationCarried,
      observationReasserted,
    };
  }

  let unchangedSinceDate = pulledFromDate;
  let ancestor = sourceCondition;
  let descendantCarryRecorded = currentCarry.recorded;
  const visited = new Set([currentReference]);
  while (true) {
    const ancestorReference = resourceReference(ancestor);
    if (!ancestorReference || visited.has(ancestorReference)) {
      return {
        pulledFromDate,
        edited: true,
        integrityWarning: "Diagnosis carry provenance cycle detected.",
        sourceAbsentSnapshots,
        observationCarried,
        observationReasserted,
      };
    }
    visited.add(ancestorReference);

    const ancestorCarry = await carryForTarget(fhir, ancestorReference, provenanceCache);
    if (ancestorCarry.kind === "none") break;
    if (ancestorCarry.kind === "invalid") {
      return {
        pulledFromDate,
        edited: true,
        integrityWarning: ancestorCarry.warning,
        sourceAbsentSnapshots,
        observationCarried,
        observationReasserted,
      };
    }
    if (ancestorCarry.recorded >= descendantCarryRecorded) {
      return {
        pulledFromDate,
        edited: true,
        integrityWarning: "Diagnosis carry provenance lineage chronology is invalid.",
        sourceAbsentSnapshots,
        observationCarried,
        observationReasserted,
      };
    }
    const ancestorTarget = await targetState(
      fhir,
      ancestorReference,
      ancestorCarry.provenance,
      ancestorCarry.recorded,
      provenanceCache,
    );
    if (ancestorTarget.warning) {
      return {
        pulledFromDate,
        edited: true,
        integrityWarning: ancestorTarget.warning,
        sourceAbsentSnapshots,
        observationCarried,
        observationReasserted,
      };
    }
    if (ancestorTarget.edited) break;
    let ancestorFindingEdited = false;
    for (const target of ancestorCarry.provenance.target) {
      const targetReference = target.reference;
      if (!targetReference?.match(observationReferencePattern)) continue;
      const targetFinding = await targetState(
        fhir,
        targetReference,
        ancestorCarry.provenance,
        ancestorCarry.recorded,
        provenanceCache,
      );
      if (targetFinding.warning) {
        return {
          pulledFromDate,
          edited: true,
          integrityWarning: targetFinding.warning,
          sourceAbsentSnapshots,
          observationCarried,
          observationReasserted,
        };
      }
      ancestorFindingEdited ||= targetFinding.edited;
    }
    if (ancestorFindingEdited) break;

    const nextReference = directSourceConditionReference(ancestorCarry.provenance);
    if (!nextReference) {
      return {
        pulledFromDate,
        edited: true,
        integrityWarning: "Diagnosis carry provenance source Condition is missing or ambiguous.",
        sourceAbsentSnapshots,
        observationCarried,
        observationReasserted,
      };
    }
    if (visited.has(nextReference)) {
      return {
        pulledFromDate,
        edited: true,
        integrityWarning: "Diagnosis carry provenance cycle detected.",
        sourceAbsentSnapshots,
        observationCarried,
        observationReasserted,
      };
    }
    ancestor = await readReference<Condition>(fhir, nextReference, "Condition");
    const nextDate = await conditionEncounterDate(fhir, ancestor);
    if (!nextDate) {
      return {
        pulledFromDate,
        edited: true,
        integrityWarning: "Diagnosis carry provenance source encounter date is missing.",
        sourceAbsentSnapshots,
        observationCarried,
        observationReasserted,
      };
    }
    unchangedSinceDate = nextDate;
    descendantCarryRecorded = ancestorCarry.recorded;
  }

  return {
    pulledFromDate,
    unchangedSinceDate,
    edited: false,
    sourceAbsentSnapshots,
    observationCarried,
    observationReasserted,
  };
}

function matchesSourceAbsentSnapshot(
  observation: Observation,
  snapshots: readonly SourceAbsentFindingSnapshot[],
): boolean {
  const atomicFindingId = observation.code.coding?.find((coding) =>
    coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code
  )?.code;
  if (!atomicFindingId) return false;
  const laterality = observationLaterality(observation);
  return snapshots.some((snapshot) =>
    snapshot.atomicFindingId === atomicFindingId && snapshot.laterality === laterality
  );
}

const conditionReferencePattern = /^Condition\/([^/]+)$/;
const encounterReferencePattern = /^Encounter\/([^/]+)$/;
const observationReferencePattern = /^Observation\/([^/]+)$/;
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

type CarryLookup =
  | { kind: "none" }
  | { kind: "invalid"; warning: string }
  | { kind: "carry"; provenance: Provenance; recorded: number };

async function carryForTarget(
  fhir: DiagnosisCarryProvenanceFhirClient,
  targetReference: string,
  cache: Map<string, Promise<Provenance[]>>,
): Promise<CarryLookup> {
  const candidates = (await provenancesForTarget(fhir, targetReference, cache)).filter(isCarryProvenance);
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length !== 1) {
    return {
      kind: "invalid",
      warning: "Diagnosis carry provenance has an invalid or ambiguous recorded timestamp.",
    };
  }
  const recorded = recordedInstant(candidates[0]!.recorded);
  if (recorded === undefined) {
    return {
      kind: "invalid",
      warning: "Diagnosis carry provenance has an invalid or ambiguous recorded timestamp.",
    };
  }
  return { kind: "carry", provenance: candidates[0]!, recorded };
}

async function targetState(
  fhir: DiagnosisCarryProvenanceFhirClient,
  targetReference: string,
  carry: Provenance,
  carryRecorded: number,
  cache: Map<string, Promise<Provenance[]>>,
): Promise<{ edited: boolean; warning?: string }> {
  const candidates = await provenancesForTarget(fhir, targetReference, cache);
  let edited = false;
  for (const candidate of candidates) {
    if (sameProvenance(candidate, carry)) continue;
    const recorded = recordedInstant(candidate.recorded);
    if (recorded === undefined || recorded === carryRecorded) {
      return {
        edited: true,
        warning: "Diagnosis carry provenance has an invalid or ambiguous recorded timestamp.",
      };
    }
    if (recorded > carryRecorded) edited = true;
  }
  return { edited };
}

function provenancesForTarget(
  fhir: DiagnosisCarryProvenanceFhirClient,
  targetReference: string,
  cache: Map<string, Promise<Provenance[]>>,
): Promise<Provenance[]> {
  const cached = cache.get(targetReference);
  if (cached) return cached;
  const requested = allTargetProvenances(fhir, targetReference);
  cache.set(targetReference, requested);
  return requested;
}

async function allTargetProvenances(
  fhir: DiagnosisCarryProvenanceFhirClient,
  targetReference: string,
): Promise<Provenance[]> {
  let bundle = await fhir.search<Provenance>("Provenance", {
    target: targetReference,
    _count: "500",
  });
  const provenances: Provenance[] = [];
  const followed = new Set<string>();
  while (true) {
    provenances.push(...bundleResources(bundle).filter((provenance) =>
      provenance.target.some((target) => target.reference === targetReference)
    ));
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) return provenances;
    if (!fhir.searchUrl || followed.has(next)) {
      throw new Error("FHIR Provenance pagination is unavailable or cyclic.");
    }
    followed.add(next);
    bundle = await fhir.searchUrl<Provenance>(next, "Provenance");
  }
}

function isCarryProvenance(provenance: Provenance): boolean {
  return provenance.activity?.text === "Diagnosis pull-forward" &&
    provenance.activity.coding?.some((coding) =>
      coding.system === V3_DATA_OPERATION_CODE_SYSTEM && coding.code === "CREATE"
    ) === true;
}

export function isFindingReassertionProvenance(provenance: Provenance): boolean {
  return provenance.activity?.coding?.some((coding) =>
    coding.system === ODOS_PROVENANCE_ACTIVITY_CODE_SYSTEM &&
    coding.code === DIAGNOSIS_FINDING_REASSERTION_CODE
  ) === true;
}

function directSourceConditionReference(provenance: Provenance): string | undefined {
  const references = [...new Set(provenance.entity?.flatMap((entity) => {
    if (entity.role !== "source") return [];
    const reference = entity.what.reference;
    return reference?.match(conditionReferencePattern) ? [reference] : [];
  }) ?? [])];
  return references.length === 1 ? references[0] : undefined;
}

async function absentSourceSnapshots(
  fhir: DiagnosisCarryProvenanceFhirClient,
  provenance: Provenance,
): Promise<SourceAbsentFindingSnapshot[]> {
  const references = [...new Set(provenance.entity?.flatMap((entity) => {
    if (entity.role !== "source") return [];
    const reference = entity.what.reference;
    return reference?.match(observationReferencePattern) ? [reference] : [];
  }) ?? [])];
  const snapshots: SourceAbsentFindingSnapshot[] = [];
  for (const reference of references) {
    const observation = await readReference<Observation>(fhir, reference, "Observation");
    if (
      observation.valueBoolean !== false ||
      observation.status === "entered-in-error" ||
      observation.status === "cancelled"
    ) continue;
    const atomicFindingId = observation.code.coding?.find((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code
    )?.code;
    if (!atomicFindingId) continue;
    const grade = observation.component?.find((component) =>
      component.code.coding?.some((coding) => coding.code === "GRADE")
    );
    const gradeValue = grade?.valueString ?? grade?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
    snapshots.push({
      observationReference: reference,
      atomicFindingId,
      presence: "absent",
      ...(gradeValue ? { grade: gradeValue } : {}),
      laterality: observationLaterality(observation),
    });
  }
  return snapshots;
}

async function conditionEncounterDate(
  fhir: DiagnosisCarryProvenanceFhirClient,
  condition: Condition,
): Promise<string | undefined> {
  const match = condition.encounter?.reference?.match(encounterReferencePattern);
  if (!match) return undefined;
  return (await fhir.read<Encounter>("Encounter", match[1]!)).period?.start;
}

async function readReference<T extends Resource>(
  fhir: DiagnosisCarryProvenanceFhirClient,
  reference: string,
  resourceType: T["resourceType"],
): Promise<T> {
  const pattern = resourceType === "Condition" ? conditionReferencePattern : observationReferencePattern;
  const match = reference.match(pattern);
  if (!match) throw new Error(`Invalid ${resourceType} reference.`);
  return fhir.read<T>(resourceType, match[1]!);
}

function recordedInstant(recorded: string | undefined): number | undefined {
  if (!recorded) return undefined;
  const match = recorded.match(instantPattern);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    year < 1 || day < 1 || day > daysInMonth ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
  ) return undefined;
  const parsed = Date.parse(recorded);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sameProvenance(left: Provenance, right: Provenance): boolean {
  return Boolean(left.id && right.id && left.id === right.id);
}

function resourceReference(resource: Condition | Observation): string | undefined {
  return resource.id ? `${resource.resourceType}/${resource.id}` : undefined;
}

function observationLaterality(observation: Observation): SourceAbsentFindingSnapshot["laterality"] {
  const code = observation.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code ??
    observation.bodySite?.coding?.find((coding) => coding.code)?.code;
  if (code === "OD" || code === "right") return "OD";
  if (code === "OS" || code === "left") return "OS";
  if (code === "OU" || code === "bilateral") return "OU";
  return "UNKNOWN";
}

function bundleResources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function emptyState(): DiagnosisCarryState {
  return {
    edited: false,
    sourceAbsentSnapshots: [],
    observationCarried: {},
    observationReasserted: {},
  };
}

function integrityFailure(integrityWarning: string): DiagnosisCarryState {
  return {
    edited: true,
    integrityWarning,
    sourceAbsentSnapshots: [],
    observationCarried: {},
    observationReasserted: {},
  };
}

function errorStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
}
