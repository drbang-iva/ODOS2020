import { isDeepStrictEqual } from "node:util";
import type { Bundle, Encounter, Observation, Resource, ServiceRequest } from "@medplum/fhirtypes";
import { resolveVisitTypeCategoryForEncounter } from "../clinic/clinic-summary.js";
import { searchAll } from "../fhir-search.js";
import { ODOS_OPHTHALMOLOGY_CODE_SYSTEM } from "../fhir/ophthalmology/codeBindings.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../fhir/schedulingVisitType.js";
import { normalizeObservationExamState } from "./exam-overview-projection.js";

export const ANNUAL_RECALL_CODE_SYSTEM =
  "https://odos2020.com/fhir/CodeSystem/odos-protocol-module";
export const ANNUAL_RECALL_SOURCE_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/annual-recall-source";
export const ANNUAL_RECALL_PATIENT_IDENTIFIER_SYSTEM =
  "https://odos2020.com/fhir/NamingSystem/annual-recall-patient";

const FULL_EXAM_VISIT_TYPE_CODES = new Set([
  "comprehensive",
  "routine-exam-new",
  "routine-exam-established",
  "medicaid-exam",
  "contact-lens-exam",
]);
const PRIMARY_REFRACTION_TYPES = new Set(["MANIFEST", "CYCLOPLEGIC", "FINAL_RX"]);
const REFRACTION_MEASUREMENT_CODES = new Set([
  "SPHERE",
  "CYLINDER",
  "AXIS",
  "ADD",
  "PRISM_AMOUNT",
  "PRISM_BASE",
]);

export interface AnnualRecallClosureFailure {
  serviceRequestReference: string;
  message: string;
}

export interface AnnualRecallMaterializationResult {
  fullExam?: boolean;
  serviceRequestReference?: string;
  completedReferences?: string[];
  closureFailures?: AnnualRecallClosureFailure[];
  materializationRefusal?: {
    code: "ANNUAL_RECALL_MATERIALIZATION_FAILED" | "ANNUAL_RECALL_CLOSURE_INCOMPLETE";
    message: string;
  };
}

export interface AnnualRecallFhir {
  readonly baseUrl: string;
  read<T extends Resource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends Resource>(resourceType: T["resourceType"], params?: Record<string, string>): Promise<Bundle<T>>;
  searchUrl?<T extends Resource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  create<T extends ServiceRequest>(resource: T, headers?: Record<string, string>): Promise<T>;
  update<T extends ServiceRequest>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    headers?: Record<string, string>,
  ): Promise<T>;
}

