import type {
  Bundle,
  Condition,
  Encounter,
  Observation,
  Patient,
  Provenance,
  Resource,
} from "@medplum/fhirtypes";
import type { Application } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import {
  buildEncounterDiagnosisComponent,
  buildEncounterDiagnosisCondition,
  FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM,
} from "../fhir/condition.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { DIAGNOSIS_KEY_IDENTIFIER_SYSTEM } from "./diagnosis-pick-endpoint.js";

export type PreviousExamLaterality = "OD" | "OS" | "OU" | "UNKNOWN";

export interface PreviousExamDiagnosisIdentity {
  diagnosisKey?: string;
  coding: Array<{ system?: string; code?: string; display?: string }>;
  text?: string;
  laterality: PreviousExamLaterality;
}

export interface PreviousExamFinding {
  observationReference: string;
  code: string;
  display: string;
  presence: "present" | "absent";
  grade?: string;
  laterality: PreviousExamLaterality;
}

export interface PreviousExamDiagnosis {
  conditionReference: string;
  display: string;
  identity: PreviousExamDiagnosisIdentity;
  findings: PreviousExamFinding[];
  checked: boolean;
  currentConditionReference?: string;
}

export interface PreviousExamGroup {
  encounterReference: string;
  date: string;
  visitType: string;
  diagnoses: PreviousExamDiagnosis[];
}

export interface PreviousExamsPage {
  pageSize: 4;
  encounters: PreviousExamGroup[];
  nextCursor?: string;
}

type PreviousExamResource = Condition | Encounter | Observation | Patient | Provenance;

export interface DiagnosisCarryForwardFhirClient {
  read<T extends PreviousExamResource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends PreviousExamResource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends PreviousExamResource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
  executeTransaction(bundle: Bundle, extraHeaders?: Record<string, string>): Promise<Bundle>;
}

export interface DiagnosisCarryForwardEndpointDeps {
  fhirBaseUrl: string;
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: DiagnosisCarryForwardFhirClient;
  } | null>;
}

export interface DiagnosisCarryForwardRouteDeps extends DiagnosisCarryForwardEndpointDeps {
  authenticateService(): Promise<void>;
  authenticateWrite: DiagnosisCarryForwardEndpointDeps["authenticate"];
}

const PAGE_SIZE = 4 as const;
const paramsSchema = z.object({ encounterId: z.string().trim().min(1).max(128) }).strict();
const querySchema = z.object({ cursor: z.string().trim().min(1).max(4096).optional() }).strict();
const pullBodySchema = z.object({
  sourceEncounterReference: z.string().regex(/^Encounter\/[^/]+$/),
  sourceConditionReference: z.string().regex(/^Condition\/[^/]+$/),
}).strict();
const patientReferencePattern = /^Patient\/([^/]+)$/;
const conditionReferencePattern = /^Condition\/([^/]+)$/;
const observationReferencePattern = /^Observation\/([^/]+)$/;

export function registerDiagnosisCarryForwardRoutes(
  app: Pick<Application, "get" | "post">,
  deps: DiagnosisCarryForwardRouteDeps,
): void {
  app.get("/clinical-graph/encounters/:encounterId/previous-exams", async (req, res) => {
    try {
      await deps.authenticateService();
      const result = await handlePreviousExamsReadRequest(deps, {
        authHeader: req.header("authorization"),
        params: req.params,
        query: req.query,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: previous exams read failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "previous exams read failed" });
    }
  });
  app.post("/clinical-graph/encounters/:encounterId/previous-exams", async (req, res) => {
    try {
      await deps.authenticateService();
      const result = await handleDiagnosisPullRequest({
        fhirBaseUrl: deps.fhirBaseUrl,
        authenticate: deps.authenticateWrite,
      }, {
        authHeader: req.header("authorization"),
        params: req.params,
        body: req.body,
      });
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("odos-mcp: diagnosis pull-forward failed:", error);
      if (!res.headersSent) res.status(500).json({ error: "diagnosis pull-forward failed" });
    }
  });
}

