import type {
  Bundle,
  Condition,
  Encounter,
  Observation,
  Patient,
  Resource,
} from "@medplum/fhirtypes";
import type { Application } from "express";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { FHIR_CONDITION_VERIFICATION_STATUS_CODE_SYSTEM } from "../fhir/condition.js";
import { ODOS_EXTENSION_URLS } from "../fhir/ophthalmology/extensions.js";
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

type PreviousExamResource = Condition | Encounter | Observation | Patient;

export interface DiagnosisCarryForwardFhirClient {
  read<T extends PreviousExamResource>(resourceType: T["resourceType"], id: string): Promise<T>;
  search<T extends PreviousExamResource>(
    resourceType: T["resourceType"],
    params?: Record<string, string>,
  ): Promise<Bundle<T>>;
  searchUrl?<T extends PreviousExamResource>(url: string, resourceType: T["resourceType"]): Promise<Bundle<T>>;
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
}

const PAGE_SIZE = 4 as const;
const paramsSchema = z.object({ encounterId: z.string().trim().min(1).max(128) }).strict();
const querySchema = z.object({ cursor: z.string().trim().min(1).max(4096).optional() }).strict();
const patientReferencePattern = /^Patient\/([^/]+)$/;
const conditionReferencePattern = /^Condition\/([^/]+)$/;
const observationReferencePattern = /^Observation\/([^/]+)$/;

export function registerDiagnosisCarryForwardRoutes(
  app: Pick<Application, "get">,
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

async function currentDiagnosisIdentities(
  fhir: DiagnosisCarryForwardFhirClient,
  encounter: Encounter,
  patientReference: string,
): Promise<Map<string, string>> {
  const identities = new Map<string, string>();
  for (const diagnosis of encounter.diagnosis ?? []) {
    const match = diagnosis.condition.reference?.match(conditionReferencePattern);
    if (!match) continue;
    const condition = await fhir.read<Condition>("Condition", match[1]!);
    if (condition.subject?.reference !== patientReference || excludedCondition(condition)) continue;
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

function identityKey(identity: PreviousExamDiagnosisIdentity): string {
  return identity.diagnosisKey
    ? JSON.stringify(["catalog", identity.diagnosisKey, identity.laterality])
    : JSON.stringify(["literal", identity.coding, identity.text, identity.laterality]);
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

class InvalidCursorError extends Error {}
