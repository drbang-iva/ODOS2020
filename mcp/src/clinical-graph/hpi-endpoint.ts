import { searchAll, FhirSearchLimitError, FhirSearchPageLimitError } from "../fhir-search.js";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { Basic, Bundle, Encounter, Observation, Provenance, Resource, ServiceRequest } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { odosConcept, reference } from "../fhir/ophthalmology/extensions.js";
import { FhirComplaintDefinitionStore } from "./complaint-definition-store.js";
import { renderComplaintNarrative } from "./complaint-model.js";
import type { EncounterComplaint } from "./complaint-model.js";
import { FhirEncounterComplaintStore } from "./encounter-complaint-store.js";
import { CLOSED_ENCOUNTER_EDIT_ERROR, isClosedEncounter } from "./encounter-sign-gate.js";
import { buildHpiFindingDefinition, HPI_STABLE_KEY } from "./hpi-definition.js";
import {
  HISTORY_ANSWER_SCOPE_SYSTEM,
  HISTORY_ANSWER_CODE,
  HISTORY_ANSWER_CODE_SYSTEM,
  HISTORY_REVIEW_ATTESTATION_CODE,
  HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM,
  HISTORY_REVIEW_ATTESTATION_IDENTIFIER_SYSTEM,
  HISTORY_REVIEW_SECTION_EXTENSION_URL,
  buildHistoryReviewAttestation,
  buildHistoryAnswerObservation,
  isHistoryAnswerObservation,
  parseHistoryAnswerObservation,
  assertHistoryTemplateAnswer,
} from "./history-answer-observation.js";
import {
  HISTORY_OPTION_CATALOGS,
  HISTORY_SUBJECT_SECTIONS,
  HISTORY_TEMPLATES,
  activeTemplateSections,
  type HistoryTemplate,
  type HistoryTemplateAnswer,
  type HistorySubjectSection,
} from "./history-template-engine.js";
import {
  captureGlaucomaFinding,
  type ClinicalFindingDefinition,
  type ClinicalGraphProvenance,
  type FindingValue,
} from "./glaucoma-suspect.js";

export interface HpiFhirClient {
  readonly baseUrl: string;
  read<T extends Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends Basic>(resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  update<T extends Basic | Encounter>(resourceType: T["resourceType"], id: string, resource: T, extraHeaders?: Record<string, string>): Promise<T>;
  executeTransaction(bundle: Bundle, extraHeaders?: Record<string, string>): Promise<Bundle>;
}

export interface HpiEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: HpiFhirClient;
  } | null>;
  findingDefinitions?: () => ClinicalFindingDefinition[];
  now?: () => string;
}

const PATIENT_HISTORY_MAX_ROWS = 5_000;

const WRITE_HEADERS = { "X-ODOS-Source": "mcp/save_hpi_ros" } as const;
export const HPI_OBSERVATION_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/NamingSystem/hpi-observation-encounter";
const rosFlagSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  display: z.string().trim().min(1).max(120),
  category: z.enum(["eye", "general"]),
  status: z.enum(["positive", "negative"]),
}).strict();
const hpiRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/),
  encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/),
  reviewOfSystems: z.array(rosFlagSchema).max(128).optional(),
  reviewAttestations: z.array(z.enum(["eye", "general"])).max(2).optional(),
  templateAnswers: z.array(z.unknown()).max(500).default([]),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const flag of value.reviewOfSystems ?? []) {
    if (seen.has(flag.code)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Review-of-systems flag ${flag.code} is duplicated.` });
    seen.add(flag.code);
  }
  if (value.reviewAttestations && new Set(value.reviewAttestations).size !== value.reviewAttestations.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Review attestations cannot contain duplicates." });
  }
  const answerIds = new Set<string>();
  for (const rawAnswer of value.templateAnswers) {
    try {
      const answer = assertHistoryTemplateAnswer(rawAnswer);
      if (answerIds.has(answer.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `History answer ${answer.id} is duplicated.` });
      answerIds.add(answer.id);
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: errorMessage(error) });
    }
  }
});
const historyReviewRequestSchema = z.object({
  patientReference: z.string().regex(/^Patient\/[A-Za-z0-9.-]+$/),
  encounterReference: z.string().regex(/^Encounter\/[A-Za-z0-9.-]+$/),
  sectionKey: z.string().regex(/^[a-z][a-z0-9-]{0,119}$/),
}).strict();

export async function handleHpiDefinitionRequest(
  deps: Pick<HpiEndpointDeps, "authenticate" | "findingDefinitions">,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read HPI definition." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  return {
    status: 200,
    body: { definition: {
      id: definition.id,
      stableKey: definition.stableKey,
      display: definition.display,
      fields: definition.valueSchema.fields,
      terminologyStatus: definition.valueSchema.terminologyStatus,
    }, templates: HISTORY_TEMPLATES, subjectSections: HISTORY_SUBJECT_SECTIONS, catalogs: HISTORY_OPTION_CATALOGS },
  };
}

export async function handleHpiRecordRequest(
  deps: Pick<HpiEndpointDeps, "authenticate">,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  return historySearchResult(() => handleHpiRecord(deps, input));
}

async function handleHpiRecord(
  deps: Pick<HpiEndpointDeps, "authenticate">,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read history." } };
  if (!staffHasBusinessAction(staff, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const encounterId = readId(input.params, "encounterId");
  if (!encounterId) return { status: 400, body: { error: "A valid encounter id is required." } };
  const encounterReference = `Encounter/${encounterId}`;
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  const patientReference = encounter.subject?.reference;
  const observations = await searchAll<Observation>(staff.fhir, "Observation", {
    encounter: encounterReference,
    code: `${HISTORY_ANSWER_CODE_SYSTEM}|${HISTORY_ANSWER_CODE}`,
    _count: "500",
  });
  const answers = observations.flatMap((observation) => {
    if (!observation || observation.status === "entered-in-error" || observation.status === "cancelled" ||
      observation.encounter?.reference !== encounterReference || observation.subject?.reference !== patientReference ||
      !isHistoryAnswerObservation(observation)) return [];
    return [parseHistoryAnswerObservation(observation)];
  });
  const complaints = await new FhirEncounterComplaintStore(staff.fhir).listByEncounter(encounterId);
  const narratives = templateNarratives(complaints, answers);
  const aggregates = await searchAll<Observation>(staff.fhir, "Observation", {
    encounter: encounterReference,
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${HPI_STABLE_KEY}`,
    _count: "200",
  });
  const aggregate = chooseCanonicalHistory(aggregates.flatMap((observation) => {
    return observation && isLiveHistoryObservation(observation, encounterReference) ? [observation] : [];
  }), encounterId);
  const requiresAggregateRefresh = narratives.length > 0 && narratives.some((row) => {
    const complaint = complaints.find((candidate) => candidate.id === row.complaintId);
    return !complaint || aggregateComponent(aggregate, `HISTORY_COMPLAINT_${complaint.ordinal}`) !== row.narrative;
  });
  const [plans, priorAnswers, reviewObservations] = patientReference
    ? await Promise.all([
        searchAll<ServiceRequest>(staff.fhir, "ServiceRequest", { subject: patientReference, _count: "500" }, { maxRows: PATIENT_HISTORY_MAX_ROWS }),
        searchAll<Observation>(staff.fhir, "Observation", {
          subject: patientReference,
          code: `${HISTORY_ANSWER_CODE_SYSTEM}|${HISTORY_ANSWER_CODE}`,
          "category:not": `${HISTORY_ANSWER_SCOPE_SYSTEM}|encounter`,
          _count: "500",
        }, { maxRows: PATIENT_HISTORY_MAX_ROWS }),
        searchAll<Observation>(staff.fhir, "Observation", {
          encounter: encounterReference,
          code: `${HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM}|${HISTORY_REVIEW_ATTESTATION_CODE}`,
          _count: "20",
        }),
      ])
    : [[], [], []];
  const prefills = [
    ...deriveFollowUpAnswerPrefills(
      complaints,
      priorAnswers,
      encounterReference,
      answers,
    ),
    ...deriveLastPlanPrefills(
      complaints,
      plans,
      encounterReference,
      answers,
    ),
  ];
  const carriedForwardAnswers = derivePatientCarryForwardAnswers(
    priorAnswers,
    encounterReference,
    patientReference,
  );
  const reviewAttestations = readHistoryReviewAttestations(
    reviewObservations,
    patientReference,
    encounterReference,
  );
  return {
    status: 200,
    body: { answers, carriedForwardAnswers, reviewAttestations, followUpPrefills: prefills, templateNarratives: narratives, requiresAggregateRefresh },
  };
}

