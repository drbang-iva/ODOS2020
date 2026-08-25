#!/usr/bin/env tsx
import type { AccessPolicy, Coding } from "@medplum/fhirtypes";
import {
  getRoleDeclaration,
  ODOS_PRACTICE_ROLE_SYSTEM,
  PRACTICE_ROLE_IDS,
  type PracticeRoleId,
} from "../mcp/src/authz/roles.js";
import { createOperatorScriptFhirClient, type JsonPatchOperation, type MedplumClient } from "../mcp/src/fhir-client.js";
import { searchAll } from "../mcp/src/fhir-search.js";

const DEFAULT_BASE_URL = "http://localhost:8103";

export type PracticeRoleTagDecision =
  | { readonly kind: "SKIP" }
  | { readonly kind: "ADD"; readonly tag: Coding }
  | { readonly kind: "CONFLICT"; readonly conflictingCodes: readonly (string | undefined)[] };

export interface PracticeRoleReseedAdapter {
  findPoliciesByName(name: string): Promise<AccessPolicy[]>;
  patchPolicy(id: string, operations: JsonPatchOperation[], versionId: string): Promise<AccessPolicy>;
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
    readonly reason: "role-tag" | "missing-version" | "stale-version";
    readonly conflictingCodes?: readonly (string | undefined)[];
  }[];
  readonly exitCode: 0 | 1;
}

export type PracticeRoleTagReseedCredentials =
  | { readonly source: "access-token"; readonly accessToken: string }
  | {
      readonly source: "admin-login";
      readonly adminEmail: string;
      readonly adminPassword: string;
    };

export function resolvePracticeRoleTagReseedCredentials(input: {
  readonly accessToken?: string;
  readonly adminEmail?: string;
  readonly adminPassword?: string;
}): PracticeRoleTagReseedCredentials {
  const accessToken = input.accessToken?.trim();
  if (accessToken) {
    return { source: "access-token", accessToken };
  }

  const adminEmail = input.adminEmail?.trim();
  const adminPassword = input.adminPassword;
  if (adminEmail && adminPassword?.trim()) {
    return { source: "admin-login", adminEmail, adminPassword };
  }

  const absent = [
    !accessToken && "MEDPLUM_ACCESS_TOKEN",
    !adminEmail && "MEDPLUM_ADMIN_EMAIL",
    !adminPassword?.trim() && "MEDPLUM_ADMIN_PASSWORD",
  ].filter((name): name is string => Boolean(name));
  throw new Error(
    "Need MEDPLUM_ACCESS_TOKEN, or MEDPLUM_ADMIN_EMAIL + MEDPLUM_ADMIN_PASSWORD. "
    + `Absent: ${absent.join(", ")}.`,
  );
}

export function decidePracticeRoleTag(
  existingTags: readonly Coding[] | undefined,
  expectedRoleCode: PracticeRoleId,
): PracticeRoleTagDecision {
  const practiceRoleTags = (existingTags ?? []).filter(
    (tag) => tag.system === ODOS_PRACTICE_ROLE_SYSTEM,
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
    tag: { system: ODOS_PRACTICE_ROLE_SYSTEM, code: expectedRoleCode },
  };
}

export async function reseedPracticeRoleTags(
  adapter: PracticeRoleReseedAdapter,
): Promise<PracticeRoleReseedResult> {
  const roles: PracticeRoleReseedCount[] = [];
  const conflicts: PracticeRoleReseedResult["conflicts"][number][] = [];

  for (const roleId of PRACTICE_ROLE_IDS) {
    const role = getRoleDeclaration(roleId);
    const expectedName = `ODOS ${role.display}`;
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
          reason: "role-tag",
          conflictingCodes: decision.conflictingCodes,
        });
        continue;
      }
      if (!policy.id) {
        throw new Error(`Matched ${expectedName} AccessPolicy has no id.`);
      }
      const versionId = policy.meta?.versionId;
      if (!versionId) {
        conflicted += 1;
        conflicts.push({ roleId, policyId: policy.id, reason: "missing-version" });
        continue;
      }
      try {
        await adapter.patchPolicy(policy.id, practiceRoleTagPatch(policy, decision.tag), versionId);
        tagged += 1;
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
        conflicted += 1;
        conflicts.push({ roleId, policyId: policy.id, reason: "stale-version" });
      }
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
  constructor(private readonly fhir: Pick<MedplumClient, "baseUrl" | "search" | "searchUrl" | "patch">) {}

  async findPoliciesByName(name: string): Promise<AccessPolicy[]> {
    return searchAll<AccessPolicy>(this.fhir, "AccessPolicy", { "name:exact": name });
  }

  async patchPolicy(
    id: string,
    operations: JsonPatchOperation[],
    versionId: string,
  ): Promise<AccessPolicy> {
    return this.fhir.patch<AccessPolicy>("AccessPolicy", id, operations, {
      "If-Match": `W/"${versionId}"`,
    });
  }
}

function printSummary(result: PracticeRoleReseedResult): void {
  for (const conflict of result.conflicts) {
    const detail = conflict.reason === "role-tag"
      ? `found practice-role code(s) ${(conflict.conflictingCodes ?? []).map((code) => code ?? "(missing)").join(", ")}`
      : conflict.reason === "missing-version"
        ? "search result had no meta.versionId; no safe conditional write was possible"
        : "policy changed after search; rerun to re-evaluate its current tags";
    console.error(`CONFLICT ${conflict.roleId} AccessPolicy/${conflict.policyId ?? "unknown"}: ${detail}`);
  }
  console.log("role\tmatched\ttagged\talready-correct\tconflicted");
  for (const role of result.roles) {
    console.log(
      `${role.roleId}\t${role.matched}\t${role.tagged}\t${role.alreadyCorrect}\t${role.conflicted}`,
    );
  }
}

async function runCli(): Promise<void> {
  const baseUrl = process.env.MEDPLUM_BASE_URL ?? DEFAULT_BASE_URL;
  assertLocalMedplumBaseUrl(baseUrl);
  const credentials = resolvePracticeRoleTagReseedCredentials({
    accessToken: process.env.MEDPLUM_ACCESS_TOKEN,
    adminEmail: process.env.MEDPLUM_ADMIN_EMAIL,
    adminPassword: process.env.MEDPLUM_ADMIN_PASSWORD,
  });
  const fhir = createOperatorScriptFhirClient({
    baseUrl,
    ...(credentials.source === "access-token" ? { accessToken: credentials.accessToken } : {}),
    reason: "Operator practice-role tag reseed runs outside request handling.",
  });
  if (credentials.source === "admin-login") {
    await fhir.login(credentials.adminEmail, credentials.adminPassword);
  }
  const result = await reseedPracticeRoleTags(new LivePracticeRoleReseedAdapter(fhir));
  printSummary(result);
  process.exitCode = result.exitCode;
}

export function assertLocalMedplumBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MEDPLUM_BASE_URL must be a valid local or private HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !isLocalOrPrivateHostname(url.hostname)
  ) {
    throw new Error("MEDPLUM_BASE_URL must target a local or private HTTP(S) Medplum server.");
  }
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 127;
}

function isPreconditionFailure(error: unknown): boolean {
  return (error as { status?: number }).status === 412;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