export async function handlePreviousExamsReadRequest(
  deps: DiagnosisCarryForwardEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; query: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read previous exams." } };
  if (!staffMayRead(staff.actorRole)) {
    return { status: 403, body: { error: "chart.read role required" } };
  }

  const parsedParams = paramsSchema.safeParse(input.params);
  if (!parsedParams.success) {
    return { status: 400, body: { error: "A valid encounter id is required." } };
  }
  const parsedQuery = querySchema.safeParse(input.query);
  if (!parsedQuery.success) {
    return { status: 400, body: { error: "A valid previous-exams cursor is required." } };
  }

  const currentEncounter = await staff.fhir.read<Encounter>("Encounter", parsedParams.data.encounterId);
  const patientMatch = currentEncounter.subject?.reference?.match(patientReferencePattern);
  const currentDate = currentEncounter.period?.start;
  if (!patientMatch || !currentDate) {
    return { status: 422, body: { error: "The current encounter requires a Patient and recorded start date." } };
  }
  const patientReference = `Patient/${patientMatch[1]}`;
  await staff.fhir.read<Patient>("Patient", patientMatch[1]!);

  const currentIdentities = await currentDiagnosisIdentities(
    staff.fhir,
    currentEncounter,
    patientReference,
  );
  const cursorPath = parsedQuery.data.cursor ? decodeCursor(parsedQuery.data.cursor, deps.fhirBaseUrl) : undefined;
  if (parsedQuery.data.cursor && !cursorPath) {
    return { status: 400, body: { error: "A valid previous-exams cursor is required." } };
  }
  if (cursorPath && !staff.fhir.searchUrl) {
    return { status: 500, body: { error: "FHIR pagination is unavailable." } };
  }
  const bundle = cursorPath
    ? await staff.fhir.searchUrl!<Encounter>(cursorPath, "Encounter")
    : await staff.fhir.search<Encounter>("Encounter", {
        subject: patientReference,
        date: `lt${currentDate}`,
        _sort: "-date",
        _count: String(PAGE_SIZE),
      });
  const encounters = bundleResources(bundle)
    .filter((encounter) => encounter.id && encounter.subject?.reference === patientReference)
    .slice(0, PAGE_SIZE);
  const groups = await Promise.all(encounters.map((encounter) =>
    previousExamGroup(staff.fhir, encounter, patientReference, currentIdentities)
  ));
  const next = bundle.link?.find((link) => link.relation === "next")?.url;
  let nextCursor: string | undefined;
  try {
    nextCursor = next ? encodeCursor(validatedNextPath(next, deps.fhirBaseUrl)) : undefined;
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      return { status: 502, body: { error: "FHIR previous-exams next link is invalid." } };
    }
    throw error;
  }
  const page: PreviousExamsPage = {
    pageSize: PAGE_SIZE,
    encounters: groups,
    ...(nextCursor ? { nextCursor } : {}),
  };
  return { status: 200, body: page };
}

