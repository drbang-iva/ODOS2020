import type {
  Bundle,
  Condition,
  Coverage,
  DocumentReference,
  Encounter,
  MedicationRequest,
  MedicationStatement,
  Observation,
  Patient,
  Procedure,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import type { MedplumClient } from "../fhir-client.js";
import { conditionEncounterId, hasConditionCategory, isConfirmedEncounterDiagnosis, referenceId } from "../fhir/condition.js";
import { ODOS_VISIT_TYPE_SYSTEM } from "../fhir/schedulingVisitType.js";
import { TOBACCO_SMOKING_STATUS_LOINC_CODE } from "../fhir/smokingStatus.js";

export const PATIENT_STICKY_NOTE_SYSTEM = "https://odos2020.com/fhir/CodeSystem/patient-sticky-note";
export const PATIENT_STICKY_NOTE_CODE = "patient-sticky-note";
export const PATIENT_STICKY_NOTE_IDENTIFIER_SYSTEM = "https://odos2020.com/fhir/identifier/patient-sticky-note";

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
  status: "Preliminary" | "Final";
  diagnoses: PatientOverviewDiagnosis[];
}

export interface PatientOverviewMedication {
  id?: string;
  name: string;
  sig?: string;
}

export interface PatientOverviewPayload {
  patient: Patient;
  insurance: string[];
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
  visits: PatientOverviewVisit[];
  diagnosisChoices: Array<{ name: string; code: string; system: string }>;
}

export interface StickyNoteHistoryEntry {
  versionId: string;
  text: string;
  editedAt?: string;
  editedBy?: string;
}

export type OverviewFhir = Pick<MedplumClient, "read" | "search" | "searchUrl" | "history" | "create" | "update">;

export class StickyNoteValidationError extends Error {}

const EYE_EXAM_VISIT_CODES = ["routine-exam-new", "routine-exam-established", "medicaid-exam"];

