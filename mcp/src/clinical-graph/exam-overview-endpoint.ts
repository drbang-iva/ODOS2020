import type {
  Bundle,
  Condition,
  Encounter,
  MedicationAdministration,
  Observation,
  Practitioner,
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
import { COVER_TEST_KEY, DILATION_KEY } from "./entrance-definition.js";

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
    const clinicalContextByObservation = await findingClinicalContextProjection(
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
        priorObservationCandidates: patientObservations.filter((observation) =>
          observation.encounter?.reference !== encounterReference
        ),
        assessmentPresent: encounterConditions.some(isAssessmentEvidence),
        provenanceByObservation,
        clinicalContextByObservation,
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

async function findingClinicalContextProjection(
  fhir: ExamOverviewFhirClient,
  conditions: readonly Condition[],
  observations: readonly Observation[],
) {
  const performerNames = await practitionerNamesByReference(fhir, observations);
  const rows = await Promise.all(observations.flatMap((observation) => {
    const observationReference = observation.id ? `Observation/${observation.id}` : undefined;
    if (!observationReference) return [];
    return [findingClinicalContext(
      fhir,
      observationReference,
      observation,
      conditions,
      performerNames,
    )];
  }));
  return Object.fromEntries(rows.flatMap((row) => row.context ? [[row.reference, row.context]] : []));
}

async function findingClinicalContext(
  fhir: ExamOverviewFhirClient,
  observationReference: string,
  observation: Observation,
  conditions: readonly Condition[],
  performerNames: ReadonlyMap<string, string>,
) {
  const findingCode = observation.code.coding?.find((coding) => coding.code)?.code;
  const summary = findingCode === COVER_TEST_KEY ? observation.note?.find((note) => note.text?.trim())?.text?.trim() : undefined;
  const event = findingCode === DILATION_KEY ? await dilationEvent(fhir, observation) : undefined;
  const diagnoses = conditions.flatMap((condition) => {
    if (!conditionObservationReferences(condition).has(observationReference)) return [];
    const display = condition.code?.text?.trim() ?? condition.code?.coding?.find((coding) => coding.display?.trim())?.display?.trim();
    if (!display) return [];
    const laterality = conditionLaterality(condition);
    return [{ display, ...(laterality ? { laterality } : {}) }];
  });
  const attestedBy = [...new Set((observation.performer ?? []).flatMap((performer) => {
    const display = performer.display?.trim() ?? (performer.reference ? performerNames.get(performer.reference) : undefined);
    return display ? [display] : [];
  }))];
  const recordedAt = observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated;
  const attestation = attestedBy.length > 0
    ? { attestedBy, ...(recordedAt ? { recordedAt } : {}) }
    : undefined;
  const context = {
    ...(summary ? { summary } : {}),
    ...(event ? { event } : {}),
    ...(diagnoses.length ? { diagnoses } : {}),
    ...(attestation ? { attestation } : {}),
  };
  return {
    reference: observationReference,
    context: Object.keys(context).length > 0 ? context : undefined,
  };
}

async function dilationEvent(
  fhir: ExamOverviewFhirClient,
  observation: Observation,
) {
  const references = (observation.partOf ?? []).flatMap((reference) => {
    const match = reference.reference?.match(/^MedicationAdministration\/([A-Za-z0-9.-]+)$/);
    return match?.[1] ? [match[1]] : [];
  });
  const administrations = await Promise.all(references.map((id) =>
    fhir.read<MedicationAdministration>("MedicationAdministration", id)
  ));
  const displayRows = administrations.flatMap((administration) => {
    if (
      administration.subject.reference !== observation.subject?.reference ||
      administration.context?.reference !== observation.encounter?.reference
    ) return [];
    const agent = administration.medicationCodeableConcept?.coding?.find((coding) => coding.display?.trim())?.display?.trim();
    const occurredAt = administration.effectiveDateTime;
    return agent && occurredAt ? [{ agent, occurredAt }] : [];
  });
  return displayRows.length ? { administrations: displayRows } : undefined;
}

async function practitionerNamesByReference(
  fhir: ExamOverviewFhirClient,
  observations: readonly Observation[],
): Promise<Map<string, string>> {
  const references = [...new Set(observations.flatMap((observation) =>
    (observation.performer ?? []).flatMap((performer) =>
      performer.display?.trim() || !performer.reference?.match(/^Practitioner\/[A-Za-z0-9.-]+$/)
        ? []
        : [performer.reference]
    )
  ))];
  const practitioners = await Promise.all(references.map(async (reference) => {
    const id = reference.slice("Practitioner/".length);
    const practitioner = await fhir.read<Practitioner>("Practitioner", id);
    const display = practitionerDisplay(practitioner);
    return display ? [reference, display] as const : undefined;
  }));
  return new Map(practitioners.flatMap((row) => row ? [row] : []));
}

function practitionerDisplay(practitioner: Practitioner): string | undefined {
  const name = practitioner.name?.[0];
  if (!name) return undefined;
  const display = [
    ...(name.prefix ?? []),
    ...(name.given ?? []),
    name.family,
    ...(name.suffix ?? []),
  ].filter((part): part is string => Boolean(part?.trim())).join(" ").trim();
  return display || name.text?.trim() || undefined;
}

function conditionLaterality(condition: Condition): "OD" | "OS" | "OU" | undefined {
  const code = condition.bodySite?.flatMap((site) => site.coding ?? []).find((coding) => coding.code)?.code;
  if (code === "OD" || code === "right") return "OD";
  if (code === "OS" || code === "left") return "OS";
  if (code === "OU" || code === "bilateral") return "OU";
  return undefined;
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
