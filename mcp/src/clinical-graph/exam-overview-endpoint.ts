import type {
  Bundle,
  Condition,
  Encounter,
  MedicationAdministration,
  Observation,
  Practitioner,
  Provenance,
  Reference,
  Resource,
} from "@medplum/fhirtypes";
import { ODOS_CLINICAL_ATTESTATION_POLICY_URL } from "../../../policy/attestation-policy-urls.js";
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
      patientReference,
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
    console.error("odos-mcp: exam overview dependency failed:", error);
    return { status: 502, body: { error: "FHIR exam overview dependency failed." } };
  }
}

async function findingClinicalContextProjection(
  fhir: ExamOverviewFhirClient,
  patientReference: string,
  conditions: readonly Condition[],
  observations: readonly Observation[],
) {
  const observationReferences = new Set(observations.flatMap((observation) =>
    observation.id ? [`Observation/${observation.id}`] : []
  ));
  const attestationProofs = await optionalAttestationProofs(
    fhir,
    patientReference,
    observationReferences,
  );
  const signerNames = await practitionerNamesByReference(
    fhir,
    attestationProofs.flatMap((provenance) =>
      provenance.signature?.map((signature) => signature.who) ?? []
    ),
  );
  const rows = await Promise.all(observations.flatMap((observation) => {
    const observationReference = observation.id ? `Observation/${observation.id}` : undefined;
    if (!observationReference) return [];
    return [findingClinicalContext(
      fhir,
      observationReference,
      observation,
      conditions,
      attestationProofs,
      signerNames,
    )];
  }));
  return Object.fromEntries(rows.flatMap((row) => row.context ? [[row.reference, row.context]] : []));
}

async function optionalAttestationProofs(
  fhir: ExamOverviewFhirClient,
  patientReference: string,
  observationReferences: ReadonlySet<string>,
): Promise<Provenance[]> {
  try {
    return (await searchAll<Provenance>(fhir, "Provenance", {
      patient: patientReference,
      _count: "100",
      _sort: "-recorded",
    })).filter((provenance) =>
      provenance.policy?.includes(ODOS_CLINICAL_ATTESTATION_POLICY_URL) === true &&
      provenance.target.some((target) => target.reference === patientReference) &&
      provenance.target.some((target) => observationReferences.has(target.reference ?? "")) &&
      provenance.signature?.some((signature) => Boolean(signature.data)) === true
    );
  } catch {
    return [];
  }
}

async function findingClinicalContext(
  fhir: ExamOverviewFhirClient,
  observationReference: string,
  observation: Observation,
  conditions: readonly Condition[],
  attestationProofs: readonly Provenance[],
  signerNames: ReadonlyMap<string, string>,
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
  const attestation = attestationForObservation(
    observationReference,
    attestationProofs,
    signerNames,
  );
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
  const administrations = (await Promise.all(references.map(async (id) => {
    try {
      return await fhir.read<MedicationAdministration>("MedicationAdministration", id);
    } catch {
      return undefined;
    }
  }))).filter((administration): administration is MedicationAdministration => administration !== undefined);
  const displayRows = administrations.flatMap((administration) => {
    if (
      administration.status !== "completed" ||
      administration.subject.reference !== observation.subject?.reference ||
      administration.context?.reference !== observation.encounter?.reference
    ) return [];
    const agent = administration.medicationCodeableConcept?.coding?.find((coding) => coding.display?.trim())?.display?.trim() ??
      administration.medicationCodeableConcept?.text?.trim();
    const occurredAt = administration.effectiveDateTime;
    return agent && occurredAt ? [{ agent, occurredAt }] : [];
  });
  return displayRows.length ? { administrations: displayRows } : undefined;
}

function attestationForObservation(
  observationReference: string,
  provenances: readonly Provenance[],
  signerNames: ReadonlyMap<string, string>,
) {
  const proof = provenances.filter((provenance) =>
    provenance.target.some((target) => target.reference === observationReference)
  ).sort((left, right) => Date.parse(right.recorded) - Date.parse(left.recorded))[0];
  if (!proof) return undefined;
  const attestedBy = [...new Set((proof.signature ?? []).flatMap((signature) => {
    const display = signature.who.display?.trim() ??
      (signature.who.reference ? signerNames.get(signature.who.reference) : undefined);
    return display ? [display] : [];
  }))];
  return attestedBy.length > 0
    ? { attestedBy, recordedAt: proof.recorded }
    : undefined;
}

async function practitionerNamesByReference(
  fhir: ExamOverviewFhirClient,
  signers: readonly Reference[],
): Promise<Map<string, string>> {
  const references = [...new Set(signers.flatMap((signer) =>
    signer.display?.trim() || !signer.reference?.match(/^Practitioner\/[A-Za-z0-9.-]+$/)
      ? []
      : [signer.reference]
  ))];
  const practitioners = await Promise.all(references.map(async (reference) => {
    const id = reference.slice("Practitioner/".length);
    let practitioner: Practitioner;
    try {
      practitioner = await fhir.read<Practitioner>("Practitioner", id);
    } catch {
      return undefined;
    }
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