export async function loadPatientOverview(
  fhir: OverviewFhir,
  patientId: string,
  options: { filter?: VisitLedgerFilter; diagnosisSystem?: string; diagnosisCode?: string } = {},
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

  const conditionParams: Record<string, string> = {
    patient: patientId,
    category: "encounter-diagnosis",
    "verification-status": "confirmed",
    _count: "100",
  };
  if (options.diagnosisSystem && options.diagnosisCode) {
    conditionParams.code = `${options.diagnosisSystem}|${options.diagnosisCode}`;
  }

  const [
    patient,
    coverageResult,
    stickyNote,
    problemConditions,
    procedures,
    medicationStatements,
    medicationRequestResult,
    smokingStatuses,
    encounterDiagnoses,
  ] = await Promise.all([
    fhir.read<Patient>("Patient", patientId),
    optionalSearchAll<Coverage>(fhir, "Coverage", { beneficiary: patientReference, status: "active", _count: "100" }),
    findPatientStickyNote(fhir, patientId, true),
    searchAll<Condition>(fhir, "Condition", { patient: patientId, category: "problem-list-item", _count: "100" }),
    searchAll<Procedure>(fhir, "Procedure", { patient: patientId, _count: "100", _sort: "-date" }),
    searchAll<MedicationStatement>(fhir, "MedicationStatement", { patient: patientId, status: "active", _count: "100" }),
    optionalSearchAll<MedicationRequest>(fhir, "MedicationRequest", { patient: patientId, status: "active", _count: "100" }),
    searchAll<Observation>(fhir, "Observation", { patient: patientId, code: TOBACCO_SMOKING_STATUS_LOINC_CODE, _count: "1", _sort: "-date" }),
    searchAll<Condition>(fhir, "Condition", conditionParams),
  ]);
  const diagnosisEncounterIds = options.diagnosisSystem && options.diagnosisCode
    ? unique(encounterDiagnoses.flatMap((condition) => conditionEncounterId(condition) ?? []))
    : undefined;
  if (diagnosisEncounterIds && diagnosisEncounterIds.length === 0) {
    return projectOverview({
      patient,
      coverages: coverageResult.resources,
      unavailable: unavailableSources(coverageResult.available, medicationRequestResult.available),
      stickyNote,
      problemConditions,
      procedures,
      medicationStatements,
      medicationRequests: medicationRequestResult.resources,
      smokingStatuses,
      encounters: [],
      encounterDiagnoses,
    });
  }
  if (diagnosisEncounterIds) {
    delete encounterParams.type;
    encounterParams._id = diagnosisEncounterIds.join(",");
  }
  const encounters = await searchAll<Encounter>(fhir, "Encounter", encounterParams);
  const encounterReferences = new Set(encounters.flatMap((encounter) =>
    encounter.id ? [`Encounter/${encounter.id}`] : [],
  ));
  const provenances = encounters.length
    ? (await searchAll<Provenance>(fhir, "Provenance", {
        recorded: `ge${encounters.reduce((earliest, encounter) => {
          const date = encounter.period?.start ?? encounter.period?.end;
          return date && date < earliest ? date : earliest;
        }, new Date().toISOString())}`,
        _count: "100",
        _sort: "recorded",
      })).filter((provenance) => provenance.target.some((target) =>
        encounterReferences.has(target.reference ?? ""),
      ))
    : [];

  return projectOverview({
    patient,
    coverages: coverageResult.resources,
    unavailable: unavailableSources(coverageResult.available, medicationRequestResult.available),
    stickyNote,
    problemConditions,
    procedures,
    medicationStatements,
    medicationRequests: medicationRequestResult.resources,
    smokingStatuses,
    encounters,
    encounterDiagnoses,
    provenances,
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
  unavailable?: PatientOverviewPayload["unavailable"];
  stickyNote?: DocumentReference;
  problemConditions: Condition[];
  procedures: Procedure[];
  medicationStatements: MedicationStatement[];
  medicationRequests: MedicationRequest[];
  smokingStatuses: Observation[];
  encounters: Encounter[];
  encounterDiagnoses: Condition[];
  provenances?: Provenance[];
}): PatientOverviewPayload {
  const problemConditions = input.problemConditions.filter((condition) =>
    hasConditionCategory(condition, "problem-list-item") && !hasStatus(condition.verificationStatus, "entered-in-error"),
  );
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
  const diagnoses = input.encounterDiagnoses.filter(isConfirmedEncounterDiagnosis);
  const signedEncounterIds = signedEncounters(input.encounters, input.provenances ?? []);
  const byEncounter = new Map<string, PatientOverviewDiagnosis[]>();
  for (const condition of diagnoses) {
    const encounterId = conditionEncounterId(condition);
    if (!encounterId || !condition.id) continue;
    const coding = condition.code?.coding?.find((candidate) => candidate.code);
    const row: PatientOverviewDiagnosis = {
      conditionId: condition.id,
      encounterId,
      name: conceptText(condition.code) || "Diagnosis recorded",
      ...(coding?.code ? { code: coding.code } : {}),
      ...(coding?.system ? { system: coding.system } : {}),
      ...(condition.bodySite?.[0]?.text ? { laterality: condition.bodySite[0].text } : {}),
    };
    byEncounter.set(encounterId, [...(byEncounter.get(encounterId) ?? []), row]);
  }

  return {
    patient: input.patient,
    insurance: [...input.coverages]
      .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
      .map((coverage) => coverage.payor?.[0]?.display ?? coverage.class?.find((row) => row.name)?.name ?? "Coverage recorded"),
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
    visits: [...input.encounters]
      .sort((left, right) => encounterTime(right) - encounterTime(left))
      .flatMap((encounter): PatientOverviewVisit[] => encounter.id ? [{
        encounterId: encounter.id,
        ...(encounter.period?.start ?? encounter.period?.end ? { date: encounter.period?.start ?? encounter.period?.end } : {}),
        ...(encounter.participant?.[0]?.individual?.display ? { provider: encounter.participant[0].individual.display } : {}),
        ...(encounter.serviceProvider?.display ?? encounter.location?.[0]?.location?.display
          ? { facility: encounter.serviceProvider?.display ?? encounter.location?.[0]?.location?.display }
          : {}),
        visitType: conceptText(encounter.type?.[0]) || "Visit type not recorded",
        status: signedEncounterIds.has(encounter.id) ? "Final" : "Preliminary",
        diagnoses: byEncounter.get(encounter.id) ?? [],
      }] : []),
    diagnosisChoices: uniqueBy(
      diagnoses.flatMap((condition) => {
        const coding = condition.code?.coding?.find((candidate) => candidate.system && candidate.code);
        return coding?.system && coding.code ? [{ name: conceptText(condition.code) || coding.display || coding.code, system: coding.system, code: coding.code }] : [];
      }),
      (row) => `${row.system}|${row.code}`,
    ),
  };
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
  fhir: Pick<MedplumClient, "search" | "searchUrl">,
  resourceType: T["resourceType"],
  params: Record<string, string>,
): Promise<T[]> {
  const resources: T[] = [];
  let bundle: Bundle<T> = await fhir.search<T>(resourceType, params);
  while (true) {
    resources.push(...(bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []));
    const next = bundle.link?.find((link) => link.relation === "next")?.url;
    if (!next) return resources;
    if (!fhir.searchUrl) throw new Error(`${resourceType} patient-overview query requires pagination support.`);
    bundle = await fhir.searchUrl<T>(next, resourceType);
  }
}

async function optionalSearchAll<T extends Resource>(
  fhir: Pick<MedplumClient, "search" | "searchUrl">,
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
