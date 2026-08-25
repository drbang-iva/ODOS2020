import type {
  Bundle,
  CarePlan,
  ChargeItem,
  Claim,
  Condition,
  Coverage,
  CoverageEligibilityResponse,
  DocumentReference,
  Encounter,
  EpisodeOfCare,
  MedicationRequest,
  MedicationStatement,
  Observation,
  Patient,
  Procedure,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { validateLocalFhirSearchNextPath } from "../fhir-search.js";
import { buildDiagnosisCatalogSeeds } from "../clinical-graph/diagnosis-catalog-seeds.js";
import { resolveConditionCodes } from "../clinical-graph/diagnosis-code-resolution.js";
import { ICD10_CM_CODE_SYSTEM } from "../clinical-graph/glaucoma-suspect.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "../clinical-graph/diagnosis-pick-endpoint.js";
import {
  conditionEncounterId,
  FHIR_CONDITION_CATEGORY_CODE_SYSTEM,
  FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
  hasConditionCategory,
  referenceId,
} from "../fhir/condition.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../fhir/schedulingVisitType.js";
import { TOBACCO_SMOKING_STATUS_LOINC_CODE } from "../fhir/smokingStatus.js";
import { DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM } from "../fhir/dryEyeProcedure.js";
import { procedureMatchesCarePlan } from "../series-tracker/series-care-plan.js";
import {
  MIGRATION_TAG_CODE,
  MIGRATION_TAG_SYSTEM,
} from "../legacy-import/access-policy.js";
import { practiceDate } from "./clinic-summary.js";

export const PATIENT_STICKY_NOTE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/patient-sticky-note";
export const PATIENT_STICKY_NOTE_CODE = "patient-sticky-note";
export const PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/identifier/patient-sticky-note";
const ODOS_LATERALITY_SYSTEM = "https://odos2020.com/fhir/CodeSystem/laterality";

export type VisitLedgerFilter = "all" | "eye-exams" | "office-visits";

export interface PatientOverviewDiagnosis {
  conditionId: string;
  encounterId: string;
  name: string;
  code?: string;
  system?: string;
  laterality?: string;
}

export interface PatientOverviewVisit {
  encounterId: string;
  date?: string;
  provider?: string;
  facility?: string;
  visitType: string;
  status: "Preliminary" | "Final" | "Migrated";
  program?: string;
  seriesDesignation?: string;
  diagnoses: PatientOverviewDiagnosis[];
}

export interface PatientOverviewProgram {
  episodeOfCareReference: string;
  title: string;
  status: EpisodeOfCare["status"];
}

export interface PatientOverviewVisitDetailCard {
  id: string;
  kicker: string;
  title: string;
  detail?: string;
  values?: Array<{ label: string; value: string }>;
}

export interface PatientOverviewVisitDetailGroup {
  summary?: string;
  cards: PatientOverviewVisitDetailCard[];
  unavailable?: string;
}

export interface PatientOverviewVisitDetail {
  encounterId: string;
  reason?: string;
  iop: PatientOverviewVisitDetailGroup;
  findings: PatientOverviewVisitDetailGroup;
  medications: PatientOverviewVisitDetailGroup;
  plan: PatientOverviewVisitDetailGroup;
  financial: PatientOverviewVisitDetailGroup;
}

export interface PatientOverviewMedication {
  id?: string;
  name: string;
  sig?: string;
}

export type BillingWeatherState = "covered" | "high-deductible" | "self-pay" | "vip-cash" | "unknown";

export interface PatientOverviewBillingWeather {
  state: BillingWeatherState;
  planName?: string;
  deductibleRemainingCents?: number;
}

export interface PatientOverviewPayload {
  patient: Patient;
  insurance: string[];
  billingWeather: PatientOverviewBillingWeather;
  unavailable?: { insurance?: string; medicationOrders?: string };
  stickyNote?: { id: string; text: string; editedAt?: string; editedBy?: string };
  snapshot: {
    ocularHistory: Array<{ id?: string; name: string; laterality?: string }>;
    ocularSurgicalHistory: Array<{ id?: string; name: string; date?: string }>;
    medicalConditions: Array<{ id?: string; name: string }>;
    socialHistory: string[];
    ophthalmicMedications: PatientOverviewMedication[];
    systemicMedications: PatientOverviewMedication[];
  };
  programs: PatientOverviewProgram[];
  visits: PatientOverviewVisit[];
  diagnosisChoices: Array<{ name: string; code: string; system: string }>;
}

export interface StickyNoteHistoryEntry {
  versionId: string;
  text: string;
  editedAt?: string;
  editedBy?: string;
}

export type OverviewFhir = Pick<MedplumClient, "read" | "search" | "searchUrl" | "history" | "create" | "update"> & {
  readonly baseUrl: string;
};

export class StickyNoteValidationError extends Error {}
export class PatientOverviewVisitNotFoundError extends Error {}

const EYE_EXAM_VISIT_CODES = ["routine-exam-new", "routine-exam-established", "medicaid-exam"];
const ENCOUNTER_LEDGER_CONDITION_CATEGORIES = ["encounter-diagnosis", "problem-list-item"]
  .map((code) => `${FHIR_CONDITION_CATEGORY_CODE_SYSTEM}|${code}`)
  .join(",");
const CONFIRMED_CONDITION_VERIFICATION_STATUS =
  `${FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM}|confirmed`;
const ENCOUNTER_LEDGER_CONDITION_BATCH_SIZE = 50;
const CONDITION_SUMMARY_ENCOUNTER_LIMIT = 3;

export async function loadPatientOverview(
  fhir: OverviewFhir,
  patientId: string,
  options: { filter?: VisitLedgerFilter; diagnosisSystem?: string; diagnosisCode?: string; now?: string; timeZone?: string } = {},
): Promise<PatientOverviewPayload> {
  const patientReference = `Patient/${patientId}`;
  const filter = options.filter ?? "all";
  const encounterParams: Record<string, string> = {
    patient: patientId,
    _count: "100",
    _sort: "-date",
  };
  if (filter === "eye-exams") {
    encounterParams.type = EYE_EXAM_VISIT_CODES.map((code) => `${ODOS_VISIT_TYPE_SYSTEM}|${code}`).join(",");
  } else if (filter === "office-visits") {
    encounterParams.type = `${ODOS_VISIT_TYPE_SYSTEM}|office-visit`;
  }

  const diagnosisCode = options.diagnosisSystem && options.diagnosisCode
    ? `${options.diagnosisSystem}|${options.diagnosisCode}`
    : undefined;

  const [
    patient,
    coverageResult,
    eligibilityResult,
    stickyNote,
    problemConditions,
    procedures,
    carePlans,
    episodesOfCare,
    medicationStatements,
    medicationRequestResult,
    smokingStatuses,
    diagnosisMatches,
  ] = await Promise.all([
    fhir.read<Patient>("Patient", patientId),
    optionalSearchAll<Coverage>(fhir, "Coverage", { beneficiary: patientReference, status: "active", _count: "100" }),
    optionalSearchAll<CoverageEligibilityResponse>(fhir, "CoverageEligibilityResponse", { patient: patientReference, _count: "100", _sort: "-created" }),
    findPatientStickyNote(fhir, patientId, true),
    searchAll<Condition>(fhir, "Condition", { patient: patientId, category: "problem-list-item", _count: "100" }),
    searchAll<Procedure>(fhir, "Procedure", { patient: patientId, _count: "100", _sort: "-date" }),
    searchAll<CarePlan>(fhir, "CarePlan", { patient: patientId, _count: "100" }),
    searchAll<EpisodeOfCare>(fhir, "EpisodeOfCare", { patient: patientReference, _count: "100" }),
    searchAll<MedicationStatement>(fhir, "MedicationStatement", { patient: patientId, status: "active", _count: "100" }),
    optionalSearchAll<MedicationRequest>(fhir, "MedicationRequest", { patient: patientId, status: "active", _count: "100" }),
    searchAll<Observation>(fhir, "Observation", { patient: patientId, code: TOBACCO_SMOKING_STATUS_LOINC_CODE, _count: "1", _sort: "-date" }),
    diagnosisCode
      ? searchAll<Condition>(fhir, "Condition", {
          patient: patientId,
          category: ENCOUNTER_LEDGER_CONDITION_CATEGORIES,
          code: diagnosisCode,
          "verification-status": CONFIRMED_CONDITION_VERIFICATION_STATUS,
          _count: "100",
        })
      : Promise.resolve(undefined),
  ]);
  const diagnosisEncounterIds = diagnosisMatches
    ? unique(diagnosisMatches.flatMap((condition) => conditionEncounterId(condition) ?? []))
    : undefined;
  if (diagnosisEncounterIds && diagnosisEncounterIds.length === 0) {
    const summaryEncounters = await searchAll<Encounter>(fhir, "Encounter", {
      patient: patientId,
      _count: "100",
      _sort: "-date",
    });
    return projectOverview({
      patient,
      coverages: coverageResult.resources,
      eligibilityResponses: eligibilityResult.resources,
      unavailable: unavailableSources(coverageResult.available, medicationRequestResult.available),
      stickyNote,
      problemConditions,
      procedures,
      carePlans,
      episodesOfCare,
      medicationStatements,
      medicationRequests: medicationRequestResult.resources,
      smokingStatuses,
      summaryEncounters,
      encounters: [],
      encounterDiagnoses: [],
      asOfDate: practiceDate(options.now ?? new Date().toISOString(), options.timeZone ?? "UTC"),
      timeZone: options.timeZone,
    });
  }
  if (diagnosisEncounterIds) {
    delete encounterParams.type;
    encounterParams._id = diagnosisEncounterIds.join(",");
  }
  const encounters = await searchAll<Encounter>(fhir, "Encounter", encounterParams);
  const summaryEncounters = filter === "all" && !diagnosisEncounterIds
    ? encounters
    : await searchAll<Encounter>(fhir, "Encounter", { patient: patientId, _count: "100", _sort: "-date" });
  const encounterReferenceList = encounters.flatMap((encounter) =>
    encounter.id ? [`Encounter/${encounter.id}`] : [],
  );
  const encounterReferences = new Set(encounterReferenceList);
  const encounterDiagnoses = encounterReferenceList.length
    ? uniqueBy((await Promise.all(Array.from(
        { length: Math.ceil(encounterReferenceList.length / ENCOUNTER_LEDGER_CONDITION_BATCH_SIZE) },
        (_, batchIndex) => searchAll<Condition>(fhir, "Condition", {
          patient: patientId,
          category: ENCOUNTER_LEDGER_CONDITION_CATEGORIES,
          encounter: encounterReferenceList
            .slice(
              batchIndex * ENCOUNTER_LEDGER_CONDITION_BATCH_SIZE,
              (batchIndex + 1) * ENCOUNTER_LEDGER_CONDITION_BATCH_SIZE,
            )
            .join(","),
          "verification-status": CONFIRMED_CONDITION_VERIFICATION_STATUS,
          ...(diagnosisCode ? { code: diagnosisCode } : {}),
          _count: "100",
        }),
      ))).flat(), (condition) => condition.id ?? "")
    : [];
  const provenances = encounters.length
    ? (await searchAll<Provenance>(fhir, "Provenance", {
        patient: patientReference,
        _count: "100",
        _sort: "recorded",
      })).filter((provenance) => provenance.target.some((target) =>
        encounterReferences.has(target.reference ?? ""),
      ))
    : [];

  return projectOverview({
    patient,
    coverages: coverageResult.resources,
    eligibilityResponses: eligibilityResult.resources,
    unavailable: unavailableSources(coverageResult.available, medicationRequestResult.available),
    stickyNote,
    problemConditions,
    procedures,
    carePlans,
    episodesOfCare,
    medicationStatements,
    medicationRequests: medicationRequestResult.resources,
    smokingStatuses,
    summaryEncounters,
    encounters,
    encounterDiagnoses,
    provenances,
    asOfDate: practiceDate(options.now ?? new Date().toISOString(), options.timeZone ?? "UTC"),
    timeZone: options.timeZone,
  });
}

export async function loadPatientOverviewVisitDetail(
  fhir: OverviewFhir,
  patientId: string,
  encounterId: string,
): Promise<PatientOverviewVisitDetail> {
  let encounter: Encounter;
  try {
    encounter = await fhir.read<Encounter>("Encounter", encounterId);
  } catch (error) {
    if (Number((error as { status?: unknown }).status) === 404) {
      throw new PatientOverviewVisitNotFoundError("Visit was not found for this patient.");
    }
    throw error;
  }
  if (encounter.subject?.reference !== `Patient/${patientId}`) {
    throw new PatientOverviewVisitNotFoundError("Visit was not found for this patient.");
  }

  const patientReference = `Patient/${patientId}`;
  const encounterReference = `Encounter/${encounterId}`;
  const [observations, medicationRequests, carePlans, claimResult, chargeItemResult] = await Promise.all([
    searchAll<Observation>(fhir, "Observation", { patient: patientId, encounter: encounterId, _count: "200" }),
    searchAll<MedicationRequest>(fhir, "MedicationRequest", { patient: patientId, encounter: encounterId, _count: "200" }),
    searchAll<CarePlan>(fhir, "CarePlan", { patient: patientId, encounter: encounterId, _count: "200" }),
    optionalSearchAll<Claim>(fhir, "Claim", { patient: patientReference, encounter: encounterReference, _count: "200" }),
    optionalSearchAll<ChargeItem>(fhir, "ChargeItem", { subject: patientReference, context: encounterReference, _count: "200" }),
  ]);

  return projectVisitDetail({
    encounter,
    observations,
    medicationRequests,
    carePlans,
    claims: claimResult.resources.filter((claim) => claimMatchesEncounter(claim, encounterReference)),
    chargeItems: chargeItemResult.resources.filter((chargeItem) => chargeItem.context?.reference === encounterReference),
    claimsAvailable: claimResult.available,
    chargeItemsAvailable: chargeItemResult.available,
  });
}

export async function savePatientStickyNote(
  fhir: OverviewFhir,
  input: { patientId: string; text: string; authorReference: string; now?: string },
): Promise<PatientOverviewPayload["stickyNote"]> {
  const text = input.text.trim();
  if (!text) throw new StickyNoteValidationError("Sticky note text is required.");
  if (text.length > 2000) throw new StickyNoteValidationError("Sticky note text cannot exceed 2000 characters.");
  const existing = await findPatientStickyNote(fhir, input.patientId);
  const resource = buildStickyNote({
    patientId: input.patientId,
    text,
    authorReference: input.authorReference,
    now: input.now ?? new Date().toISOString(),
    existing,
  });
  let saved = existing?.id
    ? await fhir.update<DocumentReference>(
        "DocumentReference",
        existing.id,
        resource,
        existing.meta?.versionId ? { "If-Match": `W/\"${existing.meta.versionId}\"` } : undefined,
      )
    : await fhir.create<DocumentReference>(resource, {
        "If-None-Exist": `identifier=${PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM}|${input.patientId}`,
      });
  if (stickyNoteText(saved) !== text && saved.id) {
    saved = await fhir.update<DocumentReference>(
      "DocumentReference",
      saved.id,
      buildStickyNote({
        patientId: input.patientId,
        text,
        authorReference: input.authorReference,
        now: input.now ?? new Date().toISOString(),
        existing: saved,
      }),
      saved.meta?.versionId ? { "If-Match": `W/\"${saved.meta.versionId}\"` } : undefined,
    );
  }
  return stickyNoteSummary(saved);
}

export async function loadPatientStickyNoteHistory(
  fhir: OverviewFhir,
  patientId: string,
): Promise<StickyNoteHistoryEntry[]> {
  const note = await findPatientStickyNote(fhir, patientId);
  if (!note) return [];
  if (!note.id) throw new Error("Patient sticky-note resource is missing its id.");
  const resources: DocumentReference[] = [];
  let bundle = await fhir.history<DocumentReference>("DocumentReference", note.id, { _count: "100" });
  while (true) {
    resources.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) break;
    if (!fhir.searchUrl) throw new Error("Sticky-note history requires pagination support.");
    bundle = await fhir.searchUrl<DocumentReference>(next, "DocumentReference");
  }
  return resources.flatMap((resource): StickyNoteHistoryEntry[] => {
    const versionId = resource?.meta?.versionId;
    if (!resource || !versionId) return [];
    return [{
      versionId,
      text: stickyNoteText(resource),
      ...(resource.meta?.lastUpdated ? { editedAt: resource.meta.lastUpdated } : {}),
      ...(resource.author?.[0]?.display ?? resource.author?.[0]?.reference
        ? { editedBy: resource.author[0]?.display ?? resource.author[0]?.reference }
        : {}),
    }];
  });
}

