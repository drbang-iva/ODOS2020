import { z } from "zod";
import type { PracticeRoleId } from "../authz/roles.js";
import {
  PROCEDURE_FEE_CATEGORIES,
  ProcedureFeeConceptConflictError,
  ProcedureFeeScheduleInputError,
  createProcedureFeeScheduleItem,
  listProcedureFeeSchedule,
  procedureConceptKeyFromDisplay,
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
    display: z.string().trim().min(1).optional(),
    category: z.enum(PROCEDURE_FEE_CATEGORIES).optional(),
    billingCode: z.string().nullable().optional(),
    modifier: z.string().nullable().optional(),
    priceCents: z.number().int().nonnegative().nullable(),
    active: z.boolean(),
  }).strict(),
  z.object({ action: z.literal("deactivate") }).strict(),
]);

const createSchema = z.object({
  action: z.literal("create"),
  display: z.string().trim().min(1).max(200).refine((value) => {
    try {
      procedureConceptKeyFromDisplay(value);
      return true;
    } catch {
      return false;
    }
  }, "Display name must contain a letter or number."),
  category: z.enum(PROCEDURE_FEE_CATEGORIES),
  billingCode: z.string().nullable().optional(),
  modifier: z.string().nullable().optional(),
  priceCents: z.number().int().nonnegative().nullable(),
  active: z.boolean(),
}).strict();

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
  try {
    const item = await saveProcedureFeeScheduleItem(staff.fhir, {
      procedureConceptKey: params.data.procedureConceptKey,
      ...(mutation.data.action === "save" ? {
        ...(Object.hasOwn(mutation.data, "display") ? { display: mutation.data.display } : {}),
        ...(Object.hasOwn(mutation.data, "category") ? { category: mutation.data.category } : {}),
        billingCode: mutation.data.billingCode,
        modifier: mutation.data.modifier,
        priceCents: mutation.data.priceCents,
      } : {}),
      active: mutation.data.action === "save" ? mutation.data.active : false,
    });
    return { status: 200, body: { item } };
  } catch (error) {
    if (error instanceof ProcedureFeeScheduleInputError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}

export async function handleProcedureFeeScheduleCreateRequest(
  deps: ProcedureFeeScheduleEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to edit the fee schedule." } };
  if (staff.actorRole !== "practice-admin") {
    return { status: 403, body: { error: "Practice-admin access is required to edit the fee schedule." } };
  }
  const parsed = createSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid fee schedule concept." } };
  }
  try {
    const item = await createProcedureFeeScheduleItem(staff.fhir, {
      display: parsed.data.display,
      category: parsed.data.category,
      billingCode: parsed.data.billingCode,
      modifier: parsed.data.modifier,
      priceCents: parsed.data.priceCents,
      active: parsed.data.active,
    });
    return { status: 201, body: { item } };
  } catch (error) {
    if (error instanceof ProcedureFeeConceptConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof ProcedureFeeScheduleInputError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}