export interface CarriedForwardHistoryAnswer {
  answer: HistoryTemplateAnswer;
  encounterReference: string;
  recordedAt: string;
}

export function derivePatientCarryForwardAnswers(
  observations: Observation[],
  currentEncounterReference: string,
  patientReference: string | undefined,
): CarriedForwardHistoryAnswer[] {
  const candidates = observations.flatMap((observation) => {
    if (!observation.id || !observation.encounter?.reference || observation.encounter.reference === currentEncounterReference ||
      observation.subject?.reference !== patientReference ||
      observation.status === "entered-in-error" || observation.status === "cancelled" || !isHistoryAnswerObservation(observation)) return [];
    const answer = parseHistoryAnswerObservation(observation);
    if (answer.subjectScope !== "patient") return [];
    return [{ answer, encounterReference: observation.encounter.reference, recordedAt: historyInstant(observation) }];
  }).sort((left, right) =>
    right.recordedAt.localeCompare(left.recordedAt) ||
    (right.answer.observationReference ?? "").localeCompare(left.answer.observationReference ?? "")
  );
  const latest = new Map<string, CarriedForwardHistoryAnswer>();
  for (const candidate of candidates) {
    const key = [candidate.answer.templateKey, candidate.answer.sectionId, candidate.answer.optionCode ?? "", candidate.answer.eye ?? ""].join("|");
    if (!latest.has(key)) latest.set(key, candidate);
  }
  return [...latest.values()];
}

function readHistoryReviewAttestations(
  observations: Observation[],
  patientReference: string | undefined,
  encounterReference: string,
): Array<{
  sectionKey: string;
  actorReference: string;
  recordedAt: string;
  attestationReference: string;
  priorAnswerReferences: string[];
}> {
  const candidates = observations.flatMap((observation) => {
    const sectionKey = observation.extension?.find((extension) => extension.url === HISTORY_REVIEW_SECTION_EXTENSION_URL)?.valueCode;
    const actorReference = observation.performer?.[0]?.reference;
    const recordedAt = historyInstant(observation);
    if (!observation.id || !sectionKey || !actorReference || !recordedAt || observation.subject?.reference !== patientReference ||
      observation.encounter?.reference !== encounterReference || observation.status === "entered-in-error" || observation.status === "cancelled" ||
      !observation.code.coding?.some((coding) => coding.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && coding.code === HISTORY_REVIEW_ATTESTATION_CODE)) return [];
    return [{
      sectionKey,
      actorReference,
      recordedAt,
      attestationReference: `Observation/${observation.id}`,
      priorAnswerReferences: (observation.derivedFrom ?? []).flatMap((reference) => reference.reference ? [reference.reference] : []),
    }];
  }).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  const latest = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) if (!latest.has(candidate.sectionKey)) latest.set(candidate.sectionKey, candidate);
  return [...latest.values()];
}

export async function handleHistoryReviewRequest(
  deps: HpiEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  return historySearchResult(() => handleHistoryReview(deps, input));
}