export function buildStickyNote(input: {
  patientId: string;
  text: string;
  authorReference: string;
  now: string;
  existing?: DocumentReference;
}): DocumentReference {
  return {
    resourceType: "DocumentReference",
    ...(input.existing?.id ? { id: input.existing.id } : {}),
    ...(input.existing?.meta ? { meta: input.existing.meta } : {}),
    status: "current",
    identifier: [{ system: PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM, value: input.patientId }],
    type: {
      coding: [{ system: PATIENT_STICKY_NOTE_SYSTEM, code: PATIENT_STICKY_NOTE_CODE, display: "Patient sticky note" }],
      text: "Patient sticky note",
    },
    subject: { reference: `Patient/${input.patientId}` },
    date: input.now,
    author: [{ reference: input.authorReference }],
    description: "Patient sticky note",
    content: [{ attachment: { contentType: "text/plain; charset=utf-8", data: Buffer.from(input.text, "utf8").toString("base64"), title: "Patient sticky note" } }],
  };
}

function projectOverview(input: {
  patient: Patient;
  coverages: Coverage[];
  eligibilityResponses: CoverageEligibilityResponse[];
  unavailable?: PatientOverviewPayload["unavailable"];
  stickyNote?: DocumentReference;
  problemConditions: Condition[];
  procedures: Procedure[];
  carePlans: CarePlan[];
  episodesOfCare: EpisodeOfCare[];
  medicationStatements: MedicationStatement[];
  medicationRequests: MedicationRequest[];
  smokingStatuses: Observation[];
  summaryEncounters: Encounter[];
  encounters: Encounter[];
  encounterDiagnoses: Condition[];
  provenances?: Provenance[];
  asOfDate: string;
  timeZone?: string;
}): PatientOverviewPayload {
  const recentEncounterRanks = new Map(
    [...input.summaryEncounters]
      .sort((left, right) => encounterTime(right) - encounterTime(left))
      .slice(0, CONDITION_SUMMARY_ENCOUNTER_LIMIT)
      .flatMap((encounter, index) => encounter.id ? [[encounter.id, index] as const] : []),
  );
  const problemConditions = uniqueConditions(input.problemConditions
    .filter((condition) =>
      hasConditionCategory(condition, "problem-list-item")
        && !hasStatus(condition.verificationStatus, "entered-in-error"),
    )
    .flatMap((condition) => {
      if (!condition.encounter?.reference) return [{ condition, encounterRank: -1 }];
      const encounterId = conditionEncounterId(condition);
      const encounterRank = encounterId ? recentEncounterRanks.get(encounterId) : undefined;
      return encounterRank === undefined ? [] : [{ condition, encounterRank }];
    })
    .sort((left, right) => left.encounterRank - right.encounterRank)
    .map(({ condition }) => condition));
  const ocular = problemConditions.filter(isOcularCondition);
  const medical = problemConditions.filter((condition) => !isOcularCondition(condition));
  const allMedications = [
    ...input.medicationStatements.map((resource) => ({
      id: resource.id,
      name: conceptText(resource.medicationCodeableConcept),
      sig: resource.dosage?.[0]?.text,
      ophthalmic: isOphthalmicRoute(resource.dosage?.[0]?.route, resource.dosage?.[0]?.text),
    })),
    ...input.medicationRequests.map((resource) => ({
      id: resource.id,
      name: conceptText(resource.medicationCodeableConcept),
      sig: resource.dosageInstruction?.[0]?.text,
      ophthalmic: isOphthalmicRoute(resource.dosageInstruction?.[0]?.route, resource.dosageInstruction?.[0]?.text),
    })),
  ].filter((medication) => medication.name);
  const diagnoses = input.encounterDiagnoses.filter(isConfirmedEncounterCondition);
  const signedEncounterIds = signedEncounters(input.encounters, input.provenances ?? []);
  const programTitles = new Map<string, string>(input.episodesOfCare.flatMap((episode) =>
    episode.id ? [[`EpisodeOfCare/${episode.id}`, conceptText(episode.type?.[0]) || "Program"] as const] : []
  ));
  const seriesCarePlans = new Map<string, CarePlan>(input.carePlans.flatMap((carePlan) =>
    carePlan.id
    && carePlan.instantiatesCanonical?.some((canonical) => canonical.includes("/PlanDefinition/series-protocol-"))
      ? [[`CarePlan/${carePlan.id}`, carePlan] as const]
      : []
  ));
  const byEncounter = new Map<string, PatientOverviewDiagnosis[]>();
  for (const condition of diagnoses) {
    const encounterId = conditionEncounterId(condition);
    if (!encounterId || !condition.id) continue;
    const coding = condition.code?.coding?.find((candidate) => candidate.code);
    const resolvedCode = resolvedDiagnosisCode(condition);
    const row: PatientOverviewDiagnosis = {
      conditionId: condition.id,
      encounterId,
      name: conceptText(condition.code) || "Diagnosis recorded",
      ...(resolvedCode ? { code: resolvedCode, system: ICD10_CM_CODE_SYSTEM } : {
        ...(coding?.code ? { code: coding.code } : {}),
        ...(coding?.system ? { system: coding.system } : {}),
      }),
      ...(condition.bodySite?.[0]?.text ? { laterality: condition.bodySite[0].text } : {}),
    };
    byEncounter.set(encounterId, [...(byEncounter.get(encounterId) ?? []), row]);
  }

  return {
    patient: input.patient,
    insurance: [...input.coverages]
      .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
      .map((coverage) => coverage.payor?.[0]?.display ?? coverage.class?.find((row) => row.name)?.name ?? "Coverage recorded"),
    billingWeather: deriveBillingWeather(input.coverages, input.eligibilityResponses, input.asOfDate, input.timeZone),
    ...(input.unavailable && Object.keys(input.unavailable).length ? { unavailable: input.unavailable } : {}),
    ...(input.stickyNote ? { stickyNote: stickyNoteSummary(input.stickyNote) } : {}),
    snapshot: {
      ocularHistory: ocular.map((condition) => ({
        ...(condition.id ? { id: condition.id } : {}),
        name: conceptText(condition.code) || "Condition recorded",
        ...(condition.bodySite?.[0]?.text ? { laterality: condition.bodySite[0].text } : {}),
      })),
      ocularSurgicalHistory: input.procedures
        .filter((procedure) => procedure.status !== "entered-in-error" && isOcularBodySite(procedure.bodySite))
        .map((procedure) => ({
          ...(procedure.id ? { id: procedure.id } : {}),
          name: conceptText(procedure.code) || "Procedure recorded",
          ...(procedure.performedDateTime ? { date: procedure.performedDateTime } : {}),
        })),
      medicalConditions: medical.map((condition) => ({
        ...(condition.id ? { id: condition.id } : {}),
        name: conceptText(condition.code) || "Condition recorded",
      })),
      socialHistory: input.smokingStatuses.flatMap((observation) => {
        const value = conceptText(observation.valueCodeableConcept);
        return value ? [value] : [];
      }),
      ophthalmicMedications: allMedications.filter((medication) => medication.ophthalmic).map(({ ophthalmic: _, ...row }) => row),
      systemicMedications: allMedications.filter((medication) => !medication.ophthalmic).map(({ ophthalmic: _, ...row }) => row),
    },
    programs: input.episodesOfCare.flatMap((episode): PatientOverviewProgram[] => episode.id && episode.status === "active" ? [{
      episodeOfCareReference: `EpisodeOfCare/${episode.id}`,
      title: conceptText(episode.type?.[0]) || "Program",
      status: episode.status,
    }] : []),
    visits: [...input.encounters]
      .sort((left, right) => encounterTime(right) - encounterTime(left))
      .flatMap((encounter): PatientOverviewVisit[] => {
        if (!encounter.id) return [];
        const designation = seriesDesignation(input.procedures, seriesCarePlans, encounter.id);
        return [{
        encounterId: encounter.id,
        ...(encounter.period?.start ?? encounter.period?.end ? { date: encounter.period?.start ?? encounter.period?.end } : {}),
        ...(encounter.participant?.[0]?.individual?.display ? { provider: encounter.participant[0].individual.display } : {}),
        ...(encounter.serviceProvider?.display ?? encounter.location?.[0]?.location?.display
          ? { facility: encounter.serviceProvider?.display ?? encounter.location?.[0]?.location?.display }
          : {}),
        visitType: conceptText(encounter.type?.[0]) || "Visit type not recorded",
        status: isMigratedEncounter(encounter)
          ? "Migrated"
          : signedEncounterIds.has(encounter.id) ? "Final" : "Preliminary",
        ...(encounter.episodeOfCare?.[0]?.reference
          ? { program: programTitles.get(encounter.episodeOfCare[0].reference) ?? "Program" }
          : {}),
        ...(designation ? { seriesDesignation: designation } : {}),
        diagnoses: byEncounter.get(encounter.id) ?? [],
        }];
      }),
    diagnosisChoices: uniqueBy(
      diagnoses.flatMap((condition) => {
        const coding = condition.code?.coding?.find((candidate) => candidate.system && candidate.code);
        return coding?.system && coding.code ? [{ name: conceptText(condition.code) || coding.display || coding.code, system: coding.system, code: coding.code }] : [];
      }),
      (row) => `${row.system}|${row.code}`,
    ),
  };
}

