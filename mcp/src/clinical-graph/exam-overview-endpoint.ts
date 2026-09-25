import { HISTORY_TEMPLATES, historyTemplateComplete } from "./history-template-engine.js";
import { isHistoryAnswerObservation, parseHistoryAnswerObservation } from "./history-answer-observation.js";
import { z } from "zod";
import { findingDefinitionForObservation } from "./finding-observation-match.js";
import { isDeepStrictEqual } from "node:util";
import { loadEncounterFindingState, projectCurrentFindings, type CurrentFindingProjection } from "./current-finding-reader.js";
import { materializeAtomicFindingCatalog } from "./diagnosis-findings-endpoint.js";
import { carryPlansForCondition, carryFindingsWitness, isFindingReassertionProvenance } from "./diagnosis-carry-provenance.js";
import { currentFindingIdentifier, parseCurrentFindingEnvelope, parseFindingPanelEnvelope, FINDING_OPERATION_AUDIT_SYSTEM } from "./current-finding-identity.js";
import { projectHistorySubjectSections } from "./history-subject-projection.js";
import type {
  Basic,
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
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { FhirFollowUpProfileStore, type FollowUpProfileRecord } from "./follow-up-profile-store.js";
import { FhirDiagnosisCatalogStore } from "./diagnosis-catalog-store.js";
import { parseDiagnosisIdentifier } from "./diagnosis-identifier.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "./diagnosis-pick-endpoint.js";
import { FhirEncounterExamScopeStore, type ProposedExamTest } from "./exam-scope-store.js";
import { searchAll } from "../fhir-search.js";
import { encounterDiagnosisProblemStatus } from "../fhir/condition.js";
import {
  readDiagnosisCarryState,
  type DiagnosisCarryState,
} from "./diagnosis-carry-provenance.js";
import { FhirComplaintDefinitionStore } from "./complaint-definition-store.js";
import type { ComplaintDefinition, EncounterComplaint } from "./complaint-model.js";
import { FhirEncounterComplaintStore } from "./encounter-complaint-store.js";
import {
  buildExamOverviewProjection,
  type ExamOverviewFindingProjection,
  type ExamFindingProvenanceState,
} from "./exam-overview-projection.js";
import type { ClinicalFindingDefinition } from "./glaucoma-suspect.js";
import { COVER_TEST_KEY, DILATION_KEY } from "./entrance-definition.js";

export interface ExamOverviewFhirClient {
  readonly baseUrl: string;
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Resource>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Resource>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
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
  if (!staffHasBusinessAction(staff, "chart.read")) {
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
    const [definitions, currentObservations, patientObservations, conditions, complaintDefinitions, complaints] =
      await Promise.all([
        deps.findingDefinitions(),
        searchAll<Observation>(staff.fhir, "Observation", { encounter: encounterReference }),
        searchAll<Observation>(staff.fhir, "Observation", { subject: patientReference }),
        searchAll<Condition>(staff.fhir, "Condition", { encounter: encounterReference }),
        new FhirComplaintDefinitionStore(staff.fhir).list(),
        new FhirEncounterComplaintStore(staff.fhir).listByEncounter(encounterId),
      ]);
    const current = currentObservations.filter((observation) =>
      observation.subject?.reference === patientReference
    );
    const encounterConditions = conditions.filter((condition) =>
      condition.subject.reference === patientReference
    );
    const scopeStore = new FhirEncounterExamScopeStore(serviceFhir);
    let scope = await scopeStore.get(encounterId);
    if (!scope.versionId) {
      try {
        scope = await scopeStore.shapeIfAbsent(encounterId, { reference: staff.staffReference },
          async () => {
            const profiles = await resolveFollowUpProfiles(serviceFhir, encounterConditions, encounterId);
            return { profiles, testsProposed: resolveProfileTests(profiles) };
          });
      } catch (error) {
        // Opening the board must not depend on bookkeeping persistence.
        const status = errorStatus(error);
        if (status === 409 || status === 412) {
          try { scope = await scopeStore.get(encounterId); } catch { /* Keep this request unshaped if confirmation is unavailable. */ }
        }
      }
    }
    const sharedEvidence = await loadOverviewFindingEvidence(staff.fhir, patientReference, encounterReference, definitions);
    const homes = new Map(sharedEvidence.projection.currentFacts.flatMap(f=>f.contributors.map(c=>[c.reference,f.homes] as const)));
    const linkedConditions = encounterConditions.map(condition=>({...condition,evidence:[...(condition.evidence ?? []),{detail:[...homes].filter(([,refs])=>refs.includes(`Condition/${condition.id}`)).map(([reference])=>({reference}))}]}));
    const provenanceByObservation = await findingProvenanceProjection(
      staff.fhir,
      linkedConditions,
      current,
      definitions,
      sharedEvidence.projection.preRebuild,
    );
    const clinicalContextByObservation = await findingClinicalContextProjection(
      staff.fhir,
      patientReference,
      linkedConditions,
      current,
    );
    const historyAnswers = currentObservations.flatMap((observation) => {
      if (observation.status === "entered-in-error" || observation.status === "cancelled" ||
        observation.encounter?.reference !== encounterReference || observation.subject?.reference !== patientReference ||
        !isHistoryAnswerObservation(observation)) return [];
      return [parseHistoryAnswerObservation(observation)];
    });
    const historyComplaintRows = complaints.flatMap((complaint) => {
      if (complaint.status !== "active") return [];
      const template = HISTORY_TEMPLATES.find((candidate) => candidate.complaint === complaint.templateKey);
      if (!template) return [];
      const answers = historyAnswers.filter((answer) => answer.complaintId === complaint.id);
      return [{ complaintId: complaint.id, charted: historyTemplateComplete(template, answers), hasLiveAnswers: answers.length > 0 }];
    });
    const projection = buildExamOverviewProjection({
      encounterReference,
      patientReference,
      examScope: scope.examScope,
      ...(scope.sectionsOpen ? { sectionsOpen: scope.sectionsOpen } : {}),
      definitions,
      currentObservations: current,
      historyComplaintRows,
      sharedProjection: sharedEvidence.projection,
      carriedWithoutCurrentEvidence: sharedEvidence.carriedWithoutCurrentEvidence,
      priorObservationCandidates: patientObservations.filter((observation) =>
        observation.encounter?.reference !== encounterReference
      ),
      assessmentRows: assessmentEvidenceRows(encounter, encounterConditions),
      provenanceByObservation,
      clinicalContextByObservation,
    });
    const complaintSummary = historyComplaintSummary(
      complaints.filter((complaint) => complaint.status === "active")
        .sort((left, right) => left.ordinal - right.ordinal),
      complaintDefinitions,
    );
    const historyAttested = projection.findings.some((finding) =>
      finding.findingKey === "hpi_ros" && hasStructuredRosAttestation(finding)
    );
    const itemizedRos = projectHistorySubjectSections(current, patientReference, encounterReference, encounter.period?.start)
      .find(section => section.sectionKey === "review-of-systems" && section.state === "charted");
    // Complaint-directed ROS remains on the HPI aggregate; full-body itemized ROS has its own authority.
    const rosClause = itemizedRos ? itemizedRos.summary : historyAttested ? "ROS reviewed" : undefined;
    const historySummary = [complaintSummary, rosClause].filter(Boolean).join(" · ") || undefined;
    return {
      status: 200,
      body: {
        ...projection,
        ...(historySummary ? { historySummary } : {}),
        findings: projection.findings.map((finding) =>
          finding.findingKey === "hpi_ros" && historySummary
            ? {
                ...finding,
                summary: historySummary,
              }
            : finding
        ),
      },
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

export async function practitionerNamesByReference(
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
  definitions: readonly ClinicalFindingDefinition[],
  preRebuild: boolean,
): Promise<Record<string, { state: ExamFindingProvenanceState; sourceDate?: string }>> {
  const states = await Promise.all(conditions.map(async (condition) => {
    const references = conditionObservationReferences(condition);
    const boundObservations = observations.filter((observation) =>
      observation.id && references.has(`Observation/${observation.id}`)
    );
    const unrelatedOnly = boundObservations.length > 0 && boundObservations.every(observation=>
      parseCurrentFindingEnvelope(observation).status !== "valid" && parseFindingPanelEnvelope(observation).status !== "valid" &&
      findingDefinitionForObservation(observation,definitions)?.valueSchema.type !== "ocular-health-structure");
    return readDiagnosisCarryState(fhir, condition, boundObservations, {preRebuild: unrelatedOnly || preRebuild});
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

function assessmentEvidenceRows(
  encounter: Encounter,
  conditions: readonly Condition[],
): Array<{ problemStatusRecorded: boolean }> {
  const eligibleReferences = new Set(conditions.flatMap((condition) =>
    condition.id && isAssessmentEvidence(condition) ? [`Condition/${condition.id}`] : []
  ));
  return (encounter.diagnosis ?? []).flatMap((diagnosis) =>
    diagnosis.condition.reference && eligibleReferences.has(diagnosis.condition.reference)
      ? [{ problemStatusRecorded: encounterDiagnosisProblemStatus(diagnosis) !== undefined }]
      : []
  );
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

function historyComplaintSummary(
  complaints: readonly EncounterComplaint[],
  definitions: readonly ComplaintDefinition[],
): string | undefined {
  const labels = complaints.map((complaint) => complaintOverviewLabel(
    complaint,
    definitions.find((definition) => definition.stableKey === complaint.complaintKey),
  ));
  if (labels.length === 0) return undefined;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
}

function complaintOverviewLabel(
  complaint: EncounterComplaint,
  definition: ComplaintDefinition | undefined,
): string {
  const freeText = complaint.freeTextLabel?.trim();
  if (freeText) return freeText;
  const display = definition?.display.trim();
  const patientDisplay = display?.match(/^Patient \((.+)\)$/)?.[1];
  const label = patientDisplay ?? display ?? "Presenting concern";
  return `${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()}`;
}

function hasStructuredRosAttestation(finding: ExamOverviewFindingProjection): boolean {
  return finding.current.components.some((component) =>
    (component.code === "ROS_ATTESTED_EYE" || component.code === "ROS_ATTESTED_GENERAL") &&
    component.value?.kind === "boolean" && component.value.value
  );
}

export async function loadOverviewFindingEvidence(
  fhir: Pick<ExamOverviewFhirClient,"baseUrl"|"read"|"search"|"searchUrl">,
  patientReference: string, encounterReference: string, definitions: readonly ClinicalFindingDefinition[],
): Promise<{projection: CurrentFindingProjection; observations: Observation[]; carriedWithoutCurrentEvidence: Set<string>}> {
  const state = await loadEncounterFindingState(fhir,{patientReference,encounterReference,definitions,catalog:materializeAtomicFindingCatalog(definitions)});
  if (state.incomplete) throw new Error(state.reason);
  const projection = projectCurrentFindings(state);
  const carriedWithoutCurrentEvidence = new Set<string>();
  for (const condition of state.conditions) {
    const plans = await carryPlansForCondition(fhir,`Condition/${condition.id}`);
    for (const {plan} of plans) {
      const witness = await carryFindingsWitness(fhir,plan);
      for (const target of plan.targets) {
        const fact = projection.currentFacts.find(f=>currentFindingIdentifier(f.key).value === currentFindingIdentifier(target.key).value);
        if (!fact) continue;
        for (const contributor of fact.contributors) {
          const reference = contributor.reference;
          if (!witness || !Object.hasOwn(witness.versions,reference)) { carriedWithoutCurrentEvidence.add(reference); continue; }
          const sameClinicalContent = fact.presence === target.presence && isDeepStrictEqual(fact.qualifiers,target.qualifiers);
          if (!sameClinicalContent) continue;
          const audits = await searchAll<Provenance>(fhir,"Provenance",{target:reference});
          const reasserted = audits.some(a=>isFindingReassertionProvenance(a) && Date.parse(a.recorded) > Date.parse(plan.recorded) &&
            a.agent.length === 1 && /^Practitioner\/[^/]+$/.test(a.agent[0].who.reference ?? "") &&
            new Set(a.target.map(t=>t.reference)).size === 2 && a.target.every(t=>[reference,patientReference].includes(t.reference ?? "")) &&
            [FINDING_OPERATION_AUDIT_SYSTEM,"urn:odos:finding-command:v1"].every(system=>a.meta?.tag?.filter(t=>t.system === system && /^[a-f0-9]{64}$/.test(t.code ?? "")).length === 1));
          if (!reasserted) carriedWithoutCurrentEvidence.add(reference);
        }
      }
    }
  }
  return {projection,observations:state.observations,carriedWithoutCurrentEvidence};
}

async function resolveFollowUpProfiles(fhir: ExamOverviewFhirClient, conditions: Condition[], encounterId: string) {
  const [profiles, catalog] = await Promise.all([
    new FhirFollowUpProfileStore(fhir).list(), new FhirDiagnosisCatalogStore(fhir).list(),
  ]);
  const families = new Set(conditions.flatMap(condition => {
    const family = conditionClinicalFamily(condition, encounterId, catalog);
    return family ? [family] : [];
  }));
  return profiles.filter(profile => profile.active && profile.matchesDiagnosisFamilies.some(family => families.has(normalizeClinicalFamily(family))));
}

export function normalizeClinicalFamily(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, " ");
}

export function conditionClinicalFamily(
  condition: Condition,
  encounterId: string,
  catalog: readonly { stableKey: string; clinicalFamily: string }[],
): string | undefined {
  if (condition.verificationStatus?.coding?.some(coding => ["entered-in-error", "refuted"].includes(coding.code ?? ""))) return undefined;
  const identifier = condition.identifier?.find(row => row.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM)?.value;
  const key = parseDiagnosisIdentifier(identifier, encounterId).diagnosisKey;
  const diagnosis = catalog.find(row => row.stableKey === key);
  return diagnosis ? normalizeClinicalFamily(diagnosis.clinicalFamily) : undefined;
}

const followingSchema = z.object({
  sourceEncounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/),
  sourceConditionReference: z.string().regex(/^Condition\/[A-Za-z0-9.-]+$/),
}).strict().nullable();

export async function handleExamScopeRequest(
  deps: ExamOverviewEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; method: "GET" | "PUT"; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read exam scope." } };
  const canWrite = staffHasBusinessAction(staff, "chart.write");
  if (!staffHasBusinessAction(staff, "chart.read") || (input.method === "PUT" && !canWrite)) {
    return { status: 403, body: { error: input.method === "PUT" ? "chart.write role required" : "chart.read role required" } };
  }
  const encounterId = readEncounterId(input.params);
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  const body = input.body as { examScope?: unknown; expectedVersion?: unknown; following?: unknown } | undefined;
  if (input.method === "PUT" && (!body || typeof body.examScope !== "string" || !["comprehensive", "office-visit"].includes(body.examScope) ||
    !(body.expectedVersion === null || (typeof body.expectedVersion === "string" && /^[A-Za-z0-9.-]+$/.test(body.expectedVersion))))) {
    return { status: 400, body: { error: "A valid exam scope and expected version are required." } };
  }
  const following = body?.following === undefined ? undefined : followingSchema.safeParse(body.following);
  if (input.method === "PUT" && following && (!following.success || (following.data === null && body?.examScope !== "office-visit"))) {
    return { status: 400, body: { error: "Choose a prior diagnosis, or Nothing to follow with Office visit." } };
  }
  try {
    const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
    if (!encounter.subject?.reference?.match(/^Patient\/[^/]+$/)) {
      return { status: 400, body: { error: "Exam scope requires an encounter patient." } };
    }
    const store = new FhirEncounterExamScopeStore(deps.serviceFhir ?? staff.fhir);
    let scope;
    if (input.method === "PUT") {
      const names = await practitionerNamesByReference(staff.fhir, [{ reference: staff.staffReference }]);
      const display = names.get(staff.staffReference);
      const actor = { reference: staff.staffReference, ...(display ? { display } : {}) };
      if (following?.success) {
        let profiles: Awaited<ReturnType<typeof resolveFollowUpProfiles>> = [];
        if (following.data) {
          const { sourceEncounterReference, sourceConditionReference } = following.data;
          const [prior, condition] = await Promise.all([
            staff.fhir.read<Encounter>("Encounter", sourceEncounterReference.slice(10)),
            staff.fhir.read<Condition>("Condition", sourceConditionReference.slice(10)),
          ]).catch(error => {
            if ([404, 410].includes(errorStatus(error) as number)) return [undefined, undefined] as const;
            throw error;
          });
          if (!prior || !condition) {
            return { status: 409, body: { error: "This diagnosis is no longer an eligible prior visit diagnosis. Reload and choose again." } };
          }
          const priorTime = Date.parse(prior.period?.start ?? ""), currentTime = Date.parse(encounter.period?.start ?? "");
          if (prior.status === "entered-in-error" || prior.subject?.reference !== encounter.subject.reference ||
            condition.subject.reference !== encounter.subject.reference || condition.encounter?.reference !== sourceEncounterReference ||
            !prior.diagnosis?.some(row => row.condition.reference === sourceConditionReference) ||
            !Number.isFinite(priorTime) || !Number.isFinite(currentTime) || priorTime >= currentTime ||
            condition.verificationStatus?.coding?.some(row => ["refuted", "entered-in-error"].includes(row.code ?? ""))) {
            return { status: 409, body: { error: "This diagnosis is no longer an eligible prior visit diagnosis. Reload and choose again." } };
          }
          profiles = await resolveFollowUpProfiles(deps.serviceFhir ?? staff.fhir, [condition], sourceEncounterReference.slice(10));
          if (!profiles.length) return { status: 409, body: { error: "No active follow-up shape matches this diagnosis." } };
        }
        scope = await store.pick(encounterId, body!.examScope as "comprehensive" | "office-visit", actor, body!.expectedVersion as string | null, profiles, resolveProfileTests(profiles));
      } else {
        scope = await store.set(encounterId, body!.examScope as "comprehensive" | "office-visit", actor, body!.expectedVersion as string | null);
      }
    } else {
      scope = await store.get(encounterId);
    }
    return { status: 200, body: { ...scope, canWrite } };
  } catch (error) {
    const status = errorStatus(error);
    if (status === 409 || status === 412) return { status: 409, body: { error: "Exam scope changed concurrently — reload and retry." } };
    if (status === 401 || status === 403) return { status: 403, body: { error: "Exam scope is outside the caller's patient compartment." } };
    if (status === 404 || status === 410) return { status: 404, body: { error: "Encounter was not found." } };
    return { status: 502, body: { error: "Exam scope could not be loaded or saved." } };
  }
}

export function resolveProfileTests(profiles: FollowUpProfileRecord[]): ProposedExamTest[] {
  const tests: ProposedExamTest[] = [];
  for (const profile of profiles) {
    try {
      for (const test of profile.testsQueuedByDefault) {
        tests.push({
          orderable: test.orderable, ...(test.focus ? { focus: test.focus } : {}),
          label: test.label,
          ...(test.unavailableReason !== undefined ? { unavailableReason: test.unavailableReason } : {}),
          ...(test.resultSection !== undefined ? { resultSection: test.resultSection } : {}),
          ...(test.choice !== undefined ? { choice: test.choice } : {}),
          sources: [{ kind: "profile", profileKey: profile.profileKey, profileLabel: profile.label }],
        });
      }
    } catch {
      // Optional test resolution must not discard the rest of the encounter shape.
    }
  }
  return tests;
}