async function handleHistoryReview(
  deps: HpiEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to review history." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = historyReviewRequestSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid history review request." } };
  const declaration = HISTORY_SUBJECT_SECTIONS.find((candidate) => candidate.key === parsed.data.sectionKey);
  if (!declaration || declaration.subjectScope !== "patient") {
    return { status: 400, body: { error: "History review section is not patient-scoped." } };
  }
  const encounterId = parsed.data.encounterReference.slice("Encounter/".length);
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  if (encounter.subject?.reference !== parsed.data.patientReference) {
    return { status: 400, body: { error: "History patient does not match the encounter subject." } };
  }
  if (isClosedEncounter(encounter)) return { status: 409, body: { error: CLOSED_ENCOUNTER_EDIT_ERROR } };

  const historyAnswers = await searchAll<Observation>(staff.fhir, "Observation", {
    subject: parsed.data.patientReference,
    code: `${HISTORY_ANSWER_CODE_SYSTEM}|${HISTORY_ANSWER_CODE}`,
    "category:not": `${HISTORY_ANSWER_SCOPE_SYSTEM}|encounter`,
    _count: "500",
  }, { maxRows: PATIENT_HISTORY_MAX_ROWS });
  const currentSectionAnswers = historyAnswers.filter((observation) => {
    if (observation.subject?.reference !== parsed.data.patientReference ||
      observation.encounter?.reference !== parsed.data.encounterReference ||
      observation.status === "entered-in-error" || observation.status === "cancelled" ||
      !isHistoryAnswerObservation(observation)) return false;
    const answer = parseHistoryAnswerObservation(observation);
    return answer.subjectScope === "patient" && answer.templateKey === declaration.key;
  });
  if (currentSectionAnswers.length > 0) {
    return { status: 409, body: { error: `${declaration.label} was edited on this encounter; a no-change review cannot also be recorded.` } };
  }
  const carried = derivePatientCarryForwardAnswers(
    historyAnswers,
    parsed.data.encounterReference,
    parsed.data.patientReference,
  ).filter((row) => row.answer.templateKey === declaration.key);
  if (carried.length === 0) return { status: 400, body: { error: `There is no prior ${declaration.label} to review.` } };

  const existingObservations = await searchAll<Observation>(staff.fhir, "Observation", {
    encounter: parsed.data.encounterReference,
    code: `${HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM}|${HISTORY_REVIEW_ATTESTATION_CODE}`,
    _count: "20",
  });
  const identifierValue = `${encounterId}:${declaration.key}`;
  const existing = existingObservations.flatMap((observation) => {
    return observation?.id && observation.status !== "entered-in-error" && observation.status !== "cancelled" &&
      observation.identifier?.some((identifier) => identifier.system === HISTORY_REVIEW_ATTESTATION_IDENTIFIER_SYSTEM && identifier.value === identifierValue)
      ? [observation]
      : [];
  })[0];
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const attestation = buildHistoryReviewAttestation({
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    sectionKey: declaration.key,
    actorReference: staff.staffReference,
    recordedAt,
    priorAnswerReferences: carried.flatMap((row) => row.answer.observationReference ? [row.answer.observationReference] : []),
  }, existing);
  const fullUrl = "urn:uuid:history-review-attestation";
  const target = existing?.id ? `Observation/${existing.id}` : fullUrl;
  const provenance: Provenance = {
    resourceType: "Provenance",
    target: [reference(target), reference(parsed.data.encounterReference), reference(parsed.data.patientReference)],
    recorded: recordedAt,
    activity: odosConcept(existing ? "UPDATE" : "CREATE", "Record reviewed today, no change"),
    agent: [{ type: odosConcept("author", "Author"), who: reference(staff.staffReference) }],
  };
  const transactionRequest: Bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      existing?.id
        ? { resource: attestation, request: { method: "PUT", url: `Observation/${existing.id}`, ...(existing.meta?.versionId ? { ifMatch: `W/\"${existing.meta.versionId}\"` } : {}) } }
        : { fullUrl, resource: attestation, request: { method: "PUT", url: `Observation?identifier=${HISTORY_REVIEW_ATTESTATION_IDENTIFIER_SYSTEM}|${identifierValue}` } },
      { fullUrl: "urn:uuid:history-review-provenance", resource: provenance, request: { method: "POST", url: "Provenance" } },
    ],
  };
  const transaction = await staff.fhir.executeTransaction(transactionRequest, {
    "X-ODOS-Source": "mcp/review_history_no_change",
    Prefer: "return=representation",
  });
  assertSuccessfulTransaction(transactionRequest, transaction);
  return {
    status: 200,
    body: {
      sectionKey: declaration.key,
      actorReference: staff.staffReference,
      recordedAt,
      attestationReference: existing?.id ? `Observation/${existing.id}` : transactionResourceReference(transaction, 0, "Observation"),
      priorAnswerReferences: carried.flatMap((row) => row.answer.observationReference ? [row.answer.observationReference] : []),
    },
  };
}

export function deriveFollowUpAnswerPrefills(
  complaints: EncounterComplaint[],
  observations: Observation[],
  currentEncounterReference: string,
  existingAnswers: HistoryTemplateAnswer[],
): HistoryTemplateAnswer[] {
  const prior = observations.flatMap((observation) => {
    if (!observation.encounter?.reference || observation.encounter.reference === currentEncounterReference ||
      observation.status === "entered-in-error" || observation.status === "cancelled" ||
      !isHistoryAnswerObservation(observation)) return [];
    return [{ observation, answer: parseHistoryAnswerObservation(observation) }];
  });
  const latestEncounter = prior.sort((left, right) =>
    historyInstant(right.observation).localeCompare(historyInstant(left.observation)) ||
    (right.observation.id ?? "").localeCompare(left.observation.id ?? "")
  )[0]?.observation.encounter?.reference;
  if (!latestEncounter) return [];
  const existingIds = new Set(existingAnswers.map((answer) => answer.id));
  const priorAnswers = prior.filter((row) => row.observation.encounter?.reference === latestEncounter).map((row) => row.answer);
  const prefills = new Map<string, HistoryTemplateAnswer>();
  for (const complaint of complaints) {
    const templateKey = complaint.templateKey ?? complaint.complaintKey;
    const template = HISTORY_TEMPLATES.find((candidate) => candidate.complaint === templateKey);
    if (!template) continue;
    const listSections = new Set(template.sections.filter((section) =>
      section.catalog && section.type !== "presents_for"
    ).map((section) => section.id));
    for (const priorAnswer of priorAnswers) {
      if (priorAnswer.templateKey !== template.complaint || priorAnswer.value.kind !== "tri-state" ||
        !listSections.has(priorAnswer.sectionId)) continue;
      const id = historyAnswerId(complaint.id, priorAnswer.sectionId, priorAnswer.optionCode, priorAnswer.eye);
      if (existingIds.has(id)) continue;
      prefills.set(id, {
        id,
        complaintId: complaint.id,
        templateKey: template.complaint,
        sectionId: priorAnswer.sectionId,
        ...(priorAnswer.optionCode ? { optionCode: priorAnswer.optionCode } : {}),
        ...(priorAnswer.eye ? { eye: priorAnswer.eye } : {}),
        value: priorAnswer.value,
      });
    }
  }
  return [...prefills.values()];
}