function seriesDesignation(
  procedures: readonly Procedure[],
  seriesCarePlans: ReadonlyMap<string, CarePlan>,
  encounterId: string,
): string | undefined {
  for (const procedure of procedures) {
    if (procedure.status === "entered-in-error"
      || procedure.encounter?.reference !== `Encounter/${encounterId}`) continue;
    for (const basedOn of procedure.basedOn ?? []) {
      const carePlanReference = basedOn.reference;
      const carePlan = carePlanReference ? seriesCarePlans.get(carePlanReference) : undefined;
      if (!carePlanReference || !carePlan || !procedureMatchesCarePlan(procedure, carePlan)) continue;
      const value = procedure.identifier?.find((identifier) =>
        identifier.system === DRY_EYE_TREATMENT_SESSION_IDENTIFIER_SYSTEM
        && identifier.value?.startsWith(`${carePlanReference}:`)
      )?.value;
      const session = value?.slice(carePlanReference.length + 1).match(/^(\d+)-of-(\d+)$/);
      const number = Number(session?.[1]);
      const total = Number(session?.[2]);
      if (!Number.isSafeInteger(number)
        || number < 1
        || total !== carePlan.activity?.length
        || number > total) continue;
      return `${carePlan.title?.trim() || "Treatment series"} · session ${number} of ${total}`;
    }
  }
  return undefined;
}