export async function materializeAnnualRecallOnSign(
  fhir: AnnualRecallFhir,
  encounterId: string,
  authoredOn: string,
): Promise<AnnualRecallMaterializationResult> {
  const encounter = await fhir.read<Encounter>("Encounter", encounterId);
  const patientReference = encounter.subject?.reference;
  const patientId = patientReference?.match(/^Patient\/([A-Za-z0-9.-]+)$/)?.[1];
  if (!patientId) {
    throw new Error("Annual recall requires an Encounter with a local Patient subject.");
  }
  const encounterReference = `Encounter/${encounterId}`;
  const observations = (await searchAll<Observation>(
    fhir,
    "Observation",
    { encounter: encounterReference },
    { maxRows: 500 },
  )).filter((observation) => observation.subject?.reference === patientReference);
  if (!await isFullEyeExam(fhir, encounter, observations)) {
    return { fullExam: false };
  }

  const serviceDate = encounter.period?.start;
  if (!serviceDate) {
    throw new Error("Annual recall requires Encounter.period.start as the service date.");
  }
  const sourceIdentifierValue = `${patientId}:${encounterId}`;
  const intended = annualServiceRequest({
    patientId,
    encounterId,
    authoredOn,
    occurrenceDateTime: addCalendarMonths(serviceDate, 12),
    sourceIdentifierValue,
  });
  const saved = await fhir.create(intended, {
    "X-ODOS-Source": "annual-recall",
    "If-None-Exist": `identifier=${ANNUAL_RECALL_SOURCE_IDENTIFIER_SYSTEM}|${sourceIdentifierValue}`,
  });
  if (!saved.id) {
    throw new Error("Annual recall ServiceRequest was saved without an id.");
  }
  const currentId = saved.id;
  const savedReference = `ServiceRequest/${currentId}`;
  if (saved.status === "active" && !Object.entries(intended).every(([key, value]) =>
    isDeepStrictEqual((saved as unknown as Record<string, unknown>)[key], value)
  )) {
    await fhir.update("ServiceRequest", currentId, { ...saved, ...intended }, { "X-ODOS-Source": "annual-recall" });
  }

  const activeAnnuals = await searchAll<ServiceRequest>(fhir, "ServiceRequest", {
    patient: patientId,
    code: `${ANNUAL_RECALL_CODE_SYSTEM}|annual-recall`,
    status: "active",
  }, { maxRows: 100 });
  const datedAnnuals = await Promise.all(activeAnnuals.map(async (request) => ({
    request,
    serviceDate: await sourceServiceDate(fhir, request, encounterReference, serviceDate),
  })));
  if (datedAnnuals.length === 0) {
    return { fullExam: true, serviceRequestReference: savedReference, completedReferences: [] };
  }
  const retained = datedAnnuals.slice(1).reduce(
    (latest, candidate) => isLaterAnnual(candidate, latest) ? candidate : latest,
    datedAnnuals[0]!,
  );
  const retainedId = retained.request.id ?? currentId;
  const completedReferences: string[] = [];
  const closureFailures: AnnualRecallClosureFailure[] = [];
  const failedAnnuals: ServiceRequest[] = [];
  for (const prior of activeAnnuals) {
    if (!prior.id || prior.id === retainedId) continue;
    const serviceRequestReference = `ServiceRequest/${prior.id}`;
    try {
      await fhir.update(
        "ServiceRequest",
        prior.id,
        { ...prior, status: "completed" },
        { "X-ODOS-Source": "annual-recall" },
      );
      completedReferences.push(serviceRequestReference);
    } catch (error) {
      failedAnnuals.push(prior);
      closureFailures.push({
        serviceRequestReference,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const serviceRequestReference = `ServiceRequest/${retainedId}`;
  if (closureFailures.length === 0) {
    return { fullExam: true, serviceRequestReference, completedReferences };
  }
  const message = `The new annual recall was created, but ${closureFailures.length} prior annual${closureFailures.length === 1 ? "" : "s"} could not be completed.`;
  const visibleNote = `Annual recall closure incomplete: ${closureFailures.length} other active annual${closureFailures.length === 1 ? "" : "s"} could not be completed.`;
  for (const failed of failedAnnuals) {
    if (!failed.id) continue;
    try {
      await appendVisibleNote(fhir, failed.id, visibleNote);
    } catch {}
  }
  try {
    await appendVisibleNote(fhir, retainedId, visibleNote);
  } catch {
    // The handler response below remains the authoritative observable refusal if annotation also fails.
  }
  return {
    fullExam: true,
    serviceRequestReference,
    completedReferences,
    closureFailures,
    materializationRefusal: {
      code: "ANNUAL_RECALL_CLOSURE_INCOMPLETE",
      message,
    },
  };
}

async function sourceServiceDate(
  fhir: AnnualRecallFhir,
  request: ServiceRequest,
  currentEncounterReference: string,
  currentServiceDate: string,
): Promise<string | undefined> {
  const reference = request.encounter?.reference;
  if (reference === currentEncounterReference) return currentServiceDate;
  const encounterId = reference?.match(/^Encounter\/([A-Za-z0-9.-]+)$/)?.[1];
  if (!encounterId) return undefined;
  try {
    return (await fhir.read<Encounter>("Encounter", encounterId)).period?.start;
  } catch {
    return undefined;
  }
}

function isLaterAnnual(
  candidate: { request: ServiceRequest; serviceDate?: string },
  latest: { request: ServiceRequest; serviceDate?: string },
): boolean {
  const candidateTime = candidate.serviceDate ? Date.parse(candidate.serviceDate) : Number.NaN;
  const latestTime = latest.serviceDate ? Date.parse(latest.serviceDate) : Number.NaN;
  if (Number.isFinite(candidateTime) !== Number.isFinite(latestTime)) return Number.isFinite(candidateTime);
  if (Number.isFinite(candidateTime) && Number.isFinite(latestTime) && candidateTime !== latestTime) {
    return candidateTime > latestTime;
  }
  const candidateDue = candidate.request.occurrenceDateTime ?? "";
  const latestDue = latest.request.occurrenceDateTime ?? "";
  if (candidateDue !== latestDue) return candidateDue > latestDue;
  const candidateReference = candidate.request.encounter?.reference ?? candidate.request.id ?? "";
  const latestReference = latest.request.encounter?.reference ?? latest.request.id ?? "";
  return candidateReference > latestReference;
}

function appendNote(request: ServiceRequest, text: string): ServiceRequest {
  if (request.note?.some((note) => note.text === text)) return request;
  return { ...request, note: [...(request.note ?? []), { text }] };
}

async function appendVisibleNote(
  fhir: AnnualRecallFhir,
  id: string,
  text: string,
): Promise<void> {
  const latest = await fhir.read<ServiceRequest>("ServiceRequest", id);
  await fhir.update(
    "ServiceRequest",
    id,
    appendNote(latest, text),
    {
      "X-ODOS-Source": "annual-recall",
      ...(latest.meta?.versionId ? { "If-Match": `W/"${latest.meta.versionId}"` } : {}),
    },
  );
}

export function annualRecallMaterializationRefusal(error: unknown): AnnualRecallMaterializationResult {
  return {
    materializationRefusal: {
      code: "ANNUAL_RECALL_MATERIALIZATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

async function isFullEyeExam(
  fhir: AnnualRecallFhir,
  encounter: Encounter,
  observations: readonly Observation[],
): Promise<boolean> {
  const directVisitType = encounter.type
    ?.flatMap((concept) => concept.coding ?? [])
    .find((coding) => coding.system === ODOS_VISIT_TYPE_SYSTEM && coding.code)
    ?.code;
  const fullExamVisitType = directVisitType !== undefined && FULL_EXAM_VISIT_TYPE_CODES.has(directVisitType)
    ? true
    : await resolveVisitTypeCategoryForEncounter(encounter, undefined, fhir) === "comprehensive";
  if (!fullExamVisitType) return false;
  const usable = observations.filter((observation) =>
    observation.status !== "entered-in-error" && observation.status !== "cancelled"
  );
  const refractionPerformed = usable.some((observation) => {
    if (observation.code.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === "REFRACTION"
    ) !== true) return false;
    const refractionType = observation.component
      ?.find((component) => component.code.coding?.some((coding) =>
        coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code === "REFRACTION_TYPE"
      ))
      ?.valueCodeableConcept?.coding
      ?.find((coding) => coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM && coding.code)
      ?.code;
    return refractionType !== undefined && PRIMARY_REFRACTION_TYPES.has(refractionType) &&
      observation.component?.some((component) => {
      const code = component.code.coding?.find((coding) => coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM)?.code;
      if (!code || !REFRACTION_MEASUREMENT_CODES.has(code)) return false;
      return component.valueQuantity?.value !== undefined ||
        component.valueCodeableConcept?.coding?.some((coding) => coding.code) === true;
      }) === true;
  });
  const examComponentPerformed = usable.some((observation) =>
    normalizeObservationExamState(observation).state === "examined" &&
    observation.code.coding?.some((coding) =>
      coding.system === ODOS_OPHTHALMOLOGY_CODE_SYSTEM &&
      (coding.code?.startsWith("ocular-health:") === true ||
        coding.code?.startsWith("optic-nerve") === true ||
        coding.code?.startsWith("gonioscopy") === true)
    ) === true
  );
  return refractionPerformed && examComponentPerformed;
}

function annualServiceRequest(input: {
  patientId: string;
  encounterId: string;
  authoredOn: string;
  occurrenceDateTime: string;
  sourceIdentifierValue: string;
}): ServiceRequest {
  return {
    resourceType: "ServiceRequest",
    status: "active",
    intent: "plan",
    subject: { reference: `Patient/${input.patientId}` },
    encounter: { reference: `Encounter/${input.encounterId}` },
    authoredOn: input.authoredOn,
    occurrenceDateTime: input.occurrenceDateTime,
    code: { coding: [{ system: ANNUAL_RECALL_CODE_SYSTEM, code: "annual-recall" }] },
    category: [{ coding: [{ system: ANNUAL_RECALL_CODE_SYSTEM, code: "routine-follow-up" }] }],
    reasonCode: [{ text: "Annual eye examination" }],
    identifier: [
      { system: ANNUAL_RECALL_SOURCE_IDENTIFIER_SYSTEM, value: input.sourceIdentifierValue },
      { system: ANNUAL_RECALL_PATIENT_IDENTIFIER_SYSTEM, value: input.patientId },
    ],
  };
}

function addCalendarMonths(value: string, months: number): string {
  const sourceDate = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!sourceDate) {
    throw new Error("Annual recall Encounter service date is invalid.");
  }
  const year = Number(sourceDate[1]);
  const month = Number(sourceDate[2]);
  const day = Number(sourceDate[3]);
  const source = new Date(Date.UTC(year, month - 1, day));
  if (source.getUTCFullYear() !== year || source.getUTCMonth() !== month - 1 || source.getUTCDate() !== day) {
    throw new Error("Annual recall Encounter service date is invalid.");
  }
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const due = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay)));
  return due.toISOString().slice(0, 10);
}
