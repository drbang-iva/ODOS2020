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
import { FAMILY_RESOLUTION_MODES } from "./diagnosis-catalog-seeds.js";

type DiagnosisQuickListFhirClient = DiagnosisCatalogFhirClient & DiagnosisPickTallyFhirClient;

export interface DiagnosisQuickListRow {
  stableKey: string;
  display: string;
  lateralityRequired: boolean;
  bilateralResolution?: DiagnosisCatalogRow["bilateralResolution"];
  icd10?: DiagnosisCatalogRow["icd10"];
  pinned: boolean;
  tallyCount: number;
  clinicalFamily?: string;
  axisLabel?: string;
  members?: Array<{
    stableKey: string;
    stageLabel: string;
    display: string;
    lateralityRequired: boolean;
    bilateralResolution?: DiagnosisCatalogRow["bilateralResolution"];
    icd10?: DiagnosisCatalogRow["icd10"];
  }>;
}

export interface StagedDiagnosisFamilyProjection {
  stableKey: string;
  clinicalFamily: string;
  display: string;
  lateralityRequired: boolean;
  axisLabel: string;
  members: NonNullable<DiagnosisQuickListRow["members"]>;
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

const COMMON_DIAGNOSIS_TARGET_COUNT = 15;

const STARTER_DIAGNOSIS_PINS = [
  { name: "Astigmatism", stableKey: "astigmatism" },
  { name: "Myopia", stableKey: "myopia" },
  { name: "Hyperopia", stableKey: "hyperopia" },
  { name: "Cataract, Nuclear", stableKey: "cataract_nuclear_sclerosis" },
  { name: "Keratoconjunctivitis Sicca", stableKey: "kcs_not_sjogren" },
  { name: "Ocular Hypertension", stableKey: "ocular_hypertension" },
  { name: "Pseudophakia", stableKey: "pseudophakia" },
  { name: "Borderline Glaucoma, Open Angle, Low Risk", stableKey: "glaucoma_suspect_open_angle_low" },
  { name: "Borderline Glaucoma, Open Angle, High Risk", stableKey: "glaucoma_suspect_open_angle_high" },
  { name: "Hypertensive Retinopathy", stableKey: "hypertensive_retinopathy" },
  { name: "Meibomian Gland Dysfunction", stableKey: "meibomian_gland_dysfunction" },
  { name: "Primary Open Angle Glaucoma (POAG)", stableKey: "primary-open-angle-glaucoma" },
] as const;

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
  const tallyStore = new FhirDiagnosisPickTallyStore(deps.tallyFhir);
  const [diagnoses, storedTally] = await Promise.all([
    diagnosisCatalog(deps),
    tallyStore.read(staff.staffReference),
  ]);
  const now = deps.now?.() ?? new Date().toISOString();
  let tally = storedTally;
  if (!tally && staffMay(staff.actorRole, "chart.write")) {
    const starter = resolveStarterDiagnosisPins(diagnoses);
    for (const missing of starter.missing) {
      console.error(
        `Diagnosis quick-list starter "${missing.name}" not seeded: stableKey "${missing.stableKey}" is not active and verified.`,
      );
    }
    tally = await tallyStore.replacePinned(staff.staffReference, starter.pinnedDiagnosisKeys, now);
  }
  tally ??= emptyTally(now);
  const migratedPins = migrateDiagnosisPins(tally.pinnedDiagnosisKeys);
  if (!samePins(tally.pinnedDiagnosisKeys, migratedPins)) {
    tally = staffMay(staff.actorRole, "chart.write")
      ? await tallyStore.replacePinned(
          staff.staffReference,
          migratedPins,
          now,
        )
      : { ...tally, pinnedDiagnosisKeys: migratedPins };
  }
  return quickListResponse(
    diagnoses,
    tally,
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
  const eligibleMemberKeys = new Set(
    diagnoses.filter((row) => row.active && row.codingStatus === "verified").map((row) => row.stableKey),
  );
  const eligibleFamilyKeys = new Set(diagnosisCatalogRows(diagnoses, emptyTally("")).map((row) => row.stableKey));
  const unknownKey = parsed.data.pinnedDiagnosisKeys.find((key) =>
    !eligibleMemberKeys.has(key) && !eligibleFamilyKeys.has(key)
  );
  if (unknownKey) {
    return { status: 400, body: { error: `Diagnosis ${unknownKey} is not an active verified Common diagnosis.` } };
  }
  const tally = await new FhirDiagnosisPickTallyStore(deps.tallyFhir).replacePinned(
    staff.staffReference,
    migrateDiagnosisPins(parsed.data.pinnedDiagnosisKeys),
    deps.now?.() ?? new Date().toISOString(),
  );
  return quickListResponse(diagnoses, tally, true);
}

export function orderDiagnosisQuickList(
  diagnoses: readonly DiagnosisCatalogRow[],
  tally: DiagnosisPickTallyRow,
): DiagnosisQuickListRow[] {
  const eligibleRows = diagnosisCatalogRows(diagnoses, tally);
  const pinOrder = new Map(tally.pinnedDiagnosisKeys.map((key, index) => [key, index]));
  const pinnedRows = eligibleRows
    .filter((row) => row.pinned)
    .sort((left, right) => pinOrder.get(left.stableKey)! - pinOrder.get(right.stableKey)!);
  const usageRows = eligibleRows
    .filter((row) => !row.pinned && row.tallyCount > 0)
    .sort((left, right) => right.tallyCount - left.tallyCount || left.display.localeCompare(right.display));
  return [
    ...pinnedRows,
    ...usageRows.slice(0, Math.max(0, COMMON_DIAGNOSIS_TARGET_COUNT - pinnedRows.length)),
  ];
}

function diagnosisCatalogRows(
  diagnoses: readonly DiagnosisCatalogRow[],
  tally: DiagnosisPickTallyRow,
): DiagnosisQuickListRow[] {
  const pinnedKeys = new Set(migrateDiagnosisPins(tally.pinnedDiagnosisKeys));
  const totals = new Map<string, number>();
  for (const counts of Object.values(tally.counts)) {
    for (const [diagnosisKey, count] of Object.entries(counts)) {
      totals.set(diagnosisKey, (totals.get(diagnosisKey) ?? 0) + count);
    }
  }
  const eligible = diagnoses.filter((row) => row.active && row.codingStatus === "verified");
  const byStableKey = new Map(eligible.map((row) => [row.stableKey, row]));
  const emittedFamilies = new Set<string>();
  return eligible.flatMap((row): DiagnosisQuickListRow[] => {
    const staged = stagedFamilyForMember(row.stableKey);
    if (!staged) return [quickListRow(row, pinnedKeys, totals)];
    if (emittedFamilies.has(staged.clinicalFamily)) return [];
    emittedFamilies.add(staged.clinicalFamily);
    const family = stagedDiagnosisFamilyRow([...byStableKey.values()], staged.clinicalFamily);
    if (!family) return [];
    return [{
      ...family,
      pinned: pinnedKeys.has(staged.clinicalFamily),
      tallyCount: family.members.reduce((sum, member) => sum + (totals.get(member.stableKey) ?? 0), 0),
    }];
  });
}

function resolveStarterDiagnosisPins(diagnoses: readonly DiagnosisCatalogRow[]): {
  pinnedDiagnosisKeys: string[];
  missing: Array<{ name: string; stableKey: string }>;
} {
  const eligibleKeys = new Set(diagnosisCatalogRows(diagnoses, emptyTally("")).map((row) => row.stableKey));
  return STARTER_DIAGNOSIS_PINS.reduce<{
    pinnedDiagnosisKeys: string[];
    missing: Array<{ name: string; stableKey: string }>;
  }>((resolved, seed) => {
    if (eligibleKeys.has(seed.stableKey)) {
      resolved.pinnedDiagnosisKeys.push(seed.stableKey);
    } else {
      resolved.missing.push(seed);
    }
    return resolved;
  }, { pinnedDiagnosisKeys: [], missing: [] });
}

export function stagedDiagnosisFamilyRow(
  diagnoses: readonly DiagnosisCatalogRow[],
  clinicalFamily: string,
): StagedDiagnosisFamilyProjection | undefined {
  const mode = FAMILY_RESOLUTION_MODES[clinicalFamily];
  if (!mode || mode.mode !== "staged") return undefined;
  const byStableKey = new Map(
    diagnoses.filter((row) => row.active && row.codingStatus === "verified").map((row) => [row.stableKey, row]),
  );
  const members = mode.members.flatMap((member) => {
    const catalogRow = byStableKey.get(member.stableKey);
    return catalogRow ? [{
      stableKey: catalogRow.stableKey,
      stageLabel: member.stageLabel,
      display: catalogRow.display,
      lateralityRequired: catalogRow.lateralityRequired,
      ...(catalogRow.bilateralResolution ? { bilateralResolution: catalogRow.bilateralResolution } : {}),
      ...(catalogRow.icd10 ? { icd10: catalogRow.icd10 } : {}),
    }] : [];
  });
  const first = members[0];
  if (!first) return undefined;
  return {
    stableKey: clinicalFamily,
    clinicalFamily,
    display: familyDisplay(first.display),
    lateralityRequired: first.lateralityRequired,
    axisLabel: mode.axisLabel,
    members,
  };
}

function quickListRow(
  row: DiagnosisCatalogRow,
  pinnedKeys: ReadonlySet<string>,
  totals: ReadonlyMap<string, number>,
): DiagnosisQuickListRow {
  return {
    stableKey: row.stableKey,
    display: row.display,
    lateralityRequired: row.lateralityRequired,
    ...(row.bilateralResolution ? { bilateralResolution: row.bilateralResolution } : {}),
    ...(row.icd10 ? { icd10: row.icd10 } : {}),
    pinned: pinnedKeys.has(row.stableKey),
    tallyCount: totals.get(row.stableKey) ?? 0,
  };
}

function stagedFamilyForMember(stableKey: string): {
  clinicalFamily: string;
  axisLabel: string;
  members: Array<{ stableKey: string; stageLabel: string }>;
} | undefined {
  for (const [clinicalFamily, mode] of Object.entries(FAMILY_RESOLUTION_MODES)) {
    if (mode.mode === "staged" && mode.members.some((member) => member.stableKey === stableKey)) {
      return { clinicalFamily, axisLabel: mode.axisLabel, members: mode.members };
    }
  }
  return undefined;
}

function migrateDiagnosisPins(keys: readonly string[]): string[] {
  const migrated: string[] = [];
  for (const key of keys) {
    const resolved = stagedFamilyForMember(key)?.clinicalFamily ?? key;
    if (!migrated.includes(resolved)) migrated.push(resolved);
  }
  return migrated;
}

function samePins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function familyDisplay(memberDisplay: string): string {
  return memberDisplay.replace(/,\s.*$/, "");
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
      catalog: diagnosisCatalogRows(diagnoses, tally),
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