export async function handleDiagnosisPullRequest(
  deps: DiagnosisCarryForwardEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to pull a diagnosis." } };
  if (!staffMayWrite(staff.actorRole)) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsedParams = paramsSchema.safeParse(input.params);
  const parsedBody = pullBodySchema.safeParse(input.body);
  if (!parsedParams.success || !parsedBody.success) {
    return { status: 400, body: { error: "A current Encounter and source Encounter diagnosis are required." } };
  }

  try {
  const currentEncounterId = parsedParams.data.encounterId;
  const sourceEncounterId = parsedBody.data.sourceEncounterReference.slice("Encounter/".length);
  const sourceConditionId = parsedBody.data.sourceConditionReference.slice("Condition/".length);
  const [initialCurrentEncounter, sourceEncounter, sourceCondition] = await Promise.all([
    diagnosisPullRead(() => staff.fhir.read<Encounter>("Encounter", currentEncounterId)),
    diagnosisPullRead(() => staff.fhir.read<Encounter>("Encounter", sourceEncounterId)),
    diagnosisPullRead(() => staff.fhir.read<Condition>("Condition", sourceConditionId)),
  ]);
  const patientReference = initialCurrentEncounter.subject?.reference;
  if (!patientReference?.match(patientReferencePattern)) {
    return { status: 409, body: { error: "The current encounter requires a Patient." } };
  }
  await diagnosisPullRead(() =>
    staff.fhir.read<Patient>("Patient", patientReference.slice("Patient/".length))
  );
  if (
    initialCurrentEncounter.status === "entered-in-error" ||
    sourceEncounter.status === "entered-in-error" ||
    sourceEncounter.subject?.reference !== patientReference ||
    sourceCondition.subject?.reference !== patientReference ||
    sourceCondition.encounter?.reference !== parsedBody.data.sourceEncounterReference ||
    !encounterHasDiagnosis(sourceEncounter, parsedBody.data.sourceConditionReference) ||
    excludedCondition(sourceCondition)
  ) {
    return { status: 409, body: { error: "The source diagnosis is not an active diagnosis for this patient and encounter." } };
  }
  if (!sourceCondition.code) {
    return { status: 409, body: { error: "The source diagnosis has no recorded code or text." } };
  }
  const sourceObservations = await sourceEvidenceObservations(
    staff.fhir,
    sourceCondition,
    patientReference,
    parsedBody.data.sourceEncounterReference,
  );
  if (!sourceObservations) {
    return { status: 409, body: { error: "The source diagnosis evidence does not belong to its patient and encounter." } };
  }

  const currentEncounter = await diagnosisPullRead(() =>
    staff.fhir.read<Encounter>("Encounter", currentEncounterId)
  );
  if (
    currentEncounter.status === "entered-in-error" ||
    currentEncounter.subject?.reference !== patientReference
  ) {
    return { status: 409, body: { error: "The current encounter patient changed; reload and retry." } };
  }
  const versionId = currentEncounter.meta?.versionId;
  if (!versionId) {
    return { status: 409, body: { error: "The current encounter has no version for an atomic pull." } };
  }
  const currentIdentities = await currentDiagnosisIdentities(staff.fhir, currentEncounter, patientReference);
  const sourceIdentity = diagnosisIdentity(sourceCondition, sourceEncounterId);
  const alreadyPresent = currentIdentities.get(identityKey(sourceIdentity));
  if (alreadyPresent) {
    return { status: 200, body: { conditionReference: alreadyPresent, alreadyPresent: true } };
  }

  const conditionFullUrl = uuidFullUrl();
  const encounterFullUrl = uuidFullUrl();
  const observationRows = sourceObservations.filter((observation) => observation.valueBoolean === true);
  const observationFullUrls = observationRows.map(() => uuidFullUrl());
  const provenanceFullUrl = uuidFullUrl();
  const pulledCondition = pulledDiagnosisCondition(
    sourceCondition,
    sourceEncounterId,
    currentEncounterId,
    patientReference,
    observationFullUrls,
  );
  const nextRank = Math.max(0, ...(currentEncounter.diagnosis ?? []).flatMap((diagnosis) =>
    Number.isInteger(diagnosis.rank) && diagnosis.rank! > 0 ? [diagnosis.rank!] : []
  )) + 1;
  const pulledEncounter: Encounter = {
    ...currentEncounter,
    diagnosis: [
      ...(currentEncounter.diagnosis ?? []),
      buildEncounterDiagnosisComponent(conditionFullUrl, nextRank),
    ],
  };
  const pulledObservations = observationRows.map((observation) =>
    pulledFindingObservation(observation, patientReference, `Encounter/${currentEncounterId}`)
  );
  const provenance = buildProvenance({
    targetReferences: [conditionFullUrl, encounterFullUrl, ...observationFullUrls],
    recorded: new Date().toISOString(),
    activityCode: "CREATE",
    activityDisplay: "Diagnosis pull-forward",
    agents: [{ typeCode: "author", whoReference: staff.staffReference }],
    entityReferences: [
      parsedBody.data.sourceConditionReference,
      ...sourceObservations.map((observation) => `Observation/${observation.id}`),
    ],
  }) as Provenance;
  const transactionBundle: Bundle = {
    resourceType: "Bundle",
    type: "transaction",
    entry: [
      {
        fullUrl: conditionFullUrl,
        resource: pulledCondition,
        request: { method: "POST", url: "Condition" },
      },
      {
        fullUrl: encounterFullUrl,
        resource: pulledEncounter,
        request: {
          method: "PUT",
          url: `Encounter/${currentEncounterId}`,
          ifMatch: `W/"${versionId}"`,
        },
      },
      ...pulledObservations.map((observation, index) => ({
        fullUrl: observationFullUrls[index],
        resource: observation,
        request: { method: "POST" as const, url: "Observation" },
      })),
      {
        fullUrl: provenanceFullUrl,
        resource: provenance,
        request: { method: "POST", url: "Provenance" },
      },
    ],
  };

  let transaction: Bundle;
  try {
    transaction = await staff.fhir.executeTransaction(transactionBundle, {
      "X-ODOS-Source": "diagnosis-carry-forward",
      Prefer: "return=representation",
    });
  } catch (error) {
    if (isFhirConflict(error)) {
      return diagnosisConflict(staff.fhir, currentEncounterId, patientReference, sourceIdentity);
    }
    throw error;
  }
  const transactionValidation = validateTransactionResponse(transactionBundle, transaction);
  if (transactionValidation.kind !== "ok") {
    if (transactionValidation.kind === "conflict") {
      return diagnosisConflict(staff.fhir, currentEncounterId, patientReference, sourceIdentity);
    }
    return { status: 502, body: { error: "FHIR diagnosis pull transaction response was invalid." } };
  }
  const conditionReference = transactionConditionReference(transaction, 0);
  if (!conditionReference) {
    return { status: 502, body: { error: "FHIR diagnosis pull transaction did not return the created Condition." } };
  }
  return {
    status: 200,
    body: { conditionReference, alreadyPresent: false, transaction },
  };
  } catch (error) {
    if (error instanceof DiagnosisPullReadError) {
      if (error.status === 404 || error.status === 410) {
        return { status: 404, body: { error: "Diagnosis pull resources were not found." } };
      }
      return {
        status: 403,
        body: { error: "Diagnosis pull resources are outside the caller's patient compartment." },
      };
    }
    throw error;
  }
}