export function deriveLastPlanPrefills(
  complaints: EncounterComplaint[],
  plans: ServiceRequest[],
  currentEncounterReference: string,
  existingAnswers: HistoryTemplateAnswer[],
): HistoryTemplateAnswer[] {
  const priorPlans = plans.filter((plan) =>
    plan.intent === "plan" &&
    plan.encounter?.reference !== currentEncounterReference &&
    plan.status !== "entered-in-error" && plan.status !== "revoked" &&
    Boolean(plan.authoredOn)
  );
  const latest = priorPlans.sort((left, right) =>
    (right.authoredOn ?? "").localeCompare(left.authoredOn ?? "") || (right.id ?? "").localeCompare(left.id ?? "")
  )[0];
  if (!latest) return [];
  const latestPlanRows = latest.encounter?.reference
    ? priorPlans.filter((plan) => plan.encounter?.reference === latest.encounter?.reference)
    : [latest];
  const planText = latestPlanRows.flatMap((plan) => [
    plan.code?.text,
    ...(plan.code?.coding ?? []).map((coding) => coding.display),
    ...(plan.reasonCode ?? []).flatMap((reason) => [
      reason.text,
      ...(reason.coding ?? []).map((coding) => coding.display),
    ]),
  ]).filter((value): value is string => Boolean(value)).join(" ");
  const normalizedPlan = normalizePlanText(planText);
  if (!normalizedPlan) return [];
  const existingIds = new Set(existingAnswers.map((answer) => answer.id));
  return complaints.flatMap((complaint) => {
    const templateKey = complaint.templateKey ?? complaint.complaintKey;
    const template = HISTORY_TEMPLATES.find((candidate) => candidate.complaint === templateKey);
    if (!template) return [];
    return template.sections.flatMap((section) => {
      if (section.prefill !== "last_plan" || !section.catalog) return [];
      return (HISTORY_OPTION_CATALOGS[section.catalog] ?? []).flatMap((option) => {
        const id = `history-${complaint.id}-${section.id}-${option.code}`;
        if (existingIds.has(id) || !normalizedPlan.includes(normalizePlanText(option.display))) return [];
        return [{
          id,
          complaintId: complaint.id,
          templateKey: template.complaint,
          sectionId: section.id,
          optionCode: option.code,
          value: { kind: "tri-state", status: "positive" as const },
        }];
      });
    });
  });
}

export async function handleHpiCaptureRequest(
  deps: HpiEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  return historySearchResult(() => handleHpiCapture(deps, input));
}