function resolvedDiagnosisCode(condition: Condition): string | undefined {
  const usesCatalogConcept = condition.code?.coding?.some((coding) =>
    coding.system === "https://odos2020.com/fhir/CodeSystem/diagnosis-catalog"
  );
  if (!usesCatalogConcept) return undefined;
  const identifierValue = condition.identifier?.find((identifier) =>
    identifier.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value;
  const parts = identifierValue?.split("::") ?? [];
  const stableKey = parts.length >= 2 ? parts.at(-2) : undefined;
  const row = stableKey
    ? buildDiagnosisCatalogSeeds().find((candidate) => candidate.stableKey === stableKey)
    : undefined;
  if (row?.bilateralResolution !== "emit-both-eyes") return undefined;
  const scope = condition.bodySite?.[0]?.text ?? parts.at(-1);
  const laterality = scope === "OD" || scope === "right"
    ? "right"
    : scope === "OS" || scope === "left"
      ? "left"
      : scope === "OU" || scope === "bilateral"
        ? "bilateral"
        : undefined;
  const codes = resolveConditionCodes(row, laterality);
  return codes.length ? codes.join(" + ") : undefined;
}

export function deriveBillingWeather(
  coverages: readonly Coverage[],
  responses: readonly CoverageEligibilityResponse[],
  asOfDate: string,
  timeZone?: string,
): PatientOverviewBillingWeather {
  const coverage = [...coverages]
    .filter((candidate) => candidate.status === "active" && candidate.id)
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))[0];
  const planName = coverage
    ? coverage.payor?.[0]?.display ?? coverage.class?.find((row) => row.name)?.name
    : undefined;
  if (!coverage?.id) return { state: "unknown" };

  const coverageReference = `Coverage/${coverage.id}`;
  const matching = responses.filter((response) => response.insurance?.some((insurance) =>
    normalizedCoverageReference(insurance.coverage.reference) === coverageReference
  ));
  const response = matching[0];
  if (!response || !Number.isFinite(Date.parse(response.created ?? ""))) {
    return { state: "unknown", ...(planName ? { planName } : {}) };
  }
  const createdDate = practiceDate(response.created, timeZone ?? "UTC");
  const insurance = response.insurance?.filter((candidate) =>
    normalizedCoverageReference(candidate.coverage.reference) === coverageReference
  );
  if (
    createdDate !== asOfDate
    || response.status !== "active"
    || response.outcome !== "complete"
    || insurance?.length !== 1
  ) {
    return { state: "unknown", ...(planName ? { planName } : {}) };
  }
  const benefit = insurance[0];
  const benefitStart = benefit.benefitPeriod?.start?.slice(0, 10);
  const benefitEnd = benefit.benefitPeriod?.end?.slice(0, 10);
  if ((benefitStart && benefitStart > asOfDate) || (benefitEnd && benefitEnd < asOfDate)) {
    return { state: "unknown", ...(planName ? { planName } : {}) };
  }
  if (benefit.inforce === false) return { state: "self-pay", ...(planName ? { planName } : {}) };
  if (benefit.inforce !== true) return { state: "unknown", ...(planName ? { planName } : {}) };

  const deductibleValues = (benefit.item ?? [])
    .flatMap((item) => (item.benefit ?? []).filter((entry) =>
      /deductible/i.test(`${item.name ?? ""} ${item.description ?? ""} ${entry.type?.text ?? ""}`)
      || entry.type?.coding?.some((coding) => coding.code?.toLowerCase() === "deductible")
    ))
    .flatMap((entry) => typeof entry.allowedMoney?.value === "number" ? [entry.allowedMoney.value] : []);
  if (deductibleValues.length !== 1 || !Number.isFinite(deductibleValues[0]) || deductibleValues[0] < 0) {
    return { state: "unknown", ...(planName ? { planName } : {}) };
  }
  const deductibleRemainingCents = Math.round(deductibleValues[0] * 100);
  return {
    state: deductibleRemainingCents === 0 ? "covered" : "high-deductible",
    ...(planName ? { planName } : {}),
    deductibleRemainingCents,
  };
}