async function currentDiagnosisIdentities(
  fhir: DiagnosisCarryForwardFhirClient,
  encounter: Encounter,
  patientReference: string,
): Promise<Map<string, string>> {
  const identities = new Map<string, string>();
  for (const diagnosis of encounter.diagnosis ?? []) {
    const match = diagnosis.condition.reference?.match(conditionReferencePattern);
    if (!match) continue;
    const condition = await diagnosisPullRead(() => fhir.read<Condition>("Condition", match[1]!));
    if (
      condition.subject?.reference !== patientReference ||
      condition.encounter?.reference !== `Encounter/${encounter.id}` ||
      excludedCondition(condition)
    ) continue;
    const reference = `Condition/${match[1]}`;
    identities.set(identityKey(diagnosisIdentity(condition, encounter.id ?? "")), reference);
  }
  return identities;
}

async function previousExamGroup(
  fhir: DiagnosisCarryForwardFhirClient,
  encounter: Encounter,
  patientReference: string,
  currentIdentities: ReadonlyMap<string, string>,
): Promise<PreviousExamGroup> {
  const encounterId = encounter.id!;
  const diagnoses: PreviousExamDiagnosis[] = [];
  for (const diagnosis of encounter.diagnosis ?? []) {
    const match = diagnosis.condition.reference?.match(conditionReferencePattern);
    if (!match) continue;
    const condition = await fhir.read<Condition>("Condition", match[1]!);
    if (condition.subject?.reference !== patientReference || excludedCondition(condition)) continue;
    const identity = diagnosisIdentity(condition, encounterId);
    const currentConditionReference = currentIdentities.get(identityKey(identity));
    diagnoses.push({
      conditionReference: `Condition/${match[1]}`,
      display: conditionDisplay(condition),
      identity,
      findings: await evidenceFindings(fhir, condition, patientReference),
      checked: currentConditionReference !== undefined,
      ...(currentConditionReference ? { currentConditionReference } : {}),
    });
  }
  return {
    encounterReference: `Encounter/${encounterId}`,
    date: encounter.period?.start ?? "",
    visitType: encounter.type?.flatMap((type) => [
      type.text,
      ...(type.coding ?? []).flatMap((coding) => [coding.display, coding.code]),
    ]).find((value): value is string => Boolean(value?.trim())) ?? "Visit type not recorded",
    diagnoses,
  };
}

async function evidenceFindings(
  fhir: DiagnosisCarryForwardFhirClient,
  condition: Condition,
  patientReference: string,
): Promise<PreviousExamFinding[]> {
  const findings: PreviousExamFinding[] = [];
  for (const detail of condition.evidence?.flatMap((evidence) => evidence.detail ?? []) ?? []) {
    const match = detail.reference?.match(observationReferencePattern);
    if (!match) continue;
    const observation = await fhir.read<Observation>("Observation", match[1]!);
    if (
      observation.subject?.reference !== patientReference ||
      observation.status === "entered-in-error" ||
      observation.status === "cancelled" ||
      typeof observation.valueBoolean !== "boolean"
    ) continue;
    const coding = observation.code.coding?.find((candidate) => candidate.code);
    const code = coding?.code ?? observation.code.text;
    if (!code) continue;
    const grade = observation.component?.find((component) =>
      component.code.coding?.some((candidate) => candidate.code === "GRADE")
    );
    const gradeValue = grade?.valueString ?? grade?.valueCodeableConcept?.coding?.find((candidate) => candidate.code)?.code;
    findings.push({
      observationReference: `Observation/${match[1]}`,
      code,
      display: coding?.display ?? observation.code.text ?? code,
      presence: observation.valueBoolean ? "present" : "absent",
      ...(gradeValue ? { grade: gradeValue } : {}),
      laterality: recordedLaterality(observation),
    });
  }
  return findings;
}

