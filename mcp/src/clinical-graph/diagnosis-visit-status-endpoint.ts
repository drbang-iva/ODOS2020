import type { Condition, Encounter } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import { isConfirmedEncounterDiagnosis } from "../fhir/condition.js";
import {
  DIAGNOSIS_VISIT_STATUSES,
  type DiagnosisVisitStatusStore,
} from "./diagnosis-visit-status-store.js";

interface DiagnosisVisitStatusFhirClient {
  read<T extends Condition | Encounter>(resourceType: T["resourceType"], id: string): Promise<T>;
}

interface Staff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: DiagnosisVisitStatusFhirClient;
}

export interface DiagnosisVisitStatusEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
  store: DiagnosisVisitStatusStore;
  now?: () => string;
}

const paramsSchema = z.object({
  encounterId: z.string().regex(/^[A-Za-z0-9.-]+$/),
}).strict();

const updateParamsSchema = paramsSchema.extend({
  conditionId: z.string().regex(/^[A-Za-z0-9.-]+$/),
}).strict();

const updateSchema = z.object({
  status: z.enum(DIAGNOSIS_VISIT_STATUSES),
}).strict();

export async function handleDiagnosisVisitStatusListRequest(
  deps: DiagnosisVisitStatusEndpointDeps,
  input: { authHeader: string | undefined; params: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read diagnosis visit statuses." } };
  if (!may(staff.actorRole, "chart.read")) return { status: 403, body: { error: "chart.read role required" } };
  const parsed = paramsSchema.safeParse(input.params);
  if (!parsed.success) return { status: 400, body: { error: "A valid encounter id is required." } };
  try {
    await staff.fhir.read<Encounter>("Encounter", parsed.data.encounterId);
  } catch {
    return { status: 404, body: { error: "Encounter not found." } };
  }
  return {
    status: 200,
    body: { statuses: await deps.store.listByEncounter(parsed.data.encounterId) },
  };
}

export async function handleDiagnosisVisitStatusUpdateRequest(
  deps: DiagnosisVisitStatusEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to update a diagnosis visit status." } };
  if (!may(staff.actorRole, "chart.write")) return { status: 403, body: { error: "chart.write role required" } };
  const parsedParams = updateParamsSchema.safeParse(input.params);
  if (!parsedParams.success) return { status: 400, body: { error: "Valid encounter and Condition ids are required." } };
  const parsedBody = updateSchema.safeParse(input.body);
  if (!parsedBody.success) return { status: 400, body: { error: parsedBody.error.issues[0]?.message ?? "Invalid diagnosis visit status." } };

  let encounter: Encounter;
  let condition: Condition;
  try {
    [encounter, condition] = await Promise.all([
      staff.fhir.read<Encounter>("Encounter", parsedParams.data.encounterId),
      staff.fhir.read<Condition>("Condition", parsedParams.data.conditionId),
    ]);
  } catch {
    return { status: 404, body: { error: "Encounter or Condition not found." } };
  }
  if (encounter.status === "finished") {
    return { status: 409, body: { error: "Diagnosis visit status cannot change after the encounter is signed." } };
  }
  if (condition.encounter?.reference !== `Encounter/${parsedParams.data.encounterId}` ||
      !isConfirmedEncounterDiagnosis(condition)) {
    return { status: 409, body: { error: "Condition must be a confirmed encounter diagnosis for this encounter." } };
  }

  const row = await deps.store.upsert({
    conditionReference: `Condition/${parsedParams.data.conditionId}`,
    encounterId: parsedParams.data.encounterId,
    status: parsedBody.data.status,
    setBy: staff.staffReference,
    at: deps.now?.() ?? new Date().toISOString(),
  });
  return { status: 200, body: { status: row } };
}

function may(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
