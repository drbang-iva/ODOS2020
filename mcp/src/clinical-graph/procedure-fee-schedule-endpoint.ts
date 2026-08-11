import { z } from "zod";
import type { PracticeRoleId } from "../authz/roles.js";
import {
  listProcedureFeeSchedule,
  saveProcedureFeeScheduleItem,
  type ProcedureFeeScheduleFhir,
} from "./procedure-fee-schedule.js";

interface Staff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: ProcedureFeeScheduleFhir;
}

export interface ProcedureFeeScheduleEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
}

const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    billingCode: z.string().nullable().optional(),
    priceCents: z.number().int().nonnegative().nullable(),
    active: z.boolean(),
  }).strict(),
  z.object({ action: z.literal("deactivate") }).strict(),
]);

export async function handleProcedureFeeScheduleRequest(
  deps: ProcedureFeeScheduleEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read the fee schedule." } };
  if (staff.actorRole !== "practice-admin") {
    return { status: 403, body: { error: "Practice-admin access is required to read the fee schedule." } };
  }
  return { status: 200, body: { items: await listProcedureFeeSchedule(staff.fhir) } };
}

export async function handleProcedureFeeScheduleMutationRequest(
  deps: ProcedureFeeScheduleEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to edit the fee schedule." } };
  if (staff.actorRole !== "practice-admin") {
    return { status: 403, body: { error: "Practice-admin access is required to edit the fee schedule." } };
  }
  const params = z.object({
    procedureConceptKey: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  }).safeParse(input.params);
  if (!params.success) return { status: 400, body: { error: "A valid procedure concept is required." } };
  const mutation = mutationSchema.safeParse(input.body);
  if (!mutation.success) {
    return { status: 400, body: { error: mutation.error.issues[0]?.message ?? "Invalid fee schedule update." } };
  }
  const item = await saveProcedureFeeScheduleItem(staff.fhir, {
    procedureConceptKey: params.data.procedureConceptKey,
    ...(mutation.data.action === "save" ? {
      billingCode: mutation.data.billingCode,
      priceCents: mutation.data.priceCents,
    } : {}),
    active: mutation.data.action === "save" ? mutation.data.active : false,
  });
  return { status: 200, body: { item } };
}