async function handleHpiCapture(
  deps: HpiEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to save history." } };
  if (!staffHasBusinessAction(staff, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsed = hpiRequestSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid history request." } };

  const encounterId = parsed.data.encounterReference.slice("Encounter/".length);
  const encounter = await staff.fhir.read<Encounter>("Encounter", encounterId);
  if (encounter.subject?.reference !== parsed.data.patientReference) {
    return { status: 400, body: { error: "History patient does not match the encounter subject." } };
  }
  if (isClosedEncounter(encounter)) {
    return { status: 409, body: { error: CLOSED_ENCOUNTER_EDIT_ERROR } };
  }
  const definition = resolveHpiDefinition(deps.findingDefinitions?.());
  const rosError = validateRos(parsed.data.reviewOfSystems ?? [], definition);
  if (rosError) return { status: 400, body: { error: rosError } };

  const definitions = await new FhirComplaintDefinitionStore(staff.fhir).list();
  const complaints = (await new FhirEncounterComplaintStore(staff.fhir).listByEncounter(encounterId))
    .filter((complaint) => complaint.status === "active")
    .sort((left, right) => left.ordinal - right.ordinal);
  const templateAnswers = parsed.data.templateAnswers.map(assertHistoryTemplateAnswer);
  const recordedAt = deps.now?.() ?? new Date().toISOString();
  const answerUpsert = await prepareHistoryAnswerUpsert(staff.fhir, templateAnswers, {
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    recordedAt,
    actorReference: staff.staffReference,
  });
  const effectiveAnswers = [...new Map([
    ...answerUpsert.persistedAnswers,
    ...templateAnswers.map((answer) => [answer.id, answer] as const),
  ]).values()];
  const answerError = validateTemplateAnswers(templateAnswers, complaints, effectiveAnswers);
  if (answerError) return { status: 400, body: { error: answerError } };

  if (!complaints.length) {
    const hasEncounterHistory = parsed.data.reviewOfSystems !== undefined || parsed.data.reviewAttestations !== undefined ||
      templateAnswers.some((answer) => Boolean(answer.complaintId));
    if (hasEncounterHistory) return { status: 400, body: { error: "At least one presenting complaint is required before saving history." } };
    if (!answerUpsert.entries.length && !answerUpsert.reviewRetirements.length) {
      return { status: 200, body: {
        encounterReference: parsed.data.encounterReference, templateNarratives: [],
        answers: templateAnswers.map((answer) => ({ ...answer, observationReference: answerUpsert.persistedAnswers.get(answer.id)?.observationReference })),
        retiredReviewSections: [],
      } };
    }
    const answerTargets = answerUpsert.entries.map((entry) => reference(
      entry.resource?.id ? `Observation/${entry.resource.id}` : entry.fullUrl ?? "urn:uuid:history-answer"
    ));
    const provenance: Provenance = {
      resourceType: "Provenance",
      target: [...answerTargets, reference(parsed.data.encounterReference), reference(parsed.data.patientReference)],
      recorded: recordedAt,
      activity: odosConcept("UPDATE", "Record patient-scoped history answers"),
      agent: [{ type: odosConcept("author", "Author"), who: reference(staff.staffReference) }],
    };
    const transactionRequest: Bundle = {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        ...answerUpsert.entries,
        ...answerUpsert.reviewRetirements,
        { fullUrl: "urn:uuid:history-answer-provenance", resource: provenance, request: { method: "POST", url: "Provenance" } },
        ...(answerUpsert.reviewRetirementProvenance
          ? [{ fullUrl: "urn:uuid:history-review-retirement-provenance", resource: answerUpsert.reviewRetirementProvenance, request: { method: "POST" as const, url: "Provenance" } }]
          : []),
      ],
    };
    const sizeError = historyBundleSizeError(transactionRequest);
    if (sizeError) return { status: 413, body: { error: sizeError } };
    const transaction = await staff.fhir.executeTransaction(transactionRequest, {
      ...WRITE_HEADERS,
      Prefer: "return=representation",
    });
    assertSuccessfulTransaction(transactionRequest, transaction);
    return {
      status: 200,
      body: {
        encounterReference: parsed.data.encounterReference,
        templateNarratives: [],
        answers: savedHistoryAnswers(templateAnswers, answerUpsert.existingAnswers, answerUpsert.changedAnswers, transaction, 0),
        retiredReviewSections: answerUpsert.retiredReviewSections,
        provenanceReference: transactionResourceReference(transaction, answerUpsert.entries.length + answerUpsert.reviewRetirements.length, "Provenance"),
      },
    };
  }
  const captureProvenance: ClinicalGraphProvenance = {
    source: "manual",
    recordedAt,
    actorReference: staff.staffReference,
    note: [
      "MANDATE-14-DEFERRED: complaint, HPI, and ROS concepts remain ODOS-local; no external terminology code is asserted.",
      ...(parsed.data.reviewAttestations ?? []).map((group) => `${group} review-of-systems remaining items attested negative.`),
    ].join(" "),
  };
  const findingId = `finding-${HPI_STABLE_KEY}-${randomUUID()}`;
  const captured = captureGlaucomaFinding({
    definition,
    patientReference: parsed.data.patientReference,
    encounterReference: parsed.data.encounterReference,
    laterality: "UNKNOWN",
    value: historyFindingValue(
      complaints,
      definitions,
      parsed.data.reviewOfSystems ?? [],
      parsed.data.reviewAttestations ?? [],
      effectiveAnswers,
    ),
    sourceType: "manual",
    performerReferences: [staff.staffReference],
    recordedAt,
    provenance: captureProvenance,
    findingInstanceId: findingId,
    observationId: findingId,
  });
  const existingObservations = await searchAll<Observation>(staff.fhir, "Observation", {
    encounter: parsed.data.encounterReference,
    code: `${ODOS_OPHTHALMOLOGY_CODE_SYSTEM}|${HPI_STABLE_KEY}`,
    _count: "200",
  });
  const liveHistory = existingObservations.flatMap((observation) => {
    return observation && isLiveHistoryObservation(observation, parsed.data.encounterReference)
      ? [observation]
      : [];
  });
  if (liveHistory.some((observation) => !observation.id)) {
    throw new Error("History upsert found a persisted Observation without an id.");
  }
  const identifierValue = encounterId;
  const canonical = chooseCanonicalHistory(liveHistory, identifierValue);
  const observation = historyObservationForUpsert(
    captured.observation,
    canonical,
    identifierValue,
    parsed.data.reviewOfSystems === undefined && parsed.data.reviewAttestations === undefined,
  );
  const observationFullUrl = "urn:uuid:hpi-observation";
  const observationTarget = canonical?.id ? `Observation/${canonical.id}` : observationFullUrl;
  const activityCode = canonical ? "UPDATE" : "CREATE";
  const provenanceResource: Provenance = {
    ...captured.provenance,
    activity: odosConcept(activityCode, [
      "Capture presenting complaints, history narrative, and review of systems",
      ...(parsed.data.reviewAttestations ?? []).map((group) => `${group} remaining items reviewed negative`),
    ].join("; ")),
    target: [
      reference(observationTarget),
      reference(parsed.data.encounterReference),
      reference(parsed.data.patientReference),
    ],
  };
  const duplicateEntries = liveHistory
    .filter((candidate) => candidate.id !== canonical?.id)
    .map((duplicate) => ({
      resource: { ...duplicate, status: "entered-in-error" as const },
      request: {
        method: "PUT" as const,
        url: `Observation/${duplicate.id}`,
        ...(duplicate.meta?.versionId ? { ifMatch: `W/\"${duplicate.meta.versionId}\"` } : {}),
      },
    }));
  const aggregateChanged = duplicateEntries.length > 0 || !canonical || !isDeepStrictEqual(observation.component, canonical.component);
  const aggregateEntries: NonNullable<Bundle["entry"]> = aggregateChanged ? [
    canonical?.id
      ? { resource: observation, request: { method: "PUT", url: `Observation/${canonical.id}`, ...(canonical.meta?.versionId ? { ifMatch: `W/"${canonical.meta.versionId}"` } : {}) } }
      : { fullUrl: observationFullUrl, resource: observation, request: { method: "PUT", url: `Observation?identifier=${HPI_OBSERVATION_IDENTIFIER_SYSTEM}|${identifierValue}` } },
  ] : [];
  const hasWrites = aggregateChanged || duplicateEntries.length > 0 || answerUpsert.entries.length > 0 || answerUpsert.reviewRetirements.length > 0;
  const provenanceEntries: NonNullable<Bundle["entry"]> = hasWrites
    ? [{ fullUrl: "urn:uuid:hpi-provenance", resource: provenanceResource, request: { method: "POST", url: "Provenance" } }]
    : [];
  const transactionRequest: Bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      ...aggregateEntries,
      ...provenanceEntries,
      ...duplicateEntries,
      ...answerUpsert.entries,
      ...answerUpsert.reviewRetirements,
      ...(answerUpsert.reviewRetirementProvenance
        ? [{ fullUrl: "urn:uuid:history-review-retirement-provenance", resource: answerUpsert.reviewRetirementProvenance, request: { method: "POST" as const, url: "Provenance" } }]
        : []),
    ],
  };
  const sizeError = historyBundleSizeError(transactionRequest);
  if (sizeError) return { status: 413, body: { error: sizeError } };
  const transaction: Bundle = hasWrites ? await staff.fhir.executeTransaction(transactionRequest, {
    ...WRITE_HEADERS,
    Prefer: "return=representation",
  }) : { resourceType: "Bundle", type: "transaction-response", entry: [] };
  assertSuccessfulTransaction(transactionRequest, transaction);
  const observationReference = canonical?.id
    ? `Observation/${canonical.id}`
    : transactionResourceReference(transaction, 0, "Observation");
  const provenanceReference = hasWrites ? transactionResourceReference(transaction, aggregateEntries.length, "Provenance") : undefined;
  const answerStartIndex = aggregateEntries.length + provenanceEntries.length + duplicateEntries.length;
  const savedAnswers = savedHistoryAnswers(templateAnswers, answerUpsert.existingAnswers, answerUpsert.changedAnswers, transaction, answerStartIndex);
  return {
    status: 200,
    body: {
      observationReference,
      encounterReference: parsed.data.encounterReference,
      narratives: complaints.map((complaint) => renderComplaintNarrative(
        complaint,
        definitions.find((candidate) => candidate.stableKey === complaint.complaintKey),
      )),
      templateNarratives: templateNarratives(complaints, effectiveAnswers),
      answers: savedAnswers,
      retiredReviewSections: answerUpsert.retiredReviewSections,
      ...(provenanceReference ? { provenanceReference } : {}),
    },
  };
}