function normalizedCoverageReference(reference: string | undefined): string | undefined {
  const match = reference?.match(/(?:^|\/)Coverage\/([^/?#]+)/);
  return match?.[1] ? `Coverage/${match[1]}` : undefined;
}

function projectVisitDetail(input: {
  encounter: Encounter;
  observations: Observation[];
  medicationRequests: MedicationRequest[];
  carePlans: CarePlan[];
  claims: Claim[];
  chargeItems: ChargeItem[];
  claimsAvailable: boolean;
  chargeItemsAvailable: boolean;
}): PatientOverviewVisitDetail {
  if (!input.encounter.id) throw new PatientOverviewVisitNotFoundError("Visit is missing its id.");
  const observations = input.observations.filter((observation) =>
    observation.status !== "cancelled" && observation.status !== "entered-in-error",
  );
  const iopObservations = observations.filter(isIopObservation);
  const findingObservations = observations.filter((observation) => !isIopObservation(observation));
  const iopCards = iopObservations.map((observation, index) => observationCard(observation, index, true));
  const findingCards = findingObservations.map((observation, index) => observationCard(observation, index, false));
  const medicationCards = input.medicationRequests
    .filter((request) => request.status !== "cancelled" && request.status !== "entered-in-error")
    .map((request, index): PatientOverviewVisitDetailCard => ({
      id: request.id ?? `medication-${index}`,
      kicker: "Medication",
      title: conceptText(request.medicationCodeableConcept) || "Medication name not recorded",
      ...(request.dosageInstruction?.[0]?.text?.trim()
        ? { detail: request.dosageInstruction[0].text.trim() }
        : request.status ? { detail: request.status } : {}),
    }));
  const planCards = input.carePlans
    .filter((plan) => !["revoked", "entered-in-error", "unknown"].includes(plan.status))
    .flatMap((plan, planIndex) => carePlanCards(plan, planIndex));
  const claimCards = input.claims.map((claim, index): PatientOverviewVisitDetailCard => ({
    id: claim.id ?? `claim-${index}`,
    kicker: "Claim",
    title: claim.insurer?.display ?? (conceptText(claim.type) || "Claim payer not recorded"),
    detail: [claim.status, moneyText(claim.total)].filter(Boolean).join(" · ") || undefined,
  }));
  const chargeCards = input.chargeItems
    .filter((chargeItem) => chargeItem.status !== "entered-in-error")
    .map((chargeItem, index): PatientOverviewVisitDetailCard => ({
      id: chargeItem.id ?? `charge-${index}`,
      kicker: "Charge",
      title: conceptText(chargeItem.code) || "Charge description not recorded",
      detail: [chargeItem.status, moneyText(chargeItem.priceOverride)].filter(Boolean).join(" · ") || undefined,
    }));
  const financialCards = [...claimCards, ...chargeCards];
  const reason = reasonText(input.encounter);
  const financialUnavailable = [
    ...(!input.claimsAvailable ? ["Claims unavailable from this session"] : []),
    ...(!input.chargeItemsAvailable ? ["Charges unavailable from this session"] : []),
  ].join(" · ") || undefined;

  return {
    encounterId: input.encounter.id,
    ...(reason ? { reason } : {}),
    iop: {
      summary: iopCards.length
        ? iopCards.map((card) => [card.kicker, card.title].filter(Boolean).join(" ")).join(" · ")
        : undefined,
      cards: iopCards,
    },
    findings: {
      summary: findingCards.length ? unique(findingCards.map((card) => card.kicker)).join(" · ") : undefined,
      cards: findingCards,
    },
    medications: {
      summary: medicationCards.length ? medicationCards.map((card) => card.title).join(" · ") : undefined,
      cards: medicationCards,
    },
    plan: {
      summary: planCards.length ? planCards.map((card) => card.title).join(" · ") : undefined,
      cards: planCards,
    },
    financial: {
      summary: financialCards.length
        ? [countLabel(claimCards.length, "claim"), countLabel(chargeCards.length, "charge")].filter(Boolean).join(" · ")
        : undefined,
      cards: financialCards,
      ...(financialUnavailable ? { unavailable: financialUnavailable } : {}),
    },
  };
}

function observationCard(
  observation: Observation,
  index: number,
  iop: boolean,
): PatientOverviewVisitDetailCard {
  const label = conceptText(observation.code) || "Finding label not recorded";
  const value = observationValueText(observation);
  const detail = [conceptText(observation.method), ...observation.interpretation?.map(conceptText) ?? []]
    .filter(Boolean)
    .join(" · ");
  const numericValues = isStructuredOctOrVisualField(observation)
    ? observationNumericValues(observation)
    : [];
  return {
    id: observation.id ?? `observation-${index}`,
    kicker: iop ? observationLaterality(observation) ?? label : label,
    title: value || "not recorded",
    ...(detail ? { detail } : {}),
    ...(numericValues.length ? { values: numericValues } : {}),
  };
}

function carePlanCards(plan: CarePlan, planIndex: number): PatientOverviewVisitDetailCard[] {
  const activities = (plan.activity ?? []).flatMap((activity, activityIndex): PatientOverviewVisitDetailCard[] => {
    const title = activity.detail?.description?.trim() || conceptText(activity.detail?.code);
    if (!title) return [];
    return [{
      id: `${plan.id ?? `plan-${planIndex}`}-activity-${activityIndex}`,
      kicker: plan.title?.trim() || "Plan",
      title,
      ...(activity.detail?.status ? { detail: activity.detail.status } : {}),
    }];
  });
  if (activities.length) return activities;
  const notes = (plan.note ?? []).flatMap((note, noteIndex): PatientOverviewVisitDetailCard[] =>
    note.text?.trim() ? [{
      id: `${plan.id ?? `plan-${planIndex}`}-note-${noteIndex}`,
      kicker: plan.title?.trim() || "Plan",
      title: note.text.trim(),
    }] : [],
  );
  if (notes.length) return notes;
  return plan.title?.trim() ? [{
    id: plan.id ?? `plan-${planIndex}`,
    kicker: "Plan",
    title: plan.title.trim(),
  }] : [];
}

function reasonText(encounter: Encounter): string | undefined {
  const reasons = unique([
    ...(encounter.reasonCode ?? []).flatMap((reason) => {
      const text = conceptText(reason).trim();
      return text ? [text] : [];
    }),
    ...(encounter.reasonReference ?? []).flatMap((reason) => {
      const display = reason.display?.trim();
      return display ? [display] : [];
    }),
  ]);
  return reasons.length ? reasons.join(" · ") : undefined;
}

function isIopObservation(observation: Observation): boolean {
  return observation.code?.coding?.some((coding) => coding.code === "INTRAOCULAR_PRESSURE") === true
    || /\b(?:intraocular pressure|iop)\b/i.test(conceptText(observation.code));
}

function isStructuredOctOrVisualField(observation: Observation): boolean {
  const identity = [
    conceptText(observation.code),
    ...observation.code?.coding?.flatMap((coding) => [coding.code, coding.display]).filter((value): value is string => Boolean(value)) ?? [],
  ].join(" ");
  return /\b(?:oct|rnfl|optical coherence tomography|visual field|perimetry)\b/i.test(identity);
}

function observationNumericValues(observation: Observation): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const topLevel = numericObservationValue(observation);
  if (topLevel) rows.push({ label: conceptText(observation.code) || "Value", value: topLevel });
  for (const component of observation.component ?? []) {
    const value = numericObservationValue(component);
    if (!value) continue;
    rows.push({ label: conceptText(component.code) || "Value", value });
  }
  return rows;
}

function numericObservationValue(value: {
  valueQuantity?: { value?: number; unit?: string; code?: string };
  valueInteger?: number;
}): string | undefined {
  if (value.valueQuantity?.value !== undefined) {
    const unit = value.valueQuantity.unit ?? value.valueQuantity.code;
    return `${value.valueQuantity.value}${unit ? ` ${unit}` : ""}`;
  }
  return value.valueInteger !== undefined ? String(value.valueInteger) : undefined;
}

function observationValueText(observation: Observation): string | undefined {
  if (observation.valueString?.trim()) return observation.valueString.trim();
  if (observation.valueQuantity?.value !== undefined) return quantityText(observation.valueQuantity);
  if (observation.valueCodeableConcept) return conceptText(observation.valueCodeableConcept) || undefined;
  if (observation.valueBoolean !== undefined) return observation.valueBoolean ? "Yes" : "No";
  if (observation.valueInteger !== undefined) return String(observation.valueInteger);
  const components = (observation.component ?? []).flatMap((component) => {
    const label = conceptText(component.code);
    const value = component.valueString?.trim()
      || (component.valueQuantity?.value !== undefined ? quantityText(component.valueQuantity) : undefined)
      || (component.valueCodeableConcept ? conceptText(component.valueCodeableConcept) : undefined)
      || (component.valueBoolean !== undefined ? (component.valueBoolean ? "Yes" : "No") : undefined)
      || (component.valueInteger !== undefined ? String(component.valueInteger) : undefined);
    return label && value ? [`${label}: ${value}`] : [];
  });
  return components.length ? components.join(" · ") : undefined;
}

function observationLaterality(observation: Observation): string | undefined {
  const odosCode = observation.bodySite?.coding?.find((coding) =>
    coding.system === ODOS_LATERALITY_SYSTEM && coding.code?.trim()
  )?.code?.trim();
  if (odosCode) return odosCode;
  const foreignDisplay = observation.bodySite?.coding?.find((coding) => coding.display?.trim())?.display?.trim();
  return foreignDisplay ?? (observation.bodySite?.text?.trim() || undefined);
}

function quantityText(quantity: { value?: number; unit?: string; code?: string }): string {
  const unit = quantity.unit ?? quantity.code;
  return `${quantity.value}${unit ? ` ${unit}` : ""}`;
}

function moneyText(money: { value?: number; currency?: string } | undefined): string | undefined {
  if (money?.value === undefined) return undefined;
  const currency = money.currency?.trim();
  return currency
    ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(money.value)
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(money.value);
}

function claimMatchesEncounter(claim: Claim, encounterReference: string): boolean {
  return claim.item?.some((item) => item.encounter?.some((encounter) => encounter.reference === encounterReference)) === true;
}

function countLabel(count: number, noun: string): string | undefined {
  return count ? `${count} ${noun}${count === 1 ? "" : "s"}` : undefined;
}

function stickyNoteSummary(resource: DocumentReference): NonNullable<PatientOverviewPayload["stickyNote"]> {
  if (!resource.id) throw new Error("Sticky-note resource is missing its id.");
  return {
    id: resource.id,
    text: stickyNoteText(resource),
    ...(resource.meta?.lastUpdated ? { editedAt: resource.meta.lastUpdated } : {}),
    ...(resource.author?.[0]?.display ?? resource.author?.[0]?.reference
      ? { editedBy: resource.author[0]?.display ?? resource.author[0]?.reference }
      : {}),
  };
}

function stickyNoteText(resource: DocumentReference): string {
  const data = resource.content?.[0]?.attachment?.data;
  return data ? Buffer.from(data, "base64").toString("utf8") : "";
}

async function searchAll<T extends Resource>(
  fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  const resources: T[] = [];
  // search-contract: patient-overview.search-resource
  let bundle: Bundle<T> = await fhir.search<T>(resourceType, params);
  while (true) {
    resources.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) return resources;
    if (!fhir.searchUrl) throw new Error(`${resourceType} patient-overview query requires pagination support.`);
    const path = validateLocalFhirSearchNextPath(next, fhir.baseUrl, resourceType);
    bundle = await fhir.searchUrl<T>(path, resourceType);
  }
}

async function optionalSearchAll<T extends Resource>(
  fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<{ resources: T[]; available: boolean }> {
  try {
    return { resources: await searchAll<T>(fhir, resourceType, params), available: true };
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    if (status === 401 || status === 403) return { resources: [], available: false };
    throw error;
  }
}

async function findPatientStickyNote(
  fhir: OverviewFhir,
  patientId: string,
  optional = false,
): Promise<DocumentReference | undefined> {
  try {
    const notes = await searchAll<DocumentReference>(fhir, "DocumentReference", {
      subject: `Patient/${patientId}`,
      identifier: `${PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM}|${patientId}`,
      _count: "2",
    });
    if (notes.length > 1) throw new Error("Patient has more than one sticky-note resource.");
    return notes[0];
  } catch (error) {
    if (!optional) throw error;
    console.error("odos-mcp: patient sticky-note lookup omitted from overview:", error);
    return undefined;
  }
}

function unavailableSources(insuranceAvailable: boolean, medicationOrdersAvailable: boolean): PatientOverviewPayload["unavailable"] {
  return {
    ...(!insuranceAvailable ? { insurance: "Insurance unavailable from this session" } : {}),
    ...(!medicationOrdersAvailable ? { medicationOrders: "Medication orders unavailable from this session" } : {}),
  };
}

function conceptText(concept: { text?: string; coding?: Array<{ display?: string; code?: string }> } | undefined): string {
  return concept?.text ?? concept?.coding?.find((coding) => coding.display)?.display ?? concept?.coding?.find((coding) => coding.code)?.code ?? "";
}

function hasStatus(concept: { coding?: Array<{ code?: string }> } | undefined, code: string): boolean {
  return concept?.coding?.some((coding) => coding.code === code) === true;
}

function isConfirmedEncounterCondition(condition: Condition): boolean {
  return (
    hasConditionCategory(condition, "encounter-diagnosis")
    || hasConditionCategory(condition, "problem-list-item")
  ) && condition.verificationStatus?.coding?.some(
    (coding) => coding.system === FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM
      && coding.code === "confirmed",
  ) === true && conditionEncounterId(condition) !== undefined;
}

function encounterTime(encounter: Encounter): number {
  const value = Date.parse(encounter.period?.start ?? encounter.period?.end ?? encounter.meta?.lastUpdated ?? "");
  return Number.isFinite(value) ? value : 0;
}

function isOcularCondition(condition: Condition): boolean {
  return isOcularBodySite(condition.bodySite);
}

function isOcularBodySite(bodySite: Array<{ text?: string }> | undefined): boolean {
  return bodySite?.some((site) => /\b(eye|eyes|ocular|od|os|ou)\b/i.test(site.text ?? "")) === true;
}

function isOphthalmicRoute(
  route: { text?: string; coding?: Array<{ code?: string; display?: string }> } | undefined,
  dosageText: string | undefined,
): boolean {
  const codedRoute = route?.coding?.flatMap((coding) => [coding.display, coding.code]).filter(Boolean).join(" ");
  return codedRoute
    ? /ophthalm|\beye\b/i.test(codedRoute)
    : /ophthalm|\beye\b|\bgtt\b|\bdrop/i.test([route?.text, dosageText].filter(Boolean).join(" "));
}

function signedEncounters(encounters: Encounter[], provenances: Provenance[]): Set<string> {
  const checkoutTimes = new Map(encounters.flatMap((encounter) =>
    encounter.id && encounter.status === "finished" && encounter.period?.end
      ? [[encounter.id, encounter.period.end] as const]
      : [],
  ));
  return new Set(provenances.flatMap((provenance) =>
    (provenance.target ?? []).flatMap((target) => {
      const encounterId = referenceId(target.reference, "Encounter");
      const checkoutAt = encounterId ? checkoutTimes.get(encounterId) : undefined;
      return encounterId && checkoutAt && sameInstant(provenance.recorded, checkoutAt) ? [encounterId] : [];
    }),
  ));
}

function sameInstant(left: string | undefined, right: string): boolean {
  const leftMs = Date.parse(left ?? "");
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

export function isMigratedEncounter(encounter: Encounter): boolean {
  return encounter.meta?.tag?.some((tag) =>
    tag.system === MIGRATION_TAG_SYSTEM && tag.code === MIGRATION_TAG_CODE
  ) === true;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function uniqueConditions(conditions: Condition[]): Condition[] {
  const seen = new Set<string>();
  return conditions.filter((condition) => {
    const codingSet = unique(condition.code?.coding?.flatMap((coding) =>
      coding.code ? [`${coding.system ?? ""}|${coding.code}`] : []
    ) ?? []).sort();
    const text = condition.code?.text?.trim();
    const identity = codingSet.length ? `code-set:${JSON.stringify(codingSet)}` : text ? `text:${text}` : undefined;
    if (!identity || !seen.has(identity)) {
      if (identity) seen.add(identity);
      return true;
    }
    return false;
  });
}
