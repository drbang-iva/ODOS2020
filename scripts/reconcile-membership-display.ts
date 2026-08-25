#!/usr/bin/env tsx
import type { ProjectMembership, User } from "@medplum/fhirtypes";
import {
  createOperatorScriptFhirClient,
  type JsonPatchOperation,
  type MedplumClient,
} from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";
import { assertLocalMedplumBaseUrl } from "./reseed-practice-role-tags.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export interface MembershipDisplayReconciliationResult {
  readonly membershipsInspected: number;
  readonly userMembershipsInspected: number;
  readonly nonUserMembershipsSkipped: number;
  readonly correctionsNeeded: number;
  readonly corrected: number;
}

export async function reconcileMembershipDisplays(
  fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl" | "read" | "patch">,
  apply: boolean,
): Promise<MembershipDisplayReconciliationResult> {
  const memberships = await searchAll<ProjectMembership>(fhir, "ProjectMembership");
  const corrections: Array<{
    membership: ProjectMembership;
    operations: JsonPatchOperation[];
  }> = [];
  let userMembershipsInspected = 0;
  let nonUserMembershipsSkipped = 0;

  for (const membership of memberships) {
    if (membership.user.reference && !membership.user.reference.startsWith("User/")) {
      nonUserMembershipsSkipped += 1;
      continue;
    }
    if (!membership.id || !membership.meta?.versionId) {
      throw new Error("Every ProjectMembership must carry id and meta.versionId.");
    }
    const userId = membershipUserId(membership);
    if (!userId) {
      throw new Error("Every ProjectMembership must reference one User.");
    }
    userMembershipsInspected += 1;
    const user = await fhir.read<User>("User", userId);
    if (!user.email?.trim()) {
      throw new Error("Every referenced User must carry a non-blank email.");
    }
    if (membership.user.display !== user.email) {
      corrections.push({
        membership,
        operations: [{
          op: membership.user.display === undefined ? "add" : "replace",
          path: "/user/display",
          value: user.email,
        }],
      });
    }
  }

  let corrected = 0;
  if (apply) {
    for (const correction of corrections) {
      await fhir.patch<ProjectMembership>(
        "ProjectMembership",
        correction.membership.id!,
        correction.operations,
        { "If-Match": `W/"${correction.membership.meta!.versionId}"` },
      );
      corrected += 1;
    }
  }

  return {
    membershipsInspected: memberships.length,
    userMembershipsInspected,
    nonUserMembershipsSkipped,
    correctionsNeeded: corrections.length,
    corrected,
  };
}

export async function readMembershipUserEmail(
  fhir: Pick<MedplumClient, "read">,
  membership: ProjectMembership,
): Promise<string | undefined> {
  const userId = membershipUserId(membership);
  if (!userId) return undefined;
  const user = await fhir.read<User>("User", userId);
  return user.email?.trim() ? user.email : undefined;
}

function membershipUserId(membership: ProjectMembership): string | undefined {
  return membership.user.reference?.match(/^User\/([A-Za-z0-9.-]{1,64})$/)?.[1];
}

function printResult(result: MembershipDisplayReconciliationResult, apply: boolean): void {
  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Memberships inspected: ${result.membershipsInspected}`);
  console.log(`User memberships inspected: ${result.userMembershipsInspected}`);
  console.log(`Non-User memberships skipped: ${result.nonUserMembershipsSkipped}`);
  console.log(`Corrections needed: ${result.correctionsNeeded}`);
  console.log(`Memberships corrected: ${result.corrected}`);
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
    reason: "Operator ProjectMembership display reconciliation runs outside request handling.",
  });
  await fhir.login(
    requireEnv("MEDPLUM_ADMIN_EMAIL"),
    requireEnv("MEDPLUM_ADMIN_PASSWORD"),
  );
  printResult(await reconcileMembershipDisplays(fhir, apply), apply);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    const status = (error as { status?: number }).status;
    const suffix = status === 412
      ? " A ProjectMembership changed during reconciliation; rerun against its current version."
      : "";
    console.error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
    process.exitCode = 1;
  }
}