async function prepareHistoryAnswerUpsert(
  fhir: HpiFhirClient,
  answers: HistoryTemplateAnswer[],
  context: { patientReference: string; encounterReference: string; recordedAt: string; actorReference: string },
): Promise<{
  existingAnswers: Map<string, Observation>;
  persistedAnswers: Map<string, HistoryTemplateAnswer>;
  changedAnswers: HistoryTemplateAnswer[];
  entries: NonNullable<Bundle["entry"]>;
  reviewRetirements: NonNullable<Bundle["entry"]>;
  retiredReviewSections: string[];
  reviewRetirementProvenance: Provenance | undefined;
}> {
  const answerObservations = await searchAll<Observation>(fhir, "Observation", {
    encounter: context.encounterReference,
    code: `${HISTORY_ANSWER_CODE_SYSTEM}|${HISTORY_ANSWER_CODE}`,
    _count: "500",
  });
  const existingAnswers = new Map(answerObservations.flatMap((candidate) => {
    if (!candidate?.id || candidate.status === "entered-in-error" || candidate.status === "cancelled" || !isHistoryAnswerObservation(candidate) ||
      candidate.subject?.reference !== context.patientReference || candidate.encounter?.reference !== context.encounterReference) return [];
    return [[parseHistoryAnswerObservation(candidate).id, candidate] as const];
  }));
  const persistedAnswers = new Map([...existingAnswers].map(([id, observation]) => {
    return [id, parseHistoryAnswerObservation(observation)] as const;
  }));
  const changedAnswers = answers.filter((answer) => !samePersistedHistoryAnswer(answer, persistedAnswers.get(answer.id)));
  const editedPatientSections = new Set(changedAnswers.flatMap((answer) => {
    const persisted = persistedAnswers.get(answer.id);
    return [answer, persisted].flatMap((candidate) => candidate?.subjectScope === "patient" ? [candidate.templateKey] : []);
  }));
  const reviewObservations = editedPatientSections.size > 0 ? await searchAll<Observation>(fhir, "Observation", {
    encounter: context.encounterReference,
    code: `${HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM}|${HISTORY_REVIEW_ATTESTATION_CODE}`,
    _count: "20",
  }) : undefined;
  const entries = changedAnswers.map((answer, index) => {
    const existing = existingAnswers.get(answer.id);
    const resource = buildHistoryAnswerObservation(answer, context, existing);
    return existing?.id
      ? { resource, request: { method: "PUT" as const, url: `Observation/${existing.id}`, ...(existing.meta?.versionId ? { ifMatch: `W/\"${existing.meta.versionId}\"` } : {}) } }
      : { fullUrl: `urn:uuid:hpi-answer-${index}`, resource, request: { method: "PUT" as const, url: `Observation?identifier=${resource.identifier?.[0]?.system}|${answer.id}` } };
  });
  const reviews = (reviewObservations ?? []).flatMap((observation) => {
    const sectionKey = observation?.extension?.find((extension) => extension.url === HISTORY_REVIEW_SECTION_EXTENSION_URL)?.valueCode;
    if (!observation?.id || !sectionKey || !editedPatientSections.has(sectionKey) ||
      observation.subject?.reference !== context.patientReference || observation.encounter?.reference !== context.encounterReference ||
      observation.status === "entered-in-error" || observation.status === "cancelled" ||
      !observation.code.coding?.some((coding) => coding.system === HISTORY_REVIEW_ATTESTATION_CODE_SYSTEM && coding.code === HISTORY_REVIEW_ATTESTATION_CODE)) return [];
    return [{ observation, sectionKey }];
  }).sort((left, right) => (left.observation.id ?? "").localeCompare(right.observation.id ?? ""));
  const reviewRetirements = reviews.map(({ observation }) => ({
    resource: { ...observation, status: "entered-in-error" as const },
    request: {
      method: "PUT" as const,
      url: `Observation/${observation.id}`,
      ...(observation.meta?.versionId ? { ifMatch: `W/\"${observation.meta.versionId}\"` } : {}),
    },
  }));
  const retiredReviewSections = [...new Set(reviews.map((review) => review.sectionKey))];
  const reviewRetirementProvenance: Provenance | undefined = reviews.length > 0 ? {
    resourceType: "Provenance",
    target: reviews.map(({ observation }) => reference(`Observation/${observation.id}`)),
    recorded: context.recordedAt,
    activity: odosConcept("VOID", "Retire superseded history review attestation"),
    agent: [{ type: odosConcept("author", "Author"), who: reference(context.actorReference) }],
  } : undefined;
  return { existingAnswers, persistedAnswers, changedAnswers, entries, reviewRetirements, retiredReviewSections, reviewRetirementProvenance };
}

function samePersistedHistoryAnswer(left: HistoryTemplateAnswer, right: HistoryTemplateAnswer | undefined): boolean {
  if (!right) return false;
  const { observationReference: _leftReference, ...leftPersisted } = left;
  const { observationReference: _rightReference, ...rightPersisted } = right;
  return isDeepStrictEqual(leftPersisted, rightPersisted);
}

function historyBundleSizeError(bundle: Bundle): string | undefined {
  const entries = bundle.entry ?? [];
  const conditional = entries.some((entry) => entry.request?.ifNoneExist || entry.request?.url.includes("?"));
  if (conditional && entries.length > 8) return `History save refused: conditional bundles allow at most 8 total entries; this save needs ${entries.length}. No changes were written.`;
  const puts = entries.filter((entry) => entry.request?.method === "PUT").length;
  if (puts > 50) return `History save refused: bundles allow at most 50 PUT entries; this save needs ${puts}. No changes were written.`;
  return undefined;
}

function savedHistoryAnswers(
  answers: HistoryTemplateAnswer[],
  existingAnswers: Map<string, Observation>,
  changedAnswers: HistoryTemplateAnswer[],
  transaction: Bundle,
  startIndex: number,
): HistoryTemplateAnswer[] {
  return answers.map((answer) => {
    const index = changedAnswers.findIndex((changed) => changed.id === answer.id);
    const existing = existingAnswers.get(answer.id);
    const observationReference = existing?.id
      ? `Observation/${existing.id}`
      : transactionResourceReference(transaction, startIndex + index, "Observation");
    return { ...answer, observationReference };
  });
}

function isLiveHistoryObservation(observation: Observation, encounterReference: string): boolean {
  return observation.status !== "entered-in-error" && observation.status !== "cancelled" &&
    observation.encounter?.reference === encounterReference &&
    observation.code.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === HPI_STABLE_KEY
    ) === true;
}

function chooseCanonicalHistory(observations: Observation[], identifierValue: string): Observation | undefined {
  return [...observations].sort((left, right) => {
    const leftIdentified = hasHistoryIdentifier(left, identifierValue) ? 1 : 0;
    const rightIdentified = hasHistoryIdentifier(right, identifierValue) ? 1 : 0;
    return rightIdentified - leftIdentified ||
      historyInstant(right).localeCompare(historyInstant(left)) ||
      (left.id ?? "").localeCompare(right.id ?? "");
  })[0];
}

