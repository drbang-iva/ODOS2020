import type {
  Bundle,
  Condition,
  Encounter,
  Observation,
  Resource,
} from "@medplum/fhirtypes";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { resolveVisitTypeCategoryForEncounter } from "../clinic/clinic-summary.js";
import { searchAll } from "../fhir-search.js";
import {
  readDiagnosisCarryState,
  type DiagnosisCarryState,
} from "./diagnosis-carry-provenance.js";
import {
  buildExamOverviewProjection,
  type ExamFindingProvenanceState,
} from "./exam-overview-projection.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";

export interface ExamOverviewFhirClient {
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
}

export interface ExamOverviewEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: ExamOverviewFhirClient;
  } | null>;
  serviceFhir?: ExamOverviewFhirClient;
  findingDefinitions: () =>
    | readonly ClinicalFindingDefinition[]
    | Promise<readonly ClinicalFindingDefinition[]>;
}

export async function handleExamOverviewRequest(
  deps: ExamOverviewEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) {
    return { status: 401, body: { error: "Authentication required to read the exam overview." } };
  }
  if (!staffMayReadChart(staff.actorRole)) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const encounterId = readEncounterId(input.params);
  if (!encounterId) {
    return { status: 400, body: { error: "A valid encounter id is required." } };
  }
  try {
    const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    const patientReference = encounter.subject?.reference;
    if (!patientReference?.match(/^Patient\/[^/]+$/)) {
      return { status: 400, body: { error: "Exam overview requires an encounter patient." } };
    }
    const encounterReference = `Encounter/${encounterId}`;
    const serviceFhir = deps.serviceFhir ?? staff.fhir;
    const [definitions, currentObservations, patientObservations, conditions, visitTypeCategoryId] =
      await Promise.all([
        deps.findingDefinitions(),
        searchAll<Observation>(staff.fhir, "Observation", { encounter: encounterReference }),
        searchAll<Observation>(staff.fhir, "Observation", { subject: patientReference }),
        searchAll<Condition>(staff.fhir, "Condition", { encounter: encounterReference }),
        resolveVisitTypeCategoryForEncounter(encounter, undefined, serviceFhir),
      ]);
    const current = currentObservations.filter((observation) =>
      observation.subject?.reference === patientReference
    );
    const encounterConditions = conditions.filter((condition) =>
      condition.subject.reference === patientReference
    );
    const provenanceByObservation = await findingProvenanceProjection(
      staff.fhir,
      encounterConditions,
      current,
    );
    return {
      status: 200,
      body: buildExamOverviewProjection({
        encounterReference,
        patientReference,
        ...(visitTypeCategoryId ? { visitTypeCategoryId } : {}),
        definitions,
        currentObservations: current,
        priorObservations: patientObservations.filter((observation) =>
          observation.encounter?.reference !== encounterReference
        ),
        assessmentPresent: encounterConditions.some(isAssessmentEvidence),
        provenanceByObservation,
      }),
    };
  } catch (error) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      return { status: 403, body: { error: "Exam overview is outside the caller's patient compartment." } };
    }
    if (status === 404 || status === 410) {
      return { status: 404, body: { error: "Exam overview resources were not found." } };
    }
    return { status: 502, body: { error: "FHIR exam overview dependency failed." } };
  }
}

async function findingProvenanceProjection(
  fhir: ExamOverviewFhirClient,
  conditions: readonly Condition[],
  observations: readonly Observation[],
): Promise<Record<string, { state: ExamFindingProvenanceState; sourceDate?: string }>> {
  const states = await Promise.all(conditions.map(async (condition) => {
    const references = conditionObservationReferences(condition);
    const boundObservations = observations.filter((observation) =>
      observation.id && references.has(`Observation/${observation.id}`)
    );
    return readDiagnosisCarryState(fhir, condition, boundObservations);
  }));
  return states.reduce<Record<string, { state: ExamFindingProvenanceState; sourceDate?: string }>>(
    (projection, state) => mergeCarryState(projection, state),
    {},
  );
}

function mergeCarryState(
  projection: Record<string, { state: ExamFindingProvenanceState; sourceDate?: string }>,
  carryState: DiagnosisCarryState,
): Record<string, { state: ExamFindingProvenanceState; sourceDate?: string }> {
  for (const [reference, reasserted] of Object.entries(carryState.observationReasserted)) {
    if (!reasserted) continue;
    projection[reference] = {
      state: "carried-reasserted",
      ...(carryState.pulledFromDate ? { sourceDate: carryState.pulledFromDate } : {}),
    };
  }
  for (const [reference, carried] of Object.entries(carryState.observationCarried)) {
    if (!carried || projection[reference]?.state === "carried-reasserted") continue;
    projection[reference] = {
      state: "carried-unreasserted",
      ...(carryState.pulledFromDate ? { sourceDate: carryState.pulledFromDate } : {}),
    };
  }
  return projection;
}

function conditionObservationReferences(condition: Condition): Set<string> {
  return new Set(condition.evidence?.flatMap((evidence) => evidence.detail ?? [])
    .flatMap((detail) => detail.reference?.startsWith("Observation/") ? [detail.reference] : []) ?? []);
}

function isAssessmentEvidence(condition: Condition): boolean {
  return condition.verificationStatus?.coding?.some((coding) =>
    coding.code === "refuted" || coding.code === "entered-in-error"
  ) !== true;
}

function readEncounterId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const encounterId = (value as Record<string, unknown>).encounterId;
  return typeof encounterId === "string" && /^[A-Za-z0-9.-]+$/.test(encounterId)
    ? encounterId
    : undefined;
}

function staffMayReadChart(role: PracticeRoleId): boolean {
  try {
    assertBusinessActionAllowed(role, "chart.read");
    return true;
  } catch {
    return false;
  }
}

function errorStatus(error: unknown): unknown {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
}
