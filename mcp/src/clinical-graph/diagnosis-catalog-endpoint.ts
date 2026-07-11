import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import {
  FhirDiagnosisCatalogStore,
  type DiagnosisCatalogFhirClient,
} from "./diagnosis-catalog-store.js";
import type { ClinicalGraphProvenance, DiagnosisCatalogRow } from "./glaucoma-suspect.js";

export interface DiagnosisCatalogEndpointDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
    fhir: DiagnosisCatalogFhirClient;
  } | null>;
  now?: () => string;
  shortId?: () => string;
}

const patternSchema = z.object({
  unspecifiedEye: z.string().trim().min(1).max(20).optional(),
  right: z.string().trim().min(1).max(20).optional(),
  left: z.string().trim().min(1).max(20).optional(),
  bilateral: z.string().trim().min(1).max(20).optional(),
}).strict().refine((value) => Object.values(value).some(Boolean), "At least one laterality code is required.");
const icd10Schema = z.union([
  z.object({ code: z.string().trim().min(1).max(20), display: z.string().trim().min(1).max(160).optional() }).strict(),
  z.object({ pattern: patternSchema }).strict(),
]);
const snomedSchema = z.object({
  code: z.string().trim().min(1).max(40),
  display: z.string().trim().min(1).max(160),
}).strict();

const createSchema = z.object({
  display: z.string().trim().min(1).max(160),
  clinicalFamily: z.string().trim().min(1).max(120).optional(),
  icd10: icd10Schema.optional(),
  snomed: snomedSchema.optional(),
  lateralityRequired: z.boolean().default(false),
}).strict();

const updateSchema = z.object({
  display: z.string().trim().min(1).max(160).optional(),
  clinicalFamily: z.string().trim().min(1).max(120).optional(),
  icd10: icd10Schema.nullable().optional(),
  snomed: snomedSchema.nullable().optional(),
  lateralityRequired: z.boolean().optional(),
  active: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one diagnosis field is required.");

export async function handleDiagnosisCatalogListRequest(
  deps: DiagnosisCatalogEndpointDeps,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read the diagnosis catalog." } };
  const canWrite = staffMay(staff.actorRole, "finding-definitions.write");
  if (!staffMay(staff.actorRole, "chart.read") && !canWrite) {
    return { status: 403, body: { error: "chart.read or finding-definitions.write role required" } };
  }
  return { status: 200, body: { canWrite, diagnoses: await new FhirDiagnosisCatalogStore(staff.fhir).list() } };
}

export async function handleDiagnosisCatalogCreationRequest(
  deps: DiagnosisCatalogEndpointDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to manage the diagnosis catalog." } };
  if (!staffMay(staff.actorRole, "finding-definitions.write")) {
    return { status: 403, body: { error: "finding-definitions.write role required" } };
  }
  const parsed = createSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid diagnosis definition." } };
  const store = new FhirDiagnosisCatalogStore(staff.fhir);
  const stableKey = `custom:${slug(parsed.data.display)}-${deps.shortId?.() ?? shortId()}`;
  if ((await store.list()).some((row) => row.stableKey === stableKey)) {
    return { status: 409, body: { error: `Diagnosis definition ${stableKey} already exists.` } };
  }
  const provenance = mutationProvenance(staff.staffReference, deps.now?.());
  const row: DiagnosisCatalogRow = {
    id: `diagnosis-def-${stableKey.replace(/[^A-Za-z0-9.-]+/g, "-")}`,
    stableKey,
    display: parsed.data.display,
    clinicalFamily: parsed.data.clinicalFamily ?? stableKey,
    ...(parsed.data.icd10 ? { icd10: parsed.data.icd10 } : {}),
    ...(parsed.data.snomed ? { snomed: parsed.data.snomed } : {}),
    codingStatus: "provisional",
    lateralityRequired: parsed.data.lateralityRequired,
    applicableFindingDefinitionIds: [],
    separatesSeverityStagePayerRisk: true,
    keyFindings: [],
    origin: "practice",
    active: true,
    provenance,
  };
  try {
    return { status: 201, body: { diagnosis: await store.save(row) } };
  } catch (error) {
    return { status: 400, body: { error: errorMessage(error) } };
  }
}

export async function handleDiagnosisCatalogMutationRequest(
  deps: DiagnosisCatalogEndpointDeps,
  input: { authHeader: string | undefined; params: unknown; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to manage the diagnosis catalog." } };
  if (!staffMay(staff.actorRole, "finding-definitions.write")) {
    return { status: 403, body: { error: "finding-definitions.write role required" } };
  }
  const stableKey = readStableKey(input.params);
  if (!stableKey) return { status: 400, body: { error: "A valid diagnosis stableKey is required." } };
  const parsed = updateSchema.safeParse(input.body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid diagnosis update." } };
  const store = new FhirDiagnosisCatalogStore(staff.fhir);
  const current = (await store.list()).find((row) => row.stableKey === stableKey);
  if (!current) return { status: 404, body: { error: `Diagnosis definition ${stableKey} does not exist.` } };
  const codingChanged =
    (parsed.data.icd10 !== undefined && !sameIcd10(parsed.data.icd10, current.icd10)) ||
    (parsed.data.snomed !== undefined && JSON.stringify(parsed.data.snomed) !== JSON.stringify(current.snomed));
  const next: DiagnosisCatalogRow = {
    ...current,
    ...(parsed.data.display !== undefined ? { display: parsed.data.display } : {}),
    ...(parsed.data.clinicalFamily !== undefined ? { clinicalFamily: parsed.data.clinicalFamily } : {}),
    ...(parsed.data.lateralityRequired !== undefined ? { lateralityRequired: parsed.data.lateralityRequired } : {}),
    ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
    ...(
      codingChanged
        ? { codingStatus: "provisional" as const }
        : {}
    ),
    provenance: mutationProvenance(staff.staffReference, deps.now?.()),
  };
  if (parsed.data.icd10 === null) delete next.icd10;
  else if (parsed.data.icd10 !== undefined) next.icd10 = parsed.data.icd10;
  if (parsed.data.snomed === null) delete next.snomed;
  else if (parsed.data.snomed !== undefined) next.snomed = parsed.data.snomed;
  try {
    return { status: 200, body: { diagnosis: await store.save(next) } };
  } catch (error) {
    return { status: 400, body: { error: errorMessage(error) } };
  }
}

function mutationProvenance(staffReference: string, recordedAt?: string): ClinicalGraphProvenance {
  return {
    source: "manual",
    recordedAt: recordedAt ?? new Date().toISOString(),
    actorReference: staffReference,
    note: "Practice diagnosis-catalog update.",
  };
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "finding-definitions.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}

function readStableKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const stableKey = (value as Record<string, unknown>).stableKey;
  return typeof stableKey === "string" && stableKey.trim() ? stableKey.trim() : undefined;
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 84) || "diagnosis";
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameIcd10(left: unknown, right: unknown): boolean {
  if (left === null || right === undefined) return left === null && right === undefined;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const leftRow = left as Record<string, unknown>;
  const rightRow = right as Record<string, unknown>;
  if (typeof leftRow.code === "string" || typeof rightRow.code === "string") {
    return leftRow.code === rightRow.code;
  }
  return JSON.stringify(leftRow.pattern) === JSON.stringify(rightRow.pattern);
}