function diagnosisIdentity(condition: Condition, encounterId: string): PreviousExamDiagnosisIdentity {
  const identifier = condition.identifier?.find((candidate) =>
    candidate.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM && candidate.value
  )?.value;
  const parsedIdentifier = parseDiagnosisIdentifier(identifier, encounterId);
  const coding = (condition.code?.coding ?? [])
    .map(({ system, code, display }) => ({
      ...(system ? { system } : {}),
      ...(code ? { code } : {}),
      ...(display ? { display } : {}),
    }))
    .filter((row) => row.system || row.code || row.display)
    .sort((left, right) =>
      (left.system ?? "").localeCompare(right.system ?? "") ||
      (left.code ?? "").localeCompare(right.code ?? "") ||
      (left.display ?? "").localeCompare(right.display ?? "")
    );
  return {
    ...(parsedIdentifier.diagnosisKey ? { diagnosisKey: parsedIdentifier.diagnosisKey } : {}),
    coding,
    ...(condition.code?.text ? { text: condition.code.text } : {}),
    laterality: parsedIdentifier.laterality ?? recordedLaterality(condition),
  };
}

function parseDiagnosisIdentifier(
  value: string | undefined,
  encounterId: string,
): { diagnosisKey?: string; laterality?: PreviousExamLaterality } {
  if (!value) return {};
  const parts = value.split("::");
  const laterality = diagnosisBucketLaterality(parts.at(-1));
  if (parts.length >= 3 && parts[0] === encounterId && laterality) {
    return { diagnosisKey: parts.slice(1, -1).join("::"), laterality };
  }
  if (parts.length >= 2 && laterality) {
    return { diagnosisKey: parts.slice(0, -1).join("::"), laterality };
  }
  return { diagnosisKey: value };
}

function diagnosisBucketLaterality(value: string | undefined): PreviousExamLaterality | undefined {
  if (value === "right") return "OD";
  if (value === "left") return "OS";
  if (value === "bilateral") return "OU";
  if (value === "unspecified" || value === "none") return "UNKNOWN";
  return undefined;
}

