import type { Condition, Encounter } from "@medplum/fhirtypes";
import { z } from "zod";
import { assertBusinessActionAllowed, staffHasBusinessAction, type PracticeRoleId } from "../authz/roles.js";
import { isConfirmedEncounterDiagnosis } from "../fhir/condition.js";
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
  if (!staffHasBusinessAction(staff, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
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

function staffMay(role: PracticeRoleId, action: "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
