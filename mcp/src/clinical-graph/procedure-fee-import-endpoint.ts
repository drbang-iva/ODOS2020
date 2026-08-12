import { z } from "zod";
import type { PracticeRoleId } from "../authz/roles.js";
import {
  ProcedureFeeImportInputError,
  commitProcedureFeeImport,
  inspectProcedureFeeCsv,
  proposeProcedureFeeImport,
} from "./procedure-fee-import.js";
import {
  listProcedureFeeScheduleSnapshot,
  type ProcedureFeeScheduleFhir,
} from "./procedure-fee-schedule.js";

interface Staff {
  staffReference: string;
  actorRole: PracticeRoleId;
  fhir: ProcedureFeeScheduleFhir;
}

export interface ProcedureFeeImportEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<Staff | null>;
}

const mappingSchema = z.object({
  display: z.string().optional(),
  category: z.string().optional(),
  billingCode: z.string().optional(),
  modifier: z.string().optional(),
  price: z.string().optional(),
  routing: z.string().optional(),
  active: z.string().optional(),
  zeroPrice: z.string().optional(),
}).strict();

const previewSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("inspect"),
    csvText: z.string().min(1).max(5_000_000),
  }).strict(),
  z.object({
    action: z.literal("propose"),
    csvText: z.string().min(1).max(5_000_000),
    mapping: mappingSchema,
  }).strict(),
]);

const commitSchema = z.object({
  proposals: z.array(z.unknown()).max(10_000),
}).strict();

export async function handleProcedureFeeImportPreviewRequest(
  deps: ProcedureFeeImportEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to import the fee schedule." } };
  if (staff.actorRole !== "practice-admin") {
    return { status: 403, body: { error: "Practice-admin access is required to import the fee schedule." } };
  }
  const parsed = previewSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid fee import preview request." } };
  }
  try {
    if (parsed.data.action === "inspect") {
      return { status: 200, body: inspectProcedureFeeCsv(parsed.data.csvText) };
    }
    const existing = await listProcedureFeeScheduleSnapshot(staff.fhir);
    return {
      status: 200,
      body: proposeProcedureFeeImport({
        csvText: parsed.data.csvText,
        mapping: parsed.data.mapping,
        existing,
      }),
    };
  } catch (error) {
    if (error instanceof ProcedureFeeImportInputError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}

export async function handleProcedureFeeImportCommitRequest(
  deps: ProcedureFeeImportEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to import the fee schedule." } };
  if (staff.actorRole !== "practice-admin") {
    return { status: 403, body: { error: "Practice-admin access is required to import the fee schedule." } };
  }
  const parsed = commitSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid fee import commit request." } };
  }
  return { status: 200, body: await commitProcedureFeeImport(staff.fhir, parsed.data.proposals) };
}
