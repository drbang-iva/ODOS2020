#!/usr/bin/env tsx
import type { AccessPolicy, Coding } from "@medplum/fhirtypes";
import {
  getRoleDeclaration,
  OSOD_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createMedplumClient, type JsonPatchOperation, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export type PracticeRoleTagDecision =
  | { readonly kind: "SKIP" }
  | { readonly kind: "ADD"; readonly tag: Coding }
  | { readonly kind: "CONFLICT"; readonly conflictingCodes: readonly (string | undefined)[] };

export interface PracticeRoleReseedAdapter {
  findPoliciesByName(name: string): Promise<AccessPolicy[]>;
  patchPolicy(id: string, operations: JsonPatchOperation[]): Promise<AccessPolicy>;
}

export interface PracticeRoleReseedCount {
  readonly roleId: PracticeRoleId;
  readonly matched: number;
  readonly tagged: number;
  readonly alreadyCorrect: number;
  readonly conflicted: number;
}

export interface PracticeRoleReseedResult {
  readonly roles: readonly PracticeRoleReseedCount[];
  readonly conflicts: readonly {
    readonly roleId: PracticeRoleId;
    readonly policyId: string | undefined;
    readonly conflictingCodes: readonly (string | undefined)[];
  }[];
  readonly exitCode: 0 | 1;
}

export function decidePracticeRoleTag(
  existingTags: readonly Coding[] | undefined,
  expectedRoleCode: PracticeRoleId,
): PracticeRoleTagDecision {
  const practiceRoleTags = (existingTags ?? []).filter(
    (tag) => tag.system === OSOD_PRACTICE_ROLE_SYSTEM,
  );
  const conflictingCodes = practiceRoleTags
    .filter((tag) => tag.code !== expectedRoleCode)
    .map((tag) => tag.code);

  if (conflictingCodes.length > 0) {
    return { kind: "CONFLICT", conflictingCodes };
  }
  if (practiceRoleTags.some((tag) => tag.code === expectedRoleCode)) {
    return { kind: "SKIP" };
  }
  return {
    kind: "ADD",
    tag: { system: OSOD_PRACTICE_ROLE_SYSTEM, code: expectedRoleCode },
  };
}

export async function reseedPracticeRoleTags(
  adapter: PracticeRoleReseedAdapter,
): Promise<PracticeRoleReseedResult> {
  const roles: PracticeRoleReseedCount[] = [];
  const conflicts: PracticeRoleReseedResult["conflicts"][number][] = [];

  for (const roleId of PRACTICE_ROLE_IDS) {
    const role = getRoleDeclaration(roleId);
    const expectedName = `OSOD ${role.display}`;
    const policies = (await adapter.findPoliciesByName(expectedName)).filter(
      (policy) => policy.name === expectedName,
    );
    let tagged = 0;
    let alreadyCorrect = 0;
    let conflicted = 0;

    for (const policy of policies) {
      const decision = decidePracticeRoleTag(policy.meta?.tag, role.id);
      if (decision.kind === "SKIP") {
        alreadyCorrect += 1;
        continue;
      }
      if (decision.kind === "CONFLICT") {
        conflicted += 1;
        conflicts.push({
          roleId,
          policyId: policy.id,
          conflictingCodes: decision.conflictingCodes,
        });
        continue;
      }
      if (!policy.id) {
        throw new Error(`Matched ${expectedName} AccessPolicy has no id.`);
      }
      await adapter.patchPolicy(policy.id, practiceRoleTagPatch(policy, decision.tag));
      tagged += 1;
    }

    roles.push({ roleId, matched: policies.length, tagged, alreadyCorrect, conflicted });
  }

  return {
    roles,
    conflicts,
    exitCode: conflicts.length > 0 ? 1 : 0,
  };
}

export function practiceRoleTagPatch(policy: AccessPolicy, tag: Coding): JsonPatchOperation[] {
  if (!policy.meta) {
    return [{ op: "add", path: "/meta", value: { tag: [tag] } }];
  }
  if (!policy.meta.tag) {
    return [{ op: "add", path: "/meta/tag", value: [tag] }];
  }
  return [{ op: "add", path: "/meta/tag/-", value: tag }];
}

class LivePracticeRoleReseedAdapter implements PracticeRoleReseedAdapter {
  constructor(private readonly fhir: Pick<MedplumClient, "search" | "searchUrl" | "patch">) {}

  async findPoliciesByName(name: string): Promise<AccessPolicy[]> {
    return searchAll<AccessPolicy>(this.fhir, "AccessPolicy", { "name:exact": name });
  }

  async patchPolicy(id: string, operations: JsonPatchOperation[]): Promise<AccessPolicy> {
    return this.fhir.patch<AccessPolicy>("AccessPolicy", id, operations);
  }
}

function printSummary(result: PracticeRoleReseedResult): void {
  for (const conflict of result.conflicts) {
    console.error(
      `CONFLICT ${conflict.roleId} AccessPolicy/${conflict.policyId ?? "unknown"}: ` +
        `found practice-role code(s) ${conflict.conflictingCodes.map((code) => code ?? "(missing)").join(", ")}`,
    );
  }
  console.log("role\tmatched\ttagged\talready-correct\tconflicted");
  for (const role of result.roles) {
    console.log(
      `${role.roleId}\t${role.matched}\t${role.tagged}\t${role.alreadyCorrect}\t${role.conflicted}`,
    );
  }
}

async function runCli(): Promise<void> {
  const email = requireEnv("MEDPLUM_ADMIN_EMAIL");
  const password = requireEnv("MEDPLUM_ADMIN_PASSWORD");
  const fhir = createMedplumClient({
    baseUrl: process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL,
  });
  await fhir.login(email, password);
  const result = await reseedPracticeRoleTags(new LivePracticeRoleReseedAdapter(fhir));
  printSummary(result);
  process.exitCode = result.exitCode;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