function historyObservationForUpsert(
  captured: Observation,
  existing: Observation | undefined,
  identifierValue: string,
  preserveReviewOfSystems: boolean,
): Observation {
  const identifiers = (existing?.identifier ?? []).filter((identifier) =>
    identifier.system !== HPI_OBSERVATION_IDENTIFIER_SYSTEM
  );
  return {
    ...captured,
    ...(existing?.id ? { id: existing.id } : { id: undefined }),
    ...(existing?.meta ? { meta: existing.meta } : {}),
    identifier: [
      ...identifiers,
      { system: HPI_OBSERVATION_IDENTIFIER_SYSTEM, value: identifierValue },
    ],
    ...(preserveReviewOfSystems && existing
      ? { component: [
          ...(captured.component ?? []),
          ...(existing.component ?? []).filter((component) =>
            component.code.coding?.some((coding) => coding.code?.startsWith("ROS_"))
          ),
        ] }
      : {}),
  };
}

function hasHistoryIdentifier(observation: Observation, identifierValue: string): boolean {
  return observation.identifier?.some((identifier) =>
    identifier.system === HPI_OBSERVATION_IDENTIFIER_SYSTEM && identifier.value === identifierValue
  ) === true;
}

function historyInstant(observation: Observation): string {
  return observation.effectiveDateTime ?? observation.issued ?? observation.meta?.lastUpdated ?? "";
}

function aggregateComponent(observation: Observation | undefined, code: string): string | undefined {
  return observation?.component?.find((component) =>
    component.code.coding?.some((coding) => coding.code === code)
  )?.valueString;
}

function assertSuccessfulTransaction(request: Bundle, response: Bundle): void {
  const entries = response.entry;
  if (response.type !== "transaction-response" || !entries || entries.length !== request.entry?.length) {
    throw new Error("History upsert did not return a complete transaction response.");
  }
  for (const entry of entries) {
    const status = Number.parseInt(entry.response?.status ?? "", 10);
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error(`History upsert transaction failed with ${entry.response?.status ?? "no status"}.`);
    }
  }
}

function transactionResourceReference(
  transaction: Bundle,
  index: number,
  resourceType: "Observation" | "Provenance",
): string {
  const location = transaction.entry?.[index]?.response?.location;
  const match = location?.match(new RegExp(`^${resourceType}/([A-Za-z0-9.-]+)(?:/_history/[A-Za-z0-9.-]+)?$`));
  if (!match) throw new Error(`History upsert transaction did not identify the ${resourceType}.`);
  return `${resourceType}/${match[1]}`;
}

function historyFindingValue(
  complaints: Awaited<ReturnType<FhirEncounterComplaintStore["listByEncounter"]>>,
  definitions: Awaited<ReturnType<FhirComplaintDefinitionStore["list"]>>,
  reviewOfSystems: z.infer<typeof rosFlagSchema>[],
  reviewAttestations: Array<"eye" | "general">,
  templateAnswers: HistoryTemplateAnswer[],
): Extract<FindingValue, { type: "components" }> {
  const renderedByComplaint = new Map(templateNarratives(complaints, templateAnswers).map((row) => [row.complaintId, row.narrative]));
  const components: Extract<FindingValue, { type: "components" }>["components"] = complaints.map((complaint) => ({
    code: `HISTORY_COMPLAINT_${complaint.ordinal}`,
    display: complaint.ordinal === 1 ? "Primary complaint history" : `Complaint ${complaint.ordinal} history`,
    value: renderedByComplaint.get(complaint.id) ?? renderComplaintNarrative(complaint, definitions.find((candidate) => candidate.stableKey === complaint.complaintKey)),
  }));
  for (const flag of reviewOfSystems) {
    components.push({ code: `ROS_${snakeCase(flag.code)}`, display: flag.display, value: flag.status });
  }
  for (const group of reviewAttestations) {
    components.push({
      code: `ROS_ATTESTED_${snakeCase(group)}`,
      display: `${group === "eye" ? "Eye" : "General"} review of systems attested`,
      value: true,
    });
  }
  return { type: "components", components };
}

function validateTemplateAnswers(answers: HistoryTemplateAnswer[], complaints: EncounterComplaint[], effectiveAnswers = answers): string | undefined {
  const complaintById = new Map(complaints.map((complaint) => [complaint.id, complaint]));
  for (const answer of answers) {
    if (answer.subjectScope) {
      const declaration = HISTORY_SUBJECT_SECTIONS.find((candidate) =>
        candidate.key === answer.templateKey && candidate.subjectScope === answer.subjectScope
      );
      if (!declaration) return `History answer ${answer.id} names an unknown subject-scoped section.`;
      const section = declaration.sections.find((candidate) => candidate.id === answer.sectionId);
      if (!section) return `History answer ${answer.id} names an inactive subject section.`;
      const sectionError = validateSubjectSectionAnswer(answer, section);
      if (sectionError) return sectionError;
      continue;
    }
    const complaint = complaintById.get(answer.complaintId);
    if (!complaint) return `History answer ${answer.id} names an inactive complaint.`;
    const template = HISTORY_TEMPLATES.find((candidate) => candidate.complaint === answer.templateKey);
    if (!template) return `History answer ${answer.id} names an unknown template.`;
    const complaintTemplate = complaint.templateKey ?? complaint.complaintKey;
    if (HISTORY_TEMPLATES.some((candidate) => candidate.complaint === complaintTemplate) && complaintTemplate !== answer.templateKey) {
      return `History answer ${answer.id} does not match its complaint template.`;
    }
    if (answer.sectionId === "narrative-override") {
      if (answer.value.kind !== "text" || !answer.value.text.trim()) return `History answer ${answer.id} has an invalid narrative override.`;
      continue;
    }
    if (answer.sectionId === "presentation") {
      if (answer.value.kind !== "selection") return `History answer ${answer.id} has an invalid presentation.`;
      const presentationCode = answer.value.code;
      if (!HISTORY_OPTION_CATALOGS[template.presentations]?.some((option) => option.code === presentationCode)) {
        return `History answer ${answer.id} has an invalid presentation.`;
      }
      continue;
    }
    const section = template.sections.find((candidate) => candidate.id === answer.sectionId);
    if (!section) return `History answer ${answer.id} names an inactive template section.`;
    const presentation = effectiveAnswers.find((candidate) => candidate.complaintId === answer.complaintId && candidate.sectionId === "presentation");
    const presentationCode = presentation?.value.kind === "selection" ? presentation.value.code : undefined;
    if (section.on && section.on !== presentationCode) {
      return `History answer ${answer.id} is inactive for ${presentationCode ?? "the unselected presentation"}.`;
    }
    if (answer.optionCode && (!section.catalog || !HISTORY_OPTION_CATALOGS[section.catalog]?.some((option) => option.code === answer.optionCode))) {
      return `History answer ${answer.id} names an unknown catalog option.`;
    }
    const expectedKind = sectionValueKind(section.type);
    if (answer.value.kind !== expectedKind) return `History answer ${answer.id} has the wrong value type for ${section.type}.`;
    if (section.catalog && !answer.optionCode) return `History answer ${answer.id} is missing its catalog option.`;
    if (!section.catalog && answer.optionCode) return `History answer ${answer.id} cannot name a catalog option.`;
    if (section.per_eye && !answer.eye) return `History answer ${answer.id} requires an eye for this section.`;
    if (answer.eye && !section.per_eye) return `History answer ${answer.id} cannot name an eye for this section.`;
  }
  return undefined;
}

