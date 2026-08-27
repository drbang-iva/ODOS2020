#!/usr/bin/env tsx
import type { Condition, Encounter } from "@medplum/fhirtypes";
import { createOperatorScriptFhirClient, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";
type ExcludedVerificationStatus = "refuted" | "entered-in-error";

export interface StaleEncounterDiagnosisRepairAdapter {
  listEncounters(): Promise<Encounter[]>;
  listConditionsByVerificationStatus(status: ExcludedVerificationStatus): Promise<Condition[]>;
  updateEncounter(encounter: Encounter, headers: Record<string, string>): Promise<Encounter>;
}

interface RepairEntry {
  readonly reference: string;
  readonly display: string;
  readonly verificationStatus: ExcludedVerificationStatus;
  readonly rank: number | undefined;
}

interface KeptEntry {
  readonly reference: string;
  readonly rank: number | undefined;
}

interface RepairPlan {
  readonly encounter: Encounter;
  readonly removed: readonly RepairEntry[];
  readonly kept: readonly KeptEntry[];
}

export interface StaleEncounterDiagnosisRepairResult {
  readonly mode: "dry-run" | "apply";
  readonly encountersInspected: number;
  readonly encountersNeedingRepair: number;
  readonly encountersChanged: number;
  readonly plans: readonly RepairPlan[];
}

export async function repairStaleEncounterDiagnoses(
  adapter: StaleEncounterDiagnosisRepairAdapter,
  apply: boolean,
): Promise<StaleEncounterDiagnosisRepairResult> {
  const [encounters, refuted, enteredInError] = await Promise.all([
    adapter.listEncounters(),
    adapter.listConditionsByVerificationStatus("refuted"),
    adapter.listConditionsByVerificationStatus("entered-in-error"),
  ]);
  const excludedByReference = new Map<string, { condition: Condition; status: ExcludedVerificationStatus }>();
  for (const condition of [...refuted, ...enteredInError]) {
    if (!condition.id) continue;
    const status = excludedVerificationStatus(condition);
    if (status) excludedByReference.set(`Condition/${condition.id}`, { condition, status });
  }

  const plans = encounters.flatMap((encounter): RepairPlan[] => {
    const removed = (encounter.diagnosis ?? []).flatMap((entry): RepairEntry[] => {
      const reference = entry.condition.reference;
      const excluded = reference ? excludedByReference.get(reference) : undefined;
      return reference && excluded ? [{
        reference,
        display: conditionDisplay(excluded.condition, reference),
        verificationStatus: excluded.status,
        rank: entry.rank,
      }] : [];
    });
    if (removed.length === 0) return [];
    if (!encounter.id || !encounter.meta?.versionId) {
      throw new Error("Every Encounter selected for repair must carry id and meta.versionId.");
    }
    const removedReferences = new Set(removed.map((entry) => entry.reference));
    const kept = (encounter.diagnosis ?? []).flatMap((entry): KeptEntry[] =>
      entry.condition.reference && !removedReferences.has(entry.condition.reference)
        ? [{ reference: entry.condition.reference, rank: entry.rank }]
        : []
    );
    return [{ encounter, removed, kept }];
  }).sort((left, right) => left.encounter.id!.localeCompare(right.encounter.id!));

  let encountersChanged = 0;
  if (apply) {
    for (const plan of plans) {
      const removedReferences = new Set(plan.removed.map((entry) => entry.reference));
      await adapter.updateEncounter({
        ...plan.encounter,
        diagnosis: (plan.encounter.diagnosis ?? []).filter((entry) =>
          !entry.condition.reference || !removedReferences.has(entry.condition.reference)
        ),
      }, {
        "If-Match": `W/"${plan.encounter.meta!.versionId}"`,
        "X-ODOS-Source": "repair-stale-encounter-diagnoses",
      });
      encountersChanged += 1;
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    encountersInspected: encounters.length,
    encountersNeedingRepair: plans.length,
    encountersChanged,
    plans,
  };
}

export function formatStaleEncounterDiagnosisRepair(result: StaleEncounterDiagnosisRepairResult): string {
  const lines = [`Mode: ${result.mode === "apply" ? "APPLY" : "DRY RUN"}`];
  for (const plan of result.plans) {
    lines.push(`Encounter/${plan.encounter.id}`);
    for (const entry of plan.removed) {
      lines.push(`  remove ${entry.reference} | ${entry.display} | ${entry.verificationStatus} | ${formatRank(entry.rank)}`);
    }
    for (const entry of plan.kept) {
      lines.push(`  keep ${entry.reference} | ${formatRank(entry.rank)}`);
    }
  }
  lines.push(`Encounters inspected: ${result.encountersInspected}`);
  lines.push(`Encounters needing repair: ${result.encountersNeedingRepair}`);
  lines.push(`Encounters changed: ${result.encountersChanged}`);
  if (result.mode === "dry-run") {
    lines.push("Dry run only. Re-run with --apply to unlink these stale diagnosis references.");
  }
  return lines.join("\n");
}

class LiveRepairAdapter implements StaleEncounterDiagnosisRepairAdapter {
  constructor(private readonly fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl" | "update">) {}

  listEncounters(): Promise<Encounter[]> {
    return searchAll<Encounter>(this.fhir, "Encounter");
  }

  listConditionsByVerificationStatus(status: ExcludedVerificationStatus): Promise<Condition[]> {
    return searchAll<Condition>(this.fhir, "Condition", { "verification-status": status });
  }

  updateEncounter(encounter: Encounter, headers: Record<string, string>): Promise<Encounter> {
    return this.fhir.update("Encounter", encounter.id!, encounter, headers);
  }
}

function excludedVerificationStatus(condition: Condition): ExcludedVerificationStatus | undefined {
  const code = condition.verificationStatus?.coding?.find((coding) =>
    coding.code === "refuted" || coding.code === "entered-in-error"
  )?.code;
  return code === "refuted" || code === "entered-in-error" ? code : undefined;
}

function conditionDisplay(condition: Condition, fallback: string): string {
  return condition.code?.text ??
    condition.code?.coding?.find((coding) => coding.display)?.display ??
    condition.code?.coding?.find((coding) => coding.code)?.code ??
    fallback;
}

function formatRank(rank: number | undefined): string {
  return rank === undefined ? "rank missing" : `rank ${rank}`;
}

function parseApplyFlag(args: readonly string[]): boolean {
  const unknown = args.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}. Use --apply to write changes.`);
  }
  return args.includes("--apply");
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function runCli(): Promise<void> {
  const baseUrl = (process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  assertLocalMedplumBaseUrl(baseUrl);
  const apply = parseApplyFlag(process.argv.slice(2));
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    reason: "Operator stale Encounter diagnosis repair runs outside request handling.",
  });
  await fhir.login(
    requireEnv("MEDPLUM_ADMIN_EMAIL"),
    requireEnv("MEDPLUM_ADMIN_PASSWORD"),
  );
  console.log(formatStaleEncounterDiagnosisRepair(
    await repairStaleEncounterDiagnoses(new LiveRepairAdapter(fhir), apply),
  ));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    const status = (error as { status?: number }).status;
    const suffix = status === 412
      ? " An Encounter changed during repair; rerun the dry-run against its current version."
      : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    process.exitCode = 1;
  }
}
