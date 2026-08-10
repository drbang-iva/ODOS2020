import { z } from "zod";
import { assertBusinessActionAllowed, type PracticeRoleId } from "../authz/roles.js";
import {
  FhirDiagnosisCatalogStore,
  type DiagnosisCatalogFhirClient,
} from "./diagnosis-catalog-store.js";
import {
  FhirDiagnosisPickTallyStore,
  type DiagnosisPickTallyFhirClient,
  type DiagnosisPickTallyRow,
} from "./diagnosis-pick-tally-store.js";
import type { DiagnosisCatalogRow } from "./glaucoma-suspect.js";

type DiagnosisQuickListFhirClient = DiagnosisCatalogFhirClient & DiagnosisPickTallyFhirClient;

export interface DiagnosisQuickListRow {
  stableKey: string;
  display: string;
  lateralityRequired: boolean;
  icd10?: DiagnosisCatalogRow["icd10"];
  pinned: boolean;
  tallyCount: number;
}

interface DiagnosisQuickListDeps {
  authenticate(authHeader: string | undefined): Promise<{
    staffReference: string;
    actorRole: PracticeRoleId;
  } | null>;
  tallyFhir: DiagnosisQuickListFhirClient;
  diagnosisCatalog?: () => Promise<DiagnosisCatalogRow[]>;
  now?: () => string;
}

const mutationSchema = z.object({
  pinnedDiagnosisKeys: z.array(z.string().trim().min(1).max(160)).max(100)
    .refine((keys) => new Set(keys).size === keys.length, "Diagnosis quick-list pins must be unique."),
}).strict();

export async function handleDiagnosisQuickListRequest(
  deps: DiagnosisQuickListDeps,
  input: { authHeader: string | undefined },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to read Common diagnoses." } };
  if (!staffMay(staff.actorRole, "chart.read")) {
    return { status: 403, body: { error: "chart.read role required" } };
  }
  const [diagnoses, tally] = await Promise.all([
    diagnosisCatalog(deps),
    new FhirDiagnosisPickTallyStore(deps.tallyFhir).read(staff.staffReference),
  ]);
  return quickListResponse(
    diagnoses,
    tally ?? emptyTally(deps.now?.() ?? new Date().toISOString()),
    staffMay(staff.actorRole, "chart.write"),
  );
}

export async function handleDiagnosisQuickListMutationRequest(
  deps: DiagnosisQuickListDeps,
  input: { authHeader: string | undefined; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const staff = await deps.authenticate(input.authHeader);
  if (!staff) return { status: 401, body: { error: "Authentication required to update Common diagnoses." } };
  if (!staffMay(staff.actorRole, "chart.write")) {
    return { status: 403, body: { error: "chart.write role required" } };
  }
  const parsed = mutationSchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid Common diagnosis order." } };
  }
  const diagnoses = await diagnosisCatalog(deps);
  const eligibleKeys = new Set(
    diagnoses.filter((row) => row.active && row.codingStatus === "verified").map((row) => row.stableKey),
  );
  const unknownKey = parsed.data.pinnedDiagnosisKeys.find((key) => !eligibleKeys.has(key));
  if (unknownKey) {
    return { status: 400, body: { error: `Diagnosis ${unknownKey} is not an active verified Common diagnosis.` } };
  }
  const tally = await new FhirDiagnosisPickTallyStore(deps.tallyFhir).replacePinned(
    staff.staffReference,
    parsed.data.pinnedDiagnosisKeys,
    deps.now?.() ?? new Date().toISOString(),
  );
  return quickListResponse(diagnoses, tally, true);
}

export function orderDiagnosisQuickList(
  diagnoses: readonly DiagnosisCatalogRow[],
  tally: DiagnosisPickTallyRow,
): DiagnosisQuickListRow[] {
  const pinOrder = new Map(tally.pinnedDiagnosisKeys.map((key, index) => [key, index]));
  const totals = new Map<string, number>();
  for (const counts of Object.values(tally.counts)) {
    for (const [diagnosisKey, count] of Object.entries(counts)) {
      totals.set(diagnosisKey, (totals.get(diagnosisKey) ?? 0) + count);
    }
  }
  return diagnoses
    .filter((row) => row.active && row.codingStatus === "verified")
    .map((row): DiagnosisQuickListRow => ({
      stableKey: row.stableKey,
      display: row.display,
      lateralityRequired: row.lateralityRequired,
      ...(row.icd10 ? { icd10: row.icd10 } : {}),
      pinned: pinOrder.has(row.stableKey),
      tallyCount: totals.get(row.stableKey) ?? 0,
    }))
    .sort((left, right) => {
      const leftPin = pinOrder.get(left.stableKey);
      const rightPin = pinOrder.get(right.stableKey);
      if (leftPin !== undefined || rightPin !== undefined) {
        if (leftPin === undefined) return 1;
        if (rightPin === undefined) return -1;
        return leftPin - rightPin;
      }
      return right.tallyCount - left.tallyCount || left.display.localeCompare(right.display);
    });
}

async function diagnosisCatalog(deps: DiagnosisQuickListDeps): Promise<DiagnosisCatalogRow[]> {
  return deps.diagnosisCatalog?.() ?? new FhirDiagnosisCatalogStore(deps.tallyFhir).list();
}

function quickListResponse(
  diagnoses: readonly DiagnosisCatalogRow[],
  tally: DiagnosisPickTallyRow,
  canWrite: boolean,
): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      canWrite,
      pinnedDiagnosisKeys: tally.pinnedDiagnosisKeys,
      diagnoses: orderDiagnosisQuickList(diagnoses, tally),
    },
  };
}

function emptyTally(updatedAt: string): DiagnosisPickTallyRow {
  return { counts: {}, pinnedDiagnosisKeys: [], updatedAt };
}

function staffMay(role: PracticeRoleId, action: "chart.read" | "chart.write"): boolean {
  try {
    assertBusinessActionAllowed(role, action);
    return true;
  } catch {
    return false;
  }
}