function recordedLaterality(resource: Condition | Observation): PreviousExamLaterality {
  const extensionCode = resource.extension?.find((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality)
    ?.valueCodeableConcept?.coding?.find((coding) => coding.code)?.code;
  const bodySites = resource.resourceType === "Condition"
    ? resource.bodySite ?? []
    : resource.bodySite ? [resource.bodySite] : [];
  const bodySiteCode = bodySites.flatMap((bodySite) => bodySite.coding ?? [])
    .find((coding) => coding.code)?.code;
  const value = extensionCode ?? bodySiteCode;
  if (value === "OD" || value === "right") return "OD";
  if (value === "OS" || value === "left") return "OS";
  if (value === "OU" || value === "bilateral") return "OU";
  return "UNKNOWN";
}

function conditionDisplay(condition: Condition): string {
  return condition.code?.text
    ?? condition.code?.coding?.find((coding) => coding.display)?.display
    ?? condition.code?.coding?.find((coding) => coding.code)?.code
    ?? "Diagnosis not recorded";
}

function excludedCondition(condition: Condition): boolean {
  const status = condition.verificationStatus?.coding?.find((coding) =>
    coding.system === FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM
  )?.code;
  return status === "refuted" || status === "entered-in-error";
}

function encounterHasDiagnosis(encounter: Encounter, conditionReference: string): boolean {
  return (encounter.diagnosis ?? []).some((diagnosis) => diagnosis.condition.reference === conditionReference);
}

async function sourceEvidenceObservations(
  fhir: DiagnosisCarryForwardFhirClient,
  condition: Condition,
  patientReference: string,
  encounterReference: string,
): Promise<Observation[] | undefined> {
  const observations: Observation[] = [];
  for (const detail of condition.evidence?.flatMap((evidence) => evidence.detail ?? []) ?? []) {
    const match = detail.reference?.match(observationReferencePattern);
    if (!match) continue;
    const observation = await diagnosisPullRead(() => fhir.read<Observation>("Observation", match[1]!));
    if (
      observation.subject?.reference !== patientReference ||
      observation.encounter?.reference !== encounterReference
    ) return undefined;
    if (
      observation.status === "entered-in-error" ||
      observation.status === "cancelled"
    ) continue;
    observations.push(observation);
  }
  return observations;
}

function pulledDiagnosisCondition(
  source: Condition,
  sourceEncounterId: string,
  currentEncounterId: string,
  patientReference: string,
  evidenceReferences: string[],
): Condition {
  const sourceIdentity = diagnosisIdentity(source, sourceEncounterId);
  const identifier = sourceIdentity.diagnosisKey
    ? [{
        system: DIAGNOSIS_KEY_IDENTIFIER_SYSTEM,
        value: `${currentEncounterId}::${sourceIdentity.diagnosisKey}::${diagnosisIdentifierSuffix(source)}`,
      }]
    : undefined;
  const condition = buildEncounterDiagnosisCondition({
    patientReference,
    encounterReference: `Encounter/${currentEncounterId}`,
    code: structuredClone(source.code!),
    verificationStatus: "confirmed",
    ...(identifier ? { identifiers: identifier } : {}),
    evidenceObservationReferences: evidenceReferences,
  });
  const extensions = source.extension?.filter((extension) => extension.url === ODOS_EXTENSION_URLS.eyeLaterality);
  const bodySite = source.bodySite?.filter((site) => site.coding?.some((coding) => isLateralityCode(coding.code)));
  return {
    ...condition,
    ...(extensions?.length ? { extension: structuredClone(extensions) } : {}),
    ...(bodySite?.length ? { bodySite: structuredClone(bodySite) } : {}),
  };
}

function pulledFindingObservation(
  source: Observation,
  patientReference: string,
  encounterReference: string,
): Observation {
  const extension = source.extension?.filter((candidate) => candidate.url === ODOS_EXTENSION_URLS.eyeLaterality);
  const bodySite = source.bodySite?.coding?.some((coding) => isLateralityCode(coding.code))
    ? source.bodySite
    : undefined;
  const component = source.component?.filter((candidate) =>
    candidate.code.coding?.some((coding) => coding.code === "GRADE")
  );
  return {
    resourceType: "Observation",
    status: "preliminary",
    code: structuredClone(source.code),
    subject: { reference: patientReference },
    encounter: { reference: encounterReference },
    valueBoolean: true,
    ...(extension?.length ? { extension: structuredClone(extension) } : {}),
    ...(bodySite ? { bodySite: structuredClone(bodySite) } : {}),
    ...(component?.length ? { component: structuredClone(component) } : {}),
  };
}

function diagnosisIdentifierSuffix(condition: Condition): "right" | "left" | "bilateral" | "unspecified" | "none" {
  const sourceValue = condition.identifier?.find((candidate) =>
    candidate.system === DIAGNOSIS_KEY_IDENTIFIER_SYSTEM
  )?.value?.split("::").at(-1);
  if (
    sourceValue === "right" || sourceValue === "left" || sourceValue === "bilateral" ||
    sourceValue === "unspecified" || sourceValue === "none"
  ) {
    return sourceValue;
  }
  const laterality = recordedLaterality(condition);
  if (laterality === "OD") return "right";
  if (laterality === "OS") return "left";
  if (laterality === "OU") return "bilateral";
  return "unspecified";
}

function isLateralityCode(code: string | undefined): boolean {
  return code === "OD" || code === "OS" || code === "OU" || code === "right" ||
    code === "left" || code === "bilateral";
}

function identityKey(identity: PreviousExamDiagnosisIdentity): string {
  return identity.diagnosisKey
    ? JSON.stringify(["catalog", identity.diagnosisKey, identity.coding, identity.text, identity.laterality])
    : JSON.stringify(["literal", identity.coding, identity.text, identity.laterality]);
}

async function diagnosisConflict(
  fhir: DiagnosisCarryForwardFhirClient,
  encounterId: string,
  patientReference: string,
  sourceIdentity: PreviousExamDiagnosisIdentity,
): Promise<{ status: number; body: unknown }> {
  try {
    const encounter = await fhir.read<Encounter>("Encounter", encounterId);
    if (
      encounter.status !== "entered-in-error" &&
      encounter.subject?.reference === patientReference
    ) {
      const identities = await currentDiagnosisIdentities(fhir, encounter, patientReference);
      const conditionReference = identities.get(identityKey(sourceIdentity));
      if (conditionReference) {
        return { status: 200, body: { conditionReference, alreadyPresent: true } };
      }
    }
  } catch {
    return { status: 409, body: { error: "The encounter diagnoses changed concurrently; reload and retry." } };
  }
  return { status: 409, body: { error: "The encounter diagnoses changed concurrently; reload and retry." } };
}

function validateTransactionResponse(
  request: Bundle,
  response: Bundle,
): { kind: "ok" } | { kind: "conflict" } | { kind: "invalid" } {
  if (response.resourceType !== "Bundle" || response.type !== "transaction-response") {
    return { kind: "invalid" };
  }
  const requestEntries = request.entry;
  const responseEntries = response.entry;
  if (!requestEntries || !responseEntries || responseEntries.length !== requestEntries.length) {
    return { kind: "invalid" };
  }
  let conflict = false;
  for (let index = 0; index < requestEntries.length; index += 1) {
    const requestResourceType = requestEntries[index]?.resource?.resourceType;
    const responseResourceType = responseEntries[index]?.resource?.resourceType;
    const status = responseEntries[index]?.response?.status;
    const statusMatch = status?.match(/^(\d{3})(?:\s|$)/);
    if (!requestResourceType || !statusMatch) {
      return { kind: "invalid" };
    }
    const statusCode = Number(statusMatch[1]);
    if (statusCode === 409 || statusCode === 412) {
      conflict = true;
    } else if (statusCode < 200 || statusCode >= 300 || responseResourceType !== requestResourceType) {
      return { kind: "invalid" };
    }
  }
  return conflict ? { kind: "conflict" } : { kind: "ok" };
}

function transactionConditionReference(bundle: Bundle, entryIndex: number): string | undefined {
  const resource = bundle.entry?.[entryIndex]?.resource;
  if (resource?.resourceType === "Condition" && resource.id) return `Condition/${resource.id}`;
  const location = bundle.entry?.[entryIndex]?.response?.location;
  const match = location?.match(/^Condition\/([^/]+)(?:\/_history\/[^/]+)?$/);
  return match ? `Condition/${match[1]}` : undefined;
}

function isFhirConflict(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return status === 409 || status === 412 || /FHIR (409|412)\b/.test(message);
}

async function diagnosisPullRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      throw new DiagnosisPullReadError(status);
    }
    throw error;
  }
}