function sectionValueKind(sectionType: HistoryTemplate["sections"][number]["type"]): HistoryTemplateAnswer["value"]["kind"] {
  if (sectionType === "symptoms" || sectionType === "quality" || sectionType === "risk_factors" || sectionType === "treatment" || sectionType === "presents_for") return "tri-state";
  if (sectionType === "presentation" || sectionType === "single_select") return "selection";
  return sectionType;
}

function validateSubjectSectionAnswer(
  answer: HistoryTemplateAnswer,
  section: HistorySubjectSection["sections"][number],
): string | undefined {
  const expectedKind = sectionValueKind(section.type);
  if (answer.value.kind !== expectedKind) return `History answer ${answer.id} has the wrong value type for ${section.type}.`;
  if (section.type === "single_select") {
    if (answer.value.kind !== "selection") {
      return `History answer ${answer.id} has an invalid selection for ${section.type}.`;
    }
    if (!section.catalog || answer.optionCode || answer.eye) {
      return `History answer ${answer.id} has an invalid selection for ${section.type}.`;
    }
    const selectionCode = answer.value.code;
    if (!HISTORY_OPTION_CATALOGS[section.catalog]?.some((option) => option.code === selectionCode)) {
      return `History answer ${answer.id} has an invalid selection for ${section.type}.`;
    }
    return undefined;
  }
  if (!section.catalog) {
    if (answer.optionCode) return `History answer ${answer.id} cannot name a catalog option.`;
    if (answer.eye) return `History answer ${answer.id} cannot name an eye for this section.`;
    return undefined;
  }
  if (!answer.optionCode) return `History answer ${answer.id} is missing its catalog option.`;
  const option = HISTORY_OPTION_CATALOGS[section.catalog]?.find((candidate) => candidate.code === answer.optionCode);
  if (!option) return `History answer ${answer.id} names an unknown catalog option.`;
  if (answer.value.kind === "tri-state" && answer.value.note !== undefined && option.note_on_positive !== true) {
    return `History answer ${answer.id} names an option that does not allow notes.`;
  }
  const perEye = option.per_eye ?? section.per_eye ?? false;
  if (perEye && !answer.eye) return `History answer ${answer.id} requires an eye for this option.`;
  if (!perEye && answer.eye) return `History answer ${answer.id} cannot name an eye for this option.`;
  return undefined;
}

function templateNarratives(
  complaints: Awaited<ReturnType<FhirEncounterComplaintStore["listByEncounter"]>>,
  answers: HistoryTemplateAnswer[],
): Array<{ complaintId: string; narrative: string }> {
  return complaints.flatMap((complaint) => {
    const complaintAnswers = answers.filter((answer) => answer.complaintId === complaint.id);
    const templateKey = complaintAnswers[0]?.templateKey;
    const template = HISTORY_TEMPLATES.find((candidate) => candidate.complaint === templateKey);
    return template ? [{
      complaintId: complaint.id,
      narrative: renderComplaintNarrative(complaint, undefined, { template, answers: complaintAnswers }),
    }] : [];
  });
}

function validateRos(flags: z.infer<typeof rosFlagSchema>[], definition: ClinicalFindingDefinition): string | undefined {
  const field = asRecord(asRecord(definition.valueSchema.fields).reviewOfSystems);
  const options = Array.isArray(field.options) ? field.options.map(asRecord) : [];
  const byCode = new Map(options.flatMap((option) =>
    typeof option.code === "string" && typeof option.category === "string"
      ? [[option.code, option] as const]
      : []
  ));
  for (const flag of flags) {
    const option = byCode.get(flag.code);
    if (!option) {
      if (flag.code.startsWith("custom-") && flag.category === "general") continue;
      return `Review-of-systems flag ${flag.code} is unknown or inactive.`;
    }
    if (option.active === false) return `Review-of-systems flag ${flag.code} is unknown or inactive.`;
    if (option.category !== flag.category) return `Review-of-systems flag ${flag.code} has the wrong category.`;
  }
  return undefined;
}

function resolveHpiDefinition(suppliedDefinitions: ClinicalFindingDefinition[] | undefined): ClinicalFindingDefinition {
  const definitions = suppliedDefinitions ?? [buildHpiFindingDefinition({
    source: "manual",
    recordedAt: new Date(0).toISOString(),
    actorReference: "Practitioner/odos-system",
  })];
  const definition = definitions.find((candidate) => candidate.stableKey === HPI_STABLE_KEY);
  if (!definition) throw new Error("HPI finding definition seed is missing.");
  return definition;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1_$2").replaceAll("-", "_").toUpperCase();
}

function normalizePlanText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function historyAnswerId(complaintId: string, sectionId: string, optionCode?: string, eye?: HistoryTemplateAnswer["eye"]): string {
  return `history-${complaintId}-${sectionId}-${optionCode ?? "value"}${eye ? `-${eye}` : ""}`;
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function resourceReference(id: string | undefined, fallbackId: string | undefined): string {
  const resolvedId = id ?? fallbackId;
  if (!resolvedId) throw new Error("Observation create response did not include an id.");
  return `Observation/${resolvedId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readId(params: unknown, key: string): string | undefined {
  const value = asRecord(params)[key];
  return typeof value === "string" && /^[A-Za-z0-9.-]+$/.test(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function historySearchResult(run: () => Promise<{ status: number; body: unknown }>): Promise<{ status: number; body: unknown }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FhirSearchLimitError || error instanceof FhirSearchPageLimitError) {
      return { status: error.status, body: { error: error.message } };
    }
    throw error;
  }
}
