import type { Condition, Encounter, Provenance } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { isConfirmedEncounterDiagnosis, MDM_PROBLEM_STATUSES, MDM_PROBLEM_STATUS_EXTENSION_URL, mdmProblemStatusExtension } from "../fhir/condition.js";
import { buildProvenance } from "../fhir/ophthalmology/provenance.js";
import { isClosedEncounter } from "./encounter-sign-gate.js";
import { isFhirConflict } from "./fhir-conflict.js";

type DiagnosisOrderResource = Condition | Encounter;

export interface DiagnosisOrderFhirClient {
  read<T extends DiagnosisOrderResource>(resourceType: T["resourceType"], id: string): Promise<T>;
  update<T extends DiagnosisOrderResource>(
    resourceType: T["resourceType"],
    id: string,
    resource: T,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
}

const paramsSchema = z.object({ encounterId: z.string().trim().min(1).max(128) }).strict();
const bodySchema = z.object({
  conditionReferences: z.array(z.string().regex(/^Condition\/[A-Za-z0-9.-]+$/)).min(1).max(200),
}).strict();

const problemStatusParamsSchema = paramsSchema.extend({ conditionId: z.string().regex(/^[A-Za-z0-9.-]+$/) });
const problemStatusSchema = z.object({
  problemStatus: z.enum(MDM_PROBLEM_STATUSES.map((status) => status.code) as [typeof MDM_PROBLEM_STATUSES[number]["code"], ...typeof MDM_PROBLEM_STATUSES[number]["code"][]]),
  expectedEncounterVersion: z.string().regex(/^[A-Za-z0-9.-]+$/),
}).strict();

export async function handleDiagnosisProblemStatusRequest(
  deps: {
    authenticate(authHeader: string | undefined): Promise<{
      staffReference: string;
      actorRole: PracticeRoleId;
      fhir: DiagnosisOrderFhirClient & { create<T extends Provenance>(resource: T, extraHeaders?: Record<string, string>): Promise<T> };
    } | null>;
  },
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to update diagnosis complexity." } };
  if (!staffHasBusinessAction(staff, "chart.diagnosis.write")) {
    return { status: 403, body: { error: "chart.diagnosis.write role required" } };
  }
  const params = problemStatusParamsSchema.safeParse(input.params);
  const body = problemStatusSchema.safeParse(input.body);
  if (!params.success || !body.success) return { status: 400, body: { error: "A valid diagnosis, complexity and encounter version are required." } };
  const [encounter, condition] = await Promise.all([
    staff.fhir.read<Encounter>("Encounter", params.data.encounterId),
    staff.fhir.read<Condition>("Condition", params.data.conditionId),
  ]);
  const encounterReference = `Encounter/${params.data.encounterId}`;
  const conditionReference = `Condition/${params.data.conditionId}`;
  const patientReference = encounter.subject?.reference;
  if (!patientReference || condition.subject.reference !== patientReference ||
      condition.encounter?.reference !== encounterReference ||
      !encounter.diagnosis?.some((row) => row.condition.reference === conditionReference)) {
    return { status: 409, body: { error: "The diagnosis must belong to this patient's encounter." } };
  }
  if (isClosedEncounter(encounter) || encounter.meta?.versionId !== body.data.expectedEncounterVersion) {
    return { status: 409, body: { error: "The encounter is closed or changed; reload before editing diagnosis complexity." } };
  }
  const extension = mdmProblemStatusExtension(body.data.problemStatus);
  const next: Encounter = { ...encounter, diagnosis: encounter.diagnosis.map((row) =>
    row.condition.reference === conditionReference ? {
      ...row, extension: [
        ...(row.extension ?? []).filter((value) => value.url !== MDM_PROBLEM_STATUS_EXTENSION_URL), extension,
      ],
    } : row
  ) };
  const headers = { "X-ODOS-Source": "update_encounter_diagnosis_problem_status" };
  let updated: Encounter;
  try {
    updated = await staff.fhir.update<Encounter>("Encounter", params.data.encounterId, next, {
      ...headers, "If-Match": `W/"${body.data.expectedEncounterVersion}"`,
    });
  } catch (error) {
    if (isFhirConflict(error)) return { status: 409, body: { error: "The encounter changed concurrently; reload and retry." } };
    throw error;
  }
  await staff.fhir.create(buildProvenance({
    targetReferences: [encounterReference, conditionReference], patientReference,
    activityCode: "UPDATE", agents: [{ whoReference: staff.staffReference }],
  }), headers);
  return { status: 200, body: { encounter: updated } };
}

export async function handleDiagnosisOrderRequest(
  deps: {
    authenticate(authHeader: string | undefined): Promise<{
      staffReference: string;
      actorRole: PracticeRoleId;
      fhir: DiagnosisOrderFhirClient;
    } | null>;
  },
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to reorder diagnoses." } };
  if (!staffHasBusinessAction(staff, "chart.diagnosis.write")) {
    return { status: 403, body: { error: "chart.diagnosis.write role required" } };
  }
  const params = paramsSchema.safeParse(input.params);
  if (!params.success) return { status: 400, body: { error: "A valid encounter id is required." } };
  const body = bodySchema.safeParse(input.body);
  if (!body.success) {
    return { status: 400, body: { error: body.error.issues[0]?.message ?? "Invalid diagnosis order." } };
  }

  const encounter = await staff.fhir.read<Encounter>("Encounter", params.data.encounterId);
  const currentReferences = (encounter.diagnosis ?? []).map((entry) => entry.condition.reference);
  if (!isExactPermutation(body.data.conditionReferences, currentReferences)) {
    return {
      status: 422,
      body: { error: "Diagnosis order must be an exact permutation of the Encounter diagnoses." },
    };
  }
  if (!encounter.meta?.versionId) {
    return { status: 409, body: { error: "The encounter has no version for an atomic diagnosis reorder." } };
  }

  const orderedConditions = await Promise.all(body.data.conditionReferences.map((reference) =>
    staff.fhir.read<Condition>("Condition", reference.slice("Condition/".length))
  ));
  if (!isConfirmedEncounterDiagnosis(orderedConditions[0]!)) {
    return { status: 422, body: { error: "A provisional diagnosis cannot be principal." } };
  }

  const rankByReference = new Map(body.data.conditionReferences.map((reference, index) => [reference, index + 1]));
  const updatedEncounter: Encounter = {
    ...encounter,
    diagnosis: (encounter.diagnosis ?? []).map((entry) => ({
      ...entry,
      rank: rankByReference.get(entry.condition.reference!)!,
    })),
  };
  try {
    const updated = await staff.fhir.update<Encounter>(
      "Encounter",
      params.data.encounterId,
      updatedEncounter,
      {
        "If-Match": `W/"${encounter.meta.versionId}"`,
        "X-ODOS-Source": "diagnosis-order",
      },
    );
    return { status: 200, body: { encounter: updated } };
  } catch (error) {
    if (isFhirConflict(error)) {
      return {
        status: 409,
        body: { error: "The encounter diagnoses changed concurrently; reload and retry." },
      };
    }
    throw error;
  }
}

function isExactPermutation(requested: readonly string[], current: readonly (string | undefined)[]): boolean {
  if (requested.length !== current.length || new Set(requested).size !== requested.length) return false;
  if (current.some((reference) => !reference) || new Set(current).size !== current.length) return false;
  const requestedSet = new Set(requested);
  return current.every((reference) => requestedSet.has(reference!));
}

function staffMay(role: PracticeRoleId, action: "chart.diagnosis.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