function uuidFullUrl(): string {
  return `urn:uuid:${randomUUID()}`;
}

function encodeCursor(path: string): string {
  return Buffer.from(JSON.stringify({ v: 1, path }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, fhirBaseUrl: string): string | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" || decoded === null ||
      (decoded as { v?: unknown }).v !== 1 ||
      typeof (decoded as { path?: unknown }).path !== "string"
    ) return undefined;
    return validatedNextPath((decoded as { path: string }).path, fhirBaseUrl);
  } catch {
    return undefined;
  }
}

function validatedNextPath(url: string, fhirBaseUrl: string): string {
  const fhirOrigin = new URL(fhirBaseUrl).origin;
  const parsed = new URL(url, `${fhirOrigin}/fhir/R4/Encounter`);
  if (
    parsed.username || parsed.password || parsed.hash ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== fhirOrigin ||
    !parsed.pathname.endsWith("/Encounter") ||
    !parsed.search
  ) throw new InvalidCursorError();
  return `${parsed.pathname}${parsed.search}`;
}

function bundleResources<T extends Resource>(bundle: Bundle<T>): T[] {
  return (bundle.entry ?? []).flatMap((entry) => entry.resource ? [entry.resource] : []);
}

function staffMayRead(role: PracticeRoleId): boolean {
  try {
    assertBusinessActionAllowed(role, "chart.read");
    return true;
  } catch {
    return false;
  }
}

function staffMayWrite(role: PracticeRoleId): boolean {
  try {
    assertBusinessActionAllowed(role, "chart.write");
    return true;
  } catch {
    return false;
  }
}

class InvalidCursorError extends Error {}
class DiagnosisPullReadError extends Error {
  constructor(readonly status: 401 | 403 | 404 | 410) {
    super("Diagnosis pull FHIR read failed");
  }
}
